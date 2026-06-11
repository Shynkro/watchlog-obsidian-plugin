import { App, Modal, Notice } from 'obsidian';
import type WatchLogPlugin from './main';
import type { Book, Manga, ReadingStatus } from './types';
import { READING_STATUSES, SELECTABLE_READING_STATUSES } from './types';
import type { ReadingCsvKind } from './ReadingCsvChoiceModal';

// ── CSV helpers (self-contained — deliberately not shared with the watch CsvModal) ──

function escapeCsvField(value: string | number | null | undefined): string {
	const s = String(value ?? '');
	if (s.includes(',') || s.includes('"') || s.includes('\n')) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

/** Full CSV parser: quoted fields with embedded newlines, escaped quotes, comma delimiter, CRLF. */
function parseCSV(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cur = '';
	let inQuotes = false;
	const t = text.replace(/\r\n?/g, '\n');
	for (let i = 0; i < t.length; i++) {
		const ch = t[i];
		if (inQuotes) {
			if (ch === '"') {
				if (t[i + 1] === '"') { cur += '"'; i++; }
				else { inQuotes = false; }
			} else {
				cur += ch;
			}
		} else {
			if (ch === '"') {
				inQuotes = true;
			} else if (ch === ',') {
				row.push(cur); cur = '';
			} else if (ch === '\n') {
				row.push(cur); cur = '';
				rows.push(row); row = [];
			} else {
				cur += ch;
			}
		}
	}
	if (cur.length > 0 || row.length > 0) {
		row.push(cur);
		rows.push(row);
	}
	while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c === '')) rows.pop();
	return rows;
}

// ── Date parsing (same logic as the watch CSV path) ─────────────────────────────

const MONTH_NAMES: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
	jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parses a date string in any common format and returns YYYY-MM-DD, or null if unparseable. */
function parseCsvDate(raw: string): string | null {
	const s = raw.trim();
	if (!s) return null;
	try {
		if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

		const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
		if (slash) {
			const a = parseInt(slash[1]!), b = parseInt(slash[2]!), y = parseInt(slash[3]!);
			let dd: number, mm: number;
			if (a > 12)      { dd = a; mm = b; }
			else if (b > 12) { mm = a; dd = b; }
			else             { dd = a; mm = b; }
			if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
			return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
		}

		const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
		if (dmy) {
			const mm = MONTH_NAMES[dmy[2]!.toLowerCase().slice(0, 3)];
			const dd = parseInt(dmy[1]!), y = parseInt(dmy[3]!);
			if (mm) return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
		}

		const mdy = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
		if (mdy) {
			const mm = MONTH_NAMES[mdy[1]!.toLowerCase().slice(0, 3)];
			const dd = parseInt(mdy[2]!), y = parseInt(mdy[3]!);
			if (mm) return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
		}

		const dotDash = s.match(/^(\d{1,2})[.-](\d{1,2})[.-](\d{4})$/);
		if (dotDash) {
			const dd = parseInt(dotDash[1]!), mm = parseInt(dotDash[2]!), y = parseInt(dotDash[3]!);
			if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)
				return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
		}

		const parsed = new Date(s);
		if (!isNaN(parsed.getTime())) {
			const dd = parsed.getDate(), mm = parsed.getMonth() + 1, y = parsed.getFullYear();
			return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
		}

		return null;
	} catch {
		return null;
	}
}

// ── Schemas (Books and Manga kept fully separate) ───────────────────────────────

type Coercion = 'string' | 'int' | 'rating' | 'date';

interface ReadingFieldDef {
	key: string;
	label: string;
	coercion: Coercion;
	autoDetect: string[];
}

// Export column order (includes dateAdded, which is export-only).
const BOOK_EXPORT_COLUMNS = [
	'title', 'author', 'status', 'rating',
	'pagesRead', 'totalPages', 'chaptersRead', 'totalChapters',
	'dateStarted', 'dateFinished', 'releaseDate', 'dateAdded',
	'externalLink', 'googleBooksId',
] as const;

const MANGA_EXPORT_COLUMNS = [
	'title', 'author', 'status', 'rating',
	'chaptersRead', 'totalChapters', 'volumesRead', 'totalVolumes',
	'dateStarted', 'dateFinished', 'releaseDate', 'dateAdded',
	'externalLink', 'malId',
] as const;

