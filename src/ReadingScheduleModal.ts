import { App, Modal, Notice } from 'obsidian';
import type { Book, Manga, AirtimeSchedule, AirtimeRecurrence } from './types';
import { parseDateInput } from './types';

/**
 * Schedule modal for Reading titles (Books & Manga). Derived from the watchlist
 * AirtimeScheduleModal's series branch — same recurrence + auto-increment logic —
 * but with:
 *  - no "Time (HH:MM)" field,
 *  - chapter/volume counters instead of episode/season counters.
 *
 * The four counters map onto the shared AirtimeEntry slots in AirtimeTab:
 *   current volume  ↔ currentSeason   total volumes  ↔ totalSeasons
 *   current chapter ↔ currentEpisode  total chapters ↔ totalEpisodes
 * so reading entries reuse the existing scheduler/countdown machinery unchanged.
 */
export class ReadingScheduleModal extends Modal {
	private item: Book | Manga;
	private kind: 'book' | 'manga';
	private schedule: AirtimeSchedule;
	private currentVolume: number | null;
	private currentChapter: number | null;
	private totalVolumes: number | null;
	private totalChapters: number | null;
	private onSave: (
		schedule: AirtimeSchedule,
		volume: number | null,
		chapter: number | null,
		totalVolumes: number | null,
		totalChapters: number | null,
	) => Promise<void>;

	constructor(
		app: App,
		item: Book | Manga,
		kind: 'book' | 'manga',
		existingSchedule: AirtimeSchedule | null,
		currentVolume: number | null,
		currentChapter: number | null,
		totalVolumes: number | null,
		totalChapters: number | null,
		onSave: (
			schedule: AirtimeSchedule,
			volume: number | null,
			chapter: number | null,
			totalVolumes: number | null,
			totalChapters: number | null,
		) => Promise<void>,
	) {
		super(app);
		this.item = item;
		this.kind = kind;
		this.schedule = existingSchedule ? { ...existingSchedule } : { recurrence: 'once' };
		// Time is never used for reading; strip any inherited value.
		this.schedule.releaseTime = undefined;
		// Pre-fill releaseDate from the item if the schedule doesn't have one yet.
		if (!this.schedule.releaseDate && item.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(item.releaseDate)) {
			this.schedule.releaseDate = item.releaseDate;
		}
		this.currentVolume = currentVolume;
		this.currentChapter = currentChapter;
		// Pre-fill totals from the item's tracked counts if not yet set.
		const itemTotalChapters = item.totalChapters ?? 0;
		const itemTotalVolumes = kind === 'manga' ? ((item as Manga).totalVolumes ?? 0) : 0;
		this.totalChapters = totalChapters ?? (itemTotalChapters > 0 ? itemTotalChapters : null);
		this.totalVolumes = totalVolumes ?? (itemTotalVolumes > 0 ? itemTotalVolumes : null);
		this.onSave = onSave;
	}

