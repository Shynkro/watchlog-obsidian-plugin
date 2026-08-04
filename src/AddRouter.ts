import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import { AddTitleModal } from './AddTitleModal';
import { AddReadingModal } from './AddReadingModal';
import { AddGameModal } from './AddGameModal';
import { DraftChoiceModal } from './DraftChoiceModal';

interface AddRouteOptions {
	plugin: WatchLogPlugin;
	dataManager: DataManager;
	/** Prefills the search box and the title field of whichever Add modal is picked. */
	title: string;
	/** Fires once the title is actually saved into a library. */
	onAdded?: () => void;
	/** Chooser heading — "Add draft" from Drafts, "Add title" elsewhere. */
	heading?: string;
}

/**
 * Opens the Watchlist / Book / Manga / Game chooser for a loose title string, then the matching Add
 * modal with that title prefilled. Shared by the Drafts cards and the Custom Lists rows so the four
 * routes live in one place.
 */
export function openAddForTitle(opts: AddRouteOptions): void {
	const { plugin, dataManager, title, onAdded, heading } = opts;
	const done = (): void => onAdded?.();

	new DraftChoiceModal(plugin.app, title, (choice) => {
		if (choice === 'watchlist') {
			new AddTitleModal(plugin.app, plugin, dataManager, done, undefined, {
				searchQuery: title,
				title,
				type: 'Anime',
				episodes: 0,
				duration: 0,
				releaseDate: '',
				link: '',
				seasons: [],
			}).open();
		} else if (choice === 'game') {
			new AddGameModal(plugin.app, plugin, plugin.gameDataManager, done, {
				searchQuery: title,
				title,
			}).open();
		} else {
			new AddReadingModal(
				plugin.app,
				plugin,
				plugin.readingDataManager,
				choice,
				done,
				undefined,
				title,
			).open();
		}
	}, heading).open();
}
