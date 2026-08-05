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
import { getApiGroupForType, todayIso } from './types';
import { renderSearchResultRow } from './SearchThumbnail';
import { apiErrorMessage, SEARCH_PAGE_SIZE, SEARCH_RESULT_LIMIT } from './ApiService';
import { LibraryIndex, animeResultIdKeys, mediaResultIdKeys } from './LibraryIndex';
import { createDatePicker } from './DatePicker';
import { renderStarRating } from './StarRating';
import {
	normalizeCustomPropertyList,
	renderCustomPropertyFormFields,
	type CustomPropertyFormState,
} from './CustomProperties';

type SearchResult = AnimeSearchResult | MediaSearchResult;

function isAnimeResult(r: SearchResult): r is AnimeSearchResult {
	return 'malId' in r;
}

export class AddTitleModal extends Modal {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	// gets the new entry — callers that don't care just ignore it
	private onAdded: (entry: WatchLogTitle) => void;

	private selectedType = 'Anime';
	private searchQuery = '';
	private searchYear = '';
	private searchResults: SearchResult[] = [];
	private resultPage = 0;
	private isSearching = false;
	private searchGeneration = 0;
	private autoSearch = false;
	private noApiMessage = '';
	private searchError = '';

	private fieldTitle = '';
	private fieldEpisodes = 0;
	private fieldDuration = 0;
	private fieldReleaseDate = '';
	private fieldLink = '';
	private fieldSeasons: Season[] = [];
	private fieldStatus = 'Plan to watch';
	private fieldPriority = 'Medium';
	private fieldRating = 0;
	private fieldDateStarted = '';
	private fieldMalId: number | null = null;
	private fieldAnilistId: number | null = null;
	// trailer resolved at selection ('' unfetched, 'none' source without one, or a URL)
	private fieldTrailerUrl = '';
	// credits resolved at selection ([] unfetched, ['none'] unavailable, or names)
	private fieldDirector: string[] = [];
	private fieldCast: string[] = [];
	private fieldStudio: string[] = [];
	private skipDuplicateCheck = false;
	private duplicateWarningEl: HTMLElement | null = null;
	private customPropState: CustomPropertyFormState = { values: {} };
	// built on first search, reused for the modal's life
	private libIndex: LibraryIndex | null = null;

	private selectedGroupId = '';
	private newGroupName = '';

	private resultsEl: HTMLElement | null = null;
	private pagerEl: HTMLElement | null = null;
	private formEl: HTMLElement | null = null;
	private searchDebounce: number | null = null;

	constructor(
		app: App,
		plugin: WatchLogPlugin,
		dataManager: DataManager,
		onAdded: (entry: WatchLogTitle) => void,
		preferredType?: string,
		prefill?: {
			title?: string;
			searchQuery?: string;
			type: string;
			episodes: number;
			duration: number;
			releaseDate: string;
			link: string;
			seasons: Season[];
			trailerUrl?: string;
			director?: string[];
			cast?: string[];
		},
	) {
		super(app);
		this.plugin = plugin;
		this.dataManager = dataManager;
		this.onAdded = onAdded;
		this.selectedType = this.plugin.resolveDefaultAddType() || this.selectedType;
		if (preferredType) {
			this.selectedType = preferredType;
		}
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
			if (prefill.trailerUrl !== undefined) this.fieldTrailerUrl = prefill.trailerUrl;
			if (prefill.director !== undefined) this.fieldDirector = prefill.director;
			if (prefill.cast !== undefined) this.fieldCast = prefill.cast;
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
			this.noApiMessage = '';
			this.searchError = '';
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

		const yearInput = searchRow.createEl('input', {
			cls: 'wl-modal-input wl-search-year',
			attr: { type: 'text', inputmode: 'numeric', maxlength: '4', placeholder: 'Year' },
		});
		yearInput.value = this.searchYear;
		yearInput.addEventListener('input', () => {
			// digits only; the APIs want a bare YYYY
			yearInput.value = yearInput.value.replace(/\D/g, '');
			this.searchYear = yearInput.value;
			if (this.searchDebounce) window.clearTimeout(this.searchDebounce);
			this.searchDebounce = window.setTimeout(() => void this.performSearch(), 600);
		});

		const searchBtn = searchRow.createEl('button', { cls: 'wl-btn', text: 'Search' });
		searchBtn.addEventListener('click', () => void this.performSearch());

		this.resultsEl = content.createDiv({ cls: 'wl-modal-results wl-results-grid' });
		this.pagerEl = content.createDiv({ cls: 'wl-result-pager' });

		this.formEl = content.createDiv({ cls: 'wl-modal-form' });
		this.renderForm();
	}

