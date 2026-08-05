import { App, Modal, Notice, Platform, setIcon } from 'obsidian';
import type WatchLogPlugin from './main';
import type { GameDataManager } from './GameDataManager';
import { Game, GameGroup, GAME_AUTO_STATUS, formatTime, parsePlaytimeInput } from './types';
import { buildPosterCard } from './PosterCard';
import { rawgResizedCover, steamAppIdFromUrl } from './ApiService';
import { renderStarRating } from './StarRating';
import { renderTagPill, renderTagChips } from './StatusDropdown';
import { ConfirmModal } from './ConfirmModal';
import { renderModePill } from './ModePill';
import { appendNoteLinkButton } from './NoteLinkButton';
import { createDatePicker } from './DatePicker';
import { pinModalFooter } from './StickyModal';
import {
	normalizeCustomPropertyList,
	renderCustomPropertiesDetailSection,
} from './CustomProperties';

/**
 * Game detail/edit modal: cover + title/developer header, Type / Priority / Status pill dropdowns
 * (shared StatusDropdown), favorite heart, star rating (shared StarRating) with a text label, the
 * progress section (click/drag bar, ±5 steppers, playtime + achievements), platform toggle chips,
 * details grid, Notes synced with the note file's `## Notes`, and a Delete / Save footer. Edits a
 * draft copy — nothing persists until Save.
 */
export class GameDetailModal extends Modal {
	private plugin: WatchLogPlugin;
	private gameData: GameDataManager;
	private draft: Game;
	private notesValue = '';
	private notesLoaded = false;

	// group membership isn't a field on Game (it lives in GamesData.groups), so it can't ride in the
	// draft — tracked here and applied on Save
	private originalGroupId = '';
	private selectedGroupId = '';
	private newGroupName = '';

	private badgeRowEl: HTMLElement | null = null;
	private ratingRowEl: HTMLElement | null = null;
	private actionsRowEl: HTMLElement | null = null;
	private coverEl: HTMLElement | null = null;

	// phone layout: note/store/wishlist on their own line, Modes aligned with Progress
	private readonly mobile = Platform.isMobile;

	constructor(app: App, plugin: WatchLogPlugin, gameData: GameDataManager, game: Game) {
		super(app);
		this.plugin = plugin;
		this.gameData = gameData;
		this.draft = {
			...game,
			platforms: [...game.platforms],
			customFields: { ...(game.customFields ?? {}) },
		};
		// the batch "Group…" action only ever adds, so a game can already sit in more than one group; the
		// dropdown seeds from the first and Save re-homes it into exactly one (or none)
		this.originalGroupId = this.gameData.getGroups().find((g) => g.gameIds.includes(game.id))?.id ?? '';
		this.selectedGroupId = this.originalGroupId;
	}

