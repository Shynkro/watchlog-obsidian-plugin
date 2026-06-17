import type WatchLogPlugin from './main';
import type { HistoryEntry, HistorySource, HistoryAction } from './HistoryManager';

type SourceFilter = 'all' | 'Watchlist' | 'Reading';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
	'January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December',
];

const ACTION_COLORS: Record<string, string> = {
	completed: '#1D9E75',
	watched: '#1D9E75',
	added: '#378ADD',
	deleted: '#E24B4A',
	status: '#BA7517',
	rating: '#BA7517',
};

// Leading source dot is colored by source (not action): green Reading, blue Watchlist.
const SOURCE_COLORS: Record<string, string> = {
	Reading: '#1D9E75',
	Watchlist: '#378ADD',
};

function inferAction(entry: HistoryEntry): HistoryAction {
	if (entry.action) return entry.action;
	const m = entry.message.toLowerCase();
	if (m.includes('was added')) return 'added';
	if (m.includes('was deleted')) return 'deleted';
	if (m.includes('was reviewed') || m.includes('rating changed')) return 'rating';
	if (m.includes('episode') && m.includes('watched')) return 'watched';
	if (m.includes('was marked as watched') || m.includes('completed')) return 'completed';
	if (m.includes('status')) return 'status';
	return 'added';
}

function inferSource(entry: HistoryEntry): HistorySource {
	if (entry.source) return entry.source;
	return 'Watchlist';
}

function actionLabel(entry: HistoryEntry): string {
	const action = inferAction(entry);
	const m = entry.message;
	switch (action) {
		case 'added': return 'Added';
		case 'deleted': return 'Deleted';
		case 'rating': {
			const rm = m.match(/Rating → (\d+\/5)/);
			if (rm) return `Rating → ${rm[1]}`;
			return 'Rating changed';
		}
		case 'status': {
			const sm = m.match(/status changed to (.+)$/);
			return sm ? `Status → ${sm[1]}` : 'Status changed';
		}
		case 'completed': return 'Completed';
		case 'watched': {
			const pm = m.match(/At (page|chapter|volume) (\d+) \/ (\d+)/i);
			if (pm) return `At ${pm[1]} ${pm[2]} / ${pm[3]}`;
			const seasonM = m.match(/\)\s+(.+?)\s+was fully watched on/i);
			if (seasonM) return `${seasonM[1]} watched`;
			const em = m.match(/episode (\d+)/i);
			return em ? `Episode ${em[1]} watched` : 'Watched';
		}
	}
	return 'Updated';
}

function typeFromEntry(entry: HistoryEntry): string {
	const m = entry.message.match(/\(([^)]+)\)/);
	return m ? m[1]! : '';
}

