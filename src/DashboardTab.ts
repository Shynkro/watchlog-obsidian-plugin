import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type { ReadingDataManager } from './ReadingDataManager';
import type { Book, Manga, TagDefinition, WatchLogTitle } from './types';
import { formatTime, getThemedColor, getReadingTypeColor } from './types';

const RING_CIRCUMFERENCE = 2 * Math.PI * 45; // r=45

/** Aggregated reading stats for one kind (books or manga). */
interface ReadingAggregate {
	left: number;       // count of Reading + Plan to Read (To be released excluded)
	read: number;       // sum of pages (books) / chapters (manga) read
	total: number;      // sum of total pages / chapters
	volumesRead: number;
	totalVolumes: number;
}

export class DashboardTab {
	private container: HTMLElement;
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private readingData: ReadingDataManager;

	constructor(
		container: HTMLElement,
		plugin: WatchLogPlugin,
		dataManager: DataManager,
		readingData: ReadingDataManager,
	) {
		this.container = container;
		this.plugin = plugin;
		this.dataManager = dataManager;
		this.readingData = readingData;
	}

	render(): void {
		this.container.empty();
		this.container.addClass('wl-dashboard');

		// Precompute shared collections once per render so each subrenderer
		// doesn't trigger another full scan of the titles array.
		const allTitles = this.dataManager.getTitles();
		const byType = new Map<string, WatchLogTitle[]>();
		for (const t of allTitles) {
			const arr = byType.get(t.type);
			if (arr) arr.push(t);
			else byType.set(t.type, [t]);
		}
		const planTitles = allTitles.filter((t) => t.status === 'Plan to watch');

		// Reading data sourced from ReadingDataManager so footer counts span both datasets.
		const books = this.readingData.getBooks();
		const manga = this.readingData.getMangaList();

		// Library + Completed counts sum watch + reading (books + manga). A reading item
		// only counts as completed when its status is exactly 'Completed', matching the watch side.
		const titleCount = allTitles.length + books.length + manga.length;
		const completedCount =
			allTitles.reduce((n, t) => n + (t.status === 'Completed' ? 1 : 0), 0) +
			books.reduce((n, b) => n + (b.status === 'Completed' ? 1 : 0), 0) +
			manga.reduce((n, m) => n + (m.status === 'Completed' ? 1 : 0), 0);

		// Reading aggregates computed once per render (not per data change).
		const booksAgg = this.aggregateBooks(books);
		const mangaAgg = this.aggregateManga(manga);

		this.renderCards(allTitles, byType, booksAgg, mangaAgg);
		this.renderSummaryMetrics(titleCount, completedCount);
		this.renderSuggestions(planTitles);
		this.renderRecentlyWatched();
		this.renderRecentlyAdded();
	}

	private statsFor(titles: WatchLogTitle[]): { watched: number; total: number } {
		const EXCLUDED = new Set(['Dropped', 'To be released']);
		let total = 0;
		let watched = 0;
		for (const t of titles) {
			if (EXCLUDED.has(t.status)) continue;
			total++;
			if (t.status === 'Completed') watched++;
		}
		return { watched, total };
	}

	private renderCards(
		allTitles: WatchLogTitle[],
		byType: Map<string, WatchLogTitle[]>,
		booksAgg: ReadingAggregate,
		mangaAgg: ReadingAggregate,
	): void {
		const isRect = this.plugin.settings.dashboardCardStyle === 'rectangles';
		const grid = this.container.createDiv({ cls: 'wl-rings-grid' });

		// Unified Total / Time card, anchored at the top (spans full width).
		const totalStats = this.statsFor(allTitles);
		const totalPercent =
			totalStats.total === 0
				? 0
				: Math.round((totalStats.watched / totalStats.total) * 100);
		const timeWatched = this.dataManager.getTotalTimeWatched();
		const timeRemaining = this.dataManager.getTotalTimeRemaining();
		this.renderUnifiedCard(
			grid, isRect, totalPercent, totalStats,
			formatTime(timeWatched), formatTime(timeRemaining),
		);

		// One card per type
		for (const type of this.plugin.settings.types) {
			const stats = this.statsFor(byType.get(type.name) ?? []);
			const percent =
				stats.total === 0 ? 0 : Math.round((stats.watched / stats.total) * 100);
			if (isRect) {
				const item = grid.createDiv({ cls: 'wl-rect-item' });
				this.fillRect(item, type.name, type.color, percent, stats);
				// Reserve the sublabel line so type cards match the taller Books/Manga cards.
				item.createDiv({ cls: 'wl-rect-subline', text: ' ' });
			} else {
				const item = grid.createDiv({ cls: 'wl-ring-item' });
				this.fillRing(item, type.name, type.color, percent, stats);
				item.createDiv({ cls: 'wl-ring-subtitle wl-ring-subline', text: ' ' });
			}
		}

		// Reading cards (Books + Manga) at the end of the flow.
		this.renderReadingCard(grid, isRect, 'Books', booksAgg);
		this.renderReadingCard(grid, isRect, 'Manga', mangaAgg);
	}