// Import targets — same as export minus dateAdded (auto-set on insert).
const COMMON_HEAD: ReadingFieldDef[] = [
	{ key: 'title',  label: 'Title',  coercion: 'string', autoDetect: ['title', 'name'] },
	{ key: 'author', label: 'Author', coercion: 'string', autoDetect: ['author', 'writer', 'by'] },
	{ key: 'status', label: 'Status', coercion: 'string', autoDetect: ['status'] },
	{ key: 'rating', label: 'Rating', coercion: 'rating', autoDetect: ['rating', 'score'] },
];

const COMMON_TAIL: ReadingFieldDef[] = [
	{ key: 'dateStarted',  label: 'Date Started',  coercion: 'date',   autoDetect: ['started', 'datestarted', 'date started', 'date_started', 'start date'] },
	{ key: 'dateFinished', label: 'Date Finished', coercion: 'date',   autoDetect: ['finished', 'datefinished', 'date finished', 'date_finished', 'end date', 'finish date', 'completed date'] },
	{ key: 'releaseDate',  label: 'Release Date',  coercion: 'date',   autoDetect: ['releasedate', 'release date', 'release_date', 'published', 'publish date'] },
	{ key: 'externalLink', label: 'Link',          coercion: 'string', autoDetect: ['link', 'externallink', 'external link', 'external_link', 'url'] },
];

const BOOK_IMPORT_FIELDS: ReadingFieldDef[] = [
	...COMMON_HEAD,
	{ key: 'pagesRead',     label: 'Pages Read',     coercion: 'int', autoDetect: ['pagesread', 'pages read', 'read pages', 'page'] },
	{ key: 'totalPages',    label: 'Total Pages',    coercion: 'int', autoDetect: ['totalpages', 'total pages', 'pages', 'page count'] },
	{ key: 'chaptersRead',  label: 'Chapters Read',  coercion: 'int', autoDetect: ['chaptersread', 'chapters read', 'read chapters'] },
	{ key: 'totalChapters', label: 'Total Chapters', coercion: 'int', autoDetect: ['totalchapters', 'total chapters', 'chapters', 'chapter count'] },
	...COMMON_TAIL,
	{ key: 'googleBooksId', label: 'Google Books ID', coercion: 'string', autoDetect: ['googlebooksid', 'google books id', 'gbid', 'volumeid'] },
];

const MANGA_IMPORT_FIELDS: ReadingFieldDef[] = [
	...COMMON_HEAD,
	{ key: 'chaptersRead',  label: 'Chapters Read',  coercion: 'int', autoDetect: ['chaptersread', 'chapters read', 'read chapters'] },
	{ key: 'totalChapters', label: 'Total Chapters', coercion: 'int', autoDetect: ['totalchapters', 'total chapters', 'chapters', 'chapter count'] },
	{ key: 'volumesRead',   label: 'Volumes Read',   coercion: 'int', autoDetect: ['volumesread', 'volumes read', 'read volumes'] },
	{ key: 'totalVolumes',  label: 'Total Volumes',  coercion: 'int', autoDetect: ['totalvolumes', 'total volumes', 'volumes', 'volume count'] },
	...COMMON_TAIL,
	{ key: 'malId',         label: 'MAL ID',         coercion: 'string', autoDetect: ['malid', 'mal id', 'myanimelist id', 'mal'] },
];

interface ReadingSchema {
	exportColumns: readonly string[];
	importFields: ReadingFieldDef[];
}

function schemaFor(kind: ReadingCsvKind): ReadingSchema {
	return kind === 'book'
		? { exportColumns: BOOK_EXPORT_COLUMNS, importFields: BOOK_IMPORT_FIELDS }
		: { exportColumns: MANGA_EXPORT_COLUMNS, importFields: MANGA_IMPORT_FIELDS };
}

function autoMap(fields: ReadingFieldDef[], headers: string[]): Record<string, string> {
	const mapping: Record<string, string> = {};
	for (const field of fields) {
		const match = headers.find((h) => field.autoDetect.includes(h.toLowerCase()));
		mapping[field.key] = match ?? '';
	}
	return mapping;
}

// ── Modal ───────────────────────────────────────────────────────────────────────

type ReadingEntry = Partial<Book & Manga>;

export class ReadingCsvModal extends Modal {
	private plugin: WatchLogPlugin;
	private kind: ReadingCsvKind;
	private mode: 'export' | 'import';
	private schema: ReadingSchema;

	private get kindLabel(): string {
		return this.kind === 'book' ? 'Books' : 'Manga';
	}

