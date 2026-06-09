import { MarkdownPostProcessorContext } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type { WatchLogTitle, TagDefinition } from './types';
import { formatTime, getThemedColor } from './types';

export class WidgetRenderer {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;

	/**
	 * Registry of all currently-rendered widget container elements.
	 * el → titleId. Stale (disconnected) entries are removed lazily.
	 */
	private widgetRegistry = new Map<HTMLElement, string>();
	/** Tracks which registered widgets are in mini mode (for correct re-render on data change). */
	private widgetMiniRegistry = new Map<HTMLElement, boolean>();
	/** Generic re-render hooks for non-todo widgets (stats, upcoming, now-watching, now-next). */
	private widgetRerender = new Map<HTMLElement, () => void>();
	private dataChangedListener: EventListener;

	constructor(plugin: WatchLogPlugin, dataManager: DataManager) {
		this.plugin = plugin;
		this.dataManager = dataManager;

		this.plugin.registerMarkdownCodeBlockProcessor(
			'watchlog',
			(source, el, ctx) => this.process(source, el, ctx),
		);

		this.plugin.registerMarkdownCodeBlockProcessor(
			'wl-todo',
			(source, el, _ctx) => this.processWlTodo(source, el),
		);

		this.plugin.registerMarkdownCodeBlockProcessor(
			'wl-stat',
			(source, el, _ctx) => this.processWlStat(source, el),
		);

		this.plugin.registerMarkdownCodeBlockProcessor(
			'wl-upcoming',
			(source, el, _ctx) => this.processWlUpcoming(source, el),
		);

		this.plugin.registerMarkdownCodeBlockProcessor(
			'wl-nowwatching',
			(source, el, _ctx) => this.processWlNowWatching(source, el),
		);

		this.plugin.registerMarkdownCodeBlockProcessor(
			'wl-now-next',
			(source, el, _ctx) => this.processWlNowNext(source, el),
		);

		// Re-render all active widgets when data changes (list → widget sync)
		this.dataChangedListener = () => this.onDataChanged();
		activeDocument.addEventListener('watchlog-data-changed', this.dataChangedListener);

		// Clean up listener when plugin unloads
		plugin.register(() => {
			activeDocument.removeEventListener('watchlog-data-changed', this.dataChangedListener);
		});
	}

	/** Called by the `watchlog-data-changed` DOM event. Re-renders all live widgets. */
	private onDataChanged(): void {
		const stale: HTMLElement[] = [];

		for (const [el, titleId] of this.widgetRegistry) {
			if (!el.isConnected) {
				stale.push(el);
				continue;
			}
			const title = this.dataManager.getTitle(titleId);
			if (!title) {
				stale.push(el);
				continue;
			}
			const isMini = this.widgetMiniRegistry.get(el) ?? false;
			if (isMini) {
				this.renderWidgetMinimal(el, title);
			} else {
				this.renderWidget(el, title);
			}
		}

		for (const el of stale) {
			this.widgetRegistry.delete(el);
			this.widgetMiniRegistry.delete(el);
		}

		const staleGeneric: HTMLElement[] = [];
		for (const [el, rerender] of this.widgetRerender) {
			if (!el.isConnected) {
				staleGeneric.push(el);
				continue;
			}
			try { rerender(); } catch (e) { console.warn('[WL] widget rerender failed:', e); }
		}
		for (const el of staleGeneric) this.widgetRerender.delete(el);
	}

	/** Clear all widget registries (plugin unload). */
	cleanup(): void {
		this.widgetRegistry.clear();
		this.widgetMiniRegistry.clear();
		this.widgetRerender.clear();
	}

	private process(
		source: string,
		el: HTMLElement,
		_ctx: MarkdownPostProcessorContext,
	): void {
		const idMatch = source.match(/id:\s*(.+)/);
		const id = idMatch?.[1]?.trim();
		if (!id) {
			el.createDiv({ cls: 'wl-widget-error', text: 'WatchLog: missing id field.' });
			return;
		}

		const title = this.dataManager.getTitle(id);
		if (!title) {
			el.createDiv({
				cls: 'wl-widget-error',
				text: `WatchLog: title "${id}" not found.`,
			});
			return;
		}

		// Register so this widget is re-rendered on future data changes
		this.widgetRegistry.set(el, id);

		this.renderWidget(el, title);
	}

	private renderWidget(el: HTMLElement, title: WatchLogTitle): void {
		this.renderWidgetFull(el, title);
	}

