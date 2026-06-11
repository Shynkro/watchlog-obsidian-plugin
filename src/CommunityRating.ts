import { Notice } from 'obsidian';
import type WatchLogPlugin from './main';
import type { WatchLogTitle, AnimeSearchResult } from './types';
import { formatVoteCount, getApiGroupForType } from './types';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const SOURCE_LABELS: Record<string, string> = {
	imdb: 'IMDb',
	mal: 'MAL',
	anilist: 'AniList',
	tmdb: 'TMDB',
};

function formatScore(rating: number, source: string): string {
	if (source === 'anilist') return `${Math.round(rating)}%`;
	return rating.toFixed(rating >= 10 ? 0 : 1);
}

export function renderCommunityRating(
	parent: HTMLElement,
	plugin: WatchLogPlugin,
	titleId: string,
	onUpdated?: () => void,
): void {
	const title = plugin.dataManager.getTitle(titleId);
	if (!title) return;

	parent.createSpan({ cls: 'wl-rating-divider' });

	const badge = parent.createDiv({ cls: 'wl-community-badge' });
	const hasRating = !!title.communitySource && (title.communityRating ?? 0) > 0;

	if (hasRating) {
		const source = title.communitySource ?? '';
		const label = SOURCE_LABELS[source] ?? source.toUpperCase();
		badge.createSpan({
			cls: `wl-community-source wl-community-source--${source}`,
			text: label,
		});
		badge.createSpan({
			cls: 'wl-community-score',
			text: formatScore(title.communityRating ?? 0, source),
		});
		if ((title.communityVotes ?? 0) > 0) {
			badge.createSpan({
				cls: 'wl-community-votes',
				text: `(${formatVoteCount(title.communityVotes ?? 0)})`,
			});
		}
	} else {
		badge.createSpan({ cls: 'wl-community-empty', text: 'No community rating' });
	}

	const refreshBtn = badge.createEl('button', {
		cls: 'wl-community-refresh',
		text: '⟳',
		attr: { title: 'Refresh community rating', type: 'button' },
	});
	refreshBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		void refreshCommunityRating(plugin, titleId, refreshBtn, true).then(() => {
			if (onUpdated) onUpdated();
		});
	});
}

/**
 * Auto-refresh: triggers a background fetch when data is stale (≥30 days)
 * or has never been fetched. For anime titles, only uses the API that
 * matches the current animeApiSource setting AND that has its ID already
 * present on the title — no search-by-name in the background. For non-anime
 * titles, uses the standard fetchCommunityRating routing.
 */
const pendingRatingRefreshes: Set<string> = new Set();

export function maybeAutoRefreshCommunityRating(
	plugin: WatchLogPlugin,
	titleId: string,
	onUpdated?: () => void,
): void {
	const title = plugin.dataManager.getTitle(titleId);
	if (!title) return;
	const last = title.communityRatingLastFetched ?? '';
	if (last) {
		const ts = Date.parse(last);
		if (!isNaN(ts) && Date.now() - ts < THIRTY_DAYS_MS) return;
	}
	if (!hasFetchableSource(title, plugin.settings.animeApiSource ?? 'jikan', plugin.settings.typeApiMapping)) return;
	if (pendingRatingRefreshes.has(titleId)) return;
	pendingRatingRefreshes.add(titleId);
	void backgroundRefresh(plugin, titleId)
		.then((ok) => {
			if (ok && onUpdated) onUpdated();
		})
		.finally(() => {
			pendingRatingRefreshes.delete(titleId);
		});
}

function hasFetchableSource(
	title: WatchLogTitle,
	animeApiSource: 'jikan' | 'anilist',
	mapping: Record<string, 'anime' | 'movie' | ''> | undefined,
): boolean {
	const group = getApiGroupForType(title.type, mapping);
	if (group === '') return false;
	if (group === 'anime') {
		if (animeApiSource === 'anilist') return (title.anilistId ?? 0) > 0;
		return (title.malId ?? 0) > 0;
	}
	return !!(title.externalLink ?? '').match(/tt\d+/);
}

async function backgroundRefresh(plugin: WatchLogPlugin, titleId: string): Promise<boolean> {
	const title = plugin.dataManager.getTitle(titleId);
	if (!title) return false;
	const animeSource = plugin.settings.animeApiSource ?? 'jikan';
	const group = getApiGroupForType(title.type, plugin.settings.typeApiMapping);
	const result = await plugin.apiService.fetchCommunityRating(title, animeSource, group);
	if (!result) return false;
	plugin.dataManager.updateCommunityRating(titleId, result.rating, result.votes, result.source);
	return true;
}