	private get itemNoun(): string {
		return this.kind === 'book' ? 'book' : 'manga';
	}

	// Export state
	private selectedIds = new Set<string>();

	// Import state
	private csvRows: string[][] = [];
	private csvHeaders: string[] = [];
	private columnMapping: Record<string, string> = {};
	private importRows: { entry: ReadingEntry; isDuplicate: boolean; selected: boolean }[] = [];

	// Value-mapping state
	private statusValueMap: Record<string, string> = {};  // csvValue → resolved status ('' = blank)
	private ratingValueMap: Record<string, string> = {};  // csvValue → '1'–'5' or '' (blank)

	// Step containers
	private stepUpload: HTMLElement | null = null;
	private stepMapping: HTMLElement | null = null;
	private stepValueMap: HTMLElement | null = null;
	private stepPreview: HTMLElement | null = null;
	private importBtn: HTMLButtonElement | null = null;
	private cancelBtn: HTMLButtonElement | null = null;

	// Progress state
	private isImporting = false;
	private importCancelled = false;
	private progressWrap: HTMLElement | null = null;
	private progressBarFill: HTMLElement | null = null;
	private progressText: HTMLElement | null = null;

	constructor(app: App, plugin: WatchLogPlugin, kind: ReadingCsvKind, mode: 'export' | 'import') {
		super(app);
		this.plugin = plugin;
		this.kind = kind;
		this.mode = mode;
		this.schema = schemaFor(kind);
	}

