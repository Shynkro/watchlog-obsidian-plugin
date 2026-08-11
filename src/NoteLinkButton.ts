import { App, Notice, TFile, setIcon } from 'obsidian';

/** Open a vault note by path (or TFile). Shows a notice if the file is missing. */
export async function openNoteFile(app: App, path: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		new Notice('Note file not found for this title.');
		return;
	}
	await app.workspace.getLeaf().openFile(file);
}

/**
 * The shared "Open note" file-text icon button used by the Watchlist and Reading detail modals.
 * Callers resolve their own `.md` target (paths differ per tab) and pass it here; this only renders
 * the icon and wires open-on-click with graceful failure.
 *
 * @param target The resolved note as a `TFile`, or a vault path to look up.
 * @param onOpen Optional callback after a successful open (e.g. close the modal).
 */
export function appendNoteLinkButton(
	app: App,
	parent: HTMLElement,
	target: TFile | string,
	onOpen?: () => void,
): HTMLElement {
	// sizing/alignment come from .wl-acc-link-icon (matches the globe)
	const noteIcon = parent.createSpan({ cls: 'wl-acc-link-icon' });
	setIcon(noteIcon, 'file-text');
	noteIcon.setAttr('aria-label', 'Open note');
	noteIcon.title = 'Open note';
	noteIcon.addEventListener('click', (e) => {
		e.stopPropagation();
		const path = target instanceof TFile ? target.path : target;
		void openNoteFile(app, path).then(() => onOpen?.());
	});
	return noteIcon;
}
