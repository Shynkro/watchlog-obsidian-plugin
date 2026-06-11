import { App, Modal, Notice } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type { ReadingDataManager } from './ReadingDataManager';
import type { WatchLogTitle, AirtimeEntry, AirtimeSchedule, AirtimeRecurrence, MaybeTitle, Book, Manga } from './types';
import { getAirtimeScheduleString, getThemedColor, getReadingTypeColor, parseDateInput, isReleaseDateFuture } from './types';
import { ConfirmModal } from './ConfirmModal';
import { MaybeAddModal } from './MaybeAddModal';
import { ReadingScheduleModal } from './ReadingScheduleModal';
import { UpcomingFinderModal, type UpcomingFinderItem } from './UpcomingFinderModal';

/**
 * A normalized Upcoming card subject — either a watchlist title or a reading item.
 * Lets the tracker render and act on both through one shared code path.
 */
type ResolvedUpcoming = {
	source: 'watchlist' | 'reading';
	id: string;
	title: string;
	/** Badge text: a watch type ("Anime", "Movie", …) or "Book" / "Manga". */
	typeName: string;
	/** Colored-badge color, or null to render a plain badge (reading). */
	typeColor: string | null;
	externalLink: string;
	/** True when the item is a single release (movie/book): 0 or 1 total units. */
	isSingle: boolean;
	/** Total episodes (watch) or total chapters (reading). */
	totalUnits: number;
	/** Lowercase noun for the incrementing unit: "episode" | "chapter". */
	unitNoun: string;
	/** Capitalized incrementing unit: "Episode" | "Chapter". */
	unitNounCap: string;
	/** Capitalized grouping unit: "Season" | "Volume". */
	groupNounCap: string;
	/** Badge tail: "Airing next" | "Reading next". */
	nextLabel: string;
	/** Status to revert to on single-release tick: "Plan to watch" | "Plan to Read". */
	planStatus: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDaysWithMonths(days: number): string {
	if (days < 30) return `in ${days} days`;
	const months = Math.round(days / 30);
	return `in ${days} days (${months} month${months !== 1 ? 's' : ''})`;
}

// ── Card state helpers ────────────────────────────────────────────────────────

type DetailedCountdown = {
	kind: 'future' | 'today-before' | 'aired' | 'due';
	label: string;
	daysUntil: number;
};

/**
 * Returns true if the scheduled time (HH:MM) has already passed for today.
 * If no releaseTime is set, we treat the whole day as "passed" (show aired/due).
 */
function isAirtimePassedNow(schedule: AirtimeSchedule): boolean {
	if (!schedule.releaseTime) return true;
	const now = new Date();
	const [hStr, mStr] = schedule.releaseTime.split(':');
	const h = parseInt(hStr ?? '0');
	const m = parseInt(mStr ?? '0');
	return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
}

/**
 * Computes a detailed countdown state for a card, correctly handling the
 * "airtime passed today" case that getAirtimeCountdown rolls over to next week.
 * Pass lastAcknowledgedDate (YYYY-MM-DD) so that recurring cards reset to the
 * next occurrence immediately after you tick an episode.
 */
function getDetailedCountdown(
	schedule: AirtimeSchedule,
	isMovie: boolean,
	lastAcknowledgedDate?: string,
): DetailedCountdown {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	const acknowledgedToday = lastAcknowledgedDate === todayStr;

	if (schedule.recurrence === 'once') {
		if (!schedule.releaseDate) return { kind: 'future', label: '—', daysUntil: 9999 };
		const rel = new Date(schedule.releaseDate + 'T00:00:00');
		const relDay = new Date(rel.getFullYear(), rel.getMonth(), rel.getDate());

		if (relDay.getTime() < today.getTime()) {
			return isMovie ? { kind: 'due', label: 'Due', daysUntil: 0 } : { kind: 'aired', label: 'Aired', daysUntil: 0 };
		}
		if (relDay.getTime() === today.getTime()) {
			if (isAirtimePassedNow(schedule)) {
				return isMovie ? { kind: 'due', label: 'Due', daysUntil: 0 } : { kind: 'aired', label: 'Aired', daysUntil: 0 };
			}
			return { kind: 'today-before', label: 'Today', daysUntil: 0 };
		}
		const daysUntil = Math.round((relDay.getTime() - today.getTime()) / 86400000);
		if (daysUntil === 1) return { kind: 'future', label: 'Tomorrow', daysUntil: 1 };
		return { kind: 'future', label: formatDaysWithMonths(daysUntil), daysUntil };
	}

	if (schedule.recurrence === 'daily') {
		const passed = isAirtimePassedNow(schedule);
		// Already ticked today → advance to tomorrow
		if (passed && acknowledgedToday) return { kind: 'future', label: 'Tomorrow', daysUntil: 1 };
		if (passed) return { kind: 'aired', label: 'Aired', daysUntil: 0 };
		return { kind: 'today-before', label: 'Today', daysUntil: 0 };
	}

	if (schedule.recurrence === 'weekly' && schedule.dayOfWeek !== undefined) {
		const currentDay = now.getDay();
		const isScheduledDay = currentDay === schedule.dayOfWeek;
		if (isScheduledDay && !acknowledgedToday) {
			if (isAirtimePassedNow(schedule)) return { kind: 'aired', label: 'Aired', daysUntil: 0 };
			return { kind: 'today-before', label: 'Today', daysUntil: 0 };
		}
		// Acknowledged on the scheduled day → force 7 days until next occurrence
		let daysUntil = (isScheduledDay && acknowledgedToday)
			? 7
			: (schedule.dayOfWeek - currentDay + 7) % 7;
		if (daysUntil === 0) daysUntil = 7;
		if (daysUntil === 1) return { kind: 'future', label: 'Tomorrow', daysUntil: 1 };
		return { kind: 'future', label: formatDaysWithMonths(daysUntil), daysUntil };
	}

	if (schedule.recurrence === 'monthly' && schedule.dayOfMonth) {
		const currentDate = now.getDate();
		const isScheduledDay = currentDate === schedule.dayOfMonth;
		if (isScheduledDay && !acknowledgedToday) {
			if (isAirtimePassedNow(schedule)) return { kind: 'aired', label: 'Aired', daysUntil: 0 };
			return { kind: 'today-before', label: 'Today', daysUntil: 0 };
		}
		// Acknowledged on the scheduled day → advance to next month
		let nextDate: Date;
		if (isScheduledDay && acknowledgedToday) {
			nextDate = new Date(now.getFullYear(), now.getMonth() + 1, schedule.dayOfMonth);
		} else {
			nextDate = new Date(now.getFullYear(), now.getMonth(), schedule.dayOfMonth);
			if (nextDate.getTime() <= today.getTime()) {
				nextDate = new Date(now.getFullYear(), now.getMonth() + 1, schedule.dayOfMonth);
			}
		}
		const daysUntil = Math.round((nextDate.getTime() - today.getTime()) / 86400000);
		if (daysUntil === 1) return { kind: 'future', label: 'Tomorrow', daysUntil: 1 };
		return { kind: 'future', label: formatDaysWithMonths(daysUntil), daysUntil };
	}

	return { kind: 'future', label: '—', daysUntil: 9999 };
}

// ── Helper: "X days ago" label ────────────────────────────────────────────────

function formatDaysAgo(releaseDateStr: string): string {
	const release = new Date(releaseDateStr + 'T00:00:00');
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const diffDays = Math.floor((today.getTime() - release.getTime()) / 86400000);
	if (diffDays <= 0) return 'Today';
	if (diffDays === 1) return 'Yesterday';
	return `${diffDays} days ago`;
}

// ── AirtimeTab ────────────────────────────────────────────────────────────────

export class AirtimeTab {
	private container: HTMLElement;
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private readingDataManager: ReadingDataManager;
	private onCountChange?: (count: number) => void;

	// Sub-tab state
	currentSubTab: 'tracker' | 'history' | 'maybe' = 'tracker';

	// Selection mode
	selectionMode = false;
	selectedItems: Set<string> = new Set(); // AirtimeEntry ids

	// Search
	searchQuery = '';

	constructor(
		container: HTMLElement,
		plugin: WatchLogPlugin,
		dataManager: DataManager,
		onCountChange?: (count: number) => void,
	) {
		this.container = container;
		this.plugin = plugin;
		this.dataManager = dataManager;
		this.readingDataManager = plugin.readingDataManager;
		this.onCountChange = onCountChange;
	}

	/**
	 * Normalizes an airtime entry into a renderable subject, resolving the
	 * underlying watchlist title or reading item. Returns null for orphan entries.
	 */
	private resolveEntry(entry: AirtimeEntry): ResolvedUpcoming | null {
		if (entry.source === 'reading') {
			const kind = entry.readingKind ?? 'book';
			const item: Book | Manga | undefined =
				kind === 'book' ? this.readingDataManager.getBook(entry.titleId) : this.readingDataManager.getManga(entry.titleId);
			if (!item) return null;
			const totalUnits = entry.totalEpisodes ?? item.totalChapters ?? 0;
			return {
				source: 'reading',
				id: item.id,
				title: item.title,
				typeName: kind === 'book' ? 'Book' : 'Manga',
				typeColor: this.plugin.settings.coloredTypeBadges
					? getReadingTypeColor(kind, this.plugin.settings)
					: null,
				externalLink: item.externalLink ?? '',
				isSingle: totalUnits <= 1,
				totalUnits,
				unitNoun: 'chapter',
				unitNounCap: 'Chapter',
				groupNounCap: 'Volume',
				nextLabel: 'Reading next',
				planStatus: 'Plan to Read',
			};
		}

		const title = this.dataManager.getTitle(entry.titleId);
		if (!title) return null;
		const typeDef = this.plugin.settings.types.find((t) => t.name === title.type);
		const colored = this.plugin.settings.coloredTypeBadges;
		return {
			source: 'watchlist',
			id: title.id,
			title: title.title,
			typeName: title.type,
			typeColor: colored && typeDef
				? getThemedColor(title.type, typeDef.color, this.plugin.settings.colorTheme)
				: null,
			externalLink: title.externalLink,
			isSingle: title.totalEpisodes <= 1,
			totalUnits: entry.totalEpisodes ?? title.totalEpisodes,
			unitNoun: 'episode',
			unitNounCap: 'Episode',
			groupNounCap: 'Season',
			nextLabel: 'Airing next',
			planStatus: 'Plan to watch',
		};
	}

	/** Returns the count of Due entries in the Maybe list — usable without rendering the tab. */
	static getMaybeDueCount(dataManager: DataManager): number {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const todayStr = today.toISOString().split('T')[0]!;
		return dataManager.getMaybeTitles().filter(
			(mt) => !!mt.releaseDate && mt.releaseDate <= todayStr,
		).length;
	}

	/** Returns the count of Aired/Due entries — usable without rendering the tab. */
	static getAiredDueCount(dataManager: DataManager, readingDataManager?: ReadingDataManager): number {
		const allEntries = dataManager.getAirtimeEntries();
		const titles = dataManager.getTitles();
		const titleMap = new Map(titles.map((t) => [t.id, t]));
		let count = 0;
		for (const entry of allEntries) {
			let isSingle: boolean;
			if (entry.source === 'reading') {
				// Verify the reading item still exists (skip orphans) when we have the manager.
				if (readingDataManager) {
					const kind = entry.readingKind ?? 'book';
					const item = kind === 'book'
						? readingDataManager.getBook(entry.titleId)
						: readingDataManager.getManga(entry.titleId);
					if (!item) continue;
				}
				isSingle = (entry.totalEpisodes ?? 0) <= 1;
			} else {
				const title = titleMap.get(entry.titleId);
				if (!title) continue;
				isSingle = title.totalEpisodes <= 1;
			}
			const cd = getDetailedCountdown(entry.schedule, isSingle, entry.lastAcknowledgedDate);
			if (cd.kind === 'aired' || cd.kind === 'due') count++;
		}
		return count;
	}

	render(): void {
		this.container.empty();
		this.container.addClass('wl-airtime');
		if (this.onCountChange) {
			this.onCountChange(AirtimeTab.getAiredDueCount(this.dataManager, this.readingDataManager) + AirtimeTab.getMaybeDueCount(this.dataManager));
		}
		this.renderInnerTabBar();
		if (this.currentSubTab === 'tracker') {
			this.renderTracker();
		} else if (this.currentSubTab === 'history') {
			this.renderHistory();
		} else {
			this.renderMaybe();
		}
	}

	private renderInnerTabBar(): void {
		const bar = this.container.createDiv({ cls: 'wl-inner-tab-bar' });
		const trackerCount = AirtimeTab.getAiredDueCount(this.dataManager, this.readingDataManager);
		const maybeCount = AirtimeTab.getMaybeDueCount(this.dataManager);
		const tabs: Array<{ key: 'tracker' | 'history' | 'maybe'; label: string; badge: number }> = [
			{ key: 'tracker', label: 'Tracker', badge: trackerCount },
			{ key: 'history', label: 'Log', badge: 0 },
			{ key: 'maybe',   label: 'Maybe',   badge: maybeCount },
		];
		for (const { key, label, badge } of tabs) {
			const text = badge > 0 ? `${label} (${badge})` : label;
			const btn = bar.createEl('button', {
				cls: `wl-inner-tab-btn${this.currentSubTab === key ? ' is-active' : ''}`,
				text,
			});
			btn.addEventListener('click', () => {
				if (this.currentSubTab === key) return;
				this.currentSubTab = key;
				this.selectionMode = false;
				this.selectedItems.clear();
				this.searchQuery = '';
				this.render();
			});
		}
	}

	private renderTracker(): void {
		if (this.plugin.settings.showHintBanners) {
			this.container.createDiv({
				cls: 'wl-cl-draft-banner',
				text: '⚠ All titles with a release date in the future will be automatically marked as "To be released" in Watchlist and added here.',
			});
		}
		this.renderHeader();
		this.renderSearch();
		this.renderCards();
	}

	private renderHistory(): void {
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const todayStr = today.toISOString().split('T')[0]!;

		const cutoff = new Date(today);
		cutoff.setMonth(cutoff.getMonth() - 6);
		const cutoffStr = cutoff.toISOString().split('T')[0]!;

		const pastTitles = this.dataManager.getTitles()
			.filter((t) => !!t.releaseDate && t.releaseDate <= todayStr && t.releaseDate >= cutoffStr)
			.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));

		if (pastTitles.length === 0) {
			this.container.createDiv({ cls: 'wl-empty-state', text: 'No past releases yet.' });
			return;
		}

		const cardsEl = this.container.createDiv({ cls: 'wl-airtime-cards' });
		for (const title of pastTitles) {
			this.renderHistoryCard(cardsEl, title);
		}
	}

	private renderHistoryCard(parent: HTMLElement, title: WatchLogTitle): void {
		const card = parent.createDiv({ cls: 'wl-airtime-card wl-airtime-history-card' });

		const left = card.createDiv({ cls: 'wl-airtime-card-left' });
		left.createDiv({ cls: 'wl-airtime-card-title', text: title.title });

		const metaRow = left.createDiv({ cls: 'wl-airtime-card-meta' });
		const typeDef = this.plugin.settings.types.find((t) => t.name === title.type);
		const colored = this.plugin.settings.coloredTypeBadges;
		const typeBadge = metaRow.createSpan({ cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain', text: title.type });
		if (colored && typeDef) typeBadge.style.backgroundColor = getThemedColor(title.type, typeDef.color, this.plugin.settings.colorTheme);
		if (title.releaseDate) {
			metaRow.createSpan({ cls: 'wl-airtime-schedule', text: title.releaseDate });
		}

		const right = card.createDiv({ cls: 'wl-airtime-card-right wl-airtime-history-right' });
		if (title.releaseDate) {
			right.createDiv({ cls: 'wl-airtime-pill wl-airtime-pill-aired', text: formatDaysAgo(title.releaseDate) });
		}

		const globeBtn = right.createEl('button', { cls: 'wl-airtime-action-btn', text: '🌐' });
		globeBtn.title = 'Open page';
		globeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (title.externalLink) activeWindow.open(title.externalLink, '_blank');
			else new Notice('No external link set for this title.');
		});

		const deleteBtn = right.createEl('button', { cls: 'wl-airtime-action-btn wl-airtime-action-btn-delete wl-btn-danger', text: '✕' });
		deleteBtn.title = 'Remove from watchlist';
		deleteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			new ConfirmModal(this.plugin.app, `Remove "${title.title}" from Watchlist?`, () => {
				void this.dataManager.removeTitle(title.id).then(() => this.render());
			}).open();
		});
	}

	private renderMaybe(): void {
		const maybeTitles = this.dataManager.getMaybeTitles();

		const headerEl = this.container.createDiv({ cls: 'wl-list-header' });
		if (maybeTitles.length > 0) {
			headerEl.createSpan({ cls: 'wl-list-count', text: String(maybeTitles.length) });
		}
		const controls = headerEl.createDiv({ cls: 'wl-header-controls' });
		// Add pinned to the far right of the toolbar row
		const rightGroup = controls.createDiv({ cls: 'wl-header-controls-right' });
		const addBtnWrap = rightGroup.createDiv({ cls: 'wl-add-btn-wrap' });
		const addBtn = addBtnWrap.createEl('button', { cls: 'wl-add-btn wl-btn-success', text: '+ add' });
		addBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			new MaybeAddModal(this.plugin.app, this.plugin, this.dataManager, () => this.render()).open();
		});

		if (maybeTitles.length === 0) {
			this.container.createDiv({ cls: 'wl-empty-state', text: 'No "Maybe" titles yet. Click + Add to track something you\'re considering.' });
			return;
		}

		const today = new Date();
		today.setHours(0, 0, 0, 0);

		const cardsEl = this.container.createDiv({ cls: 'wl-airtime-cards' });
		const sorted = [...maybeTitles].sort((a, b) => {
			const ra = a.releaseDate ?? '';
			const rb = b.releaseDate ?? '';
			if (!ra && !rb) return a.dateAdded.localeCompare(b.dateAdded);
			if (!ra) return 1;
			if (!rb) return -1;
			return ra.localeCompare(rb);
		});

		for (const mt of sorted) {
			this.renderMaybeCard(cardsEl, mt, today);
		}
	}

	private renderMaybeCard(parent: HTMLElement, mt: MaybeTitle, today: Date): void {
		const schedule: AirtimeSchedule = { recurrence: 'once', releaseDate: mt.releaseDate ?? undefined };
		const countdown = getDetailedCountdown(schedule, true);

		let cardCls = 'wl-maybe-card';
		if (countdown.kind === 'due') cardCls += ' wl-airtime-card-aired is-due';

		const card = parent.createDiv({ cls: cardCls });

		// Left: title + type badge
		const left = card.createDiv({ cls: 'wl-maybe-card-left' });

		left.createSpan({ cls: 'wl-maybe-card-title', text: mt.title });

		const typeDef = this.plugin.settings.types.find((t) => t.name === mt.type);
		const colored = this.plugin.settings.coloredTypeBadges;
		const typeBadge = left.createSpan({ cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain', text: mt.type });
		if (colored && typeDef) typeBadge.style.backgroundColor = getThemedColor(mt.type, typeDef.color, this.plugin.settings.colorTheme);

		// Right: countdown pill + IMDb link + delete
		const pillClsMap: Record<DetailedCountdown['kind'], string> = {
			'today-before': 'wl-airtime-pill wl-airtime-pill-today-series',
			'future': 'wl-airtime-pill wl-airtime-pill-days',
			'aired': 'wl-airtime-pill wl-airtime-pill-aired',
			'due': 'wl-airtime-pill wl-airtime-pill-due',
		};
		const pillCls = countdown.kind === 'future' && countdown.label === 'Tomorrow'
			? 'wl-airtime-pill wl-airtime-pill-tomorrow'
			: pillClsMap[countdown.kind];
		const right = card.createDiv({ cls: 'wl-maybe-card-right' });
		right.createDiv({ cls: pillCls, text: mt.releaseDate ? countdown.label : '—' });
		const globeBtn = right.createEl('button', { cls: 'wl-airtime-action-btn', text: '🌐' });
		globeBtn.title = 'Open page';
		globeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (mt.externalLink) activeWindow.open(mt.externalLink, '_blank');
			else new Notice('No external link set.');
		});
		const deleteBtn = right.createEl('button', { cls: 'wl-airtime-action-btn wl-airtime-action-btn-delete wl-btn-danger', text: '✕' });
		deleteBtn.title = 'Remove from maybe';
		deleteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			new ConfirmModal(this.plugin.app, `Remove "${mt.title}" from Maybe?`, () => {
				void this.dataManager.removeMaybeTitle(mt.id).then(() => this.render());
			}).open();
		});
	}

	private renderSearch(): void {
		const searchWrap = this.container.createDiv({ cls: 'wl-search-wrap' });
		const input = searchWrap.createEl('input', {
			cls: 'wl-search-input',
			attr: { type: 'text', placeholder: 'Search upcoming...' },
		});
		input.value = this.searchQuery;
		let debounceTimer: number | null = null;
		input.addEventListener('input', () => {
			this.searchQuery = input.value;
			if (debounceTimer !== null) window.clearTimeout(debounceTimer);
			debounceTimer = window.setTimeout(() => {
				debounceTimer = null;
				this.rerenderCards();
			}, 250);
		});
	}

	private rerenderCards(): void {
		const existing = this.container.querySelector('.wl-airtime-cards');
		const emptyState = this.container.querySelector('.wl-empty-state');
		if (existing) existing.remove();
		if (emptyState) emptyState.remove();
		this.renderCards();
	}

	// ── Header ────────────────────────────────────────────────────────────────────

	private renderHeader(): void {
		const header = this.container.createDiv({ cls: 'wl-list-header' });

		// Entry count (only entries that still resolve to a watchlist or reading item)
		const count = this.dataManager.getAirtimeEntries().filter(
			(e) => this.resolveEntry(e) !== null,
		).length;
		if (count > 0) {
			header.createSpan({ cls: 'wl-list-count', text: String(count) });
		}

		const controls = header.createDiv({ cls: 'wl-header-controls' });

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
					for (const entry of this.dataManager.getAirtimeEntries()) {
						this.selectedItems.add(entry.id);
					}
				}
				this.render();
			});
		}

		// Select + add pinned to the far right of the toolbar row
		const rightGroup = controls.createDiv({ cls: 'wl-header-controls-right' });

		// Selection mode toggle button
		const selBtn = rightGroup.createEl('button', {
			cls: `wl-btn wl-btn-sm${this.selectionMode ? ' is-active' : ''}`,
			text: 'Select',
		});
		selBtn.addEventListener('click', () => {
			this.selectionMode = !this.selectionMode;
			this.selectedItems.clear();
			this.render();
		});

		const addBtnWrap = rightGroup.createDiv({ cls: 'wl-add-btn-wrap' });
		const addBtn = addBtnWrap.createEl('button', { cls: 'wl-add-btn wl-btn-success', text: '+ add' });
		addBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openAddFlow();
		});
	}

	private renderActionBar(parent: HTMLElement): void {
		const bar = parent.createDiv({ cls: 'wl-action-bar' });

		// Delete — removes selected entries from Upcoming
		const deleteBtn = bar.createEl('button', {
			cls: 'wl-group-action-btn wl-group-action-btn-delete wl-btn-danger',
			text: '✕',
		});
		deleteBtn.title = 'Remove from upcoming';
		deleteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const count = this.selectedItems.size;
			new ConfirmModal(
				this.plugin.app,
				`Remove ${count} selected item${count !== 1 ? 's' : ''} from Upcoming? This cannot be undone.`,
				() => {
					void (async () => {
						await this.dataManager.removeAirtimeEntriesBatch(Array.from(this.selectedItems));
						this.selectedItems.clear();
						this.render();
					})();
				},
			).open();
		});
	}

	// ── Add flow ──────────────────────────────────────────────────────────────────

	private openAddFlow(): void {
		const entries = this.dataManager.getAirtimeEntries();
		// Already-added keys, kept separate per source so a watchlist id and a
		// reading id that happen to match don't shadow each other.
		const addedWatch = new Set(entries.filter((e) => e.source !== 'reading').map((e) => e.titleId));
		const addedReading = new Set(entries.filter((e) => e.source === 'reading').map((e) => e.titleId));

		const items: UpcomingFinderItem[] = [];
		for (const t of this.dataManager.getTitles()) {
			if (addedWatch.has(t.id)) continue;
			items.push({ source: 'watchlist', id: t.id, title: t.title, typeLabel: t.type });
		}
		for (const b of this.readingDataManager.getBooks()) {
			if (addedReading.has(b.id)) continue;
			items.push({ source: 'reading', kind: 'book', id: b.id, title: b.title, typeLabel: 'Book' });
		}
		for (const m of this.readingDataManager.getMangaList()) {
			if (addedReading.has(m.id)) continue;
			items.push({ source: 'reading', kind: 'manga', id: m.id, title: m.title, typeLabel: 'Manga' });
		}

		if (this.dataManager.getTitles().length === 0 &&
			this.readingDataManager.getBooks().length === 0 &&
			this.readingDataManager.getMangaList().length === 0) {
			new Notice('No titles in your watchlog or reading library yet.');
			return;
		}
		if (items.length === 0) {
			new Notice('Everything is already in upcoming.');
			return;
		}

		new UpcomingFinderModal(this.plugin.app, items, (item) => {
			if (item.source === 'reading') {
				const kind = item.kind ?? 'book';
				const readItem = kind === 'book'
					? this.readingDataManager.getBook(item.id)
					: this.readingDataManager.getManga(item.id);
				if (readItem) this.startAddWithReading(readItem, kind);
			} else {
				const title = this.dataManager.getTitle(item.id);
				if (title) void this.startAddWithTitle(title);
			}
		}).open();
	}

	private startAddWithReading(item: Book | Manga, kind: 'book' | 'manga'): void {
		const prefilled: AirtimeSchedule | null =
			item.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(item.releaseDate)
				? { recurrence: 'once', releaseDate: item.releaseDate }
				: null;

		new ReadingScheduleModal(
			this.plugin.app,
			item,
			kind,
			prefilled,
			null,
			null,
			null,
			null,
			async (schedule, volume, chapter, totalVolumes, totalChapters) => {
				const entry: AirtimeEntry = {
					id: this.dataManager.generateReadingAirtimeId(item.id),
					titleId: item.id,
					source: 'reading',
					readingKind: kind,
					schedule,
					currentSeason: volume ?? undefined,
					currentEpisode: chapter ?? undefined,
					totalSeasons: totalVolumes ?? undefined,
					totalEpisodes: totalChapters ?? undefined,
					dateAdded: new Date().toISOString(),
				};
				await this.dataManager.addAirtimeEntry(entry);
				await this.syncReadingItemFromSchedule(item.id, kind, schedule, totalVolumes, totalChapters);
				this.render();
			},
		).open();
	}

	/** Pushes schedule-derived totals / release date back onto the reading item. */
	private async syncReadingItemFromSchedule(
		itemId: string,
		kind: 'book' | 'manga',
		schedule: AirtimeSchedule,
		totalVolumes: number | null,
		totalChapters: number | null,
	): Promise<void> {
		if (kind === 'book') {
			const b = this.readingDataManager.getBook(itemId);
			if (!b) return;
			let changed = false;
			if (totalChapters !== null && totalChapters !== b.totalChapters) { b.totalChapters = totalChapters; changed = true; }
			// Only write a future 'once' date back (drives auto "To be released"); a
			// past/due date is left alone so the just-added entry isn't auto-removed.
			if (schedule.recurrence === 'once' && isReleaseDateFuture(schedule.releaseDate)) {
				const newDate = schedule.releaseDate ?? null;
				if (b.releaseDate !== newDate) { b.releaseDate = newDate; changed = true; }
			}
			if (changed) await this.readingDataManager.updateBook(b);
		} else {
			const m = this.readingDataManager.getManga(itemId);
			if (!m) return;
			let changed = false;
			if (totalChapters !== null && totalChapters !== m.totalChapters) { m.totalChapters = totalChapters; changed = true; }
			if (totalVolumes !== null && totalVolumes !== m.totalVolumes) { m.totalVolumes = totalVolumes; changed = true; }
			// Only write a future 'once' date back (drives auto "To be released"); a
			// past/due date is left alone so the just-added entry isn't auto-removed.
			if (schedule.recurrence === 'once' && isReleaseDateFuture(schedule.releaseDate)) {
				const newDate = schedule.releaseDate ?? null;
				if (m.releaseDate !== newDate) { m.releaseDate = newDate; changed = true; }
			}
			if (changed) await this.readingDataManager.updateManga(m);
		}
	}

	/**
	 * On a single-release tick, revert the underlying item's auto "To be released"
	 * status back to its plan status (watchlist title or reading item).
	 */
	private async revertToBeReleasedStatus(entry: AirtimeEntry, r: ResolvedUpcoming): Promise<void> {
		if (r.source === 'reading') {
			const kind = entry.readingKind ?? 'book';
			if (kind === 'book') {
				const b = this.readingDataManager.getBook(entry.titleId);
				if (b && b.status === 'To be released') { b.status = 'Plan to Read'; await this.readingDataManager.updateBook(b); }
			} else {
				const m = this.readingDataManager.getManga(entry.titleId);
				if (m && m.status === 'To be released') { m.status = 'Plan to Read'; await this.readingDataManager.updateManga(m); }
			}
		} else {
			const t = this.dataManager.getTitle(entry.titleId);
			if (t && t.status === 'To be released') { t.status = 'Plan to watch'; await this.dataManager.updateTitle(t); }
		}
	}

	private async startAddWithTitle(title: WatchLogTitle): Promise<void> {
		let prefilled: AirtimeSchedule | null = null;

		// Try Jikan auto-fill for Anime with a known malId
		if (title.type === 'Anime' && title.malId) {
			try {
				const sched = await this.plugin.apiService.getAnimeScheduleByMalId(title.malId);
				if (sched) {
					prefilled = { recurrence: 'weekly', dayOfWeek: sched.dayOfWeek, releaseTime: sched.time };
					new Notice('Schedule auto-filled from myanimelist.');
				}
			} catch {
				// ignore — fields stay empty for manual entry
			}
		}

		// Pre-fill with existing releaseDate
		if (!prefilled && title.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(title.releaseDate)) {
			prefilled = { recurrence: 'once', releaseDate: title.releaseDate };
		}

		new AirtimeScheduleModal(
			this.plugin.app,
			title,
			prefilled,
			null,
			null,
			null,
			null,
			async (schedule, season, episode, totalSeasons, totalEpisodes) => {
				const entry: AirtimeEntry = {
					id: this.dataManager.generateAirtimeId(title.id),
					titleId: title.id,
					schedule,
					currentSeason: season ?? undefined,
					currentEpisode: episode ?? undefined,
					totalSeasons: totalSeasons ?? undefined,
					totalEpisodes: totalEpisodes ?? undefined,
					dateAdded: new Date().toISOString(),
				};
				await this.dataManager.addAirtimeEntry(entry);

				// Sync back to Watchlist title
				const t = this.dataManager.getTitle(title.id);
				if (t) {
					let changed = false;
					if (totalEpisodes !== null && totalEpisodes !== t.totalEpisodes) {
						t.totalEpisodes = totalEpisodes;
						changed = true;
					}
					// Sync releaseDate when schedule is 'once'
					if (schedule.recurrence === 'once') {
						const newDate = schedule.releaseDate ?? null;
						if (t.releaseDate !== newDate) {
							t.releaseDate = newDate;
							changed = true;
						}
					}
					if (changed) await this.dataManager.updateTitle(t);
				}

				this.render();
			},
		).open();
	}

	// ── Card list ─────────────────────────────────────────────────────────────────

	private renderCards(): void {
		const allEntries = this.dataManager.getAirtimeEntries();

		if (allEntries.length === 0) {
			this.container.createDiv({
				cls: 'wl-empty-state',
				text: 'No titles in Upcoming. Click + Add to track airing schedules.',
			});
			return;
		}

		const q = this.searchQuery.trim().toLowerCase();

		const cardData = allEntries
			.map((entry) => {
				const r = this.resolveEntry(entry);
				if (!r) return null;
				if (q && !r.title.toLowerCase().includes(q)) return null;
				const countdown = getDetailedCountdown(entry.schedule, r.isSingle, entry.lastAcknowledgedDate);
				return { entry, r, countdown };
			})
			.filter(
				(d): d is { entry: AirtimeEntry; r: ResolvedUpcoming; countdown: DetailedCountdown } =>
					d !== null,
			)
			.sort((a, b) => {
				// aired/due → first; today → second; future → last
				const rankKind = (k: DetailedCountdown['kind']) =>
					k === 'aired' || k === 'due' ? 0 : k === 'today-before' ? 1 : 2;
				const ra = rankKind(a.countdown.kind);
				const rb = rankKind(b.countdown.kind);
				if (ra !== rb) return ra - rb;
				return a.countdown.daysUntil - b.countdown.daysUntil;
			});

		if (cardData.length === 0) {
			this.container.createDiv({ cls: 'wl-empty-state', text: 'No upcoming titles match your search.' });
			return;
		}

		const cardsEl = this.container.createDiv({ cls: 'wl-airtime-cards' });
		for (const { entry, r, countdown } of cardData) {
			this.renderCard(cardsEl, entry, r, countdown);
		}
	}

	// ── Single card ───────────────────────────────────────────────────────────────

	private renderCard(
		parent: HTMLElement,
		entry: AirtimeEntry,
		r: ResolvedUpcoming,
		countdown: DetailedCountdown,
	): void {
		const isMovie = r.isSingle;
		const totalEps = r.totalUnits;
		const isFinalEpisode =
			!isMovie &&
			entry.currentEpisode !== undefined &&
			totalEps > 0 &&
			entry.currentEpisode >= totalEps;

		const showTick =
			(isMovie && countdown.kind === 'due') ||
			(!isMovie && countdown.kind === 'aired');

		// Card CSS
		let cardCls = 'wl-airtime-card';
		if (countdown.kind === 'aired' || countdown.kind === 'due') {
			cardCls += ' wl-airtime-card-aired';
		}
		if (countdown.kind === 'aired') cardCls += ' is-aired';
		if (countdown.kind === 'due') cardCls += ' is-due';
		if (this.selectionMode && this.selectedItems.has(entry.id)) {
			cardCls += ' wl-row-selected';
		}
		const card = parent.createDiv({ cls: cardCls });

		// Selection checkbox
		if (this.selectionMode) {
			const cb = card.createEl('input', { attr: { type: 'checkbox' } });
			cb.addClass('wl-airtime-select-cb');
			cb.checked = this.selectedItems.has(entry.id);
			cb.addEventListener('click', (e) => e.stopPropagation());
			cb.addEventListener('change', () => {
				if (cb.checked) { this.selectedItems.add(entry.id); }
				else { this.selectedItems.delete(entry.id); }
				this.render();
			});
			card.addEventListener('click', () => {
				if (this.selectedItems.has(entry.id)) { this.selectedItems.delete(entry.id); }
				else { this.selectedItems.add(entry.id); }
				this.render();
			});
		}

		// ── Left ──────────────────────────────────────────────────────────────────
		const left = card.createDiv({ cls: 'wl-airtime-card-left' });
		left.createDiv({ cls: 'wl-airtime-card-title', text: r.title });

		// Type badge + schedule string, above the episode badge. Reading entries
		// render a plain (theme-driven) badge; watch entries may be colored.
		const metaRow = left.createDiv({ cls: 'wl-airtime-card-meta' });
		const typeBadge = metaRow.createSpan({
			cls: r.typeColor ? 'wl-badge wl-badge-sm' : 'wl-badge-plain',
			text: r.typeName,
		});
		if (r.typeColor) typeBadge.style.backgroundColor = r.typeColor;
		metaRow.createSpan({ cls: 'wl-airtime-schedule', text: getAirtimeScheduleString(entry.schedule) });

		// Progress badge — only for multi-part titles (series / manga), below meta row
		if (!isMovie && (entry.currentSeason !== undefined || entry.currentEpisode !== undefined)) {
			const badgeParts: string[] = [];
			if (entry.currentSeason !== undefined) badgeParts.push(`${r.groupNounCap} ${entry.currentSeason}`);
			if (entry.currentEpisode !== undefined) badgeParts.push(`${r.unitNounCap} ${entry.currentEpisode}`);
			badgeParts.push(r.nextLabel);
			const badgeCls = isFinalEpisode
				? 'wl-ep-badge wl-ep-badge-final'
				: 'wl-ep-badge';
			left.createDiv({ cls: badgeCls, text: badgeParts.join(' · ') });
		}

		// ── Right ─────────────────────────────────────────────────────────────────
		const right = card.createDiv({ cls: 'wl-airtime-card-right' });

		// Countdown pill
		const pillClsMap: Record<DetailedCountdown['kind'], string> = {
			'today-before': 'wl-airtime-pill wl-airtime-pill-today-series',
			'future':       'wl-airtime-pill wl-airtime-pill-days',
			'aired':        'wl-airtime-pill wl-airtime-pill-aired',
			'due':          'wl-airtime-pill wl-airtime-pill-due',
		};
		// "Tomorrow" within 'future' gets its own style
		const pillCls =
			countdown.kind === 'future' && countdown.label === 'Tomorrow'
				? 'wl-airtime-pill wl-airtime-pill-tomorrow'
				: pillClsMap[countdown.kind];
		right.createDiv({ cls: pillCls, text: countdown.label });

		// Action buttons
		const actions = right.createDiv({ cls: 'wl-airtime-actions' });

		// Green tick button (shown after airtime/release passes)
		if (showTick) {
			const tickBtn = actions.createEl('button', {
				cls: 'wl-airtime-action-btn wl-airtime-action-btn-tick',
				text: '✓',
			});
			tickBtn.title = isMovie ? 'Mark as released' : (isFinalEpisode ? `Final ${r.unitNoun} — mark done` : `Mark ${r.unitNoun} as aired`);
			tickBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				const confirmMsg = isMovie
					? `"${r.title}" has been released.\nRemove from Upcoming and set status to ${r.planStatus}?`
					: isFinalEpisode
						? `Final ${r.unitNoun} of "${r.title}".\nRemove from Upcoming? (status unchanged)`
						: `${r.unitNounCap} ${entry.currentEpisode ?? ''} of "${r.title}".\nMark and track next ${r.unitNoun}?`;

				new ConfirmModal(this.plugin.app, confirmMsg, () => {
					void (async () => {
						const today = new Date();
						const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
						// Prevent scheduler double-fire for the same airtime
						this.plugin.markAirtimeHandled(`${entry.id}-${todayStr}`);

						if (isMovie) {
							await this.dataManager.removeAirtimeEntry(entry.id);
							await this.revertToBeReleasedStatus(entry, r);
						} else if (isFinalEpisode) {
							// Final unit: remove from Upcoming, do NOT change status
							await this.dataManager.removeAirtimeEntry(entry.id);
						} else {
							// Non-final: increment the unit (episode/chapter) and record
							// the acknowledgement date so the countdown resets immediately.
							entry.currentEpisode = (entry.currentEpisode ?? 1) + 1;
							entry.lastAcknowledgedDate = todayStr;
							await this.dataManager.updateAirtimeEntry(entry);
						}
						this.render();
					})();
				}).open();
			});
		}

		// Globe — open external page
		const globeBtn = actions.createEl('button', { cls: 'wl-airtime-action-btn', text: '🌐' });
		globeBtn.title = 'Open page';
		globeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (r.externalLink) {
				activeWindow.open(r.externalLink, '_blank');
			} else {
				new Notice('No external link set for this title.');
			}
		});

		// Edit — open the schedule modal matching the entry's source
		const editBtn = actions.createEl('button', { cls: 'wl-airtime-action-btn', text: '✏' });
		editBtn.title = 'Edit schedule';
		editBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (r.source === 'reading') {
				this.openEditReadingSchedule(entry);
			} else {
				this.openEditWatchSchedule(entry);
			}
		});

		// Delete — with confirmation
		const deleteBtn = actions.createEl('button', {
			cls: 'wl-airtime-action-btn wl-airtime-action-btn-delete wl-btn-danger',
			text: '✕',
		});
		deleteBtn.title = 'Remove from upcoming';
		deleteBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			new ConfirmModal(this.plugin.app, `Remove "${r.title}" from Upcoming?`, () => {
				void this.dataManager.removeAirtimeEntry(entry.id).then(() => this.render());
			}).open();
		});
	}

	private openEditWatchSchedule(entry: AirtimeEntry): void {
		const title = this.dataManager.getTitle(entry.titleId);
		if (!title) return;
		new AirtimeScheduleModal(
			this.plugin.app,
			title,
			{ ...entry.schedule },
			entry.currentSeason ?? null,
			entry.currentEpisode ?? null,
			entry.totalSeasons ?? null,
			entry.totalEpisodes ?? null,
			async (schedule, season, episode, totalSeasons, totalEpisodes) => {
				entry.schedule = schedule;
				entry.currentSeason = season ?? undefined;
				entry.currentEpisode = episode ?? undefined;
				entry.totalSeasons = totalSeasons ?? undefined;
				entry.totalEpisodes = totalEpisodes ?? undefined;
				await this.dataManager.updateAirtimeEntry(entry);

				// Sync back to Watchlist title
				const currentTitle = this.dataManager.getTitle(entry.titleId);
				if (currentTitle) {
					let changed = false;
					if (totalEpisodes !== null && totalEpisodes !== currentTitle.totalEpisodes) {
						currentTitle.totalEpisodes = totalEpisodes;
						changed = true;
					}
					// Sync releaseDate when schedule is 'once'
					if (schedule.recurrence === 'once') {
						const newDate = schedule.releaseDate ?? null;
						if (currentTitle.releaseDate !== newDate) {
							currentTitle.releaseDate = newDate;
							changed = true;
						}
					}
					if (changed) await this.dataManager.updateTitle(currentTitle);
				}

				this.render();
			},
		).open();
	}

	private openEditReadingSchedule(entry: AirtimeEntry): void {
		const kind = entry.readingKind ?? 'book';
		const item: Book | Manga | undefined =
			kind === 'book' ? this.readingDataManager.getBook(entry.titleId) : this.readingDataManager.getManga(entry.titleId);
		if (!item) return;
		new ReadingScheduleModal(
			this.plugin.app,
			item,
			kind,
			{ ...entry.schedule },
			entry.currentSeason ?? null,   // volume
			entry.currentEpisode ?? null,  // chapter
			entry.totalSeasons ?? null,    // total volumes
			entry.totalEpisodes ?? null,   // total chapters
			async (schedule, volume, chapter, totalVolumes, totalChapters) => {
				entry.schedule = schedule;
				entry.currentSeason = volume ?? undefined;
				entry.currentEpisode = chapter ?? undefined;
				entry.totalSeasons = totalVolumes ?? undefined;
				entry.totalEpisodes = totalChapters ?? undefined;
				await this.dataManager.updateAirtimeEntry(entry);
				await this.syncReadingItemFromSchedule(entry.titleId, kind, schedule, totalVolumes, totalChapters);
				this.render();
			},
		).open();
	}
}

