export interface Season {
	name: string;
	episodes: number;
	offset: number;
	/** Season-relative episode numbers that are excluded from progress (filler, recaps, etc.) */
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
	communityRating?: number;
	communityVotes?: number;
	communitySource?: '' | 'imdb' | 'mal' | 'anilist' | 'tmdb';
	communityRatingLastFetched?: string;
	pinned?: boolean;
	/** '' = unfetched, 'none' = API returned nothing, or a URL string */
	posterUrl?: string;
	/** User-supplied override — takes priority over posterUrl when non-empty. */
	manualPosterUrl?: string;
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

// ── Custom Lists types ────────────────────────────────────────────────────────

export interface CustomListColumn {
	id: string;
	label: string;
	type: 'text' | 'number' | 'select';
	locked?: boolean;
	options?: string[];   // only for type: 'select'
	bold?: boolean;       // only for type: 'text' | 'number'
	italic?: boolean;     // only for type: 'text' | 'number'
	autoTime?: boolean;   // only for type: 'number' — auto-populate with remaining watch time
}

export interface CustomListRow {
	id: string;
	checked?: boolean;
	[key: string]: string | number | boolean | undefined;
}

// ── Maybe types ─────────────────────────────────────────────────────────────

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
}

// ── Drafts types ─────────────────────────────────────────────────────────────

export interface DraftPersistState {
	dismissed: string[];                   // lowercased title keys
	added: string[];                       // lowercased title keys
	firstSeen: Record<string, string>;     // lowercase key → ISO timestamp
	titleDisplay: Record<string, string>;  // lowercase key → original-case display title
}

export interface WatchLogPluginSettings {
	colorTheme: 'default' | 'nightfall' | 'bluez';
	defaultWatchlistView: 'list' | 'cards';
	autoCompleteOnLastEpisode: boolean;
	setFinishDateAutomatically: boolean;
	omdbApiKey: string;
	tmdbApiKey: string;
	googleBooksApiKey: string;
	activeApi: 'OMDb' | 'TMDB';
	animeApiSource: 'jikan' | 'anilist';
	typeApiMapping: Record<string, 'anime' | 'movie' | ''>;
	types: TagDefinition[];
	statuses: TagDefinition[];
	reviews: TagDefinition[];
	priorities: TagDefinition[];
	rootFolder: string;
	autoCreateFolders: boolean;
	coloredTypeBadges: boolean;
	seasonPalette: string[];
	dashboardCardStyle: 'circles' | 'rectangles';
	episodeNumbering: 'absolute' | 'per-season';
	/** User-configurable colors for the Reading type badges (Manga / Book). */
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
		priorityEmptyOnly?: boolean;
		recentlyArrivedOnly?: boolean;
		groupsOnly?: boolean;
	};
	draftsVaultTag: string;
	draftsAfterAdding: 'remove' | 'keep';
	customListTabOrder: string[];
	showHintBanners: boolean;
	showUpcomingStatusBar: boolean;
}

// ── Reading types ─────────────────────────────────────────────────────────────

export type ReadingStatus = 'Reading' | 'Completed' | 'Plan to Read' | 'To be released' | 'Dropped';

export const READING_STATUSES: ReadingStatus[] = [
	'Reading',
	'Completed',
	'Plan to Read',
	'To be released',
	'Dropped',
];

/**
 * Statuses the user may pick manually. "To be released" is auto-managed from the
 * release date (mirrors the watchlist), so it is excluded from every dropdown.
 */
export const SELECTABLE_READING_STATUSES: ReadingStatus[] = READING_STATUSES.filter(
	(s) => s !== 'To be released',
);

