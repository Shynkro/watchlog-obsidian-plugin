# Changelog

All notable changes to WatchLog are documented here.


## [2.1.0] - 2026-06-17

### Added
- **Open note button** — a new file-text icon in the title detail modal opens the title's `.md` note directly in Obsidian. Available in both the Watchlist and Reading (Books + Manga) modals.
- **Mobile toolbar toggle** — on mobile, a chevron button collapses the action buttons behind a toggle so the search bar stays usable by default. Search ↔ actions swap with a crossfade. Added to both the Watchlist and Reading tabs.
- **"Season watched" log event** — ticking an entire season now records a single summary "Season X watched" entry in the Log, but only when that action completes the season.
- **Add chooser modal** — the "+ add" button now opens a small chooser offering "Add from URL" and "Add manually / via API", consolidating the two add paths into one entry point (desktop and mobile).

### Fixed
- Reading titles not appearing on mobile.

## [2.0.0] - 2026-06-07

##### Added
- Added **Cards sub-tab** in Watchlist with a responsive poster card grid
	- Poster images auto-fetched from Jikan, TMDB, Google Books or OMDb and cached locally
- Added: **AniList API** as alternative anime source; toggle between Jikan and AniList in Settings
- Added: **Community Ratings**; IMDb, MAL, AniList, or TMDB scores displayed alongside personal star rating with manual refresh and 30-day auto-refresh
- Added: **API routing by type**; configurable API mapping per custom type in Settings; locked defaults for Anime, Movie, TV Show
- Added: manual **Poster URL** override field in Edit modal
- Added: **"Groups only"** filter in Watchlist; show only group headers, hide standalone titles
- Added: **"All" toggle** per filter section; quick select/deselect all within Type, Status, Rating, Priority, Group
- Added: status dropdown directly on expanded title row (no need to open Edit modal)
- Added: "Today" button on Date Watched field (auto-fills only when empty)
- Added: **Skip Episodes**; mark episodes as skippable (filler, recaps, etc.) per season
    - Define skip episodes in season syntax: `"Season 1: 48 (33-37,42)"`
    - Skipped episodes shown with purple border (`#6b2972`) and dash (—) marker
    - 3-state click cycle for skip-defined episodes: skipped → watched → empty
    - Skip stats displayed in Edit modal: "X to skip · Y to watch" next to Total Episodes and below Seasons
    - Season headers show skip count (e.g. "East Blue Saga 48 eps (5 to skip)")
    - Progress calculations exclude skipped episodes from totals
- Added: status badge moved to the top of the Watchlist detail modal, inline next to the title type, with a colored click-to-change dropdown (matching Reading)
- Added: Upcoming due count in the status bar; shows "N due" with the plugin icon, hidden when zero, click opens the Upcoming tab
- Added: Settings toggle "Show Upcoming count in status bar" (General, on by default)
- Added: Reading section in Quick Info with help entries; updated API & Search entry to reflect current APIs (AniList, Google Books)
- Added new **"Watchlist" settings tab** (renamed from Folders)
- Added **Reading integration into Dashboard**; new Books and Manga cards at the end of the grid
  • "left" counts Reading + Plan to read; To be released excluded from the calculation
  • Progress bar shows pages/chapters read of total, with an inline pages / chapters · vol line below
  • Reflected in both Rectangles and Circles dashboard styles
- Added **unified Total/Time card**; Total, Time watched, and Time remaining merged into one card with three equal segments
- Added **Reading in Upcoming**; titles already in Reading can be added via the "+ add" finder (now searches Reading), shown with Book/Manga badges
- Added **Reading schedule modal**; derived from the Anime scheduler; no Time field, Current/Total chapters + volumes, recurrence and auto-increment, 0/1 total treated as a single release date
- Added **Reading in Custom Lists**; name-cell autocomplete now searches Reading alongside Watchlist
- Added **Drafts add gate**; the Add button opens a choice modal (Add in Watchlist / Add book / Add manga), each opening the correct modal with the draft text prefilled
- Added **Release date field** to the Reading modal, inline next to Added; manually editable with optional API import (Google Books / Jikan)
- Added **Reading colors** section in Settings → Customize (below Season colors); color pickers for Manga and Book
- Added: **Show hint banners** toggle in Settings > General; hide/show informational banners in Upcoming, Custom Lists, and Drafts
- Added: **Auto-populate Time column** in Custom Lists; number columns can pull remaining watch time (in minutes) from Watchlist titles with exact name match
  - Enable via ⏱ toggle in Edit Columns for any number-type column
  - Values are persisted and only re-fetched on demand via ↻ refresh icon in column header
  - Titles not found in Watchlist show "Not found"

