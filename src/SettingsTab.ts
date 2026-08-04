import { App, Notice, Platform, PluginSettingTab, Setting, SliderComponent, normalizePath, setIcon } from 'obsidian';
import { cardSizeToMinWidth } from './VirtualGrid';
import type WatchLogPlugin from './main';
import type { TagDefinition, ReadingStatus, ReadingData, GamesData, GamesSettings, DateFormatPref, CardStyleTab, CardTextStyle } from './types';
import { SELECTABLE_READING_STATUSES, READING_STATUSES, LAST_USED_TYPE_SENTINEL, formatDateDisplay, needsStudioFetch, getApiGroupForType, isCreditsNone, CREDITS_NONE } from './types';
import { readingStatusColor } from './ReadingTab';
import { SteamSyncModal } from './SteamSyncModal';
import type { SteamFailureReason } from './ApiService';

/** short status-line label per Steam failure (the modal shows the long form) */
function steamFailureLabel(reason: SteamFailureReason): string {
	switch (reason) {
		case 'missing': return 'Key or Steam ID missing';
		case 'badKey': return 'Failed; check your API key';
		case 'private': return 'Profile is private; set "Game details" to Public';
		case 'empty': return 'No games on this account';
		default: return 'Could not reach Steam';
	}
}

/** sample date behind the Date-format preview labels */
const DATE_PREVIEW = '2026-03-09';

/** donation link behind the header coffee button */
const BMC_URL = 'https://buymeacoffee.com/bogdanyo17i';

/**
 * Accessors for one colour-list section in Customize. Omitting add/remove/rename hides
 * that control — how colour-only sections are expressed.
 */
interface TagListSectionConfig {
	label: string;
	info?: string;
	getList: () => TagDefinition[];
	setColor: (name: string, color: string) => Promise<void>;
	/** entries that keep the colour picker but can't be renamed or removed */
	isLocked?: (name: string) => boolean;
	add?: (name: string, color: string) => Promise<void>;
	remove?: (name: string) => Promise<void>;
	/** present ⇒ the name becomes an editable input; must cascade the rename */
	rename?: (from: string, to: string) => Promise<void>;
	/** called after every add/remove/rename — lets the group header chip re-count */
	onChanged?: () => void;
}

/**
 * Colour of a status chip in a group header or provider card. `count` is the dotless
 * neutral used for "6 types" read-outs.
 */
type ChipTone = 'ok' | 'warn' | 'error' | 'idle' | 'pending' | 'count';

/**
 * Accent palettes for `settingsGroup` — one per library, plus the neutrals and the
 * cross-tab utility accents (csv, folders, subfolders, backup), which keep the same
 * meaning on every page.
 */
type SettingsGroupVariant =
	| 'movies' | 'anime' | 'books' | 'games'
	| 'watchlist' | 'reading' | 'theme' | 'shared' | 'cards'
	| 'general' | 'drafts' | 'lists'
	| 'csv' | 'folders' | 'subfolders' | 'backup';

interface ChipStatus {
	text: string;
	tone: ChipTone;
	/** Full explanation, rendered under the card — the chip itself is too small for one. */
	detail?: string;
}

/** One credential input inside a provider card. */
interface ApiProviderField {
	label: string;
	placeholder: string;
	/** Rendered as a password field with a reveal toggle. */
	secret?: boolean;
	get: () => string;
	set: (v: string) => void;
	/** Handed the input element so a Test handler can write a resolved value back. */
	onInput?: (el: HTMLInputElement) => void;
}

/** One API provider card (OMDb, TMDB, RAWG, …). Keyless providers omit `fields` and `test`. */
interface ApiProviderSpec {
	name: string;
	/** Letter shown in the avatar disc. */
	initials: string;
	/** One-line subtitle under the name. */
	note?: string;
	/** Fixed label in the top-right slot, for cards outside an active/inactive pair. */
	badge?: string;
	fields?: ApiProviderField[];
	link?: { text: string; href: string };
	/** Long-form guidance, folded behind the (?) button. */
	help?: string;
	/** Status shown before any Test, recomputed on every keystroke. */
	status: () => ChipStatus;
	test?: () => Promise<ChipStatus>;
	/** Extra content below the footer (Steam's Sync button). */
	extra?: (el: HTMLElement) => void;
}

interface ApiProviderHandle {
	/** `null` leaves the card neutral — it isn't part of an active/inactive pair. */
	setActive: (active: boolean | null) => void;
	refreshStatus: () => void;
}
import { CsvModal } from './CsvModal';
import { ReadingCsvChoiceModal } from './ReadingCsvChoiceModal';
import { ReadingCsvModal } from './ReadingCsvModal';
import { WatchLogView } from './WatchLogView';
import { CustomListManager, DefaultColumnsModal } from './CustomListsTab';
import { ConfirmModal } from './ConfirmModal';
import { apiErrorMessage, apiErrorShort } from './ApiService';
import type { HistoryEntry } from './HistoryManager';

type SettingsSection = 'general' | 'api' | 'customize' | 'watchlist' | 'drafts' | 'custom-lists' | 'reading' | 'widgets' | 'quick-info';

export class WatchLogSettingsTab extends PluginSettingTab {
	private plugin: WatchLogPlugin;
	private textSaveTimer: number | null = null;

	private debouncedSaveSettings(): void {
		if (this.textSaveTimer !== null) window.clearTimeout(this.textSaveTimer);
		this.textSaveTimer = window.setTimeout(() => {
			this.textSaveTimer = null;
			void this.plugin.saveSettings();
		}, 500);
	}
	private activeSection: SettingsSection = 'general';
	/** Teardown for an in-flight restore file picker; see openRestoreDialog. */
	private restoreDialogCleanup: (() => void) | null = null;

	constructor(app: App, plugin: WatchLogPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		// a file picker left open when the settings pane closes would otherwise strand its hidden
		// <input> in the document body along with the window focus listener watching it
		this.restoreDialogCleanup?.();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('wl-settings');

		// mobile/tablet: 9 text labels overflow the pane — icon-only nav (same icons as the view tabs)
		const iconOnly = Platform.isMobile;
		containerEl.toggleClass('wl-settings-mobile', iconOnly);

		const nav = containerEl.createDiv({ cls: 'wl-settings-nav' });
		const sections: { key: SettingsSection; label: string; icon: string }[] = [
			{ key: 'general', label: 'General', icon: 'settings' },
			{ key: 'api', label: 'API', icon: 'plug' },
			{ key: 'customize', label: 'Customize', icon: 'palette' },
			{ key: 'watchlist', label: 'Watchlist', icon: 'tv' },
			{ key: 'drafts', label: 'Drafts', icon: 'square-pen' },
			{ key: 'custom-lists', label: 'Custom Lists', icon: 'list' },
			{ key: 'reading', label: 'Reading', icon: 'book-open' },
			{ key: 'widgets', label: 'Widgets', icon: 'layout-grid' },
			{ key: 'quick-info', label: 'Quick Info', icon: 'help-circle' },
		];

		const buttons: Map<SettingsSection, HTMLButtonElement> = new Map();
		for (const sec of sections) {
			const btn = nav.createEl('button', {
				cls: `wl-settings-nav-btn${this.activeSection === sec.key ? ' is-active' : ''}`,
			});
			if (iconOnly) {
				btn.addClass('wl-settings-nav-btn-icon');
				setIcon(btn, sec.icon);
				btn.setAttribute('aria-label', sec.label);
			} else {
				btn.setText(sec.label);
			}
			buttons.set(sec.key, btn);
			btn.addEventListener('click', () => {
				this.activeSection = sec.key;
				buttons.forEach((b, k) => {
					if (k === sec.key) { b.addClass('is-active'); } else { b.removeClass('is-active'); }
				});
				body.empty();
				this.renderSection(body);
			});
		}

		const body = containerEl.createDiv({ cls: 'wl-settings-body' });
		this.renderSection(body);
	}

	private renderSection(body: HTMLElement): void {
		body.empty();
		switch (this.activeSection) {
			case 'general': this.renderGeneral(body); break;
			case 'api': this.renderApi(body); break;
			case 'customize': this.renderCustomize(body); break;
			case 'watchlist': this.renderWatchlist(body); break;
			case 'drafts': this.renderDrafts(body); break;
			case 'custom-lists': this.renderCustomLists(body); break;
			case 'reading': this.renderReading(body); break;
			case 'widgets': this.renderWidgets(body); break;
			case 'quick-info': this.renderQuickInfo(body); break;
		}
	}

	// General

	private static readonly CARD_SIZE_LABELS: Record<number, string> = {
		[-3]: 'Smallest', [-2]: 'Smaller', [-1]: 'Small', [0]: 'Default',
		[1]: 'Large', [2]: 'Larger', [3]: 'Largest',
	};

	/** Tabs listed in the Card-text per-tab rows, in display order. */
	private static readonly CARD_STYLE_TABS: Array<{ key: CardStyleTab; label: string; icon: string }> = [
		{ key: 'watchlist', label: 'Watchlist', icon: 'clapperboard' },
		{ key: 'games', label: 'Games', icon: 'gamepad-2' },
		{ key: 'reading', label: 'Reading', icon: 'book-open' },
		{ key: 'upcoming', label: 'Upcoming', icon: 'calendar-clock' },
	];

	/**
	 * The Customize → Cards body: the per-tab text-placement picker (mini previews as
	 * apply-to-all shortcuts + one Under/Inside row per tab) and the size sliders.
	 * `setChip` keeps the header chip in sync ("Text under · 160 px", "Mixed · 160 px").
	 */
	private renderCardSettings(el: HTMLElement, setChip: (label: string) => void): void {
		const s = this.plugin.settings;
		const tabs = WatchLogSettingsTab.CARD_STYLE_TABS;
		/** 'under' / 'inside' when every tab agrees, null when mixed. */
		const unanimous = (): CardTextStyle | null => {
			const first = s.cardTextStyles[tabs[0]!.key];
			return tabs.every((t) => s.cardTextStyles[t.key] === first) ? first : null;
		};
		const syncChip = (): void => {
			const all = unanimous();
			const style = all === null ? 'Mixed' : all === 'inside' ? 'Text inside' : 'Text under';
			setChip(`${style} · ${cardSizeToMinWidth(s.cardSize ?? 0)} px`);
		};

		// text placement
		const styleBody = this.sgCard(el, {
			label: 'Card text',
			help: 'Where a tab\'s poster cards show their name, type and year; in a block under the poster (the classic Reading/Upcoming style) or overlaid at the bottom of the poster (the classic Watchlist style). Status badges stay on the poster either way. The two big previews apply a style to every tab at once; the rows below set each tab on its own.',
		});
		const picker = styleBody.createDiv({ cls: 'wl-card-style-picker' });
		const options: Array<{ value: CardTextStyle; name: string; hint: string }> = [
			{ value: 'under', name: 'Text under', hint: 'Name and details below the poster' },
			{ value: 'inside', name: 'Text inside', hint: 'Overlaid on the poster' },
		];
		const tiles = new Map<CardTextStyle, HTMLElement>();
		const tabButtons: Array<{ key: CardStyleTab; value: CardTextStyle; btn: HTMLElement }> = [];
		// one save path for tiles and rows: persist, repaint open tabs, resync UI
		const applyStyles = (assign: Partial<Record<CardStyleTab, CardTextStyle>>): void => {
			Object.assign(s.cardTextStyles, assign);
			const all = unanimous();
			for (const [value, tile] of tiles) tile.toggleClass('is-active', value === all);
			for (const { key, value, btn } of tabButtons) {
				btn.toggleClass('is-active', s.cardTextStyles[key] === value);
			}
			syncChip();
			void (async () => {
				await this.plugin.saveSettings();
				this.plugin.dataManager.notifyChange();
			})();
		};

		for (const opt of options) {
			const btn = picker.createEl('button', { cls: 'wl-card-style-option' });
			btn.setAttr('aria-label', `${opt.name}: apply to every tab`);
			tiles.set(opt.value, btn);
			// mini preview: a poster rectangle with two text lines below it or in a scrim
			const thumb = btn.createDiv({ cls: `wl-card-style-thumb is-${opt.value}` });
			const poster = thumb.createDiv({ cls: 'wl-card-style-thumb-poster' });
			const lines = (opt.value === 'inside' ? poster : thumb)
				.createDiv({ cls: 'wl-card-style-thumb-lines' });
			lines.createDiv({ cls: 'wl-card-style-thumb-line' });
			lines.createDiv({ cls: 'wl-card-style-thumb-line is-short' });
			btn.createDiv({ cls: 'wl-card-style-name', text: opt.name });
			btn.createDiv({ cls: 'wl-card-style-hint', text: opt.hint });
			if (unanimous() === opt.value) btn.addClass('is-active');
			btn.addEventListener('click', () => {
				// typed record, not Object.fromEntries — that returns `any`
				const all: Partial<Record<CardStyleTab, CardTextStyle>> = {};
				for (const t of tabs) all[t.key] = opt.value;
				applyStyles(all);
			});
		}

		// per-tab rows: icon · tab name · [Under | Inside]
		const tabRows = styleBody.createDiv({ cls: 'wl-card-style-tabs' });
		for (const tab of tabs) {
			const row = tabRows.createDiv({ cls: 'wl-card-style-tab-row' });
			const iconEl = row.createSpan({ cls: 'wl-card-style-tab-icon' });
			setIcon(iconEl, tab.icon);
			row.createSpan({ cls: 'wl-card-style-tab-label', text: tab.label });
			const group = row.createDiv({ cls: 'wl-card-style-tab-group' });
			for (const opt of options) {
				const btn = group.createEl('button', {
					cls: 'wl-card-style-tab-btn',
					text: opt.value === 'under' ? 'Under' : 'Inside',
				});
				btn.setAttr('aria-label', `${tab.label}: ${opt.name.toLowerCase()}`);
				if (s.cardTextStyles[tab.key] === opt.value) btn.addClass('is-active');
				tabButtons.push({ key: tab.key, value: opt.value, btn });
				btn.addEventListener('click', () => {
					if (s.cardTextStyles[tab.key] === opt.value) return;
					applyStyles({ [tab.key]: opt.value });
				});
			}
		}

		// size
		const sizeBody = this.sgCard(el, {
			label: 'Card size',
			help: 'Minimum poster width for every grid and shelf (cards stretch a little to fill each row). Desktop and phones/tablets are independent, and both sync like any other setting.',
		});
		const rows = sizeBody.createDiv({ cls: 'wl-card-size-rows' });
		this.renderCardSizeRow(rows, 'monitor', 'Desktop',
			() => s.cardSize ?? 0, (v) => { s.cardSize = v; }, syncChip);
		this.renderCardSizeRow(rows, 'smartphone', 'Mobile',
			() => s.cardSizeMobile ?? 0, (v) => { s.cardSizeMobile = v; }, syncChip);

		syncChip();
	}