	private renderWidgetFull(el: HTMLElement, title: WatchLogTitle): void {
		el.empty();
		el.addClass('wl-widget');

		const mainRow = el.createDiv({ cls: 'wl-widget-main-row' });

		// ── Checkbox 1: visual-only task indicator ─────────────────────────────
		// Does NOT modify WatchLog data — purely a personal note marker.
		const taskCb = mainRow.createEl('input', {
			cls: 'wl-widget-cb',
			attr: { type: 'checkbox' },
		});
		taskCb.title = 'Personal task marker (does not affect watchlog data)';
		taskCb.addEventListener('change', () => {
			const titleSpan = mainRow.querySelector<HTMLElement>('.wl-widget-title');
			if (titleSpan) {
				titleSpan.style.textDecoration = taskCb.checked ? 'line-through' : '';
				titleSpan.style.opacity = taskCb.checked ? '0.5' : '';
			}
		});

		// Title
		mainRow.createSpan({ cls: 'wl-widget-title', text: title.title });

		this.sep(mainRow);

		// Type badge (respects coloredTypeBadges setting)
		const typeDef = this.getTagDef(title.type, this.plugin.settings.types);
		const colored = this.plugin.settings.coloredTypeBadges;
		const typeBadge = mainRow.createSpan({
			cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain',
			text: title.type,
		});
		if (colored && typeDef) typeBadge.style.backgroundColor = getThemedColor(title.type, typeDef.color, this.plugin.settings.colorTheme);

		this.sep(mainRow);

		// Status badge (respects coloredTypeBadges setting)
		const statusDef = this.getTagDef(title.status, this.plugin.settings.statuses);
		const statusBadge = mainRow.createSpan({
			cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain',
			text: title.status,
		});
		if (colored && statusDef) statusBadge.style.backgroundColor = getThemedColor(title.status, statusDef.color, this.plugin.settings.colorTheme);

		this.sep(mainRow);

		// Progress bar
		const progress = this.dataManager.getProgress(title);
		const barWrap = mainRow.createDiv({ cls: 'wl-widget-bar-wrap' });
		barWrap.createDiv({ cls: 'wl-progress-bar' }).style.width = `${progress}%`;

		this.sep(mainRow);

		// Percentage
		mainRow.createSpan({ cls: 'wl-widget-percent', text: `${progress}%` });

		this.sep(mainRow);

		// Date label
		const dateStr = title.dateStarted ?? title.dateAdded;
		const dateLabel = title.dateStarted
			? `since ${this.formatShortDate(dateStr)}`
			: `added ${this.formatShortDate(dateStr)}`;
		mainRow.createSpan({ cls: 'wl-widget-date', text: dateLabel });

		// ── Checkbox 2: "Next up" — writes to WatchLog data ───────────────────
		const isMovie = title.type === 'Movie';
		if (!isMovie) {
			const nextEp = this.dataManager.getNextUnwatchedEpisode(title);
			const nextRow = el.createDiv({ cls: 'wl-widget-next-row' });

			if (nextEp !== null) {
				const nextCb = nextRow.createEl('input', {
					cls: 'wl-widget-next-cb',
					attr: { type: 'checkbox' },
				});
				nextCb.checked = false;
				nextCb.title = `Mark Episode ${nextEp} as watched`;
				nextCb.addEventListener('change', () => {
					void this.dataManager.markEpisodeWatched(title.id, nextEp, true).then(() => {
						const updated = this.dataManager.getTitle(title.id);
						if (updated) this.renderWidget(el, updated);
					});
				});
				nextRow.createSpan({ cls: 'wl-widget-next-label', text: `Next up: Ep ${nextEp}` });
			} else {
				nextRow.createSpan({ cls: 'wl-widget-next-label', text: '✓ All episodes watched' });
			}
		} else {
			// Movie: watch checkbox that writes to WatchLog data
			const watchRow = el.createDiv({ cls: 'wl-widget-next-row' });
			const watched = title.watchedEpisodes.includes(1);
			const movieCb = watchRow.createEl('input', {
				cls: 'wl-widget-next-cb',
				attr: { type: 'checkbox' },
			});
			movieCb.checked = watched;
			movieCb.title = 'Mark movie as watched';
			movieCb.addEventListener('change', () => {
				void this.dataManager.markEpisodeWatched(title.id, 1, movieCb.checked).then(() => {
					const updated = this.dataManager.getTitle(title.id);
					if (updated) this.renderWidget(el, updated);
				});
			});
			watchRow.createSpan({
				cls: 'wl-widget-next-label',
				text: watched ? 'Watched' : 'Mark as watched',
			});
		}
	}

