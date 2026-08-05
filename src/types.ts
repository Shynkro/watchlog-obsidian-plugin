import type { HistoryEntry } from './HistoryManager';

export interface Season {
	name: string;
	episodes: number;
	offset: number;
	/** episodes excluded from progress (filler, recaps) */
	skippedEpisodes?: number[];
}

export interface WatchLogTitle {
	id: string;
	title: string;
	type: string;
	status: string;
	priority: string;
	review: string;
	rating: number;
	notes: string;
	dateStarted: string | null;
	dateFinished: string | null;
	dateAdded: string;
	dateModified: string;
	totalEpisodes: number;
	episodeDuration: number;
	releaseDate: string | null;
	externalLink: string;
	seasons: Season[];
	watchedEpisodes: number[];
	malId?: number;
	anilistId?: number;
	/** cached once resolved; which endpoint it belongs to is tmdbMediaType */
	tmdbId?: number;
	/** what tmdbId indexes. Collections require 'movie' — a tv id there would query a random film. */
	tmdbMediaType?: 'movie' | 'tv';
	/** absent = unchecked, COLLECTION_NONE = checked and there is none, else the id */
	collectionId?: number;
	communityRating?: number;
	communityVotes?: number;
	communitySource?: '' | 'imdb' | 'mal' | 'anilist' | 'tmdb';
	communityRatingLastFetched?: string;
	pinned?: boolean;
	/** backfilled to false for titles predating the field */
	favorite?: boolean;
	/** ISO stamp of the last favorite toggle-on; absent on pre-field favorites */
	dateFavorited?: string;
	/** '' = unfetched, 'none' = nothing found, else a URL */
	posterUrl?: string;
	/** override — wins over posterUrl when non-empty */
	manualPosterUrl?: string;
	/** '' = unfetched, 'none' = source has no trailer (e.g. OMDb), else a YouTube URL */
	trailerUrl?: string;
	/** override — wins over trailerUrl when non-empty */
	manualTrailerUrl?: string;
	/** absent/empty = unfetched, ['none'] = fetch failed */
	director?: string[];
	/** capped at MAX_FETCHED_CREDITS; absent/empty = unfetched, ['none'] = fetch failed */
	cast?: string[];
	/** user-added, appended after the fetched ones; a refresh never overwrites */
	manualDirector?: string[];
	/** user-added, appended after the fetched ones; a refresh never overwrites */
	manualCast?: string[];
	/** studio / network / brand. absent = unfetched, ['none'] = source has none */
	studio?: string[];
	/** user-added, appended after the fetched ones; a refresh never overwrites */
	manualStudio?: string[];
}

// TMDB collections

export const COLLECTION_NONE = 0;

/** already checked, nothing there — never re-query */
export function isCollectionNone(title: WatchLogTitle): boolean {
	return title.collectionId === COLLECTION_NONE;
}

export function getCollectionId(title: WatchLogTitle): number | null {
	const id = title.collectionId;
	return id !== undefined && id !== COLLECTION_NONE ? id : null;
}

/** `tt…` out of a stored externalLink; both OMDb and TMDB adds write an imdb.com URL */
export function imdbIdFromLink(link: string | undefined): string {
	if (!link) return '';
	return link.match(/\/(tt\d+)/)?.[1] ?? '';
}

// Credits (director / cast)

/**
 * Cap on names stored from an API response. OMDb returns 4 actors; TMDB returns
 * the full cast (100+ on a big film). Fetched data only — user-added is uncapped.
 */
export const MAX_FETCHED_CREDITS = 10;

/** names shown inline before the rest collapse behind "+N more" */
export const CREDITS_INLINE_LIMIT = 4;

/** fetch failed or returned nothing (posterUrl's 'none' pattern) */
export const CREDITS_NONE = 'none';

/** fetched but empty — never re-fetch */
export function isCreditsNone(names: string[] | undefined): boolean {
	return names?.length === 1 && names[0] === CREDITS_NONE;
}

/** never fetched (absent or empty) */
export function isCreditsUnfetched(names: string[] | undefined): boolean {
	return !names || names.length === 0;
}

/** either credits field still needs its one-time fetch */
export function needsCreditsFetch(title: WatchLogTitle): boolean {
	return isCreditsUnfetched(title.director) || isCreditsUnfetched(title.cast);
}

/** studio still needs its one-time fetch (separate — anime has studios but no credits) */
export function needsStudioFetch(title: WatchLogTitle): boolean {
	return isCreditsUnfetched(title.studio);
}

/** fetched names only — unfetched and 'none' both give [] */
export function getDisplayCredits(names: string[] | undefined): string[] {
	if (!names || isCreditsNone(names)) return [];
	return names;
}

/** which credits field a helper is operating on */
export type CreditsField = 'director' | 'cast' | 'studio';

/** names shown inline on the studio line before the rest collapse behind "+N more" */
export const STUDIO_INLINE_LIMIT = 3;

/** fetched names for a field, before the manual merge */
function fetchedCredits(title: WatchLogTitle, field: CreditsField): string[] | undefined {
	if (field === 'director') return title.director;
	if (field === 'cast') return title.cast;
	return title.studio;
}

/** user-added names; never carries the 'none' sentinel */
export function getManualCredits(title: WatchLogTitle, field: CreditsField): string[] {
	if (field === 'director') return title.manualDirector ?? [];
	if (field === 'cast') return title.manualCast ?? [];
	return title.manualStudio ?? [];
}

/**
 * What every surface renders, searches and exports: fetched first, user-added
 * after, deduped case-insensitively.
 */
export function getTitleCredits(title: WatchLogTitle, field: CreditsField): string[] {
	const fetched = getDisplayCredits(fetchedCredits(title, field));
	const merged = [...fetched];
	const seen = new Set(fetched.map((n) => n.toLowerCase()));
	for (const name of getManualCredits(title, field)) {
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(name);
	}
	return merged;
}

/**
 * Drops manual entries a fetch has since returned, so a refresh folds them in
 * instead of leaving a duplicate in data.json.
 */
export function pruneManualCredits(manual: string[], fetched: string[]): string[] {
	const seen = new Set(getDisplayCredits(fetched).map((n) => n.toLowerCase()));
	return manual.filter((n) => !seen.has(n.toLowerCase()));
}

/** trims + de-dupes user-typed names; uncapped, unlike fetched credits */
export function normalizeManualCredits(names: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of names) {
		const name = raw.trim();
		if (name === '' || name === CREDITS_NONE) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(name);
	}
	return out;
}

/** normalize a fetched list for storage: cap it, empty → the 'none' sentinel */
export function normalizeCreditsForStore(names: string[]): string[] {
	const cleaned = names.map((n) => n.trim()).filter((n) => n !== '' && n !== 'N/A');
	return cleaned.length > 0 ? cleaned.slice(0, MAX_FETCHED_CREDITS) : [CREDITS_NONE];
}

export interface WatchLogGroup {
	id: string;
	name: string;
	titleIds: string[];
	dateAdded: string;
}

export interface TagDefinition {
	name: string;
	color: string;
}

/**
 * One tier of the 5-level rating system. Index 0 = 1★ … 4 = 5★; a whole star shares
 * its tier with the half-step below (0.5 & 1 = tier 1 …). Rating 0 = unrated.
 */
export interface RatingTier {
	label: string;
	color: string;
}

// Custom Lists types

