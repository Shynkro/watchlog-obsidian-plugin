import { App, Modal, Notice } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type {
	WatchLogTitle,
	WatchLogGroup,
	AnimeSearchResult,
	MediaSearchResult,
	Season,
} from './types';
import { formatDateDisplay, parseDateInput, parseReleaseDateInput } from './types';

type SearchResult = AnimeSearchResult | MediaSearchResult;

function isAnimeResult(r: SearchResult): r is AnimeSearchResult {
	return 'malId' in r;
}

export class AddTitleModal extends Modal {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private onAdded: () => void;

	// Form state
	private selectedType = 'Anime';
	private searchQuery = '';
	private searchResults: SearchResult[] = [];
	private isSearching = false;
	private autoSearch = false;

	// Editable fields
	private fieldTitle = '';
	private fieldEpisodes = 0;
	private fieldDuration = 0;
	private fieldReleaseDate = '';
	private fieldLink = '';
	private fieldSeasons: Season[] = [];
	private fieldStatus = 'Plan to watch';
	private fieldPriority = 'Medium';
	private fieldDateStarted = '';
	private fieldMalId: number | null = null;
	private skipDuplicateCheck = false;
	private duplicateWarningEl: HTMLElement | null = null;

	// Group assignment fields
	private selectedGroupId = '';
	private newGroupName = '';

	// UI refs
	private resultsEl: HTMLElement | null = null;
	private formEl: HTMLElement | null = null;
	private searchDebounce: ReturnType<typeof setTimeout> | null = null;

	constructor(
		app: App,
		plugin: WatchLogPlugin,
		dataManager: DataManager,
		onAdded: () => void,
		prefill?: {
			title?: string;
			searchQuery?: string;
			type: string;
			episodes: number;
			duration: number;
			releaseDate: string;
			link: string;
			seasons: Season[];
		},
	) {
		super(app);
		this.plugin = plugin;
		this.dataManager = dataManager;
		this.onAdded = onAdded;
		if (prefill) {
			this.selectedType = prefill.type;
			if (prefill.title) {
				this.fieldTitle = prefill.title;
			}
			if (prefill.searchQuery) {
				this.searchQuery = prefill.searchQuery;
				this.autoSearch = true;
			}
			this.fieldEpisodes = prefill.episodes;
			this.fieldDuration = prefill.duration;
			this.fieldReleaseDate = prefill.releaseDate;
			this.fieldLink = prefill.link;
			this.fieldSeasons = prefill.seasons;
		}
	}