	/**
	 * One card-size slider row (icon · label · slider · live value); applied to the CSS var
	 * and any open view immediately.
	 */
	private renderCardSizeRow(
		parent: HTMLElement,
		icon: string,
		label: string,
		get: () => number,
		set: (v: number) => void,
		onChanged: () => void,
	): void {
		const row = parent.createDiv({ cls: 'wl-card-size-row' });
		const iconEl = row.createSpan({ cls: 'wl-card-size-row-icon' });
		setIcon(iconEl, icon);
		row.createSpan({ cls: 'wl-card-size-row-label', text: label });

		const fmt = (v: number): string =>
			`${WatchLogSettingsTab.CARD_SIZE_LABELS[v] ?? 'Default'} · ${cardSizeToMinWidth(v)} px`;
		const slider = new SliderComponent(row);
		const valueEl = row.createSpan({ cls: 'wl-card-size-value', text: fmt(get()) });
		slider
			.setLimits(-3, 3, 1)
			.setValue(get())
			.onChange(async (v) => {
				set(v);
				valueEl.setText(fmt(v));
				await this.plugin.saveSettings();
				// re-publish the CSS var and re-render, so the size shows now and not on tab switch
				this.plugin.applyCardSizeCssVar();
				this.plugin.dataManager.notifyChange();
				onChanged();
			});
	}

	/** Buy Me a Coffee link, parked at the tail of a group header. */
	private renderCoffeeButton(head: HTMLElement): void {
		const link = head.createEl('a', {
			cls: 'wl-bmc-btn',
			href: BMC_URL,
			attr: { target: '_blank', rel: 'noopener' },
		});
		const icon = link.createSpan({ cls: 'wl-bmc-icon' });
		setIcon(icon, 'coffee');
		link.createSpan({ cls: 'wl-bmc-text', text: 'Buy me a coffee' });
	}

	private renderGeneral(container: HTMLElement): void {
		const page = container.createDiv({ cls: 'wl-sg-page' });

		// main
		const mainGroup = this.settingsGroup(page, {
			title: 'Main',
			sub: 'Global appearance, dates and maintenance',
			icon: 'sliders-horizontal',
			variant: 'general',
			rows: true,
		});
		const el = mainGroup.body;

		this.renderCoffeeButton(mainGroup.head);

		new Setting(el)
			.setName('Dashboard card style')
			.setDesc('Choose between ring charts or rectangular stat cards on the dashboard.')
			.addDropdown((d) =>
				d
					.addOptions({ circles: 'Circles', rectangles: 'Rectangles' })
					.setValue(this.plugin.settings.dashboardCardStyle ?? 'circles')
					.onChange(async (v) => {
						this.plugin.settings.dashboardCardStyle = v as 'circles' | 'rectangles';
						await this.plugin.saveSettings();
						activeDocument.dispatchEvent(new CustomEvent('watchlog-data-changed'));
					}),
			);

		new Setting(el)
			.setName('Date format')
			.setDesc(
				'How dates are shown and typed everywhere in the plugin; lists, cards, modals, the activity log and the calendar picker. Your stored data is never touched: dates are always saved in the same internal format, so switching between these is safe at any time.',
			)
			.addDropdown((d) =>
				d
					.addOptions({
						european: `European: ${formatDateDisplay(DATE_PREVIEW, 'european')}`,
						american: `American: ${formatDateDisplay(DATE_PREVIEW, 'american')}`,
						iso: `ISO: ${formatDateDisplay(DATE_PREVIEW, 'iso')}`,
					})
					.setValue(this.plugin.settings.dateFormat ?? 'european')
					.onChange(async (v) => {
						this.plugin.settings.dateFormat = v as DateFormatPref;
						// saveSettings mirrors the value into the shared formatters
						await this.plugin.saveSettings();
						// repaint open tabs and widgets so the new order shows immediately
						this.refreshOpenViews();
					}),
			);

		new Setting(el)
			.setName('Half-star ratings')
			.setDesc('Allow half-star (0.5) steps when rating watchlist titles and reading entries. Existing ratings are never changed.')
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.halfStarRatings ?? false)
					.onChange(async (v) => {
						this.plugin.settings.halfStarRatings = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(el)
			.setName('Set finish date automatically')
			.setDesc("Record today's date as the finish date when a watch title or reading entry is completed.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.setFinishDateAutomatically)
					.onChange(async (v) => {
						this.plugin.settings.setFinishDateAutomatically = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(el)
			.setName('Re-fetch all posters')
			.setDesc('Clears all cached poster, reading cover and game cover URLs. Watch posters and game covers reload lazily when you scroll their cards; reading covers can be re-fetched from each card\'s ⋮ menu.')
			.addButton((b) =>
				b.setButtonText('Re-fetch posters').onClick(() => {
					const titles = this.plugin.dataManager.getTitles();
					const readingCount = this.plugin.readingDataManager.getBooks().length + this.plugin.readingDataManager.getMangaList().length;
					const gameCount = this.plugin.gameDataManager.getGames().length;
					new ConfirmModal(
						this.app,
						`This will clear cached images for all ${titles.length} watch titles, ${readingCount} reading entries and ${gameCount} games. Items without API access will show placeholder cards. Continue?`,
						() => { void this.refetchAllPosters(); },
					).open();
				}),
			);

		new Setting(el)
			.setName('Rewrite all note frontmatter')
			.setDesc('Rewrites the YAML frontmatter on every existing Watchlist and Reading note, applying newer frontmatter fields to older notes. Body content (## Notes / ## Quotes) is preserved. Notes without a file on disk are skipped; use Regenerate to create them.')
			.addButton((b) =>
				b.setButtonText('Rewrite frontmatter').onClick(() => {
					const titles = this.plugin.dataManager.getTitles();
					const readingCount = this.plugin.readingDataManager.getBooks().length + this.plugin.readingDataManager.getMangaList().length;
					new ConfirmModal(
						this.app,
						`This will rewrite the YAML frontmatter on all existing notes for ${titles.length} watch titles and ${readingCount} reading entries. Body content is preserved; notes without a file on disk are skipped. Continue?`,
						() => { void this.rewriteAllFrontmatter(); },
					).open();
				}),
			);

		new Setting(el)
			.setName('Fetch studios for all titles')
			.setDesc('Fills the studio or network for every watchlist title that has none yet. Movies and series use the configured movie service, anime uses the configured anime source. Titles that already have one are skipped, so re-running is cheap.')
			.addButton((b) =>
				b.setButtonText('Fetch studios').onClick(() => {
					const pending = this.plugin.dataManager
						.getTitles()
						.filter((t) => needsStudioFetch(t)).length;
					if (pending === 0) {
						new Notice('Every title already has a studio.');
						return;
					}
					new ConfirmModal(
						this.app,
						`This will make roughly one API request for each of the ${pending} title${pending !== 1 ? 's' : ''} without a studio. It can be cancelled at any time. Continue?`,
						() => { void this.fetchAllStudios(); },
					).open();
				}),
			);

		new Setting(el)
			.setName('Show hint banners')
			.setDesc('Show informational hint banners in Upcoming, Custom Lists, and Drafts tabs.')
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.showHintBanners)
					.onChange(async (v) => {
						this.plugin.settings.showHintBanners = v;
						await this.plugin.saveSettings();
						activeDocument.dispatchEvent(new CustomEvent('watchlog-data-changed'));
					}),
			);

		new Setting(el)
			.setName('Show Upcoming count in status bar')
			.setDesc('Show a "N due" counter in the status bar when Upcoming entries are due. Click it to open the Upcoming tab. (Desktop only.)')
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.showUpcomingStatusBar)
					.onChange(async (v) => {
						this.plugin.settings.showUpcomingStatusBar = v;
						await this.plugin.saveSettings();
						this.plugin.updateStatusBar();
					}),
			);

		// Backup & restore
		const bk = this.settingsGroup(page, {
			title: 'Backup & Restore',
			sub: 'Snapshot every library to a file, or rebuild from one',
			icon: 'database-backup',
			variant: 'backup',
			rows: true,
		}).body;

		new Setting(bk)
			.setName('Export backup')
			.setDesc('Export all watchlog data into a single timestamped .JSON file: watchlist, reading (books & manga), games and activity log.')
			.addButton((b) =>
				b.setButtonText('Export backup').onClick(() => void this.exportBackup()),
			);

		new Setting(bk)
			.setName('Restore from backup')
			.setDesc('Restore from a .JSON backup file. This replaces your current watchlist, reading, games and activity-log data with the contents of the backup. Older backups restore only what they contain and leave the newer data untouched.')
			.addButton((b) =>
				b.setButtonText('Restore from backup').onClick(() => this.openRestoreDialog()),
			);

		const regenHolder = {
			wrap: null as HTMLElement | null,
			fill: null as HTMLElement | null,
			text: null as HTMLElement | null,
		};

		new Setting(bk)
			.setName('Regenerate note files')
			.setDesc("Creates missing .md files for titles that don't have one. Existing files are not modified.")
			.addButton((b) =>
				b.setButtonText('Regenerate').onClick(() => {
					const { wrap, fill, text } = regenHolder;
					if (wrap && fill && text) void this.runRegenerate(wrap, fill, text);
				}),
			);

		const regenProgressWrap = bk.createDiv({ cls: 'wl-regen-progress-wrap' });
		regenProgressWrap.hide();
		regenProgressWrap.createSpan({ cls: 'wl-csv-bg-note', text: 'You can close settings; regeneration continues in the background.' });
		const regenProgressTrack = regenProgressWrap.createDiv({ cls: 'wl-csv-progress-track' });
		const regenProgressFill = regenProgressTrack.createDiv({ cls: 'wl-csv-progress-fill' });
		const regenProgressText = regenProgressWrap.createSpan({ cls: 'wl-csv-progress-text', text: '0 / 0' });

		regenHolder.wrap = regenProgressWrap;
		regenHolder.fill = regenProgressFill;
		regenHolder.text = regenProgressText;
	}

	private async exportBackup(): Promise<void> {
		const today = new Date();
		const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
		const filename = `watchlog-backup-${dateStr}.json`;

		// v3 snapshot: a self-describing wrapper around all four data sources. Reading, games
		// and history all live inside the watch object, so strip them from `watch`.
		const watchOnly = Object.assign({}, this.plugin.dataManager.getData() ?? {}) as unknown as Record<string, unknown>;
		delete watchOnly['reading'];
		delete watchOnly['games'];
		delete watchOnly['history'];
		delete watchOnly['migratedReadingHistory'];
		const snapshot = {
			version: 3,
			exportedAt: today.toISOString(),
			watch: watchOnly,
			reading: this.plugin.readingDataManager.getData(),
			games: this.plugin.gameDataManager.getData(),
			history: this.plugin.historyManager.exportEntries(),
		};
		const json = JSON.stringify(snapshot, null, 2);

		// on mobile a browser download lands in an inaccessible sandbox — write into the vault
		// instead; desktop keeps the download path
		if (Platform.isMobile) {
			await this.exportBackupToVault(filename, json);
			return;
		}

		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = createEl('a');
		a.href = url;
		a.download = filename;
		activeDocument.body.appendChild(a);
		a.click();
		activeDocument.body.removeChild(a);
		URL.revokeObjectURL(url);
		new Notice(`Backup exported as ${filename}`);
	}

	/** Mobile path: write the backup into WatchLog/backups/, disambiguating on collision. */
	private async exportBackupToVault(filename: string, json: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const folder = normalizePath('WatchLog/backups');
		if (!(await adapter.exists(folder))) {
			try {
				await adapter.mkdir(folder);
			} catch {
				// folder may already exist
			}
		}

		// the reading-id slug rule: base name, then -2, -3, … on collision
		const dotIndex = filename.lastIndexOf('.');
		const base = dotIndex === -1 ? filename : filename.slice(0, dotIndex);
		const ext = dotIndex === -1 ? '' : filename.slice(dotIndex);
		let path = normalizePath(`${folder}/${filename}`);
		if (await adapter.exists(path)) {
			let counter = 2;
			while (await adapter.exists(normalizePath(`${folder}/${base}-${counter}${ext}`))) counter++;
			path = normalizePath(`${folder}/${base}-${counter}${ext}`);
		}

		await adapter.write(path, json);
		new Notice(`Backup saved to ${path}`);
	}

