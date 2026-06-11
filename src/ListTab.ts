import { Modal } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type { WatchLogTitle, WatchLogGroup, TagDefinition, SavedFilterPreset, Season } from './types';
import { formatTime, formatDateDisplay, parseDateInput, getThemedColor, getDisplayPoster } from './types';
import { renderCommunityRating, maybeAutoRefreshCommunityRating, refreshCommunityRating } from './CommunityRating';
import { AddTitleModal } from './AddTitleModal';
import { AddFromUrlModal } from './AddFromUrlModal';
import { EditTitleModal } from './EditTitleModal';
import { ConfirmModal } from './ConfirmModal';
import { TitleDetailModal, GroupDetailModal } from './TitleDetailModal';
import { renderGroupCollage } from './CollageUtil';

// ── Display item type ─────────────────────────────────────────────────────────

type DisplayItem =
	| { kind: 'title'; data: WatchLogTitle }
	| { kind: 'group'; data: WatchLogGroup; members: WatchLogTitle[] };

// ── Shared constants ──────────────────────────────────────────────────────────

const PRIORITY_ORDER = ['High', 'Medium', 'Low'] as const;

// ── ListTab ───────────────────────────────────────────────────────────────────

export class ListTab {
	private container: HTMLElement;
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;

	// Preserved state
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

	// Selection mode
	selectionMode = false;
	selectedItems: Set<string> = new Set(); // title ids or group ids

	// Pin state — groups (persisted via DataManager)
	pinnedGroupId: string | null = null;

	// Saved filter preset state
	savedFilterActive = false;
	private savedFilterBtnEl: HTMLButtonElement | null = null;

	// Empty-only filter flags
	filterRatingEmptyOnly = false;
	filterPriorityEmptyOnly = false;

	// Recently arrived only filter
	filterRecentlyArrivedOnly = false;

	// Groups only filter — hides standalone titles, shows only groups
	filterGroupsOnly = false;

	// Watchlist sub-tab
	currentSubTab: 'list' | 'cards' = 'list';

	// Virtual-scroll cleanup — removes the rAF-throttled scroll listener on re-render
	private scrollCleanup: (() => void) | null = null;

	// Cards-view poster lazy loading
	private cardsObserver: IntersectionObserver | null = null;
	private observedCards: Set<HTMLElement> = new Set();

	// Cards virtual scroll state
	private cardsScrollContainer: HTMLElement | null = null;
	private cardsScrollSpacer: HTMLElement | null = null;
	private cardsGridEl: HTMLElement | null = null;
	private cardsDisplayItems: DisplayItem[] = [];
	private cardsScrollHandler: (() => void) | null = null;
	private cardsScrollRAF: number | null = null;
	private cardsResizeObserver: ResizeObserver | null = null;
	private cardsLastFirst = -1;
	private cardsLastLast = -1;
	private cardsLastScrollTop = 0;
	// Survives destroyVirtualScroll() so render() can restore scroll position
	// after a full Cards-view rebuild (mirrors how _lastScrollTop works for List).
	private _cardsPersistentScrollTop = 0;
	private cardsRowHeight = 0;

	// Last known scroll position — updated continuously so rerenderTable() has the
	// correct value even when called after an async operation has mutated the DOM.
	private _lastScrollTop = 0;
	private scrollPositionListener: (() => void) | null = null;

	// Document-level click handlers registered for transient menus/panels.
	// Cleaned up on rerender so DOM removal doesn't leave dangling listeners.
	private activeCleanups: (() => void)[] = [];

	constructor(container: HTMLElement, plugin: WatchLogPlugin, dataManager: DataManager) {
		this.container = container;
		this.plugin = plugin;
		this.dataManager = dataManager;
		this.currentSubTab = plugin.settings.defaultWatchlistView === 'list' ? 'list' : 'cards';
		this.scrollPositionListener = () => {
			this._lastScrollTop = this.container.scrollTop;
		};
		this.container.addEventListener('scroll', this.scrollPositionListener, { passive: true });
		this.pinnedGroupId = dataManager.getPinnedGroupId();

		// Restore persisted filter state
		const saved = plugin.settings.listFilters;
		if (saved) {
			this.filterTypeExclude     = new Set(saved.typeExclude     ?? []);
			this.filterStatusExclude   = new Set(saved.statusExclude   ?? []);
			this.filterGroupExclude    = new Set(saved.groupExclude    ?? []);
			this.filterRatingExclude   = new Set(saved.ratingExclude   ?? []);
			this.filterPriorityExclude = new Set(saved.priorityExclude ?? []);
			const ms = ListTab.migrateSortKey(saved.sort ?? 'dateAdded-newest');
			this.filterSort     = ms.key;
			this.filterSortDir  = saved.sortDir ?? ms.dir;
			const ms2 = ListTab.migrateSortKey(saved.secondSort ?? 'none');
			this.filterSecondSort    = ms2.key;
			this.filterSecondSortDir = saved.secondSortDir ?? ms2.dir;
			this.filterRatingEmptyOnly      = saved.ratingEmptyOnly      ?? false;
			this.filterPriorityEmptyOnly    = saved.priorityEmptyOnly    ?? false;
			this.filterRecentlyArrivedOnly  = saved.recentlyArrivedOnly  ?? false;
			this.filterGroupsOnly           = saved.groupsOnly           ?? false;
		}

		// Detect if current filters match the saved preset so the button stays green
		const savedPreset = dataManager.getSavedFilterPreset();
		if (savedPreset) {
			const setsMatch = (a: Set<string>, b: string[]) =>
				a.size === b.length && b.every((x) => a.has(x));
			this.savedFilterActive =
				setsMatch(this.filterTypeExclude, savedPreset.typeExclude) &&
				setsMatch(this.filterStatusExclude, savedPreset.statusExclude) &&
				setsMatch(this.filterGroupExclude, savedPreset.groupExclude) &&
				setsMatch(this.filterRatingExclude, savedPreset.ratingExclude) &&
				setsMatch(this.filterPriorityExclude, savedPreset.priorityExclude) &&
				(this.filterRatingEmptyOnly === (savedPreset.ratingEmptyOnly ?? false)) &&
				(this.filterPriorityEmptyOnly === (savedPreset.priorityEmptyOnly ?? false)) &&
				(this.filterRecentlyArrivedOnly === (savedPreset.recentlyArrivedOnly ?? false)) &&
				(this.filterGroupsOnly === (savedPreset.groupsOnly ?? false));
		}
	}

	private saveFiltersToSettings(): void {
		this.plugin.settings.listFilters = {
			typeExclude:     Array.from(this.filterTypeExclude),
			statusExclude:   Array.from(this.filterStatusExclude),
			groupExclude:    Array.from(this.filterGroupExclude),
			ratingExclude:   Array.from(this.filterRatingExclude),
			priorityExclude: Array.from(this.filterPriorityExclude),
			sort:          this.filterSort,
			sortDir:       this.filterSortDir,
			secondSort:    this.filterSecondSort,
			secondSortDir: this.filterSecondSortDir,
			ratingEmptyOnly:       this.filterRatingEmptyOnly,
			priorityEmptyOnly:     this.filterPriorityEmptyOnly,
			recentlyArrivedOnly:   this.filterRecentlyArrivedOnly,
			groupsOnly:            this.filterGroupsOnly,
		};
		void this.plugin.saveSettings();
	}

	private hasActiveFilter(): boolean {
		return this.filterTypeExclude.size > 0 ||
			this.filterStatusExclude.size > 0 ||
			this.filterPriorityExclude.size > 0 ||
			this.filterRatingExclude.size > 0 ||
			this.filterGroupExclude.size > 0 ||
			this.filterRatingEmptyOnly ||
			this.filterPriorityEmptyOnly ||
			this.filterRecentlyArrivedOnly ||
			this.filterGroupsOnly;
	}

	private clearAllFilters(): void {
		this.filterTypeExclude.clear();
		this.filterStatusExclude.clear();
		this.filterPriorityExclude.clear();
		this.filterRatingExclude.clear();
		this.filterGroupExclude.clear();
		this.filterRatingEmptyOnly      = false;
		this.filterPriorityEmptyOnly    = false;
		this.filterRecentlyArrivedOnly  = false;
		this.filterGroupsOnly           = false;
	}