	onOpen(): void {
		this.titleEl.setText('Add title');
		this.contentEl.addClass('wl-add-modal');
		this.buildUI();
		if (this.autoSearch) {
			void this.performSearch();
		}
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.searchDebounce) clearTimeout(this.searchDebounce);
	}

	private buildUI(): void {
		const content = this.contentEl;
		content.empty();

		// Type selector row
		const typeRow = content.createDiv({ cls: 'wl-modal-row' });
		typeRow.createSpan({ cls: 'wl-modal-label', text: 'Type' });
		const typeSelect = typeRow.createEl('select', { cls: 'wl-select' });
		for (const t of this.plugin.settings.types) {
			const opt = typeSelect.createEl('option', { text: t.name, value: t.name });
			if (t.name === this.selectedType) opt.selected = true;
		}
		typeSelect.addEventListener('change', () => {
			this.selectedType = typeSelect.value;
			this.searchResults = [];
			this.renderResults();
			this.renderForm();
		});

		// Search input
		const searchRow = content.createDiv({ cls: 'wl-modal-row' });
		searchRow.createSpan({ cls: 'wl-modal-label', text: 'Search' });
		const searchInput = searchRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: 'Search for a title...' },
		});
		searchInput.value = this.searchQuery;
		searchInput.addEventListener('input', () => {
			this.searchQuery = searchInput.value;
			if (this.searchDebounce) clearTimeout(this.searchDebounce);
			this.searchDebounce = setTimeout(() => void this.performSearch(), 600);
		});

		const searchBtn = searchRow.createEl('button', { cls: 'wl-btn', text: 'Search' });
		searchBtn.addEventListener('click', () => void this.performSearch());

		// Results list
		this.resultsEl = content.createDiv({ cls: 'wl-modal-results' });

		// Form section
		this.formEl = content.createDiv({ cls: 'wl-modal-form' });
		this.renderForm();
	}

	private async performSearch(): Promise<void> {
		if (!this.searchQuery.trim()) return;
		this.isSearching = true;
		this.renderResults();

		try {
			const api = this.plugin.apiService;
			const activeApi = this.plugin.settings.activeApi ?? 'OMDb';
			const isAnime = this.selectedType === 'Anime';
			const isMovie = this.selectedType === 'Movie';

			if (isAnime) {
				this.searchResults = await api.searchAnime(this.searchQuery);
			} else if (activeApi === 'TMDB') {
				this.searchResults = await api.searchTmdb(this.searchQuery, isMovie ? 'movie' : 'series');
			} else {
				this.searchResults = await api.searchOmdb(this.searchQuery, isMovie ? 'movie' : 'series');
			}
		} catch {
			new Notice('Search failed. Check your connection and API settings.');
			this.searchResults = [];
		} finally {
			this.isSearching = false;
			this.renderResults();
		}
	}

	private renderResults(): void {
		if (!this.resultsEl) return;
		this.resultsEl.empty();

		if (this.isSearching) {
			this.resultsEl.createDiv({ cls: 'wl-modal-loading', text: 'Searching...' });
			return;
		}

		if (this.searchResults.length === 0) return;

		this.searchResults.forEach((result, idx) => {
			const item = this.resultsEl!.createDiv({ cls: 'wl-result-item' });
			const epText = isAnimeResult(result)
				? `${result.episodes} eps`
				: result.episodes > 0 ? `${result.episodes} eps` : result.mediaType;
			item.createDiv({ cls: 'wl-result-title', text: result.title });
			item.createDiv({ cls: 'wl-result-meta', text: `${epText} · ${result.releaseDate}` });
			item.dataset['idx'] = String(idx);
			item.addEventListener('click', () => void this.selectResult(result, item));
		});
	}

	private async selectResult(result: SearchResult, itemEl: HTMLElement): Promise<void> {
		if (this.resultsEl) {
			for (const child of Array.from(this.resultsEl.children)) {
				child.removeClass('is-selected');
			}
		}
		itemEl.addClass('is-selected');

		const api = this.plugin.apiService;
		const activeApi = this.plugin.settings.activeApi ?? 'OMDb';
		try {
			if (!isAnimeResult(result) && result.mediaType === 'tv') {
				const full = activeApi === 'TMDB'
					? await api.getTmdbTvDetails(result.imdbId)
					: await api.getOmdbTvDetails(result.imdbId);
				if (full) {
					this.fieldTitle = full.title;
					this.fieldEpisodes = full.episodes;
					this.fieldDuration = full.episodeDuration;
					this.fieldReleaseDate = full.releaseDate;
					this.fieldLink = full.url;
					this.fieldSeasons = full.seasons;
				}
			} else if (!isAnimeResult(result) && result.mediaType === 'movie') {
				const full = activeApi === 'TMDB'
					? await api.getTmdbMovieDetails(result.imdbId)
					: await api.getOmdbMovieDetails(result.imdbId);
				if (full) {
					this.fieldTitle = full.title;
					this.fieldEpisodes = full.episodes;
					this.fieldDuration = full.episodeDuration;
					this.fieldReleaseDate = full.releaseDate;
					this.fieldLink = full.url;
					this.fieldSeasons = full.seasons;
				}
			} else {
				const anime = result as AnimeSearchResult;
				this.fieldTitle = anime.title;
				this.fieldEpisodes = anime.episodes;
				this.fieldDuration = anime.duration;
				this.fieldReleaseDate = anime.releaseDate;
				this.fieldLink = anime.url;
				this.fieldSeasons = anime.seasons;
				this.fieldMalId = anime.malId;
			}
		} catch {
			this.fieldTitle = result.title;
			this.fieldEpisodes = isAnimeResult(result) ? result.episodes : result.episodes;
			this.fieldDuration = isAnimeResult(result) ? result.duration : result.episodeDuration;
			this.fieldReleaseDate = result.releaseDate;
			this.fieldLink = result.url;
			this.fieldSeasons = result.seasons;
		}

		this.renderForm();
	}

	private renderForm(): void {
		if (!this.formEl) return;
		this.formEl.empty();

		const makeRow = (label: string): HTMLElement => {
			const row = this.formEl!.createDiv({ cls: 'wl-modal-row' });
			row.createSpan({ cls: 'wl-modal-label', text: label });
			return row;
		};

		// Title
		const titleRow = makeRow('Title');
		const titleInput = titleRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: 'Title name' },
		});
		titleInput.value = this.fieldTitle;
		titleInput.addEventListener('input', () => { this.fieldTitle = titleInput.value; });

		// Episodes
		const epsRow = makeRow('Episodes');
		const epsInput = epsRow.createEl('input', {
			cls: 'wl-modal-input wl-modal-input-sm',
			attr: { type: 'number', min: '0', placeholder: '0' },
		});
		epsInput.value = String(this.fieldEpisodes);
		epsInput.addEventListener('input', () => { this.fieldEpisodes = parseInt(epsInput.value) || 0; });

		// Duration
		const durRow = makeRow('Ep. duration (min)');
		const durInput = durRow.createEl('input', {
			cls: 'wl-modal-input wl-modal-input-sm',
			attr: { type: 'number', min: '0', placeholder: '24' },
		});
		durInput.value = String(this.fieldDuration);
		durInput.addEventListener('input', () => { this.fieldDuration = parseInt(durInput.value) || 0; });

		// Release date
		const relRow = makeRow('Release date');
		const relStack = relRow.createDiv({ cls: 'wl-modal-input-stack' });
		const relInput = relStack.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: 'Date (dd-mm-yyyy or yyyy-mm-dd)' },
		});
		relInput.value = this.fieldReleaseDate;
		const relErrorEl = relStack.createDiv({ cls: 'wl-modal-error wl-hidden' });
		relInput.addEventListener('change', () => {
			const raw = relInput.value.trim();
			if (!raw) {
				this.fieldReleaseDate = '';
				relErrorEl.addClass('wl-hidden');
				return;
			}
			const parsed = parseReleaseDateInput(raw);
			if (parsed) {
				this.fieldReleaseDate = parsed;
				relInput.value = parsed;
				relErrorEl.addClass('wl-hidden');
			} else {
				this.fieldReleaseDate = raw;
				relErrorEl.textContent = 'Unrecognised format. Expected dd/mm/yyyy or yyyy-mm-dd.';
				relErrorEl.removeClass('wl-hidden');
			}
		});

		// External link
		const linkRow = makeRow('External link');
		const linkInput = linkRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'url', placeholder: 'https://example.com' },
		});
		linkInput.value = this.fieldLink;
		linkInput.addEventListener('input', () => { this.fieldLink = linkInput.value; });

		// Status (exclude "To be released" — it is auto-assigned based on releaseDate)
		const statusRow = makeRow('Status');
		const statusSelect = statusRow.createEl('select', { cls: 'wl-select' });
		for (const s of this.plugin.settings.statuses.filter((s) => s.name !== 'To be released')) {
			const opt = statusSelect.createEl('option', { text: s.name, value: s.name });
			if (s.name === this.fieldStatus) opt.selected = true;
		}
		statusSelect.addEventListener('change', () => { this.fieldStatus = statusSelect.value; });

		// Priority
		const priRow = makeRow('Priority');
		const priSelect = priRow.createEl('select', { cls: 'wl-select' });
		for (const p of this.plugin.settings.priorities) {
			const opt = priSelect.createEl('option', { text: p.name, value: p.name });
			if (p.name === this.fieldPriority) opt.selected = true;
		}
		priSelect.addEventListener('change', () => { this.fieldPriority = priSelect.value; });

		// Date started
		const startRow = makeRow('Date started');
		const startInput = startRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: '15/01/2024', maxlength: '10' },
		});
		startInput.value = this.fieldDateStarted ? formatDateDisplay(this.fieldDateStarted) : '';
		startInput.addEventListener('change', () => {
			const parsed = parseDateInput(startInput.value);
			if (startInput.value.trim() && !parsed) {
				startInput.addClass('wl-input-error');
			} else {
				startInput.removeClass('wl-input-error');
				this.fieldDateStarted = parsed ?? '';
			}
		});

		// Group fields (mutually exclusive)
		const groups = this.dataManager.getGroups();
		const addToGroupRow = makeRow('Add to group');
		const groupSelect = addToGroupRow.createEl('select', { cls: 'wl-select' });
		groupSelect.createEl('option', { text: '— none —', value: '' });
		for (const g of groups) {
			const opt = groupSelect.createEl('option', { text: g.name, value: g.id });
			if (g.id === this.selectedGroupId) opt.selected = true;
		}

		const newGroupRow = makeRow('Or create new group');
		const newGroupInput = newGroupRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: 'New group name...' },
		});
		newGroupInput.value = this.newGroupName;

		groupSelect.addEventListener('change', () => {
			this.selectedGroupId = groupSelect.value;
			if (this.selectedGroupId) {
				this.newGroupName = '';
				newGroupInput.value = '';
				newGroupInput.disabled = true;
			} else {
				newGroupInput.disabled = false;
			}
		});

		newGroupInput.addEventListener('input', () => {
			this.newGroupName = newGroupInput.value;
			if (this.newGroupName.trim()) {
				this.selectedGroupId = '';
				groupSelect.value = '';
				groupSelect.disabled = true;
			} else {
				groupSelect.disabled = false;
			}
		});

		if (this.selectedGroupId) newGroupInput.disabled = true;
		if (this.newGroupName.trim()) groupSelect.disabled = true;

		// Seasons info
		if (this.fieldSeasons.length > 0) {
			const seasRow = makeRow('Seasons');
			seasRow.createSpan({
				cls: 'wl-modal-info',
				text: this.fieldSeasons.map((s) => `${s.name} (${s.episodes} eps)`).join(', '),
			});
		}

		// Add button
		const btnRow = this.formEl.createDiv({ cls: 'wl-modal-btn-row' });
		const addBtn = btnRow.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Add to watchlog' });
		addBtn.addEventListener('click', () => void this.addTitle());
	}

	private showDuplicateWarning(titleName: string, btnRow: HTMLElement): void {
		if (this.duplicateWarningEl) return;
		const warn = btnRow.createDiv({ cls: 'wl-duplicate-warning' });
		this.duplicateWarningEl = warn;
		warn.createSpan({ text: `"${titleName}" already exists. Add anyway?` });
		const continueBtn = warn.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Continue' });
		const cancelBtn = warn.createEl('button', { cls: 'wl-btn', text: 'Cancel' });
		continueBtn.addEventListener('click', () => {
			this.skipDuplicateCheck = true;
			warn.remove();
			this.duplicateWarningEl = null;
			void this.addTitle();
		});
		cancelBtn.addEventListener('click', () => {
			warn.remove();
			this.duplicateWarningEl = null;
			this.skipDuplicateCheck = false;
		});
	}

	private async addTitle(): Promise<void> {
		const titleName = this.fieldTitle.trim();
		if (!titleName) {
			new Notice('Please enter a title name.');
			return;
		}

		if (!this.skipDuplicateCheck) {
			const duplicate = this.dataManager.getTitles().find(
				(t) => t.title.toLowerCase() === titleName.toLowerCase()
			);
			if (duplicate) {
				const btnRow = this.contentEl.querySelector<HTMLElement>('.wl-modal-btn-row');
				if (btnRow) this.showDuplicateWarning(titleName, btnRow);
				return;
			}
		}
		this.skipDuplicateCheck = false;

		const entry: WatchLogTitle = {
			id: this.dataManager.generateId(titleName),
			title: titleName,
			type: this.selectedType,
			status: this.fieldStatus,
			priority: this.fieldPriority,
			review: '',
			rating: 0,
			notes: '',
			dateStarted: this.fieldDateStarted || null,
			dateFinished: null,
			dateAdded: new Date().toISOString(),
			dateModified: new Date().toISOString(),
			totalEpisodes: this.fieldEpisodes,
			episodeDuration: this.fieldDuration,
			releaseDate: this.fieldReleaseDate || null,
			externalLink: this.fieldLink,
			seasons: this.fieldSeasons,
			watchedEpisodes: [],
			...(this.fieldMalId !== null ? { malId: this.fieldMalId } : {}),
		};

		// Bug 3: auto-complete episodes when adding with Completed status
		if (entry.status === 'Completed' && entry.totalEpisodes > 0) {
			entry.watchedEpisodes = Array.from({ length: entry.totalEpisodes }, (_, i) => i + 1);
			if (this.plugin.settings.setFinishDateAutomatically) {
				entry.dateFinished = new Date().toISOString().split('T')[0] ?? null;
			}
		}

		await this.dataManager.addTitle(entry);

		if (this.selectedGroupId) {
			await this.dataManager.addTitleToGroup(this.selectedGroupId, entry.id);
		} else if (this.newGroupName.trim()) {
			const name = this.newGroupName.trim();
			const group: WatchLogGroup = {
				id: this.dataManager.generateGroupId(name),
				name,
				titleIds: [entry.id],
				dateAdded: new Date().toISOString(),
			};
			await this.dataManager.addGroup(group);
		}

		new Notice(`"${titleName}" added to WatchLog.`);
		this.close();
		this.onAdded();
	}
}
