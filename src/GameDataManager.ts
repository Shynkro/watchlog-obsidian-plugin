import { normalizePath, TFile } from 'obsidian';
import type WatchLogPlugin from './main';
import type { HistoryManager } from './HistoryManager';
import {
	Game,
	GameGroup,
	GamesData,
	GamesSettings,
	GamesSavedFilterPreset,
	RecommendedDaily,
	SteamSyncUpdate,
	CustomProperty,
	defaultGamesSettings,
	GAME_AUTO_STATUS,
	GAME_FINISHED_STATUS,
	GAME_TBA_STATUS,
	isReleaseDateFuture,
	parsePlaytimeInput,
	formatTime,
	todayIso,
	TagDefinition,
} from './types';
import {
	appendCustomPropertyLines,
	normalizeCustomPropertyList,
} from './CustomProperties';

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

/**
 * Owns the games dataset — the `games` key inside data.json (the Reading pattern: bound to
 * DataManager's master object, persisted through DataManager.persist() so Sync replicates it) —
 * plus the per-game notes at `<defaultFolder>/<Title>.md`.
 *
 * Upcoming mirrors Reading's: a game with a future release date is auto-added to the shared
 * tracker (entry ids prefixed `airtime-game-`) and removed when the date passes or the game is
 * deleted; applyReleaseStatus maintains the auto "To be released" status.
 */
export class GameDataManager {
	private plugin: WatchLogPlugin;
	private data: GamesData;
	private changeListeners: Array<() => void> = [];
	private historyManager: HistoryManager | null = null;

	constructor(plugin: WatchLogPlugin) {
		this.plugin = plugin;
		this.data = this.emptyData();
	}

	setHistoryManager(hm: HistoryManager): void {
		this.historyManager = hm;
	}

	private emptyData(): GamesData {
		return {
			games: [],
			groups: [],
			settings: defaultGamesSettings(),
		};
	}

	/** The single saveData object (owned by DataManager) that holds games data. */
	private get master() {
		return this.plugin.dataManager.getData();
	}

	/**
	 * Reads the games dataset from the shared `data.games` key (in memory, not a file), normalizes it,
	 * and binds `master.games` to our canonical reference so later mutations reach the object
	 * DataManager persists.
	 */
	private bindFromMaster(): void {
		const parsed = this.master.games as Partial<GamesData> | undefined;
		if (parsed && typeof parsed === 'object') {
			this.data = {
				games: Array.isArray(parsed.games) ? parsed.games : [],
				groups: Array.isArray(parsed.groups) ? parsed.groups : [],
				settings: { ...defaultGamesSettings(), ...(parsed.settings ?? {}) },
			};
		} else {
			this.data = this.emptyData();
		}
		this.master.games = this.data;
	}

	async load(): Promise<void> {
		this.bindFromMaster();
		const changed = this.migrate();
		if (changed) {
			await this.saveOnly();
		}
		// additive reconcile: every future-dated game gets an Upcoming entry. Never removes, so
		// manually-scheduled entries survive reloads.
		const dm = this.plugin.dataManager;
		if (dm) {
			for (const g of this.data.games) if (isReleaseDateFuture(g.releaseDate)) await dm.autoAddGameToUpcoming(g);
		}
	}

	/**
	 * Mirrors the watchlist auto-add: a game with a future release date joins the shared Upcoming
	 * tracker and leaves once the date passes or is cleared.
	 */
	private async syncUpcoming(game: Game): Promise<void> {
		const dm = this.plugin.dataManager;
		if (!dm) return;
		if (isReleaseDateFuture(game.releaseDate)) {
			await dm.autoAddGameToUpcoming(game);
		} else {
			await dm.removeGameAirtimeEntries(game.id);
		}
	}

