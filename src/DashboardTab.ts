import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type { TagDefinition } from './types';
import { formatTime, getThemedColor } from './types';

const RING_CIRCUMFERENCE = 2 * Math.PI * 45; // r=45

export class DashboardTab {
	private container: HTMLElement;
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;

	constructor(container: HTMLElement, plugin: WatchLogPlugin, dataManager: DataManager) {
		this.container = container;
		this.plugin = plugin;
		this.dataManager = dataManager;
	}

	render(): void {
		this.container.empty();
		this.container.addClass('wl-dashboard');

		this.renderCards();
		this.renderSummaryMetrics();
		this.renderSuggestions();
		this.renderRecentlyWatched();
		this.renderRecentlyAdded();
	}

	private renderCards(): void {
		const isRect = this.plugin.settings.dashboardCardStyle === 'rectangles';
		const grid = this.container.createDiv({ cls: 'wl-rings-grid' });

		// Always-present Total card
		const totalStats = this.dataManager.getStatsByType('All');
		const totalPercent =
			totalStats.total === 0
				? 0
				: Math.round((totalStats.watched / totalStats.total) * 100);
		if (isRect) {
			this.renderRect(grid, 'Total', '#7F77DD', totalPercent, totalStats);
		} else {
			this.renderRing(grid, 'Total', '#7F77DD', totalPercent, totalStats);
		}

		// One card per type
		for (const type of this.plugin.settings.types) {
			const stats = this.dataManager.getStatsByType(type.name);
			const percent =
				stats.total === 0 ? 0 : Math.round((stats.watched / stats.total) * 100);
			if (isRect) {
				this.renderRect(grid, type.name, type.color, percent, stats);
			} else {
				this.renderRing(grid, type.name, type.color, percent, stats);
			}
		}

		// Time Watched card
		const timeWatched = this.dataManager.getTotalTimeWatched();
		if (isRect) {
			this.renderTimeRect(grid, 'Time Watched', '#1D9E75', formatTime(timeWatched));
		} else {
			this.renderTimeRing(grid, 'Time Watched', '#1D9E75', formatTime(timeWatched));
		}

		// Time Remaining card
		const timeRemaining = this.dataManager.getTotalTimeRemaining();
		if (isRect) {
			this.renderTimeRect(grid, 'Time Remaining', '#BA7517', formatTime(timeRemaining));
		} else {
			this.renderTimeRing(grid, 'Time Remaining', '#BA7517', formatTime(timeRemaining));
		}
	}

	// ── Ring (circle) cards ───────────────────────────────────────────────────────

	private renderRing(
		parent: HTMLElement,
		label: string,
		color: string,
		percent: number,
		stats: { watched: number; total: number },
	): void {
		const item = parent.createDiv({ cls: 'wl-ring-item' });

		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('viewBox', '0 0 120 120');
		svg.setAttribute('width', '110');
		svg.setAttribute('height', '110');
		svg.addClass('wl-ring-svg');

		const bgCircle = document.createElementNS(svgNS, 'circle');
		bgCircle.setAttribute('cx', '60');
		bgCircle.setAttribute('cy', '60');
		bgCircle.setAttribute('r', '45');
		bgCircle.setAttribute('fill', 'none');
		bgCircle.setAttribute('stroke-width', '10');
		bgCircle.addClass('wl-ring-track');
		svg.appendChild(bgCircle);

		const arc = document.createElementNS(svgNS, 'circle');
		arc.setAttribute('cx', '60');
		arc.setAttribute('cy', '60');
		arc.setAttribute('r', '45');
		arc.setAttribute('fill', 'none');
		arc.setAttribute('stroke', color);
		arc.setAttribute('stroke-width', '10');
		arc.setAttribute('stroke-linecap', 'round');
		arc.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
		const dashOffset = RING_CIRCUMFERENCE * (1 - percent / 100);
		arc.setAttribute('stroke-dashoffset', String(dashOffset));
		arc.setAttribute('transform', 'rotate(-90 60 60)');
		arc.addClass('wl-ring-arc');
		svg.appendChild(arc);

		const text = document.createElementNS(svgNS, 'text');
		text.setAttribute('x', '60');
		text.setAttribute('y', '55');
		text.setAttribute('text-anchor', 'middle');
		text.setAttribute('dominant-baseline', 'middle');
		text.addClass('wl-ring-percent-text');
		text.textContent = `${percent}%`;
		svg.appendChild(text);

		const subText = document.createElementNS(svgNS, 'text');
		subText.setAttribute('x', '60');
		subText.setAttribute('y', '72');
		subText.setAttribute('text-anchor', 'middle');
		subText.addClass('wl-ring-sub-text');
		subText.textContent = `${stats.watched}/${stats.total}`;
		svg.appendChild(subText);

		item.appendChild(svg);
		item.createDiv({ cls: 'wl-ring-label', text: label });
		const unwatched = stats.total - stats.watched;
		item.createDiv({ cls: 'wl-ring-subtitle', text: `${unwatched} unwatched` });
	}