	// ── Unified Total / Time card ──────────────────────────────────────────────────

	private renderUnifiedCard(
		grid: HTMLElement,
		isRect: boolean,
		totalPercent: number,
		totalStats: { watched: number; total: number },
		timeWatchedStr: string,
		timeRemainingStr: string,
	): void {
		// Rect cards carry an outer border; ring cards don't — match the active style.
		const card = grid.createDiv({
			cls: isRect ? 'wl-dash-unified wl-dash-unified-bordered' : 'wl-dash-unified',
		});

		// Segment 1 — Total (full card content, matching the chosen card style).
		// Ring content is centered; rect content stretches so its bar spans the segment.
		const seg1 = card.createDiv({ cls: isRect ? 'wl-dash-seg' : 'wl-dash-seg wl-dash-seg-center' });
		if (isRect) {
			// Rect content goes straight into the segment so its border is the card's.
			this.fillRect(seg1, 'Total', '#7F77DD', totalPercent, totalStats);
		} else {
			// Rings are borderless; wrap so the decorative accent ring matches type cards.
			this.fillRing(seg1.createDiv({ cls: 'wl-ring-item' }), 'Total', '#7F77DD', totalPercent, totalStats);
		}

		// Segments 2 & 3 — Time Watched / Remaining: label + value, no bar.
		this.renderTimeSegment(card, 'Time Watched', timeWatchedStr);
		this.renderTimeSegment(card, 'Time Remaining', timeRemainingStr);
	}

	private renderTimeSegment(card: HTMLElement, label: string, value: string): void {
		const seg = card.createDiv({ cls: 'wl-dash-seg wl-dash-seg-center' });
		seg.createDiv({ cls: 'wl-dash-seg-label', text: label });
		seg.createDiv({ cls: 'wl-dash-seg-value', text: value });
	}

	// ── Reading cards (Books / Manga) ──────────────────────────────────────────────

	private aggregateBooks(books: Book[]): ReadingAggregate {
		const agg: ReadingAggregate = { left: 0, read: 0, total: 0, volumesRead: 0, totalVolumes: 0 };
		for (const b of books) {
			if (b.status === 'To be released') continue; // excluded entirely
			if (b.status === 'Reading' || b.status === 'Plan to Read') agg.left++;
			agg.read += b.pagesRead;
			agg.total += b.totalPages;
		}
		return agg;
	}

	private aggregateManga(manga: Manga[]): ReadingAggregate {
		const agg: ReadingAggregate = { left: 0, read: 0, total: 0, volumesRead: 0, totalVolumes: 0 };
		for (const m of manga) {
			if (m.status === 'To be released') continue; // excluded entirely
			if (m.status === 'Reading' || m.status === 'Plan to Read') agg.left++;
			agg.read += m.chaptersRead;
			agg.total += m.totalChapters;
			agg.volumesRead += m.volumesRead;
			agg.totalVolumes += m.totalVolumes;
		}
		return agg;
	}

	private renderReadingCard(
		grid: HTMLElement,
		isRect: boolean,
		label: 'Books' | 'Manga',
		agg: ReadingAggregate,
	): void {
		const percent = agg.total > 0 ? Math.round((agg.read / agg.total) * 100) : 0;
		// Configured Reading type color (Books → book, Manga → manga), mirroring how
		// watchlist type cards use their type color.
		const color = getReadingTypeColor(label === 'Books' ? 'book' : 'manga', this.plugin.settings);

		// Single inline subline under the bar: Books → pages; Manga → chapters · vol.
		const subline =
			label === 'Books'
				? `${agg.read} / ${agg.total} pages`
				: `${agg.read} / ${agg.total} chapters · ${agg.volumesRead} / ${agg.totalVolumes} vol`;

		if (isRect) {
			const item = grid.createDiv({ cls: 'wl-rect-item' });
			const topRow = item.createDiv({ cls: 'wl-rect-top' });
			topRow.createSpan({ cls: 'wl-rect-label', text: label });
			topRow.createSpan({ cls: 'wl-rect-unwatched', text: `${agg.left} left` });
			item.createDiv({ cls: 'wl-rect-value', text: `${percent}%` });
			const barWrap = item.createDiv({ cls: 'wl-rect-bar-wrap' });
			const bar = barWrap.createDiv({ cls: 'wl-rect-bar' });
			bar.style.width = `${percent}%`;
			bar.style.backgroundColor = color;
			item.createDiv({ cls: 'wl-rect-subline', text: subline });
		} else {
			const item = grid.createDiv({ cls: 'wl-ring-item' });
			const svg = this.makeRingSvg(percent, color, `${percent}%`, '', true);
			item.appendChild(svg);
			item.createDiv({ cls: 'wl-ring-label', text: label });
			item.createDiv({ cls: 'wl-ring-subtitle', text: `${agg.left} left` });
			item.createDiv({ cls: 'wl-ring-subtitle wl-ring-subline', text: subline });
		}
	}

