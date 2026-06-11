import { App, FuzzySuggestModal, Modal, Notice, TFile } from 'obsidian';
import type WatchLogPlugin from './main';
import type { ReadingDataManager } from './ReadingDataManager';
import type { BookSearchResult, MangaSearchResult } from './ApiService';
import { googleBooksErrorMessage } from './ApiService';
import {
	Book,
	Manga,
	ReadingStatus,
	SELECTABLE_READING_STATUSES,
	formatDateDisplay,
	parseDateInput,
} from './types';

export type ReadingMode = 'book' | 'manga';

interface ReadingFormState {
	title: string;
	author: string;
	status: ReadingStatus;
	rating: number;
	pagesRead: number;
	totalPages: number;
	chaptersRead: number;
	totalChapters: number;
	volumesRead: number;
	totalVolumes: number;
	coverUrl: string;
	googleBooksId: string;
	malId: string;
	vaultPage: string;
	dateStarted: string | null;
	dateFinished: string | null;
	releaseDate: string | null;
}

function emptyFormState(): ReadingFormState {
	return {
		title: '',
		author: '',
		status: 'Plan to Read',
		rating: 0,
		pagesRead: 0,
		totalPages: 0,
		chaptersRead: 0,
		totalChapters: 0,
		volumesRead: 0,
		totalVolumes: 0,
		coverUrl: '',
		googleBooksId: '',
		malId: '',
		vaultPage: '',
		dateStarted: null,
		dateFinished: null,
		releaseDate: null,
	};
}

export function bookToFormState(book: Book): ReadingFormState {
	return {
		title: book.title,
		author: book.author,
		status: book.status,
		rating: book.rating,
		pagesRead: book.pagesRead,
		totalPages: book.totalPages,
		chaptersRead: book.chaptersRead,
		totalChapters: book.totalChapters,
		volumesRead: 0,
		totalVolumes: 0,
		coverUrl: book.coverUrl,
		googleBooksId: book.googleBooksId,
		malId: '',
		vaultPage: book.vaultPage,
		dateStarted: book.dateStarted,
		dateFinished: book.dateFinished,
		releaseDate: book.releaseDate,
	};
}

export function mangaToFormState(manga: Manga): ReadingFormState {
	return {
		title: manga.title,
		author: manga.author,
		status: manga.status,
		rating: manga.rating,
		pagesRead: 0,
		totalPages: 0,
		chaptersRead: manga.chaptersRead,
		totalChapters: manga.totalChapters,
		volumesRead: manga.volumesRead,
		totalVolumes: manga.totalVolumes,
		coverUrl: manga.coverUrl,
		googleBooksId: '',
		malId: manga.malId,
		vaultPage: manga.vaultPage,
		dateStarted: manga.dateStarted,
		dateFinished: manga.dateFinished,
		releaseDate: manga.releaseDate,
	};
}

export class VaultFilePicker extends FuzzySuggestModal<TFile> {
	private onPick: (file: TFile) => void;
	private files: TFile[];

	constructor(app: App, files: TFile[], onPick: (file: TFile) => void) {
		super(app);
		this.files = files;
		this.onPick = onPick;
		this.setPlaceholder('Pick a vault note...');
	}

	getItems(): TFile[] {
		return this.files;
	}
	getItemText(item: TFile): string {
		return item.path;
	}
	onChooseItem(item: TFile): void {
		this.onPick(item);
	}
}

export class AddReadingModal extends Modal {
	private plugin: WatchLogPlugin;
	private readingData: ReadingDataManager;
	private mode: ReadingMode;
	private state: ReadingFormState;
	private existingId: string | null;
	private onSaved: () => void;
	private starsWrap: HTMLElement | null = null;
	private lookupResultsEl: HTMLElement | null = null;
	private formEl: HTMLElement | null = null;
	private openVaultBtn: HTMLButtonElement | null = null;
	private linkVaultBtn: HTMLButtonElement | null = null;
	private lookupSearchGen = 0;
	private selectGen = 0;
	private prefillSearch: string;

	constructor(
		app: App,
		plugin: WatchLogPlugin,
		readingData: ReadingDataManager,
		mode: ReadingMode,
		onSaved: () => void,
		initial?: { state: ReadingFormState; id: string },
		prefillSearch?: string,
	) {
		super(app);
		this.plugin = plugin;
		this.readingData = readingData;
		this.mode = mode;
		this.state = initial ? { ...initial.state } : emptyFormState();
		if (!initial) {
			const defStatus = readingData.getSettings().defaultStatus;
			if (defStatus) this.state.status = defStatus;
		}
		this.existingId = initial?.id ?? null;
		this.onSaved = onSaved;
		this.prefillSearch = prefillSearch ?? '';
	}

