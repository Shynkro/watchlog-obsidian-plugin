import { App, Notice, Platform, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import type WatchLogPlugin from './main';
import type { TagDefinition, ReadingStatus, ReadingData } from './types';
import { SELECTABLE_READING_STATUSES } from './types';
import { CsvModal } from './CsvModal';
import { ReadingCsvChoiceModal } from './ReadingCsvChoiceModal';
import { ReadingCsvModal } from './ReadingCsvModal';
import { WatchLogView } from './WatchLogView';
import { CustomListManager, DefaultColumnsModal } from './CustomListsTab';
import { ConfirmModal } from './ConfirmModal';
import { googleBooksErrorMessage } from './ApiService';
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

	constructor(app: App, plugin: WatchLogPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('wl-settings');

		// Nav bar
		const nav = containerEl.createDiv({ cls: 'wl-settings-nav' });
		const sections: { key: SettingsSection; label: string }[] = [
			{ key: 'general', label: 'General' },
			{ key: 'api', label: 'API' },
			{ key: 'customize', label: 'Customize' },
			{ key: 'watchlist', label: 'Watchlist' },
			{ key: 'drafts', label: 'Drafts' },
			{ key: 'custom-lists', label: 'Custom Lists' },
			{ key: 'reading', label: 'Reading' },
			{ key: 'widgets', label: 'Widgets' },
			{ key: 'quick-info', label: 'Quick Info' },
		];

		const buttons: Map<SettingsSection, HTMLButtonElement> = new Map();
		for (const sec of sections) {
			const btn = nav.createEl('button', {
				cls: `wl-settings-nav-btn${this.activeSection === sec.key ? ' is-active' : ''}`,
				text: sec.label,
			});
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

	// ─── General ────────────────────────────────────────────────────────────────

	private renderGeneral(el: HTMLElement): void {
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
			.setDesc('Clears all cached poster and reading cover URLs. Watch posters reload lazily when you scroll the Cards view; reading covers can be re-fetched from each card\'s ⋮ menu.')
			.addButton((b) =>
				b.setButtonText('Re-fetch posters').onClick(() => {
					const titles = this.plugin.dataManager.getTitles();
					const readingCount = this.plugin.readingDataManager.getBooks().length + this.plugin.readingDataManager.getMangaList().length;
					new ConfirmModal(
						this.app,
						`This will clear cached images for all ${titles.length} watch titles and ${readingCount} reading entries. Items without API access will show placeholder cards. Continue?`,
						() => { void this.refetchAllPosters(); },
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

		// ── Backup & Restore ──────────────────────────────────────────────────────────
		el.createDiv({ cls: 'wl-settings-section-title', text: 'Backup & Restore' });

		new Setting(el)
			.setName('Export backup')
			.setDesc('Export all watchlog data — watchlist, reading (books & manga) and activity log — into a single timestamped .JSON file.')
			.addButton((b) =>
				b.setButtonText('Export backup').onClick(() => void this.exportBackup()),
			);

		new Setting(el)
			.setName('Restore from backup')
			.setDesc('Restore from a .JSON backup file. This replaces your current watchlist, reading and activity-log data with the contents of the backup. Older watch-only backups restore the watchlist only and leave reading and activity log untouched.')
			.addButton((b) =>
				b.setButtonText('Restore from backup').onClick(() => this.openRestoreDialog()),
			);

		const regenHolder = {
			wrap: null as HTMLElement | null,
			fill: null as HTMLElement | null,
			text: null as HTMLElement | null,
		};

		new Setting(el)
			.setName('Regenerate note files')
			.setDesc("Creates missing .md files for titles that don't have one. Existing files are not modified.")
			.addButton((b) =>
				b.setButtonText('Regenerate').onClick(() => {
					const { wrap, fill, text } = regenHolder;
					if (wrap && fill && text) void this.runRegenerate(wrap, fill, text);
				}),
			);

		const regenProgressWrap = el.createDiv({ cls: 'wl-regen-progress-wrap' });
		regenProgressWrap.hide();
		regenProgressWrap.createSpan({ cls: 'wl-csv-bg-note', text: 'You can close settings — regeneration continues in the background.' });
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

		// Version-2 snapshot: a self-describing wrapper around all three data sources.
		const snapshot = {
			version: 2,
			exportedAt: today.toISOString(),
			watch: this.plugin.dataManager.getData() ?? {},
			reading: this.plugin.readingDataManager.getData(),
			history: this.plugin.historyManager.exportEntries(),
		};
		const json = JSON.stringify(snapshot, null, 2);

		// On mobile the browser download lands in an inaccessible sandbox, so write
		// the backup into the vault instead. Desktop keeps the existing download path.
		if (Platform.isMobile) {
			await this.exportBackupToVault(filename, json);
			return;
		}

		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = activeDocument.createElement('a');
		a.href = url;
		a.download = filename;
		activeDocument.body.appendChild(a);
		a.click();
		activeDocument.body.removeChild(a);
		URL.revokeObjectURL(url);
		new Notice(`Backup exported as ${filename}`);
	}

	/** Mobile path: write the backup into WatchLog/backups/, disambiguating the name on collision. */
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

		// Mirror the reading-id slug disambiguation: keep the base name, then -2, -3, … on collision.
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
		const input = activeDocument.createElement('input');
		input.type = 'file';
		input.accept = '.json';
		input.hide();
		activeDocument.body.appendChild(input);
		let consumed = false;
		const cleanupInput = (): void => {
			if (input.parentElement) {
				try { activeDocument.body.removeChild(input); } catch { /* ignore */ }
			}
		};
		// If the picker is cancelled, focus returns to window. Clean up shortly after.
		const onFocus = (): void => {
			window.setTimeout(() => {
				if (!consumed) cleanupInput();
				window.removeEventListener('focus', onFocus);
			}, 200);
		};
		window.addEventListener('focus', onFocus);
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
					new Notice('Invalid backup file — could not parse JSON.');
					return;
				}
				if (typeof parsed !== 'object' || parsed === null) {
					new Notice('Invalid backup file — not an object.');
					return;
				}
				const p = parsed as Record<string, unknown>;

				// Validate the WHOLE file before touching disk — restore is all-or-nothing.
				if (p['version'] === 2) {
					const watch = p['watch'];
					const reading = p['reading'];
					const history = p['history'];
					if (!this.isValidWatchData(watch)) {
						new Notice('Invalid backup file — watch data missing required fields (titles, groups, settings).');
						return;
					}
					if (!this.isValidReadingData(reading)) {
						new Notice('Invalid backup file — reading data missing required fields (books, manga).');
						return;
					}
					if (!Array.isArray(history)) {
						new Notice('Invalid backup file — activity log is not a list.');
						return;
					}
					new ConfirmModal(this.app, 'This will replace ALL current watchlog data — watchlist, reading (books & manga) and activity log. Continue?', () => {
						void (async () => {
							await this.plugin.saveData(watch);
							await this.plugin.loadSettings();
							await this.plugin.dataManager.load();
							await this.plugin.readingDataManager.restore(reading as ReadingData);
							await this.plugin.historyManager.restore(history as HistoryEntry[]);
							activeDocument.dispatchEvent(new CustomEvent('watchlog-data-changed'));
							new Notice('Backup restored successfully.');
						})();
					}).open();
					return;
				}

				// Legacy (v1) — the file IS the watch data; reading & history are left untouched.
				if (!this.isValidWatchData(parsed)) {
					new Notice('Invalid backup file — missing required fields (titles, groups, settings).');
					return;
				}
				new ConfirmModal(this.app, 'This is a legacy (watchlist-only) backup. It will replace your current watchlist. Reading and activity-log data are left untouched. Continue?', () => {
					void this.plugin.saveData(parsed).then(async () => {
						await this.plugin.loadSettings();
						await this.plugin.dataManager.load();
						activeDocument.dispatchEvent(new CustomEvent('watchlog-data-changed'));
						new Notice('Legacy backup restored — watchlist only; reading and activity log left untouched.');
					});
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

	private async refetchAllPosters(): Promise<void> {
		const titles = this.plugin.dataManager.getTitles();
		for (const t of titles) t.posterUrl = '';
		await this.plugin.dataManager.save();

		// Also clear cached Reading cover URLs (Books + Manga) so they can be re-fetched.
		const reading = this.plugin.readingDataManager;
		for (const b of reading.getBooks()) b.coverUrl = '';
		for (const m of reading.getMangaList()) m.coverUrl = '';
		await reading.saveAndNotify();

		new Notice('Cached posters and covers cleared. Watch posters reload as you browse; refresh reading covers from each card\'s ⋮ menu.');
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
			progressText.textContent = 'Done — no missing files found';
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
			progressText.textContent = 'Done — no missing files found';
		} else {
			progressText.textContent = `Done — ${created} file${created !== 1 ? 's' : ''} created, ${skipped} already existed`;
		}
	}

	// ─── API ────────────────────────────────────────────────────────────────────

	/** Creates a faded, Obsidian-callout-style box and returns its body element for content. */
	private apiCallout(parent: HTMLElement, title: string, variant: 'movies' | 'anime' | 'books'): HTMLElement {
		const box = parent.createDiv({ cls: `wl-api-callout wl-api-callout--${variant}` });
		box.createDiv({ cls: 'wl-api-callout-title', text: title });
		return box.createDiv({ cls: 'wl-api-callout-body' });
	}

	private renderApi(el: HTMLElement): void {
		// ── 1. Movies & TV Shows ──────────────────────────────────────────────
		const movies = this.apiCallout(el, 'Movies & TV Shows', 'movies');

		new Setting(movies)
			.setName('Active API')
			.setDesc('Which API to use for movies and tv shows.')
			.addDropdown((d) =>
				d
					.addOptions({ OMDb: 'OMDb', TMDB: 'TMDB' })
					.setValue(this.plugin.settings.activeApi ?? 'OMDb')
					.onChange(async (v) => {
						this.plugin.settings.activeApi = v as 'OMDb' | 'TMDB';
						await this.plugin.saveSettings();
					}),
			);

		// OMDb key
		const omdbInfo = movies.createDiv({ cls: 'wl-settings-info' });
		omdbInfo.createSpan({ text: 'Get a free OMDb API key at ' });
		omdbInfo.createEl('a', {
			text: 'omdbapi.com/apikey.aspx',
			href: 'https://www.omdbapi.com/apikey.aspx',
			attr: { target: '_blank', rel: 'noopener noreferrer' },
		});
		omdbInfo.createSpan({ text: '.' });

		let omdbStatus: HTMLElement;
		new Setting(movies)
			.setName('Omdb API key')
			.addText((t) => {
				t
					.setPlaceholder('Paste your omdb key here')
					.setValue(this.plugin.settings.omdbApiKey)
					.onChange((v) => {
						this.plugin.settings.omdbApiKey = v;
						this.plugin.apiService.setOmdbKey(v);
						this.debouncedSaveSettings();
					});
				t.inputEl.type = 'password';
				return t;
			})
			.addButton((b) =>
				b.setButtonText('Test').onClick(async () => {
					const ok = await this.plugin.apiService.checkOmdbConnection();
					omdbStatus.textContent = ok ? '✓ Connected' : '✗ Failed — check your key';
					omdbStatus.className = ok ? 'wl-status-ok' : 'wl-status-error';
				}),
			);
		omdbStatus = movies.createDiv({
			cls: 'wl-status-indicator',
			text: this.plugin.settings.omdbApiKey ? '(not tested)' : 'Not set',
		});

		// TMDB token
		const tmdbInfo = movies.createDiv({ cls: 'wl-settings-info' });
		tmdbInfo.createSpan({ text: 'Get a free TMDB read access token at ' });
		tmdbInfo.createEl('a', {
			text: 'themoviedb.org/settings/api',
			href: 'https://www.themoviedb.org/settings/api',
			attr: { target: '_blank', rel: 'noopener noreferrer' },
		});
		tmdbInfo.createSpan({ text: '.' });

		let tmdbStatus: HTMLElement;
		new Setting(movies)
			.setName('Tmdb API read access token')
			.addText((t) => {
				t
					.setPlaceholder('Paste your tmdb key here')
					.setValue(this.plugin.settings.tmdbApiKey ?? '')
					.onChange((v) => {
						this.plugin.settings.tmdbApiKey = v;
						this.plugin.apiService.setTmdbKey(v);
						this.debouncedSaveSettings();
					});
				t.inputEl.type = 'password';
				return t;
			})
			.addButton((b) =>
				b.setButtonText('Test').onClick(async () => {
					const ok = await this.plugin.apiService.checkTmdbConnection();
					tmdbStatus.textContent = ok ? '✓ Connected' : '✗ Failed — check your key';
					tmdbStatus.className = ok ? 'wl-status-ok' : 'wl-status-error';
				}),
			);
		tmdbStatus = movies.createDiv({
			cls: 'wl-status-indicator',
			text: this.plugin.settings.tmdbApiKey ? '(not tested)' : 'Not set',
		});

		// ── 2. Anime ──────────────────────────────────────────────────────────
		const anime = this.apiCallout(el, 'Anime', 'anime');

		new Setting(anime)
			.setName('Anime API source')
			.setDesc('Which API to use for new anime titles.')
			.addDropdown((d) =>
				d
					.addOptions({ jikan: 'Jikan (MyAnimeList)', anilist: 'AniList' })
					.setValue(this.plugin.settings.animeApiSource ?? 'jikan')
					.onChange(async (v) => {
						this.plugin.settings.animeApiSource = v as 'jikan' | 'anilist';
						await this.plugin.saveSettings();
					}),
			);

		anime.createDiv({
			cls: 'wl-settings-info',
			text:
				'Jikan uses MyAnimeList\'s database (larger catalog, no API key needed). ' +
				'AniList has its own database with more precise airing schedules and a GraphQL API. ' +
				'This setting only affects new titles — existing titles keep their original API source.',
		});

		// ── 3. Books ──────────────────────────────────────────────────────────
		const books = this.apiCallout(el, 'Books', 'books');

		let googleStatus: HTMLElement;
		new Setting(books)
			.setName('Google Books API key')
			.addText((t) => {
				t
					.setPlaceholder('Paste your Google Books key here')
					.setValue(this.plugin.settings.googleBooksApiKey ?? '')
					.onChange((v) => {
						this.plugin.settings.googleBooksApiKey = v;
						this.plugin.apiService.setGoogleBooksKey(v);
						this.debouncedSaveSettings();
					});
				t.inputEl.type = 'password';
				return t;
			})
			.addButton((b) =>
				b.setButtonText('Test').onClick(async () => {
					googleStatus.textContent = 'Testing...';
					googleStatus.className = 'wl-status-indicator';
					try {
						const ok = await this.plugin.apiService.checkGoogleBooksConnection();
						googleStatus.textContent = ok ? '✓ Connected' : '✗ Failed';
						googleStatus.className = ok ? 'wl-status-ok' : 'wl-status-error';
					} catch (err) {
						googleStatus.textContent = `✗ ${googleBooksErrorMessage(err)}`;
						googleStatus.className = 'wl-status-error';
					}
				}),
			);
		googleStatus = books.createDiv({
			cls: 'wl-status-indicator',
			text: this.plugin.settings.googleBooksApiKey ? '(not tested)' : 'Not set',
		});

		const googleHelp = books.createDiv({ cls: 'wl-settings-info' });
		googleHelp.createSpan({ text: 'Get a free key in the Google Cloud Console: create a project, enable the Books API, then create an API key under ' });
		googleHelp.createEl('a', {
			text: 'APIs & Services → Credentials',
			href: 'https://console.cloud.google.com/apis/credentials',
			attr: { target: '_blank', rel: 'noopener noreferrer' },
		});
		googleHelp.createSpan({ text: '.' });

		// ── API routing (always last) ─────────────────────────────────────────
		this.renderTypeApiMapping(el);
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

		// Prune stale entries (types that no longer exist)
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

	// ─── Customize ──────────────────────────────────────────────────────────────

	private renderCustomize(el: HTMLElement): void {
		this.renderThemePicker(el);

		type TagKey = 'types' | 'statuses' | 'priorities';
		const sections: Array<{ key: TagKey; label: string }> = [
			{ key: 'types', label: 'Type' },
			{ key: 'statuses', label: 'Status' },
			{ key: 'priorities', label: 'Priority' },
		];

		for (const sec of sections) {
			this.renderTagSection(el, sec.label, sec.key);
		}

		this.renderSeasonColors(el);
		this.renderReadingColors(el);
	}

	/**
	 * Reading type badge colors — two fixed entries (Manga, Book), each a color
	 * picker only (no add/remove/rename), reusing the locked tag-pill row style.
	 */
	private renderReadingColors(el: HTMLElement): void {
		const wrap = el.createDiv({ cls: 'wl-tag-section' });
		wrap.createDiv({ cls: 'wl-settings-section-title', text: 'Reading' });

		const entries: Array<{ label: string; kind: 'manga' | 'book' }> = [
			{ label: 'Manga', kind: 'manga' },
			{ label: 'Book', kind: 'book' },
		];

		const tagsEl = wrap.createDiv({ cls: 'wl-tags-list' });
		for (const { label, kind } of entries) {
			const pill = tagsEl.createDiv({ cls: 'wl-tag-pill' });

			// Clickable color dot — opens native color picker (matches tag rows).
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

	private renderThemePicker(el: HTMLElement): void {
		const wrap = el.createDiv({ cls: 'wl-tag-section' });
		wrap.createDiv({ cls: 'wl-settings-section-title', text: 'Theme' });

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
		const cardsRow = wrap.createDiv({ cls: 'wl-theme-cards' });

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
		const wrap = el.createDiv({ cls: 'wl-tag-section' });
		wrap.createDiv({ cls: 'wl-settings-section-title', text: 'Season colors' });
		wrap.createDiv({
			cls: 'wl-settings-info',
			text: 'Colors cycle through seasons in order (Season 1 = color 1, etc.).',
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

	private renderTagSection(
		parent: HTMLElement,
		label: string,
		key: 'types' | 'statuses' | 'priorities',
	): void {
		const isStatuses = key === 'statuses';
		const isTypes = key === 'types';
		const wrap = parent.createDiv({ cls: 'wl-tag-section' });
		wrap.createDiv({ cls: 'wl-settings-section-title', text: label });

		if (isStatuses) {
			wrap.createDiv({
				cls: 'wl-settings-info',
				text: 'Status names are locked. Only the color can be changed.',
			});
		}

		if (isTypes) {
			wrap.createDiv({
				cls: 'wl-settings-info',
				text: 'Built-in types are locked. Custom types can be added and removed.',
			});
		}

		const tagsEl = wrap.createDiv({ cls: 'wl-tags-list' });
		const renderTags = (): void => {
			tagsEl.empty();
			for (const tag of this.plugin.settings[key]) {
				this.renderTagPill(tagsEl, tag, key, renderTags);
			}
		};
		renderTags();

		if (!isStatuses) {
			// Add row
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
					this.plugin.settings[key].push({ name, color: colorInput.value });
					await this.plugin.saveSettings();
					nameInput.value = '';
					colorInput.value = '#888780';
					renderTags();
				})();
			});
		}
	}

	private renderTagPill(
		parent: HTMLElement,
		tag: TagDefinition,
		key: 'types' | 'statuses' | 'priorities',
		refresh: () => void,
	): void {
		const pill = parent.createDiv({ cls: 'wl-tag-pill' });

		// Clickable color dot — opens native color picker
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
				tag.color = colorPicker.value;
				dot.style.backgroundColor = colorPicker.value;
				await this.plugin.saveSettings();
			})();
		});

		pill.createSpan({ cls: 'wl-tag-name', text: tag.name });

		// Statuses and locked built-in types: no delete button
		const isLockedType = key === 'types' && WatchLogSettingsTab.LOCKED_TYPES.includes(tag.name);
		if (key !== 'statuses' && !isLockedType) {
			const del = pill.createSpan({ cls: 'wl-tag-del', text: '×' });
			del.addEventListener('click', () => {
				void (async () => {
					this.plugin.settings[key] = this.plugin.settings[key].filter((t) => t.name !== tag.name);
					await this.plugin.saveSettings();
					refresh();
					new Notice(`Removed "${tag.name}".`);
				})();
			});
		}
	}

	// ─── Folders ────────────────────────────────────────────────────────────────

	private renderWatchlist(el: HTMLElement): void {
		new Setting(el)
			.setName('Default watchlist view')
			.setDesc('Which sub-tab opens by default when entering the Watchlist.')
			.addDropdown((d) =>
				d
					.addOptions({ list: 'List', cards: 'Cards' })
					.setValue(this.plugin.settings.defaultWatchlistView ?? 'cards')
					.onChange(async (v) => {
						this.plugin.settings.defaultWatchlistView = v as 'list' | 'cards';
						await this.plugin.saveSettings();
					}),
			);

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

		// ── Import / Export CSV ───────────────────────────────────────────────────────
		el.createDiv({ cls: 'wl-settings-section-title', text: 'Import / Export CSV' });

		new Setting(el)
			.setName('Export to CSV')
			.setDesc('Export selected titles as a CSV file.')
			.addButton((b) =>
				b.setButtonText('Export CSV').onClick(() => {
					new CsvModal(this.app, this.plugin, this.plugin.dataManager, 'export').open();
				}),
			);

		new Setting(el)
			.setName('Import from CSV')
			.setDesc('Import titles from a CSV file. Duplicates are highlighted before import.')
			.addButton((b) =>
				b.setButtonText('Import CSV').onClick(() => {
					new CsvModal(this.app, this.plugin, this.plugin.dataManager, 'import').open();
				}),
			);

		// ── Folders ───────────────────────────────────────────────────────────────────
		el.createDiv({ cls: 'wl-settings-section-title', text: 'Folders' });

		new Setting(el)
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

		new Setting(el)
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

		el.createDiv({ cls: 'wl-settings-section-title', text: 'Type subfolders' });
		const listEl = el.createDiv({ cls: 'wl-folder-list' });
		const renderList = (): void => {
			listEl.empty();
			for (const type of this.plugin.settings.types) {
				const row = listEl.createDiv({ cls: 'wl-folder-row' });
				row.createSpan({ cls: 'wl-folder-type', text: type.name });
				row.createSpan({
					cls: 'wl-folder-path',
					text: `${this.plugin.settings.rootFolder}/${type.name}`,
				});
			}
		};
		renderList();

		new Setting(el)
			.setName('Create folders now')
			.setDesc('Manually trigger folder creation for all current types.')
			.addButton((b) =>
				b.setButtonText('Create').onClick(async () => {
					await this.plugin.dataManager.ensureFolders();
					new Notice('Folders created.');
				}),
			);
	}

	// ─── Drafts ──────────────────────────────────────────────────────────────────

	private renderDrafts(el: HTMLElement): void {
		el.createDiv({ cls: 'wl-settings-section-title', text: 'Drafts' });

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

	// ─── Custom Lists ────────────────────────────────────────────────────────────

	private renderCustomLists(el: HTMLElement): void {
		el.createDiv({ cls: 'wl-settings-section-title', text: 'Custom Lists' });

		new Setting(el)
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

		new Setting(el)
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

	// ─── Reading ─────────────────────────────────────────────────────────────────

	private renderReading(el: HTMLElement): void {
		const readingData = this.plugin.readingDataManager;
		const settings = readingData.getSettings();

		el.createDiv({ cls: 'wl-settings-section-title', text: 'Reading' });

		new Setting(el)
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

		// ── Import / Export CSV ───────────────────────────────────────────────────────
		el.createDiv({ cls: 'wl-settings-section-title', text: 'Import / Export CSV' });

		new Setting(el)
			.setName('Export to CSV')
			.setDesc('Export your Books or Manga library as a CSV file.')
			.addButton((b) =>
				b.setButtonText('Export CSV').onClick(() => {
					new ReadingCsvChoiceModal(this.app, 'export', (kind) => {
						new ReadingCsvModal(this.app, this.plugin, kind, 'export').open();
					}).open();
				}),
			);

		new Setting(el)
			.setName('Import from CSV')
			.setDesc('Import Books or Manga from a CSV file, with column mapping and duplicate detection.')
			.addButton((b) =>
				b.setButtonText('Import CSV').onClick(() => {
					new ReadingCsvChoiceModal(this.app, 'import', (kind) => {
						new ReadingCsvModal(this.app, this.plugin, kind, 'import').open();
					}).open();
				}),
			);

	}

	// ─── Quick Info ──────────────────────────────────────────────────────────────

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
							+ '• Anime — Jikan (MyAnimeList data) or AniList, whichever you set under Settings → API → Anime. No key is needed for either.\n'
							+ '• Movies & TV Shows — OMDb or TMDB, whichever is set as active under Settings → API. Both need a free key/token.\n'
							+ '• Books (Reading) — Google Books. A free API key is required; add it under Settings → API → Books.\n'
							+ '• Manga (Reading) — Jikan (MyAnimeList data). No key needed.\n\n'
							+ 'The anime API choice only affects new titles — existing titles keep the source they were added with.\n\n'
							+ 'Make sure the correct type is selected before searching. If Anime is selected and you search for a movie or TV show (or vice versa), it most likely won\'t be found, because each type queries its own API. APIs are a convenience, not a requirement — you can always add a title manually. The "Add from URL" button also relies on an API.',
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
						body: 'Reading entries use five statuses: Reading, Completed, Plan to Read, To be released, and Dropped. "To be released" is set automatically when an entry has a release date in the future and cannot be chosen manually — once that date passes, the entry reverts to Plan to Read. Future-dated entries also appear in the shared Upcoming tab.',
					},
					{
						heading: 'Progress tracking',
						body: 'Books track pages read out of total pages. Manga track chapters read out of total chapters, plus volumes read out of total volumes. The card progress bar fills based on pages (books) or chapters (manga); entries with no total show "No progress" instead of a percentage.',
					},
					{
						heading: 'Notes & favorite quotes',
						body: 'Each entry generates a Markdown note file (under your Reading folder) with frontmatter plus Notes and Quotes sections. Favorite quotes you add from an entry\'s detail view are saved into that note as quote callouts, so they live alongside your own notes.',
					},
					{
						heading: 'Covers',
						body: 'Covers are fetched automatically as cards scroll into view — Google Books for books, Jikan for manga. If a cover is missing or wrong, use "Refresh cover" from a card\'s ⋮ menu. (Refreshing a book cover needs the Google Books API key.)',
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

	// ─── Widgets ─────────────────────────────────────────────────────────────────

	private renderWidgets(el: HTMLElement): void {
		el.createDiv({
			cls: 'wl-settings-info',
			text: 'Insert widgets into notes using the "WatchLog: Insert widget" command. Configure the keyboard shortcut in Obsidian Settings → Hotkeys.',
		});

		const widgets = [
			{
				name: 'wl-todo',
				desc: 'Track a specific title inline — shows type, status, progress, and a "next episode" checkbox.',
				syntax: '```wl-todo\nTitle Name\nmini\n```',
			},
			{
				name: 'wl-todo (full)',
				desc: 'Track a specific title inline (full card).',
				syntax: '```wl-todo\nTitle Name\n```',
			},
			{
				name: 'wl-stat: completed',
				desc: 'Completed titles count — compact inline stat card.',
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
