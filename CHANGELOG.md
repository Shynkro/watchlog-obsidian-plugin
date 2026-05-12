# Changelog

All notable changes to WatchLog are documented here.

## [1.1.0] - 2026-05-12

### Changed
- Minimum Obsidian version bumped to 1.7.2

### Fixed
- Performance improvements for the Drafts tab; smoother rendering and reduced UI lag during list operations.
- Simplified `CsvModal.ts` CSV export to use `document.createElement` directly
- File names with forbidden characters are now sanitized in the title property, fixing broken notes for titles containing characters such as `:` 

## [1.0.9] - 2026-04-26
### Initial public release