export interface CustomListColumn {
	id: string;
	label: string;
	type: 'text' | 'number' | 'select';
	locked?: boolean;
	options?: string[];   // only for type: 'select'
	optionColors?: Record<string, string>; // option value → hex; only for type: 'select'
	bold?: boolean;       // only for type: 'text' | 'number'
	italic?: boolean;     // only for type: 'text' | 'number'
	autoTime?: boolean;   // only for type: 'number' — auto-populate with remaining watch time
	/** rendered width in px; absent = default flex width. dropped with the column */
	width?: number;
}

export interface CustomListRow {
	id: string;
	checked?: boolean;
	[key: string]: string | number | boolean | undefined;
}

// Maybe types

export interface MaybeTitle {
	id: string;
	title: string;
	type: string;
	releaseDate: string | null;
	externalLink: string;
	totalEpisodes: number;
	episodeDuration: number;
	dateAdded: string;
}

export interface CustomList {
	name: string;
	columns: CustomListColumn[];
	rows: CustomListRow[];
	notes: string;
	tabColor?: string; // hex; colours this list's tab name. Unset = default.
	/** width in px for the built-in Name column; absent = default flex width */
	nameWidth?: number;
}

// Drafts types

export interface DraftPersistState {
	dismissed: string[];                   // lowercased title keys
	added: string[];                       // lowercased title keys
	firstSeen: Record<string, string>;     // lowercase key → ISO timestamp
	titleDisplay: Record<string, string>;  // lowercase key → original-case display title
}

/** one horizontal shelf in the Rows layout */
export interface RowsShelfLayoutEntry {
	id: string;
	enabled: boolean;
}

/**
 * The Rows-view sections in default order. All shelves except `byType` / `byStatus`,
 * the virtualised grids — those reorder and toggle like any shelf.
 */
export const ROWS_SHELVES: ReadonlyArray<{ id: string; label: string }> = [
	{ id: 'favorites', label: 'Favorites' },
	{ id: 'recommended', label: 'Recommended' },
	{ id: 'recentlyAdded', label: 'Recently Added' },
	{ id: 'recentlyWatched', label: 'Recently Watched' },
	{ id: 'groups', label: 'Groups' },
	{ id: 'recentlyReleased', label: 'Recently Released' },
	{ id: 'byType', label: 'By type' },
	{ id: 'byStatus', label: 'By status' },
];

/**
 * Shelf ids that can never both be on — byType and byStatus group the same library,
 * so both would show every title twice. Enforced in normalizeRowsLayout and in
 * RowsCustomizeModal. All members off ⇒ one flat ungrouped grid.
 */
export const ROWS_EXCLUSIVE_SHELVES: ReadonlyArray<ReadonlyArray<string>> = [
	['byType', 'byStatus'],
];

/**
 * Favorites-shelf order: newest favorite first. Sorts in place, stable — items with no
 * stamp (favorited before the field existed) sink to the end keeping their incoming order.
 */
export function sortByFavorited<T extends { dateFavorited?: string }>(items: T[]): T[] {
	return items.sort((a, b) => {
		const av = a.dateFavorited ?? '';
		const bv = b.dateFavorited ?? '';
		if (av === bv) return 0;
		if (!av) return 1;
		if (!bv) return -1;
		return bv.localeCompare(av);
	});
}

/** Games Rows sections (the Watchlist registry with Games naming — "genre", "played"). */
export const GAMES_ROWS_SHELVES: ReadonlyArray<{ id: string; label: string }> = [
	{ id: 'favorites', label: 'Favorites' },
	{ id: 'recommended', label: 'Recommended' },
	{ id: 'recentlyAdded', label: 'Recently Added' },
	{ id: 'recentlyPlayed', label: 'Recently Played' },
	{ id: 'groups', label: 'Groups' },
	{ id: 'recentlyReleased', label: 'Recently Released' },
	{ id: 'byType', label: 'By genre' },
	{ id: 'byStatus', label: 'By status' },
];

/**
 * Reading Rows sections. No groups and no type registry, so "By status" is the only
 * grouped grid; with it off the flat fallback shows.
 */
export const READING_ROWS_SHELVES: ReadonlyArray<{ id: string; label: string }> = [
	{ id: 'favorites', label: 'Favorites' },
	{ id: 'recentlyAdded', label: 'Recently Added' },
	{ id: 'recentlyRead', label: 'Recently Read' },
	{ id: 'recentlyReleased', label: 'Recently Released' },
	{ id: 'byStatus', label: 'By status' },
];

/**
 * A valid rows layout from whatever was stored: unknown/duplicate ids dropped, known
 * shelves missing from the layout appended enabled. Always returns new objects.
 * `shelves` is the registry to validate against; `exclusiveGroups` lists ids that
 * can't both be on (first enabled in layout order wins).
 */
export function normalizeRowsLayout(
	stored: RowsShelfLayoutEntry[] | undefined,
	shelves: ReadonlyArray<{ id: string; label: string }> = ROWS_SHELVES,
	exclusiveGroups: ReadonlyArray<ReadonlyArray<string>> = ROWS_EXCLUSIVE_SHELVES,
): RowsShelfLayoutEntry[] {
	const known = new Set(shelves.map((s) => s.id));
	const out: RowsShelfLayoutEntry[] = [];
	const seen = new Set<string>();
	for (const entry of stored ?? []) {
		if (!known.has(entry.id) || seen.has(entry.id)) continue;
		seen.add(entry.id);
		out.push({ id: entry.id, enabled: entry.enabled !== false });
	}
	for (const shelf of shelves) {
		if (seen.has(shelf.id)) continue;
		// a newly introduced alternative to a stored shelf (byStatus next to byType) appends
		// DISABLED, so an update never pops a second grouping on by itself
		const hasStoredSibling = exclusiveGroups.some(
			(g) => g.includes(shelf.id) && out.some((e) => e.id !== shelf.id && g.includes(e.id)),
		);
		out.push({ id: shelf.id, enabled: !hasStoredSibling });
	}
	// self-heal: at most one enabled entry per group, so a hand-edited data.json can't show both
	for (const group of exclusiveGroups) {
		let found = false;
		for (const entry of out) {
			if (!group.includes(entry.id) || !entry.enabled) continue;
			if (found) entry.enabled = false;
			found = true;
		}
	}
	return out;
}

/** Card text placement: below the poster or overlaid at its bottom. */
export type CardTextStyle = 'under' | 'inside';

/** The four tabs whose poster cards honour a per-tab text placement. */
export type CardStyleTab = 'watchlist' | 'games' | 'reading' | 'upcoming';