	private renderTimeRing(
		parent: HTMLElement,
		label: string,
		color: string,
		timeStr: string,
	): void {
		const item = parent.createDiv({ cls: 'wl-ring-item' });

		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('viewBox', '0 0 120 120');
		svg.setAttribute('width', '110');
		svg.setAttribute('height', '110');
		svg.addClass('wl-ring-svg');

		const bgCircle = document.createElementNS(svgNS, 'circle');
		bgCircle.setAttribute('cx', '60');
		bgCircle.setAttribute('cy', '60');
		bgCircle.setAttribute('r', '45');
		bgCircle.setAttribute('fill', 'none');
		bgCircle.setAttribute('stroke-width', '10');
		bgCircle.addClass('wl-ring-track');
		svg.appendChild(bgCircle);

		const arc = document.createElementNS(svgNS, 'circle');
		arc.setAttribute('cx', '60');
		arc.setAttribute('cy', '60');
		arc.setAttribute('r', '45');
		arc.setAttribute('fill', 'none');
		arc.setAttribute('stroke', color);
		arc.setAttribute('stroke-width', '10');
		arc.setAttribute('stroke-linecap', 'round');
		arc.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
		arc.setAttribute('stroke-dashoffset', '0');
		arc.setAttribute('transform', 'rotate(-90 60 60)');
		arc.addClass('wl-ring-arc');
		svg.appendChild(arc);

		const text = document.createElementNS(svgNS, 'text');
		text.setAttribute('x', '60');
		text.setAttribute('y', '60');
		text.setAttribute('text-anchor', 'middle');
		text.setAttribute('dominant-baseline', 'middle');
		text.addClass('wl-ring-time-text');
		text.textContent = timeStr;
		svg.appendChild(text);

		item.appendChild(svg);
		item.createDiv({ cls: 'wl-ring-label', text: label });
		item.createDiv({ cls: 'wl-ring-subtitle', text: 'total' });
	}

	// ── Rectangle cards ───────────────────────────────────────────────────────────

	private renderRect(
		parent: HTMLElement,
		label: string,
		color: string,
		percent: number,
		stats: { watched: number; total: number },
	): void {
		const item = parent.createDiv({ cls: 'wl-rect-item' });

		const topRow = item.createDiv({ cls: 'wl-rect-top' });
		topRow.createSpan({ cls: 'wl-rect-label', text: label });
		const unwatched = stats.total - stats.watched;
		topRow.createSpan({ cls: 'wl-rect-unwatched', text: `${unwatched} left` });

		item.createDiv({ cls: 'wl-rect-value', text: `${percent}%` });

		const barWrap = item.createDiv({ cls: 'wl-rect-bar-wrap' });
		const bar = barWrap.createDiv({ cls: 'wl-rect-bar' });
		bar.style.width = `${percent}%`;
		bar.style.backgroundColor = color;
	}