	/** Ensures every record has the full set of fields with sensible defaults. */
	private migrate(): boolean {
		let changed = false;

		const s = this.data.settings;
		if (!Array.isArray(s.statuses) || s.statuses.length === 0) {
			s.statuses = defaultGamesSettings().statuses;
			changed = true;
		}
		if (!Array.isArray(s.types) || s.types.length === 0) {
			s.types = defaultGamesSettings().types;
			changed = true;
		}
		const normalizedProps = normalizeCustomPropertyList(s.customProperties);
		if (!Array.isArray(s.customProperties) || JSON.stringify(normalizedProps) !== JSON.stringify(s.customProperties)) {
			s.customProperties = normalizedProps;
			changed = true;
		}

		if (!Array.isArray(s.platforms)) {
			s.platforms = defaultGamesSettings().platforms;
			changed = true;
		} else {
			// platforms became coloured TagDefinitions (Settings → Customize → Games); older installs stored
			// plain name strings — convert in place, reusing the default colour for names we ship.
			// `Game.platforms` stores names, so no game record needs touching.
			const defaults = defaultGamesSettings().platforms;
			const upgraded = s.platforms.map((p): TagDefinition => {
				if (typeof p === 'string') {
					return { name: p, color: defaults.find((d) => d.name === p)?.color ?? '#888780' };
				}
				return p;
			});
			if (upgraded.some((p, i) => p !== s.platforms[i])) {
				s.platforms = upgraded;
				changed = true;
			}
		}

		// one-time: 'Wishlist' stopped being a status and became the `wishlist` flag, freeing its slot for
		// the manual TBA status. Gated on the old status still being present, so a user-deleted TBA is not
		// re-added.
		const wishlistIdx = s.statuses.findIndex((st) => st.name === 'Wishlist');
		if (wishlistIdx !== -1) {
			for (const g of this.data.games) {
				if (g.status === 'Wishlist') {
					g.wishlist = true;
					g.status = s.defaultStatus || 'Not started';
				}
			}
			if (s.statuses.some((st) => st.name === GAME_TBA_STATUS)) {
				s.statuses.splice(wishlistIdx, 1);
			} else {
				s.statuses[wishlistIdx] = { name: GAME_TBA_STATUS, color: '#EAB308' };
			}
			if (s.defaultStatus === 'Wishlist') s.defaultStatus = 'Not started';
			// a stored "exclude Wishlist" would otherwise linger forever as an active filter with no checkbox
			// left to clear it
			const preset = s.savedFilterPreset;
			if (preset) {
				preset.statusExclude = preset.statusExclude.filter((n) => n !== 'Wishlist');
			}
			const live = this.plugin.settings?.gamesFilters;
			if (live?.statusExclude?.includes('Wishlist')) {
				live.statusExclude = live.statusExclude.filter((n) => n !== 'Wishlist');
				void this.plugin.saveSettings();
			}
			changed = true;
		}

		for (const g of this.data.games) {
			if (typeof g.developer !== 'string') { g.developer = ''; changed = true; }
			if (typeof g.publisher !== 'string') { g.publisher = ''; changed = true; }
			if (typeof g.type !== 'string') { g.type = ''; changed = true; }
			if (typeof g.priority !== 'string') { g.priority = ''; changed = true; }
			if (typeof g.favorite !== 'boolean') { g.favorite = false; changed = true; }
			// set true just above for games carrying the retired 'Wishlist' status
			if (typeof g.wishlist !== 'boolean') { g.wishlist = false; changed = true; }
			if (typeof g.rating !== 'number') { g.rating = 0; changed = true; }
			if (typeof g.progress !== 'number') { g.progress = 0; changed = true; }
			// playtime used to be a freeform string ("42h 30m"); it is minutes now so it can be sorted and
			// totalled. Parse the old value once, then drop it.
			const legacy = g as Game & { playtime?: unknown };
			if (typeof g.playtimeMinutes !== 'number') {
				g.playtimeMinutes = typeof legacy.playtime === 'string'
					? parsePlaytimeInput(legacy.playtime)
					: 0;
				changed = true;
			}
			if (legacy.playtime !== undefined) { delete legacy.playtime; changed = true; }
			if (typeof g.achievementsEarned !== 'number') { g.achievementsEarned = 0; changed = true; }
			if (typeof g.achievementsTotal !== 'number') { g.achievementsTotal = 0; changed = true; }
			if (!Array.isArray(g.platforms)) { g.platforms = []; changed = true; }
			if (typeof g.singleplayer !== 'boolean') { g.singleplayer = false; changed = true; }
			// games stored before Co-op existed backfill false — the old two-mode data can't tell co-op apart
			// from generic multiplayer
			if (typeof g.coop !== 'boolean') { g.coop = false; changed = true; }
			if (typeof g.multiplayer !== 'boolean') { g.multiplayer = false; changed = true; }
			if (typeof g.storeUrl !== 'string') { g.storeUrl = ''; changed = true; }
			if (typeof g.coverUrl !== 'string') { g.coverUrl = ''; changed = true; }
			// games added before the API-id fields backfill empty and resolve their source on the first
			// title-based cover lookup
			if (g.apiSource !== 'rawg' && g.apiSource !== 'igdb') { g.apiSource = ''; changed = true; }
			if (typeof g.apiId !== 'string') { g.apiId = ''; changed = true; }
			// Steam link + last-played backfill empty; the first sync fills them in, seeding steamAppId from
			// storeUrl where one is stored
			if (typeof g.steamAppId !== 'string') { g.steamAppId = ''; changed = true; }
			if (g.lastPlayed !== null && typeof g.lastPlayed !== 'string') { g.lastPlayed = null; changed = true; }
			if (typeof g.externalLink !== 'string') { g.externalLink = ''; changed = true; }
			if (typeof g.vaultPage !== 'string') { g.vaultPage = ''; changed = true; }
			if (g.releaseDate === undefined) { g.releaseDate = null; changed = true; }
			if (g.dateStarted === undefined) { g.dateStarted = null; changed = true; }
			if (g.dateFinished === undefined) { g.dateFinished = null; changed = true; }
			if (!g.dateAdded) { g.dateAdded = new Date().toISOString(); changed = true; }
			if (!g.dateModified) { g.dateModified = g.dateAdded; changed = true; }
			if (!g.customFields || typeof g.customFields !== 'object') {
				g.customFields = {};
				changed = true;
			}
		}

		if (!Array.isArray(this.data.groups)) {
			this.data.groups = [];
			changed = true;
		}
		for (const group of this.data.groups) {
			if (!Array.isArray(group.gameIds)) { group.gameIds = []; changed = true; }
			if (!group.dateAdded) { group.dateAdded = new Date().toISOString(); changed = true; }
		}

		// reconcile the auto "To be released" status against each release date
		for (const g of this.data.games) if (this.applyReleaseStatus(g)) changed = true;

		return changed;
	}

