import { requestUrl } from 'obsidian';
import type { DataManager } from './DataManager';
import type { WatchLogTitle, WatchLogPluginSettings } from './types';
import { getApiGroupForType } from './types';

const JIKAN_BASE = 'https://api.jikan.moe/v4';
const OMDB_BASE = 'https://www.omdbapi.com';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w300';
const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const API_TIMEOUT_MS = 8000;

// Rate-limit delays between consecutive queued requests
const JIKAN_DELAY_MS = 400; // ≈2.5 req/sec (Jikan caps at 3/sec)
const ANILIST_DELAY_MS = 700; // AniList caps at 90/min
const TMDB_DELAY_MS = 30;   // ≈33 req/sec (TMDB caps at 40/sec)
const OMDB_DELAY_MS = 100;

interface QueueItem {
	title: WatchLogTitle;
	resolve: (url: string | null) => void;
}

interface JikanImagesShape {
	data?: {
		images?: {
			jpg?: {
				image_url?: string;
				large_image_url?: string;
			};
		};
	};
	// Search shape: data is an array
}

interface JikanSearchShape {
	data?: Array<{
		images?: {
			jpg?: {
				image_url?: string;
				large_image_url?: string;
			};
		};
	}>;
}

interface TmdbMultiResult {
	results?: Array<{ poster_path?: string | null }>;
}

interface OmdbResult {
	Poster?: string;
	Response?: string;
}

interface AniListPosterResponse {
	data?: {
		Media?: {
			coverImage?: { large?: string | null; medium?: string | null } | null;
		} | null;
	};
}

export class PosterService {
	private dataManager: DataManager;
	private getSettings: () => WatchLogPluginSettings;
	private queue: QueueItem[] = [];
	private isProcessing = false;
	private disposed = false;

	constructor(
		dataManager: DataManager,
		getSettings: () => WatchLogPluginSettings,
	) {
		this.dataManager = dataManager;
		this.getSettings = getSettings;
	}

	destroy(): void {
		this.disposed = true;
		this.clearQueue();
	}

	/**
	 * Enqueue a poster fetch for the given title. Resolves with the URL or null.
	 * The result is also persisted via DataManager.updatePosterUrl (silent + debounced).
	 */
	enqueue(title: WatchLogTitle): Promise<string | null> {
		return new Promise((resolve) => {
			if (this.disposed) { resolve(null); return; }
			this.queue.push({ title, resolve });
			void this.processQueue();
		});
	}

	/** Empty the queue and resolve all pending promises with null. */
	clearQueue(): void {
		const pending = this.queue.splice(0);
		for (const item of pending) {
			item.resolve(null);
		}
	}

	private async processQueue(): Promise<void> {
		if (this.isProcessing) return;
		this.isProcessing = true;

		while (this.queue.length > 0) {
			if (this.disposed) break;
			const item = this.queue.shift();
			if (!item) break;
			// Manual override: don't auto-fetch, don't touch posterUrl.
			if (item.title.manualPosterUrl && item.title.manualPosterUrl.trim() !== '') {
				item.resolve(item.title.manualPosterUrl);
				continue;
			}
			try {
				const url = await this.fetchPosterForTitle(item.title);
				if (this.disposed) { item.resolve(null); break; }
				const finalUrl = url || 'none';
				this.dataManager.updatePosterUrl(item.title.id, finalUrl);
				item.resolve(url);
			} catch {
				if (!this.disposed) this.dataManager.updatePosterUrl(item.title.id, 'none');
				item.resolve(null);
			}

			const delay = this.getDelayForTitle(item.title);
			if (delay > 0) {
				await new Promise<void>((r) => window.setTimeout(r, delay));
			}
		}

		this.isProcessing = false;
	}

	private getDelayForTitle(title: WatchLogTitle): number {
		const settings = this.getSettings();
		const group = getApiGroupForType(title.type, settings.typeApiMapping);
		if (group === 'anime') {
			if (title.anilistId && title.anilistId > 0) return ANILIST_DELAY_MS;
			return JIKAN_DELAY_MS;
		}
		if (settings.tmdbApiKey) return TMDB_DELAY_MS;
		if (settings.omdbApiKey) return OMDB_DELAY_MS;
		return 0;
	}

