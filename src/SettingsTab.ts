import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type WatchLogPlugin from './main';
import type { TagDefinition } from './types';
import { CsvModal } from './CsvModal';
import { WatchLogView } from './WatchLogView';
import { CustomListManager, DefaultColumnsModal } from './CustomListsTab';
import { ConfirmModal } from './ConfirmModal';

type SettingsSection = 'general' | 'api' | 'customize' | 'folders' | 'drafts' | 'custom-lists' | 'widgets' | 'quick-info';

export class WatchLogSettingsTab extends PluginSettingTab {
	private plugin: WatchLogPlugin;
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
			{ key: 'folders', label: 'Folders' },
			{ key: 'drafts', label: 'Drafts' },
			{ key: 'custom-lists', label: 'Custom Lists' },
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
			case 'folders': this.renderFolders(body); break;
			case 'drafts': this.renderDrafts(body); break;
			case 'custom-lists': this.renderCustomLists(body); break;
			case 'widgets': this.renderWidgets(body); break;
			case 'quick-info': this.renderQuickInfo(body); break;
		}
	}

	// ─── General ────────────────────────────────────────────────────────────────

	private renderGeneral(el: HTMLElement): void {
		new Setting(el)
			.setName('Default view')
			.setDesc('Which tab opens when you launch the watchlog panel.')
			.addDropdown((d) =>
				d
					.addOptions({ dashboard: 'Dashboard', watchlist: 'Watchlist' })
					.setValue(this.plugin.settings.defaultView)
					.onChange(async (v) => {
						this.plugin.settings.defaultView = v as 'dashboard' | 'watchlist';
						await this.plugin.saveSettings();
					}),
			);

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
			.setName('Set finish date automatically')
			.setDesc("Record today's date as the finish date when a title is completed.")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.setFinishDateAutomatically)
					.onChange(async (v) => {
						this.plugin.settings.setFinishDateAutomatically = v;
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

		// ── Backup & Restore ──────────────────────────────────────────────────────────
		el.createDiv({ cls: 'wl-settings-section-title', text: 'Backup & Restore' });

		new Setting(el)
			.setName('Export backup')
			.setDesc('Export all watchlog data into a single timestamped .JSON file.')
			.addButton((b) =>
				b.setButtonText('Export backup').onClick(() => this.exportBackup()),
			);

		new Setting(el)
			.setName('Restore from backup')
			.setDesc('Restore all watchlog data from a .JSON backup file. Current data will be replaced.')
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
	}

	private exportBackup(): void {
		const today = new Date();
		const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
		const filename = `watchlog-backup-${dateStr}.json`;

		void this.plugin.loadData().then((data) => {
			const json = JSON.stringify(data ?? {}, null, 2);
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
		});
	}

	private openRestoreDialog(): void {
		const input = activeDocument.createElement('input');
		input.type = 'file';
		input.accept = '.json';
		input.hide();
		activeDocument.body.appendChild(input);
		input.addEventListener('change', () => {
			const file = input.files?.[0];
			if (!file) { activeDocument.body.removeChild(input); return; }
			const reader = new FileReader();
			reader.onload = (e) => {
				activeDocument.body.removeChild(input);
				const text = e.target?.result as string;
				let parsed: unknown;
				try { parsed = JSON.parse(text); } catch {
					new Notice('Invalid backup file — could not parse JSON.');
					return;
				}
				// Basic validation
				if (typeof parsed !== 'object' || parsed === null || !('titles' in parsed)) {
					new Notice('Invalid backup file — missing required fields.');
					return;
				}
				new ConfirmModal(this.app, 'This will replace all current watchlog data. Continue?', () => {
					void this.plugin.saveData(parsed).then(async () => {
						await this.plugin.loadSettings();
						await this.plugin.dataManager.load();
						activeDocument.dispatchEvent(new CustomEvent('watchlog-data-changed'));
						new Notice('Backup restored successfully.');
					});
				}).open();
			};
			reader.readAsText(file);
		});
		input.click();
	}

	private async runRegenerate(
		progressWrap: HTMLElement,
		progressBarFill: HTMLElement,
		progressText: HTMLElement,
	): Promise<void> {
		const titles = this.plugin.dataManager.getTitles();
		const total = titles.length;
		progressWrap.show();
		if (total === 0) {
			progressText.textContent = 'Done — no missing files found';
			return;
		}
		progressBarFill.style.width = `0%`;
		progressText.textContent = `0 / ${total}`;
		let created = 0;
		let skipped = 0;
		for (let i = 0; i < titles.length; i++) {
			const wasCreated = await this.plugin.dataManager.createMarkdownFileIfMissing(titles[i]!);
			if (wasCreated) created++; else skipped++;
			const pct = Math.round(((i + 1) / total) * 100);
			progressBarFill.style.width = `${pct}%`;
			progressText.textContent = `${i + 1} / ${total}`;
		}
		if (created === 0) {
			progressText.textContent = 'Done — no missing files found';
		} else {
			progressText.textContent = `Done — ${created} file${created !== 1 ? 's' : ''} created, ${skipped} already existed`;
		}
	}

	// ─── API ────────────────────────────────────────────────────────────────────

	private renderApi(el: HTMLElement): void {
		el.createDiv({
			cls: 'wl-settings-info',
			text: 'Anime data uses the Jikan API (jikan.moe) — a free public MyAnimeList wrapper. No API key required.',
		});

		// Active API selector
		new Setting(el)
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

		// OMDb section
		el.createDiv({ cls: 'wl-settings-section-title', text: 'OMDb API' });
		const omdbInfo = el.createDiv({ cls: 'wl-settings-info' });
		omdbInfo.createSpan({ text: 'Get a free API key at ' });
		omdbInfo.createEl('a', {
			text: 'omdbapi.com/apikey.aspx',
			href: 'https://www.omdbapi.com/apikey.aspx',
			attr: { target: '_blank', rel: 'noopener noreferrer' },
		});
		omdbInfo.createSpan({ text: '.' });

		let omdbStatus: HTMLElement;
		new Setting(el)
			.setName('Omdb API key')
			.addText((t) => {
				t
					.setPlaceholder('Paste your omdb key here')
					.setValue(this.plugin.settings.omdbApiKey)
					.onChange(async (v) => {
						this.plugin.settings.omdbApiKey = v;
						this.plugin.apiService.setOmdbKey(v);
						await this.plugin.saveSettings();
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
		omdbStatus = el.createDiv({
			cls: 'wl-status-indicator',
			text: this.plugin.settings.omdbApiKey ? '(not tested)' : 'Not set',
		});

		// TMDB section
		el.createDiv({ cls: 'wl-settings-section-title', text: 'TMDB API' });
		const tmdbInfo = el.createDiv({ cls: 'wl-settings-info' });
		tmdbInfo.createSpan({ text: 'Get a free API key at ' });
		tmdbInfo.createEl('a', {
			text: 'themoviedb.org/settings/api',
			href: 'https://www.themoviedb.org/settings/api',
			attr: { target: '_blank', rel: 'noopener noreferrer' },
		});
		tmdbInfo.createSpan({ text: '.' });

		let tmdbStatus: HTMLElement;
		new Setting(el)
			.setName('Tmdb API read access token')
			.addText((t) => {
				t
					.setPlaceholder('Paste your tmdb key here')
					.setValue(this.plugin.settings.tmdbApiKey ?? '')
					.onChange(async (v) => {
						this.plugin.settings.tmdbApiKey = v;
						this.plugin.apiService.setTmdbKey(v);
						await this.plugin.saveSettings();
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
		tmdbStatus = el.createDiv({
			cls: 'wl-status-indicator',
			text: this.plugin.settings.tmdbApiKey ? '(not tested)' : 'Not set',
		});
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
		const addBtn = addRow.createEl('button', { cls: 'wl-btn', text: '+ add color' });
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
			const addBtn = addRow.createEl('button', { cls: 'wl-btn', text: '+ add' });
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

	private renderFolders(el: HTMLElement): void {
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
						heading: 'Anime vs Movies & TV Shows',
						body: 'WatchLog uses two separate APIs. Anime titles are searched via Jikan (MyAnimeList data). Movies and TV Shows use either OMDb or TMDB, depending on which is set as active in Settings. Make sure you have the correct type selected before searching; if you have Anime selected and search for a movie or TV show, it most likely won\'t be found, and vice versa.\n\nNote: APIs are there to help, not mandatory; you can manually add a new title.\n\nNote: The "Add from URL" button also uses an API.',
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
