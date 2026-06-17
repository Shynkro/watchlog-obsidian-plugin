import { App, Modal } from 'obsidian';

export type AddTitleChoice = 'url' | 'manual';

/**
 * Small chooser modal shown when adding a title to the Watchlist. Offers two
 * inline options (Add from URL / Add manually or via API), each routing to its
 * own corresponding Add modal. This modal only routes — it holds no form logic.
 */
export class AddTitleChoiceModal extends Modal {
	constructor(
		app: App,
		private onChoice: (choice: AddTitleChoice) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('wl-draft-choice-modal');

		this.titleEl.setText('Add title');

		const grid = contentEl.createDiv({ cls: 'wl-draft-choice-grid' });

		const makeOption = (label: string, choice: AddTitleChoice): void => {
			const btn = grid.createEl('button', { cls: 'wl-draft-choice-btn' });
			btn.createDiv({ cls: 'wl-draft-choice-label', text: label });
			btn.addEventListener('click', () => {
				this.close();
				this.onChoice(choice);
			});
		};

		makeOption('Add from URL', 'url');
		makeOption('Add manually / via API', 'manual');
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
