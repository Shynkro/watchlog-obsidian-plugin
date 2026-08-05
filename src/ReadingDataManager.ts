import { normalizePath, TFile } from 'obsidian';
import type WatchLogPlugin from './main';
import type { HistoryManager } from './HistoryManager';
import {
	Book,
	Manga,
	ReadingCustomColumn,
	ReadingData,
	ReadingSettings,
	DEFAULT_READING_SETTINGS,
	isReleaseDateFuture,
	todayIso,
	READING_STATUSES,
	DEFAULT_READING_STATUS_COLORS,
} from './types';

export type ReadingKind = 'book' | 'manga';

function sanitizeFilename(input: string): string {
	return input.replace(/[*"\\/<>:|?]/g, '-').trim();
}

function yamlEscape(value: string): string {
	if (value === '') return '""';
	// double-quote and escape backslashes and double quotes
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

export class ReadingDataManager {
	private plugin: WatchLogPlugin;
	private data: ReadingData;
	private changeListeners: Array<() => void> = [];
	private historyManager: HistoryManager | null = null;

	constructor(plugin: WatchLogPlugin) {
		this.plugin = plugin;
		this.data = this.emptyData();
	}

	setHistoryManager(hm: HistoryManager): void {
		this.historyManager = hm;
	}

	private emptyData(): ReadingData {
		return {
			books: [],
			manga: [],
			bookColumns: [],
			mangaColumns: [],
			settings: { ...DEFAULT_READING_SETTINGS },
		};
	}

	/** The single saveData object (owned by DataManager) that holds reading data. */
	private get master() {
		return this.plugin.dataManager.getData();
	}

	/**
	 * Reads the reading dataset from the shared `data.reading` key (in memory, not a file), normalizes
	 * it, and binds `master.reading` to our canonical reference so later mutations reach the object
	 * DataManager persists.
	 */
	private bindFromMaster(): void {
		const parsed = this.master.reading as Partial<ReadingData> | undefined;
		if (parsed && typeof parsed === 'object') {
			this.data = {
				books: Array.isArray(parsed.books) ? parsed.books : [],
				manga: Array.isArray(parsed.manga) ? parsed.manga : [],
				bookColumns: Array.isArray(parsed.bookColumns) ? parsed.bookColumns : [],
				mangaColumns: Array.isArray(parsed.mangaColumns) ? parsed.mangaColumns : [],
				settings: { ...DEFAULT_READING_SETTINGS, ...(parsed.settings ?? {}) },
			};
		} else {
			this.data = this.emptyData();
		}
		this.master.reading = this.data;
	}

	async load(): Promise<void> {
		this.bindFromMaster();
		const changed = this.migrate();
		if (changed) {
			await this.saveOnly();
		}
		// additive reconcile: every future-dated item gets an Upcoming entry. Never removes, so
		// manually-scheduled recurring entries survive reloads.
		const dm = this.plugin.dataManager;
		if (dm) {
			for (const b of this.data.books) if (isReleaseDateFuture(b.releaseDate)) await dm.autoAddReadingToUpcoming(b, 'book');
			for (const m of this.data.manga) if (isReleaseDateFuture(m.releaseDate)) await dm.autoAddReadingToUpcoming(m, 'manga');
		}
	}

	/** Ensures every record has the full set of fields with sensible defaults. */
	private migrate(): boolean {
		let changed = false;

		// "On Hold" was removed; never leave it as the default for new entries
		if ((this.data.settings.defaultStatus as string) === 'On Hold') {
			this.data.settings.defaultStatus = 'Plan to Read';
			changed = true;
		}

		// status colours became user-editable (Settings → Customize → Reading) — seed missing keys from
		// the shipped defaults so the picker always has a concrete value; names stay fixed
		if (!this.data.settings.statusColors || typeof this.data.settings.statusColors !== 'object') {
			this.data.settings.statusColors = { ...DEFAULT_READING_STATUS_COLORS };
			changed = true;
		} else {
			for (const status of READING_STATUSES) {
				if (typeof this.data.settings.statusColors[status] !== 'string') {
					this.data.settings.statusColors[status] = DEFAULT_READING_STATUS_COLORS[status];
					changed = true;
				}
			}
		}

		for (const b of this.data.books) {
			if (typeof b.author !== 'string') { b.author = ''; changed = true; }
			if (typeof b.favorite !== 'boolean') { b.favorite = false; changed = true; }
			if (typeof b.rating !== 'number') { b.rating = 0; changed = true; }
			if (typeof b.pagesRead !== 'number') { b.pagesRead = 0; changed = true; }
			if (typeof b.totalPages !== 'number') { b.totalPages = 0; changed = true; }
			// pages/words tracking: every pre-existing book was tracked in pages
			if (b.progressUnit !== 'pages' && b.progressUnit !== 'words') { b.progressUnit = 'pages'; changed = true; }
			if (typeof b.wordsRead !== 'number') { b.wordsRead = 0; changed = true; }
			if (typeof b.totalWords !== 'number') { b.totalWords = 0; changed = true; }
			if (typeof b.chaptersRead !== 'number') { b.chaptersRead = 0; changed = true; }
			if (typeof b.totalChapters !== 'number') { b.totalChapters = 0; changed = true; }
			if (typeof b.coverUrl !== 'string') { b.coverUrl = ''; changed = true; }
			// books now use Google Books volume ids; pre-existing entries keep openLibraryId and get an empty
			// googleBooksId
			if (typeof b.googleBooksId !== 'string') { b.googleBooksId = ''; changed = true; }
			if (typeof b.vaultPage !== 'string') { b.vaultPage = ''; changed = true; }
			if (b.dateStarted === undefined) { b.dateStarted = null; changed = true; }
			if (b.dateFinished === undefined) { b.dateFinished = null; changed = true; }
			if (b.releaseDate === undefined) { b.releaseDate = null; changed = true; }
			// "On Hold" was removed; migrate any legacy value to "Plan to Read"
			if ((b.status as string) === 'On Hold') { b.status = 'Plan to Read'; changed = true; }
			if (!b.dateAdded) { b.dateAdded = new Date().toISOString(); changed = true; }
			if (!b.dateModified) { b.dateModified = b.dateAdded; changed = true; }
			if (!b.customFields || typeof b.customFields !== 'object') {
				b.customFields = {};
				changed = true;
			}
		}

		for (const m of this.data.manga) {
			if (typeof m.author !== 'string') { m.author = ''; changed = true; }
			if (typeof m.favorite !== 'boolean') { m.favorite = false; changed = true; }
			if (typeof m.rating !== 'number') { m.rating = 0; changed = true; }
			if (typeof m.chaptersRead !== 'number') { m.chaptersRead = 0; changed = true; }
			if (typeof m.totalChapters !== 'number') { m.totalChapters = 0; changed = true; }
			if (typeof m.volumesRead !== 'number') { m.volumesRead = 0; changed = true; }
			if (typeof m.totalVolumes !== 'number') { m.totalVolumes = 0; changed = true; }
			if (typeof m.coverUrl !== 'string') { m.coverUrl = ''; changed = true; }
			if (typeof m.malId !== 'string') { m.malId = ''; changed = true; }
			if (typeof m.vaultPage !== 'string') { m.vaultPage = ''; changed = true; }
			if (m.dateStarted === undefined) { m.dateStarted = null; changed = true; }
			if (m.dateFinished === undefined) { m.dateFinished = null; changed = true; }
			if (m.releaseDate === undefined) { m.releaseDate = null; changed = true; }
			// "On Hold" was removed; migrate any legacy value to "Plan to Read"
			if ((m.status as string) === 'On Hold') { m.status = 'Plan to Read'; changed = true; }
			if (!m.dateAdded) { m.dateAdded = new Date().toISOString(); changed = true; }
			if (!m.dateModified) { m.dateModified = m.dateAdded; changed = true; }
			if (!m.customFields || typeof m.customFields !== 'object') {
				m.customFields = {};
				changed = true;
			}
		}

		for (const c of this.data.bookColumns) {
			if (!Array.isArray(c.options)) { c.options = []; changed = true; }
			if (!c.color) { c.color = '#5F5E5A'; changed = true; }
		}
		for (const c of this.data.mangaColumns) {
			if (!Array.isArray(c.options)) { c.options = []; changed = true; }
			if (!c.color) { c.color = '#5F5E5A'; changed = true; }
		}

		// reconcile the auto "To be released" status against each release date
		for (const b of this.data.books) if (this.applyReleaseStatus(b)) changed = true;
		for (const m of this.data.manga) if (this.applyReleaseStatus(m)) changed = true;

		return changed;
	}

	/**
	 * Forces "To be released" when the release date is in the future and reverts to "Plan to Read"
	 * once it passes or is cleared. Returns true if the status changed.
	 */
	private applyReleaseStatus(item: Book | Manga): boolean {
		const future = isReleaseDateFuture(item.releaseDate);
		if (future) {
			if (item.status !== 'To be released') {
				item.status = 'To be released';
				return true;
			}
		} else if (item.status === 'To be released') {
			item.status = 'Plan to Read';
			return true;
		}
		return false;
	}

	/**
	 * Mirrors the watchlist auto-add: a reading item with a future release date joins the shared
	 * Upcoming tracker and leaves once the date passes or is cleared.
	 */
	private async syncUpcoming(item: Book | Manga, kind: ReadingKind): Promise<void> {
		const dm = this.plugin.dataManager;
		if (!dm) return;
		if (isReleaseDateFuture(item.releaseDate)) {
			await dm.autoAddReadingToUpcoming(item, kind);
		} else {
			await dm.removeReadingAirtimeEntries(item.id);
		}
	}

	getData(): ReadingData {
		return this.data;
	}

	getSettings(): ReadingSettings {
		return this.data.settings;
	}

	async updateSettings(patch: Partial<ReadingSettings>): Promise<void> {
		this.data.settings = { ...this.data.settings, ...patch };
		await this.save();
	}

	/**
	 * Persist without notifying — for state the rendering tab wrote itself (the rows layout): it
	 * re-renders on its own.
	 */
	persistQuiet(): void {
		void this.saveOnly();
	}

	/**
	 * Silent favorite toggle: data.json + note frontmatter, but deliberately no dateModified stamp — a
	 * favorite is not a content edit and must not bubble the item up recently-modified orderings.
	 */
	async setFavorite(kind: ReadingKind, id: string, favorite: boolean): Promise<void> {
		const item = kind === 'book' ? this.getBook(id) : this.getManga(id);
		if (!item) return;
		item.favorite = favorite;
		// stamp drives the Favorites shelf order (newest first); cleared on unfavorite
		if (favorite) item.dateFavorited = new Date().toISOString();
		else delete item.dateFavorited;
		await this.save();
		try { await this.rewriteFrontmatterIfExists(kind, item); } catch (e) {
			console.warn('[WL] setFavorite frontmatter rewrite failed:', e);
		}
	}

	// Persistence

	private async saveOnly(): Promise<void> {
		try {
			// keep the master reference pointed at our current data (an external sync reload may have replaced
			// the master object), then persist all of data.json
			this.master.reading = this.data;
			await this.plugin.dataManager.persist();
		} catch (e) {
			console.warn('[WL] ReadingDataManager.save failed:', e);
		}
	}

	/** Re-bind to a freshly synced data.json (DataManager's 'raw' watcher), migrate, refresh the tab. */
	async adoptExternalChange(): Promise<void> {
		this.bindFromMaster();
		const changed = this.migrate();
		if (changed) await this.saveOnly();
		this.notifyListeners();
	}

	private async save(): Promise<void> {
		await this.saveOnly();
		this.notifyListeners();
	}

	// Listeners

	onChange(listener: () => void): void {
		this.changeListeners.push(listener);
	}

	offChange(listener: () => void): void {
		this.changeListeners = this.changeListeners.filter((l) => l !== listener);
	}

	notifyChange(): void {
		this.notifyListeners();
	}

	async saveAndNotify(): Promise<void> {
		await this.saveOnly();
		this.notifyListeners();
	}

	/**
	 * Overwrite the entire reading dataset from a backup, then reload through load() (migration +
	 * Upcoming reconcile) and notify listeners.
	 */
	async restore(data: ReadingData): Promise<void> {
		this.master.reading = data;
		await this.plugin.dataManager.persist();
		await this.load();
		this.notifyListeners();
	}

	private notifyListeners(): void {
		for (const listener of this.changeListeners) {
			listener();
		}
	}

	private coverSaveTimer: number | null = null;
	private readonly COVER_SAVE_DEBOUNCE_MS = 5000;

	/**
	 * Silent cover URL update for the lazy Cards re-fetch: memory now, debounced disk save (5s), no
	 * notify — the card swaps its own <img>, so the grid is not rebuilt and scroll survives.
	 */
	updateCoverUrl(kind: ReadingKind, id: string, url: string): void {
		const item = kind === 'book' ? this.getBook(id) : this.getManga(id);
		if (!item) return;
		item.coverUrl = url;
		if (this.coverSaveTimer !== null) return;
		this.coverSaveTimer = window.setTimeout(() => {
			this.coverSaveTimer = null;
			void this.saveOnly();
		}, this.COVER_SAVE_DEBOUNCE_MS);
	}

	/**
	 * Like updateCoverUrl, but also persists a source ID just resolved by a title-based lookup (for
	 * CSV-imported entries that arrived with neither cover nor ID). Stores googleBooksId / malId so
	 * later loads take the cheap ID path. Same silent, debounced contract.
	 */
	updateCoverAndSource(kind: ReadingKind, id: string, url: string, sourceId: string): void {
		const item = kind === 'book' ? this.getBook(id) : this.getManga(id);
		if (!item) return;
		item.coverUrl = url;
		if (kind === 'book') (item as Book).googleBooksId = sourceId;
		else (item as Manga).malId = sourceId;
		if (this.coverSaveTimer !== null) return;
		this.coverSaveTimer = window.setTimeout(() => {
			this.coverSaveTimer = null;
			void this.saveOnly();
		}, this.COVER_SAVE_DEBOUNCE_MS);
	}

	/** Flush a pending debounced cover save now (e.g. on plugin unload). */
	flushCoverSave(): void {
		if (this.coverSaveTimer !== null) {
			window.clearTimeout(this.coverSaveTimer);
			this.coverSaveTimer = null;
			void this.saveOnly();
		}
	}

	// Books CRUD

	getBooks(): Book[] {
		return this.data.books;
	}

	getBook(id: string): Book | undefined {
		return this.data.books.find((b) => b.id === id);
	}

	async addBook(book: Book): Promise<void> {
		this.applyReleaseStatus(book);
		this.data.books.push(book);
		await this.save();
		await this.syncUpcoming(book, 'book');
		try { await this.writeReadingNote('book', book); } catch (e) { console.warn('[WL] writeReadingNote failed:', e); }
		void this.historyManager?.log(
			`${book.title} (Book) was added`,
			{ source: 'Reading', action: 'added', titleName: book.title },
		);
	}

	async addBookSilent(book: Book): Promise<void> {
		this.applyReleaseStatus(book);
		this.data.books.push(book);
		await this.saveOnly();
	}

	async updateBook(updated: Book): Promise<void> {
		updated.dateModified = new Date().toISOString();
		this.applyReleaseStatus(updated);
		const idx = this.data.books.findIndex((b) => b.id === updated.id);
		if (idx >= 0) {
			const old = this.data.books[idx]!;
			if (old.status !== updated.status) {
				const act = updated.status === 'Completed' ? 'completed' as const : 'status' as const;
				// mirror the watch behavior: stamp today's finish date on the transition to Completed
				if (updated.status === 'Completed' && this.plugin.settings.setFinishDateAutomatically && !updated.dateFinished) {
					updated.dateFinished = todayIso();
				}
				void this.historyManager?.log(
					`${updated.title} (Book) status changed to ${updated.status}`,
					{ source: 'Reading', action: act, titleName: updated.title },
				);
			}
			if (old.rating !== updated.rating) {
				void this.historyManager?.log(
					`${updated.title} (Book) Rating → ${updated.rating}/5`,
					{ source: 'Reading', action: 'rating', titleName: updated.title },
				);
			}
			this.data.books[idx] = updated;
			await this.save();
			// reconcile Upcoming only when the release date actually changed, so rating/status/progress edits
			// never disturb a manual recurring entry
			if (old.releaseDate !== updated.releaseDate) await this.syncUpcoming(updated, 'book');
			try { await this.writeReadingNote('book', updated); } catch (e) { console.warn('[WL] writeReadingNote failed:', e); }
		}
	}

	updateBookSilent(updated: Book): void {
		updated.dateModified = new Date().toISOString();
		this.applyReleaseStatus(updated);
		const idx = this.data.books.findIndex((b) => b.id === updated.id);
		if (idx >= 0) {
			this.data.books[idx] = updated;
		}
	}

	async removeBook(id: string): Promise<void> {
		const book = this.getBook(id);
		this.data.books = this.data.books.filter((b) => b.id !== id);
		await this.save();
		await this.plugin.dataManager?.removeReadingAirtimeEntries(id);
		if (book) {
			void this.historyManager?.log(
				`${book.title} (Book) was deleted`,
				{ source: 'Reading', action: 'deleted', titleName: book.title },
			);
			try { await this.deleteReadingNote('book', book); } catch (e) { console.warn('[WL] deleteReadingNote failed:', e); }
		}
	}

	/**
	 * Insert many books in one shot: single persist, then per-item Upcoming reconcile and note write
	 * (mirrors addTitleBatch). Used by the chunked CSV import.
	 */
	async addBookBatch(books: Book[]): Promise<void> {
		for (const book of books) {
			this.applyReleaseStatus(book);
			this.data.books.push(book);
		}
		await this.saveOnly();
		for (const book of books) {
			await this.syncUpcoming(book, 'book');
			try { await this.writeReadingNote('book', book); } catch (e) { console.warn('[WL] writeReadingNote failed:', e); }
			void this.historyManager?.log(
				`${book.title} (Book) was added`,
				{ source: 'Reading', action: 'added', titleName: book.title },
			);
		}
	}

	generateBookId(title: string): string {
		const base = slugify(title) || 'book';
		const existing = new Set(this.data.books.map((b) => b.id));
		if (!existing.has(base)) return base;
		let counter = 2;
		while (existing.has(`${base}-${counter}`)) counter++;
		return `${base}-${counter}`;
	}

	// Manga CRUD

	getMangaList(): Manga[] {
		return this.data.manga;
	}

	getManga(id: string): Manga | undefined {
		return this.data.manga.find((m) => m.id === id);
	}

	async addManga(manga: Manga): Promise<void> {
		this.applyReleaseStatus(manga);
		this.data.manga.push(manga);
		await this.save();
		await this.syncUpcoming(manga, 'manga');
		try { await this.writeReadingNote('manga', manga); } catch (e) { console.warn('[WL] writeReadingNote failed:', e); }
		void this.historyManager?.log(
			`${manga.title} (Manga) was added`,
			{ source: 'Reading', action: 'added', titleName: manga.title },
		);
	}

	async addMangaSilent(manga: Manga): Promise<void> {
		this.applyReleaseStatus(manga);
		this.data.manga.push(manga);
		await this.saveOnly();
	}

	async updateManga(updated: Manga): Promise<void> {
		updated.dateModified = new Date().toISOString();
		this.applyReleaseStatus(updated);
		const idx = this.data.manga.findIndex((m) => m.id === updated.id);
		if (idx >= 0) {
			const old = this.data.manga[idx]!;
			if (old.status !== updated.status) {
				const act = updated.status === 'Completed' ? 'completed' as const : 'status' as const;
				// mirror the watch behavior: stamp today's finish date on the transition to Completed
				if (updated.status === 'Completed' && this.plugin.settings.setFinishDateAutomatically && !updated.dateFinished) {
					updated.dateFinished = todayIso();
				}
				void this.historyManager?.log(
					`${updated.title} (Manga) status changed to ${updated.status}`,
					{ source: 'Reading', action: act, titleName: updated.title },
				);
			}
			if (old.rating !== updated.rating) {
				void this.historyManager?.log(
					`${updated.title} (Manga) Rating → ${updated.rating}/5`,
					{ source: 'Reading', action: 'rating', titleName: updated.title },
				);
			}
			this.data.manga[idx] = updated;
			await this.save();
			// reconcile Upcoming only when the release date actually changed, so rating/status/progress edits
			// never disturb a manual recurring entry
			if (old.releaseDate !== updated.releaseDate) await this.syncUpcoming(updated, 'manga');
			try { await this.writeReadingNote('manga', updated); } catch (e) { console.warn('[WL] writeReadingNote failed:', e); }
		}
	}

	updateMangaSilent(updated: Manga): void {
		updated.dateModified = new Date().toISOString();
		this.applyReleaseStatus(updated);
		const idx = this.data.manga.findIndex((m) => m.id === updated.id);
		if (idx >= 0) {
			this.data.manga[idx] = updated;
		}
	}

	async removeManga(id: string): Promise<void> {
		const manga = this.getManga(id);
		this.data.manga = this.data.manga.filter((m) => m.id !== id);
		await this.save();
		await this.plugin.dataManager?.removeReadingAirtimeEntries(id);
		if (manga) {
			void this.historyManager?.log(
				`${manga.title} (Manga) was deleted`,
				{ source: 'Reading', action: 'deleted', titleName: manga.title },
			);
			try { await this.deleteReadingNote('manga', manga); } catch (e) { console.warn('[WL] deleteReadingNote failed:', e); }
		}
	}

	async removeBooksBatch(ids: string[]): Promise<void> {
		const CHUNK = 10;
		const toDelete: Book[] = [];
		for (const id of ids) {
			const book = this.getBook(id);
			if (book) toDelete.push(book);
		}
		this.data.books = this.data.books.filter((b) => !ids.includes(b.id));
		await this.save();
		for (const id of ids) await this.plugin.dataManager?.removeReadingAirtimeEntries(id);
		for (const book of toDelete) {
			void this.historyManager?.log(
				`${book.title} (Book) was deleted`,
				{ source: 'Reading', action: 'deleted', titleName: book.title },
			);
		}
		for (let i = 0; i < toDelete.length; i += CHUNK) {
			const chunk = toDelete.slice(i, i + CHUNK);
			await Promise.all(chunk.map((b) => this.deleteReadingNote('book', b).catch(() => {})));
		}
	}

	async removeMangaBatch(ids: string[]): Promise<void> {
		const CHUNK = 10;
		const toDelete: Manga[] = [];
		for (const id of ids) {
			const manga = this.getManga(id);
			if (manga) toDelete.push(manga);
		}
		this.data.manga = this.data.manga.filter((m) => !ids.includes(m.id));
		await this.save();
		for (const id of ids) await this.plugin.dataManager?.removeReadingAirtimeEntries(id);
		for (const manga of toDelete) {
			void this.historyManager?.log(
				`${manga.title} (Manga) was deleted`,
				{ source: 'Reading', action: 'deleted', titleName: manga.title },
			);
		}
		for (let i = 0; i < toDelete.length; i += CHUNK) {
			const chunk = toDelete.slice(i, i + CHUNK);
			await Promise.all(chunk.map((m) => this.deleteReadingNote('manga', m).catch(() => {})));
		}
	}

	/**
	 * Insert many manga in one shot: single persist, then per-item Upcoming reconcile and note write.
	 * Used by the chunked CSV import.
	 */
	async addMangaBatch(mangaList: Manga[]): Promise<void> {
		for (const manga of mangaList) {
			this.applyReleaseStatus(manga);
			this.data.manga.push(manga);
		}
		await this.saveOnly();
		for (const manga of mangaList) {
			await this.syncUpcoming(manga, 'manga');
			try { await this.writeReadingNote('manga', manga); } catch (e) { console.warn('[WL] writeReadingNote failed:', e); }
			void this.historyManager?.log(
				`${manga.title} (Manga) was added`,
				{ source: 'Reading', action: 'added', titleName: manga.title },
			);
		}
	}

	generateMangaId(title: string): string {
		const base = slugify(title) || 'manga';
		const existing = new Set(this.data.manga.map((m) => m.id));
		if (!existing.has(base)) return base;
		let counter = 2;
		while (existing.has(`${base}-${counter}`)) counter++;
		return `${base}-${counter}`;
	}

	// Custom columns CRUD

	getBookColumns(): ReadingCustomColumn[] {
		return this.data.bookColumns;
	}

	getMangaColumns(): ReadingCustomColumn[] {
		return this.data.mangaColumns;
	}

	private columnsFor(kind: 'book' | 'manga'): ReadingCustomColumn[] {
		return kind === 'book' ? this.data.bookColumns : this.data.mangaColumns;
	}

	async addColumn(kind: 'book' | 'manga', column: ReadingCustomColumn): Promise<void> {
		this.columnsFor(kind).push(column);
		await this.save();
	}

	async updateColumn(kind: 'book' | 'manga', updated: ReadingCustomColumn): Promise<void> {
		const cols = this.columnsFor(kind);
		const idx = cols.findIndex((c) => c.id === updated.id);
		if (idx >= 0) {
			cols[idx] = updated;
			await this.save();
		}
	}

	async removeColumn(kind: 'book' | 'manga', id: string): Promise<void> {
		if (kind === 'book') {
			this.data.bookColumns = this.data.bookColumns.filter((c) => c.id !== id);
			for (const b of this.data.books) {
				if (b.customFields && Object.prototype.hasOwnProperty.call(b.customFields, id)) {
					delete b.customFields[id];
				}
			}
		} else {
			this.data.mangaColumns = this.data.mangaColumns.filter((c) => c.id !== id);
			for (const m of this.data.manga) {
				if (m.customFields && Object.prototype.hasOwnProperty.call(m.customFields, id)) {
					delete m.customFields[id];
				}
			}
		}
		await this.save();
	}

	generateColumnId(kind: 'book' | 'manga', name: string): string {
		const base = `col-${slugify(name) || 'field'}`;
		const existing = new Set(this.columnsFor(kind).map((c) => c.id));
		if (!existing.has(base)) return base;
		let counter = 2;
		while (existing.has(`${base}-${counter}`)) counter++;
		return `${base}-${counter}`;
	}

	async reorderColumns(kind: ReadingKind, fromIdx: number, toIdx: number): Promise<void> {
		const cols = this.columnsFor(kind);
		if (fromIdx < 0 || fromIdx >= cols.length || toIdx < 0 || toIdx >= cols.length) return;
		const [moved] = cols.splice(fromIdx, 1);
		if (!moved) return;
		cols.splice(toIdx, 0, moved);
		await this.save();
	}

	// Custom field values

	async setCustomField(
		kind: ReadingKind,
		itemId: string,
		columnId: string,
		value: string | number | null,
	): Promise<void> {
		const item = kind === 'book' ? this.getBook(itemId) : this.getManga(itemId);
		if (!item) return;
		if (!item.customFields) item.customFields = {};
		if (value === null || value === '') {
			delete item.customFields[columnId];
		} else {
			item.customFields[columnId] = value;
		}
		item.dateModified = new Date().toISOString();
		await this.save();
	}

	// Reading note files

	private kindFolder(kind: ReadingKind): string {
		const root = this.data.settings.defaultFolder || 'WatchLog/Reading';
		return normalizePath(`${root}/${kind === 'book' ? 'Books' : 'Manga'}`);
	}

	noteFilePath(kind: ReadingKind, title: string): string {
		const safe = sanitizeFilename(title) || (kind === 'book' ? 'book' : 'manga');
		return normalizePath(`${this.kindFolder(kind)}/${safe}.md`);
	}

	private async ensureFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (!this.plugin.app.vault.getAbstractFileByPath(normalized)) {
			try {
				await this.plugin.app.vault.createFolder(normalized);
			} catch {
				// folder may already exist
			}
		}
	}

	private buildFrontmatter(kind: ReadingKind, item: Book | Manga): string {
		const lines: string[] = ['---'];
		lines.push(`title: ${yamlEscape(sanitizeFilename(item.title))}`);
		lines.push(`author: ${yamlEscape(item.author ?? '')}`);
		lines.push(`status: ${yamlEscape(item.status)}`);
		if (item.favorite) lines.push(`favorite: true`);
		lines.push(`rating: ${item.rating | 0}`);
		if (kind === 'book') {
			const b = item as Book;
			lines.push(`pagesRead: ${b.pagesRead | 0}`);
			lines.push(`totalPages: ${b.totalPages | 0}`);
			// words are an opt-in unit: emitted only when they carry meaning, so a pages-tracked note keeps
			// exactly the frontmatter it always had
			if (b.progressUnit === 'words' || (b.wordsRead | 0) > 0 || (b.totalWords | 0) > 0) {
				lines.push(`progressUnit: ${b.progressUnit === 'words' ? 'words' : 'pages'}`);
				lines.push(`wordsRead: ${b.wordsRead | 0}`);
				lines.push(`totalWords: ${b.totalWords | 0}`);
			}
			lines.push(`chaptersRead: ${b.chaptersRead | 0}`);
			lines.push(`totalChapters: ${b.totalChapters | 0}`);
			if (b.googleBooksId) lines.push(`googleBooksId: ${yamlEscape(b.googleBooksId)}`);
		} else {
			const m = item as Manga;
			lines.push(`chaptersRead: ${m.chaptersRead | 0}`);
			lines.push(`totalChapters: ${m.totalChapters | 0}`);
			lines.push(`volumesRead: ${m.volumesRead | 0}`);
			lines.push(`totalVolumes: ${m.totalVolumes | 0}`);
			if (m.malId) lines.push(`malId: ${yamlEscape(m.malId)}`);
		}
		lines.push(`dateStarted: ${item.dateStarted ?? 'null'}`);
		lines.push(`dateFinished: ${item.dateFinished ?? 'null'}`);
		lines.push(`releaseDate: ${item.releaseDate ?? 'null'}`);
		lines.push(`dateAdded: ${yamlEscape(item.dateAdded)}`);
		lines.push(`dateModified: ${yamlEscape(item.dateModified)}`);
		if (item.coverUrl) lines.push(`coverUrl: ${yamlEscape(item.coverUrl)}`);
		if (item.externalLink) lines.push(`externalLink: ${yamlEscape(item.externalLink)}`);
		lines.push(`type: ${kind === 'book' ? 'book' : 'manga'}`);
		lines.push('---');
		return lines.join('\n');
	}

	private buildInitialNoteContent(kind: ReadingKind, item: Book | Manga): string {
		return `${this.buildFrontmatter(kind, item)}\n\n## Notes\n\n\n## Quotes\n`;
	}

	private rebuildWithFrontmatter(existing: string, frontmatter: string): string {
		const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
		if (fmMatch) {
			return frontmatter + '\n' + existing.slice(fmMatch[0].length);
		}
		// no frontmatter found — prepend it
		return frontmatter + '\n\n' + existing;
	}

	private lastNotePathById = new Map<string, string>();

	/** Writes (creates or updates) the note file. Preserves the Notes/Quotes body when it exists. */
	async writeReadingNote(kind: ReadingKind, item: Book | Manga): Promise<string> {
		await this.ensureFolder(this.kindFolder(kind));
		const filePath = this.noteFilePath(kind, item.title);
		const frontmatter = this.buildFrontmatter(kind, item);

		// handle rename: trash the previous file if the path changed
		const prevKey = `${kind}:${item.id}`;
		const previousPath = this.lastNotePathById.get(prevKey);
		if (previousPath && previousPath !== filePath) {
			const oldFile = this.plugin.app.vault.getAbstractFileByPath(previousPath);
			if (oldFile instanceof TFile) {
				try {
					await this.plugin.app.fileManager.trashFile(oldFile);
				} catch {
					// best-effort
				}
			}
		}

		const existing = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			const current = await this.plugin.app.vault.read(existing);
			const updated = this.rebuildWithFrontmatter(current, frontmatter);
			if (updated !== current) {
				await this.plugin.app.vault.modify(existing, updated);
			}
		} else {
			await this.plugin.app.vault.create(filePath, this.buildInitialNoteContent(kind, item));
		}
		this.lastNotePathById.set(prevKey, filePath);
		return filePath;
	}

	async ensureReadingNote(kind: ReadingKind, item: Book | Manga): Promise<string> {
		const filePath = this.noteFilePath(kind, item.title);
		const existing = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			this.lastNotePathById.set(`${kind}:${item.id}`, filePath);
			return filePath;
		}
		return this.writeReadingNote(kind, item);
	}

	/** Creates the note file only if missing; true when one was created. */
	async createReadingNoteIfMissing(kind: ReadingKind, item: Book | Manga): Promise<boolean> {
		const filePath = this.noteFilePath(kind, item.title);
		if (this.plugin.app.vault.getAbstractFileByPath(filePath) instanceof TFile) return false;
		await this.writeReadingNote(kind, item);
		return true;
	}

	/**
	 * Rewrites ONLY the frontmatter of an existing reading note, body verbatim (`## Notes` /
	 * `## Quotes`). Does NOT create the file when missing — returns false. Used by the bulk "Rewrite
	 * all frontmatter" action.
	 */
	async rewriteFrontmatterIfExists(kind: ReadingKind, item: Book | Manga): Promise<boolean> {
		const filePath = this.noteFilePath(kind, item.title);
		const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return false;
		const current = await this.plugin.app.vault.read(file);
		const updated = this.rebuildWithFrontmatter(current, this.buildFrontmatter(kind, item));
		if (updated !== current) {
			await this.plugin.app.vault.modify(file, updated);
		}
		this.lastNotePathById.set(`${kind}:${item.id}`, filePath);
		return true;
	}

	async readReadingNote(kind: ReadingKind, item: Book | Manga): Promise<string | null> {
		const filePath = this.noteFilePath(kind, item.title);
		const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return null;
		return this.plugin.app.vault.read(file);
	}

	/** Appends a `> [!quote]` callout to the ## Quotes section, creating it if missing. */
	async appendQuote(
		kind: ReadingKind,
		item: Book | Manga,
		text: string,
		reference: string,
	): Promise<void> {
		await this.ensureReadingNote(kind, item);
		const filePath = this.noteFilePath(kind, item.title);
		const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		const current = await this.plugin.app.vault.read(file);
		const refTrim = reference.trim();
		const titlePart = refTrim ? ` ${refTrim}` : '';
		const bodyLines = text
			.split(/\r?\n/)
			.map((l) => `> ${l}`)
			.join('\n');
		const callout = `> [!quote]${titlePart}\n${bodyLines}`;

		let updated: string;
		const quotesMatch = current.match(/(^|\n)## Quotes[ \t]*\r?\n/);
		if (quotesMatch && quotesMatch.index !== undefined) {
			const insertAt = quotesMatch.index + quotesMatch[0].length;
			const before = current.slice(0, insertAt);
			const after = current.slice(insertAt);
			const needsLeadingNl = before.length > 0 && !before.endsWith('\n\n');
			updated = `${before}${needsLeadingNl ? '\n' : ''}${callout}\n${after.startsWith('\n') ? '' : '\n'}${after}`;
		} else {
			const sep = current.endsWith('\n') ? '' : '\n';
			updated = `${current}${sep}\n## Quotes\n\n${callout}\n`;
		}

		await this.plugin.app.vault.modify(file, updated);
	}

	async deleteReadingNote(kind: ReadingKind, item: Book | Manga): Promise<void> {
		const filePath = this.noteFilePath(kind, item.title);
		const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			try {
				await this.plugin.app.fileManager.trashFile(file);
			} catch {
				// best-effort
			}
		}
		this.lastNotePathById.delete(`${kind}:${item.id}`);
	}
}