	/**
	 * Forces "To be released" when the release date is in the future and reverts to the default status
	 * once it passes or is cleared. Returns true if changed.
	 */
	private applyReleaseStatus(game: Game): boolean {
		const future = isReleaseDateFuture(game.releaseDate);
		if (future) {
			if (game.status !== GAME_AUTO_STATUS) {
				game.status = GAME_AUTO_STATUS;
				return true;
			}
		} else if (game.status === GAME_AUTO_STATUS) {
			game.status = this.data.settings.defaultStatus || 'Not started';
			return true;
		}
		return false;
	}

	getData(): GamesData {
		return this.data;
	}

	getSettings(): GamesSettings {
		return this.data.settings;
	}

	async updateSettings(patch: Partial<GamesSettings>): Promise<void> {
		this.data.settings = { ...this.data.settings, ...patch };
		await this.save();
	}

	getCustomProperties(): CustomProperty[] {
		return this.data.settings.customProperties ?? [];
	}

	/** Replace the property schema; removes deleted ids from every game's customFields. */
	async setCustomProperties(next: CustomProperty[]): Promise<void> {
		const prevIds = new Set((this.data.settings.customProperties ?? []).map((p) => p.id));
		const nextIds = new Set(next.map((p) => p.id));
		const removed = [...prevIds].filter((id) => !nextIds.has(id));
		this.data.settings.customProperties = next;
		if (removed.length > 0) {
			for (const g of this.data.games) {
				if (!g.customFields) continue;
				for (const id of removed) delete g.customFields[id];
			}
		}
		await this.save();
	}

