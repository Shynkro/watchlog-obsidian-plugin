import { App, Modal } from 'obsidian';

export type ReadingCsvKind = 'book' | 'manga';

/**
 * Gate modal for Reading CSV import/export. Mirrors the "Add draft" choice modal
 * (title top-left, × top-right, a context line, equal-width horizontal buttons):
 * the user first picks Books or Manga, then the kind-specific Reading CSV modal opens.
 */
export class ReadingCsvChoiceModal extends Modal {
	constructor(
		app: App,
		private mode: 'export' | 'import',
		private onChoice: (kind: ReadingCsvKind) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('wl-draft-choice-modal');

		this.titleEl.setText(this.mode === 'export' ? 'Export to CSV' : 'Import from CSV');
		contentEl.createDiv({
			cls: 'wl-draft-choice-subtitle',
			text: this.mode === 'export'
				? 'Which library do you want to export?'
				: 'Which library do you want to import into?',
		});

		const grid = contentEl.createDiv({ cls: 'wl-draft-choice-grid' });

		const makeOption = (label: string, kind: ReadingCsvKind): void => {
			const btn = grid.createEl('button', { cls: 'wl-draft-choice-btn' });
			btn.createDiv({ cls: 'wl-draft-choice-label', text: label });
			btn.addEventListener('click', () => {
				this.close();
				this.onChoice(kind);
			});
		};

		makeOption('Books', 'book');
		makeOption('Manga', 'manga');
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
