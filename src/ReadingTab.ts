import { Notice, setIcon } from 'obsidian';
import { apiErrorMessage } from './ApiService';
import type WatchLogPlugin from './main';
import type { ReadingDataManager, ReadingKind } from './ReadingDataManager';
import { Book, Manga, ReadingStatus, ReadingCustomColumn, ReadingSavedFilterPreset, READING_STATUSES, SELECTABLE_READING_STATUSES, DEFAULT_READING_STATUS_COLORS, normalizeRowsLayout, READING_ROWS_SHELVES, bookUnitProgress, formatCount, sortByFavorited } from './types';
import { searchItems, yearOf, type SearchFieldSpec } from './SearchQuery';
import { renderSearchHelpButton } from './SearchHelpModal';
import { renderShelf, renderShelfTitle, type ShelfSelect } from './RowsView';
import { RowsCustomizeModal } from './RowsCustomizeModal';
import { AddReadingModal } from './AddReadingModal';
import { ReadingDetailModal } from './ReadingDetailModal';
import { ReadingManageColumnsModal } from './ReadingManageColumnsModal';
import { ConfirmModal } from './ConfirmModal';
import { renderToolbarWithMobileToggle } from './MobileToolbar';
import { VirtualGrid, computeGridMetrics, setRowsCardWidth, type GridMetrics } from './VirtualGrid';
import { VirtualScroller } from './VirtualScroller';
import { LazyCardObserver } from './LazyCardObserver';
import { openCardMenu } from './PosterCard';
import { openNoteFile } from './NoteLinkButton';

type SubTab = 'books' | 'manga';

// built-in sort keys, plus dynamic `custom:<columnId>` keys for custom fields
type SortKey = string;
type SortDir = 'asc' | 'desc';

// synthetic option keys for the "Has value" / "No value" choices on text/number custom-field
// filter sections
const HAS_VALUE = '__has__';
const NO_VALUE = '__none__';

function customFieldHasValue(item: Book | Manga, columnId: string): boolean {
	const v = item.customFields?.[columnId];
	return v !== undefined && v !== null && v !== '';
}

interface ReadingFilters {
	// excluded statuses (a ticked checkbox = included, like the Watchlist popover). Empty = every
	// status shown. Converted to the preset's `statusInclude` shape only on save/load.
	statusExclude: ReadingStatus[];
	ratingMode: 'all' | 'has' | 'none';
	// per custom-field exclusions keyed by column id: option strings for 'select' columns, the
	// synthetic HAS_VALUE / NO_VALUE keys for 'text'/'number'
	customExclude: Record<string, string[]>;
}

interface ReadingSort {
	key: SortKey;
	dir: SortDir;
	secondKey: SortKey;
	secondDir: SortDir;
}

// staged filter edits — ReadingFilters with Sets, for in-place mutation while the popover is open
interface FilterDraft {
	statusExclude: Set<ReadingStatus>;
	ratingMode: 'all' | 'has' | 'none';
	customExclude: Map<string, Set<string>>;
}

// lets the global Select all / Deselect all buttons drive a section's checkboxes
interface SectionController {
	selectAll: () => void;
	deselectAll: () => void;
}

function defaultFilters(): ReadingFilters {
	return { statusExclude: [], ratingMode: 'all', customExclude: {} };
}

function defaultSort(): ReadingSort {
	return { key: 'dateAdded', dir: 'desc', secondKey: 'none', secondDir: 'asc' };
}

function filtersActive(f: ReadingFilters): number {
	let n = 0;
	if (f.statusExclude.length > 0) n++;
	if (f.ratingMode !== 'all') n++;
	for (const k of Object.keys(f.customExclude)) {
		if ((f.customExclude[k]?.length ?? 0) > 0) n++;
	}
	return n;
}

/**
 * Badge colour for a reading status. The names are fixed, but the colours are user-editable
 * (Settings → Customize → Reading) and stored per name in `ReadingSettings.statusColors`; pass
 * that record in to honour the choice. Omitting it, or a missing key, falls back to the default.
 */
export function readingStatusColor(
	status: ReadingStatus,
	colors?: Record<string, string>,
): string {
	return colors?.[status] ?? DEFAULT_READING_STATUS_COLORS[status] ?? '#888780';
}

const COVER_PALETTE = [
	'#3a4a6b', '#4a3a6b', '#6b3a4a', '#6b5a3a',
	'#3a6b5a', '#5a6b3a', '#3a5a6b', '#6b3a5a',
];

export function coverFallbackColor(id: string): string {
	let hash = 0;
	for (let i = 0; i < id.length; i++) {
		hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
	}
	return COVER_PALETTE[hash % COVER_PALETTE.length] ?? '#3a4a6b';
}

function bookProgress(b: Book): number {
	const { read, total } = bookUnitProgress(b);
	if (total > 0) return Math.min(100, (read / total) * 100);
	return 0;
}

function mangaProgress(m: Manga): number {
	if (m.totalChapters > 0) return Math.min(100, (m.chaptersRead / m.totalChapters) * 100);
	return 0;
}

export class ReadingTab {
	// session-persistent state: survives tab switches and view rebuilds within the same plugin load,
	// resets only on unload
	private static sessionSubTab: SubTab | null = null;
	private static sessionFilters: Record<SubTab, ReadingFilters> = {
		books: defaultFilters(),
		manga: defaultFilters(),
	};
	private static sessionSort: Record<SubTab, ReadingSort> = {
		books: defaultSort(),
		manga: defaultSort(),
	};

	private container: HTMLElement;
	private plugin: WatchLogPlugin;
	private readingData: ReadingDataManager;
	private searchQuery = '';
	private dataChangeListener: () => void;
	private contentEl: HTMLElement | null = null;
	private filterBtn: HTMLButtonElement | null = null;
	private sortBtn: HTMLButtonElement | null = null;
	private resetBtn: HTMLButtonElement | null = null;
	// single saved filter (the Watchlist flow). The external "Saved filter" button applies it; the
	// in-popover button toggles Save/Delete.
	private savedFilterActive = false;
	private savedFilterBtnEl: HTMLButtonElement | null = null;
	private openPopover: HTMLElement | null = null;
	private popoverCleanup: (() => void) | null = null;
	private activeCleanups: (() => void)[] = [];

	private selectionMode = false;
	private selectedIds: Set<string> = new Set();

	// false = search shown, true = action buttons; desktop shows both
	private toolbarExpanded = false;

	// virtual scroll — VirtualGrid windows the grid, VirtualScroller drives it (the shared machinery
	// the Watchlist Cards view uses)
	private vsScroller: VirtualScroller | null = null;
	private vsPersistentScrollTop = 0;

	// lazy cover re-fetch (the shared Cards lazy-observer pattern)
	private coverObserver: LazyCardObserver | null = null;
	// covers that already failed this session — don't retry on every scroll
	private coverFetchFailed: Set<string> = new Set();

	private get activeSubTab(): SubTab {
		if (ReadingTab.sessionSubTab !== null) return ReadingTab.sessionSubTab;
		return this.readingData.getSettings().defaultSubTab ?? 'books';
	}
	private set activeSubTab(value: SubTab) {
		ReadingTab.sessionSubTab = value;
	}

	private get filters(): ReadingFilters {
		return ReadingTab.sessionFilters[this.activeSubTab];
	}
	private get sort(): ReadingSort {
		return ReadingTab.sessionSort[this.activeSubTab];
	}

	// custom columns for the active sub-tab (Books → bookColumns, Manga → mangaColumns)
	private activeColumns(): ReadingCustomColumn[] {
		return this.activeSubTab === 'books'
			? this.readingData.getBookColumns()
			: this.readingData.getMangaColumns();
	}

	constructor(container: HTMLElement, plugin: WatchLogPlugin, readingData: ReadingDataManager) {
		this.container = container;
		this.plugin = plugin;
		this.readingData = readingData;
		this.dataChangeListener = () => this.renderContent();
		this.readingData.onChange(this.dataChangeListener);
	}

	destroy(): void {
		this.readingData.offChange(this.dataChangeListener);
		this.closePopover();
		this.destroyVirtualScroll();
		for (const fn of this.activeCleanups) fn();
		this.activeCleanups = [];
	}

