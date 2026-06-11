import { requestUrl } from 'obsidian';
import type {
	AnimeSearchResult,
	MediaSearchResult,
	WatchLogTitle,
	JikanAnime,
	OmdbSearchResponse,
	OmdbDetailResponse,
	OmdbSeasonResponse,
	TmdbSearchResponse,
	TmdbMovieDetail,
	TmdbTvDetail,
	TmdbExternalIds,
	TmdbFindResult,
	Season,
	AniListMedia,
	AniListSearchResponse,
	AniListMediaResponse,
} from './types';

const JIKAN_BASE = 'https://api.jikan.moe/v4';
const OMDB_BASE = 'https://www.omdbapi.com';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const ANILIST_RATE_LIMIT_MS = 700;
const GOOGLE_BOOKS_BASE = 'https://www.googleapis.com/books/v1';
const JIKAN_RATE_LIMIT_MS = 400;
const API_TIMEOUT_MS = 8000;

export interface BookSearchResult {
	title: string;
	author: string;
	year: number;
	totalPages: number;
	coverUrl: string;
	googleBooksId: string;
	releaseDate: string;
	url: string;
}

export interface MangaSearchResult {
	malId: number;
	title: string;
	author: string;
	year: number;
	totalChapters: number;
	totalVolumes: number;
	coverUrl: string;
	releaseDate: string;
	url: string;
}

interface GoogleVolumeInfo {
	title?: string;
	subtitle?: string;
	authors?: string[];
	publishedDate?: string;
	pageCount?: number;
	imageLinks?: {
		smallThumbnail?: string;
		thumbnail?: string;
		small?: string;
		medium?: string;
		large?: string;
		extraLarge?: string;
	};
	infoLink?: string;
	canonicalVolumeLink?: string;
}

interface GoogleVolume {
	id?: string;
	volumeInfo?: GoogleVolumeInfo;
}

interface GoogleBooksResponse {
	items?: GoogleVolume[];
}

interface JikanMangaItem {
	mal_id: number;
	title: string;
	title_english?: string | null;
	authors?: Array<{ name: string }>;
	chapters?: number | null;
	volumes?: number | null;
	published?: { from?: string | null } | null;
	images?: { jpg?: { image_url?: string | null } | null } | null;
	url?: string | null;
}

/** Why a Google Books request failed — used to surface accurate, non-misleading UI messages. */
export type GoogleBooksErrorReason = 'no-key' | 'rate-limited' | 'http' | 'parse' | 'network';

export class GoogleBooksError extends Error {
	reason: GoogleBooksErrorReason;
	status?: number;
	constructor(reason: GoogleBooksErrorReason, message: string, status?: number) {
		super(message);
		this.name = 'GoogleBooksError';
		this.reason = reason;
		this.status = status;
	}
}

/** Maps any error from a Google Books call to a short, user-facing explanation. */
export function googleBooksErrorMessage(err: unknown): string {
	if (err instanceof GoogleBooksError) {
		switch (err.reason) {
			case 'no-key':
				return 'Google Books API key required — add one in Settings → API → Books.';
			case 'rate-limited':
				return 'Google Books rate limit reached — your API key is missing or over quota.';
			case 'http':
				return `Google Books request failed (HTTP ${err.status ?? '?'}).`;
			case 'parse':
				return 'Google Books returned an unreadable response.';
			default:
				return 'Google Books request failed — check your connection.';
		}
	}
	return 'Google Books request failed — check your connection.';
}

export class ApiService {
	private omdbApiKey: string;
	private tmdbApiKey: string;
	private googleBooksApiKey: string;
	private anilistLastRequest = 0;
	private anilistQueue: Promise<void> = Promise.resolve();
	private jikanLastRequest = 0;
	private jikanQueue: Promise<void> = Promise.resolve();

	private throttleJikan<T>(task: () => Promise<T>): Promise<T> {
		const run = async (): Promise<T> => {
			const now = Date.now();
			const gap = now - this.jikanLastRequest;
			if (gap < JIKAN_RATE_LIMIT_MS) {
				await new Promise<void>((r) => window.setTimeout(r, JIKAN_RATE_LIMIT_MS - gap));
			}
			this.jikanLastRequest = Date.now();
			return task();
		};
		const next = this.jikanQueue.then(run, run);
		this.jikanQueue = next.then(() => undefined, () => undefined);
		return next;
	}

