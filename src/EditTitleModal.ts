import { App, Modal, Notice } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type { WatchLogTitle, Season } from './types';
import { formatDateDisplay, parseDateInput, parseReleaseDateInput } from './types';

/** Parses a seasons textarea (one line per season: "Name: N") back to Season[]. */
function parseSeasonsText(text: string): Season[] {
	const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
	const seasons: Season[] = [];
	let offset = 0;
	for (const line of lines) {
		const match = line.match(/^(.+?):\s*(\d+)/);
		if (match && match[1] && match[2]) {
			const eps = parseInt(match[2]);
			seasons.push({ name: match[1].trim(), episodes: eps, offset });
			offset += eps;
		}
	}
	return seasons;
}

function seasonsToText(seasons: Season[]): string {
	return seasons.map((s) => `${s.name}: ${s.episodes}`).join('\n');
}

export class EditTitleModal extends Modal {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private original: WatchLogTitle;
	private onSaved: () => void;

	// Editable state (mirrors all WatchLogTitle fields)
	private fieldTitle: string;
	private fieldType: string;
	private fieldEpisodes: number;
	private fieldDuration: number;
	private fieldReleaseDate: string;
	private fieldLink: string;
	private fieldSeasonsText: string;
	private fieldStatus: string;
	private fieldPriority: string;
	private fieldReview: string;
	private fieldRating: number;
	private fieldNotes: string;
	private fieldDateStarted: string;
	private fieldDateFinished: string;
	private skipDuplicateCheck = false;
	private duplicateWarningEl: HTMLElement | null = null;

	constructor(
		app: App,
		plugin: WatchLogPlugin,
		dataManager: DataManager,
		title: WatchLogTitle,
		onSaved: () => void,
	) {
		super(app);
		this.plugin = plugin;
		this.dataManager = dataManager;
		this.original = title;
		this.onSaved = onSaved;

		// Pre-populate from existing title
		this.fieldTitle = title.title;
		this.fieldType = title.type;
		this.fieldEpisodes = title.totalEpisodes;
		this.fieldDuration = title.episodeDuration;
		this.fieldReleaseDate = title.releaseDate ?? '';
		this.fieldLink = title.externalLink;
		this.fieldSeasonsText = seasonsToText(title.seasons);
		this.fieldStatus = title.status;
		this.fieldPriority = title.priority;
		this.fieldReview = (title as unknown as { review?: string }).review ?? '';
		this.fieldRating = title.rating;
		this.fieldNotes = title.notes;
		this.fieldDateStarted = title.dateStarted ?? '';
		this.fieldDateFinished = title.dateFinished ?? '';
	}

	onOpen(): void {
		this.titleEl.setText(`Edit: ${this.original.title}`);
		this.contentEl.addClass('wl-add-modal');
		this.buildUI();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private buildUI(): void {
		const content = this.contentEl;
		content.empty();

		const makeRow = (label: string): HTMLElement => {
			const row = content.createDiv({ cls: 'wl-modal-row' });
			row.createSpan({ cls: 'wl-modal-label', text: label });
			return row;
		};

		// Title
		const titleRow = makeRow('Title');
		const titleInput = titleRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text' },
		});
		titleInput.value = this.fieldTitle;
		titleInput.addEventListener('input', () => { this.fieldTitle = titleInput.value; });

		// Type
		const typeRow = makeRow('Type');
		const typeSelect = typeRow.createEl('select', { cls: 'wl-select' });
		for (const t of this.plugin.settings.types) {
			const opt = typeSelect.createEl('option', { text: t.name, value: t.name });
			if (t.name === this.fieldType) opt.selected = true;
		}
		typeSelect.addEventListener('change', () => { this.fieldType = typeSelect.value; });

		// Status — "To be released" is auto-assigned; show it only if title currently has it
		const statusRow = makeRow('Status');
		const statusSelect = statusRow.createEl('select', { cls: 'wl-select' });
		const showToBeReleased = this.fieldStatus === 'To be released';
		for (const s of this.plugin.settings.statuses) {
			if (s.name === 'To be released' && !showToBeReleased) continue;
			const opt = statusSelect.createEl('option', { text: s.name, value: s.name });
			if (s.name === this.fieldStatus) opt.selected = true;
		}
		statusSelect.addEventListener('change', () => { this.fieldStatus = statusSelect.value; });

		// Priority
		const priRow = makeRow('Priority');
		const priSelect = priRow.createEl('select', { cls: 'wl-select' });
		for (const p of this.plugin.settings.priorities) {
			const opt = priSelect.createEl('option', { text: p.name, value: p.name });
			if (p.name === this.fieldPriority) opt.selected = true;
		}
		priSelect.addEventListener('change', () => { this.fieldPriority = priSelect.value; });

		// Rating
		const ratingRow = makeRow('Rating');
		const starsWrap = ratingRow.createDiv({ cls: 'wl-stars' });
		const updateStarDisplay = (): void => {
			starsWrap.empty();
			for (let i = 1; i <= 5; i++) {
				const star = starsWrap.createSpan({
					cls: `wl-star${this.fieldRating >= i ? ' is-active' : ''}`,
					text: '★',
				});
				star.addEventListener('click', () => {
					this.fieldRating = this.fieldRating === i ? 0 : i;
					updateStarDisplay();
				});
			}
		};
		updateStarDisplay();

