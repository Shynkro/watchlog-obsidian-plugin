import { App, Modal, Notice } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type { MaybeTitle, AnimeSearchResult, MediaSearchResult } from './types';
import { parseReleaseDateInput, getApiGroupForType } from './types';

type SearchResult = AnimeSearchResult | MediaSearchResult;

function isAnimeResult(r: SearchResult): r is AnimeSearchResult {
	return 'malId' in r;
}

export class MaybeAddModal extends Modal {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private onAdded: () => void;

	private selectedType = 'Anime';
	private searchQuery = '';
	private searchResults: SearchResult[] = [];
	private isSearching = false;
	private searchGeneration = 0;

	private fieldTitle = '';
	private fieldEpisodes = 0;
	private fieldDuration = 0;
	private fieldReleaseDate = '';
	private fieldLink = '';

	private resultsEl: HTMLElement | null = null;
	private formEl: HTMLElement | null = null;
	private searchDebounce: number | null = null;

	constructor(
		app: App,
		plugin: WatchLogPlugin,
		dataManager: DataManager,
		onAdded: () => void,
	) {
		super(app);
		this.plugin = plugin;
		this.dataManager = dataManager;
		this.onAdded = onAdded;
	}

	onOpen(): void {
		this.titleEl.setText('Add to maybe');
		this.contentEl.addClass('wl-add-modal');
		this.buildUI();
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.searchDebounce) window.clearTimeout(this.searchDebounce);
	}

	private buildUI(): void {
		const content = this.contentEl;
		content.empty();

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

		const searchRow = content.createDiv({ cls: 'wl-modal-row' });
		searchRow.createSpan({ cls: 'wl-modal-label', text: 'Search' });
		const searchInput = searchRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: 'Search for a title...' },
		});
		searchInput.value = this.searchQuery;
		searchInput.addEventListener('input', () => {
			this.searchQuery = searchInput.value;
			if (this.searchDebounce) window.clearTimeout(this.searchDebounce);
			this.searchDebounce = window.setTimeout(() => void this.performSearch(), 600);
		});
		const searchBtn = searchRow.createEl('button', { cls: 'wl-btn', text: 'Search' });
		searchBtn.addEventListener('click', () => void this.performSearch());

		this.resultsEl = content.createDiv({ cls: 'wl-modal-results' });
		this.formEl = content.createDiv({ cls: 'wl-modal-form' });
		this.renderForm();
	}

	private async performSearch(): Promise<void> {
		if (!this.searchQuery.trim()) return;
		const gen = ++this.searchGeneration;
		this.isSearching = true;
		this.renderResults();
		try {
			const api = this.plugin.apiService;
			const activeApi = this.plugin.settings.activeApi ?? 'OMDb';
			const apiGroup = getApiGroupForType(this.selectedType, this.plugin.settings.typeApiMapping);
			const isMovie = this.selectedType === 'Movie';
			let results: SearchResult[] = [];
			if (apiGroup === '') {
				new Notice(`No API configured for type "${this.selectedType}". Configure it in Settings → API.`);
			} else if (apiGroup === 'anime') {
				const animeSource = this.plugin.settings.animeApiSource ?? 'jikan';
				results = animeSource === 'anilist'
					? await api.searchAniList(this.searchQuery)
					: await api.searchAnime(this.searchQuery);
			} else if (activeApi === 'TMDB') {
				results = await api.searchTmdb(this.searchQuery, isMovie ? 'movie' : 'series');
			} else {
				results = await api.searchOmdb(this.searchQuery, isMovie ? 'movie' : 'series');
			}
			if (gen !== this.searchGeneration) return; // stale
			this.searchResults = results;
		} catch {
			if (gen !== this.searchGeneration) return;
			new Notice('Search failed. Check your connection and API settings.');
			this.searchResults = [];
		} finally {
			if (gen === this.searchGeneration) {
				this.isSearching = false;
				this.renderResults();
			}
		}
	}

	private renderResults(): void {
		if (!this.resultsEl) return;
		this.resultsEl.empty();
		if (this.isSearching) { this.resultsEl.createDiv({ cls: 'wl-modal-loading', text: 'Searching...' }); return; }
		if (!this.searchResults.length) return;
		this.searchResults.forEach((result, idx) => {
			const item = this.resultsEl!.createDiv({ cls: 'wl-result-item' });
			const epText = isAnimeResult(result) ? `${result.episodes} eps` : result.episodes > 0 ? `${result.episodes} eps` : result.mediaType;
			item.createDiv({ cls: 'wl-result-title', text: result.title });
			item.createDiv({ cls: 'wl-result-meta', text: `${epText} · ${result.releaseDate}` });
			item.dataset['idx'] = String(idx);
			item.addEventListener('click', () => void this.selectResult(result, item));
		});
	}

	private async selectResult(result: SearchResult, itemEl: HTMLElement): Promise<void> {
		if (this.resultsEl) {
			for (const child of Array.from(this.resultsEl.children)) child.removeClass('is-selected');
		}
		itemEl.addClass('is-selected');
		const gen = ++this.searchGeneration;
		const api = this.plugin.apiService;
		const activeApi = this.plugin.settings.activeApi ?? 'OMDb';
		try {
			if (!isAnimeResult(result) && result.mediaType === 'tv') {
				const full = activeApi === 'TMDB' ? await api.getTmdbTvDetails(result.imdbId) : await api.getOmdbTvDetails(result.imdbId);
				if (gen !== this.searchGeneration) return;
				if (full) { this.fieldTitle = full.title; this.fieldEpisodes = full.episodes; this.fieldDuration = full.episodeDuration; this.fieldReleaseDate = full.releaseDate; this.fieldLink = full.url; }
			} else if (!isAnimeResult(result) && result.mediaType === 'movie') {
				const full = activeApi === 'TMDB' ? await api.getTmdbMovieDetails(result.imdbId) : await api.getOmdbMovieDetails(result.imdbId);
				if (gen !== this.searchGeneration) return;
				if (full) { this.fieldTitle = full.title; this.fieldEpisodes = full.episodes; this.fieldDuration = full.episodeDuration; this.fieldReleaseDate = full.releaseDate; this.fieldLink = full.url; }
			} else {
				const anime = result as AnimeSearchResult;
				this.fieldTitle = anime.title; this.fieldEpisodes = anime.episodes; this.fieldDuration = anime.duration;
				this.fieldReleaseDate = anime.releaseDate; this.fieldLink = anime.url;
			}
		} catch {
			if (gen !== this.searchGeneration) return;
			this.fieldTitle = result.title;
			this.fieldEpisodes = result.episodes;
			this.fieldDuration = isAnimeResult(result) ? result.duration : result.episodeDuration;
			this.fieldReleaseDate = result.releaseDate; this.fieldLink = result.url;
		}
		if (gen !== this.searchGeneration) return;
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

		const titleRow = makeRow('Title');
		const titleInput = titleRow.createEl('input', { cls: 'wl-modal-input', attr: { type: 'text', placeholder: 'Title name' } });
		titleInput.value = this.fieldTitle;
		titleInput.addEventListener('input', () => { this.fieldTitle = titleInput.value; });

		const epsRow = makeRow('Episodes');
		const epsInput = epsRow.createEl('input', { cls: 'wl-modal-input wl-modal-input-sm', attr: { type: 'number', min: '0', placeholder: '0' } });
		epsInput.value = String(this.fieldEpisodes);
		epsInput.addEventListener('input', () => { this.fieldEpisodes = parseInt(epsInput.value) || 0; });

		const durRow = makeRow('Ep. duration (min)');
		const durInput = durRow.createEl('input', { cls: 'wl-modal-input wl-modal-input-sm', attr: { type: 'number', min: '0', placeholder: '24' } });
		durInput.value = String(this.fieldDuration);
		durInput.addEventListener('input', () => { this.fieldDuration = parseInt(durInput.value) || 0; });

		const relRow = makeRow('Release date');
		const relStack = relRow.createDiv({ cls: 'wl-modal-input-stack' });
		const relInput = relStack.createEl('input', { cls: 'wl-modal-input', attr: { type: 'text', placeholder: 'Date (dd-mm-yyyy or yyyy-mm-dd)' } });
		relInput.value = this.fieldReleaseDate;
		const relErrorEl = relStack.createDiv({ cls: 'wl-modal-error wl-hidden' });
		relInput.addEventListener('change', () => {
			const raw = relInput.value.trim();
			if (!raw) { this.fieldReleaseDate = ''; relErrorEl.addClass('wl-hidden'); return; }
			const parsed = parseReleaseDateInput(raw);
			if (parsed) { this.fieldReleaseDate = parsed; relInput.value = parsed; relErrorEl.addClass('wl-hidden'); }
			else { this.fieldReleaseDate = raw; relErrorEl.textContent = 'Unrecognised format.'; relErrorEl.removeClass('wl-hidden'); }
		});

		const linkRow = makeRow('External link');
		const linkInput = linkRow.createEl('input', { cls: 'wl-modal-input', attr: { type: 'url', placeholder: 'https://example.com' } });
		linkInput.value = this.fieldLink;
		linkInput.addEventListener('input', () => { this.fieldLink = linkInput.value; });

		const btnRow = this.formEl.createDiv({ cls: 'wl-modal-btn-row' });
		const addBtn = btnRow.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Add to maybe' });
		addBtn.addEventListener('click', () => void this.addMaybeTitle());
	}

	private async addMaybeTitle(): Promise<void> {
		const titleName = this.fieldTitle.trim();
		if (!titleName) { new Notice('Please enter a title name.'); return; }

		const entry: MaybeTitle = {
			id: this.dataManager.generateMaybeId(titleName),
			title: titleName,
			type: this.selectedType,
			releaseDate: this.fieldReleaseDate || null,
			externalLink: this.fieldLink,
			totalEpisodes: this.fieldEpisodes,
			episodeDuration: this.fieldDuration,
			dateAdded: new Date().toISOString(),
		};
		await this.dataManager.addMaybeTitle(entry);
		new Notice(`"${titleName}" added to Maybe.`);
		this.close();
		this.onAdded();
	}
}
