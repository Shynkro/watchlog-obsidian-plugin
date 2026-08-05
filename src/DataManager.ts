import { App, TFile, normalizePath } from 'obsidian';
import type WatchLogPlugin from './main';
import type { WatchLogData, WatchLogTitle, WatchLogGroup, AirtimeEntry, MaybeTitle, RecommendedDaily, SavedFilterPreset, WatchLogPluginSettings, Book, Manga, Game } from './types';
import type { HistoryManager } from './HistoryManager';
import { formatHistoryDate } from './HistoryManager';
import { getDisplayPoster, getDisplayTrailer, getTitleCredits, pruneManualCredits, normalizeManualCredits, isReleaseDateFuture, todayIso } from './types';
import type { CreditsField } from './types';

function isValidWatchLogData(data: unknown): data is WatchLogData {
	return (
		data !== null &&
		typeof data === 'object' &&
		Array.isArray((data as { titles?: unknown }).titles)
	);
}

export class DataManager {
	private plugin: WatchLogPlugin;
	private app: App;
	private data: WatchLogData;
	private changeListeners: Array<() => void> = [];
	private historyManager: HistoryManager | null = null;
	// debounced save for high-frequency edits (rapid episode clicks): memory now, disk coalesced
	private pendingSaveTimer: number | null = null;
	private pendingMdTitleIds: Set<string> = new Set();
	private readonly EPISODE_SAVE_DEBOUNCE_MS = 500;
	// last self-initiated saveOnly — the 'raw' watcher uses it to ignore the echo of our own
	// writes, which would otherwise reload data.json and notify on every debounced save
	private lastSelfSaveTime = 0;
	private readonly SELF_SAVE_ECHO_WINDOW_MS = 2000;

	// debounced batched poster saves: memory now, disk ~every 5s
	private posterSaveTimer: number | null = null;
	private readonly POSTER_SAVE_DEBOUNCE_MS = 5000;

	// generic queued-save debounce for cross-cutting saves (settings, drafts, lists)
	private queuedSaveTimer: number | null = null;
	private readonly QUEUED_SAVE_DEBOUNCE_MS = 100;

	setHistoryManager(hm: HistoryManager): void {
		this.historyManager = hm;
	}