	onOpen(): void {
		const colorTheme = this.plugin.settings.colorTheme ?? 'default';
		this.modalEl.setAttribute('data-theme', colorTheme);
		this.contentEl.setAttribute('data-theme', colorTheme);
		this.modalEl.addClass('wl-game-modal');
		this.contentEl.addClass('wl-view');
		this.render();

		// notes live in the note file's ## Notes section — loaded async so edits made directly in the .md
		// flow into the textarea
		void this.gameData.readGameNotes(this.draft).then((notes) => {
			this.notesValue = notes ?? '';
			this.notesLoaded = true;
			const ta = this.contentEl.querySelector<HTMLTextAreaElement>('.wl-game-modal-notes');
			if (ta && ta.value === '') ta.value = this.notesValue;
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();

		// Header: cover + title/developer + badges + rating
		const header = c.createDiv({ cls: 'wl-game-modal-header' });
		this.coverEl = header.createDiv({ cls: 'wl-game-modal-cover' });
		this.renderCover();

		const head = header.createDiv({ cls: 'wl-game-modal-head' });

		// click-to-edit title / developer (the Reading detail modal pattern, sharing its classes);
		// commits into the draft
		const titleWrap = head.createDiv({ cls: 'wl-reading-detail-title-wrap' });
		this.renderTitleDisplay(titleWrap);

		const devWrap = head.createDiv({ cls: 'wl-reading-detail-author-wrap' });
		this.renderDeveloperDisplay(devWrap);

		this.badgeRowEl = head.createDiv({ cls: 'wl-game-modal-badges' });
		this.renderBadgeRow();

		this.ratingRowEl = head.createDiv({ cls: 'wl-game-modal-rating' });
		this.renderRatingRow();

		// mobile: note · store · wishlist get their own line, and Modes leaves the head column so it
		// starts under the cover, aligned with Progress
		if (this.mobile) {
			this.actionsRowEl = head.createDiv({ cls: 'wl-game-modal-actions' });
			this.renderActionsRow();
			this.renderModesRow(c);
		} else {
			this.renderModesRow(head);
		}

		// Progress
		this.renderProgressSection(c);

		// Platforms
		const platforms = c.createDiv({ cls: 'wl-game-modal-section' });
		platforms.createSpan({ cls: 'wl-game-modal-label', text: 'Platforms' });
		renderTagChips({
			wrap: platforms.createDiv({ cls: 'wl-game-modal-platforms' }),
			tags: this.gameData.getSettings().platforms,
			selected: this.draft.platforms,
			onToggle: (sel) => { this.draft.platforms = sel; },
		});

		// Details grid
		const details = c.createDiv({ cls: 'wl-game-modal-section wl-game-modal-details-section' });
		details.createSpan({ cls: 'wl-game-modal-label', text: 'Details' });
		const grid = details.createDiv({ cls: 'wl-game-modal-details' });

		// publisher pairs with release date and the two progress dates pair with each other, so each row
		// reads as one thought. Playtime lives in the Progress stat strip.
		this.textField(grid, 'Publisher', this.draft.publisher, (v) => { this.draft.publisher = v; });
		this.dateField(grid, 'Release date', this.draft.releaseDate, (v) => { this.draft.releaseDate = v; });
		this.dateField(grid, 'Date started', this.draft.dateStarted, (v) => { this.draft.dateStarted = v; });
		this.dateField(grid, 'Date finished', this.draft.dateFinished, (v) => { this.draft.dateFinished = v; });

		// group assignment (move / create) — full-width row under the grid
		this.renderGroupField(details);

		// the three URLs are set once (usually by the API) and rarely edited, so they collapse behind a
		// disclosure instead of costing two grid rows
		this.renderLinksDisclosure(details);

		// Notes
		const notes = c.createDiv({ cls: 'wl-game-modal-section' });
		notes.createSpan({ cls: 'wl-game-modal-label', text: 'Notes' });
		const ta = notes.createEl('textarea', {
			cls: 'wl-game-modal-notes',
			attr: { placeholder: 'Add notes...', rows: '3' },
		});
		ta.value = this.notesValue;
		ta.addEventListener('input', () => { this.notesValue = ta.value; });

		if (!this.draft.customFields) this.draft.customFields = {};
		const gameProps = normalizeCustomPropertyList(this.gameData.getCustomProperties());
		if (gameProps.length > 0) {
			renderCustomPropertiesDetailSection({
				parent: c,
				properties: gameProps,
				getFields: () => this.draft.customFields ?? {},
				emptyHint: 'No properties yet. Add some in Settings → Customize → Games.',
				onSave: (propId, value) => {
					if (!this.draft.customFields) this.draft.customFields = {};
					if (value === null || value === '') delete this.draft.customFields[propId];
					else this.draft.customFields[propId] = value;
				},
			});
		}

		// Footer
		const footer = c.createDiv({ cls: 'wl-game-modal-footer' });
		const deleteBtn = footer.createEl('button', { cls: 'wl-btn wl-game-modal-delete', text: 'Delete' });
		deleteBtn.addEventListener('click', () => {
			new ConfirmModal(
				this.app,
				`Delete "${this.draft.title}"? Its note file will be moved to the trash.`,
				() => {
					void this.gameData.removeGame(this.draft.id);
					this.close();
				},
			).open();
		});

		// favorite heart, centered between Delete and Save by the footer's space-between layout. Edits the
		// draft — persists on Save like everything else here.
		const favBtn = footer.createEl('button', {
			cls: 'wl-detail-fav-btn',
			attr: { type: 'button' },
		});
		setIcon(favBtn, 'heart');
		const paintFav = (): void => {
			favBtn.toggleClass('is-active', this.draft.favorite);
			const label = this.draft.favorite ? 'Remove from favorites' : 'Add to favorites';
			favBtn.title = label;
			favBtn.setAttr('aria-label', label);
		};
		paintFav();
		favBtn.addEventListener('click', () => {
			this.draft.favorite = !this.draft.favorite;
			paintFav();
		});

		const saveBtn = footer.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Save changes' });
		saveBtn.addEventListener('click', () => { void this.save(); });

		pinModalFooter(footer);
	}

	private async save(): Promise<void> {
		if (!this.draft.title.trim()) return;
		this.draft.title = this.draft.title.trim();
		await this.gameData.updateGame(this.draft);
		await this.applyGroupChange();
		// write the Notes section only when it was loaded or edited — never clobber an unloaded section
		// with an empty string
		if (this.notesLoaded || this.notesValue !== '') {
			await this.gameData.writeGameNotes(this.draft, this.notesValue);
		}
		this.close();
	}

	private renderCover(): void {
		const cover = this.coverEl;
		if (!cover) return;
		cover.empty();
		const url = this.draft.coverUrl;
		if (url && url.startsWith('http')) {
			const img = cover.createEl('img', {
				attr: { src: rawgResizedCover(url), alt: this.draft.title },
			});
			img.onerror = () => {
				img.remove();
				cover.createSpan({ cls: 'wl-game-modal-cover-hint', text: 'cover art' });
			};
		} else {
			cover.createSpan({ cls: 'wl-game-modal-cover-hint', text: 'cover art' });
		}
	}

	// Click-to-edit title / developer

	private renderTitleDisplay(wrap: HTMLElement): void {
		wrap.empty();
		const titleEl = wrap.createEl('h2', {
			cls: 'wl-reading-detail-title wl-reading-detail-editable-text',
			text: this.draft.title,
		});
		titleEl.title = 'Click to edit';
		titleEl.addEventListener('click', () => this.editTitle(wrap));
	}

	private editTitle(wrap: HTMLElement): void {
		wrap.empty();
		const input = wrap.createEl('input', {
			cls: 'wl-modal-input wl-reading-detail-title-input',
			attr: { type: 'text' },
		});
		input.value = this.draft.title;
		const commit = (): void => {
			const val = input.value.trim();
			if (val) this.draft.title = val;
			this.renderTitleDisplay(wrap);
		};
		input.addEventListener('blur', commit);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
			else if (e.key === 'Escape') { e.preventDefault(); this.renderTitleDisplay(wrap); }
		});
		input.focus();
		input.select();
	}

