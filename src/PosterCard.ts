// PosterCard — shared builder for the Watchlist-style poster card (`wl-card`): letter placeholder +
// lazy <img> + status badge + overlay (title, type badge, year, progress bar) + ⋮ menu. Extracted
// from ListTab so every poster-card grid builds the same DOM; the caller supplies data + callbacks.
//
// Also exports openCardMenu — the card context-menu plumbing that was duplicated across ListTab,
// ReadingTab and AirtimeTab. The class prefix parameterises the CSS, so each tab keeps its styling.

import { setIcon } from 'obsidian';

export interface CardMenuItem {
	label: string;
	/** Receives the card element the menu belongs to. */
	onClick: (card: HTMLElement) => void;
}

export interface CardMenuContext {
	/** Scopes "close any open menu" and the right-edge alignment box. */
	container: HTMLElement;
	/** Render-scoped cleanup registry — the document-level dismiss listener is
	 *  pushed here so a re-render can't leave it dangling. */
	cleanups: (() => void)[];
}

/**
 * Open a card's ⋮ menu: closes any other open menu, right-aligns near the container's right edge,
 * and dismisses on any outside click (registered on the card's own document, so popouts work).
 */
export function openCardMenu(
	card: HTMLElement,
	anchorBtn: HTMLElement,
	items: CardMenuItem[],
	ctx: CardMenuContext,
	clsPrefix = 'wl-card',
): void {
	ctx.container.querySelectorAll(`.${clsPrefix}-context-menu`).forEach((el) => el.remove());

	const menu = card.createDiv({ cls: `${clsPrefix}-context-menu` });
	const cardRect = card.getBoundingClientRect();
	const containerRect = ctx.container.getBoundingClientRect();
	if (cardRect.right > containerRect.right - 180) {
		menu.classList.add('is-right-aligned');
	}

	// capture the owning document once so add/remove can't desync across popout windows
	const doc = card.ownerDocument;
	const closeMenu = (): void => {
		menu.remove();
		doc.removeEventListener('click', onDocClick, true);
	};
	const onDocClick = (e: MouseEvent): void => {
		if (!menu.contains(e.target as Node) && e.target !== anchorBtn) {
			closeMenu();
		}
	};
	// defer registration so the click that opened the menu doesn't close it
	window.setTimeout(() => doc.addEventListener('click', onDocClick, true), 0);
	ctx.cleanups.push(() => doc.removeEventListener('click', onDocClick, true));

	for (const item of items) {
		const itemEl = menu.createDiv({ cls: `${clsPrefix}-context-item`, text: item.label });
		itemEl.addEventListener('click', (e) => {
			e.stopPropagation();
			closeMenu();
			item.onClick(card);
		});
	}
}

/**
 * Height (px) of the text block under a poster card in text-under mode — title + type/year +
 * progress bar. Grid metrics add this to the poster height; must match .wl-card-under-info in
 * styles.css.
 */
export const POSTER_CARD_TEXT_H = 54;

export interface PosterCardSpec {
	/** Stamped into the card's dataset (e.g. `{ titleId: id }`) so the lazy
	 *  observer / poster refresh can resolve the item later. */
	dataset?: Record<string, string>;
	title: string;
	/** Resolved display image URL — applied immediately when it's an http(s) URL. */
	posterUrl?: string | null;
	/** Flag the card for the lazy poster observer (`data-needs-poster`). */
	needsPoster?: boolean;
	/** Letter-placeholder background colour. */
	placeholderColor: string;
	cardWidth?: number;
	cardHeight?: number;
	selected?: boolean;
	statusLabel?: string;
	statusColor?: string;
	typeLabel?: string;
	typeColor?: string;
	/** Release year beside the type badge; omitted entirely when unknown. */
	year?: string;
	/** 0..1 fill ratio for the progress bar; omit for no bar. */
	progressRatio?: number;
	/**
	 * Card text placement (the cardTextStyle setting): true renders name + type/year + progress in a
	 * block under the poster inside a `wl-card-cell` wrapper, instead of the bottom overlay. The status
	 * badge and ⋮ menu stay on the poster either way; `cardHeight` is then the whole cell.
	 */
	textUnder?: boolean;
	/** Small always-visible corner marker left of the ⋮ button (Games wishlist). `icon` is a Lucide id. */
	flag?: { icon: string; label: string };
	/**
	 * Called when the poster <img> fails to load (e.g. persist the 'none' sentinel). The has-poster
	 * class is already removed.
	 */
	onPosterError?: () => void;
	menuAriaLabel?: string;
	/** Omit for no ⋮ button. */
	menuItems?: CardMenuItem[];
	onClick: (card: HTMLElement) => void;
	/** Right-click on the card (e.g. open detail modal when openNoteOnClick is on). */
	onContextMenu?: (card: HTMLElement) => void;
}