function titleFromEntry(entry: HistoryEntry): string {
	let title: string;
	if (entry.titleName) {
		title = entry.titleName;
	} else {
		const m = entry.message.match(/^(.+?)\s*\(/);
		title = m ? m[1]! : entry.message;
	}
	const type = typeFromEntry(entry);
	if (type) return `${title} (${type})`;
	return title;
}

function formatDayHeader(dateStr: string): string {
	const d = new Date(dateStr + 'T12:00:00');
	return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatTime(isoTs: string): string {
	const d = new Date(isoTs);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dateKey(isoTs: string): string {
	const d = new Date(isoTs);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface VirtualRow {
	type: 'header' | 'entry';
	date?: string;
	entry?: HistoryEntry;
	isLastInGroup?: boolean;
}

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 40;

export class LogTab {
	private container: HTMLElement;
	private plugin: WatchLogPlugin;
	private sourceFilter: SourceFilter = 'all';

	private scrollContainer: HTMLElement | null = null;
	private spacer: HTMLElement | null = null;
	private viewport: HTMLElement | null = null;
	private rows: VirtualRow[] = [];
	private rowOffsets: number[] = [];
	private totalHeight = 0;
	private scrollHandler: (() => void) | null = null;
	private scrollRAF: number | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private lastFirst = -1;
	private lastLast = -1;
	private renderedNodes: Map<number, HTMLElement> = new Map();

	constructor(container: HTMLElement, plugin: WatchLogPlugin) {
		this.container = container;
		this.plugin = plugin;
	}

	destroy(): void {
		this.destroyVirtualScroll();
	}

	render(): void {
		this.destroyVirtualScroll();
		this.container.empty();
		this.container.addClass('wl-log-tab');

		this.renderFilterBar();

		const allEntries = this.plugin.historyManager?.getEntries() ?? [];
		const filtered = this.sourceFilter === 'all'
			? allEntries
			: allEntries.filter((e) => inferSource(e) === this.sourceFilter);

		if (filtered.length === 0) {
			this.container.createDiv({
				cls: 'wl-log-empty',
				text: this.sourceFilter === 'all'
					? 'No events yet. Actions from Watchlist and Reading will appear here.'
					: `No ${this.sourceFilter} events yet.`,
			});
			return;
		}

		this.buildVirtualRows(filtered);
		this.renderVirtualTimeline();
	}

	private renderFilterBar(): void {
		const bar = this.container.createDiv({ cls: 'wl-log-filter-bar' });

		const filters: { label: string; value: SourceFilter }[] = [
			{ label: 'All', value: 'all' },
			{ label: 'Watchlist', value: 'Watchlist' },
			{ label: 'Reading', value: 'Reading' },
		];

		for (const f of filters) {
			const btn = bar.createEl('button', {
				cls: `wl-log-filter-btn${this.sourceFilter === f.value ? ' is-active' : ''}`,
				text: f.label,
			});
			btn.addEventListener('click', () => {
				if (this.sourceFilter === f.value) return;
				this.sourceFilter = f.value;
				this.render();
			});
		}
	}

	private buildVirtualRows(entries: HistoryEntry[]): void {
		this.rows = [];
		this.rowOffsets = [];

		const map = new Map<string, HistoryEntry[]>();
		for (const entry of entries) {
			const key = dateKey(entry.timestamp);
			let list = map.get(key);
			if (!list) {
				list = [];
				map.set(key, list);
			}
			list.push(entry);
		}

		const groups: { date: string; entries: HistoryEntry[] }[] = [];
		for (const [date, list] of map) {
			groups.push({ date, entries: list });
		}

		let offset = 0;
		for (const group of groups) {
			this.rows.push({ type: 'header', date: group.date });
			this.rowOffsets.push(offset);
			offset += HEADER_HEIGHT;

			for (let i = 0; i < group.entries.length; i++) {
				this.rows.push({
					type: 'entry',
					entry: group.entries[i],
					isLastInGroup: i === group.entries.length - 1,
				});
				this.rowOffsets.push(offset);
				offset += ROW_HEIGHT;
			}
		}
		this.totalHeight = offset;
	}

	private renderVirtualTimeline(): void {
		const scroll = this.container.createDiv({ cls: 'wl-log-timeline wl-log-virtual-scroll' });
		const spacer = scroll.createDiv({ cls: 'wl-log-spacer' });
		const viewport = spacer.createDiv({ cls: 'wl-log-viewport' });

		this.scrollContainer = scroll;
		this.spacer = spacer;
		this.viewport = viewport;
		this.renderedNodes.clear();
		this.lastFirst = -1;
		this.lastLast = -1;

		spacer.setCssProps({ height: `${this.totalHeight}px` });
		viewport.setCssProps({ height: `${this.totalHeight}px` });

		this.scrollHandler = () => {
			if (this.scrollRAF !== null) return;
			this.scrollRAF = window.requestAnimationFrame(() => {
				this.scrollRAF = null;
				this.renderVisibleRows();
			});
		};
		scroll.addEventListener('scroll', this.scrollHandler, { passive: true });

		this.resizeObserver = new ResizeObserver(() => {
			this.renderedNodes.clear();
			if (this.viewport) this.viewport.empty();
			this.lastFirst = -1;
			this.lastLast = -1;
			this.renderVisibleRows();
		});
		this.resizeObserver.observe(scroll);

		this.renderVisibleRows();
	}

	private renderVisibleRows(): void {
		const scroll = this.scrollContainer;
		const viewport = this.viewport;
		if (!scroll || !viewport) return;

		const scrollTop = scroll.scrollTop;
		const viewHeight = scroll.clientHeight;
		if (viewHeight <= 0) return;

		const first = this.findFirstVisible(scrollTop);
		const last = this.findLastVisible(scrollTop + viewHeight);

		if (first === this.lastFirst && last === this.lastLast) return;

		this.lastFirst = first;
		this.lastLast = last;

		// Remove rows that left the visible window
		for (const [idx, el] of this.renderedNodes) {
			if (idx < first || idx > last) {
				el.remove();
				this.renderedNodes.delete(idx);
			}
		}

		// Add rows that newly entered the visible window
		for (let i = first; i <= last; i++) {
			if (this.renderedNodes.has(i)) continue;
			const row = this.rows[i];
			if (!row) continue;

			let el: HTMLElement;
			if (row.type === 'header') {
				el = activeDocument.createElement('div');
				el.className = 'wl-log-day-header';
				el.setCssProps({ height: `${HEADER_HEIGHT}px` });
				el.textContent = formatDayHeader(row.date!);
			} else {
				el = this.buildEntryRow(row);
			}

			const offset = this.rowOffsets[i] ?? 0;
			el.setCssProps({ top: `${offset}px` });

			viewport.appendChild(el);
			this.renderedNodes.set(i, el);
		}
	}

	private buildEntryRow(row: VirtualRow): HTMLElement {
		const entry = row.entry!;
		const action = inferAction(entry);
		const color = ACTION_COLORS[action] ?? '#888780';
		const source = inferSource(entry);
		const dotColor = SOURCE_COLORS[source] ?? '#888780';

		const el = activeDocument.createElement('div');
		el.className = 'wl-log-entry';
		el.setCssProps({ height: `${ROW_HEIGHT}px` });

		const dotCol = activeDocument.createElement('div');
		dotCol.className = 'wl-log-dot-col';
		const dot = activeDocument.createElement('div');
		dot.className = 'wl-log-dot';
		dot.style.backgroundColor = dotColor;
		dotCol.appendChild(dot);
		if (!row.isLastInGroup) {
			const connector = activeDocument.createElement('div');
			connector.className = 'wl-log-connector';
			dotCol.appendChild(connector);
		}
		el.appendChild(dotCol);

		const content = activeDocument.createElement('div');
		content.className = 'wl-log-content';
		const srcSpan = activeDocument.createElement('span');
		srcSpan.className = 'wl-log-source';
		srcSpan.textContent = source;
		content.appendChild(srcSpan);
		const sep1 = activeDocument.createElement('span');
		sep1.className = 'wl-log-sep';
		sep1.textContent = ' · ';
		content.appendChild(sep1);
		const titleSpan = activeDocument.createElement('span');
		titleSpan.className = 'wl-log-title';
		titleSpan.textContent = titleFromEntry(entry);
		content.appendChild(titleSpan);
		const sep2 = activeDocument.createElement('span');
		sep2.className = 'wl-log-sep';
		sep2.textContent = ' — ';
		content.appendChild(sep2);
		const actionSpan = activeDocument.createElement('span');
		actionSpan.className = 'wl-log-action';
		actionSpan.textContent = actionLabel(entry);
		actionSpan.style.color = color;
		content.appendChild(actionSpan);
		el.appendChild(content);

		const timeEl = activeDocument.createElement('div');
		timeEl.className = 'wl-log-time';
		timeEl.textContent = formatTime(entry.timestamp);
		el.appendChild(timeEl);

		return el;
	}

	private findFirstVisible(scrollTop: number): number {
		let lo = 0;
		let hi = this.rows.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			const rowEnd = this.rowOffsets[mid]! + (this.rows[mid]!.type === 'header' ? HEADER_HEIGHT : ROW_HEIGHT);
			if (rowEnd <= scrollTop) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return Math.max(0, lo - 2);
	}

	private findLastVisible(bottom: number): number {
		let lo = 0;
		let hi = this.rows.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >>> 1;
			if (this.rowOffsets[mid]! >= bottom) {
				hi = mid - 1;
			} else {
				lo = mid;
			}
		}
		return Math.min(this.rows.length - 1, lo + 2);
	}

	private destroyVirtualScroll(): void {
		if (this.scrollRAF !== null) {
			window.cancelAnimationFrame(this.scrollRAF);
			this.scrollRAF = null;
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.scrollContainer && this.scrollHandler) {
			this.scrollContainer.removeEventListener('scroll', this.scrollHandler);
		}
		this.scrollHandler = null;
		this.scrollContainer = null;
		this.spacer = null;
		this.viewport = null;
		this.renderedNodes.clear();
		this.lastFirst = -1;
		this.lastLast = -1;
	}
}