	private renderDeveloperDisplay(wrap: HTMLElement): void {
		wrap.empty();
		const devEl = wrap.createDiv({
			cls: 'wl-reading-detail-author wl-reading-detail-editable-text',
			text: this.draft.developer || '—',
		});
		devEl.title = 'Click to edit';
		devEl.addEventListener('click', () => this.editDeveloper(wrap));
	}

	private editDeveloper(wrap: HTMLElement): void {
		wrap.empty();
		const input = wrap.createEl('input', {
			cls: 'wl-modal-input wl-reading-detail-author-input',
			attr: { type: 'text' },
		});
		input.value = this.draft.developer;
		const commit = (): void => {
			this.draft.developer = input.value.trim();
			this.renderDeveloperDisplay(wrap);
		};
		input.addEventListener('blur', commit);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
			else if (e.key === 'Escape') { e.preventDefault(); this.renderDeveloperDisplay(wrap); }
		});
		input.focus();
		input.select();
	}

	// Badge row (Status / Type / Priority pills + note link)

	private renderBadgeRow(): void {
		const row = this.badgeRowEl;
		if (!row) return;
		row.empty();
		const settings = this.gameData.getSettings();
		const priorities = this.plugin.settings.priorities;

		// the shared detail-modal pill (renderTagPill), so these match the Watchlist / Reading badges. The
		// auto-managed "To be released" is excluded from the dropdown (it follows the release date) but
		// still displays when active.
		const statusWrap = row.createSpan({ cls: 'wl-reading-detail-status-wrap' });
		renderTagPill({
			wrap: statusWrap,
			value: this.draft.status,
			color: settings.statuses.find((s) => s.name === this.draft.status)?.color,
			showDot: true,
			tooltip: 'Click to change status',
			container: this.contentEl,
			options: settings.statuses.filter((s) => s.name !== GAME_AUTO_STATUS).map((s) => s.name),
			getOptionColor: (v) => settings.statuses.find((s) => s.name === v)?.color,
			onSelect: (v) => { this.draft.status = v; this.renderBadgeRow(); },
		});

		const typeWrap = row.createSpan({ cls: 'wl-reading-detail-status-wrap' });
		renderTagPill({
			wrap: typeWrap,
			value: this.draft.type,
			emptyLabel: 'No type',
			color: settings.types.find((t) => t.name === this.draft.type)?.color,
			showDot: true,
			tooltip: 'Click to change genre',
			container: this.contentEl,
			options: settings.types.map((t) => t.name),
			getOptionColor: (v) => settings.types.find((t) => t.name === v)?.color,
			onSelect: (v) => { this.draft.type = v; this.renderBadgeRow(); },
		});

		const priorityWrap = row.createSpan({ cls: 'wl-reading-detail-status-wrap' });
		renderTagPill({
			wrap: priorityWrap,
			value: this.draft.priority,
			emptyLabel: 'No priority',
			color: priorities.find((p) => p.name === this.draft.priority)?.color,
			showDot: true,
			tooltip: 'Click to change priority',
			container: this.contentEl,
			options: [...priorities.map((p) => p.name), { value: '', label: 'No priority' }],
			getOptionColor: (v) => (v ? priorities.find((p) => p.name === v)?.color : null),
			onSelect: (v) => { this.draft.priority = v; this.renderBadgeRow(); },
		});

		// mobile groups it with store + wishlist under the rating instead
		if (!this.mobile) this.renderNoteButton(row);
	}

	/** Open this game's .md note — the shared file-text icon the other detail modals use. */
	private renderNoteButton(parent: HTMLElement): void {
		appendNoteLinkButton(
			this.plugin.app,
			parent,
			this.gameData.noteFilePath(this.draft.title),
			() => this.close(),
		);
	}

	/** Mobile: note · store · wishlist on one line under the rating row. */
	private renderActionsRow(): void {
		const row = this.actionsRowEl;
		if (!row) return;
		row.empty();
		this.renderNoteButton(row);
		this.renderStoreButton(row);
		this.renderWishlistButton(row);
	}

	/**
	 * Progress — a click/drag-to-set bar (no range slider), a typed percentage, ±5 steppers, and the
	 * play-stats strip: time played (freeform in, stored as minutes) and achievements earned/total,
	 * which can push their derived percentage into the bar on demand rather than silently overwriting
	 * it.
	 */
	private renderProgressSection(parent: HTMLElement): void {
		const section = parent.createDiv({ cls: 'wl-game-modal-section wl-game-modal-progress' });

		// the bar picks up the genre colour, the way the type pill does
		const typeColor = this.gameData.getSettings().types.find((t) => t.name === this.draft.type)?.color;
		if (typeColor) section.style.setProperty('--wl-game-progress-color', typeColor);

		const head = section.createDiv({ cls: 'wl-game-modal-progress-head' });
		head.createSpan({ cls: 'wl-game-modal-label', text: 'Progress' });

		const pctWrap = head.createDiv({ cls: 'wl-game-modal-progress-pct' });
		const doneIcon = pctWrap.createSpan({ cls: 'wl-game-modal-progress-done' });
		setIcon(doneIcon, 'check');
		const pctInput = pctWrap.createEl('input', {
			cls: 'wl-game-modal-progress-input',
			attr: { type: 'number', min: '0', max: '100', 'aria-label': 'Completion percentage' },
		});
		pctWrap.createSpan({ cls: 'wl-game-modal-progress-sign', text: '%' });

		// the bar replaces the slider, so it carries the slider's a11y contract
		const bar = section.createDiv({
			cls: 'wl-game-modal-progress-bar',
			attr: {
				role: 'slider',
				tabindex: '0',
				'aria-label': 'Completion percentage',
				'aria-valuemin': '0',
				'aria-valuemax': '100',
			},
		});
		const fill = bar.createDiv({ cls: 'wl-game-modal-progress-fill' });

		const strip = section.createDiv({ cls: 'wl-game-modal-progress-strip' });
		const steps = strip.createDiv({ cls: 'wl-game-modal-step-group' });

		// achievements → percentage chip, refreshed by the shared sync below
		let refreshDerived = (): void => {};

		const sync = (): void => {
			const p = this.draft.progress;
			fill.style.width = `${p}%`;
			bar.setAttr('aria-valuenow', String(p));
			bar.setAttr('aria-valuetext', `${p}%`);
			pctWrap.toggleClass('is-complete', p >= 100);
			if (pctInput.value !== String(p)) pctInput.value = String(p);
			refreshDerived();
		};

		const setProgress = (value: number): void => {
			this.draft.progress = Math.min(100, Math.max(0, Math.round(value)));
			sync();
		};

		for (const delta of [-5, 5]) {
			const btn = steps.createEl('button', {
				cls: 'wl-game-modal-step',
				text: delta > 0 ? `+${delta}` : String(delta),
				attr: { type: 'button', 'aria-label': `${delta > 0 ? 'Increase' : 'Decrease'} progress by 5%` },
			});
			btn.addEventListener('click', () => setProgress(this.draft.progress + delta));
		}

		// Time played
		const timeStat = strip.createDiv({ cls: 'wl-game-modal-stat' });
		setIcon(timeStat.createSpan({ cls: 'wl-game-modal-stat-icon' }), 'clock');
		const timeInput = timeStat.createEl('input', {
			cls: 'wl-game-modal-stat-input wl-game-modal-stat-time',
			attr: {
				type: 'text',
				placeholder: '0h',
				title: 'Time played: e.g. 42h 30m, 90m, 1.5h',
				'aria-label': 'Time played',
			},
		});
		timeInput.value = this.draft.playtimeMinutes > 0 ? formatTime(this.draft.playtimeMinutes) : '';
		const commitTime = (): void => {
			const minutes = parsePlaytimeInput(timeInput.value);
			this.draft.playtimeMinutes = minutes;
			timeInput.value = minutes > 0 ? formatTime(minutes) : '';
		};
		timeInput.addEventListener('change', commitTime);
		timeInput.addEventListener('blur', commitTime);

		// Achievements
		const achStat = strip.createDiv({ cls: 'wl-game-modal-stat' });
		setIcon(achStat.createSpan({ cls: 'wl-game-modal-stat-icon' }), 'trophy');
		const earnedInput = achStat.createEl('input', {
			cls: 'wl-game-modal-stat-input wl-game-modal-stat-num',
			attr: { type: 'number', min: '0', placeholder: '0', 'aria-label': 'Achievements earned' },
		});
		achStat.createSpan({ cls: 'wl-game-modal-stat-sep', text: '/' });
		const totalInput = achStat.createEl('input', {
			cls: 'wl-game-modal-stat-input wl-game-modal-stat-num',
			attr: { type: 'number', min: '0', placeholder: '—', 'aria-label': 'Achievements total' },
		});
		earnedInput.value = this.draft.achievementsEarned > 0 ? String(this.draft.achievementsEarned) : '';
		totalInput.value = this.draft.achievementsTotal > 0 ? String(this.draft.achievementsTotal) : '';

		const derived = achStat.createEl('button', {
			cls: 'wl-game-modal-derive',
			attr: { type: 'button' },
		});

		refreshDerived = (): void => {
			const total = this.draft.achievementsTotal;
			const pct = total > 0 ? Math.round((this.draft.achievementsEarned / total) * 100) : -1;
			const show = pct >= 0 && pct !== this.draft.progress;
			derived.toggleClass('is-hidden', !show);
			if (show) {
				derived.textContent = `= ${pct}%`;
				derived.setAttr('title', `Set progress to ${pct}% from achievements`);
				derived.setAttr('aria-label', `Set progress to ${pct} percent from achievements`);
			}
		};
		derived.addEventListener('click', () => {
			const total = this.draft.achievementsTotal;
			if (total > 0) setProgress((this.draft.achievementsEarned / total) * 100);
		});

		const commitAchievements = (): void => {
			const total = Math.max(0, Math.round(Number(totalInput.value) || 0));
			// earned can't exceed a known total; an unknown total (0) leaves it alone
			const earned = Math.max(0, Math.round(Number(earnedInput.value) || 0));
			this.draft.achievementsTotal = total;
			this.draft.achievementsEarned = total > 0 ? Math.min(earned, total) : earned;
			earnedInput.value = this.draft.achievementsEarned > 0 ? String(this.draft.achievementsEarned) : '';
			totalInput.value = total > 0 ? String(total) : '';
			refreshDerived();
		};
		for (const input of [earnedInput, totalInput]) {
			input.addEventListener('change', commitAchievements);
			input.addEventListener('blur', commitAchievements);
		}

		// Steam pull — only when Steam is configured and this game resolves to an appid. Writes into the
		// draft like every other control here, so it still takes a Save and can be undone by closing the
		// modal.
		const steamAppId = this.draft.steamAppId || steamAppIdFromUrl(this.draft.storeUrl);
		if (this.plugin.apiService.hasSteamCredentials() && steamAppId !== '') {
			const steamBtn = strip.createEl('button', {
				cls: 'wl-game-modal-steam-pull',
				attr: { type: 'button', title: 'Pull playtime and achievements from Steam' },
			});
			setIcon(steamBtn, 'refresh-cw');
			steamBtn.createSpan({ text: 'Steam' });

			steamBtn.addEventListener('click', () => {
				if (steamBtn.hasClass('is-loading')) return;
				steamBtn.addClass('is-loading');
				void (async () => {
					try {
						const [library, achievements] = await Promise.all([
							this.plugin.apiService.getSteamOwnedGames(),
							this.plugin.apiService.getSteamAchievements(steamAppId),
						]);
						const owned = library.ok
							? library.games.find((g) => g.appId === steamAppId)
							: undefined;

						if (!owned && !achievements) {
							new Notice(library.ok
								? 'Steam has no record of this game on your account.'
								: 'Could not reach Steam.');
							return;
						}
						if (owned) {
							this.draft.playtimeMinutes = owned.playtimeMinutes;
							this.draft.lastPlayed = owned.lastPlayed;
							timeInput.value = owned.playtimeMinutes > 0 ? formatTime(owned.playtimeMinutes) : '';
						}
						if (achievements) {
							this.draft.achievementsTotal = achievements.total;
							this.draft.achievementsEarned = achievements.earned;
							earnedInput.value = achievements.earned > 0 ? String(achievements.earned) : '';
							totalInput.value = achievements.total > 0 ? String(achievements.total) : '';
							refreshDerived();
						}
						// stamp the link so the next sync matches by id, not by title
						this.draft.steamAppId = steamAppId;
						new Notice('Pulled from Steam; save changes to keep it.');
					} finally {
						steamBtn.removeClass('is-loading');
					}
				})();
			});
		}

		// Bar interaction: click/drag anywhere, arrow keys, typed value
		const setFromPointer = (clientX: number): void => {
			const rect = bar.getBoundingClientRect();
			if (rect.width <= 0) return;
			setProgress(((clientX - rect.left) / rect.width) * 100);
		};
		bar.addEventListener('pointerdown', (e: PointerEvent) => {
			bar.setPointerCapture(e.pointerId);
			setFromPointer(e.clientX);
		});
		bar.addEventListener('pointermove', (e: PointerEvent) => {
			if (bar.hasPointerCapture(e.pointerId)) setFromPointer(e.clientX);
		});
		bar.addEventListener('pointerup', (e: PointerEvent) => bar.releasePointerCapture(e.pointerId));
		bar.addEventListener('keydown', (e: KeyboardEvent) => {
			const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 5
				: e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -5
					: 0;
			if (step !== 0) {
				e.preventDefault();
				setProgress(this.draft.progress + step);
			} else if (e.key === 'Home') {
				e.preventDefault();
				setProgress(0);
			} else if (e.key === 'End') {
				e.preventDefault();
				setProgress(100);
			}
		});

		const commitPct = (): void => {
			const typed = Number(pctInput.value);
			setProgress(Number.isFinite(typed) ? typed : this.draft.progress);
		};
		pctInput.addEventListener('change', commitPct);
		pctInput.addEventListener('blur', commitPct);

		sync();
	}

	/** Game modes — its own row under the rating (the pill's home since Co-op). */
	private renderModesRow(parent: HTMLElement): void {
		const row = parent.createDiv({ cls: 'wl-game-modal-modes' });
		row.createSpan({ cls: 'wl-game-modal-label', text: 'Modes' });
		renderModePill(
			row,
			() => ({
				singleplayer: this.draft.singleplayer,
				coop: this.draft.coop,
				multiplayer: this.draft.multiplayer,
			}),
			(patch) => {
				if (patch.singleplayer !== undefined) this.draft.singleplayer = patch.singleplayer;
				if (patch.coop !== undefined) this.draft.coop = patch.coop;
				if (patch.multiplayer !== undefined) this.draft.multiplayer = patch.multiplayer;
			},
		);
	}

	private renderRatingRow(): void {
		const row = this.ratingRowEl;
		if (!row) return;
		row.empty();
		row.createSpan({ cls: 'wl-game-modal-label', text: 'Rating' });
		const stars = row.createDiv();
		renderStarRating(stars, this.draft.rating, {
			allowHalf: true,
			tiers: this.plugin.settings.ratingSystem,
			showLabel: true,
			onChange: (value) => {
				this.draft.rating = value;
				// a full re-render rebinds the stars to the new current value
				this.renderRatingRow();
			},
		});

		// mobile moves both onto their own line under this row
		if (!this.mobile) {
			this.renderStoreButton(row);
			this.renderWishlistButton(row);
		}
	}

	/** Store link, at the rating row's tail (the watchlist trailer-button spot). Only when set. */
	private renderStoreButton(parent: HTMLElement): void {
		if (!this.draft.storeUrl.trim()) return;
		const storeBtn = parent.createEl('button', {
			cls: 'wl-store-btn',
			attr: { type: 'button', title: 'Open store page', 'aria-label': 'Open store page' },
		});
		setIcon(storeBtn, 'store');
		storeBtn.addEventListener('click', () => {
			const url = this.draft.storeUrl.trim();
			if (url) window.open(url, '_blank');
		});
	}

	/**
	 * Wishlist toggle beside the store button — a gift tag, since a wishlisted game is one you want
	 * but don't own. Edits the draft; persists on Save.
	 */
	private renderWishlistButton(parent: HTMLElement): void {
		const wishBtn = parent.createEl('button', {
			cls: 'wl-store-btn wl-wishlist-btn',
			attr: { type: 'button' },
		});
		setIcon(wishBtn, 'gift');
		const paintWish = (): void => {
			wishBtn.toggleClass('is-active', this.draft.wishlist);
			const label = this.draft.wishlist ? 'Remove from wishlist' : 'Add to wishlist';
			wishBtn.title = label;
			wishBtn.setAttr('aria-label', label);
			wishBtn.setAttr('aria-pressed', String(this.draft.wishlist));
		};
		paintWish();
		wishBtn.addEventListener('click', () => {
			this.draft.wishlist = !this.draft.wishlist;
			paintWish();
		});
	}

	// Group assignment

	/**
	 * "Add to group" / "Or create new group", laid out as one compact row: the dropdown and the
	 * new-name input sit side by side and disable each other, so only one can be pending. Nothing is
	 * written until Save (see applyGroupChange).
	 */
	private renderGroupField(parent: HTMLElement): void {
		const row = parent.createDiv({ cls: 'wl-game-modal-group' });
		row.createEl('label', { cls: 'wl-game-modal-group-label', text: 'Group' });
		const controls = row.createDiv({ cls: 'wl-game-modal-group-controls' });

		// not wl-select-sm — that sets width:auto, which fights the grid column
		const select = controls.createEl('select', { cls: 'wl-select' });
		select.createEl('option', { text: '— none —', value: '' });
		for (const g of this.gameData.getGroups()) {
			const opt = select.createEl('option', { text: g.name, value: g.id });
			if (g.id === this.selectedGroupId) opt.selected = true;
		}

		const newInput = controls.createEl('input', {
			cls: 'wl-modal-input wl-game-modal-group-new',
			attr: { type: 'text', placeholder: 'Or create new group…', maxlength: '64' },
		});
		newInput.value = this.newGroupName;

		select.addEventListener('change', () => {
			this.selectedGroupId = select.value;
			if (this.selectedGroupId) {
				this.newGroupName = '';
				newInput.value = '';
				newInput.disabled = true;
			} else {
				newInput.disabled = false;
			}
		});

		newInput.addEventListener('input', () => {
			this.newGroupName = newInput.value;
			if (this.newGroupName.trim()) {
				this.selectedGroupId = '';
				select.value = '';
				select.disabled = true;
			} else {
				select.disabled = false;
			}
		});

		if (this.selectedGroupId) newInput.disabled = true;
		if (this.newGroupName.trim()) select.disabled = true;
	}

	/**
	 * Applies the pending group choice: detach, then attach. Detaching sweeps *every* group rather
	 * than just originalGroupId, so a game left in two by the batch action ends up in exactly the one
	 * picked. No-ops when unchanged.
	 */
	private async applyGroupChange(): Promise<void> {
		const newName = this.newGroupName.trim();
		if (newName === '' && this.selectedGroupId === this.originalGroupId) return;

		for (const g of this.gameData.getGroups()) {
			if (!g.gameIds.includes(this.draft.id)) continue;
			await this.gameData.updateGroup({
				...g,
				gameIds: g.gameIds.filter((id) => id !== this.draft.id),
			});
		}

		if (newName) {
			await this.gameData.addGroup({
				id: this.gameData.generateGroupId(newName),
				name: newName,
				gameIds: [this.draft.id],
				dateAdded: new Date().toISOString(),
			});
		} else if (this.selectedGroupId) {
			await this.gameData.addGameToGroup(this.selectedGroupId, this.draft.id);
		}
		// else: moved to "— none —" — detached only
	}

	// Links disclosure

	/**
	 * The three URLs (store / external / cover) behind a collapsed "Links (N)" toggle. Normally filled
	 * once by the API add flow and then never touched, so at rest they cost one thin line instead of
	 * two grid rows. N counts the non-empty URLs and tracks the draft as you type.
	 */
	private renderLinksDisclosure(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: 'wl-game-modal-links' });
		const toggle = wrap.createEl('button', {
			cls: 'wl-game-modal-links-toggle',
			attr: { type: 'button', 'aria-expanded': 'false' },
		});
		const caret = toggle.createSpan({ cls: 'wl-game-modal-links-caret', text: '▸' });
		const summary = toggle.createSpan({ cls: 'wl-game-modal-links-summary' });
		const body = wrap.createDiv({ cls: 'wl-game-modal-links-body' });

		const paintSummary = (): void => {
			const filled = [this.draft.storeUrl, this.draft.externalLink, this.draft.coverUrl]
				.filter((u) => u.trim() !== '').length;
			summary.textContent = filled > 0 ? `Links (${filled})` : 'Links';
		};

		this.linkField(body, 'Store', this.draft.storeUrl, (v) => {
			this.draft.storeUrl = v;
			paintSummary();
		});
		this.linkField(body, 'External', this.draft.externalLink, (v) => {
			this.draft.externalLink = v;
			paintSummary();
		});
		this.linkField(body, 'Cover', this.draft.coverUrl, (v) => {
			this.draft.coverUrl = v;
			this.renderCover();
			paintSummary();
		});
		paintSummary();

		// render() runs once per open, so no field is needed
		let open = false;
		toggle.addEventListener('click', () => {
			open = !open;
			wrap.toggleClass('is-open', open);
			caret.textContent = open ? '▾' : '▸';
			toggle.setAttr('aria-expanded', String(open));
		});
	}

	// Small field builders

	/** One-line URL row inside the Links disclosure: inline label, compact input. */
	private linkField(
		parent: HTMLElement,
		label: string,
		value: string,
		onInput: (v: string) => void,
	): void {
		const row = parent.createDiv({ cls: 'wl-game-modal-link-row' });
		row.createEl('label', { text: label });
		const input = row.createEl('input', { attr: { type: 'text', placeholder: 'https://…' } });
		input.value = value;
		input.addEventListener('input', () => onInput(input.value));
	}

	private textField(
		grid: HTMLElement,
		label: string,
		value: string,
		onInput: (v: string) => void,
		placeholder = '—',
		extraCls = '',
	): void {
		const field = grid.createDiv({ cls: `wl-game-modal-field ${extraCls}`.trim() });
		field.createEl('label', { text: label });
		const input = field.createEl('input', { attr: { type: 'text', placeholder } });
		input.value = value;
		input.addEventListener('input', () => onInput(input.value));
	}

	private dateField(
		grid: HTMLElement,
		label: string,
		value: string | null,
		onInput: (v: string | null) => void,
	): void {
		const field = grid.createDiv({ cls: 'wl-game-modal-field' });
		field.createEl('label', { text: label });
		// was a native <input type="date">, which paints in the OS locale and ignores the plugin's
		// date-format setting; the shared picker doesn't
		createDatePicker({
			parent: field,
			value,
			lenient: true,
			onChange: onInput,
		});
	}
}

