import { App, Modal, Notice, Platform, TFile, setIcon } from 'obsidian';
import type WatchLogPlugin from './main';
import type { ReadingDataManager } from './ReadingDataManager';
import {
	Book, Manga, ReadingCustomColumn, ReadingStatus, SELECTABLE_READING_STATUSES,
	BookProgressUnit,
	bookProgressUnit, bookUnitProgress, formatCount,
	formatDateDisplay, todayIso,
} from './types';
import { createDatePicker } from './DatePicker';
import { apiErrorMessage } from './ApiService';
import { appendNoteLinkButton } from './NoteLinkButton';
import { ConfirmModal } from './ConfirmModal';
import { renderStarRating } from './StarRating';
import { VaultFilePicker } from './AddReadingModal';
import { readingStatusColor, coverFallbackColor } from './ReadingTab';
import { openStatusDropdown, renderSegmentedToggle } from './StatusDropdown';
import { pinModalFooter } from './StickyModal';
import {
	normalizePropertyType,
	renderCustomPropertiesDetailSection,
} from './CustomProperties';

interface ParsedQuote {
	reference: string;
	text: string;
}

function parseQuotesSection(content: string): ParsedQuote[] {
	const match = content.match(/(^|\n)## Quotes[ \t]*\r?\n([\s\S]*?)(?=\n## |\n# |$)/);
	if (!match) return [];
	const section = match[2] ?? '';
	const quotes: ParsedQuote[] = [];

	const lines = section.split(/\r?\n/);
	let current: { reference: string; body: string[] } | null = null;
	const flush = (): void => {
		if (current) {
			const text = current.body.join('\n').trim();
			if (text) quotes.push({ reference: current.reference, text });
		}
		current = null;
	};

	for (const raw of lines) {
		const header = raw.match(/^>\s*\[!quote\](.*)$/i);
		if (header) {
			flush();
			current = { reference: (header[1] ?? '').trim(), body: [] };
			continue;
		}
		if (current) {
			const cont = raw.match(/^>\s?(.*)$/);
			if (cont) {
				current.body.push(cont[1] ?? '');
			} else if (raw.trim() === '') {
				flush();
			} else {
				flush();
			}
		}
	}
	flush();
	return quotes;
}

interface ProgressDraft {
	pagesRead: number;
	wordsRead: number;
	chaptersRead: number;
	volumesRead: number;
}

interface ProgressSnapshot {
	pagesRead: number;
	wordsRead: number;
	chaptersRead: number;
	volumesRead: number;
}

/**
 * Step for the −/+ buttons in words mode — single-word steps are useless at six digits. The number
 * input still takes an exact value.
 */
const WORDS_STEP = 100;

export class ReadingDetailModal extends Modal {
	private plugin: WatchLogPlugin;
	private readingData: ReadingDataManager;
	private mode: 'book' | 'manga';
	private id: string;
	private onChanged: () => void;
	private draft: ProgressDraft;
	private openSnapshot: ProgressSnapshot;
	private starsWrapEl: HTMLElement | null = null;

	constructor(
		app: App,
		plugin: WatchLogPlugin,
		readingData: ReadingDataManager,
		mode: 'book' | 'manga',
		id: string,
		onChanged: () => void,
	) {
		super(app);
		this.plugin = plugin;
		this.readingData = readingData;
		this.mode = mode;
		this.id = id;
		this.onChanged = onChanged;
		const item = this.getItem();
		this.draft = {
			pagesRead: item && this.mode === 'book' ? (item as Book).pagesRead : 0,
			wordsRead: item && this.mode === 'book' ? ((item as Book).wordsRead ?? 0) : 0,
			chaptersRead: item ? (item).chaptersRead : 0,
			volumesRead: item && this.mode === 'manga' ? (item as Manga).volumesRead : 0,
		};
		this.openSnapshot = { ...this.draft };
	}

	private getItem(): Book | Manga | undefined {
		return this.mode === 'book'
			? this.readingData.getBook(this.id)
			: this.readingData.getManga(this.id);
	}

	onOpen(): void {
		const colorTheme = this.plugin.settings.colorTheme ?? 'default';
		this.modalEl.setAttribute('data-theme', colorTheme);
		this.contentEl.setAttribute('data-theme', colorTheme);
		this.contentEl.addClass('wl-view');
		this.contentEl.addClass('wl-detail-modal');
		this.contentEl.addClass('wl-reading-detail');
		this.renderAll();
	}

	onClose(): void {
		void this.commitOnClose();
		this.contentEl.empty();
	}

	private async commitOnClose(): Promise<void> {
		const draftChanged =
			this.draft.pagesRead !== this.openSnapshot.pagesRead ||
			this.draft.wordsRead !== this.openSnapshot.wordsRead ||
			this.draft.chaptersRead !== this.openSnapshot.chaptersRead ||
			this.draft.volumesRead !== this.openSnapshot.volumesRead;
		if (!draftChanged) return;

		const item = this.getItem();
		if (!item) return;

		if (this.mode === 'book') {
			const book = item as Book;
			const updated: Book = {
				...book,
				pagesRead: this.draft.pagesRead,
				wordsRead: this.draft.wordsRead,
				chaptersRead: this.draft.chaptersRead,
			};
			this.applyAutoComplete(updated);
			await this.readingData.updateBook(updated);
		} else {
			const manga = item as Manga;
			const updated: Manga = {
				...manga,
				chaptersRead: this.draft.chaptersRead,
				volumesRead: this.draft.volumesRead,
			};
			this.applyAutoComplete(updated);
			await this.readingData.updateManga(updated);
		}

		this.logProgressChange(item);
		this.onChanged();
	}

	private logProgressChange(item: Book | Manga): void {
		const snap = this.openSnapshot;
		const typeLabel = this.mode === 'book' ? 'Book' : 'Manga';

		if (this.mode === 'book') {
			const book = item as Book;
			// only the unit the book is tracked in is worth a log line
			if (bookProgressUnit(book) === 'words') {
				if (this.draft.wordsRead !== snap.wordsRead && book.totalWords > 0) {
					void this.plugin.historyManager?.log(
						`${item.title} (${typeLabel}) At word ${formatCount(this.draft.wordsRead)} / ${formatCount(book.totalWords)}`,
						{ source: 'Reading', action: 'watched', titleName: item.title },
					);
				}
			} else if (this.draft.pagesRead !== snap.pagesRead && book.totalPages > 0) {
				void this.plugin.historyManager?.log(
					`${item.title} (${typeLabel}) At page ${formatCount(this.draft.pagesRead)} / ${formatCount(book.totalPages)}`,
					{ source: 'Reading', action: 'watched', titleName: item.title },
				);
			}
			if (this.draft.chaptersRead !== snap.chaptersRead && book.totalChapters > 0) {
				void this.plugin.historyManager?.log(
					`${item.title} (${typeLabel}) At chapter ${this.draft.chaptersRead} / ${book.totalChapters}`,
					{ source: 'Reading', action: 'watched', titleName: item.title },
				);
			}
		} else {
			const manga = item as Manga;
			if (this.draft.chaptersRead !== snap.chaptersRead && manga.totalChapters > 0) {
				void this.plugin.historyManager?.log(
					`${item.title} (${typeLabel}) At chapter ${this.draft.chaptersRead} / ${manga.totalChapters}`,
					{ source: 'Reading', action: 'watched', titleName: item.title },
				);
			}
			if (this.draft.volumesRead !== snap.volumesRead && manga.totalVolumes > 0) {
				void this.plugin.historyManager?.log(
					`${item.title} (${typeLabel}) At volume ${this.draft.volumesRead} / ${manga.totalVolumes}`,
					{ source: 'Reading', action: 'watched', titleName: item.title },
				);
			}
		}
	}

	private renderAll(): void {
		this.contentEl.empty();
		const item = this.getItem();
		if (!item) {
			this.contentEl.createDiv({ text: 'Item no longer exists.' });
			return;
		}
		this.renderHeader(item);
		this.renderProgressSection(item);
		this.renderDetailsSection(item);
		this.contentEl.createDiv({ cls: 'wl-reading-modal-divider' });
		this.renderCustomFieldsSection(item);
		this.contentEl.createDiv({ cls: 'wl-reading-modal-divider' });
		void this.renderQuotesSection(item);
		this.renderFooter(item);
		pinModalFooter(this.contentEl.querySelector<HTMLElement>('.wl-reading-detail-footer'));
	}

	private renderHeader(item: Book | Manga): void {
		const header = this.contentEl.createDiv({ cls: 'wl-reading-detail-header' });

		const cover = header.createDiv({ cls: 'wl-reading-detail-cover' });
		if (item.coverUrl) {
			cover.createEl('img', {
				cls: 'wl-reading-detail-cover-img',
				attr: { src: item.coverUrl, alt: item.title },
			});
		} else {
			cover.style.backgroundColor = coverFallbackColor(item.id);
			cover.createSpan({
				cls: 'wl-reading-detail-cover-icon',
				text: this.mode === 'book' ? '📖' : '📓',
			});
		}

		const info = header.createDiv({ cls: 'wl-reading-detail-info' });

		const titleWrap = info.createDiv({ cls: 'wl-reading-detail-title-wrap' });
		this.renderTitleDisplay(titleWrap);

		const authorWrap = info.createDiv({ cls: 'wl-reading-detail-author-wrap' });
		this.renderAuthorDisplay(authorWrap);

		const meta = info.createDiv({ cls: 'wl-reading-detail-meta-row' });

		const statusWrap = meta.createSpan({ cls: 'wl-reading-detail-status-wrap' });
		this.renderStatusBadge(statusWrap);

		// open this entry's .md note; Reading resolves its own path (Books/Manga have their own folder) and
		// the shared helper handles the rest
		appendNoteLinkButton(
			this.plugin.app,
			meta,
			this.readingData.noteFilePath(this.mode, item.title),
			() => this.close(),
		);

		// mobile: status pill + note icon fill the meta row, so the stars take their own line
		const starsHost = Platform.isMobile
			? info.createDiv({ cls: 'wl-reading-detail-stars-row' })
			: meta;
		this.starsWrapEl = starsHost.createDiv({ cls: 'wl-stars wl-reading-detail-stars' });
		this.renderStars();

		// external link + vault page share one row; each keeps its own container so the two
		// rebuild-in-place renderers stay independent
		const links = info.createDiv({ cls: 'wl-reading-detail-links-row' });

		const actions = links.createDiv({ cls: 'wl-reading-detail-actions' });
		this.renderExternalLinkActions(actions);

		const vaultRow = links.createDiv({ cls: 'wl-reading-detail-vault-row' });
		this.renderVaultRow(vaultRow);
	}

	private renderTitleDisplay(wrap: HTMLElement): void {
		wrap.empty();
		const fresh = this.getItem();
		const titleEl = wrap.createEl('h2', {
			cls: 'wl-reading-detail-title wl-reading-detail-editable-text',
			text: fresh?.title ?? '',
		});
		titleEl.title = 'Click to edit';
		titleEl.addEventListener('click', () => this.editTitle(wrap));
	}

	private editTitle(wrap: HTMLElement): void {
		wrap.empty();
		const fresh = this.getItem();
		const input = wrap.createEl('input', {
			cls: 'wl-modal-input wl-reading-detail-title-input',
			attr: { type: 'text' },
		});
		input.value = fresh?.title ?? '';
		const commit = (): void => {
			const val = input.value.trim();
			if (!val) { this.renderTitleDisplay(wrap); return; }
			void (async () => {
				const curr = this.getItem();
				if (curr && val !== curr.title) {
					if (this.mode === 'book') {
						await this.readingData.updateBook({ ...(curr as Book), title: val });
					} else {
						await this.readingData.updateManga({ ...(curr as Manga), title: val });
					}
					this.onChanged();
				}
				this.renderTitleDisplay(wrap);
			})();
		};
		input.addEventListener('blur', commit);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
			else if (e.key === 'Escape') { e.preventDefault(); this.renderTitleDisplay(wrap); }
		});
		input.focus();
		input.select();
	}

	private renderAuthorDisplay(wrap: HTMLElement): void {
		wrap.empty();
		const fresh = this.getItem();
		const authorEl = wrap.createDiv({
			cls: 'wl-reading-detail-author wl-reading-detail-editable-text',
			text: fresh?.author || '—',
		});
		authorEl.title = 'Click to edit';
		authorEl.addEventListener('click', () => this.editAuthor(wrap));
	}

	private editAuthor(wrap: HTMLElement): void {
		wrap.empty();
		const fresh = this.getItem();
		const input = wrap.createEl('input', {
			cls: 'wl-modal-input wl-reading-detail-author-input',
			attr: { type: 'text' },
		});
		input.value = fresh?.author ?? '';
		const commit = (): void => {
			const val = input.value.trim();
			void (async () => {
				const curr = this.getItem();
				if (curr && val !== curr.author) {
					if (this.mode === 'book') {
						await this.readingData.updateBook({ ...(curr as Book), author: val });
					} else {
						await this.readingData.updateManga({ ...(curr as Manga), author: val });
					}
					this.onChanged();
				}
				this.renderAuthorDisplay(wrap);
			})();
		};
		input.addEventListener('blur', commit);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
			else if (e.key === 'Escape') { e.preventDefault(); this.renderAuthorDisplay(wrap); }
		});
		input.focus();
		input.select();
	}

	private renderStatusBadge(wrap: HTMLElement): void {
		wrap.empty();
		const fresh = this.getItem();
		const status = fresh?.status ?? 'Plan to Read';
		const badge = wrap.createSpan({ cls: 'wl-reading-detail-status', text: status });
		badge.style.backgroundColor = readingStatusColor(status, this.readingData.getSettings().statusColors);
		badge.title = 'Click to change status';
		badge.addEventListener('click', (e) => {
			e.stopPropagation();
			this.openStatusDropdown(badge, wrap);
		});
	}

	private openStatusDropdown(anchor: HTMLElement, wrap: HTMLElement): void {
		openStatusDropdown({
			anchor,
			container: this.contentEl,
			options: [...SELECTABLE_READING_STATUSES],
			getOptionColor: (status) => readingStatusColor(status as ReadingStatus, this.readingData.getSettings().statusColors),
			onSelect: (status) =>
				void this.saveStatus(status as ReadingStatus).then(() => this.renderStatusBadge(wrap)),
		});
	}

	private async saveStatus(status: ReadingStatus): Promise<void> {
		const curr = this.getItem();
		if (!curr) return;
		const patch: Partial<Book & Manga> = { status };
		if (status === 'Completed' && !curr.dateFinished) {
			patch.dateFinished = todayIso();
		}
		if (this.mode === 'book') {
			await this.readingData.updateBook({ ...(curr as Book), ...patch });
		} else {
			await this.readingData.updateManga({ ...(curr as Manga), ...patch });
		}
		this.onChanged();
	}

	private renderExternalLinkActions(container: HTMLElement): void {
		container.empty();
		const item = this.getItem();
		if (!item) return;

		const hasLink = !!item.externalLink;

		const linkBtn = container.createEl('button', {
			cls: 'wl-btn wl-btn-sm',
			text: hasLink ? 'Change link' : 'External link',
		});
		linkBtn.addEventListener('click', () => {
			container.empty();
			const inputWrap = container.createDiv({ cls: 'wl-reading-external-link-wrap' });
			const inp = inputWrap.createEl('input', {
				cls: 'wl-modal-input wl-reading-external-link-input',
				attr: { type: 'url', placeholder: 'https://…' },
			});
			inp.value = item.externalLink ?? '';
			const saveBtn = inputWrap.createEl('button', { cls: 'wl-reading-add-btn wl-btn-success', text: 'Save' });
			const cancelBtn = inputWrap.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Cancel' });
			const commit = (): void => {
				const url = inp.value.trim();
				void (async () => {
					const curr = this.getItem();
					if (!curr) return;
					if (this.mode === 'book') {
						await this.readingData.updateBook({ ...(curr as Book), externalLink: url });
					} else {
						await this.readingData.updateManga({ ...(curr as Manga), externalLink: url });
					}
					this.onChanged();
					this.renderExternalLinkActions(container);
				})();
			};
			saveBtn.addEventListener('click', commit);
			cancelBtn.addEventListener('click', () => this.renderExternalLinkActions(container));
			inp.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') { e.preventDefault(); commit(); }
				else if (e.key === 'Escape') { e.preventDefault(); this.renderExternalLinkActions(container); }
			});
			inp.focus();
		});

		if (hasLink) {
			const openBtn = container.createEl('button', {
				cls: 'wl-btn wl-btn-sm',
				text: 'Open',
			});
			openBtn.title = item.externalLink ?? '';
			openBtn.addEventListener('click', () => {
				const curr = this.getItem();
				if (curr?.externalLink) {
					activeWindow.open(curr.externalLink, '_blank', 'noopener,noreferrer');
				}
			});
		}
	}

	private renderVaultRow(row: HTMLElement): void {
		row.empty();
		const item = this.getItem();
		if (!item) return;

		// the button carries the "Vault page" wording, so the value beside it is just the state
		const linkBtn = row.createEl('button', {
			cls: 'wl-btn wl-btn-sm',
			text: 'Vault page',
		});
		linkBtn.title = item.vaultPage
			? `Linked: ${item.vaultPage}`
			: 'Link a vault note to this entry';
		linkBtn.addEventListener('click', () => {
			const files = this.plugin.app.vault.getMarkdownFiles();
			new VaultFilePicker(this.plugin.app, files, (file) => {
				void this.updateVaultPage(file.path).then(() => this.renderVaultRow(row));
			}).open();
		});

		if (item.vaultPage) {
			const openBtn = row.createEl('button', {
				cls: 'wl-btn wl-btn-sm',
				text: 'Open',
			});
			openBtn.title = 'Open the linked vault page in a new tab';
			openBtn.addEventListener('click', () => this.openLinkedVaultPage());
		}

		if (item.vaultPage) {
			const filename = item.vaultPage.split('/').pop() || item.vaultPage;
			const pathSpan = row.createSpan({
				cls: 'wl-reading-detail-vault-path',
				text: filename,
			});
			pathSpan.title = item.vaultPage;
		} else {
			row.createSpan({
				cls: 'wl-reading-detail-vault-empty',
				text: 'not linked',
			});
		}
	}

	private async updateVaultPage(newPath: string): Promise<void> {
		const item = this.getItem();
		if (!item) return;
		if (this.mode === 'book') {
			const updated: Book = { ...(item as Book), vaultPage: newPath };
			await this.readingData.updateBook(updated);
		} else {
			const updated: Manga = { ...(item as Manga), vaultPage: newPath };
			await this.readingData.updateManga(updated);
		}
	}

	private openLinkedVaultPage(): void {
		const item = this.getItem();
		if (!item || !item.vaultPage) return;
		const file = this.plugin.app.vault.getAbstractFileByPath(item.vaultPage);
		if (file instanceof TFile) {
			void this.plugin.app.workspace.getLeaf('tab').openFile(file);
			this.close();
		} else {
			new Notice('Linked vault page no longer exists.');
		}
	}

	private renderStars(): void {
		if (!this.starsWrapEl) return;
		const item = this.getItem();
		if (!item) {
			this.starsWrapEl.empty();
			return;
		}
		renderStarRating(this.starsWrapEl, item.rating, {
			allowHalf: this.plugin.settings.halfStarRatings ?? false,
			tiers: this.plugin.settings.ratingSystem,
			showLabel: true,
			onChange: (value) => {
				const fresh = this.getItem();
				if (!fresh) return;
				void (async () => {
					if (this.mode === 'book') {
						const updated = { ...(fresh as Book), rating: value };
						await this.readingData.updateBook(updated);
					} else {
						const updated = { ...(fresh as Manga), rating: value };
						await this.readingData.updateManga(updated);
					}
					this.renderStars();
				})();
			},
		});
	}

	private renderProgressSection(item: Book | Manga): void {
		const section = this.contentEl.createDiv({ cls: 'wl-reading-detail-progress' });
		const label = section.createDiv({ cls: 'wl-reading-section-label' });
		label.createSpan({ text: 'Progress' });
		// only books carry a unit switch, so only they need the taller flex row
		if (this.mode === 'book') {
			label.addClass('wl-reading-section-label-row');
			this.renderUnitToggle(label, item as Book);
		}

		const gaugeRow = section.createDiv({ cls: 'wl-reading-arc-row' });

		// rings + controls always render, even when the total is 0
		if (this.mode === 'book') {
			// the primary gauge follows the book's unit; chapters are unit-agnostic
			if (bookProgressUnit(item as Book) === 'words') {
				this.renderArcGauge(
					gaugeRow, 'words', '#8b5cf6',
					() => this.draft.wordsRead,
					(v) => { this.draft.wordsRead = v; },
					() => (this.getItem() as Book | undefined)?.totalWords ?? 0,
					(v) => this.commitTotal('totalWords', v),
					WORDS_STEP,
				);
			} else {
				this.renderArcGauge(
					gaugeRow, 'pages', '#8b5cf6',
					() => this.draft.pagesRead,
					(v) => { this.draft.pagesRead = v; },
					() => (this.getItem() as Book | undefined)?.totalPages ?? 0,
					(v) => this.commitTotal('totalPages', v),
				);
			}
			this.renderArcGauge(
				gaugeRow, 'chapters', '#06b6d4',
				() => this.draft.chaptersRead,
				(v) => { this.draft.chaptersRead = v; },
				() => (this.getItem() as Book | undefined)?.totalChapters ?? 0,
				(v) => this.commitTotal('totalChapters', v),
			);
		} else {
			this.renderArcGauge(
				gaugeRow, 'chapters', '#06b6d4',
				() => this.draft.chaptersRead,
				(v) => { this.draft.chaptersRead = v; },
				() => (this.getItem() as Manga | undefined)?.totalChapters ?? 0,
				(v) => this.commitTotal('totalChapters', v),
			);
			this.renderArcGauge(
				gaugeRow, 'volumes', '#f59e0b',
				() => this.draft.volumesRead,
				(v) => { this.draft.volumesRead = v; },
				() => (this.getItem() as Manga | undefined)?.totalVolumes ?? 0,
				(v) => this.commitTotal('totalVolumes', v),
			);
		}

		// the "of N …" totals are click-to-edit, which isn't discoverable on its own — gated on the same
		// "Show hint banners" setting as the other hints
		if (this.plugin.settings.showHintBanners) {
			const primary = this.mode === 'book'
				? (bookProgressUnit(item as Book) === 'words' ? 'words' : 'pages')
				: 'chapters';
			const secondary = this.mode === 'book' ? 'chapters' : 'volumes';
			section.createDiv({
				cls: 'wl-cl-draft-banner',
				text: `⚠ Click the total number of ${primary} or ${secondary} above to edit it.`,
			});
		}
	}

	/** Pages/Words switch on the Progress label row. Books only. */
	private renderUnitToggle(parent: HTMLElement, book: Book): void {
		renderSegmentedToggle<BookProgressUnit>({
			parent,
			options: [
				{ value: 'pages', label: 'Pages', title: 'Track progress in pages' },
				{ value: 'words', label: 'Words', title: 'Track progress in words' },
			],
			value: bookProgressUnit(book),
			onPick: (unit) => { void this.switchProgressUnit(unit); },
		});
	}

	/**
	 * Persists the new tracking unit and repaints. Uncommitted counter edits are folded in first, so
	 * typing a page count and *then* switching never drops it. The other unit's numbers are untouched,
	 * which is what makes switching back lossless.
	 */
	private async switchProgressUnit(unit: BookProgressUnit): Promise<void> {
		const curr = this.getItem() as Book | undefined;
		if (!curr) return;
		const updated: Book = {
			...curr,
			progressUnit: unit,
			pagesRead: this.draft.pagesRead,
			wordsRead: this.draft.wordsRead,
			chaptersRead: this.draft.chaptersRead,
		};
		await this.readingData.updateBook(updated);
		this.openSnapshot = { ...this.draft };
		this.onChanged();
		this.renderAll();
	}

	/** Persists an edited total (pages/words/chapters/volumes) to the underlying item. */
	private async commitTotal(
		field: 'totalPages' | 'totalWords' | 'totalChapters' | 'totalVolumes',
		value: number,
	): Promise<void> {
		const curr = this.getItem();
		if (!curr) return;
		if (this.mode === 'book') {
			await this.readingData.updateBook({ ...(curr as Book), [field]: value });
		} else {
			await this.readingData.updateManga({ ...(curr as Manga), [field]: value });
		}
		this.onChanged();
	}

	private renderArcGauge(
		parent: HTMLElement,
		unit: string,
		color: string,
		getValue: () => number,
		setValue: (v: number) => void,
		getTotal: () => number,
		commitTotal: (v: number) => Promise<void>,
		step = 1,
	): void {
		const col = parent.createDiv({ cls: 'wl-reading-arc-col' });
		// word counters need wider fields and coarser steps than page/chapter ones
		if (step > 1) col.addClass('wl-reading-arc-col-wide');

		const svgSize = 100;
		const strokeWidth = 8;
		const radius = (svgSize - strokeWidth) / 2;
		const cx = svgSize / 2;
		const cy = svgSize / 2;

		const svgWrap = col.createDiv({ cls: 'wl-reading-arc-svg-wrap' });
		const svg = svgWrap.createSvg('svg');
		svg.setAttribute('viewBox', `0 0 ${svgSize} ${svgSize}`);
		svg.setAttribute('class', 'wl-reading-arc-svg');

		const arcLength = Math.PI * radius;

		const bgArc = svg.createSvg('path');
		const arcPath = `M ${cx - radius} ${cy} A ${radius} ${radius} 0 1 1 ${cx + radius} ${cy}`;
		bgArc.setAttribute('d', arcPath);
		bgArc.setAttribute('fill', 'none');
		bgArc.setAttribute('stroke', '#2a2a2a');
		bgArc.setAttribute('stroke-width', String(strokeWidth));
		bgArc.setAttribute('stroke-linecap', 'round');

		const fgArc = svg.createSvg('path');
		fgArc.setAttribute('d', arcPath);
		fgArc.setAttribute('fill', 'none');
		fgArc.setAttribute('stroke', color);
		fgArc.setAttribute('stroke-width', String(strokeWidth));
		fgArc.setAttribute('stroke-linecap', 'round');
		fgArc.setAttribute('stroke-dasharray', String(arcLength));

		const pctText = svg.createSvg('text');
		pctText.setAttribute('x', String(cx));
		pctText.setAttribute('y', String(cy + 4));
		pctText.setAttribute('text-anchor', 'middle');
		pctText.setAttribute('class', 'wl-reading-arc-pct');

		const clamp = (n: number): number => {
			const total = getTotal();
			if (isNaN(n) || n < 0) return 0;
			if (total > 0 && n > total) return total;
			return n;
		};

		const controls = col.createDiv({ cls: 'wl-reading-arc-controls' });
		const decBtn = controls.createEl('button', { cls: 'wl-btn wl-btn-sm wl-reading-step-btn', text: `−${step}` });
		const input = controls.createEl('input', {
			cls: 'wl-modal-input wl-modal-input-sm wl-reading-arc-input',
			attr: { type: 'number', min: '0', max: String(getTotal()), step: String(step) },
		});
		const incBtn = controls.createEl('button', { cls: 'wl-btn wl-btn-sm wl-reading-step-btn', text: `+${step}` });

		const label = col.createDiv({ cls: 'wl-reading-arc-label' });

		const sync = (): void => {
			const total = getTotal();
			const v = getValue();
			input.value = String(v);
			input.setAttribute('max', String(total));
			const pct = total > 0 ? Math.min(1, v / total) : 0;
			const dashOffset = arcLength * (1 - pct);
			fgArc.setAttribute('stroke-dashoffset', String(dashOffset));
			pctText.textContent = `${Math.round(pct * 100)}%`;
		};

		// static "of … <unit>" line with only the total inline-editable
		const renderLabel = (): void => {
			label.empty();
			label.createSpan({ text: 'of ' });
			const numEl = label.createSpan({
				cls: 'wl-reading-arc-total wl-reading-detail-editable-text',
				text: formatCount(getTotal()),
			});
			numEl.title = 'Click to edit';
			numEl.addEventListener('click', () => editTotal());
			label.createSpan({ text: ` ${unit}` });
		};

		const editTotal = (): void => {
			label.empty();
			label.createSpan({ text: 'of ' });
			const totalInput = label.createEl('input', {
				cls: 'wl-modal-input wl-modal-input-sm wl-reading-arc-total-input',
				attr: { type: 'number', min: '0' },
			});
			totalInput.value = String(getTotal());
			label.createSpan({ text: ` ${unit}` });
			let committed = false;
			const commit = (): void => {
				if (committed) return;
				committed = true;
				const raw = parseInt(totalInput.value, 10);
				const v = isNaN(raw) || raw < 0 ? 0 : raw;
				void (async () => {
					if (v !== getTotal()) {
						await commitTotal(v);
						sync();
					}
					renderLabel();
				})();
			};
			totalInput.addEventListener('blur', commit);
			totalInput.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') { e.preventDefault(); totalInput.blur(); }
				else if (e.key === 'Escape') { e.preventDefault(); committed = true; renderLabel(); }
			});
			totalInput.focus();
			totalInput.select();
		};

		renderLabel();
		sync();

		input.addEventListener('input', () => {
			const v = clamp(parseInt(input.value, 10));
			setValue(v);
			sync();
		});
		decBtn.addEventListener('click', () => {
			setValue(clamp(getValue() - step));
			sync();
		});
		incBtn.addEventListener('click', () => {
			setValue(clamp(getValue() + step));
			sync();
		});
	}

	private renderDetailsSection(item: Book | Manga): void {
		const section = this.contentEl.createDiv({ cls: 'wl-reading-detail-details' });
		section.createDiv({ cls: 'wl-reading-section-label', text: 'Details' });

		const grid = section.createDiv({ cls: 'wl-reading-detail-grid' });

		this.renderIdCell(grid, item);

		this.renderEditableDateCell(
			grid, 'Started',
			() => this.getItem()?.dateStarted ?? null,
			async (val) => {
				const curr = this.getItem();
				if (!curr) return;
				if (this.mode === 'book') {
					await this.readingData.updateBook({ ...(curr as Book), dateStarted: val });
				} else {
					await this.readingData.updateManga({ ...(curr as Manga), dateStarted: val });
				}
				this.onChanged();
			},
		);

		this.renderAddedReleaseCell(grid, item);

		this.renderEditableDateCell(
			grid, 'Finished',
			() => this.getItem()?.dateFinished ?? null,
			async (val) => {
				const curr = this.getItem();
				if (!curr) return;
				if (this.mode === 'book') {
					await this.readingData.updateBook({ ...(curr as Book), dateFinished: val });
				} else {
					await this.readingData.updateManga({ ...(curr as Manga), dateFinished: val });
				}
				this.onChanged();
			},
		);
	}

	/**
	 * DETAILS ID row (Google Books ID / MAL ID). The ID links to the title's web page — the editable
	 * `externalLink` when set, else a URL derived from the ID. The edit button to the right sets the
	 * source ID itself (`googleBooksId` / `malId`), which re-fetches the cover.
	 */
	private renderIdCell(grid: HTMLElement, item: Book | Manga): void {
		const label = this.mode === 'book' ? 'Google Books ID' : 'MAL ID';
		const value = this.makeDetailCell(grid, label);
		value.addClass('wl-reading-detail-id-value');
		this.fillIdValue(value, item);
	}

	private idText(item: Book | Manga): string {
		return this.mode === 'book' ? (item as Book).googleBooksId : (item as Manga).malId;
	}

	/** Resolves the URL the clickable ID points to: explicit link, else derived from the ID. */
	private resolveItemLink(item: Book | Manga): string {
		if (item.externalLink) return item.externalLink;
		if (this.mode === 'manga') {
			const malId = (item as Manga).malId;
			return malId ? `https://myanimelist.net/manga/${encodeURIComponent(malId)}` : '';
		}
		const volumeId = (item as Book).googleBooksId;
		if (!volumeId) return '';
		return `https://books.google.com/books?id=${encodeURIComponent(volumeId)}`;
	}

	private fillIdValue(value: HTMLElement, item: Book | Manga): void {
		value.empty();
		const idText = this.idText(item);
		const linkUrl = this.resolveItemLink(item);

		if (idText) {
			if (linkUrl) {
				value.createEl('a', {
					cls: 'wl-reading-detail-link',
					text: idText,
					attr: { href: linkUrl, target: '_blank', rel: 'noopener noreferrer' },
				});
			} else {
				value.createSpan({ text: idText });
			}
		} else {
			value.createSpan({ text: '—' });
		}

		const editBtn = value.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-reading-detail-id-edit',
			text: '✎',
			attr: { title: this.mode === 'book' ? 'Edit Google Books ID' : 'Edit MAL ID' },
		});
		editBtn.addEventListener('click', () => this.editIdLink(value, item));
	}

	private editIdLink(value: HTMLElement, item: Book | Manga): void {
		value.empty();
		const wrap = value.createDiv({ cls: 'wl-reading-external-link-wrap' });
		const inp = wrap.createEl('input', {
			cls: 'wl-modal-input wl-reading-external-link-input',
			attr: {
				type: 'text',
				placeholder: this.mode === 'book' ? 'Google Books volume ID' : 'MAL manga ID',
			},
		});
		inp.value = this.idText(item);
		const saveBtn = wrap.createEl('button', { cls: 'wl-reading-add-btn wl-btn-success', text: 'Save' });
		const cancelBtn = wrap.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Cancel' });

		const restore = (): void => {
			const fresh = this.getItem();
			if (fresh) this.fillIdValue(value, fresh);
		};
		const commit = (): void => {
			const newId = inp.value.trim();
			void (async () => {
				const curr = this.getItem();
				if (!curr) return;
				if (newId === this.idText(curr)) { restore(); return; }
				if (this.mode === 'book') {
					await this.readingData.updateBook({ ...(curr as Book), googleBooksId: newId });
				} else {
					await this.readingData.updateManga({ ...(curr as Manga), malId: newId });
				}
				this.onChanged();
				restore();
				if (newId) await this.refetchCoverFromId(newId);
			})();
		};
		saveBtn.addEventListener('click', commit);
		cancelBtn.addEventListener('click', restore);
		inp.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); commit(); }
			else if (e.key === 'Escape') { e.preventDefault(); restore(); }
		});
		inp.focus();
	}

	/**
	 * Re-resolves ONLY the cover from a freshly-edited source ID and persists it — pages/dates/other
	 * fields untouched. `onChanged()` re-renders the card so the new cover shows without a scroll.
	 * Notifies when the volume has no cover, or when the lookup fails.
	 */
	private async refetchCoverFromId(newId: string): Promise<void> {
		try {
			if (this.mode === 'book') {
				if (!this.plugin.apiService.hasGoogleBooksKey()) {
					new Notice('Google Books API key required; add one in Settings → API → Books.');
					return;
				}
				const result = await this.plugin.apiService.getGoogleBookById(newId);
				if (!result || !result.coverUrl) {
					new Notice("This volume doesn't have a cover; try a different edition's ID.");
					return;
				}
				const fresh = this.getItem();
				if (!fresh) return;
				await this.readingData.updateBook({ ...(fresh as Book), coverUrl: result.coverUrl });
			} else {
				const result = await this.plugin.apiService.getMangaByMalId(Number(newId));
				if (!result || !result.coverUrl) {
					new Notice("This manga doesn't have a cover; try a different ID.");
					return;
				}
				const fresh = this.getItem();
				if (!fresh) return;
				await this.readingData.updateManga({ ...(fresh as Manga), coverUrl: result.coverUrl });
			}
			this.onChanged();
		} catch (err) {
			new Notice(apiErrorMessage(err));
		}
	}

	/**
	 * Renders ADDED (static) and RELEASE (editable) side by side in one grid cell so the modal keeps
	 * its height. Release date drives the auto "To be released" status, so a change re-renders.
	 */
	private renderAddedReleaseCell(grid: HTMLElement, item: Book | Manga): void {
		const cell = grid.createDiv({ cls: 'wl-reading-detail-cell wl-reading-detail-cell-pair' });

		const added = cell.createDiv({ cls: 'wl-reading-detail-pair-col' });
		added.createDiv({ cls: 'wl-reading-detail-cell-label', text: 'Added' });
		added.createDiv({
			cls: 'wl-reading-detail-cell-value',
			text: formatDateDisplay(item.dateAdded.slice(0, 10)),
		});

		const rel = cell.createDiv({ cls: 'wl-reading-detail-pair-col' });
		rel.createDiv({ cls: 'wl-reading-detail-cell-label', text: 'Release' });
		createDatePicker({
			parent: rel,
			inputCls: 'wl-reading-detail-date-input',
			value: this.getItem()?.releaseDate ?? null,
			lenient: true,
			onChange: (iso) => {
				void (async () => {
					const curr = this.getItem();
					if (!curr) return;
					if (this.mode === 'book') {
						await this.readingData.updateBook({ ...(curr as Book), releaseDate: iso });
					} else {
						await this.readingData.updateManga({ ...(curr as Manga), releaseDate: iso });
					}
					this.onChanged();
					// status may have flipped to/from "To be released"
					this.renderAll();
				})();
			},
		});
	}

	private makeDetailCell(parent: HTMLElement, label: string): HTMLElement {
		const cell = parent.createDiv({ cls: 'wl-reading-detail-cell' });
		cell.createDiv({ cls: 'wl-reading-detail-cell-label', text: label });
		const value = cell.createDiv({ cls: 'wl-reading-detail-cell-value' });
		return value;
	}

	private renderEditableDateCell(
		parent: HTMLElement,
		label: string,
		getValue: () => string | null,
		save: (val: string | null) => Promise<void>,
	): void {
		const cell = parent.createDiv({ cls: 'wl-reading-detail-cell' });
		cell.createDiv({ cls: 'wl-reading-detail-cell-label', text: label });
		const valueArea = cell.createDiv({ cls: 'wl-reading-detail-cell-date' });

		const todayBtn = valueArea.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-reading-detail-today-btn',
			text: 'Today',
			attr: { title: 'Fill with today\'s date' },
		});
		const picker = createDatePicker({
			parent: valueArea,
			inputCls: 'wl-reading-detail-date-input',
			value: getValue(),
			onChange: (iso) => {
				refreshTodayBtn();
				void save(iso);
			},
		});

		const refreshTodayBtn = (): void => {
			todayBtn.toggleClass('is-dimmed', !!picker.getValue());
		};
		refreshTodayBtn();

		todayBtn.addEventListener('click', () => {
			if (picker.getValue()) return;
			picker.setValue(todayIso());
		});
	}

	private renderFooter(item: Book | Manga): void {
		const footer = this.contentEl.createDiv({ cls: 'wl-reading-detail-footer' });

		const left = footer.createDiv({ cls: 'wl-reading-detail-footer-left' });
		const deleteBtn = left.createEl('button', {
			cls: 'wl-delete-btn wl-btn-danger wl-reading-detail-delete',
			text: 'Delete',
		});
		deleteBtn.addEventListener('click', () => {
			new ConfirmModal(
				this.plugin.app,
				`Delete "${item.title}"?`,
				() => {
					void (async () => {
						if (this.mode === 'book') {
							await this.readingData.removeBook(item.id);
						} else {
							await this.readingData.removeManga(item.id);
						}
						this.onChanged();
						this.close();
					})();
				},
			).open();
		});

		// favorite heart, centered by the footer's space-between (the Watchlist/Games spot). Persists
		// immediately — this modal saves field-by-field, unlike the Games draft.
		const favBtn = footer.createEl('button', {
			cls: 'wl-detail-fav-btn',
			attr: { type: 'button' },
		});
		setIcon(favBtn, 'heart');
		const paintFav = (): void => {
			const fav = this.getItem()?.favorite === true;
			favBtn.toggleClass('is-active', fav);
			const label = fav ? 'Remove from favorites' : 'Add to favorites';
			favBtn.title = label;
			favBtn.setAttr('aria-label', label);
		};
		paintFav();
		favBtn.addEventListener('click', () => {
			const fav = this.getItem()?.favorite === true;
			void this.readingData.setFavorite(this.mode, item.id, !fav).then(paintFav);
		});

		const right = footer.createDiv({ cls: 'wl-reading-detail-footer-right' });

		const updateBtn = right.createEl('button', {
			cls: 'wl-reading-add-btn wl-btn-success',
			text: 'Update progress',
		});
		updateBtn.addEventListener('click', () => void this.commitDraft());
	}

	private getColumns(): ReadingCustomColumn[] {
		return this.mode === 'book'
			? this.readingData.getBookColumns()
			: this.readingData.getMangaColumns();
	}

	private renderCustomFieldsSection(item: Book | Manga): void {
		const settings = this.readingData.getSettings();
		const fieldStyle = this.mode === 'book'
			? (settings.bookCustomFieldStyle ?? 'fill')
			: (settings.mangaCustomFieldStyle ?? 'fill');
		renderCustomPropertiesDetailSection({
			parent: this.contentEl,
			properties: this.getColumns().map((c) => ({
				...c,
				type: normalizePropertyType(c.type),
			})),
			getFields: () => {
				const fresh = this.getItem() ?? item;
				return fresh.customFields ?? {};
			},
			fieldStyle,
			emptyHint: 'No properties yet. Add some in Settings → Customize → Reading.',
			onSave: async (propId, value) => {
				await this.readingData.setCustomField(this.mode, item.id, propId, value);
			},
		});
	}

	private async renderQuotesSection(item: Book | Manga): Promise<void> {
		const section = this.contentEl.createDiv({ cls: 'wl-reading-detail-quotes' });

		const heading = section.createDiv({ cls: 'wl-reading-detail-quotes-heading' });
		heading.createSpan({ cls: 'wl-reading-section-label', text: 'Favorite quotes' });
		const addBtn = heading.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-reading-detail-quotes-add',
			text: 'Add quote',
		});

		const listEl = section.createDiv({ cls: 'wl-reading-quote-list' });
		const formHost = section.createDiv({ cls: 'wl-reading-quote-form-host' });

		const refresh = async (): Promise<void> => {
			listEl.empty();
			try {
				const content = await this.readingData.readReadingNote(this.mode, item);
				const quotes = content ? parseQuotesSection(content) : [];
				if (quotes.length === 0) {
					listEl.createDiv({
						cls: 'wl-reading-quote-empty',
						text: 'No quotes yet.',
					});
				} else {
					for (const q of quotes) {
						this.renderQuoteCard(listEl, q);
					}
				}
			} catch (e) {
				console.warn('[WL] quotes read failed:', e);
			}
		};

		addBtn.addEventListener('click', () => {
			formHost.empty();
			this.renderAddQuoteForm(formHost, item, async () => {
				await refresh();
			});
		});

		void refresh();
	}

	private renderQuoteCard(parent: HTMLElement, q: ParsedQuote): void {
		const card = parent.createDiv({ cls: 'wl-reading-quote-card' });
		card.createDiv({ cls: 'wl-reading-quote-text', text: q.text });
		if (q.reference) {
			card.createDiv({ cls: 'wl-reading-quote-ref', text: q.reference });
		}
	}

	private renderAddQuoteForm(
		parent: HTMLElement,
		item: Book | Manga,
		onSaved: () => Promise<void>,
	): void {
		parent.empty();
		const form = parent.createDiv({ cls: 'wl-reading-quote-form' });

		const textarea = form.createEl('textarea', {
			cls: 'wl-modal-input wl-reading-quote-textarea',
			attr: { placeholder: 'Quote text…', rows: '3' },
		});

		const refInput = form.createEl('input', {
			cls: 'wl-modal-input wl-reading-quote-ref-input',
			attr: { type: 'text', placeholder: 'p. 123 or ch. 5 (optional)' },
		});

		const actions = form.createDiv({ cls: 'wl-reading-quote-form-actions' });
		const cancelBtn = actions.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Cancel' });
		cancelBtn.addEventListener('click', () => parent.empty());

		const saveBtn = actions.createEl('button', {
			cls: 'wl-reading-add-btn wl-btn-success wl-reading-quote-save',
			text: 'Save quote',
		});
		saveBtn.addEventListener('click', () => {
			const text = textarea.value.trim();
			if (!text) {
				new Notice('Enter the quote text first.');
				return;
			}
			void (async () => {
				try {
					await this.readingData.appendQuote(this.mode, item, text, refInput.value);
					parent.empty();
					await onSaved();
				} catch (e) {
					console.warn('[WL] appendQuote failed:', e);
					new Notice('Could not save quote.');
				}
			})();
		});

		textarea.focus();
	}

	private async commitDraft(): Promise<void> {
		const item = this.getItem();
		if (!item) return;

		if (this.mode === 'book') {
			const book = item as Book;
			const updated: Book = {
				...book,
				pagesRead: this.draft.pagesRead,
				wordsRead: this.draft.wordsRead,
				chaptersRead: this.draft.chaptersRead,
			};
			this.applyAutoComplete(updated);
			await this.readingData.updateBook(updated);
		} else {
			const manga = item as Manga;
			const updated: Manga = {
				...manga,
				chaptersRead: this.draft.chaptersRead,
				volumesRead: this.draft.volumesRead,
			};
			this.applyAutoComplete(updated);
			await this.readingData.updateManga(updated);
		}

		this.logProgressChange(item);
		this.openSnapshot = { ...this.draft };

		new Notice('Progress updated.');
		this.onChanged();
		this.close();
	}

	private applyAutoComplete(item: Book | Manga): void {
		const isComplete = this.mode === 'book'
			? this.isBookComplete(item as Book)
			: this.isMangaComplete(item as Manga);
		if (isComplete && item.status !== 'Completed') {
			item.status = 'Completed';
		}
		if (item.status === 'Completed' && !item.dateFinished) {
			item.dateFinished = todayIso();
		}
	}

	private isBookComplete(book: Book): boolean {
		// only the tracked unit counts — a stale page count left by a switch to words must not
		// auto-complete the book
		const { read, total } = bookUnitProgress(book);
		if (total > 0 && read >= total) return true;
		if (book.totalChapters > 0 && book.chaptersRead >= book.totalChapters) return true;
		return false;
	}

	private isMangaComplete(manga: Manga): boolean {
		if (manga.totalChapters > 0 && manga.chaptersRead >= manga.totalChapters) return true;
		return false;
	}
}