	// ── Shared card content builders ───────────────────────────────────────────────

	/** Builds the progress-ring SVG. When `themeStroke` is set, the arc colour is
	 *  applied via inline style so CSS vars (e.g. var(--wl-accent)) resolve. */
	private makeRingSvg(
		percent: number,
		color: string,
		centerText: string,
		subText: string,
		themeStroke = false,
	): SVGSVGElement {
		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = activeDocument.createElementNS(svgNS, 'svg');
		svg.setAttribute('viewBox', '0 0 120 120');
		svg.setAttribute('width', '110');
		svg.setAttribute('height', '110');
		svg.addClass('wl-ring-svg');

		const bgCircle = activeDocument.createElementNS(svgNS, 'circle');
		bgCircle.setAttribute('cx', '60');
		bgCircle.setAttribute('cy', '60');
		bgCircle.setAttribute('r', '45');
		bgCircle.setAttribute('fill', 'none');
		bgCircle.setAttribute('stroke-width', '10');
		bgCircle.addClass('wl-ring-track');
		svg.appendChild(bgCircle);

		const arc = activeDocument.createElementNS(svgNS, 'circle');
		arc.setAttribute('cx', '60');
		arc.setAttribute('cy', '60');
		arc.setAttribute('r', '45');
		arc.setAttribute('fill', 'none');
		if (themeStroke) arc.style.stroke = color;
		else arc.setAttribute('stroke', color);
		arc.setAttribute('stroke-width', '10');
		arc.setAttribute('stroke-linecap', 'round');
		arc.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
		arc.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE * (1 - percent / 100)));
		arc.setAttribute('transform', 'rotate(-90 60 60)');
		arc.addClass('wl-ring-arc');
		svg.appendChild(arc);

		const text = activeDocument.createElementNS(svgNS, 'text');
		text.setAttribute('x', '60');
		text.setAttribute('y', subText ? '55' : '60');
		text.setAttribute('text-anchor', 'middle');
		text.setAttribute('dominant-baseline', 'middle');
		text.addClass('wl-ring-percent-text');
		text.textContent = centerText;
		svg.appendChild(text);

		if (subText) {
			const sub = activeDocument.createElementNS(svgNS, 'text');
			sub.setAttribute('x', '60');
			sub.setAttribute('y', '72');
			sub.setAttribute('text-anchor', 'middle');
			sub.addClass('wl-ring-sub-text');
			sub.textContent = subText;
			svg.appendChild(sub);
		}

		return svg;
	}

	private fillRing(
		item: HTMLElement,
		label: string,
		color: string,
		percent: number,
		stats: { watched: number; total: number },
	): void {
		const svg = this.makeRingSvg(percent, color, `${percent}%`, `${stats.watched}/${stats.total}`);
		item.appendChild(svg);
		item.createDiv({ cls: 'wl-ring-label', text: label });
		const unwatched = stats.total - stats.watched;
		item.createDiv({ cls: 'wl-ring-subtitle', text: `${unwatched} unwatched` });
	}

	private fillRect(
		item: HTMLElement,
		label: string,
		color: string,
		percent: number,
		stats: { watched: number; total: number },
	): void {
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

	// ── Summary metrics ───────────────────────────────────────────────────────────

	private renderSummaryMetrics(titleCount: number, completedCount: number): void {
		const section = this.container.createDiv({ cls: 'wl-summary-metrics' });
		this.renderMetricRow(section, 'Titles in library', String(titleCount));
		this.renderMetricRow(section, 'Completed', String(completedCount));
	}

	private renderMetricRow(parent: HTMLElement, label: string, value: string): void {
		const row = parent.createDiv({ cls: 'wl-metric-row' });
		row.createSpan({ cls: 'wl-metric-label', text: label });
		row.createSpan({ cls: 'wl-metric-value', text: value });
	}

	// ── Suggestions ──────────────────────────────────────────────────────────────

	private renderSuggestions(planTitles: WatchLogTitle[]): void {
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