export function buildPosterCard(
	parent: HTMLElement,
	spec: PosterCardSpec,
	menuCtx: CardMenuContext,
): HTMLElement {
	// text-under mode wraps the poster in a cell (the Upcoming tracker-cell pattern): the cell carries
	// the total height, the poster keeps its 2:3 ratio via CSS, and the text block fills the rest
	const cell = spec.textUnder ? parent.createDiv({ cls: 'wl-card-cell' }) : null;
	const card = (cell ?? parent).createDiv({ cls: 'wl-card' });
	for (const [key, value] of Object.entries(spec.dataset ?? {})) {
		card.dataset[key] = value;
	}
	// cards built while scrolling during selection mode must show their state
	if (spec.selected) card.addClass('wl-card-selected');
	// width is distributed by the parent CSS grid (1fr columns) — do NOT set an explicit width here.
	// Fractional pixel widths per card made flex-wrap overflow and shift the grid a slot per scroll.
	if (spec.cardHeight !== undefined) {
		(cell ?? card).style.height = `${spec.cardHeight}px`;
	}

	const placeholder = card.createDiv({ cls: 'wl-card-poster-placeholder' });
	placeholder.style.backgroundColor = spec.placeholderColor;
	const letter = (spec.title.trim().charAt(0) || '?').toUpperCase();
	placeholder.createSpan({ text: letter });

	const img = card.createEl('img', { cls: 'wl-card-poster' });
	img.alt = spec.title;
	// decode off the main thread — the letter placeholder covers the extra frame, and a synchronous
	// decode of a large cover janks the scroll
	img.decoding = 'async';
	// give the <img> definite intrinsic dimensions so it never momentarily lays out at its natural
	// (post-load) size; the CSS (absolute inset:0 + object-fit:cover) then fills the card's box. Shelf
	// cards pass only cardWidth, so derive the height from the same 2:3 ratio.
	if (spec.cardWidth !== undefined) {
		img.width = Math.round(spec.cardWidth);
		img.height = Math.round(
			spec.textUnder ? spec.cardWidth * 1.5 : spec.cardHeight ?? spec.cardWidth * 1.5,
		);
	}

	if (spec.posterUrl && spec.posterUrl.startsWith('http')) {
		// reveal synchronously: gating on onload made every re-render flash the letter placeholder for a
		// frame, because onload is async even for a fully cached image. An <img> paints nothing until its
		// data arrives, so the placeholder still covers a genuinely slow load; onerror re-hides the img and
		// restores the placeholder. Attach onerror before src so a cached failure still fires.
		img.onerror = () => {
			card.removeClass('has-poster');
			spec.onPosterError?.();
		};
		card.addClass('has-poster');
		img.src = spec.posterUrl;
	} else if (spec.needsPoster) {
		card.dataset.needsPoster = 'true';
	}

	if (spec.statusLabel) {
		const statusBadge = card.createSpan({
			cls: 'wl-card-status-badge',
			text: spec.statusLabel,
		});
		if (spec.statusColor) statusBadge.style.backgroundColor = spec.statusColor;
	}

	// name + type/year + progress live either in the classic bottom overlay (inside mode) or in the
	// under-info block below the poster (under mode)
	const textHost = cell
		? cell.createDiv({ cls: 'wl-card-under-info' })
		: card.createDiv({ cls: 'wl-card-overlay' });
	textHost.createSpan({
		cls: cell ? 'wl-card-under-title' : 'wl-card-title',
		text: spec.title,
	});
	if (spec.typeLabel) {
		const metaRow = textHost.createDiv({ cls: 'wl-card-meta-row' });
		const typeBadge = metaRow.createSpan({
			cls: 'wl-card-type-badge',
			text: spec.typeLabel,
		});
		if (spec.typeColor) typeBadge.style.backgroundColor = spec.typeColor;
		if (spec.year) {
			metaRow.createSpan({
				cls: cell ? 'wl-card-under-year' : 'wl-card-year',
				text: spec.year,
			});
		}
	}

	if (spec.flag) {
		const flag = card.createSpan({ cls: 'wl-card-flag-badge' });
		flag.setAttr('aria-label', spec.flag.label);
		flag.title = spec.flag.label;
		setIcon(flag, spec.flag.icon);
	}

	if (spec.progressRatio !== undefined) {
		const bar = textHost.createDiv({ cls: 'wl-card-progress-bar' });
		const fill = bar.createDiv({ cls: 'wl-card-progress-fill' });
		fill.style.width = `${Math.max(0, Math.min(1, spec.progressRatio)) * 100}%`;
	}

	const menuItems = spec.menuItems;
	if (menuItems && menuItems.length > 0) {
		const menuBtn = card.createEl('button', {
			cls: 'wl-card-menu-btn',
			text: '⋮',
		});
		menuBtn.setAttr('aria-label', spec.menuAriaLabel ?? 'More actions');
		menuBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			openCardMenu(card, menuBtn, menuItems, menuCtx);
		});
	}

	// in under mode the whole cell is clickable (poster AND text), but the callback still receives the
	// card — selection styling lives there
	const clickTarget = cell ?? card;
	clickTarget.addEventListener('click', () => spec.onClick(card));
	if (spec.onContextMenu) {
		clickTarget.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			e.stopPropagation();
			spec.onContextMenu?.(card);
		});
	}
	return card;
}