/**
 * Mean completion percentage across a group's members (games carry a 0–100 % slider, not episode
 * counters, so group progress is a plain average).
 */
export function gameGroupProgress(members: Game[]): number {
	if (members.length === 0) return 0;
	const sum = members.reduce((s, g) => s + g.progress, 0);
	return Math.min(100, Math.round(sum / members.length));
}

/**
 * Group detail modal (the Watchlist GroupDetailModal pattern): group name + member count, average
 * completion with a progress bar, and a card grid of the members — clicking one closes this modal
 * and opens its GameDetailModal.
 */
export class GameGroupDetailModal extends Modal {
	private plugin: WatchLogPlugin;
	private gameData: GameDataManager;
	private group: GameGroup;
	private members: Game[];
	private cleanups: (() => void)[] = [];

	constructor(
		app: App,
		plugin: WatchLogPlugin,
		gameData: GameDataManager,
		group: GameGroup,
		members: Game[],
	) {
		super(app);
		this.plugin = plugin;
		this.gameData = gameData;
		this.group = group;
		this.members = members;
	}

	onOpen(): void {
		const colorTheme = this.plugin.settings.colorTheme ?? 'default';
		this.modalEl.setAttribute('data-theme', colorTheme);
		this.contentEl.setAttribute('data-theme', colorTheme);
		this.contentEl.addClass('wl-view');
		this.contentEl.addClass('wl-detail-modal');
		this.renderAll();
	}

