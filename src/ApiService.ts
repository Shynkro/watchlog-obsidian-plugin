import { requestUrl } from 'obsidian';
import type {
	AnimeSearchResult,
	MediaSearchResult,
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
} from './types';

const JIKAN_BASE = 'https://api.jikan.moe/v4';
const OMDB_BASE = 'https://www.omdbapi.com';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const API_TIMEOUT_MS = 8000;

export class ApiService {
	private omdbApiKey: string;
	private tmdbApiKey: string;

	constructor(omdbApiKey: string, tmdbApiKey = '') {
		this.omdbApiKey = omdbApiKey;
		this.tmdbApiKey = tmdbApiKey;
	}

	setOmdbKey(key: string): void {
		this.omdbApiKey = key;
	}

	setTmdbKey(key: string): void {
		this.tmdbApiKey = key;
	}

	private tmdbHeaders(): Record<string, string> {
		return { 'Authorization': `Bearer ${this.tmdbApiKey}` };
	}

	private async fetchWithTimeout(url: string, headers?: Record<string, string>): Promise<unknown> {
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error('Request timed out')), API_TIMEOUT_MS),
		);
		const fetchPromise = requestUrl({ url, headers }).then((r) => r.json as unknown);
		return Promise.race([fetchPromise, timeoutPromise]);
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
