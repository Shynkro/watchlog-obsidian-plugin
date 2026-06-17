import type WatchLogPlugin from './main';

export type HistorySource = 'Watchlist' | 'Reading';
export type HistoryAction = 'added' | 'completed' | 'deleted' | 'status' | 'rating' | 'watched';

export interface HistoryEntry {
	id: string;
	timestamp: string;
	message: string;
	source?: HistorySource;
	action?: HistoryAction;
	titleName?: string;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatHistoryDate(isoTs: string): string {
	const d = new Date(isoTs);
	const day = DAYS[d.getDay()] ?? '';
	const dd = String(d.getDate()).padStart(2, '0');
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const yyyy = d.getFullYear();
	const hh = String(d.getHours()).padStart(2, '0');
	const min = String(d.getMinutes()).padStart(2, '0');
	return `${day} ${dd}/${mm}/${yyyy} at ${hh}:${min}`;
}

export class HistoryManager {
	private plugin: WatchLogPlugin;
	private entries: HistoryEntry[] = [];
	private readonly MAX_ENTRIES = 1000;

	constructor(plugin: WatchLogPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Loads the activity log from the shared `data.history` key (in memory, not a
	 * file) and binds `master.history` to our canonical array so appends are
	 * reflected in the object DataManager persists.
	 */
	async load(): Promise<void> {
		const master = this.plugin.dataManager.getData();
		const h = master.history;
		this.entries = Array.isArray(h) ? h : [];
		if (this.entries.length > this.MAX_ENTRIES) {
			this.entries = this.entries.slice(-this.MAX_ENTRIES);
		}
		master.history = this.entries;
	}

	/** Re-bind to a freshly synced data.json (driven by DataManager's 'raw' watcher). */
	adoptExternalChange(): void {
		const master = this.plugin.dataManager.getData();
		const h = master.history;
		this.entries = Array.isArray(h) ? h : [];
		if (this.entries.length > this.MAX_ENTRIES) {
			this.entries = this.entries.slice(-this.MAX_ENTRIES);
		}
		master.history = this.entries;
	}

	async log(
		message: string,
		meta?: { source?: HistorySource; action?: HistoryAction; titleName?: string },
	): Promise<void> {
		const entry: HistoryEntry = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			timestamp: new Date().toISOString(),
			message,
			source: meta?.source,
			action: meta?.action,
			titleName: meta?.titleName,
		};
		this.entries.push(entry);
		if (this.entries.length > this.MAX_ENTRIES) {
			this.entries = this.entries.slice(-this.MAX_ENTRIES);
		}
		await this.save();
	}

	getEntries(): HistoryEntry[] {
		return [...this.entries].reverse();
	}

	/** Raw stored entries (oldest-first), for inclusion in a full backup. */
	exportEntries(): HistoryEntry[] {
		return [...this.entries];
	}

	/** Replace the entire audit log (used by full-snapshot restore). */
	async restore(entries: HistoryEntry[]): Promise<void> {
		const list = Array.isArray(entries) ? entries : [];
		this.entries = list.length > this.MAX_ENTRIES ? list.slice(-this.MAX_ENTRIES) : list;
		await this.save();
	}

	private async save(): Promise<void> {
		try {
			// Activity log lives inside data.json now (Sync-replicated). Re-bind the
			// master reference (an external reload may have replaced the object), then
			// persist the whole file through DataManager.
			this.plugin.dataManager.getData().history = this.entries;
			await this.plugin.dataManager.persist();
		} catch {
			// write errors are non-fatal
		}
	}
}