	private renderTimeRect(
		parent: HTMLElement,
		label: string,
		color: string,
		timeStr: string,
	): void {
		const item = parent.createDiv({ cls: 'wl-rect-item' });

		const topRow = item.createDiv({ cls: 'wl-rect-top' });
		topRow.createSpan({ cls: 'wl-rect-label', text: label });
		topRow.createSpan({ cls: 'wl-rect-unwatched', text: 'total' });

		item.createDiv({ cls: 'wl-rect-value', text: timeStr });

		const barWrap = item.createDiv({ cls: 'wl-rect-bar-wrap' });
		const bar = barWrap.createDiv({ cls: 'wl-rect-bar wl-rect-bar-full' });
		bar.style.backgroundColor = color;
	}

	// ── Summary metrics ───────────────────────────────────────────────────────────

	private renderSummaryMetrics(): void {
		const section = this.container.createDiv({ cls: 'wl-summary-metrics' });
		const titles = this.dataManager.getTitles();
		const completed = this.dataManager.getCompletedCount();
		this.renderMetricRow(section, 'Titles in library', String(titles.length));
		this.renderMetricRow(section, 'Completed', String(completed));
	}

	private renderMetricRow(parent: HTMLElement, label: string, value: string): void {
		const row = parent.createDiv({ cls: 'wl-metric-row' });
		row.createSpan({ cls: 'wl-metric-label', text: label });
		row.createSpan({ cls: 'wl-metric-value', text: value });
	}

	// ── Suggestions ──────────────────────────────────────────────────────────────

	private renderSuggestions(): void {
		const planTitles = this.dataManager.getTitles().filter((t) => t.status === 'Plan to watch');
		if (planTitles.length === 0) return;

		const section = this.container.createDiv({ cls: 'wl-suggestions' });
		section.createDiv({ cls: 'wl-section-title', text: "Don't know what to watch next?" });

		const grid = section.createDiv({ cls: 'wl-suggestions-grid' });

		const shortestByType = (typeName: string): string | null => {
			const candidates = planTitles
				.filter((t) => t.type === typeName)
				.filter((t) => t.totalEpisodes > 0 || t.episodeDuration > 0);
			if (candidates.length === 0) {
				// fallback: any plan-to-watch of this type, no length filter
				const fallback = planTitles.filter((t) => t.type === typeName);
				return fallback[0]?.title ?? null;
			}
			candidates.sort((a, b) => {
				const aVal = a.totalEpisodes > 0 ? a.totalEpisodes * (a.episodeDuration || 24) : a.episodeDuration;
				const bVal = b.totalEpisodes > 0 ? b.totalEpisodes * (b.episodeDuration || 24) : b.episodeDuration;
				return aVal - bVal;
			});
			return candidates[0]?.title ?? null;
		};

		// Fixed 2×2 grid: Anime, Movie, TV Show, Random
		const fixedTypes = ['Anime', 'Movie', 'TV Show'];
		for (const typeName of fixedTypes) {
			const pick = shortestByType(typeName);
			const card = grid.createDiv({ cls: 'wl-suggestion-card' });
			card.createDiv({ cls: 'wl-suggestion-label', text: `Shortest ${typeName}` });
			card.createDiv({
				cls: `wl-suggestion-title${pick ? '' : ' wl-suggestion-empty'}`,
				text: pick ?? 'Nothing planned',
			});
		}

		// Random card (bottom-right, equal size)
		const randomCard = grid.createDiv({ cls: 'wl-suggestion-card' });
		const randomHeader = randomCard.createDiv({ cls: 'wl-suggestion-random-header' });
		randomHeader.createDiv({ cls: 'wl-suggestion-label', text: 'Random' });
		const shuffleBtn = randomHeader.createEl('button', { cls: 'wl-suggestion-shuffle', text: '🔀' });
		shuffleBtn.title = 'Pick another';

		const getRandomTitle = (): string =>
			planTitles[Math.floor(Math.random() * planTitles.length)]?.title ?? '';
		const randomTitleEl = randomCard.createDiv({ cls: 'wl-suggestion-title', text: getRandomTitle() });

		shuffleBtn.addEventListener('click', () => {
			randomTitleEl.textContent = getRandomTitle();
		});
	}

