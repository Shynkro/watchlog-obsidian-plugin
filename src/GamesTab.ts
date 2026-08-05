import { Modal, Notice, setIcon } from 'obsidian';
import type WatchLogPlugin from './main';
import type { GameDataManager } from './GameDataManager';
import {
	Game, GameGroup, GamesSavedFilterPreset, GAME_AUTO_STATUS, GAME_FINISHED_STATUS,
	normalizeRowsLayout, GAMES_ROWS_SHELVES, ROWS_EXCLUSIVE_SHELVES, sortByFavorited,
	priorityFilterOpts, formatPriorityOpt, migratePriorityExclude,
} from './types';
import { searchItems, yearOf, type SearchFieldSpec } from './SearchQuery';
import { renderSearchHelpButton } from './SearchHelpModal';
import { RowsCustomizeModal } from './RowsCustomizeModal';
import { VirtualGrid, computeGridMetrics, setRowsCardWidth, type GridMetrics } from './VirtualGrid';
import { VirtualScroller } from './VirtualScroller';
import { LazyCardObserver } from './LazyCardObserver';
import { buildPosterCard, openCardMenu, POSTER_CARD_TEXT_H } from './PosterCard';
import { renderGroupCollage } from './CollageUtil';
import { renderShelf, renderShelfTitle, type ShelfSelect } from './RowsView';
import { renderToolbarWithMobileToggle } from './MobileToolbar';
import { rawgResizedCover, type GameSearchResult } from './ApiService';
import { toggleFilterPanel, FilterSection } from './FilterPanel';
import { toggleSortPopover } from './SortPopover';
import { ConfirmModal } from './ConfirmModal';
import { GameDetailModal, GameGroupDetailModal, gameGroupProgress } from './GameDetailModal';
import { AddGameModal } from './AddGameModal';
import { openNoteFile } from './NoteLinkButton';

/** One entry in the merged grid: an ungrouped game, or a group card with its resolved members. */
type GameDisplayItem =
	| { kind: 'game'; data: Game }
	| { kind: 'group'; data: GameGroup; members: Game[] };

const PRIORITY_ORDER = ['High', 'Medium', 'Low'] as const;

