import { Notice } from 'obsidian';
import { googleBooksErrorMessage } from './ApiService';
import Fuse from 'fuse.js';
import type WatchLogPlugin from './main';
import type { ReadingDataManager, ReadingKind } from './ReadingDataManager';
import { Book, Manga, ReadingStatus, ReadingCustomColumn, ReadingSavedFilterPreset, READING_STATUSES, SELECTABLE_READING_STATUSES } from './types';
import { AddReadingModal } from './AddReadingModal';
import { ReadingDetailModal } from './ReadingDetailModal';
import { ReadingManageColumnsModal } from './ReadingManageColumnsModal';
import { ConfirmModal } from './ConfirmModal';

type SubTab = 'books' | 'manga';

// Built-in sort keys, plus dynamic `custom:<columnId>` keys for custom fields.
type SortKey = string;
type SortDir = 'asc' | 'desc';

// Synthetic option keys for the "Has value" / "No value" choices on text/number
// custom-field filter sections.
const HAS_VALUE = '__has__';
const NO_VALUE = '__none__';

function customFieldHasValue(item: Book | Manga, columnId: string): boolean {
	const v = item.customFields?.[columnId];
	return v !== undefined && v !== null && v !== '';
}

interface ReadingFilters {
	// Excluded statuses (mirrors the Watchlist popover, where a ticked checkbox =
	// included). Empty = every status shown. Converted to the preset's
	// `statusInclude` shape only when a preset is saved/loaded.
	statusExclude: ReadingStatus[];
	ratingMode: 'all' | 'has' | 'none';
	// Per custom-field exclusions keyed by column id. For 'select' columns the
	// excluded values are option strings; for 'text'/'number' columns they are the
	// synthetic HAS_VALUE / NO_VALUE predicate keys.
	customExclude: Record<string, string[]>;
}

interface ReadingSort {
	key: SortKey;
	dir: SortDir;
	secondKey: SortKey;
	secondDir: SortDir;
}

// Staged filter edits (mirror of ReadingFilters but with Sets for in-place
// mutation while the popover is open).
interface FilterDraft {
	statusExclude: Set<ReadingStatus>;
	ratingMode: 'all' | 'has' | 'none';
	customExclude: Map<string, Set<string>>;
}

// Lets the global Select all / Deselect all buttons drive a section's checkboxes.
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

export function readingStatusColor(status: ReadingStatus): string {
	switch (status) {
		case 'Reading':       return '#1D9E75';
		case 'Completed':     return '#7F77DD';
		case 'Plan to Read':  return '#E8873A';
		case 'To be released': return '#3A86C8';
		case 'Dropped':       return '#E24B4A';
		default:              return '#888780';
	}
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
	if (b.totalPages > 0) return Math.min(100, (b.pagesRead / b.totalPages) * 100);
	return 0;
}

function mangaProgress(m: Manga): number {
	if (m.totalChapters > 0) return Math.min(100, (m.chaptersRead / m.totalChapters) * 100);
	return 0;
}

export class ReadingTab {
	// Session-persistent state. Survives tab switches and view rebuilds
	// within the same plugin load — resets only when the plugin unloads.
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
	// Single saved filter (mirrors the Watchlist saved-filter flow). The external
	// "Saved filter" button applies it; the in-popover button toggles Save/Delete.
	private savedFilterActive = false;
	private savedFilterBtnEl: HTMLButtonElement | null = null;
	private openPopover: HTMLElement | null = null;
	private popoverCleanup: (() => void) | null = null;
	private activeCleanups: (() => void)[] = [];

	// Selection mode
	private selectionMode = false;
	private selectedIds: Set<string> = new Set();

	// Virtual scroll state
	private vsScrollContainer: HTMLElement | null = null;
	private vsScrollSpacer: HTMLElement | null = null;
	private vsGridEl: HTMLElement | null = null;
	private vsDisplayItems: Array<Book | Manga> = [];
	private vsScrollHandler: (() => void) | null = null;
	private vsScrollRAF: number | null = null;
	private vsResizeObserver: ResizeObserver | null = null;
	private vsLastFirst = -1;
	private vsLastLast = -1;
	private vsLastScrollTop = 0;
	private vsPersistentScrollTop = 0;
	private vsRowHeight = 0;