	private openRestoreDialog(): void {
		// a previous picker still hanging around (rapid double-click) is torn down first
		this.restoreDialogCleanup?.();

		const input = activeDocument.body.createEl('input', { attr: { type: 'file', accept: '.json' } });
		input.hide();
		let consumed = false;
		// one teardown for every exit path — file chosen, picker cancelled, or the settings pane
		// closing underneath it (hide() calls this through restoreDialogCleanup)
		const cleanupInput = (): void => {
			window.removeEventListener('focus', onFocus);
			input.remove();
			if (this.restoreDialogCleanup === cleanupInput) this.restoreDialogCleanup = null;
		};
		// a cancelled picker returns focus to window; clean up shortly after
		const onFocus = (): void => {
			window.setTimeout(() => {
				if (!consumed) cleanupInput();
			}, 200);
		};
		window.addEventListener('focus', onFocus);
		this.restoreDialogCleanup = cleanupInput;
		input.addEventListener('change', () => {
			consumed = true;
			const file = input.files?.[0];
			if (!file) { cleanupInput(); return; }
			const reader = new FileReader();
			reader.onload = (e) => {
				cleanupInput();
				const text = e.target?.result as string;
				let parsed: unknown;
				try { parsed = JSON.parse(text); } catch {
					new Notice('Invalid backup file: could not parse JSON.');
					return;
				}
				if (typeof parsed !== 'object' || parsed === null) {
					new Notice('Invalid backup file: not an object.');
					return;
				}
				const p = parsed as Record<string, unknown>;

				// validate the WHOLE file before touching disk — restore is all-or-nothing
				const version = p['version'];
				if (version === 2 || version === 3) {
					const watch = p['watch'];
					const reading = p['reading'];
					const games = p['games'];
					const history = p['history'];
					if (!this.isValidWatchData(watch)) {
						new Notice('Invalid backup file: watch data missing required fields (titles, groups, settings).');
						return;
					}
					if (!this.isValidReadingData(reading)) {
						new Notice('Invalid backup file: reading data missing required fields (books, manga).');
						return;
					}
					// games are a v3 field; v2 files carry them (if at all) inside `watch`
					if (version === 3 && !this.isValidGamesData(games)) {
						new Notice('Invalid backup file: games data missing required fields (games, settings).');
						return;
					}
					if (!Array.isArray(history)) {
						new Notice('Invalid backup file: activity log is not a list.');
						return;
					}
					const scope = version === 3
						? 'watchlist, reading (books & manga), games and activity log'
						: 'watchlist, reading (books & manga) and activity log';
					new ConfirmModal(this.app, `This will replace ALL current watchlog data; ${scope}. Continue?`, () => {
						void (async () => {
							// reading, games + history persist inside data.json — mark the data already-migrated so
							// the one-time legacy import can't re-run and clobber the restore
							const restored = Object.assign({}, watch as Record<string, unknown>, { migratedReadingHistory: true });
							// a v2 file exported before Games shipped has none at all; keep the current ones
							if (version === 2 && restored['games'] === undefined) {
								restored['games'] = this.plugin.gameDataManager.getData();
							}
							await this.plugin.saveData(restored);
							await this.plugin.loadSettings();
							await this.plugin.dataManager.load();
							await this.plugin.readingDataManager.restore(reading as ReadingData);
							// v3 restores the explicit field; v2 re-binds the manager to whatever games object landed
							if (version === 3) await this.plugin.gameDataManager.restore(games as GamesData);
							else await this.plugin.gameDataManager.load();
							await this.plugin.historyManager.restore(history as HistoryEntry[]);
							activeDocument.dispatchEvent(new CustomEvent('watchlog-data-changed'));
							new Notice('Backup restored successfully.');
						})();
					}).open();
					return;
				}

				// legacy (v1) — the file IS the watch data
				if (!this.isValidWatchData(parsed)) {
					new Notice('Invalid backup file: missing required fields (titles, groups, settings).');
					return;
				}
				new ConfirmModal(this.app, 'This is a legacy (watchlist-only) backup. It will replace your current watchlist. Reading and activity-log data are left untouched. Continue?', () => {
					void (async () => {
						// a legacy backup carries no reading/games/history, so preserve the CURRENT in-memory
						// data (and the migrated flag) when overwriting the watch data
						const merged = Object.assign({}, parsed as Record<string, unknown>, {
							reading: this.plugin.readingDataManager.getData(),
							games: this.plugin.gameDataManager.getData(),
							history: this.plugin.historyManager.exportEntries(),
							migratedReadingHistory: true,
						});
						await this.plugin.saveData(merged);
						await this.plugin.loadSettings();
						await this.plugin.dataManager.load();
						await this.plugin.historyManager.load();
						await this.plugin.readingDataManager.load();
						await this.plugin.gameDataManager.load();
						activeDocument.dispatchEvent(new CustomEvent('watchlog-data-changed'));
						new Notice('Legacy backup restored: watchlist only; reading, games and activity log left untouched.');
					})();
				}).open();
			};
			reader.readAsText(file);
		});
		input.click();
	}

	private isValidWatchData(value: unknown): boolean {
		if (typeof value !== 'object' || value === null) return false;
		const w = value as Record<string, unknown>;
		return Array.isArray(w['titles'])
			&& Array.isArray(w['groups'])
			&& typeof w['settings'] === 'object'
			&& w['settings'] !== null;
	}

	private isValidReadingData(value: unknown): boolean {
		if (typeof value !== 'object' || value === null) return false;
		const r = value as Record<string, unknown>;
		return Array.isArray(r['books'])
			&& Array.isArray(r['manga'])
			&& typeof r['settings'] === 'object'
			&& r['settings'] !== null;
	}

	private isValidGamesData(value: unknown): boolean {
		if (typeof value !== 'object' || value === null) return false;
		const g = value as Record<string, unknown>;
		return Array.isArray(g['games'])
			&& typeof g['settings'] === 'object'
			&& g['settings'] !== null;
	}

	private async refetchAllPosters(): Promise<void> {
		const titles = this.plugin.dataManager.getTitles();
		for (const t of titles) t.posterUrl = '';
		await this.plugin.dataManager.save();

		// also clear cached Reading cover URLs so they can be re-fetched
		const reading = this.plugin.readingDataManager;
		for (const b of reading.getBooks()) b.coverUrl = '';
		for (const m of reading.getMangaList()) m.coverUrl = '';
		await reading.saveAndNotify();

		// games clear the same way; their cards re-fetch lazily on scroll
		const gameData = this.plugin.gameDataManager;
		for (const g of gameData.getGames()) g.coverUrl = '';
		await gameData.saveAndNotify();

		new Notice('Cached posters and covers cleared. Watch posters and game covers reload as you browse; refresh reading covers from each card\'s ⋮ menu.');
	}

	/**
	 * Rewrites the frontmatter block on every existing note (Watchlist + Reading),
	 * preserving each body. Missing files are skipped, never created. Chunked, with a
	 * cancelable progress notice via the shared importProgress infrastructure.
	 */
	private async rewriteAllFrontmatter(): Promise<void> {
		const dm = this.plugin.dataManager;
		const reading = this.plugin.readingDataManager;
		const titles = dm.getTitles();
		const books = reading.getBooks();
		const manga = reading.getMangaList();
		const total = titles.length + books.length + manga.length;
		if (total === 0) {
			new Notice('No notes to rewrite.');
			return;
		}

		// one flat list of work units; true = rewritten, false = skipped (no file on disk)
		const jobs: Array<() => Promise<boolean>> = [
			...titles.map((t) => () => dm.rewriteFrontmatterIfExists(t)),
			...books.map((b) => () => reading.rewriteFrontmatterIfExists('book', b)),
			...manga.map((m) => () => reading.rewriteFrontmatterIfExists('manga', m)),
		];

		let cancelled = false;
		const cancelFn = (): void => { cancelled = true; };
		// expose to the shared progress infra (the Watchlist header draws the cancel button)
		this.plugin.importProgress = { current: 0, total, cancel: cancelFn };
		dm.notifyChange();

		// in-place progress notice with its own cancel button — the header bar isn't visible
		// from Settings. persistent (timeout 0).
		const notice = new Notice('', 0);
		const label = notice.messageEl.createSpan({ text: `Rewriting frontmatter… 0 / ${total}` });
		const cancelBtn = notice.messageEl.createEl('button', { cls: 'wl-btn wl-btn-sm wl-notice-cancel-btn', text: 'Cancel' });
		cancelBtn.addEventListener('click', cancelFn);

		const CHUNK_SIZE = 10;
		let rewritten = 0;
		let skipped = 0;
		let done = 0;
		try {
			for (let i = 0; i < jobs.length; i++) {
				if (cancelled) break;
				if (await jobs[i]!()) rewritten++; else skipped++;
				done++;
				// yield every chunk so the UI repaints and stays responsive across 700+ notes
				if (done % CHUNK_SIZE === 0 || done === total) {
					this.plugin.importProgress = { current: done, total, cancel: cancelFn };
					label.textContent = `Rewriting frontmatter… ${done} / ${total}`;
					await new Promise((r) => window.setTimeout(r, 0));
				}
			}
		} finally {
			this.plugin.importProgress = null;
			dm.notifyChange();
			notice.hide();
		}

		const skippedMsg = skipped > 0 ? `, ${skipped} skipped (no file)` : '';
		const prefix = cancelled ? 'Cancelled: ' : 'Done: ';
		new Notice(`${prefix}${rewritten} note${rewritten !== 1 ? 's' : ''} rewritten${skippedMsg}.`);
	}

	/** Bulk studio backfill; the rewriteAllFrontmatter progress/cancel pattern. */
	private async fetchAllStudios(): Promise<void> {
		const dm = this.plugin.dataManager;
		const pending = dm.getTitles().filter((t) => needsStudioFetch(t));
		const total = pending.length;
		if (total === 0) {
			new Notice('Every title already has a studio.');
			return;
		}

		let cancelled = false;
		const cancelFn = (): void => { cancelled = true; };
		this.plugin.importProgress = { current: 0, total, cancel: cancelFn };
		dm.notifyChange();

		const notice = new Notice('', 0);
		const label = notice.messageEl.createSpan({ text: `Fetching studios… 0 / ${total}` });
		const cancelBtn = notice.messageEl.createEl('button', { cls: 'wl-btn wl-btn-sm wl-notice-cancel-btn', text: 'Cancel' });
		cancelBtn.addEventListener('click', cancelFn);

		const animeSource = this.plugin.settings.animeApiSource ?? 'jikan';
		let filled = 0;
		let missed = 0;
		try {
			for (let i = 0; i < pending.length; i++) {
				if (cancelled) break;
				const t = pending[i]!;
				try {
					const group = getApiGroupForType(t.type, this.plugin.settings.typeApiMapping);
					const found = await this.plugin.apiService.fetchStudio(t, animeSource, group);
					// a miss stores 'none' so the next run skips it instead of retrying forever
					await dm.updateStudio(t.id, found?.studio ?? [CREDITS_NONE], found?.tmdbId, found?.tmdbMediaType);
					if (found?.studio && !isCreditsNone(found.studio)) filled++; else missed++;
				} catch {
					missed++;
				}
				this.plugin.importProgress = { current: i + 1, total, cancel: cancelFn };
				label.textContent = `Fetching studios… ${i + 1} / ${total}`;
				await new Promise((r) => window.setTimeout(r, 0));
			}
		} finally {
			this.plugin.importProgress = null;
			dm.notifyChange();
			notice.hide();
		}

		const prefix = cancelled ? 'Cancelled: ' : 'Done: ';
		const missedMsg = missed > 0 ? `, ${missed} with no studio available` : '';
		new Notice(`${prefix}${filled} title${filled !== 1 ? 's' : ''} filled${missedMsg}.`);
	}

	private async runRegenerate(
		progressWrap: HTMLElement,
		progressBarFill: HTMLElement,
		progressText: HTMLElement,
	): Promise<void> {
		const titles = this.plugin.dataManager.getTitles();
		const reading = this.plugin.readingDataManager;
		const books = reading.getBooks();
		const manga = reading.getMangaList();
		const total = titles.length + books.length + manga.length;
		progressWrap.show();
		if (total === 0) {
			progressText.textContent = 'Done: no missing files found';
			return;
		}
		progressBarFill.style.width = `0%`;
		progressText.textContent = `0 / ${total}`;
		let created = 0;
		let skipped = 0;
		let done = 0;
		const tick = (wasCreated: boolean): void => {
			if (wasCreated) created++; else skipped++;
			done++;
			const pct = Math.round((done / total) * 100);
			progressBarFill.style.width = `${pct}%`;
			progressText.textContent = `${done} / ${total}`;
		};
		for (const title of titles) {
			tick(await this.plugin.dataManager.createMarkdownFileIfMissing(title));
		}
		for (const book of books) {
			tick(await reading.createReadingNoteIfMissing('book', book));
		}
		for (const m of manga) {
			tick(await reading.createReadingNoteIfMissing('manga', m));
		}
		if (created === 0) {
			progressText.textContent = 'Done: no missing files found';
		} else {
			progressText.textContent = `Done: ${created} file${created !== 1 ? 's' : ''} created, ${skipped} already existed`;
		}
	}

	// Settings groups (shared by API + Customize)

	/** Repaints a chip element's tone class. */
	/** Failed Test → short chip label + the full cause underneath. */
	private testFailure(err: unknown): ChipStatus {
		return { text: apiErrorShort(err), tone: 'error', detail: apiErrorMessage(err) };
	}

	private setChipTone(chip: HTMLElement, tone: ChipTone): void {
		chip.removeClasses(['is-ok', 'is-warn', 'is-error', 'is-idle', 'is-pending', 'is-count']);
		chip.addClass(`is-${tone}`);
	}

	/**
	 * One coloured settings group: accent header (icon disc, title, sub-line, live chip)
	 * over a plain body. The accent lives in the header only, so nothing fights a tint.
	 */
	private settingsGroup(
		parent: HTMLElement,
		opts: {
			title: string;
			sub: string;
			icon: string;
			variant: SettingsGroupVariant;
			/**
			 * body holds bare Obsidian `Setting` rows, which carry their own separators — so the
			 * body drops its gap
			 */
			rows?: boolean;
		},
	): { head: HTMLElement; body: HTMLElement; setChip: (status: ChipStatus) => void } {
		const box = parent.createDiv({ cls: `wl-sg wl-sg--${opts.variant}` });

		const head = box.createDiv({ cls: 'wl-sg-head' });
		const icon = head.createDiv({ cls: 'wl-sg-icon' });
		setIcon(icon, opts.icon);
		const titles = head.createDiv({ cls: 'wl-sg-titles' });
		titles.createDiv({ cls: 'wl-sg-title', text: opts.title });
		titles.createDiv({ cls: 'wl-sg-sub', text: opts.sub });

		const chip = head.createDiv({ cls: 'wl-sg-chip' });
		chip.createSpan({ cls: 'wl-sg-chip-dot' });
		const chipText = chip.createSpan({ cls: 'wl-sg-chip-text' });
		// groups with nothing to report never call setChip — an empty pill reads as broken
		chip.hide();

		return {
			head,
			body: box.createDiv({ cls: `wl-sg-body${opts.rows ? ' wl-sg-body--rows' : ''}` }),
			setChip: (status) => {
				chipText.textContent = status.text;
				this.setChipTone(chip, status.tone);
				chip.toggle(status.text.length > 0);
			},
		};
	}

