import { App, Modal } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type { WatchLogTitle, WatchLogGroup, Season, TagDefinition } from './types';
import { formatTime, formatDateDisplay, parseDateInput, getThemedColor, getDisplayPoster } from './types';
import { appendNoteLinkButton } from './NoteLinkButton';
import { EditTitleModal } from './EditTitleModal';
import { ConfirmModal } from './ConfirmModal';
import { renderCommunityRating, maybeAutoRefreshCommunityRating } from './CommunityRating';

export class TitleDetailModal extends Modal {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private title: WatchLogTitle;
	private onChanged?: () => void;
	private changed = false;
	private collapsedSeasons: Set<number> = new Set();

	// Section anchors so we can re-render incrementally
	private statsBoxEl: HTMLElement | null = null;
	private episodesSectionEl: HTMLElement | null = null;
	private starsWrapEl: HTMLElement | null = null;

	constructor(
		app: App,
		plugin: WatchLogPlugin,
		title: WatchLogTitle,
		onChanged?: () => void,
	) {
		super(app);
		this.plugin = plugin;
		this.dataManager = plugin.dataManager;
		this.title = title;
		this.onChanged = onChanged;
		this.collapsedSeasons = this.dataManager.getCollapsedSeasonsForTitle(title.id);
	}

	onOpen(): void {
		const colorTheme = this.plugin.settings.colorTheme ?? 'default';
		// The theme CSS variables (--wl-watched-color, --wl-rating-color, ...)
		// are scoped to `.wl-view` and `.wl-view[data-theme=...]`. Mark the
		// content root with both so episode boxes, stars, and progress bars
		// pick up the active theme just like List view's expand does.
		this.modalEl.setAttribute('data-theme', colorTheme);
		this.contentEl.setAttribute('data-theme', colorTheme);
		this.contentEl.addClass('wl-view');
		this.contentEl.addClass('wl-detail-modal');
		this.renderAll();
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.changed && this.onChanged) {
			this.onChanged();
		}
	}

	private getTagDef(name: string, list: TagDefinition[]): TagDefinition | undefined {
		return list.find((d) => d.name === name);
	}

	private refreshTitle(): void {
		const fresh = this.dataManager.getTitle(this.title.id);
		if (fresh) this.title = fresh;
	}

	private markChanged(): void {
		this.changed = true;
	}

	private renderAll(): void {
		this.contentEl.empty();
		this.renderHeader(this.contentEl);
		this.renderEpisodesSection(this.contentEl);
		this.renderRatingSection(this.contentEl);
		this.renderNotesSection(this.contentEl);
		this.renderDateSection(this.contentEl);
		this.renderFooter(this.contentEl);
	}

	// ── Header ────────────────────────────────────────────────────────────────
	private renderHeader(parent: HTMLElement): void {
		const header = parent.createDiv({ cls: 'wl-detail-header' });
		const left = header.createDiv({ cls: 'wl-detail-header-left' });
		left.createEl('h2', { cls: 'wl-detail-title', text: this.title.title });

		const badgeRow = left.createDiv({ cls: 'wl-detail-badge-row' });
		const typeDef = this.getTagDef(this.title.type, this.plugin.settings.types);
		const typeColor = typeDef
			? getThemedColor(this.title.type, typeDef.color, this.plugin.settings.colorTheme)
			: '#888780';
		const typeBadge = badgeRow.createSpan({
			cls: 'wl-card-type-badge',
			text: this.title.type,
		});
		typeBadge.style.backgroundColor = typeColor;

		if (this.title.externalLink) {
			const linkIcon = badgeRow.createEl('a', { cls: 'wl-acc-link-icon', text: '🌐' });
			linkIcon.href = this.title.externalLink;
			linkIcon.title = 'Open external link';
			linkIcon.target = '_blank';
			linkIcon.rel = 'noopener noreferrer';
		}

		// Open the per-title .md note inside Obsidian, inline right after the globe.
		// Watchlist resolves its note path from the title; the shared helper builds
		// the button and handles opening / graceful failure.
		appendNoteLinkButton(
			this.app,
			badgeRow,
			this.dataManager.getNoteFilePath(this.title),
			() => this.close(),
		);

		// Editable status badge, inline to the right of the type badge / link icon.
		// Mirrors the Reading detail modal's clickable badge + dropdown, but draws
		// from the user-configured watchlist statuses and their colors.
		const statusWrap = badgeRow.createSpan({ cls: 'wl-reading-detail-status-wrap' });
		this.renderStatusBadge(statusWrap);

		this.statsBoxEl = header.createDiv({ cls: 'wl-detail-stats-box' });
		this.renderStatsBox();
	}

	private renderStatsBox(): void {
		if (!this.statsBoxEl) return;
		this.statsBoxEl.empty();
		const t = this.title;
		const timeLeft = this.dataManager.calcTimeRemainingForModal(t);
		const timeWatched = this.dataManager.calcTimeWatched(t);
		const watchedEps = t.watchedEpisodes.length;
		const effectiveTotal = this.dataManager.getEffectiveTotal(t);
		const progress = this.dataManager.getProgress(t);

		const makeBlock = (value: string, label: string): void => {
			const block = this.statsBoxEl!.createDiv({ cls: 'wl-acc-stat-block' });
			block.createDiv({ cls: 'wl-acc-percent', text: value });
			block.createDiv({ cls: 'wl-acc-progress-label', text: label });
		};
		makeBlock(formatTime(timeLeft), 'left');
		makeBlock(formatTime(timeWatched), 'watched');
		makeBlock(`${watchedEps} / ${effectiveTotal}`, 'episodes');

		const progBlock = this.statsBoxEl.createDiv({ cls: 'wl-acc-header-right' });
		progBlock.createDiv({ cls: 'wl-acc-percent', text: `${progress}%` });
		progBlock.createDiv({ cls: 'wl-acc-progress-label', text: 'progress' });
		const barWrap = progBlock.createDiv({ cls: 'wl-acc-progress-wrap' });
		barWrap.createDiv({ cls: 'wl-progress-bar' }).style.width = `${progress}%`;
	}

	// ── Episodes / Seasons ────────────────────────────────────────────────────
	private renderEpisodesSection(parent: HTMLElement): void {
		this.episodesSectionEl = parent.createDiv({ cls: 'wl-detail-episodes' });
		this.renderEpisodesBody();
	}

	private renderEpisodesBody(): void {
		if (!this.episodesSectionEl) return;
		this.episodesSectionEl.empty();
		const t = this.title;
		if (t.type === 'Movie') {
			const row = this.episodesSectionEl.createDiv({ cls: 'wl-movie-row' });
			const cb = row.createEl('input', {
				cls: 'wl-movie-checkbox',
				attr: { type: 'checkbox' },
			});
			cb.checked = t.watchedEpisodes.includes(1);
			row.createSpan({ cls: 'wl-movie-label', text: 'Watched' });
			cb.addEventListener('change', () => {
				void this.dataManager.markEpisodeWatched(t.id, 1, cb.checked).then(() => {
					this.refreshTitle();
					this.markChanged();
					this.renderStatsBox();
				});
			});
			return;
		}
		if (t.seasons.length === 0) {
			if (t.totalEpisodes > 0) {
				this.renderEpisodeGrid(this.episodesSectionEl, null);
			}
			return;
		}
		t.seasons.forEach((season, seasonIdx) => {
			let isCollapsed = this.collapsedSeasons.has(seasonIdx);
			const seasonWrap = this.episodesSectionEl!.createDiv({ cls: 'wl-season-wrap' });
			const seasonHeader = seasonWrap.createDiv({ cls: 'wl-season-header' });
			const badge = seasonHeader.createSpan({ cls: 'wl-season-badge' });
			badge.textContent = season.name;
			const palette = this.plugin.settings.seasonPalette;
			badge.style.backgroundColor = palette[seasonIdx % palette.length] ?? '#888780';
			const skipCount = (season.skippedEpisodes ?? []).length;
			const skipSuffix = skipCount > 0 ? ` (${skipCount} to skip)` : '';
			seasonHeader.createSpan({
				cls: 'wl-season-ep-count',
				text: `${season.episodes} eps${skipSuffix}`,
			});
			const chevron = seasonHeader.createSpan({
				cls: `wl-chevron${isCollapsed ? '' : ' is-open'}`,
				text: '›',
			});

			if (!isCollapsed) {
				this.renderEpisodeGrid(seasonWrap, season);
			}

			seasonHeader.addEventListener('click', () => {
				if (isCollapsed) {
					isCollapsed = false;
					this.collapsedSeasons.delete(seasonIdx);
					chevron.classList.add('is-open');
					this.renderEpisodeGrid(seasonWrap, season);
				} else {
					isCollapsed = true;
					this.collapsedSeasons.add(seasonIdx);
					chevron.classList.remove('is-open');
					seasonWrap.querySelector('.wl-episode-grid')?.remove();
				}
				void this.dataManager.persistCollapsedSeasons(this.title.id, this.collapsedSeasons);
			});
		});
	}

	private renderEpisodeGrid(parent: HTMLElement, season: Season | null): void {
		const t = this.title;
		const grid = parent.createDiv({ cls: 'wl-episode-grid' });
		const count = season ? season.episodes : t.totalEpisodes;
		const offset = season ? season.offset : 0;
		const seasonEps = Array.from({ length: count }, (_, i) => offset + i + 1);

		const fillBtn = grid.createDiv({ cls: 'wl-season-fill-btn' });
		const refreshFillBtn = (): void => {
			const watched = new Set(this.title.watchedEpisodes);
			const allWatched = seasonEps.length > 0 && seasonEps.every((ep) => watched.has(ep));
			fillBtn.classList.toggle('is-clear', allWatched);
			fillBtn.classList.toggle('is-fill', !allWatched);
			fillBtn.textContent = allWatched ? '✗' : '✓';
			fillBtn.title = allWatched
				? 'Clear all episodes in this season'
				: 'Mark all episodes in this season as watched';
		};
		refreshFillBtn();
		fillBtn.addEventListener('click', () => {
			const watched = new Set(this.title.watchedEpisodes);
			const allWatched = seasonEps.length > 0 && seasonEps.every((ep) => watched.has(ep));
			void this.dataManager
				.markSeasonWatched(this.title.id, seasonEps, !allWatched, season?.name)
				.then(() => {
					this.refreshTitle();
					this.markChanged();
					this.renderEpisodesBody();
					this.renderStatsBox();
				});
		});

		const perSeason = this.plugin.settings.episodeNumbering === 'per-season';
		for (let i = 0; i < count; i++) {
			const epNum = offset + i + 1;
			const relNum = i + 1;
			const displayNum = perSeason ? relNum : epNum;
			const box = grid.createDiv({ cls: 'wl-episode-box' });
			const refreshBox = (): void => {
				const isWatched = this.title.watchedEpisodes.includes(epNum);
				const isSkipped = season ? (season.skippedEpisodes ?? []).includes(relNum) : false;
				box.classList.toggle('is-watched', isWatched);
				box.classList.toggle('is-skipped', isSkipped);
				box.textContent = isSkipped && !isWatched ? '—' : isWatched ? '✓' : String(displayNum);
				box.title = `Episode ${epNum}${isSkipped ? ' (skipped)' : ''}`;
			};
			refreshBox();
			box.addEventListener('click', () => {
				const isWatched = this.title.watchedEpisodes.includes(epNum);
				this.dataManager.applyEpisodeWatchedToggle(this.title.id, epNum, !isWatched);
				this.refreshTitle();
				this.markChanged();
				refreshBox();
				refreshFillBtn();
				this.renderStatsBox();
			});
		}
	}

	// ── Rating ────────────────────────────────────────────────────────────────
	private renderRatingSection(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: 'wl-detail-rating' });
		wrap.createSpan({ cls: 'wl-stars-label', text: 'Rating' });
		this.starsWrapEl = wrap.createDiv({ cls: 'wl-stars wl-detail-stars' });
		this.renderStars();

		const rerenderCommunity = (): void => {
			const next = wrap.querySelector('.wl-rating-divider');
			let n: ChildNode | null = next;
			while (n) {
				const toRemove = n;
				n = n.nextSibling;
				toRemove.parentNode?.removeChild(toRemove);
			}
			renderCommunityRating(wrap, this.plugin, this.title.id, rerenderCommunity);
			this.refreshTitle();
		};
		renderCommunityRating(wrap, this.plugin, this.title.id, rerenderCommunity);
		maybeAutoRefreshCommunityRating(this.plugin, this.title.id, rerenderCommunity);
	}

	private renderStars(): void {
		if (!this.starsWrapEl) return;
		this.starsWrapEl.empty();
		for (let i = 1; i <= 5; i++) {
			const star = this.starsWrapEl.createSpan({
				cls: `wl-star${this.title.rating >= i ? ' is-active' : ''}`,
				text: '★',
			});
			star.addEventListener('click', () => {
				void (async () => {
					const t = this.dataManager.getTitle(this.title.id);
					if (!t) return;
					t.rating = t.rating === i ? 0 : i;
					await this.dataManager.updateTitle(t);
					this.refreshTitle();
					this.markChanged();
					this.renderStars();
				})();
			});
		}
	}

	// ── Notes ─────────────────────────────────────────────────────────────────
	private renderNotesSection(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: 'wl-detail-notes' });
		wrap.createSpan({ cls: 'wl-stars-label', text: 'Notes' });
		const textarea = wrap.createEl('textarea', {
			cls: 'wl-detail-notes-input',
			attr: { placeholder: 'Add notes...', rows: '3' },
		});
		textarea.value = this.title.notes;
		const autoResize = (): void => {
			textarea.setCssProps({ height: 'auto' });
			textarea.setCssProps({ height: `${textarea.scrollHeight}px` });
		};
		textarea.addEventListener('input', autoResize);
		window.setTimeout(autoResize, 0);
		textarea.addEventListener('blur', () => {
			if (textarea.value === this.title.notes) return;
			void (async () => {
				const t = this.dataManager.getTitle(this.title.id);
				if (!t) return;
				t.notes = textarea.value;
				await this.dataManager.updateTitle(t);
				this.refreshTitle();
				this.markChanged();
			})();
		});
	}

	// ── Date watched ──────────────────────────────────────────────────────────
	private renderDateSection(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: 'wl-detail-date' });
		wrap.createSpan({ cls: 'wl-stars-label', text: 'Date watched' });
		const todayBtn = wrap.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-footer-today-btn',
			text: 'Today',
		});
		const dateInput = wrap.createEl('input', {
			cls: 'wl-footer-date',
			attr: { type: 'text', placeholder: 'Dd/mm/yyyy', maxlength: '10' },
		});
		dateInput.value = formatDateDisplay(this.title.dateFinished);
		const refreshDimmed = (): void => {
			todayBtn.toggleClass('is-dimmed', !!dateInput.value.trim());
		};
		refreshDimmed();
		dateInput.addEventListener('change', () => {
			void (async () => {
				const t = this.dataManager.getTitle(this.title.id);
				if (!t) return;
				const parsed = parseDateInput(dateInput.value);
				if (dateInput.value.trim() && !parsed) {
					dateInput.addClass('wl-input-error');
					return;
				}
				dateInput.removeClass('wl-input-error');
				t.dateFinished = parsed;
				await this.dataManager.updateTitle(t);
				this.refreshTitle();
				this.markChanged();
				refreshDimmed();
			})();
		});
		todayBtn.addEventListener('click', () => {
			if (dateInput.value.trim()) return;
			const now = new Date();
			const dd = String(now.getDate()).padStart(2, '0');
			const mm = String(now.getMonth() + 1).padStart(2, '0');
			const yyyy = now.getFullYear();
			dateInput.value = `${dd}/${mm}/${yyyy}`;
			refreshDimmed();
			dateInput.dispatchEvent(new Event('change'));
		});
	}

	// ── Status ────────────────────────────────────────────────────────────────
	private statusColor(name: string): string {
		const def = this.getTagDef(name, this.plugin.settings.statuses);
		return def
			? getThemedColor(name, def.color, this.plugin.settings.colorTheme)
			: '#888780';
	}

	private renderStatusBadge(wrap: HTMLElement): void {
		wrap.empty();
		const status = this.title.status;
		const badge = wrap.createSpan({ cls: 'wl-reading-detail-status', text: status });
		badge.style.backgroundColor = this.statusColor(status);
		badge.title = 'Click to change status';
		badge.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openStatusDropdown(badge, wrap);
		});
	}

	private openStatusDropdown(anchor: HTMLElement, wrap: HTMLElement): void {
		this.contentEl.querySelectorAll('.wl-reading-status-dropdown').forEach((el) => el.remove());
		const rect = anchor.getBoundingClientRect();
		const dropdown = this.contentEl.createDiv({ cls: 'wl-reading-status-dropdown' });
		dropdown.style.top = `${rect.bottom + 4}px`;
		dropdown.style.left = `${rect.left}px`;
		// Capture the owning document once so add/remove can't desync across popout windows.
		const doc = this.contentEl.ownerDocument;

		for (const s of this.plugin.settings.statuses) {
			if (s.name === 'To be released') continue;
			const opt = dropdown.createDiv({ cls: 'wl-reading-status-option' });
			const dot = opt.createSpan({ cls: 'wl-reading-status-option-dot' });
			dot.style.backgroundColor = this.statusColor(s.name);
			opt.createSpan({ text: s.name });
			opt.addEventListener('click', () => {
				dropdown.remove();
				doc.removeEventListener('mousedown', closeListener, true);
				void this.saveStatus(s.name).then(() => this.renderStatusBadge(wrap));
			});
		}

		const closeListener = (e: MouseEvent): void => {
			if (!dropdown.contains(e.target as Node)) {
				dropdown.remove();
				doc.removeEventListener('mousedown', closeListener, true);
			}
		};
		window.setTimeout(() => doc.addEventListener('mousedown', closeListener, true), 0);
	}

	private async saveStatus(status: string): Promise<void> {
		const t = this.dataManager.getTitle(this.title.id);
		if (!t) return;
		t.status = status;
		await this.dataManager.updateTitle(t);
		this.refreshTitle();
		this.markChanged();
	}

	// ── Footer ────────────────────────────────────────────────────────────────
	private renderFooter(parent: HTMLElement): void {
		const footer = parent.createDiv({ cls: 'wl-detail-footer' });
		const removeBtn = footer.createEl('button', {
			cls: 'wl-delete-btn wl-btn-danger wl-detail-remove',
			text: 'Remove',
		});
		removeBtn.addEventListener('click', () => {
			new ConfirmModal(
				this.plugin.app,
				`Remove "${this.title.title}" from watchlog?`,
				() => {
					void this.dataManager.removeTitle(this.title.id).then(() => {
						this.markChanged();
						this.close();
					});
				},
			).open();
		});

		const editBtn = footer.createEl('button', {
			cls: 'wl-edit-btn wl-detail-edit',
			text: 'Edit',
		});
		editBtn.addEventListener('click', () => {
			const current = this.dataManager.getTitle(this.title.id);
			if (!current) return;
			this.close();
			new EditTitleModal(this.plugin.app, this.plugin, this.dataManager, current, () => {
				if (this.onChanged) this.onChanged();
			}).open();
		});
	}
}

