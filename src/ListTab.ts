import { Modal, setIcon } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type { WatchLogTitle, WatchLogGroup, TagDefinition, SavedFilterPreset, Season } from './types';
import { formatTime, formatDateDisplay, todayIso, getThemedColor, getDisplayPoster, getTitleCredits, getManualCredits, normalizeRowsLayout, ROWS_SHELVES, ROWS_EXCLUSIVE_SHELVES, sortByFavorited, priorityFilterOpts, formatPriorityOpt, migratePriorityExclude } from './types';
import { searchItems, yearOf, type SearchFieldSpec } from './SearchQuery';
import { renderSearchHelpButton } from './SearchHelpModal';
import { createDatePicker } from './DatePicker';
import { renderCommunityRating, maybeAutoRefreshCommunityRating, refreshCommunityRating } from './CommunityRating';
import { inferHistoryAction, inferHistorySource } from './HistoryManager';
import { AddTitleModal } from './AddTitleModal';
import { AddFromUrlModal } from './AddFromUrlModal';
import { AddTitleChoiceModal } from './AddTitleChoiceModal';
import { renderToolbarWithMobileToggle } from './MobileToolbar';
import { EditTitleModal } from './EditTitleModal';
import { ConfirmModal } from './ConfirmModal';
import { TitleDetailModal, GroupDetailModal, renderCreditsRows, renderCreditsRefreshButton } from './TitleDetailModal';
import { AddCreditModal } from './AddCreditModal';
import { renderGroupCollage } from './CollageUtil';
import { appendMarkWatchedButton, isSingleEpisodeTitle } from './MarkWatchedButton';
import { renderStarRating, ratingColor } from './StarRating';
import { VirtualGrid, computeGridMetrics, setRowsCardWidth, type GridMetrics } from './VirtualGrid';
import { VirtualScroller } from './VirtualScroller';
import { LazyCardObserver } from './LazyCardObserver';
import { buildPosterCard, openCardMenu, POSTER_CARD_TEXT_H } from './PosterCard';
import { renderShelf, renderShelfTitle, type ShelfSelect } from './RowsView';
import { RowsCustomizeModal } from './RowsCustomizeModal';
import { toggleFilterPanel, FilterSection } from './FilterPanel';
import { toggleSortPopover } from './SortPopover';
import { openNoteFile } from './NoteLinkButton';


type DisplayItem =
	| { kind: 'title'; data: WatchLogTitle }
	| { kind: 'group'; data: WatchLogGroup; members: WatchLogTitle[] };

type TypeSubTab = 'All' | string;

const PRIORITY_ORDER = ['High', 'Medium', 'Low'] as const;


export class ListTab {
	private static sessionTypeSubTab: TypeSubTab | null = null;

	private container: HTMLElement;
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;

	// preserved state
	filterTypeExclude: Set<string> = new Set();
	filterStatusExclude: Set<string> = new Set();
	filterPriorityExclude: Set<string> = new Set();
	filterRatingExclude: Set<string> = new Set();
	filterGroupExclude: Set<string> = new Set();
	filterSort = 'dateAdded';
	filterSortDir: 'asc' | 'desc' = 'desc';
	filterSecondSort = 'none';
	filterSecondSortDir: 'asc' | 'desc' = 'asc';
	searchQuery = '';
	expandedId: string | null = null;
	collapsedSeasons: Set<number> = new Set();
	expandedGroups: Set<string> = new Set();
	renamingGroupId: string | null = null;

	// selection mode
	selectionMode = false;
	// header select-all boxes of the current Rows render; re-synced on every selection change
	private shelfSelectRefreshers: (() => void)[] = [];
	selectedItems: Set<string> = new Set(); // title ids or group ids

	// pinned groups (persisted via DataManager)
	pinnedGroupId: string | null = null;

	// saved filter preset
	savedFilterActive = false;
	private savedFilterBtnEl: HTMLButtonElement | null = null;

	// empty-only filter flag (priority has none — '' is a normal option)
	filterRatingEmptyOnly = false;

	filterRecentlyArrivedOnly = false;

	// hides standalone titles
	filterGroupsOnly = false;

	filterFavoritesOnly = false;

	// Cards grid | List table | Rows shelves
	currentView: 'list' | 'rows' = 'list';

	// false = search shown, true = action buttons; desktop shows both
	private toolbarExpanded = false;

	// removes the rAF scroll listener on re-render
	private scrollCleanup: (() => void) | null = null;

	// one per rendered view; fetch logic lives in handleCardsVisible
	private cardsObserver: LazyCardObserver | null = null;

	// flat "all titles + groups" grid items, indexed by buildCardElement
	private cardsDisplayItems: DisplayItem[] = [];

	// one VirtualGrid section per grid, all on the shared VirtualScroller
	private rowsScroller: VirtualScroller | null = null;
	// survives destroyRowsVirtual() so a re-render can restore rows scroll
	// (child scroller, not this.container, so _lastScrollTop misses it)
	private _rowsPersistentScrollTop = 0;

	// updated continuously so rerenderTable() is right even after async DOM changes
	private _lastScrollTop = 0;
	private scrollPositionListener: (() => void) | null = null;

	// cleaned up on rerender so DOM removal leaves no dangling listeners
	private activeCleanups: (() => void)[] = [];

	// display: contents — lets selection changes rebuild just the buttons
	private toolbarActionsEl: HTMLElement | null = null;

	constructor(container: HTMLElement, plugin: WatchLogPlugin, dataManager: DataManager) {
		this.container = container;
		this.plugin = plugin;
		this.dataManager = dataManager;
		const dv = plugin.settings.defaultWatchlistView;
		this.currentView = dv === 'list' ? 'list' : 'rows';
		this.scrollPositionListener = () => {
			this._lastScrollTop = this.container.scrollTop;
		};
		this.container.addEventListener('scroll', this.scrollPositionListener, { passive: true });
		this.pinnedGroupId = dataManager.getPinnedGroupId();

		// restore persisted filter state
		const saved = plugin.settings.listFilters;
		if (saved) {
			this.filterTypeExclude     = new Set(saved.typeExclude     ?? []);
			this.filterStatusExclude   = new Set(saved.statusExclude   ?? []);
			this.filterGroupExclude    = new Set(saved.groupExclude    ?? []);
			this.filterRatingExclude   = new Set(saved.ratingExclude   ?? []);
			this.filterPriorityExclude = migratePriorityExclude(
				saved.priorityExclude,
				saved.priorityEmptyOnly,
				plugin.settings.priorities,
			);
			const ms = ListTab.migrateSortKey(saved.sort ?? 'dateAdded-newest');
			this.filterSort     = ms.key;
			this.filterSortDir  = saved.sortDir ?? ms.dir;
			const ms2 = ListTab.migrateSortKey(saved.secondSort ?? 'none');
			this.filterSecondSort    = ms2.key;
			this.filterSecondSortDir = saved.secondSortDir ?? ms2.dir;
			this.filterRatingEmptyOnly      = saved.ratingEmptyOnly      ?? false;
			this.filterRecentlyArrivedOnly  = saved.recentlyArrivedOnly  ?? false;
			this.filterGroupsOnly           = saved.groupsOnly           ?? false;
			this.filterFavoritesOnly        = saved.favoritesOnly        ?? false;
		}

		if (this.typeSubTabsEnabled()) {
			this.filterTypeExclude.clear();
		}

		// keep the preset button green while filters still match it
		const savedPreset = dataManager.getSavedFilterPreset();
		if (savedPreset) {
			const setsMatch = (a: Set<string>, b: string[]) =>
				a.size === b.length && b.every((x) => a.has(x));
			const typeMatch = this.typeSubTabsEnabled()
				? true
				: setsMatch(this.filterTypeExclude, savedPreset.typeExclude);
			this.savedFilterActive =
				typeMatch &&
				setsMatch(this.filterStatusExclude, savedPreset.statusExclude) &&
				setsMatch(this.filterGroupExclude, savedPreset.groupExclude) &&
				setsMatch(this.filterRatingExclude, savedPreset.ratingExclude) &&
				setsMatch(
					this.filterPriorityExclude,
					Array.from(migratePriorityExclude(
						savedPreset.priorityExclude,
						savedPreset.priorityEmptyOnly,
						plugin.settings.priorities,
					)),
				) &&
				(this.filterRatingEmptyOnly === (savedPreset.ratingEmptyOnly ?? false)) &&
				(this.filterRecentlyArrivedOnly === (savedPreset.recentlyArrivedOnly ?? false)) &&
				(this.filterGroupsOnly === (savedPreset.groupsOnly ?? false)) &&
				(this.filterFavoritesOnly === (savedPreset.favoritesOnly ?? false));
		}
	}

	private saveFiltersToSettings(): void {
		this.plugin.settings.listFilters = {
			typeExclude:     this.typeSubTabsEnabled() ? [] : Array.from(this.filterTypeExclude),
			statusExclude:   Array.from(this.filterStatusExclude),
			groupExclude:    Array.from(this.filterGroupExclude),
			ratingExclude:   Array.from(this.filterRatingExclude),
			priorityExclude: Array.from(this.filterPriorityExclude),
			sort:          this.filterSort,
			sortDir:       this.filterSortDir,
			secondSort:    this.filterSecondSort,
			secondSortDir: this.filterSecondSortDir,
			ratingEmptyOnly:       this.filterRatingEmptyOnly,
			recentlyArrivedOnly:   this.filterRecentlyArrivedOnly,
			groupsOnly:            this.filterGroupsOnly,
			favoritesOnly:         this.filterFavoritesOnly,
		};
		void this.plugin.saveSettings();
	}

	private typeSubTabsEnabled(): boolean {
		return this.plugin.settings.watchlistTypeSubTabs === true;
	}

	private get activeTypeSubTab(): TypeSubTab {
		if (!this.typeSubTabsEnabled()) return 'All';
		const session = ListTab.sessionTypeSubTab;
		if (session === null || session === 'All') return 'All';
		const known = this.plugin.settings.types.some((t) => t.name === session);
		return known ? session : 'All';
	}

	private set activeTypeSubTab(value: TypeSubTab) {
		ListTab.sessionTypeSubTab = value;
	}

	private typeSubTabFiltering(): boolean {
		return this.typeSubTabsEnabled() && this.activeTypeSubTab !== 'All';
	}

	private hasActiveFilter(): boolean {
		return (!this.typeSubTabsEnabled() && this.filterTypeExclude.size > 0) ||
			this.filterStatusExclude.size > 0 ||
			this.filterPriorityExclude.size > 0 ||
			this.filterRatingExclude.size > 0 ||
			this.filterGroupExclude.size > 0 ||
			this.filterRatingEmptyOnly ||
			this.filterRecentlyArrivedOnly ||
			this.filterGroupsOnly ||
			this.filterFavoritesOnly;
	}

	private clearAllFilters(): void {
		this.filterTypeExclude.clear();
		this.filterStatusExclude.clear();
		this.filterPriorityExclude.clear();
		this.filterRatingExclude.clear();
		this.filterGroupExclude.clear();
		this.filterRatingEmptyOnly      = false;
		this.filterRecentlyArrivedOnly  = false;
		this.filterGroupsOnly           = false;
		this.filterFavoritesOnly        = false;
	}

	private applyPreset(preset: SavedFilterPreset): void {
		this.filterTypeExclude          = this.typeSubTabsEnabled()
			? new Set()
			: new Set(preset.typeExclude);
		this.filterStatusExclude        = new Set(preset.statusExclude);
		this.filterGroupExclude         = new Set(preset.groupExclude);
		this.filterRatingExclude        = new Set(preset.ratingExclude);
		this.filterPriorityExclude      = migratePriorityExclude(
			preset.priorityExclude,
			preset.priorityEmptyOnly,
			this.plugin.settings.priorities,
		);
		this.filterRatingEmptyOnly      = preset.ratingEmptyOnly      ?? false;
		this.filterRecentlyArrivedOnly  = preset.recentlyArrivedOnly  ?? false;
		this.filterGroupsOnly           = preset.groupsOnly           ?? false;
		this.filterFavoritesOnly        = preset.favoritesOnly        ?? false;
	}

	private deactivateSavedFilter(): void {
		if (this.savedFilterActive) {
			this.savedFilterActive = false;
			this.savedFilterBtnEl?.removeClass('wl-btn-preset-active');
		}
	}

	private static isRecentlyArrived(title: WatchLogTitle): boolean {
		if (!title.releaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(title.releaseDate)) return false;
		const releaseMs = new Date(title.releaseDate + 'T00:00:00').getTime();
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const diffDays = (today.getTime() - releaseMs) / 86400000;
		return diffDays >= 0 && diffDays <= 7;
	}

	private titlePassesFilters(t: WatchLogTitle): boolean {
		if (this.filterFavoritesOnly && !t.favorite) return false;
		if (this.typeSubTabFiltering()) {
			if (t.type !== this.activeTypeSubTab) return false;
		} else if (this.filterTypeExclude.size > 0 && this.filterTypeExclude.has(t.type)) {
			return false;
		}
		if (this.filterRecentlyArrivedOnly) {
			if (!ListTab.isRecentlyArrived(t)) return false;
		} else if (this.filterStatusExclude.size > 0 && this.filterStatusExclude.has(t.status)) {
			return false;
		}
		// rating 0 = un-rated, not a real value; only the Empty toggle shows those
		if (this.filterRatingEmptyOnly) {
			if (t.rating !== 0) return false;
		} else if (this.filterRatingExclude.size > 0 && (t.rating === 0 || this.filterRatingExclude.has(`${t.rating}★`))) {
			return false;
		}
		// '' is a real option here — no-priority titles are excludable like any other
		if (this.filterPriorityExclude.size > 0 && this.filterPriorityExclude.has(t.priority)) {
			return false;
		}
		return true;
	}

	destroy(): void {
		if (this.scrollPositionListener) {
			this.container.removeEventListener('scroll', this.scrollPositionListener);
			this.scrollPositionListener = null;
		}
		if (this.scrollCleanup) {
			this.scrollCleanup();
			this.scrollCleanup = null;
		}
		this.destroyVirtualScroll();
		this.destroyRowsVirtual();
		// flush the debounced episode save before the tab instance is lost
		void this.dataManager.flushPendingSave();
	}

	render(): void {
		this._lastScrollTop = this.container.scrollTop || this._lastScrollTop;
		this.activeCleanups.forEach((fn) => fn());
		this.activeCleanups = [];
		this.container.empty();
		this.container.addClass('wl-list');
		if (this.typeSubTabsEnabled() && this.filterTypeExclude.size > 0) {
			this.filterTypeExclude.clear();
		}
		if (this.currentView === 'list') {
			this.renderListContent();
		} else {
			this.renderRowsContent();
		}
	}

	private renderListContent(): void {
		if (this.typeSubTabsEnabled()) this.renderTypeSubTabs();
		this.renderHeader();
		this.container.createDiv({ cls: 'wl-divider' });
		this.renderTable(this._lastScrollTop);
	}

	// Rows view (horizontal shelves)