	private async fetchPosterForTitle(title: WatchLogTitle): Promise<string | null> {
		// Already cached
		if (title.posterUrl && title.posterUrl.startsWith('http')) return title.posterUrl;
		if (title.posterUrl === 'none') return null;

		const settings = this.getSettings();
		const group = getApiGroupForType(title.type, settings.typeApiMapping);
		if (group === 'anime') return this.fetchAnimePoster(title);
		if (group === 'movie') return this.fetchMediaPoster(title);
		return null;
	}

	private cleanTitleForSearch(name: string): string {
		const cleaned = name
			.replace(/\s*-?\s*[Ss]eason\s*\d+/gi, '')
			.replace(/\s*-?\s*[Ss]eries\s*\d+/gi, '')
			.replace(/\s*-?\s*[Pp]art\s*\d+/gi, '')
			.replace(/\s*-?\s*[Vv]ol(ume)?\.?\s*\d+/gi, '')
			.replace(/\s*\(\d{4}\)/g, '')
			.replace(/\s*-?\s*[Ss]\d+/gi, '')
			.replace(/\s+/g, ' ')
			.trim();
		return cleaned || name;
	}

	private async fetchAnimePoster(title: WatchLogTitle): Promise<string | null> {
		if (title.anilistId && title.anilistId > 0) {
			const gql = `query ($id: Int) { Media(id: $id, type: ANIME) { coverImage { large medium } } }`;
			const data = (await this.postJson(ANILIST_ENDPOINT, {
				query: gql,
				variables: { id: title.anilistId },
			})) as AniListPosterResponse | null;
			const cover = data?.data?.Media?.coverImage;
			return cover?.large ?? cover?.medium ?? null;
		}
		if (title.malId) {
			const url = `${JIKAN_BASE}/anime/${title.malId}`;
			const data = (await this.fetchJson(url)) as JikanImagesShape | null;
			const jpg = data?.data?.images?.jpg;
			return jpg?.large_image_url ?? jpg?.image_url ?? null;
		}
		const q = encodeURIComponent(this.cleanTitleForSearch(title.title));
		const url = `${JIKAN_BASE}/anime?q=${q}&limit=1`;
		const data = (await this.fetchJson(url)) as JikanSearchShape | null;
		const first = data?.data?.[0];
		const jpg = first?.images?.jpg;
		return jpg?.large_image_url ?? jpg?.image_url ?? null;
	}

	private async fetchMediaPoster(title: WatchLogTitle): Promise<string | null> {
		const settings = this.getSettings();
		const searchName = this.cleanTitleForSearch(title.title);
		if (settings.tmdbApiKey) {
			const q = encodeURIComponent(searchName);
			const url = `${TMDB_BASE}/search/multi?query=${q}&page=1`;
			const data = (await this.fetchJson(url, {
				Authorization: `Bearer ${settings.tmdbApiKey}`,
			})) as TmdbMultiResult | null;
			const poster = data?.results?.[0]?.poster_path;
			if (poster) return `${TMDB_IMG_BASE}${poster}`;
			return null;
		}
		if (settings.omdbApiKey) {
			const q = encodeURIComponent(searchName);
			const url = `${OMDB_BASE}/?t=${q}&apikey=${encodeURIComponent(settings.omdbApiKey)}`;
			const data = (await this.fetchJson(url)) as OmdbResult | null;
			const poster = data?.Poster;
			if (poster && poster !== 'N/A') return poster;
			return null;
		}
		return null;
	}

	private async fetchJson(
		url: string,
		headers?: Record<string, string>,
	): Promise<unknown> {
		let timer: number | null = null;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = window.setTimeout(() => reject(new Error('Request timed out')), API_TIMEOUT_MS);
		});
		try {
			const fetchPromise = requestUrl({ url, headers }).then((r) => r.json as unknown);
			return await Promise.race([fetchPromise, timeoutPromise]);
		} finally {
			if (timer !== null) window.clearTimeout(timer);
		}
	}

	private async postJson(
		url: string,
		body: unknown,
		headers?: Record<string, string>,
	): Promise<unknown> {
		let timer: number | null = null;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = window.setTimeout(() => reject(new Error('Request timed out')), API_TIMEOUT_MS);
		});
		try {
			const fetchPromise = requestUrl({
				url,
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
				body: JSON.stringify(body),
			}).then((r) => r.json as unknown);
			return await Promise.race([fetchPromise, timeoutPromise]);
		} finally {
			if (timer !== null) window.clearTimeout(timer);
		}
	}
}
