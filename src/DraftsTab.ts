import Fuse from 'fuse.js';
import type { EventRef } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type { DraftPersistState, WatchLogTitle } from './types';
import { AddTitleModal } from './AddTitleModal';

interface LiveDraftEntry {
	titleKey: string;
	titleDisplay: string;
	sources: string[];
	firstSeen: string;
	added: boolean;
}

export class DraftsTab {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private containerEl: HTMLElement;
	private onCountChange: (count: number) => void;

	private eventRef: EventRef | null = null;
	private destroyed = false;
	private scanDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private lastScanEntries: LiveDraftEntry[] = [];
	private persistState: DraftPersistState = {
		dismissed: [],
		added: [],
		firstSeen: {},
		titleDisplay: {},
	};

	constructor(
		containerEl: HTMLElement,
		plugin: WatchLogPlugin,
		dataManager: DataManager,
		onCountChange: (count: number) => void,
	) {
		this.containerEl = containerEl;
		this.plugin = plugin;
		this.dataManager = dataManager;
		this.onCountChange = onCountChange;
	}

	async render(): Promise<void> {
		this.destroyed = false;
		await this.loadPersistState();
		if (this.destroyed) return;

		const entries = await this.scanVault();
		if (this.destroyed) return;

		this.renderUI(entries);
		this.registerChangeListener();
	}

	destroy(): void {
		this.destroyed = true;
		if (this.scanDebounceTimer) {
			clearTimeout(this.scanDebounceTimer);
			this.scanDebounceTimer = null;
		}
		if (this.eventRef) {
			this.plugin.app.metadataCache.offref(this.eventRef);
			this.eventRef = null;
		}
	}

	// ── Persistence ───────────────────────────────────────────────────────────────

	private async loadPersistState(): Promise<void> {
		const data = (await this.plugin.loadData()) as Record<string, unknown> | null;
		const drafts = data?.['drafts'] as Partial<DraftPersistState> | undefined;
		if (drafts) {
			this.persistState = {
				dismissed: drafts.dismissed ?? [],
				added: drafts.added ?? [],
				firstSeen: drafts.firstSeen ?? {},
				titleDisplay: drafts.titleDisplay ?? {},
			};
		}
	}

	private async savePersistState(): Promise<void> {
		const data = ((await this.plugin.loadData()) as Record<string, unknown> | null) ?? {};
		await this.plugin.saveData({ ...data, drafts: this.persistState });
	}

	// ── Vault scanning ────────────────────────────────────────────────────────────

	private getTag(): string {
		return this.plugin.settings.draftsVaultTag ?? '#watchlog';
	}

	private async scanVault(): Promise<LiveDraftEntry[]> {
		const tag = this.getTag();
		const files = this.plugin.app.vault.getMarkdownFiles();
		// Map: lowercase title key → { sources, displayTitle }
		const liveMap: Map<string, { sources: Set<string>; displayTitle: string }> = new Map();

		for (const file of files) {
			const cache = this.plugin.app.metadataCache.getFileCache(file);
			const hasTag = cache?.tags?.some((t) => t.tag === tag) ?? false;
			if (!hasTag) continue;

			try {
				const content = await this.plugin.app.vault.cachedRead(file);
				const lines = content.split('\n');
				for (const line of lines) {
					if (!line.includes(tag)) continue;
					const tagIdx = line.indexOf(tag);
					const afterTag = line.slice(tagIdx + tag.length).trim();
					if (!afterTag) continue;

					// Each comma-separated segment after the tag is a separate title
					const segments = afterTag.split(',');
					for (const seg of segments) {
						const displayTitle = seg.trim();
						if (!displayTitle || displayTitle.length > 100) continue;
						const titleKey = displayTitle.toLowerCase();
						if (!liveMap.has(titleKey)) {
							liveMap.set(titleKey, { sources: new Set(), displayTitle });
						}
						liveMap.get(titleKey)!.sources.add(file.basename);
					}
				}
			} catch {
				// Skip unreadable files
			}
		}

		// Record firstSeen and displayTitle for newly discovered entries
		let stateChanged = false;
		const now = new Date().toISOString();
		for (const [key, { displayTitle }] of liveMap) {
			if (!this.persistState.firstSeen[key]) {
				this.persistState.firstSeen[key] = now;
				stateChanged = true;
			}
			if (!this.persistState.titleDisplay[key]) {
				this.persistState.titleDisplay[key] = displayTitle;
				stateChanged = true;
			}
		}
		if (stateChanged) {
			await this.savePersistState();
		}

		// Build visible entries (dismissed entries are excluded entirely)
		const entries: LiveDraftEntry[] = [];
		for (const [key, { sources }] of liveMap) {
			if (this.persistState.dismissed.includes(key)) continue;
			entries.push({
				titleKey: key,
				titleDisplay: this.persistState.titleDisplay[key] ?? key,
				sources: Array.from(sources),
				firstSeen: this.persistState.firstSeen[key] ?? now,
				added: this.persistState.added.includes(key),
			});
		}

		// Sort oldest-first (FIFO queue)
		entries.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
		this.lastScanEntries = entries;
		return entries;
	}