export interface Book {
	id: string;
	title: string;
	author: string;
	status: ReadingStatus;
	rating: number;
	pagesRead: number;
	totalPages: number;
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
	// Single saved filter scoped per sub-tab (Books / Manga keep their own).
	savedFilters?: Partial<Record<'books' | 'manga', ReadingSavedFilterPreset>>;
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

export const FIELD_COLOR_50: Record<string, string> = Object.fromEntries(
	FIELD_COLORS.map(({ color600, color50 }) => [color600, color50]),
);

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

// ── Airtime types ─────────────────────────────────────────────────────────────

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
	/** For watchlist entries: a WatchLogTitle id. For reading entries: a Book/Manga id. */
	titleId: string;
	/** Absent or 'watchlist' = a watch title; 'reading' = a Book/Manga entry. */
	source?: 'watchlist' | 'reading';
	/** Only set when source === 'reading'. */
	readingKind?: 'book' | 'manga';
	schedule: AirtimeSchedule;
	/**
	 * Watch entries: current season. Reading entries reuse this slot for the
	 * current volume (the "season" analog).
	 */
	currentSeason?: number;
	/**
	 * Watch entries: current episode. Reading entries reuse this slot for the
	 * current chapter (the "episode" analog — this is what auto-increments).
	 */
	currentEpisode?: number;
	/**
	 * Total episodes to track for final-episode detection (synced from Watchlist).
	 * Reading entries reuse this slot for total chapters; a value of 0 or 1 marks
	 * a single-release item (like a movie/book).
	 */
	totalEpisodes?: number;
	/** Total seasons (informational). Reading entries reuse this slot for total volumes. */
	totalSeasons?: number;
	/** YYYY-MM-DD: set when you tick an episode, so the countdown resets to the next occurrence. */
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
	priorityEmptyOnly?: boolean;
	recentlyArrivedOnly?: boolean;
	groupsOnly?: boolean;
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
}

// ── Airtime utility functions ─────────────────────────────────────────────────

