import { App, Modal, Notice } from 'obsidian';
import type WatchLogPlugin from './main';
import type { GameDataManager } from './GameDataManager';
import { Game, SteamSyncUpdate, GAME_AUTO_STATUS, formatTime } from './types';
import { steamAppIdFromUrl, steamLibraryCover, type SteamOwnedGame, type SteamFailureReason } from './ApiService';

/**
 * Steam library sync.
 *
 * Steam is authoritative for playtime and achievements — no other source knows them — so matched
 * games take those fields unconditionally. Everything else (status, rating, priority, favorite,
 * wishlist, notes) is never touched, and no status is derived from playtime.
 *
 * Flow: fetch the library → match against existing games → show what will change plus a checklist of
 * games not in the library yet → run, with progress and a working Cancel.
 */
export class SteamSyncModal extends Modal {
	private plugin: WatchLogPlugin;
	private gameData: GameDataManager;

	private owned: SteamOwnedGame[] = [];
	private matches: Array<{ game: Game; steam: SteamOwnedGame }> = [];
	private unmatched: SteamOwnedGame[] = [];
	/** Steam appids ticked for import in the unmatched list. */
	private selectedNew = new Set<string>();
	private syncAchievements = true;

	private cancelled = false;
	private running = false;
	/** Set by onClose — separates "user stopped the run" from "the modal is gone". */
	private disposed = false;

	constructor(app: App, plugin: WatchLogPlugin, gameData: GameDataManager) {
		super(app);
		this.plugin = plugin;
		this.gameData = gameData;
	}

	onOpen(): void {
		const colorTheme = this.plugin.settings.colorTheme ?? 'default';
		this.modalEl.setAttribute('data-theme', colorTheme);
		this.contentEl.setAttribute('data-theme', colorTheme);
		this.contentEl.addClass('wl-view');
		this.contentEl.addClass('wl-steam-sync');
		void this.loadLibrary();
	}

	onClose(): void {
		// stops an in-flight run: the loops check this between requests
		this.disposed = true;
		this.cancelled = true;
		this.contentEl.empty();
	}

	// Load + match

	private async loadLibrary(): Promise<void> {
		const c = this.contentEl;
		c.empty();
		c.createEl('h2', { text: 'Sync Steam library' });
		const status = c.createDiv({ cls: 'wl-steam-status', text: 'Fetching your Steam library…' });

		const result = await this.plugin.apiService.getSteamOwnedGames();
		if (this.cancelled) return;

		if (!result.ok) {
			status.textContent = failureMessage(result.reason);
			status.addClass('wl-status-error');
			this.renderCloseOnly();
			return;
		}

		this.owned = result.games;
		this.matchAgainstLibrary();
		this.renderPlan();
	}

