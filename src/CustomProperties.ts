import { Notice } from 'obsidian';
import {
	CustomProperty,
	CustomPropertyType,
	DEFAULT_FIELD_COLOR,
} from './types';
import { ConfirmModal } from './ConfirmModal';
import { openColorPicker, deriveFillColor, deriveBorderColor } from './ColorPicker';
import { createDatePicker } from './DatePicker';
import type { App } from 'obsidian';

export const CUSTOM_PROPERTY_TYPES: CustomPropertyType[] = ['text', 'number', 'date', 'dropdown'];

/** Built-in frontmatter keys that custom properties must not collide with. */
const RESERVED_YAML_KEYS = new Set([
	'title', 'type', 'status', 'priority', 'review', 'rating', 'progress',
	'totalEpisodes', 'episodeDuration', 'dateStarted', 'dateFinished',
	'dateAdded', 'dateModified', 'releaseDate', 'malId', 'anilistId',
	'communityRating', 'communityVotes', 'communitySource', 'director',
	'cast', 'studio', 'poster', 'trailer', 'externalLink', 'pinned', 'favorite',
	'author', 'pagesRead', 'totalPages', 'progressUnit', 'wordsRead', 'totalWords',
	'chaptersRead', 'totalChapters', 'volumesRead', 'totalVolumes', 'googleBooksId',
	'coverUrl', 'developer', 'publisher', 'genre', 'wishlist', 'playtime',
	'achievements', 'platforms', 'singleplayer', 'coop', 'multiplayer',
	'storeUrl', 'lastPlayed',
]);

/** Normalize legacy `select` → `dropdown` (and coerce unknown types to text). */
export function normalizePropertyType(raw: string | undefined): CustomPropertyType {
	if (raw === 'select' || raw === 'dropdown') return 'dropdown';
	if (raw === 'number' || raw === 'date' || raw === 'text') return raw;
	return 'text';
}

export function isDropdownType(type: string): boolean {
	return type === 'dropdown' || type === 'select';
}

export function normalizeCustomProperty(raw: Partial<CustomProperty> & { type?: string }): CustomProperty {
	return {
		id: typeof raw.id === 'string' && raw.id ? raw.id : `prop-${Date.now()}`,
		name: typeof raw.name === 'string' ? raw.name : 'Field',
		type: normalizePropertyType(raw.type),
		options: Array.isArray(raw.options) ? raw.options.filter((o) => typeof o === 'string') : [],
		color: typeof raw.color === 'string' && raw.color ? raw.color : DEFAULT_FIELD_COLOR,
	};
}

export function normalizeCustomPropertyList(list: unknown): CustomProperty[] {
	if (!Array.isArray(list)) return [];
	return list.map((item) => normalizeCustomProperty((item ?? {}) as Partial<CustomProperty>));
}

/** YAML key from property name; prefixes `prop_` on reserved / empty collisions. */
export function customPropertyYamlKey(name: string): string {
	let key = name
		.trim()
		.replace(/\s+/g, '_')
		.replace(/[^A-Za-z0-9_\-]/g, '');
	if (!key || /^\d/.test(key)) key = `prop_${key || 'field'}`;
	if (RESERVED_YAML_KEYS.has(key)) key = `prop_${key}`;
	return key;
}