export function getAirtimeScheduleString(schedule: AirtimeSchedule): string {
	const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const time = schedule.releaseTime ? ` · ${schedule.releaseTime}` : '';

	if (schedule.recurrence === 'once') {
		if (!schedule.releaseDate) return 'No date set';
		const d = new Date(schedule.releaseDate + 'T12:00:00');
		return `Release date · ${d.getDate()} ${MONTHS[d.getMonth()] ?? ''} ${d.getFullYear()}${time}`;
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

export const DEFAULT_SETTINGS: WatchLogPluginSettings = {
	colorTheme: 'default',
	defaultWatchlistView: 'cards',
	autoCompleteOnLastEpisode: true,
	setFinishDateAutomatically: false,
	omdbApiKey: '',
	tmdbApiKey: '',
	googleBooksApiKey: '',
	activeApi: 'OMDb',
	animeApiSource: 'jikan',
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
	dashboardCardStyle: 'circles',
	episodeNumbering: 'absolute',
	readingTypeColors: { manga: '#D4537E', book: '#D85A30' },
	customListsFolder: 'WatchLog/CustomLists',
	defaultCustomColumns: [],
	draftsVaultTag: '#watchlog',
	draftsAfterAdding: 'keep',
	customListTabOrder: [],
	showHintBanners: true,
	showUpcomingStatusBar: true,
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
 * Returns the user-defined badge color for a type/status/priority.
 * Themes do not override Type, Status, or Priority colors — those are
 * fully user-controlled. The theme parameter is accepted for API compatibility
 * but is intentionally unused.
 */
export function getThemedColor(name: string, defaultColor: string, theme: string): string {
	return defaultColor;
}

/**
 * Returns the user-configured badge color for a Reading type (Book / Manga).
 * Mirrors how watchlist badges resolve `settings.types[].color`, but for the two
 * fixed Reading kinds whose colors live in `settings.readingTypeColors`.
 */
export function getReadingTypeColor(
	kind: 'book' | 'manga',
	settings: WatchLogPluginSettings,
): string {
	const colors = settings.readingTypeColors ?? DEFAULT_SETTINGS.readingTypeColors;
	return kind === 'manga' ? colors.manga : colors.book;
}

// ── Shared utility ────────────────────────────────────────────────────────────

/** Converts a stored YYYY-MM-DD date string to DD/MM/YYYY for display. */
export function formatDateDisplay(dateStr: string | null | undefined): string {
	if (!dateStr) return '';
	const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (m) return `${m[3]}/${m[2]}/${m[1]}`;
	return dateStr;
}

/** Parses a DD/MM/YYYY user input string into YYYY-MM-DD storage format. Returns null if invalid. */
export function parseDateInput(str: string): string | null {
	const trimmed = str.trim();
	if (!trimmed) return null;
	const parts = trimmed.split('/');
	if (parts.length !== 3) return null;
	const [dd, mm, yyyy] = parts;
	if (!dd || !mm || !yyyy || yyyy.length !== 4) return null;
	const d = parseInt(dd, 10), mo = parseInt(mm, 10), y = parseInt(yyyy, 10);
	if (isNaN(d) || isNaN(mo) || isNaN(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
	// Reject impossible dates (e.g., Feb 31): Date constructor rolls over, so verify components match.
	const check = new Date(y, mo - 1, d);
	if (check.getFullYear() !== y || check.getMonth() !== mo - 1 || check.getDate() !== d) return null;
	return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

/** Parses a release date in DD/MM/YYYY, DD-MM-YYYY, or YYYY-MM-DD format. Returns YYYY-MM-DD or null. */
export function parseReleaseDateInput(str: string): string | null {
	const trimmed = str.trim();
	if (!trimmed) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
	// eslint-disable-next-line no-useless-escape -- forward slash escaped for visual clarity in date regex
	const m = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
	if (m) {
		const dd = m[1]!.padStart(2, '0');
		const mm2 = m[2]!.padStart(2, '0');
		const yyyy = m[3]!;
		const d = parseInt(dd, 10), mo = parseInt(mm2, 10);
		if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
		return `${yyyy}-${mm2}-${dd}`;
	}
	return null;
}

/**
 * True when a `YYYY-MM-DD` release date is strictly in the future (after today).
 * Mirrors the watchlist's auto "To be released" check (see EditTitleModal).
 */
export function isReleaseDateFuture(releaseDate: string | null | undefined): boolean {
	if (!releaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return false;
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const releaseMs = new Date(releaseDate + 'T12:00:00').getTime();
	return releaseMs > today.getTime();
}

/**
 * Resolves the API group that should be used for a given title type.
 *  - The three built-in types are hardcoded and never live in the mapping.
 *  - Any other type is routed via `settings.typeApiMapping`; missing entries
 *    return `''` (no API configured).
 */
export function getApiGroupForType(
	type: string,
	mapping: Record<string, 'anime' | 'movie' | ''> | undefined,
): 'anime' | 'movie' | '' {
	if (type === 'Anime') return 'anime';
	if (type === 'Movie' || type === 'TV Show' || type === 'TvShow') return 'movie';
	return mapping?.[type] ?? '';
}

/**
 * Returns the poster URL to render for a title. A non-empty `manualPosterUrl`
 * takes priority over the auto-fetched `posterUrl`.
 */
export function getDisplayPoster(title: WatchLogTitle): string {
	if (title.manualPosterUrl && title.manualPosterUrl.trim() !== '') {
		return title.manualPosterUrl;
	}
	return title.posterUrl ?? '';
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
	const hStr = h >= 1000 ? String(h).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : String(h);
	if (h === 0) return `${m}m`;
	if (m === 0) return `${hStr}h`;
	return `${hStr}h ${m}m`;
}

// ── API result types ──────────────────────────────────────────────────────────

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
}

// ── AniList API shapes ───────────────────────────────────────────────────────

export interface AniListTitle {
	romaji?: string | null;
	english?: string | null;
	native?: string | null;
}

export interface AniListDate {
	year?: number | null;
	month?: number | null;
	day?: number | null;
}

export interface AniListCoverImage {
	large?: string | null;
	medium?: string | null;
}

export interface AniListMedia {
	id: number;
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
}

// ── Jikan API shapes ─────────────────────────────────────────────────────────

export interface JikanAnime {
	mal_id: number;
	title: string;
	title_english: string | null;
	episodes: number | null;
	duration: string | null;
	aired: { from: string | null } | null;
	url: string;
}

// ── OMDb API shapes ───────────────────────────────────────────────────────────

export interface OmdbSearchItem {
	Title: string;
	Year: string;
	imdbID: string;
	Type: string;
}

export interface OmdbSearchResponse {
	Search?: OmdbSearchItem[];
	Response: string;
	Error?: string;
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
}

export interface OmdbSeasonResponse {
	Season: string;
	Episodes?: Array<{ Episode: string; Title: string; imdbID: string }>;
	Response: string;
}

// ── TMDB API shapes ───────────────────────────────────────────────────────────

export interface TmdbSearchItem {
	id: number;
	title?: string;
	name?: string;
	release_date?: string;
	first_air_date?: string;
}

export interface TmdbSearchResponse {
	results?: TmdbSearchItem[];
}

export interface TmdbMovieDetail {
	id: number;
	title: string;
	runtime?: number;
	release_date?: string;
	imdb_id?: string;
}

export interface TmdbTvSeason {
	season_number: number;
	name: string;
	episode_count: number;
}

export interface TmdbTvDetail {
	id: number;
	name: string;
	episode_run_time?: number[];
	first_air_date?: string;
	number_of_episodes?: number;
	seasons?: TmdbTvSeason[];
}

export interface TmdbExternalIds {
	imdb_id?: string;
}

export interface TmdbFindResult {
	movie_results?: TmdbMovieDetail[];
	tv_results?: TmdbTvDetail[];
}