- Added **Log** as standalone top-level tab (extracted from Watchlist); unified timeline for both Watchlist and Reading events
  • Vertical timeline with colored dots and connector lines
  • Day-grouped entries with date headers
  • Action color coding: green (Completed/Watched), blue (Added), red (Deleted), amber (Status/Rating changed)
  • Source filter toolbar: All / Watchlist / Reading

- Added **Reading tab** with two sub-tabs: Books and Manga; fully independent from the existing Watchlist
- Added separate `reading.json` storage with dedicated `ReadingDataManager` for CRUD operations, change listeners, and schema migrations
- Added **Book tracking** with fields: title, author, status, rating, pages read/total, chapters read/total, cover URL, Open Library ID, vault page link, dates, custom fields
- Added **Manga tracking** with fields: title, author, status, rating, chapters read/total, volumes read/total, cover URL, MAL ID, vault page link, dates, custom fields
- Added **Card grid view** for both Books and Manga with responsive layout, cover images, status dots, progress bars, and author display
- Added **Detail modal** with cover, title, author, status badge, rating, Open note button, vault page controls (Change/Open with filename display and full path tooltip)
- Added **Custom fields system** per sub-tab: user-defined columns (text / number / select) with per-column color picker (8 preset colors)
    - Two display styles with toggle: **Fill** (key cell background) and **Border** (key cell border with rounded corners)
    - Inline editing in Detail modal (text input, number input, or select dropdown)
- Added **Manage Columns modal** with horizontal row layout: drag handle, name input, type dropdown, color dot picker, options input (for select type), delete button — all aligned inline
- Added **Favorite Quotes** section in Detail modal: parsed from `## Quotes` in the auto-generated `.md` file, displayed as styled callout blocks with page/chapter reference; Add quote inline form
- Added **Auto-generated `.md` files** per title at `WatchLog/Reading/Books/<Title>.md` or `WatchLog/Reading/Manga/<Title>.md` with YAML frontmatter, `## Notes`, and `## Quotes` sections; frontmatter syncs on edit
- Added **Jikan manga lookup** in Add Manga modal: search by title or MAL ID, auto-fill title/author/chapters/volumes/cover/MAL ID
- Added default reading folder path setting (default `WatchLog/Reading`)


##### Improved
- Improved: Custom Lists; Edit Columns modal redesigned as horizontal cards
- Improved: # and Name columns shown as grayed-out/non-editable in Edit Columns modal
- Improved: Edit Columns modal wider to fit card layout
- Improved: Cards sub-tab is now the default Watchlist view
- Improved: "History" sub-tabs renamed to "Log" in Watchlist and Upcoming
- Improved: **API settings tab** restructured into three faded callout sections — Movies & TV Shows, Anime, Books — with consistent key/test/status layout
- Improved: **shared danger/success button colors** consolidated into reusable utility classes (red borders for delete/remove, green for add), with softened resting borders
- Improved: Backup/Restore now covers all three data files (watch, reading, history) via a versioned format, with legacy backups still restorable
- Improved: removed the Custom Lists mobile input modal; tapping a cell now uses inline editing directly on both mobile and desktop (the modal was a workaround for the now-fixed keyboard bug)
- 

##### Fixed
- Fixed: titles inside groups now appear correctly when filtering by status
- Fixed: priority is automatically cleared when a title is marked as Completed
- Fixed: mobile keyboard layout bug; when the keyboard opened on iOS and Android, the scrollable content area collapsed and a blank/dark region covered most of the view above the keyboard. Content was present but hidden behind it.
- Fixed: Custom Lists — adding a new column no longer resets row checkboxes
- Fixed: custom field fill mode text color now black for readability

##### Performance
- Performance: optimized episode click handling; direct DOM updates with debounced save, eliminated redundant re-renders
- Performance: centralized save pipeline, batch CSV imports, debounced inputs, Map-based lookups, dead code removal, listener leak fixes
- Performance: the keyboard layout fix is debounced via requestAnimationFrame (one write per frame), with redundant-write skipping, no duplicate observers, and full teardown on view close


##### Removed
- Removed the **"Default view"** setting; the panel now always opens on Dashboard
- Removed the standalone **"Folders"** settings tab (its contents moved into the new "Watchlist" tab)


## [1.1.0] - 2026-05-12

### Changed
- Minimum Obsidian version bumped to 1.7.2

### Fixed
- Performance improvements for the Drafts tab; smoother rendering and reduced UI lag during list operations.
- Simplified `CsvModal.ts` CSV export to use `document.createElement` directly
- File names with forbidden characters are now sanitized in the title property, fixing broken notes for titles containing characters such as `:` 


## [1.0.9] - 2026-04-26
### Initial public release