// ── AirtimeScheduleModal ──────────────────────────────────────────────────────

class AirtimeScheduleModal extends Modal {
	private title: WatchLogTitle;
	private schedule: AirtimeSchedule;
	private currentSeason: number | null;
	private currentEpisode: number | null;
	private totalSeasons: number | null;
	private totalEpisodes: number | null;
	private onSave: (
		schedule: AirtimeSchedule,
		season: number | null,
		episode: number | null,
		totalSeasons: number | null,
		totalEpisodes: number | null,
	) => Promise<void>;

	constructor(
		app: App,
		title: WatchLogTitle,
		existingSchedule: AirtimeSchedule | null,
		currentSeason: number | null,
		currentEpisode: number | null,
		totalSeasons: number | null,
		totalEpisodes: number | null,
		onSave: (
			schedule: AirtimeSchedule,
			season: number | null,
			episode: number | null,
			totalSeasons: number | null,
			totalEpisodes: number | null,
		) => Promise<void>,
	) {
		super(app);
		this.title = title;
		const isMovie = title.totalEpisodes <= 1;
		this.schedule = existingSchedule
			? { ...existingSchedule }
			: { recurrence: isMovie ? 'once' : 'weekly' };
		// Pre-fill releaseDate from title if the schedule doesn't have one yet
		if (!this.schedule.releaseDate && title.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(title.releaseDate)) {
			this.schedule.releaseDate = title.releaseDate;
		}
		this.currentSeason = currentSeason;
		this.currentEpisode = currentEpisode;
		// Pre-fill totalSeasons from title.seasons.length if not yet set
		this.totalSeasons = totalSeasons ?? (title.seasons.length > 0 ? title.seasons.length : null);
		// Pre-fill totalEpisodes from title.totalEpisodes if not yet set
		this.totalEpisodes = totalEpisodes ?? (title.totalEpisodes > 0 ? title.totalEpisodes : null);
		this.onSave = onSave;
	}

