import { App, FuzzySuggestModal } from 'obsidian';

/** A unified finder entry spanning watchlist titles and reading items. */
export interface UpcomingFinderItem {
	source: 'watchlist' | 'reading';
	kind?: 'book' | 'manga';
	id: string;
	title: string;
	/** Type/kind label shown in parentheses (e.g. "Anime", "Book", "Manga"). */
	typeLabel: string;
}

/**
 * The shared "+ add" finder for the Upcoming tab. Extends the watchlist finder to
 * also surface Reading items, so a reading title can be added to Upcoming through
 * the exact same pathway — never a separate add flow.
 */
export class UpcomingFinderModal extends FuzzySuggestModal<UpcomingFinderItem> {
	private items: UpcomingFinderItem[];
	private onSelect: (item: UpcomingFinderItem) => void;

	constructor(app: App, items: UpcomingFinderItem[], onSelect: (item: UpcomingFinderItem) => void) {
		super(app);
		this.items = items;
		this.onSelect = onSelect;
		this.setPlaceholder('Search a title to add to Upcoming...');
	}

	getItems(): UpcomingFinderItem[] {
		return this.items;
	}

	getItemText(item: UpcomingFinderItem): string {
		return `${item.title} (${item.typeLabel})`;
	}

	onChooseItem(item: UpcomingFinderItem): void {
		this.onSelect(item);
	}
}