/**
 * Manual refresh:
 *  - For anime: respects current animeApiSource. If the title is missing
 *    the ID for that source, searches by name on that API; on a reasonable
 *    match, stores the new ID + updates externalLink to the new source.
 *  - For non-anime: standard fetchCommunityRating.
 * Saves changes via updateTitle (full save) when IDs/externalLink change;
 * otherwise the lighter updateCommunityRating path.
 */
export async function refreshCommunityRating(
	plugin: WatchLogPlugin,
	titleId: string,
	btnEl: HTMLElement | null,
	showNotice: boolean,
): Promise<boolean> {
	let title = plugin.dataManager.getTitle(titleId);
	if (!title) return false;
	if (btnEl) btnEl.addClass('is-loading');
	try {
		const animeSource = plugin.settings.animeApiSource ?? 'jikan';
		const group = getApiGroupForType(title.type, plugin.settings.typeApiMapping);

		if (group === '') {
			if (showNotice) {
				new Notice(`No API configured for type "${title.type}". Configure it in Settings → API.`);
			}
			return false;
		}

		if (group === 'anime') {
			const wantsAniList = animeSource === 'anilist';
			const hasPreferredId = wantsAniList
				? (title.anilistId ?? 0) > 0
				: (title.malId ?? 0) > 0;

			if (!hasPreferredId) {
				// Search by name on the preferred API.
				const matched = await searchForMatch(plugin, title, wantsAniList);
				if (!matched) {
					if (showNotice) {
						new Notice(`Could not find matching title on ${wantsAniList ? 'AniList' : 'MAL'}.`);
					}
					return false;
				}
				// Persist the new ID + externalLink before fetching the rating.
				const fresh = plugin.dataManager.getTitle(titleId);
				if (!fresh) return false;
				if (wantsAniList) {
					fresh.anilistId = matched.anilistId ?? 0;
					fresh.externalLink = `https://anilist.co/anime/${fresh.anilistId}`;
				} else {
					fresh.malId = matched.malId;
					fresh.externalLink = `https://myanimelist.net/anime/${fresh.malId}`;
				}
				await plugin.dataManager.updateTitle(fresh);
				title = fresh;
			} else {
				// We already have the right ID — still make sure externalLink
				// matches the preferred source so the UI link is consistent.
				const expectedLink = wantsAniList
					? `https://anilist.co/anime/${title.anilistId}`
					: `https://myanimelist.net/anime/${title.malId}`;
				if (title.externalLink !== expectedLink) {
					title.externalLink = expectedLink;
					await plugin.dataManager.updateTitle(title);
				}
			}
		}

		const result = await plugin.apiService.fetchCommunityRating(title, animeSource, group);
		if (!result) {
			if (showNotice) new Notice('Could not fetch community rating.');
			return false;
		}
		plugin.dataManager.updateCommunityRating(
			titleId,
			result.rating,
			result.votes,
			result.source,
		);
		if (showNotice) {
			const label = SOURCE_LABELS[result.source] ?? result.source;
			new Notice(`Rating updated from ${label}.`);
		}
		return true;
	} finally {
		if (btnEl) btnEl.removeClass('is-loading');
	}
}

function normalizeName(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isReasonableMatch(needle: string, hay: string): boolean {
	const a = normalizeName(needle);
	const b = normalizeName(hay);
	if (!a || !b) return false;
	if (a === b) return true;
	if (a.includes(b) || b.includes(a)) return true;
	const aWords = new Set(a.split(' ').filter((w) => w.length > 2));
	const bWords = new Set(b.split(' ').filter((w) => w.length > 2));
	if (aWords.size === 0 || bWords.size === 0) return false;
	let shared = 0;
	for (const w of aWords) if (bWords.has(w)) shared++;
	const minSize = Math.min(aWords.size, bWords.size);
	return shared / minSize >= 0.5;
}

async function searchForMatch(
	plugin: WatchLogPlugin,
	title: WatchLogTitle,
	wantsAniList: boolean,
): Promise<AnimeSearchResult | null> {
	const results = wantsAniList
		? await plugin.apiService.searchAniList(title.title)
		: await plugin.apiService.searchAnime(title.title);
	if (!results.length) return null;
	const top = results[0]!;
	if (isReasonableMatch(title.title, top.title)) return top;
	// Try a few more results in case the first isn't the best.
	for (let i = 1; i < Math.min(results.length, 5); i++) {
		if (isReasonableMatch(title.title, results[i]!.title)) return results[i]!;
	}
	return null;
}