	onOpen(): void {
		this.titleEl.setText('Set schedule');
		this.contentEl.addClass('wl-add-modal');
		this.renderForm();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/**
	 * Converts a local HH:MM time string to its JST (UTC+9) equivalent.
	 * Accounts for your local UTC offset so DST is handled correctly.
	 */
	private localHHMMtoJST(localHHMM: string): string {
		if (!localHHMM || !/^\d{2}:\d{2}$/.test(localHHMM)) return '—';
		const [hStr, mStr] = localHHMM.split(':');
		const h = parseInt(hStr ?? '0');
		const m = parseInt(mStr ?? '0');
		// Build a Date for today at the given local time
		const now = new Date();
		const local = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
		// .getTime() is UTC epoch; add 9h for JST
		const jstMs = local.getTime() + 9 * 60 * 60 * 1000;
		const jst = new Date(jstMs);
		// Format in UTC (we already added the JST offset)
		const jh = jst.getUTCHours().toString().padStart(2, '0');
		const jm = jst.getUTCMinutes().toString().padStart(2, '0');
		return `${jh}:${jm}`;
	}

	private renderForm(): void {
		this.contentEl.empty();
		this.contentEl.addClass('wl-add-modal');
		const content = this.contentEl;
		const isMovie = this.title.totalEpisodes <= 1;

		const makeRow = (label: string): HTMLElement => {
			const row = content.createDiv({ cls: 'wl-modal-row' });
			row.createSpan({ cls: 'wl-modal-label', text: label });
			return row;
		};

		/** Renders a time input (24h text, e.g. "14:50") + live JST converter label */
		const makeTimeRow = (label: string, parent: HTMLElement): HTMLInputElement => {
			const row = parent.createDiv({ cls: 'wl-modal-row wl-modal-row-mt' });
			row.createSpan({ cls: 'wl-modal-label', text: label });
			const inp = row.createEl('input', {
				cls: 'wl-modal-input wl-time-input',
				attr: { type: 'text', placeholder: 'Hh:mm', maxlength: '5' },
			});
			inp.value = this.schedule.releaseTime ?? '';

			const jstLabel = row.createSpan({ cls: 'wl-jst-clock' });
			const updateJST = (): void => {
				jstLabel.textContent = inp.value
					? `JST ${this.localHHMMtoJST(inp.value)}`
					: 'JST —';
			};
			updateJST();
			inp.addEventListener('input', () => {
				const val = inp.value.trim();
				this.schedule.releaseTime = val || undefined;
				updateJST();
			});
			return inp;
		};

		if (isMovie) {
			// Movie: only a release date (+ optional time)
			const dateRow = makeRow('Release date');
			const dateInput = dateRow.createEl('input', {
    			cls: 'wl-modal-input',
    			attr: { type: 'text', placeholder: 'Dd/mm/yyyy', maxlength: '10' },
			});
			dateInput.value = this.schedule.releaseDate 
   				 ? this.schedule.releaseDate.split('-').reverse().join('/') 
    			: '';
			dateInput.addEventListener('change', () => {
				const parsed = parseDateInput(dateInput.value);
				if (parsed) {
					this.schedule.recurrence = 'once';
					this.schedule.releaseDate = parsed;
				}
			});

			makeTimeRow('Time (optional)', content);
		} else {
			// Series/Anime: recurrence + extra fields
			const recRow = makeRow('Recurrence');
			const recSelect = recRow.createEl('select', { cls: 'wl-select' });
			const recOptions: Array<[AirtimeRecurrence, string]> = [
				['once', 'Once'],
				['daily', 'Daily'],
				['weekly', 'Weekly'],
				['monthly', 'Monthly'],
			];
			for (const [val, label] of recOptions) {
				const opt = recSelect.createEl('option', { text: label, value: val });
				if (val === this.schedule.recurrence) opt.selected = true;
			}

			const extraEl = content.createDiv();

			const renderExtra = (): void => {
				extraEl.empty();
				const rec = this.schedule.recurrence;

				if (rec === 'once') {
					const r = extraEl.createDiv({ cls: 'wl-modal-row' });
					r.createSpan({ cls: 'wl-modal-label', text: 'Date' });
					const inp = r.createEl('input', {
    					cls: 'wl-modal-input',
    					attr: { type: 'text', placeholder: 'Dd/mm/yyyy', maxlength: '10' },
					});
					inp.value = this.schedule.releaseDate 
    					? this.schedule.releaseDate.split('-').reverse().join('/') 
    					: '';
					inp.addEventListener('change', () => {
						const parsed = parseDateInput(inp.value);
						if (parsed) {
							this.schedule.releaseDate = parsed;
						}
					});
				}

				if (rec === 'weekly') {
					const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
					const r = extraEl.createDiv({ cls: 'wl-modal-row' });
					r.createSpan({ cls: 'wl-modal-label', text: 'Day of week' });
					const daySelect = r.createEl('select', { cls: 'wl-select' });
					DAYS.forEach((d, i) => {
						const opt = daySelect.createEl('option', { text: d, value: String(i) });
						if (i === (this.schedule.dayOfWeek ?? 6)) opt.selected = true;
					});
					daySelect.addEventListener('change', () => {
						this.schedule.dayOfWeek = parseInt(daySelect.value);
					});
				}

				if (rec === 'monthly') {
					const r = extraEl.createDiv({ cls: 'wl-modal-row' });
					r.createSpan({ cls: 'wl-modal-label', text: 'Day of month' });
					const inp = r.createEl('input', {
						cls: 'wl-modal-input wl-modal-input-sm',
						attr: { type: 'number', min: '1', max: '31', placeholder: '1' },
					});
					inp.value = String(this.schedule.dayOfMonth ?? 1);
					inp.addEventListener('input', () => { this.schedule.dayOfMonth = parseInt(inp.value) || 1; });
				}

				// Time field with live JST converter
				makeTimeRow('Time (HH:MM)', extraEl);
			};

			recSelect.addEventListener('change', () => {
				this.schedule.recurrence = recSelect.value as AirtimeRecurrence;
				renderExtra();
			});
			renderExtra();

			// ── Current season + episode ─────────────────────────────────────────────
			const seasonRow = makeRow('Current season');
			const seasonInput = seasonRow.createEl('input', {
				cls: 'wl-modal-input wl-modal-input-sm',
				attr: { type: 'number', min: '1', placeholder: 'E.g. 2' },
			});
			if (this.currentSeason !== null) seasonInput.value = String(this.currentSeason);
			seasonInput.addEventListener('input', () => { this.currentSeason = parseInt(seasonInput.value) || null; });

			const epRow = makeRow('Current episode');
			const epInput = epRow.createEl('input', {
				cls: 'wl-modal-input wl-modal-input-sm',
				attr: { type: 'number', min: '1', placeholder: 'E.g. 7' },
			});
			if (this.currentEpisode !== null) epInput.value = String(this.currentEpisode);
			epInput.addEventListener('input', () => { this.currentEpisode = parseInt(epInput.value) || null; });

			// ── Total seasons + total episodes ───────────────────────────────────────
			const totSeasRow = makeRow('Total seasons');
			const totSeasInput = totSeasRow.createEl('input', {
				cls: 'wl-modal-input wl-modal-input-sm',
				attr: { type: 'number', min: '1', placeholder: 'E.g. 3' },
			});
			if (this.totalSeasons !== null) totSeasInput.value = String(this.totalSeasons);
			totSeasInput.addEventListener('input', () => { this.totalSeasons = parseInt(totSeasInput.value) || null; });

			const totEpRow = makeRow('Total episodes');
			const totEpInput = totEpRow.createEl('input', {
				cls: 'wl-modal-input wl-modal-input-sm',
				attr: { type: 'number', min: '0', placeholder: 'E.g. 13' },
			});
			if (this.totalEpisodes !== null) totEpInput.value = String(this.totalEpisodes);
			totEpInput.addEventListener('input', () => { this.totalEpisodes = parseInt(totEpInput.value) || null; });

			// Static hint note (always visible)
			content.createDiv({
				cls: 'wl-modal-info wl-schedule-hint',
				text: 'Titles with 0 or 1 total episodes will be treated as a single release date, like a movie.',
			});
		}

		// Cancel / Save buttons
		const btnRow = content.createDiv({ cls: 'wl-modal-btn-row' });
		const cancelBtn = btnRow.createEl('button', { cls: 'wl-btn wl-btn-mr', text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const saveBtn = btnRow.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Save' });
		saveBtn.addEventListener('click', () => {
			void (async () => {
				// Validate time format if provided
				if (this.schedule.releaseTime && !/^\d{2}:\d{2}$/.test(this.schedule.releaseTime)) {
					new Notice('Time must be in 24h format: hh:mm (e.g. 14:50)');
					return;
				}
				await this.onSave(
					this.schedule,
					this.currentSeason,
					this.currentEpisode,
					this.totalSeasons,
					this.totalEpisodes,
				);
				this.close();
			})();
		});
	}
}