	// shelf cards mirror the grids' *computed* card width (setRowsCardWidth), not the setting minimum

	private renderRowsContent(): void {
		if (this.typeSubTabsEnabled()) this.renderTypeSubTabs();
		this.renderHeader();
		this.container.createDiv({ cls: 'wl-divider' });
		this.renderRowsView();
	}

	private renderTypeSubTabs(): void {
		const bar = this.container.createDiv({ cls: 'wl-subtabs wl-list-type-subtabs' });
		const track = bar.createDiv({ cls: 'wl-subtabs-track' });
		const active = this.activeTypeSubTab;

		const tabs: TypeSubTab[] = ['All', ...this.plugin.settings.types.map((t) => t.name)];
		for (const name of tabs) {
			const btn = track.createEl('button', {
				cls: `wl-subtab${active === name ? ' is-active' : ''}`,
				text: name,
			});
			btn.addEventListener('click', () => {
				if (this.activeTypeSubTab === name) return;
				this.activeTypeSubTab = name;
				this.render();
			});
		}
	}

	private renderRowsView(): void {
		// clear stale observer/scroller state; this render builds fresh ones
		this.destroyVirtualScroll();
		this.destroyRowsVirtual();
		this.shelfSelectRefreshers = [];

		// search/filter keeps the shelves layout; a shelf with no matches disappears entirely
		const searchMatched = this.getSearchMatchedIds();
		const filtering = searchMatched !== null || this.hasActiveFilter() || this.typeSubTabFiltering();
		const titleVisible = (t: WatchLogTitle): boolean =>
			!filtering ||
			(!this.filterGroupsOnly &&
				(searchMatched === null || searchMatched.has(t.id)) &&
				this.titlePassesFilters(t));

		const titles = this.dataManager.getTitles();
		const visibleGroups = this.getVisibleRowsGroups(searchMatched, filtering);
		// same count line as List/Cards, same slot
		const countEl = this.renderCountLine(
			this.container,
			filtering ? titles.filter(titleVisible).length : titles.length,
			visibleGroups.length,
		);
		// customize-shelves gear, far right on the count line
		countEl.addClass('wl-results-count-rows');
		const gearBtn = countEl.createEl('button', { cls: 'wl-rows-customize-btn' });
		gearBtn.setAttr('aria-label', 'Customize rows');
		setIcon(gearBtn, 'settings');
		gearBtn.addEventListener('click', () => {
			new RowsCustomizeModal(this.plugin.app, this.plugin, {
				shelves: ROWS_SHELVES,
				getLayout: () => this.plugin.settings.rowsLayout,
				setLayout: (layout) => { this.plugin.settings.rowsLayout = layout; },
				// live update while the modal reorders shelves behind it
				onChanged: () => {
					if (this.currentView === 'rows') this.rerenderActiveView();
				},
				hint: 'Reorder the sections or switch them off. "By type" and "By status" are the grouped grid sections; only one can be on at a time, and with both off the titles show as one flat grid.',
				exclusiveGroups: ROWS_EXCLUSIVE_SHELVES,
			}).open();
		});

		const scroll = this.container.createDiv({ cls: 'wl-rows-scroll-container' });
		// one metrics source for the grids AND the shelf width — every call re-publishes it
		const rowsMetrics = (w: number): GridMetrics => {
			const m = computeGridMetrics(w, this.plugin.getCardMinWidth());
			setRowsCardWidth(scroll, m.cardWidth);
			// text-under cells are poster + text block
			if (this.plugin.isCardTextUnder('watchlist')) {
				const cardHeight = m.cardHeight + POSTER_CARD_TEXT_H;
				return { cols: m.cols, cardWidth: m.cardWidth, cardHeight, rowHeight: cardHeight + 12 };
			}
			return m;
		};
		// eager first publish: shelf cards render before the scroller attaches
		const cardWidth = rowsMetrics(scroll.clientWidth).cardWidth;

		// the observer serves the eager shelf cards and the virtualised grids alike
		const observer = new LazyCardObserver(
			'.wl-card[data-needs-poster="true"]',
			(cards) => this.handleCardsVisible(cards),
		);
		this.cardsObserver = observer;
		const rowsScroller = new VirtualScroller({
			scroll,
			metrics: rowsMetrics,
			onWindowChanged: () => observer.observeNew(scroll),
			onScrollPos: (top) => { this._rowsPersistentScrollTop = top; },
		});
		this.rowsScroller = rowsScroller;

		// shelf builders keyed by rowsLayout id; a disabled shelf costs nothing.
		// each computes its list first, THEN hides non-matches — Recently Added stays
		// the 10 newest overall, not the 10 newest matches
		const titleCard = (strip: HTMLElement, t: WatchLogTitle): void =>
			this.renderTitleCard(strip, t, cardWidth);
		const sel = (items: { id: string }[]): ShelfSelect | undefined =>
			this.shelfSelect(items.map((i) => i.id));
		const shelfRenderers: Record<string, () => void> = {
			favorites: () => {
				// newest favorite first — this shelf ignores the tab sort
				const favorites = sortByFavorited(
					titles.filter((t) => t.favorite === true && titleVisible(t)),
				);
				renderShelf(
					scroll, 'Favorites', favorites,
					'No favorites yet; mark a title as favorite to see it here.',
					filtering, titleCard, sel(favorites),
				);
			},
			recommended: () => {
				const recommended = this.getRecommendedTitles(titles).filter(titleVisible);
				renderShelf(
					scroll, 'Recommended', recommended,
					'Nothing to recommend; add titles to "Plan to watch" or "Watching".',
					filtering, titleCard, sel(recommended),
				);
			},
			// ISO timestamps, so string compare sorts chronologically
			recentlyAdded: () => {
				const recentlyAdded = [...titles]
					.sort((a, b) => (b.dateAdded ?? '').localeCompare(a.dateAdded ?? ''))
					.slice(0, 10)
					.filter(titleVisible);
				renderShelf(
					scroll, 'Recently Added', recentlyAdded,
					'Nothing here yet; added titles will show up in this row.',
					filtering, titleCard, sel(recentlyAdded),
				);
			},
			recentlyWatched: () => {
				const recentlyWatched = this.getRecentlyWatchedTitles(titles).filter(titleVisible);
				renderShelf(
					scroll, 'Recently Watched', recentlyWatched,
					'Nothing watched yet; episodes you tick or titles you complete will show up here.',
					filtering, titleCard, sel(recentlyWatched),
				);
			},
			groups: () => {
				this.renderGroupsShelf(scroll, cardWidth, visibleGroups, filtering);
			},
			recentlyReleased: () => {
				// past releases only; today counts as released
				const today = ListTab.todayStamp();
				const recentlyReleased = titles
					.filter(
						(t) =>
							t.status !== 'To be released' &&
							!!t.releaseDate &&
							/^\d{4}-\d{2}-\d{2}$/.test(t.releaseDate) &&
							t.releaseDate <= today,
					)
					.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
					.slice(0, 10)
					.filter(titleVisible);
				renderShelf(
					scroll, 'Recently Released', recentlyReleased,
					'No released titles yet; titles with a past release date show up here.',
					filtering, titleCard, sel(recentlyReleased),
				);
			},
			// the grouped grids are regular layout entries, so they sit anywhere — the windowing
			// math is position-independent. byType/byStatus are mutually exclusive (normalizeRowsLayout)
			byType: () => {
				if (this.typeSubTabFiltering()) return;
				this.renderGroupedGridsSection(scroll, titleVisible, filtering, 'byType');
			},
			byStatus: () => {
				this.renderGroupedGridsSection(scroll, titleVisible, filtering, 'byStatus');
			},
		};

		// user order + visibility (RowsCustomizeModal); normalized at read time so a stale layout can't drop a section
		const layout = normalizeRowsLayout(this.plugin.settings.rowsLayout);
		// both grids off: one flat ungrouped grid (the old Cards view) at the first grid entry's position
		const gridIds = new Set(['byType', 'byStatus']);
		const gridEnabled = (id: string, enabled: boolean): boolean => {
			if (!enabled) return false;
			if (id === 'byType' && this.typeSubTabFiltering()) return false;
			return true;
		};
		const anyGridEnabled = layout.some((e) => gridIds.has(e.id) && gridEnabled(e.id, e.enabled));
		const anyShelfEnabled = layout.some((e) => !gridIds.has(e.id) && e.enabled);
		let flatRendered = false;
		for (const entry of layout) {
			if (!anyGridEnabled && gridIds.has(entry.id)) {
				if (!flatRendered) {
					flatRendered = true;
					this.renderAllItemsSection(scroll, anyShelfEnabled);
				}
				continue;
			}
			if (!gridEnabled(entry.id, entry.enabled) && gridIds.has(entry.id)) continue;
			if (!entry.enabled) continue;
			shelfRenderers[entry.id]?.();
		}

		// eager shelf cards now; the grids register theirs as windows materialise
		observer.observeNew(scroll);
		rowsScroller.attach(this._rowsPersistentScrollTop);
	}

	/** Horizontal strip of group cover cards. `groups` is already visibility-filtered. */
	private renderGroupsShelf(
		parent: HTMLElement,
		cardWidth: number,
		groups: WatchLogGroup[],
		filtering: boolean,
	): void {
		if (filtering && groups.length === 0) return;
		const shelf = parent.createDiv({ cls: 'wl-rows-shelf' });
		renderShelfTitle(shelf, 'Groups', groups.length, this.shelfSelect(groups.map((g) => g.id)));
		if (groups.length === 0) {
			shelf.createDiv({
				cls: 'wl-rows-shelf-empty',
				text: 'No groups yet; group related titles to see their covers here.',
			});
			return;
		}
		const titleMap = new Map(this.dataManager.getTitles().map((t) => [t.id, t]));
		const strip = shelf.createDiv({ cls: 'wl-rows-strip' });
		for (const group of groups) {
			const members = group.titleIds
				.map((id) => titleMap.get(id))
				.filter((t): t is WatchLogTitle => t !== undefined);
			this.renderGroupCard(strip, group, members, cardWidth);
		}
	}

	/**
	 * Groups the Rows shelf shows: all of them, or — under search/filter — the
	 * Cards/List rule (name match, or one member passing).
	 */
	private getVisibleRowsGroups(searchMatched: Set<string> | null, filtering: boolean): WatchLogGroup[] {
		const groups = this.dataManager.getGroups();
		if (!filtering) return groups;
		const q = this.searchQuery.trim().toLowerCase();
		const titleMap = new Map(this.dataManager.getTitles().map((t) => [t.id, t]));
		const titleFilterActive =
			this.typeSubTabFiltering() ||
			(!this.typeSubTabsEnabled() && this.filterTypeExclude.size > 0) ||
			this.filterStatusExclude.size > 0 ||
			this.filterRatingExclude.size > 0 ||
			this.filterPriorityExclude.size > 0 ||
			this.filterRatingEmptyOnly ||
			this.filterRecentlyArrivedOnly ||
			this.filterFavoritesOnly;
		return groups.filter((group) => {
			if (this.filterGroupExclude.size > 0 && this.filterGroupExclude.has(group.name)) return false;
			const members = group.titleIds
				.map((id) => titleMap.get(id))
				.filter((t): t is WatchLogTitle => t !== undefined);
			if (searchMatched) {
				const nameMatch = group.name.toLowerCase().includes(q);
				if (!nameMatch && !members.some((m) => searchMatched.has(m.id))) return false;
			}
			if (titleFilterActive && !members.some((m) => this.titlePassesFilters(m))) return false;
			return true;
		});
	}

	/**
	 * One Cards-style grid per type (or status), in settings order; empty buckets are
	 * skipped. Virtualised: each bucket gets a fixed-height spacer whose VirtualGrid
	 * materialises only the rows near the viewport.
	 */
	private renderGroupedGridsSection(
		parent: HTMLElement,
		titleVisible: (t: WatchLogTitle) => boolean,
		filtering: boolean,
		mode: 'byType' | 'byStatus',
	): void {
		const byType = mode === 'byType';
		const defs = byType ? this.plugin.settings.types : this.plugin.settings.statuses;
		const keyOf = (t: WatchLogTitle): string => (byType ? t.type : t.status);

		const section = parent.createDiv({ cls: 'wl-rows-bytype' });
		section.createDiv({ cls: 'wl-rows-bytype-title', text: byType ? 'By type' : 'By status' });

		const titles = this.dataManager.getTitles();
		let rendered = 0;
		for (const def of defs) {
			// buckets keep settings order; sorting only reorders within a bucket
			const bucketTitles = this.sortTitlesByCurrentSort(
				titles.filter((t) => keyOf(t) === def.name && titleVisible(t)),
			);
			if (bucketTitles.length === 0) continue;
			rendered++;
			renderShelfTitle(section, def.name, bucketTitles.length, this.shelfSelect(bucketTitles.map((t) => t.id)));
			const spacer = section.createDiv({ cls: 'wl-rows-bytype-spacer' });
			// same classes as the flat grid so the CLS fix applies unchanged
			const grid = spacer.createDiv({ cls: 'wl-cards-grid wl-cards-grid-virtual' });
			const vgrid = new VirtualGrid(spacer, grid, bucketTitles.length, {
				buildItem: (i, w, h) => {
					const title = bucketTitles[i];
					if (!title) return null;
					const tmp = createDiv();
					this.renderTitleCard(tmp, title, w, h);
					return tmp.firstElementChild as HTMLElement | null;
				},
				removeItem: (el) => this.cardsObserver?.unobserveAndRemove(el),
			});
			// attach() reserves every section's height up-front, so late grids shift nothing
			this.rowsScroller?.addSection(vgrid, spacer);
		}
		if (rendered === 0) {
			// a grouped section with no matches disappears entirely, like the shelves
			if (filtering) {
				section.remove();
				return;
			}
			section.createDiv({
				cls: 'wl-rows-shelf-empty',
				text: `No titles yet; added titles are grouped by ${byType ? 'type' : 'status'} here.`,
			});
		}
	}

	/**
	 * The flat ungrouped grid — the old Cards view as the fallback section, rendered
	 * only when neither By type nor By status is on. `titled` adds a header when
	 * other sections exist.
	 */
	private renderAllItemsSection(parent: HTMLElement, titled: boolean): void {
		const items = this.getDisplayItems();
		this.cardsDisplayItems = items;
		if (items.length === 0) {
			// the old Cards empty state — only meaningful when this is the lone section
			if (!titled) {
				const empty = parent.createDiv({ cls: 'wl-cards-empty' });
				empty.createSpan({ cls: 'wl-cards-empty-icon', text: '🎬' });
				empty.createEl('p', { cls: 'wl-cards-empty-msg', text: 'No titles match your filters' });
			}
			return;
		}
		const section = parent.createDiv({ cls: 'wl-rows-bytype' });
		if (titled) renderShelfTitle(section, 'All titles', items.length, this.shelfSelect(items.map((i) => i.data.id)));
		const spacer = section.createDiv({ cls: 'wl-rows-bytype-spacer' });
		const grid = spacer.createDiv({ cls: 'wl-cards-grid wl-cards-grid-virtual' });
		const vgrid = new VirtualGrid(spacer, grid, items.length, {
			buildItem: (i, w, h) => this.buildCardElement(i, w, h),
			removeItem: (el) => this.cardsObserver?.unobserveAndRemove(el),
		});
		this.rowsScroller?.addSection(vgrid, spacer);
	}

