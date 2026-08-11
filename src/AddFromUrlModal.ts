import { App, Modal } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type { MediaSearchResult } from './types';
import { apiErrorMessage } from './ApiService';
import { AddTitleModal } from './AddTitleModal';

/** themoviedb.org/movie/27205-inception, /tv/1396, with or without slug and query */
const TMDB_URL_RE = /themoviedb\.org\/(movie|tv)\/(\d+)/i;

export class AddFromUrlModal extends Modal {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private onAdded: () => void;
	private imdbInput: HTMLInputElement | null = null;
	private tmdbInput: HTMLInputElement | null = null;
	private errorEl: HTMLElement | null = null;

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
			text: 'Please enter an IMDb or TMDB URL (e.g. https://www.imdb.com/title/tt1375666/ or https://www.themoviedb.org/movie/27205)',
		});

		this.imdbInput = this.buildRow(
			content,
			'IMDb',
			'https://www.imdb.com/title/ttXXXXXXX/',
			() => this.lookupImdb(),
		);
		this.tmdbInput = this.buildRow(
			content,
			'TMDB',
			'https://www.themoviedb.org/movie/XXXXX',
			() => this.lookupTmdb(),
		);

		this.errorEl = content.createDiv({ cls: 'wl-modal-error' });
		this.errorEl.hide();

		window.setTimeout(() => this.imdbInput?.focus(), 50);
	}

	/** label · url input · inline Add button; the button owns its own loading state */
	private buildRow(
		content: HTMLElement,
		label: string,
		placeholder: string,
		lookup: () => Promise<MediaSearchResult | null | 'invalid' | 'nokey'>,
	): HTMLInputElement {
		const row = content.createDiv({ cls: 'wl-modal-row' });
		row.createDiv({ cls: 'wl-modal-label wl-url-row-label', text: label });
		const input = row.createEl('input', {
			cls: 'wl-modal-input',
			attr: { type: 'url', placeholder },
		});
		const btn = row.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Add' });

		const run = () => void this.handleAdd(btn, lookup);
		btn.addEventListener('click', run);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') run();
		});
		return input;
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async lookupImdb(): Promise<MediaSearchResult | null | 'invalid'> {
		const match = (this.imdbInput?.value.trim() ?? '').match(/tt\d+/);
		if (!match) return 'invalid';
		return this.plugin.settings.activeApi === 'TMDB'
			? this.plugin.apiService.getTmdbByImdbId(match[0])
			: this.plugin.apiService.getOmdbByImdbId(match[0]);
	}

	/** TMDB links carry the id + media type outright, so the detail call is direct — but it needs a key */
	private async lookupTmdb(): Promise<MediaSearchResult | null | 'invalid' | 'nokey'> {
		const match = (this.tmdbInput?.value.trim() ?? '').match(TMDB_URL_RE);
		if (!match) return 'invalid';
		if (!this.plugin.apiService.hasTmdbKey()) return 'nokey';
		const [, kind, id] = match;
		return kind!.toLowerCase() === 'movie'
			? this.plugin.apiService.getTmdbMovieDetails(id!)
			: this.plugin.apiService.getTmdbTvDetails(id!);
	}

	private async handleAdd(
		btn: HTMLButtonElement,
		lookup: () => Promise<MediaSearchResult | null | 'invalid' | 'nokey'>,
	): Promise<void> {
		btn.disabled = true;
		btn.textContent = 'Loading…';
		if (this.errorEl) this.errorEl.hide();

		try {
			let result: MediaSearchResult | null | 'invalid' | 'nokey';
			try {
				result = await lookup();
			} catch (err) {
				// a rejected key reaches here instead of resolving null — it must not read as "not found"
				this.showError(apiErrorMessage(err));
				return;
			}

			if (result === 'nokey') {
				this.showError('Add a TMDB API key in Settings → API to use TMDB links.');
				return;
			}
			if (result === 'invalid' || !result) {
				this.showError('Title not found. Please check the URL and try again.');
				return;
			}

			this.close();

			const type = result.mediaType === 'movie' ? 'Movie' : 'TV Show';
			new AddTitleModal(this.app, this.plugin, this.dataManager, this.onAdded, undefined, {
				title: result.title,
				type,
				episodes: result.episodes,
				duration: result.episodeDuration,
				releaseDate: result.releaseDate,
				link: result.url,
				seasons: result.seasons,
				trailerUrl: result.trailerUrl ?? '',
				director: result.director,
				cast: result.cast,
			}).open();
		} finally {
			btn.disabled = false;
			btn.textContent = 'Add';
		}
	}

	private showError(msg: string): void {
		if (this.errorEl) {
			this.errorEl.textContent = msg;
			this.errorEl.show();
		}
	}
}