	private applyPreset(preset: SavedFilterPreset): void {
		this.filterTypeExclude          = new Set(preset.typeExclude);
		this.filterStatusExclude        = new Set(preset.statusExclude);
		this.filterGroupExclude         = new Set(preset.groupExclude);
		this.filterRatingExclude        = new Set(preset.ratingExclude);
		this.filterPriorityExclude      = new Set(preset.priorityExclude);
		this.filterRatingEmptyOnly      = preset.ratingEmptyOnly      ?? false;
		this.filterPriorityEmptyOnly    = preset.priorityEmptyOnly    ?? false;
		this.filterRecentlyArrivedOnly  = preset.recentlyArrivedOnly  ?? false;
		this.filterGroupsOnly           = preset.groupsOnly           ?? false;
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
		if (this.filterTypeExclude.size > 0 && this.filterTypeExclude.has(t.type)) return false;
		if (this.filterRecentlyArrivedOnly) {
			if (!ListTab.isRecentlyArrived(t)) return false;
		} else if (this.filterStatusExclude.size > 0 && this.filterStatusExclude.has(t.status)) {
			return false;
		}
		if (this.filterRatingEmptyOnly) {
			if (t.rating !== 0) return false;
		} else if (this.filterRatingExclude.size > 0 && this.filterRatingExclude.has(`${t.rating}★`)) {
			return false;
		}
		if (this.filterPriorityEmptyOnly) {
			if (t.priority) return false;
		} else if (this.filterPriorityExclude.size > 0 && this.filterPriorityExclude.has(t.priority)) {
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
		// Make sure any debounced episode-click save reaches disk before we
		// lose the tab instance (e.g. on tab switch or view close).
		void this.dataManager.flushPendingSave();
	}

	render(): void {
		this._lastScrollTop = this.container.scrollTop || this._lastScrollTop;
		this.activeCleanups.forEach((fn) => fn());
		this.activeCleanups = [];
		this.container.empty();
		this.container.addClass('wl-list');
		this.renderSubTabBar();
		if (this.currentSubTab === 'list') {
			this.renderListContent();
		} else {
			this.renderCardsContent();
		}
	}

	private renderSubTabBar(): void {
		const bar = this.container.createDiv({ cls: 'wl-inner-tab-bar' });
		const cardsBtn = bar.createEl('button', {
			cls: `wl-inner-tab-btn${this.currentSubTab === 'cards' ? ' is-active' : ''}`,
			text: 'Cards',
		});
		const listBtn = bar.createEl('button', {
			cls: `wl-inner-tab-btn${this.currentSubTab === 'list' ? ' is-active' : ''}`,
			text: 'List',
		});
		listBtn.addEventListener('click', () => {
			if (this.currentSubTab === 'list') return;
			this.destroyVirtualScroll();
			this.currentSubTab = 'list';
			this.render();
		});
		cardsBtn.addEventListener('click', () => {
			if (this.currentSubTab === 'cards') return;
			this.currentSubTab = 'cards';
			this.render();
		});
	}

	private renderListContent(): void {
		this.renderHeader();
		this.container.createDiv({ cls: 'wl-divider' });
		this.renderTable(this._lastScrollTop);
	}

	private renderCardsContent(): void {
		this.renderHeader();
		this.container.createDiv({ cls: 'wl-divider' });
		this.renderCardsView();
	}

	private renderCardsView(): void {
		this.destroyVirtualScroll();
		const items = this.getDisplayItems();
		this.cardsDisplayItems = items;
		this.renderResultsCount(this.container, items);
		if (items.length === 0) {
			const empty = this.container.createDiv({ cls: 'wl-cards-empty' });
			empty.createSpan({ cls: 'wl-cards-empty-icon', text: '🎬' });
			empty.createEl('p', { cls: 'wl-cards-empty-msg', text: 'No titles match your filters' });
			return;
		}

		const scroll = this.container.createDiv({ cls: 'wl-cards-scroll-container' });
		const spacer = scroll.createDiv({ cls: 'wl-cards-scroll-spacer' });
		const grid = spacer.createDiv({ cls: 'wl-cards-grid wl-cards-grid-virtual' });
		this.cardsScrollContainer = scroll;
		this.cardsScrollSpacer = spacer;
		this.cardsGridEl = grid;
		this.cardsLastFirst = -1;
		this.cardsLastLast = -1;

		this.cardsScrollHandler = () => {
			const scrollTop = scroll.scrollTop;
			this._cardsPersistentScrollTop = scrollTop;
			// Only schedule a render when the user has scrolled at least half a
			// row's height — below that, the visible range cannot change so the
			// rerun would do nothing useful.
			const threshold = this.cardsRowHeight > 0 ? this.cardsRowHeight / 2 : 50;
			if (Math.abs(scrollTop - this.cardsLastScrollTop) < threshold) return;
			this.cardsLastScrollTop = scrollTop;
			if (this.cardsScrollRAF !== null) return;
			this.cardsScrollRAF = window.requestAnimationFrame(() => {
				this.cardsScrollRAF = null;
				this.renderVisibleCards();
			});
		};
		scroll.addEventListener('scroll', this.cardsScrollHandler, { passive: true });

		// Let renderVisibleCards detect range changes. We do NOT reset
		// cardsLastFirst/Last when width shifts (e.g. scrollbar appears after
		// the spacer height is set) — the CSS grid reflows on its own and the
		// internal range comparison already short-circuits if no items moved.
		// Resetting here caused a spurious second "initial" render.
		this.cardsResizeObserver = new ResizeObserver(() => {
			this.renderVisibleCards();
		});
		this.cardsResizeObserver.observe(scroll);

		// Restore scroll position from before the last re-render. The spacer
		// height isn't set yet (renderVisibleCards does that), so do a first
		// pass to size the spacer, then assign scrollTop, then re-run so the
		// correct row range is materialized.
		if (this._cardsPersistentScrollTop > 0) {
			this.renderVisibleCards();
			scroll.scrollTop = this._cardsPersistentScrollTop;
			this.cardsLastScrollTop = this._cardsPersistentScrollTop;
			this.renderVisibleCards();
		}
	}

	private getCardsGridMetrics(containerWidth: number): {
		cols: number;
		cardWidth: number;
		cardHeight: number;
		rowHeight: number;
	} {
		const gap = 12;
		const minCardWidth = 140;
		const cols = Math.max(1, Math.floor((containerWidth + gap) / (minCardWidth + gap)));
		const cardWidth = (containerWidth - gap * (cols - 1)) / cols;
		const cardHeight = cardWidth * 1.5;
		const rowHeight = cardHeight + gap;
		return { cols, cardWidth, cardHeight, rowHeight };
	}

	private renderVisibleCards(): void {
		const scroll = this.cardsScrollContainer;
		const spacer = this.cardsScrollSpacer;
		const grid = this.cardsGridEl;
		if (!scroll || !spacer || !grid) return;

		const scrollTop = scroll.scrollTop;
		const viewportHeight = scroll.clientHeight;
		const width = scroll.clientWidth;
		if (width <= 0 || viewportHeight <= 0) return;

		const { cols, cardWidth, cardHeight, rowHeight } = this.getCardsGridMetrics(width);
		this.cardsRowHeight = rowHeight;
		const totalItems = this.cardsDisplayItems.length;
		const totalRows = Math.ceil(totalItems / cols);

		const firstVisibleRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 2);
		const lastVisibleRow = Math.min(
			totalRows - 1,
			Math.ceil((scrollTop + viewportHeight) / rowHeight) + 2,
		);
		const firstIndex = firstVisibleRow * cols;
		const lastIndex = Math.min(totalItems - 1, (lastVisibleRow + 1) * cols - 1);

		spacer.style.height = `${totalRows * rowHeight}px`;
		grid.style.transform = `translateY(${firstVisibleRow * rowHeight}px)`;
		grid.style.setProperty('--wl-cards-cols', String(cols));
		grid.style.setProperty('--wl-card-height', `${cardHeight}px`);

		const oldFirst = this.cardsLastFirst;
		const oldLast = this.cardsLastLast;
		if (firstIndex === oldFirst && lastIndex === oldLast) return;

		const isInitial = oldFirst === -1 || oldLast === -1;
		const hasOverlap = !isInitial && firstIndex <= oldLast && lastIndex >= oldFirst;

		this.cardsLastFirst = firstIndex;
		this.cardsLastLast = lastIndex;

		if (isInitial || !hasOverlap) {
			this.fullRenderCards(grid, firstIndex, lastIndex, cardWidth, cardHeight);
			this.setupCardsObserver(scroll);
			return;
		}

		// Incremental update — trim from edges, then add what's new.
		if (firstIndex > oldFirst) {
			const removeCount = firstIndex - oldFirst;
			for (let i = 0; i < removeCount; i++) {
				const el = grid.firstElementChild as HTMLElement | null;
				if (!el) break;
				this.unobserveAndRemove(el);
			}
		}
		if (lastIndex < oldLast) {
			const removeCount = oldLast - lastIndex;
			for (let i = 0; i < removeCount; i++) {
				const el = grid.lastElementChild as HTMLElement | null;
				if (!el) break;
				this.unobserveAndRemove(el);
			}
		}
		if (firstIndex < oldFirst) {
			const addEnd = Math.min(oldFirst - 1, lastIndex);
			const fragment = activeDocument.createDocumentFragment();
			for (let i = firstIndex; i <= addEnd; i++) {
				const card = this.buildCardElement(i, cardWidth, cardHeight);
				if (card) fragment.appendChild(card);
			}
			grid.insertBefore(fragment, grid.firstChild);
		}
		if (lastIndex > oldLast) {
			const addStart = Math.max(oldLast + 1, firstIndex);
			const fragment = activeDocument.createDocumentFragment();
			for (let i = addStart; i <= lastIndex; i++) {
				const card = this.buildCardElement(i, cardWidth, cardHeight);
				if (card) fragment.appendChild(card);
			}
			grid.appendChild(fragment);
		}

		this.setupCardsObserver(scroll);
	}