	constructor(plugin: WatchLogPlugin) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.data = { titles: [], groups: [], settings: {} };
	}

	async load(): Promise<void> {
		const raw: unknown = await this.plugin.loadData();
		this.data = isValidWatchLogData(raw)
			? raw
			: { titles: [], groups: [], settings: {} };
		const changed = this.migrateData();
		if (changed) {
			await this.saveOnly();
		}
	}

	private migrateData(): boolean {
		let changed = false;
		if (!Array.isArray(this.data.titles)) {
			this.data.titles = [];
			changed = true;
		}
		if (!Array.isArray((this.data as unknown as Record<string, unknown>)['groups'])) {
			this.data.groups = [];
			changed = true;
		}

		if (!Array.isArray(this.data.airtime)) {
			this.data.airtime = [];
			changed = true;
		}

		for (const title of this.data.titles) {
			if (!title.dateAdded) {
				title.dateAdded = new Date().toISOString();
				changed = true;
			} else if (!title.dateAdded.includes('T')) {
				title.dateAdded = new Date(title.dateAdded).toISOString();
				changed = true;
			}

			if (!title.dateModified) {
				const raw = title as unknown as Record<string, unknown>;
				const lastInteracted = raw['lastInteracted'];
				if (typeof lastInteracted === 'string' && lastInteracted) {
					title.dateModified = lastInteracted;
				} else {
					title.dateModified = title.dateAdded;
				}
				changed = true;
			}

			for (const season of (title.seasons ?? [])) {
				if (!Array.isArray(season.skippedEpisodes)) {
					season.skippedEpisodes = [];
					changed = true;
				}
			}

			if (title.posterUrl === undefined) { title.posterUrl = ''; changed = true; }
			if (title.manualPosterUrl === undefined) { title.manualPosterUrl = ''; changed = true; }
			if (title.trailerUrl === undefined) { title.trailerUrl = ''; changed = true; }
			if (title.manualTrailerUrl === undefined) { title.manualTrailerUrl = ''; changed = true; }
			if (title.anilistId === undefined) { title.anilistId = 0; changed = true; }
			if (title.communityRating === undefined) { title.communityRating = 0; changed = true; }
			if (title.communityVotes === undefined) { title.communityVotes = 0; changed = true; }
			if (title.communitySource === undefined) { title.communitySource = ''; changed = true; }
			if (title.communityRatingLastFetched === undefined) { title.communityRatingLastFetched = ''; changed = true; }
			if (title.favorite === undefined) { title.favorite = false; changed = true; }
			// every stored tmdbId predates tmdbMediaType and came from the Collections path,
			// which only ever wrote movie ids
			if (title.tmdbId && title.tmdbMediaType === undefined) {
				title.tmdbMediaType = 'movie';
				changed = true;
			}
		}

		if (!this.data.posterRetryDone) {
			for (const title of this.data.titles) {
				if (title.posterUrl === 'none') {
					title.posterUrl = '';
				}
			}
			this.data.posterRetryDone = true;
			changed = true;
		}

		if (!this.data.recommendedDaily) {
			this.data.recommendedDaily = { date: '', ids: [] };
			changed = true;
		}
		return changed;
	}

	// Rows-view daily recommendations

	getRecommendedDaily(): RecommendedDaily {
		return this.data.recommendedDaily ?? { date: '', ids: [] };
	}

	/**
	 * Silent daily-recommendation save — no listener notify; the Rows view that rolled the picks
	 * renders them itself.
	 */
	setRecommendedDaily(rec: RecommendedDaily): void {
		this.data.recommendedDaily = rec;
		void this.saveOnly();
	}

	/**
	 * Silent poster URL update: memory now, debounced disk save (5s). No notify — the card that
	 * triggered the fetch updates its own <img>.
	 */
	updatePosterUrl(titleId: string, url: string): void {
		const title = this.data.titles.find((t) => t.id === titleId);
		if (title) {
			title.posterUrl = url;
			this.schedulePosterSave();
		}
	}

	/** Silent TMDB id + collection cache. tmdbId null = not a movie, keep the verdict only. */
	updateTmdbIdentity(id: string, tmdbId: number | null, collectionId: number): void {
		const title = this.data.titles.find((t) => t.id === id);
		if (!title) return;
		const nextTmdbId = tmdbId ?? title.tmdbId;
		if (title.tmdbId === nextTmdbId && title.collectionId === collectionId) return;
		// only ever a movie id here — the collections lookup rejects everything else
		if (nextTmdbId !== undefined) {
			title.tmdbId = nextTmdbId;
			title.tmdbMediaType = 'movie';
		}
		title.collectionId = collectionId;
		void this.saveOnly();
	}

	/** Silent community-rating update: memory + disk, no notify. The caller refreshes its own UI. */
	updateCommunityRating(
		id: string,
		rating: number,
		votes: number,
		source: '' | 'imdb' | 'mal' | 'anilist' | 'tmdb',
	): void {
		const title = this.data.titles.find((t) => t.id === id);
		if (!title) return;
		title.communityRating = rating;
		title.communityVotes = votes;
		title.communitySource = source;
		title.communityRatingLastFetched = new Date().toISOString();
		void this.saveOnly();
	}

	/**
	 * Silent trailer URL update (manual refresh): memory + disk, no notify — the caller re-renders
	 * its own row.
	 */
	updateTrailerUrl(titleId: string, url: string): void {
		const title = this.data.titles.find((t) => t.id === titleId);
		if (!title) return;
		title.trailerUrl = url;
		void this.saveOnly();
	}

	/**
	 * Persists a director/cast backfill through the normal update path: data.json AND the note's
	 * frontmatter (NOT the poster-style silent save, which skips the .md). Deliberately does not
	 * stamp dateModified — a background backfill is not a user edit and must not reshuffle
	 * "recently modified" sorts.
	 *
	 * Only the fetched fields are touched; user-added credits live in their own arrays. Manual
	 * entries the fetch now returns are pruned, so no name is stored twice.
	 */
	async updateCredits(titleId: string, director: string[], cast: string[]): Promise<void> {
		const title = this.getTitle(titleId);
		if (!title) return;
		title.director = director;
		title.cast = cast;
		title.manualDirector = pruneManualCredits(title.manualDirector ?? [], director);
		title.manualCast = pruneManualCredits(title.manualCast ?? [], cast);
		await this.save();
		await this.updateMarkdownFile(title);
	}

	/** Studio backfill; same no-dateModified rules as updateCredits. Caches the TMDB id it resolved. */
	async updateStudio(
		titleId: string,
		studio: string[],
		tmdbId?: number,
		tmdbMediaType?: 'movie' | 'tv',
	): Promise<void> {
		const title = this.getTitle(titleId);
		if (!title) return;
		title.studio = studio;
		title.manualStudio = pruneManualCredits(title.manualStudio ?? [], studio);
		if (tmdbId && tmdbMediaType) {
			title.tmdbId = tmdbId;
			title.tmdbMediaType = tmdbMediaType;
		}
		await this.save();
		await this.updateMarkdownFile(title);
	}

	/**
	 * Replaces one field's user-added credits (the add modal commits additions and removals in one
	 * call). Uncapped by design — the API cap trims a fetched cast, not user input. Like
	 * updateCredits: data.json + frontmatter, no dateModified stamp.
	 */
	async updateManualCredits(titleId: string, field: CreditsField, names: string[]): Promise<void> {
		const title = this.getTitle(titleId);
		if (!title) return;
		const fetched =
			(field === 'director' ? title.director : field === 'cast' ? title.cast : title.studio) ?? [];
		const cleaned = pruneManualCredits(normalizeManualCredits(names), fetched);
		if (field === 'director') title.manualDirector = cleaned;
		else if (field === 'cast') title.manualCast = cleaned;
		else title.manualStudio = cleaned;
		await this.save();
		await this.updateMarkdownFile(title);
	}

	/**
	 * Silent favorite toggle: data.json + frontmatter, no notify — the detail modal updates its own
	 * button and flags the change for the on-close refresh. No dateModified stamp.
	 */
	async setFavorite(id: string, favorite: boolean): Promise<void> {
		const title = this.getTitle(id);
		if (!title) return;
		title.favorite = favorite;
		// stamp drives the Favorites shelf order (newest first); cleared on unfavorite
		if (favorite) title.dateFavorited = new Date().toISOString();
		else delete title.dateFavorited;
		await this.saveOnly();
		await this.updateMarkdownFile(title);
	}

	private schedulePosterSave(): void {
		if (this.posterSaveTimer !== null) return;
		this.posterSaveTimer = window.setTimeout(() => {
			this.posterSaveTimer = null;
			void this.saveOnly();
		}, this.POSTER_SAVE_DEBOUNCE_MS);
	}

	/** Flush a pending debounced poster save now (e.g. on plugin unload). */
	flushPosterSave(): void {
		if (this.posterSaveTimer !== null) {
			window.clearTimeout(this.posterSaveTimer);
			this.posterSaveTimer = null;
			void this.saveOnly();
		}
	}

	/** Synchronously flush a pending poster save during plugin unload. */
	flushPosterSaveSync(): void {
		if (this.posterSaveTimer !== null) {
			window.clearTimeout(this.posterSaveTimer);
			this.posterSaveTimer = null;
			this.lastSelfSaveTime = Date.now();
			void this.plugin.saveData(this.data);
		}
	}

	/** Public access to the full in-memory data snapshot. */
	getData(): WatchLogData {
		return this.data;
	}

	/** Centralized debounced save for cross-cutting paths (settings, drafts, lists). */
	queueSave(): void {
		if (this.queuedSaveTimer !== null) {
			window.clearTimeout(this.queuedSaveTimer);
		}
		this.queuedSaveTimer = window.setTimeout(() => {
			this.queuedSaveTimer = null;
			void this.saveOnly();
		}, this.QUEUED_SAVE_DEBOUNCE_MS);
	}

	flushQueuedSaveSync(): void {
		if (this.queuedSaveTimer !== null) {
			window.clearTimeout(this.queuedSaveTimer);
			this.queuedSaveTimer = null;
			this.lastSelfSaveTime = Date.now();
			void this.plugin.saveData(this.data);
		}
	}

	/** Save settings through the centralized data path. */
	async saveSettings(settings: WatchLogPluginSettings): Promise<void> {
		this.data.settings = settings;
		await this.saveOnly();
	}

	private async saveOnly(): Promise<void> {
		this.lastSelfSaveTime = Date.now();
		await this.plugin.saveData(this.data);
		this.lastSelfSaveTime = Date.now();
	}

	/**
	 * Persist the full in-memory data object to data.json. Reading and activity-log data live as
	 * keys (`reading` / `history`) in this same object, so those managers route their saves through
	 * here. saveOnly() stamps lastSelfSaveTime, so the 'raw' watcher ignores the echo.
	 */
	async persist(): Promise<void> {
		await this.saveOnly();
	}

	async save(): Promise<void> {
		// an immediate save supersedes any pending debounced one — memory already has those changes
		if (this.pendingSaveTimer !== null) {
			window.clearTimeout(this.pendingSaveTimer);
			this.pendingSaveTimer = null;
			this.pendingMdTitleIds.clear();
		}
		await this.saveOnly();
		this.notifyListeners();
	}

	/**
	 * Schedule a debounced silent save (no notify, no re-render). Later calls reset the timer;
	 * callers own any targeted DOM updates.
	 */
	scheduleEpisodeSave(titleIdForMd: string): void {
		this.pendingMdTitleIds.add(titleIdForMd);
		if (this.pendingSaveTimer !== null) {
			window.clearTimeout(this.pendingSaveTimer);
		}
		this.pendingSaveTimer = window.setTimeout(() => {
			void this.flushPendingSave();
		}, this.EPISODE_SAVE_DEBOUNCE_MS);
	}

	/** Flush a pending debounced save now (e.g. on view close / plugin unload). */
	async flushPendingSave(): Promise<void> {
		if (this.pendingSaveTimer !== null) {
			window.clearTimeout(this.pendingSaveTimer);
			this.pendingSaveTimer = null;
		}
		if (this.pendingMdTitleIds.size === 0) return;
		const ids = Array.from(this.pendingMdTitleIds);
		this.pendingMdTitleIds.clear();
		await this.saveOnly();
		for (const id of ids) {
			const t = this.getTitle(id);
			if (t) await this.updateMarkdownFile(t);
		}
	}

	/** Synchronously flush a pending episode-save during plugin unload (no awaits). */
	flushPendingSaveSync(): void {
		if (this.pendingSaveTimer !== null) {
			window.clearTimeout(this.pendingSaveTimer);
			this.pendingSaveTimer = null;
		}
		if (this.pendingMdTitleIds.size === 0) return;
		const ids = Array.from(this.pendingMdTitleIds);
		this.pendingMdTitleIds.clear();
		this.lastSelfSaveTime = Date.now();
		void this.plugin.saveData(this.data);
		for (const id of ids) {
			const t = this.getTitle(id);
			if (t) void this.updateMarkdownFile(t);
		}
	}

	getTitles(): WatchLogTitle[] {
		return this.data.titles ?? [];
	}

	getTitle(id: string): WatchLogTitle | undefined {
		return (this.data.titles ?? []).find((t) => t.id === id);
	}

	async addTitle(title: WatchLogTitle): Promise<void> {
		// a fresh title needs posterUrl '' (not undefined) so the Cards needs-poster gate enqueues an
		// auto-fetch on first render
		if (title.posterUrl === undefined) title.posterUrl = '';
		if (title.trailerUrl === undefined) title.trailerUrl = '';
		if (title.manualTrailerUrl === undefined) title.manualTrailerUrl = '';
		const autoUpcoming = this.canAutoAddToUpcoming(title);
		if (autoUpcoming) {
			title.status = 'To be released';
		}
		this.data.titles.push(title);
		await this.save();
		if (autoUpcoming) {
			await this.autoAddToUpcoming(title);
		}
		await this.updateMarkdownFile(title);
		const now = new Date().toISOString();
		void this.historyManager?.log(
			`${title.title} (${title.type}) was added on ${formatHistoryDate(now)}`,
			{ source: 'Watchlist', action: 'added', titleName: title.title },
		);
	}

	/** Add without re-rendering. Caller must call notifyChange() after the batch. */
	async addTitleSilent(title: WatchLogTitle): Promise<void> {
		const autoUpcoming = this.canAutoAddToUpcoming(title);
		if (autoUpcoming) {
			title.status = 'To be released';
		}
		this.data.titles.push(title);
		await this.saveOnly();
		if (autoUpcoming) {
			await this.autoAddToUpcoming(title);
		}
		await this.updateMarkdownFile(title);
	}

	/** Batch-add: push all titles into memory, save once, then write all MD files. */
	async addTitleBatch(titles: WatchLogTitle[]): Promise<void> {
		const upcoming: WatchLogTitle[] = [];
		for (const title of titles) {
			if (this.canAutoAddToUpcoming(title)) {
				title.status = 'To be released';
				upcoming.push(title);
			}
			this.data.titles.push(title);
		}
		await this.saveOnly();
		for (const title of upcoming) {
			await this.autoAddToUpcoming(title);
		}
		for (const title of titles) {
			await this.updateMarkdownFile(title);
		}
	}

	/** Batch-update via mutator. Single save + single notify; MD files updated. */
	async batchUpdate(ids: string[], mutator: (t: WatchLogTitle) => void): Promise<void> {
		const updated: WatchLogTitle[] = [];
		for (const id of ids) {
			const t = this.getTitle(id);
			if (!t) continue;
			mutator(t);
			t.dateModified = new Date().toISOString();
			updated.push(t);
		}
		if (updated.length === 0) return;
		await this.save();
		for (const t of updated) {
			await this.updateMarkdownFile(t);
		}
	}

	/** Remove multiple titles in one batch: single save, MD files deleted in chunks of 10. */
	async removeTitlesBatch(ids: string[]): Promise<void> {
		const CHUNK_SIZE = 10;
		const titlesToDelete: WatchLogTitle[] = [];

		for (const id of ids) {
			const title = this.getTitle(id);
			if (title) titlesToDelete.push(title);
			this.data.titles = this.data.titles.filter((t) => t.id !== id);
			for (const group of this.data.groups) {
				group.titleIds = group.titleIds.filter((tid) => tid !== id);
			}
			if (this.data.airtime) {
				this.data.airtime = this.data.airtime.filter((e) => e.titleId !== id || e.source === 'reading');
			}
			const d = this.data as unknown as Record<string, unknown>;
			if (d['collapsedSeasons']) {
				delete (d['collapsedSeasons'] as Record<string, number[]>)[id];
			}
		}

		await this.save();

		for (let i = 0; i < titlesToDelete.length; i += CHUNK_SIZE) {
			const chunk = titlesToDelete.slice(i, i + CHUNK_SIZE);
			await Promise.all(chunk.map((t) => this.deleteMarkdownFile(t)));
		}
	}

	canAutoAddToUpcoming(title: WatchLogTitle): boolean {
		if (!title.releaseDate) return false;
		// only auto-add with a full YYYY-MM-DD date
		if (!/^\d{4}-\d{2}-\d{2}$/.test(title.releaseDate)) return false;
		const release = new Date(title.releaseDate + 'T12:00:00');
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		return release > today;
	}

	async autoAddToUpcoming(title: WatchLogTitle): Promise<void> {
		if (!this.data.airtime) this.data.airtime = [];
		// avoid duplicates
		if (this.data.airtime.some((e) => e.titleId === title.id)) return;
		const entry: import('./types').AirtimeEntry = {
			id: this.generateAirtimeId(title.id),
			titleId: title.id,
			schedule: {
				recurrence: 'once',
				releaseDate: title.releaseDate ?? undefined,
			},
			dateAdded: new Date().toISOString(),
		};
		this.data.airtime.push(entry);
		await this.plugin.saveData(this.data);
	}

	/**
	 * Reconciles everything a release-date edit ripples into: an existing 'once' Upcoming entry's
	 * date, the auto "To be released" status, and whether the title belongs in Upcoming at all. A
	 * future full date forces the status and adds the entry; a past or cleared date reverts a
	 * "To be released" title to "Plan to watch" and drops its entry.
	 *
	 * Call after `releaseDate` has been written and persisted.
	 */
	async applyReleaseDateChange(title: WatchLogTitle): Promise<void> {
		// keep a one-off Upcoming entry pointing at the new date
		const existing = this.getAirtimeEntries().find((e) => e.titleId === title.id);
		if (existing && existing.schedule.recurrence === 'once') {
			const next = title.releaseDate ?? undefined;
			if (existing.schedule.releaseDate !== next) {
				existing.schedule.releaseDate = next;
				await this.updateAirtimeEntry(existing);
			}
		}

		const releaseDate = title.releaseDate;
		const isFullDate = !!releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(releaseDate);

		if (isFullDate) {
			if (isReleaseDateFuture(releaseDate)) {
				if (title.status !== 'To be released') {
					title.status = 'To be released';
					await this.updateTitle(title);
				}
				if (!this.getAirtimeEntries().some((e) => e.titleId === title.id)) {
					await this.autoAddToUpcoming(title);
				}
			} else if (title.status === 'To be released') {
				// date is past/today — the auto status no longer applies
				title.status = 'Plan to watch';
				await this.updateTitle(title);
				await this.removeAirtimeEntriesForTitle(title.id);
			}
		} else if (!releaseDate && title.status === 'To be released') {
			title.status = 'Plan to watch';
			await this.updateTitle(title);
			await this.removeAirtimeEntriesForTitle(title.id);
		}
	}

	/** Remove all Upcoming entries for a title (e.g. when the date goes past). */
	async removeAirtimeEntriesForTitle(titleId: string): Promise<void> {
		const before = (this.data.airtime ?? []).length;
		this.data.airtime = (this.data.airtime ?? []).filter(
			(e) => e.titleId !== titleId || (e.source !== undefined && e.source !== 'watchlist'),
		);
		if ((this.data.airtime ?? []).length !== before) {
			await this.save();
		}
	}

	// Reading → Upcoming bridge. Reading items live under data.reading, but their Upcoming entries
	// share the airtime list with watch titles — mirroring autoAddToUpcoming.

	/** Auto-adds a reading item with a future release date to Upcoming. No-op if one exists. */
	async autoAddReadingToUpcoming(item: Book | Manga, kind: 'book' | 'manga'): Promise<void> {
		if (!this.data.airtime) this.data.airtime = [];
		if (this.data.airtime.some((e) => e.source === 'reading' && e.titleId === item.id)) return;
		const entry: AirtimeEntry = {
			id: this.generateReadingAirtimeId(item.id),
			titleId: item.id,
			source: 'reading',
			readingKind: kind,
			schedule: {
				recurrence: 'once',
				releaseDate: item.releaseDate ?? undefined,
			},
			dateAdded: new Date().toISOString(),
		};
		this.data.airtime.push(entry);
		await this.plugin.saveData(this.data);
	}

	/** Remove all Upcoming entries for a reading item (book/manga id). */
	async removeReadingAirtimeEntries(itemId: string): Promise<void> {
		const before = (this.data.airtime ?? []).length;
		this.data.airtime = (this.data.airtime ?? []).filter(
			(e) => !(e.source === 'reading' && e.titleId === itemId),
		);
		if ((this.data.airtime ?? []).length !== before) {
			await this.save();
		}
	}

	generateReadingAirtimeId(itemId: string): string {
		const base = `airtime-reading-${itemId}`;
		const existing = (this.data.airtime ?? []).map((e) => e.id);
		if (!existing.includes(base)) return base;
		let counter = 2;
		while (existing.includes(`${base}-${counter}`)) counter++;
		return `${base}-${counter}`;
	}

	// Games → Upcoming bridge — the Reading-bridge pattern exactly.

	/** Auto-adds a game with a future release date to Upcoming. No-op if one exists. */
	async autoAddGameToUpcoming(game: Game): Promise<void> {
		if (!this.data.airtime) this.data.airtime = [];
		if (this.data.airtime.some((e) => e.source === 'game' && e.titleId === game.id)) return;
		const entry: AirtimeEntry = {
			id: this.generateGameAirtimeId(game.id),
			titleId: game.id,
			source: 'game',
			schedule: {
				recurrence: 'once',
				releaseDate: game.releaseDate ?? undefined,
			},
			dateAdded: new Date().toISOString(),
		};
		this.data.airtime.push(entry);
		await this.plugin.saveData(this.data);
	}

	/** Remove all Upcoming entries for a game id. */
	async removeGameAirtimeEntries(gameId: string): Promise<void> {
		const before = (this.data.airtime ?? []).length;
		this.data.airtime = (this.data.airtime ?? []).filter(
			(e) => !(e.source === 'game' && e.titleId === gameId),
		);
		if ((this.data.airtime ?? []).length !== before) {
			await this.save();
		}
	}

	generateGameAirtimeId(gameId: string): string {
		const base = `airtime-game-${gameId}`;
		const existing = (this.data.airtime ?? []).map((e) => e.id);
		if (!existing.includes(base)) return base;
		let counter = 2;
		while (existing.includes(`${base}-${counter}`)) counter++;
		return `${base}-${counter}`;
	}

	async updateTitle(updated: WatchLogTitle): Promise<void> {
		updated.dateModified = new Date().toISOString();
		if (updated.status === 'Completed') {
			updated.priority = '';
		}
		const idx = this.data.titles.findIndex((t) => t.id === updated.id);
		if (idx >= 0) {
			const old = this.data.titles[idx]!;
			const now = new Date().toISOString();
			if (old.rating !== updated.rating) {
				void this.historyManager?.log(
					`${updated.title} (${updated.type}) was reviewed on ${formatHistoryDate(now)}`,
					{ source: 'Watchlist', action: 'rating', titleName: updated.title },
				);
			}
			if (old.status !== updated.status && updated.status === 'Completed') {
				void this.historyManager?.log(
					`${updated.title} (${updated.type}) was marked as watched on ${formatHistoryDate(now)}`,
					{ source: 'Watchlist', action: 'completed', titleName: updated.title },
				);
			}
			this.data.titles[idx] = updated;
			await this.save();
			await this.updateMarkdownFile(updated);
		}
	}

	/**
	 * Update without saving or notifying. Caller must save() (or saveOnly + notifyChange) once after
	 * the batch, and owns the per-title markdown update.
	 */
	updateTitleSilent(updated: WatchLogTitle): void {
		updated.dateModified = new Date().toISOString();
		if (updated.status === 'Completed') {
			updated.priority = '';
		}
		const idx = this.data.titles.findIndex((t) => t.id === updated.id);
		if (idx >= 0) {
			const old = this.data.titles[idx]!;
			const now = new Date().toISOString();
			if (old.rating !== updated.rating) {
				void this.historyManager?.log(
					`${updated.title} (${updated.type}) was reviewed on ${formatHistoryDate(now)}`,
					{ source: 'Watchlist', action: 'rating', titleName: updated.title },
				);
			}
			if (old.status !== updated.status && updated.status === 'Completed') {
				void this.historyManager?.log(
					`${updated.title} (${updated.type}) was marked as watched on ${formatHistoryDate(now)}`,
					{ source: 'Watchlist', action: 'completed', titleName: updated.title },
				);
			}
			this.data.titles[idx] = updated;
		}
	}

	async removeTitle(id: string): Promise<void> {
		const title = this.getTitle(id);
		if (title) {
			const now = new Date().toISOString();
			void this.historyManager?.log(
				`${title.title} (${title.type}) was deleted on ${formatHistoryDate(now)}`,
				{ source: 'Watchlist', action: 'deleted', titleName: title.title },
			);
		}
		this.data.titles = this.data.titles.filter((t) => t.id !== id);
		for (const group of this.data.groups) {
			group.titleIds = group.titleIds.filter((tid) => tid !== id);
		}
		if (this.data.airtime) {
			this.data.airtime = this.data.airtime.filter((e) => e.titleId !== id || e.source === 'reading');
		}
		const d = this.data as unknown as Record<string, unknown>;
		if (d['collapsedSeasons']) {
			delete (d['collapsedSeasons'] as Record<string, number[]>)[id];
		}
		await this.save();
		if (title) {
			await this.deleteMarkdownFile(title);
		}
	}

	// Group CRUD

	getGroups(): WatchLogGroup[] {
		return this.data.groups ?? [];
	}

	getGroup(id: string): WatchLogGroup | undefined {
		return (this.data.groups ?? []).find((g) => g.id === id);
	}

	async addGroup(group: WatchLogGroup): Promise<void> {
		this.data.groups.push(group);
		await this.save();
	}

	async updateGroup(updated: WatchLogGroup): Promise<void> {
		const idx = this.data.groups.findIndex((g) => g.id === updated.id);
		if (idx >= 0) {
			this.data.groups[idx] = updated;
			await this.save();
		}
	}

	async removeGroup(id: string): Promise<void> {
		this.data.groups = this.data.groups.filter((g) => g.id !== id);
		await this.save();
	}

	async addTitleToGroup(groupId: string, titleId: string): Promise<void> {
		const group = this.getGroup(groupId);
		if (!group) return;
		if (!group.titleIds.includes(titleId)) {
			group.titleIds.push(titleId);
			await this.updateGroup(group);
		}
	}

	getGroupedTitleIds(): Set<string> {
		const ids = new Set<string>();
		for (const group of (this.data.groups ?? [])) {
			for (const id of group.titleIds) {
				ids.add(id);
			}
		}
		return ids;
	}

	generateGroupId(name: string): string {
		let id =
			'group-' +
			name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
		const existing = (this.data.groups ?? []).map((g) => g.id);
		if (!existing.includes(id)) return id;
		let counter = 2;
		while (existing.includes(`${id}-${counter}`)) counter++;
		return `${id}-${counter}`;
	}

	// Pinned group

	getPinnedGroupId(): string | null {
		return this.data.pinnedGroupId ?? null;
	}

	async setPinnedGroupId(id: string | null): Promise<void> {
		this.data.pinnedGroupId = id;
		await this.save();
	}

	// Saved filter preset

	getSavedFilterPreset(): SavedFilterPreset | null {
		return this.data.savedFilterPreset ?? null;
	}

	async setSavedFilterPreset(preset: SavedFilterPreset | null): Promise<void> {
		this.data.savedFilterPreset = preset;
		await this.save();
	}

	// Airtime CRUD

	getAirtimeEntries(): AirtimeEntry[] {
		return this.data.airtime ?? [];
	}

	async addAirtimeEntry(entry: AirtimeEntry): Promise<void> {
		if (!this.data.airtime) this.data.airtime = [];
		this.data.airtime.push(entry);
		await this.save();
	}

	async updateAirtimeEntry(updated: AirtimeEntry): Promise<void> {
		if (!this.data.airtime) return;
		const idx = this.data.airtime.findIndex((e) => e.id === updated.id);
		if (idx >= 0) {
			this.data.airtime[idx] = updated;
			await this.save();
		}
	}

	async removeAirtimeEntry(id: string): Promise<void> {
		this.data.airtime = (this.data.airtime ?? []).filter((e) => e.id !== id);
		await this.save();
	}

	async removeAirtimeEntriesBatch(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		const removeSet = new Set(ids);
		this.data.airtime = (this.data.airtime ?? []).filter((e) => !removeSet.has(e.id));
		await this.save();
	}

	// Maybe CRUD

	getMaybeTitles(): MaybeTitle[] {
		return this.data.maybe ?? [];
	}

	async addMaybeTitle(title: MaybeTitle): Promise<void> {
		if (!this.data.maybe) this.data.maybe = [];
		this.data.maybe.push(title);
		await this.save();
	}

	async removeMaybeTitle(id: string): Promise<void> {
		this.data.maybe = (this.data.maybe ?? []).filter((t) => t.id !== id);
		await this.save();
	}

	generateMaybeId(titleName: string): string {
		let base = 'maybe-' + titleName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
		const existing = (this.data.maybe ?? []).map((t) => t.id);
		if (!existing.includes(base)) return base;
		let counter = 2;
		while (existing.includes(`${base}-${counter}`)) counter++;
		return `${base}-${counter}`;
	}

	generateAirtimeId(titleId: string): string {
		const base = `airtime-${titleId}`;
		const existing = (this.data.airtime ?? []).map((e) => e.id);
		if (!existing.includes(base)) return base;
		let counter = 2;
		while (existing.includes(`${base}-${counter}`)) counter++;
		return `${base}-${counter}`;
	}

	// Time calculations

	calcTimeWatched(title: WatchLogTitle): number {
		if (title.episodeDuration <= 0) return 0;
		// "To be released" titles haven't been watched yet
		if (title.status === 'To be released') return 0;
		if (title.type === 'Movie') {
			return title.watchedEpisodes.includes(1) ? title.episodeDuration : 0;
		}
		if (title.status === 'Completed') {
			return this.getEffectiveTotal(title) * title.episodeDuration;
		}
		return title.watchedEpisodes.length * title.episodeDuration;
	}

	calcTimeRemaining(title: WatchLogTitle): number {
		if (title.episodeDuration <= 0) return 0;
		if (title.status === 'Dropped') return 0;
		// "To be released" doesn't count toward time remaining — not yet available
		if (title.status === 'To be released') return 0;
		if (title.type === 'Movie') {
			return title.watchedEpisodes.includes(1) ? 0 : title.episodeDuration;
		}
		const effective = this.getEffectiveTotal(title);
		if (title.status === 'Plan to watch') {
			return Math.max(0, effective - title.watchedEpisodes.length) * title.episodeDuration;
		}
		if (title.status === 'Watching') {
			return Math.max(0, effective - title.watchedEpisodes.length) * title.episodeDuration;
		}
		return 0;
	}

	calcTimeRemainingForModal(title: WatchLogTitle): number {
		if (title.episodeDuration <= 0) return 0;
		if (title.status === 'To be released') return 0;
		if (title.type === 'Movie') {
			return title.watchedEpisodes.includes(1) ? 0 : title.episodeDuration;
		}
		const effective = this.getEffectiveTotal(title);
		if (title.status === 'Dropped') {
			return Math.max(0, effective - title.watchedEpisodes.length) * title.episodeDuration;
		}
		if (title.status === 'Plan to watch') {
			return Math.max(0, effective - title.watchedEpisodes.length) * title.episodeDuration;
		}
		if (title.status === 'Watching') {
			return Math.max(0, effective - title.watchedEpisodes.length) * title.episodeDuration;
		}
		return 0;
	}

	getTotalTimeWatched(): number {
		return (this.data.titles ?? []).reduce((sum, t) => sum + this.calcTimeWatched(t), 0);
	}

	getTotalTimeRemaining(): number {
		return (this.data.titles ?? []).reduce((sum, t) => sum + this.calcTimeRemaining(t), 0);
	}

	// External change watcher

	/**
	 * Vault-relative path of our own data.json, as the 'raw' event reports it. Derived from the
	 * manifest rather than hardcoded: the plugin folder is only called `watchlog` on a Community
	 * Plugins install — BRAT and manual installs can name it anything, and a hardcoded match would
	 * silently disable external-change detection there.
	 */
	private dataFilePath(): string {
		const dir = this.plugin.manifest.dir
			?? `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
		return normalizePath(`${dir}/data.json`);
	}

	startWatchingExternalChanges(): void {
		const dataPath = this.dataFilePath();
		// 'raw' fires when Obsidian Sync writes a file directly to disk (not via the vault API). A real
		// runtime event, but not declared in Obsidian's public types.
		const ref = (
			this.app.vault as unknown as {
				on(event: 'raw', cb: (path: string) => void): import('obsidian').EventRef;
			}
		).on('raw', (path: string) => {
			if (normalizePath(path) === dataPath) {
				// suppress the echo of our own saveOnly() — Obsidian fires 'raw' for any write to the data file,
				// so without this guard each episode click cascades into load() + notifyListeners()
				if (Date.now() - this.lastSelfSaveTime < this.SELF_SAVE_ECHO_WINDOW_MS) {
					return;
				}
				void (async () => {
					await this.load();
					this.notifyListeners();
					// reading + activity log live in data.json now, so a synced file carries them: re-bind those
					// managers to the fresh object and refresh their UIs
					await this.plugin.readingDataManager?.adoptExternalChange();
					await this.plugin.gameDataManager?.adoptExternalChange();
					this.plugin.historyManager?.adoptExternalChange();
				})();
			}
		});
		this.plugin.registerEvent(ref);
	}

	// Listeners

	onChange(listener: () => void): void {
		this.changeListeners.push(listener);
	}

	offChange(listener: () => void): void {
		this.changeListeners = this.changeListeners.filter((l) => l !== listener);
	}

	/** Public trigger for external callers (e.g. CsvModal) that need to force a UI refresh. */
	notifyChange(): void {
		this.notifyListeners();
	}

	private notifyListeners(): void {
		for (const listener of this.changeListeners) {
			listener();
		}
		activeDocument.dispatchEvent(new CustomEvent('watchlog-data-changed'));
	}

	// Season collapse persistence

	getCollapsedSeasonsForTitle(titleId: string): Set<number> {
		const stored = (this.data as unknown as Record<string, unknown>)['collapsedSeasons'] as
			| Record<string, number[]>
			| undefined;
		return new Set<number>(stored?.[titleId] ?? []);
	}

	async persistCollapsedSeasons(titleId: string, seasons: Set<number>): Promise<void> {
		const d = this.data as unknown as Record<string, unknown>;
		if (!d['collapsedSeasons']) d['collapsedSeasons'] = {};
		(d['collapsedSeasons'] as Record<string, number[]>)[titleId] = Array.from(seasons);
		await this.save();
	}

	// Skip helpers

	getTotalSkippedCount(title: WatchLogTitle): number {
		return title.seasons.reduce((sum, s) => sum + (s.skippedEpisodes?.length ?? 0), 0);
	}

	/** totalEpisodes minus all season-defined skipped episodes. */
	getEffectiveTotal(title: WatchLogTitle): number {
		return Math.max(0, title.totalEpisodes - this.getTotalSkippedCount(title));
	}

	/** True when absoluteEpNum falls in any season's skippedEpisodes list. */
	isEpisodeSkipped(title: WatchLogTitle, absoluteEpNum: number): boolean {
		for (const season of title.seasons) {
			const rel = absoluteEpNum - season.offset;
			if (rel >= 1 && rel <= season.episodes && (season.skippedEpisodes ?? []).includes(rel)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * In-memory toggle of an episode's watched state plus auto-complete. Schedules a debounced save
	 * and does NOT notify — the caller owns targeted DOM updates. Returns the mutated title.
	 */
	applyEpisodeWatchedToggle(
		id: string,
		episodeNumber: number,
		watched: boolean,
	): WatchLogTitle | null {
		const title = this.getTitle(id);
		if (!title) return null;

		if (watched) {
			if (!title.watchedEpisodes.includes(episodeNumber)) {
				title.watchedEpisodes.push(episodeNumber);
				title.watchedEpisodes.sort((a, b) => a - b);
			}
			const now = new Date().toISOString();
			if (title.totalEpisodes > 1) {
				void this.historyManager?.log(
					`${title.title} (${title.type}) episode ${episodeNumber} was marked as watched on ${formatHistoryDate(now)}`,
					{ source: 'Watchlist', action: 'watched', titleName: title.title },
				);
			} else {
				void this.historyManager?.log(
					`${title.title} (${title.type}) was marked as watched on ${formatHistoryDate(now)}`,
					{ source: 'Watchlist', action: 'watched', titleName: title.title },
				);
			}
		} else {
			title.watchedEpisodes = title.watchedEpisodes.filter((e) => e !== episodeNumber);
		}

		title.dateModified = new Date().toISOString();
		this.applyAutoCompleteRules(title);
		this.scheduleEpisodeSave(id);
		return title;
	}

	/** Shared auto-complete / un-complete rules. Mutates title in place. */
	private applyAutoCompleteRules(title: WatchLogTitle): void {
		const effectiveTotal = this.getEffectiveTotal(title);
		if (
			this.plugin.settings.autoCompleteOnLastEpisode &&
			effectiveTotal > 0 &&
			title.watchedEpisodes.length >= effectiveTotal
		) {
			if (title.status !== 'Completed') {
				title.status = 'Completed';
				// match updateTitle(): completed titles drop priority
				title.priority = '';
			}
			if (this.plugin.settings.setFinishDateAutomatically && !title.dateFinished) {
				title.dateFinished = todayIso();
			}
		} else if (title.status === 'Completed' && title.watchedEpisodes.length < effectiveTotal) {
			title.status = 'Watching';
			title.dateFinished = null;
		}
	}

	// Progress helpers

	getProgress(title: WatchLogTitle): number {
		const effective = this.getEffectiveTotal(title);
		if (effective === 0) return 0;
		return Math.min(100, Math.round((title.watchedEpisodes.length / effective) * 100));
	}

	getNextUnwatchedEpisode(title: WatchLogTitle): number | null {
		const watched = new Set(title.watchedEpisodes);
		for (let i = 1; i <= title.totalEpisodes; i++) {
			if (!watched.has(i)) return i;
		}
		return null;
	}

	async markEpisodeWatched(id: string, episodeNumber: number, watched: boolean): Promise<void> {
		const title = this.getTitle(id);
		if (!title) return;

		if (watched) {
			if (!title.watchedEpisodes.includes(episodeNumber)) {
				title.watchedEpisodes.push(episodeNumber);
				title.watchedEpisodes.sort((a, b) => a - b);
			}
			const now = new Date().toISOString();
			if (title.totalEpisodes > 1) {
				void this.historyManager?.log(
					`${title.title} (${title.type}) episode ${episodeNumber} was marked as watched on ${formatHistoryDate(now)}`,
					{ source: 'Watchlist', action: 'watched', titleName: title.title },
				);
			} else {
				void this.historyManager?.log(
					`${title.title} (${title.type}) was marked as watched on ${formatHistoryDate(now)}`,
					{ source: 'Watchlist', action: 'watched', titleName: title.title },
				);
			}
		} else {
			title.watchedEpisodes = title.watchedEpisodes.filter((e) => e !== episodeNumber);
		}

		const effectiveTotal = this.getEffectiveTotal(title);
		if (
			this.plugin.settings.autoCompleteOnLastEpisode &&
			effectiveTotal > 0 &&
			title.watchedEpisodes.length >= effectiveTotal
		) {
			title.status = 'Completed';
			if (this.plugin.settings.setFinishDateAutomatically && !title.dateFinished) {
				title.dateFinished = todayIso();
			}
		} else if (title.status === 'Completed' && title.watchedEpisodes.length < effectiveTotal) {
			title.status = 'Watching';
			title.dateFinished = null;
		}

		await this.updateTitle(title);
	}

	async markSeasonWatched(
		id: string,
		episodeNumbers: number[],
		watched: boolean,
		seasonLabel?: string,
	): Promise<void> {
		const title = this.getTitle(id);
		if (!title) return;

		// capture season completion BEFORE the tick, to detect a not-complete → complete transition
		const before = new Set(title.watchedEpisodes);
		const wasComplete = episodeNumbers.length > 0 && episodeNumbers.every((ep) => before.has(ep));

		if (watched) {
			const set = new Set(title.watchedEpisodes);
			for (const ep of episodeNumbers) set.add(ep);
			title.watchedEpisodes = Array.from(set).sort((a, b) => a - b);
		} else {
			const remove = new Set(episodeNumbers);
			title.watchedEpisodes = title.watchedEpisodes.filter((e) => !remove.has(e));
		}

		// "tick entire season" emits ONE history entry, and only when the action makes the season newly
		// complete — not when clearing, already complete, or without a season label
		if (watched && seasonLabel) {
			const after = new Set(title.watchedEpisodes);
			const nowComplete = episodeNumbers.length > 0 && episodeNumbers.every((ep) => after.has(ep));
			if (!wasComplete && nowComplete) {
				const now = new Date().toISOString();
				void this.historyManager?.log(
					`${title.title} (${title.type}) ${seasonLabel} was fully watched on ${formatHistoryDate(now)}`,
					{ source: 'Watchlist', action: 'watched', titleName: title.title },
				);
			}
		}

		const effectiveTotal = this.getEffectiveTotal(title);
		if (
			this.plugin.settings.autoCompleteOnLastEpisode &&
			effectiveTotal > 0 &&
			title.watchedEpisodes.length >= effectiveTotal
		) {
			title.status = 'Completed';
			if (this.plugin.settings.setFinishDateAutomatically && !title.dateFinished) {
				title.dateFinished = todayIso();
			}
		} else if (title.status === 'Completed' && title.watchedEpisodes.length < effectiveTotal) {
			title.status = 'Watching';
			title.dateFinished = null;
		}

		await this.updateTitle(title);
	}

	// Folder management

	async ensureFolders(): Promise<void> {
		if (!this.plugin.settings.autoCreateFolders) return;
		const root = this.plugin.settings.rootFolder;
		await this.ensureFolder(root);
		for (const type of this.plugin.settings.types) {
			await this.ensureFolder(`${root}/${type.name}`);
		}
	}

	async ensureFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (!this.app.vault.getAbstractFileByPath(normalized)) {
			try {
				await this.app.vault.createFolder(normalized);
			} catch {
				// folder may already exist
			}
		}
	}

	private lastMarkdownPathById: Map<string, string> = new Map();

	/** Resolves the per-title `.md` path — the same scheme used to create it. */
	getNoteFilePath(title: WatchLogTitle): string {
		const root = this.plugin.settings.rootFolder;
		const safeTitle = title.title.replace(/[*"\\/<>:|?]/g, '-');
		return normalizePath(`${root}/${title.type}/${safeTitle}.md`);
	}

	async updateMarkdownFile(title: WatchLogTitle): Promise<void> {
		const root = this.plugin.settings.rootFolder;
		const folderPath = normalizePath(`${root}/${title.type}`);
		await this.ensureFolder(folderPath);
		const filePath = this.getNoteFilePath(title);
		const progress = this.getProgress(title);
		const content = this.buildMarkdownContent(title, progress);

		// remove the stale file first when the path changed (rename / type change)
		const previousPath = this.lastMarkdownPathById.get(title.id);
		if (previousPath && previousPath !== filePath) {
			try {
				const oldFile = this.app.vault.getAbstractFileByPath(previousPath);
				if (oldFile instanceof TFile) {
					await this.app.fileManager.trashFile(oldFile);
				}
			} catch {
				// best-effort cleanup
			}
		}

		const existing = this.app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			// body-preserving update: swap the leading frontmatter block, then replace ONLY the `## Notes`
			// body. Everything else is kept verbatim — no append, no dupes (mirrors the Reading path).
			const current = await this.app.vault.read(existing);
			let updated = this.rebuildWithFrontmatter(current, this.buildFrontmatter(title, progress));
			updated = this.replaceNotesSection(updated, title.notes);
			if (updated !== current) {
				await this.app.vault.modify(existing, updated);
			}
		} else {
			// new file: write the full template (frontmatter + ## Notes from title.notes)
			await this.app.vault.create(filePath, content);
		}
		this.lastMarkdownPathById.set(title.id, filePath);
	}

	/**
	 * Replaces only the leading `---…---` frontmatter block, preserving the body; prepends it when
	 * the file has none. Mirrors ReadingDataManager.rebuildWithFrontmatter.
	 */
	private rebuildWithFrontmatter(existing: string, frontmatter: string): string {
		const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
		if (fmMatch) {
			return frontmatter + '\n' + existing.slice(fmMatch[0].length);
		}
		// no frontmatter found — prepend it
		return frontmatter + '\n\n' + existing;
	}

	/**
	 * Reads the `## Notes` body back from a title note. null when the file or section is absent.
	 * Lets manual .md edits flow back into the plugin.
	 */
	async readNotesFromFile(title: WatchLogTitle): Promise<string | null> {
		const filePath = this.getNoteFilePath(title);
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			// diagnostic: the resolved path matched no real file — the likely culprit if read-back ever
			// stops working (sanitization / folder / rename mismatch)
			console.warn(
				`[WatchLog] Notes read: no note file at resolved path "${filePath}" for title "${title.title}"`,
			);
			return null;
		}
		const content = await this.app.vault.read(file);
		const match = content.match(/(^|\n)## Notes[ \t]*\r?\n([\s\S]*?)(?=\n## |\n# |$)/);
		if (!match) return null;
		// strip the template's leading blank line and trailing whitespace, keep internal breaks
		return (match[2] ?? '').replace(/^\n+/, '').replace(/\s+$/, '');
	}

	/**
	 * Pulls the on-disk `## Notes` body into the in-memory title, so a later
	 * updateMarkdownFile() can't clobber edits made directly in the .md.
	 */
	async syncNotesFromFile(titleId: string): Promise<void> {
		const title = this.getTitle(titleId);
		if (!title) return;
		const fileNotes = await this.readNotesFromFile(title);
		if (fileNotes === null || fileNotes === title.notes) return;
		title.notes = fileNotes;
		this.updateTitleSilent(title);
		await this.persist();
	}

	/**
	 * Replaces the `## Notes` body, preserving the heading, every other section, the frontmatter and
	 * any prose outside it. Appends the heading when missing (never duplicated). The boundary matches
	 * readNotesFromFile, so read-then-write round-trips cleanly.
	 */
	private replaceNotesSection(existing: string, notesBody: string): string {
		const headingMatch = existing.match(/(^|\n)## Notes[ \t]*\r?\n/);
		if (!headingMatch || headingMatch.index === undefined) {
			const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
			return `${existing}${sep}\n## Notes\n\n${notesBody}\n`;
		}
		const bodyStart = headingMatch.index + headingMatch[0].length;
		const after = existing.slice(bodyStart);
		const nextHeading = after.match(/\n(?:## |# )/);
		const bodyEnd =
			nextHeading && nextHeading.index !== undefined
				? bodyStart + nextHeading.index
				: existing.length;
		const before = existing.slice(0, bodyStart);
		const rest = existing.slice(bodyEnd);
		return `${before}\n${notesBody}\n${rest}`;
	}

	async createMarkdownFileIfMissing(title: WatchLogTitle): Promise<boolean> {
		const root = this.plugin.settings.rootFolder;
		const folderPath = normalizePath(`${root}/${title.type}`);
		const filePath = this.getNoteFilePath(title);
		if (this.app.vault.getAbstractFileByPath(filePath) instanceof TFile) return false;
		await this.ensureFolder(normalizePath(root));
		await this.ensureFolder(folderPath);
		const content = this.buildMarkdownContent(title, this.getProgress(title));
		await this.app.vault.create(filePath, content);
		return true;
	}

	/**
	 * Rewrites ONLY the frontmatter of an existing title note, body verbatim. Does NOT create the
	 * file — returns false then. Powers the bulk "Rewrite all frontmatter" action.
	 */
	async rewriteFrontmatterIfExists(title: WatchLogTitle): Promise<boolean> {
		const filePath = this.getNoteFilePath(title);
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return false;
		const current = await this.app.vault.read(file);
		const updated = this.rebuildWithFrontmatter(current, this.buildFrontmatter(title, this.getProgress(title)));
		if (updated !== current) {
			await this.app.vault.modify(file, updated);
		}
		this.lastMarkdownPathById.set(title.id, filePath);
		return true;
	}

	/**
	 * YAML-quotes a value (escaping backslashes and double quotes) so a `:` in a title or URL can't
	 * break the frontmatter. Empty → `""`.
	 */
	private yamlEscape(value: string): string {
		if (value === '') return '""';
		return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	}

	/** The leading `---…---` frontmatter block (no trailing newline). */
	private buildFrontmatter(title: WatchLogTitle, progress: number): string {
		const esc = (v: string): string => this.yamlEscape(v);
		const lines: string[] = ['---'];
		// text values go through yamlEscape; numbers/booleans/dates emit unquoted. absent optional fields
		// are omitted
		lines.push(`title: ${esc(title.title)}`);
		lines.push(`type: ${esc(title.type)}`);
		lines.push(`status: ${esc(title.status)}`);
		lines.push(`priority: ${esc(title.priority)}`);
		if (title.review) lines.push(`review: ${esc(title.review)}`);
		lines.push(`rating: ${title.rating}`);
		lines.push(`progress: ${progress}%`);
		lines.push(`totalEpisodes: ${title.totalEpisodes}`);
		lines.push(`episodeDuration: ${title.episodeDuration}`);
		lines.push(`dateStarted: ${title.dateStarted ?? 'null'}`);
		lines.push(`dateFinished: ${title.dateFinished ?? 'null'}`);
		lines.push(`dateAdded: ${esc(title.dateAdded)}`);
		lines.push(`dateModified: ${esc(title.dateModified)}`);
		if (title.releaseDate) lines.push(`releaseDate: ${title.releaseDate}`);
		if (title.malId !== undefined) lines.push(`malId: ${title.malId}`);
		if (title.anilistId !== undefined) lines.push(`anilistId: ${title.anilistId}`);
		if (title.communityRating !== undefined) lines.push(`communityRating: ${title.communityRating}`);
		if (title.communityVotes !== undefined) lines.push(`communityVotes: ${title.communityVotes}`);
		if (title.communitySource) lines.push(`communitySource: ${esc(title.communitySource)}`);
		// inline YAML arrays of the merged view — fetched names plus user-added, uncapped. unfetched and
		// 'none' are both omitted
		const director = getTitleCredits(title, 'director');
		if (director.length > 0) lines.push(`director: [${director.map(esc).join(', ')}]`);
		const cast = getTitleCredits(title, 'cast');
		if (cast.length > 0) lines.push(`cast: [${cast.map(esc).join(', ')}]`);
		const studio = getTitleCredits(title, 'studio');
		if (studio.length > 0) lines.push(`studio: [${studio.map(esc).join(', ')}]`);
		// single resolved poster (manual override if set, else auto-fetched)
		const poster = getDisplayPoster(title);
		if (poster && poster !== 'none') lines.push(`poster: ${esc(poster)}`);
		// single resolved trailer (manual override if set, else auto-fetched)
		const trailer = getDisplayTrailer(title);
		if (trailer) lines.push(`trailer: ${esc(trailer)}`);
		if (title.externalLink) lines.push(`externalLink: ${esc(title.externalLink)}`);
		if (title.pinned) lines.push(`pinned: true`);
		if (title.favorite) lines.push(`favorite: true`);
		lines.push('---');
		return lines.join('\n');
	}

	/** Full note template (frontmatter + ## Notes body). Only used when creating a file. */
	private buildMarkdownContent(title: WatchLogTitle, progress: number): string {
		return `${this.buildFrontmatter(title, progress)}

## Notes

${title.notes}
`;
	}

	private async deleteMarkdownFile(title: WatchLogTitle): Promise<void> {
		const filePath = this.getNoteFilePath(title);
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			await this.app.fileManager.trashFile(file);
		}
	}

	// Dashboard helpers

	getRecentlyWatched(count: number): WatchLogTitle[] {
		return [...(this.data.titles ?? [])]
			.filter((t) => t.watchedEpisodes.length > 0 || t.status === 'Completed')
			.sort((a, b) => b.dateModified.localeCompare(a.dateModified))
			.slice(0, count);
	}

	getRecentlyAdded(count: number): WatchLogTitle[] {
		return [...(this.data.titles ?? [])]
			.sort((a, b) => b.dateAdded.localeCompare(a.dateAdded))
			.slice(0, count);
	}

	getStatsByType(type: string): { watched: number; total: number } {
		const EXCLUDED = ['Dropped', 'To be released'];
		const all = this.data.titles ?? [];
		const titles = (type === 'All' ? all : all.filter((t) => t.type === type))
    		.filter((t) => !EXCLUDED.includes(t.status));
		const total = titles.length;
		const watched = titles.filter((t) => t.status === 'Completed').length;
		return { watched, total };
	}

	getCompletedCount(): number {
		return (this.data.titles ?? []).filter((t) => t.status === 'Completed').length;
	}

	// ID generation

	generateId(title: string): string {
		let id = title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '');
		const existing = (this.data.titles ?? []).map((t) => t.id);
		if (!existing.includes(id)) return id;
		let counter = 2;
		while (existing.includes(`${id}-${counter}`)) {
			counter++;
		}
		return `${id}-${counter}`;
	}
}