	private async performSearch(): Promise<void> {
		if (!this.searchQuery.trim()) return;
		const gen = ++this.searchGeneration;
		this.isSearching = true;
		this.resultPage = 0;
		this.renderResults();

		try {
			const api = this.plugin.apiService;
			const activeApi = this.plugin.settings.activeApi ?? 'OMDb';
			const apiGroup = getApiGroupForType(this.selectedType, this.plugin.settings.typeApiMapping);
			const isMovie = this.selectedType === 'Movie';

			let results: SearchResult[] = [];
			let noApi = '';
			if (apiGroup === '') {
				noApi = `No API configured for type "${this.selectedType}". Go to Settings → API to set one up.`;
			} else if (apiGroup === 'anime') {
				const animeSource = this.plugin.settings.animeApiSource ?? 'jikan';
				results = animeSource === 'anilist'
					? await api.searchAniList(this.searchQuery, this.searchYear)
					: await api.searchAnime(this.searchQuery, this.searchYear, SEARCH_RESULT_LIMIT);
			} else if (activeApi === 'TMDB') {
				results = await api.searchTmdb(this.searchQuery, isMovie ? 'movie' : 'series', this.searchYear);
			} else {
				results = await api.searchOmdb(this.searchQuery, isMovie ? 'movie' : 'series', this.searchYear);
			}
			if (gen !== this.searchGeneration) return; // stale
			this.noApiMessage = noApi;
			this.searchError = '';
			this.searchResults = results;
		} catch (err) {
			if (gen !== this.searchGeneration) return;
			// in the panel, not a Notice — a blank result list is what made a rejected key
			// look like a title that does not exist
			this.searchError = apiErrorMessage(err);
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
		this.renderPager();

		if (this.isSearching) {
			this.resultsEl.createDiv({ cls: 'wl-modal-loading', text: 'Searching...' });
			return;
		}

		if (this.noApiMessage) {
			const msg = this.resultsEl.createDiv({ cls: 'wl-modal-no-api' });
			msg.createSpan({ cls: 'wl-modal-no-api-icon', text: 'ℹ' });
			msg.createSpan({ cls: 'wl-modal-no-api-text', text: this.noApiMessage });
			return;
		}

		if (this.searchError) {
			const msg = this.resultsEl.createDiv({ cls: 'wl-modal-no-api wl-modal-api-error' });
			msg.createSpan({ cls: 'wl-modal-no-api-icon', text: '⚠' });
			msg.createSpan({ cls: 'wl-modal-no-api-text', text: this.searchError });
			return;
		}

		if (this.searchResults.length === 0) return;

		if (!this.libIndex) this.libIndex = LibraryIndex.build(this.plugin, ['watchlist']);
		const libIndex = this.libIndex;
		const activeApi = this.plugin.settings.activeApi ?? 'OMDb';

		const start = this.resultPage * SEARCH_PAGE_SIZE;
		this.searchResults.slice(start, start + SEARCH_PAGE_SIZE).forEach((result, i) => {
			const epText = isAnimeResult(result)
				? `${result.episodes} eps`
				: result.episodes > 0 ? `${result.episodes} eps` : result.mediaType;
			const idKeys = isAnimeResult(result)
				? animeResultIdKeys(result)
				: mediaResultIdKeys(result, activeApi);
			const item = renderSearchResultRow(this.resultsEl!, {
				thumbUrl: result.posterUrl,
				fallbackIcon: '🎬',
				title: result.title,
				meta: `${epText} · ${result.releaseDate}`,
				inLibrary: libIndex.lookup(idKeys, result.title),
				onClick: (itemEl) => void this.selectResult(result, itemEl),
			});
			item.dataset['idx'] = String(start + i);
		});
	}

	private renderPager(): void {
		if (!this.pagerEl) return;
		this.pagerEl.empty();
		const total = Math.ceil(this.searchResults.length / SEARCH_PAGE_SIZE);
		if (this.isSearching || total <= 1) return;

		const prev = this.pagerEl.createEl('button', { cls: 'wl-btn wl-result-pager-btn', text: '‹' });
		prev.disabled = this.resultPage === 0;
		prev.addEventListener('click', () => this.goToPage(this.resultPage - 1));

		this.pagerEl.createSpan({
			cls: 'wl-result-pager-info',
			text: `Page ${this.resultPage + 1} of ${total}`,
		});

		const next = this.pagerEl.createEl('button', { cls: 'wl-btn wl-result-pager-btn', text: '›' });
		next.disabled = this.resultPage >= total - 1;
		next.addEventListener('click', () => this.goToPage(this.resultPage + 1));
	}

	private goToPage(page: number): void {
		const total = Math.ceil(this.searchResults.length / SEARCH_PAGE_SIZE);
		this.resultPage = Math.max(0, Math.min(page, total - 1));
		this.renderResults();
		this.resultsEl?.scrollTo({ top: 0 });
	}

	private async selectResult(result: SearchResult, itemEl: HTMLElement): Promise<void> {
		if (this.resultsEl) {
			for (const child of Array.from(this.resultsEl.children)) {
				child.removeClass('is-selected');
			}
		}
		itemEl.addClass('is-selected');

		const gen = ++this.searchGeneration;
		const api = this.plugin.apiService;
		const activeApi = this.plugin.settings.activeApi ?? 'OMDb';
		try {
			if (!isAnimeResult(result) && result.mediaType === 'tv') {
				const full = activeApi === 'TMDB'
					? await api.getTmdbTvDetails(result.imdbId)
					: await api.getOmdbTvDetails(result.imdbId);
				if (gen !== this.searchGeneration) return;
				if (full) {
					this.fieldTitle = full.title;
					this.fieldEpisodes = full.episodes;
					this.fieldDuration = full.episodeDuration;
					this.fieldReleaseDate = full.releaseDate;
					this.fieldLink = full.url;
					this.fieldSeasons = full.seasons;
					this.fieldTrailerUrl = full.trailerUrl ?? '';
					this.fieldDirector = full.director ?? [];
					this.fieldCast = full.cast ?? [];
					this.fieldStudio = full.studio ?? [];
				}
			} else if (!isAnimeResult(result) && result.mediaType === 'movie') {
				const full = activeApi === 'TMDB'
					? await api.getTmdbMovieDetails(result.imdbId)
					: await api.getOmdbMovieDetails(result.imdbId);
				if (gen !== this.searchGeneration) return;
				if (full) {
					this.fieldTitle = full.title;
					this.fieldEpisodes = full.episodes;
					this.fieldDuration = full.episodeDuration;
					this.fieldReleaseDate = full.releaseDate;
					this.fieldLink = full.url;
					this.fieldSeasons = full.seasons;
					this.fieldTrailerUrl = full.trailerUrl ?? '';
					this.fieldDirector = full.director ?? [];
					this.fieldCast = full.cast ?? [];
					this.fieldStudio = full.studio ?? [];
				}
			} else {
				const anime = result as AnimeSearchResult;
				this.fieldTitle = anime.title;
				this.fieldEpisodes = anime.episodes;
				this.fieldDuration = anime.duration;
				this.fieldReleaseDate = anime.releaseDate;
				this.fieldLink = anime.url;
				this.fieldSeasons = anime.seasons;
				this.fieldTrailerUrl = anime.trailerUrl ?? '';
				// anime sources don't carry credits — clear any stale movie/TV selection.
				// studio is backfilled from Jikan/AniList on first modal open.
				this.fieldDirector = [];
				this.fieldCast = [];
				this.fieldStudio = [];
				if (anime.anilistId && anime.anilistId > 0) {
					this.fieldAnilistId = anime.anilistId;
					this.fieldMalId = null;
				} else {
					this.fieldMalId = anime.malId;
					this.fieldAnilistId = null;
				}
			}
		} catch {
			this.fieldTitle = result.title;
			this.fieldEpisodes = isAnimeResult(result) ? result.episodes : result.episodes;
			this.fieldDuration = isAnimeResult(result) ? result.duration : result.episodeDuration;
			this.fieldReleaseDate = result.releaseDate;
			this.fieldLink = result.url;
			this.fieldSeasons = result.seasons;
			// anime search results already carry a trailer; movie/TV list rows do not
			this.fieldTrailerUrl = result.trailerUrl ?? '';
			this.fieldDirector = !isAnimeResult(result) ? (result.director ?? []) : [];
			this.fieldCast = !isAnimeResult(result) ? (result.cast ?? []) : [];
			this.fieldStudio = !isAnimeResult(result) ? (result.studio ?? []) : [];
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

		// a paired-row cell: [label][fixed-width input]. The left cell keeps the standard label width so its
		// input aligns with the full-width fields; the right cell anchors to the row's right edge.
		const makeCell = (row: HTMLElement, label: string, right = false): HTMLElement => {
			const cell = row.createDiv({
				cls: right ? 'wl-modal-pair-cell wl-modal-pair-cell-right' : 'wl-modal-pair-cell',
			});
			cell.createSpan({ cls: 'wl-modal-label', text: label });
			return cell;
		};

		const titleRow = makeRow('Title');
		const titleInput = titleRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: 'Title name' },
		});
		titleInput.value = this.fieldTitle;
		titleInput.addEventListener('input', () => { this.fieldTitle = titleInput.value; });