/** Released within the last 7 days (the Watchlist "Recently arrived" rule). */
function isRecentlyReleased(releaseDate: string | null): boolean {
	if (!releaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return false;
	const releaseMs = new Date(releaseDate + 'T00:00:00').getTime();
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const diffDays = (today.getTime() - releaseMs) / 86400000;
	return diffDays >= 0 && diffDays <= 7;
}

/**
 * Games tab: the Watchlist toolbar (search + Saved filter / Filters / Sorting / Select / + Add,
 * on the shared FilterPanel + SortPopover + mobile-toggle modules) over the customizable Rows
 * layout (GAMES_ROWS_SHELVES + RowsCustomizeModal) — shelves, the exclusive By genre / By status
 * grids, and the flat "All games" fallback, all on the shared card infrastructure. + Add opens
 * AddGameModal; a card click opens GameDetailModal, or toggles selection in Select mode.
 */
export class GamesTab {
	private container: HTMLElement;
	private plugin: WatchLogPlugin;
	private gameData: GameDataManager;
	private dataChangeListener: () => void;
	private scroller: VirtualScroller | null = null;
	// lazy cover re-fetch — one observer per rendered view (see handleCoversVisible).
	// coverFetchFailed suppresses retries for the rest of the session, so a game the API can't
	// resolve doesn't re-search on every scroll past its card
	private coversObserver: LazyCardObserver | null = null;
	private coverFetchFailed = new Set<string>();
	// survives re-renders within this tab instance, so grid scroll is restored after a rebuild
	private persistentScrollTop = 0;
	private activeCleanups: (() => void)[] = [];
	private searchQuery = '';

	// filter state (the Watchlist model — persisted live in settings.gamesFilters)
	private filterGenreExclude = new Set<string>();
	private filterStatusExclude = new Set<string>();
	private filterRatingExclude = new Set<string>();
	private filterPriorityExclude = new Set<string>();
	private filterPlatformExclude = new Set<string>();
	private filterGroupExclude = new Set<string>();
	private filterRatingEmptyOnly = false;
	private filterRecentlyArrivedOnly = false;
	private filterFavoritesOnly = false;
	private filterWishlistOnly = false;
	// hides standalone games, shows only groups
	private filterGroupsOnly = false;
	private filterSort = 'dateAdded';
	private filterSortDir: 'asc' | 'desc' = 'desc';
	private filterSecondSort = 'none';
	private filterSecondSortDir: 'asc' | 'desc' = 'asc';

	private savedFilterActive = false;
	private savedFilterBtnEl: HTMLButtonElement | null = null;

	private selectionMode = false;
	private selectedIds = new Set<string>();
	// header select-all boxes of the current Rows render; re-synced on every selection change
	private shelfSelectRefreshers: (() => void)[] = [];

	// mobile toolbar toggle (shared crossfade slot) + isolated button rebuilds
	private toolbarExpanded = false;
	private toolbarActionsEl: HTMLElement | null = null;
	private contentEl: HTMLElement | null = null;

	constructor(container: HTMLElement, plugin: WatchLogPlugin, gameData: GameDataManager) {
		this.container = container;
		this.plugin = plugin;
		this.gameData = gameData;
		this.dataChangeListener = () => this.render();
		this.gameData.onChange(this.dataChangeListener);

		// restore persisted filter state
		const saved = plugin.settings.gamesFilters;
		if (saved) {
			this.filterGenreExclude    = new Set(saved.genreExclude    ?? []);
			this.filterStatusExclude   = new Set(saved.statusExclude   ?? []);
			this.filterRatingExclude   = new Set(saved.ratingExclude   ?? []);
			this.filterPriorityExclude = migratePriorityExclude(
				saved.priorityExclude,
				saved.priorityEmptyOnly,
				plugin.settings.priorities,
			);
			this.filterPlatformExclude = new Set(saved.platformExclude ?? []);
			this.filterGroupExclude    = new Set(saved.groupExclude    ?? []);
			this.filterSort          = saved.sort ?? 'dateAdded';
			this.filterSortDir       = saved.sortDir ?? 'desc';
			this.filterSecondSort    = saved.secondSort ?? 'none';
			this.filterSecondSortDir = saved.secondSortDir ?? 'asc';
			this.filterRatingEmptyOnly     = saved.ratingEmptyOnly     ?? false;
			this.filterRecentlyArrivedOnly = saved.recentlyArrivedOnly ?? false;
			this.filterFavoritesOnly       = saved.favoritesOnly       ?? false;
			this.filterWishlistOnly        = saved.wishlistOnly        ?? false;
			this.filterGroupsOnly          = saved.groupsOnly          ?? false;
		}

		// keep the preset button green while filters still match it
		const savedPreset = gameData.getSavedFilterPreset();
		if (savedPreset) {
			const setsMatch = (a: Set<string>, b: string[]): boolean =>
				a.size === b.length && b.every((x) => a.has(x));
			this.savedFilterActive =
				setsMatch(this.filterGenreExclude, savedPreset.genreExclude) &&
				setsMatch(this.filterStatusExclude, savedPreset.statusExclude) &&
				setsMatch(this.filterRatingExclude, savedPreset.ratingExclude) &&
				setsMatch(
					this.filterPriorityExclude,
					Array.from(migratePriorityExclude(
						savedPreset.priorityExclude,
						savedPreset.priorityEmptyOnly,
						plugin.settings.priorities,
					)),
				) &&
				setsMatch(this.filterPlatformExclude, savedPreset.platformExclude) &&
				setsMatch(this.filterGroupExclude, savedPreset.groupExclude ?? []) &&
				(this.filterRatingEmptyOnly === (savedPreset.ratingEmptyOnly ?? false)) &&
				(this.filterRecentlyArrivedOnly === (savedPreset.recentlyArrivedOnly ?? false)) &&
				(this.filterFavoritesOnly === (savedPreset.favoritesOnly ?? false)) &&
				(this.filterWishlistOnly === (savedPreset.wishlistOnly ?? false)) &&
				(this.filterGroupsOnly === (savedPreset.groupsOnly ?? false));
		}
	}

	destroy(): void {
		this.gameData.offChange(this.dataChangeListener);
		this.scroller?.destroy();
		this.scroller = null;
		this.coversObserver?.destroy();
		this.coversObserver = null;
		for (const fn of this.activeCleanups) fn();
		this.activeCleanups = [];
	}

	// Filter state helpers (the Watchlist pattern)

	private saveFiltersToSettings(): void {
		this.plugin.settings.gamesFilters = {
			genreExclude:    Array.from(this.filterGenreExclude),
			statusExclude:   Array.from(this.filterStatusExclude),
			ratingExclude:   Array.from(this.filterRatingExclude),
			priorityExclude: Array.from(this.filterPriorityExclude),
			platformExclude: Array.from(this.filterPlatformExclude),
			groupExclude:    Array.from(this.filterGroupExclude),
			sort:          this.filterSort,
			sortDir:       this.filterSortDir,
			secondSort:    this.filterSecondSort,
			secondSortDir: this.filterSecondSortDir,
			ratingEmptyOnly:     this.filterRatingEmptyOnly,
			recentlyArrivedOnly: this.filterRecentlyArrivedOnly,
			favoritesOnly:       this.filterFavoritesOnly,
			wishlistOnly:        this.filterWishlistOnly,
			groupsOnly:          this.filterGroupsOnly,
		};
		void this.plugin.saveSettings();
	}

	private hasActiveFilter(): boolean {
		return this.filterGenreExclude.size > 0 ||
			this.filterStatusExclude.size > 0 ||
			this.filterRatingExclude.size > 0 ||
			this.filterPriorityExclude.size > 0 ||
			this.filterPlatformExclude.size > 0 ||
			this.filterGroupExclude.size > 0 ||
			this.filterRatingEmptyOnly ||
			this.filterRecentlyArrivedOnly ||
			this.filterFavoritesOnly ||
			this.filterWishlistOnly ||
			this.filterGroupsOnly;
	}

	private clearAllFilters(): void {
		this.filterGenreExclude.clear();
		this.filterStatusExclude.clear();
		this.filterRatingExclude.clear();
		this.filterPriorityExclude.clear();
		this.filterPlatformExclude.clear();
		this.filterGroupExclude.clear();
		this.filterRatingEmptyOnly     = false;
		this.filterRecentlyArrivedOnly = false;
		this.filterFavoritesOnly       = false;
		this.filterWishlistOnly        = false;
		this.filterGroupsOnly          = false;
	}

	private applyPreset(preset: GamesSavedFilterPreset): void {
		this.filterGenreExclude    = new Set(preset.genreExclude);
		this.filterStatusExclude   = new Set(preset.statusExclude);
		this.filterRatingExclude   = new Set(preset.ratingExclude);
		this.filterPriorityExclude = migratePriorityExclude(
			preset.priorityExclude,
			preset.priorityEmptyOnly,
			this.plugin.settings.priorities,
		);
		this.filterPlatformExclude = new Set(preset.platformExclude);
		this.filterGroupExclude    = new Set(preset.groupExclude ?? []);
		this.filterRatingEmptyOnly     = preset.ratingEmptyOnly     ?? false;
		this.filterRecentlyArrivedOnly = preset.recentlyArrivedOnly ?? false;
		this.filterFavoritesOnly       = preset.favoritesOnly       ?? false;
		this.filterWishlistOnly        = preset.wishlistOnly        ?? false;
		this.filterGroupsOnly          = preset.groupsOnly          ?? false;
	}

	private deactivateSavedFilter(): void {
		if (this.savedFilterActive) {
			this.savedFilterActive = false;
			this.savedFilterBtnEl?.removeClass('wl-btn-preset-active');
		}
	}

	private gamePassesFilters(g: Game): boolean {
		if (this.filterFavoritesOnly && !g.favorite) return false;
		if (this.filterWishlistOnly && !g.wishlist) return false;
		if (this.filterGenreExclude.size > 0 && this.filterGenreExclude.has(g.type)) return false;
		if (this.filterRecentlyArrivedOnly) {
			if (!isRecentlyReleased(g.releaseDate)) return false;
		} else if (this.filterStatusExclude.size > 0 && this.filterStatusExclude.has(g.status)) {
			return false;
		}
		// rating 0 = un-rated, not a real value; only the Empty toggle shows those
		if (this.filterRatingEmptyOnly) {
			if (g.rating !== 0) return false;
		} else if (this.filterRatingExclude.size > 0 && (g.rating === 0 || this.filterRatingExclude.has(`${g.rating}★`))) {
			return false;
		}
		// '' is a real option here — no-priority games are excludable like any other
		if (this.filterPriorityExclude.size > 0 && this.filterPriorityExclude.has(g.priority)) {
			return false;
		}
		// a game hides only when EVERY one of its platforms is excluded; games with none set are
		// unaffected (the Group rule)
		if (
			this.filterPlatformExclude.size > 0 &&
			g.platforms.length > 0 &&
			g.platforms.every((p) => this.filterPlatformExclude.has(p))
		) {
			return false;
		}
		return true;
	}

	// Sorting (the Watchlist comparator semantics)

	private static readonly SORT_DEFAULT_DIR: Record<string, 'asc' | 'desc'> = {
		title:        'asc',
		dateAdded:    'desc',
		progress:     'desc',
		playtime:     'desc',
		rating:       'desc',
		priority:     'asc',
		started:      'asc',
		status:       'asc',
		dateFinished: 'desc',
		releaseDate:  'desc',
	};

	private sortLabelToKey(label: string): string {
		const map: Record<string, string> = {
			'Title':         'title',
			'Date added':    'dateAdded',
			'Progress':      'progress',
			'Playtime':      'playtime',
			'Rating':        'rating',
			'Priority':      'priority',
			'Started':       'started',
			'Status':        'status',
			'Date finished': 'dateFinished',
			'Release date':  'releaseDate',
		};
		return map[label] ?? 'dateAdded';
	}

	private getStatusIndex(status: string): number {
		const idx = this.gameData.getSettings().statuses.findIndex((s) => s.name === status);
		return idx === -1 ? 99 : idx;
	}

	/** Nullable YYYY-MM-DD → ms, nulls last in either direction. */
	private static compareNullableDates(a: string | null, b: string | null, dir: 'asc' | 'desc'): number {
		const ta = a ? new Date(a).getTime() : null;
		const tb = b ? new Date(b).getTime() : null;
		if (ta == null && tb == null) return 0;
		if (ta == null) return 1;
		if (tb == null) return -1;
		return dir === 'asc' ? ta - tb : tb - ta;
	}

	private compareGamesByKey(key: string, dir: 'asc' | 'desc', a: Game, b: Game): number {
		switch (key) {
			case 'title':
				return dir === 'asc' ? a.title.localeCompare(b.title) : b.title.localeCompare(a.title);
			case 'dateAdded': {
				const cmp = new Date(a.dateAdded).getTime() - new Date(b.dateAdded).getTime();
				return dir === 'asc' ? cmp : -cmp;
			}
			case 'progress':
				return dir === 'asc' ? a.progress - b.progress : b.progress - a.progress;
			case 'playtime': {
				// untracked (0) sorts below every real playtime, like the rating rule
				const pa = a.playtimeMinutes;
				const pb = b.playtimeMinutes;
				if (pa === 0 && pb === 0) return 0;
				if (pa === 0) return 1;
				if (pb === 0) return -1;
				return dir === 'asc' ? pa - pb : pb - pa;
			}
			case 'rating': {
				if (dir === 'desc') {
					// un-rated (0) sorts below every real rating
					const ra = a.rating === 0 ? -1 : a.rating;
					const rb = b.rating === 0 ? -1 : b.rating;
					return rb - ra;
				}
				if (a.rating === 0 && b.rating === 0) return 0;
				if (a.rating === 0) return 1;
				if (b.rating === 0) return -1;
				return a.rating - b.rating;
			}
			case 'priority': {
				// direction-agnostic High → Low, empty last (the Watchlist rule)
				const ai = PRIORITY_ORDER.indexOf(a.priority as typeof PRIORITY_ORDER[number]);
				const bi = PRIORITY_ORDER.indexOf(b.priority as typeof PRIORITY_ORDER[number]);
				return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
			}
			case 'started':
				return GamesTab.compareNullableDates(a.dateStarted, b.dateStarted, dir);
			case 'status': {
				const cmp = this.getStatusIndex(a.status) - this.getStatusIndex(b.status);
				return dir === 'asc' ? cmp : -cmp;
			}
			case 'dateFinished':
				return GamesTab.compareNullableDates(a.dateFinished, b.dateFinished, dir);
			case 'releaseDate':
				return GamesTab.compareNullableDates(a.releaseDate, b.releaseDate, dir);
			default:
				return 0;
		}
	}

	/** Fields the Games search covers — also drives the "?" help panel. */
	searchFields(): SearchFieldSpec<Game>[] {
		return [
			{ name: 'title', label: 'Title', weight: 0.6, text: (g) => [g.title] },
			{ name: 'developer', label: 'Developer', weight: 0.15, aliases: ['dev'], text: (g) => [g.developer] },
			{ name: 'publisher', label: 'Publisher', weight: 0.1, aliases: ['pub'], text: (g) => [g.publisher] },
			{ name: 'platform', label: 'Platform', weight: 0.1, aliases: ['platforms'], text: (g) => g.platforms },
			{ name: 'year', label: 'Year', weight: 0.05, text: (g) => { const y = yearOf(g.releaseDate); return y ? [String(y)] : []; }, number: (g) => yearOf(g.releaseDate) },
			{ name: 'rating', label: 'Rating', number: (g) => g.rating },
			{ name: 'hours', label: 'Hours played', number: (g) => g.playtimeMinutes / 60 },
		];
	}

	/** Matching game ids, or null for an empty query. */
	private getSearchMatchedIds(): Set<string> | null {
		return searchItems(this.gameData.getGames(), { id: (g) => g.id, fields: this.searchFields() }, this.searchQuery);
	}

	/** An empty query (null set) matches everything. */
	private gameMatchesSearch(g: Game, matched: Set<string> | null): boolean {
		return matched === null || matched.has(g.id);
	}

	/**
	 * The active two-level Sorting selection applied to a copy of `list` — shared by the flat
	 * pipeline, the shelves, and the grouped grids, which sort within each bucket.
	 */
	private sortGames(list: Game[]): Game[] {
		return [...list].sort((a, b) => {
			const primary = this.compareGamesByKey(this.filterSort, this.filterSortDir, a, b);
			if (primary !== 0) return primary;
			if (this.filterSecondSort !== 'none') {
				return this.compareGamesByKey(this.filterSecondSort, this.filterSecondSortDir, a, b);
			}
			return 0;
		});
	}

	/** Search + filters + primary/secondary sort applied to the games list. */
	private getDisplayGames(): Game[] {
		const matched = this.getSearchMatchedIds();
		return this.sortGames(this.gameData.getGames().filter((g) =>
			this.gameMatchesSearch(g, matched) && this.gamePassesFilters(g),
		));
	}

	// Display items (merged groups + top-level games)

	/**
	 * The grid's item list: groups plus ungrouped games, sorted together. A group survives search
	 * when its name or any member matches, survives the name exclude, and survives filters when any
	 * member passes. "Groups only" drops every standalone game.
	 */
	private getDisplayItems(): GameDisplayItem[] {
		const groupedIds = this.gameData.getGroupedGameIds();

		const topLevel = this.filterGroupsOnly
			? []
			: this.getDisplayGames().filter((g) => !groupedIds.has(g.id));

		const items: GameDisplayItem[] = [
			...this.getVisibleGroups().map((g) => ({ kind: 'group' as const, data: g.data, members: g.members })),
			...topLevel.map((g) => ({ kind: 'game' as const, data: g })),
		];
		items.sort((a, b) => {
			const primary = this.compareItemsByKey(this.filterSort, this.filterSortDir, a, b);
			if (primary !== 0) return primary;
			if (this.filterSecondSort !== 'none') {
				return this.compareItemsByKey(this.filterSecondSort, this.filterSecondSortDir, a, b);
			}
			return 0;
		});
		return items;
	}

	/**
	 * Groups surviving the active search/filters — the shared rule for the grid and the Groups
	 * shelf: the name exclude drops the group, a search must hit the name or a member, and any
	 * active filter must pass for at least one member.
	 */
	private getVisibleGroups(): Array<{ data: GameGroup; members: Game[] }> {
		const groups = this.gameData.getGroups();
		const gameMap = new Map(this.gameData.getGames().map((g) => [g.id, g]));
		const q = this.searchQuery.trim().toLowerCase();
		const matched = this.getSearchMatchedIds();
		const anyFilterActive = this.hasActiveFilter();

		const out: Array<{ data: GameGroup; members: Game[] }> = [];
		for (const group of groups) {
			if (this.filterGroupExclude.size > 0 && this.filterGroupExclude.has(group.name)) continue;

			const members = group.gameIds
				.map((id) => gameMap.get(id))
				.filter((g): g is Game => g !== undefined);

			if (q) {
				const nameMatch = group.name.toLowerCase().includes(q);
				const memberMatch = members.some((m) => this.gameMatchesSearch(m, matched));
				if (!nameMatch && !memberMatch) continue;
			}

			if (anyFilterActive && !members.some((m) => this.gamePassesFilters(m))) continue;

			out.push({ data: group, members });
		}
		return out;
	}

	/**
	 * Item-level comparator: games compare via compareGamesByKey; a group compares through a
	 * synthetic aggregate of its members (newest dateAdded, mean progress/rating over rated members,
	 * most-urgent priority, earliest start, most-active status, latest finish/release).
	 */
	private compareItemsByKey(key: string, dir: 'asc' | 'desc', a: GameDisplayItem, b: GameDisplayItem): number {
		return this.compareGamesByKey(key, dir, this.itemSortProxy(a), this.itemSortProxy(b));
	}

	/** A game whose sort-relevant fields carry the group's aggregate values (games pass through). */
	private itemSortProxy(item: GameDisplayItem): Game {
		if (item.kind === 'game') return item.data;
		const m = item.members;
		const maxDate = (dates: Array<string | null>): string | null => {
			const real = dates.filter((d): d is string => !!d);
			return real.length > 0 ? real.reduce((x, y) => (x > y ? x : y)) : null;
		};
		const minDate = (dates: Array<string | null>): string | null => {
			const real = dates.filter((d): d is string => !!d);
			return real.length > 0 ? real.reduce((x, y) => (x < y ? x : y)) : null;
		};
		const rated = m.filter((g) => g.rating > 0);
		const priorityIdx = m
			.map((g) => PRIORITY_ORDER.indexOf(g.priority as typeof PRIORITY_ORDER[number]))
			.filter((i) => i !== -1);
		const statusIdx = m.map((g) => this.getStatusIndex(g.status));
		const statuses = this.gameData.getSettings().statuses;
		const first = m[0];
		return {
			...(first ?? ({} as Game)),
			title: item.data.name,
			dateAdded: maxDate(m.map((g) => g.dateAdded)) ?? item.data.dateAdded,
			progress: gameGroupProgress(m),
			playtimeMinutes: m.reduce((sum, g) => sum + g.playtimeMinutes, 0),
			rating: rated.length > 0 ? rated.reduce((s, g) => s + g.rating, 0) / rated.length : 0,
			priority: priorityIdx.length > 0 ? PRIORITY_ORDER[Math.min(...priorityIdx)] ?? '' : '',
			dateStarted: minDate(m.map((g) => g.dateStarted)),
			status: statusIdx.length > 0 ? statuses[Math.min(...statusIdx)]?.name ?? '' : '',
			dateFinished: maxDate(m.map((g) => g.dateFinished)),
			releaseDate: maxDate(m.map((g) => g.releaseDate)),
		};
	}

	// Render

	render(): void {
		this.container.empty();
		this.container.addClass('wl-games-tab');

		// header — the Watchlist toolbar structure (search + action buttons, crossfading behind a
		// chevron on mobile)
		const header = this.container.createDiv({ cls: 'wl-list-header' });
		const controls = header.createDiv({ cls: 'wl-header-controls' });
		renderToolbarWithMobileToggle({
			controls,
			renderSearch: (parent) => this.renderSearch(parent),
			renderActions: (parent) => {
				// display: contents — children stay in the flex row, buttons rebuild in isolation
				const wrap = parent.createDiv({ cls: 'wl-toolbar-actions' });
				this.toolbarActionsEl = wrap;
				this.renderToolbarActions(wrap);
			},
			expanded: this.toolbarExpanded,
			onToggleChange: (expanded) => { this.toolbarExpanded = expanded; },
		});

		this.contentEl = this.container.createDiv({ cls: 'wl-games-content' });
		this.renderContent();
	}

	/**
	 * Rebuilds only the content below the toolbar (count, shelves, grids), so filter/sort/search
	 * changes never tear down the search input.
	 */
	private renderContent(): void {
		const content = this.contentEl;
		if (!content) return;
		this.scroller?.destroy();
		this.scroller = null;
		this.coversObserver?.destroy();
		this.coversObserver = null;
		for (const fn of this.activeCleanups) fn();
		this.activeCleanups = [];
		content.empty();

		const allGames = this.gameData.getGames();
		if (allGames.length === 0 && this.gameData.getGroups().length === 0) {
			const empty = content.createDiv({ cls: 'wl-cards-empty' });
			empty.createSpan({ cls: 'wl-cards-empty-icon', text: '🎮' });
			empty.createEl('p', { cls: 'wl-cards-empty-msg', text: 'No games yet; click + Add to track your first game.' });
			return;
		}

		// search/filter keeps the sections layout; a section with no matches disappears entirely
		const matched = this.getSearchMatchedIds();
		const filtering = matched !== null || this.hasActiveFilter();
		const gameVisible = (g: Game): boolean =>
			!filtering ||
			(!this.filterGroupsOnly && this.gameMatchesSearch(g, matched) && this.gamePassesFilters(g));

		const items = this.getDisplayItems();
		const visibleGroups = this.getVisibleGroups();
		const gameCount = items.reduce((n, item) => n + (item.kind === 'game' ? 1 : 0), 0);
		const groupCount = items.length - gameCount;
		const countParts = [`${gameCount} game${gameCount !== 1 ? 's' : ''}`];
		if (groupCount > 0) countParts.push(`${groupCount} group${groupCount !== 1 ? 's' : ''}`);
		const countEl = content.createDiv({
			cls: 'wl-results-count wl-results-count-rows',
			text: countParts.join(', '),
		});
		const gearBtn = countEl.createEl('button', { cls: 'wl-rows-customize-btn' });
		gearBtn.setAttr('aria-label', 'Customize rows');
		setIcon(gearBtn, 'settings');
		gearBtn.addEventListener('click', () => {
			new RowsCustomizeModal(this.plugin.app, this.plugin, {
				shelves: GAMES_ROWS_SHELVES,
				getLayout: () => this.gameData.getSettings().rowsLayout,
				setLayout: (layout) => { this.gameData.getSettings().rowsLayout = layout; },
				// the layout lives inside data.json's games key, not plugin.settings — persist through the games
				// data manager (quiet: onChanged re-renders this tab itself)
				persist: () => this.gameData.persistQuiet(),
				onChanged: () => this.renderContent(),
				hint: 'Reorder the sections or switch them off. "By genre" and "By status" are the grouped grid sections; only one can be on at a time, and with both off the games show as one flat grid.',
				exclusiveGroups: ROWS_EXCLUSIVE_SHELVES,
			}).open();
		});

		const scroll = content.createDiv({ cls: 'wl-rows-scroll-container' });
		// shelf cards mirror the grids' *computed* card width (setRowsCardWidth); one metrics source
		// keeps shelves matching grids across resizes. Heights come from the CSS 2:3 ratio.
		const metrics = (w: number): GridMetrics => {
			const m = computeGridMetrics(w, this.plugin.getCardMinWidth());
			setRowsCardWidth(scroll, m.cardWidth);
			// text-under cells are poster + text block
			if (this.plugin.isCardTextUnder('games')) {
				const cardHeight = m.cardHeight + POSTER_CARD_TEXT_H;
				return { cols: m.cols, cardWidth: m.cardWidth, cardHeight, rowHeight: cardHeight + 12 };
			}
			return m;
		};
		const cardW = metrics(scroll.clientWidth).cardWidth;
		// the observer serves the eager shelf cards and the virtualised grids alike
		const observer = new LazyCardObserver(
			'.wl-card[data-needs-poster="true"]',
			(cards) => this.handleCoversVisible(cards),
		);
		this.coversObserver = observer;
		const scroller = new VirtualScroller({
			scroll,
			metrics,
			onWindowChanged: () => observer.observeNew(scroll),
			onScrollPos: (top) => { this.persistentScrollTop = top; },
		});
		this.scroller = scroller;
		const gameCard = (strip: HTMLElement, g: Game): void =>
			this.renderGameCard(strip, g, cardW);
		this.shelfSelectRefreshers = [];
		const sel = (items: { id: string }[]): ShelfSelect | undefined =>
			this.shelfSelect(items.map((i) => i.id));

		// section builders keyed by rowsLayout id — each computes its own list (so a disabled section
		// costs nothing), then hides non-matching games: Recently Added stays the 10 newest overall, not
		// the 10 newest matches. Grouped favorites stay on the shelf — a game only leaves the flat grid.
		const shelfRenderers: Record<string, () => void> = {
			favorites: () => {
				// newest favorite first — this shelf ignores the tab sort
				const favorites = sortByFavorited(allGames.filter((g) => g.favorite && gameVisible(g)));
				renderShelf(
					scroll, 'Favorites', favorites,
					'No favorites yet; use a card\'s ⋮ menu to favorite a game.',
					filtering, gameCard, sel(favorites),
				);
			},
			recommended: () => {
				const recommended = this.getRecommendedGames(allGames).filter(gameVisible);
				renderShelf(
					scroll, 'Recommended', recommended,
					'Nothing to recommend; add games you plan to play.',
					filtering, gameCard, sel(recommended),
				);
			},
			recentlyAdded: () => {
				const recentlyAdded = [...allGames]
					.sort((a, b) => (b.dateAdded ?? '').localeCompare(a.dateAdded ?? ''))
					.slice(0, 10)
					.filter(gameVisible);
				renderShelf(
					scroll, 'Recently Added', recentlyAdded,
					'Nothing here yet; added games will show up in this row.',
					filtering, gameCard, sel(recentlyAdded),
				);
			},
			recentlyPlayed: () => {
				const recentlyPlayed = this.getRecentlyPlayedGames(allGames).filter(gameVisible);
				renderShelf(
					scroll, 'Recently Played', recentlyPlayed,
					'Nothing played yet; games you progress or finish show up here.',
					filtering, gameCard, sel(recentlyPlayed),
				);
			},
			groups: () => {
				this.renderGroupsShelf(scroll, visibleGroups, filtering);
			},
			recentlyReleased: () => {
				// past releases only; today counts as released
				const today = GamesTab.todayStamp();
				const recentlyReleased = allGames
					.filter(
						(g) =>
							g.status !== GAME_AUTO_STATUS &&
							!!g.releaseDate &&
							/^\d{4}-\d{2}-\d{2}$/.test(g.releaseDate) &&
							g.releaseDate <= today,
					)
					.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
					.slice(0, 10)
					.filter(gameVisible);
				renderShelf(
					scroll, 'Recently Released', recentlyReleased,
					'No released games yet; games with a past release date show up here.',
					filtering, gameCard, sel(recentlyReleased),
				);
			},
			// the grouped grids are mutually exclusive (normalizeRowsLayout guarantees it)
			byType: () => {
				this.renderGroupedGridsSection(scroll, gameVisible, filtering, 'byType');
			},
			byStatus: () => {
				this.renderGroupedGridsSection(scroll, gameVisible, filtering, 'byStatus');
			},
		};

		// user order + visibility: with BOTH grouped grids off, the flat "All games" grid renders at the
		// first grid entry's position
		const layout = normalizeRowsLayout(this.gameData.getSettings().rowsLayout, GAMES_ROWS_SHELVES);
		const gridIds = new Set(['byType', 'byStatus']);
		const anyGridEnabled = layout.some((e) => gridIds.has(e.id) && e.enabled);
		const anyShelfEnabled = layout.some((e) => !gridIds.has(e.id) && e.enabled);
		let flatRendered = false;
		for (const entry of layout) {
			if (!anyGridEnabled && gridIds.has(entry.id)) {
				if (!flatRendered) {
					flatRendered = true;
					this.renderAllGamesSection(scroll, anyShelfEnabled, items);
				}
				continue;
			}
			if (!entry.enabled) continue;
			shelfRenderers[entry.id]?.();
		}

		observer.observeNew(scroll);
		scroller.attach(this.persistentScrollTop);
	}

	/** Horizontal strip of group cover cards. `groups` is already visibility-filtered. */
	private renderGroupsShelf(
		parent: HTMLElement,
		groups: Array<{ data: GameGroup; members: Game[] }>,
		filtering: boolean,
	): void {
		if (filtering && groups.length === 0) return;
		const shelf = parent.createDiv({ cls: 'wl-rows-shelf' });
		renderShelfTitle(shelf, 'Groups', groups.length, this.shelfSelect(groups.map((g) => g.data.id)));
		if (groups.length === 0) {
			shelf.createDiv({
				cls: 'wl-rows-shelf-empty',
				text: 'No groups yet; group related games to see their covers here.',
			});
			return;
		}
		const strip = shelf.createDiv({ cls: 'wl-rows-strip' });
		for (const group of groups) {
			this.renderGroupCard(strip, group.data, group.members);
		}
	}

	/**
	 * "By genre" / "By status" — one grid per configured genre (or status), in settings order; empty
	 * buckets are skipped and each game appears once under its own bucket (grouped games included —
	 * a game only leaves the flat grid). Virtualised per bucket.
	 */
	private renderGroupedGridsSection(
		parent: HTMLElement,
		gameVisible: (g: Game) => boolean,
		filtering: boolean,
		mode: 'byType' | 'byStatus',
	): void {
		const byType = mode === 'byType';
		const settings = this.gameData.getSettings();
		const defs = byType ? settings.types : settings.statuses;
		const keyOf = (g: Game): string => (byType ? g.type : g.status);

		const section = parent.createDiv({ cls: 'wl-rows-bytype' });
		section.createDiv({ cls: 'wl-rows-bytype-title', text: byType ? 'By genre' : 'By status' });

		const allGames = this.gameData.getGames();
		let rendered = 0;
		for (const def of defs) {
			const bucketGames = this.sortGames(
				allGames.filter((g) => keyOf(g) === def.name && gameVisible(g)),
			);
			if (bucketGames.length === 0) continue;
			rendered++;
			renderShelfTitle(section, def.name, bucketGames.length, this.shelfSelect(bucketGames.map((g) => g.id)));
			const spacer = section.createDiv({ cls: 'wl-rows-bytype-spacer' });
			const grid = spacer.createDiv({ cls: 'wl-cards-grid wl-cards-grid-virtual' });
			const vgrid = new VirtualGrid(spacer, grid, bucketGames.length, {
				buildItem: (i, w, h) => {
					const game = bucketGames[i];
					if (!game) return null;
					const tmp = createDiv();
					this.renderGameCard(tmp, game, w, h);
					return tmp.firstElementChild as HTMLElement | null;
				},
				removeItem: (el) => el.remove(),
			});
			this.scroller?.addSection(vgrid, spacer);
		}
		if (rendered === 0) {
			if (filtering) {
				section.remove();
				return;
			}
			section.createDiv({
				cls: 'wl-rows-shelf-empty',
				text: `No games yet; added games are grouped by ${byType ? 'genre' : 'status'} here.`,
			});
		}
	}

	/**
	 * The flat grid over groups + ungrouped games — the Rows fallback, rendered only when neither
	 * grouped grid is on. `titled` adds the "All games" header when other sections exist.
	 */
	private renderAllGamesSection(parent: HTMLElement, titled: boolean, items: GameDisplayItem[]): void {
		if (items.length === 0) {
			if (!titled) {
				parent.createDiv({
					cls: 'wl-reading-empty-search',
					text: this.searchQuery.trim()
						? `No matches for "${this.searchQuery.trim()}".`
						: 'No games match the current filters.',
				});
			}
			return;
		}
		const section = parent.createDiv({ cls: 'wl-rows-bytype' });
		if (titled) renderShelfTitle(section, 'All games', items.length, this.shelfSelect(items.map((i) => i.data.id)));
		const spacer = section.createDiv({ cls: 'wl-rows-bytype-spacer' });
		const grid = spacer.createDiv({ cls: 'wl-cards-grid wl-cards-grid-virtual' });
		const vgrid = new VirtualGrid(spacer, grid, items.length, {
			buildItem: (i, w, h) => {
				const item = items[i];
				if (!item) return null;
				const tmp = createDiv();
				if (item.kind === 'game') {
					this.renderGameCard(tmp, item.data, w, h);
				} else {
					this.renderGroupCard(tmp, item.data, item.members, h);
				}
				return tmp.firstElementChild as HTMLElement | null;
			},
			// no lazy cover observer — covers are filled at add time, so a plain remove suffices
			removeItem: (el) => el.remove(),
		});
		this.scroller?.addSection(vgrid, spacer);
	}

	/** Local calendar day as YYYY-MM-DD. */
	private static todayStamp(): string {
		const now = new Date();
		return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	}

	// daily picks the Recommended shelf shows (pool permitting)
	private static readonly RECOMMENDED_COUNT = 10;

	/**
	 * Daily random picks for the Recommended shelf: up to 10 games from the not-yet-finished pool
	 * (everything except Finished / Dropped / To be released — status names are configurable, so
	 * exclusion beats listing the plan/playing names). Stored in data.json and re-rolled only on a
	 * new calendar day; a short same-day list is topped up without re-rolling the kept picks.
	 */
	private getRecommendedGames(allGames: Game[]): Game[] {
		const pool = allGames.filter(
			(g) => g.status !== GAME_FINISHED_STATUS && g.status !== 'Dropped' && g.status !== GAME_AUTO_STATUS,
		);
		const today = GamesTab.todayStamp();

		const stored = this.gameData.getRecommendedDaily();
		if (stored.date === today) {
			const byId = new Map(pool.map((g) => [g.id, g]));
			const picks = stored.ids
				.map((id) => byId.get(id))
				.filter((g): g is Game => g !== undefined);
			if (picks.length < GamesTab.RECOMMENDED_COUNT && picks.length < pool.length) {
				const used = new Set(picks.map((g) => g.id));
				picks.push(...GamesTab.pickRandom(
					pool.filter((g) => !used.has(g.id)),
					GamesTab.RECOMMENDED_COUNT - picks.length,
				));
				this.gameData.setRecommendedDaily({ date: today, ids: picks.map((g) => g.id) });
			}
			return picks;
		}

		const picks = GamesTab.pickRandom(pool, GamesTab.RECOMMENDED_COUNT);
		this.gameData.setRecommendedDaily({ date: today, ids: picks.map((g) => g.id) });
		return picks;
	}

	/**
	 * Games with any play signal (Steam playtime, progress, a start date or a finish date), most
	 * recently played first (max 10).
	 *
	 * `lastPlayed` is a real timestamp and comes from a Steam sync, so it sorts ahead of every game
	 * without one. Games log no session history, so unsynced entries fall back to dateModified —
	 * which can surface a merely-edited game, the accepted tradeoff.
	 */
	private getRecentlyPlayedGames(allGames: Game[]): Game[] {
		return allGames
			.filter((g) => g.progress > 0 || g.playtimeMinutes > 0 || !!g.dateStarted || !!g.dateFinished)
			.sort((a, b) => {
				if (a.lastPlayed && b.lastPlayed) return b.lastPlayed.localeCompare(a.lastPlayed);
				if (a.lastPlayed) return -1;
				if (b.lastPlayed) return 1;
				return (b.dateModified ?? '').localeCompare(a.dateModified ?? '');
			})
			.slice(0, 10);
	}

	/** Fisher–Yates on a copy, returning the first `count` items. */
	private static pickRandom<T>(pool: T[], count: number): T[] {
		const arr = [...pool];
		for (let i = arr.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			const tmp = arr[i]!;
			arr[i] = arr[j]!;
			arr[j] = tmp;
		}
		return arr.slice(0, count);
	}

	private renderSearch(parent: HTMLElement): void {
		// compact inline search inside the toolbar row (the Watchlist classes)
		const searchWrap = parent.createDiv({ cls: 'wl-reading-search-wrap' });
		const input = searchWrap.createEl('input', {
			cls: 'wl-reading-search-input',
			attr: { type: 'text', placeholder: 'Search title, developer, platform…' },
		});
		input.value = this.searchQuery;
		renderSearchHelpButton(searchWrap, this.plugin.app, 'Games', () => this.searchFields());
		// clear button — only while there is text
		const clearBtn = searchWrap.createEl('button', {
			cls: 'wl-search-clear',
			attr: { type: 'button', 'aria-label': 'Clear search' },
		});
		setIcon(clearBtn, 'x');
		const syncClear = () => clearBtn.toggleClass('is-visible', input.value.length > 0);
		syncClear();
		let searchDebounce = 0;
		input.addEventListener('input', () => {
			this.searchQuery = input.value;
			syncClear();
			window.clearTimeout(searchDebounce);
			searchDebounce = window.setTimeout(() => {
				this.renderContent();
			}, 250);
		});
		clearBtn.addEventListener('click', () => {
			window.clearTimeout(searchDebounce);
			input.value = '';
			this.searchQuery = '';
			syncClear();
			input.focus();
			this.renderContent();
		});
	}

	/**
	 * Rebuilds only the toolbar action buttons, so selection changes never tear down the grid or the
	 * search input.
	 */
	private refreshToolbarActions(): void {
		const wrap = this.toolbarActionsEl;
		if (!wrap || !wrap.isConnected) return;
		wrap.empty();
		this.renderToolbarActions(wrap);
	}

	private renderToolbarActions(controls: HTMLElement): void {
		// saved filter preset (only when one is stored)
		const preset = this.gameData.getSavedFilterPreset();
		if (preset) {
			const savedBtn = controls.createEl('button', {
				cls: `wl-btn wl-btn-sm${this.savedFilterActive ? ' wl-btn-preset-active' : ''}`,
				text: 'Saved filter',
			});
			this.savedFilterBtnEl = savedBtn;
			savedBtn.addEventListener('click', () => {
				this.applyPreset(preset);
				this.savedFilterActive = true;
				this.saveFiltersToSettings();
				this.refreshToolbarActions();
				this.renderContent();
			});
		} else {
			this.savedFilterBtnEl = null;
		}

		this.renderFiltersDropdown(controls);

		this.renderSortingDropdown(controls);

		// action bar — selection mode with items selected
		if (this.selectionMode && this.selectedIds.size > 0) {
			this.renderActionBar(controls);
		}

		if (this.selectionMode) {
			const hasAny = this.selectedIds.size > 0;
			const selAllBtn = controls.createEl('button', { cls: 'wl-btn wl-btn-sm', text: hasAny ? 'None' : 'All' });
			selAllBtn.title = hasAny ? 'Deselect all' : 'Select all visible';
			selAllBtn.addEventListener('click', () => {
				if (this.selectedIds.size > 0) {
					this.selectedIds.clear();
				} else {
					for (const item of this.getDisplayItems()) {
						this.selectedIds.add(item.data.id);
					}
				}
				this.refreshToolbarActions();
				this.syncCardSelectionClasses();
			});
		}

		// in selection mode the button is the way out — red Cancel
		const selBtn = controls.createEl('button', {
			cls: `wl-btn wl-btn-sm${this.selectionMode ? ' wl-btn-cancel' : ''}`,
			text: this.selectionMode ? 'Cancel' : 'Select',
		});
		selBtn.addEventListener('click', () => {
			this.setSelectionMode(!this.selectionMode);
		});

		// add button, far right on the toolbar row
		const rightGroup = controls.createDiv({ cls: 'wl-header-controls-right' });
		const addBtnWrap = rightGroup.createDiv({ cls: 'wl-add-btn-wrap' });
		const addBtn = addBtnWrap.createEl('button', { cls: 'wl-add-btn wl-btn-success', text: '+ add' });
		addBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openAddPrompt();
		});
	}

	private renderFiltersDropdown(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: 'wl-add-btn-wrap' });
		const btn = wrap.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Filters ▼' });
		const dotEl = btn.createSpan({ cls: 'wl-filter-dot' });
		if (this.hasActiveFilter()) { dotEl.show(); } else { dotEl.hide(); }

		const clearBtn = parent.createEl('button', { cls: 'wl-btn wl-btn-sm wl-btn-clear-filters', text: '✕ clear' });
		clearBtn.title = 'Clear all filters';
		if (this.hasActiveFilter()) { clearBtn.show(); } else { clearBtn.hide(); }
		clearBtn.addEventListener('click', () => {
			this.clearAllFilters();
			this.saveFiltersToSettings();
			this.deactivateSavedFilter();
			dotEl.hide();
			clearBtn.hide();
			this.renderContent();
		});

		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			const settings = this.gameData.getSettings();

			const genreOpts = settings.types.map((t) => t.name);
			const statusOpts = settings.statuses.map((s) => s.name);
			// half options (½ … 4½) appear only when a game holds that exact rating (the Watchlist rule)
			const presentHalfRatings = new Set<number>();
			for (const g of this.gameData.getGames()) {
				if (g.rating % 1 === 0.5) presentHalfRatings.add(g.rating);
			}
			const ratingOpts: string[] = [];
			for (let i = 1; i <= 5; i++) {
				if (presentHalfRatings.has(i - 0.5)) ratingOpts.push(`${i - 0.5}★`);
				ratingOpts.push(`${i}★`);
			}
			const formatRatingOpt = (opt: string): string =>
				opt.replace(/^(\d+)\.5/, (_m, whole: string) => (whole === '0' ? '½' : `${whole}½`));
			const priorityOpts = priorityFilterOpts(this.plugin.settings.priorities);
			const platformOpts = settings.platforms.map((p) => p.name);
			const groupOpts = this.gameData.getGroups().map((g) => g.name);

			// draft — live filter state only changes on Apply
			const draft = {
				genreExclude:    new Set(this.filterGenreExclude),
				statusExclude:   new Set(this.filterStatusExclude),
				ratingExclude:   new Set(this.filterRatingExclude),
				priorityExclude: new Set(this.filterPriorityExclude),
				platformExclude: new Set(this.filterPlatformExclude),
				groupExclude:    new Set(this.filterGroupExclude),
				filterRatingEmptyOnly:     this.filterRatingEmptyOnly,
				filterRecentlyArrivedOnly: this.filterRecentlyArrivedOnly,
				filterFavoritesOnly:       this.filterFavoritesOnly,
				filterWishlistOnly:        this.filterWishlistOnly,
				filterGroupsOnly:          this.filterGroupsOnly,
			};

			const sections: FilterSection[] = [
				{ label: 'Genre', opts: genreOpts, excludeSet: draft.genreExclude },
				{
					label: 'Status', opts: statusOpts, excludeSet: draft.statusExclude,
					specials: [{
						text: '✦ Recently arrived',
						spanCls: 'wl-recently-arrived-filter',
						get: () => draft.filterRecentlyArrivedOnly,
						set: (v) => { draft.filterRecentlyArrivedOnly = v; },
						mode: 'exclusive',
						resetOnGlobal: true,
					}],
				},
				{
					label: 'Rating', opts: ratingOpts, excludeSet: draft.ratingExclude,
					formatOpt: formatRatingOpt,
					specials: [{
						text: 'Empty',
						get: () => draft.filterRatingEmptyOnly,
						set: (v) => { draft.filterRatingEmptyOnly = v; },
						mode: 'exclusive',
					}],
				},
				{
					label: 'Priority', opts: priorityOpts, excludeSet: draft.priorityExclude,
					formatOpt: formatPriorityOpt,
				},
			];
			if (platformOpts.length > 0) {
				sections.push({ label: 'Platform', opts: platformOpts, excludeSet: draft.platformExclude });
			}
			if (groupOpts.length > 0) {
				sections.push({
					label: 'Group', opts: groupOpts, excludeSet: draft.groupExclude,
					specials: [{
						text: '◇ Groups only',
						spanCls: 'wl-recently-arrived-filter',
						get: () => draft.filterGroupsOnly,
						set: (v) => { draft.filterGroupsOnly = v; },
						mode: 'independent',
						dividerAfter: true,
					}],
				});
			}

			toggleFilterPanel({
				anchor: btn,
				outsideGuard: wrap,
				registerCleanup: (fn) => this.activeCleanups.push(fn),
				sections,
				favorites: {
					get: () => draft.filterFavoritesOnly,
					set: (v) => { draft.filterFavoritesOnly = v; },
				},
				standaloneRows: [{
					text: '🎁 Wishlist',
					spanCls: 'wl-wishlist-filter',
					get: () => draft.filterWishlistOnly,
					set: (v) => { draft.filterWishlistOnly = v; },
				}],
				presetExists: this.gameData.getSavedFilterPreset() !== null,
				onPresetSave: async () => {
					await this.gameData.setSavedFilterPreset({
						genreExclude:    Array.from(draft.genreExclude),
						statusExclude:   Array.from(draft.statusExclude),
						ratingExclude:   Array.from(draft.ratingExclude),
						priorityExclude: Array.from(draft.priorityExclude),
						platformExclude: Array.from(draft.platformExclude),
						groupExclude:    Array.from(draft.groupExclude),
						ratingEmptyOnly:     draft.filterRatingEmptyOnly,
						recentlyArrivedOnly: draft.filterRecentlyArrivedOnly,
						favoritesOnly:       draft.filterFavoritesOnly,
						wishlistOnly:        draft.filterWishlistOnly,
						groupsOnly:          draft.filterGroupsOnly,
					});
				},
				onPresetDelete: async () => {
					await this.gameData.setSavedFilterPreset(null);
					this.savedFilterActive = false;
				},
				onPresetChanged: () => this.render(),
				onApply: () => {
					this.filterGenreExclude    = draft.genreExclude;
					this.filterStatusExclude   = draft.statusExclude;
					this.filterRatingExclude   = draft.ratingExclude;
					this.filterPriorityExclude = draft.priorityExclude;
					this.filterPlatformExclude = draft.platformExclude;
					this.filterGroupExclude    = draft.groupExclude;
					this.filterRatingEmptyOnly     = draft.filterRatingEmptyOnly;
					this.filterRecentlyArrivedOnly = draft.filterRecentlyArrivedOnly;
					this.filterFavoritesOnly       = draft.filterFavoritesOnly;
					this.filterWishlistOnly        = draft.filterWishlistOnly;
					this.filterGroupsOnly          = draft.filterGroupsOnly;
					this.saveFiltersToSettings();
					this.deactivateSavedFilter();
					const active = this.hasActiveFilter();
					if (active) { dotEl.show(); clearBtn.show(); } else { dotEl.hide(); clearBtn.hide(); }
					this.renderContent();
				},
			});
		});
	}

	private renderSortingDropdown(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: 'wl-add-btn-wrap' });
		const btn = wrap.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Sorting ▼' });

		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			toggleSortPopover({
				wrap,
				anchor: btn,
				registerCleanup: (fn) => this.activeCleanups.push(fn),
				options: [
					'Title', 'Date added', 'Progress', 'Playtime', 'Rating', 'Priority',
					'Started', 'Status', 'Date finished', 'Release date',
				],
				labelToKey: (label) => this.sortLabelToKey(label),
				defaultDirs: GamesTab.SORT_DEFAULT_DIR,
				primary: { key: this.filterSort, dir: this.filterSortDir },
				secondary: { key: this.filterSecondSort, dir: this.filterSecondSortDir },
				onChange: (primary, secondary) => {
					this.filterSort          = primary.key;
					this.filterSortDir       = primary.dir;
					this.filterSecondSort    = secondary.key;
					this.filterSecondSortDir = secondary.dir;
					this.saveFiltersToSettings();
					// sorting only reorders content
					this.renderContent();
				},
			});
		});
	}

	// Selection mode

	/**
	 * Enters/exits selection mode without a full rebuild — the grid DOM is untouched; only the
	 * toolbar buttons and card selection classes change.
	 */
	private setSelectionMode(on: boolean): void {
		this.selectionMode = on;
		this.selectedIds.clear();
		// full rebuild: the section headers gain/lose their select-all box
		this.render();
	}

	/**
	 * Select-all spec for one Rows section. undefined outside selection mode, which is what keeps
	 * the box out of the header. Ids, not DOM: the grid sections are virtualised.
	 */
	private shelfSelect(ids: string[]): ShelfSelect | undefined {
		if (!this.selectionMode) return undefined;
		return {
			ids,
			selected: this.selectedIds,
			onToggle: (sectionIds, selectAll) => {
				for (const id of sectionIds) {
					if (selectAll) { this.selectedIds.add(id); } else { this.selectedIds.delete(id); }
				}
				this.syncCardSelectionClasses();
				this.refreshToolbarActions();
			},
			register: (refresh) => this.shelfSelectRefreshers.push(refresh),
		};
	}

	/** A game can sit in several sections, so every header box re-reads the set. */
	private refreshShelfSelects(): void {
		for (const refresh of this.shelfSelectRefreshers) refresh();
	}

	/** Applies/removes wl-card-selected on every currently rendered card. */
	private syncCardSelectionClasses(): void {
		this.container.querySelectorAll<HTMLElement>('.wl-card').forEach((card) => {
			const id = card.dataset.gameId ?? card.dataset.groupId;
			card.classList.toggle('wl-card-selected', !!id && this.selectedIds.has(id));
		});
		this.refreshShelfSelects();
	}

	/**
	 * Selection click — state + class only. A game can render twice (Favorites shelf AND grid), so
	 * every instance of the id is synced.
	 */
	private toggleCardSelection(card: HTMLElement, id: string): void {
		if (this.selectedIds.has(id)) {
			this.selectedIds.delete(id);
		} else {
			this.selectedIds.add(id);
		}
		const selected = this.selectedIds.has(id);
		const esc = CSS.escape(id);
		this.container
			.querySelectorAll<HTMLElement>(`.wl-card[data-game-id="${esc}"], .wl-card[data-group-id="${esc}"]`)
			.forEach((el) => el.classList.toggle('wl-card-selected', selected));
		this.refreshShelfSelects();
		this.refreshToolbarActions();
	}

	private renderActionBar(parent: HTMLElement): void {
		const bar = parent.createDiv({ cls: 'wl-action-bar' });

		const deleteBtn = bar.createEl('button', {
			cls: 'wl-group-action-btn wl-group-action-btn-delete wl-btn-danger',
			text: '✕',
		});
		deleteBtn.title = 'Delete selected';
		deleteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const count = this.selectedIds.size;
			new ConfirmModal(
				this.plugin.app,
				`Delete ${count} selected item${count !== 1 ? 's' : ''}? Deleted games' note files will be moved to the trash; deleting a group returns its games to the main list.`,
				() => {
					void (async () => {
						// selected groups are dissolved (games return to the grid); selected games are batch-deleted
						// with their note files
						const groupIds = new Set(this.gameData.getGroups().map((g) => g.id));
						const gameIds: string[] = [];
						for (const id of Array.from(this.selectedIds)) {
							if (groupIds.has(id)) {
								await this.gameData.removeGroup(id);
							} else {
								gameIds.push(id);
							}
						}
						if (gameIds.length > 0) {
							await this.gameData.removeGamesBatch(gameIds);
						}
						this.selectedIds.clear();
						this.render();
					})();
				},
			).open();
		});

		// batch status change (the auto "To be released" stays release-date-driven; groups are skipped —
		// status belongs to the member games)
		const statusSelect = bar.createEl('select', { cls: 'wl-select wl-select-sm' });
		statusSelect.createEl('option', { text: 'Status…', value: '' });
		for (const s of this.gameData.getSettings().statuses.filter((s) => s.name !== GAME_AUTO_STATUS)) {
			statusSelect.createEl('option', { text: s.name, value: s.name });
		}
		statusSelect.addEventListener('change', () => {
			void (async () => {
				const newStatus = statusSelect.value;
				if (!newStatus) return;
				for (const id of this.selectedIds) {
					const game = this.gameData.getGame(id);
					if (game) {
						this.gameData.updateGameSilent({ ...game, status: newStatus });
					}
				}
				await this.gameData.saveAndNotify();
				statusSelect.value = '';
			})();
		});

		const allGroups = this.gameData.getGroups();
		const hasGroupSelected = Array.from(this.selectedIds).some((id) =>
			allGroups.some((g) => g.id === id),
		);
		const moveSelect = bar.createEl('select', { cls: 'wl-select wl-select-sm' });
		if (hasGroupSelected) {
			moveSelect.disabled = true;
			moveSelect.title = 'A group is selected; cannot move groups into other groups';
		}
		moveSelect.createEl('option', { text: 'Group…', value: '' });
		for (const g of allGroups) {
			moveSelect.createEl('option', { text: g.name, value: g.id });
		}
		moveSelect.createEl('option', { text: 'Create new group…', value: '__new__' });
		moveSelect.addEventListener('change', () => {
			void (async () => {
				const value = moveSelect.value;
				if (!value) return;
				const groupIds = new Set(allGroups.map((g) => g.id));
				const gameIds = Array.from(this.selectedIds).filter((id) => !groupIds.has(id));

				if (value === '__new__') {
					// inline input — prompt() is unavailable in Obsidian/Electron
					moveSelect.value = '';
					moveSelect.hide();
					const nameInput = bar.createEl('input', {
						cls: 'wl-modal-input wl-group-name-input',
						attr: { type: 'text', placeholder: 'Group name…', maxlength: '64' },
					});
					const confirmBtn = bar.createEl('button', { cls: 'wl-group-action-btn', text: '✓' });
					confirmBtn.title = 'Create group';
					const cancelBtn = bar.createEl('button', { cls: 'wl-group-action-btn', text: '✕' });
					cancelBtn.title = 'Cancel';

					const doCreate = async () => {
						const name = nameInput.value.trim();
						if (!name) return;
						const newGroup: GameGroup = {
							id: this.gameData.generateGroupId(name),
							name,
							gameIds,
							dateAdded: new Date().toISOString(),
						};
						this.selectedIds.clear();
						this.selectionMode = false;
						await this.gameData.addGroup(newGroup);
					};
					confirmBtn.addEventListener('click', (e) => { e.stopPropagation(); void doCreate(); });
					// cancel only needs the toolbar back
					cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); this.refreshToolbarActions(); });
					nameInput.addEventListener('keydown', (e) => {
						e.stopPropagation();
						if (e.key === 'Enter') void doCreate();
						if (e.key === 'Escape') this.refreshToolbarActions();
					});
					nameInput.addEventListener('click', (e) => e.stopPropagation());
					window.setTimeout(() => nameInput.focus(), 0);
					return;
				}

				this.selectedIds.clear();
				this.selectionMode = false;
				for (const id of gameIds) {
					await this.gameData.addGameToGroup(value, id);
				}
			})();
		});
	}

	// Cards

	/**
	 * `cardHeight` comes from the virtual grids (inline-pinned); shelf cards omit it and take their
	 * height from the CSS 2:3 ratio.
	 */
	private renderGameCard(parent: HTMLElement, game: Game, cardWidth: number, cardHeight?: number): void {
		const settings = this.gameData.getSettings();
		const typeColor = settings.types.find((t) => t.name === game.type)?.color ?? '#888780';
		const statusColor = settings.statuses.find((s) => s.name === game.status)?.color;

		buildPosterCard(parent, {
			dataset: { gameId: game.id },
			title: game.title,
			posterUrl: rawgResizedCover(game.coverUrl),
			needsPoster: true,
			placeholderColor: typeColor,
			cardWidth,
			cardHeight,
			selected: this.selectedIds.has(game.id),
			statusLabel: game.status,
			statusColor,
			typeLabel: game.type || undefined,
			typeColor,
			year: game.releaseDate?.match(/^(\d{4})/)?.[1],
			progressRatio: game.progress > 0 ? game.progress / 100 : undefined,
			textUnder: this.plugin.isCardTextUnder('games'),
			flag: game.wishlist ? { icon: 'gift', label: 'On your wishlist' } : undefined,
			menuItems: [
				{
					label: game.favorite ? 'Unfavorite' : 'Favorite',
					onClick: () => { void this.gameData.updateGame({ ...game, favorite: !game.favorite }); },
				},
				{
					label: game.wishlist ? 'Remove from wishlist' : 'Add to wishlist',
					onClick: () => { void this.gameData.updateGame({ ...game, wishlist: !game.wishlist }); },
				},
				{ label: 'Refresh cover', onClick: () => { void this.refreshCover(game); } },
				{ label: 'Open note', onClick: () => { void this.openGameNote(game); } },
				{
					label: 'Delete',
					onClick: () => {
						new ConfirmModal(
							this.plugin.app,
							`Delete "${game.title}"? Its note file will be moved to the trash.`,
							() => { void this.gameData.removeGame(game.id); },
						).open();
					},
				},
			],
			onClick: (card) => {
				if (this.selectionMode) {
					this.toggleCardSelection(card, game.id);
				} else if (this.plugin.settings.openNoteOnClick) {
					void this.openGameNote(game);
				} else {
					this.openDetailModal(game);
				}
			},
			onContextMenu: this.plugin.settings.openNoteOnClick && !this.selectionMode
				? () => this.openDetailModal(game)
				: undefined,
		}, { container: this.container, cleanups: this.activeCleanups });
	}

	// Lazy cover re-fetch. Games added before an API was configured (or after "Re-fetch all
	// posters") carry no coverUrl; their cards fetch one the first time they scroll into view.

	/** LazyCardObserver callback: cards are handed over once, already unobserved. */
	private handleCoversVisible(cards: HTMLElement[]): void {
		// built once per batch — a per-card find() would be O(cards × games)
		let gameById: Map<string, Game> | null = null;
		for (const card of cards) {
			const id = card.dataset.gameId;
			if (!id) continue;
			if (gameById === null) {
				gameById = new Map(this.gameData.getGames().map((g) => [g.id, g]));
			}
			const game = gameById.get(id);
			// skip if it vanished, already has a cover, or failed earlier this session
			if (!game || game.coverUrl || this.coverFetchFailed.has(id)) continue;

			const placeholder = card.querySelector('.wl-card-poster-placeholder');
			placeholder?.addClass('is-loading');
			void this.resolveCover(game).then((res) => {
				placeholder?.removeClass('is-loading');
				if (!res.url) {
					this.coverFetchFailed.add(id);
					return;
				}
				// persist silently (no re-render, so scroll survives) and swap this card's <img>. A title search
				// that resolved an id stores it too, so the next fetch takes the cheap id path.
				if (res.source) this.gameData.updateCoverAndSource(id, res.url, res.source, res.apiId);
				else this.gameData.updateCoverUrl(id, res.url);
				this.applyCoverToCard(card, res.url);
			});
		}
	}

	/**
	 * Resolves a cover through the games APIs: by stored id when the game has one, otherwise a title
	 * search whose first result is taken — returning that result's source + id so the caller can
	 * persist them. `source` is '' when there is nothing new to store.
	 */
	private async resolveCover(game: Game): Promise<{ url: string; source: '' | 'rawg' | 'igdb'; apiId: string }> {
		const none = { url: '', source: '' as const, apiId: '' };
		const api = this.plugin.apiService;
		try {
			if (game.apiSource && game.apiId) {
				const details = game.apiSource === 'igdb'
					? await api.getIgdbGameDetails(Number(game.apiId))
					: await api.getRawgGameDetails(Number(game.apiId));
				return details?.coverUrl ? { url: details.coverUrl, source: '' as const, apiId: '' } : none;
			}

			// no stored id (added manually or before the field existed) — search by title
			const source = this.plugin.settings.gamesApiSource ?? 'rawg';
			let results: GameSearchResult[] = [];
			if (source === 'igdb') {
				if (!api.hasIgdbCredentials()) return none;
				results = await api.searchIgdbGames(game.title);
			} else {
				if (!api.hasRawgKey()) return none;
				results = await api.searchRawgGames(game.title);
			}
			const first = results[0];
			if (!first || !first.coverUrl) return none;
			return { url: first.coverUrl, source: first.source, apiId: String(first.id) };
		} catch {
			return none;
		}
	}

	private applyCoverToCard(card: HTMLElement, url: string): void {
		const img = card.querySelector<HTMLImageElement>('.wl-card-poster');
		if (!img) return;
		img.onload = () => { card.addClass('has-poster'); };
		img.onerror = () => { card.removeClass('has-poster'); };
		img.src = rawgResizedCover(url);
	}

	/** ⋮ menu action: re-fetch this game's cover even when it already has one. */
	private async refreshCover(game: Game): Promise<void> {
		const res = await this.resolveCover(game);
		if (!res.url) {
			new Notice('Could not fetch a cover; check the game\'s title and your Settings → API → Games setup.');
			return;
		}
		const fresh = this.gameData.getGame(game.id);
		if (!fresh) return;
		const updated: Game = { ...fresh, coverUrl: res.url };
		if (res.source) {
			updated.apiSource = res.source;
			updated.apiId = res.apiId;
		}
		await this.gameData.updateGame(updated);
		new Notice('Cover refreshed.');
	}

	/**
	 * Group cover card: member-cover collage, name + "N games" badge, ⋮ menu; click opens
	 * GameGroupDetailModal.
	 */
	private renderGroupCard(parent: HTMLElement, group: GameGroup, members: Game[], cardHeight?: number): void {
		const settings = this.gameData.getSettings();
		const primaryType = members[0]?.type ?? '';
		const typeColor = settings.types.find((t) => t.name === primaryType)?.color ?? '#888780';

		// under mode wraps the collage in a cell with name + count below (see buildPosterCard)
		const cell = this.plugin.isCardTextUnder('games')
			? parent.createDiv({ cls: 'wl-card-cell' })
			: null;
		const card = (cell ?? parent).createDiv({ cls: 'wl-card wl-card-group' });
		card.dataset.groupId = group.id;
		if (this.selectedIds.has(group.id)) card.addClass('wl-card-selected');
		if (cardHeight !== undefined) (cell ?? card).style.height = `${cardHeight}px`;

		const letter = (group.name.trim().charAt(0) || '?').toUpperCase();
		renderGroupCollage(card, members, (g) => rawgResizedCover(g.coverUrl), { letter, color: typeColor });

		const textHost = cell
			? cell.createDiv({ cls: 'wl-card-under-info' })
			: card.createDiv({ cls: 'wl-card-overlay' });
		textHost.createSpan({
			cls: cell ? 'wl-card-under-title' : 'wl-card-title',
			text: group.name,
		});
		const subtitle = textHost.createDiv({ cls: 'wl-card-meta-row' })
			.createSpan({ cls: 'wl-card-type-badge' });
		subtitle.style.backgroundColor = typeColor;
		subtitle.textContent = `${members.length} game${members.length !== 1 ? 's' : ''}`;

		const menuBtn = card.createEl('button', {
			cls: 'wl-card-menu-btn',
			text: '⋮',
		});
		menuBtn.setAttr('aria-label', 'Group actions');
		menuBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			openCardMenu(card, menuBtn, [
				{ label: 'Edit name', onClick: () => this.openRenameGroupPrompt(group) },
				{
					label: 'Delete group',
					onClick: () => {
						new ConfirmModal(
							this.plugin.app,
							`Delete group "${group.name}"? All games inside will be returned to the main list.`,
							() => { void this.gameData.removeGroup(group.id); },
						).open();
					},
				},
			], { container: this.container, cleanups: this.activeCleanups });
		});

		// under mode: the whole cell opens the group
		(cell ?? card).addEventListener('click', () => {
			if (this.selectionMode) {
				this.toggleCardSelection(card, group.id);
				return;
			}
			new GameGroupDetailModal(this.plugin.app, this.plugin, this.gameData, group, members).open();
		});
	}

	private openRenameGroupPrompt(group: GameGroup): void {
		const modal = new Modal(this.plugin.app);
		modal.titleEl.setText('Rename group');
		const input = modal.contentEl.createEl('input', {
			cls: 'wl-input',
			attr: { type: 'text', value: group.name, placeholder: 'Group name' },
		});
		const btnRow = modal.contentEl.createDiv({ cls: 'wl-modal-btn-row' });
		const submit = (): void => {
			const newName = input.value.trim();
			if (newName && newName !== group.name) {
				void this.gameData.updateGroup({ ...group, name: newName });
			}
			modal.close();
		};
		btnRow
			.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Save' })
			.addEventListener('click', submit);
		btnRow
			.createEl('button', { cls: 'wl-btn', text: 'Cancel' })
			.addEventListener('click', () => modal.close());
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') submit();
			else if (e.key === 'Escape') modal.close();
		});
		modal.open();
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	private openDetailModal(game: Game): void {
		// re-resolve so a stale card built before an edit can't reopen old data
		const fresh = this.gameData.getGame(game.id);
		if (!fresh) return;
		new GameDetailModal(this.plugin.app, this.plugin, this.gameData, fresh).open();
	}

	private async openGameNote(game: Game): Promise<void> {
		const fresh = this.gameData.getGame(game.id) ?? game;
		const created = await this.gameData.createGameNoteIfMissing(fresh);
		if (!created) await this.gameData.rewriteFrontmatterIfExists(fresh);
		await openNoteFile(this.plugin.app, this.gameData.noteFilePath(fresh.title));
	}

	/** Opens the API-assisted Add modal (the tab re-renders via its data listener). */
	private openAddPrompt(): void {
		new AddGameModal(this.plugin.app, this.plugin, this.gameData, () => {}).open();
	}
}
