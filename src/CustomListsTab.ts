import { App, Component, MarkdownRenderer, Modal, Notice, TFile, normalizePath, Setting } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import type { CustomListColumn, CustomListRow, CustomList } from './types';
import { ConfirmModal } from './ConfirmModal';

// ─────────────────────────────────────────────────────────────────────────────
// CustomListManager — vault I/O
// ─────────────────────────────────────────────────────────────────────────────

export class CustomListManager {
	/** Names of lists whose ## Data JSON is corrupt — never overwrite these. */
	corruptLists: Set<string> = new Set();

	/** Per-list save queue: serializes writes to the same list file so table
	 * and notes saves cannot race and clobber each other. */
	private saveQueues: Map<string, Promise<void>> = new Map();

	constructor(
		private readonly app: App,
		private readonly plugin: WatchLogPlugin,
	) {}

	private async saveSerialized(listName: string, saveFn: () => Promise<void>): Promise<void> {
		const prev = this.saveQueues.get(listName) ?? Promise.resolve();
		const next = prev.then(saveFn).catch(e => console.error('[WL] Save error for list:', listName, e));
		this.saveQueues.set(listName, next);
		await next;
	}

	get folderPath(): string {
		return this.plugin.settings.customListsFolder || 'WatchLog/CustomLists';
	}

	async ensureFolder(): Promise<void> {
		const path = normalizePath(this.folderPath);
		if (!this.app.vault.getAbstractFileByPath(path)) {
			try { await this.app.vault.createFolder(path); } catch { /* ok */ }
		}
	}

	listNames(): string[] {
		const dir = normalizePath(this.folderPath);
		return this.app.vault.getFiles()
			.filter(f => {
				const parentPath = f.parent?.path ?? '';
				return parentPath === dir && f.extension === 'md';
			})
			.map(f => f.basename)
			.sort((a, b) => a.localeCompare(b));
	}

	async loadList(name: string): Promise<CustomList | null> {
		const path = normalizePath(`${this.folderPath}/${name}.md`);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return null;
		try {
			const content = await this.app.vault.read(file);
			return this.parse(name, content);
		} catch (e) {
			console.warn('[WL] Failed to read custom list', name, e);
			return null;
		}
	}