	async setCustomField(gameId: string, propId: string, value: string | number | null): Promise<void> {
		const game = this.getGame(gameId);
		if (!game) return;
		if (!game.customFields) game.customFields = {};
		if (value === null || value === '') delete game.customFields[propId];
		else game.customFields[propId] = value;
		game.dateModified = new Date().toISOString();
		await this.save();
		try {
			await this.rewriteFrontmatterIfExists(game);
		} catch {
			// note may not exist yet
		}
	}

	/**
	 * Persist without notifying — for state the rendering tab wrote itself (rows layout, daily picks):
	 * it re-renders on its own, and a notify here would double the render.
	 */
	persistQuiet(): void {
		void this.saveOnly();
	}

	// Daily "Recommended" picks (the Watchlist RecommendedDaily pattern)

	getRecommendedDaily(): RecommendedDaily {
		return this.data.recommendedDaily ?? { date: '', ids: [] };
	}

	/** Silent — the Rows view that rolled the picks renders them itself. */
	setRecommendedDaily(rec: RecommendedDaily): void {
		this.data.recommendedDaily = rec;
		void this.saveOnly();
	}

	// Saved filter preset (the Watchlist pattern)

	getSavedFilterPreset(): GamesSavedFilterPreset | null {
		return this.data.settings.savedFilterPreset ?? null;
	}

	async setSavedFilterPreset(preset: GamesSavedFilterPreset | null): Promise<void> {
		this.data.settings.savedFilterPreset = preset;
		await this.saveOnly();
	}

	// Persistence