export interface WatchLogPluginSettings {
	colorTheme: 'default' | 'nightfall' | 'bluez';
	/**
	 * How dates are displayed and parsed. Storage is unaffected — date-only fields stay
	 * `YYYY-MM-DD` and dateAdded/dateModified stay ISO timestamps.
	 */
	dateFormat: DateFormatPref;
	// last-used Watchlist view, written on every switch (the Upcoming pattern);
	// the old 'cards' value migrates to 'rows' in loadSettings
	defaultWatchlistView: 'list' | 'rows';
	autoCompleteOnLastEpisode: boolean;
	setFinishDateAutomatically: boolean;
	omdbApiKey: string;
	tmdbApiKey: string;
	googleBooksApiKey: string;
	activeApi: 'OMDb' | 'TMDB';
	animeApiSource: 'jikan' | 'anilist';
	/** Which API new games are searched on (existing games keep their data). */
	gamesApiSource: 'rawg' | 'igdb';
	rawgApiKey: string;
	/** IGDB authenticates through Twitch — a registered app's Client ID + Secret. */
	igdbClientId: string;
	igdbClientSecret: string;
	/**
	 * Steam is a sync layer, not a search source (no search endpoint) — it fills
	 * playtime/achievements, so it needs a Web API key plus the SteamID64 to read.
	 */
	steamApiKey: string;
	steamId: string;
	typeApiMapping: Record<string, 'anime' | 'movie' | ''>;
	types: TagDefinition[];
	statuses: TagDefinition[];
	reviews: TagDefinition[];
	priorities: TagDefinition[];
	rootFolder: string;
	autoCreateFolders: boolean;
	coloredTypeBadges: boolean;
	watchlistTypeSubTabs: boolean;
	openNoteOnClick: boolean;
	/** Open the panel on the Watchlist tab after the Add title command adds something. */
	openWatchlistAfterAdd: boolean;
	seasonPalette: string[];
	dashboardCardStyle: 'circles' | 'rectangles';
	/**
	 * Card size step for every grid and shelf: −3..+3, 0 = default (160px minimum width,
	 * see CARD_SIZE_WIDTHS). Desktop and mobile are independent.
	 */
	cardSize: number;
	cardSizeMobile: number;
	/**
	 * Per-tab card text placement: 'under' = block below the poster (Reading/Upcoming
	 * style), 'inside' = overlaid at its bottom (Watchlist style). Status badges stay
	 * inside either way.
	 */
	cardTextStyles: Record<CardStyleTab, CardTextStyle>;
	/** Allow 0.5-step star ratings (Watchlist and Reading alike). */
	halfStarRatings: boolean;
	/**
	 * Five-tier rating system (colour + label for 1★…5★), shared by every star control.
	 * Always five entries; index 0 = 1★.
	 */
	ratingSystem: RatingTier[];
	episodeNumbering: 'absolute' | 'per-season';
	/**
	 * Type preselected in the Add modal: a real `types[].name`, or LAST_USED_TYPE_SENTINEL
	 * to follow the last added type.
	 */
	defaultAddType: string;
	/** Type slug of the most recently added title. Updated silently on every add. */
	lastAddedType: string;
	/** How many entries the Dashboard "Top Directors" / "Top Actors" lists show. */
	dashboardTopCredits: number;
	/** Colors for the Reading type badges (Manga / Book). */
	readingTypeColors: { manga: string; book: string };
	customListsFolder: string;
	defaultCustomColumns: CustomListColumn[];
	listFilters: {
		typeExclude: string[];
		statusExclude: string[];
		groupExclude: string[];
		ratingExclude: string[];
		priorityExclude: string[];
		sort: string;
		sortDir?: 'asc' | 'desc';
		secondSort?: string;
		secondSortDir?: 'asc' | 'desc';
		ratingEmptyOnly?: boolean;
		/** legacy — read once by migratePriorityExclude, never written */
		priorityEmptyOnly?: boolean;
		recentlyArrivedOnly?: boolean;
		groupsOnly?: boolean;
		favoritesOnly?: boolean;
	};
	/** Games tab filter/sort state (the listFilters pattern — persisted live). */
	gamesFilters: {
		genreExclude: string[];
		statusExclude: string[];
		ratingExclude: string[];
		priorityExclude: string[];
		platformExclude: string[];
		groupExclude: string[];
		sort: string;
		sortDir?: 'asc' | 'desc';
		secondSort?: string;
		secondSortDir?: 'asc' | 'desc';
		ratingEmptyOnly?: boolean;
		/** legacy — read once by migratePriorityExclude, never written */
		priorityEmptyOnly?: boolean;
		recentlyArrivedOnly?: boolean;
		favoritesOnly?: boolean;
		wishlistOnly?: boolean;
		groupsOnly?: boolean;
	};
	draftsVaultTag: string;
	draftsAfterAdding: 'remove' | 'keep';
	customListTabOrder: string[];
	showHintBanners: boolean;
	showUpcomingStatusBar: boolean;
	/** Upcoming → Tracker presentation. Persisted from the view toggle. */
	upcomingTrackerView: 'list' | 'cards';
	/** Rows-view shelf order + visibility (see ROWS_SHELVES). */
	rowsLayout: RowsShelfLayoutEntry[];
}

// Reading types

export type ReadingStatus = 'Reading' | 'Completed' | 'Plan to Read' | 'To be released' | 'Dropped';

export const READING_STATUSES: ReadingStatus[] = [
	'Reading',
	'Completed',
	'Plan to Read',
	'To be released',
	'Dropped',
];

/**
 * Statuses pickable by hand. "To be released" is auto-managed from the release date
 * (mirroring the watchlist), so it is excluded from every dropdown.
 */
export const SELECTABLE_READING_STATUSES: ReadingStatus[] = READING_STATUSES.filter(
	(s) => s !== 'To be released',
);

/**
 * Books track pages or words — some readers only know a word count. The unit is
 * per-book and both counter pairs are stored side by side, so switching never
 * destroys the other unit's numbers. Manga has no words analog.
 */
export type BookProgressUnit = 'pages' | 'words';

/**
 * Words per page, used *only* to fold words-mode books into a pages aggregate (the
 * Dashboard Books ring). No stored value is ever converted.
 */
export const WORDS_PER_PAGE = 250;

export interface Book {
	id: string;
	title: string;
	author: string;
	status: ReadingStatus;
	favorite?: boolean;
	dateFavorited?: string;
	rating: number;
	progressUnit: BookProgressUnit;
	pagesRead: number;
	totalPages: number;
	wordsRead: number;
	totalWords: number;
	chaptersRead: number;
	totalChapters: number;
	coverUrl: string;
	googleBooksId: string;
	externalLink?: string;
	vaultPage: string;
	dateStarted: string | null;
	dateFinished: string | null;
	releaseDate: string | null;
	dateAdded: string;
	dateModified: string;
	customFields: Record<string, string | number>;
}

export interface Manga {
	id: string;
	title: string;
	author: string;
	status: ReadingStatus;
	favorite?: boolean;
	dateFavorited?: string;
	rating: number;
	chaptersRead: number;
	totalChapters: number;
	volumesRead: number;
	totalVolumes: number;
	coverUrl: string;
	malId: string;
	externalLink?: string;
	vaultPage: string;
	dateStarted: string | null;
	dateFinished: string | null;
	releaseDate: string | null;
	dateAdded: string;
	dateModified: string;
	customFields: Record<string, string | number>;
}

/** the book's unit, tolerating records written before the field existed */
export function bookProgressUnit(book: Book): BookProgressUnit {
	return book.progressUnit === 'words' ? 'words' : 'pages';
}

/**
 * The read/total pair the book's own unit tracks, plus its label. Every progress
 * readout goes through this, so the unit is honoured in one place.
 */
export function bookUnitProgress(book: Book): { read: number; total: number; label: string } {
	return bookProgressUnit(book) === 'words'
		? { read: book.wordsRead ?? 0, total: book.totalWords ?? 0, label: 'words' }
		: { read: book.pagesRead ?? 0, total: book.totalPages ?? 0, label: 'pages' };
}

/** Page-equivalent read/total, so words-mode books can join a pages aggregate. */
export function bookPageEquivalents(book: Book): { read: number; total: number } {
	if (bookProgressUnit(book) === 'words') {
		return {
			read: Math.round((book.wordsRead ?? 0) / WORDS_PER_PAGE),
			total: Math.round((book.totalWords ?? 0) / WORDS_PER_PAGE),
		};
	}
	return { read: book.pagesRead ?? 0, total: book.totalPages ?? 0 };
}

/**
 * Thousands-separated count — word totals run into six digits. Locale-independent
 * by design: the grouping character must not drift with the OS.
 */