	private fullRenderCards(
		grid: HTMLElement,
		firstIndex: number,
		lastIndex: number,
		cardWidth: number,
		cardHeight: number,
	): void {
		this.observedCards.clear();
		grid.empty();
		const fragment = activeDocument.createDocumentFragment();
		for (let i = firstIndex; i <= lastIndex; i++) {
			const card = this.buildCardElement(i, cardWidth, cardHeight);
			if (card) fragment.appendChild(card);
		}
		grid.appendChild(fragment);
	}

	private buildCardElement(
		index: number,
		cardWidth: number,
		cardHeight: number,
	): HTMLElement | null {
		const item = this.cardsDisplayItems[index];
		if (!item) return null;
		const tmp = activeDocument.createElement('div');
		if (item.kind === 'title') {
			this.renderTitleCard(tmp, item.data, cardWidth, cardHeight);
		} else {
			this.renderGroupCard(tmp, item.data, item.members, cardWidth, cardHeight);
		}
		return tmp.firstElementChild as HTMLElement | null;
	}

	private unobserveAndRemove(el: HTMLElement): void {
		if (this.cardsObserver && this.observedCards.has(el)) {
			this.cardsObserver.unobserve(el);
			this.observedCards.delete(el);
		}
		el.remove();
	}

	private setupCardsObserver(container: HTMLElement): void {
		if (!this.cardsObserver) {
			this.cardsObserver = new IntersectionObserver(
				(entries) => this.handleCardIntersection(entries),
				{
					root: container,
					rootMargin: '0px',
					threshold: 0,
				},
			);
		}
		const cards = (this.cardsGridEl ?? container).querySelectorAll(
			'.wl-card[data-needs-poster="true"]',
		);
		cards.forEach((card) => {
			const el = card as HTMLElement;
			if (!this.observedCards.has(el)) {
				this.cardsObserver!.observe(el);
				this.observedCards.add(el);
			}
		});
	}

	private handleCardIntersection(entries: IntersectionObserverEntry[]): void {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const card = entry.target as HTMLElement;
			const titleId = card.dataset.titleId;
			if (!titleId) continue;

			this.cardsObserver?.unobserve(card);

			const title = this.dataManager.getTitles().find((t) => t.id === titleId);
			if (!title) continue;
			// Manual override takes priority — skip auto-fetch for manual overrides
			// and for titles whose auto-fetched poster is already populated.
			if (title.manualPosterUrl && title.manualPosterUrl.trim() !== '') continue;
			if (title.posterUrl !== '') continue;

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

	private destroyCardsObserver(): void {
		if (this.cardsObserver) {
			this.cardsObserver.disconnect();
			this.cardsObserver = null;
		}
		this.observedCards.clear();
		this.plugin.posterService?.clearQueue();
	}

	private destroyVirtualScroll(): void {
		if (this.cardsScrollRAF !== null) {
			window.cancelAnimationFrame(this.cardsScrollRAF);
			this.cardsScrollRAF = null;
		}
		if (this.cardsResizeObserver) {
			this.cardsResizeObserver.disconnect();
			this.cardsResizeObserver = null;
		}
		if (this.cardsScrollContainer && this.cardsScrollHandler) {
			this.cardsScrollContainer.removeEventListener('scroll', this.cardsScrollHandler);
		}
		this.cardsScrollHandler = null;
		this.cardsScrollContainer = null;
		this.cardsScrollSpacer = null;
		this.cardsGridEl = null;
		this.cardsDisplayItems = [];
		this.cardsLastFirst = -1;
		this.cardsLastLast = -1;
		this.cardsLastScrollTop = 0;
		this.cardsRowHeight = 0;
		this.destroyCardsObserver();
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

		const card = parent.createDiv({ cls: 'wl-card' });
		card.dataset.titleId = title.id;
		// Width is distributed by the parent CSS grid (1fr columns) — do not set
		// an explicit width here. Setting fractional pixel widths per card caused
		// flex-wrap to overflow and shift the grid left by one slot per scroll.
		if (cardHeight !== undefined) card.style.height = `${cardHeight}px`;

		const placeholder = card.createDiv({ cls: 'wl-card-poster-placeholder' });
		placeholder.style.backgroundColor = typeColor;
		const letter = (title.title.trim().charAt(0) || '?').toUpperCase();
		placeholder.createSpan({ text: letter });

		const img = card.createEl('img', { cls: 'wl-card-poster' });
		img.alt = title.title;

		const display = getDisplayPoster(title);
		const isManual = !!(title.manualPosterUrl && title.manualPosterUrl.trim() !== '');
		if (display && display.startsWith('http')) {
			img.src = display;
			card.addClass('has-poster');
			img.onerror = () => {
				card.removeClass('has-poster');
				// Only mark the auto-fetched URL as 'none' — don't touch a user's manual choice.
				if (!isManual) this.dataManager.updatePosterUrl(title.id, 'none');
			};
		} else if (!isManual && title.posterUrl === '') {
			card.dataset.needsPoster = 'true';
		}

		if (statusDef) {
			const statusBadge = card.createSpan({
				cls: 'wl-card-status-badge',
				text: title.status,
			});
			statusBadge.style.backgroundColor = getThemedColor(
				title.status,
				statusDef.color,
				this.plugin.settings.colorTheme,
			);
		}

		const overlay = card.createDiv({ cls: 'wl-card-overlay' });
		overlay.createSpan({ cls: 'wl-card-title', text: title.title });
		const typeBadge = overlay.createSpan({
			cls: 'wl-card-type-badge',
			text: title.type,
		});
		typeBadge.style.backgroundColor = typeColor;

		// Progress bar
		const total = title.totalEpisodes;
		if (total && total > 0) {
			const isCompleted = title.status === 'Completed';
			const ratio = isCompleted
				? 1
				: Math.max(0, Math.min(1, title.watchedEpisodes.length / total));
			const bar = overlay.createDiv({ cls: 'wl-card-progress-bar' });
			const fill = bar.createDiv({ cls: 'wl-card-progress-fill' });
			fill.style.width = `${ratio * 100}%`;
		}

		const menuBtn = card.createEl('button', {
			cls: 'wl-card-menu-btn',
			text: '⋮',
		});
		menuBtn.setAttr('aria-label', 'More actions');
		menuBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openCardContextMenu(card, menuBtn, title);
		});