		// episodes + ep. duration paired 50/50 to reclaim vertical space
		const epsDurRow = this.formEl.createDiv({ cls: 'wl-modal-row wl-modal-row-pair' });
		const epsCell = makeCell(epsDurRow, 'Episodes');
		const epsInput = epsCell.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'number', min: '0', placeholder: '0' },
		});
		epsInput.value = String(this.fieldEpisodes);
		epsInput.addEventListener('input', () => { this.fieldEpisodes = parseInt(epsInput.value, 10) || 0; });

		const durCell = makeCell(epsDurRow, 'Ep. duration (min)', true);
		const durInput = durCell.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'number', min: '0', placeholder: '24' },
		});
		durInput.value = String(this.fieldDuration);
		durInput.addEventListener('input', () => { this.fieldDuration = parseInt(durInput.value, 10) || 0; });

		// the picker refuses to commit unparsable text, so the field can't store a raw non-ISO string
		const relRow = makeRow('Release date');
		const relStack = relRow.createDiv({ cls: 'wl-modal-input-stack' });
		createDatePicker({
			parent: relStack,
			inputCls: 'wl-modal-input',
			value: this.fieldReleaseDate || null,
			lenient: true,
			onChange: (iso) => { this.fieldReleaseDate = iso ?? ''; },
		});

		const linkRow = makeRow('External link');
		const linkInput = linkRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'url', placeholder: 'https://example.com' },
		});
		linkInput.value = this.fieldLink;
		linkInput.addEventListener('input', () => { this.fieldLink = linkInput.value; });

		// status + priority paired 50/50 (status excludes "To be released" — it follows releaseDate)
		const statusPriRow = this.formEl.createDiv({ cls: 'wl-modal-row wl-modal-row-pair' });
		const statusCell = makeCell(statusPriRow, 'Status');
		const statusSelect = statusCell.createEl('select', { cls: 'wl-select' });
		for (const s of this.plugin.settings.statuses.filter((s) => s.name !== 'To be released')) {
			const opt = statusSelect.createEl('option', { text: s.name, value: s.name });
			if (s.name === this.fieldStatus) opt.selected = true;
		}
		statusSelect.addEventListener('change', () => { this.fieldStatus = statusSelect.value; });

		const priCell = makeCell(statusPriRow, 'Priority', true);
		const priSelect = priCell.createEl('select', { cls: 'wl-select' });
		for (const p of this.plugin.settings.priorities) {
			const opt = priSelect.createEl('option', { text: p.name, value: p.name });
			if (p.name === this.fieldPriority) opt.selected = true;
		}
		priSelect.addEventListener('change', () => { this.fieldPriority = priSelect.value; });

		const ratingRow = makeRow('Rating');
		const starsWrap = ratingRow.createDiv({ cls: 'wl-stars' });
		const paintStars = (): void => {
			renderStarRating(starsWrap, this.fieldRating, {
				allowHalf: this.plugin.settings.halfStarRatings ?? false,
				tiers: this.plugin.settings.ratingSystem,
				showLabel: true,
				onChange: (value) => { this.fieldRating = value; paintStars(); },
			});
		};
		paintStars();

		const startRow = makeRow('Date started');
		createDatePicker({
			parent: startRow,
			inputCls: 'wl-modal-input',
			value: this.fieldDateStarted || null,
			onChange: (iso) => { this.fieldDateStarted = iso ?? ''; },
		});

		// group fields (mutually exclusive)
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

		if (this.fieldSeasons.length > 0) {
			const seasRow = makeRow('Seasons');
			seasRow.createSpan({
				cls: 'wl-modal-info',
				text: this.fieldSeasons.map((s) => `${s.name} (${s.episodes} eps)`).join(', '),
			});
		}

		renderCustomPropertyFormFields(
			this.formEl,
			normalizeCustomPropertyList(this.plugin.settings.watchlistCustomProperties),
			this.customPropState,
		);

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
			rating: this.fieldRating,
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
			favorite: false,
			posterUrl: '',
			trailerUrl: this.fieldTrailerUrl,
			manualTrailerUrl: '',
			// empty stays absent (= unfetched) so the detail modal's lazy backfill runs
			...(this.fieldDirector.length > 0 ? { director: this.fieldDirector } : {}),
			...(this.fieldCast.length > 0 ? { cast: this.fieldCast } : {}),
			...(this.fieldStudio.length > 0 ? { studio: this.fieldStudio } : {}),
			...(this.fieldMalId !== null ? { malId: this.fieldMalId } : {}),
			...(this.fieldAnilistId !== null ? { anilistId: this.fieldAnilistId } : {}),
			customFields: { ...this.customPropState.values },
		};

		// auto-complete episodes when adding with Completed status
		if (entry.status === 'Completed' && entry.totalEpisodes > 0) {
			entry.watchedEpisodes = Array.from({ length: entry.totalEpisodes }, (_, i) => i + 1);
			if (this.plugin.settings.setFinishDateAutomatically) {
				entry.dateFinished = todayIso();
			}
		}

		await this.dataManager.addTitle(entry);

		// remember the type actually used so "Last type used" can follow it
		this.plugin.settings.lastAddedType = entry.type;
		void this.plugin.saveSettings();

		// fire-and-forget community rating fetch (non-blocking)
		void (async () => {
			const animeSource = this.plugin.settings.animeApiSource ?? 'jikan';
			const group = getApiGroupForType(entry.type, this.plugin.settings.typeApiMapping);
			if (group === '') return;
			const result = await this.plugin.apiService.fetchCommunityRating(entry, animeSource, group);
			if (result) {
				this.dataManager.updateCommunityRating(entry.id, result.rating, result.votes, result.source);
			}
		})();

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
		this.onAdded(entry);
	}
}