	// ── Recently watched ──────────────────────────────────────────────────────────

	private renderRecentlyWatched(): void {
		const section = this.container.createDiv({ cls: 'wl-recently-watched' });
		section.createDiv({ cls: 'wl-section-title', text: 'Recently watched' });

		const recent = this.dataManager.getRecentlyWatched(3);

		if (recent.length === 0) {
			section.createDiv({ cls: 'wl-empty-state', text: 'No titles watched yet.' });
			return;
		}

		for (const title of recent) {
			const item = section.createDiv({ cls: 'wl-rw-item' });

			item.createDiv({ cls: 'wl-rw-title', text: title.title });

			const typeDef = this.getTagDef(title.type, this.plugin.settings.types);
			const colored = this.plugin.settings.coloredTypeBadges;
			const badgeWrap = item.createDiv({ cls: 'wl-rw-col-badge' });
			const badge = badgeWrap.createSpan({
				cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain',
				text: title.type,
			});
			if (colored && typeDef) badge.style.backgroundColor = getThemedColor(title.type, typeDef.color, this.plugin.settings.colorTheme);

			const epCol = item.createDiv({ cls: 'wl-rw-col-ep' });
			const isMovie = title.type === 'Movie';
			if (!isMovie) {
				const nextEp = this.dataManager.getNextUnwatchedEpisode(title);
				epCol.textContent = nextEp !== null ? `Ep ${nextEp}` : '✓';
			}

			const pctCol = item.createDiv({ cls: 'wl-rw-col-pct' });
			if (isMovie) {
				pctCol.textContent = title.watchedEpisodes.includes(1) ? '100%' : '0%';
			} else {
				pctCol.textContent = `${this.dataManager.getProgress(title)}%`;
			}
		}
	}

	// ── Recently added ────────────────────────────────────────────────────────────

	private renderRecentlyAdded(): void {
		const section = this.container.createDiv({ cls: 'wl-recently-watched' });
		section.createDiv({ cls: 'wl-section-title', text: 'Recently added' });

		const recent = this.dataManager.getRecentlyAdded(3);

		if (recent.length === 0) {
			section.createDiv({ cls: 'wl-empty-state', text: 'No titles in your library yet.' });
			return;
		}

		for (const title of recent) {
			const item = section.createDiv({ cls: 'wl-rw-item' });

			item.createDiv({ cls: 'wl-rw-title', text: title.title });

			const typeDef = this.getTagDef(title.type, this.plugin.settings.types);
			const colored = this.plugin.settings.coloredTypeBadges;
			const badgeWrap = item.createDiv({ cls: 'wl-rw-col-badge' });
			const badge = badgeWrap.createSpan({
				cls: colored ? 'wl-badge wl-badge-sm' : 'wl-badge-plain',
				text: title.type,
			});
			if (colored && typeDef) badge.style.backgroundColor = getThemedColor(title.type, typeDef.color, this.plugin.settings.colorTheme);

			const epCol = item.createDiv({ cls: 'wl-rw-col-ep' });
			const isMovie = title.type === 'Movie';
			if (!isMovie) {
				const nextEp = this.dataManager.getNextUnwatchedEpisode(title);
				epCol.textContent = nextEp !== null ? `Ep ${nextEp}` : '✓';
			}

			const pctCol = item.createDiv({ cls: 'wl-rw-col-pct' });
			if (isMovie) {
				pctCol.textContent = title.watchedEpisodes.includes(1) ? '100%' : '0%';
			} else {
				pctCol.textContent = `${this.dataManager.getProgress(title)}%`;
			}
		}
	}

	private getTagDef(name: string, tags: TagDefinition[]): TagDefinition | undefined {
		return tags.find((t) => t.name === name);
	}
}