	private getItems(): (Book | Manga)[] {
		return this.kind === 'book'
			? this.plugin.readingDataManager.getBooks()
			: this.plugin.readingDataManager.getMangaList();
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('wl-csv-modal');
		if (this.mode === 'export') this.renderExport(contentEl);
		else this.renderImport(contentEl);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// ── Export ──────────────────────────────────────────────────────────────────

	private itemsToCsv(items: (Book | Manga)[]): string {
		const cols = this.schema.exportColumns;
		const header = cols.join(',');
		const rows = items.map((it) =>
			cols.map((col) => escapeCsvField((it as unknown as Record<string, string | number | null | undefined>)[col])).join(','),
		);
		return [header, ...rows].join('\n');
	}

	private renderExport(el: HTMLElement): void {
		el.createEl('h2', { cls: 'wl-modal-title', text: `Export ${this.kindLabel} to CSV` });

		const items = this.getItems();
		items.forEach((it) => this.selectedIds.add(it.id));

		const ctrlRow = el.createDiv({ cls: 'wl-csv-ctrl-row' });
		const selectAllBtn = ctrlRow.createEl('button', { cls: 'wl-btn', text: 'Select all' });
		const selectNoneBtn = ctrlRow.createEl('button', { cls: 'wl-btn', text: 'Select none' });
		const countEl = ctrlRow.createSpan({ cls: 'wl-csv-count', text: `${items.length} selected` });

		const listEl = el.createDiv({ cls: 'wl-csv-list' });
		const checkboxes: HTMLInputElement[] = [];

		const updateCount = (): void => {
			countEl.textContent = `${this.selectedIds.size} selected`;
		};

		for (const item of items) {
			const row = listEl.createDiv({ cls: 'wl-csv-row' });
			const cb = row.createEl('input', { attr: { type: 'checkbox' } });
			cb.checked = true;
			checkboxes.push(cb);
			row.createSpan({ cls: 'wl-csv-row-title', text: item.title });
			const meta = [item.author, item.status].filter(Boolean).join(' · ');
			if (meta) row.createSpan({ cls: 'wl-csv-row-meta', text: meta });

			cb.addEventListener('change', () => {
				if (cb.checked) this.selectedIds.add(item.id);
				else this.selectedIds.delete(item.id);
				updateCount();
			});
		}

		selectAllBtn.addEventListener('click', () => {
			items.forEach((it) => this.selectedIds.add(it.id));
			checkboxes.forEach((cb) => { cb.checked = true; });
			updateCount();
		});

		selectNoneBtn.addEventListener('click', () => {
			this.selectedIds.clear();
			checkboxes.forEach((cb) => { cb.checked = false; });
			updateCount();
		});

		const btnRow = el.createDiv({ cls: 'wl-modal-btn-row wl-csv-btn-row' });
		const cancelBtn = btnRow.createEl('button', { cls: 'wl-btn', text: 'Cancel' });
		const exportBtn = btnRow.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Export CSV' });

		cancelBtn.addEventListener('click', () => this.close());
		exportBtn.addEventListener('click', () => {
			const toExport = items.filter((it) => this.selectedIds.has(it.id));
			if (toExport.length === 0) {
				new Notice(`No ${this.itemNoun} selected.`);
				return;
			}
			const csv = this.itemsToCsv(toExport);
			const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
			const url = URL.createObjectURL(blob);
			const a = activeDocument.createElement('a');
			const today = new Date();
			const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
			a.href = url;
			a.download = `watchlog-${this.itemNoun === 'book' ? 'books' : 'manga'}-export-${dateStr}.csv`;
			a.click();
			URL.revokeObjectURL(url);
			new Notice(`Exported ${toExport.length} ${this.kindLabel.toLowerCase()}.`);
			this.close();
		});
	}

	// ── Import ──────────────────────────────────────────────────────────────────

	private renderImport(el: HTMLElement): void {
		el.createEl('h2', { cls: 'wl-modal-title', text: `Import ${this.kindLabel} from CSV` });

		this.stepUpload = el.createDiv({ cls: 'wl-csv-step' });
		const dropZone = this.stepUpload.createDiv({ cls: 'wl-csv-drop-zone' });
		dropZone.createDiv({ cls: 'wl-csv-drop-label', text: 'Select a CSV file to import' });
		const fileInput = dropZone.createEl('input', {
			attr: { type: 'file', accept: '.csv' },
			cls: 'wl-csv-file-input',
		});

		this.stepMapping = el.createDiv({ cls: 'wl-csv-step' });
		this.stepMapping.hide();
		this.stepValueMap = el.createDiv({ cls: 'wl-csv-step' });
		this.stepValueMap.hide();
		this.stepPreview = el.createDiv({ cls: 'wl-csv-step' });
		this.stepPreview.hide();

		const btnRow = el.createDiv({ cls: 'wl-modal-btn-row wl-csv-btn-row' });

		this.progressWrap = btnRow.createDiv({ cls: 'wl-csv-progress-wrap' });
		this.progressWrap.hide();
		this.progressWrap.createSpan({ cls: 'wl-csv-bg-note', text: 'You can close this window — import will continue in the background.' });
		const progressTrack = this.progressWrap.createDiv({ cls: 'wl-csv-progress-track' });
		this.progressBarFill = progressTrack.createDiv({ cls: 'wl-csv-progress-fill' });
		this.progressText = this.progressWrap.createSpan({ cls: 'wl-csv-progress-text', text: '0 / 0' });

		this.cancelBtn = btnRow.createEl('button', { cls: 'wl-btn', text: 'Cancel' });
		this.importBtn = btnRow.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Import selected' });
		this.importBtn.disabled = true;
		this.importBtn.hide();

		this.cancelBtn.addEventListener('click', () => {
			if (this.isImporting) {
				this.importCancelled = true;
				if (this.cancelBtn) {
					this.cancelBtn.disabled = true;
					this.cancelBtn.textContent = 'Cancelling…';
				}
			} else {
				this.close();
			}
		});
		this.importBtn.addEventListener('click', () => void this.doImport());

		fileInput.addEventListener('change', () => {
			const file = fileInput.files?.[0];
			if (!file) return;
			const reader = new FileReader();
			reader.onload = (ev) => {
				const text = ev.target?.result as string;
				this.csvRows = parseCSV(text);
				this.csvHeaders = (this.csvRows[0] ?? []).map((h) => h.trim());
				this.columnMapping = autoMap(this.schema.importFields, this.csvHeaders);
				this.showMappingStep();
			};
			reader.readAsText(file);
		});
	}

	// ── Step: Column Mapping ──────────────────────────────────────────────────────

	private showMappingStep(): void {
		if (!this.stepUpload || !this.stepMapping) return;
		this.stepUpload.hide();
		this.stepMapping.show();
		this.renderMappingStep(this.stepMapping);
	}

	private renderMappingStep(el: HTMLElement): void {
		el.empty();
		el.createDiv({ cls: 'wl-csv-step-title', text: 'Map your columns' });
		el.createDiv({
			cls: 'wl-csv-step-desc',
			text: `Match each ${this.itemNoun === 'book' ? 'Book' : 'Manga'} field to a column from your CSV. Select "— skip —" to leave a field empty.`,
		});
		el.createDiv({
			cls: 'wl-csv-info-note',
			text: 'Rows with empty fields will be skipped automatically. If you see missing entries, check that your CSV has no empty rows at the top.',
		});

		const SKIP_VALUE = '';
		const grid = el.createDiv({ cls: 'wl-csv-map-grid' });
		const selectEls: Record<string, HTMLSelectElement> = {};

		for (const field of this.schema.importFields) {
			const row = grid.createDiv({ cls: 'wl-csv-map-row' });
			row.createSpan({ cls: 'wl-csv-map-label', text: field.label });
			const sel = row.createEl('select', { cls: 'wl-select wl-csv-map-select' });
			selectEls[field.key] = sel;
			sel.createEl('option', { value: SKIP_VALUE, text: '— skip —' });
			for (const col of this.csvHeaders) {
				sel.createEl('option', { value: col, text: col });
			}
			sel.value = this.columnMapping[field.key] ?? SKIP_VALUE;
		}

		const previewBtn = el.createEl('button', { cls: 'wl-btn wl-btn-primary wl-csv-preview-btn', text: 'Next →' });
		previewBtn.addEventListener('click', () => {
			for (const field of this.schema.importFields) {
				this.columnMapping[field.key] = selectEls[field.key]?.value ?? '';
			}
			this.importRows = this.applyMapping()
				.map((r) => ({ ...r, selected: !r.isDuplicate }));

			// Unknown statuses and non-numeric ratings → value-mapping step.
			const knownStatuses = new Set<string>(READING_STATUSES as string[]);
			const unknownStatuses: string[] = [];
			const unknownRatings: string[] = [];
			const seenStatuses = new Set<string>();
			const seenRatings = new Set<string>();

			const headers = (this.csvRows[0] ?? []).map((h) => h.trim());
			const ratingColName = this.columnMapping['rating'];
			const ratingIdx = ratingColName ? headers.indexOf(ratingColName) : -1;

			for (const r of this.importRows) {
				const sv = (r.entry.status as string | undefined)?.trim();
				if (sv && !knownStatuses.has(sv) && !seenStatuses.has(sv)) {
					unknownStatuses.push(sv);
					seenStatuses.add(sv);
				}
				if (ratingIdx >= 0) {
					const lineIdx = this.importRows.indexOf(r);
					const rawValues = this.csvRows[lineIdx + 1] ?? [];
					const rawRating = (rawValues[ratingIdx] ?? '').trim();
					if (rawRating && isNaN(parseFloat(rawRating)) && !seenRatings.has(rawRating)) {
						unknownRatings.push(rawRating);
						seenRatings.add(rawRating);
					}
				}
			}

			if (unknownStatuses.length > 0 || unknownRatings.length > 0) {
				this.showValueMapStep(unknownStatuses, unknownRatings);
			} else {
				this.showPreviewStep();
			}
		});
	}

	private applyMapping(): { entry: ReadingEntry; isDuplicate: boolean }[] {
		if (this.csvRows.length < 2) return [];
		const headers = (this.csvRows[0] ?? []).map((h) => h.trim());
		const existing = this.getItems();

		return this.csvRows.slice(1)
			.filter((r) => r.some((c) => c.trim()))
			.map((values): { entry: ReadingEntry; isDuplicate: boolean } | null => {
				const get = (fieldKey: string): string => {
					const colName = this.columnMapping[fieldKey];
					if (!colName) return '';
					const idx = headers.indexOf(colName);
					return idx >= 0 ? (values[idx] ?? '').trim() : '';
				};

				const entry: ReadingEntry = {};
				for (const field of this.schema.importFields) {
					const raw = get(field.key);
					if (!raw) continue;
					switch (field.coercion) {
						case 'string':
							(entry as Record<string, unknown>)[field.key] = raw;
							break;
						case 'int':
							(entry as Record<string, unknown>)[field.key] = parseInt(raw) || 0;
							break;
						case 'rating': {
							const v = parseFloat(raw) || 0;
							entry.rating = Math.max(0, Math.min(5, v));
							break;
						}
						case 'date': {
							const d = parseCsvDate(raw);
							if (d) (entry as Record<string, unknown>)[field.key] = d;
							break;
						}
					}
				}

				if (!entry.title || !entry.title.trim()) return null;

				const isDuplicate = !!existing.find(
					(it) => it.title.toLowerCase() === (entry.title ?? '').toLowerCase(),
				);
				return { entry, isDuplicate };
			})
			.filter((r): r is { entry: ReadingEntry; isDuplicate: boolean } => r !== null);
	}

	// ── Step: Value Mapping ───────────────────────────────────────────────────────

	private showValueMapStep(unknownStatuses: string[], unknownRatings: string[]): void {
		if (!this.stepMapping || !this.stepValueMap) return;
		this.stepMapping.hide();
		this.stepValueMap.show();
		this.renderValueMapStep(this.stepValueMap, unknownStatuses, unknownRatings);
	}

	private renderValueMapStep(el: HTMLElement, unknownStatuses: string[], unknownRatings: string[]): void {
		el.empty();
		el.createDiv({ cls: 'wl-csv-step-title', text: 'Map unknown values' });
		el.createDiv({
			cls: 'wl-csv-step-desc',
			text: 'Some values in your CSV were not recognized. Map each to an existing value, or leave it blank.',
		});

		// Reading statuses are a fixed set — no "create new status" option (unlike watch types).
		const statusSelects: Record<string, HTMLSelectElement> = {};
		const ratingSelects: Record<string, HTMLSelectElement> = {};

		if (unknownStatuses.length > 0) {
			el.createDiv({ cls: 'wl-csv-valmap-section-title', text: 'Status' });
			for (const sv of unknownStatuses) {
				const row = el.createDiv({ cls: 'wl-csv-valmap-row' });
				row.createSpan({ cls: 'wl-csv-valmap-orig', text: `"${sv}"` });
				row.createSpan({ cls: 'wl-csv-valmap-arrow', text: '→' });
				const sel = row.createEl('select', { cls: 'wl-select wl-csv-valmap-select' });
				statusSelects[sv] = sel;
				sel.createEl('option', { value: '', text: '— leave blank —' });
				for (const name of SELECTABLE_READING_STATUSES) {
					sel.createEl('option', { value: name, text: name });
				}
				const lc = sv.toLowerCase();
				const match = SELECTABLE_READING_STATUSES.find((s) => s.toLowerCase() === lc);
				if (match) sel.value = match;
			}
		}

		if (unknownRatings.length > 0) {
			el.createDiv({ cls: 'wl-csv-valmap-section-title', text: 'Rating' });
			for (const rv of unknownRatings) {
				const row = el.createDiv({ cls: 'wl-csv-valmap-row' });
				row.createSpan({ cls: 'wl-csv-valmap-orig', text: `"${rv}"` });
				row.createSpan({ cls: 'wl-csv-valmap-arrow', text: '→' });
				const sel = row.createEl('select', { cls: 'wl-select wl-csv-valmap-select' });
				ratingSelects[rv] = sel;
				sel.createEl('option', { value: '', text: '— leave blank —' });
				for (let i = 1; i <= 5; i++) {
					sel.createEl('option', { value: String(i), text: `${i}/5` });
				}
			}
		}

		const btnRow = el.createDiv({ cls: 'wl-csv-valmap-btn-row' });
		const backBtn = btnRow.createEl('button', { cls: 'wl-btn', text: '← back' });
		const confirmBtn = btnRow.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Preview →' });

		backBtn.addEventListener('click', () => {
			if (!this.stepValueMap || !this.stepMapping) return;
			this.stepValueMap.hide();
			this.stepMapping.show();
		});

		confirmBtn.addEventListener('click', () => {
			this.statusValueMap = {};
			for (const sv of unknownStatuses) this.statusValueMap[sv] = statusSelects[sv]?.value ?? '';
			this.ratingValueMap = {};
			for (const rv of unknownRatings) this.ratingValueMap[rv] = ratingSelects[rv]?.value ?? '';
			this.applyValueMapsToRows();
			this.showPreviewStep();
		});
	}

	private applyValueMapsToRows(): void {
		const headers = (this.csvRows[0] ?? []).map((h) => h.trim());
		const ratingColName = this.columnMapping['rating'];
		const ratingIdx = ratingColName ? headers.indexOf(ratingColName) : -1;

		for (const r of this.importRows) {
			const sv = (r.entry.status as string | undefined)?.trim() ?? '';
			if (sv && Object.prototype.hasOwnProperty.call(this.statusValueMap, sv)) {
				const resolved = this.statusValueMap[sv] ?? '';
				r.entry.status = (resolved || undefined) as ReadingStatus | undefined;
			}

			if (ratingIdx >= 0) {
				const rowIdx = this.importRows.indexOf(r);
				const rawValues = this.csvRows[rowIdx + 1] ?? [];
				const rawRating = (rawValues[ratingIdx] ?? '').trim();
				if (rawRating && Object.prototype.hasOwnProperty.call(this.ratingValueMap, rawRating)) {
					const resolved = this.ratingValueMap[rawRating] ?? '';
					r.entry.rating = resolved ? parseInt(resolved) : 0;
				}
			}
		}
	}

	// ── Step: Preview ─────────────────────────────────────────────────────────────

	private showPreviewStep(): void {
		if (!this.stepValueMap || !this.stepMapping || !this.stepPreview || !this.importBtn) return;
		this.stepValueMap.hide();
		this.stepMapping.hide();
		this.stepPreview.show();
		this.importBtn.show();
		this.importBtn.disabled = this.importRows.filter((r) => r.selected).length === 0;
		this.renderPreviewStep(this.stepPreview);
	}

	private renderPreviewStep(el: HTMLElement): void {
		el.empty();

		const dupeCount = this.importRows.filter((r) => r.isDuplicate).length;
		if (dupeCount > 0) {
			el.createDiv({
				cls: 'wl-csv-dupe-warning',
				text: `${dupeCount} duplicate${dupeCount !== 1 ? 's' : ''} found (highlighted). These are deselected by default.`,
			});
		}

		const ctrlRow = el.createDiv({ cls: 'wl-csv-ctrl-row' });
		const backBtn = ctrlRow.createEl('button', { cls: 'wl-btn', text: '← back' });
		const selectAllBtn = ctrlRow.createEl('button', { cls: 'wl-btn', text: 'Select all' });
		const selectNoneBtn = ctrlRow.createEl('button', { cls: 'wl-btn', text: 'Select none' });
		const countEl = ctrlRow.createSpan({ cls: 'wl-csv-count', text: '' });

		backBtn.addEventListener('click', () => {
			if (!this.stepPreview || !this.stepValueMap || !this.stepMapping || !this.importBtn) return;
			this.stepPreview.hide();
			this.importBtn.hide();
			this.importBtn.disabled = true;
			const hadValueMap = Object.keys(this.statusValueMap).length > 0 || Object.keys(this.ratingValueMap).length > 0;
			if (hadValueMap) this.stepValueMap.show();
			else this.stepMapping.show();
		});

		const listEl = el.createDiv({ cls: 'wl-csv-list' });
		const checkboxes: HTMLInputElement[] = [];

		const updateCount = (): void => {
			const sel = this.importRows.filter((r) => r.selected).length;
			countEl.textContent = `${sel} of ${this.importRows.length} selected`;
			if (this.importBtn) this.importBtn.disabled = sel === 0;
		};

		for (let i = 0; i < this.importRows.length; i++) {
			const r = this.importRows[i]!;
			const row = listEl.createDiv({ cls: `wl-csv-row${r.isDuplicate ? ' wl-csv-row-dupe' : ''}` });
			const cb = row.createEl('input', { attr: { type: 'checkbox' } });
			cb.checked = r.selected;
			checkboxes.push(cb);
			row.createSpan({ cls: 'wl-csv-row-title', text: r.entry.title ?? '(no title)' });
			const metaParts = [r.entry.author, r.entry.status].filter(Boolean).join(' · ');
			if (metaParts) row.createSpan({ cls: 'wl-csv-row-meta', text: metaParts });
			if (r.isDuplicate) row.createSpan({ cls: 'wl-csv-dupe-badge', text: 'duplicate' });
			const idx = i;
			cb.addEventListener('change', () => {
				this.importRows[idx]!.selected = cb.checked;
				updateCount();
			});
		}

		selectAllBtn.addEventListener('click', () => {
			this.importRows.forEach((r) => { r.selected = true; });
			checkboxes.forEach((cb) => { cb.checked = true; });
			updateCount();
		});

		selectNoneBtn.addEventListener('click', () => {
			this.importRows.forEach((r) => { r.selected = false; });
			checkboxes.forEach((cb) => { cb.checked = false; });
			updateCount();
		});

		updateCount();
	}

	// ── Import ──────────────────────────────────────────────────────────────────

	private buildBook(entry: ReadingEntry, defaultStatus: ReadingStatus): Book {
		const titleName = entry.title!.trim();
		const now = new Date().toISOString();
		return {
			id: this.plugin.readingDataManager.generateBookId(titleName),
			title: titleName,
			author: entry.author ?? '',
			status: (entry.status) || defaultStatus,
			rating: entry.rating ?? 0,
			pagesRead: entry.pagesRead ?? 0,
			totalPages: entry.totalPages ?? 0,
			chaptersRead: entry.chaptersRead ?? 0,
			totalChapters: entry.totalChapters ?? 0,
			coverUrl: '',
			googleBooksId: entry.googleBooksId ?? '',
			externalLink: entry.externalLink ?? '',
			vaultPage: '',
			dateStarted: entry.dateStarted ?? null,
			dateFinished: entry.dateFinished ?? null,
			releaseDate: entry.releaseDate ?? null,
			dateAdded: now,
			dateModified: now,
			customFields: {},
		};
	}

	private buildManga(entry: ReadingEntry, defaultStatus: ReadingStatus): Manga {
		const titleName = entry.title!.trim();
		const now = new Date().toISOString();
		return {
			id: this.plugin.readingDataManager.generateMangaId(titleName),
			title: titleName,
			author: entry.author ?? '',
			status: (entry.status) || defaultStatus,
			rating: entry.rating ?? 0,
			chaptersRead: entry.chaptersRead ?? 0,
			totalChapters: entry.totalChapters ?? 0,
			volumesRead: entry.volumesRead ?? 0,
			totalVolumes: entry.totalVolumes ?? 0,
			coverUrl: '',
			malId: entry.malId ?? '',
			externalLink: entry.externalLink ?? '',
			vaultPage: '',
			dateStarted: entry.dateStarted ?? null,
			dateFinished: entry.dateFinished ?? null,
			releaseDate: entry.releaseDate ?? null,
			dateAdded: now,
			dateModified: now,
			customFields: {},
		};
	}

	private async doImport(): Promise<void> {
		const toImport = this.importRows.filter((r) => r.selected && r.entry.title?.trim());
		if (toImport.length === 0) {
			new Notice(`No ${this.itemNoun} selected to import.`);
			return;
		}

		this.isImporting = true;
		this.importCancelled = false;
		if (this.importBtn) this.importBtn.disabled = true;
		if (this.cancelBtn) this.cancelBtn.textContent = 'Cancel import';
		if (this.progressWrap) this.progressWrap.show();
		if (this.progressText) this.progressText.textContent = `0 / ${toImport.length}`;
		if (this.progressBarFill) this.progressBarFill.style.width = `0%`;

		const reading = this.plugin.readingDataManager;
		const defaultStatus: ReadingStatus = reading.getSettings().defaultStatus ?? 'Plan to Read';

		const CHUNK_SIZE = 10;
		let added = 0;

		try {
			for (let chunkStart = 0; chunkStart < toImport.length; chunkStart += CHUNK_SIZE) {
				if (this.importCancelled) break;
				const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, toImport.length);

				if (this.kind === 'book') {
					const chunk: Book[] = [];
					for (let i = chunkStart; i < chunkEnd; i++) {
						if (this.importCancelled) break;
						chunk.push(this.buildBook(toImport[i]!.entry, defaultStatus));
					}
					if (chunk.length === 0) break;
					await reading.addBookBatch(chunk);
					added += chunk.length;
				} else {
					const chunk: Manga[] = [];
					for (let i = chunkStart; i < chunkEnd; i++) {
						if (this.importCancelled) break;
						chunk.push(this.buildManga(toImport[i]!.entry, defaultStatus));
					}
					if (chunk.length === 0) break;
					await reading.addMangaBatch(chunk);
					added += chunk.length;
				}

				const pct = Math.round((added / toImport.length) * 100);
				if (this.progressBarFill) this.progressBarFill.style.width = `${pct}%`;
				if (this.progressText) this.progressText.textContent = `${added} / ${toImport.length}`;
			}
		} finally {
			this.isImporting = false;
			reading.notifyChange();
		}

		if (this.importCancelled) {
			if (this.progressText) this.progressText.textContent = `Cancelled — ${added} / ${toImport.length} imported`;
			if (this.cancelBtn) { this.cancelBtn.disabled = false; this.cancelBtn.textContent = 'Close'; }
			new Notice(`Import cancelled. ${added} ${this.itemNoun}${added !== 1 ? 's' : ''} imported.`);
		} else {
			if (this.progressText) this.progressText.textContent = `Done — ${added} imported`;
			if (this.cancelBtn) { this.cancelBtn.disabled = false; this.cancelBtn.textContent = 'Close'; }
			new Notice(`Imported ${added} ${this.itemNoun}${added !== 1 ? 's' : ''}.`);
			this.close();
		}
	}
}
