import { App, TFile, normalizePath } from 'obsidian';
import type WatchLogPlugin from './main';
import type { WatchLogData, WatchLogTitle, WatchLogGroup, AirtimeEntry, MaybeTitle, SavedFilterPreset } from './types';
import type { HistoryManager } from './HistoryManager';
import { formatHistoryDate } from './HistoryManager';

export class DataManager {
	private plugin: WatchLogPlugin;
	private app: App;
	private data: WatchLogData;
	private changeListeners: Array<() => void> = [];
	private historyManager: HistoryManager | null = null;

	setHistoryManager(hm: HistoryManager): void {
		this.historyManager = hm;
	}

	constructor(plugin: WatchLogPlugin) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.data = { titles: [], groups: [], settings: {} };
	}

	async load(): Promise<void> {
		const loaded = (await this.plugin.loadData()) as WatchLogData | null;
		if (loaded) {
			this.data = loaded;
		} else {
			this.data = { titles: [], groups: [], settings: {} };
		}
		this.migrateData();
	}

	private migrateData(): void {
		// Ensure core arrays exist (data.json may be missing or partial on first install)
		if (!Array.isArray(this.data.titles)) {
			this.data.titles = [];
		}
		if (!Array.isArray((this.data as unknown as Record<string, unknown>)['groups'])) {
			this.data.groups = [];
		}

		// Ensure airtime array exists
		if (!Array.isArray(this.data.airtime)) {
			this.data.airtime = [];
		}

		for (const title of this.data.titles) {
			// Ensure dateAdded is a full ISO timestamp (old data may be date-only "YYYY-MM-DD")
			if (!title.dateAdded) {
				title.dateAdded = new Date().toISOString();
			} else if (!title.dateAdded.includes('T')) {
				title.dateAdded = new Date(title.dateAdded).toISOString();
			}

			// Migrate lastInteracted → dateModified
			if (!title.dateModified) {
				const raw = title as unknown as Record<string, unknown>;
				const lastInteracted = raw['lastInteracted'];
				if (typeof lastInteracted === 'string' && lastInteracted) {
					title.dateModified = lastInteracted;
				} else {
					title.dateModified = title.dateAdded;
				}
			}
		}
	}

	private async saveOnly(): Promise<void> {
		await this.plugin.saveData(this.data);
	}

	async save(): Promise<void> {
		await this.saveOnly();
		this.notifyListeners();
	}

	getTitles(): WatchLogTitle[] {
		return this.data.titles ?? [];
	}

	getTitle(id: string): WatchLogTitle | undefined {
		return (this.data.titles ?? []).find((t) => t.id === id);
	}

	async addTitle(title: WatchLogTitle): Promise<void> {
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
		void this.historyManager?.log(`${title.title} (${title.type}) was added on ${formatHistoryDate(now)}`);
	}

	/** Add without triggering a UI re-render. Caller must call notifyChange() after the batch. */
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
				this.data.airtime = this.data.airtime.filter((e) => e.titleId !== id);
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
		// Only auto-add when we have a full YYYY-MM-DD date
		if (!/^\d{4}-\d{2}-\d{2}$/.test(title.releaseDate)) return false;
		const release = new Date(title.releaseDate + 'T12:00:00');
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		return release > today;
	}

	async autoAddToUpcoming(title: WatchLogTitle): Promise<void> {
		if (!this.data.airtime) this.data.airtime = [];
		// Avoid duplicates
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
		// Persist airtime entry
		await this.plugin.saveData(this.data);
	}

	/** Remove all Upcoming entries for a given title (e.g. when date goes past). */
	async removeAirtimeEntriesForTitle(titleId: string): Promise<void> {
		const before = (this.data.airtime ?? []).length;
		this.data.airtime = (this.data.airtime ?? []).filter((e) => e.titleId !== titleId);
		if ((this.data.airtime ?? []).length !== before) {
			await this.save();
		}
	}

	async updateTitle(updated: WatchLogTitle): Promise<void> {
		updated.dateModified = new Date().toISOString();
		const idx = this.data.titles.findIndex((t) => t.id === updated.id);
		if (idx >= 0) {
			const old = this.data.titles[idx]!;
			const now = new Date().toISOString();
			if (old.rating !== updated.rating) {
				void this.historyManager?.log(`${updated.title} (${updated.type}) was reviewed on ${formatHistoryDate(now)}`);
			}
			if (old.status !== updated.status && updated.status === 'Completed') {
				void this.historyManager?.log(
					`${updated.title} (${updated.type}) was marked as watched on ${formatHistoryDate(now)}`
				);
			}
			this.data.titles[idx] = updated;
			await this.save();
			await this.updateMarkdownFile(updated);
		}
	}

	async removeTitle(id: string): Promise<void> {
		const title = this.getTitle(id);
		if (title) {
			const now = new Date().toISOString();
			void this.historyManager?.log(`${title.title} (${title.type}) was deleted on ${formatHistoryDate(now)}`);
		}
		this.data.titles = this.data.titles.filter((t) => t.id !== id);
		// Remove from any groups
		for (const group of this.data.groups) {
			group.titleIds = group.titleIds.filter((tid) => tid !== id);
		}
		// Remove airtime entries for this title
		if (this.data.airtime) {
			this.data.airtime = this.data.airtime.filter((e) => e.titleId !== id);
		}
		// Remove collapsed seasons for this title
		const d = this.data as unknown as Record<string, unknown>;
		if (d['collapsedSeasons']) {
			delete (d['collapsedSeasons'] as Record<string, number[]>)[id];
		}
		await this.save();
		if (title) {
			await this.deleteMarkdownFile(title);
		}
	}

	// ── Group CRUD ────────────────────────────────────────────────────────────────

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

	// ── Pinned group ──────────────────────────────────────────────────────────────

	getPinnedGroupId(): string | null {
		return this.data.pinnedGroupId ?? null;
	}

	async setPinnedGroupId(id: string | null): Promise<void> {
		this.data.pinnedGroupId = id;
		await this.save();
	}

	// ── Saved filter preset ───────────────────────────────────────────────────────

	getSavedFilterPreset(): SavedFilterPreset | null {
		return this.data.savedFilterPreset ?? null;
	}

	async setSavedFilterPreset(preset: SavedFilterPreset | null): Promise<void> {
		this.data.savedFilterPreset = preset;
		await this.save();
	}

	// ── Airtime CRUD ──────────────────────────────────────────────────────────────

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

	// ── Maybe CRUD ────────────────────────────────────────────────────────────────

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

	// ── Time calculations ─────────────────────────────────────────────────────────

	calcTimeWatched(title: WatchLogTitle): number {
		if (title.episodeDuration <= 0) return 0;
		// "To be released" titles haven't been watched yet
		if (title.status === 'To be released') return 0;
		if (title.type === 'Movie') {
			return title.watchedEpisodes.includes(1) ? title.episodeDuration : 0;
		}
		if (title.status === 'Completed') {
			return title.totalEpisodes * title.episodeDuration;
		}
		// Watching, Dropped, Plan to watch: only watched episodes
		return title.watchedEpisodes.length * title.episodeDuration;
	}

	calcTimeRemaining(title: WatchLogTitle): number {
		if (title.episodeDuration <= 0) return 0;
		if (title.status === 'Dropped') return 0;
		// "To be released" doesn't count toward time remaining (not yet available)
		if (title.status === 'To be released') return 0;
		if (title.type === 'Movie') {
			return title.watchedEpisodes.includes(1) ? 0 : title.episodeDuration;
		}
		if (title.status === 'Plan to watch') {
			return Math.max(0, title.totalEpisodes - title.watchedEpisodes.length) * title.episodeDuration;
		}
		if (title.status === 'Watching') {
			const unwatched = Math.max(0, title.totalEpisodes - title.watchedEpisodes.length);
			return unwatched * title.episodeDuration;
		}
		// Completed or other: 0
		return 0;
	}

	calcTimeRemainingForModal(title: WatchLogTitle): number {
		if (title.episodeDuration <= 0) return 0;
		if (title.status === 'To be released') return 0;
		if (title.type === 'Movie') {
			return title.watchedEpisodes.includes(1) ? 0 : title.episodeDuration;
		}
		if (title.status === 'Dropped') {
			return Math.max(0, title.totalEpisodes - title.watchedEpisodes.length) * title.episodeDuration;
		}
		if (title.status === 'Plan to watch') {
			return Math.max(0, title.totalEpisodes - title.watchedEpisodes.length) * title.episodeDuration;
		}
		if (title.status === 'Watching') {
			return Math.max(0, title.totalEpisodes - title.watchedEpisodes.length) * title.episodeDuration;
		}
		// Completed or other: 0
		return 0;
	}

	getTotalTimeWatched(): number {
		return (this.data.titles ?? []).reduce((sum, t) => sum + this.calcTimeWatched(t), 0);
	}

	getTotalTimeRemaining(): number {
		return (this.data.titles ?? []).reduce((sum, t) => sum + this.calcTimeRemaining(t), 0);
	}

	// ── External change watcher ───────────────────────────────────────────────────

	startWatchingExternalChanges(): void {
		// 'raw' fires when Obsidian Sync writes a file directly to disk (not via vault API).
		// It's a real runtime event but not declared in Obsidian's public type definitions.
		const ref = (
			this.app.vault as unknown as {
				on(event: 'raw', cb: (path: string) => void): import('obsidian').EventRef;
			}
		).on('raw', (path: string) => {
			if (path.endsWith('watchlog/data.json')) {
				void (async () => {
					await this.load();
					this.notifyListeners();
				})();
			}
		});
		this.plugin.registerEvent(ref);
	}

	// ── Listeners ─────────────────────────────────────────────────────────────────

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

	// ── Season collapse persistence ──────────────────────────────────────────────

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

	// ── Progress helpers ──────────────────────────────────────────────────────────

	getProgress(title: WatchLogTitle): number {
		if (title.totalEpisodes === 0) return 0;
		return Math.round((title.watchedEpisodes.length / title.totalEpisodes) * 100);
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
				void this.historyManager?.log(`${title.title} (${title.type}) episode ${episodeNumber} was marked as watched on ${formatHistoryDate(now)}`);
			} else {
				void this.historyManager?.log(`${title.title} (${title.type}) was marked as watched on ${formatHistoryDate(now)}`);
			}
		} else {
			title.watchedEpisodes = title.watchedEpisodes.filter((e) => e !== episodeNumber);
		}

		if (
			this.plugin.settings.autoCompleteOnLastEpisode &&
			title.totalEpisodes > 0 &&
			title.watchedEpisodes.length >= title.totalEpisodes
		) {
			title.status = 'Completed';
			if (this.plugin.settings.setFinishDateAutomatically && !title.dateFinished) {
				title.dateFinished = new Date().toISOString().split('T')[0] ?? null;
			}
		} else if (title.status === 'Completed' && title.watchedEpisodes.length < title.totalEpisodes) {
			title.status = 'Watching';
			title.dateFinished = null;
		}

		await this.updateTitle(title);
	}

	async markSeasonWatched(id: string, episodeNumbers: number[], watched: boolean): Promise<void> {
		const title = this.getTitle(id);
		if (!title) return;

		if (watched) {
			const set = new Set(title.watchedEpisodes);
			for (const ep of episodeNumbers) set.add(ep);
			title.watchedEpisodes = Array.from(set).sort((a, b) => a - b);
		} else {
			const remove = new Set(episodeNumbers);
			title.watchedEpisodes = title.watchedEpisodes.filter((e) => !remove.has(e));
		}

		if (
			this.plugin.settings.autoCompleteOnLastEpisode &&
			title.totalEpisodes > 0 &&
			title.watchedEpisodes.length >= title.totalEpisodes
		) {
			title.status = 'Completed';
			if (this.plugin.settings.setFinishDateAutomatically && !title.dateFinished) {
				title.dateFinished = new Date().toISOString().split('T')[0] ?? null;
			}
		} else if (title.status === 'Completed' && title.watchedEpisodes.length < title.totalEpisodes) {
			title.status = 'Watching';
			title.dateFinished = null;
		}

		await this.updateTitle(title);
	}

	// ── Folder management ─────────────────────────────────────────────────────────

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

	async updateMarkdownFile(title: WatchLogTitle): Promise<void> {
		const root = this.plugin.settings.rootFolder;
		const folderPath = normalizePath(`${root}/${title.type}`);
		await this.ensureFolder(folderPath);
		const safeTitle = title.title.replace(/[*"\\/<>:|?]/g, '-');
		const filePath = normalizePath(`${folderPath}/${safeTitle}.md`);
		const progress = this.getProgress(title);
		const content = this.buildMarkdownContent(title, progress);
		const existing = this.app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(filePath, content);
		}
	}

	async createMarkdownFileIfMissing(title: WatchLogTitle): Promise<boolean> {
		const root = this.plugin.settings.rootFolder;
		const folderPath = normalizePath(`${root}/${title.type}`);
		const safeTitle = title.title.replace(/[*"\\/<>:|?]/g, '-');
		const filePath = normalizePath(`${folderPath}/${safeTitle}.md`);
		if (this.app.vault.getAbstractFileByPath(filePath) instanceof TFile) return false;
		await this.ensureFolder(normalizePath(root));
		await this.ensureFolder(folderPath);
		const content = this.buildMarkdownContent(title, this.getProgress(title));
		await this.app.vault.create(filePath, content);
		return true;
	}

	private buildMarkdownContent(title: WatchLogTitle, progress: number): string {
		return `---
title: "${title.title.replace(/"/g, '\\"')}"
type: ${title.type}
status: ${title.status}
priority: ${title.priority}
rating: ${title.rating}
dateStarted: ${title.dateStarted ?? 'null'}
dateFinished: ${title.dateFinished ?? 'null'}
progress: ${progress}%
totalEpisodes: ${title.totalEpisodes}
externalLink: ${title.externalLink}
---

## Notes

${title.notes}
`;
	}

	private async deleteMarkdownFile(title: WatchLogTitle): Promise<void> {
		const root = this.plugin.settings.rootFolder;
		const safeTitle = title.title.replace(/[*"\\/<>:|?]/g, '-');
		const filePath = normalizePath(`${root}/${title.type}/${safeTitle}.md`);
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			await this.app.fileManager.trashFile(file);
		}
	}

	// ── Dashboard helpers ─────────────────────────────────────────────────────────

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

	// ── ID generation ─────────────────────────────────────────────────────────────

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
