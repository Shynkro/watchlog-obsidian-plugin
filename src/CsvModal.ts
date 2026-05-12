import { App, Modal, Notice } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type { WatchLogTitle } from './types';

// ── CSV helpers ───────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
	'title', 'type', 'status', 'priority', 'rating',
	'totalEpisodes', 'episodeDuration',
	'dateStarted', 'dateFinished', 'releaseDate', 'dateAdded',
	'externalLink', 'notes',
] as const;

function escapeCsvField(value: string | number | null | undefined): string {
	const s = String(value ?? '');
	if (s.includes(',') || s.includes('"') || s.includes('\n')) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

function titlesToCsv(titles: WatchLogTitle[]): string {
	const header = CSV_COLUMNS.join(',');
	const rows = titles.map((t) =>
		CSV_COLUMNS.map((col) => escapeCsvField((t as unknown as Record<string, string | number | null | undefined>)[col])).join(',')
	);
	return [header, ...rows].join('\n');
}

function parseCsvRow(row: string): string[] {
	const fields: string[] = [];
	let cur = '';
	let inQuotes = false;
	for (let i = 0; i < row.length; i++) {
		const ch = row[i];
		if (ch === '"') {
			if (inQuotes && row[i + 1] === '"') {
				cur += '"';
				i++;
			} else {
				inQuotes = !inQuotes;
			}
		} else if (ch === ',' && !inQuotes) {
			fields.push(cur);
			cur = '';
		} else {
			cur += ch;
		}
	}
	fields.push(cur);
	return fields;
}

// ── Date parsing ─────────────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
	jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Parses a date string in any common format and returns YYYY-MM-DD, or null if unparseable. */
function parseCsvDate(raw: string): string | null {
	const s = raw.trim();
	if (!s) return null;
	try {
		// YYYY-MM-DD (already in storage format)
		if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

		// D/M/YYYY, DD/MM/YYYY, M/D/YYYY, MM/DD/YYYY
		const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
		if (slash) {
			const a = parseInt(slash[1]!), b = parseInt(slash[2]!), y = parseInt(slash[3]!);
			let dd: number, mm: number;
			if (a > 12)      { dd = a; mm = b; }  // Must be DD/MM
			else if (b > 12) { mm = a; dd = b; }  // Must be MM/DD
			else             { dd = a; mm = b; }  // Ambiguous → assume DD/MM
			if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
			return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
		}

		// "27 Jun 2025" (DD Mon YYYY)
		const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
		if (dmy) {
			const mm = MONTH_NAMES[dmy[2]!.toLowerCase().slice(0, 3)];
			const dd = parseInt(dmy[1]!), y = parseInt(dmy[3]!);
			if (mm) return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
		}

		// "Jun 27, 2025" or "Jun 27 2025" (Mon DD YYYY)
		const mdy = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
		if (mdy) {
			const mm = MONTH_NAMES[mdy[1]!.toLowerCase().slice(0, 3)];
			const dd = parseInt(mdy[2]!), y = parseInt(mdy[3]!);
			if (mm) return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
		}

		// DD.MM.YYYY or DD-MM-YYYY (dot/dash with year at end)
		const dotDash = s.match(/^(\d{1,2})[.-](\d{1,2})[.-](\d{4})$/);
		if (dotDash) {
			const dd = parseInt(dotDash[1]!), mm = parseInt(dotDash[2]!), y = parseInt(dotDash[3]!);
			if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)
				return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
		}

		// Fallback: native Date.parse
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

// ── Field mapping definitions ────────────────────────────────────────────────

interface WlFieldDef {
	key: string;
	label: string;
	autoDetect: string[];
}

const WL_IMPORT_FIELDS: WlFieldDef[] = [
	{ key: 'title',          label: 'Name',          autoDetect: ['title', 'name'] },
	{ key: 'type',           label: 'Type',          autoDetect: ['type'] },
	{ key: 'status',         label: 'Status',        autoDetect: ['status'] },
	{ key: 'priority',       label: 'Priority',      autoDetect: ['priority'] },
	{ key: 'rating',         label: 'Rating',        autoDetect: ['rating', 'score'] },
	{ key: 'totalEpisodes',  label: 'Episodes',      autoDetect: ['episodes', 'totalepisodes', 'total episodes', 'episode count', 'ep count'] },
	{ key: 'episodeDuration',label: 'Duration (min)',autoDetect: ['duration', 'episodeduration', 'episode duration', 'minutes', 'runtime'] },
	{ key: 'dateStarted',    label: 'Date Started',  autoDetect: ['started', 'datestarted', 'date started', 'date_started', 'start date'] },
	{ key: 'dateFinished',   label: 'Date Finished', autoDetect: ['finished', 'datefinished', 'date finished', 'date_finished', 'end date', 'finish date', 'completed date'] },
	{ key: 'releaseDate',    label: 'Release Date',  autoDetect: ['releasedate', 'release date', 'release_date', 'air date', 'airdate'] },
	{ key: 'externalLink',   label: 'Link',          autoDetect: ['link', 'externallink', 'external link', 'external_link', 'url'] },
];

function autoMap(headers: string[]): Record<string, string> {
	const mapping: Record<string, string> = {};
	for (const field of WL_IMPORT_FIELDS) {
		const match = headers.find((h) => field.autoDetect.includes(h.toLowerCase()));
		mapping[field.key] = match ?? '';
	}
	return mapping;
}

function applyMapping(
	lines: string[],
	mapping: Record<string, string>,
	dataManager: DataManager,
): { entry: Partial<WatchLogTitle>; isDuplicate: boolean }[] {
	if (lines.length < 2) return [];
	const headerLine = lines[0] ?? '';
	const headers = parseCsvRow(headerLine).map((h) => h.trim());
	const existingTitles = dataManager.getTitles();

	return lines.slice(1)
		.filter((l) => l.trim())
		.map((line) => {
			const values = parseCsvRow(line);
			const get = (fieldKey: string): string => {
				const colName = mapping[fieldKey];
				if (!colName) return '';
				const idx = headers.indexOf(colName);
				return idx >= 0 ? (values[idx] ?? '').trim() : '';
			};

			const entry: Partial<WatchLogTitle> = {};

			const titleVal = get('title');
			if (titleVal) entry.title = titleVal;
			const typeVal = get('type');
			if (typeVal) entry.type = typeVal;
			const statusVal = get('status');
			if (statusVal) entry.status = statusVal;
			const priorityVal = get('priority');
			if (priorityVal) entry.priority = priorityVal;
			const ratingVal = get('rating');
			if (ratingVal) entry.rating = parseFloat(ratingVal) || 0;
			const epsVal = get('totalEpisodes');
			if (epsVal) entry.totalEpisodes = parseInt(epsVal) || 0;
			const durVal = get('episodeDuration');
			if (durVal) entry.episodeDuration = parseInt(durVal) || 0;
			const startedRaw = get('dateStarted');
			if (startedRaw) { const d = parseCsvDate(startedRaw); if (d) entry.dateStarted = d; }
			const finishedRaw = get('dateFinished');
			if (finishedRaw) { const d = parseCsvDate(finishedRaw); if (d) entry.dateFinished = d; }
			const releaseDateRaw = get('releaseDate');
			if (releaseDateRaw) { const d = parseCsvDate(releaseDateRaw); if (d) entry.releaseDate = d; }
			const linkVal = get('externalLink');
			if (linkVal) entry.externalLink = linkVal;

			// Skip rows where all mapped fields resolved to empty
			const isEmpty = !entry.title?.trim() && !entry.type && !entry.status
				&& !entry.rating && !entry.totalEpisodes && !entry.episodeDuration
				&& !entry.dateStarted && !entry.dateFinished && !entry.releaseDate && !entry.externalLink;
			if (isEmpty) return null;

			const isDuplicate = !!existingTitles.find(
				(t) => t.title.toLowerCase() === (entry.title ?? '').toLowerCase()
			);
			return { entry, isDuplicate };
		})
		.filter((r): r is { entry: Partial<WatchLogTitle>; isDuplicate: boolean } => r !== null);
}

// Sentinel for "create new type" in value mapping
const CREATE_NEW_TYPE = '__create__';

// Theme-aware random colors for auto-created types
const TYPE_AUTO_COLORS: Record<string, string[]> = {
	default:   ['#6366F1', '#8B5CF6', '#EC4899', '#14B8A6', '#F59E0B', '#10B981', '#3B82F6', '#EF4444'],
	nightfall: ['#7B2CBF', '#9D4EDD', '#C77DFF', '#5A189A', '#E040FB', '#B388FF', '#CE93D8', '#9C27B0'],
	bluez:     ['#2C7DA0', '#468FAF', '#61A5C2', '#1B6A8A', '#0077B6', '#00B4D8', '#48CAE4', '#90E0EF'],
};

function randomAutoColor(theme: string): string {
	const palette = TYPE_AUTO_COLORS[theme] ?? TYPE_AUTO_COLORS['default']!;
	return palette[Math.floor(Math.random() * palette.length)] ?? '#888780';
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export class CsvModal extends Modal {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private mode: 'export' | 'import';

	// Export state
	private selectedIds = new Set<string>();

	// Import state — shared across steps
	private csvLines: string[] = [];
	private csvHeaders: string[] = [];
	private columnMapping: Record<string, string> = {};
	private importRows: { entry: Partial<WatchLogTitle>; isDuplicate: boolean; selected: boolean }[] = [];

	// Value mapping state
	private statusValueMap: Record<string, string> = {};  // csvValue → resolved status ('' = leave blank)
	private typeValueMap: Record<string, string> = {};    // csvValue → resolved type ('' = blank, CREATE_NEW_TYPE = create)
	private ratingValueMap: Record<string, string> = {};  // csvValue → '1'–'5' or '' (leave blank)

	// Step containers
	private stepUpload: HTMLElement | null = null;
	private stepMapping: HTMLElement | null = null;
	private stepValueMap: HTMLElement | null = null;
	private stepPreview: HTMLElement | null = null;
	private importBtn: HTMLButtonElement | null = null;
	private cancelBtn: HTMLButtonElement | null = null;

	// Import progress state
	private isImporting = false;
	private importCancelled = false;
	private progressWrap: HTMLElement | null = null;
	private progressBarFill: HTMLElement | null = null;
	private progressText: HTMLElement | null = null;

	constructor(
		app: App,
		plugin: WatchLogPlugin,
		dataManager: DataManager,
		mode: 'export' | 'import',
	) {
		super(app);
		this.plugin = plugin;
		this.dataManager = dataManager;
		this.mode = mode;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('wl-csv-modal');

		if (this.mode === 'export') {
			this.renderExport(contentEl);
		} else {
			this.renderImport(contentEl);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// ── Export ────────────────────────────────────────────────────────────────────

	private renderExport(el: HTMLElement): void {
		el.createEl('h2', { cls: 'wl-modal-title', text: 'Export to CSV' });

		const titles = this.dataManager.getTitles();
		titles.forEach((t) => this.selectedIds.add(t.id));

		const ctrlRow = el.createDiv({ cls: 'wl-csv-ctrl-row' });
		const selectAllBtn = ctrlRow.createEl('button', { cls: 'wl-btn', text: 'Select all' });
		const selectNoneBtn = ctrlRow.createEl('button', { cls: 'wl-btn', text: 'Select none' });
		const countEl = ctrlRow.createSpan({ cls: 'wl-csv-count', text: `${titles.length} selected` });

		const listEl = el.createDiv({ cls: 'wl-csv-list' });
		const checkboxes: HTMLInputElement[] = [];

		const updateCount = (): void => {
			countEl.textContent = `${this.selectedIds.size} selected`;
		};

		for (const title of titles) {
			const row = listEl.createDiv({ cls: 'wl-csv-row' });
			const cb = row.createEl('input', { attr: { type: 'checkbox' } });
			cb.checked = true;
			checkboxes.push(cb);
			row.createSpan({ cls: 'wl-csv-row-title', text: title.title });
			row.createSpan({ cls: 'wl-csv-row-meta', text: `${title.type} · ${title.status}` });

			cb.addEventListener('change', () => {
				if (cb.checked) this.selectedIds.add(title.id);
				else this.selectedIds.delete(title.id);
				updateCount();
			});
		}

		selectAllBtn.addEventListener('click', () => {
			titles.forEach((t) => this.selectedIds.add(t.id));
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
			const toExport = titles.filter((t) => this.selectedIds.has(t.id));
			if (toExport.length === 0) {
				new Notice('No titles selected.');
				return;
			}
			const csv = titlesToCsv(toExport);
			const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
			const url = URL.createObjectURL(blob);
			const a = (activeDocument ?? document).createElement('a');
			const today = new Date();
			const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
			a.href = url;
			a.download = `watchlog-export-${dateStr}.csv`;
			a.click();
			URL.revokeObjectURL(url);
			new Notice(`Exported ${toExport.length} titles.`);
			this.close();
		});
	}

	// ── Import ────────────────────────────────────────────────────────────────────

	private renderImport(el: HTMLElement): void {
		el.createEl('h2', { cls: 'wl-modal-title', text: 'Import from CSV' });

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

		// Background-import note (hidden until import starts)
		this.progressWrap = btnRow.createDiv({ cls: 'wl-csv-progress-wrap' });
		this.progressWrap.hide();
		this.progressWrap.createSpan({ cls: 'wl-csv-bg-note', text: 'You can close this window — import will continue in the background.' });
		const progressTrack = this.progressWrap.createDiv({ cls: 'wl-csv-progress-track' });
		this.progressBarFill = progressTrack.createDiv({ cls: 'wl-csv-progress-fill' });
		this.progressText = this.progressWrap.createSpan({ cls: 'wl-csv-progress-text', text: '0 / 0' });

		this.cancelBtn = btnRow.createEl('button', { cls: 'wl-btn', text: 'Cancel' });
		this.importBtn = btnRow.createEl('button', {
			cls: 'wl-btn wl-btn-primary',
			text: 'Import selected',
		});
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
				this.csvLines = text.split('\n');
				const headerLine = this.csvLines[0] ?? '';
				this.csvHeaders = parseCsvRow(headerLine).map((h) => h.trim());
				this.columnMapping = autoMap(this.csvHeaders);
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
			text: 'Match each WatchLog field to a column from your CSV. Select "Skip" to leave a field empty.',
		});
		el.createDiv({
			cls: 'wl-csv-info-note',
			text: 'Rows with empty fields will be skipped automatically. If you see missing titles, check that your CSV has no empty rows at the top.',
		});

		const SKIP_VALUE = '';
		const grid = el.createDiv({ cls: 'wl-csv-map-grid' });
		const selectEls: Record<string, HTMLSelectElement> = {};

		for (const field of WL_IMPORT_FIELDS) {
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

		const previewBtn = el.createEl('button', {
			cls: 'wl-btn wl-btn-primary wl-csv-preview-btn',
			text: 'Next →',
		});
		previewBtn.addEventListener('click', () => {
			for (const field of WL_IMPORT_FIELDS) {
				this.columnMapping[field.key] = selectEls[field.key]?.value ?? '';
			}
			// Parse rows with current column mapping
			this.importRows = applyMapping(this.csvLines, this.columnMapping, this.dataManager)
				.map((r) => ({ ...r, selected: !r.isDuplicate }));

			// Check for unknown status/type values and non-numeric ratings
			const existingStatusNames = new Set(this.plugin.settings.statuses.map((s) => s.name));
			const existingTypeNames = new Set(this.plugin.settings.types.map((t) => t.name));

			const unknownStatuses: string[] = [];
			const unknownTypes: string[] = [];
			const unknownRatings: string[] = [];
			const seenStatuses = new Set<string>();
			const seenTypes = new Set<string>();
			const seenRatings = new Set<string>();

			for (const r of this.importRows) {
				const sv = r.entry.status?.trim();
				if (sv && !existingStatusNames.has(sv) && !seenStatuses.has(sv)) {
					unknownStatuses.push(sv);
					seenStatuses.add(sv);
				}
				const tv = r.entry.type?.trim();
				if (tv && !existingTypeNames.has(tv) && !seenTypes.has(tv)) {
					unknownTypes.push(tv);
					seenTypes.add(tv);
				}
				// Detect non-numeric rating values (r.entry.rating would be 0 from parseFloat on non-numeric)
				const ratingColName = this.columnMapping['rating'];
				if (ratingColName) {
					const headerLine = this.csvLines[0] ?? '';
					const headers = parseCsvRow(headerLine).map((h) => h.trim());
					const ratingIdx = headers.indexOf(ratingColName);
					if (ratingIdx >= 0) {
						const lineIdx = this.importRows.indexOf(r);
						const rawLine = this.csvLines[lineIdx + 1] ?? '';
						const rawValues = parseCsvRow(rawLine);
						const rawRating = (rawValues[ratingIdx] ?? '').trim();
						if (rawRating && isNaN(parseFloat(rawRating)) && !seenRatings.has(rawRating)) {
							unknownRatings.push(rawRating);
							seenRatings.add(rawRating);
						}
					}
				}
			}

			if (unknownStatuses.length > 0 || unknownTypes.length > 0 || unknownRatings.length > 0) {
				this.showValueMapStep(unknownStatuses, unknownTypes, unknownRatings);
			} else {
				this.showPreviewStep();
			}
		});
	}

	// ── Step: Value Mapping ───────────────────────────────────────────────────────

	private showValueMapStep(unknownStatuses: string[], unknownTypes: string[], unknownRatings: string[] = []): void {
		if (!this.stepMapping || !this.stepValueMap) return;
		this.stepMapping.hide();
		this.stepValueMap.show();
		this.renderValueMapStep(this.stepValueMap, unknownStatuses, unknownTypes, unknownRatings);
	}

	private renderValueMapStep(el: HTMLElement, unknownStatuses: string[], unknownTypes: string[], unknownRatings: string[] = []): void {
		el.empty();
		el.createDiv({ cls: 'wl-csv-step-title', text: 'Map unknown values' });
		el.createDiv({
			cls: 'wl-csv-step-desc',
			text: 'Some values in your CSV were not recognized. Map each to an existing value, or choose how to handle it.',
		});

		const existingStatuses = this.plugin.settings.statuses.map((s) => s.name);
		const existingTypes = this.plugin.settings.types.map((t) => t.name);
		const statusSelects: Record<string, HTMLSelectElement> = {};
		const typeSelects: Record<string, HTMLSelectElement> = {};
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
				for (const name of existingStatuses) {
					sel.createEl('option', { value: name, text: name });
				}
				// Pre-fill with closest match (case-insensitive)
				const lc = sv.toLowerCase();
				const match = existingStatuses.find((s) => s.toLowerCase() === lc);
				if (match) sel.value = match;
			}
		}

		if (unknownTypes.length > 0) {
			el.createDiv({ cls: 'wl-csv-valmap-section-title', text: 'Type' });
			for (const tv of unknownTypes) {
				const row = el.createDiv({ cls: 'wl-csv-valmap-row' });
				row.createSpan({ cls: 'wl-csv-valmap-orig', text: `"${tv}"` });
				row.createSpan({ cls: 'wl-csv-valmap-arrow', text: '→' });
				const sel = row.createEl('select', { cls: 'wl-select wl-csv-valmap-select' });
				typeSelects[tv] = sel;
				sel.createEl('option', { value: '', text: '— leave blank —' });
				for (const name of existingTypes) {
					sel.createEl('option', { value: name, text: name });
				}
				sel.createEl('option', { value: CREATE_NEW_TYPE, text: '+ create new type' });
				// Pre-fill with closest match
				const lc = tv.toLowerCase();
				const match = existingTypes.find((t) => t.toLowerCase() === lc);
				if (match) sel.value = match;
				else sel.value = CREATE_NEW_TYPE;
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
		const confirmBtn = btnRow.createEl('button', {
			cls: 'wl-btn wl-btn-primary',
			text: 'Preview →',
		});

		backBtn.addEventListener('click', () => {
			if (!this.stepValueMap || !this.stepMapping) return;
			this.stepValueMap.hide();
			this.stepMapping.show();
		});

		confirmBtn.addEventListener('click', () => {
			// Collect mappings
			this.statusValueMap = {};
			for (const sv of unknownStatuses) {
				this.statusValueMap[sv] = statusSelects[sv]?.value ?? '';
			}
			this.typeValueMap = {};
			for (const tv of unknownTypes) {
				this.typeValueMap[tv] = typeSelects[tv]?.value ?? '';
			}
			this.ratingValueMap = {};
			for (const rv of unknownRatings) {
				this.ratingValueMap[rv] = ratingSelects[rv]?.value ?? '';
			}
			// Apply value maps to importRows
			this.applyValueMapsToRows();
			this.showPreviewStep();
		});
	}

	private applyValueMapsToRows(): void {
		for (const r of this.importRows) {
			// Status
			const sv = r.entry.status?.trim() ?? '';
			if (sv && Object.prototype.hasOwnProperty.call(this.statusValueMap, sv)) {
				const resolved = this.statusValueMap[sv] ?? '';
				r.entry.status = resolved || undefined;
			}
			// Type — keep CREATE_NEW_TYPE sentinel; doImport will handle it
			const tv = r.entry.type?.trim() ?? '';
			if (tv && Object.prototype.hasOwnProperty.call(this.typeValueMap, tv)) {
				const resolved = this.typeValueMap[tv] ?? '';
				if (resolved === CREATE_NEW_TYPE) {
					// keep original value, mark for creation
					r.entry.type = tv;
				} else {
					r.entry.type = resolved || undefined;
				}
			}
			// Rating — map non-numeric value to numeric
			const rawRatingKey = Object.keys(this.ratingValueMap).find((k) => {
				// Find if this row's original CSV rating matched this key
				const ratingColName = this.columnMapping['rating'];
				if (!ratingColName) return false;
				const headerLine = this.csvLines[0] ?? '';
				const headers = parseCsvRow(headerLine).map((h) => h.trim());
				const ratingIdx = headers.indexOf(ratingColName);
				if (ratingIdx < 0) return false;
				const rowIdx = this.importRows.indexOf(r);
				const rawLine = this.csvLines[rowIdx + 1] ?? '';
				const rawValues = parseCsvRow(rawLine);
				return (rawValues[ratingIdx] ?? '').trim() === k;
			});
			if (rawRatingKey !== undefined) {
				const resolved = this.ratingValueMap[rawRatingKey] ?? '';
				r.entry.rating = resolved ? parseInt(resolved) : 0;
			}

			// Re-check duplicate status after value resolution
			r.isDuplicate = !!this.dataManager.getTitles().find(
				(t) => t.title.toLowerCase() === (r.entry.title ?? '').toLowerCase()
			);
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
			// Go back to value-map step if it was shown, else column mapping
			const hadValueMap = Object.keys(this.statusValueMap).length > 0 || Object.keys(this.typeValueMap).length > 0 || Object.keys(this.ratingValueMap).length > 0;
			if (hadValueMap) {
				this.stepValueMap.show();
			} else {
				this.stepMapping.show();
			}
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
			const row = listEl.createDiv({
				cls: `wl-csv-row${r.isDuplicate ? ' wl-csv-row-dupe' : ''}`,
			});
			const cb = row.createEl('input', { attr: { type: 'checkbox' } });
			cb.checked = r.selected;
			checkboxes.push(cb);
			row.createSpan({ cls: 'wl-csv-row-title', text: r.entry.title ?? '(no title)' });
			const metaParts = [r.entry.type, r.entry.status].filter(Boolean).join(' · ');
			if (metaParts) row.createSpan({ cls: 'wl-csv-row-meta', text: metaParts });
			if (r.isDuplicate) {
				row.createSpan({ cls: 'wl-csv-dupe-badge', text: 'duplicate' });
			}
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

	// ── Import ────────────────────────────────────────────────────────────────────

	private async doImport(): Promise<void> {
		const toImport = this.importRows.filter((r) => r.selected && r.entry.title?.trim());
		if (toImport.length === 0) {
			new Notice('No titles selected to import.');
			return;
		}

		// Set up progress UI
		this.isImporting = true;
		this.importCancelled = false;
		if (this.importBtn) this.importBtn.disabled = true;
		if (this.cancelBtn) this.cancelBtn.textContent = 'Cancel import';
		if (this.progressWrap) this.progressWrap.show();
		if (this.progressText) this.progressText.textContent = `0 / ${toImport.length}`;
		if (this.progressBarFill) this.progressBarFill.style.width = `0%`;

		// Expose progress to the Watchlist header
		const cancelFn = (): void => { this.importCancelled = true; };
		this.plugin.importProgress = { current: 0, total: toImport.length, cancel: cancelFn };

		// Auto-create types marked CREATE_NEW_TYPE or not in existing types
		const theme = this.plugin.settings.colorTheme ?? 'default';
		const existingTypeNames = new Set(this.plugin.settings.types.map((t) => t.name.toLowerCase()));
		const typesToCreate = new Set<string>();

		for (const r of toImport) {
			const typeName = r.entry.type?.trim();
			if (typeName && !existingTypeNames.has(typeName.toLowerCase())) {
				typesToCreate.add(typeName);
			}
		}
		for (const [orig, resolved] of Object.entries(this.typeValueMap)) {
			if (resolved === CREATE_NEW_TYPE && !existingTypeNames.has(orig.toLowerCase())) {
				typesToCreate.add(orig);
			}
		}

		if (typesToCreate.size > 0) {
			for (const typeName of typesToCreate) {
				this.plugin.settings.types.push({ name: typeName, color: randomAutoColor(theme) });
			}
			await this.plugin.saveSettings();
		}

		const CHUNK_SIZE = 10;
		let added = 0;

		for (let chunkStart = 0; chunkStart < toImport.length; chunkStart += CHUNK_SIZE) {
			if (this.importCancelled) break;

			const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, toImport.length);
			for (let i = chunkStart; i < chunkEnd; i++) {
				if (this.importCancelled) break;

				const r = toImport[i]!;
				const titleName = r.entry.title!.trim();
				const entry: WatchLogTitle = {
					id: this.dataManager.generateId(titleName),
					title: titleName,
					type: r.entry.type?.trim() || this.plugin.settings.types[0]?.name || 'Anime',
					status: r.entry.status || 'Plan to watch',
					priority: r.entry.priority || 'Medium',
					review: '',
					rating: r.entry.rating ?? 0,
					notes: '',
					dateStarted: r.entry.dateStarted ?? null,
					dateFinished: r.entry.dateFinished ?? null,
					dateAdded: new Date().toISOString(),
					dateModified: new Date().toISOString(),
					totalEpisodes: r.entry.totalEpisodes ?? 0,
					episodeDuration: r.entry.episodeDuration ?? 0,
					releaseDate: r.entry.releaseDate ?? null,
					externalLink: r.entry.externalLink ?? '',
					seasons: [],
					watchedEpisodes: [],
				};

				if (entry.status === 'Completed' && entry.totalEpisodes > 0) {
					entry.watchedEpisodes = Array.from({ length: entry.totalEpisodes }, (_, k) => k + 1);
				}

				this.plugin.importProgress = { current: added + 1, total: toImport.length, cancel: cancelFn };
				await this.dataManager.addTitleSilent(entry);
				added++;

				const pct = Math.round((added / toImport.length) * 100);
				if (this.progressBarFill) this.progressBarFill.style.width = `${pct}%`;
				if (this.progressText) this.progressText.textContent = `${added} / ${toImport.length}`;
			}
		}

		this.isImporting = false;

		// Clear header progress bar and trigger a final UI refresh
		this.plugin.importProgress = null;
		this.dataManager.notifyChange();

		const newTypesMsg = typesToCreate.size > 0
			? ` (${typesToCreate.size} new type${typesToCreate.size !== 1 ? 's' : ''} created)`
			: '';

		if (this.importCancelled) {
			// Import was cancelled — stay open so user can see what was imported
			if (this.progressText) {
				this.progressText.textContent = `Cancelled — ${added} / ${toImport.length} imported`;
			}
			if (this.cancelBtn) {
				this.cancelBtn.disabled = false;
				this.cancelBtn.textContent = 'Close';
			}
			new Notice(`Import cancelled. ${added} title${added !== 1 ? 's' : ''} imported.`);
		} else {
			// All done — show success state, then close
			if (this.progressText) {
				this.progressText.textContent = `Done — ${added} imported`;
			}
			if (this.cancelBtn) {
				this.cancelBtn.disabled = false;
				this.cancelBtn.textContent = 'Close';
			}
			new Notice(`Imported ${added} title${added !== 1 ? 's' : ''}${newTypesMsg}.`);
			this.close();
		}
	}
}
