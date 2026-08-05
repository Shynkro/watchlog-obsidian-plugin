// TMDB collections (film series). Movies only — TV has no belongs_to_collection.

import { App, Modal, Notice } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type {
	WatchLogTitle,
	WatchLogGroup,
	TmdbCollectionDetail,
	TmdbCollectionPart,
} from './types';
import {
	COLLECTION_NONE,
	getCollectionId,
	isCollectionNone,
	imdbIdFromLink,
	getThemedColor,
	getDisplayPoster,
	getApiGroupForType,
} from './types';
import { buildPosterCard } from './PosterCard';
import type { CardMenuContext } from './PosterCard';
import { pinModalFooter } from './StickyModal';

const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p';
const NOT_ADDED_COLOR = '#4b5563';

function tmdbPoster(path: string | null | undefined, size = 'w342'): string {
	return path ? `${TMDB_IMG_BASE}/${size}${path}` : '';
}

function yearOf(date: string | null | undefined): string {
	return date?.match(/^(\d{4})/)?.[1] ?? '';
}

// lowercase, drop leading article + punctuation
function titleKey(title: string): string {
	return title
		.toLowerCase()
		.replace(/^(the|a|an)\s+/, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

// exact tmdbId first, else title+year (nothing has a tmdbId until something resolves one)
function matchLibraryTitle(
	part: TmdbCollectionPart,
	titles: WatchLogTitle[],
): WatchLogTitle | undefined {
	const byId = titles.find((t) => t.tmdbMediaType === 'movie' && t.tmdbId === part.id);
	if (byId) return byId;

	const key = titleKey(part.title ?? '');
	if (!key) return undefined;
	const partYear = yearOf(part.release_date);
	return titles.find((t) => {
		if (titleKey(t.title) !== key) return false;
		const titleYear = yearOf(t.releaseDate);
		// missing year on either side is not a mismatch
		return !partYear || !titleYear || partYear === titleYear;
	});
}

// stored tmdbId -> /find by imdb id -> title search. Caches what it learns.
export async function resolveCollection(
	plugin: WatchLogPlugin,
	title: WatchLogTitle,
): Promise<TmdbCollectionDetail | null> {
	const api = plugin.apiService;
	if (!api.hasTmdbKey()) return null;
	if (getApiGroupForType(title.type, plugin.settings.typeApiMapping) !== 'movie') return null;
	if (isCollectionNone(title)) return null;

	const known = getCollectionId(title);
	if (known !== null) return api.getTmdbCollection(known);

	// a tv id in tmdbId would query a random film — only a movie id is usable here
	let tmdbId = title.tmdbMediaType === 'movie' ? title.tmdbId ?? null : null;
	if (!tmdbId) {
		const imdbId = imdbIdFromLink(title.externalLink);
		if (imdbId) {
			const found = await api.findTmdbMovieIdByImdbId(imdbId);
			if (found.status === 'error') return null;
			if (found.status === 'none') {
				// exact key said not-a-movie. Cache it or every series re-queries.
				plugin.dataManager.updateTmdbIdentity(title.id, null, COLLECTION_NONE);
				return null;
			}
			tmdbId = found.id;
		} else {
			// fuzzy — a miss is never cached
			tmdbId = await api.searchTmdbMovieId(title.title, title.releaseDate ?? '');
		}
	}
	if (!tmdbId) return null;

	const lookup = await api.getTmdbMovieCollection(tmdbId);
	if (lookup.status === 'error') return null;
	if (lookup.status === 'none') {
		plugin.dataManager.updateTmdbIdentity(title.id, tmdbId, COLLECTION_NONE);
		return null;
	}
	plugin.dataManager.updateTmdbIdentity(title.id, tmdbId, lookup.ref.id);
	return api.getTmdbCollection(lookup.ref.id);
}

export function countMissing(collection: TmdbCollectionDetail, titles: WatchLogTitle[]): number {
	return (collection.parts ?? []).filter((p) => !matchLibraryTitle(p, titles)).length;
}

export class CollectionModal extends Modal {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private collection: TmdbCollectionDetail;
	private onChanged?: () => void;
	private changed = false;

	private parts: TmdbCollectionPart[] = [];
	private selected = new Set<number>();
	private createGroup = false;
	private isAdding = false;

	private movieType: string;
	// injected — importing TitleDetailModal would cycle
	private onOpenTitle: (title: WatchLogTitle) => void;

	private gridEl: HTMLElement | null = null;
	private footerEl: HTMLElement | null = null;
	private metaEl: HTMLElement | null = null;
	private cleanups: (() => void)[] = [];

	constructor(
		app: App,
		plugin: WatchLogPlugin,
		collection: TmdbCollectionDetail,
		movieType: string,
		onOpenTitle: (title: WatchLogTitle) => void,
		onChanged?: () => void,
	) {
		super(app);
		this.plugin = plugin;
		this.dataManager = plugin.dataManager;
		this.collection = collection;
		this.movieType = movieType;
		this.onOpenTitle = onOpenTitle;
		this.onChanged = onChanged;

		// oldest first, undated last
		this.parts = [...(collection.parts ?? [])].sort((a, b) => {
			const ay = a.release_date || '';
			const by = b.release_date || '';
			if (!ay && !by) return (a.title ?? '').localeCompare(b.title ?? '');
			if (!ay) return 1;
			if (!by) return -1;
			return ay.localeCompare(by);
		});
	}

	onOpen(): void {
		const colorTheme = this.plugin.settings.colorTheme ?? 'default';
		this.modalEl.setAttribute('data-theme', colorTheme);
		this.modalEl.addClass('wl-collection-modal-shell');
		this.contentEl.setAttribute('data-theme', colorTheme);
		this.contentEl.addClass('wl-view');
		this.contentEl.addClass('wl-detail-modal');
		this.contentEl.addClass('wl-collection-modal');
		this.renderAll();
	}

	onClose(): void {
		for (const fn of this.cleanups) fn();
		this.cleanups = [];
		this.contentEl.empty();
		if (this.changed && this.onChanged) this.onChanged();
	}

	private renderAll(): void {
		this.contentEl.empty();
		this.renderHeader();
		this.gridEl = this.contentEl.createDiv({
			cls: 'wl-cards-grid wl-detail-group-grid wl-collection-grid',
		});
		this.renderGrid();
		this.footerEl = this.contentEl.createDiv({ cls: 'wl-detail-footer wl-collection-footer' });
		this.renderFooter();
		pinModalFooter(this.footerEl);
	}

	private renderHeader(): void {
		const header = this.contentEl.createDiv({ cls: 'wl-collection-header' });

		const posterUrl = tmdbPoster(this.collection.poster_path, 'w185');
		if (posterUrl) {
			const cover = header.createDiv({ cls: 'wl-collection-cover' });
			const img = cover.createEl('img', { cls: 'wl-collection-cover-img' });
			img.src = posterUrl;
			img.alt = this.collection.name;
			img.decoding = 'async';
			img.onerror = () => cover.addClass('wl-hidden');
		}

		const left = header.createDiv({ cls: 'wl-collection-header-left' });
		left.createEl('h2', { cls: 'wl-detail-title', text: this.collection.name });
		this.metaEl = left.createDiv({ cls: 'wl-collection-meta' });
		this.renderMeta();

		if (this.collection.overview) {
			left.createDiv({ cls: 'wl-collection-overview', text: this.collection.overview });
		}
	}

	private renderMeta(): void {
		if (!this.metaEl) return;
		const titles = this.dataManager.getTitles();
		const owned = this.parts.filter((p) => matchLibraryTitle(p, titles)).length;
		this.metaEl.setText(`${owned} of ${this.parts.length} in your library`);
	}

	private renderGrid(): void {
		const grid = this.gridEl;
		if (!grid) return;
		grid.empty();

		const settings = this.plugin.settings;
		const titles = this.dataManager.getTitles();
		const menuCtx: CardMenuContext = { container: grid, cleanups: this.cleanups };

		for (const part of this.parts) {
			const existing = matchLibraryTitle(part, titles);
			const name = part.title ?? 'Untitled';
			const year = yearOf(part.release_date);
			const fallbackPoster = tmdbPoster(part.poster_path);

			if (existing) {
				const typeDef = settings.types.find((d) => d.name === existing.type);
				const statusDef = settings.statuses.find((d) => d.name === existing.status);
				const typeColor = typeDef
					? getThemedColor(existing.type, typeDef.color, settings.colorTheme)
					: NOT_ADDED_COLOR;
				const total = this.dataManager.getEffectiveTotal(existing);
				const ratio =
					existing.status === 'Completed'
						? 1
						: total > 0
							? Math.max(0, Math.min(1, existing.watchedEpisodes.length / total))
							: undefined;

				buildPosterCard(
					grid,
					{
						dataset: { titleId: existing.id },
						title: existing.title,
						posterUrl: getDisplayPoster(existing) || fallbackPoster,
						placeholderColor: typeColor,
						statusLabel: existing.status,
						statusColor: statusDef
							? getThemedColor(existing.status, statusDef.color, settings.colorTheme)
							: undefined,
						typeLabel: existing.type,
						typeColor,
						year: year || undefined,
						progressRatio: ratio,
						onClick: () => {
							this.close();
							this.onOpenTitle(existing);
						},
					},
					menuCtx,
				);
				continue;
			}

			const card = buildPosterCard(
				grid,
				{
					dataset: { partId: String(part.id) },
					title: name,
					posterUrl: fallbackPoster,
					placeholderColor: NOT_ADDED_COLOR,
					selected: this.selected.has(part.id),
					statusLabel: 'Not added',
					statusColor: NOT_ADDED_COLOR,
					typeLabel: this.movieType,
					typeColor: NOT_ADDED_COLOR,
					year: year || undefined,
					onClick: (el) => this.toggleSelection(part.id, el),
				},
				menuCtx,
			);
			card.addClass('wl-collection-card-missing');

			// marker only — whole card toggles
			const tick = card.createDiv({ cls: 'wl-collection-tick' });
			tick.setText('✓');
		}
	}

	private toggleSelection(partId: number, card: HTMLElement): void {
		if (this.isAdding) return;
		if (this.selected.has(partId)) {
			this.selected.delete(partId);
		} else {
			this.selected.add(partId);
		}
		card.toggleClass('wl-card-selected', this.selected.has(partId));
		this.renderFooter();
	}

	private renderFooter(): void {
		const footer = this.footerEl;
		if (!footer) return;
		footer.empty();

		const titles = this.dataManager.getTitles();
		const missing = this.parts.filter((p) => !matchLibraryTitle(p, titles));

		const left = footer.createDiv({ cls: 'wl-collection-footer-left' });

		if (missing.length > 0) {
			const allSelected = missing.every((p) => this.selected.has(p.id));
			const selectBtn = left.createEl('button', {
				cls: 'wl-btn wl-btn-sm',
				text: allSelected ? 'Select none' : 'Select all',
				attr: { type: 'button' },
			});
			selectBtn.disabled = this.isAdding;
			selectBtn.addEventListener('click', () => {
				if (allSelected) {
					this.selected.clear();
				} else {
					for (const p of missing) this.selected.add(p.id);
				}
				this.renderGrid();
				this.renderFooter();
			});
		}

		const groupLabel = left.createEl('label', { cls: 'wl-collection-group-toggle' });
		const groupCheck = groupLabel.createEl('input', { attr: { type: 'checkbox' } });
		groupCheck.checked = this.createGroup;
		groupCheck.disabled = this.isAdding;
		groupCheck.addEventListener('change', () => {
			this.createGroup = groupCheck.checked;
		});
		groupLabel.createSpan({ text: `Group as "${this.collection.name}"` });

		const addBtn = footer.createEl('button', {
			cls: 'wl-btn wl-btn-primary wl-collection-add',
			attr: { type: 'button' },
		});
		const count = this.selected.size;
		addBtn.setText(
			this.isAdding
				? 'Adding…'
				: count > 0
					? `Add ${count} title${count !== 1 ? 's' : ''}`
					: 'Add selected',
		);
		addBtn.disabled = this.isAdding || count === 0;
		addBtn.addEventListener('click', () => void this.addSelected());
	}

	// detail call per pick — collection parts carry no runtime. Sequential to avoid throttling.
	private async addSelected(): Promise<void> {
		const picked = this.parts.filter((p) => this.selected.has(p.id));
		if (picked.length === 0 || this.isAdding) return;

		this.isAdding = true;
		this.renderFooter();
		// renderFooter detached the clicked button — re-query
		const addBtn = this.footerEl?.querySelector<HTMLElement>('.wl-collection-add') ?? null;

		const api = this.plugin.apiService;
		const settings = this.plugin.settings;
		// shipped defaults may have been renamed away
		const status =
			settings.statuses.find((s) => s.name === 'Plan to watch')?.name ??
			settings.statuses[0]?.name ??
			'Plan to watch';
		const priority =
			settings.priorities?.find((p) => p.name === 'Medium')?.name ??
			settings.priorities?.[0]?.name ??
			'Medium';

		// generateId only sees stored titles — dedupe within the batch too
		const takenIds = new Set(this.dataManager.getTitles().map((t) => t.id));
		const entries: WatchLogTitle[] = [];
		let failed = 0;

		for (let i = 0; i < picked.length; i++) {
			const part = picked[i]!;
			addBtn?.setText(`Adding ${i + 1}/${picked.length}…`);

			const detail = await api.getTmdbMovieDetails(String(part.id));
			if (!detail) {
				failed++;
				continue;
			}

			let id = this.dataManager.generateId(detail.title);
			if (takenIds.has(id)) {
				let n = 2;
				while (takenIds.has(`${id}-${n}`)) n++;
				id = `${id}-${n}`;
			}
			takenIds.add(id);

			const now = new Date().toISOString();
			entries.push({
				id,
				title: detail.title,
				type: this.movieType,
				status,
				priority,
				review: '',
				rating: 0,
				notes: '',
				dateStarted: null,
				dateFinished: null,
				dateAdded: now,
				dateModified: now,
				totalEpisodes: detail.episodes,
				episodeDuration: detail.episodeDuration,
				releaseDate: detail.releaseDate || null,
				externalLink: detail.url,
				seasons: detail.seasons,
				watchedEpisodes: [],
				favorite: false,
				posterUrl: '',
				trailerUrl: detail.trailerUrl ?? '',
				manualTrailerUrl: '',
				customFields: {},
				// both ids known — skips the ladder forever
				tmdbId: part.id,
				collectionId: this.collection.id,
				...(detail.director && detail.director.length > 0 ? { director: detail.director } : {}),
				...(detail.cast && detail.cast.length > 0 ? { cast: detail.cast } : {}),
			});
		}

		if (entries.length > 0) {
			// handles the future-release "To be released" + Upcoming routing
			await this.dataManager.addTitleBatch(entries);
			if (this.createGroup) await this.createCollectionGroup(entries);
			this.dataManager.notifyChange();
			this.changed = true;
			if (this.onChanged) this.onChanged();
		}

		this.isAdding = false;
		this.selected.clear();

		if (failed > 0) {
			new Notice(
				entries.length > 0
					? `Added ${entries.length}; ${failed} could not be fetched from TMDB.`
					: 'Could not fetch details from TMDB. Check your connection.',
			);
		} else {
			new Notice(`Added ${entries.length} to "${this.collection.name}".`);
		}

		this.renderGrid();
		this.renderMeta();
		this.renderFooter();
	}

	// whole collection, not just the new entries
	private async createCollectionGroup(added: WatchLogTitle[]): Promise<void> {
		const titles = this.dataManager.getTitles();
		const memberIds = new Set(added.map((t) => t.id));
		for (const part of this.parts) {
			const existing = matchLibraryTitle(part, titles);
			if (existing) memberIds.add(existing.id);
		}
		if (memberIds.size === 0) return;

		const name = this.collection.name;
		const existingGroup = this.dataManager.getGroups().find((g) => g.name === name);
		if (existingGroup) {
			// top up, don't duplicate
			for (const id of memberIds) {
				if (!existingGroup.titleIds.includes(id)) existingGroup.titleIds.push(id);
			}
			await this.dataManager.updateGroup(existingGroup);
			return;
		}

		const group: WatchLogGroup = {
			id: this.dataManager.generateGroupId(name),
			name,
			titleIds: [...memberIds],
			dateAdded: new Date().toISOString(),
		};
		await this.dataManager.addGroup(group);
	}
}