	/**
	 * A sub-card inside a settings group — the Customize counterpart of the API page's
	 * provider card: label, optional (?) explanation, caller-filled body.
	 */
	private sgCard(
		parent: HTMLElement,
		opts: { label: string; help?: string },
	): HTMLElement {
		const card = parent.createDiv({ cls: 'wl-sg-card' });

		const head = card.createDiv({ cls: 'wl-sg-card-head' });
		head.createDiv({ cls: 'wl-sg-card-label', text: opts.label });

		if (opts.help) {
			const tools = head.createDiv({ cls: 'wl-sg-card-tools' });
			const toggle = tools.createEl('button', {
				cls: 'wl-sg-icon-btn wl-sg-help-btn',
				text: '?',
				attr: { 'aria-label': `About ${opts.label}` },
			});
			const help = card.createDiv({ cls: 'wl-sg-help wl-sg-help--card', text: opts.help });
			toggle.addEventListener('click', () => {
				const open = !help.hasClass('is-open');
				help.toggleClass('is-open', open);
				toggle.toggleClass('is-active', open);
			});
		}

		return card.createDiv({ cls: 'wl-sg-card-body' });
	}

	/** Segmented picker replacing the old "which API" dropdown. */
	private apiSegmented(
		parent: HTMLElement,
		opts: {
			label: string;
			options: { value: string; label: string }[];
			value: string;
			onChange: (v: string) => void;
		},
	): void {
		const row = parent.createDiv({ cls: 'wl-sg-seg-row' });
		row.createDiv({ cls: 'wl-sg-seg-label', text: opts.label });

		const wrap = row.createDiv({ cls: 'wl-sg-seg' });
		const btns = new Map<string, HTMLElement>();
		for (const o of opts.options) {
			const btn = wrap.createEl('button', { cls: 'wl-sg-seg-btn', text: o.label });
			btns.set(o.value, btn);
			btn.addEventListener('click', () => {
				btns.forEach((el, v) => {
					if (v === o.value) { el.addClass('is-active'); } else { el.removeClass('is-active'); }
				});
				opts.onChange(o.value);
			});
		}
		btns.get(opts.value)?.addClass('is-active');
	}

	/**
	 * A provider card: avatar + name + state on top, credential fields, then a footer with
	 * the status chip and the link / help / Test actions. Every keystroke recomputes the
	 * status, so an old "Connected" never outlives the key it was tested with.
	 */
	private apiProvider(parent: HTMLElement, spec: ApiProviderSpec): ApiProviderHandle {
		const card = parent.createDiv({ cls: 'wl-api-provider' });

		const head = card.createDiv({ cls: 'wl-api-provider-head' });
		head.createDiv({ cls: 'wl-api-provider-avatar', text: spec.initials });
		const names = head.createDiv({ cls: 'wl-api-provider-names' });
		names.createDiv({ cls: 'wl-api-provider-name', text: spec.name });
		if (spec.note) names.createDiv({ cls: 'wl-api-provider-note', text: spec.note });
		const state = head.createDiv({ cls: 'wl-api-provider-state' });
		if (spec.badge) state.textContent = spec.badge;

		// credential fields
		for (const f of spec.fields ?? []) {
			const field = card.createDiv({ cls: 'wl-api-field' });
			field.createDiv({ cls: 'wl-api-field-label', text: f.label });
			// plain fields keep the reveal button's gutter so every input ends on the same edge
			const row = field.createDiv({
				cls: `wl-api-field-row${f.secret ? '' : ' wl-api-field-row--plain'}`,
			});

			const input = row.createEl('input', { cls: 'wl-api-input' });
			input.type = f.secret ? 'password' : 'text';
			input.placeholder = f.placeholder;
			input.value = f.get();
			input.addEventListener('input', () => {
				f.set(input.value);
				refreshStatus();
			});
			f.onInput?.(input);

			if (f.secret) {
				const eye = row.createEl('button', { cls: 'wl-sg-icon-btn', attr: { 'aria-label': 'Show key' } });
				setIcon(eye, 'eye');
				eye.addEventListener('click', () => {
					const hidden = input.type === 'password';
					input.type = hidden ? 'text' : 'password';
					setIcon(eye, hidden ? 'eye-off' : 'eye');
					eye.setAttribute('aria-label', hidden ? 'Hide key' : 'Show key');
				});
			}
		}

		// footer: status + actions
		const foot = card.createDiv({ cls: 'wl-api-provider-foot' });
		const chip = foot.createDiv({ cls: 'wl-sg-chip' });
		chip.createSpan({ cls: 'wl-sg-chip-dot' });
		const chipText = chip.createSpan({ cls: 'wl-sg-chip-text' });

		const actions = foot.createDiv({ cls: 'wl-api-actions' });
		if (spec.link) {
			const a = actions.createEl('a', {
				cls: 'wl-api-link',
				href: spec.link.href,
				attr: { target: '_blank', rel: 'noopener noreferrer' },
			});
			a.createSpan({ text: spec.link.text });
			setIcon(a.createSpan({ cls: 'wl-api-link-icon' }), 'external-link');
		}

		let help: HTMLElement | null = null;
		if (spec.help) {
			const toggle = actions.createEl('button', {
				cls: 'wl-sg-icon-btn wl-sg-help-btn',
				text: '?',
				attr: { 'aria-label': `About ${spec.name}` },
			});
			toggle.addEventListener('click', () => {
				if (!help) return;
				const open = !help.hasClass('is-open');
				help.toggleClass('is-open', open);
				toggle.toggleClass('is-active', open);
			});
		}

		const diagnosis = card.createDiv({ cls: 'wl-api-diagnosis' });
		diagnosis.hide();

		const setStatus = (status: ChipStatus): void => {
			chipText.textContent = status.text;
			this.setChipTone(chip, status.tone);
			diagnosis.textContent = status.detail ?? '';
			diagnosis.toggle(!!status.detail);
		};
		const refreshStatus = (): void => setStatus(spec.status());

		const runTest = spec.test;
		if (runTest) {
			const test = actions.createEl('button', { cls: 'wl-api-test', text: 'Test' });
			test.addEventListener('click', () => {
				test.disabled = true;
				setStatus({ text: 'Testing…', tone: 'pending' });
				void (async () => {
					try {
						setStatus(await runTest());
					} finally {
						test.disabled = false;
					}
				})();
			});
		}

		if (spec.help) {
			help = card.createDiv({ cls: 'wl-sg-help', text: spec.help });
		}
		spec.extra?.(card);

		refreshStatus();

		return {
			setActive: (active) => {
				if (active === null) return;
				card.toggleClass('is-inactive', !active);
				state.textContent = active ? 'Active' : 'Inactive';
				state.toggleClass('is-active', active);
			},
			refreshStatus,
		};
	}

