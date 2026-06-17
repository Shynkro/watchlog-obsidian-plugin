import { App, Editor, FuzzySuggestModal, MarkdownView, Notice, Platform, Plugin, normalizePath, setIcon } from 'obsidian';
import { DEFAULT_SETTINGS, WatchLogPluginSettings, AirtimeSchedule } from './types';
import type { ReadingData } from './types';
import type { HistoryEntry } from './HistoryManager';
import { DataManager } from './DataManager';
import { ReadingDataManager } from './ReadingDataManager';
import { ApiService } from './ApiService';
import { HistoryManager } from './HistoryManager';
import { PosterService } from './PosterService';
import { WatchLogView, WATCHLOG_VIEW_TYPE, TabName } from './WatchLogView';
import { AirtimeTab } from './AirtimeTab';
import { WatchLogSettingsTab } from './SettingsTab';
import { AddTitleModal } from './AddTitleModal';
import { InsertWidgetModal } from './InsertWidgetModal';
import { WidgetRenderer } from './WidgetRenderer';

export default class WatchLogPlugin extends Plugin {
	settings: WatchLogPluginSettings = DEFAULT_SETTINGS;
	dataManager: DataManager = new DataManager(this);
	readingDataManager: ReadingDataManager = new ReadingDataManager(this);
	apiService: ApiService = new ApiService('', '');
	historyManager: HistoryManager = new HistoryManager(this);
	posterService!: PosterService;
	widgetRenderer?: WidgetRenderer;

	// Runtime import progress state (not persisted)
	importProgress: { current: number; total: number; cancel: () => void } | null = null;

	// Track which entry+day combos have already fired a notification
	private notifiedEntries: Set<string> = new Set();

	// Status-bar Upcoming "due" counter (desktop only; null on mobile)
	private statusBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.dataManager = new DataManager(this);
		await this.dataManager.load();

		// One-time migration: pull legacy reading.json / history.json into data.json so
		// Obsidian Sync replicates them. Must run after data.json is loaded and before the
		// reading/history managers bind to it. Idempotent — gated by a flag in data.json.
		await this.migrateReadingHistory();

		this.dataManager.startWatchingExternalChanges();

		this.apiService = new ApiService(this.settings.omdbApiKey, this.settings.tmdbApiKey, this.settings.googleBooksApiKey);
		this.readingDataManager = new ReadingDataManager(this);
		this.historyManager = new HistoryManager(this);
		this.dataManager.setHistoryManager(this.historyManager);
		this.readingDataManager.setHistoryManager(this.historyManager);
		// History binds first so any reading-load logging has a live target.
		await this.historyManager.load();
		await this.readingDataManager.load();

		this.posterService = new PosterService(
			this.dataManager,
			() => this.settings,
		);

		await this.dataManager.ensureFolders();
		this.startAirtimeScheduler();

		this.registerView(WATCHLOG_VIEW_TYPE, (leaf) => {
			return new WatchLogView(leaf, this, this.dataManager);
		});

		this.widgetRenderer = new WidgetRenderer(this, this.dataManager);

		// Ribbon icon
		this.addRibbonIcon('tv', 'Watchlog', () => {
			void this.activateView();
		});

		// Command: Open panel
		this.addCommand({
			id: 'open-panel',
			name: 'Open panel',
			callback: () => void this.activateView(),
		});

		// Command: Add title
		this.addCommand({
			id: 'add-title',
			name: 'Add title',
			callback: () => {
				new AddTitleModal(this.app, this, this.dataManager, () => {
					void this.activateView();
				}).open();
			},
		});

		// Command: Insert widget
		this.addCommand({
			id: 'insert-widget',
			name: 'Insert widget',
			editorCallback: (editor: Editor, _view: MarkdownView) => {
				this.openWidgetPalette(editor);
			},
		});