export function formatCount(n: number): string {
	return String(Math.max(0, Math.round(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface ReadingCustomColumn {
	id: string;
	name: string;
	type: 'text' | 'number' | 'select';
	options: string[];
	color?: string; // 600-stop hex; defaults to FIELD_COLORS gray
}

export interface ReadingSavedFilterPreset {
	name: string;
	statusInclude: ReadingStatus[];
	ratingMode: 'all' | 'has' | 'none';
}

export interface ReadingSettings {
	defaultFolder: string;
	defaultStatus: ReadingStatus;
	defaultSubTab?: 'books' | 'manga';
	bookCustomFieldStyle?: 'fill' | 'border';
	mangaCustomFieldStyle?: 'fill' | 'border';
	// one saved filter per sub-tab (Books / Manga keep their own)
	savedFilters?: Partial<Record<'books' | 'manga', ReadingSavedFilterPreset>>;
	/** Reading Rows section order + visibility, shared by the Books and Manga sub-tabs. */
	rowsLayout?: RowsShelfLayoutEntry[];
	/**
	 * Colors for the five fixed reading statuses, keyed by status name. Missing keys
	 * fall back to DEFAULT_READING_STATUS_COLORS.
	 */
	statusColors?: Record<string, string>;
}

export interface FieldColorEntry {
	color600: string;
	color50: string;
}

export const FIELD_COLORS: FieldColorEntry[] = [
	{ color600: '#534AB7', color50: '#EEEDFE' },
	{ color600: '#1D9E75', color50: '#E1F5EE' },
	{ color600: '#EF9F27', color50: '#FAEEDA' },
	{ color600: '#378ADD', color50: '#E6F1FB' },
	{ color600: '#D85A30', color50: '#FAECE7' },
	{ color600: '#993556', color50: '#FBEAF0' },
	{ color600: '#639922', color50: '#EAF3DE' },
	{ color600: '#5F5E5A', color50: '#F1EFE8' },
];

export const DEFAULT_FIELD_COLOR = '#5F5E5A';

export interface ReadingData {
	books: Book[];
	manga: Manga[];
	bookColumns: ReadingCustomColumn[];
	mangaColumns: ReadingCustomColumn[];
	settings: ReadingSettings;
}

export const DEFAULT_READING_SETTINGS: ReadingSettings = {
	defaultFolder: 'WatchLog/Reading',
	defaultStatus: 'Plan to Read',
	bookCustomFieldStyle: 'fill',
	mangaCustomFieldStyle: 'fill',
};

// Games types

export interface Game {
	id: string;
	title: string;
	developer: string;
	publisher: string;
	/** Genre, one of GamesSettings.types. */
	type: string;
	/** One of GamesSettings.statuses. */
	status: string;
	/** '' | 'Low' | 'Medium' | 'High' — the watchlist priority set. */
	priority: string;
	favorite: boolean;
	/** ISO stamp of the last favorite toggle-on; absent on pre-field favorites */
	dateFavorited?: string;
	/**
	 * Wanted, not owned yet. A flag rather than a status, so a wishlisted game keeps a
	 * real status — it can be wishlisted *and* TBA.
	 */
	wishlist: boolean;
	/** 0–5 stars (0 = unrated). */
	rating: number;
	/** Completion percentage 0–100 — games track no episode/page counters. */
	progress: number;
	/** Total minutes played (0 = untracked); displayed via formatTime. */
	playtimeMinutes: number;
	/** Achievements earned out of the total — 0 total means untracked. */
	achievementsEarned: number;
	achievementsTotal: number;
	/** Selected platform names (subset of GamesSettings.platforms). */
	platforms: string[];
	/** Game modes — any combination may be true (the Solo/Co-op/Multi pill). */
	singleplayer: boolean;
	coop: boolean;
	multiplayer: boolean;
	coverUrl: string;
	/**
	 * Which games API resolved this entry ('' = manual or pre-field) and its id there,
	 * stored as a string. Lets a cover be re-fetched by id instead of by title.
	 */
	apiSource: '' | 'rawg' | 'igdb';
	apiId: string;
	/**
	 * Steam appid, as a string ('' when unlinked). Independent of apiSource — a RAWG
	 * game gets one the first time a sync matches it, making later syncs exact.
	 */
	steamAppId: string;
	/**
	 * Last-played from Steam (ISO), null when never played or never synced. Games have
	 * no session history, so this is all "Recently played" has besides dateModified.
	 */
	lastPlayed: string | null;
	/** Preferred store page (Steam → GOG → Epic priority when API-filled). */
	storeUrl: string;
	externalLink: string;
	vaultPage: string;
	releaseDate: string | null;
	dateStarted: string | null;
	dateFinished: string | null;
	dateAdded: string;
	dateModified: string;
}

export interface GamesSettings {
	defaultFolder: string;
	defaultStatus: string;
	/**
	 * User-configurable status list with colors (the watchlist TagDefinition pattern,
	 * unlike Reading's fixed union).
	 */
	statuses: TagDefinition[];
	/** User-configurable genre list with colors. */
	types: TagDefinition[];
	/**
	 * Platform toggles with colors (Settings → Customize → Games). `Game.platforms`
	 * stores platform *names*, so renaming one here does not rewrite the games that
	 * reference it (same as watchlist types).
	 */
	platforms: TagDefinition[];
	/** Games Rows shelf order + visibility (own shelf registry). */
	rowsLayout?: RowsShelfLayoutEntry[];
	/** The Games tab's single saved filter preset (the Watchlist pattern). */
	savedFilterPreset?: GamesSavedFilterPreset | null;
}

/** The Games saved filter preset — SavedFilterPreset plus a Platform section. */
export interface GamesSavedFilterPreset {
	genreExclude: string[];
	statusExclude: string[];
	ratingExclude: string[];
	priorityExclude: string[];
	platformExclude: string[];
	groupExclude: string[];
	ratingEmptyOnly?: boolean;
	/** legacy — read once by migratePriorityExclude, never written */
	priorityEmptyOnly?: boolean;
	recentlyArrivedOnly?: boolean;
	favoritesOnly?: boolean;
	wishlistOnly?: boolean;
	groupsOnly?: boolean;
}

/**
 * One game's Steam sync results, for GameDataManager.applySteamSync. `achievements`
 * is null when the game has none or syncing was off — either way the stored counts
 * are left untouched rather than zeroed.
 */
export interface SteamSyncUpdate {
	gameId: string;
	steamAppId: string;
	playtimeMinutes: number;
	lastPlayed: string | null;
	achievements: { earned: number; total: number } | null;
}

/** A named bundle of related games (the WatchLogGroup pattern). */
export interface GameGroup {
	id: string;
	name: string;
	gameIds: string[];
	dateAdded: string;
}

export interface GamesData {
	games: Game[];
	groups: GameGroup[];
	settings: GamesSettings;
	/** Daily "Recommended" shelf picks (the Watchlist RecommendedDaily pattern). */
	recommendedDaily?: RecommendedDaily;
}

/** auto status forced by a future release date; excluded from manual dropdowns */
export const GAME_AUTO_STATUS = 'To be released';

/**
 * status the games log treats as finished (drives the 'completed' action and the
 * automatic finish-date stamp)
 */
export const GAME_FINISHED_STATUS = 'Finished';

/**
 * manual "to be announced": coming, but no known date. Never auto-applied or
 * auto-cleared, unlike GAME_AUTO_STATUS. Replaced the old 'Wishlist' status, which
 * became the `wishlist` flag on Game.
 */
export const GAME_TBA_STATUS = 'TBA';

/**
 * Fresh default settings. A factory, not a const: a shared const spread shallowly
 * into stored settings would alias its arrays into data.json, where a later edit
 * would silently mutate the "defaults" too.
 */
export function defaultGamesSettings(): GamesSettings {
	return {
		defaultFolder: 'WatchLog/Games',
		defaultStatus: 'Not started',
		statuses: [
			{ name: 'Playing', color: '#3B82F6' },
			{ name: 'Not started', color: '#6B7280' },
			{ name: GAME_FINISHED_STATUS, color: '#22C55E' },
			{ name: 'Dropped', color: '#EF4444' },
			{ name: GAME_AUTO_STATUS, color: '#F59E0B' },
			{ name: GAME_TBA_STATUS, color: '#EAB308' },
		],
		types: [
			{ name: 'Adventure', color: '#8B5CF6' },
			{ name: 'RPG', color: '#3B82F6' },
			{ name: 'Shooter', color: '#EF4444' },
			{ name: 'Strategy', color: '#F59E0B' },
			{ name: 'Platformer', color: '#22C55E' },
			{ name: 'Racing', color: '#D85A30' },
			{ name: 'Simulation', color: '#1D9E75' },
			{ name: 'Sports', color: '#639922' },
			{ name: 'Puzzle', color: '#378ADD' },
			{ name: 'Fighting', color: '#993556' },
			{ name: 'Horror', color: '#5F5E5A' },
			{ name: 'Indie', color: '#D4537E' },
		],
		platforms: [
			{ name: 'Windows PC', color: '#378ADD' },
			{ name: 'PlayStation 5', color: '#1D4ED8' },
			{ name: 'Xbox Series X|S', color: '#22C55E' },
			{ name: 'Nintendo Switch 2', color: '#E24B4A' },
		],
	};
}

/** Fallback colors for the five fixed reading statuses (names are not editable). */
export const DEFAULT_READING_STATUS_COLORS: Record<ReadingStatus, string> = {
	'Reading': '#1D9E75',
	'Completed': '#7F77DD',
	'Plan to Read': '#E8873A',
	'To be released': '#3A86C8',
	'Dropped': '#E24B4A',
};

// Airtime types

export type AirtimeRecurrence = 'once' | 'daily' | 'weekly' | 'monthly';

export interface AirtimeSchedule {
	recurrence: AirtimeRecurrence;
	releaseDate?: string;   // YYYY-MM-DD, for 'once'
	releaseTime?: string;   // HH:MM, for any recurrence
	dayOfWeek?: number;     // 0=Sunday … 6=Saturday, for 'weekly'
	dayOfMonth?: number;    // 1–31, for 'monthly'
}

export interface AirtimeEntry {
	id: string;
	/** watchlist: a WatchLogTitle id; reading: a Book/Manga id; game: a Game id */
	titleId: string;
	/** absent or 'watchlist' = watch title, 'reading' = Book/Manga, 'game' = Game */
	source?: 'watchlist' | 'reading' | 'game';
	/** Only set when source === 'reading'. */
	readingKind?: 'book' | 'manga';
	schedule: AirtimeSchedule;
	/** watch: current season. reading reuses this slot for the current volume. */
	currentSeason?: number;
	/**
	 * watch: current episode. reading reuses this slot for the current chapter (this is
	 * what auto-increments).
	 */
	currentEpisode?: number;
	/**
	 * total episodes, for final-episode detection (synced from Watchlist). reading reuses
	 * it for total chapters; 0 or 1 marks a single release (movie/book).
	 */
	totalEpisodes?: number;
	/** total seasons (informational); reading reuses it for total volumes */
	totalSeasons?: number;
	/** YYYY-MM-DD: set when you tick an episode, so the countdown resets to the next one. */
	lastAcknowledgedDate?: string;
	dateAdded: string;
}

export interface SavedFilterPreset {
	typeExclude: string[];
	statusExclude: string[];
	groupExclude: string[];
	ratingExclude: string[];
	priorityExclude: string[];
	ratingEmptyOnly?: boolean;
	/** legacy — read once by migratePriorityExclude, never written */
	priorityEmptyOnly?: boolean;
	recentlyArrivedOnly?: boolean;
	groupsOnly?: boolean;
	favoritesOnly?: boolean;
}

/**
 * Daily random picks for the Rows "Recommended" shelf; re-rolled when the stored
 * date is no longer today.
 */
export interface RecommendedDaily {
	date: string;   // YYYY-MM-DD the picks were rolled on ('' = never rolled)
	ids: string[];  // chosen title ids
}

export interface WatchLogData {
	titles: WatchLogTitle[];
	groups: WatchLogGroup[];
	settings: Partial<WatchLogPluginSettings>;
	airtime?: AirtimeEntry[];
	maybe?: MaybeTitle[];
	pinnedGroupId?: string | null;
	drafts?: DraftPersistState;
	savedFilterPreset?: SavedFilterPreset | null;
	posterRetryDone?: boolean;
	recommendedDaily?: RecommendedDaily;
	// reading + activity log now live in data.json (Obsidian saveData), so Sync replicates
	// them alongside the watchlist. Migrated once from the legacy reading.json /
	// history.json; the flag below gates that one-time migration.
	reading?: ReadingData;
	history?: HistoryEntry[];
	migratedReadingHistory?: boolean;
	/** Games dataset — same in-data.json pattern as `reading`, minus the migration. */
	games?: GamesData;
}

// Airtime utility functions

export function getAirtimeScheduleString(schedule: AirtimeSchedule): string {
	const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
	const time = schedule.releaseTime ? ` · ${schedule.releaseTime}` : '';

	if (schedule.recurrence === 'once') {
		if (!schedule.releaseDate) return 'No date set';
		return `Release date · ${formatDateWithMonthName(schedule.releaseDate)}${time}`;
	}
	if (schedule.recurrence === 'daily') return `Every day${time}`;
	if (schedule.recurrence === 'weekly') {
		const dayName =
			schedule.dayOfWeek !== undefined ? (DAYS[schedule.dayOfWeek] ?? 'Unknown') : 'Unknown';
		return `Every ${dayName}${time}`;
	}
	if (schedule.recurrence === 'monthly') {
		return `Monthly on day ${schedule.dayOfMonth ?? '?'}${time}`;
	}
	return '—';
}

/**
 * Sentinel for `defaultAddType` meaning "use the last type added". No real type slug
 * can collide with it.
 */
export const LAST_USED_TYPE_SENTINEL = '__wl_last_used__';

export const DEFAULT_SETTINGS: WatchLogPluginSettings = {
	colorTheme: 'default',
	// 'european' keeps the DD/MM/YYYY rendering every existing install already sees.
	dateFormat: 'european',
	defaultWatchlistView: 'rows',
	autoCompleteOnLastEpisode: true,
	setFinishDateAutomatically: false,
	omdbApiKey: '',
	tmdbApiKey: '',
	googleBooksApiKey: '',
	activeApi: 'OMDb',
	animeApiSource: 'jikan',
	gamesApiSource: 'rawg',
	rawgApiKey: '',
	igdbClientId: '',
	igdbClientSecret: '',
	steamApiKey: '',
	steamId: '',
	typeApiMapping: {},
	types: [
		{ name: 'Anime', color: '#1D9E75' },
		{ name: 'Movie', color: '#378ADD' },
		{ name: 'TV Show', color: '#BA7517' },
		{ name: 'Korean TV Show', color: '#7F77DD' },
		{ name: 'Animation', color: '#D85A30' },
	],
	statuses: [
		{ name: 'Watching', color: '#1D9E75' },
		{ name: 'Plan to watch', color: '#00A9A5' },
		{ name: 'Completed', color: '#378ADD' },
		{ name: 'To be released', color: '#E8873A' },
		{ name: 'Dropped', color: '#E24B4A' },
	],
	reviews: [
		{ name: 'Nah', color: '#E24B4A' },
		{ name: 'Awesome', color: '#1D9E75' },
		{ name: 'Marvelous', color: '#7F77DD' },
	],
	priorities: [
		{ name: 'Low', color: '#888780' },
		{ name: 'Medium', color: '#3b82f6' },
		{ name: 'High', color: '#E24B4A' },
	],
	rootFolder: 'WatchLog',
	autoCreateFolders: true,
	coloredTypeBadges: true,
	watchlistTypeSubTabs: false,
	openNoteOnClick: false,
	openWatchlistAfterAdd: true,
	dashboardCardStyle: 'rectangles',
	cardSize: 0,
	cardSizeMobile: 0,
	cardTextStyles: { watchlist: 'under', games: 'under', reading: 'under', upcoming: 'under' },
	halfStarRatings: false,
	ratingSystem: [
		{ label: 'Poor',        color: '#E24B4A' },
		{ label: 'Fair',        color: '#E28C3C' },
		{ label: 'Good',        color: '#378ADD' },
		{ label: 'Great',       color: '#1D9E75' },
		{ label: 'Masterpiece', color: '#7F77DD' },
	],
	episodeNumbering: 'absolute',
	defaultAddType: LAST_USED_TYPE_SENTINEL,
	lastAddedType: '',
	dashboardTopCredits: 5,
	readingTypeColors: { manga: '#D4537E', book: '#D85A30' },
	customListsFolder: 'WatchLog/CustomLists',
	defaultCustomColumns: [],
	draftsVaultTag: '#watchlog',
	draftsAfterAdding: 'keep',
	customListTabOrder: [],
	showHintBanners: true,
	showUpcomingStatusBar: true,
	upcomingTrackerView: 'list',
	rowsLayout: ROWS_SHELVES.map((s) => ({ id: s.id, enabled: s.id !== 'byStatus' })),
	listFilters: {
		typeExclude: [],
		statusExclude: [],
		groupExclude: [],
		ratingExclude: [],
		priorityExclude: [],
		sort: 'dateAdded',
		sortDir: 'desc',
		secondSort: 'none',
		secondSortDir: 'asc',
	},
	gamesFilters: {
		genreExclude: [],
		statusExclude: [],
		ratingExclude: [],
		priorityExclude: [],
		platformExclude: [],
		groupExclude: [],
		sort: 'dateAdded',
		sortDir: 'desc',
		secondSort: 'none',
		secondSortDir: 'asc',
	},
	seasonPalette: [
		'#1D9E75',
		'#BA7517',
		'#378ADD',
		'#7F77DD',
		'#D85A30',
		'#D4537E',
		'#639922',
		'#888780',
	],
};

/**
 * Badge color for a type/status/priority. Themes never override these; the theme
 * parameter is accepted for API compatibility and intentionally unused.
 */
export function getThemedColor(name: string, defaultColor: string, theme: string): string {
	return defaultColor;
}

// Priority filtering. '' is a real, tickable filter option — not a gap.

/** Filter option value for "no priority set". */
export const NO_PRIORITY = '';

/** Filter label for NO_PRIORITY. */
export const NO_PRIORITY_LABEL = 'No priority';

/** Priority filter options: the configured names plus the empty one. */
export function priorityFilterOpts(priorities: TagDefinition[]): string[] {
	return [...priorities.map((p) => p.name), NO_PRIORITY];
}

/** Priority option label — '' reads as "No priority". */
export function formatPriorityOpt(opt: string): string {
	return opt === NO_PRIORITY ? NO_PRIORITY_LABEL : opt;
}

/**
 * Legacy `priorityEmptyOnly` → exclude set. The old exclusive toggle meant "empty only",
 * which is now the same as excluding every named priority.
 */
export function migratePriorityExclude(
	exclude: string[] | undefined,
	emptyOnly: boolean | undefined,
	priorities: TagDefinition[],
): Set<string> {
	if (emptyOnly) return new Set(priorities.map((p) => p.name));
	return new Set(exclude ?? []);
}

/** Badge color for a Reading type (Book / Manga), from settings.readingTypeColors. */
export function getReadingTypeColor(
	kind: 'book' | 'manga',
	settings: WatchLogPluginSettings,
): string {
	const colors = settings.readingTypeColors ?? DEFAULT_SETTINGS.readingTypeColors;
	return kind === 'manga' ? colors.manga : colors.book;
}

// Shared utility

// Date display / parsing. Storage is always ISO — date-only fields are `YYYY-MM-DD`,
// dateAdded/dateModified are ISO timestamps. Only rendering and typed input follow
// the `dateFormat` setting; every parse funnels back to `YYYY-MM-DD`.

/** the three orderings offered in Settings; storage is ISO regardless */
export type DateFormatPref = 'european' | 'american' | 'iso';

/** readable mask per format — placeholders and error hints */
const DATE_MASKS: Record<DateFormatPref, string> = {
	european: 'DD/MM/YYYY',
	american: 'MM/DD/YYYY',
	iso: 'YYYY-MM-DD',
};

/** separator each format writes (input accepts / - . in any case) */
const DATE_SEPARATORS: Record<DateFormatPref, string> = {
	european: '/',
	american: '/',
	iso: '-',
};

/**
 * Active display format, mirrored from `settings.dateFormat` by setActiveDateFormat
 * (on load and on every save).
 *
 * A module-level mirror rather than a parameter on ~30 call sites: pure helpers like
 * getAirtimeScheduleString and formatHistoryDate have no plugin instance. Every
 * function below still takes an explicit override for tests and one-off renders.
 */
let activeDateFormat: DateFormatPref = 'european';

export function setActiveDateFormat(fmt: DateFormatPref): void {
	activeDateFormat = fmt;
}

export function getActiveDateFormat(): DateFormatPref {
	return activeDateFormat;
}

/** The input mask for the active (or given) format, e.g. `DD/MM/YYYY`. */
export function dateFormatMask(fmt: DateFormatPref = activeDateFormat): string {
	return DATE_MASKS[fmt];
}

/** Error/tooltip text when typed input doesn't match the active format. */
export function dateFormatHint(fmt: DateFormatPref = activeDateFormat): string {
	return `Unrecognised format. Expected ${DATE_MASKS[fmt]}.`;
}

/**
 * A Date's *local* calendar day as `YYYY-MM-DD`. Always use this instead of
 * `date.toISOString().split('T')[0]`, which converts to UTC first and so returns the
 * wrong day for part of every local day.
 */
export function toIsoDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Today as `YYYY-MM-DD`, from the local calendar day. */
export function todayIso(): string {
	return toIsoDate(new Date());
}

/** Splits a stored `YYYY-MM-DD` into parts, or null when it isn't one. */
function isoParts(dateStr: string): { y: string; m: string; d: string } | null {
	const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	return m ? { y: m[1]!, m: m[2]!, d: m[3]! } : null;
}

/**
 * Renders a stored `YYYY-MM-DD` in the active format. Empty → ''; anything that
 * isn't a plain ISO date passes through untouched (old release dates predate
 * strict validation).
 */
export function formatDateDisplay(
	dateStr: string | null | undefined,
	fmt: DateFormatPref = activeDateFormat,
): string {
	if (!dateStr) return '';
	const p = isoParts(dateStr);
	if (!p) return dateStr;
	const sep = DATE_SEPARATORS[fmt];
	if (fmt === 'iso') return `${p.y}${sep}${p.m}${sep}${p.d}`;
	if (fmt === 'american') return `${p.m}${sep}${p.d}${sep}${p.y}`;
	return `${p.d}${sep}${p.m}${sep}${p.y}`;
}

/** Two-digit-year variant for the compact widgets (`25/07/26`, `07/25/26`, `26-07-25`). */
export function formatShortDateDisplay(
	dateStr: string | null | undefined,
	fmt: DateFormatPref = activeDateFormat,
): string {
	if (!dateStr) return '';
	const p = isoParts(dateStr.slice(0, 10));
	if (!p) return dateStr;
	const yy = p.y.slice(2);
	const sep = DATE_SEPARATORS[fmt];
	if (fmt === 'iso') return `${yy}${sep}${p.m}${sep}${p.d}`;
	if (fmt === 'american') return `${p.m}${sep}${p.d}${sep}${yy}`;
	return `${p.d}${sep}${p.m}${sep}${yy}`;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Month-name rendering for the Log day headers and the Upcoming schedule line, still
 * ordered by the setting: `25 Jul 2026` / `Jul 25, 2026` / `2026-07-25`.
 */
export function formatDateWithMonthName(
	dateStr: string | null | undefined,
	fmt: DateFormatPref = activeDateFormat,
): string {
	if (!dateStr) return '';
	const p = isoParts(dateStr.slice(0, 10));
	if (!p) return dateStr;
	if (fmt === 'iso') return `${p.y}-${p.m}-${p.d}`;
	const day = String(parseInt(p.d, 10));
	const mon = MONTH_ABBR[parseInt(p.m, 10) - 1] ?? '';
	if (fmt === 'american') return `${mon} ${day}, ${p.y}`;
	return `${day} ${mon} ${p.y}`;
}

/**
 * Parses typed input in the active format into `YYYY-MM-DD`, or null. Accepts / - .
 * and 1- or 2-digit day/month, but the *order* is fixed by the format, so
 * `03/04/2026` is never guessed at.
 */
export function parseDateInput(
	str: string,
	fmt: DateFormatPref = activeDateFormat,
): string | null {
	const trimmed = str.trim();
	if (!trimmed) return null;
	const parts = trimmed.split(/[/.-]/);
	if (parts.length !== 3) return null;
	let dd: string | undefined, mm: string | undefined, yyyy: string | undefined;
	if (fmt === 'iso') [yyyy, mm, dd] = parts;
	else if (fmt === 'american') [mm, dd, yyyy] = parts;
	else [dd, mm, yyyy] = parts;
	if (!dd || !mm || !yyyy || yyyy.length !== 4) return null;
	const d = parseInt(dd, 10), mo = parseInt(mm, 10), y = parseInt(yyyy, 10);
	if (isNaN(d) || isNaN(mo) || isNaN(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
	// reject impossible dates (Feb 31): the Date constructor rolls over, so verify the components
	const check = new Date(y, mo - 1, d);
	if (check.getFullYear() !== y || check.getMonth() !== mo - 1 || check.getDate() !== d) return null;
	return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

/**
 * Lenient parse for release-date fields: the active format *or* raw ISO, which is what
 * the APIs return and what older stored values look like. The 4-digit group's position
 * disambiguates them.
 */
export function parseReleaseDateInput(
	str: string,
	fmt: DateFormatPref = activeDateFormat,
): string | null {
	const trimmed = str.trim();
	if (!trimmed) return null;
	// year-first always reads as ISO, whatever the display setting is
	if (/^\d{4}[/.-]\d{1,2}[/.-]\d{1,2}$/.test(trimmed)) {
		return parseDateInput(trimmed, 'iso');
	}
	return parseDateInput(trimmed, fmt);
}

/**
 * True when a `YYYY-MM-DD` release date is strictly after today. Mirrors the auto
 * "To be released" check (see EditTitleModal).
 */
export function isReleaseDateFuture(releaseDate: string | null | undefined): boolean {
	if (!releaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return false;
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const releaseMs = new Date(releaseDate + 'T12:00:00').getTime();
	return releaseMs > today.getTime();
}

/**
 * The API group to use for a title type. The three built-in types are hardcoded and
 * never live in the mapping; anything else routes via `settings.typeApiMapping`,
 * where a missing entry returns '' (no API configured).
 */
export function getApiGroupForType(
	type: string,
	mapping: Record<string, 'anime' | 'movie' | ''> | undefined,
): 'anime' | 'movie' | '' {
	if (type === 'Anime') return 'anime';
	if (type === 'Movie' || type === 'TV Show' || type === 'TvShow') return 'movie';
	return mapping?.[type] ?? '';
}

/** Poster URL to render — a non-empty `manualPosterUrl` wins over `posterUrl`. */
export function getDisplayPoster(title: WatchLogTitle): string {
	if (title.manualPosterUrl && title.manualPosterUrl.trim() !== '') {
		return title.manualPosterUrl;
	}
	return title.posterUrl ?? '';
}

/**
 * Trailer URL to render — `manualTrailerUrl` wins; 'none' (no trailer) and ''
 * (unfetched) both resolve to ''.
 */
export function getDisplayTrailer(title: WatchLogTitle): string {
	if (title.manualTrailerUrl && title.manualTrailerUrl.trim() !== '') {
		return title.manualTrailerUrl;
	}
	return title.trailerUrl && title.trailerUrl !== 'none' ? title.trailerUrl : '';
}

export function formatVoteCount(votes: number): string {
	if (!votes || votes < 0) return '0';
	if (votes >= 1_000_000) return (votes / 1_000_000).toFixed(1) + 'M';
	if (votes >= 1_000) return (votes / 1_000).toFixed(1) + 'K';
	return votes.toString();
}

export function formatTime(minutes: number): string {
	if (minutes <= 0) return '0m';
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	// comma groups, like formatCount; a dot here reads back as a decimal
	const hStr = h >= 1000 ? String(h).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(h);
	if (h === 0) return `${m}m`;
	if (m === 0) return `${hStr}h`;
	return `${hStr}h ${m}m`;
}

/**
 * One number out of a playtime string. A separator followed by exactly three digits is
 * digit grouping ("3,000" / "3.000" = 3000); anything else is a decimal ("1.5" / "1,5").
 */
function parseTimeNumber(raw: string): number {
	const s = raw
		.replace(/\s/g, '')
		.replace(/[.,](?=\d{3}(?:[.,]|$))/g, '')
		.replace(',', '.');
	const n = Number(s);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Parses a freeform playtime into minutes: "42h 30m", "42h", "90m", "1.5h", "2:30",
 * or a bare number (read as hours — games are hour-scale). 0 = untracked.
 */
export function parsePlaytimeInput(text: string): number {
	const s = text.trim().toLowerCase();
	if (!s) return 0;

	const clock = s.match(/^(\d+):([0-5]?\d)$/);
	if (clock) return Number(clock[1]) * 60 + Number(clock[2]);

	// NUM matches grouped numbers too, so "3,000h" is not read as 3
	let minutes = 0;
	let matched = false;
	const hours = s.match(/(\d+(?:[.,]\d+)*)\s*h/);
	if (hours) {
		minutes += Math.round(parseTimeNumber(hours[1]!) * 60);
		matched = true;
	}
	const mins = s.match(/(\d+(?:[.,]\d+)*)\s*m/);
	if (mins) {
		minutes += Math.round(parseTimeNumber(mins[1]!));
		matched = true;
	} else if (hours) {
		// "12h30" — a unit-less tail after the hours reads as minutes
		const tail = s.match(/h\s*(\d+)\s*$/);
		if (tail) minutes += Number(tail[1]);
	}
	if (matched) return minutes;

	const bare = parseTimeNumber(s);
	return bare > 0 ? Math.round(bare * 60) : 0;
}

// API result types

export interface AnimeSearchResult {
	malId: number;
	anilistId?: number;
	title: string;
	episodes: number;
	duration: number;
	releaseDate: string;
	url: string;
	seasons: Season[];
	description?: string;
	averageScore?: number;
	genres?: string[];
	posterUrl?: string;
	/** '' = unresolved, 'none' = no trailer, else a YouTube watch URL */
	trailerUrl?: string;
}

// AniList API shapes

interface AniListTitle {
	romaji?: string | null;
	english?: string | null;
	native?: string | null;
}

interface AniListDate {
	year?: number | null;
	month?: number | null;
	day?: number | null;
}

interface AniListCoverImage {
	large?: string | null;
	medium?: string | null;
}

/** studios.edges — isMain marks the animation studio; the rest are producers */
export interface AniListStudioEdge {
	isMain?: boolean | null;
	node?: { name?: string | null } | null;
}

export interface AniListMedia {
	id: number;
	studios?: { edges?: AniListStudioEdge[] | null } | null;
	title?: AniListTitle | null;
	episodes?: number | null;
	duration?: number | null;
	status?: string | null;
	season?: string | null;
	seasonYear?: number | null;
	startDate?: AniListDate | null;
	averageScore?: number | null;
	popularity?: number | null;
	coverImage?: AniListCoverImage | null;
	description?: string | null;
	genres?: string[] | null;
	trailer?: { id?: string | null; site?: string | null } | null;
	nextAiringEpisode?: {
		airingAt?: number | null;
		episode?: number | null;
		timeUntilAiring?: number | null;
	} | null;
}

export interface AniListSearchResponse {
	data?: { Page?: { media?: AniListMedia[] } };
	errors?: Array<{ message: string }>;
}

export interface AniListMediaResponse {
	data?: { Media?: AniListMedia };
	errors?: Array<{ message: string }>;
}

export interface MediaSearchResult {
	imdbId: string;
	title: string;
	mediaType: 'movie' | 'tv';
	episodes: number;
	episodeDuration: number;
	releaseDate: string;
	url: string;
	seasons: Season[];
	posterUrl?: string;
	/** '' = unresolved, 'none' = no trailer, else a YouTube watch URL */
	trailerUrl?: string;
	/** detail lookups only: normalized name list or ['none'] (see CREDITS_NONE) */
	director?: string[];
	/** detail lookups only: normalized names (capped at MAX_FETCHED_CREDITS) or ['none'] */
	cast?: string[];
	/** detail lookups only: studio / network names or ['none'] */
	studio?: string[];
}

// Jikan API shapes

export interface JikanAnime {
	mal_id: number;
	/** animation studio(s); Jikan keeps producers and licensors in separate fields */
	studios?: Array<{ name?: string | null }> | null;
	title: string;
	title_english: string | null;
	episodes: number | null;
	duration: string | null;
	aired: { from: string | null } | null;
	url: string;
	images?: { jpg?: { image_url?: string | null; small_image_url?: string | null; large_image_url?: string | null } | null } | null;
	// Jikan often nulls youtube_id / url while embed_url still carries the id, so all
	// three are parsed defensively (see ApiService.extractYoutubeId)
	trailer?: { youtube_id?: string | null; url?: string | null; embed_url?: string | null } | null;
}

// OMDb API shapes

export interface OmdbSearchItem {
	Title: string;
	Year: string;
	imdbID: string;
	Type: string;
	/** Poster URL, or the literal 'N/A'. */
	Poster?: string;
}

export interface OmdbSearchResponse {
	Search?: OmdbSearchItem[];
	Response: string;
	Error?: string;
	/** Total hits across all pages, as a string. */
	totalResults?: string;
}

export interface OmdbDetailResponse {
	Title: string;
	Year: string;
	Released?: string;
	Runtime?: string;
	totalSeasons?: string;
	imdbID: string;
	Type: string;
	Response: string;
	Error?: string;
	imdbRating?: string;
	imdbVotes?: string;
	/** Comma-separated director name(s), or 'N/A'. */
	Director?: string;
	/** Comma-separated writer(s), or 'N/A'. For series this holds the creators. */
	Writer?: string;
	/** Comma-separated actors (OMDb returns at most 4), or 'N/A'. */
	Actors?: string;
}

export interface OmdbSeasonResponse {
	Season: string;
	Episodes?: Array<{ Episode: string; Title: string; imdbID: string }>;
	Response: string;
}

// TMDB API shapes

export interface TmdbSearchItem {
	id: number;
	title?: string;
	name?: string;
	release_date?: string;
	first_air_date?: string;
	poster_path?: string | null;
}

export interface TmdbSearchResponse {
	results?: TmdbSearchItem[];
	total_pages?: number;
}

export interface TmdbVideo {
	key: string;
	site: string;
	type: string;
	official?: boolean;
	name?: string;
}

export interface TmdbVideosResult {
	results?: TmdbVideo[];
}

export interface TmdbCreditsResult {
	cast?: Array<{ name?: string }>;
	crew?: Array<{ name?: string; job?: string }>;
}

export interface TmdbMovieDetail {
	id: number;
	title: string;
	runtime?: number;
	release_date?: string;
	imdb_id?: string;
	/** null for standalone films. Movies only — no TV equivalent. */
	belongs_to_collection?: TmdbCollectionRef | null;
	production_companies?: TmdbCompany[];
	/** only when the detail call uses append_to_response=videos */
	videos?: TmdbVideosResult;
	/** only when the detail call uses append_to_response=credits */
	credits?: TmdbCreditsResult;
}

export interface TmdbCompany {
	id: number;
	name?: string;
}

export interface TmdbCollectionRef {
	id: number;
	name: string;
	poster_path?: string | null;
}

/** no runtime here — adding still needs a detail call */
export interface TmdbCollectionPart {
	id: number;
	title?: string;
	release_date?: string;
	poster_path?: string | null;
	overview?: string;
}

export interface TmdbCollectionDetail {
	id: number;
	name: string;
	overview?: string;
	poster_path?: string | null;
	parts?: TmdbCollectionPart[];
}

interface TmdbTvSeason {
	season_number: number;
	name: string;
	episode_count: number;
}

export interface TmdbTvDetail {
	id: number;
	name: string;
	/** HBO / Netflix / AMC — the usable brand for a series, unlike production_companies */
	networks?: TmdbCompany[];
	production_companies?: TmdbCompany[];
	/** Series creators — TV has no single director, so these fill the director field. */
	created_by?: Array<{ name?: string }>;
	episode_run_time?: number[];
	first_air_date?: string;
	number_of_episodes?: number;
	seasons?: TmdbTvSeason[];
	/** only when the detail call uses append_to_response=videos */
	videos?: TmdbVideosResult;
	/** only when the detail call uses append_to_response=credits */
	credits?: TmdbCreditsResult;
}

export interface TmdbExternalIds {
	imdb_id?: string;
}

export interface TmdbFindResult {
	movie_results?: TmdbMovieDetail[];
	tv_results?: TmdbTvDetail[];
}