	onOpen(): void {
		const colorTheme = this.plugin.settings.colorTheme ?? 'default';
		this.modalEl.setAttribute('data-theme', colorTheme);
		this.contentEl.setAttribute('data-theme', colorTheme);
		this.contentEl.addClass('wl-view');
		this.contentEl.addClass('wl-reading-modal');
		this.contentEl.addClass(this.mode === 'book' ? 'wl-reading-modal-book' : 'wl-reading-modal-manga');
		this.titleEl.setText(this.headerTitle());
		this.buildUI();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private headerTitle(): string {
		if (this.existingId) {
			return this.mode === 'book' ? 'Edit book' : 'Edit manga';
		}
		return this.mode === 'book' ? 'Add book' : 'Add manga';
	}

	private buildUI(): void {
		const c = this.contentEl;
		c.empty();

		this.renderHeaderRow(c);
		this.renderLookupBar(c);
		c.createDiv({ cls: 'wl-reading-modal-divider' });
		this.formEl = c.createDiv({ cls: 'wl-reading-form-wrap' });
		this.renderForm(this.formEl);
		this.renderFooter(c);
	}

	private renderHeaderRow(parent: HTMLElement): void {
		const row = parent.createDiv({ cls: 'wl-reading-modal-header' });
		const left = row.createDiv({ cls: 'wl-reading-modal-header-left' });
		left.createSpan({
			cls: 'wl-reading-modal-header-icon',
			text: this.mode === 'book' ? '📖' : '📓',
		});
		left.createSpan({
			cls: 'wl-reading-modal-header-title',
			text: this.headerTitle(),
		});

		const actions = row.createDiv({ cls: 'wl-reading-modal-header-actions' });
		// "Link" button intentionally omitted from the Add modal — vault-page linking
		// lives in the detail/edit modal (ReadingDetailModal).
		this.openVaultBtn = actions.createEl('button', {
			cls: 'wl-btn wl-btn-sm',
			text: 'Open',
		});
		this.openVaultBtn.addEventListener('click', () => this.openLinkedVaultPage());
		this.refreshVaultButtons();
	}

	private refreshVaultButtons(): void {
		if (this.linkVaultBtn) {
			this.linkVaultBtn.textContent = this.state.vaultPage ? 'Change link' : 'Link';
			this.linkVaultBtn.title = this.state.vaultPage
				? `Linked: ${this.state.vaultPage}`
				: 'Link a vault note to this entry';
		}
		if (this.openVaultBtn) {
			const hasLink = !!this.state.vaultPage;
			this.openVaultBtn.disabled = !hasLink;
			this.openVaultBtn.toggleClass('is-hidden', !hasLink);
		}
	}

	private openLinkedVaultPage(): void {
		const path = this.state.vaultPage;
		if (!path) return;
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			void this.plugin.app.workspace.getLeaf('tab').openFile(file);
			this.close();
		} else {
			new Notice('Linked vault page no longer exists.');
		}
	}