	constructor(omdbApiKey: string, tmdbApiKey = '', googleBooksApiKey = '') {
		this.omdbApiKey = omdbApiKey;
		this.tmdbApiKey = tmdbApiKey;
		this.googleBooksApiKey = googleBooksApiKey;
	}

	setOmdbKey(key: string): void {
		this.omdbApiKey = key;
	}

	setTmdbKey(key: string): void {
		this.tmdbApiKey = key;
	}

	setGoogleBooksKey(key: string): void {
		this.googleBooksApiKey = key;
	}

	hasGoogleBooksKey(): boolean {
		return this.googleBooksApiKey.trim().length > 0;
	}

	private tmdbHeaders(): Record<string, string> {
		return { 'Authorization': `Bearer ${this.tmdbApiKey}` };
	}

	private async fetchWithTimeout(url: string, headers?: Record<string, string>): Promise<unknown> {
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

	private async postJsonWithTimeout(
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

	// ─── AniList (GraphQL) ───────────────────────────────────────────────────────

	/** Serializes AniList requests with a minimum gap of ANILIST_RATE_LIMIT_MS between them. */
	private throttleAniList<T>(task: () => Promise<T>): Promise<T> {
		const run = async (): Promise<T> => {
			const now = Date.now();
			const gap = now - this.anilistLastRequest;
			if (gap < ANILIST_RATE_LIMIT_MS) {
				await new Promise<void>((r) => window.setTimeout(r, ANILIST_RATE_LIMIT_MS - gap));
			}
			this.anilistLastRequest = Date.now();
			return task();
		};
		const next = this.anilistQueue.then(run, run);
		this.anilistQueue = next.then(() => undefined, () => undefined);
		return next;
	}

	private stripHtml(s: string): string {
		return s
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<[^>]+>/g, '')
			.replace(/&nbsp;/g, ' ')
			.replace(/&amp;/g, '&')
			.replace(/&quot;/g, '"')
			.replace(/&#039;/g, "'")
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.trim();
	}

	private formatAniListDate(d: { year?: number | null; month?: number | null; day?: number | null } | null | undefined): string {
		if (!d?.year) return '';
		const yyyy = String(d.year);
		const mm = String(d.month ?? 1).padStart(2, '0');
		const dd = String(d.day ?? 1).padStart(2, '0');
		return `${yyyy}-${mm}-${dd}`;
	}

	private mapAniListMedia(media: AniListMedia): AnimeSearchResult {
		const name = media.title?.english || media.title?.romaji || media.title?.native || '';
		const episodes = media.episodes ?? 0;
		const duration = media.duration ?? 24;
		const seasons: Season[] =
			episodes > 0 ? [{ name: 'Season 1', episodes, offset: 0 }] : [];
		const description = media.description ? this.stripHtml(media.description) : '';
		return {
			malId: 0,
			anilistId: media.id,
			title: name,
			episodes,
			duration,
			releaseDate: this.formatAniListDate(media.startDate),
			url: `https://anilist.co/anime/${media.id}`,
			seasons,
			description,
			averageScore: media.averageScore ?? undefined,
			genres: media.genres ?? undefined,
			posterUrl: media.coverImage?.large ?? media.coverImage?.medium ?? undefined,
		};
	}

	async searchAniList(query: string): Promise<AnimeSearchResult[]> {
		const gql = `
			query ($search: String) {
				Page(page: 1, perPage: 10) {
					media(search: $search, type: ANIME) {
						id
						title { romaji english native }
						episodes
						duration
						status
						season
						seasonYear
						startDate { year month day }
						averageScore
						popularity
						coverImage { large medium }
						description
						genres
					}
				}
			}
		`;
		try {
			const res = await this.throttleAniList(() =>
				this.postJsonWithTimeout(ANILIST_ENDPOINT, { query: gql, variables: { search: query } }),
			);
			const data = res as AniListSearchResponse;
			const media = data.data?.Page?.media ?? [];
			return media.map((m) => this.mapAniListMedia(m));
		} catch {
			return [];
		}
	}

	async getAniListById(anilistId: number): Promise<AniListMedia | null> {
		const gql = `
			query ($id: Int) {
				Media(id: $id, type: ANIME) {
					id
					title { romaji english native }
					episodes
					duration
					status
					averageScore
					popularity
					coverImage { large }
					nextAiringEpisode {
						airingAt
						episode
						timeUntilAiring
					}
				}
			}
		`;
		try {
			const res = await this.throttleAniList(() =>
				this.postJsonWithTimeout(ANILIST_ENDPOINT, { query: gql, variables: { id: anilistId } }),
			);
			const data = res as AniListMediaResponse;
			return data.data?.Media ?? null;
		} catch {
			return null;
		}
	}

	// ─── Jikan / MAL ─────────────────────────────────────────────────────────────

	async searchAnime(query: string): Promise<AnimeSearchResult[]> {
		const url = `${JIKAN_BASE}/anime?q=${encodeURIComponent(query)}&limit=10&sfw=false`;
		try {
			const data = (await this.fetchWithTimeout(url)) as { data?: JikanAnime[] };
			return (data.data ?? []).map((a) => this.mapJikanAnime(a));
		} catch {
			return [];
		}
	}

	private mapJikanAnime(anime: JikanAnime): AnimeSearchResult {
		const durationStr = anime.duration ?? '24 min per ep';
		const durationMatch = durationStr.match(/(\d+)\s*min/);
		const duration = durationMatch && durationMatch[1] ? parseInt(durationMatch[1]) : 24;
		const episodes = anime.episodes ?? 0;
		const seasons: Season[] =
			episodes > 0 ? [{ name: 'Season 1', episodes, offset: 0 }] : [];
		return {
			malId: anime.mal_id,
			title: anime.title_english ?? anime.title,
			episodes,
			duration,
			releaseDate: anime.aired?.from ? (anime.aired.from.split('T')[0] ?? '') : '',
			url: anime.url,
			seasons,
		};
	}

	// ─── OMDb ─────────────────────────────────────────────────────────────────────

	async searchOmdb(query: string, type: 'movie' | 'series'): Promise<MediaSearchResult[]> {
		if (!this.omdbApiKey) return [];
		const url = `${OMDB_BASE}/?s=${encodeURIComponent(query)}&type=${type}&apikey=${encodeURIComponent(this.omdbApiKey)}`;
		try {
			const data = (await this.fetchWithTimeout(url)) as OmdbSearchResponse;
			if (data.Response === 'False') return [];
			return (data.Search ?? []).slice(0, 10).map((item) => ({
				imdbId: item.imdbID,
				title: item.Title,
				mediaType: type === 'movie' ? ('movie' as const) : ('tv' as const),
				episodes: type === 'movie' ? 1 : 0,
				episodeDuration: 0,
				releaseDate: item.Year ? `${item.Year}-01-01` : '',
				url: `https://www.imdb.com/title/${item.imdbID}`,
				seasons: [],
			}));
		} catch {
			return [];
		}
	}

	async getOmdbMovieDetails(imdbId: string): Promise<MediaSearchResult | null> {
		if (!this.omdbApiKey) return null;
		const url = `${OMDB_BASE}/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(this.omdbApiKey)}`;
		try {
			const data = (await this.fetchWithTimeout(url)) as OmdbDetailResponse;
			if (data.Response === 'False' || !data.imdbID) return null;
			const runtimeMin = data.Runtime ? parseInt(data.Runtime.replace(/[^0-9]/g, '')) : 120;
			return {
				imdbId: data.imdbID,
				title: data.Title,
				mediaType: 'movie',
				episodes: 1,
				episodeDuration: isNaN(runtimeMin) ? 120 : runtimeMin,
				releaseDate: this.parseOmdbDate(data.Released ?? data.Year),
				url: `https://www.imdb.com/title/${data.imdbID}`,
				seasons: [{ name: 'Movie', episodes: 1, offset: 0 }],
			};
		} catch {
			return null;
		}
	}

	async getOmdbTvDetails(imdbId: string): Promise<MediaSearchResult | null> {
		if (!this.omdbApiKey) return null;
		const url = `${OMDB_BASE}/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(this.omdbApiKey)}`;
		try {
			const data = (await this.fetchWithTimeout(url)) as OmdbDetailResponse;
			if (data.Response === 'False' || !data.imdbID) return null;

			const totalSeasons = parseInt(data.totalSeasons ?? '1') || 1;
			const seasons: Season[] = [];
			let offset = 0;

			for (let s = 1; s <= totalSeasons; s++) {
				const count = await this.getOmdbSeasonEpisodeCount(imdbId, s);
				if (count === null) break;
				seasons.push({ name: `Season ${s}`, episodes: count, offset });
				offset += count;
			}

			const totalEpisodes = seasons.reduce((sum, s) => sum + s.episodes, 0);
			return {
				imdbId: data.imdbID,
				title: data.Title,
				mediaType: 'tv',
				episodes: totalEpisodes,
				episodeDuration: 45,
				releaseDate: this.parseOmdbDate(data.Released ?? data.Year),
				url: `https://www.imdb.com/title/${data.imdbID}`,
				seasons,
			};
		} catch {
			return null;
		}
	}

	private async getOmdbSeasonEpisodeCount(imdbId: string, season: number): Promise<number | null> {
		const url = `${OMDB_BASE}/?i=${encodeURIComponent(imdbId)}&Season=${season}&apikey=${encodeURIComponent(this.omdbApiKey)}`;
		try {
			const data = (await this.fetchWithTimeout(url)) as OmdbSeasonResponse;
			if (data.Response === 'False') return null;
			return (data.Episodes ?? []).length;
		} catch {
			return null;
		}
	}

	// ─── Jikan schedule ──────────────────────────────────────────────────────────

	async getAnimeScheduleByMalId(
		malId: number,
	): Promise<{ dayOfWeek: number; time: string } | null> {
		try {
			const url = `${JIKAN_BASE}/anime/${malId}`;
			const data = (await this.fetchWithTimeout(url)) as {
				data?: { broadcast?: { day?: string | null; time?: string | null } };
			};
			const broadcast = data.data?.broadcast;
			if (!broadcast?.day || !broadcast.time) return null;

			const dayMap: Record<string, number> = {
				Mondays: 1, Tuesdays: 2, Wednesdays: 3, Thursdays: 4,
				Fridays: 5, Saturdays: 6, Sundays: 0,
			};
			const dayOfWeek = dayMap[broadcast.day];
			if (dayOfWeek === undefined) return null;
			return { dayOfWeek, time: broadcast.time };
		} catch {
			return null;
		}
	}

	/**
	 * Converts OMDb "DD Mon YYYY" dates (e.g. "08 Feb 2026") to YYYY-MM-DD.
	 * Returns the input unchanged if it doesn't match that pattern (e.g. year-only "2026").
	 */
	private parseOmdbDate(dateStr: string): string {
		const MONTHS: Record<string, string> = {
			Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
			Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
		};
		const m = dateStr.match(/^(\d{2})\s+([A-Za-z]{3})\s+(\d{4})$/);
		if (m && m[1] && m[2] && m[3]) {
			const mon = MONTHS[m[2]];
			if (mon) return `${m[3]}-${mon}-${m[1]}`;
		}
		return dateStr;
	}

	/** Fetches OMDb detail by raw IMDb ID, auto-detecting movie vs. TV. */
	async getOmdbByImdbId(imdbId: string): Promise<MediaSearchResult | null> {
		if (!this.omdbApiKey) return null;
		const url = `${OMDB_BASE}/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(this.omdbApiKey)}`;
		try {
			const data = (await this.fetchWithTimeout(url)) as OmdbDetailResponse;
			if (data.Response === 'False' || !data.imdbID) return null;
			if (data.Type === 'movie') return this.getOmdbMovieDetails(imdbId);
			return this.getOmdbTvDetails(imdbId);
		} catch {
			return null;
		}
	}

	// ─── TMDB ─────────────────────────────────────────────────────────────────────

	async searchTmdb(query: string, type: 'movie' | 'series'): Promise<MediaSearchResult[]> {
		if (!this.tmdbApiKey) return [];
		const endpoint = type === 'movie' ? 'movie' : 'tv';
		const url = `${TMDB_BASE}/search/${endpoint}?query=${encodeURIComponent(query)}&page=1`;
		try {
			const data = (await this.fetchWithTimeout(url, this.tmdbHeaders())) as TmdbSearchResponse;
			return (data.results ?? []).slice(0, 10).map((item) => ({
				imdbId: String(item.id),
				title: item.title ?? item.name ?? '',
				mediaType: type === 'movie' ? ('movie' as const) : ('tv' as const),
				episodes: 0,
				episodeDuration: 0,
				releaseDate: item.release_date ?? item.first_air_date ?? '',
				url: '',
				seasons: [],
			}));
		} catch {
			return [];
		}
	}

	async getTmdbMovieDetails(tmdbId: string): Promise<MediaSearchResult | null> {
		if (!this.tmdbApiKey) return null;
		try {
			const [detailData, extData] = await Promise.all([
				this.fetchWithTimeout(`${TMDB_BASE}/movie/${tmdbId}`, this.tmdbHeaders()),
				this.fetchWithTimeout(`${TMDB_BASE}/movie/${tmdbId}/external_ids`, this.tmdbHeaders()),
			]);
			const detail = detailData as TmdbMovieDetail;
			const ext = extData as TmdbExternalIds;
			const imdbId = ext.imdb_id ?? detail.imdb_id ?? '';
			return {
				imdbId: String(detail.id),
				title: detail.title,
				mediaType: 'movie',
				episodes: 1,
				episodeDuration: detail.runtime ?? 120,
				releaseDate: detail.release_date ?? '',
				url: imdbId ? `https://www.imdb.com/title/${imdbId}` : '',
				seasons: [{ name: 'Movie', episodes: 1, offset: 0 }],
			};
		} catch {
			return null;
		}
	}

	async getTmdbTvDetails(tmdbId: string): Promise<MediaSearchResult | null> {
		if (!this.tmdbApiKey) return null;
		try {
			const [detailData, extData] = await Promise.all([
				this.fetchWithTimeout(`${TMDB_BASE}/tv/${tmdbId}`, this.tmdbHeaders()),
				this.fetchWithTimeout(`${TMDB_BASE}/tv/${tmdbId}/external_ids`, this.tmdbHeaders()),
			]);
			const detail = detailData as TmdbTvDetail;
			const ext = extData as TmdbExternalIds;
			const imdbId = ext.imdb_id ?? '';

			const rawSeasons = (detail.seasons ?? []).filter((s) => s.season_number !== 0);
			let offset = 0;
			const seasons: Season[] = rawSeasons.map((s) => {
				const season: Season = { name: s.name, episodes: s.episode_count, offset };
				offset += s.episode_count;
				return season;
			});
			const totalEpisodes = seasons.reduce((sum, s) => sum + s.episodes, 0) || (detail.number_of_episodes ?? 0);

			return {
				imdbId: String(detail.id),
				title: detail.name,
				mediaType: 'tv',
				episodes: totalEpisodes,
				episodeDuration: (detail.episode_run_time ?? [])[0] ?? 45,
				releaseDate: detail.first_air_date ?? '',
				url: imdbId ? `https://www.imdb.com/title/${imdbId}` : '',
				seasons,
			};
		} catch {
			return null;
		}
	}

	async getTmdbByImdbId(imdbId: string): Promise<MediaSearchResult | null> {
		if (!this.tmdbApiKey) return null;
		const url = `${TMDB_BASE}/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`;
		try {
			const data = (await this.fetchWithTimeout(url, this.tmdbHeaders())) as TmdbFindResult;
			if (data.movie_results && data.movie_results.length > 0) {
				return this.getTmdbMovieDetails(String(data.movie_results[0]!.id));
			}
			if (data.tv_results && data.tv_results.length > 0) {
				return this.getTmdbTvDetails(String(data.tv_results[0]!.id));
			}
			return null;
		} catch {
			return null;
		}
	}

	// ─── Community ratings ───────────────────────────────────────────────────────

	private parseOmdbVotes(s: string | undefined): number {
		if (!s || s === 'N/A') return 0;
		const n = parseInt(s.replace(/,/g, ''), 10);
		return isNaN(n) ? 0 : n;
	}

	private parseOmdbRating(s: string | undefined): number {
		if (!s || s === 'N/A') return 0;
		const n = parseFloat(s);
		return isNaN(n) ? 0 : n;
	}

	private extractImdbId(externalLink: string): string {
		const m = externalLink.match(/tt\d+/);
		return m ? m[0] : '';
	}

	private async fetchMalRating(malId: number): Promise<{ rating: number; votes: number } | null> {
		try {
			const url = `${JIKAN_BASE}/anime/${malId}`;
			const data = (await this.fetchWithTimeout(url)) as {
				data?: { score?: number | null; scored_by?: number | null };
			};
			const rating = data.data?.score ?? 0;
			const votes = data.data?.scored_by ?? 0;
			if (!rating && !votes) return null;
			return { rating, votes };
		} catch {
			return null;
		}
	}

	private async fetchAniListRating(
		anilistId: number,
	): Promise<{ rating: number; votes: number } | null> {
		const media = await this.getAniListById(anilistId);
		if (!media) return null;
		const rating = media.averageScore ?? 0;
		const votes = media.popularity ?? 0;
		if (!rating && !votes) return null;
		return { rating, votes };
	}

	private async fetchOmdbRating(imdbId: string): Promise<{ rating: number; votes: number } | null> {
		if (!this.omdbApiKey) return null;
		try {
			const url = `${OMDB_BASE}/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(this.omdbApiKey)}`;
			const data = (await this.fetchWithTimeout(url)) as {
				Response?: string;
				imdbRating?: string;
				imdbVotes?: string;
			};
			if (data.Response === 'False') return null;
			const rating = this.parseOmdbRating(data.imdbRating);
			const votes = this.parseOmdbVotes(data.imdbVotes);
			if (!rating && !votes) return null;
			return { rating, votes };
		} catch {
			return null;
		}
	}

	private async fetchTmdbRatingByImdb(
		imdbId: string,
	): Promise<{ rating: number; votes: number } | null> {
		if (!this.tmdbApiKey) return null;
		try {
			const url = `${TMDB_BASE}/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`;
			const data = (await this.fetchWithTimeout(url, this.tmdbHeaders())) as {
				movie_results?: Array<{ vote_average?: number; vote_count?: number }>;
				tv_results?: Array<{ vote_average?: number; vote_count?: number }>;
			};
			const hit =
				(data.movie_results && data.movie_results[0]) ||
				(data.tv_results && data.tv_results[0]) ||
				null;
			if (!hit) return null;
			const rating = hit.vote_average ?? 0;
			const votes = hit.vote_count ?? 0;
			if (!rating && !votes) return null;
			return { rating, votes };
		} catch {
			return null;
		}
	}

	/**
	 * Picks the right API based on the title's stored IDs and returns the
	 * community rating + vote count + source label. Returns null on failure
	 * or if no suitable API is available.
	 */
	async fetchCommunityRating(
		title: WatchLogTitle,
		animeApiSource: 'jikan' | 'anilist' = 'jikan',
		apiGroup: 'anime' | 'movie' | '' = '',
	): Promise<{ rating: number; votes: number; source: 'mal' | 'anilist' | 'imdb' | 'tmdb' } | null> {
		const hasMal = (title.malId ?? 0) > 0;
		const hasAniList = (title.anilistId ?? 0) > 0;
		const resolvedGroup: 'anime' | 'movie' | '' =
			apiGroup || (title.type === 'Anime' ? 'anime' : title.type === 'Movie' || title.type === 'TV Show' || title.type === 'TvShow' ? 'movie' : '');

		if (resolvedGroup === '') return null;

		// Anime API group is bound to anime APIs.
		if (resolvedGroup === 'anime') {
			if (animeApiSource === 'anilist') {
				if (hasAniList) {
					const r = await this.fetchAniListRating(title.anilistId!);
					if (r) return { ...r, source: 'anilist' };
				}
				if (hasMal) {
					const r = await this.fetchMalRating(title.malId!);
					if (r) return { ...r, source: 'mal' };
				}
			} else {
				if (hasMal) {
					const r = await this.fetchMalRating(title.malId!);
					if (r) return { ...r, source: 'mal' };
				}
				if (hasAniList) {
					const r = await this.fetchAniListRating(title.anilistId!);
					if (r) return { ...r, source: 'anilist' };
				}
			}
			// Last-resort: anime without any anime-api ID falls through to IMDb/TMDB.
		}

		const imdbId = this.extractImdbId(title.externalLink ?? '');
		if (imdbId) {
			if (this.omdbApiKey) {
				const r = await this.fetchOmdbRating(imdbId);
				if (r) return { ...r, source: 'imdb' };
			}
			if (this.tmdbApiKey) {
				const r = await this.fetchTmdbRatingByImdb(imdbId);
				if (r) return { ...r, source: 'tmdb' };
			}
		}

		return null;
	}

	// ─── Google Books (Books) ─────────────────────────────────────────────────────

	/**
	 * Picks the largest available cover from a volume's imageLinks, falling down the
	 * chain extraLarge → large → medium → small → thumbnail → smallThumbnail. Returns
	 * a direct (200) HTTPS image URL — upgraded from http and stripped of the page-curl
	 * effect — so no local caching is needed. Empty string when no image is present.
	 */
	private googleCoverUrl(info: GoogleVolumeInfo): string {
		const links = info.imageLinks;
		if (!links) return '';
		const raw =
			links.extraLarge ??
			links.large ??
			links.medium ??
			links.small ??
			links.thumbnail ??
			links.smallThumbnail ??
			'';
		if (!raw) return '';
		return raw.replace(/^http:/, 'https:').replace(/&edge=curl/g, '');
	}

	/** Normalizes Google's `publishedDate` (YYYY | YYYY-MM | YYYY-MM-DD) to a YYYY-MM-DD storage value. */
	private googleReleaseDate(published?: string): string {
		if (!published) return '';
		if (/^\d{4}-\d{2}-\d{2}$/.test(published)) return published;
		if (/^\d{4}-\d{2}$/.test(published)) return `${published}-01`;
		if (/^\d{4}$/.test(published)) return `${published}-01-01`;
		return published;
	}

	private mapGoogleVolume(item: GoogleVolume): BookSearchResult {
		const info = item.volumeInfo ?? {};
		const published = info.publishedDate ?? '';
		const year = published ? parseInt(published.slice(0, 4), 10) || 0 : 0;
		const fullTitle = info.subtitle ? `${info.title ?? ''}: ${info.subtitle}` : (info.title ?? '');
		return {
			title: fullTitle,
			author: (info.authors ?? []).join(', '),
			year,
			totalPages: info.pageCount ?? 0,
			coverUrl: this.googleCoverUrl(info),
			googleBooksId: item.id ?? '',
			releaseDate: this.googleReleaseDate(published),
			url: info.infoLink ?? info.canonicalVolumeLink ?? '',
		};
	}

	/**
	 * Google Books requests must always carry the user's API key — the anonymous
	 * endpoint shares a global quota and returns 429. Throws a typed GoogleBooksError
	 * (no-key / rate-limited / http / parse / network) so callers can show an accurate
	 * message instead of a generic "check your connection". `path` is everything after
	 * the base, e.g. `/volumes?q=...`; the `key` param is appended here.
	 */
	private async googleBooksFetch(path: string): Promise<unknown> {
		const key = this.googleBooksApiKey.trim();
		if (!key) {
			throw new GoogleBooksError('no-key', 'Google Books API key not set');
		}
		const sep = path.includes('?') ? '&' : '?';
		const url = `${GOOGLE_BOOKS_BASE}${path}${sep}key=${encodeURIComponent(key)}`;
		let timer: number | null = null;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = window.setTimeout(() => reject(new GoogleBooksError('network', 'Request timed out')), API_TIMEOUT_MS);
		});
		try {
			const reqPromise = requestUrl({ url, throw: false }).then((r) => {
				// 429 (rate limit) and 403 (quota/keyInvalid) both point at the key, not the network.
				if (r.status === 429 || r.status === 403) {
					throw new GoogleBooksError('rate-limited', `Google Books returned ${r.status}`, r.status);
				}
				if (r.status < 200 || r.status >= 300) {
					throw new GoogleBooksError('http', `Google Books returned ${r.status}`, r.status);
				}
				try {
					return r.json as unknown;
				} catch {
					throw new GoogleBooksError('parse', 'Failed to parse Google Books response');
				}
			});
			return await Promise.race([reqPromise, timeoutPromise]);
		} catch (err) {
			if (err instanceof GoogleBooksError) throw err;
			throw new GoogleBooksError('network', (err as Error)?.message ?? 'Network error');
		} finally {
			if (timer !== null) window.clearTimeout(timer);
		}
	}

