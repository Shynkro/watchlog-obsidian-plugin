import { Platform, setIcon } from 'obsidian';

export interface MobileToolbarOptions {
	/** The flex container row that holds the toolbar (e.g. wl-header-controls / wl-reading-toolbar). */
	controls: HTMLElement;
	/** Builds the search input into the given parent. */
	renderSearch: (parent: HTMLElement) => void;
	/** Builds the full set of action buttons into the given parent. */
	renderActions: (parent: HTMLElement) => void;
	/** Current toggle state — true shows actions, false (retracted, default) shows search. */
	expanded: boolean;
	/** Persists the new toggle state on the caller so it survives re-renders. */
	onToggleChange: (expanded: boolean) => void;
}

/**
 * Renders a toolbar that, on mobile only, crossfades between a search input
 * (default / retracted) and its action buttons via a chevron toggle button.
 * Both panes are absolutely positioned inside a fixed-height slot so swapping
 * causes no reflow — only opacity is animated. On desktop the search and the
 * actions render inline together, unchanged.
 *
 * Shared by the Watchlist (ListTab) and Reading (ReadingTab) toolbars so the
 * toggle behaviour lives in exactly one place.
 */
export function renderToolbarWithMobileToggle(options: MobileToolbarOptions): void {
	const { controls, renderSearch, renderActions } = options;

	if (!Platform.isMobile) {
		// Desktop: search sits inline followed by the full set of action buttons.
		renderSearch(controls);
		renderActions(controls);
		return;
	}

	let expanded = options.expanded;

	const slot = controls.createDiv({ cls: 'wl-toolbar-slot' });
	const searchWrap = slot.createDiv({ cls: 'wl-toolbar-slot-pane wl-toolbar-fade' });
	renderSearch(searchWrap);
	const actionsWrap = slot.createDiv({ cls: 'wl-toolbar-slot-pane wl-toolbar-fade' });
	renderActions(actionsWrap);

	const applyState = (): void => {
		searchWrap.toggleClass('wl-toolbar-pane-hidden', expanded);
		actionsWrap.toggleClass('wl-toolbar-pane-hidden', !expanded);
	};
	applyState();

	const toggleBtn = controls.createEl('button', { cls: 'wl-btn wl-btn-sm wl-toolbar-toggle-btn' });
	const applyIcon = (): void => {
		setIcon(toggleBtn, expanded ? 'chevron-right' : 'chevron-left');
		toggleBtn.setAttr('aria-label', expanded ? 'Show search' : 'Show actions');
	};
	applyIcon();
	toggleBtn.addEventListener('click', () => {
		expanded = !expanded;
		options.onToggleChange(expanded);
		applyState();
		applyIcon();
	});
}
