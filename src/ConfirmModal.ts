import { App, Modal } from 'obsidian';

export class ConfirmModal extends Modal {
	private message: string;
	private onConfirm: () => void;

	constructor(app: App, message: string, onConfirm: () => void) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createDiv({ cls: 'wl-confirm-msg', text: this.message });
		const btnRow = contentEl.createDiv({ cls: 'wl-modal-btn-row' });
		btnRow.createEl('button', { cls: 'wl-btn wl-btn-danger', text: 'Confirm' })
			.addEventListener('click', () => { this.close(); this.onConfirm(); });
		btnRow.createEl('button', { cls: 'wl-btn', text: 'Cancel' })
			.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
