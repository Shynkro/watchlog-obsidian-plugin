import { App, Notice, TFile, setIcon } from 'obsidian';

/**
 * Builds the shared "Open note" file-text icon button used by the Watchlist and
 * Reading detail modals. Callers resolve their own `.md` note path/file (paths
 * differ per tab) and pass the resolved target here; this helper only renders
 * the icon and wires the open-on-click with graceful failure handling.
 *
 * @param app     Obsidian app, used to resolve the path and open the leaf.
 * @param parent  Element the button is appended to (sizing comes from the class).
 * @param target  The resolved note as a `TFile`, or a vault path string to look up.
 * @param onOpen  Optional callback fired after a successful open (e.g. close the modal).
 * @returns The created button element.
 */
export function appendNoteLinkButton(
	app: App,
	parent: HTMLElement,
	target: TFile | string,
	onOpen?: () => void,
): HTMLElement {
	// Sizing/alignment come from the .wl-acc-link-icon class (matches the globe).
	const noteIcon = parent.createEl('span', { cls: 'wl-acc-link-icon' });
	setIcon(noteIcon, 'file-text');
	noteIcon.setAttr('aria-label', 'Open note');
	noteIcon.title = 'Open note';
	noteIcon.addEventListener('click', (e) => {
		e.stopPropagation();
		const file =
			target instanceof TFile ? target : app.vault.getAbstractFileByPath(target);
		if (!(file instanceof TFile)) {
			new Notice('Note file not found for this title.');
			return;
		}
		void app.workspace.getLeaf().openFile(file);
		onOpen?.();
	});
	return noteIcon;
}