// ── Group detail modal ──────────────────────────────────────────────────────
export class GroupDetailModal extends Modal {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private group: WatchLogGroup;
	private members: WatchLogTitle[];
	private onChanged?: () => void;
	private changed = false;

	constructor(
		app: App,
		plugin: WatchLogPlugin,
		group: WatchLogGroup,
		members: WatchLogTitle[],
		onChanged?: () => void,
	) {
		super(app);
		this.plugin = plugin;
		this.dataManager = plugin.dataManager;
		this.group = group;
		this.members = members;
		this.onChanged = onChanged;
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
		if (this.changed && this.onChanged) this.onChanged();
	}

	private renderAll(): void {
		this.contentEl.empty();
		const header = this.contentEl.createDiv({ cls: 'wl-detail-header' });
		const left = header.createDiv({ cls: 'wl-detail-header-left' });
		left.createEl('h2', { cls: 'wl-detail-title', text: this.group.name });
		left.createDiv({
			cls: 'wl-detail-group-meta',
			text: `${this.members.length} title${this.members.length !== 1 ? 's' : ''}`,
		});

		const totalEps = this.members.reduce(
			(s, m) => s + this.dataManager.getEffectiveTotal(m),
			0,
		);
		const watchedEps = this.members.reduce((s, m) => s + m.watchedEpisodes.length, 0);
		const progress = totalEps > 0 ? Math.round((watchedEps / totalEps) * 100) : 0;
		const statsBox = header.createDiv({ cls: 'wl-detail-stats-box' });
		const progBlock = statsBox.createDiv({ cls: 'wl-acc-header-right' });
		progBlock.createDiv({ cls: 'wl-acc-percent', text: `${progress}%` });
		progBlock.createDiv({ cls: 'wl-acc-progress-label', text: 'progress' });
		const barWrap = progBlock.createDiv({ cls: 'wl-acc-progress-wrap' });
		barWrap.createDiv({ cls: 'wl-progress-bar' }).style.width = `${progress}%`;

		const grid = this.contentEl.createDiv({ cls: 'wl-cards-grid wl-detail-group-grid' });
		for (const m of this.members) {
			const card = buildTitleCardElement(this.plugin, m, {
				onOpenDetail: () => {
					this.close();
					new TitleDetailModal(this.plugin.app, this.plugin, m, () => {
						this.changed = true;
						if (this.onChanged) this.onChanged();
					}).open();
				},
				onEdit: () => {
					this.close();
					new EditTitleModal(
						this.plugin.app,
						this.plugin,
						this.dataManager,
						m,
						() => {
							this.changed = true;
							if (this.onChanged) this.onChanged();
						},
					).open();
				},
			});
			grid.appendChild(card);
		}
	}
}