export function yamlEscapeValue(value: string): string {
	if (value === '') return '""';
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Append non-empty custom field lines to a frontmatter `lines` array (before the closing `---`). */
export function appendCustomPropertyLines(
	lines: string[],
	properties: CustomProperty[],
	fields: Record<string, string | number> | undefined,
	esc: (v: string) => string = yamlEscapeValue,
): void {
	if (!properties.length || !fields) return;
	for (const prop of properties) {
		const raw = fields[prop.id];
		if (raw === undefined || raw === null || raw === '') continue;
		const key = customPropertyYamlKey(prop.name);
		if (prop.type === 'number' && typeof raw === 'number') {
			lines.push(`${key}: ${raw}`);
		} else {
			lines.push(`${key}: ${esc(String(raw))}`);
		}
	}
}

export function generatePropertyId(existing: CustomProperty[], name: string): string {
	const base = `prop-${name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '') || 'field'}`;
	const ids = new Set(existing.map((p) => p.id));
	if (!ids.has(base)) return base;
	let n = 2;
	while (ids.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

export interface CustomPropertiesEditorConfig {
	app: App;
	container: HTMLElement;
	getList: () => CustomProperty[];
	setList: (next: CustomProperty[]) => Promise<void>;
	/** Optional fill/border style row (Reading). */
	styleToggle?: {
		get: () => 'fill' | 'border';
		set: (v: 'fill' | 'border') => Promise<void>;
	};
	emptyLabel?: string;
	deleteConfirmNoun?: string;
	onChanged?: () => void;
}

/** Shared CRUD list used by Settings → Customize → Properties. */
export function renderCustomPropertiesEditor(cfg: CustomPropertiesEditorConfig): void {
	const wrap = cfg.container.createDiv({ cls: 'wl-custom-props-editor' });

	if (cfg.styleToggle) {
		const styleRow = wrap.createDiv({ cls: 'wl-reading-cols-style-row' });
		styleRow.createSpan({ cls: 'wl-reading-cols-style-label', text: 'Display style:' });
		const group = styleRow.createDiv({ cls: 'wl-reading-cols-style-group' });
		const current = cfg.styleToggle.get();
		for (const opt of ['fill', 'border'] as const) {
			const btn = group.createEl('button', {
				cls: `wl-reading-cols-style-btn${current === opt ? ' is-active' : ''}`,
				text: opt.charAt(0).toUpperCase() + opt.slice(1),
			});
			btn.addEventListener('click', () => {
				void (async () => {
					await cfg.styleToggle!.set(opt);
					group.querySelectorAll('.wl-reading-cols-style-btn').forEach((b) => b.removeClass('is-active'));
					btn.addClass('is-active');
					cfg.onChanged?.();
				})();
			});
		}
	}

	const listEl = wrap.createDiv({ cls: 'wl-reading-manage-cols-list' });
	let dragFrom = -1;

	const redraw = (): void => {
		listEl.empty();
		const cols = cfg.getList();
		if (cols.length === 0) {
			listEl.createDiv({
				cls: 'wl-reading-manage-cols-empty',
				text: cfg.emptyLabel ?? 'No properties yet. Add one below.',
			});
		} else {
			cols.forEach((col, idx) => {
				const card = listEl.createDiv({ cls: 'wl-editcol-card wl-reading-col-card' });
				const handle = card.createDiv({ cls: 'wl-editcol-card-handle', text: '⠿' });
				handle.title = 'Drag to reorder';
				handle.addEventListener('mousedown', () => card.setAttribute('draggable', 'true'));
				card.addEventListener('dragstart', (e) => {
					dragFrom = idx;
					e.dataTransfer?.setData('text/plain', String(idx));
					card.addClass('wl-cl-dragging');
				});
				card.addEventListener('dragend', () => {
					card.removeClass('wl-cl-dragging');
					card.setAttribute('draggable', 'false');
				});
				card.addEventListener('dragover', (e) => {
					e.preventDefault();
					card.addClass('wl-cl-drag-over');
				});
				card.addEventListener('dragleave', () => card.removeClass('wl-cl-drag-over'));
				card.addEventListener('drop', (e) => {
					e.preventDefault();
					card.removeClass('wl-cl-drag-over');
					const from = dragFrom;
					const to = idx;
					dragFrom = -1;
					if (from === to || from < 0) return;
					void (async () => {
						const next = [...cfg.getList()];
						const [moved] = next.splice(from, 1);
						if (!moved) return;
						next.splice(to, 0, moved);
						await cfg.setList(next);
						redraw();
						cfg.onChanged?.();
					})();
				});

				const nameInput = card.createEl('input', {
					cls: 'wl-modal-input wl-editcol-card-name',
					attr: { type: 'text', placeholder: 'Property name' },
				});
				nameInput.value = col.name;
				nameInput.addEventListener('change', () => {
					const nextName = nameInput.value.trim();
					if (!nextName) {
						nameInput.value = col.name;
						return;
					}
					if (nextName === col.name) return;
					void (async () => {
						const next = cfg.getList().map((p) =>
							p.id === col.id ? { ...p, name: nextName } : p,
						);
						await cfg.setList(next);
						redraw();
						cfg.onChanged?.();
					})();
				});

				const typeSelect = card.createEl('select', { cls: 'wl-select wl-editcol-card-type' });
				for (const t of CUSTOM_PROPERTY_TYPES) {
					const opt = typeSelect.createEl('option', {
						value: t,
						text: t.charAt(0).toUpperCase() + t.slice(1),
					});
					if (col.type === t) opt.selected = true;
				}

				const colorDot = card.createEl('button', { cls: 'wl-reading-col-color-dot' });
				colorDot.style.backgroundColor = col.color ?? DEFAULT_FIELD_COLOR;
				colorDot.title = 'Choose field color';
				colorDot.addEventListener('click', (e) => {
					e.stopPropagation();
					openColorPicker({
						anchor: colorDot,
						container: cfg.container,
						current: col.color ?? DEFAULT_FIELD_COLOR,
						allowCustom: true,
						onPick: (color) => {
							void (async () => {
								const next = cfg.getList().map((p) =>
									p.id === col.id ? { ...p, color: color ?? undefined } : p,
								);
								await cfg.setList(next);
								redraw();
								cfg.onChanged?.();
							})();
						},
					});
				});

				const optsInput = card.createEl('input', {
					cls: 'wl-modal-input wl-reading-col-opts-input',
					attr: { type: 'text', placeholder: 'Comma-separated values' },
				});
				optsInput.value = col.options.join(', ');
				optsInput.style.visibility = isDropdownType(col.type) ? '' : 'hidden';
				optsInput.addEventListener('change', () => {
					const parsed = optsInput.value.split(',').map((s) => s.trim()).filter(Boolean);
					void (async () => {
						const next = cfg.getList().map((p) =>
							p.id === col.id ? { ...p, options: parsed } : p,
						);
						await cfg.setList(next);
						cfg.onChanged?.();
					})();
				});

				typeSelect.addEventListener('change', () => {
					const type = normalizePropertyType(typeSelect.value);
					optsInput.style.visibility = isDropdownType(type) ? '' : 'hidden';
					void (async () => {
						const next = cfg.getList().map((p) =>
							p.id === col.id ? { ...p, type, options: isDropdownType(type) ? p.options : [] } : p,
						);
						await cfg.setList(next);
						redraw();
						cfg.onChanged?.();
					})();
				});

				const delBtn = card.createEl('button', {
					cls: 'wl-btn wl-btn-sm wl-editcol-card-del',
					text: '✕',
				});
				delBtn.title = 'Delete this property';
				delBtn.addEventListener('click', () => {
					const noun = cfg.deleteConfirmNoun ?? 'entry';
					new ConfirmModal(
						cfg.app,
						`Delete property "${col.name}"? This removes its data from every ${noun}.`,
						() => {
							void (async () => {
								await cfg.setList(cfg.getList().filter((p) => p.id !== col.id));
								redraw();
								cfg.onChanged?.();
							})();
						},
					).open();
				});
			});
		}
	};

	redraw();

	const addWrap = wrap.createDiv({ cls: 'wl-reading-add-col' });
	addWrap.createDiv({ cls: 'wl-reading-section-label', text: 'Add property' });
	const row = addWrap.createDiv({ cls: 'wl-reading-add-col-row' });

	const nameInput = row.createEl('input', {
		cls: 'wl-modal-input wl-reading-add-col-name',
		attr: { type: 'text', placeholder: 'Property name' },
	});
	const typeSelect = row.createEl('select', { cls: 'wl-select wl-reading-add-col-type' });
	for (const t of CUSTOM_PROPERTY_TYPES) {
		typeSelect.createEl('option', {
			value: t,
			text: t.charAt(0).toUpperCase() + t.slice(1),
		});
	}
	const optsInput = row.createEl('input', {
		cls: 'wl-modal-input wl-reading-add-col-opts',
		attr: { type: 'text', placeholder: 'Options (comma-separated)' },
	});
	const refreshOpts = (): void => {
		optsInput.style.display = isDropdownType(typeSelect.value) ? '' : 'none';
	};
	typeSelect.addEventListener('change', refreshOpts);
	refreshOpts();

	const addBtn = row.createEl('button', {
		cls: 'wl-reading-add-btn wl-btn-success wl-reading-add-col-btn',
		text: 'Add',
	});
	addBtn.addEventListener('click', () => {
		const name = nameInput.value.trim();
		if (!name) {
			new Notice('Enter a property name first.');
			return;
		}
		const type = normalizePropertyType(typeSelect.value);
		const options = isDropdownType(type)
			? optsInput.value.split(',').map((s) => s.trim()).filter(Boolean)
			: [];
		const list = cfg.getList();
		const prop: CustomProperty = {
			id: generatePropertyId(list, name),
			name,
			type,
			options,
			color: DEFAULT_FIELD_COLOR,
		};
		void (async () => {
			await cfg.setList([...list, prop]);
			nameInput.value = '';
			optsInput.value = '';
			typeSelect.value = 'text';
			refreshOpts();
			redraw();
			cfg.onChanged?.();
		})();
	});
}

export interface CustomPropertyFormState {
	values: Record<string, string | number>;
}

/** Render form fields for Add modals; mutates `state.values`. */
export interface CustomPropertiesDetailConfig {
	parent: HTMLElement;
	properties: CustomProperty[];
	getFields: () => Record<string, string | number>;
	fieldStyle?: 'fill' | 'border';
	emptyHint?: string;
	/** Persist a single value (null clears). */
	onSave: (propId: string, value: string | number | null) => Promise<void> | void;
}

/** Detail-modal Properties table (Reading-style chips). */
export function renderCustomPropertiesDetailSection(cfg: CustomPropertiesDetailConfig): void {
	const section = cfg.parent.createDiv({ cls: 'wl-reading-detail-custom' });
	const heading = section.createDiv({ cls: 'wl-reading-detail-custom-heading' });
	heading.createSpan({ cls: 'wl-reading-section-label', text: 'Properties' });

	if (cfg.properties.length === 0) {
		section.createDiv({
			cls: 'wl-reading-detail-custom-empty',
			text: cfg.emptyHint ?? 'No properties yet. Add some in Settings → Customize.',
		});
		return;
	}

	const style = cfg.fieldStyle ?? 'fill';
	const tableCls = style === 'border'
		? 'wl-reading-custom-table is-border-mode'
		: 'wl-reading-custom-table';
	const table = section.createDiv({ cls: tableCls });

	for (const prop of cfg.properties) {
		const row = table.createDiv({ cls: 'wl-reading-custom-row' });
		const labelCell = row.createDiv({ cls: 'wl-reading-custom-label', text: prop.name });
		const valueCell = row.createDiv({ cls: 'wl-reading-custom-value' });
		const color = prop.color ?? DEFAULT_FIELD_COLOR;
		if (style === 'fill') {
			labelCell.setCssProps({ '--wl-field-bg': deriveFillColor(color) });
		} else {
			labelCell.setCssProps({ '--wl-field-border': deriveBorderColor(color) });
		}

		const paint = (): void => {
			const raw = cfg.getFields()[prop.id];
			renderDetailValue(valueCell, prop, raw, async (v) => {
				await cfg.onSave(prop.id, v);
				paint();
			});
		};
		paint();
	}
}

function renderDetailValue(
	cell: HTMLElement,
	prop: CustomProperty,
	raw: string | number | undefined,
	onCommit: (v: string | number | null) => Promise<void>,
): void {
	cell.empty();
	const hasValue = raw !== undefined && raw !== null && raw !== '';
	const display = cell.createSpan({
		cls: `wl-reading-custom-display${hasValue ? '' : ' is-placeholder'}`,
		text: hasValue ? String(raw) : '—',
	});
	display.addEventListener('click', () => {
		cell.empty();
		if (isDropdownType(prop.type)) {
			const select = cell.createEl('select', { cls: 'wl-select wl-reading-custom-input' });
			const blank = select.createEl('option', { value: '', text: '—' });
			if (!hasValue) blank.selected = true;
			for (const opt of prop.options) {
				const o = select.createEl('option', { value: opt, text: opt });
				if (String(raw ?? '') === opt) o.selected = true;
			}
			const commit = (): void => {
				void onCommit(select.value === '' ? null : select.value);
			};
			select.addEventListener('change', commit);
			select.addEventListener('blur', commit);
			select.focus();
			return;
		}
		if (prop.type === 'date') {
			createDatePicker({
				parent: cell,
				value: typeof raw === 'string' ? raw : null,
				inputCls: 'wl-modal-input wl-reading-custom-input',
				onChange: (iso) => { void onCommit(iso); },
			});
			return;
		}
		const input = cell.createEl('input', {
			cls: 'wl-modal-input wl-reading-custom-input',
			attr: {
				type: prop.type === 'number' ? 'number' : 'text',
				placeholder: 'Enter value…',
			},
		});
		if (hasValue) input.value = String(raw);
		const commit = (): void => {
			const t = input.value.trim();
			if (t === '') {
				void onCommit(null);
				return;
			}
			if (prop.type === 'number') {
				const n = Number(t);
				void onCommit(isNaN(n) ? null : n);
			} else {
				void onCommit(t);
			}
		};
		input.addEventListener('blur', commit);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				input.blur();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				void onCommit(raw === undefined ? null : raw).then(() => {
					/* paint restores display */
				});
			}
		});
		input.focus();
		input.select();
	});
}

