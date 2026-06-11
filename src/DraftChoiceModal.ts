import { App, Modal } from 'obsidian';

export type DraftAddChoice = 'watchlist' | 'book' | 'manga';

/**
 * Small choice modal shown when adding a draft. Offers three inline options
 * (Watchlist / Book / Manga), each routing to its own corresponding Add modal.
 * The draft's text is shown as a subtitle to identify what's being added.
 */
export class DraftChoiceModal extends Modal {
	constructor(
		app: App,
		private draftText: string,
		private onChoice: (choice: DraftAddChoice) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('wl-draft-choice-modal');

		this.titleEl.setText('Add draft');
		contentEl.createDiv({ cls: 'wl-draft-choice-subtitle', text: this.draftText });

		const grid = contentEl.createDiv({ cls: 'wl-draft-choice-grid' });

		const makeOption = (label: string, choice: DraftAddChoice): void => {
			const btn = grid.createEl('button', { cls: 'wl-draft-choice-btn' });
			btn.createDiv({ cls: 'wl-draft-choice-label', text: label });
			btn.addEventListener('click', () => {
				this.close();
				this.onChoice(choice);
			});
		};

		makeOption('Add in Watchlist', 'watchlist');
		makeOption('Add book', 'book');
		makeOption('Add manga', 'manga');
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