		card.addEventListener('click', () => {
			this.openDetailModalForTitle(title.id);
		});
	}

	private openCardContextMenu(
		card: HTMLElement,
		anchorBtn: HTMLElement,
		title: WatchLogTitle,
	): void {
		// Close any existing menu first
		this.container.querySelectorAll('.wl-card-context-menu').forEach((el) => el.remove());

		const menu = card.createDiv({ cls: 'wl-card-context-menu' });
		const editItem = menu.createDiv({ cls: 'wl-card-context-item', text: 'Edit title' });
		const refreshItem = menu.createDiv({
			cls: 'wl-card-context-item',
			text: 'Refresh poster',
		});
		const refreshRatingItem = menu.createDiv({
			cls: 'wl-card-context-item',
			text: 'Refresh rating',
		});

		// Edge-align if the button is close to the right edge of the container
		const cardRect = card.getBoundingClientRect();
		const containerRect = this.container.getBoundingClientRect();
		if (cardRect.right > containerRect.right - 180) {
			menu.classList.add('is-right-aligned');
		}

		// Capture the owning document once so add/remove can't desync across popout windows.
		const doc = card.ownerDocument;
		const closeMenu = (): void => {
			menu.remove();
			doc.removeEventListener('click', onDocClick, true);
		};
		const onDocClick = (e: MouseEvent): void => {
			if (!menu.contains(e.target as Node) && e.target !== anchorBtn) {
				closeMenu();
			}
		};
		// Defer registration so the click that opened the menu doesn't close it
		window.setTimeout(() => doc.addEventListener('click', onDocClick, true), 0);
		this.activeCleanups.push(() => doc.removeEventListener('click', onDocClick, true));

		editItem.addEventListener('click', (e) => {
			e.stopPropagation();
			closeMenu();
			this.openEditModalForTitle(title.id);
		});
		refreshItem.addEventListener('click', (e) => {
			e.stopPropagation();
			closeMenu();
			this.refreshPosterForCard(card, title.id);
		});
		refreshRatingItem.addEventListener('click', (e) => {
			e.stopPropagation();
			closeMenu();
			void refreshCommunityRating(this.plugin, title.id, null, true);
		});
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

		// Refetch via the queue
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

		const card = parent.createDiv({ cls: 'wl-card wl-card-group' });
		if (cardHeight !== undefined) card.style.height = `${cardHeight}px`;

		const letter = (group.name.trim().charAt(0) || '?').toUpperCase();
		renderGroupCollage(card, members, getDisplayPoster, { letter, color: typeColor });

		const overlay = card.createDiv({ cls: 'wl-card-overlay' });
		overlay.createSpan({ cls: 'wl-card-title', text: group.name });
		const subtitle = overlay.createSpan({ cls: 'wl-card-type-badge' });
		subtitle.style.backgroundColor = typeColor;
		subtitle.textContent = `${members.length} title${members.length !== 1 ? 's' : ''}`;

		const menuBtn = card.createEl('button', {
			cls: 'wl-card-menu-btn',
			text: '⋮',
		});
		menuBtn.setAttr('aria-label', 'Group actions');
		menuBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openGroupCardContextMenu(card, menuBtn, group);
		});

		card.addEventListener('click', () => {
			new GroupDetailModal(this.plugin.app, this.plugin, group, members, () => {
				this.render();
			}).open();
		});
	}

	private openGroupCardContextMenu(
		card: HTMLElement,
		anchorBtn: HTMLElement,
		group: WatchLogGroup,
	): void {
		this.container.querySelectorAll('.wl-card-context-menu').forEach((el) => el.remove());

		const menu = card.createDiv({ cls: 'wl-card-context-menu' });
		const renameItem = menu.createDiv({ cls: 'wl-card-context-item', text: 'Edit name' });
		const deleteItem = menu.createDiv({
			cls: 'wl-card-context-item',
			text: 'Delete group',
		});

		const cardRect = card.getBoundingClientRect();
		const containerRect = this.container.getBoundingClientRect();
		if (cardRect.right > containerRect.right - 180) {
			menu.classList.add('is-right-aligned');
		}

		// Capture the owning document once so add/remove can't desync across popout windows.
		const doc = card.ownerDocument;
		const closeMenu = (): void => {
			menu.remove();
			doc.removeEventListener('click', onDocClick, true);
		};
		const onDocClick = (e: MouseEvent): void => {
			if (!menu.contains(e.target as Node) && e.target !== anchorBtn) {
				closeMenu();
			}
		};
		window.setTimeout(() => doc.addEventListener('click', onDocClick, true), 0);
		this.activeCleanups.push(() => doc.removeEventListener('click', onDocClick, true));

		renameItem.addEventListener('click', (e) => {
			e.stopPropagation();
			closeMenu();
			this.openRenameGroupPrompt(group);
		});
		deleteItem.addEventListener('click', (e) => {
			e.stopPropagation();
			closeMenu();
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
		}).open();
	}

	// ── Header ────────────────────────────────────────────────────────────────────

	private renderHeader(): void {
		const header = this.container.createDiv({ cls: 'wl-list-header' });

		// Import progress bar (shown while a background import is running)
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

		// Search sits inline as the first item in the toolbar row (matches Reading)
		this.renderSearch(controls);

		// Saved filter preset button (shown only when a preset is stored)
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
				savedBtn.addClass('wl-btn-preset-active');
				this.saveFiltersToSettings();
				// Full render so the filter bar (Clear button, filter dot) is
				// rebuilt with the new active-filter state on whichever sub-tab
				// is current — rerenderTable/rerenderActiveSubTab only refresh
				// the content area, not the header.
				this.render();
			});
		} else {
			this.savedFilterBtnEl = null;
		}

		// Filters dropdown button
		this.renderFiltersDropdown(controls);

		// Sorting dropdown button
		this.renderSortingDropdown(controls);

		// Action bar — visible when in selection mode AND items are selected
		if (this.selectionMode && this.selectedItems.size > 0) {
			this.renderActionBar(controls);
		}

		// Select All / Deselect All button — visible in selection mode
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
				this.render();
			});
		}

		// Selection mode toggle button
		const selBtn = controls.createEl('button', {
			cls: `wl-btn wl-btn-sm${this.selectionMode ? ' is-active' : ''}`,
			text: 'Select',
		});
		selBtn.addEventListener('click', () => {
			this.selectionMode = !this.selectionMode;
			this.selectedItems.clear();
			this.render();
		});

		// Add buttons pinned to the far right of the toolbar row
		const rightGroup = controls.createDiv({ cls: 'wl-header-controls-right' });

		// + Add from URL
		const addUrlBtn = rightGroup.createEl('button', { cls: 'wl-btn wl-btn-sm wl-btn-success', text: '+add from URL' });
		addUrlBtn.addEventListener('click', () => {
			new AddFromUrlModal(this.plugin.app, this.plugin, this.dataManager, () => {
				this.render();
			}).open();
		});

		// + Add
		const addBtnWrap = rightGroup.createDiv({ cls: 'wl-add-btn-wrap' });
		const addBtn = addBtnWrap.createEl('button', { cls: 'wl-add-btn wl-btn-success', text: '+ add' });
		addBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openAddTitleModal();
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
			this.rerenderTable();
		});

		btn.addEventListener('click', (e) => {
    		e.stopPropagation();
    		const existing = activeDocument.querySelector('.wl-filters-panel');
    		if (existing) { existing.remove(); return; }

    		const panel = activeDocument.body.createDiv({ cls: 'wl-dropdown wl-filters-panel wl-filters-panel-popup' });
			const rect = btn.getBoundingClientRect();
			panel.style.top = `${rect.bottom + 4}px`;
			panel.style.left = `${rect.left}px`;

			const typeOpts = this.plugin.settings.types.map((t) => t.name);
			const statusOpts = this.plugin.settings.statuses.map((s) => s.name);
			const ratingOpts = ['1★', '2★', '3★', '4★', '5★'];
			const priorityOpts = this.plugin.settings.priorities.map((p) => p.name);
			const groupOpts = this.dataManager.getGroups().map((g) => g.name);

			// Draft — live filter state is not mutated until Apply is clicked
			const draft = {
				typeExclude:              new Set(this.filterTypeExclude),
				statusExclude:            new Set(this.filterStatusExclude),
				ratingExclude:            new Set(this.filterRatingExclude),
				priorityExclude:          new Set(this.filterPriorityExclude),
				groupExclude:             new Set(this.filterGroupExclude),
				filterRatingEmptyOnly:    this.filterRatingEmptyOnly,
				filterPriorityEmptyOnly:  this.filterPriorityEmptyOnly,
				filterRecentlyArrivedOnly: this.filterRecentlyArrivedOnly,
				filterGroupsOnly:         this.filterGroupsOnly,
			};

			const sections: Array<{ label: string; opts: string[]; excludeSet: Set<string> }> = [
				{ label: 'Type',     opts: typeOpts,     excludeSet: draft.typeExclude },
				{ label: 'Status',   opts: statusOpts,   excludeSet: draft.statusExclude },
				{ label: 'Rating',   opts: ratingOpts,   excludeSet: draft.ratingExclude },
				{ label: 'Priority', opts: priorityOpts, excludeSet: draft.priorityExclude },
			];
			if (groupOpts.length > 0) {
				sections.push({ label: 'Group', opts: groupOpts, excludeSet: draft.groupExclude });
			}

			const allCheckboxRefs: Array<{ cb: HTMLInputElement }> = [];

			// Global buttons
			const globalRow = panel.createDiv({ cls: 'wl-filter-global-btns' });
			let recentlyArrivedCbRef: HTMLInputElement | null = null;

			const selectAllBtn = globalRow.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Select all' });
			selectAllBtn.addEventListener('click', (ev) => {
				ev.stopPropagation();
				for (const { excludeSet } of sections) excludeSet.clear();
				for (const { cb } of allCheckboxRefs) cb.checked = true;
				draft.filterRecentlyArrivedOnly = false;
				if (recentlyArrivedCbRef) recentlyArrivedCbRef.checked = false;
			});
			const deselectAllBtn = globalRow.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Deselect all' });
			deselectAllBtn.addEventListener('click', (ev) => {
				ev.stopPropagation();
				for (const { opts, excludeSet } of sections) {
					for (const opt of opts) excludeSet.add(opt);
				}
				for (const { cb } of allCheckboxRefs) cb.checked = false;
				draft.filterRecentlyArrivedOnly = false;
				if (recentlyArrivedCbRef) recentlyArrivedCbRef.checked = false;
			});

			// Save / Delete preset button
			const existingPreset = this.dataManager.getSavedFilterPreset();
			const saveDeleteBtn = globalRow.createEl('button', {
				cls: 'wl-btn wl-btn-sm',
				text: existingPreset ? 'Delete' : 'Save',
			});
			saveDeleteBtn.addEventListener('click', (ev) => {
				void (async () => {
					ev.stopPropagation();
					if (saveDeleteBtn.textContent === 'Save') {
						await this.dataManager.setSavedFilterPreset({
							typeExclude:     Array.from(draft.typeExclude),
							statusExclude:   Array.from(draft.statusExclude),
							groupExclude:    Array.from(draft.groupExclude),
							ratingExclude:   Array.from(draft.ratingExclude),
							priorityExclude: Array.from(draft.priorityExclude),
							ratingEmptyOnly:       draft.filterRatingEmptyOnly,
							priorityEmptyOnly:     draft.filterPriorityEmptyOnly,
							recentlyArrivedOnly:   draft.filterRecentlyArrivedOnly,
							groupsOnly:            draft.filterGroupsOnly,
						});
					} else {
						await this.dataManager.setSavedFilterPreset(null);
						this.savedFilterActive = false;
					}
					panel.remove();
					this.render();
				})();
			});

			// Collapsed state per section (collapsed by default)
			const sectionCollapsed: Record<string, boolean> = {};
			for (const { label } of sections) {
				sectionCollapsed[label] = true;
			}

			for (const { label, opts, excludeSet } of sections) {
				const section = panel.createDiv({ cls: 'wl-filter-section' });

				// Collapsible header
				const sectionHeader = section.createDiv({ cls: 'wl-filter-section-header' });
				sectionHeader.createSpan({ cls: 'wl-filter-label', text: label });
				const chevron = sectionHeader.createSpan({ cls: 'wl-filter-chevron', text: '▼' });

				// Content container — hidden by default
				const content = section.createDiv({ cls: 'wl-filter-section-content wl-hidden' });

				sectionHeader.addEventListener('click', (ev) => {
					ev.stopPropagation();
					sectionCollapsed[label] = !sectionCollapsed[label];
					const collapsed = sectionCollapsed[label] ?? true;
					content.toggleClass('wl-hidden', collapsed);
					chevron.textContent = collapsed ? '▼' : '▲';
				});

				// "All" toggle — first item inside the section, styled like
				// "Recently arrived" and "Groups only".
				const allRow = content.createDiv({ cls: 'wl-filter-checkbox-row' });
				const allCb = allRow.createEl('input', { attr: { type: 'checkbox' } });
				allRow.createSpan({ cls: 'wl-filter-all-toggle', text: '◆ All' });

				// "Recently arrived" checkbox in Status section
				if (label === 'Status') {
					const raRow = content.createDiv({ cls: 'wl-filter-checkbox-row' });
					const raCb = raRow.createEl('input', { attr: { type: 'checkbox' } });
					raCb.checked = draft.filterRecentlyArrivedOnly;
					raRow.createSpan({ cls: 'wl-recently-arrived-filter', text: '✦ Recently arrived' });
					recentlyArrivedCbRef = raCb;

					raCb.addEventListener('change', () => {
						draft.filterRecentlyArrivedOnly = raCb.checked;
						if (raCb.checked) {
							// Clear status exclude set when Recently arrived is active
							excludeSet.clear();
							for (const optCb of statusOptionCbs) optCb.checked = true;
						}
					});
				}

				// "Empty" checkbox for Rating and Priority sections
				let emptyCb: HTMLInputElement | null = null;
				const optionCbs: HTMLInputElement[] = [];
				const statusOptionCbs: HTMLInputElement[] = [];

				if (label === 'Rating' || label === 'Priority') {
					const emptyRow = content.createDiv({ cls: 'wl-filter-checkbox-row' });
					emptyCb = emptyRow.createEl('input', { attr: { type: 'checkbox' } });
					emptyCb.checked = label === 'Rating' ? draft.filterRatingEmptyOnly : draft.filterPriorityEmptyOnly;
					emptyRow.createSpan({ text: 'Empty' });
					const localEmptyCb = emptyCb;

					emptyCb.addEventListener('change', () => {
						if (label === 'Rating') {
							draft.filterRatingEmptyOnly = localEmptyCb.checked;
						} else {
							draft.filterPriorityEmptyOnly = localEmptyCb.checked;
						}
						if (localEmptyCb.checked) {
							for (const optCb of optionCbs) { optCb.checked = true; }
							excludeSet.clear();
						}
					});
				}

				// "Groups only" toggle at top of Group section
				if (label === 'Group') {
					const goRow = content.createDiv({ cls: 'wl-filter-checkbox-row' });
					const goCb = goRow.createEl('input', { attr: { type: 'checkbox' } });
					goCb.checked = draft.filterGroupsOnly;
					goRow.createSpan({ cls: 'wl-recently-arrived-filter', text: '◇ Groups only' });
					goCb.addEventListener('change', () => {
						draft.filterGroupsOnly = goCb.checked;
					});
					content.createDiv({ cls: 'wl-filter-section-divider' });
				}

				for (const opt of opts) {
					const cbRow = content.createDiv({ cls: 'wl-filter-checkbox-row' });
					const cb = cbRow.createEl('input', { attr: { type: 'checkbox' } });
					cb.checked = !excludeSet.has(opt);
					cbRow.createSpan({ text: opt });
					optionCbs.push(cb);
					if (label === 'Status') statusOptionCbs.push(cb);
					allCheckboxRefs.push({ cb });
					const localEmptyCb = emptyCb;

					cb.addEventListener('change', () => {
						if (cb.checked) excludeSet.delete(opt);
						else excludeSet.add(opt);
						// Deactivate Recently arrived when a specific status is interacted with
						if (label === 'Status' && recentlyArrivedCbRef) {
							draft.filterRecentlyArrivedOnly = false;
							recentlyArrivedCbRef.checked = false;
						}
						// Deactivate Empty when a specific option is interacted with
						if ((label === 'Rating' || label === 'Priority') && localEmptyCb) {
							if (label === 'Rating') draft.filterRatingEmptyOnly = false;
							else draft.filterPriorityEmptyOnly = false;
							localEmptyCb.checked = false;
						}
					});
				}

				// Reflect current state in the "All" checkbox.
				const syncAllCb = (): void => {
					allCb.checked = optionCbs.length > 0 && optionCbs.every((c) => c.checked);
				};
				syncAllCb();

				const toggleAll = (): void => {
					const allChecked = optionCbs.length > 0 && optionCbs.every((c) => c.checked);
					if (allChecked) {
						for (const optCb of optionCbs) optCb.checked = false;
						for (const opt of opts) excludeSet.add(opt);
					} else {
						for (const optCb of optionCbs) optCb.checked = true;
						excludeSet.clear();
					}
					syncAllCb();
				};
				allCb.addEventListener('click', (ev) => {
					ev.stopPropagation();
					// We drive the visual + data state ourselves; cancel the native toggle.
					toggleAll();
				});
				allRow.addEventListener('click', (ev) => {
					if (ev.target === allCb) return;
					ev.stopPropagation();
					toggleAll();
				});
			}

			// Apply — commits draft to live state, re-renders, and closes the panel
			const applyBtn = panel.createEl('button', { cls: 'wl-btn wl-btn-sm wl-filter-apply-btn', text: 'Apply' });
			applyBtn.addEventListener('click', (ev) => {
				ev.stopPropagation();
				this.filterTypeExclude     = draft.typeExclude;
				this.filterStatusExclude   = draft.statusExclude;
				this.filterRatingExclude   = draft.ratingExclude;
				this.filterPriorityExclude = draft.priorityExclude;
				this.filterGroupExclude    = draft.groupExclude;
				this.filterRatingEmptyOnly      = draft.filterRatingEmptyOnly;
				this.filterPriorityEmptyOnly    = draft.filterPriorityEmptyOnly;
				this.filterRecentlyArrivedOnly  = draft.filterRecentlyArrivedOnly;
				this.filterGroupsOnly           = draft.filterGroupsOnly;
				this.saveFiltersToSettings();
				this.deactivateSavedFilter();
				const active = this.hasActiveFilter();
				if (active) { dotEl.show(); clearBtn.show(); } else { dotEl.hide(); clearBtn.hide(); }
				this.rerenderTable();
				panel.remove();
				activeDocument.removeEventListener('mousedown', closer, false);
			});

			const closer = (ev: MouseEvent) => {
    			const target = ev.target as Node;
    			if (panel.contains(target) || wrap.contains(target)) return;
    			panel.remove();
    			activeDocument.removeEventListener('mousedown', closer, false);
			};
			window.setTimeout(() => activeDocument.addEventListener('mousedown', closer, false), 0);
		});
	}

	private renderSortingDropdown(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: 'wl-add-btn-wrap' });
		const btn = wrap.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Sorting ▼' });

		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			const existing = wrap.querySelector('.wl-dropdown');
			if (existing) { existing.remove(); return; }

			const panel = wrap.createDiv({ cls: 'wl-dropdown wl-sorting-panel' });

			if (window.innerWidth <= 600) {
				const rect = btn.getBoundingClientRect();
				panel.addClass('wl-sorting-panel-mobile');
				panel.style.top = `${rect.bottom + 4}px`;
			}

			const sortOptions = [
				'Title', 'Date added', 'Progress', 'Rating', 'Priority',
				'Started', 'Status', 'Date watched', 'Time left', 'Time watched',
			];

			const addSortRow = (labelText: string, currentKey: string, currentDir: 'asc' | 'desc', isPrimary: boolean): void => {
				const row = panel.createDiv({ cls: 'wl-filter-row' });
				row.createSpan({ cls: 'wl-filter-label', text: labelText });
				const sel = row.createEl('select', { cls: 'wl-select' });

				if (!isPrimary) {
					const noneOpt = sel.createEl('option', { text: 'None', value: 'none' });
					noneOpt.selected = currentKey === 'none';
				}
				for (const opt of sortOptions) {
					const el = sel.createEl('option', { text: opt, value: opt });
					if (this.sortLabelToKey(opt) === currentKey) el.selected = true;
				}

				const dirBtn = row.createEl('button', {
					cls: 'wl-btn wl-btn-sm wl-sort-dir-btn',
					text: currentDir === 'asc' ? '↑' : '↓',
				});
				dirBtn.title = currentDir === 'asc'
					? 'Ascending — click to switch to descending'
					: 'Descending — click to switch to ascending';

				sel.addEventListener('change', () => {
					const newKey = sel.value === 'none' ? 'none' : this.sortLabelToKey(sel.value);
					if (isPrimary) {
						this.filterSort    = newKey;
						this.filterSortDir = ListTab.SORT_DEFAULT_DIR[newKey] ?? 'asc';
					} else {
						this.filterSecondSort    = newKey;
						this.filterSecondSortDir = ListTab.SORT_DEFAULT_DIR[newKey] ?? 'asc';
					}
					panel.remove();
					activeDocument.removeEventListener('click', closer, true);
					this.saveFiltersToSettings();
					this.render();
				});

				dirBtn.addEventListener('click', (ev) => {
					ev.stopPropagation();
					if (isPrimary) {
						this.filterSortDir = this.filterSortDir === 'asc' ? 'desc' : 'asc';
					} else {
						this.filterSecondSortDir = this.filterSecondSortDir === 'asc' ? 'desc' : 'asc';
					}
					panel.remove();
					activeDocument.removeEventListener('click', closer, true);
					this.saveFiltersToSettings();
					this.render();
				});
			};

			addSortRow('Sort by', this.filterSort, this.filterSortDir, true);
			addSortRow('Then by', this.filterSecondSort, this.filterSecondSortDir, false);

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

		// Delete button — same style as group delete button
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

		// Change Status dropdown
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

		// Move to Group dropdown
		const allGroups = this.dataManager.getGroups();
		const hasGroupSelected = Array.from(this.selectedItems).some((id) =>
			this.dataManager.getGroups().some((g) => g.id === id),
		);
		const moveSelect = bar.createEl('select', { cls: 'wl-select wl-select-sm' });
		if (hasGroupSelected) {
			moveSelect.disabled = true;
			moveSelect.title = 'A group is selected — cannot move groups into other groups';
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
					// Inline group-name input (prompt() is not available in Obsidian/Electron)
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
					cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); this.render(); });
					nameInput.addEventListener('keydown', (e) => {
						e.stopPropagation();
						if (e.key === 'Enter') void doCreate();
						if (e.key === 'Escape') this.render();
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

	// ── Modal helpers ─────────────────────────────────────────────────────────────

	private openAddTitleModal(): void {
		new AddTitleModal(this.plugin.app, this.plugin, this.dataManager, () => {
			this.render();
		}).open();
	}

	// ── Search & Controls ─────────────────────────────────────────────────────────

	private renderSearch(parent: HTMLElement): void {
		// Inline compact search inside the toolbar row, reusing Reading's classes
		const searchWrap = parent.createDiv({ cls: 'wl-reading-search-wrap' });
		const input = searchWrap.createEl('input', {
			cls: 'wl-reading-search-input',
			attr: { type: 'text', placeholder: 'Search titles...' },
		});
		input.value = this.searchQuery;
		let searchDebounce = 0;
		input.addEventListener('input', () => {
			this.searchQuery = input.value;
			window.clearTimeout(searchDebounce);
			searchDebounce = window.setTimeout(() => {
				this.rerenderActiveSubTab();
			}, 250);
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

	// ── Table rendering ───────────────────────────────────────────────────────────

	rerenderTable(): void {
		// Route callers to the renderer matching the active sub-tab so callers
		// (filter apply, saved filter, sort change, row interactions, etc.) work
		// whether the user is on List or Cards. Otherwise a List table would be
		// appended underneath the Cards grid.
		if (this.currentSubTab !== 'list') {
			this.rerenderActiveSubTab();
			return;
		}
		const savedScroll = this._lastScrollTop;
		const existing = this.container.querySelector('.wl-table-section');
		if (existing) existing.remove();
		this.renderTable(savedScroll);
	}

	private rerenderActiveSubTab(): void {
		if (this.currentSubTab === 'cards') {
			this.destroyVirtualScroll();
			// Strip both cards-view DOM and any stray list table so the two views
			// can never coexist in the container.
			this.container
				.querySelectorAll('.wl-cards-scroll-container, .wl-cards-empty, .wl-table-section, .wl-results-count')
				.forEach((el) => el.remove());
			this.renderCardsView();
		} else {
			const savedScroll = this._lastScrollTop;
			const existing = this.container.querySelector('.wl-table-section');
			if (existing) existing.remove();
			this.renderTable(savedScroll);
		}
	}

	/** Renders the "N titles, M groups" count line. Shared by List and Cards views. */
	private renderResultsCount(parent: HTMLElement, items: DisplayItem[]): void {
		const titleCount = items.reduce((n, item) => n + (item.kind === 'title' ? 1 : 0), 0);
		const groupCount = items.reduce((n, item) => n + (item.kind === 'group' ? 1 : 0), 0);
		const countEl = parent.createDiv({ cls: 'wl-results-count' });
		const parts: string[] = [];
		if (titleCount > 0) parts.push(`${titleCount} title${titleCount !== 1 ? 's' : ''}`);
		if (groupCount > 0) parts.push(`${groupCount} group${groupCount !== 1 ? 's' : ''}`);
		countEl.textContent = parts.length > 0 ? parts.join(', ') : '0 titles';
	}

	private renderTable(restoreScroll?: number): void {
		// Tear down any previous scroll listener before rebuilding the DOM
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
	 *
	 * Phase 1 — all items are rendered into a hidden measurement container so we
	 * read their *actual* heights in one synchronous batch (single forced layout).
	 * The container is removed before the virtual one is created.
	 *
	 * Phase 2 — a single fixed-height `wl-virt-container` div is inserted.  Its
	 * height is set once from the cached offset table and never changes during
	 * scroll, so the scrollable area is perfectly stable (CLS = 0 while scrolling).
	 *
	 * Phase 3 — on each scroll event (rAF-throttled, passive) we binary-search the
	 * offset table to find which items are visible and absolutely-position only
	 * those inside the container.  No layout reads happen inside the handler.
	 *
	 * On expand/collapse `rerenderTable()` is called, which destroys and recreates
	 * the entire virtualisation — remeasuring affected rows automatically.
	 */
	private mountVirtualRows(table: HTMLElement, items: DisplayItem[], restoreScroll?: number): void {
		const BUFFER_ROWS = 5;
		const INTER_ITEM_GAP = 8;  // px — mirrors the CSS margin-top between top-level rows
		const FALLBACK_H = 44;     // px — used when offsetHeight returns 0 and for buffer math

		// ── Phase 1: uniform row heights ──────────────────────────────────────────
		const ROW_H = 68; // px — covers a standard unexpanded title row with badge + progress bar
		const heights: number[] = items.map(() => ROW_H);

		// ── Phase 1b: measure the expanded title row (accordion included) ─────────
		// Only one title can be expanded at a time, so this is a single DOM measurement.
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

		// ── Phase 1c: measure expanded group rows ────────────────────────────────
		// Multiple groups can be expanded simultaneously, so check every group item.
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

		// ── Phase 2: cumulative offset table (includes inter-item gap) ────────────
		const offsets: number[] = [];
		let totalHeight = 0;
		for (let i = 0; i < items.length; i++) {
			offsets.push(totalHeight);
			totalHeight += heights[i] ?? FALLBACK_H;
			if (i < items.length - 1) totalHeight += INTER_ITEM_GAP;
		}

		// ── Phase 3: fixed-height container ──────────────────────────────────────
		// Height is set once and never mutated during scroll — this is what keeps
		// the total scrollable area stable and CLS at zero.
		const virt = table.createDiv({ cls: 'wl-virt-container' });
		virt.style.height = `${totalHeight}px`;

		// Distance from the scroll container's content-top to virt's top edge.
		// Computed once here (outside the scroll handler) using getBoundingClientRect.
		const scrollEl = this.container;
		const containerTopOffset =
			virt.getBoundingClientRect().top -
			scrollEl.getBoundingClientRect().top +
			scrollEl.scrollTop;

		// Restore scroll AFTER containerTopOffset is computed (which needs scrollTop=0
		// on a fresh DOM) but BEFORE renderWindow() so it sees the correct position.
		if (restoreScroll !== undefined) {
			scrollEl.scrollTop = restoreScroll;
		}

		// ── Phase 4: rAF-throttled scroll handler ─────────────────────────────────
		let rafId = 0;
		let lastStart = -1;
		let lastEnd = -1;

		const renderWindow = (): void => {
			// Read scroll state first — no DOM writes until after all reads
			const scrollTop = scrollEl.scrollTop;
			const viewH = scrollEl.clientHeight || 600;

			const bufferPx = BUFFER_ROWS * FALLBACK_H;
			const relTop   = scrollTop - containerTopOffset;
			const windowTop = relTop - bufferPx;
			const windowBot = relTop + viewH + bufferPx;

			// Binary search: first item whose bottom edge is past windowTop
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

			// Linear scan from startIdx: last item whose top edge is before windowBot
			let endIdx = startIdx;
			for (let i = startIdx; i < items.length; i++) {
				if ((offsets[i] ?? 0) >= windowBot) break;
				endIdx = i;
			}

			// Skip DOM work entirely if the visible range has not changed
			if (startIdx === lastStart && endIdx === lastEnd) return;
			lastStart = startIdx;
			lastEnd   = endIdx;

			// Write phase — clear old rows, insert visible slice
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

	// ── Display items (merged groups + top-level titles) ──────────────────────────

	private getDisplayItems(): DisplayItem[] {
		const groups = this.dataManager.getGroups();
		const groupedIds = this.dataManager.getGroupedTitleIds();
		const allTitles = this.dataManager.getTitles();
		const titleMap = new Map(allTitles.map((t) => [t.id, t]));
		const q = this.searchQuery.trim().toLowerCase();

		// Top-level titles (not in any group), filtered. Hidden entirely when
		// "Groups only" is active.
		const topLevel = this.filterGroupsOnly
			? []
			: this.getFilteredSortedTitles().filter((t) => !groupedIds.has(t.id));

		// Groups: skip those excluded by group filter; show if any member passes filters
		const displayGroups: Array<{ kind: 'group'; data: WatchLogGroup; members: WatchLogTitle[] }> = [];
		for (const group of groups) {
			if (this.filterGroupExclude.size > 0 && this.filterGroupExclude.has(group.name)) continue;

			const members = group.titleIds
				.map((id) => titleMap.get(id))
				.filter((t): t is WatchLogTitle => t !== undefined);

			// Search: show group if name matches OR any member title matches
			if (q) {
				const nameMatch = group.name.toLowerCase().includes(q);
				const memberMatch = members.some((m) => m.title.toLowerCase().includes(q));
				if (!nameMatch && !memberMatch) continue;
			}

			// Show group if any member passes type/status/rating/priority filters
			const anyFilterActive = this.filterTypeExclude.size > 0 ||
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
			// Pinned item always first
			const aPinned = (a.kind === 'title' && a.data.pinned) || (a.kind === 'group' && a.data.id === this.pinnedGroupId);
			const bPinned = (b.kind === 'title' && b.data.pinned) || (b.kind === 'group' && b.data.id === this.pinnedGroupId);
			if (aPinned && !bPinned) return -1;
			if (!aPinned && bPinned) return 1;
			return this.compareDisplayItems(a, b);
		});
	}

	// Status sort order (ascending): Watching → Plan to watch → Completed → To be released → Dropped
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

	// ── Individual title row ──────────────────────────────────────────────────────

	private renderRow(parent: HTMLElement, title: WatchLogTitle, indented = false): void {
		const isExpanded = this.expandedId === title.id;
		const isSelected = this.selectedItems.has(title.id);
		const classes = ['wl-row', isExpanded ? 'is-expanded' : '', indented ? 'wl-row-indented' : '', isSelected ? 'wl-row-selected' : '']
			.filter(Boolean)
			.join(' ');
		const row = parent.createDiv({ cls: classes });
		row.dataset['titleId'] = title.id;

		// Selection checkbox column
		if (this.selectionMode) {
			const cbCol = row.createDiv({ cls: 'wl-col-select' });
			const cb = cbCol.createEl('input', { attr: { type: 'checkbox' } });
			cb.checked = isSelected;
			cb.addEventListener('click', (e) => e.stopPropagation());
			cb.addEventListener('change', () => {
				if (cb.checked) { this.selectedItems.add(title.id); }
				else { this.selectedItems.delete(title.id); }
				this.render();
			});
		}

		// Title + type badge + progress bar
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
		if (ListTab.isRecentlyArrived(title)) {
			badgeRow.createSpan({ cls: 'wl-recently-arrived', text: '· Recently arrived' });
		}
		const barWrap = colTitle.createDiv({ cls: 'wl-progress-wrap' });
		const bar = barWrap.createDiv({ cls: 'wl-progress-bar' });
		bar.style.width = `${this.dataManager.getProgress(title)}%`;

		// Priority
		const colPriority = row.createDiv({ cls: 'wl-col-priority' });
		if (title.priority) {
			const priorityDef = this.getTagDef(title.priority, this.plugin.settings.priorities);
			const pBadge = colPriority.createSpan({ cls: 'wl-priority-badge', text: title.priority });
			if (priorityDef) pBadge.style.color = priorityDef.color;
		}

		// Started date
		const colStarted = row.createDiv({ cls: 'wl-col-started' });
		colStarted.textContent = title.dateStarted ? formatDateDisplay(title.dateStarted) : '—';

		// Rating
		const colRating = row.createDiv({ cls: 'wl-col-rating' });
		if (title.rating > 0) {
			colRating.createSpan({ cls: 'wl-row-rating', text: `★ ${title.rating}/5` });
		} else {
			colRating.createSpan({ cls: 'wl-row-rating wl-row-rating-empty', text: '—' });
		}

		// Status badge (respects coloredTypeBadges toggle)
		const colStatus = row.createDiv({ cls: 'wl-col-status' });
		const statusDef = this.getTagDef(title.status, this.plugin.settings.statuses);
		const statusBadge = colStatus.createSpan({
			cls: colored ? 'wl-badge' : 'wl-badge-plain',
			text: title.status,
		});
		if (colored && statusDef) statusBadge.style.backgroundColor = getThemedColor(title.status, statusDef.color, this.plugin.settings.colorTheme);

		// Pin icon
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
				// Unpin all others first
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
				if (this.selectedItems.has(title.id)) { this.selectedItems.delete(title.id); }
				else { this.selectedItems.add(title.id); }
				this.render();
				return;
			}
			this.expandedId = isExpanded ? null : title.id;
			if (!isExpanded) {
				this.collapsedSeasons = this.dataManager.getCollapsedSeasonsForTitle(title.id);
			}
			this.rerenderTable();
		});

		if (isExpanded && !this.selectionMode) {
			this.renderAccordion(parent, title);
		}
	}

	// ── Group header row ──────────────────────────────────────────────────────────

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

		// Add data-* attributes so filters can evaluate the group row the same way as title rows
		row.dataset['type'] = members[0]?.type ?? '';
		row.dataset['status'] = this.getGroupStatus(members);
		row.dataset['priority'] = this.getGroupHighestPriority(members) ?? '';
		row.dataset['rating'] = `${Math.round(this.getGroupRating(members))}★`;
		row.dataset['group'] = group.name;

		// Selection checkbox column
		if (this.selectionMode) {
			const cbCol = row.createDiv({ cls: 'wl-col-select' });
			const cb = cbCol.createEl('input', { attr: { type: 'checkbox' } });
			cb.checked = isSelected;
			cb.addEventListener('click', (e) => e.stopPropagation());
			cb.addEventListener('change', () => {
				if (cb.checked) { this.selectedItems.add(group.id); }
				else { this.selectedItems.delete(group.id); }
				this.render();
			});
		}

		// Col: Title + type badge + group stats + progress bar
		const colTitle = row.createDiv({ cls: 'wl-col-title' });

		// Group name row: name (or rename input) + action buttons
		if (this.renamingGroupId === group.id) {
			// Rename mode
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
			// Focus the input
			window.setTimeout(() => nameInput.focus(), 0);
		} else {
			// Normal mode: name + pencil + delete buttons
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

		// Group stats (always visible)
		const statsEl = colTitle.createDiv({ cls: 'wl-group-stats' });
		const timeWatched = members.reduce((s, t) => s + this.dataManager.calcTimeWatched(t), 0);
		const timeLeft = members.reduce((s, t) => s + this.dataManager.calcTimeRemaining(t), 0);
		statsEl.createSpan({ text: `${members.length} title${members.length !== 1 ? 's' : ''}` });
		statsEl.createSpan({ text: `  ·  ${formatTime(timeWatched)} watched` });
		statsEl.createSpan({ text: `  ·  ${formatTime(timeLeft)} left` });

		const barWrap = colTitle.createDiv({ cls: 'wl-progress-wrap' });
		barWrap.createDiv({ cls: 'wl-progress-bar' }).style.width =
			`${this.getGroupProgress(members)}%`;

		// Col: Priority (highest among members)
		const colGrpPriority = row.createDiv({ cls: 'wl-col-priority' });
		const highestPriority = this.getGroupHighestPriority(members);
		if (highestPriority) {
			const pDef = this.getTagDef(highestPriority, this.plugin.settings.priorities);
			const pBadge = colGrpPriority.createSpan({ cls: 'wl-priority-badge', text: highestPriority });
			if (pDef) pBadge.style.color = pDef.color;
		}

		// Col: Started (earliest among members)
		const colStarted = row.createDiv({ cls: 'wl-col-started' });
		const groupStarted = this.getGroupStartedDate(members);
		colStarted.textContent = groupStarted ? formatDateDisplay(groupStarted) : '—';

		// Col: Rating (average)
		const colRating = row.createDiv({ cls: 'wl-col-rating' });
		const avgRating = this.getGroupRating(members);
		if (avgRating > 0) {
			colRating.createSpan({
				cls: 'wl-row-rating',
				text: `★ ${avgRating.toFixed(1)}/5`,
			});
		} else {
			colRating.createSpan({ cls: 'wl-row-rating wl-row-rating-empty', text: '—' });
		}

		// Col: Status (computed per priority rule, respects coloredTypeBadges)
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

		// Col: Pin
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
			// Unpin any pinned title
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

		// Toggle expand/collapse (disabled while renaming or in selection mode)
		row.addEventListener('click', () => {
			if (this.renamingGroupId === group.id) return;
			if (this.selectionMode) {
				if (this.selectedItems.has(group.id)) { this.selectedItems.delete(group.id); }
				else { this.selectedItems.add(group.id); }
				this.render();
				return;
			}
			if (isExpanded) {
				this.expandedGroups.delete(group.id);
			} else {
				this.expandedGroups.add(group.id);
			}
			this.rerenderTable();
		});

		// Render member titles indented when expanded
		if (isExpanded) {
			for (const member of members) {
				this.renderRow(parent, member, true);
			}
		}
	}

	// ── Group helper calculations ─────────────────────────────────────────────────

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

	// ── Accordion ─────────────────────────────────────────────────────────────────

	private renderAccordion(parent: HTMLElement, title: WatchLogTitle): void {
		const accordion = parent.createDiv({ cls: 'wl-accordion' });
		accordion.addEventListener('click', (e) => e.stopPropagation());

		// Header
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

		// Stats row: 3 new blocks + existing progress block, all in one right-aligned row
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

		// Body
		const accBody = accordion.createDiv({ cls: 'wl-accordion-body' });
		if (title.type === 'Movie') {
			this.renderMovieBody(accBody, title);
		} else {
			this.renderEpisodesBody(accBody, title);
		}

		// Footer
		this.renderAccordionFooter(accordion, title);
	}

	private renderMovieBody(parent: HTMLElement, title: WatchLogTitle): void {
		const row = parent.createDiv({ cls: 'wl-movie-row' });
		const cb = row.createEl('input', {
			cls: 'wl-movie-checkbox',
			attr: { type: 'checkbox' },
		});
		cb.checked = title.watchedEpisodes.includes(1);
		row.createSpan({ cls: 'wl-movie-label', text: 'Watched' });

		cb.addEventListener('change', (e) => {
			e.stopPropagation();
			void this.dataManager.markEpisodeWatched(title.id, 1, cb.checked).then(() => this.rerenderTable());
		});
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

			// Render grid immediately only if this season is expanded
			if (!isCollapsed) {
				this.renderEpisodeGrid(seasonWrap, title, season);
			}

			seasonHeader.addEventListener('click', (e) => {
				e.stopPropagation();
				if (isCollapsed) {
					// Expanding: create grid in-place
					isCollapsed = false;
					this.collapsedSeasons.delete(seasonIdx);
					chevron.classList.add('is-open');
					this.renderEpisodeGrid(seasonWrap, title, season);
				} else {
					// Collapsing: remove grid from DOM entirely
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

		// Fill/clear toggle button (first element in the row). Its visual state is
		// always recomputed from the live `title.watchedEpisodes`.
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
			// Bulk operation: cheap to do via the existing notify-path which triggers a full re-render.
			void this.dataManager.markSeasonWatched(title.id, seasonEps, !allWatched).then(() => this.rerenderTable());
		});

		const perSeason = this.plugin.settings.episodeNumbering === 'per-season';

		for (let i = 0; i < count; i++) {
			const epNum = offset + i + 1;
			const relNum = i + 1;
			const displayNum = perSeason ? relNum : epNum;

			const box = grid.createDiv({ cls: 'wl-episode-box' });

			// Read fresh state every time — closures over isWatched/isSkipped would
			// go stale after the first targeted update.
			const refreshBox = (): void => {
				const isWatched = title.watchedEpisodes.includes(epNum);
				const isSkipped = season ? (season.skippedEpisodes ?? []).includes(relNum) : false;
				box.classList.toggle('is-watched', isWatched);
				box.classList.toggle('is-skipped', isSkipped);
				box.textContent = isSkipped && !isWatched ? '—' : (isWatched ? '✓' : String(displayNum));
				box.title = `Episode ${epNum}${isSkipped ? ' (skipped)' : ''}`;
			};
			refreshBox();

			// Clicking toggles watched/unwatched only. The season's skippedEpisodes
			// definition is read-only at runtime — it is set exclusively from the
			// Edit modal's season text (e.g. "Season 1: 48 (33-37)").
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
	 * Targeted DOM update for the accordion stats row (left / watched / episodes
	 * / progress %) and the enclosing season header's skip-count suffix. Avoids
	 * a full table re-render on every episode click.
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

		// Season header's "(N to skip)" suffix only changes on skip-toggle, but
		// it's cheap to refresh either way.
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

	private renderAccordionFooter(parent: HTMLElement, title: WatchLogTitle): void {
		const footer = parent.createDiv({ cls: 'wl-accordion-footer' });

		// Star rating
		const starsRow = footer.createDiv({ cls: 'wl-stars-row' });
		starsRow.createSpan({ cls: 'wl-stars-label', text: 'Rating' });
		const starsWrap = starsRow.createDiv({ cls: 'wl-stars' });
		for (let i = 1; i <= 5; i++) {
			const star = starsWrap.createSpan({
				cls: `wl-star${title.rating >= i ? ' is-active' : ''}`,
				text: '★',
			});
			star.addEventListener('click', (e) => {
				e.stopPropagation();
				void (async () => {
					const t = this.dataManager.getTitle(title.id);
					if (!t) return;
					t.rating = t.rating === i ? 0 : i;
					await this.dataManager.updateTitle(t);
					this.rerenderTable();
				})();
			});
		}

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

		// Notes
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

		// Date watched
		const dateRow = footer.createDiv({ cls: 'wl-footer-row' });
		dateRow.createSpan({ cls: 'wl-footer-label', text: 'Date watched' });
		const todayBtn = dateRow.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-footer-today-btn',
			text: 'Today',
			attr: { title: 'Fill with today’s date' },
		});
		const dateInput = dateRow.createEl('input', {
			cls: 'wl-footer-date',
			attr: { type: 'text', placeholder: 'Dd/mm/yyyy', maxlength: '10' },
		});
		dateInput.value = formatDateDisplay(title.dateFinished);
		const refreshTodayBtnState = (): void => {
			todayBtn.toggleClass('is-dimmed', !!dateInput.value.trim());
		};
		refreshTodayBtnState();
		dateInput.addEventListener('click', (e) => e.stopPropagation());
		dateInput.addEventListener('change', () => {
			void (async () => {
				const t = this.dataManager.getTitle(title.id);
				if (!t) return;
				const parsed = parseDateInput(dateInput.value);
				if (dateInput.value.trim() && !parsed) {
					dateInput.addClass('wl-input-error');
					return;
				}
				dateInput.removeClass('wl-input-error');
				t.dateFinished = parsed;
				await this.dataManager.updateTitle(t);
				this.rerenderTable();
			})();
		});
		todayBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (dateInput.value.trim()) return; // no-op when already filled
			const now = new Date();
			const dd = String(now.getDate()).padStart(2, '0');
			const mm = String(now.getMonth() + 1).padStart(2, '0');
			const yyyy = now.getFullYear();
			dateInput.value = `${dd}/${mm}/${yyyy}`;
			refreshTodayBtnState();
			dateInput.dispatchEvent(new Event('change'));
		});

		// Status
		const statusRow = footer.createDiv({ cls: 'wl-footer-row' });
		statusRow.createSpan({ cls: 'wl-footer-label', text: 'Status' });
		const statusSelect = statusRow.createEl('select', { cls: 'wl-select wl-select-sm' });
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

		// Delete (left) + Edit dropdown (right)
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

	// ── Filter + sort ─────────────────────────────────────────────────────────────

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

	private getFilteredSortedTitles(): WatchLogTitle[] {
		let titles = this.dataManager.getTitles();

		if (this.searchQuery.trim()) {
			const q = this.searchQuery.toLowerCase();
			titles = titles.filter((t) => t.title.toLowerCase().includes(q));
		}

		titles = titles.filter((t) => this.titlePassesFilters(t));

		const primaryKey = ListTab.sortBaseAndDirToKey(this.filterSort, this.filterSortDir);
		const secondKey = this.filterSecondSort === 'none'
			? 'none'
			: ListTab.sortBaseAndDirToKey(this.filterSecondSort, this.filterSecondSortDir);
		titles = [...titles].sort((a, b) => {
			const primary = this.compareTitlesByKey(primaryKey, a, b);
			if (primary !== 0 || secondKey === 'none') return primary;
			return this.compareTitlesByKey(secondKey, a, b);
		});

		return titles;
	}

	// ── Utilities ─────────────────────────────────────────────────────────────────

	private getTagDef(name: string, tags: TagDefinition[]): TagDefinition | undefined {
		return tags.find((t) => t.name === name);
	}

}

