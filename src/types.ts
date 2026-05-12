export interface Season {
	name: string;
	episodes: number;
	offset: number;
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
	pinned?: boolean;
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
}

export interface CustomListRow {
	id: string;
	checked?: boolean;
	[key: string]: string | number | boolean | undefined;
}

// ── Maybe types (Feature 2c) ──────────────────────────────────────────────────

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
	defaultView: 'dashboard' | 'watchlist';
	autoCompleteOnLastEpisode: boolean;
	setFinishDateAutomatically: boolean;
	omdbApiKey: string;
	tmdbApiKey: string;
	activeApi: 'OMDb' | 'TMDB';
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
	};
	draftsVaultTag: string;
	draftsAfterAdding: 'remove' | 'keep';
	customListTabOrder: string[];
}

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
	titleId: string;
	schedule: AirtimeSchedule;
	currentSeason?: number;
	currentEpisode?: number;
	/** Total episodes to track for final-episode detection (synced from Watchlist). */
	totalEpisodes?: number;
	/** Total seasons (informational). */
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
}

// ── Airtime utility functions ─────────────────────────────────────────────────

export function getAirtimeNextDate(schedule: AirtimeSchedule): Date | null {
	const now = new Date();
	const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

	if (schedule.recurrence === 'once') {
		if (!schedule.releaseDate) return null;
		const d = new Date(schedule.releaseDate + 'T12:00:00');
		if (schedule.releaseTime) {
			const parts = schedule.releaseTime.split(':');
			d.setHours(parseInt(parts[0] ?? '0'), parseInt(parts[1] ?? '0'), 0, 0);
		}
		return d;
	}

	if (schedule.recurrence === 'daily') {
		const d = new Date(todayMidnight);
		if (schedule.releaseTime) {
			const parts = schedule.releaseTime.split(':');
			d.setHours(parseInt(parts[0] ?? '0'), parseInt(parts[1] ?? '0'), 0, 0);
			if (d <= now) d.setDate(d.getDate() + 1);
		}
		return d;
	}

	if (schedule.recurrence === 'weekly' && schedule.dayOfWeek !== undefined) {
		const currentDay = now.getDay();
		let daysUntil = (schedule.dayOfWeek - currentDay + 7) % 7;
		const d = new Date(todayMidnight);
		if (schedule.releaseTime) {
			const parts = schedule.releaseTime.split(':');
			d.setHours(parseInt(parts[0] ?? '0'), parseInt(parts[1] ?? '0'), 0, 0);
			if (daysUntil === 0 && d <= now) daysUntil = 7;
		}
		d.setDate(d.getDate() + daysUntil);
		return d;
	}

	if (schedule.recurrence === 'monthly' && schedule.dayOfMonth) {
		const d = new Date(now.getFullYear(), now.getMonth(), schedule.dayOfMonth);
		if (schedule.releaseTime) {
			const parts = schedule.releaseTime.split(':');
			d.setHours(parseInt(parts[0] ?? '0'), parseInt(parts[1] ?? '0'), 0, 0);
		}
		if (d <= now) d.setMonth(d.getMonth() + 1);
		return d;
	}

	return null;
}

export function getAirtimeCountdown(
	schedule: AirtimeSchedule,
): { label: string; kind: 'today' | 'tomorrow' | 'days' | 'missed' } {
	const next = getAirtimeNextDate(schedule);
	if (!next) return { label: '—', kind: 'days' };

	const now = new Date();
	if (schedule.recurrence === 'once' && next < now) {
		return { label: 'Missed', kind: 'missed' };
	}

	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const tomorrow = new Date(today);
	tomorrow.setDate(tomorrow.getDate() + 1);
	const nextMidnight = new Date(next.getFullYear(), next.getMonth(), next.getDate());

	if (nextMidnight.getTime() === today.getTime()) return { label: 'Today', kind: 'today' };
	if (nextMidnight.getTime() === tomorrow.getTime()) return { label: 'Tomorrow', kind: 'tomorrow' };

	const daysUntil = Math.round((nextMidnight.getTime() - today.getTime()) / 86400000);
	if (daysUntil < 0) return { label: 'Missed', kind: 'missed' };
	return { label: `in ${daysUntil} days`, kind: 'days' };
}

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
	defaultView: 'watchlist',
	autoCompleteOnLastEpisode: true,
	setFinishDateAutomatically: false,
	omdbApiKey: '',
	tmdbApiKey: '',
	activeApi: 'OMDb',
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
	customListsFolder: 'WatchLog/CustomLists',
	defaultCustomColumns: [],
	draftsVaultTag: '#watchlog',
	draftsAfterAdding: 'keep',
	customListTabOrder: [],
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
	title: string;
	episodes: number;
	duration: number;
	releaseDate: string;
	url: string;
	seasons: Season[];
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
