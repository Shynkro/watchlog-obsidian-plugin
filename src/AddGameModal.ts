import { App, Modal, Notice, setIcon } from 'obsidian';
import type WatchLogPlugin from './main';
import type { GameDataManager } from './GameDataManager';
import { apiErrorMessage, rawgResizedCover, steamAppIdFromUrl, type GameSearchResult } from './ApiService';
import { Game, GameGroup, GAME_AUTO_STATUS } from './types';
import { renderSearchResultRow } from './SearchThumbnail';
import { LibraryIndex, gameResultIdKeys } from './LibraryIndex';
import { renderModePill } from './ModePill';
import { renderTagChips } from './StatusDropdown';
import { createDatePicker } from './DatePicker';
import {
	normalizeCustomPropertyList,
	renderCustomPropertyFormFields,
	type CustomPropertyFormState,
} from './CustomProperties';

/** Lowercased word tokens of a platform name, split into alpha and numeric. */
function platformTokens(name: string): { alpha: Set<string>; num: Set<string> } {
	const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	return {
		alpha: new Set(tokens.filter((t) => !/^\d+$/.test(t))),
		num: new Set(tokens.filter((t) => /^\d+$/.test(t))),
	};
}

/**
 * Loose platform-name equality across APIs: the smaller alpha-token set must be contained in the
 * larger ("PC" ⊂ "Windows PC" ⊂ "PC (Microsoft Windows)"), and numeric tokens (console
 * generations) must match exactly — so "PlayStation 5" never matches "PlayStation 4".
 */
function platformMatches(a: string, b: string): boolean {
	const ta = platformTokens(a);
	const tb = platformTokens(b);
	const [small, big] = ta.alpha.size <= tb.alpha.size ? [ta.alpha, tb.alpha] : [tb.alpha, ta.alpha];
	if (small.size === 0) return false;
	for (const t of small) if (!big.has(t)) return false;
	if (ta.num.size !== tb.num.size) return false;
	for (const n of ta.num) if (!tb.num.has(n)) return false;
	return true;
}

/**
 * Add-game modal (the AddTitleModal pattern): API search (RAWG or IGDB per gamesApiSource) with
 * thumbnailed results, an editable form below, platform chips, the mode pill and a store-link
 * button. Works as a plain manual form when no API is configured.
 */
export class AddGameModal extends Modal {
	private plugin: WatchLogPlugin;
	private gameData: GameDataManager;
	private onAdded: () => void;

	private searchQuery = '';
	private searchResults: GameSearchResult[] = [];
	private isSearching = false;
	private searchGeneration = 0;
	private noApiMessage = '';
	private searchError = '';

	private fieldTitle = '';
	private fieldDeveloper = '';
	private fieldPublisher = '';
	private fieldGenre = '';
	private fieldStatus = '';
	private fieldPriority = '';
	private fieldReleaseDate = '';
	private fieldDateStarted = '';
	private fieldStoreUrl = '';
	private fieldLink = '';
	private fieldCoverUrl = '';
	private fieldPlatforms: string[] = [];
	// which API row the form was filled from — persisted on the game so covers can later be re-fetched
	// by id instead of by title
	private apiSource: '' | 'rawg' | 'igdb' = '';
	private apiId = '';
	private fieldSingleplayer = false;
	private fieldCoop = false;
	private fieldMultiplayer = false;
	private selectedGroupId = '';
	private newGroupName = '';
	private skipDuplicateCheck = false;
	private duplicateWarningEl: HTMLElement | null = null;
	private customPropState: CustomPropertyFormState = { values: {} };
	// built on first search, reused for the modal's life
	private libIndex: LibraryIndex | null = null;

	private resultsEl: HTMLElement | null = null;
	private formEl: HTMLElement | null = null;
	private searchDebounce: number | null = null;

	constructor(
		app: App,
		plugin: WatchLogPlugin,
		gameData: GameDataManager,
		onAdded: () => void,
		prefill?: { searchQuery?: string; title?: string },
	) {
		super(app);
		this.plugin = plugin;
		this.gameData = gameData;
		this.onAdded = onAdded;
		const s = gameData.getSettings();
		this.fieldGenre = s.types[0]?.name ?? '';
		this.fieldStatus = s.defaultStatus;
		// prefill (e.g. from Drafts): seed the search box and title field so the modal opens ready to search
		if (prefill?.searchQuery) this.searchQuery = prefill.searchQuery;
		if (prefill?.title) this.fieldTitle = prefill.title;
	}