	private renderWidgetMinimal(el: HTMLElement, title: WatchLogTitle): void {
		el.empty();
		el.addClass('wl-widget-minimal');

		const row = el.createDiv({ cls: 'wl-widget-minimal-row' });

		// Left checkbox: visual-only task marker
		const taskCb = row.createEl('input', {
			cls: 'wl-widget-cb',
			attr: { type: 'checkbox' },
		});
		taskCb.title = 'Personal task marker (does not affect watchlog data)';
		taskCb.addEventListener('change', () => {
			const titleSpan = row.querySelector<HTMLElement>('.wl-widget-title');
			if (titleSpan) {
				titleSpan.style.textDecoration = taskCb.checked ? 'line-through' : '';
				titleSpan.style.opacity = taskCb.checked ? '0.5' : '';
			}
		});

		// Title
		row.createSpan({ cls: 'wl-widget-title', text: title.title });

		this.sep(row);

		// Type badge
		const typeDef = this.getTagDef(title.type, this.plugin.settings.types);
		const colored = this.plugin.settings.coloredTypeBadges;
		const typeBadge = row.createSpan({
			cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain',
			text: title.type,
		});
		if (colored && typeDef) typeBadge.style.backgroundColor = getThemedColor(title.type, typeDef.color, this.plugin.settings.colorTheme);

		this.sep(row);

		// Status badge (respects coloredTypeBadges setting)
		const statusDef = this.getTagDef(title.status, this.plugin.settings.statuses);
		const statusBadge = row.createSpan({
			cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain',
			text: title.status,
		});
		if (colored && statusDef) statusBadge.style.backgroundColor = getThemedColor(title.status, statusDef.color, this.plugin.settings.colorTheme);

		this.sep(row);

		// Progress %
		const progress = this.dataManager.getProgress(title);
		row.createSpan({ cls: 'wl-widget-percent', text: `${progress}%` });

		this.sep(row);

		// Right checkbox: "Mark as watched" / next episode
		const isMovie = title.type === 'Movie';
		if (isMovie) {
			const watched = title.watchedEpisodes.includes(1);
			const movieCb = row.createEl('input', {
				cls: 'wl-widget-next-cb',
				attr: { type: 'checkbox' },
			});
			movieCb.checked = watched;
			movieCb.title = 'Mark movie as watched';
			movieCb.addEventListener('change', () => {
				void this.dataManager.markEpisodeWatched(title.id, 1, movieCb.checked).then(() => {
					const updated = this.dataManager.getTitle(title.id);
					if (updated) this.renderWidgetMinimal(el, updated);
				});
			});
		} else {
			const nextEp = this.dataManager.getNextUnwatchedEpisode(title);
			const nextCb = row.createEl('input', {
				cls: 'wl-widget-next-cb',
				attr: { type: 'checkbox' },
			});
			if (nextEp !== null) {
				nextCb.checked = false;
				nextCb.title = `Mark Episode ${nextEp} as watched`;
				nextCb.addEventListener('change', () => {
					void this.dataManager.markEpisodeWatched(title.id, nextEp, true).then(() => {
						const updated = this.dataManager.getTitle(title.id);
						if (updated) this.renderWidgetMinimal(el, updated);
					});
				});
			} else {
				nextCb.checked = true;
				nextCb.disabled = true;
				nextCb.title = 'All episodes watched';
			}
		}
	}

	private sep(parent: HTMLElement): void {
		parent.createSpan({ cls: 'wl-widget-sep', text: '·' });
	}

	private getTagDef(name: string, tags: TagDefinition[]): TagDefinition | undefined {
		return tags.find((t) => t.name === name);
	}