	// Lazy cover re-fetch (mirrors the watch Cards IntersectionObserver pattern).
	private coverObserver: IntersectionObserver | null = null;
	private observedCovers: Set<HTMLElement> = new Set();
	// Items whose cover fetch already failed this session — don't retry on every scroll.
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

	// Custom columns for the active sub-tab (Books → bookColumns, Manga → mangaColumns).
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
		const bar = this.container.createDiv({ cls: 'wl-reading-subtabs' });

		const booksBtn = bar.createEl('button', {
			cls: `wl-reading-subtab${this.activeSubTab === 'books' ? ' is-active' : ''}`,
			text: 'Books',
		});

		const mangaBtn = bar.createEl('button', {
			cls: `wl-reading-subtab${this.activeSubTab === 'manga' ? ' is-active' : ''}`,
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

		const left = toolbar.createDiv({ cls: 'wl-reading-toolbar-left' });

		const searchWrap = left.createDiv({ cls: 'wl-reading-search-wrap' });
		const placeholder = this.activeSubTab === 'books' ? 'Search books...' : 'Search manga...';
		const searchInput = searchWrap.createEl('input', {
			cls: 'wl-reading-search-input',
			attr: { type: 'text', placeholder },
		});
		searchInput.value = this.searchQuery;
		let debounce = 0;
		searchInput.addEventListener('input', () => {
			this.searchQuery = searchInput.value;
			window.clearTimeout(debounce);
			debounce = window.setTimeout(() => this.renderContent(), 200);
		});

		// Saved filter button — shown only when a filter has been saved. Pressing
		// it applies the saved filter to the active sub-tab (mirrors Watchlist).
		const savedFilter = this.getSavedFilter();
		if (savedFilter) {
			this.savedFilterActive = this.filtersMatchSaved(savedFilter);
			const savedBtn = left.createEl('button', {
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

		this.filterBtn = left.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-reading-filter-btn',
			text: 'Filter',
		});
		this.refreshFilterButtonBadge();
		this.filterBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.toggleFilterPopover();
		});

		this.resetBtn = left.createEl('button', {
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

		this.sortBtn = left.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-reading-sort-btn',
			text: 'Sort',
		});
		this.sortBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.toggleSortPopover();
		});

		// Selection mode action bar
		if (this.selectionMode && this.selectedIds.size > 0) {
			this.renderSelectionActionBar(left);
		}

		// Select All / Deselect All
		if (this.selectionMode) {
			const hasAny = this.selectedIds.size > 0;
			const selAllBtn = left.createEl('button', {
				cls: 'wl-btn wl-btn-sm',
				text: hasAny ? 'None' : 'All',
			});
			selAllBtn.title = hasAny ? 'Deselect all' : 'Select all visible';
			selAllBtn.addEventListener('click', () => {
				if (this.selectedIds.size > 0) {
					this.selectedIds.clear();
				} else {
					for (const item of this.vsDisplayItems) {
						this.selectedIds.add(item.id);
					}
				}
				this.render();
			});
		}

		// Selection mode toggle
		const selBtn = left.createEl('button', {
			cls: `wl-btn wl-btn-sm${this.selectionMode ? ' is-active' : ''}`,
			text: 'Select',
		});
		selBtn.addEventListener('click', () => {
			this.selectionMode = !this.selectionMode;
			this.selectedIds.clear();
			this.render();
		});

		const right = toolbar.createDiv({ cls: 'wl-reading-toolbar-right' });
		const manageBtn = right.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-reading-manage-btn',
			attr: { 'aria-label': 'Manage columns', title: 'Manage columns' },
			text: '⚙',
		});
		manageBtn.addEventListener('click', () => this.openManageColumns());

		// Add button sits at the far right, after the gear
		const addBtn = right.createEl('button', {
			cls: 'wl-reading-add-btn wl-btn-success',
			text: this.activeSubTab === 'books' ? '+ Add book' : '+ Add manga',
		});
		addBtn.addEventListener('click', () => this.openAddModal());
	}

	private renderSelectionActionBar(parent: HTMLElement): void {
		const bar = parent.createDiv({ cls: 'wl-reading-action-bar' });

		// Batch delete
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

		// Batch status change
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
		const pop = this.container.createDiv({ cls });
		const rect = anchor.getBoundingClientRect();
		const parentRect = this.container.getBoundingClientRect();
		pop.style.position = 'absolute';
		pop.style.top = `${rect.bottom - parentRect.top + 4}px`;
		pop.style.left = `${rect.left - parentRect.left}px`;
		pop.style.right = 'auto';
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

	// ── Saved filter (single, Watchlist-style) ─────────────────────────────────
	private getSavedFilter(): ReadingSavedFilterPreset | null {
		return this.readingData.getSettings().savedFilters?.[this.activeSubTab] ?? null;
	}

	private filtersMatchSaved(saved: ReadingSavedFilterPreset): boolean {
		const f = this.filters;
		// A saved filter only captures status + rating, so any active custom-field
		// filter means the live state no longer matches it.
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
		// Draft state — Reading's live filters are NOT mutated until Apply is
		// clicked (the key behavioral parity with the Watchlist popover). Status
		// and custom fields use exclude semantics for the UI; Status is converted
		// to the preset's `statusInclude` shape only on save.
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
		const applyWrap = el.createDiv();
		applyWrap.style.padding = '6px 12px 2px';
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
				? 'Ascending — click to switch to descending'
				: 'Descending — click to switch to ascending';

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

	private applySearch(items: Array<Book | Manga>): Array<Book | Manga> {
		const q = this.searchQuery.trim();
		if (!q) return items;
		const fuse = new Fuse(items, {
			keys: ['title', 'author'],
			threshold: 0.4,
			ignoreLocation: true,
		});
		return fuse.search(q).map((r) => r.item);
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

		const filtered = this.applyFilters(items);
		const searched = this.applySearch(filtered);
		const sorted = this.applySort(searched);

		if (sorted.length === 0) {
			const q = this.searchQuery.trim();
			this.contentEl.createDiv({
				cls: 'wl-reading-empty-search',
				text: q ? `No matches for "${q}".` : 'No items match the current filters.',
			});
			return;
		}

		this.renderResultsCount(sorted.length);

		this.vsDisplayItems = sorted;
		this.renderVirtualGrid();
	}

	/**
	 * Renders the "N titles" count line above the grid, mirroring the Watchlist
	 * Cards count. Reading has no groups, so only the title count is shown. The
	 * count reflects the post-filter/search result set.
	 */
	private renderResultsCount(titleCount: number): void {
		if (!this.contentEl) return;
		const countEl = this.contentEl.createDiv({ cls: 'wl-results-count' });
		countEl.textContent = `${titleCount} title${titleCount !== 1 ? 's' : ''}`;
	}

	// ── Virtual scroll ────────────────────────────────────────────────────────

	private destroyVirtualScroll(): void {
		this.destroyCoverObserver();
		if (this.vsScrollRAF !== null) {
			window.cancelAnimationFrame(this.vsScrollRAF);
			this.vsScrollRAF = null;
		}
		if (this.vsResizeObserver) {
			this.vsResizeObserver.disconnect();
			this.vsResizeObserver = null;
		}
		if (this.vsScrollContainer && this.vsScrollHandler) {
			this.vsScrollContainer.removeEventListener('scroll', this.vsScrollHandler);
		}
		this.vsScrollHandler = null;
		this.vsScrollContainer = null;
		this.vsScrollSpacer = null;
		this.vsGridEl = null;
		this.vsDisplayItems = [];
		this.vsLastFirst = -1;
		this.vsLastLast = -1;
		this.vsLastScrollTop = 0;
		this.vsRowHeight = 0;
	}

	private renderVirtualGrid(): void {
		if (!this.contentEl) return;

		const scroll = this.contentEl.createDiv({ cls: 'wl-reading-scroll-container' });
		const spacer = scroll.createDiv({ cls: 'wl-reading-scroll-spacer' });
		const grid = spacer.createDiv({ cls: 'wl-reading-grid wl-reading-grid-virtual' });
		this.vsScrollContainer = scroll;
		this.vsScrollSpacer = spacer;
		this.vsGridEl = grid;
		this.vsLastFirst = -1;
		this.vsLastLast = -1;

		this.vsScrollHandler = () => {
			const scrollTop = scroll.scrollTop;
			this.vsPersistentScrollTop = scrollTop;
			const threshold = this.vsRowHeight > 0 ? this.vsRowHeight / 2 : 50;
			if (Math.abs(scrollTop - this.vsLastScrollTop) < threshold) return;
			this.vsLastScrollTop = scrollTop;
			if (this.vsScrollRAF !== null) return;
			this.vsScrollRAF = window.requestAnimationFrame(() => {
				this.vsScrollRAF = null;
				this.renderVisibleCards();
			});
		};
		scroll.addEventListener('scroll', this.vsScrollHandler, { passive: true });

		this.vsResizeObserver = new ResizeObserver(() => {
			this.renderVisibleCards();
		});
		this.vsResizeObserver.observe(scroll);

		if (this.vsPersistentScrollTop > 0) {
			this.renderVisibleCards();
			scroll.scrollTop = this.vsPersistentScrollTop;
			this.vsLastScrollTop = this.vsPersistentScrollTop;
			this.renderVisibleCards();
		}
	}

	private getGridMetrics(containerWidth: number): {
		cols: number;
		cardWidth: number;
		cardHeight: number;
		rowHeight: number;
	} {
		const gap = 12;
		const minCardWidth = 140;
		const cols = Math.max(1, Math.floor((containerWidth + gap) / (minCardWidth + gap)));
		const cardWidth = (containerWidth - gap * (cols - 1)) / cols;
		const coverHeight = cardWidth * 1.5;
		const cardHeight = coverHeight + 72;
		const rowHeight = cardHeight + gap;
		return { cols, cardWidth, cardHeight, rowHeight };
	}

	private renderVisibleCards(): void {
		const scroll = this.vsScrollContainer;
		const spacer = this.vsScrollSpacer;
		const grid = this.vsGridEl;
		if (!scroll || !spacer || !grid) return;

		const scrollTop = scroll.scrollTop;
		const viewportHeight = scroll.clientHeight;
		const width = scroll.clientWidth;
		if (width <= 0 || viewportHeight <= 0) return;

		const { cols, cardHeight, rowHeight } = this.getGridMetrics(width);
		this.vsRowHeight = rowHeight;
		const totalItems = this.vsDisplayItems.length;
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
		grid.style.setProperty('--wl-reading-cols', String(cols));
		grid.style.setProperty('--wl-reading-card-height', `${cardHeight}px`);

		const oldFirst = this.vsLastFirst;
		const oldLast = this.vsLastLast;
		if (firstIndex === oldFirst && lastIndex === oldLast) return;

		this.vsLastFirst = firstIndex;
		this.vsLastLast = lastIndex;

		grid.empty();
		const isBooks = this.activeSubTab === 'books';
		const fragment = activeDocument.createDocumentFragment();
		for (let i = firstIndex; i <= lastIndex; i++) {
			const item = this.vsDisplayItems[i];
			if (!item) continue;
			const tmp = activeDocument.createElement('div');
			if (isBooks) {
				this.renderBookCard(tmp, item as Book);
			} else {
				this.renderMangaCard(tmp, item as Manga);
			}
			const card = tmp.firstElementChild as HTMLElement | null;
			if (card) fragment.appendChild(card);
		}
		grid.appendChild(fragment);
		this.setupCoverObserver();
	}

	// ── Lazy cover re-fetch ─────────────────────────────────────────────────────

	private setupCoverObserver(): void {
		const scroll = this.vsScrollContainer;
		const grid = this.vsGridEl;
		if (!scroll || !grid) return;
		if (!this.coverObserver) {
			this.coverObserver = new IntersectionObserver(
				(entries) => this.handleCoverIntersection(entries),
				{ root: scroll, rootMargin: '0px', threshold: 0 },
			);
		}
		// The grid was just rebuilt (grid.empty()), so previously observed cards are
		// detached. Drop their (strong) refs before observing the current card set.
		this.observedCovers.clear();
		grid.querySelectorAll('.wl-reading-card[data-needs-cover="true"]').forEach((card) => {
			const el = card as HTMLElement;
			if (!this.observedCovers.has(el)) {
				this.coverObserver!.observe(el);
				this.observedCovers.add(el);
			}
		});
	}

	private handleCoverIntersection(entries: IntersectionObserverEntry[]): void {
		const kind: ReadingKind = this.activeSubTab === 'books' ? 'book' : 'manga';
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const card = entry.target as HTMLElement;
			this.coverObserver?.unobserve(card);
			this.observedCovers.delete(card);

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
		const img = activeDocument.createElement('img');
		img.className = 'wl-reading-card-cover-img';
		img.alt = alt;
		img.loading = 'lazy';
		img.onload = () => {
			cover.style.backgroundColor = '';
			icon?.remove();
		};
		img.onerror = () => { img.remove(); };
		cover.insertBefore(img, cover.firstChild);
		img.src = url;
		delete card.dataset.needsCover;
	}

	private destroyCoverObserver(): void {
		if (this.coverObserver) {
			this.coverObserver.disconnect();
			this.coverObserver = null;
		}
		this.observedCovers.clear();
	}

	private renderBookCard(grid: HTMLElement, book: Book): void {
		const card = this.renderCardShell(grid, book, '📖');
		const progress = book.totalPages > 0
			? Math.min(100, Math.round((book.pagesRead / book.totalPages) * 100))
			: 0;
		this.renderProgressBar(card, progress, book.status);
		const text = card.createDiv({ cls: 'wl-reading-card-progress-text' });
		if (book.totalPages > 0) {
			text.textContent = `${book.pagesRead} / ${book.totalPages} pages`;
		} else if (book.pagesRead > 0) {
			text.textContent = `${book.pagesRead} pages`;
		} else {
			text.textContent = 'No progress';
		}
		this.bindCardClick(card, 'book', book.id);
	}

	private renderMangaCard(grid: HTMLElement, manga: Manga): void {
		const card = this.renderCardShell(grid, manga, '📓');
		const progress = manga.totalChapters > 0
			? Math.min(100, Math.round((manga.chaptersRead / manga.totalChapters) * 100))
			: 0;
		this.renderProgressBar(card, progress, manga.status);
		const text = card.createDiv({ cls: 'wl-reading-card-progress-text' });
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
			card.addEventListener('click', () => this.openDetailModal(mode, id));
		}
	}

	private renderCardShell(grid: HTMLElement, item: Book | Manga, fallbackIcon: string): HTMLElement {
		const card = grid.createDiv({ cls: 'wl-reading-card' });

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
		statusBadge.style.backgroundColor = readingStatusColor(item.status);

		const menuBtn = card.createEl('button', {
			cls: 'wl-reading-card-menu-btn',
			text: '⋮',
		});
		menuBtn.setAttr('aria-label', 'More actions');
		menuBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openCardContextMenu(card, menuBtn, item);
		});

		const title = card.createDiv({ cls: 'wl-reading-card-title', text: item.title });
		title.title = item.title;
		const author = card.createDiv({
			cls: 'wl-reading-card-author',
			text: item.author || '—',
		});
		author.title = item.author || '';

		return card;
	}

	private openCardContextMenu(
		card: HTMLElement,
		anchorBtn: HTMLElement,
		item: Book | Manga,
	): void {
		this.container.querySelectorAll('.wl-reading-card-context-menu').forEach((el) => el.remove());

		const menu = card.createDiv({ cls: 'wl-reading-card-context-menu' });
		const refreshItem = menu.createDiv({
			cls: 'wl-reading-card-context-item',
			text: 'Refresh cover',
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

		refreshItem.addEventListener('click', (e) => {
			e.stopPropagation();
			closeMenu();
			this.refreshCover(item);
		});
	}

	private refreshCover(item: Book | Manga): void {
		const isBooks = this.activeSubTab === 'books';
		const kind = isBooks ? 'book' : 'manga';

		if (kind === 'book') {
			const book = item as Book;
			if (!book.googleBooksId) {
				new Notice('No Google Books ID — cannot refresh cover.');
				return;
			}
			if (!this.plugin.apiService.hasGoogleBooksKey()) {
				new Notice('Google Books API key required — add one in Settings → API → Books.');
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
					new Notice(googleBooksErrorMessage(err));
				}
			})();
		} else {
			const manga = item as Manga;
			if (!manga.malId) {
				new Notice('No MAL ID — cannot refresh cover.');
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
		fill.style.backgroundColor = readingStatusColor(status);
	}

	private renderEmptyState(): void {
		if (!this.contentEl) return;
		const empty = this.contentEl.createDiv({ cls: 'wl-reading-empty' });
		const isBooks = this.activeSubTab === 'books';
		empty.createSpan({ cls: 'wl-reading-empty-icon', text: isBooks ? '📖' : '📓' });
		const msg = empty.createDiv({ cls: 'wl-reading-empty-msg' });
		msg.createSpan({ text: isBooks ? 'No books yet — ' : 'No manga yet — ' });
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
}