		// Command: Search title
		this.addCommand({
			id: 'search-title',
			name: 'Search title',
			callback: () => {
				const titles = this.dataManager.getTitles();
				new InsertWidgetModal(this.app, titles, (title) => {
					void this.activateView().then(() => {
						new Notice(`"${title.title}" — ${title.type} · ${title.status}`);
					});
				}).open();
			},
		});

		// Settings tab
		this.addSettingTab(new WatchLogSettingsTab(this.app, this));

		// Status-bar Upcoming "due" counter
		this.setupStatusBar();
		// Keep the status bar in sync with data edits (no new timer — the 60s
		// airtime interval drives the time-based refresh). 'watchlog-data-changed'
		// is a custom event, so register the listener directly (like WidgetRenderer).
		const statusBarListener = (): void => this.updateStatusBar();
		activeDocument.addEventListener('watchlog-data-changed', statusBarListener);
		this.register(() => activeDocument.removeEventListener('watchlog-data-changed', statusBarListener));
	}

	onunload(): void {
		// Synchronously flush any pending debounced saves so no in-memory edits are lost.
		this.dataManager.flushPendingSaveSync();
		this.dataManager.flushPosterSaveSync();
		this.dataManager.flushQueuedSaveSync();
		this.readingDataManager?.flushCoverSave();
		this.posterService?.destroy();
		this.widgetRenderer?.cleanup();

	}

	private startAirtimeScheduler(): void {
		this.checkAirtimeNotifications();
		this.registerInterval(window.setInterval(() => {
			this.checkAirtimeNotifications();
		}, 60000));
	}

	/** Allow AirtimeTab to prevent the scheduler from double-firing after a manual tick. */
	markAirtimeHandled(key: string): void {
		this.notifiedEntries.add(key);
	}

	private checkAirtimeNotifications(): void {
		const now = new Date();
		const currentHHMM =
			`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
		const today =
			`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

		const entries = this.dataManager.getAirtimeEntries();
		for (const entry of entries) {
			// Only fire when the entry has a specific time set and it matches now
			if (!entry.schedule.releaseTime) continue;
			if (entry.schedule.releaseTime !== currentHHMM) continue;

			// Use direct day-of-week / date check to avoid the getAirtimeCountdown rollover bug
			if (!this.isScheduledForToday(entry.schedule)) continue;

			// Deduplicate: only fire once per entry per day
			const notifKey = `${entry.id}-${today}`;
			if (this.notifiedEntries.has(notifKey)) continue;
			this.notifiedEntries.add(notifKey);

			// Resolve the entry's subject — a watch title or a reading item.
			let name: string;
			let maxUnits: number;
			if (entry.source === 'reading') {
				const kind = entry.readingKind ?? 'book';
				const item = kind === 'book'
					? this.readingDataManager.getBook(entry.titleId)
					: this.readingDataManager.getManga(entry.titleId);
				if (!item) continue;
				name = item.title;
				maxUnits = entry.totalEpisodes ?? item.totalChapters ?? 0;
			} else {
				const title = this.dataManager.getTitle(entry.titleId);
				if (!title) continue;
				name = title.title;
				maxUnits = entry.totalEpisodes ?? title.totalEpisodes;
			}
			new Notice(name, 8000);

			// Auto-increment the unit (episode/chapter) for multi-part titles
			if (maxUnits > 1 && entry.currentEpisode !== undefined) {
				const nextEp = entry.currentEpisode + 1;
				if (nextEp <= maxUnits) {
					entry.currentEpisode = nextEp;
					void this.dataManager.updateAirtimeEntry(entry);
				}
				// If final unit: leave in Upcoming, you handle via tick button
			}
		}

		// The due count is time-based, so refresh the status bar on every tick.
		this.updateStatusBar();
	}

	// ── Status bar: Upcoming "due" counter ──────────────────────────────────────
	private setupStatusBar(): void {
		// The status bar doesn't exist on mobile — skip entirely there.
		if (Platform.isMobile) return;
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('wl-statusbar-upcoming');
		this.statusBarEl.setAttribute('aria-label', 'WatchLog — Upcoming due');
		this.statusBarEl.addEventListener('click', () => void this.activateView('upcoming'));
		this.updateStatusBar();
	}

	/** Refreshes the status-bar Upcoming counter. Hidden when off or when 0 due. */
	updateStatusBar(): void {
		const el = this.statusBarEl;
		if (!el) return;
		if (!this.settings.showUpcomingStatusBar) {
			el.hide();
			return;
		}
		const count =
			AirtimeTab.getAiredDueCount(this.dataManager, this.readingDataManager) +
			AirtimeTab.getMaybeDueCount(this.dataManager);
		if (count <= 0) {
			el.hide();
			return;
		}
		el.empty();
		el.show();
		// Orange icon + "N due" (colour comes from .wl-statusbar-upcoming) — reuse the ribbon's 'tv' icon.
		const icon = el.createSpan({ cls: 'wl-statusbar-icon' });
		setIcon(icon, 'tv');
		el.createSpan({ cls: 'wl-statusbar-text', text: `${count} due` });
	}

	/**
	 * Returns true if today is a day when the given schedule fires.
	 * Avoids the rollover issue in getAirtimeNextDate/getAirtimeCountdown.
	 */
	private isScheduledForToday(schedule: AirtimeSchedule): boolean {
		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

		if (schedule.recurrence === 'daily') return true;

		if (schedule.recurrence === 'weekly') {
			return schedule.dayOfWeek === now.getDay();
		}

		if (schedule.recurrence === 'monthly') {
			return now.getDate() === (schedule.dayOfMonth ?? -1);
		}

		if (schedule.recurrence === 'once' && schedule.releaseDate) {
			const rel = new Date(schedule.releaseDate + 'T00:00:00');
			const relDay = new Date(rel.getFullYear(), rel.getMonth(), rel.getDate());
			return relDay.getTime() === today.getTime();
		}

		return false;
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as {
			settings?: Partial<WatchLogPluginSettings>;
		} | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved?.settings ?? {});
		if (saved?.settings?.listFilters) {
			this.settings.listFilters = Object.assign(
				{},
				DEFAULT_SETTINGS.listFilters,
				saved.settings.listFilters,
			);
		}
		if (this.settings.animeApiSource === undefined) {
			this.settings.animeApiSource = 'jikan';
		}
		if (this.settings.typeApiMapping === undefined) {
			this.settings.typeApiMapping = {};
		}
		// Reading type badge colors (Manga / Book) — backfill defaults for old installs.
		if (!this.settings.readingTypeColors) {
			this.settings.readingTypeColors = { manga: '#D4537E', book: '#D85A30' };
		} else {
			if (!this.settings.readingTypeColors.manga) this.settings.readingTypeColors.manga = '#D4537E';
			if (!this.settings.readingTypeColors.book) this.settings.readingTypeColors.book = '#D85A30';
		}
		// Default for the defaultWatchlistView setting (Cards)
		if (this.settings.defaultWatchlistView !== 'list' && this.settings.defaultWatchlistView !== 'cards') {
			this.settings.defaultWatchlistView = 'cards';
		}
		// Backfill the status-bar Upcoming counter toggle for existing installs (default ON).
		if (this.settings.showUpcomingStatusBar === undefined) {
			this.settings.showUpcomingStatusBar = true;
		}
		// Ensure array fields are never undefined after a partial merge
		if (!this.settings.types?.length) this.settings.types = DEFAULT_SETTINGS.types;
		if (!this.settings.statuses?.length) this.settings.statuses = DEFAULT_SETTINGS.statuses;
		if (!this.settings.reviews?.length) this.settings.reviews = DEFAULT_SETTINGS.reviews;
		if (!this.settings.priorities?.length) this.settings.priorities = DEFAULT_SETTINGS.priorities;
		if (!this.settings.seasonPalette?.length) this.settings.seasonPalette = DEFAULT_SETTINGS.seasonPalette;
		// Migrate Plan to watch color from old grey to new teal
		const ptw = this.settings.statuses.find((s) => s.name === 'Plan to watch');
		if (ptw && ptw.color === '#888780') ptw.color = '#00A9A5';

		// Ensure "To be released" status exists (migration for existing users)
		if (!this.settings.statuses.find((s) => s.name === 'To be released')) {
			const completedIdx = this.settings.statuses.findIndex((s) => s.name === 'Completed');
			const insertAt = completedIdx >= 0 ? completedIdx + 1 : this.settings.statuses.length;
			this.settings.statuses.splice(insertAt, 0, { name: 'To be released', color: '#E8873A' });
		}
	}

	async saveSettings(): Promise<void> {
		await this.dataManager.saveSettings(this.settings);
	}

	/**
	 * One-time migration of legacy `reading.json` / `history.json` into `data.json`.
	 *
	 * Obsidian Sync replicates data.json (the saveData channel) but NOT the raw
	 * adapter-written reading.json / history.json. This copies their contents into
	 * the single saveData object so Sync carries reading + activity-log data too.
	 *
	 * Gated by `data.migratedReadingHistory`. The flag and the migrated data are
	 * written together in ONE atomic saveData(), so an interrupted load simply
	 * re-runs the (idempotent) migration next time. The flag is only set when both
	 * legacy reads succeeded (a valid empty/absent file counts as success); a
	 * parse failure leaves the flag unset to preserve a recovery chance. Legacy
	 * files are left on disk untouched as a backup.
	 */
	private async migrateReadingHistory(): Promise<void> {
		const master = this.dataManager.getData();
		if (master.migratedReadingHistory === true) {
			return;
		}

		const adapter = this.app.vault.adapter;
		const dir = `${this.app.vault.configDir}/plugins/watchlog`;
		const readingPath = normalizePath(`${dir}/reading.json`);
		const historyPath = normalizePath(`${dir}/history.json`);

		// ── Read legacy reading.json ──────────────────────────────────────────────
		let readingOk = false;
		let readingData: ReadingData | null = null;
		try {
			if (await adapter.exists(readingPath)) {
				const raw = await adapter.read(readingPath);
				readingData = JSON.parse(raw) as ReadingData;
				readingOk = true;
			} else {
				readingOk = true; // absent = nothing to migrate (still a success)
			}
		} catch (e) {
			readingOk = false;
			console.warn('[WL] reading.json read/parse failed — migration will retry next load:', e);
		}

		// ── Read legacy history.json ──────────────────────────────────────────────
		let historyOk = false;
		let historyEntries: HistoryEntry[] | null = null;
		try {
			if (await adapter.exists(historyPath)) {
				const raw = await adapter.read(historyPath);
				const parsed = JSON.parse(raw) as { entries?: HistoryEntry[] };
				historyEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
				historyOk = true;
			} else {
				historyOk = true;
			}
		} catch (e) {
			historyOk = false;
			console.warn('[WL] history.json read/parse failed — migration will retry next load:', e);
		}

		// ── Copy into the saveData object (with the don't-overwrite-with-empty belt) ──
		if (readingOk && readingData) {
			const legacyHasReading =
				(readingData.books?.length ?? 0) > 0 || (readingData.manga?.length ?? 0) > 0 ||
				(readingData.bookColumns?.length ?? 0) > 0 || (readingData.mangaColumns?.length ?? 0) > 0;
			const masterHasReading = !!master.reading &&
				(((master.reading.books?.length ?? 0) > 0) || ((master.reading.manga?.length ?? 0) > 0));
			if (legacyHasReading || !masterHasReading) {
				master.reading = readingData;
			}
		}

		if (historyOk && historyEntries) {
			const masterHasHistory = Array.isArray(master.history) && master.history.length > 0;
			if (historyEntries.length > 0 || !masterHasHistory) {
				master.history = historyEntries;
			}
		}

		// Only mark migrated when both reads succeeded; otherwise retry next load.
		if (readingOk && historyOk) {
			master.migratedReadingHistory = true;
		}

		// Single atomic write: migrated data AND flag together.
		await this.dataManager.persist();
	}

	private openWidgetPalette(editor: Editor): void {
		const widgets = [
			{ name: 'wl-todo — Track a title (full)', id: 'wl-todo' },
			{ name: 'wl-todo mini — Track a title (compact)', id: 'wl-todo:mini' },
			{ name: 'wl-stat: watched — Time watched (mini)', id: 'wl-stat:watched' },
			{ name: 'wl-stat: completed — Completed titles (mini)', id: 'wl-stat:completed' },
			{ name: 'wl-stat: remaining — Time remaining (mini)', id: 'wl-stat:remaining' },
			{ name: 'wl-stat: time — Watched + remaining (mini)', id: 'wl-stat:time' },
			{ name: 'wl-upcoming: next — Next upcoming (mini)', id: 'wl-upcoming:next' },
			{ name: 'wl-stat: time completed full — Time · Remaining · Completed card', id: 'wl-stat:time completed full' },
			{ name: 'wl-now-next — Now Watching + Up Next card', id: 'wl-now-next' },
		];

		new WidgetSelectModal(this.app, widgets, (selected) => {
			if (selected.id === 'wl-todo' || selected.id === 'wl-todo:mini') {
				const titles = this.dataManager.getTitles();
				if (titles.length === 0) {
					new Notice('No titles in your watchlog library yet.');
					return;
				}
				const isMini = selected.id === 'wl-todo:mini';
				new InsertWidgetModal(this.app, titles, (title) => {
					if (isMini) {
						editor.replaceSelection(`\`\`\`wl-todo\n${title.title}\nmini\n\`\`\``);
					} else {
						editor.replaceSelection(`\`\`\`wl-todo\n${title.title}\n\`\`\``);
					}
				}).open();
			} else if (selected.id === 'wl-stat:watched') {
				editor.replaceSelection('```wl-stat\nwatched\n```');
			} else if (selected.id === 'wl-stat:completed') {
				editor.replaceSelection('```wl-stat\ncompleted\n```');
			} else if (selected.id === 'wl-stat:remaining') {
				editor.replaceSelection('```wl-stat\nremaining\n```');
			} else if (selected.id === 'wl-stat:time') {
				editor.replaceSelection('```wl-stat\ntime\n```');
			} else if (selected.id === 'wl-upcoming:next') {
				editor.replaceSelection('```wl-upcoming\nnext\n```');
			} else if (selected.id === 'wl-stat:time completed full') {
				editor.replaceSelection('```wl-stat\ntime completed full\n```');
			} else if (selected.id === 'wl-now-next') {
				editor.replaceSelection('```wl-now-next\n```');
			}
		}).open();
	}

	private async activateView(tab?: TabName): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(WATCHLOG_VIEW_TYPE);
		if (existing.length > 0) {
			const leaf = existing[0]!;
			void workspace.revealLeaf(leaf);
			if (tab && leaf.view instanceof WatchLogView) leaf.view.setActiveTab(tab);
			return;
		}

		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({ type: WATCHLOG_VIEW_TYPE, active: true });
		void workspace.revealLeaf(leaf);
		if (tab && leaf.view instanceof WatchLogView) leaf.view.setActiveTab(tab);
	}
}

// ── Widget selection modal ────────────────────────────────────────────────────

interface WidgetItem { name: string; id: string; }

class WidgetSelectModal extends FuzzySuggestModal<WidgetItem> {
	private items: WidgetItem[];
	private onSelect: (item: WidgetItem) => void;

	constructor(app: App, items: WidgetItem[], onSelect: (item: WidgetItem) => void) {
		super(app);
		this.items = items;
		this.onSelect = onSelect;
		this.setPlaceholder('Select a widget to insert...');
	}

	getItems(): WidgetItem[] { return this.items; }
	getItemText(item: WidgetItem): string { return item.name; }
	onChooseItem(item: WidgetItem): void { this.onSelect(item); }
}