	render(): void {
		this.container.empty();
		this.container.addClass('wl-reading-tab');
		this.renderSubTabs();
		this.renderToolbar();
		this.contentEl = this.container.createDiv({ cls: 'wl-reading-content' });
		this.renderContent();
	}

	private renderSubTabs(): void {
		const bar = this.container.createDiv({ cls: 'wl-subtabs' });
		const track = bar.createDiv({ cls: 'wl-subtabs-track' });

		const booksBtn = track.createEl('button', {
			cls: `wl-subtab${this.activeSubTab === 'books' ? ' is-active' : ''}`,
			text: 'Books',
		});

		const mangaBtn = track.createEl('button', {
			cls: `wl-subtab${this.activeSubTab === 'manga' ? ' is-active' : ''}`,
			text: 'Manga',
		});

		booksBtn.addEventListener('click', () => {
			if (this.activeSubTab === 'books') return;
			this.activeSubTab = 'books';
			this.searchQuery = '';
			this.render();
		});

		mangaBtn.addEventListener('click', () => {
			if (this.activeSubTab === 'manga') return;
			this.activeSubTab = 'manga';
			this.searchQuery = '';
			this.render();
		});
	}

	private renderToolbar(): void {
		const toolbar = this.container.createDiv({ cls: 'wl-reading-toolbar' });

		// on mobile the search input and the action buttons crossfade inside one slot behind a chevron
		// (shared with the Watchlist toolbar); desktop renders both inline
		renderToolbarWithMobileToggle({
			controls: toolbar,
			renderSearch: (parent) => this.renderReadingSearch(parent),
			renderActions: (parent) => this.renderReadingActions(parent),
			expanded: this.toolbarExpanded,
			onToggleChange: (expanded) => { this.toolbarExpanded = expanded; },
		});
	}

	private renderReadingSearch(parent: HTMLElement): void {
		const searchWrap = parent.createDiv({ cls: 'wl-reading-search-wrap' });
		const placeholder = this.activeSubTab === 'books' ? 'Search books...' : 'Search manga...';
		const searchInput = searchWrap.createEl('input', {
			cls: 'wl-reading-search-input',
			attr: { type: 'text', placeholder },
		});
		searchInput.value = this.searchQuery;
		renderSearchHelpButton(searchWrap, this.plugin.app, this.activeSubTab === 'books' ? 'Books' : 'Manga', () => this.searchFields());
		// clear button — only while there is text
		const clearBtn = searchWrap.createEl('button', {
			cls: 'wl-search-clear',
			attr: { type: 'button', 'aria-label': 'Clear search' },
		});
		setIcon(clearBtn, 'x');
		const syncClear = () => clearBtn.toggleClass('is-visible', searchInput.value.length > 0);
		syncClear();
		let debounce = 0;
		searchInput.addEventListener('input', () => {
			this.searchQuery = searchInput.value;
			syncClear();
			window.clearTimeout(debounce);
			debounce = window.setTimeout(() => this.renderContent(), 200);
		});
		clearBtn.addEventListener('click', () => {
			window.clearTimeout(debounce);
			searchInput.value = '';
			this.searchQuery = '';
			syncClear();
			searchInput.focus();
			this.renderContent();
		});
	}