	// ── Event listener ────────────────────────────────────────────────────────────

	private triggerDebouncedRender(): void {
		if (this.scanDebounceTimer) clearTimeout(this.scanDebounceTimer);
		this.scanDebounceTimer = setTimeout(() => {
			this.scanDebounceTimer = null;
			void this.render();
		}, 500);
	}

	private registerChangeListener(): void {
		if (this.eventRef) {
			this.plugin.app.metadataCache.offref(this.eventRef);
		}
		this.eventRef = this.plugin.app.metadataCache.on('changed', (_file) => {
			this.triggerDebouncedRender();
		});
	}

	// ── Fuzzy match helper ────────────────────────────────────────────────────────

	private buildFuse(titles: WatchLogTitle[]): Fuse<WatchLogTitle> {
		return new Fuse(titles, {
			keys: ['title'],
			threshold: 0.35,
			includeScore: true,
		});
	}

	private fuzzyMatchesWatchlist(displayTitle: string, fuse: Fuse<WatchLogTitle>): boolean {
		const results = fuse.search(displayTitle);
		return results.length > 0 && (results[0]?.score ?? 1) <= 0.35;
	}

	// ── Rendering ─────────────────────────────────────────────────────────────────

	private renderUI(entries: LiveDraftEntry[]): void {
		const el = this.containerEl;
		el.empty();

		const tag = this.getTag();
		const watchlistTitles = this.dataManager.getTitles();
		const fuse = this.buildFuse(watchlistTitles);

		// Compute fuzzy match results once per entry and cache them
		const fuzzyCache = new Map<string, boolean>();
		for (const entry of entries) {
			if (entry.added) {
				fuzzyCache.set(entry.titleKey, false);
			} else {
				fuzzyCache.set(entry.titleKey, this.fuzzyMatchesWatchlist(entry.titleDisplay, fuse));
			}
		}

		// Pending = not added AND not already present in the Watchlist (exact or fuzzy)
		const pendingCount = entries.filter((e) => {
			if (e.added) return false;
			return !fuzzyCache.get(e.titleKey);
		}).length;
		this.onCountChange(pendingCount);

		// Notice banner — matches Custom Lists draft banner style (Fix 3)
		el.createDiv({
			cls: 'wl-drafts-notice',
			text: `⚠ Write ${tag} Movie Name in any note and it appears here automatically. Hit Add when you're ready to add it to your Watchlist.`,
		});

		// Count pill
		const countWrap = el.createDiv({ cls: 'wl-list-title-wrap' });
		countWrap.createSpan({ cls: 'wl-list-count', text: String(pendingCount) });
		countWrap.createSpan({
			cls: 'wl-drafts-count-label',
			text: ` Pending draft${pendingCount !== 1 ? 's' : ''}`,
		});

		if (entries.length === 0) {
			el.createDiv({
				cls: 'wl-drafts-empty',
				text: `No drafts found. Add ${tag} followed by a title in any vault note.`,
			});
			return;
		}

		// Sort: non-Watchlist entries first (oldest-first), Watchlist entries last (oldest-first)
		entries.sort((a, b) => {
			const aDup = fuzzyCache.get(a.titleKey) ?? false;
			const bDup = fuzzyCache.get(b.titleKey) ?? false;
			if (aDup !== bDup) return aDup ? 1 : -1;
			return a.firstSeen.localeCompare(b.firstSeen);
		});

		// Cards (Fix 2 — Upcoming tab card style)
		const cards = el.createDiv({ cls: 'wl-drafts-cards' });
		for (const entry of entries) {
			this.renderCard(cards, entry, fuzzyCache.get(entry.titleKey) ?? false);
		}
	}