	private renderApi(el: HTMLElement): void {
		const page = el.createDiv({ cls: 'wl-sg-page' });
		const s = this.plugin.settings;

		// 1. Movies & TV shows
		const movies = this.settingsGroup(page, {
			title: 'Movies & TV shows',
			sub: 'Watchlist metadata, posters, cast and ratings',
			icon: 'clapperboard',
			variant: 'movies',
		});

		let omdb: ApiProviderHandle;
		let tmdb: ApiProviderHandle;
		const syncMovies = (): void => {
			const active = s.activeApi ?? 'OMDb';
			omdb.setActive(active === 'OMDb');
			tmdb.setActive(active === 'TMDB');
			const keyed = active === 'OMDb' ? !!s.omdbApiKey : !!s.tmdbApiKey;
			movies.setChip(
				keyed
					? { text: `${active} · key set`, tone: 'ok' }
					: { text: `${active} · key needed`, tone: 'warn' },
			);
		};

		this.apiSegmented(movies.body, {
			label: 'Active API',
			options: [{ value: 'OMDb', label: 'OMDb' }, { value: 'TMDB', label: 'TMDB' }],
			value: s.activeApi ?? 'OMDb',
			onChange: (v) => {
				s.activeApi = v as 'OMDb' | 'TMDB';
				void this.plugin.saveSettings();
				syncMovies();
			},
		});

		omdb = this.apiProvider(movies.body, {
			name: 'OMDb',
			initials: 'O',
			note: 'Up to 4 cast members and the director',
			link: { text: 'Get a free key', href: 'https://www.omdbapi.com/apikey.aspx' },
			help:
				'OMDb keys are free for personal use and arrive by email; the link in that ' +
				'email has to be clicked once before the key starts working.',
			fields: [{
				label: 'API key',
				placeholder: 'Paste your OMDb key here',
				secret: true,
				get: () => s.omdbApiKey,
				set: (v) => {
					s.omdbApiKey = v;
					this.plugin.apiService.setOmdbKey(v);
					this.debouncedSaveSettings();
					syncMovies();
				},
			}],
			status: () => (s.omdbApiKey
				? { text: 'Key set · not tested', tone: 'idle' }
				: { text: 'No key', tone: 'idle' }),
			test: async () => {
				try {
					const ok = await this.plugin.apiService.checkOmdbConnection();
					return ok
						? { text: 'Connected', tone: 'ok' as const }
						: { text: 'Failed; check your key', tone: 'error' as const };
				} catch (err) {
					return this.testFailure(err);
				}
			},
		});

		tmdb = this.apiProvider(movies.body, {
			name: 'TMDB',
			initials: 'T',
			note: 'Up to 10 cast members (billing order) and all credited directors',
			link: { text: 'Get a free token', href: 'https://www.themoviedb.org/settings/api' },
			help:
				'TMDB is used through the API Read Access Token (the long v4 bearer token), ' +
				'not the shorter v3 API key.',
			fields: [{
				label: 'API read access token',
				placeholder: 'Paste your TMDB token here',
				secret: true,
				get: () => s.tmdbApiKey ?? '',
				set: (v) => {
					s.tmdbApiKey = v;
					this.plugin.apiService.setTmdbKey(v);
					this.debouncedSaveSettings();
					syncMovies();
				},
			}],
			status: () => (s.tmdbApiKey
				? { text: 'Token set · not tested', tone: 'idle' }
				: { text: 'No token', tone: 'idle' }),
			test: async () => {
				try {
					const ok = await this.plugin.apiService.checkTmdbConnection();
					return ok
						? { text: 'Connected', tone: 'ok' as const }
						: { text: 'Failed; check your token', tone: 'error' as const };
				} catch (err) {
					return this.testFailure(err);
				}
			},
		});
		syncMovies();

		movies.body.createDiv({
			cls: 'wl-sg-note',
			text:
				'Missing a name? Use the + on a title\'s Director or Cast row to add your own. ' +
				'Manual additions are unlimited, sit after the fetched names, and are never ' +
				'overwritten by a refresh or by switching API.',
		});

		// 2. Anime
		const anime = this.settingsGroup(page, {
			title: 'Anime',
			sub: 'Watchlist anime metadata, airing schedules and scores',
			icon: 'sparkles',
			variant: 'anime',
		});
		anime.setChip({ text: 'Ready · no key needed', tone: 'ok' });

		let jikan: ApiProviderHandle;
		let anilist: ApiProviderHandle;
		const syncAnime = (): void => {
			const active = s.animeApiSource ?? 'jikan';
			jikan.setActive(active === 'jikan');
			anilist.setActive(active === 'anilist');
		};

		this.apiSegmented(anime.body, {
			label: 'Active API',
			options: [{ value: 'jikan', label: 'Jikan' }, { value: 'anilist', label: 'AniList' }],
			value: s.animeApiSource ?? 'jikan',
			onChange: (v) => {
				s.animeApiSource = v as 'jikan' | 'anilist';
				void this.plugin.saveSettings();
				syncAnime();
			},
		});

		jikan = this.apiProvider(anime.body, {
			name: 'Jikan',
			initials: 'J',
			note: 'MyAnimeList\'s database, the larger catalogue',
			status: () => ({ text: 'No key needed', tone: 'ok' }),
			help: 'Jikan is the unofficial MyAnimeList API. It is rate-limited but needs no account.',
		});

		anilist = this.apiProvider(anime.body, {
			name: 'AniList',
			initials: 'A',
			note: 'Own database, more precise airing schedules',
			status: () => ({ text: 'No key needed', tone: 'ok' }),
			help: 'AniList is queried over GraphQL and reports scores as a percentage.',
		});
		syncAnime();

		anime.body.createDiv({
			cls: 'wl-sg-note',
			text: 'This setting only affects new titles; existing titles keep their original API source.',
		});

		// 3. Books & manga
		const books = this.settingsGroup(page, {
			title: 'Books & manga',
			sub: 'Reading tab search, authors and cover art',
			icon: 'book-open',
			variant: 'books',
		});
		const syncBooks = (): void => {
			books.setChip(
				s.googleBooksApiKey
					? { text: 'Books · key set', tone: 'ok' }
					: { text: 'Books · key needed', tone: 'warn' },
			);
		};

		this.apiProvider(books.body, {
			name: 'Google Books',
			initials: 'G',
			note: 'Book search, authors, page counts and covers',
			badge: 'Books',
			link: { text: 'Google Cloud Console', href: 'https://console.cloud.google.com/apis/credentials' },
			help:
				'Create a project in the Google Cloud Console, enable the Books API, then create ' +
				'an API key under APIs & Services → Credentials. Book search does not work ' +
				'without it.',
			fields: [{
				label: 'API key',
				placeholder: 'Paste your Google Books key here',
				secret: true,
				get: () => s.googleBooksApiKey ?? '',
				set: (v) => {
					s.googleBooksApiKey = v;
					this.plugin.apiService.setGoogleBooksKey(v);
					this.debouncedSaveSettings();
					syncBooks();
				},
			}],
			status: () => (s.googleBooksApiKey
				? { text: 'Key set · not tested', tone: 'idle' }
				: { text: 'No key; book search is off', tone: 'warn' }),
			test: async () => {
				try {
					const ok = await this.plugin.apiService.checkGoogleBooksConnection();
					return ok
						? { text: 'Connected', tone: 'ok' as const }
						: { text: 'Failed', tone: 'error' as const };
				} catch (err) {
					return this.testFailure(err);
				}
			},
		});
		syncBooks();

		this.apiProvider(books.body, {
			name: 'Jikan',
			initials: 'J',
			note: 'Manga search, chapters, volumes and covers',
			badge: 'Manga',
			status: () => ({ text: 'No key needed', tone: 'ok' }),
			help:
				'Manga always goes through Jikan (MyAnimeList), whatever the anime API above ' +
				'is set to. No account or key is involved.',
		});

		// 4. Games
		const games = this.settingsGroup(page, {
			title: 'Games',
			sub: 'Games tab search, covers, platforms and store links',
			icon: 'gamepad-2',
			variant: 'games',
		});

		let rawg: ApiProviderHandle;
		let igdb: ApiProviderHandle;
		const syncGames = (): void => {
			const active = s.gamesApiSource ?? 'rawg';
			rawg.setActive(active === 'rawg');
			igdb.setActive(active === 'igdb');
			const keyed = active === 'rawg'
				? !!s.rawgApiKey
				: !!(s.igdbClientId && s.igdbClientSecret);
			games.setChip(
				keyed
					? { text: `${active === 'rawg' ? 'RAWG' : 'IGDB'} · key set`, tone: 'ok' }
					: { text: `${active === 'rawg' ? 'RAWG' : 'IGDB'} · key needed`, tone: 'warn' },
			);
		};

		this.apiSegmented(games.body, {
			label: 'Active API',
			options: [{ value: 'rawg', label: 'RAWG' }, { value: 'igdb', label: 'IGDB' }],
			value: s.gamesApiSource ?? 'rawg',
			onChange: (v) => {
				s.gamesApiSource = v as 'rawg' | 'igdb';
				void this.plugin.saveSettings();
				syncGames();
			},
		});

		rawg = this.apiProvider(games.body, {
			name: 'RAWG',
			initials: 'R',
			note: 'Search, covers, platforms and store links',
			link: { text: 'Get a free key', href: 'https://rawg.io/apidocs' },
			help: 'RAWG also carries PC requirements, which IGDB does not expose.',
			fields: [{
				label: 'API key',
				placeholder: 'Paste your RAWG key here',
				secret: true,
				get: () => s.rawgApiKey ?? '',
				set: (v) => {
					s.rawgApiKey = v;
					this.plugin.apiService.setRawgKey(v);
					this.debouncedSaveSettings();
					syncGames();
				},
			}],
			status: () => (s.rawgApiKey
				? { text: 'Key set · not tested', tone: 'idle' }
				: { text: 'No key', tone: 'idle' }),
			test: async () => {
				try {
					const ok = await this.plugin.apiService.checkRawgConnection();
					return ok
						? { text: 'Connected', tone: 'ok' as const }
						: { text: 'Failed; check your key', tone: 'error' as const };
				} catch (err) {
					return this.testFailure(err);
				}
			},
		});

		igdb = this.apiProvider(games.body, {
			name: 'IGDB',
			initials: 'I',
			note: 'Search, covers, platforms and trailers',
			link: { text: 'Register a Twitch app', href: 'https://dev.twitch.tv/console/apps' },
			help:
				'IGDB authenticates through Twitch: register an application to get a Client ID ' +
				'and Client Secret. The access token is fetched and refreshed automatically.',
			fields: [
				{
					label: 'Client ID',
					placeholder: 'Paste your Twitch client ID here',
					secret: true,
					get: () => s.igdbClientId ?? '',
					set: (v) => {
						s.igdbClientId = v;
						this.plugin.apiService.setIgdbCredentials(v, s.igdbClientSecret ?? '');
						this.debouncedSaveSettings();
						syncGames();
					},
				},
				{
					label: 'Client secret',
					placeholder: 'Paste your Twitch client secret here',
					secret: true,
					get: () => s.igdbClientSecret ?? '',
					set: (v) => {
						s.igdbClientSecret = v;
						this.plugin.apiService.setIgdbCredentials(s.igdbClientId ?? '', v);
						this.debouncedSaveSettings();
						syncGames();
					},
				},
			],
			status: () => (s.igdbClientId && s.igdbClientSecret
				? { text: 'Credentials set · not tested', tone: 'idle' }
				: { text: 'Credentials incomplete', tone: 'idle' }),
			test: async () => {
				try {
					const ok = await this.plugin.apiService.checkIgdbConnection();
					return ok
						? { text: 'Connected', tone: 'ok' as const }
						: { text: 'Failed; check the ID and secret', tone: 'error' as const };
				} catch (err) {
					return this.testFailure(err);
				}
			},
		});
		syncGames();

		// Steam sits outside the segmented pair on purpose: no search endpoint, so it can't back
		// the add flow — it only syncs playtime and achievements from your own account
		let steamIdInput: HTMLInputElement | null = null;
		const steam = this.apiProvider(games.body, {
			name: 'Steam',
			initials: 'S',
			note: 'Syncs playtime and achievements from your own library',
			badge: 'Companion',
			link: { text: 'Get a Web API key', href: 'https://steamcommunity.com/dev/apikey' },
			help:
				'Steam has no search endpoint, so it never replaces the API above; it runs ' +
				'alongside it. Your Steam profile\'s "Game details" privacy must be set to ' +
				'Public, or Steam returns an empty library even to your own key.',
			fields: [
				{
					label: 'Web API key',
					placeholder: 'Paste your Steam Web API key here',
					secret: true,
					get: () => s.steamApiKey ?? '',
					set: (v) => {
						s.steamApiKey = v;
						this.plugin.apiService.setSteamCredentials(v, s.steamId ?? '');
						this.debouncedSaveSettings();
					},
				},
				{
					label: 'Steam ID or profile URL',
					placeholder: '76561198… or steamcommunity.com/id/yourname',
					get: () => s.steamId ?? '',
					set: (v) => {
						s.steamId = v;
						this.plugin.apiService.setSteamCredentials(s.steamApiKey ?? '', v);
						this.debouncedSaveSettings();
					},
					onInput: (input) => { steamIdInput = input; },
				},
			],
			status: () => (s.steamApiKey && s.steamId
				? { text: 'Credentials set · not tested', tone: 'idle' }
				: { text: 'Credentials incomplete', tone: 'idle' }),
			test: async () => {
				// resolve a vanity name / URL to a SteamID64 once and store it. The field is written in
				// place rather than via this.display(), which would detach the elements this handler holds.
				const resolved = await this.plugin.apiService.resolveSteamId(s.steamId ?? '');
				if (resolved && resolved !== s.steamId) {
					s.steamId = resolved;
					if (steamIdInput) steamIdInput.value = resolved;
					await this.plugin.saveSettings();
				}
				this.plugin.apiService.setSteamCredentials(s.steamApiKey ?? '', resolved || (s.steamId ?? ''));

				const result = await this.plugin.apiService.checkSteamConnection();
				return result.ok
					? { text: `Connected: ${result.games.length} games found`, tone: 'ok' as const }
					: { text: steamFailureLabel(result.reason), tone: 'error' as const };
			},
			extra: (card) => {
				const row = card.createDiv({ cls: 'wl-api-action' });
				const texts = row.createDiv({ cls: 'wl-api-action-texts' });
				texts.createDiv({ cls: 'wl-api-action-title', text: 'Sync Steam library' });
				texts.createDiv({
					cls: 'wl-api-action-desc',
					text: 'Updates playtime and achievements on matching games, and offers to import the rest.',
				});
				const btn = row.createEl('button', { cls: 'wl-api-action-btn mod-cta', text: 'Sync now' });
				btn.addEventListener('click', () => {
					if (!this.plugin.apiService.hasSteamCredentials()) {
						new Notice('Set your Steam API key and Steam ID first.');
						return;
					}
					new SteamSyncModal(this.app, this.plugin, this.plugin.gameDataManager).open();
				});
			},
		});
		steam.setActive(null);

		// API routing (always last)
		this.renderTypeApiMapping(page);
	}

	private renderTypeApiMapping(parent: HTMLElement): void {
		const card = parent.createDiv({ cls: 'wl-settings-card' });
		card.createDiv({ cls: 'wl-settings-card-title', text: 'API routing by type in Watchlist' });
		card.createDiv({
			cls: 'wl-settings-card-desc',
			text: 'Choose which API group to use for each title type. Anime, Movie, and TV Show are locked to their default APIs.',
		});

		const list = card.createDiv({ cls: 'wl-type-api-list' });
		const allTypes = this.plugin.settings.types ?? [];
		const mapping = this.plugin.settings.typeApiMapping ?? {};

		// prune stale entries (types that no longer exist)
		const validNames = new Set(allTypes.map((t) => t.name));
		let pruned = false;
		for (const key of Object.keys(mapping)) {
			if (!validNames.has(key) || key === 'Anime' || key === 'Movie' || key === 'TV Show' || key === 'TvShow') {
				delete mapping[key];
				pruned = true;
			}
		}
		if (pruned) void this.plugin.saveSettings();

		for (const t of allTypes) {
			const row = list.createDiv({ cls: 'wl-type-api-row' });
			row.createSpan({ cls: 'wl-type-api-name', text: t.name });

			if (t.name === 'Anime') {
				row.createSpan({ cls: 'wl-type-api-locked', text: 'Jikan / AniList (locked)' });
			} else if (t.name === 'Movie' || t.name === 'TV Show' || t.name === 'TvShow') {
				row.createSpan({ cls: 'wl-type-api-locked', text: 'OMDb / TMDB (locked)' });
			} else {
				const select = row.createEl('select', { cls: 'wl-select wl-type-api-select' });
				const current = mapping[t.name] ?? '';
				const opts: Array<{ value: '' | 'anime' | 'movie'; label: string }> = [
					{ value: '', label: '— Not set —' },
					{ value: 'anime', label: 'Anime API (Jikan / AniList)' },
					{ value: 'movie', label: 'Movie / TV API (OMDb / TMDB)' },
				];
				for (const o of opts) {
					const optEl = select.createEl('option', { text: o.label, value: o.value });
					if (current === o.value) optEl.selected = true;
				}
				select.addEventListener('change', () => {
					const v = select.value as '' | 'anime' | 'movie';
					if (!this.plugin.settings.typeApiMapping) this.plugin.settings.typeApiMapping = {};
					if (v === '') {
						delete this.plugin.settings.typeApiMapping[t.name];
					} else {
						this.plugin.settings.typeApiMapping[t.name] = v;
					}
					void this.plugin.saveSettings();
				});
			}
		}
	}

	// Customize

	/**
	 * Customize is grouped per library, reusing the API callouts (blue Watchlist / yellow
	 * Reading / red Games). Priority and the Rating system stay ungrouped below — they are
	 * shared by all three.
	 */
	private renderCustomize(el: HTMLElement): void {
		const page = el.createDiv({ cls: 'wl-sg-page' });
		const s = this.plugin.settings;

		// theme
		const theme = this.settingsGroup(page, {
			title: 'Theme',
			sub: 'Preset palette applied across every tab',
			icon: 'palette',
			variant: 'theme',
		});
		this.renderThemePicker(theme.body, (label) => theme.setChip({ text: label, tone: 'count' }));

		// cards
		const cards = this.settingsGroup(page, {
			title: 'Cards',
			sub: 'Size and text layout of the poster cards in every tab',
			icon: 'layout-grid',
			variant: 'cards',
		});
		this.renderCardSettings(cards.body, (label) => cards.setChip({ text: label, tone: 'count' }));

		// watchlist
		const watchlist = this.settingsGroup(page, {
			title: 'Watchlist',
			sub: 'Type, status and season colours for watch titles',
			icon: 'clapperboard',
			variant: 'watchlist',
		});
		const syncWatchlist = (): void => watchlist.setChip({
			text: `${s.types.length} types · ${s.statuses.length} statuses`,
			tone: 'count',
		});
		this.renderTagSection(watchlist.body, 'Type', 'types', syncWatchlist);
		this.renderTagSection(watchlist.body, 'Status', 'statuses', syncWatchlist);
		this.renderSeasonColors(watchlist.body);
		syncWatchlist();

		// reading
		const reading = this.settingsGroup(page, {
			title: 'Reading',
			sub: 'Badge and status colours for books and manga',
			icon: 'book-open',
			variant: 'reading',
		});
		this.renderReadingColors(reading.body);
		this.renderReadingStatusColors(reading.body);
		reading.setChip({ text: `2 types · ${READING_STATUSES.length} statuses`, tone: 'count' });

		// games
		const games = this.settingsGroup(page, {
			title: 'Games',
			sub: 'Status, genre and platform colours for the Games tab',
			icon: 'gamepad-2',
			variant: 'games',
		});
		const gamesSettings = (): GamesSettings => this.plugin.gameDataManager.getSettings();
		const syncGames = (): void => games.setChip({
			text: `${gamesSettings().types.length} genres · ${gamesSettings().platforms.length} platforms`,
			tone: 'count',
		});
		this.renderGamesTags(games.body, syncGames);
		syncGames();

		// shared across libraries
		const shared = this.settingsGroup(page, {
			title: 'Shared',
			sub: 'Priority and star ratings, used by all three libraries',
			icon: 'star',
			variant: 'shared',
		});
		const syncShared = (): void => shared.setChip({
			text: `${s.priorities.length} priorities · ${s.ratingSystem.length} tiers`,
			tone: 'count',
		});
		this.renderTagSection(shared.body, 'Priority', 'priorities', syncShared);
		this.renderRatingSystem(shared.body);
		syncShared();
	}