	private renderReadingActions(parent: HTMLElement): void {
		// saved filter button — shown only when one exists; applies it to the active sub-tab
		const savedFilter = this.getSavedFilter();
		if (savedFilter) {
			this.savedFilterActive = this.filtersMatchSaved(savedFilter);
			const savedBtn = parent.createEl('button', {
				cls: `wl-btn wl-btn-sm${this.savedFilterActive ? ' wl-btn-preset-active' : ''}`,
				text: 'Saved filter',
			});
			this.savedFilterBtnEl = savedBtn;
			savedBtn.addEventListener('click', () => {
				ReadingTab.sessionFilters[this.activeSubTab] = {
					statusExclude: READING_STATUSES.filter((s) => !savedFilter.statusInclude.includes(s)),
					ratingMode: savedFilter.ratingMode,
					customExclude: {},
				};
				this.savedFilterActive = true;
				savedBtn.addClass('wl-btn-preset-active');
				this.refreshFilterButtonBadge();
				this.render();
			});
		} else {
			this.savedFilterBtnEl = null;
		}

		this.filterBtn = parent.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-reading-filter-btn',
			text: 'Filter',
		});
		this.refreshFilterButtonBadge();
		this.filterBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.toggleFilterPopover();
		});

		this.resetBtn = parent.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-reading-reset-btn',
			text: 'Reset',
		});
		this.resetBtn.addEventListener('click', () => {
			ReadingTab.sessionFilters[this.activeSubTab] = defaultFilters();
			this.deactivateSavedFilter();
			this.closePopover();
			this.filterBtn?.removeClass('is-popover-open');
			this.refreshFilterButtonBadge();
			this.renderContent();
		});
		this.refreshFilterButtonBadge();

		this.sortBtn = parent.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-reading-sort-btn',
			text: 'Sort',
		});
		this.sortBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.toggleSortPopover();
		});

		if (this.selectionMode && this.selectedIds.size > 0) {
			this.renderSelectionActionBar(parent);
		}

		if (this.selectionMode) {
			const hasAny = this.selectedIds.size > 0;
			const selAllBtn = parent.createEl('button', {
				cls: 'wl-btn wl-btn-sm',
				text: hasAny ? 'None' : 'All',
			});
			selAllBtn.title = hasAny ? 'Deselect all' : 'Select all visible';
			selAllBtn.addEventListener('click', () => {
				if (this.selectedIds.size > 0) {
					this.selectedIds.clear();
				} else {
					const items: Array<Book | Manga> = this.activeSubTab === 'books'
						? this.readingData.getBooks()
						: this.readingData.getMangaList();
					for (const item of this.applySearch(this.applyFilters(items))) {
						this.selectedIds.add(item.id);
					}
				}
				this.render();
			});
		}

		// in selection mode the button is the way out — red Cancel
		const selBtn = parent.createEl('button', {
			cls: `wl-btn wl-btn-sm${this.selectionMode ? ' wl-btn-cancel' : ''}`,
			text: this.selectionMode ? 'Cancel' : 'Select',
		});
		selBtn.addEventListener('click', () => {
			this.selectionMode = !this.selectionMode;
			this.selectedIds.clear();
			this.render();
		});

		const right = parent.createDiv({ cls: 'wl-reading-toolbar-right' });
		const manageBtn = right.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-reading-manage-btn',
			attr: { 'aria-label': 'Manage columns', title: 'Manage columns' },
			text: '⚙',
		});
		manageBtn.addEventListener('click', () => this.openManageColumns());

		const addBtn = right.createEl('button', {
			cls: 'wl-reading-add-btn wl-btn-success',
			text: this.activeSubTab === 'books' ? '+ Add book' : '+ Add manga',
		});
		addBtn.addEventListener('click', () => this.openAddModal());
	}

	private renderSelectionActionBar(parent: HTMLElement): void {
		const bar = parent.createDiv({ cls: 'wl-reading-action-bar' });

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
				`Delete ${count} selected item${count !== 1 ? 's' : ''}? This cannot be undone.`,
				() => {
					void (async () => {
						const ids = Array.from(this.selectedIds);
						if (this.activeSubTab === 'books') {
							await this.readingData.removeBooksBatch(ids);
						} else {
							await this.readingData.removeMangaBatch(ids);
						}
						this.selectedIds.clear();
						this.selectionMode = false;
						this.render();
					})();
				},
			).open();
		});

		const statusSelect = bar.createEl('select', { cls: 'wl-select wl-select-sm' });
		statusSelect.createEl('option', { text: 'Status…', value: '' });
		for (const s of SELECTABLE_READING_STATUSES) {
			statusSelect.createEl('option', { text: s, value: s });
		}
		statusSelect.addEventListener('change', () => {
			void (async () => {
				const newStatus = statusSelect.value as ReadingStatus;
				if (!newStatus) return;
				const isBooks = this.activeSubTab === 'books';
				for (const id of this.selectedIds) {
					if (isBooks) {
						const book = this.readingData.getBook(id);
						if (book) {
							this.readingData.updateBookSilent({ ...book, status: newStatus });
						}
					} else {
						const manga = this.readingData.getManga(id);
						if (manga) {
							this.readingData.updateMangaSilent({ ...manga, status: newStatus });
						}
					}
				}
				await this.readingData.saveAndNotify();
				statusSelect.value = '';
				this.selectedIds.clear();
				this.selectionMode = false;
				this.render();
			})();
		});
	}

	private refreshFilterButtonBadge(): void {
		if (!this.filterBtn) return;
		const count = filtersActive(this.filters);
		this.filterBtn.empty();
		this.filterBtn.createSpan({ text: 'Filter' });
		if (count > 0) {
			this.filterBtn.createSpan({ cls: 'wl-reading-filter-badge', text: String(count) });
		}
		if (this.resetBtn) {
			this.resetBtn.style.display = count > 0 ? '' : 'none';
		}
	}

	private closePopover(): void {
		if (this.openPopover) {
			this.openPopover.remove();
			this.openPopover = null;
		}
		if (this.popoverCleanup) {
			this.popoverCleanup();
			this.popoverCleanup = null;
		}
	}

	private openPopoverAt(anchor: HTMLElement, cls: string, build: (el: HTMLElement) => void): void {
		this.closePopover();
		// wl-popover-anchored pins via top/left (right: auto) instead of the right-anchored default
		const pop = this.container.createDiv({ cls: `${cls} wl-popover-anchored` });
		const rect = anchor.getBoundingClientRect();
		const parentRect = this.container.getBoundingClientRect();
		pop.setCssProps({
			top: `${rect.bottom - parentRect.top + 4}px`,
			left: `${rect.left - parentRect.left}px`,
		});
		build(pop);
		this.openPopover = pop;

		const onDocClick = (ev: MouseEvent): void => {
			if (pop.contains(ev.target as Node)) return;
			this.closePopover();
		};
		const onKey = (ev: KeyboardEvent): void => {
			if (ev.key === 'Escape') this.closePopover();
		};
		window.setTimeout(() => activeDocument.addEventListener('click', onDocClick), 0);
		activeDocument.addEventListener('keydown', onKey);
		this.popoverCleanup = () => {
			activeDocument.removeEventListener('click', onDocClick);
			activeDocument.removeEventListener('keydown', onKey);
		};
	}

	private toggleFilterPopover(): void {
		if (this.openPopover && this.filterBtn?.hasClass('is-popover-open')) {
			this.closePopover();
			this.filterBtn.removeClass('is-popover-open');
			return;
		}
		this.sortBtn?.removeClass('is-popover-open');
		this.filterBtn?.addClass('is-popover-open');
		this.openPopoverAt(this.filterBtn!, 'wl-dropdown wl-filters-panel', (el) => this.buildFilterPopover(el));
	}

	private toggleSortPopover(): void {
		if (this.openPopover && this.sortBtn?.hasClass('is-popover-open')) {
			this.closePopover();
			this.sortBtn.removeClass('is-popover-open');
			return;
		}
		this.filterBtn?.removeClass('is-popover-open');
		this.sortBtn?.addClass('is-popover-open');
		this.openPopoverAt(this.sortBtn!, 'wl-dropdown wl-sorting-panel', (el) => this.buildSortPopover(el));
	}

	// Saved filter (single, Watchlist-style)
	private getSavedFilter(): ReadingSavedFilterPreset | null {
		return this.readingData.getSettings().savedFilters?.[this.activeSubTab] ?? null;
	}

	private filtersMatchSaved(saved: ReadingSavedFilterPreset): boolean {
		const f = this.filters;
		// a saved filter only captures status + rating, so any active custom-field filter means the live
		// state no longer matches it
		if (Object.values(f.customExclude).some((arr) => arr.length > 0)) return false;
		const savedExclude = new Set(READING_STATUSES.filter((s) => !saved.statusInclude.includes(s)));
		const cur = new Set(f.statusExclude);
		if (cur.size !== savedExclude.size) return false;
		for (const s of cur) if (!savedExclude.has(s)) return false;
		return f.ratingMode === saved.ratingMode;
	}

	private deactivateSavedFilter(): void {
		if (this.savedFilterActive) {
			this.savedFilterActive = false;
			this.savedFilterBtnEl?.removeClass('wl-btn-preset-active');
		}
	}

	private buildFilterPopover(el: HTMLElement): void {
		// draft — Reading's live filters only change on Apply (the parity with the Watchlist popover).
		// Status and custom fields use exclude semantics for the UI; Status converts to the preset's
		// `statusInclude` shape on save.
		const draft: FilterDraft = {
			statusExclude: new Set<ReadingStatus>(this.filters.statusExclude),
			ratingMode: this.filters.ratingMode,
			customExclude: new Map<string, Set<string>>(),
		};
		for (const col of this.activeColumns()) {
			draft.customExclude.set(col.id, new Set(this.filters.customExclude[col.id] ?? []));
		}
		// Collapsed state persists across body re-renders. Keyed by section id
		// (`Status`, `Rating`, `custom:<columnId>`); default collapsed.
		const collapsed: Record<string, boolean> = {};
		this.renderFilterPopoverBody(el, draft, collapsed);
	}

	// Builds a collapsible section shell (Watchlist-style header + chevron) and
	// invokes `build` to fill its content. Returns nothing; the section is appended
	// to `el`.
	private addFilterSection(
		el: HTMLElement,
		collapsed: Record<string, boolean>,
		id: string,
		label: string,
		build: (content: HTMLElement) => void,
	): void {
		const section = el.createDiv({ cls: 'wl-filter-section' });
		const header = section.createDiv({ cls: 'wl-filter-section-header' });
		header.createSpan({ cls: 'wl-filter-label', text: label });
		const chevron = header.createSpan({
			cls: 'wl-filter-chevron',
			text: (collapsed[id] ?? true) ? '▼' : '▲',
		});
		const content = section.createDiv({ cls: 'wl-filter-section-content' });
		content.toggleClass('wl-hidden', collapsed[id] ?? true);
		header.addEventListener('click', (ev) => {
			ev.stopPropagation();
			const next = !(collapsed[id] ?? true);
			collapsed[id] = next;
			content.toggleClass('wl-hidden', next);
			chevron.textContent = next ? '▼' : '▲';
		});
		build(content);
	}

	// Multi-select section body (checkbox list + "◆ All" toggle), shared by Status
	// and `select` custom fields. Returns a controller so the global Select all /
	// Deselect all buttons can drive it.
	private addMultiSelectBody(
		content: HTMLElement,
		options: string[],
		excludeSet: Set<string>,
	): SectionController {
		const cbs: HTMLInputElement[] = [];
		const allRow = content.createDiv({ cls: 'wl-filter-checkbox-row' });
		const allCb = allRow.createEl('input', { attr: { type: 'checkbox' } });
		allRow.createSpan({ cls: 'wl-filter-all-toggle', text: '◆ All' });

		const syncAll = (): void => {
			allCb.checked = cbs.length > 0 && cbs.every((c) => c.checked);
		};

		for (const opt of options) {
			const row = content.createDiv({ cls: 'wl-filter-checkbox-row' });
			const cb = row.createEl('input', { attr: { type: 'checkbox' } });
			cb.checked = !excludeSet.has(opt);
			row.createSpan({ text: opt });
			cbs.push(cb);
			cb.addEventListener('change', () => {
				if (cb.checked) excludeSet.delete(opt);
				else excludeSet.add(opt);
				syncAll();
			});
		}
		syncAll();

		const toggleAll = (): void => {
			const allChecked = cbs.length > 0 && cbs.every((c) => c.checked);
			if (allChecked) {
				for (const cb of cbs) cb.checked = false;
				for (const o of options) excludeSet.add(o);
			} else {
				for (const cb of cbs) cb.checked = true;
				excludeSet.clear();
			}
			syncAll();
		};
		allCb.addEventListener('click', (ev) => { ev.stopPropagation(); toggleAll(); });
		allRow.addEventListener('click', (ev) => {
			if (ev.target === allCb) return;
			ev.stopPropagation();
			toggleAll();
		});

		return {
			selectAll: () => { for (const cb of cbs) cb.checked = true; excludeSet.clear(); syncAll(); },
			deselectAll: () => { for (const cb of cbs) cb.checked = false; for (const o of options) excludeSet.add(o); syncAll(); },
		};
	}

	// "Has value" / "No value" section body for text/number custom fields.
	private addHasValueBody(content: HTMLElement, excludeSet: Set<string>): SectionController {
		const entries: Array<{ key: string; cb: HTMLInputElement }> = [];
		for (const [key, label] of [[HAS_VALUE, 'Has value'], [NO_VALUE, 'No value']] as const) {
			const row = content.createDiv({ cls: 'wl-filter-checkbox-row' });
			const cb = row.createEl('input', { attr: { type: 'checkbox' } });
			cb.checked = !excludeSet.has(key);
			row.createSpan({ text: label });
			cb.addEventListener('change', () => {
				if (cb.checked) excludeSet.delete(key);
				else excludeSet.add(key);
			});
			entries.push({ key, cb });
		}
		return {
			selectAll: () => { for (const e of entries) { e.cb.checked = true; excludeSet.delete(e.key); } },
			deselectAll: () => { for (const e of entries) { e.cb.checked = false; excludeSet.add(e.key); } },
		};
	}

	private renderFilterPopoverBody(
		el: HTMLElement,
		draft: FilterDraft,
		collapsed: Record<string, boolean>,
	): void {
		el.empty();

		// Multi-select-style sections register here so the global Select all /
		// Deselect all buttons can drive every one of them at once (Watchlist UX).
		const controllers: SectionController[] = [];

		// ── Global buttons row (Select all / Deselect all / Save-or-Delete) ──
		const globalRow = el.createDiv({ cls: 'wl-filter-global-btns' });

		const selectAllBtn = globalRow.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Select all' });
		selectAllBtn.addEventListener('click', (ev) => {
			ev.stopPropagation();
			for (const c of controllers) c.selectAll();
		});
		const deselectAllBtn = globalRow.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Deselect all' });
		deselectAllBtn.addEventListener('click', (ev) => {
			ev.stopPropagation();
			for (const c of controllers) c.deselectAll();
		});

		// Save / Delete — a single saved filter, exactly like the Watchlist popover.
		// Save stores the current draft (without applying it); Delete clears it. Both
		// re-render so the external "Saved filter" button appears/disappears.
		const saveDeleteBtn = globalRow.createEl('button', {
			cls: 'wl-btn wl-btn-sm',
			text: this.getSavedFilter() ? 'Delete' : 'Save',
		});
		saveDeleteBtn.addEventListener('click', (ev) => {
			ev.stopPropagation();
			void (async () => {
				// Preserve the other sub-tab's saved filter when updating this one.
				const current = { ...(this.readingData.getSettings().savedFilters ?? {}) };
				if (saveDeleteBtn.textContent === 'Save') {
					current[this.activeSubTab] = {
						name: 'Saved filter',
						// Stored in include shape: the statuses that remain visible.
						statusInclude: READING_STATUSES.filter((s) => !draft.statusExclude.has(s)),
						ratingMode: draft.ratingMode,
					};
					await this.readingData.updateSettings({ savedFilters: current });
				} else {
					delete current[this.activeSubTab];
					await this.readingData.updateSettings({ savedFilters: current });
					this.savedFilterActive = false;
				}
				this.closePopover();
				this.filterBtn?.removeClass('is-popover-open');
				this.render();
			})();
		});

		// ── Status section (multi-select with "All") ──
		this.addFilterSection(el, collapsed, 'Status', 'Status', (content) => {
			controllers.push(this.addMultiSelectBody(content, READING_STATUSES, draft.statusExclude));
		});

		// ── Rating section (single-select mode; not part of Select/Deselect all) ──
		this.addFilterSection(el, collapsed, 'Rating', 'Rating', (content) => {
			const ratingOpts: Array<{ key: 'all' | 'has' | 'none'; label: string }> = [
				{ key: 'all', label: 'All' },
				{ key: 'has', label: 'Has rating' },
				{ key: 'none', label: 'No rating' },
			];
			const groupName = `wl-reading-rating-${Date.now()}`;
			for (const opt of ratingOpts) {
				const row = content.createDiv({ cls: 'wl-filter-checkbox-row' });
				const radio = row.createEl('input', { attr: { type: 'radio', name: groupName } });
				radio.checked = draft.ratingMode === opt.key;
				row.createSpan({ text: opt.label });
				radio.addEventListener('change', () => {
					if (radio.checked) draft.ratingMode = opt.key;
				});
			}
		});

		// ── Custom-field sections (per active sub-tab) ──
		for (const col of this.activeColumns()) {
			const excludeSet = draft.customExclude.get(col.id) ?? new Set<string>();
			draft.customExclude.set(col.id, excludeSet);
			this.addFilterSection(el, collapsed, `custom:${col.id}`, col.name, (content) => {
				if (col.type === 'select') {
					controllers.push(this.addMultiSelectBody(content, col.options, excludeSet));
				} else {
					controllers.push(this.addHasValueBody(content, excludeSet));
				}
			});
		}

		// ── Apply — commits the staged draft to live state and re-renders ──
		const applyWrap = el.createDiv({ cls: 'wl-filter-apply-wrap' });
		const applyBtn = applyWrap.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-filter-apply-btn',
			text: 'Apply',
		});
		applyBtn.addEventListener('click', (ev) => {
			ev.stopPropagation();
			const customExclude: Record<string, string[]> = {};
			for (const [id, set] of draft.customExclude) {
				if (set.size > 0) customExclude[id] = Array.from(set);
			}
			ReadingTab.sessionFilters[this.activeSubTab] = {
				statusExclude: Array.from(draft.statusExclude),
				ratingMode: draft.ratingMode,
				customExclude,
			};
			this.deactivateSavedFilter();
			this.refreshFilterButtonBadge();
			this.closePopover();
			this.filterBtn?.removeClass('is-popover-open');
			this.renderContent();
		});
	}

	private buildSortPopover(el: HTMLElement): void {
		const keys: Array<{ key: SortKey; label: string }> = [
			{ key: 'dateAdded', label: 'Date added' },
			{ key: 'title', label: 'Title' },
			{ key: 'author', label: 'Author' },
			{ key: 'rating', label: 'Rating' },
			{ key: 'progress', label: 'Progress' },
			{ key: 'status', label: 'Status' },
			{ key: 'dateStarted', label: 'Date started' },
			{ key: 'dateFinished', label: 'Date finished' },
		];
		// Append custom fields for the active sub-tab as `custom:<columnId>` keys.
		for (const col of this.activeColumns()) {
			keys.push({ key: `custom:${col.id}`, label: col.name });
		}

		const addRow = (
			labelText: string,
			currentKey: SortKey,
			currentDir: SortDir,
			isPrimary: boolean,
		): void => {
			const row = el.createDiv({ cls: 'wl-filter-row' });
			row.createSpan({ cls: 'wl-filter-label', text: labelText });
			const sel = row.createEl('select', { cls: 'wl-select' });

			if (!isPrimary) {
				const noneOpt = sel.createEl('option', { text: 'None', value: 'none' });
				if (currentKey === 'none') noneOpt.selected = true;
			}
			for (const k of keys) {
				const opt = sel.createEl('option', { text: k.label, value: k.key });
				if (k.key === currentKey) opt.selected = true;
			}

			const dirBtn = row.createEl('button', {
				cls: 'wl-btn wl-btn-sm wl-sort-dir-btn',
				text: currentDir === 'asc' ? '↑' : '↓',
			});
			dirBtn.title = currentDir === 'asc'
				? 'Ascending; click to switch to descending'
				: 'Descending; click to switch to ascending';

			sel.addEventListener('change', () => {
				if (isPrimary) {
					this.sort.key = sel.value;
				} else {
					this.sort.secondKey = (sel.value === 'none' ? 'none' : sel.value);
				}
				this.closePopover();
				this.sortBtn?.removeClass('is-popover-open');
				this.renderContent();
			});

			dirBtn.addEventListener('click', (ev) => {
				ev.stopPropagation();
				if (isPrimary) {
					this.sort.dir = this.sort.dir === 'asc' ? 'desc' : 'asc';
				} else {
					this.sort.secondDir = this.sort.secondDir === 'asc' ? 'desc' : 'asc';
				}
				this.closePopover();
				this.sortBtn?.removeClass('is-popover-open');
				this.renderContent();
			});
		};

		addRow('Sort by', this.sort.key, this.sort.dir, true);
		addRow('Then by', this.sort.secondKey, this.sort.secondDir, false);
	}

	private applyFilters(items: Array<Book | Manga>): Array<Book | Manga> {
		const f = this.filters;
		const columns = this.activeColumns();
		return items.filter((it) => {
			if (f.statusExclude.includes(it.status)) return false;
			if (f.ratingMode === 'has' && !(it.rating > 0)) return false;
			if (f.ratingMode === 'none' && it.rating > 0) return false;
			for (const col of columns) {
				const ex = f.customExclude[col.id];
				if (!ex || ex.length === 0) continue;
				if (col.type === 'select') {
					// Like Status: only items whose value is an excluded option are
					// hidden; items with no value for this field are unaffected.
					const v = it.customFields?.[col.id];
					const sv = v === undefined || v === null ? '' : String(v);
					if (sv !== '' && ex.includes(sv)) return false;
				} else {
					const has = customFieldHasValue(it, col.id);
					if (has && ex.includes(HAS_VALUE)) return false;
					if (!has && ex.includes(NO_VALUE)) return false;
				}
			}
			return true;
		});
	}

	/**
	 * Fields the Reading search covers — also drives the "?" help panel. Book/Manga carry no series
	 * or publisher of their own, so every custom column becomes a searchable field under its own
	 * name: a "Series" column gives you `series:dune`.
	 */
	searchFields(): SearchFieldSpec<Book | Manga>[] {
		const isBooks = this.activeSubTab === 'books';
		const fields: SearchFieldSpec<Book | Manga>[] = [
			{ name: 'title', label: 'Title', weight: 0.6, text: (i) => [i.title] },
			{ name: 'author', label: 'Author', weight: 0.25, text: (i) => [i.author] },
			{ name: 'year', label: 'Year', weight: 0.05, text: (i) => { const y = yearOf(i.releaseDate); return y ? [String(y)] : []; }, number: (i) => yearOf(i.releaseDate) },
			{ name: 'rating', label: 'Rating', number: (i) => i.rating },
			{
				name: isBooks ? 'pages' : 'chapters',
				label: isBooks ? 'Pages' : 'Chapters',
				number: (i) => (isBooks ? (i as Book).totalPages : (i as Manga).totalChapters) || null,
			},
		];
		// custom columns, keyed by a search-safe form of the column name
		for (const col of this.activeColumns()) {
			const key = col.name.trim().toLowerCase().replace(/\s+/g, '-');
			if (!key || fields.some((f) => f.name === key)) continue;
			fields.push({
				name: key,
				label: col.name,
				weight: 0.1,
				text: (i) => {
					const v = i.customFields?.[col.id];
					return v === undefined || v === null || v === '' ? [] : [String(v)];
				},
				...(col.type === 'number'
					? { number: (i: Book | Manga) => { const v = Number(i.customFields?.[col.id]); return Number.isFinite(v) ? v : null; } }
					: {}),
			});
		}
		return fields;
	}

	private applySearch(items: Array<Book | Manga>): Array<Book | Manga> {
		const matched = searchItems(items, { id: (i) => i.id, fields: this.searchFields() }, this.searchQuery);
		if (matched === null) return items;
		return items.filter((i) => matched.has(i.id));
	}

	private compareBySortKey(
		a: Book | Manga,
		b: Book | Manga,
		key: SortKey,
		factor: number,
		isBooks: boolean,
	): number {
		if (key.startsWith('custom:')) {
			return this.compareCustom(a, b, key.slice('custom:'.length), factor);
		}
		switch (key) {
			case 'title':
				return a.title.localeCompare(b.title) * factor;
			case 'author':
				return (a.author || '').localeCompare(b.author || '') * factor;
			case 'rating':
				return (a.rating - b.rating) * factor;
			case 'dateAdded':
				return a.dateAdded.localeCompare(b.dateAdded) * factor;
			case 'dateStarted':
				return (a.dateStarted ?? '').localeCompare(b.dateStarted ?? '') * factor;
			case 'dateFinished':
				return (a.dateFinished ?? '').localeCompare(b.dateFinished ?? '') * factor;
			case 'status':
				return a.status.localeCompare(b.status) * factor;
			case 'progress': {
				const pa = isBooks ? bookProgress(a as Book) : mangaProgress(a as Manga);
				const pb = isBooks ? bookProgress(b as Book) : mangaProgress(b as Manga);
				return (pa - pb) * factor;
			}
			default:
				return 0;
		}
	}

	// Compares two items by a custom field value. Number columns compare
	// numerically, text/select alphabetically. Items with no value always sort
	// last, regardless of direction (the `factor` is not applied to them).
	private compareCustom(a: Book | Manga, b: Book | Manga, columnId: string, factor: number): number {
		const col = this.activeColumns().find((c) => c.id === columnId);
		const av = a.customFields?.[columnId];
		const bv = b.customFields?.[columnId];
		const aEmpty = av === undefined || av === null || av === '';
		const bEmpty = bv === undefined || bv === null || bv === '';
		if (aEmpty && bEmpty) return 0;
		if (aEmpty) return 1;
		if (bEmpty) return -1;
		if (col?.type === 'number') {
			return (Number(av) - Number(bv)) * factor;
		}
		return String(av).localeCompare(String(bv)) * factor;
	}

	private applySort(items: Array<Book | Manga>): Array<Book | Manga> {
		const { key, dir, secondKey, secondDir } = this.sort;
		const isBooks = this.activeSubTab === 'books';
		const f1 = dir === 'asc' ? 1 : -1;
		const f2 = secondDir === 'asc' ? 1 : -1;
		return [...items].sort((a, b) => {
			const primary = this.compareBySortKey(a, b, key, f1, isBooks);
			if (primary !== 0 || secondKey === 'none') return primary;
			return this.compareBySortKey(a, b, secondKey, f2, isBooks);
		});
	}

	// Shelf cards mirror the grids' *computed* card width — the stretched
	// 1fr-track width, not just the setting's minimum (see setRowsCardWidth).

	private renderContent(): void {
		if (!this.contentEl) return;
		this.destroyVirtualScroll();
		for (const fn of this.activeCleanups) fn();
		this.activeCleanups = [];
		this.contentEl.empty();

		const isBooks = this.activeSubTab === 'books';
		const items: Array<Book | Manga> = isBooks
			? this.readingData.getBooks()
			: this.readingData.getMangaList();

		if (items.length === 0) {
			this.renderEmptyState();
			return;
		}

		// An active search or filter keeps the sections layout (the Watchlist
		// Rows rule): every section keeps its own logic and shows only the
		// matching items; a section with no matches disappears entirely.
		const visible = this.applySearch(this.applyFilters(items));
		const filtering = this.searchQuery.trim() !== '' || filtersActive(this.filters) > 0;

		this.renderResultsCount(visible.length);

		if (filtering && visible.length === 0) {
			const q = this.searchQuery.trim();
			this.contentEl.createDiv({
				cls: 'wl-reading-empty-search',
				text: q ? `No matches for "${q}".` : 'No items match the current filters.',
			});
			return;
		}

		const visibleIds = new Set(visible.map((i) => i.id));
		const itemVisible = (it: Book | Manga): boolean => !filtering || visibleIds.has(it.id);

		const scroll = this.contentEl.createDiv({ cls: 'wl-reading-scroll-container' });
		// One metrics source for the grids AND the shelf card width; the eager
		// call publishes it before the shelf cards render (a late scrollbar is
		// caught by the scroller's ResizeObserver re-running metrics).
		const metrics = (w: number): GridMetrics => {
			const m = this.readingMetrics(w);
			setRowsCardWidth(scroll, m.cardWidth);
			return m;
		};
		metrics(scroll.clientWidth);

		const observer = new LazyCardObserver(
			'.wl-reading-card[data-needs-cover="true"]',
			(cards) => this.handleCoversVisible(cards),
		);
		this.coverObserver = observer;
		const scroller = new VirtualScroller({
			scroll,
			metrics,
			onWindowChanged: () => observer.observeNew(scroll),
			onScrollPos: (top) => { this.vsPersistentScrollTop = top; },
		});
		this.vsScroller = scroller;

		const renderCard = (parent: HTMLElement, it: Book | Manga): void => {
			if (isBooks) this.renderBookCard(parent, it as Book);
			else this.renderMangaCard(parent, it as Manga);
		};

		// Section builders keyed by rowsLayout id — each computes its own list
		// with its own logic first, THEN hides non-matching items (e.g.
		// Recently Added stays the 10 newest overall with non-matches removed).
		const shelfRenderers: Record<string, () => void> = {
			favorites: () => {
				// newest favorite first — this shelf ignores the tab sort
				const favorites = sortByFavorited(items.filter((i) => i.favorite === true && itemVisible(i)));
				renderShelf(
					scroll, 'Favorites', favorites,
					`No favorites yet; open a ${isBooks ? 'book' : 'manga'} and tap the heart.`,
					filtering, renderCard, this.shelfSelect(favorites),
				);
			},
			recentlyAdded: () => {
				const recentlyAdded = [...items]
					.sort((a, b) => (b.dateAdded ?? '').localeCompare(a.dateAdded ?? ''))
					.slice(0, 10)
					.filter(itemVisible);
				renderShelf(
					scroll, 'Recently Added', recentlyAdded,
					'Nothing here yet; added items will show up in this row.',
					filtering, renderCard, this.shelfSelect(recentlyAdded),
				);
			},
			recentlyRead: () => {
				const recentlyRead = this.getRecentlyReadItems(items).filter(itemVisible);
				renderShelf(
					scroll, 'Recently Read', recentlyRead,
					'Nothing read yet; items you progress or finish show up here.',
					filtering, renderCard, this.shelfSelect(recentlyRead),
				);
			},
			recentlyReleased: () => {
				// Past releases only (today counts as released; the auto
				// "To be released" status only applies to strictly future dates).
				const today = ReadingTab.todayStamp();
				const recentlyReleased = items
					.filter(
						(i) =>
							i.status !== 'To be released' &&
							!!i.releaseDate &&
							/^\d{4}-\d{2}-\d{2}$/.test(i.releaseDate) &&
							i.releaseDate <= today,
					)
					.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
					.slice(0, 10)
					.filter(itemVisible);
				renderShelf(
					scroll, 'Recently Released', recentlyReleased,
					'No released items yet; items with a past release date show up here.',
					filtering, renderCard, this.shelfSelect(recentlyReleased),
				);
			},
			byStatus: () => {
				this.renderByStatusSection(scroll, items, itemVisible, filtering, isBooks);
			},
		};

		// User-customizable section order + visibility (the Watchlist Rows
		// pattern). "By status" is Reading's only grouped-grid section — with
		// it off, the flat grid (the old Reading grid) renders at its layout
		// position; with every section off, the flat grid is all there is.
		const layout = normalizeRowsLayout(this.readingData.getSettings().rowsLayout, READING_ROWS_SHELVES, []);
		const byStatusEnabled = layout.some((e) => e.id === 'byStatus' && e.enabled);
		const anyShelfEnabled = layout.some((e) => e.id !== 'byStatus' && e.enabled);
		for (const entry of layout) {
			if (entry.id === 'byStatus' && !byStatusEnabled) {
				this.renderAllItemsSection(scroll, anyShelfEnabled, this.applySort(visible), isBooks);
				continue;
			}
			if (!entry.enabled) continue;
			shelfRenderers[entry.id]?.();
		}

		// Observe the eagerly built shelf cards now; the grids register theirs
		// incrementally as the scroller materialises windows.
		observer.observeNew(scroll);
		scroller.attach(this.vsPersistentScrollTop);
	}

	/**
	 * Renders the "N titles" count line above the sections, mirroring the
	 * Watchlist count. Reading has no groups, so only the title count is
	 * shown; the count reflects the post-filter/search result set. Carries the
	 * customize-rows gear at the far right (the Watchlist spot).
	 */
	private renderResultsCount(titleCount: number): void {
		if (!this.contentEl) return;
		const countEl = this.contentEl.createDiv({ cls: 'wl-results-count wl-results-count-rows' });
		countEl.textContent = `${titleCount} title${titleCount !== 1 ? 's' : ''}`;
		const gearBtn = countEl.createEl('button', { cls: 'wl-rows-customize-btn' });
		gearBtn.setAttr('aria-label', 'Customize rows');
		setIcon(gearBtn, 'settings');
		gearBtn.addEventListener('click', () => {
			new RowsCustomizeModal(this.plugin.app, this.plugin, {
				shelves: READING_ROWS_SHELVES,
				getLayout: () => this.readingData.getSettings().rowsLayout,
				setLayout: (layout) => { this.readingData.getSettings().rowsLayout = layout; },
				// The layout lives inside data.json's reading key, not
				// plugin.settings — persist through the reading data manager
				// (quiet: onChanged re-renders this tab itself).
				persist: () => this.readingData.persistQuiet(),
				onChanged: () => this.renderContent(),
				hint: 'Reorder the sections or switch them off. "By status" is the grouped grid section; with it off the items show as one flat grid.',
				// Reading has a single grouped-grid section — nothing to be
				// mutually exclusive with.
				exclusiveGroups: [],
			}).open();
		});
	}

	// ── Virtual scroll ────────────────────────────────────────────────────────

	private destroyVirtualScroll(): void {
		this.coverObserver?.destroy();
		this.coverObserver = null;
		this.vsScroller?.destroy();
		this.vsScroller = null;
	}

	/** The Cards-view poster geometry, plus the fixed text block below each
	 *  cover (title + author + progress line) when the card text style is
	 *  'under'; in 'inside' mode the text overlays the cover, so the cell is
	 *  the bare 2:3 card. */
	private readingMetrics(containerWidth: number): GridMetrics {
		const base = computeGridMetrics(containerWidth, this.plugin.getCardMinWidth());
		if (!this.plugin.isCardTextUnder('reading')) return base;
		const cardHeight = base.cardHeight + 72;
		return { cols: base.cols, cardWidth: base.cardWidth, cardHeight, rowHeight: cardHeight + 12 };
	}

	/** Local calendar day as YYYY-MM-DD. */
	private static todayStamp(): string {
		const now = new Date();
		return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	}

	/**
	 * Items with any reading signal (progress, a start date, or a finish
	 * date), most recently touched first (capped at 10). Reading logs no
	 * per-session history events for page/chapter ticks outside the detail
	 * modal flow, so dateModified is the best available recency signal — it
	 * can also surface a merely-edited item, an accepted tradeoff.
	 */
	private getRecentlyReadItems(items: Array<Book | Manga>): Array<Book | Manga> {
		return items
			.filter((i) => {
				const pages = (i as Book).pagesRead ?? 0;
				const words = (i as Book).wordsRead ?? 0;
				const volumes = (i as Manga).volumesRead ?? 0;
				return pages > 0 || words > 0 || i.chaptersRead > 0 || volumes > 0
					|| !!i.dateStarted || !!i.dateFinished;
			})
			.sort((a, b) => (b.dateModified ?? '').localeCompare(a.dateModified ?? ''))
			.slice(0, 10);
	}

	/** One virtualised Reading grid over `bucket`, registered as a section on
	 *  the shared scroller (the grouped grids and the flat grid both use it). */
	private addReadingGridSection(parent: HTMLElement, bucket: Array<Book | Manga>, isBooks: boolean): void {
		const spacer = parent.createDiv({ cls: 'wl-rows-bytype-spacer' });
		const grid = spacer.createDiv({ cls: 'wl-reading-grid wl-reading-grid-virtual' });
		const vgrid = new VirtualGrid(
			spacer,
			grid,
			bucket.length,
			{
				buildItem: (i) => {
					const item = bucket[i];
					if (!item) return null;
					const tmp = createDiv();
					if (isBooks) this.renderBookCard(tmp, item as Book);
					else this.renderMangaCard(tmp, item as Manga);
					return tmp.firstElementChild as HTMLElement | null;
				},
				removeItem: (el) => this.coverObserver?.unobserveAndRemove(el),
			},
			// The Reading grid's stylesheet reads its own CSS variables.
			{ colsVar: '--wl-reading-cols', cardHeightVar: '--wl-reading-card-height' },
		);
		this.vsScroller?.addSection(vgrid, spacer);
	}

	/** "By status" — one Reading grid per status, in the READING_STATUSES
	 *  order; empty buckets are skipped, each item appears once. */
	private renderByStatusSection(
		parent: HTMLElement,
		items: Array<Book | Manga>,
		itemVisible: (it: Book | Manga) => boolean,
		filtering: boolean,
		isBooks: boolean,
	): void {
		const section = parent.createDiv({ cls: 'wl-rows-bytype' });
		section.createDiv({ cls: 'wl-rows-bytype-title', text: 'By status' });

		let rendered = 0;
		for (const status of READING_STATUSES) {
			const bucket = this.applySort(items.filter((i) => i.status === status && itemVisible(i)));
			if (bucket.length === 0) continue;
			rendered++;
			renderShelfTitle(section, status, bucket.length, this.shelfSelect(bucket));
			this.addReadingGridSection(section, bucket, isBooks);
		}
		if (rendered === 0) {
			if (filtering) {
				section.remove();
				return;
			}
			section.createDiv({
				cls: 'wl-rows-shelf-empty',
				text: 'No items yet; added items are grouped by status here.',
			});
		}
	}

	/** The flat grid — the old Reading grid living inside the Rows layout as
	 *  its fallback section (rendered only when "By status" is off). `titled`
	 *  adds the section header when other sections are on. */
	private renderAllItemsSection(
		parent: HTMLElement,
		titled: boolean,
		sortedItems: Array<Book | Manga>,
		isBooks: boolean,
	): void {
		if (sortedItems.length === 0) return;
		const section = parent.createDiv({ cls: 'wl-rows-bytype' });
		if (titled) renderShelfTitle(section, isBooks ? 'All books' : 'All manga', sortedItems.length, this.shelfSelect(sortedItems));
		this.addReadingGridSection(section, sortedItems, isBooks);
	}

	// ── Lazy cover re-fetch ─────────────────────────────────────────────────────

	/** Lazy cover fetch for cards that scrolled into view (LazyCardObserver
	 *  hands them over exactly once, already unobserved). */
	private handleCoversVisible(cards: HTMLElement[]): void {
		const kind: ReadingKind = this.activeSubTab === 'books' ? 'book' : 'manga';
		for (const card of cards) {
			const id = card.dataset.itemId;
			if (!id) continue;
			const item = kind === 'book' ? this.readingData.getBook(id) : this.readingData.getManga(id);
			// Skip if it vanished, already has a cover, or failed earlier this session.
			if (!item || item.coverUrl || this.coverFetchFailed.has(id)) continue;

			const cover = card.querySelector('.wl-reading-card-cover');
			cover?.addClass('is-loading');
			void this.resolveCover(kind, item).then(({ url, sourceId }) => {
				cover?.removeClass('is-loading');
				if (url) {
					// Persist silently (no re-render) and update this card's <img> directly.
					// When a title-based lookup resolved a new ID, store it too so future
					// loads use the cheap ID path instead of re-searching.
					if (sourceId) this.readingData.updateCoverAndSource(kind, id, url, sourceId);
					else this.readingData.updateCoverUrl(kind, id, url);
					this.applyCoverToCard(card, url, item.title);
				} else {
					this.coverFetchFailed.add(id);
				}
			});
		}
	}

	/**
	 * Re-resolves a cover through Reading's OWN sources — Google Books for books,
	 * Jikan for manga — never the watch PosterService. When the entry has a source ID
	 * it's used directly; otherwise (CSV-imported entries with neither cover nor ID) it
	 * falls back to a title-based search, taking the first result and returning its ID so
	 * the caller can persist it. `sourceId` is '' when nothing new needs persisting.
	 * Returns an empty url when unavailable.
	 */
	private async resolveCover(kind: ReadingKind, item: Book | Manga): Promise<{ url: string; sourceId: string }> {
		try {
			if (kind === 'book') {
				const gid = (item as Book).googleBooksId;
				if (gid) {
					const result = await this.plugin.apiService.getGoogleBookById(gid);
					return { url: result?.coverUrl ?? '', sourceId: '' };
				}
				const query = (item as Book).author
					? `${item.title} ${(item as Book).author}`
					: item.title;
				const results = await this.plugin.apiService.searchGoogleBooks(query);
				const first = results[0];
				if (!first || !first.coverUrl || !first.googleBooksId) return { url: '', sourceId: '' };
				return { url: first.coverUrl, sourceId: first.googleBooksId };
			}
			const malId = (item as Manga).malId;
			if (malId) {
				const result = await this.plugin.apiService.getMangaByMalId(Number(malId));
				return { url: result?.coverUrl ?? '', sourceId: '' };
			}
			const results = await this.plugin.apiService.searchManga(item.title);
			const first = results[0];
			if (!first || !first.coverUrl || !first.malId) return { url: '', sourceId: '' };
			return { url: first.coverUrl, sourceId: String(first.malId) };
		} catch {
			return { url: '', sourceId: '' };
		}
	}

	private applyCoverToCard(card: HTMLElement, url: string, alt: string): void {
		const cover = card.querySelector<HTMLElement>('.wl-reading-card-cover');
		if (!cover) return;
		const icon = cover.querySelector('.wl-reading-card-cover-icon');
		const img = createEl('img');
		img.className = 'wl-reading-card-cover-img';
		img.alt = alt;
		img.loading = 'lazy';
		img.onload = () => {
			cover.style.removeProperty('background-color');
			icon?.remove();
		};
		img.onerror = () => { img.remove(); };
		cover.insertBefore(img, cover.firstChild);
		img.src = url;
		delete card.dataset.needsCover;
	}

	private renderBookCard(grid: HTMLElement, book: Book): void {
		const { card, textHost } = this.renderCardShell(grid, book, '📖');
		const { read, total, label } = bookUnitProgress(book);
		const progress = total > 0 ? Math.min(100, Math.round((read / total) * 100)) : 0;
		this.renderProgressBar(textHost, progress, book.status);
		const text = textHost.createDiv({ cls: 'wl-reading-card-progress-text' });
		if (total > 0) {
			text.textContent = `${formatCount(read)} / ${formatCount(total)} ${label}`;
		} else if (read > 0) {
			text.textContent = `${formatCount(read)} ${label}`;
		} else {
			text.textContent = 'No progress';
		}
		this.bindCardClick(card, 'book', book.id);
	}

	private renderMangaCard(grid: HTMLElement, manga: Manga): void {
		const { card, textHost } = this.renderCardShell(grid, manga, '📓');
		const progress = manga.totalChapters > 0
			? Math.min(100, Math.round((manga.chaptersRead / manga.totalChapters) * 100))
			: 0;
		this.renderProgressBar(textHost, progress, manga.status);
		const text = textHost.createDiv({ cls: 'wl-reading-card-progress-text' });
		const chPart = manga.totalChapters > 0
			? `Ch. ${manga.chaptersRead}/${manga.totalChapters}`
			: manga.chaptersRead > 0 ? `Ch. ${manga.chaptersRead}` : '';
		const volPart = manga.totalVolumes > 0
			? `Vol. ${manga.volumesRead}/${manga.totalVolumes}`
			: manga.volumesRead > 0 ? `Vol. ${manga.volumesRead}` : '';
		if (chPart) text.createSpan({ cls: 'wl-reading-card-progress-piece', text: chPart });
		if (volPart) text.createSpan({ cls: 'wl-reading-card-progress-piece', text: volPart });
		if (!chPart && !volPart) text.textContent = 'No progress';
		this.bindCardClick(card, 'manga', manga.id);
	}

	/**
	 * Select-all spec for one Rows section. undefined outside selection mode, which is what keeps
	 * the box out of the header. This tab re-renders on every selection change, so the boxes
	 * rebuild with fresh state and need no refresher registry.
	 */
	private shelfSelect(sectionItems: Array<{ id: string }>): ShelfSelect | undefined {
		if (!this.selectionMode) return undefined;
		return {
			ids: sectionItems.map((i) => i.id),
			selected: this.selectedIds,
			onToggle: (ids, selectAll) => {
				for (const id of ids) {
					if (selectAll) { this.selectedIds.add(id); } else { this.selectedIds.delete(id); }
				}
				this.render();
			},
		};
	}

	private bindCardClick(card: HTMLElement, mode: 'book' | 'manga', id: string): void {
		if (this.selectionMode) {
			if (this.selectedIds.has(id)) {
				card.addClass('is-selected');
			}
			card.addEventListener('click', (e) => {
				e.stopPropagation();
				if (this.selectedIds.has(id)) {
					this.selectedIds.delete(id);
					card.removeClass('is-selected');
				} else {
					this.selectedIds.add(id);
					card.addClass('is-selected');
				}
				this.render();
			});
		} else {
			card.addEventListener('click', () => {
				if (this.plugin.settings.openNoteOnClick) {
					void this.openReadingNote(mode, id);
				} else {
					this.openDetailModal(mode, id);
				}
			});
			if (this.plugin.settings.openNoteOnClick) {
				card.addEventListener('contextmenu', (e) => {
					e.preventDefault();
					e.stopPropagation();
					this.openDetailModal(mode, id);
				});
			}
		}
	}

	/** Builds the shared card DOM. `textHost` is where the caller appends the
	 *  progress bar/text: the card itself in under mode (the classic Reading
	 *  layout), or a bottom overlay inside the cover in inside mode (the
	 *  Watchlist look — the cardTextStyle setting). */
	private renderCardShell(
		grid: HTMLElement,
		item: Book | Manga,
		fallbackIcon: string,
	): { card: HTMLElement; textHost: HTMLElement } {
		const card = grid.createDiv({ cls: 'wl-reading-card' });
		if (!this.plugin.isCardTextUnder('reading')) card.addClass('is-text-inside');

		const cover = card.createDiv({ cls: 'wl-reading-card-cover' });
		if (item.coverUrl) {
			cover.createEl('img', {
				cls: 'wl-reading-card-cover-img',
				attr: { src: item.coverUrl, alt: item.title, loading: 'lazy' },
			});
		} else {
			cover.style.backgroundColor = coverFallbackColor(item.id);
			cover.createSpan({
				cls: 'wl-reading-card-cover-icon',
				text: fallbackIcon,
			});
			// Flag cards with a missing cover for lazy re-fetch when they scroll into view.
			// resolveCover uses the source ID when present, otherwise falls back to a
			// title-based lookup (CSV-imported entries with neither cover nor ID). Skip
			// only titles that already failed to resolve this session.
			if (!this.coverFetchFailed.has(item.id)) {
				card.dataset.needsCover = 'true';
				card.dataset.itemId = item.id;
			}
		}

		const statusBadge = cover.createSpan({ cls: 'wl-reading-card-status-badge', text: item.status });
		statusBadge.style.backgroundColor = readingStatusColor(item.status, this.readingData.getSettings().statusColors);

		const menuBtn = card.createEl('button', {
			cls: 'wl-reading-card-menu-btn',
			text: '⋮',
		});
		menuBtn.setAttr('aria-label', 'More actions');
		menuBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openCardContextMenu(card, menuBtn, item);
		});

		const textHost = this.plugin.isCardTextUnder('reading')
			? card
			: cover.createDiv({ cls: 'wl-reading-card-overlay' });

		const title = textHost.createDiv({ cls: 'wl-reading-card-title', text: item.title });
		title.title = item.title;
		const author = textHost.createDiv({
			cls: 'wl-reading-card-author',
			text: item.author || '—',
		});
		author.title = item.author || '';

		return { card, textHost };
	}

	private openCardContextMenu(
		card: HTMLElement,
		anchorBtn: HTMLElement,
		item: Book | Manga,
	): void {
		openCardMenu(
			card,
			anchorBtn,
			[{ label: 'Refresh cover', onClick: () => this.refreshCover(item) }],
			{ container: this.container, cleanups: this.activeCleanups },
			'wl-reading-card',
		);
	}

	private refreshCover(item: Book | Manga): void {
		const isBooks = this.activeSubTab === 'books';
		const kind = isBooks ? 'book' : 'manga';

		if (kind === 'book') {
			const book = item as Book;
			if (!book.googleBooksId) {
				new Notice('No Google Books ID; cannot refresh cover.');
				return;
			}
			if (!this.plugin.apiService.hasGoogleBooksKey()) {
				new Notice('Google Books API key required; add one in Settings → API → Books.');
				return;
			}
			void (async () => {
				try {
					const result = await this.plugin.apiService.getGoogleBookById(book.googleBooksId);
					if (!result || !result.coverUrl) {
						new Notice('Could not fetch cover from API.');
						return;
					}
					const fresh = this.readingData.getBook(book.id);
					if (!fresh) return;
					await this.readingData.updateBook({ ...fresh, coverUrl: result.coverUrl });
					new Notice('Cover refreshed.');
				} catch (err) {
					new Notice(apiErrorMessage(err));
				}
			})();
		} else {
			const manga = item as Manga;
			if (!manga.malId) {
				new Notice('No MAL ID; cannot refresh cover.');
				return;
			}
			void (async () => {
				try {
					const result = await this.plugin.apiService.getMangaByMalId(Number(manga.malId));
					if (!result || !result.coverUrl) {
						new Notice('Could not fetch cover from API.');
						return;
					}
					const fresh = this.readingData.getManga(manga.id);
					if (!fresh) return;
					await this.readingData.updateManga({ ...fresh, coverUrl: result.coverUrl });
					new Notice('Cover refreshed.');
				} catch {
					new Notice('Failed to refresh cover.');
				}
			})();
		}
	}

	private renderProgressBar(card: HTMLElement, percent: number, status: ReadingStatus): void {
		const bar = card.createDiv({ cls: 'wl-reading-card-progress-bar' });
		const fill = bar.createDiv({ cls: 'wl-reading-card-progress-fill' });
		fill.style.width = `${percent}%`;
		fill.style.backgroundColor = readingStatusColor(status, this.readingData.getSettings().statusColors);
	}

	private renderEmptyState(): void {
		if (!this.contentEl) return;
		const empty = this.contentEl.createDiv({ cls: 'wl-reading-empty' });
		const isBooks = this.activeSubTab === 'books';
		empty.createSpan({ cls: 'wl-reading-empty-icon', text: isBooks ? '📖' : '📓' });
		const msg = empty.createDiv({ cls: 'wl-reading-empty-msg' });
		msg.createSpan({ text: isBooks ? 'No books yet; ' : 'No manga yet; ' });
		const link = msg.createEl('a', {
			cls: 'wl-reading-empty-link',
			text: isBooks ? 'add your first book' : 'add your first manga',
		});
		link.addEventListener('click', (e) => {
			e.preventDefault();
			this.openAddModal();
		});
	}

	private openAddModal(): void {
		new AddReadingModal(
			this.plugin.app,
			this.plugin,
			this.readingData,
			this.activeSubTab === 'books' ? 'book' : 'manga',
			() => this.renderContent(),
		).open();
	}

	private openManageColumns(): void {
		new ReadingManageColumnsModal(
			this.plugin.app,
			this.plugin,
			this.readingData,
			this.activeSubTab === 'books' ? 'book' : 'manga',
			() => this.renderContent(),
		).open();
	}

	private openDetailModal(mode: 'book' | 'manga', id: string): void {
		new ReadingDetailModal(
			this.plugin.app,
			this.plugin,
			this.readingData,
			mode,
			id,
			() => this.renderContent(),
		).open();
	}

	private async openReadingNote(mode: 'book' | 'manga', id: string): Promise<void> {
		const item = mode === 'book'
			? this.readingData.getBook(id)
			: this.readingData.getManga(id);
		if (!item) return;
		const created = await this.readingData.createReadingNoteIfMissing(mode, item);
		if (!created) await this.readingData.rewriteFrontmatterIfExists(mode, item);
		await openNoteFile(this.plugin.app, this.readingData.noteFilePath(mode, item.title));
	}
}