	private async saveOnly(): Promise<void> {
		try {
			// keep the master reference pointed at our current data (an external sync reload may have replaced
			// the master object), then persist all of data.json
			this.master.games = this.data;
			await this.plugin.dataManager.persist();
		} catch (e) {
			console.warn('[WL] GameDataManager.save failed:', e);
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

	/** Persist + notify after a run of silent mutations (the Reading pattern). */
	async saveAndNotify(): Promise<void> {
		await this.save();
	}

	/**
	 * Overwrite the entire games dataset from a backup, then reload through load() (migration) and
	 * notify listeners.
	 */
	async restore(data: GamesData): Promise<void> {
		this.master.games = data;
		await this.plugin.dataManager.persist();
		await this.load();
		this.notifyListeners();
	}

	// Listeners

	onChange(listener: () => void): void {
		this.changeListeners.push(listener);
	}

	offChange(listener: () => void): void {
		this.changeListeners = this.changeListeners.filter((l) => l !== listener);
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
	 * notify — the card that triggered the fetch swaps its own <img>, so the grid is not rebuilt and
	 * the scroll position survives.
	 */
	updateCoverUrl(id: string, url: string): void {
		const game = this.getGame(id);
		if (!game) return;
		game.coverUrl = url;
		if (this.coverSaveTimer !== null) return;
		this.coverSaveTimer = window.setTimeout(() => {
			this.coverSaveTimer = null;
			void this.saveOnly();
		}, this.COVER_SAVE_DEBOUNCE_MS);
	}

	/**
	 * Silent cover update that also stores the API source + id a title-based lookup resolved, so later
	 * re-fetches take the cheap id path. Same debounced, no-notify contract.
	 */
	updateCoverAndSource(id: string, url: string, source: 'rawg' | 'igdb', apiId: string): void {
		const game = this.getGame(id);
		if (!game) return;
		game.apiSource = source;
		game.apiId = apiId;
		this.updateCoverUrl(id, url);
	}

	/** Flush a pending debounced cover save now (e.g. on plugin unload). */
	flushCoverSave(): void {
		if (this.coverSaveTimer !== null) {
			window.clearTimeout(this.coverSaveTimer);
			this.coverSaveTimer = null;
			void this.saveOnly();
		}
	}

	// Games CRUD

	getGames(): Game[] {
		return this.data.games;
	}

	getGame(id: string): Game | undefined {
		return this.data.games.find((g) => g.id === id);
	}

	async addGame(game: Game): Promise<void> {
		this.applyReleaseStatus(game);
		this.data.games.push(game);
		await this.save();
		await this.syncUpcoming(game);
		try { await this.writeGameNote(game); } catch (e) { console.warn('[WL] writeGameNote failed:', e); }
		void this.historyManager?.log(
			`${game.title} (Game) was added`,
			{ source: 'Games', action: 'added', titleName: game.title },
		);
	}

	async updateGame(updated: Game): Promise<void> {
		updated.dateModified = new Date().toISOString();
		this.applyReleaseStatus(updated);
		const idx = this.data.games.findIndex((g) => g.id === updated.id);
		if (idx >= 0) {
			const old = this.data.games[idx]!;
			// favorite arrives as a whole-object replace — stamp/clear off the transition. Drives the
			// Favorites shelf order (newest first).
			if (old.favorite !== updated.favorite) {
				if (updated.favorite) updated.dateFavorited = new Date().toISOString();
				else delete updated.dateFavorited;
			}
			if (old.status !== updated.status) {
				const act = updated.status === GAME_FINISHED_STATUS ? 'completed' as const : 'status' as const;
				// mirror the watch behavior: stamp today's finish date on the transition to Finished
				if (updated.status === GAME_FINISHED_STATUS && this.plugin.settings.setFinishDateAutomatically && !updated.dateFinished) {
					updated.dateFinished = todayIso();
				}
				void this.historyManager?.log(
					`${updated.title} (Game) status changed to ${updated.status}`,
					{ source: 'Games', action: act, titleName: updated.title },
				);
			}
			if (old.rating !== updated.rating) {
				void this.historyManager?.log(
					`${updated.title} (Game) Rating → ${updated.rating}/5`,
					{ source: 'Games', action: 'rating', titleName: updated.title },
				);
			}
			this.data.games[idx] = updated;
			await this.save();
			// reconcile Upcoming only on a release-date change (never on rating/status/progress edits), so
			// manually-scheduled entries survive
			if (old.releaseDate !== updated.releaseDate) await this.syncUpcoming(updated);
			try { await this.writeGameNote(updated); } catch (e) { console.warn('[WL] writeGameNote failed:', e); }
		}
	}

	updateGameSilent(updated: Game): void {
		updated.dateModified = new Date().toISOString();
		this.applyReleaseStatus(updated);
		const idx = this.data.games.findIndex((g) => g.id === updated.id);
		if (idx >= 0) {
			this.data.games[idx] = updated;
		}
	}

	async removeGame(id: string): Promise<void> {
		const game = this.getGame(id);
		this.data.games = this.data.games.filter((g) => g.id !== id);
		for (const group of this.data.groups) {
			group.gameIds = group.gameIds.filter((gid) => gid !== id);
		}
		await this.save();
		await this.plugin.dataManager?.removeGameAirtimeEntries(id);
		if (game) {
			void this.historyManager?.log(
				`${game.title} (Game) was deleted`,
				{ source: 'Games', action: 'deleted', titleName: game.title },
			);
			try { await this.deleteGameNote(game); } catch (e) { console.warn('[WL] deleteGameNote failed:', e); }
		}
	}

	/** Batch delete with chunked note-file removal (the Reading pattern). */
	async removeGamesBatch(ids: string[]): Promise<void> {
		const CHUNK = 10;
		const toDelete: Game[] = [];
		for (const id of ids) {
			const game = this.getGame(id);
			if (game) toDelete.push(game);
		}
		this.data.games = this.data.games.filter((g) => !ids.includes(g.id));
		for (const group of this.data.groups) {
			group.gameIds = group.gameIds.filter((gid) => !ids.includes(gid));
		}
		await this.save();
		for (const id of ids) await this.plugin.dataManager?.removeGameAirtimeEntries(id);
		for (const game of toDelete) {
			void this.historyManager?.log(
				`${game.title} (Game) was deleted`,
				{ source: 'Games', action: 'deleted', titleName: game.title },
			);
		}
		for (let i = 0; i < toDelete.length; i += CHUNK) {
			const chunk = toDelete.slice(i, i + CHUNK);
			await Promise.all(chunk.map((g) => this.deleteGameNote(g).catch(() => {})));
		}
	}

	/**
	 * Writes a batch of Steam sync results: playtime, achievements, last-played and the steamAppId
	 * link. Steam is authoritative for those, so they overwrite unconditionally — everything else on
	 * the game (status, rating, priority, favorite, wishlist, notes) is left alone.
	 *
	 * Deliberately no dateModified stamp: a sync is not a user edit, and stamping it would shove the
	 * whole library to the top of every recently-modified ordering at once. `lastPlayed` carries the
	 * real signal.
	 *
	 * One save + notify for the whole batch; note frontmatter is rewritten in chunks.
	 */
	async applySteamSync(updates: SteamSyncUpdate[]): Promise<number> {
		const CHUNK = 10;
		const touched: Game[] = [];

		for (const u of updates) {
			const game = this.getGame(u.gameId);
			if (!game) continue;
			game.steamAppId = u.steamAppId;
			game.playtimeMinutes = u.playtimeMinutes;
			game.lastPlayed = u.lastPlayed;
			if (u.achievements) {
				game.achievementsTotal = u.achievements.total;
				game.achievementsEarned = u.achievements.earned;
			}
			// a game Steam has no store link for yet gets one for free
			if (game.storeUrl === '' && u.steamAppId !== '') {
				game.storeUrl = `https://store.steampowered.com/app/${u.steamAppId}/`;
			}
			touched.push(game);
		}

		if (touched.length === 0) return 0;
		await this.save();
		for (let i = 0; i < touched.length; i += CHUNK) {
			const chunk = touched.slice(i, i + CHUNK);
			await Promise.all(chunk.map((g) => this.writeGameNote(g).catch(() => {})));
		}
		return touched.length;
	}

	// Group CRUD (the WatchLogGroup pattern)

	getGroups(): GameGroup[] {
		return this.data.groups ?? [];
	}

	getGroup(id: string): GameGroup | undefined {
		return (this.data.groups ?? []).find((g) => g.id === id);
	}

	async addGroup(group: GameGroup): Promise<void> {
		this.data.groups.push(group);
		await this.save();
	}

	async updateGroup(updated: GameGroup): Promise<void> {
		const idx = this.data.groups.findIndex((g) => g.id === updated.id);
		if (idx >= 0) {
			this.data.groups[idx] = updated;
			await this.save();
		}
	}

	/** Deletes the group only — its games return to the main grid untouched. */
	async removeGroup(id: string): Promise<void> {
		this.data.groups = this.data.groups.filter((g) => g.id !== id);
		await this.save();
	}

	async addGameToGroup(groupId: string, gameId: string): Promise<void> {
		const group = this.getGroup(groupId);
		if (!group) return;
		if (!group.gameIds.includes(gameId)) {
			group.gameIds.push(gameId);
			await this.updateGroup(group);
		}
	}

	getGroupedGameIds(): Set<string> {
		const ids = new Set<string>();
		for (const group of (this.data.groups ?? [])) {
			for (const id of group.gameIds) {
				ids.add(id);
			}
		}
		return ids;
	}

	generateGroupId(name: string): string {
		const base = 'group-' + (slugify(name) || 'unnamed');
		const existing = new Set((this.data.groups ?? []).map((g) => g.id));
		if (!existing.has(base)) return base;
		let counter = 2;
		while (existing.has(`${base}-${counter}`)) counter++;
		return `${base}-${counter}`;
	}

	generateGameId(title: string): string {
		const base = slugify(title) || 'game';
		const existing = new Set(this.data.games.map((g) => g.id));
		if (!existing.has(base)) return base;
		let counter = 2;
		while (existing.has(`${base}-${counter}`)) counter++;
		return `${base}-${counter}`;
	}

	// Game note files

	private gamesFolder(): string {
		return normalizePath(this.data.settings.defaultFolder || 'WatchLog/Games');
	}

	noteFilePath(title: string): string {
		const safe = sanitizeFilename(title) || 'game';
		return normalizePath(`${this.gamesFolder()}/${safe}.md`);
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

	private buildFrontmatter(game: Game): string {
		const lines: string[] = ['---'];
		lines.push(`title: ${yamlEscape(sanitizeFilename(game.title))}`);
		lines.push(`developer: ${yamlEscape(game.developer ?? '')}`);
		lines.push(`publisher: ${yamlEscape(game.publisher ?? '')}`);
		// `genre` carries the in-app "type" field; the `type:` key stays the cross-note kind marker
		// (book / manga / game), like the Reading notes
		lines.push(`genre: ${yamlEscape(game.type ?? '')}`);
		lines.push(`status: ${yamlEscape(game.status)}`);
		if (game.priority) lines.push(`priority: ${yamlEscape(game.priority)}`);
		if (game.favorite) lines.push('favorite: true');
		if (game.wishlist) lines.push('wishlist: true');
		lines.push(`rating: ${game.rating | 0}`);
		lines.push(`progress: ${game.progress | 0}`);
		if (game.playtimeMinutes > 0) lines.push(`playtime: ${formatTime(game.playtimeMinutes)}`);
		if (game.achievementsTotal > 0) {
			lines.push(`achievements: ${game.achievementsEarned}/${game.achievementsTotal}`);
		}
		if (game.platforms.length > 0) {
			lines.push('platforms:');
			for (const p of game.platforms) lines.push(`  - ${yamlEscape(p)}`);
		}
		if (game.singleplayer) lines.push('singleplayer: true');
		if (game.coop) lines.push('coop: true');
		if (game.multiplayer) lines.push('multiplayer: true');
		lines.push(`dateStarted: ${game.dateStarted ?? 'null'}`);
		lines.push(`dateFinished: ${game.dateFinished ?? 'null'}`);
		lines.push(`releaseDate: ${game.releaseDate ?? 'null'}`);
		lines.push(`dateAdded: ${yamlEscape(game.dateAdded)}`);
		lines.push(`dateModified: ${yamlEscape(game.dateModified)}`);
		if (game.coverUrl) lines.push(`coverUrl: ${yamlEscape(game.coverUrl)}`);
		if (game.storeUrl) lines.push(`storeUrl: ${yamlEscape(game.storeUrl)}`);
		if (game.externalLink) lines.push(`externalLink: ${yamlEscape(game.externalLink)}`);
		lines.push('type: game');
		appendCustomPropertyLines(
			lines,
			normalizeCustomPropertyList(this.data.settings.customProperties),
			game.customFields,
			yamlEscape,
		);
		lines.push('---');
		return lines.join('\n');
	}

	private buildInitialNoteContent(game: Game): string {
		return `${this.buildFrontmatter(game)}\n\n## Notes\n`;
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

	/** Writes (creates or updates) the note file. Preserves the body when it exists. */
	async writeGameNote(game: Game): Promise<string> {
		await this.ensureFolder(this.gamesFolder());
		const filePath = this.noteFilePath(game.title);
		const frontmatter = this.buildFrontmatter(game);

		// handle rename: trash the previous file if the path changed
		const previousPath = this.lastNotePathById.get(game.id);
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
			await this.plugin.app.vault.create(filePath, this.buildInitialNoteContent(game));
		}
		this.lastNotePathById.set(game.id, filePath);
		return filePath;
	}

	async ensureGameNote(game: Game): Promise<string> {
		const filePath = this.noteFilePath(game.title);
		const existing = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			this.lastNotePathById.set(game.id, filePath);
			return filePath;
		}
		return this.writeGameNote(game);
	}

	/** Creates the note file only if missing; true when one was created. */
	async createGameNoteIfMissing(game: Game): Promise<boolean> {
		const filePath = this.noteFilePath(game.title);
		if (this.plugin.app.vault.getAbstractFileByPath(filePath) instanceof TFile) return false;
		await this.writeGameNote(game);
		return true;
	}

	/**
	 * Rewrites ONLY the frontmatter of an existing game note, body verbatim. Does NOT create the file
	 * when missing — returns false. Used by the bulk "Rewrite all frontmatter" action.
	 */
	async rewriteFrontmatterIfExists(game: Game): Promise<boolean> {
		const filePath = this.noteFilePath(game.title);
		const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return false;
		const current = await this.plugin.app.vault.read(file);
		const updated = this.rebuildWithFrontmatter(current, this.buildFrontmatter(game));
		if (updated !== current) {
			await this.plugin.app.vault.modify(file, updated);
		}
		this.lastNotePathById.set(game.id, filePath);
		return true;
	}

	async readGameNote(game: Game): Promise<string | null> {
		const filePath = this.noteFilePath(game.title);
		const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return null;
		return this.plugin.app.vault.read(file);
	}

	/**
	 * Reads the `## Notes` body back from the game's note file. null when the file or section is
	 * absent, so edits made directly in the .md flow back into the modal.
	 */
	async readGameNotes(game: Game): Promise<string | null> {
		const content = await this.readGameNote(game);
		if (content === null) return null;
		const match = content.match(/(^|\n)## Notes[ \t]*\r?\n([\s\S]*?)(?=\n## |\n# |$)/);
		if (!match) return null;
		// strip the template's leading blank line and trailing whitespace, keep internal breaks
		return (match[2] ?? '').replace(/^\n+/, '').replace(/\s+$/, '');
	}

	/**
	 * Replaces only the `## Notes` body, preserving the heading, frontmatter and any other sections
	 * (appended when missing, never duplicated). Creates the note first when absent. The boundary
	 * matches readGameNotes, so read-then-write round-trips.
	 */
	async writeGameNotes(game: Game, notesBody: string): Promise<void> {
		await this.ensureGameNote(game);
		const filePath = this.noteFilePath(game.title);
		const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;
		const current = await this.plugin.app.vault.read(file);

		let updated: string;
		const headingMatch = current.match(/(^|\n)## Notes[ \t]*\r?\n/);
		if (!headingMatch || headingMatch.index === undefined) {
			const sep = current.length === 0 || current.endsWith('\n') ? '' : '\n';
			updated = `${current}${sep}\n## Notes\n\n${notesBody}\n`;
		} else {
			const bodyStart = headingMatch.index + headingMatch[0].length;
			const after = current.slice(bodyStart);
			const nextHeading = after.match(/\n(?:## |# )/);
			const bodyEnd =
				nextHeading && nextHeading.index !== undefined
					? bodyStart + nextHeading.index
					: current.length;
			updated = `${current.slice(0, bodyStart)}\n${notesBody}\n${current.slice(bodyEnd)}`;
		}
		if (updated !== current) {
			await this.plugin.app.vault.modify(file, updated);
		}
	}

	async deleteGameNote(game: Game): Promise<void> {
		const filePath = this.noteFilePath(game.title);
		const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			try {
				await this.plugin.app.fileManager.trashFile(file);
			} catch {
				// best-effort
			}
		}
		this.lastNotePathById.delete(game.id);
	}
}