	private renderLookupBar(parent: HTMLElement): void {
		const lookup = parent.createDiv({ cls: 'wl-reading-lookup' });
		const input = lookup.createEl('input', {
			cls: 'wl-modal-input wl-reading-lookup-input',
			attr: {
				type: 'text',
				placeholder: this.mode === 'book'
					? 'Search by title or ISBN...'
					: 'Search by title or MAL ID...',
			},
		});
		const fetchBtn = lookup.createEl('button', {
			cls: 'wl-btn wl-reading-lookup-btn',
			text: 'Fetch',
		});
		this.lookupResultsEl = parent.createDiv({ cls: 'wl-reading-lookup-results' });

		// Prefill the search box (e.g. from a Drafts entry) without auto-fetching,
		// mirroring the Watchlist Add modal's prefill behavior.
		if (this.prefillSearch) input.value = this.prefillSearch;

		const runFetch = (): void => {
			const q = input.value.trim();
			if (!q) {
				new Notice('Enter a search term first.');
				return;
			}
			void this.performLookup(q);
		};

		fetchBtn.addEventListener('click', runFetch);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				runFetch();
			}
		});
	}

	private async performLookup(query: string): Promise<void> {
		const gen = ++this.lookupSearchGen;
		if (!this.lookupResultsEl) return;
		this.lookupResultsEl.empty();
		this.lookupResultsEl.createDiv({ cls: 'wl-reading-lookup-loading', text: 'Searching...' });

		try {
			if (this.mode === 'book') {
				if (!this.plugin.apiService.hasGoogleBooksKey()) {
					if (gen !== this.lookupSearchGen) return;
					this.lookupResultsEl.empty();
					this.lookupResultsEl.createDiv({
						cls: 'wl-reading-lookup-empty',
						text: 'Google Books API key required — add one in Settings → API → Books.',
					});
					return;
				}
				const results = await this.plugin.apiService.searchGoogleBooks(query);
				if (gen !== this.lookupSearchGen) return;
				this.renderBookLookupResults(results);
			} else {
				const isNumeric = /^\d+$/.test(query);
				let results: MangaSearchResult[];
				if (isNumeric) {
					const single = await this.plugin.apiService.getMangaByMalId(parseInt(query, 10));
					if (gen !== this.lookupSearchGen) return;
					results = single ? [single] : [];
				} else {
					results = await this.plugin.apiService.searchManga(query);
					if (gen !== this.lookupSearchGen) return;
				}
				this.renderMangaLookupResults(results);
			}
		} catch (err) {
			if (gen !== this.lookupSearchGen) return;
			this.lookupResultsEl.empty();
			const msg = this.mode === 'book' ? googleBooksErrorMessage(err) : 'Lookup failed. Check your connection.';
			this.lookupResultsEl.createDiv({ cls: 'wl-reading-lookup-empty', text: msg });
		}
	}

	private renderBookLookupResults(results: BookSearchResult[]): void {
		if (!this.lookupResultsEl) return;
		this.lookupResultsEl.empty();
		if (results.length === 0) {
			this.lookupResultsEl.createDiv({ cls: 'wl-reading-lookup-empty', text: 'No matches.' });
			return;
		}
		for (const r of results) {
			const item = this.lookupResultsEl.createDiv({ cls: 'wl-reading-lookup-item' });
			this.renderLookupItemTitle(item, r.title, r.url);
			const meta = [r.author || 'Unknown author', r.year ? String(r.year) : ''].filter(Boolean).join(' · ');
			item.createDiv({ cls: 'wl-reading-lookup-item-meta', text: meta });
			item.addEventListener('click', () => this.applyBookResult(r));
		}
	}

	/** Title row with a globe web-link to the right (same pattern as the Watchlist). */
	private renderLookupItemTitle(item: HTMLElement, title: string, url: string): void {
		const titleRow = item.createDiv({ cls: 'wl-reading-lookup-item-title-row' });
		titleRow.createDiv({ cls: 'wl-reading-lookup-item-title', text: title || '(untitled)' });
		if (url) {
			const linkIcon = titleRow.createEl('a', { cls: 'wl-acc-link-icon', text: '🌐' });
			linkIcon.href = url;
			linkIcon.title = 'Open external link';
			linkIcon.target = '_blank';
			linkIcon.rel = 'noopener noreferrer';
			linkIcon.addEventListener('click', (e) => e.stopPropagation());
		}
	}

	private renderMangaLookupResults(results: MangaSearchResult[]): void {
		if (!this.lookupResultsEl) return;
		this.lookupResultsEl.empty();
		if (results.length === 0) {
			this.lookupResultsEl.createDiv({ cls: 'wl-reading-lookup-empty', text: 'No matches.' });
			return;
		}
		for (const r of results) {
			const item = this.lookupResultsEl.createDiv({ cls: 'wl-reading-lookup-item' });
			this.renderLookupItemTitle(item, r.title, r.url);
			const meta = [r.author || 'Unknown author', r.year ? String(r.year) : ''].filter(Boolean).join(' · ');
			item.createDiv({ cls: 'wl-reading-lookup-item-meta', text: meta });
			item.addEventListener('click', () => this.applyMangaResult(r));
		}
	}

	private applyBookResult(r: BookSearchResult): void {
		// Always overwrite the auto-populated fields so re-selecting a different
		// result fully replaces the previous selection's data.
		const gen = ++this.selectGen;
		this.state.title = r.title;
		this.state.author = r.author;
		this.state.totalPages = r.totalPages;
		this.state.coverUrl = r.coverUrl;
		this.state.googleBooksId = r.googleBooksId;
		this.state.releaseDate = r.releaseDate ?? '';
		this.refreshForm();
		// Keep the results list open so another result can be picked.
		// Search results sometimes omit page counts and only return thumbnail covers —
		// fetch the full volume for the selected book to upgrade both.
		if (r.googleBooksId) {
			void (async () => {
				try {
					const detail = await this.plugin.apiService.getGoogleBookById(r.googleBooksId);
					if (gen !== this.selectGen || !detail) return; // a newer selection superseded this one
					if (detail.totalPages > 0) this.state.totalPages = detail.totalPages;
					if (detail.coverUrl) this.state.coverUrl = detail.coverUrl;
					this.refreshForm();
				} catch {
					// Best-effort enrichment; the book is already applied from search results.
				}
			})();
		}
	}

	private applyMangaResult(r: MangaSearchResult): void {
		// Always overwrite the auto-populated fields so re-selecting a different
		// result fully replaces the previous selection's data.
		const gen = ++this.selectGen;
		this.state.title = r.title;
		this.state.author = r.author;
		this.state.totalChapters = r.totalChapters;
		this.state.totalVolumes = r.totalVolumes;
		this.state.coverUrl = r.coverUrl;
		this.state.malId = r.malId > 0 ? String(r.malId) : '';
		this.state.releaseDate = r.releaseDate ?? '';
		this.refreshForm();
		// Keep the results list open so another result can be picked.
		// Search returns null chapters/volumes for ongoing titles — fetch detail only
		// for the selected manga to populate the totals.
		if (r.malId > 0) {
			void (async () => {
				const detail = await this.plugin.apiService.getMangaByMalId(r.malId);
				if (gen !== this.selectGen || !detail) return; // superseded or no data
				this.state.totalChapters = detail.totalChapters > 0 ? detail.totalChapters : this.state.totalChapters;
				this.state.totalVolumes = detail.totalVolumes > 0 ? detail.totalVolumes : this.state.totalVolumes;
				this.refreshForm();
			})();
		}
	}

	private refreshForm(): void {
		if (!this.formEl) return;
		this.formEl.empty();
		this.renderForm(this.formEl);
	}

	private renderForm(parent: HTMLElement): void {
		const form = parent.createDiv({ cls: 'wl-reading-form' });

		// Title (required)
		this.renderTextField(form, 'Title', 'Book title', this.state.title, (v) => {
			this.state.title = v;
		});

		// Author
		this.renderTextField(form, 'Author', 'Author name', this.state.author, (v) => {
			this.state.author = v;
		});

		// Status + Rating row (compact, inline)
		this.renderStatusRatingRow(form);

		// PROGRESS + OPTIONAL side-by-side grid
		this.renderProgressOptionalGrid(form);
	}

	private renderProgressOptionalGrid(parent: HTMLElement): void {
		const grid = parent.createDiv({ cls: 'wl-reading-form-grid' });

		const progressCol = grid.createDiv({ cls: 'wl-reading-form-grid-col' });
		progressCol.createDiv({ cls: 'wl-reading-section-label', text: 'Progress' });
		if (this.mode === 'book') {
			this.renderTwoNumberRow(
				progressCol,
				{ label: 'Pages read', value: this.state.pagesRead, onChange: (n) => { this.state.pagesRead = n; } },
				{ label: 'Chapters read', value: this.state.chaptersRead, onChange: (n) => { this.state.chaptersRead = n; } },
			);
			this.renderTwoNumberRow(
				progressCol,
				{ label: 'Total pages', value: this.state.totalPages, onChange: (n) => { this.state.totalPages = n; } },
				{ label: 'Total chapters', value: this.state.totalChapters, onChange: (n) => { this.state.totalChapters = n; } },
			);
		} else {
			this.renderTwoNumberRow(
				progressCol,
				{ label: 'Chapters read', value: this.state.chaptersRead, onChange: (n) => { this.state.chaptersRead = n; } },
				{ label: 'Volumes read', value: this.state.volumesRead, onChange: (n) => { this.state.volumesRead = n; } },
			);
			this.renderTwoNumberRow(
				progressCol,
				{ label: 'Total chapters', value: this.state.totalChapters, onChange: (n) => { this.state.totalChapters = n; } },
				{ label: 'Total volumes', value: this.state.totalVolumes, onChange: (n) => { this.state.totalVolumes = n; } },
			);
		}

		const optionalCol = grid.createDiv({ cls: 'wl-reading-form-grid-col' });
		optionalCol.createDiv({ cls: 'wl-reading-section-label', text: 'Optional' });
		this.renderTextField(optionalCol, 'Cover URL', 'https://...', this.state.coverUrl, (v) => {
			this.state.coverUrl = v;
		});
		this.renderDateField(optionalCol, 'Start date', this.state.dateStarted, (parsed) => {
			this.state.dateStarted = parsed;
		});
		this.renderDateField(optionalCol, 'Release date', this.state.releaseDate, (parsed) => {
			this.state.releaseDate = parsed;
		});
	}

	private renderTextField(
		parent: HTMLElement,
		label: string,
		placeholder: string,
		value: string,
		onChange: (v: string) => void,
	): void {
		const row = parent.createDiv({ cls: 'wl-reading-row' });
		row.createSpan({ cls: 'wl-reading-label', text: label });
		const input = row.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder },
		});
		input.value = value;
		input.addEventListener('input', () => onChange(input.value));
	}

	private renderStatusRatingRow(parent: HTMLElement): void {
		const row = parent.createDiv({ cls: 'wl-reading-status-rating-row' });

		// Status (compact — only as wide as needed)
		const statusGroup = row.createDiv({ cls: 'wl-reading-inline-group' });
		statusGroup.createSpan({ cls: 'wl-reading-label', text: 'Status' });
		const select = statusGroup.createEl('select', { cls: 'wl-select wl-reading-status-select' });
		for (const s of SELECTABLE_READING_STATUSES) {
			const opt = select.createEl('option', { text: s, value: s });
			if (s === this.state.status) opt.selected = true;
		}
		select.addEventListener('change', () => {
			this.state.status = select.value as ReadingStatus;
		});

		// Rating (inline next to status)
		const ratingGroup = row.createDiv({ cls: 'wl-reading-inline-group' });
		ratingGroup.createSpan({ cls: 'wl-reading-label', text: 'Rating' });
		this.starsWrap = ratingGroup.createDiv({ cls: 'wl-stars wl-reading-stars' });
		this.renderStars();
	}

	private renderStars(): void {
		if (!this.starsWrap) return;
		this.starsWrap.empty();
		for (let i = 1; i <= 5; i++) {
			const star = this.starsWrap.createSpan({
				cls: `wl-star${this.state.rating >= i ? ' is-active' : ''}`,
				text: '★',
			});
			star.addEventListener('click', () => {
				this.state.rating = this.state.rating === i ? 0 : i;
				this.renderStars();
			});
		}
	}

	private renderTwoNumberRow(
		parent: HTMLElement,
		left: { label: string; value: number; onChange: (n: number) => void },
		right: { label: string; value: number; onChange: (n: number) => void },
	): void {
		const row = parent.createDiv({ cls: 'wl-reading-row wl-reading-row-split' });
		this.renderNumberCol(row, left);
		this.renderNumberCol(row, right);
	}

	private renderNumberCol(
		parent: HTMLElement,
		field: { label: string; value: number; onChange: (n: number) => void },
	): void {
		const col = parent.createDiv({ cls: 'wl-reading-col' });
		col.createSpan({ cls: 'wl-reading-label', text: field.label });
		const input = col.createEl('input', {
			cls: 'wl-modal-input wl-modal-input-sm',
			attr: { type: 'number', min: '0' },
		});
		input.value = String(field.value);
		input.addEventListener('input', () => {
			const n = parseInt(input.value, 10);
			field.onChange(isNaN(n) || n < 0 ? 0 : n);
		});
	}

	private renderDateField(
		parent: HTMLElement,
		label: string,
		value: string | null,
		onParsed: (parsed: string | null) => void,
	): void {
		const row = parent.createDiv({ cls: 'wl-reading-row' });
		row.createSpan({ cls: 'wl-reading-label', text: label });
		const input = row.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: 'DD/MM/YYYY', maxlength: '10' },
		});
		input.value = value ? formatDateDisplay(value) : '';
		input.addEventListener('change', () => {
			const raw = input.value.trim();
			if (!raw) {
				input.removeClass('wl-input-error');
				onParsed(null);
				return;
			}
			const parsed = parseDateInput(raw);
			if (parsed) {
				input.removeClass('wl-input-error');
				onParsed(parsed);
			} else {
				input.addClass('wl-input-error');
			}
		});
	}

	private renderFooter(parent: HTMLElement): void {
		const footer = parent.createDiv({ cls: 'wl-reading-modal-footer' });
		const cancelBtn = footer.createEl('button', { cls: 'wl-btn', text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const saveBtn = footer.createEl('button', {
			cls: 'wl-reading-add-btn wl-btn-success wl-reading-modal-save',
			text: this.saveButtonLabel(),
		});
		saveBtn.addEventListener('click', () => void this.save());
	}

	private saveButtonLabel(): string {
		if (this.existingId) return 'Save changes';
		return this.mode === 'book' ? 'Add book' : 'Add manga';
	}

	private async save(): Promise<void> {
		const title = this.state.title.trim();
		if (!title) {
			new Notice('Please enter a title.');
			return;
		}

		if (this.mode === 'book') {
			await this.saveBook(title);
		} else {
			await this.saveManga(title);
		}
		this.onSaved();
		this.close();
	}

	private async saveBook(title: string): Promise<void> {
		if (this.existingId) {
			const existing = this.readingData.getBook(this.existingId);
			if (!existing) {
				new Notice('Original book no longer exists.');
				return;
			}
			const updated: Book = {
				...existing,
				title,
				author: this.state.author.trim(),
				status: this.state.status,
				rating: this.state.rating,
				pagesRead: this.state.pagesRead,
				totalPages: this.state.totalPages,
				chaptersRead: this.state.chaptersRead,
				totalChapters: this.state.totalChapters,
				coverUrl: this.state.coverUrl.trim(),
				googleBooksId: this.state.googleBooksId.trim(),
				vaultPage: this.state.vaultPage,
				dateStarted: this.state.dateStarted,
				dateFinished: this.state.dateFinished,
				releaseDate: this.state.releaseDate,
			};
			await this.readingData.updateBook(updated);
		} else {
			const now = new Date().toISOString();
			const book: Book = {
				id: this.readingData.generateBookId(title),
				title,
				author: this.state.author.trim(),
				status: this.state.status,
				rating: this.state.rating,
				pagesRead: this.state.pagesRead,
				totalPages: this.state.totalPages,
				chaptersRead: this.state.chaptersRead,
				totalChapters: this.state.totalChapters,
				coverUrl: this.state.coverUrl.trim(),
				googleBooksId: this.state.googleBooksId.trim(),
				vaultPage: this.state.vaultPage,
				dateStarted: this.state.dateStarted,
				dateFinished: this.state.dateFinished,
				releaseDate: this.state.releaseDate,
				dateAdded: now,
				dateModified: now,
				customFields: {},
			};
			await this.readingData.addBook(book);
		}
	}

	private async saveManga(title: string): Promise<void> {
		if (this.existingId) {
			const existing = this.readingData.getManga(this.existingId);
			if (!existing) {
				new Notice('Original manga no longer exists.');
				return;
			}
			const updated: Manga = {
				...existing,
				title,
				author: this.state.author.trim(),
				status: this.state.status,
				rating: this.state.rating,
				chaptersRead: this.state.chaptersRead,
				totalChapters: this.state.totalChapters,
				volumesRead: this.state.volumesRead,
				totalVolumes: this.state.totalVolumes,
				coverUrl: this.state.coverUrl.trim(),
				malId: this.state.malId.trim(),
				vaultPage: this.state.vaultPage,
				dateStarted: this.state.dateStarted,
				dateFinished: this.state.dateFinished,
				releaseDate: this.state.releaseDate,
			};
			await this.readingData.updateManga(updated);
		} else {
			const now = new Date().toISOString();
			const manga: Manga = {
				id: this.readingData.generateMangaId(title),
				title,
				author: this.state.author.trim(),
				status: this.state.status,
				rating: this.state.rating,
				chaptersRead: this.state.chaptersRead,
				totalChapters: this.state.totalChapters,
				volumesRead: this.state.volumesRead,
				totalVolumes: this.state.totalVolumes,
				coverUrl: this.state.coverUrl.trim(),
				malId: this.state.malId.trim(),
				vaultPage: this.state.vaultPage,
				dateStarted: this.state.dateStarted,
				dateFinished: this.state.dateFinished,
				releaseDate: this.state.releaseDate,
				dateAdded: now,
				dateModified: now,
				customFields: {},
			};
			await this.readingData.addManga(manga);
		}
	}
}