	/**
	 * Rating system — the five star tiers (1★…5★), each an editable colour + label. Drives
	 * every star control across Watchlist, Reading and Games. A whole star shares a tier
	 * with the half-step below (2.5★ and 3★ are both tier 3).
	 */
	private renderRatingSystem(el: HTMLElement): void {
		const wrap = this.sgCard(el, {
			label: 'Rating system',
			help: 'The color and text shown for each star rating across Watchlist, Reading, and Games. A whole star shares a tier with the half-step below it; e.g. 2.5★ and 3★ are both "Good".',
		});

		const list = wrap.createDiv({ cls: 'wl-rating-tier-list' });
		this.plugin.settings.ratingSystem.forEach((tier, idx) => {
			const tierNumber = idx + 1;
			const rowEl = list.createDiv({ cls: 'wl-rating-tier-row' });

			// clickable colour dot + hidden native picker
			const dotWrap = rowEl.createDiv({ cls: 'wl-tag-dot-wrap' });
			const dot = dotWrap.createSpan({ cls: 'wl-tag-dot' });
			dot.style.backgroundColor = tier.color;
			const colorPicker = dotWrap.createEl('input', {
				cls: 'wl-tag-color-picker',
				attr: { type: 'color', value: tier.color },
			});

			// static preview: `tierNumber` filled stars in the tier colour
			const preview = rowEl.createDiv({ cls: 'wl-star-rating wl-rating-tier-preview' });
			preview.style.setProperty('--wl-rating-color', tier.color);
			for (let i = 1; i <= 5; i++) {
				const star = preview.createSpan({ cls: 'wl-star', text: '★' });
				if (i <= tierNumber) star.addClass('is-active');
			}

			const labelInput = rowEl.createEl('input', {
				cls: 'wl-modal-input wl-rating-tier-label',
				attr: {
					type: 'text',
					value: tier.label,
					'aria-label': `Label for ${tierNumber}-star rating`,
				},
			});

			dot.addEventListener('click', () => colorPicker.click());
			colorPicker.addEventListener('change', () => {
				void (async () => {
					tier.color = colorPicker.value;
					dot.style.backgroundColor = colorPicker.value;
					preview.style.setProperty('--wl-rating-color', colorPicker.value);
					await this.plugin.saveSettings();
					this.refreshOpenViews();
				})();
			});

			// commit on change/blur; an empty label reverts to the stored value
			const commitLabel = (): void => {
				const val = labelInput.value.trim();
				if (!val) { labelInput.value = tier.label; return; }
				if (val === tier.label) return;
				tier.label = val;
				void (async () => {
					await this.plugin.saveSettings();
					this.refreshOpenViews();
				})();
			};
			labelInput.addEventListener('change', commitLabel);
			labelInput.addEventListener('blur', commitLabel);
		});
	}

	/** Re-render open WatchLog views + widgets so a display-setting edit shows immediately. */
	private refreshOpenViews(): void {
		activeDocument.dispatchEvent(new CustomEvent('watchlog-data-changed'));
		const leaves = this.plugin.app.workspace.getLeavesOfType('watchlog-view');
		for (const leaf of leaves) {
			if (leaf.view instanceof WatchLogView) leaf.view.refreshUI();
		}
	}

	/** Reading type badge colours — two fixed entries (Manga, Book), colour picker only. */
	private renderReadingColors(el: HTMLElement): void {
		const wrap = this.sgCard(el, {
			label: 'Type',
			help: 'The badge colour used for a Book or a Manga wherever its type is shown.',
		});

		const entries: Array<{ label: string; kind: 'manga' | 'book' }> = [
			{ label: 'Manga', kind: 'manga' },
			{ label: 'Book', kind: 'book' },
		];

		const tagsEl = wrap.createDiv({ cls: 'wl-tags-list' });
		for (const { label, kind } of entries) {
			const pill = tagsEl.createDiv({ cls: 'wl-tag-pill' });

			const dotWrap = pill.createDiv({ cls: 'wl-tag-dot-wrap' });
			const dot = dotWrap.createSpan({ cls: 'wl-tag-dot' });
			dot.style.backgroundColor = this.plugin.settings.readingTypeColors[kind];
			const colorPicker = dotWrap.createEl('input', {
				cls: 'wl-tag-color-picker',
				attr: { type: 'color', value: this.plugin.settings.readingTypeColors[kind] },
			});
			dot.addEventListener('click', () => colorPicker.click());
			colorPicker.addEventListener('change', () => {
				void (async () => {
					this.plugin.settings.readingTypeColors[kind] = colorPicker.value;
					dot.style.backgroundColor = colorPicker.value;
					await this.plugin.saveSettings();
				})();
			});

			pill.createSpan({ cls: 'wl-tag-name', text: label });
		}
	}

	/**
	 * Reading status colours — the five fixed statuses, colour only (the names are a TS
	 * union). Values live in `ReadingSettings.statusColors`, keyed by status name.
	 */
	private renderReadingStatusColors(el: HTMLElement): void {
		const readingData = this.plugin.readingDataManager;
		this.renderTagListSection(el, {
			label: 'Status',
			info: 'Status names are locked. Only the color can be changed.',
			getList: () => READING_STATUSES.map((name) => ({
				name,
				color: readingStatusColor(name, readingData.getSettings().statusColors),
			})),
			setColor: async (name, color) => {
				const next = { ...(readingData.getSettings().statusColors ?? {}), [name]: color };
				// updateSettings saves + notifies, so the Reading tab repaints
				await readingData.updateSettings({ statusColors: next });
			},
			isLocked: () => true,
		});
	}

	/**
	 * Games statuses / genres / platforms. Statuses are colour-only — their names carry
	 * behaviour (the auto "To be released", "Finished" and manual TBA slots). Genres and
	 * platforms are fully editable.
	 *
	 * Games reference genres and platforms **by name**, so a rename must cascade into the
	 * game records and into any stored filter selections, or it orphans them.
	 */
	private renderGamesTags(el: HTMLElement, onChanged?: () => void): void {
		const gameData = this.plugin.gameDataManager;
		const settings = (): GamesSettings => gameData.getSettings();

		this.renderTagListSection(el, {
			label: 'Status',
			info: 'Status names are locked. Only the color can be changed.',
			getList: () => settings().statuses,
			setColor: async (name, color) => {
				const tag = settings().statuses.find((t) => t.name === name);
				if (tag) tag.color = color;
				await gameData.updateSettings({ statuses: settings().statuses });
			},
			isLocked: () => true,
		});

		this.renderTagListSection(el, {
			label: 'Genre',
			onChanged,
			info: 'Genres can be renamed, recolored, added and removed. Renaming updates every game using that genre.',
			getList: () => settings().types,
			setColor: async (name, color) => {
				const tag = settings().types.find((t) => t.name === name);
				if (tag) tag.color = color;
				await gameData.updateSettings({ types: settings().types });
			},
			add: async (name, color) => {
				settings().types.push({ name, color });
				await gameData.updateSettings({ types: settings().types });
			},
			remove: async (name) => {
				// watchlist type behaviour: the games keep their stored genre string (it still renders,
				// with a fallback colour) — only the configured entry goes away
				await gameData.updateSettings({
					types: settings().types.filter((t) => t.name !== name),
				});
				this.clearGamesFilterRefs('type', name);
			},
			rename: async (from, to) => {
				const tag = settings().types.find((t) => t.name === from);
				if (tag) tag.name = to;
				for (const g of gameData.getGames()) {
					if (g.type === from) g.type = to;
				}
				this.renameGamesFilterRefs('type', from, to);
				await gameData.updateSettings({ types: settings().types });
			},
		});

		this.renderTagListSection(el, {
			label: 'Platform',
			onChanged,
			info: 'Platforms can be renamed, recolored, added and removed. Renaming updates every game using that platform; removing one clears it from them.',
			getList: () => settings().platforms,
			setColor: async (name, color) => {
				const tag = settings().platforms.find((t) => t.name === name);
				if (tag) tag.color = color;
				await gameData.updateSettings({ platforms: settings().platforms });
			},
			add: async (name, color) => {
				settings().platforms.push({ name, color });
				await gameData.updateSettings({ platforms: settings().platforms });
			},
			remove: async (name) => {
				// unlike genres, an orphaned platform name would be invisible (chips are drawn from this
				// list only), so strip it from the games too
				for (const g of gameData.getGames()) {
					if (g.platforms.includes(name)) {
						g.platforms = g.platforms.filter((p) => p !== name);
					}
				}
				await gameData.updateSettings({
					platforms: settings().platforms.filter((t) => t.name !== name),
				});
				this.clearGamesFilterRefs('platform', name);
			},
			rename: async (from, to) => {
				const tag = settings().platforms.find((t) => t.name === from);
				if (tag) tag.name = to;
				for (const g of gameData.getGames()) {
					if (g.platforms.includes(from)) {
						g.platforms = g.platforms.map((p) => (p === from ? to : p));
					}
				}
				this.renameGamesFilterRefs('platform', from, to);
				await gameData.updateSettings({ platforms: settings().platforms });
			},
		});

		el.createDiv({
			cls: 'wl-sg-note',
			text: 'Game note files pick up a renamed genre or platform the next time that game is saved.',
		});
	}

	/** Live-filter + saved-preset exclusion lists referencing a genre/platform by name. */
	private gamesFilterRefs(kind: 'type' | 'platform'): string[][] {
		// the Games filter calls the genre axis `genreExclude` (the field on the game itself is
		// `type`), so the two names differ by design
		const key = kind === 'type' ? 'genreExclude' : 'platformExclude';
		const lists: string[][] = [];
		const live = this.plugin.settings.gamesFilters;
		if (live?.[key]) lists.push(live[key]);
		const preset = this.plugin.gameDataManager.getSettings().savedFilterPreset;
		if (preset?.[key]) lists.push(preset[key]);
		return lists;
	}

	/** Keeps stored "exclude this genre/platform" selections pointing at the new name. */
	private renameGamesFilterRefs(kind: 'type' | 'platform', from: string, to: string): void {
		for (const list of this.gamesFilterRefs(kind)) {
			const idx = list.indexOf(from);
			if (idx !== -1) list[idx] = to;
		}
		void this.plugin.saveSettings();
	}

	/**
	 * Drops a deleted genre/platform from stored filters — it would otherwise stay an active
	 * exclusion with no checkbox left to clear it.
	 */
	private clearGamesFilterRefs(kind: 'type' | 'platform', name: string): void {
		for (const list of this.gamesFilterRefs(kind)) {
			const idx = list.indexOf(name);
			if (idx !== -1) list.splice(idx, 1);
		}
		void this.plugin.saveSettings();
	}

	/** `onPicked` reports the selected theme's label so the group header chip can follow it. */
	private renderThemePicker(el: HTMLElement, onPicked?: (label: string) => void): void {
		const themes: Array<{ key: 'default' | 'nightfall' | 'bluez'; label: string; colors: string[] }> = [
			{
				key: 'default',
				label: 'Default',
				colors: ['#1D9E75', '#378ADD', '#BA7517', '#7F77DD', '#E24B4A'],
			},
			{
				key: 'nightfall',
				label: 'Nightfall',
				colors: ['#10002B', '#3C096C', '#7B2CBF', '#C77DFF', '#E0AAFF'],
			},
			{
				key: 'bluez',
				label: 'Bluez',
				colors: ['#012A4A', '#01497C', '#2C7DA0', '#61A5C2', '#A9D6E5'],
			},
		];

		const currentTheme = this.plugin.settings.colorTheme ?? 'default';
		const cardsRow = el.createDiv({ cls: 'wl-theme-cards' });
		onPicked?.(themes.find((t) => t.key === currentTheme)?.label ?? 'Default');

		const allCards: HTMLElement[] = [];
		for (const theme of themes) {
			const card = cardsRow.createDiv({
				cls: `wl-theme-card${currentTheme === theme.key ? ' is-selected' : ''}`,
			});
			allCards.push(card);
			card.createDiv({ cls: 'wl-theme-card-name', text: theme.label });
			const strip = card.createDiv({ cls: 'wl-theme-strip' });
			for (const color of theme.colors) {
				const swatch = strip.createDiv({ cls: 'wl-theme-swatch' });
				swatch.style.backgroundColor = color;
			}
			card.addEventListener('click', () => {
				void (async () => {
					this.plugin.settings.colorTheme = theme.key;
					await this.plugin.saveSettings();
					for (const c of allCards) c.removeClass('is-selected');
					card.addClass('is-selected');
					onPicked?.(theme.label);
					activeDocument.dispatchEvent(new CustomEvent('watchlog-data-changed'));
					const leaves = this.plugin.app.workspace.getLeavesOfType('watchlog-view');
					for (const leaf of leaves) {
						if (leaf.view instanceof WatchLogView) {
							leaf.view.refreshUI();
						}
					}
				})();
			});
		}
	}