	/** Throws GoogleBooksError on failure (no key, rate limit, etc.) — see googleBooksErrorMessage. */
	async searchGoogleBooks(query: string): Promise<BookSearchResult[]> {
		const data = (await this.googleBooksFetch(
			`/volumes?q=${encodeURIComponent(query)}&maxResults=10`,
		)) as GoogleBooksResponse;
		return (data.items ?? []).slice(0, 10).map((item) => this.mapGoogleVolume(item));
	}

	/** Resolves on success, throws GoogleBooksError on failure (so the test can report the real cause). */
	async checkGoogleBooksConnection(): Promise<boolean> {
		const data = (await this.googleBooksFetch('/volumes?q=tolkien&maxResults=1')) as GoogleBooksResponse;
		return Array.isArray(data.items);
	}

	// ─── Jikan (Manga) ──────────────────────────────────────────────────────────

	private mapJikanManga(m: JikanMangaItem): MangaSearchResult {
		const yearStr = m.published?.from ?? '';
		const year = yearStr ? parseInt(yearStr.slice(0, 4), 10) || 0 : 0;
		return {
			malId: m.mal_id,
			title: m.title_english ?? m.title,
			author: (m.authors ?? []).map((a) => a.name).join(', '),
			year,
			totalChapters: m.chapters ?? 0,
			totalVolumes: m.volumes ?? 0,
			coverUrl: m.images?.jpg?.image_url ?? '',
			releaseDate: m.published?.from ? (m.published.from.split('T')[0] ?? '') : '',
			url: m.url ?? `https://myanimelist.net/manga/${m.mal_id}`,
		};
	}