		// Episodes
		const epsRow = makeRow('Total episodes');
		const epsInput = epsRow.createEl('input', {
			cls: 'wl-modal-input wl-modal-input-sm',
			attr: { type: 'number', min: '0' },
		});
		epsInput.value = String(this.fieldEpisodes);
		epsInput.addEventListener('input', () => { this.fieldEpisodes = parseInt(epsInput.value) || 0; });

		// Duration
		const durRow = makeRow('Ep. duration (min)');
		const durInput = durRow.createEl('input', {
			cls: 'wl-modal-input wl-modal-input-sm',
			attr: { type: 'number', min: '0' },
		});
		durInput.value = String(this.fieldDuration);
		durInput.addEventListener('input', () => { this.fieldDuration = parseInt(durInput.value) || 0; });

		// Release date
		const relRow = makeRow('Release date');
		const relStack = relRow.createDiv({ cls: 'wl-modal-input-stack' });
		const relInput = relStack.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: 'Date (dd-mm-yyyy or yyyy-mm-dd)' },
		});
		relInput.value = this.fieldReleaseDate;
		const relErrorEl = relStack.createDiv({ cls: 'wl-modal-error wl-hidden' });
		relInput.addEventListener('change', () => {
			const raw = relInput.value.trim();
			if (!raw) {
				this.fieldReleaseDate = '';
				relErrorEl.addClass('wl-hidden');
				return;
			}
			const parsed = parseReleaseDateInput(raw);
			if (parsed) {
				this.fieldReleaseDate = parsed;
				relInput.value = parsed;
				relErrorEl.addClass('wl-hidden');
			} else {
				this.fieldReleaseDate = raw;
				relErrorEl.textContent = 'Unrecognised format. Expected dd/mm/yyyy or yyyy-mm-dd.';
				relErrorEl.removeClass('wl-hidden');
			}
		});

		// External link
		const linkRow = makeRow('External link');
		const linkInput = linkRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'url', placeholder: 'HTTPS://...' },
		});
		linkInput.value = this.fieldLink;
		linkInput.addEventListener('input', () => { this.fieldLink = linkInput.value; });

		// Date started
		const startRow = makeRow('Date started');
		const startInput = startRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: 'Dd/mm/yyyy', maxlength: '10' },
		});
		startInput.value = formatDateDisplay(this.fieldDateStarted);
		startInput.addEventListener('change', () => {
			const parsed = parseDateInput(startInput.value);
			if (startInput.value.trim() && !parsed) {
				startInput.addClass('wl-input-error');
			} else {
				startInput.removeClass('wl-input-error');
				this.fieldDateStarted = parsed ?? '';
			}
		});

		// Date finished
		const finRow = makeRow('Date finished');
		const finInput = finRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'text', placeholder: 'Dd/mm/yyyy', maxlength: '10' },
		});
		finInput.value = formatDateDisplay(this.fieldDateFinished);
		finInput.addEventListener('change', () => {
			const parsed = parseDateInput(finInput.value);
			if (finInput.value.trim() && !parsed) {
				finInput.addClass('wl-input-error');
			} else {
				finInput.removeClass('wl-input-error');
				this.fieldDateFinished = parsed ?? '';
			}
		});

		// Notes
		const notesRow = makeRow('Notes');
		const notesInput = notesRow.createEl('textarea', {
			cls: 'wl-modal-textarea',
			attr: { rows: '3', placeholder: 'Your notes...' },
		});
		notesInput.value = this.fieldNotes;
		notesInput.addEventListener('input', () => { this.fieldNotes = notesInput.value; });

		// Seasons
		const seasonsRow = makeRow('Seasons');
		const seasonsHelp = seasonsRow.createDiv({ cls: 'wl-modal-input-stack' });
		const seasonsInput = seasonsHelp.createEl('textarea', {
			cls: 'wl-modal-textarea',
			attr: { rows: '4', placeholder: 'Season 1: 12\nseason 2: 13' },
		});
		seasonsInput.value = this.fieldSeasonsText;

		const totalPreviewEl = seasonsHelp.createDiv({ cls: 'wl-modal-season-total' });
		const updateTotalPreview = (): void => {
			const parsed = parseSeasonsText(seasonsInput.value);
			const total = parsed.reduce((sum, s) => sum + s.episodes, 0);
			totalPreviewEl.textContent = `Total episodes: ${total}`;
		};
		updateTotalPreview();

		seasonsInput.addEventListener('input', () => {
			this.fieldSeasonsText = seasonsInput.value;
			updateTotalPreview();
		});

		seasonsHelp.createDiv({
			cls: 'wl-modal-info',
			text: 'One per line: "Season Name: N" (e.g. "Season 1: 12")',
		});
		seasonsHelp.createDiv({
			cls: 'wl-modal-info',
			text: 'Note: when adding a new season, remember to update "Total Episodes" so progress calculates correctly.',
		});

		// Save / Cancel
		const btnRow = content.createDiv({ cls: 'wl-modal-btn-row' });
		const cancelBtn = btnRow.createEl('button', { cls: 'wl-btn', text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		const saveBtn = btnRow.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Save changes' });
		saveBtn.addEventListener('click', () => void this.saveTitle());
	}

	private showDuplicateWarning(titleName: string, btnRow: HTMLElement): void {
		if (this.duplicateWarningEl) return;
		const warn = btnRow.createDiv({ cls: 'wl-duplicate-warning' });
		this.duplicateWarningEl = warn;
		warn.createSpan({ text: `"${titleName}" already exists. Save anyway?` });
		const continueBtn = warn.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Continue' });
		const cancelBtn = warn.createEl('button', { cls: 'wl-btn', text: 'Cancel' });
		continueBtn.addEventListener('click', () => {
			this.skipDuplicateCheck = true;
			warn.remove();
			this.duplicateWarningEl = null;
			void this.saveTitle();
		});
		cancelBtn.addEventListener('click', () => {
			warn.remove();
			this.duplicateWarningEl = null;
			this.skipDuplicateCheck = false;
		});
	}

	private async saveTitle(): Promise<void> {
		const titleName = this.fieldTitle.trim();
		if (!titleName) {
			new Notice('Title name cannot be empty.');
			return;
		}

		if (!this.skipDuplicateCheck) {
			const duplicate = this.dataManager.getTitles().find(
				(t) => t.id !== this.original.id && t.title.toLowerCase() === titleName.toLowerCase()
			);
			if (duplicate) {
				const btnRow = this.contentEl.querySelector<HTMLElement>('.wl-modal-btn-row');
				if (btnRow) this.showDuplicateWarning(titleName, btnRow);
				return;
			}
		}
		this.skipDuplicateCheck = false;

		const seasons = parseSeasonsText(this.fieldSeasonsText);
		const newReleaseDate = this.fieldReleaseDate || null;

		const updated: WatchLogTitle = {
			...this.original,
			title: titleName,
			type: this.fieldType,
			status: this.fieldStatus,
			priority: this.fieldPriority,
			review: this.fieldReview,
			rating: this.fieldRating,
			notes: this.fieldNotes,
			totalEpisodes: this.fieldEpisodes,
			episodeDuration: this.fieldDuration,
			releaseDate: newReleaseDate,
			externalLink: this.fieldLink,
			seasons,
			dateStarted: this.fieldDateStarted || null,
			dateFinished: this.fieldDateFinished || null,
		};

		// Auto-mark all episodes watched when status is set to Completed
		if (updated.status === 'Completed' && updated.totalEpisodes > 0) {
			updated.watchedEpisodes = Array.from({ length: updated.totalEpisodes }, (_, i) => i + 1);
		}

		await this.dataManager.updateTitle(updated);

		// Bug 2: sync updated releaseDate to any existing 'once' airtime entry
		const allEntries = this.dataManager.getAirtimeEntries();
		const existingAirtimeEntry = allEntries.find((e) => e.titleId === updated.id);
		if (existingAirtimeEntry && existingAirtimeEntry.schedule.recurrence === 'once') {
			const newDateForEntry = newReleaseDate ?? undefined;
			if (existingAirtimeEntry.schedule.releaseDate !== newDateForEntry) {
				existingAirtimeEntry.schedule.releaseDate = newDateForEntry;
				await this.dataManager.updateAirtimeEntry(existingAirtimeEntry);
			}
		}

		// ── handle releaseDate changes ───────────────────────────────────────────────
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const isFullDate = (d: string | null): d is string =>
			d !== null && /^\d{4}-\d{2}-\d{2}$/.test(d);

		if (isFullDate(newReleaseDate)) {
			const releaseMs = new Date(newReleaseDate + 'T12:00:00').getTime();
			const isFuture = releaseMs > today.getTime();

			if (isFuture) {
				if (updated.status !== 'To be released') {
					updated.status = 'To be released';
					await this.dataManager.updateTitle(updated);
				}
				// Auto-add to Upcoming if not already there
				const entries = this.dataManager.getAirtimeEntries();
				const alreadyInUpcoming = entries.some((e) => e.titleId === updated.id);
				if (!alreadyInUpcoming) {
					await this.dataManager.autoAddToUpcoming(updated);
				}
			} else {
				// Date is past/today — revert "To be released" status
				if (updated.status === 'To be released') {
					updated.status = 'Plan to watch';
					await this.dataManager.updateTitle(updated);
					await this.dataManager.removeAirtimeEntriesForTitle(updated.id);
				}
			}
		} else if (!newReleaseDate && updated.status === 'To be released') {
			// Date cleared — revert "To be released" status
			updated.status = 'Plan to watch';
			await this.dataManager.updateTitle(updated);
			await this.dataManager.removeAirtimeEntriesForTitle(updated.id);
		}

		new Notice(`"${titleName}" updated.`);
		this.close();
		this.onSaved();
	}
}