	private renderSeasonColors(el: HTMLElement): void {
		const wrap = this.sgCard(el, {
			label: 'Season colors',
			help: 'Colors cycle through seasons in order (Season 1 = color 1, etc.).',
		});

		const colorsEl = wrap.createDiv({ cls: 'wl-season-colors-list' });
		const renderColors = (): void => {
			colorsEl.empty();
			this.plugin.settings.seasonPalette.forEach((color, idx) => {
				const pill = colorsEl.createDiv({ cls: 'wl-season-color-pill' });
				const swatch = pill.createEl('input', {
					cls: 'wl-color-input',
					attr: { type: 'color', value: color },
				});
				swatch.addEventListener('change', () => {
					void (async () => {
						this.plugin.settings.seasonPalette[idx] = swatch.value;
						await this.plugin.saveSettings();
					})();
				});
				pill.createSpan({ cls: 'wl-season-color-label', text: `Season ${idx + 1}` });
				const del = pill.createSpan({ cls: 'wl-tag-del', text: '×' });
				del.addEventListener('click', () => {
					void (async () => {
						this.plugin.settings.seasonPalette.splice(idx, 1);
						await this.plugin.saveSettings();
						renderColors();
					})();
				});
			});
		};
		renderColors();

		const addRow = wrap.createDiv({ cls: 'wl-tag-add-row' });
		const colorInput = addRow.createEl('input', {
			cls: 'wl-color-input',
			attr: { type: 'color', value: '#888780' },
		});
		const addBtn = addRow.createEl('button', { cls: 'wl-btn wl-btn-success', text: '+ add color' });
		addBtn.addEventListener('click', () => {
			void (async () => {
				this.plugin.settings.seasonPalette.push(colorInput.value);
				await this.plugin.saveSettings();
				colorInput.value = '#888780';
				renderColors();
			})();
		});
	}

	private static readonly LOCKED_TYPES = ['Anime', 'Movie', 'TV Show'];

	/**
	 * One colour-picker-per-entry list section. Config-driven, so the same renderer serves
	 * lists in different stores: plugin settings, `data.games.settings`, and a plain colour
	 * record (Reading, whose names are a fixed union). Callers supply the accessors; this
	 * owns only the DOM.
	 */
	private renderTagListSection(parent: HTMLElement, cfg: TagListSectionConfig): void {
		const wrap = this.sgCard(parent, { label: cfg.label, help: cfg.info });

		const tagsEl = wrap.createDiv({ cls: 'wl-tags-list' });
		const renderTags = (): void => {
			tagsEl.empty();
			for (const tag of cfg.getList()) {
				this.renderTagListPill(tagsEl, tag, cfg, renderTags);
			}
			cfg.onChanged?.();
		};
		renderTags();

		if (cfg.add) {
			const addRow = wrap.createDiv({ cls: 'wl-tag-add-row' });
			const nameInput = addRow.createEl('input', {
				cls: 'wl-modal-input',
				attr: { type: 'text', placeholder: 'Name' },
			});
			const colorInput = addRow.createEl('input', {
				cls: 'wl-color-input',
				attr: { type: 'color', value: '#888780' },
			});
			const addBtn = addRow.createEl('button', { cls: 'wl-btn wl-btn-success', text: '+ add' });
			addBtn.addEventListener('click', () => {
				void (async () => {
					const name = nameInput.value.trim();
					if (!name) return;
					// names identify the entry everywhere (games store the name, not an id), so a duplicate
					// would make two rows indistinguishable
					if (cfg.getList().some((t) => t.name.toLowerCase() === name.toLowerCase())) {
						new Notice(`"${name}" already exists.`);
						return;
					}
					await cfg.add!(name, colorInput.value);
					nameInput.value = '';
					colorInput.value = '#888780';
					renderTags();
				})();
			});
		}
	}

	private renderTagListPill(
		parent: HTMLElement,
		tag: TagDefinition,
		cfg: TagListSectionConfig,
		refresh: () => void,
	): void {
		const pill = parent.createDiv({ cls: 'wl-tag-pill' });
		const locked = cfg.isLocked?.(tag.name) ?? false;

		const dotWrap = pill.createDiv({ cls: 'wl-tag-dot-wrap' });
		const dot = dotWrap.createSpan({ cls: 'wl-tag-dot' });
		dot.style.backgroundColor = tag.color;
		const colorPicker = dotWrap.createEl('input', {
			cls: 'wl-tag-color-picker',
			attr: { type: 'color', value: tag.color },
		});
		dot.addEventListener('click', () => colorPicker.click());
		colorPicker.addEventListener('change', () => {
			void (async () => {
				dot.style.backgroundColor = colorPicker.value;
				await cfg.setColor(tag.name, colorPicker.value);
			})();
		});

		if (cfg.rename && !locked) {
			// editable name; commits on change/blur, empty or duplicate reverts
			const nameInput = pill.createEl('input', {
				cls: 'wl-tag-name-input',
				attr: {
					type: 'text',
					value: tag.name,
					// sized to the current name, so "Xbox Series X|S" isn't cramped and short ones leave no
					// dead space
					size: String(Math.max(6, tag.name.length)),
					'aria-label': `Rename ${tag.name}`,
				},
			});
			const original = tag.name;
			// `change` and `blur` both fire when committing with the mouse, and the rename is async —
			// without this guard the second call sees the new name already in the list and reports a
			// bogus "already exists"
			let committed = false;
			const commit = (): void => {
				if (committed) return;
				const next = nameInput.value.trim();
				if (!next || next === original) { nameInput.value = original; return; }
				if (cfg.getList().some((t) => t.name.toLowerCase() === next.toLowerCase())) {
					new Notice(`"${next}" already exists.`);
					nameInput.value = original;
					return;
				}
				committed = true;
				void (async () => {
					await cfg.rename!(original, next);
					refresh();
				})();
			};
			nameInput.addEventListener('change', commit);
			nameInput.addEventListener('blur', commit);
		} else {
			pill.createSpan({ cls: 'wl-tag-name', text: tag.name });
		}

		if (cfg.remove && !locked) {
			const del = pill.createSpan({ cls: 'wl-tag-del', text: '×' });
			del.addEventListener('click', () => {
				void (async () => {
					await cfg.remove!(tag.name);
					refresh();
					new Notice(`Removed "${tag.name}".`);
				})();
			});
		}
	}

	/** The three plugin-settings lists (Watchlist types/statuses, Priority). */
	private renderTagSection(
		parent: HTMLElement,
		label: string,
		key: 'types' | 'statuses' | 'priorities',
		onChanged?: () => void,
	): void {
		const isStatuses = key === 'statuses';
		const isTypes = key === 'types';
		const persist = async (): Promise<void> => { await this.plugin.saveSettings(); };

		this.renderTagListSection(parent, {
			label,
			onChanged,
			info: isStatuses
				? 'Status names are locked. Only the color can be changed.'
				: isTypes
					? 'Built-in types are locked. Custom types can be added and removed.'
					: undefined,
			getList: () => this.plugin.settings[key],
			setColor: async (name, color) => {
				const tag = this.plugin.settings[key].find((t) => t.name === name);
				if (tag) tag.color = color;
				await persist();
			},
			// statuses are colour-only; locked built-in types keep their picker but lose delete
			isLocked: (name) =>
				isStatuses || (isTypes && WatchLogSettingsTab.LOCKED_TYPES.includes(name)),
			...(isStatuses ? {} : {
				add: async (name, color) => {
					this.plugin.settings[key].push({ name, color });
					await persist();
				},
				remove: async (name) => {
					this.plugin.settings[key] = this.plugin.settings[key].filter((t) => t.name !== name);
					await persist();
				},
			}),
		});
	}

	// Folders