	async searchManga(query: string): Promise<MangaSearchResult[]> {
		const url = `${JIKAN_BASE}/manga?q=${encodeURIComponent(query)}&limit=10`;
		try {
			const data = (await this.throttleJikan(() => this.fetchWithTimeout(url))) as { data?: JikanMangaItem[] };
			return (data.data ?? []).map((m) => this.mapJikanManga(m));
		} catch {
			return [];
		}
	}

	/**
	 * Detail lookup for a single manga (Jikan /manga/{mal_id}). Search-list results
	 * return null chapters/volumes for ongoing titles, so totals are fetched here on
	 * selection. Shares the existing Jikan throttle. (Jikan also exposes a richer
	 * `/manga/{id}/full` endpoint not used here.)
	 */
	async getMangaByMalId(malId: number): Promise<MangaSearchResult | null> {
		const url = `${JIKAN_BASE}/manga/${malId}`;
		try {
			const data = (await this.throttleJikan(() => this.fetchWithTimeout(url))) as { data?: JikanMangaItem };
			if (!data.data) return null;
			return this.mapJikanManga(data.data);
		} catch {
			return null;
		}
	}

	/**
	 * Detail lookup for a single Google Books volume. The search endpoint sometimes
	 * omits pageCount and only returns thumbnail-sized images, so on selection this
	 * resolves the full volume (better page count + larger cover). Returns null when
	 * the volume can't be fetched.
	 */
	async getGoogleBookById(volumeId: string): Promise<BookSearchResult | null> {
		if (!volumeId) return null;
		const item = (await this.googleBooksFetch(`/volumes/${encodeURIComponent(volumeId)}`)) as GoogleVolume;
		if (!item || !item.id) return null;
		return this.mapGoogleVolume(item);
	}

	async checkTmdbConnection(): Promise<boolean> {
		if (!this.tmdbApiKey) return false;
		try {
			const url = `${TMDB_BASE}/movie/550`;
			const data = (await this.fetchWithTimeout(url, this.tmdbHeaders())) as { id?: number };
			return data.id !== undefined;
		} catch {
			return false;
		}
	}

	async checkOmdbConnection(): Promise<boolean> {
		if (!this.omdbApiKey) return false;
		try {
			// Use a known IMDb ID (The Shawshank Redemption) as a connectivity test
			const url = `${OMDB_BASE}/?i=tt0111161&apikey=${encodeURIComponent(this.omdbApiKey)}`;
			const data = (await this.fetchWithTimeout(url)) as OmdbDetailResponse;
			return data.Response === 'True';
		} catch {
			return false;
		}
	}
}