	onOpen(): void {
		this.titleEl.setText('Add game');
		this.contentEl.addClass('wl-add-modal', 'wl-add-game-modal');
		this.buildUI();
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.searchDebounce) window.clearTimeout(this.searchDebounce);
	}

	private buildUI(): void {
		const content = this.contentEl;
		content.empty();

		const searchRow = content.createDiv({ cls: 'wl-modal-row' });
		searchRow.createSpan({ cls: 'wl-modal-label', text: 'Search' });
		const searchInput = searchRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: 'Search for a game...' },
		});
		searchInput.value = this.searchQuery;
		searchInput.addEventListener('input', () => {
			this.searchQuery = searchInput.value;
			if (this.searchDebounce) window.clearTimeout(this.searchDebounce);
			this.searchDebounce = window.setTimeout(() => void this.performSearch(), 600);
		});
		const searchBtn = searchRow.createEl('button', { cls: 'wl-btn', text: 'Search' });
		searchBtn.addEventListener('click', () => void this.performSearch());

		this.resultsEl = content.createDiv({ cls: 'wl-modal-results wl-results-grid' });

		this.formEl = content.createDiv({ cls: 'wl-modal-form' });
		this.renderForm();

		// a prefilled search fires immediately — the results are the point of routing a draft here
		if (this.searchQuery.trim()) void this.performSearch();
	}

	private async performSearch(): Promise<void> {
		if (!this.searchQuery.trim()) return;
		const gen = ++this.searchGeneration;
		this.isSearching = true;
		this.renderResults();

		try {
			const api = this.plugin.apiService;
			const source = this.plugin.settings.gamesApiSource ?? 'rawg';

			let results: GameSearchResult[] = [];
			let noApi = '';
			if (source === 'igdb') {
				if (!api.hasIgdbCredentials()) {
					noApi = 'No IGDB credentials configured. Go to Settings → API → Games to set the Twitch Client ID and Secret.';
				} else {
					results = await api.searchIgdbGames(this.searchQuery);
				}
			} else {
				if (!api.hasRawgKey()) {
					noApi = 'No RAWG API key configured. Go to Settings → API → Games to set one up.';
				} else {
					results = await api.searchRawgGames(this.searchQuery);
				}
			}
			if (gen !== this.searchGeneration) return; // stale
			this.noApiMessage = noApi;
			this.searchError = '';
			this.searchResults = results;
		} catch (err) {
			if (gen !== this.searchGeneration) return;
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

		if (!this.libIndex) this.libIndex = LibraryIndex.build(this.plugin, ['games']);
		const libIndex = this.libIndex;

		for (const result of this.searchResults) {
			const year = result.releaseDate.match(/^(\d{4})/)?.[1] ?? '—';
			const platforms = result.platforms.slice(0, 3).join(', ') || 'Unknown platforms';
			renderSearchResultRow(this.resultsEl, {
				// card covers are full-width now, so request a sharper 600px rendition
				thumbUrl: rawgResizedCover(result.coverUrl, 600),
				fallbackIcon: '🎮',
				title: result.title,
				meta: `${year} · ${platforms}`,
				inLibrary: libIndex.lookup(gameResultIdKeys(result), result.title),
				onClick: (itemEl) => void this.selectResult(result, itemEl),
			});
		}
	}

	private async selectResult(result: GameSearchResult, itemEl: HTMLElement): Promise<void> {
		if (this.resultsEl) {
			for (const child of Array.from(this.resultsEl.children)) {
				child.removeClass('is-selected');
			}
		}
		itemEl.addClass('is-selected');

		const gen = ++this.searchGeneration;
		const api = this.plugin.apiService;
		// remember the origin even if the detail fetch fails — the search row identifies the game well
		// enough to re-fetch its cover later
		this.apiSource = result.source;
		this.apiId = String(result.id);
		try {
			const full = result.source === 'igdb'
				? await api.getIgdbGameDetails(result.id)
				: await api.getRawgGameDetails(result.id);
			if (gen !== this.searchGeneration) return;
			if (full) {
				this.fieldTitle = full.title;
				this.fieldDeveloper = full.developer;
				this.fieldPublisher = full.publisher;
				this.fieldReleaseDate = full.releaseDate;
				this.fieldCoverUrl = full.coverUrl;
				this.fieldLink = full.url;
				this.fieldStoreUrl = full.storeUrl;
				this.fieldSingleplayer = full.singleplayer;
				this.fieldCoop = full.coop;
				this.fieldMultiplayer = full.multiplayer;
				this.fieldPlatforms = this.matchOwnPlatforms(full.platforms);
			}
		} catch {
			// detail fetch failed — fall back to what the search row carried
			this.fieldTitle = result.title;
			this.fieldReleaseDate = result.releaseDate;
			this.fieldCoverUrl = result.coverUrl;
			this.fieldLink = result.url;
			this.fieldPlatforms = this.matchOwnPlatforms(result.platforms);
		}

		this.renderForm();
	}

	/** Maps API platform names onto the user's configured platform chips. */
	private matchOwnPlatforms(apiPlatforms: string[]): string[] {
		return this.gameData
			.getSettings()
			.platforms.filter((own) => apiPlatforms.some((p) => platformMatches(own.name, p)))
			.map((own) => own.name);
	}

	private renderForm(): void {
		if (!this.formEl) return;
		this.formEl.empty();

		const makeRow = (label: string): HTMLElement => {
			const row = this.formEl!.createDiv({ cls: 'wl-modal-row' });
			row.createSpan({ cls: 'wl-modal-label', text: label });
			return row;
		};

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
			attr: { type: 'text', placeholder: 'Game title' },
		});
		titleInput.value = this.fieldTitle;
		titleInput.addEventListener('input', () => { this.fieldTitle = titleInput.value; });

		const devPubRow = this.formEl.createDiv({ cls: 'wl-modal-row wl-modal-row-pair' });
		const devCell = makeCell(devPubRow, 'Developer');
		const devInput = devCell.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: 'Developer' },
		});
		devInput.value = this.fieldDeveloper;
		devInput.addEventListener('input', () => { this.fieldDeveloper = devInput.value; });

		const pubCell = makeCell(devPubRow, 'Publisher', true);
		const pubInput = pubCell.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: 'Publisher' },
		});
		pubInput.value = this.fieldPublisher;
		pubInput.addEventListener('input', () => { this.fieldPublisher = pubInput.value; });

		const settings = this.gameData.getSettings();
		const genrePriRow = this.formEl.createDiv({ cls: 'wl-modal-row wl-modal-row-pair' });
		const genreCell = makeCell(genrePriRow, 'Genre');
		const genreSelect = genreCell.createEl('select', { cls: 'wl-select' });
		for (const t of settings.types) {
			const opt = genreSelect.createEl('option', { text: t.name, value: t.name });
			if (t.name === this.fieldGenre) opt.selected = true;
		}
		genreSelect.addEventListener('change', () => { this.fieldGenre = genreSelect.value; });

		const priCell = makeCell(genrePriRow, 'Priority', true);
		const priSelect = priCell.createEl('select', { cls: 'wl-select' });
		priSelect.createEl('option', { text: '— none —', value: '' });
		for (const p of this.plugin.settings.priorities) {
			const opt = priSelect.createEl('option', { text: p.name, value: p.name });
			if (p.name === this.fieldPriority) opt.selected = true;
		}
		priSelect.addEventListener('change', () => { this.fieldPriority = priSelect.value; });

		// status + date started paired 50/50 (the auto "To be released" is excluded — it follows the
		// release date)
		const statusStartRow = this.formEl.createDiv({ cls: 'wl-modal-row wl-modal-row-pair' });
		const statusCell = makeCell(statusStartRow, 'Status');
		const statusSelect = statusCell.createEl('select', { cls: 'wl-select' });
		for (const s of settings.statuses.filter((s) => s.name !== GAME_AUTO_STATUS)) {
			const opt = statusSelect.createEl('option', { text: s.name, value: s.name });
			if (s.name === this.fieldStatus) opt.selected = true;
		}
		statusSelect.addEventListener('change', () => { this.fieldStatus = statusSelect.value; });

		const startCell = makeCell(statusStartRow, 'Date started', true);
		createDatePicker({
			parent: startCell,
			inputCls: 'wl-modal-input',
			value: this.fieldDateStarted || null,
			onChange: (iso) => { this.fieldDateStarted = iso ?? ''; },
		});

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

		const storeRow = makeRow('Store link');
		const storeInput = storeRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'url', placeholder: 'https://store.steampowered.com/...' },
		});
		storeInput.value = this.fieldStoreUrl;
		const storeBtn = storeRow.createEl('button', {
			cls: 'wl-store-btn',
			attr: { type: 'button', title: 'Open store page', 'aria-label': 'Open store page' },
		});
		setIcon(storeBtn, 'store');
		const syncStoreBtn = (): void => {
			storeBtn.toggleClass('wl-hidden', !this.fieldStoreUrl.trim());
		};
		syncStoreBtn();
		storeInput.addEventListener('input', () => {
			this.fieldStoreUrl = storeInput.value;
			syncStoreBtn();
		});
		storeBtn.addEventListener('click', () => {
			const url = this.fieldStoreUrl.trim();
			if (url) window.open(url, '_blank');
		});

		const linkRow = makeRow('External link');
		const linkInput = linkRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'url', placeholder: 'https://example.com' },
		});
		linkInput.value = this.fieldLink;
		linkInput.addEventListener('input', () => { this.fieldLink = linkInput.value; });

		const coverRow = makeRow('Cover URL');
		const coverInput = coverRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'url', placeholder: 'https://…' },
		});
		coverInput.value = this.fieldCoverUrl;
		coverInput.addEventListener('input', () => { this.fieldCoverUrl = coverInput.value; });

		const modesRow = makeRow('Modes');
		renderModePill(
			modesRow,
			() => ({
				singleplayer: this.fieldSingleplayer,
				coop: this.fieldCoop,
				multiplayer: this.fieldMultiplayer,
			}),
			(patch) => {
				if (patch.singleplayer !== undefined) this.fieldSingleplayer = patch.singleplayer;
				if (patch.coop !== undefined) this.fieldCoop = patch.coop;
				if (patch.multiplayer !== undefined) this.fieldMultiplayer = patch.multiplayer;
			},
		);

		// platforms — the shared coloured toggle chips, driven by Settings → Customize → Games
		const platRow = makeRow('Platforms');
		renderTagChips({
			wrap: platRow.createDiv({ cls: 'wl-game-modal-platforms wl-add-game-platforms' }),
			tags: settings.platforms,
			selected: this.fieldPlatforms,
			onToggle: (sel) => { this.fieldPlatforms = sel; },
		});

		// group fields (mutually exclusive — the AddTitleModal pattern)
		const groups = this.gameData.getGroups();
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

		renderCustomPropertyFormFields(
			this.formEl,
			normalizeCustomPropertyList(this.gameData.getCustomProperties()),
			this.customPropState,
		);

		const btnRow = this.formEl.createDiv({ cls: 'wl-modal-btn-row' });
		const addBtn = btnRow.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Add to games' });
		addBtn.addEventListener('click', () => void this.addGame());
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
			void this.addGame();
		});
		cancelBtn.addEventListener('click', () => {
			warn.remove();
			this.duplicateWarningEl = null;
			this.skipDuplicateCheck = false;
		});
	}

	private async addGame(): Promise<void> {
		const titleName = this.fieldTitle.trim();
		if (!titleName) {
			new Notice('Please enter a game title.');
			return;
		}

		if (!this.skipDuplicateCheck) {
			const duplicate = this.gameData.getGames().find(
				(g) => g.title.toLowerCase() === titleName.toLowerCase(),
			);
			if (duplicate) {
				const btnRow = this.contentEl.querySelector<HTMLElement>('.wl-modal-btn-row');
				if (btnRow) this.showDuplicateWarning(titleName, btnRow);
				return;
			}
		}
		this.skipDuplicateCheck = false;

		const now = new Date().toISOString();
		const game: Game = {
			id: this.gameData.generateGameId(titleName),
			title: titleName,
			developer: this.fieldDeveloper.trim(),
			publisher: this.fieldPublisher.trim(),
			type: this.fieldGenre,
			status: this.fieldStatus,
			priority: this.fieldPriority,
			favorite: false,
			wishlist: false,
			rating: 0,
			progress: 0,
			playtimeMinutes: 0,
			achievementsEarned: 0,
			achievementsTotal: 0,
			platforms: [...this.fieldPlatforms],
			singleplayer: this.fieldSingleplayer,
			coop: this.fieldCoop,
			multiplayer: this.fieldMultiplayer,
			coverUrl: this.fieldCoverUrl.trim(),
			apiSource: this.apiSource,
			apiId: this.apiId,
			// seeded from the store link when it's a Steam page, so a later Steam sync matches exactly instead
			// of guessing by title
			steamAppId: steamAppIdFromUrl(this.fieldStoreUrl.trim()),
			lastPlayed: null,
			storeUrl: this.fieldStoreUrl.trim(),
			externalLink: this.fieldLink.trim(),
			vaultPage: '',
			releaseDate: this.fieldReleaseDate || null,
			dateStarted: this.fieldDateStarted || null,
			dateFinished: null,
			dateAdded: now,
			dateModified: now,
			customFields: { ...this.customPropState.values },
		};

		await this.gameData.addGame(game);

		if (this.selectedGroupId) {
			await this.gameData.addGameToGroup(this.selectedGroupId, game.id);
		} else if (this.newGroupName.trim()) {
			const name = this.newGroupName.trim();
			const group: GameGroup = {
				id: this.gameData.generateGroupId(name),
				name,
				gameIds: [game.id],
				dateAdded: new Date().toISOString(),
			};
			await this.gameData.addGroup(group);
		}

		new Notice(`"${titleName}" added to WatchLog.`);
		this.close();
		this.onAdded();
	}
}