	/** Local calendar day as YYYY-MM-DD. */
	private static todayStamp(): string {
		return todayIso();
	}

	// daily picks the Recommended shelf shows (pool permitting)
	private static readonly RECOMMENDED_COUNT = 10;

	/**
	 * Daily random picks from the Plan to watch / Watching pool. Stored in data.json
	 * and re-rolled only on a new calendar day; a short same-day list is topped up
	 * without re-rolling the kept picks.
	 */
	private getRecommendedTitles(allTitles: WatchLogTitle[]): WatchLogTitle[] {
		const pool = allTitles.filter(
			(t) => t.status === 'Plan to watch' || t.status === 'Watching',
		);
		const today = ListTab.todayStamp();

		const stored = this.dataManager.getRecommendedDaily();
		if (stored.date === today) {
			const byId = new Map(pool.map((t) => [t.id, t]));
			const picks = stored.ids
				.map((id) => byId.get(id))
				.filter((t): t is WatchLogTitle => t !== undefined);
			if (picks.length < ListTab.RECOMMENDED_COUNT && picks.length < pool.length) {
				const used = new Set(picks.map((t) => t.id));
				picks.push(...ListTab.pickRandom(
					pool.filter((t) => !used.has(t.id)),
					ListTab.RECOMMENDED_COUNT - picks.length,
				));
				this.dataManager.setRecommendedDaily({ date: today, ids: picks.map((t) => t.id) });
			}
			return picks;
		}

		const picks = ListTab.pickRandom(pool, ListTab.RECOMMENDED_COUNT);
		this.dataManager.setRecommendedDaily({ date: today, ids: picks.map((t) => t.id) });
		return picks;
	}

