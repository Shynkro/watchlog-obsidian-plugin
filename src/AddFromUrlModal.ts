import { App, Modal } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import { AddTitleModal } from './AddTitleModal';

export class AddFromUrlModal extends Modal {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private onAdded: () => void;
	private urlInput: HTMLInputElement | null = null;
	private errorEl: HTMLElement | null = null;
	private addBtn: HTMLButtonElement | null = null;

	constructor(app: App, plugin: WatchLogPlugin, dataManager: DataManager, onAdded: () => void) {
		super(app);
		this.plugin = plugin;
		this.dataManager = dataManager;
		this.onAdded = onAdded;
	}

	onOpen(): void {
		this.titleEl.setText('Add from URL');
		const content = this.contentEl;
		content.addClass('wl-add-modal');

		content.createDiv({
			cls: 'wl-modal-info',
			text: 'Please enter an IMDb URL (e.g. https://www.imdb.com/title/tt1375666/)',
		});

		const inputRow = content.createDiv({ cls: 'wl-modal-row' });
		this.urlInput = inputRow.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'url', placeholder: 'https://www.imdb.com/title/ttXXXXXXX/' },
		});
		this.urlInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') void this.handleAdd();
		});

		this.errorEl = content.createDiv({ cls: 'wl-modal-error' });
		this.errorEl.hide();

		const btnRow = content.createDiv({ cls: 'wl-modal-btn-row' });
		this.addBtn = btnRow.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Add' });
		this.addBtn.addEventListener('click', () => void this.handleAdd());

		setTimeout(() => this.urlInput?.focus(), 50);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async handleAdd(): Promise<void> {
		const url = this.urlInput?.value.trim() ?? '';
		const match = url.match(/tt\d+/);
		if (!match) {
			this.showError('Title not found. Please check the URL and try again.');
			return;
		}
		const imdbId = match[0];

		if (this.addBtn) {
			this.addBtn.disabled = true;
			this.addBtn.textContent = 'Loading…';
		}
		if (this.errorEl) this.errorEl.hide();

		const result = this.plugin.settings.activeApi === 'TMDB'
			? await this.plugin.apiService.getTmdbByImdbId(imdbId)
			: await this.plugin.apiService.getOmdbByImdbId(imdbId);

		if (!result) {
			if (this.addBtn) {
				this.addBtn.disabled = false;
				this.addBtn.textContent = 'Add';
			}
			this.showError('Title not found. Please check the URL and try again.');
			return;
		}

		this.close();

		const type = result.mediaType === 'movie' ? 'Movie' : 'TV Show';
		new AddTitleModal(this.app, this.plugin, this.dataManager, this.onAdded, {
			title: result.title,
			type,
			episodes: result.episodes,
			duration: result.episodeDuration,
			releaseDate: result.releaseDate,
			link: result.url,
			seasons: result.seasons,
		}).open();
	}

	private showError(msg: string): void {
		if (this.errorEl) {
			this.errorEl.textContent = msg;
			this.errorEl.show();
		}
	}
}
