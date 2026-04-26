import { App, Editor, FuzzySuggestModal, MarkdownView, Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, WatchLogPluginSettings, AirtimeSchedule } from './types';
import { DataManager } from './DataManager';
import { ApiService } from './ApiService';
import { HistoryManager } from './HistoryManager';
import { WatchLogView, WATCHLOG_VIEW_TYPE } from './WatchLogView';
import { WatchLogSettingsTab } from './SettingsTab';
import { AddTitleModal } from './AddTitleModal';
import { InsertWidgetModal } from './InsertWidgetModal';
import { WidgetRenderer } from './WidgetRenderer';

export default class WatchLogPlugin extends Plugin {
	settings: WatchLogPluginSettings = DEFAULT_SETTINGS;
	dataManager: DataManager = new DataManager(this);
	apiService: ApiService = new ApiService('', '');
	historyManager: HistoryManager = new HistoryManager(this);

	// Runtime import progress state (not persisted)
	importProgress: { current: number; total: number; cancel: () => void } | null = null;

	// Track which entry+day combos have already fired a notification
	private notifiedEntries: Set<string> = new Set();

	async onload(): Promise<void> {
		// Load settings first, then data
		await this.loadSettings();
		this.dataManager = new DataManager(this);
		await this.dataManager.load();
		this.dataManager.startWatchingExternalChanges();
		this.apiService = new ApiService(this.settings.omdbApiKey, this.settings.tmdbApiKey);
		this.historyManager = new HistoryManager(this);
		await this.historyManager.load();
		this.dataManager.setHistoryManager(this.historyManager);

		// Ensure vault folders exist
		await this.dataManager.ensureFolders();

		// Start the airtime notification scheduler (checks every 60 seconds)
		this.startAirtimeScheduler();

		// Register the sidebar view
		this.registerView(WATCHLOG_VIEW_TYPE, (leaf) => {
			return new WatchLogView(leaf, this, this.dataManager);
		});

		// Register the inline widget code block processor
		new WidgetRenderer(this, this.dataManager);

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
	}

	onunload(): void {
		
	}

	private startAirtimeScheduler(): void {
		// Check immediately on startup, then every 60 seconds
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

			const title = this.dataManager.getTitle(entry.titleId);
			if (!title) continue;
			new Notice(title.title, 8000);

			// Auto-increment episode for series/anime
			if ((title.totalEpisodes ?? 0) > 1 && entry.currentEpisode !== undefined) {
				const maxEps = entry.totalEpisodes ?? title.totalEpisodes;
				const nextEp = entry.currentEpisode + 1;
				if (nextEp <= maxEps) {
					entry.currentEpisode = nextEp;
					void this.dataManager.updateAirtimeEntry(entry);
				}
				// If final episode: leave in Upcoming, you handle via tick button
			}
		}
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
			settings?: Partial<WatchLogPluginSettings> & { defaultView?: string };
		} | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved?.settings ?? {});
		if (saved?.settings?.listFilters) {
			this.settings.listFilters = Object.assign(
				{},
				DEFAULT_SETTINGS.listFilters,
				saved.settings.listFilters,
			);
		}
		// Migrate old defaultView value 'list' → 'watchlist'
		if ((this.settings.defaultView as string) === 'list') {
			this.settings.defaultView = 'watchlist';
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
		const current = ((await this.loadData()) as Record<string, unknown> | null) ?? {};
		await this.saveData({ ...current, settings: this.settings });
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

	private async activateView(): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(WATCHLOG_VIEW_TYPE);
		if (existing.length > 0) {
			void workspace.revealLeaf(existing[0]!);
			return;
		}

		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({ type: WATCHLOG_VIEW_TYPE, active: true });
		void workspace.revealLeaf(leaf);
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