	/**
	 * Titles with a real watch event in the log, most recent first (max 10).
	 * dateModified is deliberately NOT used — it bumps on any edit. Entries match
	 * by name, so a renamed title drops out.
	 */
	private getRecentlyWatchedTitles(allTitles: WatchLogTitle[]): WatchLogTitle[] {
		const byName = new Map<string, WatchLogTitle[]>();
		for (const t of allTitles) {
			const list = byName.get(t.title);
			if (list) list.push(t);
			else byName.set(t.title, [t]);
		}

		const out: WatchLogTitle[] = [];
		const seen = new Set<string>();
		for (const entry of this.plugin.historyManager.getEntries()) { // newest-first
			if (inferHistorySource(entry) !== 'Watchlist') continue;
			const action = inferHistoryAction(entry);
			if (action !== 'watched' && action !== 'completed') continue;
			const name = entry.titleName ?? entry.message.match(/^(.+?)\s*\(/)?.[1];
			if (!name) continue;
			const candidates = byName.get(name);
			if (!candidates || candidates.length === 0) continue;
			let title = candidates[0]!;
			if (candidates.length > 1) {
				// same name under several types — the message embeds "(Type)"
				const type = entry.message.match(/\(([^)]+)\)/)?.[1];
				title = candidates.find((t) => t.type === type) ?? title;
			}
			if (seen.has(title.id)) continue;
			seen.add(title.id);
			out.push(title);
			if (out.length >= 10) break;
		}
		return out;
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

	private buildCardElement(
		index: number,
		cardWidth: number,
		cardHeight: number,
	): HTMLElement | null {
		const item = this.cardsDisplayItems[index];
		if (!item) return null;
		const tmp = createDiv();
		if (item.kind === 'title') {
			this.renderTitleCard(tmp, item.data, cardWidth, cardHeight);
		} else {
			this.renderGroupCard(tmp, item.data, item.members, cardWidth, cardHeight);
		}
		return tmp.firstElementChild as HTMLElement | null;
	}

	/** Lazy poster fetch for cards that scrolled into view (handed over once, already unobserved). */
	private handleCardsVisible(cards: HTMLElement[]): void {
		// built once per batch — a per-card find() made this O(cards × titles)
		let titleById: Map<string, WatchLogTitle> | null = null;
		for (const card of cards) {
			const titleId = card.dataset.titleId;
			if (!titleId) continue;

			if (titleById === null) {
				titleById = new Map(this.dataManager.getTitles().map((t) => [t.id, t]));
			}
			const title = titleById.get(titleId);
			if (!title) continue;
			// skip manual overrides and resolved posters ('none' = tried, nothing found)
			if (title.manualPosterUrl && title.manualPosterUrl.trim() !== '') continue;
			if (title.posterUrl || title.posterUrl === 'none') continue;

			const placeholder = card.querySelector('.wl-card-poster-placeholder');
			placeholder?.addClass('is-loading');

			void this.plugin.posterService.enqueue(title).then((url) => {
				placeholder?.removeClass('is-loading');
				if (url) {
					this.applyPosterToCard(card, url);
				}
			});
		}
	}

	private applyPosterToCard(card: HTMLElement, url: string): void {
		const img = card.querySelector<HTMLImageElement>('.wl-card-poster');
		if (!img) return;
		img.onload = () => {
			card.addClass('has-poster');
		};
		img.onerror = () => {
			const titleId = card.dataset.titleId;
			if (titleId) {
				this.dataManager.updatePosterUrl(titleId, 'none');
			}
		};
		img.src = url;
	}

	/** Tear down the poster observer and the PosterService queue. */
	private destroyVirtualScroll(): void {
		this.cardsDisplayItems = [];
		this.cardsObserver?.destroy();
		this.cardsObserver = null;
		this.plugin.posterService?.clearQueue();
	}

	/**
	 * Tear down the Rows scroller only — destroyVirtualScroll owns the observer and
	 * queue. The scroll position survives for the next renderRowsView.
	 */
	private destroyRowsVirtual(): void {
		this.rowsScroller?.destroy();
		this.rowsScroller = null;
	}

	private renderTitleCard(
		parent: HTMLElement,
		title: WatchLogTitle,
		cardWidth?: number,
		cardHeight?: number,
	): void {
		const typeDef = this.getTagDef(title.type, this.plugin.settings.types);
		const statusDef = this.getTagDef(title.status, this.plugin.settings.statuses);
		const typeColor = typeDef
			? getThemedColor(title.type, typeDef.color, this.plugin.settings.colorTheme)
			: '#888780';

		const display = getDisplayPoster(title);
		const isManual = !!(title.manualPosterUrl && title.manualPosterUrl.trim() !== '');
		// missing (undefined / null / "") needs a fetch; the 'none' sentinel does not
		const needsPoster = !isManual && !title.posterUrl && title.posterUrl !== 'none';

		// no bar when episodes are unknown
		const total = title.totalEpisodes;
		const progressRatio = total && total > 0
			? (title.status === 'Completed'
				? 1
				: Math.max(0, Math.min(1, title.watchedEpisodes.length / total)))
			: undefined;

		buildPosterCard(parent, {
			dataset: { titleId: title.id },
			title: title.title,
			posterUrl: display,
			needsPoster,
			placeholderColor: typeColor,
			cardWidth,
			cardHeight,
			selected: this.selectedItems.has(title.id),
			statusLabel: statusDef ? title.status : undefined,
			statusColor: statusDef
				? getThemedColor(title.status, statusDef.color, this.plugin.settings.colorTheme)
				: undefined,
			typeLabel: title.type,
			typeColor,
			year: title.releaseDate?.match(/^(\d{4})/)?.[1],
			progressRatio,
			textUnder: this.plugin.isCardTextUnder('watchlist'),
			// only mark the auto-fetched URL 'none' — leave a manual choice alone
			onPosterError: () => {
				if (!isManual) this.dataManager.updatePosterUrl(title.id, 'none');
			},
			menuItems: [
				{ label: 'Edit title', onClick: () => this.openEditModalForTitle(title.id) },
				{ label: 'Refresh poster', onClick: (card) => this.refreshPosterForCard(card, title.id) },
				{ label: 'Refresh rating', onClick: () => void refreshCommunityRating(this.plugin, title.id, null, true) },
			],
			onClick: (card) => {
				if (this.selectionMode) {
					this.toggleCardSelection(card, title.id);
					return;
				}
				this.handleTitleActivate(title.id);
			},
			onContextMenu: this.plugin.settings.openNoteOnClick
				? () => this.openDetailModalForTitle(title.id)
				: undefined,
		}, { container: this.container, cleanups: this.activeCleanups });
	}

	private refreshPosterForCard(card: HTMLElement, titleId: string): void {
		const fresh = this.dataManager.getTitle(titleId);
		if (!fresh) return;
		this.dataManager.updatePosterUrl(titleId, '');
		card.dataset.needsPoster = 'true';

		const img = card.querySelector<HTMLImageElement>('.wl-card-poster');
		const placeholder = card.querySelector<HTMLElement>(
			'.wl-card-poster-placeholder',
		);
		if (img) {
			img.removeAttribute('src');
		}
		card.removeClass('has-poster');
		if (placeholder) {
			placeholder.addClass('is-loading');
		}

		void this.plugin.posterService.enqueue(fresh).then((url) => {
			placeholder?.removeClass('is-loading');
			if (url) this.applyPosterToCard(card, url);
		});
	}

	private renderGroupCard(
		parent: HTMLElement,
		group: WatchLogGroup,
		members: WatchLogTitle[],
		cardWidth?: number,
		cardHeight?: number,
	): void {
		const primaryType = members[0]?.type ?? '';
		const typeDef = primaryType
			? this.getTagDef(primaryType, this.plugin.settings.types)
			: undefined;
		const typeColor = typeDef
			? getThemedColor(primaryType, typeDef.color, this.plugin.settings.colorTheme)
			: '#888780';

		// under mode wraps the collage in a cell with name + count below (see buildPosterCard)
		const cell = this.plugin.isCardTextUnder('watchlist')
			? parent.createDiv({ cls: 'wl-card-cell' })
			: null;
		const card = (cell ?? parent).createDiv({ cls: 'wl-card wl-card-group' });
		card.dataset.groupId = group.id;
		if (this.selectedItems.has(group.id)) card.addClass('wl-card-selected');
		if (cardHeight !== undefined) (cell ?? card).style.height = `${cardHeight}px`;

		const letter = (group.name.trim().charAt(0) || '?').toUpperCase();
		renderGroupCollage(card, members, getDisplayPoster, { letter, color: typeColor });

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
		subtitle.textContent = `${members.length} title${members.length !== 1 ? 's' : ''}`;

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
							`Delete group "${group.name}"? All titles inside will be returned to the main list.`,
							() => {
								void this.dataManager.removeGroup(group.id).then(() => {
									this.expandedGroups.delete(group.id);
									this.render();
								});
							},
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
			new GroupDetailModal(this.plugin.app, this.plugin, group, members, () => {
				this.render();
			}, (name) => this.applyPersonSearch(name)).open();
		});
	}

	private openRenameGroupPrompt(group: WatchLogGroup): void {
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
				void this.dataManager
					.updateGroup({ ...group, name: newName })
					.then(() => this.render());
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

	private openEditModalForTitle(titleId: string): void {
		const current = this.dataManager.getTitle(titleId);
		if (!current) return;
		new EditTitleModal(this.plugin.app, this.plugin, this.dataManager, current, () => {
			this.render();
		}).open();
	}

	private openDetailModalForTitle(titleId: string): void {
		const current = this.dataManager.getTitle(titleId);
		if (!current) return;
		new TitleDetailModal(this.plugin.app, this.plugin, current, () => {
			this.render();
		}, (name) => this.applyPersonSearch(name)).open();
	}

	/** Left-click: open note when openNoteOnClick is on, otherwise the detail modal. */
	private handleTitleActivate(titleId: string): void {
		if (this.plugin.settings.openNoteOnClick) {
			void this.openTitleNote(titleId);
			return;
		}
		this.openDetailModalForTitle(titleId);
	}

	private async openTitleNote(titleId: string): Promise<void> {
		const title = this.dataManager.getTitle(titleId);
		if (!title) return;
		const created = await this.dataManager.createMarkdownFileIfMissing(title);
		if (!created) await this.dataManager.rewriteFrontmatterIfExists(title);
		await openNoteFile(this.plugin.app, this.dataManager.getNoteFilePath(title));
		await this.dataManager.syncNotesFromFile(title.id);
	}

	/** Click-to-filter a credit name: routes it through the search bar, so it is visible and clearable. */
	private applyPersonSearch(name: string): void {
		this.searchQuery = name;
		this.render();
	}

	// Header

	private renderHeader(): void {
		const header = this.container.createDiv({ cls: 'wl-list-header' });

		// import progress bar
		if (this.plugin.importProgress) {
			const { current, total, cancel } = this.plugin.importProgress;
			const progWrap = header.createDiv({ cls: 'wl-header-import-progress' });
			const track = progWrap.createDiv({ cls: 'wl-header-import-track' });
			const fill = track.createDiv({ cls: 'wl-header-import-fill' });
			fill.style.width = `${total > 0 ? Math.round((current / total) * 100) : 0}%`;
			progWrap.createSpan({ cls: 'wl-header-import-text', text: `${current} / ${total}` });
			const cancelBtn = progWrap.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Cancel import' });
			cancelBtn.addEventListener('click', () => cancel());
		}

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
	}

	/** Rebuilds only the toolbar action buttons, so the Cards virtual grid is never torn down. */
	private refreshToolbarActions(): void {
		const wrap = this.toolbarActionsEl;
		if (!wrap || !wrap.isConnected) return;
		wrap.empty();
		this.renderToolbarActions(wrap);
	}

	/**
	 * Enters/exits selection mode without a full rebuild: Cards just clears borders,
	 * List rebuilds the table (rows gain a checkbox column).
	 */
	private setSelectionMode(on: boolean): void {
		this.selectionMode = on;
		this.selectedItems.clear();
		this.refreshToolbarActions();
		if (this.currentView === 'rows') {
			// full rebuild: the section headers gain/lose their select-all box
			this.rerenderActiveView();
		} else {
			this.rerenderTable();
		}
	}

	/**
	 * Select-all spec for one Rows section. undefined outside selection mode, which is what keeps
	 * the box out of the header. Ids, not DOM: the grid sections are virtualised.
	 */
	private shelfSelect(ids: string[]): ShelfSelect | undefined {
		if (!this.selectionMode) return undefined;
		return {
			ids,
			selected: this.selectedItems,
			onToggle: (sectionIds, selectAll) => {
				for (const id of sectionIds) {
					if (selectAll) { this.selectedItems.add(id); } else { this.selectedItems.delete(id); }
				}
				this.syncCardSelectionClasses();
				this.refreshToolbarActions();
			},
			register: (refresh) => this.shelfSelectRefreshers.push(refresh),
		};
	}

	/** A title can sit in several sections, so every header box re-reads the set. */
	private refreshShelfSelects(): void {
		for (const refresh of this.shelfSelectRefreshers) refresh();
	}

	/** Sync wl-card-selected across the whole tab (Cards grid, shelves, By-type grids). */
	private syncCardSelectionClasses(): void {
		this.container.querySelectorAll<HTMLElement>('.wl-card').forEach((card) => {
			const id = card.dataset.titleId ?? card.dataset.groupId;
			card.classList.toggle('wl-card-selected', !!id && this.selectedItems.has(id));
		});
		this.refreshShelfSelects();
	}

	/**
	 * Selection click — state + class only. A title can render more than once in Rows
	 * view, so every instance of the id is synced.
	 */
	private toggleCardSelection(card: HTMLElement, id: string): void {
		if (this.selectedItems.has(id)) {
			this.selectedItems.delete(id);
		} else {
			this.selectedItems.add(id);
		}
		const selected = this.selectedItems.has(id);
		const esc = CSS.escape(id);
		this.container
			.querySelectorAll<HTMLElement>(
				`.wl-card[data-title-id="${esc}"], .wl-card[data-group-id="${esc}"]`,
			)
			.forEach((el) => el.classList.toggle('wl-card-selected', selected));
		this.refreshShelfSelects();
		this.refreshToolbarActions();
	}

	/** Row click/checkbox in List selection mode — class toggle, no re-render. */
	private toggleRowSelection(row: HTMLElement, id: string): boolean {
		const nowSelected = !this.selectedItems.has(id);
		if (nowSelected) {
			this.selectedItems.add(id);
		} else {
			this.selectedItems.delete(id);
		}
		row.classList.toggle('wl-row-selected', nowSelected);
		const cb = row.querySelector<HTMLInputElement>('.wl-col-select input');
		if (cb) cb.checked = nowSelected;
		this.refreshToolbarActions();
		return nowSelected;
	}

	/** Toolbar action buttons. Desktop: inline after the search input; mobile: in the crossfading slot. */
	private renderToolbarActions(controls: HTMLElement): void {
		// saved filter preset (only when one is stored)
		const preset = this.dataManager.getSavedFilterPreset();
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
				// rebuild toolbar + content, not the whole tab
				this.refreshToolbarActions();
				this.rerenderActiveView();
			});
		} else {
			this.savedFilterBtnEl = null;
		}

		this.renderFiltersDropdown(controls);

		this.renderSortingDropdown(controls);

		// action bar — selection mode with items selected
		if (this.selectionMode && this.selectedItems.size > 0) {
			this.renderActionBar(controls);
		}

		if (this.selectionMode) {
			const hasAny = this.selectedItems.size > 0;
			const selAllBtn = controls.createEl('button', { cls: 'wl-btn wl-btn-sm', text: hasAny ? 'None' : 'All' });
			selAllBtn.title = hasAny ? 'Deselect all' : 'Select all visible';
			selAllBtn.addEventListener('click', () => {
				if (this.selectedItems.size > 0) {
					this.selectedItems.clear();
				} else {
					for (const item of this.getDisplayItems()) {
						this.selectedItems.add(item.data.id);
					}
				}
				this.refreshToolbarActions();
				if (this.currentView === 'rows') {
					this.syncCardSelectionClasses();
				} else {
					this.rerenderTable();
				}
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

		const rightGroup = controls.createDiv({ cls: 'wl-header-controls-right' });

		this.renderViewDropdown(rightGroup);

		// add button, far right — opens the chooser modal
		const addBtnWrap = rightGroup.createDiv({ cls: 'wl-add-btn-wrap' });
		const addBtn = addBtnWrap.createEl('button', { cls: 'wl-add-btn wl-btn-success', text: '+ add' });
		addBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openAddTitleChooser();
		});
	}

	private openAddTitleChooser(): void {
		new AddTitleChoiceModal(this.plugin.app, (choice) => {
			if (choice === 'url') {
				new AddFromUrlModal(this.plugin.app, this.plugin, this.dataManager, () => {
					this.render();
				}).open();
			} else {
				this.openAddTitleModal();
			}
		}).open();
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
			this.rerenderTable();
		});

		btn.addEventListener('click', (e) => {
			e.stopPropagation();

			const statusOpts = this.plugin.settings.statuses.map((s) => s.name);
			// half options (½ … 4½) appear only when a title holds that exact rating; keys
			// mirror titlePassesFilters' `${t.rating}★`, so 4.5 matches "4.5★", never 4 or 5
			const presentHalfRatings = new Set<number>();
			for (const t of this.dataManager.getTitles()) {
				if (t.rating % 1 === 0.5) presentHalfRatings.add(t.rating);
			}
			const ratingOpts: string[] = [];
			for (let i = 1; i <= 5; i++) {
				if (presentHalfRatings.has(i - 0.5)) ratingOpts.push(`${i - 0.5}★`);
				ratingOpts.push(`${i}★`);
			}
			const formatRatingOpt = (opt: string): string =>
				opt.replace(/^(\d+)\.5/, (_m, whole: string) => (whole === '0' ? '½' : `${whole}½`));
			const priorityOpts = priorityFilterOpts(this.plugin.settings.priorities);
			const groupOpts = this.dataManager.getGroups().map((g) => g.name);

			// draft — live filter state only changes on Apply
			const draft = {
				typeExclude:              new Set(this.filterTypeExclude),
				statusExclude:            new Set(this.filterStatusExclude),
				ratingExclude:            new Set(this.filterRatingExclude),
				priorityExclude:          new Set(this.filterPriorityExclude),
				groupExclude:             new Set(this.filterGroupExclude),
				filterRatingEmptyOnly:    this.filterRatingEmptyOnly,
				filterRecentlyArrivedOnly: this.filterRecentlyArrivedOnly,
				filterGroupsOnly:         this.filterGroupsOnly,
				filterFavoritesOnly:      this.filterFavoritesOnly,
			};

			const sections: FilterSection[] = [];
			if (!this.typeSubTabsEnabled()) {
				const typeOpts = this.plugin.settings.types.map((t) => t.name);
				sections.push({ label: 'Type', opts: typeOpts, excludeSet: draft.typeExclude });
			}
			sections.push(
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
			);
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
				presetExists: this.dataManager.getSavedFilterPreset() !== null,
				onPresetSave: async () => {
					await this.dataManager.setSavedFilterPreset({
						typeExclude:     this.typeSubTabsEnabled() ? [] : Array.from(draft.typeExclude),
						statusExclude:   Array.from(draft.statusExclude),
						groupExclude:    Array.from(draft.groupExclude),
						ratingExclude:   Array.from(draft.ratingExclude),
						priorityExclude: Array.from(draft.priorityExclude),
						ratingEmptyOnly:       draft.filterRatingEmptyOnly,
						recentlyArrivedOnly:   draft.filterRecentlyArrivedOnly,
						groupsOnly:            draft.filterGroupsOnly,
						favoritesOnly:         draft.filterFavoritesOnly,
					});
				},
				onPresetDelete: async () => {
					await this.dataManager.setSavedFilterPreset(null);
					this.savedFilterActive = false;
				},
				onPresetChanged: () => this.render(),
				onApply: () => {
					this.filterTypeExclude     = this.typeSubTabsEnabled() ? new Set() : draft.typeExclude;
					this.filterStatusExclude   = draft.statusExclude;
					this.filterRatingExclude   = draft.ratingExclude;
					this.filterPriorityExclude = draft.priorityExclude;
					this.filterGroupExclude    = draft.groupExclude;
					this.filterRatingEmptyOnly      = draft.filterRatingEmptyOnly;
					this.filterRecentlyArrivedOnly  = draft.filterRecentlyArrivedOnly;
					this.filterGroupsOnly           = draft.filterGroupsOnly;
					this.filterFavoritesOnly        = draft.filterFavoritesOnly;
					this.saveFiltersToSettings();
					this.deactivateSavedFilter();
					const active = this.hasActiveFilter();
					if (active) { dotEl.show(); clearBtn.show(); } else { dotEl.hide(); clearBtn.hide(); }
					this.rerenderTable();
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
					'Title', 'Date added', 'Progress', 'Rating', 'Priority',
					'Started', 'Status', 'Date watched', 'Time left', 'Time watched',
				],
				labelToKey: (label) => this.sortLabelToKey(label),
				defaultDirs: ListTab.SORT_DEFAULT_DIR,
				primary: { key: this.filterSort, dir: this.filterSortDir },
				secondary: { key: this.filterSecondSort, dir: this.filterSecondSortDir },
				onChange: (primary, secondary) => {
					this.filterSort          = primary.key;
					this.filterSortDir       = primary.dir;
					this.filterSecondSort    = secondary.key;
					this.filterSecondSortDir = secondary.dir;
					this.saveFiltersToSettings();
					// sorting only reorders content
					this.rerenderActiveView();
				},
			});
		});
	}

	private renderViewDropdown(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: 'wl-add-btn-wrap' });
		const btn = wrap.createEl('button', { cls: 'wl-btn wl-btn-sm wl-view-btn' });
		setIcon(btn, this.currentView === 'rows' ? 'layout-grid' : 'list');
		btn.title = 'View';

		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			const existing = wrap.querySelector('.wl-dropdown');
			if (existing) { existing.remove(); return; }

			const panel = wrap.createDiv({ cls: 'wl-dropdown wl-view-panel' });

			const options: { key: 'list' | 'rows'; label: string; icon: string }[] = [
				{ key: 'rows', label: 'Cards', icon: 'layout-grid' },
				{ key: 'list', label: 'List', icon: 'list' },
			];
			for (const opt of options) {
				const active = this.currentView === opt.key;
				const row = panel.createDiv({ cls: `wl-view-option-row${active ? ' is-active' : ''}` });
				const iconEl = row.createSpan({ cls: 'wl-view-option-icon' });
				setIcon(iconEl, opt.icon);
				row.createSpan({ cls: 'wl-view-option-label', text: opt.label });
				if (active) {
					const checkEl = row.createSpan({ cls: 'wl-view-option-check' });
					setIcon(checkEl, 'check');
				}
				row.addEventListener('click', (ev) => {
					ev.stopPropagation();
					panel.remove();
					activeDocument.removeEventListener('click', closer, true);
					if (this.currentView === opt.key) return;
					if (this.currentView === 'rows') {
						// this also tears down the shared poster observer
						this.destroyVirtualScroll();
						this.destroyRowsVirtual();
					}
					this.currentView = opt.key;
					// last-used persistence (the Upcoming pattern) — no separate default setting
					this.plugin.settings.defaultWatchlistView = opt.key;
					void this.plugin.saveSettings();
					this.render();
				});
			}

			const closer = (ev: MouseEvent) => {
				if (!wrap.contains(ev.target as Node)) {
					panel.remove();
					activeDocument.removeEventListener('click', closer, true);
				}
			};
			window.setTimeout(() => activeDocument.addEventListener('click', closer, true), 0);
		});
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
			const count = this.selectedItems.size;
			new ConfirmModal(this.plugin.app, `Delete ${count} selected item${count !== 1 ? 's' : ''}? This cannot be undone.`, () => {
				void (async () => {
					const groupIds = new Set(this.dataManager.getGroups().map((g) => g.id));
					const titleIds: string[] = [];
					for (const id of Array.from(this.selectedItems)) {
						if (groupIds.has(id)) {
							await this.dataManager.removeGroup(id);
							this.expandedGroups.delete(id);
						} else {
							titleIds.push(id);
							if (this.expandedId === id) this.expandedId = null;
						}
					}
					if (titleIds.length > 0) {
						await this.dataManager.removeTitlesBatch(titleIds);
					}
					this.selectedItems.clear();
					this.render();
				})();
			}).open();
		});

		const statusSelect = bar.createEl('select', { cls: 'wl-select wl-select-sm' });
		statusSelect.createEl('option', { text: 'Status…', value: '' });
		for (const s of this.plugin.settings.statuses.filter((s) => s.name !== 'To be released')) {
			statusSelect.createEl('option', { text: s.name, value: s.name });
		}
		statusSelect.addEventListener('change', () => {
			void (async () => {
				const newStatus = statusSelect.value;
				if (!newStatus) return;
				const groupIds = new Set(this.dataManager.getGroups().map((g) => g.id));
				const updated: WatchLogTitle[] = [];
				for (const id of this.selectedItems) {
					if (groupIds.has(id)) continue;
					const t = this.dataManager.getTitle(id);
					if (!t) continue;
					t.status = newStatus;
					this.dataManager.updateTitleSilent(t);
					updated.push(t);
				}
				if (updated.length > 0) {
					await this.dataManager.save();
					for (const t of updated) {
						await this.dataManager.updateMarkdownFile(t);
					}
				}
				statusSelect.value = '';
				this.render();
			})();
		});

		const allGroups = this.dataManager.getGroups();
		const hasGroupSelected = Array.from(this.selectedItems).some((id) =>
			this.dataManager.getGroups().some((g) => g.id === id),
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
				const titleIds = Array.from(this.selectedItems).filter((id) => !groupIds.has(id));

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
						const newGroup: WatchLogGroup = {
							id: this.dataManager.generateGroupId(name),
							name,
							titleIds,
							dateAdded: new Date().toISOString(),
						};
						await this.dataManager.addGroup(newGroup);
						this.selectedItems.clear();
						this.selectionMode = false;
						this.render();
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

				for (const id of titleIds) {
					await this.dataManager.addTitleToGroup(value, id);
				}
				moveSelect.value = '';
				this.selectedItems.clear();
				this.selectionMode = false;
				this.render();
			})();
		});
	}

	// Modal helpers

	private openAddTitleModal(): void {
		const preferredType = this.typeSubTabFiltering() ? this.activeTypeSubTab : undefined;
		new AddTitleModal(this.plugin.app, this.plugin, this.dataManager, () => {
			this.render();
		}, preferredType).open();
	}

	// Search & controls

	private renderSearch(parent: HTMLElement): void {
		// compact inline search, reusing Reading's classes
		const searchWrap = parent.createDiv({ cls: 'wl-reading-search-wrap' });
		const input = searchWrap.createEl('input', {
			cls: 'wl-reading-search-input',
			attr: { type: 'text', placeholder: 'Search titles, cast, studio…' },
		});
		input.value = this.searchQuery;
		renderSearchHelpButton(searchWrap, this.plugin.app, 'Watchlist', () => this.searchFields());
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
				this.rerenderActiveView();
			}, 250);
		});
		clearBtn.addEventListener('click', () => {
			window.clearTimeout(searchDebounce);
			input.value = '';
			this.searchQuery = '';
			syncClear();
			input.focus();
			this.rerenderActiveView();
		});
	}


	private sortLabelToKey(label: string): string {
		const map: Record<string, string> = {
			'Title':        'title',
			'Date added':   'dateAdded',
			'Progress':     'progress',
			'Rating':       'rating',
			'Priority':     'priority',
			'Started':      'started',
			'Status':       'status',
			'Date watched': 'dateWatched',
			'Time left':    'timeLeft',
			'Time watched': 'timeWatched',
		};
		return map[label] ?? 'dateAdded';
	}

	private static readonly SORT_DEFAULT_DIR: Record<string, 'asc' | 'desc'> = {
		title:       'asc',
		dateAdded:   'desc',
		progress:    'desc',
		rating:      'desc',
		priority:    'asc',
		started:     'asc',
		status:      'asc',
		dateWatched: 'desc',
		timeLeft:    'desc',
		timeWatched: 'desc',
	};

	private static migrateSortKey(oldKey: string): { key: string; dir: 'asc' | 'desc' } {
		const map: Record<string, { key: string; dir: 'asc' | 'desc' }> = {
			'title-asc':          { key: 'title',       dir: 'asc' },
			'title-desc':         { key: 'title',       dir: 'desc' },
			'dateAdded-newest':   { key: 'dateAdded',   dir: 'desc' },
			'dateAdded-oldest':   { key: 'dateAdded',   dir: 'asc' },
			'progress-high':      { key: 'progress',    dir: 'desc' },
			'progress-low':       { key: 'progress',    dir: 'asc' },
			'rating-high':        { key: 'rating',      dir: 'desc' },
			'rating-low':         { key: 'rating',      dir: 'asc' },
			'priority':           { key: 'priority',    dir: 'asc' },
			'started-asc':        { key: 'started',     dir: 'asc' },
			'started-desc':       { key: 'started',     dir: 'desc' },
			'status-asc':         { key: 'status',      dir: 'asc' },
			'status-desc':        { key: 'status',      dir: 'desc' },
			'dateWatched-newest': { key: 'dateWatched', dir: 'desc' },
			'dateWatched-oldest': { key: 'dateWatched', dir: 'asc' },
			'timeLeft-high':      { key: 'timeLeft',    dir: 'desc' },
			'timeLeft-low':       { key: 'timeLeft',    dir: 'asc' },
			'timeWatched-high':   { key: 'timeWatched', dir: 'desc' },
			'timeWatched-low':    { key: 'timeWatched', dir: 'asc' },
			'none':               { key: 'none',        dir: 'asc' },
		};
		return map[oldKey] ?? { key: oldKey, dir: 'desc' };
	}

	private static sortBaseAndDirToKey(base: string, dir: 'asc' | 'desc'): string {
		const map: Record<string, { asc: string; desc: string }> = {
			title:       { asc: 'title-asc',          desc: 'title-desc' },
			dateAdded:   { asc: 'dateAdded-oldest',    desc: 'dateAdded-newest' },
			progress:    { asc: 'progress-low',        desc: 'progress-high' },
			rating:      { asc: 'rating-low',          desc: 'rating-high' },
			priority:    { asc: 'priority',            desc: 'priority' },
			started:     { asc: 'started-asc',         desc: 'started-desc' },
			status:      { asc: 'status-asc',          desc: 'status-desc' },
			dateWatched: { asc: 'dateWatched-oldest',  desc: 'dateWatched-newest' },
			timeLeft:    { asc: 'timeLeft-low',        desc: 'timeLeft-high' },
			timeWatched: { asc: 'timeWatched-low',     desc: 'timeWatched-high' },
		};
		return map[base]?.[dir] ?? 'dateAdded-newest';
	}

	// Table rendering

	rerenderTable(): void {
		// route to the active view's renderer, or a List table would append under the Cards grid
		if (this.currentView !== 'list') {
			this.rerenderActiveView();
			return;
		}
		const savedScroll = this._lastScrollTop;
		const existing = this.container.querySelector('.wl-table-section');
		if (existing) existing.remove();
		this.renderTable(savedScroll);
	}

	private rerenderActiveView(): void {
		if (this.currentView === 'rows') {
			// strip rows DOM + any stray table so the two views can't coexist
			this.container
				.querySelectorAll('.wl-cards-empty, .wl-table-section, .wl-results-count, .wl-rows-scroll-container')
				.forEach((el) => el.remove());
			this.renderRowsView();
		} else {
			const savedScroll = this._lastScrollTop;
			const existing = this.container.querySelector('.wl-table-section');
			if (existing) existing.remove();
			this.renderTable(savedScroll);
		}
	}

	/** Count line from the filtered display items (List + Cards; Rows uses renderCountLine). */
	private renderResultsCount(parent: HTMLElement, items: DisplayItem[]): void {
		const titleCount = items.reduce((n, item) => n + (item.kind === 'title' ? 1 : 0), 0);
		const groupCount = items.reduce((n, item) => n + (item.kind === 'group' ? 1 : 0), 0);
		this.renderCountLine(parent, titleCount, groupCount);
	}

	/** The count line itself; returned so Rows can append its gear. */
	private renderCountLine(parent: HTMLElement, titleCount: number, groupCount: number): HTMLElement {
		const countEl = parent.createDiv({ cls: 'wl-results-count' });
		const parts: string[] = [];
		if (titleCount > 0) parts.push(`${titleCount} title${titleCount !== 1 ? 's' : ''}`);
		if (groupCount > 0) parts.push(`${groupCount} group${groupCount !== 1 ? 's' : ''}`);
		countEl.textContent = parts.length > 0 ? parts.join(', ') : '0 titles';
		return countEl;
	}

	private renderTable(restoreScroll?: number): void {
		if (this.scrollCleanup) {
			this.scrollCleanup();
			this.scrollCleanup = null;
		}

		const section = this.container.createDiv({ cls: 'wl-table-section' });
		const items = this.getDisplayItems();

		this.renderResultsCount(section, items);

		const tableCls = this.selectionMode ? 'wl-table wl-selection-mode' : 'wl-table';
		const table = section.createDiv({ cls: tableCls });
		const colHeader = table.createDiv({ cls: 'wl-table-header-row' });
		if (this.selectionMode) {
			colHeader.createDiv({ cls: 'wl-col-select-h' });
		}
		colHeader.createDiv({ cls: 'wl-col-title-h', text: 'Title' });
		colHeader.createDiv({ cls: 'wl-col-priority-h', text: 'Priority' });
		colHeader.createDiv({ cls: 'wl-col-started-h', text: 'Started' });
		colHeader.createDiv({ cls: 'wl-col-rating-h', text: 'Rating' });
		colHeader.createDiv({ cls: 'wl-col-status-h', text: 'Status' });

		if (items.length === 0) {
			table.createDiv({ cls: 'wl-empty-state', text: 'No titles match your filters.' });
			return;
		}

		this.mountVirtualRows(table, items, restoreScroll);
	}

	/**
	 * Virtualised list renderer.
	 * 1 — render everything into a hidden container, read real heights in one batch.
	 * 2 — one fixed-height container, sized once from the offset table (CLS 0 while scrolling).
	 * 3 — per scroll (rAF, passive) binary-search the offsets and absolutely position
	 *     only the visible rows; no layout reads inside the handler.
	 * Expand/collapse goes through rerenderTable(), which rebuilds the whole thing.
	 */
	private mountVirtualRows(table: HTMLElement, items: DisplayItem[], restoreScroll?: number): void {
		const BUFFER_ROWS = 5;
		const INTER_ITEM_GAP = 8;  // px — mirrors the CSS margin-top between top-level rows
		const FALLBACK_H = 44;     // px — used when offsetHeight returns 0 and for buffer math

		// phase 1: uniform row heights
		const ROW_H = 68; // px — covers a standard unexpanded title row with badge + progress bar
		const heights: number[] = items.map(() => ROW_H);

		// phase 1b: measure the expanded title row — only one can be open
		if (this.expandedId !== null) {
			const expandedIdx = items.findIndex(
				(item) => item.kind === 'title' && item.data.id === this.expandedId,
			);
			if (expandedIdx !== -1) {
				const item = items[expandedIdx];
				if (item?.kind === 'title') {
					const probe = activeDocument.body.createDiv();
					probe.style.cssText = `position:absolute;left:-9999px;top:0;width:${table.clientWidth}px;visibility:hidden;`;
					this.renderRow(probe, item.data);
					const measured = probe.offsetHeight;
					probe.remove();
					if (measured > 0) heights[expandedIdx] = measured;
				}
			}
		}

		// phase 1c: measure expanded group rows — several can be open
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item?.kind !== 'group') continue;
			if (!this.expandedGroups.has(item.data.id)) continue;
			const probe = activeDocument.body.createDiv();
			probe.style.cssText = `position:absolute;left:-9999px;top:0;width:${table.clientWidth}px;visibility:hidden;`;
			this.renderGroupRow(probe, item.data, item.members);
			const measured = probe.offsetHeight;
			probe.remove();
			if (measured > 0) heights[i] = measured;
		}

		// phase 2: cumulative offsets (incl. inter-item gap)
		const offsets: number[] = [];
		let totalHeight = 0;
		for (let i = 0; i < items.length; i++) {
			offsets.push(totalHeight);
			totalHeight += heights[i] ?? FALLBACK_H;
			if (i < items.length - 1) totalHeight += INTER_ITEM_GAP;
		}

		// phase 3: fixed-height container, set once — keeps the scroll area stable
		const virt = table.createDiv({ cls: 'wl-virt-container' });
		virt.style.height = `${totalHeight}px`;

		// content-top → virt top, computed once outside the scroll handler
		const scrollEl = this.container;
		const containerTopOffset =
			virt.getBoundingClientRect().top -
			scrollEl.getBoundingClientRect().top +
			scrollEl.scrollTop;

		// restore scroll AFTER containerTopOffset (needs scrollTop=0) but BEFORE renderWindow()
		if (restoreScroll !== undefined) {
			scrollEl.scrollTop = restoreScroll;
		}

		// phase 4: rAF-throttled scroll handler
		let rafId = 0;
		let lastStart = -1;
		let lastEnd = -1;

		const renderWindow = (): void => {
			// read scroll state first — no DOM writes until the reads are done
			const scrollTop = scrollEl.scrollTop;
			const viewH = scrollEl.clientHeight || 600;

			const bufferPx = BUFFER_ROWS * FALLBACK_H;
			const relTop   = scrollTop - containerTopOffset;
			const windowTop = relTop - bufferPx;
			const windowBot = relTop + viewH + bufferPx;

			// binary search: first item whose bottom is past windowTop
			let lo = 0;
			let hi = items.length - 1;
			while (lo <= hi) {
				const mid = (lo + hi) >>> 1;
				if ((offsets[mid] ?? 0) + (heights[mid] ?? FALLBACK_H) <= windowTop) {
					lo = mid + 1;
				} else {
					hi = mid - 1;
				}
			}
			const startIdx = Math.max(0, lo);

			// scan on: last item whose top is before windowBot
			let endIdx = startIdx;
			for (let i = startIdx; i < items.length; i++) {
				if ((offsets[i] ?? 0) >= windowBot) break;
				endIdx = i;
			}

			// skip DOM work if the visible range is unchanged
			if (startIdx === lastStart && endIdx === lastEnd) return;
			lastStart = startIdx;
			lastEnd   = endIdx;

			// write phase
			virt.empty();
			for (let i = startIdx; i <= endIdx; i++) {
				const item = items[i];
				if (!item) continue;  // guard: items array may be stale on concurrent re-render
				const rowEl = virt.createDiv({ cls: 'wl-virt-item' });
				rowEl.style.top = `${offsets[i] ?? 0}px`;
				if (item.kind === 'title') {
					this.renderRow(rowEl, item.data);
				} else {
					this.renderGroupRow(rowEl, item.data, item.members);
				}
			}
		};

		renderWindow();

		const onScroll = (): void => {
			if (rafId !== 0) return;
			rafId = window.requestAnimationFrame(() => {
				rafId = 0;
				renderWindow();
			});
		};

		scrollEl.addEventListener('scroll', onScroll, { passive: true });
		this.scrollCleanup = (): void => {
			scrollEl.removeEventListener('scroll', onScroll);
			if (rafId !== 0) {
				window.cancelAnimationFrame(rafId);
				rafId = 0;
			}
		};
	}

	// Display items (groups + top-level titles)

	private getDisplayItems(): DisplayItem[] {
		const groups = this.dataManager.getGroups();
		const groupedIds = this.dataManager.getGroupedTitleIds();
		const allTitles = this.dataManager.getTitles();
		const titleMap = new Map(allTitles.map((t) => [t.id, t]));
		const q = this.searchQuery.trim().toLowerCase();
		// one fuzzy pass for both top-level and member matching
		const searchMatched = this.getSearchMatchedIds();

		// top-level titles; hidden entirely under "Groups only"
		const topLevel = this.filterGroupsOnly
			? []
			: this.getFilteredSortedTitles(searchMatched).filter((t) => !groupedIds.has(t.id));

		// show a group if any member passes
		const displayGroups: Array<{ kind: 'group'; data: WatchLogGroup; members: WatchLogTitle[] }> = [];
		for (const group of groups) {
			if (this.filterGroupExclude.size > 0 && this.filterGroupExclude.has(group.name)) continue;

			const members = group.titleIds
				.map((id) => titleMap.get(id))
				.filter((t): t is WatchLogTitle => t !== undefined);

			// search hits the group name or a member
			if (searchMatched) {
				const nameMatch = group.name.toLowerCase().includes(q);
				const memberMatch = members.some((m) => searchMatched.has(m.id));
				if (!nameMatch && !memberMatch) continue;
			}

			const anyFilterActive = this.typeSubTabFiltering() ||
				(!this.typeSubTabsEnabled() && this.filterTypeExclude.size > 0) ||
				this.filterStatusExclude.size > 0 ||
				this.filterRatingExclude.size > 0 ||
				this.filterPriorityExclude.size > 0;
			if (anyFilterActive && !members.some((m) => this.titlePassesFilters(m))) continue;

			displayGroups.push({ kind: 'group', data: group, members });
		}

		const allItems: DisplayItem[] = [
			...displayGroups,
			...topLevel.map((t) => ({ kind: 'title' as const, data: t })),
		];

		return allItems.sort((a, b) => {
			// pinned first
			const aPinned = (a.kind === 'title' && a.data.pinned) || (a.kind === 'group' && a.data.id === this.pinnedGroupId);
			const bPinned = (b.kind === 'title' && b.data.pinned) || (b.kind === 'group' && b.data.id === this.pinnedGroupId);
			if (aPinned && !bPinned) return -1;
			if (!aPinned && bPinned) return 1;
			return this.compareDisplayItems(a, b);
		});
	}

	// ascending: Watching → Plan to watch → Completed → To be released → Dropped
	private readonly STATUS_ORDER = ['Watching', 'Plan to watch', 'Completed', 'To be released', 'Dropped'];

	private getStatusIndex(status: string): number {
		const i = this.STATUS_ORDER.indexOf(status);
		return i === -1 ? 99 : i;
	}

	private compareDisplayItemsByKey(key: string, a: DisplayItem, b: DisplayItem): number {

		const getName = (item: DisplayItem): string =>
			item.kind === 'title' ? item.data.title : item.data.name;

		const getProgress = (item: DisplayItem): number =>
			item.kind === 'title'
				? this.dataManager.getProgress(item.data)
				: this.getGroupProgress(item.members);

		const getPriorityIndex = (item: DisplayItem): number => {
			if (item.kind === 'title') {
				const i = PRIORITY_ORDER.indexOf(item.data.priority as typeof PRIORITY_ORDER[number]);
				return i === -1 ? 99 : i;
			}
			const indices = item.members
				.map((m) => PRIORITY_ORDER.indexOf(m.priority as typeof PRIORITY_ORDER[number]))
				.filter((i) => i !== -1);
			return indices.length > 0 ? Math.min(...indices) : 99;
		};

		const getDateAdded = (item: DisplayItem): number => {
			if (item.kind === 'title') return new Date(item.data.dateAdded).getTime();
			const times = item.members.map((m) => new Date(m.dateAdded).getTime());
			return times.length > 0 ? Math.max(...times) : 0;
		};

		const getStartedDate = (item: DisplayItem): number | null => {
			if (item.kind === 'title') {
				return item.data.dateStarted ? new Date(item.data.dateStarted).getTime() : null;
			}
			const dates = item.members
				.map((m) => (m.dateStarted ? new Date(m.dateStarted).getTime() : null))
				.filter((d): d is number => d !== null);
			return dates.length > 0 ? Math.min(...dates) : null;
		};

		const getStatusIdx = (item: DisplayItem): number => {
			if (item.kind === 'title') return this.getStatusIndex(item.data.status);
			return this.getStatusIndex(this.getGroupStatus(item.members));
		};

		const getRating = (item: DisplayItem): number => {
			if (item.kind === 'title') return item.data.rating;
			const rated = item.members.filter((m) => m.rating > 0);
			if (rated.length === 0) return 0;
			return rated.reduce((s, m) => s + m.rating, 0) / rated.length;
		};

		const getDateWatched = (item: DisplayItem): number => {
			if (item.kind === 'title') {
				return item.data.dateFinished ? new Date(item.data.dateFinished).getTime() : 0;
			}
			const dates = item.members
				.map((m) => m.dateFinished ? new Date(m.dateFinished).getTime() : 0)
				.filter((d) => d > 0);
			return dates.length > 0 ? Math.max(...dates) : 0;
		};

		const getTimeLeft = (item: DisplayItem): number =>
			item.kind === 'title'
				? this.dataManager.calcTimeRemaining(item.data)
				: item.members.reduce((s, m) => s + this.dataManager.calcTimeRemaining(m), 0);

		const getTimeWatched = (item: DisplayItem): number =>
			item.kind === 'title'
				? this.dataManager.calcTimeWatched(item.data)
				: item.members.reduce((s, m) => s + this.dataManager.calcTimeWatched(m), 0);

		switch (key) {
			case 'title-asc':        return getName(a).localeCompare(getName(b));
			case 'title-desc':       return getName(b).localeCompare(getName(a));
			case 'dateAdded-newest': return getDateAdded(b) - getDateAdded(a);
			case 'dateAdded-oldest': return getDateAdded(a) - getDateAdded(b);
			case 'progress-high':    return getProgress(b) - getProgress(a);
			case 'progress-low':     return getProgress(a) - getProgress(b);
			case 'rating-high': {
				const ra = getRating(a), rb = getRating(b);
				if (ra === 0 && rb === 0) return 0;
				if (ra === 0) return 1;
				if (rb === 0) return -1;
				return rb - ra;
			}
			case 'rating-low': {
				const ra = getRating(a), rb = getRating(b);
				if (ra === 0 && rb === 0) return 0;
				if (ra === 0) return 1;
				if (rb === 0) return -1;
				return ra - rb;
			}
			case 'priority':         return getPriorityIndex(a) - getPriorityIndex(b);
			case 'status-asc':       return getStatusIdx(a) - getStatusIdx(b);
			case 'status-desc':      return getStatusIdx(b) - getStatusIdx(a);
			case 'started-asc': {
				const da = getStartedDate(a);
				const db = getStartedDate(b);
				if (da == null && db == null) return 0;
				if (da == null) return 1;
				if (db == null) return -1;
				return da - db;
			}
			case 'started-desc': {
				const da = getStartedDate(a);
				const db = getStartedDate(b);
				if (da == null && db == null) return 0;
				if (da == null) return 1;
				if (db == null) return -1;
				return db - da;
			}
			case 'dateWatched-newest': return getDateWatched(b) - getDateWatched(a);
			case 'dateWatched-oldest': {
				const da = getDateWatched(a) || Infinity;
				const db = getDateWatched(b) || Infinity;
				return da - db;
			}
			case 'timeLeft-high':    return getTimeLeft(b) - getTimeLeft(a);
			case 'timeLeft-low':     return getTimeLeft(a) - getTimeLeft(b);
			case 'timeWatched-high': return getTimeWatched(b) - getTimeWatched(a);
			case 'timeWatched-low':  return getTimeWatched(a) - getTimeWatched(b);
			default:                 return 0;
		}
	}

	private compareDisplayItems(a: DisplayItem, b: DisplayItem): number {
		const primaryKey = ListTab.sortBaseAndDirToKey(this.filterSort, this.filterSortDir);
		const primary = this.compareDisplayItemsByKey(primaryKey, a, b);
		if (primary !== 0 || this.filterSecondSort === 'none') return primary;
		const secondKey = ListTab.sortBaseAndDirToKey(this.filterSecondSort, this.filterSecondSortDir);
		return this.compareDisplayItemsByKey(secondKey, a, b);
	}

	// Title row

	private renderRow(parent: HTMLElement, title: WatchLogTitle, indented = false): void {
		const isExpanded = this.expandedId === title.id;
		const isSelected = this.selectedItems.has(title.id);
		const classes = ['wl-row', isExpanded ? 'is-expanded' : '', indented ? 'wl-row-indented' : '', isSelected ? 'wl-row-selected' : '']
			.filter(Boolean)
			.join(' ');
		const row = parent.createDiv({ cls: classes });
		row.dataset['titleId'] = title.id;

		if (this.selectionMode) {
			const cbCol = row.createDiv({ cls: 'wl-col-select' });
			const cb = cbCol.createEl('input', { attr: { type: 'checkbox' } });
			cb.checked = isSelected;
			cb.addEventListener('click', (e) => e.stopPropagation());
			cb.addEventListener('change', () => {
				this.toggleRowSelection(row, title.id);
			});
		}

		const colTitle = row.createDiv({ cls: 'wl-col-title' });
		colTitle.createDiv({ cls: 'wl-row-title-text', text: title.title });
		const typeDef = this.getTagDef(title.type, this.plugin.settings.types);
		const colored = this.plugin.settings.coloredTypeBadges;
		const badgeRow = colTitle.createDiv({ cls: 'wl-badge-row' });
		const typeBadge = badgeRow.createSpan({
			cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain',
			text: title.type,
		});
		if (colored && typeDef) typeBadge.style.backgroundColor = getThemedColor(title.type, typeDef.color, this.plugin.settings.colorTheme);
		// release year after the type badge; omitted when unknown
		const yearMatch = title.releaseDate?.match(/^(\d{4})/);
		if (yearMatch) badgeRow.createSpan({ cls: 'wl-row-year', text: yearMatch[1] });
		if (ListTab.isRecentlyArrived(title)) {
			badgeRow.createSpan({ cls: 'wl-recently-arrived', text: '· Recently arrived' });
		}
		const barWrap = colTitle.createDiv({ cls: 'wl-progress-wrap' });
		const bar = barWrap.createDiv({ cls: 'wl-progress-bar' });
		bar.style.width = `${this.dataManager.getProgress(title)}%`;

		const colPriority = row.createDiv({ cls: 'wl-col-priority' });
		if (title.priority) {
			const priorityDef = this.getTagDef(title.priority, this.plugin.settings.priorities);
			const pBadge = colPriority.createSpan({ cls: 'wl-priority-badge', text: title.priority });
			if (priorityDef) pBadge.style.color = priorityDef.color;
		}

		const colStarted = row.createDiv({ cls: 'wl-col-started' });
		colStarted.textContent = title.dateStarted ? formatDateDisplay(title.dateStarted) : '—';

		const colRating = row.createDiv({ cls: 'wl-col-rating' });
		if (title.rating > 0) {
			const ratingEl = colRating.createSpan({ cls: 'wl-row-rating', text: `★ ${title.rating}/5` });
			ratingEl.style.color = ratingColor(title.rating, this.plugin.settings.ratingSystem);
		} else {
			colRating.createSpan({ cls: 'wl-row-rating wl-row-rating-empty', text: '—' });
		}

		// status badge (respects coloredTypeBadges)
		const colStatus = row.createDiv({ cls: 'wl-col-status' });
		const statusDef = this.getTagDef(title.status, this.plugin.settings.statuses);
		const statusBadge = colStatus.createSpan({
			cls: colored ? 'wl-badge' : 'wl-badge-plain',
			text: title.status,
		});
		if (colored && statusDef) statusBadge.style.backgroundColor = getThemedColor(title.status, statusDef.color, this.plugin.settings.colorTheme);

		const colPin = row.createDiv({ cls: 'wl-col-pin' });
		const pinIcon = colPin.createSpan({
			cls: `wl-pin-icon${title.pinned ? ' is-pinned' : ''}`,
			text: '📌',
		});
		pinIcon.title = title.pinned ? 'Unpin' : 'Pin to top';
		pinIcon.addEventListener('click', (e) => {
			e.stopPropagation();
			void (async () => {
				const t = this.dataManager.getTitle(title.id);
				if (!t) return;
				const newPinned = !t.pinned;
				// unpin all others first
				if (newPinned) {
					for (const other of this.dataManager.getTitles()) {
						if (other.id !== t.id && other.pinned) {
							other.pinned = false;
							await this.dataManager.updateTitle(other);
						}
					}
				}
				t.pinned = newPinned;
				await this.dataManager.updateTitle(t);
				this.rerenderTable();
			})();
		});

		row.addEventListener('click', () => {
			if (this.selectionMode) {
				this.toggleRowSelection(row, title.id);
				return;
			}
			if (this.plugin.settings.openNoteOnClick) {
				void this.openTitleNote(title.id);
				return;
			}
			this.expandedId = isExpanded ? null : title.id;
			if (!isExpanded) {
				this.collapsedSeasons = this.dataManager.getCollapsedSeasonsForTitle(title.id);
			}
			this.rerenderTable();
		});

		if (this.plugin.settings.openNoteOnClick) {
			row.addEventListener('contextmenu', (e) => {
				e.preventDefault();
				if (this.selectionMode) return;
				this.openDetailModalForTitle(title.id);
			});
		}

		if (isExpanded && !this.selectionMode) {
			this.renderAccordion(parent, title);
		}
	}

	// Group header row

	private renderGroupRow(
		parent: HTMLElement,
		group: WatchLogGroup,
		members: WatchLogTitle[],
	): void {
		const isExpanded = this.expandedGroups.has(group.id);
		const isSelected = this.selectedItems.has(group.id);
		const row = parent.createDiv({
			cls: `wl-row wl-group-row${isExpanded ? ' is-expanded' : ''}${isSelected ? ' wl-row-selected' : ''}`,
		});

		// data-* so filters can evaluate group rows like title rows
		row.dataset['type'] = members[0]?.type ?? '';
		row.dataset['status'] = this.getGroupStatus(members);
		row.dataset['priority'] = this.getGroupHighestPriority(members) ?? '';
		row.dataset['rating'] = `${Math.round(this.getGroupRating(members))}★`;
		row.dataset['group'] = group.name;

		if (this.selectionMode) {
			const cbCol = row.createDiv({ cls: 'wl-col-select' });
			const cb = cbCol.createEl('input', { attr: { type: 'checkbox' } });
			cb.checked = isSelected;
			cb.addEventListener('click', (e) => e.stopPropagation());
			cb.addEventListener('change', () => {
				this.toggleRowSelection(row, group.id);
			});
		}

		const colTitle = row.createDiv({ cls: 'wl-col-title' });

		if (this.renamingGroupId === group.id) {
			// rename mode
			const renameRow = colTitle.createDiv({ cls: 'wl-group-name-row' });
			const nameInput = renameRow.createEl('input', {
				cls: 'wl-group-rename-input',
				attr: { type: 'text', value: group.name },
			});
			nameInput.addEventListener('click', (e) => e.stopPropagation());
			nameInput.addEventListener('keydown', (e) => {
				e.stopPropagation();
				if (e.key === 'Enter') {
					void (async () => {
						const newName = nameInput.value.trim();
						if (newName && newName !== group.name) {
							const updated = { ...group, name: newName };
							await this.dataManager.updateGroup(updated);
						}
						this.renamingGroupId = null;
						this.rerenderTable();
					})();
				} else if (e.key === 'Escape') {
					this.renamingGroupId = null;
					this.rerenderTable();
				}
			});
			const saveBtn = renameRow.createEl('button', { cls: 'wl-group-action-btn', text: '✓' });
			saveBtn.title = 'Save';
			saveBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				void (async () => {
					const newName = nameInput.value.trim();
					if (newName && newName !== group.name) {
						const updated = { ...group, name: newName };
						await this.dataManager.updateGroup(updated);
					}
					this.renamingGroupId = null;
					this.rerenderTable();
				})();
			});
			const cancelBtn = renameRow.createEl('button', { cls: 'wl-group-action-btn', text: '✕' });
			cancelBtn.title = 'Cancel';
			cancelBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.renamingGroupId = null;
				this.rerenderTable();
			});
			window.setTimeout(() => nameInput.focus(), 0);
		} else {
			// normal mode
			const nameRow = colTitle.createDiv({ cls: 'wl-group-name-row' });
			nameRow.createSpan({ cls: 'wl-row-title-text wl-group-name', text: group.name });
			const renameBtn = nameRow.createEl('button', { cls: 'wl-group-action-btn', text: '✏' });
			renameBtn.title = 'Rename group';
			renameBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.renamingGroupId = group.id;
				this.rerenderTable();
			});
			const deleteBtn = nameRow.createEl('button', { cls: 'wl-group-action-btn wl-group-action-btn-delete wl-btn-danger', text: '✕' });
			deleteBtn.title = 'Delete group (titles are kept)';
			deleteBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				new ConfirmModal(this.plugin.app, `Delete group "${group.name}"? All titles inside will be returned to the main list.`, () => {
					void this.dataManager.removeGroup(group.id).then(() => {
						this.expandedGroups.delete(group.id);
						this.rerenderTable();
					});
				}).open();
			});
		}

		const primaryType = members[0]?.type ?? '';
		if (primaryType) {
			const typeDef = this.getTagDef(primaryType, this.plugin.settings.types);
			const colored = this.plugin.settings.coloredTypeBadges;
			const typeBadge = colTitle.createSpan({
				cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain',
				text: primaryType,
			});
			if (colored && typeDef) typeBadge.style.backgroundColor = getThemedColor(primaryType, typeDef.color, this.plugin.settings.colorTheme);
		}

		const statsEl = colTitle.createDiv({ cls: 'wl-group-stats' });
		const timeWatched = members.reduce((s, t) => s + this.dataManager.calcTimeWatched(t), 0);
		const timeLeft = members.reduce((s, t) => s + this.dataManager.calcTimeRemaining(t), 0);
		statsEl.createSpan({ text: `${members.length} title${members.length !== 1 ? 's' : ''}` });
		statsEl.createSpan({ text: `  ·  ${formatTime(timeWatched)} watched` });
		statsEl.createSpan({ text: `  ·  ${formatTime(timeLeft)} left` });

		const barWrap = colTitle.createDiv({ cls: 'wl-progress-wrap' });
		barWrap.createDiv({ cls: 'wl-progress-bar' }).style.width =
			`${this.getGroupProgress(members)}%`;

		// priority: highest among members
		const colGrpPriority = row.createDiv({ cls: 'wl-col-priority' });
		const highestPriority = this.getGroupHighestPriority(members);
		if (highestPriority) {
			const pDef = this.getTagDef(highestPriority, this.plugin.settings.priorities);
			const pBadge = colGrpPriority.createSpan({ cls: 'wl-priority-badge', text: highestPriority });
			if (pDef) pBadge.style.color = pDef.color;
		}

		// started: earliest among members
		const colStarted = row.createDiv({ cls: 'wl-col-started' });
		const groupStarted = this.getGroupStartedDate(members);
		colStarted.textContent = groupStarted ? formatDateDisplay(groupStarted) : '—';

		// rating: average
		const colRating = row.createDiv({ cls: 'wl-col-rating' });
		const avgRating = this.getGroupRating(members);
		if (avgRating > 0) {
			const avgRatingEl = colRating.createSpan({
				cls: 'wl-row-rating',
				text: `★ ${avgRating.toFixed(1)}/5`,
			});
			avgRatingEl.style.color = ratingColor(avgRating, this.plugin.settings.ratingSystem);
		} else {
			colRating.createSpan({ cls: 'wl-row-rating wl-row-rating-empty', text: '—' });
		}

		// status: per priority rule, respects coloredTypeBadges
		const colStatus = row.createDiv({ cls: 'wl-col-status' });
		const groupStatus = this.getGroupStatus(members);
		const groupStatusDef = this.getTagDef(groupStatus, this.plugin.settings.statuses);
		const groupColored = this.plugin.settings.coloredTypeBadges;
		const statusBadge = colStatus.createSpan({
			cls: groupColored ? 'wl-badge' : 'wl-badge-plain',
			text: groupStatus,
		});
		if (groupColored) {
			if (groupStatusDef) {
				statusBadge.style.backgroundColor = getThemedColor(groupStatus, groupStatusDef.color, this.plugin.settings.colorTheme);
			} else if (groupStatus === 'In Progress') {
				statusBadge.style.backgroundColor = getThemedColor('In Progress', '#724CF9', this.plugin.settings.colorTheme);
			}
		}

		const isGrpPinned = this.pinnedGroupId === group.id;
		const colGrpPin = row.createDiv({ cls: 'wl-col-pin' });
		const grpPinIcon = colGrpPin.createSpan({
			cls: `wl-pin-icon${isGrpPinned ? ' is-pinned' : ''}`,
			text: '📌',
		});
		grpPinIcon.title = isGrpPinned ? 'Unpin' : 'Pin to top';
		grpPinIcon.addEventListener('click', (e) => {
			e.stopPropagation();
			this.pinnedGroupId = isGrpPinned ? null : group.id;
			void this.dataManager.setPinnedGroupId(this.pinnedGroupId);
			// unpin any pinned title
			if (this.pinnedGroupId) {
				for (const t of this.dataManager.getTitles()) {
					if (t.pinned) {
						t.pinned = false;
						void this.dataManager.updateTitle(t);
					}
				}
			}
			this.rerenderTable();
		});

		// no expand while renaming or selecting
		row.addEventListener('click', () => {
			if (this.renamingGroupId === group.id) return;
			if (this.selectionMode) {
				this.toggleRowSelection(row, group.id);
				return;
			}
			if (isExpanded) {
				this.expandedGroups.delete(group.id);
			} else {
				this.expandedGroups.add(group.id);
			}
			this.rerenderTable();
		});

		if (isExpanded) {
			for (const member of members) {
				this.renderRow(parent, member, true);
			}
		}
	}

	// Group helper calculations

	private getGroupProgress(members: WatchLogTitle[]): number {
		const totalWatched = members.reduce((s, t) => s + t.watchedEpisodes.length, 0);
		const totalEps = members.reduce((s, t) => s + this.dataManager.getEffectiveTotal(t), 0);
		if (totalEps === 0) return 0;
		return Math.min(100, Math.round((totalWatched / totalEps) * 100));
	}

	private getGroupStatus(members: WatchLogTitle[]): string {
		if (members.length === 0) return 'Plan to watch';
		const statuses = members.map((t) => t.status);
		if (statuses.some((s) => s === 'Watching')) return 'Watching';
		if (statuses.every((s) => s === 'Completed')) return 'Completed';
		if (statuses.every((s) => s === 'Plan to watch')) return 'Plan to watch';
		return 'In Progress';
	}

	private getGroupStartedDate(members: WatchLogTitle[]): string | null {
		const dates = members.map((t) => t.dateStarted).filter((d): d is string => d !== null);
		if (dates.length === 0) return null;
		return dates.sort()[0] ?? null;
	}

	private getGroupRating(members: WatchLogTitle[]): number {
		const rated = members.filter((t) => t.rating > 0);
		if (rated.length === 0) return 0;
		return rated.reduce((s, t) => s + t.rating, 0) / rated.length;
	}

	private getGroupHighestPriority(members: WatchLogTitle[]): string | null {
		let best: string | null = null;
		let bestIdx = Infinity;
		for (const m of members) {
			const idx = PRIORITY_ORDER.indexOf(m.priority as typeof PRIORITY_ORDER[number]);
			if (idx !== -1 && idx < bestIdx) {
				bestIdx = idx;
				best = m.priority;
			}
		}
		return best;
	}

	// Accordion

	private renderAccordion(parent: HTMLElement, title: WatchLogTitle): void {
		const accordion = parent.createDiv({ cls: 'wl-accordion' });
		accordion.addEventListener('click', (e) => e.stopPropagation());

		const accHeader = accordion.createDiv({ cls: 'wl-accordion-header' });
		const accLeft = accHeader.createDiv({ cls: 'wl-acc-header-left' });
		const episodeTotal = title.totalEpisodes > 0 ? ` · ${title.totalEpisodes} eps total` : '';
		const startedStr = title.dateStarted
			? `Started ${formatDateDisplay(title.dateStarted)}`
			: 'Not started';
		const subtitleRow = accLeft.createDiv({ cls: 'wl-acc-subtitle' });
		subtitleRow.createSpan({ cls: 'wl-acc-subtitle-text', text: `${startedStr}${episodeTotal}` });
		if (title.externalLink) {
			const linkIcon = subtitleRow.createEl('a', { cls: 'wl-acc-link-icon', text: '🌐' });
			linkIcon.href = title.externalLink;
			linkIcon.title = 'Open external link';
			linkIcon.target = '_blank';
			linkIcon.rel = 'noopener noreferrer';
			linkIcon.addEventListener('click', (e) => e.stopPropagation());
		}

		// credits rows; clicking a name filters this view via the search bar
		const creditsWrap = accLeft.createDiv({ cls: 'wl-acc-credits' });
		renderCreditsRefreshButton(creditsWrap, this.plugin, title, () => this.rerenderTable());
		renderCreditsRows(creditsWrap, title, {
			onPersonClick: (name) => this.applyPersonSearch(name),
			onAddCredits: (field) => {
				new AddCreditModal(this.plugin.app, this.plugin, title, field, () =>
					this.rerenderTable(),
				).open();
			},
			onRemoveManual: (field, name) => {
				void (async () => {
					const remaining = getManualCredits(title, field).filter(
						(n) => n.toLowerCase() !== name.toLowerCase(),
					);
					await this.dataManager.updateManualCredits(title.id, field, remaining);
					this.rerenderTable();
				})();
			},
		});

		const watchedEps = title.watchedEpisodes.length;
		const effectiveTotal = this.dataManager.getEffectiveTotal(title);
		const timeWatched = this.dataManager.calcTimeWatched(title);
		const timeLeft = this.dataManager.calcTimeRemainingForModal(title);
		const progress = this.dataManager.getProgress(title);

		const accRightGroup = accHeader.createDiv({ cls: 'wl-acc-right-group' });

		const makeStatBlock = (value: string, label: string): void => {
			const block = accRightGroup.createDiv({ cls: 'wl-acc-stat-block' });
			block.createDiv({ cls: 'wl-acc-percent', text: value });
			block.createDiv({ cls: 'wl-acc-progress-label', text: label });
		};
		makeStatBlock(formatTime(timeLeft), 'left');
		makeStatBlock(formatTime(timeWatched), 'watched');
		makeStatBlock(`${watchedEps} / ${effectiveTotal}`, 'episodes');

		const accRight = accRightGroup.createDiv({ cls: 'wl-acc-header-right' });
		accRight.createDiv({ cls: 'wl-acc-percent', text: `${progress}%` });
		accRight.createDiv({ cls: 'wl-acc-progress-label', text: 'progress' });
		const accBarWrap = accRight.createDiv({ cls: 'wl-acc-progress-wrap' });
		accBarWrap.createDiv({ cls: 'wl-progress-bar' }).style.width = `${progress}%`;

		const accBody = accordion.createDiv({ cls: 'wl-accordion-body' });
		if (isSingleEpisodeTitle(title)) {
			this.renderSingleEpisodeBody(accBody, title);
		} else {
			this.renderEpisodesBody(accBody, title);
		}

		this.renderAccordionFooter(accordion, title);
	}

	private renderSingleEpisodeBody(parent: HTMLElement, title: WatchLogTitle): void {
		const row = parent.createDiv({ cls: 'wl-movie-row' });
		// the shared toggle writes status + watch date; the row just re-renders
		appendMarkWatchedButton(this.dataManager, row, title.id, () => this.rerenderTable());
	}

	private renderEpisodesBody(parent: HTMLElement, title: WatchLogTitle): void {
		if (title.seasons.length === 0) {
			if (title.totalEpisodes > 0) {
				this.renderEpisodeGrid(parent, title, null);
			}
			return;
		}

		title.seasons.forEach((season, seasonIdx) => {
			let isCollapsed = this.collapsedSeasons.has(seasonIdx);
			const seasonWrap = parent.createDiv({ cls: 'wl-season-wrap' });

			const seasonHeader = seasonWrap.createDiv({ cls: 'wl-season-header' });
			const badge = seasonHeader.createSpan({ cls: 'wl-season-badge' });
			badge.textContent = season.name;
			const palette = this.plugin.settings.seasonPalette;
			badge.style.backgroundColor = palette[seasonIdx % palette.length] ?? '#888780';
			const skipCount = (season.skippedEpisodes ?? []).length;
			const skipSuffix = skipCount > 0 ? ` (${skipCount} to skip)` : '';
			seasonHeader.createSpan({ cls: 'wl-season-ep-count', text: `${season.episodes} eps${skipSuffix}` });
			const chevron = seasonHeader.createSpan({
				cls: `wl-chevron${isCollapsed ? '' : ' is-open'}`,
				text: '›',
			});

			if (!isCollapsed) {
				this.renderEpisodeGrid(seasonWrap, title, season);
			}

			seasonHeader.addEventListener('click', (e) => {
				e.stopPropagation();
				if (isCollapsed) {
					isCollapsed = false;
					this.collapsedSeasons.delete(seasonIdx);
					chevron.classList.add('is-open');
					this.renderEpisodeGrid(seasonWrap, title, season);
				} else {
					isCollapsed = true;
					this.collapsedSeasons.add(seasonIdx);
					chevron.classList.remove('is-open');
					seasonWrap.querySelector('.wl-episode-grid')?.remove();
				}
				if (this.expandedId) {
					void this.dataManager.persistCollapsedSeasons(this.expandedId, this.collapsedSeasons);
				}
			});
		});
	}

	private renderEpisodeGrid(
		parent: HTMLElement,
		title: WatchLogTitle,
		season: Season | null,
	): void {
		const grid = parent.createDiv({ cls: 'wl-episode-grid' });
		const count = season ? season.episodes : title.totalEpisodes;
		const offset = season ? season.offset : 0;
		const seasonEps = Array.from({ length: count }, (_, i) => offset + i + 1);

		// fill/clear toggle; its state is recomputed from live watchedEpisodes
		const fillBtn = grid.createDiv({ cls: 'wl-season-fill-btn' });
		const refreshFillBtn = (): void => {
			const watched = new Set(title.watchedEpisodes);
			const allWatched = seasonEps.length > 0 && seasonEps.every((ep) => watched.has(ep));
			fillBtn.classList.toggle('is-clear', allWatched);
			fillBtn.classList.toggle('is-fill', !allWatched);
			fillBtn.textContent = allWatched ? '✗' : '✓';
			fillBtn.title = allWatched
				? 'Clear all episodes in this season'
				: 'Mark all episodes in this season as watched';
		};
		refreshFillBtn();
		fillBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const watched = new Set(title.watchedEpisodes);
			const allWatched = seasonEps.length > 0 && seasonEps.every((ep) => watched.has(ep));
			// bulk: cheap via the notify path, which triggers a full re-render
			void this.dataManager.markSeasonWatched(title.id, seasonEps, !allWatched, season?.name).then(() => this.rerenderTable());
		});

		const perSeason = this.plugin.settings.episodeNumbering === 'per-season';

		for (let i = 0; i < count; i++) {
			const epNum = offset + i + 1;
			const relNum = i + 1;
			const displayNum = perSeason ? relNum : epNum;

			const box = grid.createDiv({ cls: 'wl-episode-box' });

			// read fresh state — closures over isWatched/isSkipped go stale
			const refreshBox = (): void => {
				const isWatched = title.watchedEpisodes.includes(epNum);
				const isSkipped = season ? (season.skippedEpisodes ?? []).includes(relNum) : false;
				box.classList.toggle('is-watched', isWatched);
				box.classList.toggle('is-skipped', isSkipped);
				box.textContent = isSkipped && !isWatched ? '—' : (isWatched ? '✓' : String(displayNum));
				box.title = `Episode ${epNum}${isSkipped ? ' (skipped)' : ''}`;
			};
			refreshBox();

			// click toggles watched only; skippedEpisodes comes from the Edit modal's season text
			box.addEventListener('click', (e) => {
				e.stopPropagation();
				const isWatched = title.watchedEpisodes.includes(epNum);
				this.dataManager.applyEpisodeWatchedToggle(title.id, epNum, !isWatched);
				refreshBox();
				refreshFillBtn();
				this.updateAccordionStats(box, title, season);
			});
		}
	}

	/**
	 * Targeted update of the accordion stats row and the season header's skip suffix,
	 * so an episode click needs no full re-render.
	 */
	private updateAccordionStats(
		box: HTMLElement,
		title: WatchLogTitle,
		season: Season | null,
	): void {
		const accordion = box.closest('.wl-accordion');
		if (!accordion) return;

		const timeLeft = this.dataManager.calcTimeRemainingForModal(title);
		const timeWatched = this.dataManager.calcTimeWatched(title);
		const watchedEps = title.watchedEpisodes.length;
		const effectiveTotal = this.dataManager.getEffectiveTotal(title);
		const progress = this.dataManager.getProgress(title);

		const statValues = accordion.querySelectorAll<HTMLElement>('.wl-acc-stat-block .wl-acc-percent');
		if (statValues[0]) statValues[0].textContent = formatTime(timeLeft);
		if (statValues[1]) statValues[1].textContent = formatTime(timeWatched);
		if (statValues[2]) statValues[2].textContent = `${watchedEps} / ${effectiveTotal}`;

		const progressText = accordion.querySelector<HTMLElement>('.wl-acc-header-right .wl-acc-percent');
		if (progressText) progressText.textContent = `${progress}%`;
		const progressBar = accordion.querySelector<HTMLElement>('.wl-acc-header-right .wl-progress-bar');
		if (progressBar) progressBar.style.width = `${progress}%`;

		// only changes on skip-toggle, but cheap to refresh either way
		if (season) {
			const grid = box.closest('.wl-episode-grid');
			const seasonWrap = grid?.parentElement;
			const countEl = seasonWrap?.querySelector<HTMLElement>('.wl-season-header .wl-season-ep-count');
			if (countEl) {
				const skipCount = (season.skippedEpisodes ?? []).length;
				const skipSuffix = skipCount > 0 ? ` (${skipCount} to skip)` : '';
				countEl.textContent = `${season.episodes} eps${skipSuffix}`;
			}
		}
	}

	/**
	 * Label + Today + date input bound to one date field. `autoLabel` drops the fixed
	 * label width so a paired field hugs its text.
	 */
	private renderFooterDateField(
		parent: HTMLElement,
		title: WatchLogTitle,
		label: string,
		field: 'dateStarted' | 'dateFinished',
		autoLabel: boolean,
	): void {
		const wrap = parent.createDiv({ cls: 'wl-date-field' });
		wrap.createSpan({
			cls: `wl-footer-label${autoLabel ? ' wl-footer-label-auto' : ''}`,
			text: label,
		});
		const todayBtn = wrap.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-footer-today-btn',
			text: 'Today',
			attr: { title: 'Fill with today’s date' },
		});
		const picker = createDatePicker({
			parent: wrap,
			inputCls: 'wl-footer-date wl-date-input',
			value: title[field],
			stopClickPropagation: true,
			onChange: (iso) => {
				void (async () => {
					const t = this.dataManager.getTitle(title.id);
					if (!t) return;
					t[field] = iso;
					await this.dataManager.updateTitle(t);
					this.rerenderTable();
				})();
			},
		});
		const refreshTodayBtnState = (): void => {
			todayBtn.toggleClass('is-dimmed', !!picker.getValue());
		};
		refreshTodayBtnState();
		todayBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (picker.getValue()) return; // no-op when already filled
			picker.setValue(todayIso());
			refreshTodayBtnState();
		});
	}

	private renderAccordionFooter(parent: HTMLElement, title: WatchLogTitle): void {
		const footer = parent.createDiv({ cls: 'wl-accordion-footer' });

		const starsRow = footer.createDiv({ cls: 'wl-stars-row' });
		starsRow.createSpan({ cls: 'wl-stars-label', text: 'Rating' });
		const starsWrap = starsRow.createDiv({ cls: 'wl-stars' });
		// star clicks must not bubble up and toggle the accordion
		starsWrap.addEventListener('click', (e) => e.stopPropagation());
		renderStarRating(starsWrap, title.rating, {
			allowHalf: this.plugin.settings.halfStarRatings ?? false,
			tiers: this.plugin.settings.ratingSystem,
			showLabel: true,
			onChange: (value) => {
				void (async () => {
					const t = this.dataManager.getTitle(title.id);
					if (!t) return;
					t.rating = value;
					await this.dataManager.updateTitle(t);
					this.rerenderTable();
				})();
			},
		});

		const rerenderCommunity = (): void => {
			const next = starsRow.querySelector('.wl-rating-divider');
			let n: ChildNode | null = next;
			while (n) {
				const toRemove = n;
				n = n.nextSibling;
				toRemove.parentNode?.removeChild(toRemove);
			}
			renderCommunityRating(starsRow, this.plugin, title.id, rerenderCommunity);
		};
		renderCommunityRating(starsRow, this.plugin, title.id, rerenderCommunity);
		maybeAutoRefreshCommunityRating(this.plugin, title.id, rerenderCommunity);

		const notesRow = footer.createDiv({ cls: 'wl-footer-row' });
		const notesInput = notesRow.createEl('input', {
			cls: 'wl-notes-input',
			attr: { type: 'text', placeholder: 'Add a note...' },
		});
		notesInput.value = title.notes;
		notesInput.addEventListener('click', (e) => e.stopPropagation());
		notesInput.addEventListener('change', () => {
			void (async () => {
				const t = this.dataManager.getTitle(title.id);
				if (!t) return;
				t.notes = notesInput.value;
				await this.dataManager.updateTitle(t);
				this.rerenderTable();
			})();
		});

		// started + watched share a row; only the first label keeps the fixed width
		const dateRow = footer.createDiv({ cls: 'wl-footer-row wl-footer-row-pair' });
		this.renderFooterDateField(dateRow, title, 'Date started', 'dateStarted', false);
		this.renderFooterDateField(dateRow, title, 'Date watched', 'dateFinished', true);

		const statusRow = footer.createDiv({ cls: 'wl-footer-row wl-footer-row-pair' });
		const statusField = statusRow.createDiv({ cls: 'wl-date-field' });
		statusField.createSpan({ cls: 'wl-footer-label', text: 'Status' });
		const statusSelect = statusField.createEl('select', { cls: 'wl-select wl-select-sm' });
		for (const s of this.plugin.settings.statuses) {
			if (s.name === 'To be released') continue; // auto-managed; not user-selectable here
			const opt = statusSelect.createEl('option', { text: s.name, value: s.name });
			if (s.name === title.status) opt.selected = true;
		}
		statusSelect.addEventListener('click', (e) => e.stopPropagation());
		statusSelect.addEventListener('change', () => {
			void (async () => {
				const t = this.dataManager.getTitle(title.id);
				if (!t) return;
				t.status = statusSelect.value;
				await this.dataManager.updateTitle(t);
				this.rerenderTable();
			})();
		});

		const priField = statusRow.createDiv({ cls: 'wl-date-field' });
		priField.createSpan({ cls: 'wl-footer-label wl-footer-label-auto', text: 'Priority' });
		const prioritySelect = priField.createEl('select', { cls: 'wl-select wl-select-sm' });
		// blank option clears the priority
		prioritySelect.createEl('option', { text: 'No priority', value: '' });
		for (const p of this.plugin.settings.priorities) {
			const opt = prioritySelect.createEl('option', { text: p.name, value: p.name });
			if (p.name === title.priority) opt.selected = true;
		}
		prioritySelect.addEventListener('click', (e) => e.stopPropagation());
		prioritySelect.addEventListener('change', () => {
			void (async () => {
				const t = this.dataManager.getTitle(title.id);
				if (!t) return;
				t.priority = prioritySelect.value;
				await this.dataManager.updateTitle(t);
				this.rerenderTable();
			})();
		});

		const releaseRow = footer.createDiv({ cls: 'wl-footer-row' });
		releaseRow.createSpan({ cls: 'wl-footer-label', text: 'Release date' });
		createDatePicker({
			parent: releaseRow,
			inputCls: 'wl-footer-date wl-date-input',
			value: title.releaseDate,
			lenient: true,
			stopClickPropagation: true,
			onChange: (iso) => {
				void (async () => {
					const t = this.dataManager.getTitle(title.id);
					if (!t) return;
					t.releaseDate = iso;
					await this.dataManager.updateTitle(t);
					// may flip the status to "To be released" and add/remove the Upcoming entry
					await this.dataManager.applyReleaseDateChange(t);
					this.rerenderTable();
				})();
			},
		});

		const actionRow = footer.createDiv({ cls: 'wl-footer-row wl-footer-action-row' });

		const deleteBtn = actionRow.createEl('button', { cls: 'wl-delete-btn wl-btn-danger', text: 'Remove' });
		deleteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			new ConfirmModal(this.plugin.app, `Remove "${title.title}" from watchlog?`, () => {
				void this.dataManager.removeTitle(title.id).then(() => {
					this.expandedId = null;
					this.rerenderTable();
				});
			}).open();
		});

		const editBtnWrap = actionRow.createDiv({ cls: 'wl-add-btn-wrap' });
		const editBtn = editBtnWrap.createEl('button', { cls: 'wl-edit-btn', text: 'Edit' });
		editBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const current = this.dataManager.getTitle(title.id);
			if (!current) return;
			new EditTitleModal(this.plugin.app, this.plugin, this.dataManager, current, () => {
				this.rerenderTable();
			}).open();
		});
	}

	// Filter + sort

	private compareTitlesByKey(key: string, a: WatchLogTitle, b: WatchLogTitle): number {
		switch (key) {
			case 'title-asc':        return a.title.localeCompare(b.title);
			case 'title-desc':       return b.title.localeCompare(a.title);
			case 'dateAdded-newest': return new Date(b.dateAdded).getTime() - new Date(a.dateAdded).getTime();
			case 'dateAdded-oldest': return new Date(a.dateAdded).getTime() - new Date(b.dateAdded).getTime();
			case 'progress-high':    return this.dataManager.getProgress(b) - this.dataManager.getProgress(a);
			case 'progress-low':     return this.dataManager.getProgress(a) - this.dataManager.getProgress(b);
			case 'rating-high': {
				const ra = a.rating === 0 ? -1 : a.rating;
				const rb = b.rating === 0 ? -1 : b.rating;
				return rb - ra;
			}
			case 'rating-low': {
				if (a.rating === 0 && b.rating === 0) return 0;
				if (a.rating === 0) return 1;
				if (b.rating === 0) return -1;
				return a.rating - b.rating;
			}
			case 'priority': {
				const ai = PRIORITY_ORDER.indexOf(a.priority as typeof PRIORITY_ORDER[number]);
				const bi = PRIORITY_ORDER.indexOf(b.priority as typeof PRIORITY_ORDER[number]);
				return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
			}
			case 'started-asc': {
				const da = a.dateStarted ? new Date(a.dateStarted).getTime() : Infinity;
				const db = b.dateStarted ? new Date(b.dateStarted).getTime() : Infinity;
				return da - db;
			}
			case 'started-desc': {
				const da2 = a.dateStarted ? new Date(a.dateStarted).getTime() : null;
				const db2 = b.dateStarted ? new Date(b.dateStarted).getTime() : null;
				if (da2 == null && db2 == null) return 0;
				if (da2 == null) return 1;
				if (db2 == null) return -1;
				return db2 - da2;
			}
			case 'status-asc':  return this.getStatusIndex(a.status) - this.getStatusIndex(b.status);
			case 'status-desc': return this.getStatusIndex(b.status) - this.getStatusIndex(a.status);
			case 'dateWatched-newest': {
				const da = a.dateFinished ? new Date(a.dateFinished).getTime() : 0;
				const db = b.dateFinished ? new Date(b.dateFinished).getTime() : 0;
				return db - da;
			}
			case 'dateWatched-oldest': {
				const da = a.dateFinished ? new Date(a.dateFinished).getTime() : Infinity;
				const db = b.dateFinished ? new Date(b.dateFinished).getTime() : Infinity;
				return da - db;
			}
			case 'timeLeft-high':    return this.dataManager.calcTimeRemaining(b) - this.dataManager.calcTimeRemaining(a);
			case 'timeLeft-low':     return this.dataManager.calcTimeRemaining(a) - this.dataManager.calcTimeRemaining(b);
			case 'timeWatched-high': return this.dataManager.calcTimeWatched(b) - this.dataManager.calcTimeWatched(a);
			case 'timeWatched-low':  return this.dataManager.calcTimeWatched(a) - this.dataManager.calcTimeWatched(b);
			default: return 0;
		}
	}

	/** Fields the Watchlist search covers — also drives the "?" help panel. */
	searchFields(): SearchFieldSpec<WatchLogTitle>[] {
		return [
			{ name: 'title', label: 'Title', weight: 0.6, text: (t) => [t.title] },
			{ name: 'director', label: 'Director', weight: 0.2, aliases: ['dir'], text: (t) => getTitleCredits(t, 'director') },
			{ name: 'studio', label: 'Studio', weight: 0.1, text: (t) => getTitleCredits(t, 'studio') },
			{ name: 'cast', label: 'Cast', weight: 0.1, aliases: ['actor'], text: (t) => getTitleCredits(t, 'cast') },
			{ name: 'year', label: 'Year', weight: 0.05, text: (t) => { const y = yearOf(t.releaseDate); return y ? [String(y)] : []; }, number: (t) => yearOf(t.releaseDate) },
			{ name: 'rating', label: 'Rating', number: (t) => t.rating },
		];
	}

	/** Matching title ids, or null for an empty query. See SearchQuery.ts for the semantics. */
	private getSearchMatchedIds(): Set<string> | null {
		return searchItems(this.dataManager.getTitles(), { id: (t) => t.id, fields: this.searchFields() }, this.searchQuery);
	}

	private getFilteredSortedTitles(searchMatched?: Set<string> | null): WatchLogTitle[] {
		let titles = this.dataManager.getTitles();

		const matched = searchMatched !== undefined ? searchMatched : this.getSearchMatchedIds();
		if (matched) {
			titles = titles.filter((t) => matched.has(t.id));
		}

		titles = titles.filter((t) => this.titlePassesFilters(t));

		return this.sortTitlesByCurrentSort(titles);
	}

	/**
	 * Apply the two-level Sorting selection. Shared by List/Cards and the By-type
	 * grids, which sort within each section.
	 */
	private sortTitlesByCurrentSort(titles: WatchLogTitle[]): WatchLogTitle[] {
		const primaryKey = ListTab.sortBaseAndDirToKey(this.filterSort, this.filterSortDir);
		const secondKey = this.filterSecondSort === 'none'
			? 'none'
			: ListTab.sortBaseAndDirToKey(this.filterSecondSort, this.filterSecondSortDir);
		return [...titles].sort((a, b) => {
			const primary = this.compareTitlesByKey(primaryKey, a, b);
			if (primary !== 0 || secondKey === 'none') return primary;
			return this.compareTitlesByKey(secondKey, a, b);
		});
	}

	// Utilities

	private getTagDef(name: string, tags: TagDefinition[]): TagDefinition | undefined {
		return tags.find((t) => t.name === name);
	}

}