	private parse(name: string, content: string): CustomList | null {
		const notesMatch = content.match(/## Notes\n([\s\S]*?)(?=\n## |\s*$)/);
		const notes = (notesMatch?.[1] ?? '').trim();

		const dataMatch = content.match(/## Data\n```json\n([\s\S]*?)\n```/);
		let columns: CustomListColumn[] = [];
		let rows: CustomListRow[] = [];

		if (dataMatch?.[1]) {
			try {
				const p = JSON.parse(dataMatch[1]) as { columns?: unknown; rows?: unknown };
				if (Array.isArray(p.columns)) {
					columns = (p.columns as unknown[]).filter((c): c is CustomListColumn =>
						typeof c === 'object' && c !== null &&
						'id' in c && 'label' in c && 'type' in c,
					);
				}
				if (Array.isArray(p.rows)) {
					rows = (p.rows as unknown[]).filter((r): r is CustomListRow =>
						typeof r === 'object' && r !== null && 'id' in r,
					);
				}
			} catch (e) {
				console.warn('[WL] Custom list JSON parse failed for', name, e);
				new Notice(`Custom list "${name}" has corrupt data and cannot be loaded.`);
				this.corruptLists.add(name);
				return null;
			}
		}

		return { name, columns, rows, notes };
	}

	async saveList(list: CustomList): Promise<void> {
		await this.saveSerialized(list.name, async () => {
			if (this.corruptLists.has(list.name)) {
				console.warn('[WL] Refusing to save corrupt custom list', list.name);
				return;
			}
			await this.ensureFolder();
			const path = normalizePath(`${this.folderPath}/${list.name}.md`);
			const content = this.serialize(list);
			const existing = this.app.vault.getAbstractFileByPath(path);
			try {
				if (existing instanceof TFile) {
					await this.app.vault.modify(existing, content);
				} else {
					await this.app.vault.create(path, content);
				}
			} catch (e) {
				console.error('WatchLog: failed to save custom list', e);
			}
		});
	}

	/** Saves only the ## Notes section without touching ## Data JSON. */
	async saveNotes(name: string, notes: string): Promise<void> {
		await this.saveSerialized(name, async () => {
			const path = normalizePath(`${this.folderPath}/${name}.md`);
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			try {
				const content = await this.app.vault.read(file);
				const notesMarker = '## Notes\n';
				const dataMarker = '\n## Data\n';
				const notesIdx = content.indexOf(notesMarker);
				if (notesIdx === -1) return;
				const afterNotes = notesIdx + notesMarker.length;
				const dataIdx = content.indexOf(dataMarker, afterNotes);
				const updated = dataIdx !== -1
					? content.slice(0, afterNotes) + notes + content.slice(dataIdx)
					: content.slice(0, afterNotes) + notes + '\n';
				await this.app.vault.modify(file, updated);
			} catch (e) {
				console.error('WatchLog: failed to save notes', e);
			}
		});
	}

	private serialize(list: CustomList): string {
		const json = JSON.stringify({ columns: list.columns, rows: list.rows }, null, 2);
		return `# ${list.name}\n\n## Notes\n${list.notes}\n\n## Data\n\`\`\`json\n${json}\n\`\`\`\n`;
	}

	async deleteList(name: string): Promise<void> {
		const path = normalizePath(`${this.folderPath}/${name}.md`);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			try { await this.app.fileManager.trashFile(file); } catch { /* ok */ }
		}
	}

	async renameList(oldName: string, newName: string): Promise<void> {
		const newPath = normalizePath(`${this.folderPath}/${newName}.md`);
		const oldPath = normalizePath(`${this.folderPath}/${oldName}.md`);
		const file = this.app.vault.getAbstractFileByPath(oldPath);
		if (file instanceof TFile) {
			try { await this.app.vault.rename(file, newPath); } catch { /* ok */ }
		}
	}

	generateColId(existingColumns: CustomListColumn[]): string {
		const ids = new Set(existingColumns.map(c => c.id));
		let i = 1;
		while (ids.has(`col_${i}`)) i++;
		return `col_${i}`;
	}

	generateRowId(rows: CustomListRow[]): string {
		const ids = new Set(rows.map(r => r.id));
		let i = 1;
		while (ids.has(`row_${i}`)) i++;
		return `row_${i}`;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared column list renderer (used by EditColumnsModal & DefaultColumnsModal)
// ─────────────────────────────────────────────────────────────────────────────

function renderColumnList(
	listEl: HTMLElement,
	cols: CustomListColumn[],
	existingRows: CustomListRow[],
	app: App,
	onReorder: (from: number, to: number) => void,
	onDelete: (idx: number) => void,
	onTypeChange: () => void,
	onAdd?: () => void,
): void {
	listEl.empty();
	listEl.addClass('wl-editcol-card-grid');
	let dragFromIndex = -1;

	// Permanent auto-included columns — non-editable, non-deletable, non-draggable.
	const renderAutoCard = (label: string): void => {
		const card = listEl.createDiv({ cls: 'wl-editcol-card wl-editcol-card-auto' });
		card.setAttribute('data-auto', label);
		const nameWrap = card.createDiv({ cls: 'wl-editcol-card-name-wrap' });
		nameWrap.createDiv({ cls: 'wl-editcol-card-name-label', text: label });
		card.createDiv({ cls: 'wl-editcol-card-type-locked', text: 'Auto' });
		card.createDiv({ cls: 'wl-editcol-card-spacer' });
	};
	renderAutoCard('#');
	renderAutoCard('Name');

	// User columns
	cols.forEach((col, idx) => {
		const card = listEl.createDiv({ cls: 'wl-editcol-card' });

		// Drag handle (top of card)
		const handle = card.createDiv({ cls: 'wl-editcol-card-handle', text: '⠿' });
		handle.title = 'Drag to reorder';
		handle.addEventListener('mousedown', () => card.setAttribute('draggable', 'true'));
		card.addEventListener('dragstart', (e) => {
			dragFromIndex = idx;
			e.dataTransfer?.setData('text/plain', String(idx));
			card.addClass('wl-cl-dragging');
		});
		card.addEventListener('dragend', () => {
			card.removeClass('wl-cl-dragging');
			card.setAttribute('draggable', 'false');
		});
		card.addEventListener('dragover', (e) => { e.preventDefault(); card.addClass('wl-cl-drag-over'); });
		card.addEventListener('dragleave', () => card.removeClass('wl-cl-drag-over'));
		card.addEventListener('drop', (e) => {
			e.preventDefault();
			card.removeClass('wl-cl-drag-over');
			const from = dragFromIndex;
			const to = idx;
			if (from !== to && from >= 0) onReorder(from, to);
		});

		// Name input
		const nameInput = card.createEl('input', {
			cls: 'wl-modal-input wl-editcol-card-name',
			attr: { type: 'text', placeholder: 'Column name', value: col.label },
		});
		nameInput.addEventListener('input', () => { col.label = nameInput.value; });

		// Type select
		const typeSelect = card.createEl('select', { cls: 'wl-select wl-editcol-card-type' });
		for (const t of ['text', 'number', 'select'] as const) {
			const opt = typeSelect.createEl('option', {
				value: t,
				text: t.charAt(0).toUpperCase() + t.slice(1),
			});
			if (col.type === t) opt.selected = true;
		}
		typeSelect.addEventListener('change', () => {
			col.type = typeSelect.value as CustomListColumn['type'];
			onTypeChange();
		});

		// Bold/Italic toggles (text/number only)
		if (col.type === 'text' || col.type === 'number') {
			const toggles = card.createDiv({ cls: 'wl-editcol-card-toggles' });
			const boldBtn = toggles.createEl('button', {
				cls: `wl-btn wl-btn-sm wl-editcol-card-toggle wl-editcols-bold-btn${col.bold ? ' is-active' : ''}`,
				text: 'B',
			});
			boldBtn.addEventListener('click', () => {
				col.bold = !col.bold;
				boldBtn.toggleClass('is-active', !!col.bold);
			});
			const italicBtn = toggles.createEl('button', {
				cls: `wl-btn wl-btn-sm wl-editcol-card-toggle wl-editcols-italic-btn${col.italic ? ' is-active' : ''}`,
				text: 'I',
			});
			italicBtn.addEventListener('click', () => {
				col.italic = !col.italic;
				italicBtn.toggleClass('is-active', !!col.italic);
			});

			if (col.type === 'number') {
				const autoTimeBtn = toggles.createEl('button', {
					cls: `wl-btn wl-btn-sm wl-editcol-card-toggle wl-editcols-autotime-btn${col.autoTime ? ' is-active' : ''}`,
					text: '⏱',
					attr: { title: 'Auto-populate with remaining watch time from Watchlist' },
				});
				autoTimeBtn.addEventListener('click', () => {
					col.autoTime = !col.autoTime;
					autoTimeBtn.toggleClass('is-active', !!col.autoTime);
				});
			}
		}

		// Delete card button
		const delBtn = card.createEl('button', {
			cls: 'wl-btn wl-btn-sm wl-editcol-card-del',
			text: '×',
		});
		delBtn.title = 'Delete this column';
		delBtn.addEventListener('click', () => {
			const hasData = existingRows.some(r => {
				const val = (r as Record<string, unknown>)[col.id];
				return val !== undefined && val !== '' && val !== null;
			});
			if (hasData) {
				new ConfirmModal(app, `Delete column "${col.label}"? This will remove all data in this column.`, () => {
					onDelete(idx);
				}).open();
			} else {
				onDelete(idx);
			}
		});

		// Options block (select type only)
		if (col.type === 'select') {
			const optsArea = card.createDiv({ cls: 'wl-editcol-card-opts' });
			const renderOpts = (): void => {
				optsArea.empty();
				(col.options ?? []).forEach((opt, oi) => {
					const optRow = optsArea.createDiv({ cls: 'wl-editcol-card-opt-row' });
					const optInput = optRow.createEl('input', {
						cls: 'wl-modal-input wl-editcol-card-opt-input',
						attr: { type: 'text', value: opt, placeholder: 'Option' },
					});
					optInput.addEventListener('input', () => {
						if (!col.options) col.options = [];
						col.options[oi] = optInput.value;
					});
					const delOpt = optRow.createEl('button', {
						cls: 'wl-btn wl-btn-sm wl-editcol-card-opt-del',
						text: '×',
						attr: { title: 'Remove this option' },
					});
					delOpt.addEventListener('click', () => { col.options?.splice(oi, 1); renderOpts(); });
				});
				const addOpt = optsArea.createEl('button', {
					cls: 'wl-btn wl-btn-sm wl-editcol-card-opt-add',
					text: '+ option',
				});
				addOpt.addEventListener('click', () => {
					if (!col.options) col.options = [];
					col.options.push('');
					renderOpts();
				});
			};
			renderOpts();
		}
	});

	// Add-column card (last in row)
	if (onAdd) {
		const addCard = listEl.createDiv({ cls: 'wl-editcol-card wl-editcol-card-add' });
		addCard.createDiv({ cls: 'wl-editcol-card-add-label', text: '+ add column' });
		addCard.addEventListener('click', () => onAdd());
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// EditColumnsModal
// ─────────────────────────────────────────────────────────────────────────────

export class EditColumnsModal extends Modal {
	private list: CustomList;
	private manager: CustomListManager;
	private onSave: (columns: CustomListColumn[]) => Promise<void>;
	private cols: CustomListColumn[];
	private listEl!: HTMLElement;

	constructor(
		app: App,
		list: CustomList,
		manager: CustomListManager,
		onSave: (columns: CustomListColumn[]) => Promise<void>,
	) {
		super(app);
		this.list = list;
		this.manager = manager;
		this.onSave = onSave;
		this.cols = list.columns
			.filter(c => !c.locked)
			.map(c => ({ ...c, options: c.options ? [...c.options] : undefined }));
	}

	onOpen(): void {
		this.modalEl.addClass('wl-editcol-modal');
		this.titleEl.setText(`Edit Columns — ${this.list.name}`);
		this.contentEl.addClass('wl-editcols-modal');
		this.renderBody();
	}

	private renderBody(): void {
		this.contentEl.empty();
		this.contentEl.addClass('wl-editcols-modal');

		this.listEl = this.contentEl.createDiv({ cls: 'wl-editcols-list' });
		this.renderCols();

		const footer = this.contentEl.createDiv({ cls: 'wl-modal-btn-row wl-editcols-footer' });
		const cancelBtn = footer.createEl('button', { cls: 'wl-btn', text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		const saveBtn = footer.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Save' });
		saveBtn.addEventListener('click', () => void this.handleSave());
	}

	private renderCols(): void {
		renderColumnList(
			this.listEl,
			this.cols,
			this.list.rows,
			this.app,
			(from, to) => {
				const [moved] = this.cols.splice(from, 1);
				this.cols.splice(from < to ? to - 1 : to, 0, moved!);
				this.renderCols();
			},
			(idx) => { this.cols.splice(idx, 1); this.renderBody(); },
			() => this.renderBody(),
			() => {
				this.cols.push({
					id: this.manager.generateColId([...this.list.columns.filter(c => !c.locked), ...this.cols]),
					label: '',
					type: 'text',
					bold: false,
					italic: false,
				});
				this.renderBody();
			},
		);
	}

	private handleSave(): void {
		for (const col of this.cols) {
			if (!col.label.trim()) { new Notice('Column names cannot be empty.'); return; }
			if (col.type === 'select' && (!col.options || col.options.length === 0)) {
				new Notice(`Column "${col.label}" must have at least one option.`);
				return;
			}
		}
		for (const col of this.cols) {
			col.label = col.label.trim();
			if (col.options) col.options = col.options.map(o => o.trim()).filter(o => o);
		}
		void this.onSave(this.cols).then(() => this.close());
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DefaultColumnsModal — for Settings
// ─────────────────────────────────────────────────────────────────────────────

export class DefaultColumnsModal extends Modal {
	private plugin: WatchLogPlugin;
	private cols: CustomListColumn[];
	private manager: CustomListManager;
	private listEl!: HTMLElement;

	constructor(app: App, plugin: WatchLogPlugin) {
		super(app);
		this.plugin = plugin;
		this.manager = new CustomListManager(app, plugin);
		this.cols = (plugin.settings.defaultCustomColumns ?? [])
			.map(c => ({ ...c, options: c.options ? [...c.options] : undefined }));
	}

	onOpen(): void {
		this.modalEl.addClass('wl-editcol-modal');
		this.titleEl.setText('Default columns');
		this.contentEl.addClass('wl-editcols-modal');
		this.renderBody();
	}

	private renderBody(): void {
		this.contentEl.empty();
		this.contentEl.addClass('wl-editcols-modal');

		this.contentEl.createDiv({
			cls: 'wl-settings-info',
			text: 'These columns are pre-populated when creating a new list. The Name column is always added automatically.',
		});

		this.listEl = this.contentEl.createDiv({ cls: 'wl-editcols-list' });
		this.renderCols();

		const footer = this.contentEl.createDiv({ cls: 'wl-modal-btn-row wl-editcols-footer' });
		const cancelBtn = footer.createEl('button', { cls: 'wl-btn', text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		const saveBtn = footer.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Save' });
		saveBtn.addEventListener('click', () => void this.handleSave());
	}

	private renderCols(): void {
		renderColumnList(
			this.listEl,
			this.cols,
			[],
			this.app,
			(from, to) => {
				const [moved] = this.cols.splice(from, 1);
				this.cols.splice(from < to ? to - 1 : to, 0, moved!);
				this.renderCols();
			},
			(idx) => { this.cols.splice(idx, 1); this.renderBody(); },
			() => this.renderBody(),
			() => {
				this.cols.push({
					id: this.manager.generateColId(this.cols),
					label: '',
					type: 'text',
					bold: false,
					italic: false,
				});
				this.renderBody();
			},
		);
	}

	private async handleSave(): Promise<void> {
		for (const col of this.cols) {
			if (!col.label.trim()) { new Notice('Column names cannot be empty.'); return; }
			if (col.type === 'select' && (!col.options || col.options.length === 0)) {
				new Notice(`Column "${col.label}" must have at least one option.`);
				return;
			}
		}
		for (const col of this.cols) {
			col.label = col.label.trim();
			if (col.options) col.options = col.options.map(o => o.trim()).filter(o => o);
		}
		this.plugin.settings.defaultCustomColumns = this.cols;
		await this.plugin.saveSettings();
		new Notice('Default columns saved.');
		this.close();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// NotesModal — edits a list's notes in a simple textarea modal
// ─────────────────────────────────────────────────────────────────────────────

class NotesModal extends Modal {
	private previewComponent = new Component();

	constructor(
		app: App,
		private listName: string,
		private initialNotes: string,
		private onSave: (notes: string) => Promise<void>,
	) { super(app); }

	onOpen(): void {
		this.previewComponent.load();
		this.titleEl.setText(`Notes — ${this.listName}`);
		const { contentEl } = this;
		contentEl.addClass('wl-notes-modal');

		// ── Mode toggle bar ──
		const modeBar = contentEl.createDiv({ cls: 'wl-notes-mode-bar' });
		const editBtn = modeBar.createEl('button', { cls: 'wl-btn wl-btn-sm is-active', text: 'Edit' });
		const previewBtn = modeBar.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Preview' });

		// ── Edit area ──
		const editArea = contentEl.createDiv({ cls: 'wl-notes-edit-area' });
		const textarea = editArea.createEl('textarea', {
			cls: 'wl-modal-textarea wl-notes-textarea',
			attr: { placeholder: 'Add notes, links, or any text here...' },
		});
		textarea.value = this.initialNotes;
		window.setTimeout(() => {
			textarea.focus();
			textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		}, 0);

		// ── Preview area ──
		const previewArea = contentEl.createDiv({ cls: 'wl-notes-preview-area' });
		previewArea.hide();

		const showEdit = (): void => {
			editArea.show();
			previewArea.hide();
			editBtn.addClass('is-active');
			previewBtn.removeClass('is-active');
			textarea.focus();
		};

		const showPreview = async (): Promise<void> => {
			editArea.hide();
			previewArea.show();
			previewArea.empty();
			editBtn.removeClass('is-active');
			previewBtn.addClass('is-active');
			const source = textarea.value.trim() || '*No notes yet.*';
			await MarkdownRenderer.render(this.app, source, previewArea, '', this.previewComponent);
		};

		editBtn.addEventListener('click', showEdit);
		previewBtn.addEventListener('click', () => void showPreview());

		// Ctrl+B / Ctrl+I shortcuts in textarea
		textarea.addEventListener('keydown', (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
				e.preventDefault();
				wrapSelection(textarea, '**', '**');
			} else if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
				e.preventDefault();
				wrapSelection(textarea, '*', '*');
			}
		});

		const footer = contentEl.createDiv({ cls: 'wl-modal-btn-row' });
		const cancelBtn = footer.createEl('button', { cls: 'wl-btn', text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		const saveBtn = footer.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Save' });
		saveBtn.addEventListener('click', () => void this.onSave(textarea.value).then(() => this.close()));
	}

	onClose(): void { this.previewComponent.unload(); this.contentEl.empty(); }
}

/** Wraps the current selection in a textarea with a prefix/suffix pair. */
function wrapSelection(ta: HTMLTextAreaElement, before: string, after: string): void {
	const start = ta.selectionStart;
	const end = ta.selectionEnd;
	const selected = ta.value.slice(start, end);
	const replacement = before + selected + after;
	ta.setRangeText(replacement, start, end, 'select');
	// Place cursor inside the markers if nothing was selected
	if (start === end) {
		ta.selectionStart = start + before.length;
		ta.selectionEnd = start + before.length;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// ListNameModal — text-input modal (window.prompt() is blocked in Electron)
// ─────────────────────────────────────────────────────────────────────────────

class ListNameModal extends Modal {
	constructor(
		app: App,
		private existingNames: string[],
		private onSubmit: (name: string) => void,
	) { super(app); }

	onOpen(): void {
		this.titleEl.setText('New custom list');
		const { contentEl } = this;

		let value = '';
		const errorEl = contentEl.createDiv({ cls: 'wl-cl-name-error' });
		errorEl.hide();

		new Setting(contentEl)
			.setName('List name')
			.addText((t) => {
				t.setPlaceholder('E.g. Marvel movies')
					.onChange((v) => { value = v; errorEl.hide(); });
				window.setTimeout(() => t.inputEl.focus(), 0);
				t.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') { e.preventDefault(); submit(); }
				});
			});

		const submit = (): void => {
			const trimmed = value.trim();
			if (!trimmed) { errorEl.textContent = 'Please enter a name.'; errorEl.show(); return; }
			if (this.existingNames.includes(trimmed)) {
				errorEl.textContent = `A list named "${trimmed}" already exists.`;
				errorEl.show();
				return;
			}
			this.close();
			this.onSubmit(trimmed);
		};

		const btnRow = contentEl.createDiv({ cls: 'wl-modal-btn-row' });
		btnRow.createEl('button', { cls: 'wl-btn', text: 'Cancel' }).addEventListener('click', () => this.close());
		btnRow.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Create' }).addEventListener('click', submit);
	}

	onClose(): void { this.contentEl.empty(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// CustomListsTab
// ─────────────────────────────────────────────────────────────────────────────

export class CustomListsTab {
	private container: HTMLElement;
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private manager: CustomListManager;

	private listNames: string[] = [];
	activeListName: string | null = null;
	private currentList: CustomList | null = null;
	private sortCol: string | null = null;
	private sortDir: 'asc' | 'desc' = 'asc';
	searchQuery = '';
	private duplicatedRowIds: Set<string> = new Set();
	private _escapeKeyHandler: ((e: KeyboardEvent) => void) | null = null;

	// Cleanup functions for inline-editor document/visualViewport listeners
	private activeCleanups: Array<() => void> = [];

	// Generation counter to guard against stale renders / race conditions
	private renderGeneration = 0;

	// Per-list save queue to prevent overlapping table + notes writes
	private saveQueues: Map<string, Promise<void>> = new Map();

	// Kept for keyboard navigation (set at buildTable time)
	private _countEl: HTMLElement | null = null;
	private _tableContainer: HTMLElement | null = null;

	constructor(container: HTMLElement, plugin: WatchLogPlugin, dataManager: DataManager) {
		this.container = container;
		this.plugin = plugin;
		this.dataManager = dataManager;
		this.manager = new CustomListManager(plugin.app, plugin);
	}

	/** Returns listNames merged with the persisted tab order (new lists appended at end). */
	private applyTabOrder(names: string[]): string[] {
		const saved = this.plugin.settings.customListTabOrder ?? [];
		const ordered = saved.filter(n => names.includes(n));
		const unordered = names.filter(n => !ordered.includes(n));
		return [...ordered, ...unordered];
	}

	/** Tear down active inline-editor listeners (called on rerender / view close). */
	destroy(): void {
		for (const fn of this.activeCleanups) {
			try { fn(); } catch { /* ignore */ }
		}
		this.activeCleanups = [];
		if (this._escapeKeyHandler) {
			try { activeDocument.removeEventListener('keydown', this._escapeKeyHandler); } catch { /* ignore */ }
			this._escapeKeyHandler = null;
		}
	}

	addCleanup(fn: () => void): void {
		this.activeCleanups.push(fn);
	}

	/** Serializes saves per-list so notes + table writes don't overlap. */
	saveSerialized(listName: string, saveFn: () => Promise<void>): Promise<void> {
		const prev = this.saveQueues.get(listName) ?? Promise.resolve();
		const next = prev.then(saveFn).catch((e) => console.error('[WL] custom-list save failed:', e));
		this.saveQueues.set(listName, next);
		return next;
	}

	async render(): Promise<void> {
		const gen = ++this.renderGeneration;
		this.destroy();
		this.container.empty();
		this.container.addClass('wl-custom-lists');

		const rawNames = this.manager.listNames();
		this.listNames = this.applyTabOrder(rawNames);

		if (this.listNames.length === 0) {
			this.buildEmptyState();
			return;
		}

		if (!this.activeListName || !this.listNames.includes(this.activeListName)) {
			this.activeListName = this.listNames[0] ?? null;
		}

		if (this.activeListName) {
			this.currentList = await this.manager.loadList(this.activeListName);
		}

		if (gen !== this.renderGeneration) return; // stale render
		this.container.empty();
		this.buildSubTabs();

		if (this.currentList) {
			this.buildListView(this.currentList);
		}
	}

	private buildEmptyState(): void {
		const es = this.container.createDiv({ cls: 'wl-cl-empty-state' });
		es.createDiv({ cls: 'wl-cl-empty-text', text: 'No custom lists yet.' });
		const btn = es.createEl('button', { cls: 'wl-btn wl-btn-primary', text: 'Create your first list' });
		btn.addEventListener('click', () => this.promptCreateList());
	}

	private buildSubTabs(): void {
		const tabBar = this.container.createDiv({ cls: 'wl-cl-sub-tabs' });
		let dragFromName: string | null = null;

		for (const name of this.listNames) {
			const tab = tabBar.createDiv({
				cls: `wl-cl-sub-tab${name === this.activeListName ? ' is-active' : ''}`,
			});
			tab.setAttribute('draggable', 'true');

			const nameSpan = tab.createSpan({ cls: 'wl-cl-sub-tab-name', text: name });
			nameSpan.addEventListener('dblclick', (e) => {
				e.stopPropagation();
				this.startRenameTab(tab, nameSpan, name);
			});

			const delBtn = tab.createSpan({ cls: 'wl-cl-sub-tab-del', text: '×' });
			delBtn.addEventListener('click', (e) => { e.stopPropagation(); void this.deleteList(name); });

			tab.addEventListener('click', () => {
				if (this.activeListName === name) return;
				this.activeListName = name;
				this.sortCol = null;
				this.sortDir = 'asc';
				this.searchQuery = '';
				this.duplicatedRowIds.clear();
				void this.render();
			});

			// Drag-and-drop reorder
			tab.addEventListener('dragstart', (e) => {
				dragFromName = name;
				e.dataTransfer?.setData('text/plain', name);
				tab.addClass('wl-cl-dragging');
			});
			tab.addEventListener('dragend', () => tab.removeClass('wl-cl-dragging'));
			tab.addEventListener('dragover', (e) => { e.preventDefault(); tab.addClass('wl-cl-drag-over'); });
			tab.addEventListener('dragleave', () => tab.removeClass('wl-cl-drag-over'));
			tab.addEventListener('drop', (e) => {
				e.preventDefault();
				tab.removeClass('wl-cl-drag-over');
				if (!dragFromName || dragFromName === name) return;
				const fromIdx = this.listNames.indexOf(dragFromName);
				const toIdx = this.listNames.indexOf(name);
				if (fromIdx < 0 || toIdx < 0) return;
				this.listNames.splice(fromIdx, 1);
				this.listNames.splice(toIdx, 0, dragFromName);
				this.plugin.settings.customListTabOrder = [...this.listNames];
				void this.plugin.saveSettings().then(() => void this.render());
			});
		}

		const addBtn = tabBar.createEl('button', { cls: 'wl-cl-sub-tab-add wl-btn-success', text: '+' });
		addBtn.addEventListener('click', () => this.promptCreateList());
	}

	private startRenameTab(tab: HTMLElement, nameSpan: HTMLElement, oldName: string): void {
		nameSpan.hide();
		const input = tab.createEl('input', {
			cls: 'wl-cl-sub-tab-rename',
			attr: { type: 'text', value: oldName },
		});
		input.focus();
		input.select();

		let finished = false;
		const finish = async (save: boolean): Promise<void> => {
			if (finished) return;
			finished = true;
			input.remove();
			nameSpan.show();
			if (!save) return;
			const newName = input.value.trim();
			if (!newName || newName === oldName) return;
			if (this.listNames.includes(newName)) { new Notice(`A list named "${newName}" already exists.`); return; }
			await this.manager.renameList(oldName, newName);
			if (this.activeListName === oldName) this.activeListName = newName;
			await this.render();
		};

		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
			if (e.key === 'Escape') { void finish(false); }
		});
		input.addEventListener('blur', () => void finish(true));
	}

	private promptCreateList(): void {
		new ListNameModal(this.plugin.app, this.listNames, (trimmed) => {
			const defaultCols = (this.plugin.settings.defaultCustomColumns ?? [])
				.map(c => ({ ...c, id: c.id, options: c.options ? [...c.options] : undefined }));

			const newList: CustomList = { name: trimmed, columns: defaultCols, rows: [], notes: '' };

			new EditColumnsModal(
				this.plugin.app,
				newList,
				this.manager,
				async (cols) => {
					newList.columns = cols;
					await this.manager.saveList(newList);
					this.activeListName = trimmed;
					this.sortCol = null;
					this.sortDir = 'asc';
					this.searchQuery = '';
					this.duplicatedRowIds.clear();
					await this.render();
				},
			).open();
		}).open();
	}

	private deleteList(name: string): void {
		new ConfirmModal(this.plugin.app, `Delete list "${name}"? This cannot be undone.`, () => {
			void (async () => {
				await this.manager.deleteList(name);
				if (this.activeListName === name) { this.activeListName = null; this.currentList = null; }
				await this.render();
			})();
		}).open();
	}

	private buildListView(list: CustomList): void {
		const view = this.container.createDiv({ cls: 'wl-cl-list-view' });

		// Header
		const header = view.createDiv({ cls: 'wl-cl-header' });
		const countEl = header.createSpan({ cls: 'wl-results-count wl-cl-count' });
		const toolbar = header.createDiv({ cls: 'wl-cl-toolbar' });

		// Notes — opens NotesModal
		const notesBtn = toolbar.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Notes' });
		notesBtn.addEventListener('click', () => {
			new NotesModal(
				this.plugin.app,
				list.name,
				list.notes,
				async (notes) => {
					await this.manager.saveNotes(list.name, notes);
					list.notes = notes;
				},
			).open();
		});

		// Sort
		const sortBtn = toolbar.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Sort' });
		let sortPanel: HTMLElement | null = null;
		sortBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (sortPanel) { sortPanel.remove(); sortPanel = null; return; }
			sortPanel = this.buildSortPanel(list, toolbar, () => { sortPanel = null; });
			activeDocument.addEventListener('click', () => { sortPanel?.remove(); sortPanel = null; }, { once: true });
		});

		// Export
		toolbar.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Export' })
			.addEventListener('click', () => void this.exportToClipboard(list));

		// Edit Columns
		toolbar.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Edit columns' })
			.addEventListener('click', () => {
				new EditColumnsModal(
					this.plugin.app,
					list,
					this.manager,
					async (cols) => {
						const colIds = new Set(cols.map(c => c.id));
						for (const row of list.rows) {
							for (const key of Object.keys(row)) {
								if (key !== 'id' && key !== 'name' && key !== 'checked' && !colIds.has(key)) {
									delete (row as Record<string, unknown>)[key];
								}
							}
						}
						list.columns = cols;
						for (const col of cols) {
							if (col.type === 'number' && col.autoTime) {
								this.autoPopulateTimeColumn(list, col);
							}
						}
						await this.manager.saveList(list);
						await this.render();
					},
				).open();
			});

		// Search
		const searchWrap = view.createDiv({ cls: 'wl-search-wrap' });
		const searchInput = searchWrap.createEl('input', {
			cls: 'wl-search-input',
			attr: { type: 'text', placeholder: 'Search...', value: this.searchQuery },
		});
		let searchDebounce: number | null = null;
		searchInput.addEventListener('input', () => {
			this.searchQuery = searchInput.value;
			if (searchDebounce !== null) window.clearTimeout(searchDebounce);
			searchDebounce = window.setTimeout(() => {
				searchDebounce = null;
				if (this._tableContainer && this._countEl) {
					this._tableContainer.empty();
					this.buildTable(this._tableContainer, list, this._countEl);
				}
			}, 250);
		});

		if (this.plugin.settings.showHintBanners) {
			view.createDiv({
				cls: 'wl-cl-draft-banner',
				text: '⚠ This is a draft list. Titles here are not included in any stats or counts.',
			});
		}

		// Table
		const tableWrap = view.createDiv({ cls: 'wl-cl-table-wrap' });
		this.buildTable(tableWrap, list, countEl);
	}

	private buildSortPanel(list: CustomList, anchor: HTMLElement, onClose: () => void): HTMLElement {
		const panel = anchor.createDiv({ cls: 'wl-cl-sort-panel' });

		const row1 = panel.createDiv({ cls: 'wl-filter-row' });
		row1.createSpan({ cls: 'wl-filter-label', text: 'Sort by' });
		const colSel = row1.createEl('select', { cls: 'wl-select' });
		colSel.createEl('option', { value: 'name', text: 'Name' });
		for (const col of list.columns.filter(c => !c.locked)) {
			colSel.createEl('option', { value: col.id, text: col.label });
		}
		if (this.sortCol) colSel.value = this.sortCol;

		const row2 = panel.createDiv({ cls: 'wl-filter-row' });
		row2.createSpan({ cls: 'wl-filter-label', text: 'Direction' });
		const dirSel = row2.createEl('select', { cls: 'wl-select' });
		dirSel.createEl('option', { value: 'asc', text: 'A → z' });
		dirSel.createEl('option', { value: 'desc', text: 'Z → a' });
		dirSel.value = this.sortDir;

		const btnRow = panel.createDiv({ cls: 'wl-modal-btn-row' });
		btnRow.createEl('button', { cls: 'wl-btn wl-btn-sm', text: 'Clear sort' })
			.addEventListener('click', (e) => { e.stopPropagation(); this.sortCol = null; this.sortDir = 'asc'; onClose(); void this.render(); });
		btnRow.createEl('button', { cls: 'wl-btn wl-btn-sm wl-btn-primary', text: 'Apply' })
			.addEventListener('click', (e) => {
				e.stopPropagation();
				this.sortCol = colSel.value;
				this.sortDir = dirSel.value as 'asc' | 'desc';
				onClose();
				void this.render();
			});

		panel.addEventListener('click', (e) => e.stopPropagation());
		return panel;
	}

	private async exportToClipboard(list: CustomList): Promise<void> {
		const nonLockedCols = list.columns.filter(c => !c.locked);
		const allCols = [{ id: '#', label: '#' }, { id: 'name', label: 'Name' }, ...nonLockedCols];
		const header = '| ' + allCols.map(c => c.label).join(' | ') + ' |';
		const sep = '| ' + allCols.map(() => '---').join(' | ') + ' |';
		const rows = this.getFilteredSortedRows(list).map((row, i) => {
			const cells = allCols.map(c => {
				if (c.id === '#') return String(i + 1);
				const val = (row as Record<string, string | number | null | undefined>)[c.id];
				return val !== undefined && val !== null ? String(val) : '';
			});
			return '| ' + cells.join(' | ') + ' |';
		});
		try {
			await navigator.clipboard.writeText([header, sep, ...rows].join('\n'));
			new Notice('Copied to clipboard!');
		} catch { new Notice('Failed to copy to clipboard.'); }
	}

	private getFilteredSortedRows(list: CustomList): CustomListRow[] {
		let rows = [...list.rows];
		if (this.searchQuery.trim()) {
			const q = this.searchQuery.toLowerCase();
			rows = rows.filter(r => String((r as Record<string, string | undefined>)['name'] ?? '').toLowerCase().includes(q));
		}
		if (this.sortCol) {
			const col = this.sortCol;
			const dir = this.sortDir;
			rows.sort((a, b) => {
				const av = String((a as Record<string, string | number | undefined>)[col] ?? '').toLowerCase();
				const bv = String((b as Record<string, string | number | undefined>)[col] ?? '').toLowerCase();
				return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
			});
		}
		return rows;
	}

	// ── Table ──────────────────────────────────────────────────────────────────

	private buildTable(container: HTMLElement, list: CustomList, countEl: HTMLElement): void {
		// Store refs for keyboard navigation and search rebuild
		this._countEl = countEl;
		this._tableContainer = container;

		const visibleRows = this.getFilteredSortedRows(list);
		countEl.textContent = `${visibleRows.length} title${visibleRows.length !== 1 ? 's' : ''}`;

		const nonLockedCols = list.columns.filter(c => !c.locked);

		const table = container.createDiv({ cls: 'wl-cl-table' });

		// Header
		const thead = table.createDiv({ cls: 'wl-cl-thead' });
		const hRow = thead.createDiv({ cls: 'wl-cl-tr wl-cl-tr-header' });
		hRow.createDiv({ cls: 'wl-cl-th wl-cl-th-tick' }); // tick column header
		hRow.createDiv({ cls: 'wl-cl-th wl-cl-th-num', text: '#' });
		hRow.createDiv({ cls: 'wl-cl-th', text: 'Name' });
		for (const col of nonLockedCols) {
			const th = hRow.createDiv({ cls: 'wl-cl-th' });
			th.createSpan({ text: col.label });
			if (col.type === 'number' && col.autoTime) {
				const refreshBtn = th.createSpan({ cls: 'wl-cl-autotime-refresh', text: '↻' });
				refreshBtn.title = 'Refresh remaining time values';
				refreshBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					this.autoPopulateTimeColumn(list, col);
					void this.manager.saveList(list).then(() => {
						container.empty();
						this.buildTable(container, list, countEl);
					});
				});
			}
		}
		hRow.createDiv({ cls: 'wl-cl-th wl-cl-th-actions' });

		// Body
		const tbody = table.createDiv({ cls: 'wl-cl-tbody' });
		let dragFromIndex = -1;

		visibleRows.forEach((row, displayIdx) => {
			const isChecked = row.checked === true;
			const tr = tbody.createDiv({ cls: `wl-cl-tr wl-cl-tr-body${isChecked ? ' wl-cl-tr-checked' : ''}` });
			tr.dataset.rowId = row.id;

			// Tick button
			const tickCell = tr.createDiv({ cls: 'wl-cl-td wl-cl-td-tick' });
			const tickBtn = tickCell.createDiv({ cls: `wl-cl-tick-btn${isChecked ? ' is-checked' : ''}` });
			tickBtn.title = isChecked ? 'Uncheck row' : 'Check row';
			tickBtn.textContent = isChecked ? '✓' : '○';
			tickBtn.addEventListener('click', () => {
				const realRow = list.rows.find((r) => r.id === row.id);
				if (!realRow) return;
				realRow.checked = !realRow.checked;
				void this.manager.saveList(list).then(() => { container.empty(); this.buildTable(container, list, countEl); });
			});

			tr.createDiv({ cls: 'wl-cl-td wl-cl-td-num', text: String(displayIdx + 1) });

			const nameCell = tr.createDiv({ cls: 'wl-cl-td wl-cl-td-name' });
			this.renderNameCell(nameCell, row, list, countEl, nonLockedCols, container);

			for (const col of nonLockedCols) {
				const td = tr.createDiv({ cls: 'wl-cl-td' });
				this.renderCustomCell(td, row, col, list);
			}

			// Actions
			const actCell = tr.createDiv({ cls: 'wl-cl-td wl-cl-td-actions' });

			const dragHandle = actCell.createDiv({ cls: 'wl-cl-row-action wl-cl-drag-handle', text: '⠿' });
			dragHandle.title = 'Drag to reorder';

			const dupBtn = actCell.createDiv({ cls: 'wl-cl-row-action wl-cl-dup-btn', text: '⧉' });
			dupBtn.title = 'Duplicate row';
			dupBtn.addEventListener('click', () => {
				const realIdx = list.rows.findIndex(r => r.id === row.id);
				if (realIdx < 0) return;
				const newRow: CustomListRow = {
					...(list.rows[realIdx] as object),
					id: this.manager.generateRowId(list.rows),
				} as CustomListRow;
				list.rows.splice(realIdx + 1, 0, newRow);
				this.duplicatedRowIds.add(newRow.id);
				void this.manager.saveList(list).then(() => { container.empty(); this.buildTable(container, list, countEl); });
			});

			const rowDelBtn = actCell.createDiv({ cls: 'wl-cl-row-action wl-cl-row-del', text: '×' });
			rowDelBtn.title = 'Delete row';
			rowDelBtn.addEventListener('click', () => {
				list.rows = list.rows.filter(r => r.id !== row.id);
				this.duplicatedRowIds.delete(row.id);
				void this.manager.saveList(list).then(() => { container.empty(); this.buildTable(container, list, countEl); });
			});

			// Drag & drop (handle-initiated only)
			tr.setAttribute('draggable', 'false');
			dragHandle.addEventListener('mousedown', () => tr.setAttribute('draggable', 'true'));
			tr.addEventListener('dragstart', (e) => {
				dragFromIndex = list.rows.findIndex(r => r.id === row.id);
				e.dataTransfer?.setData('text/plain', row.id);
				tr.addClass('wl-cl-dragging');
			});
			tr.addEventListener('dragend', () => { tr.removeClass('wl-cl-dragging'); tr.setAttribute('draggable', 'false'); });
			tr.addEventListener('dragover', (e) => { e.preventDefault(); tr.addClass('wl-cl-drag-over'); });
			tr.addEventListener('dragleave', () => tr.removeClass('wl-cl-drag-over'));
			tr.addEventListener('drop', (e) => {
				e.preventDefault();
				tr.removeClass('wl-cl-drag-over');
				const toRealIdx = list.rows.findIndex(r => r.id === row.id);
				if (dragFromIndex !== toRealIdx && dragFromIndex >= 0) {
					const [moved] = list.rows.splice(dragFromIndex, 1);
					list.rows.splice(dragFromIndex < toRealIdx ? toRealIdx - 1 : toRealIdx, 0, moved!);
					void this.manager.saveList(list).then(() => { container.empty(); this.buildTable(container, list, countEl); });
				}
			});
		});

		// Add row
		const addRowEl = container.createDiv({ cls: 'wl-cl-add-row' });
		addRowEl.createEl('button', { cls: 'wl-btn wl-btn-sm wl-btn-success', text: '+ add row' })
			.addEventListener('click', () => {
				const newRow: CustomListRow = { id: this.manager.generateRowId(list.rows), name: '' };
				list.rows.push(newRow);
				void this.manager.saveList(list).then(() => {
					container.empty();
					this.buildTable(container, list, countEl);
					window.setTimeout(() => {
						const newTbody = container.querySelector('.wl-cl-tbody');
						const lastTr = newTbody?.querySelector('.wl-cl-tr-body:last-child') as HTMLElement | null;
						(lastTr?.querySelector('.wl-cl-td-name') as HTMLElement | null)?.click();
					}, 0);
				});
			});
	}

	// ── Cell rendering ─────────────────────────────────────────────────────────

	private renderNameCell(
		cell: HTMLElement,
		row: CustomListRow,
		list: CustomList,
		countEl: HTMLElement,
		nonLockedCols: CustomListColumn[],
		tableContainer: HTMLElement,
	): void {
		cell.empty();
		cell.removeClass('wl-cl-editing');
		const nameVal = String((row as Record<string, string | undefined>)['name'] ?? '');
		const isDuplicated = this.duplicatedRowIds.has(row.id);

		if (nameVal) {
			const span = cell.createSpan({ cls: 'wl-cl-cell-text', text: nameVal });
			if (isDuplicated) span.addClass('wl-cl-dup-name');
		} else {
			cell.createSpan({ cls: 'wl-cl-cell-empty', text: '—' });
		}

		cell.addEventListener('click', () => {
			this.startNameEdit(cell, row, list, countEl, nonLockedCols, tableContainer);
		}, { once: true });
	}

	private startNameEdit(
		cell: HTMLElement,
		row: CustomListRow,
		list: CustomList,
		countEl: HTMLElement,
		nonLockedCols: CustomListColumn[],
		tableContainer: HTMLElement,
	): void {
		const prevVal = String((row as Record<string, string | undefined>)['name'] ?? '');

		cell.empty();
		cell.addClass('wl-cl-editing');
		this._escapeKeyHandler = (e: KeyboardEvent) => {
    		if (e.key === 'Escape') {
        		e.stopPropagation();
        		e.stopImmediatePropagation();
        		e.preventDefault();
    		}
		};
		activeDocument.addEventListener('keydown', this._escapeKeyHandler, true);
		activeDocument.addEventListener('keyup', this._escapeKeyHandler, true);
		const escHandler = this._escapeKeyHandler;
		this.addCleanup(() => {
			activeDocument.removeEventListener('keydown', escHandler, true);
			activeDocument.removeEventListener('keyup', escHandler, true);
		});

		// Mobile viewport: scroll active element into view when virtual keyboard shrinks viewport
		const vpResizeHandler = (): void => {
			const active = activeDocument.activeElement as HTMLElement | null;
			if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
		};
		if (window.visualViewport) window.visualViewport.addEventListener('resize', vpResizeHandler);
		this.addCleanup(() => {
			if (window.visualViewport) window.visualViewport.removeEventListener('resize', vpResizeHandler);
		});
		window.setTimeout(() => cell.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);

		const wrap = cell.createDiv({ cls: 'wl-cl-autofill-wrap' });
		const input = wrap.createEl('input', {
			cls: 'wl-cl-cell-input',
			attr: { type: 'text', value: prevVal },
		});
		input.focus();
		input.select();

		// Autofill — rendered on document.body with position:fixed to escape table overflow:hidden
		let dropdown: HTMLElement | null = null;
		let focusedSuggestionIdx = -1;
		const clearDropdown = (): void => { dropdown?.remove(); dropdown = null; focusedSuggestionIdx = -1; };

		input.addEventListener('input', () => {
			clearDropdown();
			const q = input.value.toLowerCase();
			if (!q) return;
			// Suggestions come from both the Watchlist and the Reading list (Books + Manga).
			const reading = this.plugin.readingDataManager;
			const suggestions: { title: string; meta: string }[] = [
				...this.dataManager.getTitles().map(t => ({ title: t.title, meta: `${t.type} · ${t.status}` })),
				...reading.getBooks().map(b => ({ title: b.title, meta: `Book · ${b.status}` })),
				...reading.getMangaList().map(m => ({ title: m.title, meta: `Manga · ${m.status}` })),
			]
				.filter(s => s.title.toLowerCase().includes(q))
				.slice(0, 10);
			if (!suggestions.length) return;
			const rect = input.getBoundingClientRect();
			dropdown = activeDocument.body.createDiv({ cls: 'wl-cl-autofill-dropdown wl-pos-fixed' });
			dropdown.style.top = `${rect.bottom}px`;
			dropdown.style.left = `${rect.left}px`;
			dropdown.style.width = `${rect.width}px`;
			for (const sug of suggestions) {
				const item = dropdown.createDiv({ cls: 'wl-result-item' });
				item.createDiv({ cls: 'wl-result-title', text: sug.title });
				item.createDiv({ cls: 'wl-result-meta', text: sug.meta });
				item.addEventListener('mousedown', (e) => { e.preventDefault(); input.value = sug.title; clearDropdown(); });
			}
		});

		let saved = false;
		let navDirection: 'tab' | 'shift-tab' | 'enter' | null = null;

		const doSave = async (cancel: boolean): Promise<void> => {
			if (saved) return;
			saved = true;
			if (window.visualViewport) window.visualViewport.removeEventListener('resize', vpResizeHandler);
			if (this._escapeKeyHandler) {
    			activeDocument.removeEventListener('keydown', this._escapeKeyHandler, true);
    			activeDocument.removeEventListener('keyup', this._escapeKeyHandler, true);
    			this._escapeKeyHandler = null;
			}
			clearDropdown();
			const newVal = input.value.trim();
			if (!cancel) {
				const isDup = this.duplicatedRowIds.has(row.id);
				(row as Record<string, unknown>)['name'] = newVal;
				if (isDup && newVal !== prevVal) this.duplicatedRowIds.delete(row.id);
				await this.manager.saveList(list);
			}
			this.renderNameCell(cell, row, list, countEl, nonLockedCols, tableContainer);
			if (!cancel && navDirection) this.navigateCell(cell, navDirection);
		};

		input.addEventListener('blur', () => void doSave(false));
		input.addEventListener('keydown', (e) => {
			// Keyboard navigation in suggestion dropdown
			if (dropdown) {
				const items = Array.from(dropdown.querySelectorAll<HTMLElement>('.wl-result-item'));
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					focusedSuggestionIdx = Math.min(focusedSuggestionIdx + 1, items.length - 1);
					items.forEach((item, i) => {
						if (i === focusedSuggestionIdx) item.addClass('wl-result-item-focused');
						else item.removeClass('wl-result-item-focused');
					});
					return;
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					focusedSuggestionIdx = Math.max(focusedSuggestionIdx - 1, 0);
					items.forEach((item, i) => {
						if (i === focusedSuggestionIdx) item.addClass('wl-result-item-focused');
						else item.removeClass('wl-result-item-focused');
					});
					return;
				}
				if (e.key === 'Enter' && focusedSuggestionIdx >= 0) {
					e.preventDefault();
					const titleText = items[focusedSuggestionIdx]?.querySelector<HTMLElement>('.wl-result-title')?.textContent ?? '';
					if (titleText) input.value = titleText;
					clearDropdown();
					return;
				}
				if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					e.stopImmediatePropagation();
					clearDropdown();
					return;
				}
			}

			if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); navDirection = 'shift-tab'; void doSave(false); }
			else if (e.key === 'Tab') { e.preventDefault(); navDirection = 'tab'; void doSave(false); }
			else if (e.key === 'Enter') { e.preventDefault(); navDirection = 'enter'; void doSave(false); }
			else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void doSave(true); }
		});
	}

	private renderCustomCell(
		cell: HTMLElement,
		row: CustomListRow,
		col: CustomListColumn,
		list: CustomList,
	): void {
		cell.empty();
		cell.removeClass('wl-cl-editing');
		const val = (row as Record<string, string | number | undefined>)[col.id];

		if (col.type === 'select') {
			const strVal = String(val ?? '');
			if (strVal) cell.createSpan({ cls: 'wl-cl-select-badge', text: strVal });
			else cell.createSpan({ cls: 'wl-cl-cell-empty', text: '—' });
		} else {
			const strVal = val !== undefined && val !== null && val !== '' ? String(val) : '';
			if (strVal) {
				const span = cell.createSpan({ cls: 'wl-cl-cell-text', text: strVal });
				if (col.bold) span.addClass('wl-cell-bold');
				if (col.italic) span.addClass('wl-cell-italic');
			} else {
				cell.createSpan({ cls: 'wl-cl-cell-empty', text: '—' });
			}
		}

		cell.addEventListener('click', () => this.startCustomEdit(cell, row, col, list), { once: true });
	}

	private startCustomEdit(
		cell: HTMLElement,
		row: CustomListRow,
		col: CustomListColumn,
		list: CustomList,
	): void {
		const currentVal = (row as Record<string, string | number | undefined>)[col.id];

		cell.empty();
		cell.addClass('wl-cl-editing');

		// Mobile viewport: scroll active element into view when virtual keyboard shrinks viewport
		const vpResizeHandler = (): void => {
			const active = activeDocument.activeElement as HTMLElement | null;
			if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
		};
		if (window.visualViewport) window.visualViewport.addEventListener('resize', vpResizeHandler);
		this.addCleanup(() => {
			if (window.visualViewport) window.visualViewport.removeEventListener('resize', vpResizeHandler);
		});
		window.setTimeout(() => cell.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);

		let getValue: () => string | number | undefined;
		let saved = false;
		let navDirection: 'tab' | 'shift-tab' | 'enter' | null = null;

		const doSave = async (cancel: boolean): Promise<void> => {
			if (saved) return;
			saved = true;
			if (window.visualViewport) window.visualViewport.removeEventListener('resize', vpResizeHandler);
			if (this._escapeKeyHandler) {
    			activeDocument.removeEventListener('keydown', this._escapeKeyHandler, true);
    			activeDocument.removeEventListener('keyup', this._escapeKeyHandler, true);
    			this._escapeKeyHandler = null;
			}
			cell.removeClass('wl-cl-editing');
			if (!cancel) {
				const newVal = getValue();
				(row as Record<string, unknown>)[col.id] = (newVal === '' || newVal === undefined) ? undefined : newVal;
				await this.manager.saveList(list);
			}
			this.renderCustomCell(cell, row, col, list);
			if (!cancel && navDirection) this.navigateCell(cell, navDirection);
		};

		if (col.type === 'select') {
			const select = cell.createEl('select', { cls: 'wl-select wl-cl-cell-select' });
			select.createEl('option', { value: '', text: '—' });
			for (const opt of (col.options ?? [])) {
				const o = select.createEl('option', { value: opt, text: opt });
				if (currentVal === opt) o.selected = true;
			}
			getValue = () => select.value;
			select.focus();
			select.addEventListener('change', () => void doSave(false));
			select.addEventListener('blur', () => void doSave(false));
			select.addEventListener('keydown', (e) => {
				if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void doSave(true); }
				else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); navDirection = 'shift-tab'; void doSave(false); }
				else if (e.key === 'Tab') { e.preventDefault(); navDirection = 'tab'; void doSave(false); }
			});
		} else if (col.type === 'number') {
			const input = cell.createEl('input', {
				cls: 'wl-cl-cell-input',
				attr: { type: 'number', value: currentVal !== undefined && currentVal !== null ? String(currentVal) : '' },
			});
			getValue = () => { const n = parseFloat(input.value); return isNaN(n) ? '' : n; };
			input.focus();
			input.select();
			input.addEventListener('blur', () => void doSave(false));
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') { e.preventDefault(); navDirection = 'enter'; void doSave(false); }
				else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); navDirection = 'shift-tab'; void doSave(false); }
				else if (e.key === 'Tab') { e.preventDefault(); navDirection = 'tab'; void doSave(false); }
				else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void doSave(true); }
			});
		} else {
			const input = cell.createEl('input', {
				cls: 'wl-cl-cell-input',
				attr: { type: 'text', value: currentVal !== undefined && currentVal !== null ? String(currentVal) : '' },
			});
			getValue = () => input.value;
			input.focus();
			input.select();
			input.addEventListener('blur', () => void doSave(false));
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') { e.preventDefault(); navDirection = 'enter'; void doSave(false); }
				else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); navDirection = 'shift-tab'; void doSave(false); }
				else if (e.key === 'Tab') { e.preventDefault(); navDirection = 'tab'; void doSave(false); }
				else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); void doSave(true); }
			});
		}
	}

	// ── Auto-populate time column ──────────────────────────────────────────────

	private autoPopulateTimeColumn(list: CustomList, col: CustomListColumn): void {
		const titles = this.dataManager.getTitles();
		for (const row of list.rows) {
			const rowName = String(row['name'] ?? '').trim();
			if (!rowName) continue;
			const match = titles.find(t => t.title === rowName);
			if (!match) {
				row[col.id] = 'Not found';
				continue;
			}
			const remainingMinutes = this.dataManager.calcTimeRemainingForModal(match);
			row[col.id] = remainingMinutes;
		}
	}

	// ── Keyboard navigation ─────────────────────────────────────────────────────

	/** Returns editable cells (Name + custom) in a row, skipping # and actions. */
	private getEditableCells(tr: Element): Element[] {
		return Array.from(tr.querySelectorAll(':scope > .wl-cl-td'))
			.filter(c => !c.classList.contains('wl-cl-td-num') && !c.classList.contains('wl-cl-td-actions'));
	}

	private navigateCell(cell: HTMLElement, direction: 'tab' | 'shift-tab' | 'enter'): void {
		const tr = cell.closest('.wl-cl-tr-body');
		if (!tr) return;
		const tbody = tr.parentElement;
		if (!tbody) return;

		const rows = Array.from(tbody.querySelectorAll(':scope > .wl-cl-tr-body'));
		const rowIdx = rows.indexOf(tr);
		const editableCells = this.getEditableCells(tr);
		const colIdx = editableCells.indexOf(cell);

		if (direction === 'tab') {
			if (colIdx >= 0 && colIdx < editableCells.length - 1) {
				// Next cell in same row
				window.setTimeout(() => (editableCells[colIdx + 1] as HTMLElement | undefined)?.click(), 10);
			} else if (rowIdx >= 0 && rowIdx < rows.length - 1) {
				// First cell of next row
				const nextRow = rows[rowIdx + 1];
				if (nextRow) {
					const nextCells = this.getEditableCells(nextRow);
					if (nextCells.length) window.setTimeout(() => (nextCells[0] as HTMLElement | undefined)?.click(), 10);
				}
			} else {
				// Last cell of last row → add new row, focus name
				this.addRowForNavigation(0);
			}
		} else if (direction === 'shift-tab') {
			if (colIdx > 0) {
				// Previous cell in same row
				window.setTimeout(() => (editableCells[colIdx - 1] as HTMLElement | undefined)?.click(), 10);
			} else if (rowIdx > 0) {
				// Last cell of previous row
				const prevRow = rows[rowIdx - 1];
				if (prevRow) {
					const prevCells = this.getEditableCells(prevRow);
					if (prevCells.length) window.setTimeout(() => (prevCells[prevCells.length - 1] as HTMLElement | undefined)?.click(), 10);
				}
			}
			// First cell of first row → do nothing
		} else { // enter
			if (rowIdx >= 0 && rowIdx < rows.length - 1) {
				// Same column in next row
				const nextRow = rows[rowIdx + 1];
				if (nextRow) {
					const nextCells = this.getEditableCells(nextRow);
					const targetIdx = Math.min(colIdx >= 0 ? colIdx : 0, nextCells.length - 1);
					if (nextCells.length) window.setTimeout(() => (nextCells[targetIdx] as HTMLElement | undefined)?.click(), 10);
				}
			} else {
				// Last row → add new row, focus same column
				this.addRowForNavigation(colIdx >= 0 ? colIdx : 0);
			}
		}
	}

	private addRowForNavigation(colIdx: number): void {
		const list = this.currentList;
		const tableContainer = this._tableContainer;
		const countEl = this._countEl;
		if (!list || !tableContainer || !countEl) return;

		const newRow: CustomListRow = { id: this.manager.generateRowId(list.rows), name: '' };
		list.rows.push(newRow);
		void this.manager.saveList(list).then(() => {
			tableContainer.empty();
			this.buildTable(tableContainer, list, countEl);
			window.setTimeout(() => {
				const newTbody = tableContainer.querySelector('.wl-cl-tbody');
				if (!newTbody) return;
				const allRows = Array.from(newTbody.querySelectorAll('.wl-cl-tr-body'));
				const lastRow = allRows[allRows.length - 1];
				if (!lastRow) return;
				const cells = this.getEditableCells(lastRow);
				const target = cells[Math.min(colIdx, cells.length - 1)] as HTMLElement | undefined;
				target?.click();
			}, 50);
		});
	}
}