// Builds a standalone .wl-card element matching the Cards grid look. Used by
// the Cards grid (via ListTab) and by GroupDetailModal so member tiles look
// identical to the main view. Posters with no cached URL get fetched eagerly
// here since a group modal has a small, finite member count.
export function buildTitleCardElement(
	plugin: WatchLogPlugin,
	title: WatchLogTitle,
	handlers: { onOpenDetail: () => void; onEdit: () => void },
): HTMLElement {
	const settings = plugin.settings;
	const typeDef = settings.types.find((d) => d.name === title.type);
	const statusDef = settings.statuses.find((d) => d.name === title.status);
	const typeColor = typeDef
		? getThemedColor(title.type, typeDef.color, settings.colorTheme)
		: '#888780';

	const tmp = activeDocument.createElement('div');
	const card = tmp.createDiv({ cls: 'wl-card' });
	card.dataset.titleId = title.id;

	const placeholder = card.createDiv({ cls: 'wl-card-poster-placeholder' });
	placeholder.style.backgroundColor = typeColor;
	const letter = (title.title.trim().charAt(0) || '?').toUpperCase();
	placeholder.createSpan({ text: letter });

	const img = card.createEl('img', { cls: 'wl-card-poster' });
	img.alt = title.title;

	const showImg = (url: string): void => {
		img.src = url;
		card.addClass('has-poster');
	};
	const showPlaceholder = (): void => {
		card.removeClass('has-poster');
	};

	const display = getDisplayPoster(title);
	const isManual = !!(title.manualPosterUrl && title.manualPosterUrl.trim() !== '');
	if (display && display.startsWith('http')) {
		showImg(display);
		img.onerror = () => {
			showPlaceholder();
			if (!isManual) plugin.dataManager.updatePosterUrl(title.id, 'none');
		};
	} else if (!isManual && title.posterUrl === '') {
		placeholder.addClass('is-loading');
		void plugin.posterService?.enqueue(title).then((url) => {
			placeholder.removeClass('is-loading');
			if (url) showImg(url);
		});
	}

	if (statusDef) {
		const statusBadge = card.createSpan({
			cls: 'wl-card-status-badge',
			text: title.status,
		});
		statusBadge.style.backgroundColor = getThemedColor(
			title.status,
			statusDef.color,
			settings.colorTheme,
		);
	}

	const overlay = card.createDiv({ cls: 'wl-card-overlay' });
	overlay.createSpan({ cls: 'wl-card-title', text: title.title });
	const typeBadge = overlay.createSpan({ cls: 'wl-card-type-badge', text: title.type });
	typeBadge.style.backgroundColor = typeColor;

	const total = title.totalEpisodes;
	if (total && total > 0) {
		const isCompleted = title.status === 'Completed';
		const ratio = isCompleted
			? 1
			: Math.max(0, Math.min(1, title.watchedEpisodes.length / total));
		const bar = overlay.createDiv({ cls: 'wl-card-progress-bar' });
		const fill = bar.createDiv({ cls: 'wl-card-progress-fill' });
		fill.style.width = `${ratio * 100}%`;
	}

	const menuBtn = card.createEl('button', { cls: 'wl-card-menu-btn', text: '⋮' });
	menuBtn.setAttr('aria-label', 'Edit');
	menuBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		handlers.onEdit();
	});

	card.addEventListener('click', () => handlers.onOpenDetail());

	return card;
}