export function renderCustomPropertyFormFields(
	parent: HTMLElement,
	properties: CustomProperty[],
	state: CustomPropertyFormState,
): void {
	if (!properties.length) return;
	const section = parent.createDiv({ cls: 'wl-custom-props-form' });
	section.createDiv({ cls: 'wl-modal-section-label', text: 'Properties' });
	for (const prop of properties) {
		const row = section.createDiv({ cls: 'wl-modal-field-row' });
		row.createEl('label', { text: prop.name });
		if (isDropdownType(prop.type)) {
			const select = row.createEl('select', { cls: 'wl-select' });
			select.createEl('option', { value: '', text: '—' });
			for (const opt of prop.options) {
				select.createEl('option', { value: opt, text: opt });
			}
			select.addEventListener('change', () => {
				if (select.value === '') delete state.values[prop.id];
				else state.values[prop.id] = select.value;
			});
		} else if (prop.type === 'date') {
			const holder = row.createDiv();
			createDatePicker({
				parent: holder,
				value: null,
				inputCls: 'wl-modal-input',
				onChange: (iso) => {
					if (!iso) delete state.values[prop.id];
					else state.values[prop.id] = iso;
				},
			});
		} else {
			const input = row.createEl('input', {
				cls: 'wl-modal-input',
				attr: {
					type: prop.type === 'number' ? 'number' : 'text',
					placeholder: prop.name,
				},
			});
			input.addEventListener('change', () => {
				const raw = input.value.trim();
				if (raw === '') {
					delete state.values[prop.id];
					return;
				}
				if (prop.type === 'number') {
					const n = Number(raw);
					if (!isNaN(n)) state.values[prop.id] = n;
					else delete state.values[prop.id];
				} else {
					state.values[prop.id] = raw;
				}
			});
		}
	}
}