	private formatShortDate(dateStr: string): string {
		try {
			const d = new Date(dateStr);
			return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`;
		} catch {
			return dateStr;
		}
	}

	// ── wl-todo ───────────────────────────────────────────────────────────────────

	private processWlTodo(source: string, el: HTMLElement): void {
		const lines = source.trim().split('\n').map((l) => l.trim()).filter(Boolean);
		const isMini = lines.includes('mini');
		const titleName = lines.find((l) => l !== 'mini') ?? '';
		if (!titleName) {
			el.createDiv({ cls: 'wl-widget-error', text: 'wl-todo: missing title name.' });
			return;
		}
		const title = this.dataManager.getTitles().find(
			(t) => t.title.toLowerCase() === titleName.toLowerCase(),
		);
		if (!title) {
			el.createDiv({ cls: 'wl-widget-error', text: `wl-todo: "${titleName}" not found.` });
			return;
		}
		this.widgetRegistry.set(el, title.id);
		this.widgetMiniRegistry.set(el, isMini);
		if (isMini) {
			this.renderWidgetMinimal(el, title);
		} else {
			this.renderWidget(el, title);
		}
	}

	// ── wl-stat ───────────────────────────────────────────────────────────────────

	private processWlStat(source: string, el: HTMLElement): void {
		this.widgetRerender.set(el, () => this.renderWlStat(source, el));
		this.renderWlStat(source, el);
	}

	private renderWlStat(source: string, el: HTMLElement): void {
		const kind = source.trim().toLowerCase();
		el.empty();
		el.addClass('wl-wstat');

		if (kind === 'watched') {
			const minutes = this.dataManager.getTotalTimeWatched();
			this.renderStatCard(el, '🕐', formatTime(minutes), 'watched');
		} else if (kind === 'completed') {
			const count = this.dataManager.getCompletedCount();
			this.renderStatCard(el, '✅', `${count} titles`, 'completed');
		} else if (kind === 'remaining') {
			const minutes = this.dataManager.getTotalTimeRemaining();
			this.renderStatCard(el, '⏳', formatTime(minutes), 'remaining');
		} else if (kind === 'time') {
			const watched = this.dataManager.getTotalTimeWatched();
			const remaining = this.dataManager.getTotalTimeRemaining();
			this.renderTimeCardMini(el, watched, remaining);
		} else if (kind === 'time full') {
			const watched = this.dataManager.getTotalTimeWatched();
			const remaining = this.dataManager.getTotalTimeRemaining();
			this.renderTimeCardFull(el, watched, remaining);
		} else if (kind === 'completed full') {
			const count = this.dataManager.getCompletedCount();
			this.renderCompletedCardFull(el, count);
		} else if (kind === 'time completed full') {
			const watched = this.dataManager.getTotalTimeWatched();
			const remaining = this.dataManager.getTotalTimeRemaining();
			const count = this.dataManager.getCompletedCount();
			this.renderTripleStatCard(el, watched, remaining, count);
		} else {
			el.createDiv({ cls: 'wl-widget-error', text: `wl-stat: unknown stat "${kind}". Use watched, completed, remaining, time, time full, completed full, or time completed full.` });
		}
	}

	private renderStatCard(el: HTMLElement, icon: string, value: string, label: string): void {
		el.empty();
		const card = el.createDiv({ cls: 'wl-stat-card' });
		card.createSpan({ cls: 'wl-stat-icon', text: icon });
		card.createSpan({ cls: 'wl-stat-value', text: value });
		card.createSpan({ cls: 'wl-stat-label', text: label });
	}

	private renderTimeCardMini(el: HTMLElement, watchedMins: number, remainingMins: number): void {
		el.empty();
		const card = el.createDiv({ cls: 'wl-stat-card wl-stat-card-time' });
		card.createSpan({ cls: 'wl-stat-icon', text: '🕐' });
		card.createSpan({ cls: 'wl-stat-value', text: formatTime(watchedMins) });
		card.createSpan({ cls: 'wl-stat-label', text: 'watched' });
		card.createSpan({ cls: 'wl-stat-sep', text: '·' });
		card.createSpan({ cls: 'wl-stat-icon', text: '⏳' });
		card.createSpan({ cls: 'wl-stat-value', text: formatTime(remainingMins) });
		card.createSpan({ cls: 'wl-stat-label', text: 'left' });
	}

	private renderTimeCardFull(el: HTMLElement, watchedMins: number, remainingMins: number): void {
		el.empty();
		const card = el.createDiv({ cls: 'wl-full-card wl-full-card-time' });
		card.createDiv({ cls: 'wl-full-card-header', text: 'Time' });
		const cols = card.createDiv({ cls: 'wl-full-card-time-cols' });
		const makeCol = (mins: number, label: string) => {
			const col = cols.createDiv({ cls: 'wl-full-card-time-col' });
			col.createDiv({ cls: 'wl-full-card-value', text: formatTime(mins) });
			col.createDiv({ cls: 'wl-full-card-days', text: this.formatTimeDays(mins) });
			col.createDiv({ cls: 'wl-full-card-sub', text: label });
		};
		makeCol(watchedMins, 'watched');
		makeCol(remainingMins, 'remaining');
	}

	private formatTimeDays(minutes: number): string {
		const days = Math.floor(minutes / 1440);
		const hours = Math.floor((minutes % 1440) / 60);
		if (days === 0) return hours > 0 ? `${hours}h` : '0h';
		return `${days} days ${hours}h`;
	}

	private renderCompletedCardFull(el: HTMLElement, count: number): void {
		el.empty();
		const card = el.createDiv({ cls: 'wl-full-card' });
		card.createDiv({ cls: 'wl-full-card-header', text: 'Completed' });
		card.createDiv({ cls: 'wl-full-card-value', text: String(count) });
		card.createDiv({ cls: 'wl-full-card-sub', text: 'titles completed' });
	}

	private renderTripleStatCard(el: HTMLElement, watchedMins: number, remainingMins: number, completed: number): void {
		el.empty();
		el.addClass('wl-wstat-triple');
		const card = el.createDiv({ cls: 'wl-full-card wl-full-card-triple' });
		const cols = card.createDiv({ cls: 'wl-triple-cols' });

		const makeTimeCol = (mins: number, label: string) => {
			const col = cols.createDiv({ cls: 'wl-triple-col' });
			col.createDiv({ cls: 'wl-full-card-value', text: formatTime(mins) });
			col.createDiv({ cls: 'wl-full-card-days', text: this.formatTimeDays(mins) });
			col.createDiv({ cls: 'wl-full-card-sub', text: label });
		};

		makeTimeCol(watchedMins, 'watched');
		cols.createDiv({ cls: 'wl-vert-sep' });
		makeTimeCol(remainingMins, 'remaining');
		cols.createDiv({ cls: 'wl-vert-sep' });

		const completedCol = cols.createDiv({ cls: 'wl-triple-col' });
		completedCol.createDiv({ cls: 'wl-full-card-value', text: String(completed) });
		completedCol.createDiv({ cls: 'wl-full-card-sub', text: 'completed' });
	}

	// ── wl-upcoming ───────────────────────────────────────────────────────────────

	private processWlUpcoming(source: string, el: HTMLElement): void {
		this.widgetRerender.set(el, () => this.renderWlUpcoming(source, el));
		this.renderWlUpcoming(source, el);
	}

	private renderWlUpcoming(source: string, el: HTMLElement): void {
		el.empty();
		const kind = source.trim().toLowerCase();
		const isFull = kind === 'next full';
		if (kind !== 'next' && kind !== 'next full') {
			el.createDiv({ cls: 'wl-widget-error', text: 'wl-upcoming: only "next" or "next full" is supported.' });
			return;
		}

		const entries = this.dataManager.getAirtimeEntries();
		const titles = this.dataManager.getTitles();
		const titleMap = new Map(titles.map((t) => [t.id, t]));

		// Find the entry with the soonest future release date
		const now = Date.now();
		let bestEntry: { titleName: string; type: string; releaseDate: string; daysUntil: number } | null = null;
		let bestMs = Infinity;

		for (const entry of entries) {
			const title = titleMap.get(entry.titleId);
			if (!title || entry.schedule.recurrence !== 'once' || !entry.schedule.releaseDate) continue;
			const ms = new Date(entry.schedule.releaseDate + 'T12:00:00').getTime();
			if (ms >= now && ms < bestMs) {
				bestMs = ms;
				const daysUntil = Math.round((ms - now) / 86400000);
				bestEntry = {
					titleName: title.title,
					type: title.type,
					releaseDate: entry.schedule.releaseDate,
					daysUntil,
				};
			}
		}

		el.addClass('wl-wupcoming');

		if (isFull) {
			this.renderUpcomingFull(el, bestEntry);
			return;
		}

		if (!bestEntry) {
			el.createDiv({ cls: 'wl-upcoming-card wl-upcoming-empty', text: 'No upcoming titles.' });
			return;
		}

		const card = el.createDiv({ cls: 'wl-upcoming-card' });
		card.createSpan({ cls: 'wl-upcoming-title', text: bestEntry.titleName });

		const typeDef = this.getTagDef(bestEntry.type, this.plugin.settings.types);
		const colored = this.plugin.settings.coloredTypeBadges;
		const badge = card.createSpan({
			cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain',
			text: bestEntry.type,
		});
		if (colored && typeDef) badge.style.backgroundColor = getThemedColor(bestEntry.type, typeDef.color, this.plugin.settings.colorTheme);

		card.createSpan({ cls: 'wl-upcoming-date', text: bestEntry.releaseDate });
		const daysUntil = bestEntry.daysUntil;
		const monthSuffix = daysUntil >= 30 ? ` (${Math.round(daysUntil / 30)} month${Math.round(daysUntil / 30) !== 1 ? 's' : ''})` : '';
		const countdown = daysUntil === 0 ? 'today' : daysUntil === 1 ? 'tomorrow' : `in ${daysUntil} days${monthSuffix}`;
		card.createSpan({ cls: 'wl-upcoming-countdown', text: countdown });
	}

	private renderUpcomingFull(
		el: HTMLElement,
		bestEntry: { titleName: string; type: string; releaseDate: string; daysUntil: number } | null,
	): void {
		el.empty();
		const card = el.createDiv({ cls: 'wl-full-card' });
		card.createDiv({ cls: 'wl-full-card-header', text: 'Up Next' });
		if (!bestEntry) {
			card.createDiv({ cls: 'wl-full-card-sub', text: 'No upcoming titles.' });
			return;
		}
		card.createDiv({ cls: 'wl-full-card-title', text: bestEntry.titleName });
		const meta = card.createDiv({ cls: 'wl-full-card-meta' });
		const typeDef = this.getTagDef(bestEntry.type, this.plugin.settings.types);
		const colored = this.plugin.settings.coloredTypeBadges;
		const badge = meta.createSpan({
			cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain',
			text: bestEntry.type,
		});
		if (colored && typeDef) badge.style.backgroundColor = getThemedColor(bestEntry.type, typeDef.color, this.plugin.settings.colorTheme);
		const daysUntil = bestEntry.daysUntil;
		const countdown = daysUntil === 0 ? 'today' : daysUntil === 1 ? 'tomorrow' : `in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}`;
		meta.createSpan({ text: countdown });
		meta.createSpan({ cls: 'wl-full-card-sub', text: bestEntry.releaseDate });
	}

	// ── wl-nowwatching ────────────────────────────────────────────────────────────

	private processWlNowWatching(source: string, el: HTMLElement): void {
		this.widgetRerender.set(el, () => this.renderWlNowWatching(source, el));
		this.renderWlNowWatching(source, el);
	}

	private renderWlNowWatching(source: string, el: HTMLElement): void {
		el.empty();
		const isFull = source.trim().toLowerCase() === 'full';
		el.addClass('wl-wnowwatching');

		const pinnedTitle = this.dataManager.getTitles().find((t) => t.pinned);
		const pinnedGroupId = this.dataManager.getPinnedGroupId();
		const pinnedGroup = pinnedGroupId
			? this.dataManager.getGroups().find((g) => g.id === pinnedGroupId)
			: null;

		if (isFull) {
			this.renderNowWatchingFull(el, pinnedTitle ?? null, pinnedGroup ?? null);
			return;
		}

		if (!pinnedTitle && !pinnedGroup) {
			el.createDiv({ cls: 'wl-nowwatching-card wl-nowwatching-empty', text: 'Pin a title to set it as now watching.' });
			return;
		}

		const card = el.createDiv({ cls: 'wl-nowwatching-card' });

		if (pinnedGroup) {
			card.createSpan({ cls: 'wl-nowwatching-title', text: pinnedGroup.name });
			const allTitles = this.dataManager.getTitles();
			const titleMap = new Map(allTitles.map((t) => [t.id, t]));
			const members = pinnedGroup.titleIds
				.map((id) => titleMap.get(id))
				.filter((t): t is WatchLogTitle => t !== undefined);
			const totalWatched = members.reduce((s, t) => s + t.watchedEpisodes.length, 0);
			const totalEps = members.reduce((s, t) => s + this.dataManager.getEffectiveTotal(t), 0);
			const progress = totalEps > 0 ? Math.min(100, Math.round((totalWatched / totalEps) * 100)) : 0;
			card.createSpan({ cls: 'wl-nowwatching-ep', text: `${members.length} title${members.length !== 1 ? 's' : ''}` });
			const barWrap = card.createDiv({ cls: 'wl-nowwatching-bar-wrap' });
			barWrap.createDiv({ cls: 'wl-nowwatching-bar' }).style.width = `${progress}%`;
			card.createSpan({ cls: 'wl-nowwatching-pct', text: `${progress}%` });
			return;
		}

		const pinned = pinnedTitle!;
		card.createSpan({ cls: 'wl-nowwatching-title', text: pinned.title });

		const typeDef = this.getTagDef(pinned.type, this.plugin.settings.types);
		const colored = this.plugin.settings.coloredTypeBadges;
		const badge = card.createSpan({
			cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain',
			text: pinned.type,
		});
		if (colored && typeDef) badge.style.backgroundColor = getThemedColor(pinned.type, typeDef.color, this.plugin.settings.colorTheme);

		if (pinned.type !== 'Movie') {
			const nextEp = this.dataManager.getNextUnwatchedEpisode(pinned);
			card.createSpan({ cls: 'wl-nowwatching-ep', text: nextEp !== null ? `Ep ${nextEp}` : '✓ Completed' });
		}

		const progress = this.dataManager.getProgress(pinned);
		const barWrap = card.createDiv({ cls: 'wl-nowwatching-bar-wrap' });
		const bar = barWrap.createDiv({ cls: 'wl-nowwatching-bar' });
		bar.style.width = `${progress}%`;
		card.createSpan({ cls: 'wl-nowwatching-pct', text: `${progress}%` });
	}

	private renderNowWatchingFull(
		el: HTMLElement,
		pinnedTitle: WatchLogTitle | null,
		pinnedGroup: import('./types').WatchLogGroup | null,
	): void {
		el.empty();
		const card = el.createDiv({ cls: 'wl-full-card wl-full-card-nw' });
		card.createDiv({ cls: 'wl-full-card-header', text: 'NOW WATCHING' });

		if (!pinnedTitle && !pinnedGroup) {
			card.createDiv({ cls: 'wl-full-card-sub', text: 'Pin a title to set it as now watching.' });
			return;
		}

		if (pinnedGroup) {
			card.createDiv({ cls: 'wl-full-card-title', text: pinnedGroup.name });
			const allTitles = this.dataManager.getTitles();
			const titleMap = new Map(allTitles.map((t) => [t.id, t]));
			const members = pinnedGroup.titleIds
				.map((id) => titleMap.get(id))
				.filter((t): t is WatchLogTitle => t !== undefined);
			const totalWatched = members.reduce((s, t) => s + t.watchedEpisodes.length, 0);
			const totalEps = members.reduce((s, t) => s + this.dataManager.getEffectiveTotal(t), 0);
			const progress = totalEps > 0 ? Math.min(100, Math.round((totalWatched / totalEps) * 100)) : 0;
			const bottomRow = card.createDiv({ cls: 'wl-nw-bottom-row' });
			bottomRow.createSpan({ cls: 'wl-full-card-sub', text: `${members.length} title${members.length !== 1 ? 's' : ''}` });
			const barCol = bottomRow.createDiv({ cls: 'wl-nw-bar-col' });
			barCol.createDiv({ cls: 'wl-nw-pct', text: `${progress}%` });
			barCol.createDiv({ cls: 'wl-full-card-bar-wrap' }).createDiv({ cls: 'wl-full-card-bar' }).style.width = `${progress}%`;
			return;
		}

		const pinned = pinnedTitle!;
		card.createDiv({ cls: 'wl-full-card-title', text: pinned.title });

		const progress = this.dataManager.getProgress(pinned);
		const bottomRow = card.createDiv({ cls: 'wl-nw-bottom-row' });

		const typeDef = this.getTagDef(pinned.type, this.plugin.settings.types);
		const colored = this.plugin.settings.coloredTypeBadges;
		const badge = bottomRow.createSpan({
			cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain',
			text: pinned.type,
		});
		if (colored && typeDef) badge.style.backgroundColor = getThemedColor(pinned.type, typeDef.color, this.plugin.settings.colorTheme);

		const barCol = bottomRow.createDiv({ cls: 'wl-nw-bar-col' });
		barCol.createDiv({ cls: 'wl-nw-pct', text: `${progress}%` });
		barCol.createDiv({ cls: 'wl-full-card-bar-wrap' }).createDiv({ cls: 'wl-full-card-bar' }).style.width = `${progress}%`;
	}

	// ── wl-now-next ───────────────────────────────────────────────────────────────

	private processWlNowNext(source: string, el: HTMLElement): void {
		this.widgetRerender.set(el, () => this.renderWlNowNext(source, el));
		this.renderWlNowNext(source, el);
	}

	private renderWlNowNext(_source: string, el: HTMLElement): void {
		el.empty();
		el.addClass('wl-wnownext');

		const pinnedTitle = this.dataManager.getTitles().find((t) => t.pinned);
		const pinnedGroupId = this.dataManager.getPinnedGroupId();
		const pinnedGroup = pinnedGroupId
			? this.dataManager.getGroups().find((g) => g.id === pinnedGroupId)
			: null;

		const entries = this.dataManager.getAirtimeEntries();
		const titles = this.dataManager.getTitles();
		const titleMap = new Map(titles.map((t) => [t.id, t]));
		const now = Date.now();
		let bestEntry: { titleName: string; type: string; releaseDate: string; daysUntil: number } | null = null;
		let bestMs = Infinity;

		for (const entry of entries) {
			const title = titleMap.get(entry.titleId);
			if (!title || entry.schedule.recurrence !== 'once' || !entry.schedule.releaseDate) continue;
			const ms = new Date(entry.schedule.releaseDate + 'T12:00:00').getTime();
			if (ms >= now && ms < bestMs) {
				bestMs = ms;
				const daysUntil = Math.round((ms - now) / 86400000);
				bestEntry = { titleName: title.title, type: title.type, releaseDate: entry.schedule.releaseDate, daysUntil };
			}
		}

		this.renderNowNextCard(el, pinnedTitle ?? null, pinnedGroup ?? null, bestEntry);
	}

	private renderNowNextCard(
		el: HTMLElement,
		pinnedTitle: WatchLogTitle | null,
		pinnedGroup: import('./types').WatchLogGroup | null,
		bestEntry: { titleName: string; type: string; releaseDate: string; daysUntil: number } | null,
	): void {
		el.empty();
		const card = el.createDiv({ cls: 'wl-full-card wl-full-card-now-next' });
		const cols = card.createDiv({ cls: 'wl-double-cols' });

		// Left column: Now Watching
		const nowCol = cols.createDiv({ cls: 'wl-double-col' });
		nowCol.createDiv({ cls: 'wl-full-card-header', text: 'NOW WATCHING' });

		if (!pinnedTitle && !pinnedGroup) {
			nowCol.createDiv({ cls: 'wl-full-card-sub', text: 'Nothing pinned.' });
		} else if (pinnedGroup) {
			nowCol.createDiv({ cls: 'wl-full-card-title', text: pinnedGroup.name });
			const allTitles = this.dataManager.getTitles();
			const titleMap2 = new Map(allTitles.map((t) => [t.id, t]));
			const members = pinnedGroup.titleIds
				.map((id) => titleMap2.get(id))
				.filter((t): t is WatchLogTitle => t !== undefined);
			const totalWatched = members.reduce((s, t) => s + t.watchedEpisodes.length, 0);
			const totalEps = members.reduce((s, t) => s + this.dataManager.getEffectiveTotal(t), 0);
			const progress = totalEps > 0 ? Math.min(100, Math.round((totalWatched / totalEps) * 100)) : 0;
			nowCol.createDiv({ cls: 'wl-full-card-sub', text: `${members.length} title${members.length !== 1 ? 's' : ''} · ${progress}%` });
		} else {
			const pinned = pinnedTitle!;
			nowCol.createDiv({ cls: 'wl-full-card-title', text: pinned.title });
			const progress = this.dataManager.getProgress(pinned);
			nowCol.createDiv({ cls: 'wl-full-card-sub', text: `${progress}%` });
		}

		// Vertical separator
		cols.createDiv({ cls: 'wl-vert-sep' });

		// Right column: Up Next
		const nextCol = cols.createDiv({ cls: 'wl-double-col' });
		nextCol.createDiv({ cls: 'wl-full-card-header', text: 'UPCOMING NEXT' });

		if (!bestEntry) {
			nextCol.createDiv({ cls: 'wl-full-card-sub', text: 'No upcoming.' });
		} else {
			nextCol.createDiv({ cls: 'wl-full-card-title', text: bestEntry.titleName });
			const daysUntil = bestEntry.daysUntil;
			const countdown = daysUntil === 0 ? 'today' : daysUntil === 1 ? 'tomorrow' : `in ${daysUntil}d`;
			nextCol.createDiv({ cls: 'wl-full-card-sub', text: `${bestEntry.releaseDate} · ${countdown}` });
		}
	}
}