	private renderWatchlist(container: HTMLElement): void {
		const page = container.createDiv({ cls: 'wl-sg-page' });

		// main
		const el = this.settingsGroup(page, {
			title: 'Main',
			sub: 'Episode numbering, add defaults and badge style',
			icon: 'clapperboard',
			variant: 'watchlist',
			rows: true,
		}).body;

		new Setting(el)
			.setName('Episode numbering')
			.setDesc('Absolute: episodes numbered 1→n across all seasons. Per season: each season restarts from 1 (display only, data is unchanged).')
			.addDropdown((d) =>
				d
					.addOptions({ absolute: 'Absolute', 'per-season': 'Per season' })
					.setValue(this.plugin.settings.episodeNumbering ?? 'absolute')
					.onChange(async (v) => {
						this.plugin.settings.episodeNumbering = v as 'absolute' | 'per-season';
						await this.plugin.saveSettings();
						activeDocument.dispatchEvent(new CustomEvent('watchlog-data-changed'));
					}),
			);

		new Setting(el)
			.setName('Default type for new titles')
			.setDesc('Type preselected when adding a title. "Last type used" follows whatever you added last.')
			.addDropdown((d) => {
				d.addOption(LAST_USED_TYPE_SENTINEL, '* Last type used');
				for (const t of this.plugin.settings.types) {
					d.addOption(t.name, t.name);
				}
				d.setValue(this.plugin.settings.defaultAddType ?? LAST_USED_TYPE_SENTINEL).onChange(
					async (v) => {
						this.plugin.settings.defaultAddType = v;
						await this.plugin.saveSettings();
					},
				);
			});

		new Setting(el)
			.setName('Top directors / actors count')
			.setDesc('How many entries the dashboard shows in its top directors and top actors lists.')
			.addText((t) => {
				t.inputEl.type = 'number';
				t.inputEl.min = '1';
				t.inputEl.addClass('wl-settings-count-input');
				t.setValue(String(this.plugin.settings.dashboardTopCredits ?? 5)).onChange(
					async (v) => {
						const n = parseInt(v, 10);
						if (isNaN(n) || n < 1) return;
						this.plugin.settings.dashboardTopCredits = n;
						await this.plugin.saveSettings();
						activeDocument.dispatchEvent(new CustomEvent('watchlog-data-changed'));
					},
				);
			});

		new Setting(el)
			.setName('Auto-complete on last episode')
			.setDesc('Mark status as completed when all episodes are watched.')
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.autoCompleteOnLastEpisode)
					.onChange(async (v) => {
						this.plugin.settings.autoCompleteOnLastEpisode = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(el)
			.setName('Colored type badges')
			.setDesc('Show type and status badges with their configured colors. Disable for a plain text style.')
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.coloredTypeBadges)
					.onChange(async (v) => {
						this.plugin.settings.coloredTypeBadges = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(el)
			.setName('Type sub-tabs')
			.setDesc('Show an All tab plus one sub-tab per type. When on, the Type filter in Filters is hidden.')
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.watchlistTypeSubTabs ?? false)
					.onChange(async (v) => {
						this.plugin.settings.watchlistTypeSubTabs = v;
						if (v) {
							const lf = this.plugin.settings.listFilters;
							if (lf) lf.typeExclude = [];
						}
						await this.plugin.saveSettings();
						this.plugin.dataManager.notifyChange();
					}),
			);

		new Setting(el)
			.setName('Open watchlist after adding')
			.setDesc('Jump to the watchlist tab and open the new title after adding it from the command palette.')
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.openWatchlistAfterAdd ?? true)
					.onChange(async (v) => {
						this.plugin.settings.openWatchlistAfterAdd = v;
						await this.plugin.saveSettings();
					}),
			);

		// import / export CSV
		const csv = this.settingsGroup(page, {
			title: 'Import / Export CSV',
			sub: 'Move watch titles in and out of the plugin',
			icon: 'file-spreadsheet',
			variant: 'csv',
			rows: true,
		}).body;

		new Setting(csv)
			.setName('Export to CSV')
			.setDesc('Export selected titles as a CSV file.')
			.addButton((b) =>
				b.setButtonText('Export CSV').onClick(() => {
					new CsvModal(this.app, this.plugin, this.plugin.dataManager, 'export').open();
				}),
			);

		new Setting(csv)
			.setName('Import from CSV')
			.setDesc('Import titles from a CSV file. Duplicates are highlighted before import.')
			.addButton((b) =>
				b.setButtonText('Import CSV').onClick(() => {
					new CsvModal(this.app, this.plugin, this.plugin.dataManager, 'import').open();
				}),
			);

		// folders
		const folders = this.settingsGroup(page, {
			title: 'Folders',
			sub: 'Where watch notes are generated in your vault',
			icon: 'folder',
			variant: 'folders',
			rows: true,
		}).body;

		new Setting(folders)
			.setName('Root folder name')
			.setDesc('Vault folder where watchlog Markdown files are stored.')
			.addText((t) =>
				t
					.setValue(this.plugin.settings.rootFolder)
					.onChange(async (v) => {
						this.plugin.settings.rootFolder = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(folders)
			.setName('Auto-create folders')
			.setDesc('Automatically create type subfolders on plugin load.')
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.autoCreateFolders)
					.onChange(async (v) => {
						this.plugin.settings.autoCreateFolders = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(folders)
			.setName('Create folders now')
			.setDesc('Manually trigger folder creation for all current types.')
			.addButton((b) =>
				b.setButtonText('Create').onClick(async () => {
					await this.plugin.dataManager.ensureFolders();
					new Notice('Folders created.');
				}),
			);

		// type subfolders
		const subfolders = this.settingsGroup(page, {
			title: 'Type subfolders',
			sub: 'The folder path each configured type writes to',
			icon: 'folder-tree',
			variant: 'subfolders',
		});
		subfolders.setChip({
			text: `${this.plugin.settings.types.length} types`,
			tone: 'count',
		});

		const listEl = subfolders.body.createDiv({ cls: 'wl-folder-list' });
		for (const type of this.plugin.settings.types) {
			const row = listEl.createDiv({ cls: 'wl-folder-row' });
			row.createSpan({ cls: 'wl-folder-type', text: type.name });
			row.createSpan({
				cls: 'wl-folder-path',
				text: `${this.plugin.settings.rootFolder}/${type.name}`,
			});
		}
	}

	// Drafts

	private renderDrafts(container: HTMLElement): void {
		const page = container.createDiv({ cls: 'wl-sg-page' });

		// main
		const el = this.settingsGroup(page, {
			title: 'Main',
			sub: 'The tag scanned in your vault, and what happens after adding',
			icon: 'notebook-pen',
			variant: 'drafts',
			rows: true,
		}).body;

		new Setting(el)
			.setName('Vault tag to monitor')
			.setDesc('Lines containing this tag followed by a title will appear in the drafts tab.')
			.addText((t) =>
				t
					.setPlaceholder('#watchlog')
					.setValue(this.plugin.settings.draftsVaultTag ?? '#watchlog')
					.onChange(async (v) => {
						this.plugin.settings.draftsVaultTag = v.trim() || '#watchlog';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(el)
			.setName('After adding a title')
			.setDesc('What happens to a draft entry once you hit add and confirm.')
			.addDropdown((d) =>
				d
					.addOptions({ keep: 'Keep as Added', remove: 'Remove' })
					.setValue(this.plugin.settings.draftsAfterAdding ?? 'keep')
					.onChange(async (v) => {
						this.plugin.settings.draftsAfterAdding = v as 'keep' | 'remove';
						await this.plugin.saveSettings();
					}),
			);
	}

	// Custom Lists

	private renderCustomLists(container: HTMLElement): void {
		const page = container.createDiv({ cls: 'wl-sg-page' });

		// main
		const el = this.settingsGroup(page, {
			title: 'Main',
			sub: 'Columns every new list starts with',
			icon: 'table',
			variant: 'lists',
			rows: true,
		}).body;

		new Setting(el)
			.setName('Default columns')
			.setDesc('Columns pre-populated when creating a new list. The name column is always included.')
			.addButton((b) => {
				const count = (this.plugin.settings.defaultCustomColumns ?? []).length;
				b.setButtonText(`Edit (${count} column${count !== 1 ? 's' : ''})`);
				b.onClick(() => {
					new DefaultColumnsModal(this.app, this.plugin).open();
				});
			});

		// folder
		const folder = this.settingsGroup(page, {
			title: 'Folder',
			sub: 'Where custom list files live in your vault',
			icon: 'folder',
			variant: 'folders',
			rows: true,
		}).body;

		new Setting(folder)
			.setName('Custom lists folder path')
			.setDesc('Vault folder where custom list files are stored.')
			.addText((t) =>
				t
					.setValue(this.plugin.settings.customListsFolder ?? 'WatchLog/CustomLists')
					.onChange(async (v) => {
						this.plugin.settings.customListsFolder = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(folder)
			.setName('Create folder now')
			.setDesc('Manually create the custom lists folder in the vault.')
			.addButton((b) =>
				b.setButtonText('Create').onClick(async () => {
					const manager = new CustomListManager(this.app, this.plugin);
					await manager.ensureFolder();
					new Notice('Custom lists folder created.');
				}),
			);
	}

	// Reading

	private renderReading(container: HTMLElement): void {
		const readingData = this.plugin.readingDataManager;
		const settings = readingData.getSettings();
		const page = container.createDiv({ cls: 'wl-sg-page' });

		// main
		const main = this.settingsGroup(page, {
			title: 'Main',
			sub: 'Defaults applied when adding books and manga',
			icon: 'book-open',
			variant: 'reading',
			rows: true,
		});
		main.setChip({
			text: `${readingData.getBooks().length} books · ${readingData.getMangaList().length} manga`,
			tone: 'count',
		});
		const el = main.body;

		new Setting(el)
			.setName('Default status for new entries')
			.setDesc('Status pre-selected in the Add book / Add manga modal.')
			.addDropdown((d) => {
				const opts: Record<string, string> = {};
				for (const s of SELECTABLE_READING_STATUSES) opts[s] = s;
				d
					.addOptions(opts)
					.setValue(settings.defaultStatus)
					.onChange((v) => {
						void readingData.updateSettings({ defaultStatus: v as ReadingStatus });
					});
			});

		new Setting(el)
			.setName('Default sub-tab')
			.setDesc('Which sub-tab opens by default when you switch to the Reading tab.')
			.addDropdown((d) => {
				d
					.addOptions({ books: 'Books', manga: 'Manga' })
					.setValue(settings.defaultSubTab ?? 'books')
					.onChange((v) => {
						void readingData.updateSettings({ defaultSubTab: v as 'books' | 'manga' });
					});
			});

		// import / export CSV
		const csv = this.settingsGroup(page, {
			title: 'Import / Export CSV',
			sub: 'Move books and manga in and out of the plugin',
			icon: 'file-spreadsheet',
			variant: 'csv',
			rows: true,
		}).body;

		new Setting(csv)
			.setName('Export to CSV')
			.setDesc('Export your Books or Manga library as a CSV file.')
			.addButton((b) =>
				b.setButtonText('Export CSV').onClick(() => {
					new ReadingCsvChoiceModal(this.app, 'export', (kind) => {
						new ReadingCsvModal(this.app, this.plugin, kind, 'export').open();
					}).open();
				}),
			);

		new Setting(csv)
			.setName('Import from CSV')
			.setDesc('Import Books or Manga from a CSV file, with column mapping and duplicate detection.')
			.addButton((b) =>
				b.setButtonText('Import CSV').onClick(() => {
					new ReadingCsvChoiceModal(this.app, 'import', (kind) => {
						new ReadingCsvModal(this.app, this.plugin, kind, 'import').open();
					}).open();
				}),
			);

		// folder
		const folder = this.settingsGroup(page, {
			title: 'Folder',
			sub: 'Where reading notes are generated in your vault',
			icon: 'folder',
			variant: 'folders',
			rows: true,
		}).body;

		new Setting(folder)
			.setName('Reading folder path')
			.setDesc('Vault folder where reading note files are generated. Changing this will not move existing files.')
			.addText((t) =>
				t
					.setPlaceholder('WatchLog/Reading')
					.setValue(settings.defaultFolder)
					.onChange((v) => {
						const next = v.trim() || 'WatchLog/Reading';
						void readingData.updateSettings({ defaultFolder: next });
					}),
			);
	}

	// Quick Info

	private renderQuickInfo(el: HTMLElement): void {
		el.createDiv({ cls: 'wl-settings-section-title', text: 'Quick Info' });

		const sections: { title: string; items: { heading: string; body: string }[] }[] = [
			{
				title: '📊 Dashboard',
				items: [
					{
						heading: 'Please note',
						body: 'Statuses To be released or Dropped (time left) are not included in any calculations, only Watching, Completed and Dropped (time watched).',
					},
					{
						heading: 'Time Watched',
						body: 'Calculated as: episodes watched × episode duration, summed across all titles with status Watching and Completed.',
					},
					{
						heading: 'Time Remaining',
						body: 'Calculated as: episodes remaining × episode duration, summed across all titles with status Watching and Plan to Watch.',
					},
					{
						heading: 'Dropped',
						body: 'Calculated as: episodes watched × episode duration, summed across all titles with status Dropped.',
					},
				],
			},
			{
				title: '📋 Watchlist',
				items: [
					{
						heading: 'Why Groups exist',
						body: 'Groups let you combine related titles under one entry; for example, a movie and its sequel, a TV show and its anime adaptation, or an anime series and its movie. They appear as a single collapsible row in your Watchlist.',
					},
					{
						heading: 'Group Rating',
						body: "A group's rating is automatically calculated as the average of all individual title ratings within it.",
					},
					{
						heading: 'Pin to Top',
						body: "Pinning a title moves it to the top of your Watchlist regardless of sorting. Pinned titles also appear in the Now Watching widget, so you can quickly see what you're currently watching inside your notes or Homepage.",
					},
					{
						heading: 'How to add a new season',
						body: 'Open the title and click Edit at the bottom. In the Edit modal, scroll down to the Seasons field and add a new line in the format "Season Name: N" (e.g. "Season 3: 10" or "Season name: 10").',
					},
				],
			},
			{
				title: '🔍 API & Search',
				items: [
					{
						heading: 'Which API is used for what',
						body: 'WatchLog uses a different API per content type:\n'
							+ '• Anime: Jikan (MyAnimeList data) or AniList, whichever you set under Settings → API → Anime. No key is needed for either.\n'
							+ '• Movies & TV Shows: OMDb or TMDB, whichever is set as active under Settings → API. Both need a free key/token.\n'
							+ '• Books (Reading): Google Books. A free API key is required; add it under Settings → API → Books.\n'
						+ '• Games: RAWG or IGDB, whichever you set under Settings → API → Games. RAWG needs a free key; IGDB needs a Twitch Client ID and Secret.\n'
							+ '• Manga (Reading): Jikan (MyAnimeList data). No key needed.\n\n'
							+ 'The anime API choice only affects new titles; existing titles keep the source they were added with.\n\n'
							+ 'Make sure the correct type is selected before searching. If Anime is selected and you search for a movie or TV show (or vice versa), it most likely won\'t be found, because each type queries its own API. APIs are a convenience, not a requirement; you can always add a title manually. The "Add from URL" button also relies on an API.',
					},
				],
			},
			{
				title: '📚 Reading',
				items: [
					{
						heading: 'Books vs Manga',
						body: 'Reading has two independent sub-tabs: Books and Manga. Each keeps its own entries, custom columns, filters, sort order, and saved filter. Set which one opens by default under Settings → Reading.',
					},
					{
						heading: 'Statuses',
						body: 'Reading entries use five statuses: Reading, Completed, Plan to Read, To be released, and Dropped. "To be released" is set automatically when an entry has a release date in the future and cannot be chosen manually; once that date passes, the entry reverts to Plan to Read. Future-dated entries also appear in the shared Upcoming tab.',
					},
					{
						heading: 'Progress tracking',
						body: 'Books track pages read out of total pages; or words, if you prefer: the Pages/Words switch on the Progress section of a book\'s detail view sets the unit per book, and both counters are kept, so switching back and forth never loses numbers. Manga track chapters read out of total chapters, plus volumes read out of total volumes. The card progress bar fills based on the book\'s chosen unit (or chapters, for manga); entries with no total show "No progress" instead of a percentage. On the Dashboard, words-tracked books are folded into the Books ring at 250 words per page so one ring can cover both units.',
					},
					{
						heading: 'Notes & favorite quotes',
						body: 'Each entry generates a Markdown note file (under your Reading folder) with frontmatter plus Notes and Quotes sections. Favorite quotes you add from an entry\'s detail view are saved into that note as quote callouts, so they live alongside your own notes.',
					},
					{
						heading: 'Covers',
						body: 'Covers are fetched automatically as cards scroll into view; Google Books for books, Jikan for manga. If a cover is missing or wrong, use "Refresh cover" from a card\'s ⋮ menu. (Refreshing a book cover needs the Google Books API key.)',
					},
					{
						heading: 'Custom columns',
						body: 'Use the ⚙ button in the Reading toolbar to add custom columns (text, number, or select). Columns are per sub-tab, and you can filter and sort by them just like the built-in fields.',
					},
				],
			},
			{
				title: '📅 Upcoming',
				items: [
					{
						heading: 'How Upcoming works',
						body: 'Any title with a release date set in the future is automatically marked as To be released and appears in this tab. This status cannot be set manually; it is determined solely by the release date you enter. If a title has already started airing but only some episodes are out (e.g. an ongoing series), it will not appear here automatically; you\'ll need to manually add it through the Add button in the Upcoming tab.',
					},
				],
			},
		];

		for (const section of sections) {
			const wrapper = el.createDiv({ cls: 'wl-qi-section' });

			const header = wrapper.createDiv({ cls: 'wl-qi-section-header' });
			const chevron = header.createSpan({ cls: 'wl-qi-chevron', text: '▶' });
			header.createSpan({ cls: 'wl-qi-section-label', text: section.title });

			const body = wrapper.createDiv({ cls: 'wl-qi-section-body wl-qi-section-body-hidden' });

			for (const item of section.items) {
				const banner = body.createDiv({ cls: 'wl-qi-banner' });
				banner.createDiv({ cls: 'wl-qi-banner-heading', text: item.heading });
				banner.createDiv({ cls: 'wl-qi-banner-body', text: item.body });
			}

			header.addEventListener('click', () => {
				const isOpen = !body.hasClass('wl-qi-section-body-hidden');
				if (isOpen) { body.addClass('wl-qi-section-body-hidden'); } else { body.removeClass('wl-qi-section-body-hidden'); }
				chevron.textContent = isOpen ? '▶' : '▼';
			});
		}
	}

	// Widgets

	private renderWidgets(el: HTMLElement): void {
		el.createDiv({
			cls: 'wl-settings-info',
			text: 'Insert widgets into notes using the "WatchLog: Insert widget" command. Configure the keyboard shortcut in Obsidian Settings → Hotkeys.',
		});

		const widgets = [
			{
				name: 'wl-todo',
				desc: 'Track a specific title inline; shows type, status, progress, and a "next episode" checkbox.',
				syntax: '```wl-todo\nTitle Name\nmini\n```',
			},
			{
				name: 'wl-todo (full)',
				desc: 'Track a specific title inline (full card).',
				syntax: '```wl-todo\nTitle Name\n```',
			},
			{
				name: 'wl-stat: completed',
				desc: 'Completed titles count, compact inline stat card.',
				syntax: '```wl-stat\ncompleted\n```',
			},
			{
				name: 'wl-stat: time',
				desc: 'Time watched & remaining combined (mini).',
				syntax: '```wl-stat\ntime\n```',
			},
			{
				name: 'wl-upcoming: next',
				desc: 'Next upcoming title with name, type badge, release date, and countdown.',
				syntax: '```wl-upcoming\nnext\n```',
			},
			{
				name: 'wl-nowwatching',
				desc: 'Currently pinned title with name, type badge, and progress bar.',
				syntax: '```wl-nowwatching\n```',
			},
			{
				name: 'wl-stat: time completed full',
				desc: 'Full-width triple card: Time Watched · Time Remaining · Completed.',
				syntax: '```wl-stat\ntime completed full\n```',
			},
			{
				name: 'wl-now-next',
				desc: 'Full-width double card: Now Watching · Up Next.',
				syntax: '```wl-now-next\n```',
			},
		];

		for (const w of widgets) {
			const section = el.createDiv({ cls: 'wl-widget-info-section' });
			section.createDiv({ cls: 'wl-widget-info-name', text: w.name });
			section.createDiv({ cls: 'wl-widget-info-desc', text: w.desc });
			const codeRow = section.createDiv({ cls: 'wl-widget-info-code-row' });
			codeRow.createEl('code', { cls: 'wl-widget-info-code', text: w.syntax });
			const copyBtn = codeRow.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Copy' });
			copyBtn.addEventListener('click', () => {
				void navigator.clipboard.writeText(w.syntax).then(() => {
					copyBtn.textContent = 'Copied!';
					window.setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
				});
			});
		}
	}
}