	private renderCard(cards: HTMLElement, entry: LiveDraftEntry, isDuplicate: boolean): void {
		// Build class list (Fix 4 — dim watchlist rows; style added rows)
		let cls = 'wl-drafts-card';
		if (isDuplicate) cls += ' wl-drafts-card-watchlist';
		if (entry.added) cls += ' wl-drafts-card-added';

		const card = cards.createDiv({ cls });

		// Title (left, bold)
		card.createDiv({ cls: 'wl-drafts-card-title', text: entry.titleDisplay });

		// Source link (center)
		const sourceEl = card.createDiv({ cls: 'wl-drafts-card-source' });
		if (entry.sources.length > 0) {
			const primaryNote = entry.sources[0]!;
			const link = sourceEl.createSpan({
				cls: 'wl-drafts-source-link',
				text: `[[${primaryNote}]]`,
			});
			link.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.plugin.app.workspace.openLinkText(primaryNote, '');
			});
			if (entry.sources.length > 1) {
				sourceEl.createSpan({
					cls: 'wl-drafts-source-count',
					text: ` (${entry.sources.length})`,
					attr: { title: entry.sources.join('\n') },
				});
			}
		}

		// "In Watchlist" indicator (center-right, only when applicable) — Fix 4
		const dupEl = card.createDiv({ cls: 'wl-drafts-card-dup' });
		if (isDuplicate) {
			dupEl.createSpan({
				text: 'In Watchlist',
				attr: { title: 'This title already exists in your Watchlist' },
			});
		}

		// Actions (far right)
		const actions = card.createDiv({ cls: 'wl-drafts-card-actions' });

		if (entry.added || isDuplicate) {
			actions.createSpan({ cls: 'wl-drafts-added-label', text: 'Added' });
		} else {
			const addBtn = actions.createEl('button', {
				cls: 'wl-btn wl-btn-sm wl-btn-primary',
				text: 'Add',
			});
			addBtn.addEventListener('click', () => this.openAddModal(entry));
		}

		const dismissBtn = actions.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-drafts-dismiss',
			text: '✕',
			attr: { title: 'Dismiss' },
		});
		dismissBtn.addEventListener('click', () => void this.dismissEntry(entry.titleKey));
	}

	private rerenderFromCache(): void {
		const entries = this.lastScanEntries
			.filter((e) => !this.persistState.dismissed.includes(e.titleKey))
			.map((e) => ({
				...e,
				added: this.persistState.added.includes(e.titleKey),
			}));
		this.renderUI(entries);
	}

	// ── Actions ───────────────────────────────────────────────────────────────────

	private async dismissEntry(titleKey: string): Promise<void> {
		if (!this.persistState.dismissed.includes(titleKey)) {
			this.persistState.dismissed.push(titleKey);
		}
		this.persistState.added = this.persistState.added.filter((k) => k !== titleKey);
		await this.savePersistState();
		this.rerenderFromCache();
	}

	private openAddModal(entry: LiveDraftEntry): void {
		const modal = new AddTitleModal(
			this.plugin.app,
			this.plugin,
			this.dataManager,
			() => void this.afterAdded(entry.titleKey),
			{
				searchQuery: entry.titleDisplay,
				title: entry.titleDisplay,
				type: 'Anime',
				episodes: 0,
				duration: 0,
				releaseDate: '',
				link: '',
				seasons: [],
			},
		);
		modal.open();
	}

	private async afterAdded(titleKey: string): Promise<void> {
		const behavior = this.plugin.settings.draftsAfterAdding ?? 'keep';
		if (behavior === 'remove') {
			await this.dismissEntry(titleKey);
		} else {
			if (!this.persistState.added.includes(titleKey)) {
				this.persistState.added.push(titleKey);
			}
			await this.savePersistState();
			this.rerenderFromCache();
		}
	}
}