	onClose(): void {
		this.contentEl.empty();
		for (const fn of this.cleanups) fn();
		this.cleanups = [];
	}

	private renderAll(): void {
		this.contentEl.empty();
		const header = this.contentEl.createDiv({ cls: 'wl-detail-header' });
		const left = header.createDiv({ cls: 'wl-detail-header-left' });
		left.createEl('h2', { cls: 'wl-detail-title', text: this.group.name });
		left.createDiv({
			cls: 'wl-detail-group-meta',
			text: `${this.members.length} game${this.members.length !== 1 ? 's' : ''}`,
		});

		const progress = gameGroupProgress(this.members);
		const statsBox = header.createDiv({ cls: 'wl-detail-stats-box' });
		const progBlock = statsBox.createDiv({ cls: 'wl-acc-header-right' });
		progBlock.createDiv({ cls: 'wl-acc-percent', text: `${progress}%` });
		progBlock.createDiv({ cls: 'wl-acc-progress-label', text: 'progress' });
		const barWrap = progBlock.createDiv({ cls: 'wl-acc-progress-wrap' });
		barWrap.createDiv({ cls: 'wl-progress-bar' }).style.width = `${progress}%`;

		const grid = this.contentEl.createDiv({ cls: 'wl-cards-grid wl-detail-group-grid' });
		const settings = this.gameData.getSettings();
		for (const m of this.members) {
			const typeColor = settings.types.find((t) => t.name === m.type)?.color ?? '#888780';
			const statusColor = settings.statuses.find((s) => s.name === m.status)?.color;
			buildPosterCard(grid, {
				dataset: { gameId: m.id },
				title: m.title,
				posterUrl: rawgResizedCover(m.coverUrl),
				placeholderColor: typeColor,
				statusLabel: m.status,
				statusColor,
				typeLabel: m.type || undefined,
				typeColor,
				year: m.releaseDate?.match(/^(\d{4})/)?.[1],
				progressRatio: m.progress > 0 ? m.progress / 100 : undefined,
				flag: m.wishlist ? { icon: 'gift', label: 'On your wishlist' } : undefined,
				onClick: () => {
					this.close();
					const fresh = this.gameData.getGame(m.id);
					if (!fresh) return;
					new GameDetailModal(this.plugin.app, this.plugin, this.gameData, fresh).open();
				},
			}, { container: this.contentEl, cleanups: this.cleanups });
		}
	}
}