	/**
	 * Three-tier match, strongest first: a stored steamAppId, an appid parsed out of the store link
	 * (Steam is first in the store-priority order, so most RAWG/IGDB games already carry one), then a
	 * normalized title. Only the title tier can be wrong, and it's the last resort.
	 */
	private matchAgainstLibrary(): void {
		const games = this.gameData.getGames();
		const byAppId = new Map<string, Game>();
		const byTitle = new Map<string, Game>();

		for (const g of games) {
			const appId = g.steamAppId || steamAppIdFromUrl(g.storeUrl);
			if (appId) byAppId.set(appId, g);
			// first writer wins, so a duplicate title can't steal an earlier match
			const key = normalizeTitle(g.title);
			if (key !== '' && !byTitle.has(key)) byTitle.set(key, g);
		}

		this.matches = [];
		this.unmatched = [];
		const claimed = new Set<string>();

		for (const steam of this.owned) {
			const game = byAppId.get(steam.appId) ?? byTitle.get(normalizeTitle(steam.name));
			if (game && !claimed.has(game.id)) {
				claimed.add(game.id);
				this.matches.push({ game, steam });
			} else if (!game) {
				this.unmatched.push(steam);
			}
			// a game already claimed by an earlier Steam entry is dropped: two apps mapping onto one library
			// entry would double-write playtime
		}

		this.unmatched.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);
	}

	// Plan screen

	private renderPlan(): void {
		const c = this.contentEl;
		c.empty();
		c.createEl('h2', { text: 'Sync Steam library' });

		c.createDiv({
			cls: 'wl-steam-summary',
			text: `${this.owned.length} games on Steam · ${this.matches.length} matched in your library · ${this.unmatched.length} not added yet`,
		});

		c.createDiv({
			cls: 'wl-modal-info',
			text: 'Playtime and achievements are taken from Steam and overwrite what is stored. Status, rating, priority and notes are never changed.',
		});

		// achievements opt-out — the only part that scales with library size
		const achRow = c.createDiv({ cls: 'wl-steam-option' });
		const achBox = achRow.createEl('input', { attr: { type: 'checkbox' } });
		achBox.checked = this.syncAchievements;
		// label/for would need a document-unique id; a click handler does the same job without
		// planting a fixed id in the document (the unmatched rows below use the same pattern)
		const achLabel = achRow.createEl('label', { text: 'Also sync achievements' });
		const achCount = this.matches.length + this.selectedNew.size;
		const achNote = achRow.createSpan({
			cls: 'wl-steam-option-note',
			text: `one request per game, about ${achCount} extra`,
		});
		const setAchievements = (on: boolean): void => {
			achBox.checked = on;
			this.syncAchievements = on;
			achNote.toggleClass('is-dim', !on);
		};
		achBox.addEventListener('change', () => setAchievements(achBox.checked));
		achLabel.addEventListener('click', () => setAchievements(!achBox.checked));

		if (this.unmatched.length > 0) this.renderNewGamesPicker(c, achNote);

		const btnRow = c.createDiv({ cls: 'wl-modal-btn-row' });
		const runBtn = btnRow.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Sync' });
		runBtn.addEventListener('click', () => { void this.run(); });
		btnRow.createEl('button', { cls: 'wl-btn', text: 'Cancel' })
			.addEventListener('click', () => this.close());

		if (this.matches.length === 0 && this.unmatched.length === 0) {
			runBtn.disabled = true;
		}
	}

	private renderNewGamesPicker(parent: HTMLElement, achNote: HTMLElement): void {
		const section = parent.createDiv({ cls: 'wl-steam-section' });
		const head = section.createDiv({ cls: 'wl-steam-section-head' });
		head.createSpan({ cls: 'wl-game-modal-label', text: 'Not in your library' });

		const countEl = head.createSpan({ cls: 'wl-steam-picked' });
		const paintCount = (): void => {
			countEl.textContent = `${this.selectedNew.size} selected`;
			achNote.textContent = `one request per game, about ${this.matches.length + this.selectedNew.size} extra`;
		};

		const actions = head.createDiv({ cls: 'wl-steam-section-actions' });
		const allBtn = actions.createEl('button', { cls: 'wl-btn wl-btn-mini', text: 'All' });
		const noneBtn = actions.createEl('button', { cls: 'wl-btn wl-btn-mini', text: 'None' });

		const list = section.createDiv({ cls: 'wl-steam-list' });
		const boxes: HTMLInputElement[] = [];

		for (const steam of this.unmatched) {
			const row = list.createDiv({ cls: 'wl-steam-row' });
			const box = row.createEl('input', { attr: { type: 'checkbox' } });
			box.checked = this.selectedNew.has(steam.appId);
			boxes.push(box);

			const label = row.createDiv({ cls: 'wl-steam-row-label' });
			label.createSpan({ cls: 'wl-steam-row-title', text: steam.name || `App ${steam.appId}` });
			label.createSpan({
				cls: 'wl-steam-row-time',
				text: steam.playtimeMinutes > 0 ? formatTime(steam.playtimeMinutes) : 'never played',
			});

			const toggle = (on: boolean): void => {
				box.checked = on;
				if (on) this.selectedNew.add(steam.appId);
				else this.selectedNew.delete(steam.appId);
				row.toggleClass('is-picked', on);
			};
			box.addEventListener('change', () => { toggle(box.checked); paintCount(); });
			// clicking the row toggles too, but not when the box itself was hit
			row.addEventListener('click', (e) => {
				if (e.target === box) return;
				toggle(!box.checked);
				paintCount();
			});
			row.toggleClass('is-picked', box.checked);
		}

		allBtn.addEventListener('click', () => {
			for (const s of this.unmatched) this.selectedNew.add(s.appId);
			for (const b of boxes) b.checked = true;
			list.findAll('.wl-steam-row').forEach((r) => r.addClass('is-picked'));
			paintCount();
		});
		noneBtn.addEventListener('click', () => {
			this.selectedNew.clear();
			for (const b of boxes) b.checked = false;
			list.findAll('.wl-steam-row').forEach((r) => r.removeClass('is-picked'));
			paintCount();
		});

		paintCount();
	}

	// Run

	private async run(): Promise<void> {
		if (this.running || this.disposed) return;
		this.running = true;
		// a fresh run starts uncancelled — but never resurrect one the modal already closed on
		this.cancelled = false;

		const c = this.contentEl;
		c.empty();
		c.createEl('h2', { text: 'Syncing…' });
		const label = c.createDiv({ cls: 'wl-steam-status', text: 'Starting…' });
		const barWrap = c.createDiv({ cls: 'wl-steam-progress' });
		const bar = barWrap.createDiv({ cls: 'wl-steam-progress-fill' });

		const btnRow = c.createDiv({ cls: 'wl-modal-btn-row' });
		const cancelBtn = btnRow.createEl('button', { cls: 'wl-btn', text: 'Cancel' });
		cancelBtn.addEventListener('click', () => {
			this.cancelled = true;
			label.textContent = 'Finishing the current request…';
		});

		const newGames = this.unmatched.filter((s) => this.selectedNew.has(s.appId));
		// achievement calls dominate; the metadata fetch is one per imported game
		const totalSteps =
			this.matches.length
			+ newGames.length
			+ (this.syncAchievements ? this.matches.length + newGames.length : 0);
		let step = 0;
		const tick = (text: string): void => {
			step++;
			const pct = totalSteps > 0 ? Math.round((step / totalSteps) * 100) : 100;
			bar.setCssProps({ '--wl-steam-progress': `${pct}%` });
			label.textContent = `${text} (${step}/${totalSteps})`;
		};

		// matched games: playtime always, achievements when asked
		const updates: SteamSyncUpdate[] = [];
		// Cancel is checked once per iteration, at the top: the button promises to finish the current
		// request, and breaking mid-iteration would bin a round-trip that already came back.
		for (const { game, steam } of this.matches) {
			if (this.cancelled) break;
			tick(`Updating ${game.title}`);
			let achievements: { earned: number; total: number } | null = null;
			if (this.syncAchievements) {
				achievements = await this.plugin.apiService.getSteamAchievements(steam.appId);
				tick(`Achievements for ${game.title}`);
			}
			updates.push({
				gameId: game.id,
				steamAppId: steam.appId,
				playtimeMinutes: steam.playtimeMinutes,
				lastPlayed: steam.lastPlayed,
				achievements,
			});
		}

		const updated = updates.length > 0 ? await this.gameData.applySteamSync(updates) : 0;

		// new games: one storefront call each, then create
		let imported = 0;
		for (const steam of newGames) {
			if (this.cancelled) break;
			tick(`Importing ${steam.name}`);
			const details = await this.plugin.apiService.getSteamAppDetails(steam.appId);

			let achievements: { earned: number; total: number } | null = null;
			if (this.syncAchievements) {
				achievements = await this.plugin.apiService.getSteamAchievements(steam.appId);
				tick(`Achievements for ${steam.name}`);
			}

			await this.gameData.addGame(this.buildGame(steam, details, achievements));
			imported++;
		}

		this.running = false;
		this.renderDone(updated, imported, this.cancelled);
	}

	/**
	 * A Game from a Steam library entry plus whatever storefront metadata came back. The storefront
	 * call is best-effort — a null `details` (rate limit, delisted app) still produces a usable entry
	 * from the library data alone.
	 */
	private buildGame(
		steam: SteamOwnedGame,
		details: Awaited<ReturnType<WatchLogPlugin['apiService']['getSteamAppDetails']>>,
		achievements: { earned: number; total: number } | null,
	): Game {
		const settings = this.gameData.getSettings();
		const now = new Date().toISOString();
		const title = details?.name || steam.name || `App ${steam.appId}`;

		// genre: the first storefront genre matching a configured one, else the configured default — never
		// invents a new genre behind the user's back
		const configured = settings.types.map((t) => t.name);
		const genre = (details?.genres ?? []).find((g) =>
			configured.some((c) => c.toLowerCase() === g.toLowerCase()),
		) ?? configured[0] ?? '';

		const status = settings.statuses.find((s) => s.name !== GAME_AUTO_STATUS)?.name
			?? settings.statuses[0]?.name
			?? '';

		return {
			id: this.gameData.generateGameId(title),
			title,
			developer: details?.developer ?? '',
			publisher: details?.publisher ?? '',
			type: genre,
			status,
			priority: '',
			favorite: false,
			wishlist: false,
			rating: 0,
			progress: 0,
			playtimeMinutes: steam.playtimeMinutes,
			achievementsEarned: achievements?.earned ?? 0,
			achievementsTotal: achievements?.total ?? 0,
			platforms: [],
			singleplayer: details?.singleplayer ?? false,
			coop: details?.coop ?? false,
			multiplayer: details?.multiplayer ?? false,
			coverUrl: details?.coverUrl ?? steamLibraryCover(steam.appId),
			apiSource: '',
			apiId: '',
			steamAppId: steam.appId,
			lastPlayed: steam.lastPlayed,
			storeUrl: details?.storeUrl ?? `https://store.steampowered.com/app/${steam.appId}/`,
			externalLink: '',
			vaultPage: '',
			releaseDate: details?.releaseDate ?? null,
			dateStarted: null,
			dateFinished: null,
			dateAdded: now,
			dateModified: now,
			customFields: {},
		};
	}

	private renderDone(updated: number, imported: number, cancelled: boolean): void {
		// the modal may have been closed mid-run — the work is saved either way, so still report it
		// as a Notice, but don't paint a summary screen into a detached contentEl
		if (this.disposed) {
			new Notice(`Steam sync: ${updated} updated, ${imported} imported.`);
			return;
		}
		const c = this.contentEl;
		c.empty();
		c.createEl('h2', { text: cancelled ? 'Sync stopped' : 'Sync complete' });
		c.createDiv({
			cls: 'wl-steam-status',
			text: `${updated} game${updated === 1 ? '' : 's'} updated · ${imported} imported`,
		});
		if (cancelled) {
			c.createDiv({
				cls: 'wl-modal-info',
				text: 'Everything processed before you stopped has been saved.',
			});
		}
		const btnRow = c.createDiv({ cls: 'wl-modal-btn-row' });
		btnRow.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Done' })
			.addEventListener('click', () => this.close());
		new Notice(`Steam sync: ${updated} updated, ${imported} imported.`);
	}

	private renderCloseOnly(): void {
		const btnRow = this.contentEl.createDiv({ cls: 'wl-modal-btn-row' });
		btnRow.createEl('button', { cls: 'wl-btn', text: 'Close' })
			.addEventListener('click', () => this.close());
	}
}

/**
 * Match key for titles: case-folded, trademark noise and punctuation stripped, whitespace collapsed.
 * Deliberately conservative — it must not fold a series together (Portal / Portal 2 stay apart).
 */
function normalizeTitle(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[™®©]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/** User-facing explanation per failure reason — the private-profile case is the common one. */
function failureMessage(reason: SteamFailureReason): string {
	switch (reason) {
		case 'missing':
			return 'Set your Steam API key and Steam ID under Settings → API → Games first.';
		case 'badKey':
			return 'Steam rejected the API key. Check it under Settings → API → Games.';
		case 'private':
			return 'Steam returned no library. Your profile\'s "Game details" privacy setting must be Public; Steam hides owned games otherwise, even from your own API key.';
		case 'empty':
			return 'Steam reports no games on this account. Check the Steam ID is the right one.';
		default:
			return 'Could not reach Steam. Check your connection and try again.';
	}
}