	onOpen(): void {
		this.titleEl.setText('Set reading schedule');
		this.contentEl.addClass('wl-add-modal');
		this.renderForm();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderForm(): void {
		this.contentEl.empty();
		this.contentEl.addClass('wl-add-modal');
		const content = this.contentEl;

		const makeRow = (label: string): HTMLElement => {
			const row = content.createDiv({ cls: 'wl-modal-row' });
			row.createSpan({ cls: 'wl-modal-label', text: label });
			return row;
		};

		const makeNumberRow = (
			label: string,
			value: number | null,
			placeholder: string,
			onInput: (v: number | null) => void,
		): void => {
			const row = makeRow(label);
			const inp = row.createEl('input', {
				cls: 'wl-modal-input wl-modal-input-sm',
				attr: { type: 'number', min: '0', placeholder },
			});
			if (value !== null) inp.value = String(value);
			inp.addEventListener('input', () => { onInput(parseInt(inp.value) || null); });
		};

		// ── Recurrence (no time field) ──────────────────────────────────────────────
		const recRow = makeRow('Recurrence');
		const recSelect = recRow.createEl('select', { cls: 'wl-select' });
		const recOptions: Array<[AirtimeRecurrence, string]> = [
			['once', 'Once'],
			['daily', 'Daily'],
			['weekly', 'Weekly'],
			['monthly', 'Monthly'],
		];
		for (const [val, label] of recOptions) {
			const opt = recSelect.createEl('option', { text: label, value: val });
			if (val === this.schedule.recurrence) opt.selected = true;
		}

		const extraEl = content.createDiv();
		const renderExtra = (): void => {
			extraEl.empty();
			const rec = this.schedule.recurrence;

			if (rec === 'once') {
				const r = extraEl.createDiv({ cls: 'wl-modal-row' });
				r.createSpan({ cls: 'wl-modal-label', text: 'Date' });
				const inp = r.createEl('input', {
					cls: 'wl-modal-input',
					attr: { type: 'text', placeholder: 'Dd/mm/yyyy', maxlength: '10' },
				});
				inp.value = this.schedule.releaseDate
					? this.schedule.releaseDate.split('-').reverse().join('/')
					: '';
				inp.addEventListener('change', () => {
					const parsed = parseDateInput(inp.value);
					if (parsed) this.schedule.releaseDate = parsed;
				});
			}

			if (rec === 'weekly') {
				const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
				const r = extraEl.createDiv({ cls: 'wl-modal-row' });
				r.createSpan({ cls: 'wl-modal-label', text: 'Day of week' });
				const daySelect = r.createEl('select', { cls: 'wl-select' });
				DAYS.forEach((d, i) => {
					const opt = daySelect.createEl('option', { text: d, value: String(i) });
					if (i === (this.schedule.dayOfWeek ?? 6)) opt.selected = true;
				});
				daySelect.addEventListener('change', () => {
					this.schedule.dayOfWeek = parseInt(daySelect.value);
				});
			}

			if (rec === 'monthly') {
				const r = extraEl.createDiv({ cls: 'wl-modal-row' });
				r.createSpan({ cls: 'wl-modal-label', text: 'Day of month' });
				const inp = r.createEl('input', {
					cls: 'wl-modal-input wl-modal-input-sm',
					attr: { type: 'number', min: '1', max: '31', placeholder: '1' },
				});
				inp.value = String(this.schedule.dayOfMonth ?? 1);
				inp.addEventListener('input', () => { this.schedule.dayOfMonth = parseInt(inp.value) || 1; });
			}
		};

		recSelect.addEventListener('change', () => {
			this.schedule.recurrence = recSelect.value as AirtimeRecurrence;
			renderExtra();
		});
		renderExtra();

		// ── Chapter / volume counters ───────────────────────────────────────────────
		// Books typically use only chapters; Manga use chapters + volumes. The user
		// fills whichever applies and leaves the rest empty.
		makeNumberRow('Current chapter', this.currentChapter, 'E.g. 12', (v) => { this.currentChapter = v; });
		makeNumberRow('Current volume', this.currentVolume, 'E.g. 2', (v) => { this.currentVolume = v; });
		makeNumberRow('Total chapters', this.totalChapters, 'E.g. 120', (v) => { this.totalChapters = v; });
		makeNumberRow('Total volumes', this.totalVolumes, 'E.g. 12', (v) => { this.totalVolumes = v; });

		// Static hint note (adapted for reading).
		content.createDiv({
			cls: 'wl-modal-info wl-schedule-hint',
			text: 'Titles with 0 or 1 total chapters will be treated as a single release date, like a book.',
		});

		// ── Buttons ─────────────────────────────────────────────────────────────────
		const btnRow = content.createDiv({ cls: 'wl-modal-btn-row' });
		const cancelBtn = btnRow.createEl('button', { cls: 'wl-btn wl-btn-mr', text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const saveBtn = btnRow.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Save' });
		saveBtn.addEventListener('click', () => {
			void (async () => {
				if (this.schedule.recurrence === 'once' && !this.schedule.releaseDate) {
					new Notice('Set a release date.');
					return;
				}
				await this.onSave(
					this.schedule,
					this.currentVolume,
					this.currentChapter,
					this.totalVolumes,
					this.totalChapters,
				);
				this.close();
			})();
		});
	}
}
