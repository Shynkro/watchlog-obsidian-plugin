import { ItemView, WorkspaceLeaf } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import { DashboardTab } from './DashboardTab';
import { ListTab } from './ListTab';
import { AirtimeTab } from './AirtimeTab';
import { CustomListsTab } from './CustomListsTab';
import { DraftsTab } from './DraftsTab';

export const WATCHLOG_VIEW_TYPE = 'watchlog-view';

type TabName = 'dashboard' | 'watchlist' | 'upcoming' | 'custom-lists' | 'drafts';

export class WatchLogView extends ItemView {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private activeTab: TabName;
	private dashboardTab: DashboardTab | null = null;
	private listTab: ListTab | null = null;
	private airtimeTab: AirtimeTab | null = null;
	private customListsTab: CustomListsTab | null = null;
	private draftsTab: DraftsTab | null = null;
	private airtimeBtn: HTMLButtonElement | null = null;
	private draftsBtn: HTMLButtonElement | null = null;
	private tabContentEl: HTMLElement | null = null;
	private dataChangeListener: () => void;

	constructor(leaf: WorkspaceLeaf, plugin: WatchLogPlugin, dataManager: DataManager) {
		super(leaf);
		this.plugin = plugin;
		this.dataManager = dataManager;
		// defaultView is 'dashboard' | 'watchlist'; map to internal TabName
		const dv = plugin.settings.defaultView as string;
		this.activeTab = (dv === 'watchlist' || dv === 'dashboard') ? dv as TabName : 'watchlist';
		// Re-render in-place so tab instances (and their state) are preserved
		this.dataChangeListener = () => this.refreshActiveTab();
	}

	getViewType(): string {
		return WATCHLOG_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Watchlog';
	}

	getIcon(): string {
		return 'tv';
	}

	// eslint-disable-next-line @typescript-eslint/require-await -- onOpen must be async to match ItemView base class signature
	async onOpen(): Promise<void> {
		this.dataManager.onChange(this.dataChangeListener);
		this.buildUI();
	}

	// eslint-disable-next-line @typescript-eslint/require-await -- onClose must be async to match ItemView base class signature
	async onClose(): Promise<void> {
		this.dataManager.offChange(this.dataChangeListener);
		this.destroyDraftsTab();
	}

	/** Reapplies the active colour theme and rebuilds the UI. Used by SettingsTab. */
	refreshUI(): void {
		this.applyColorTheme(this.contentEl);
		this.buildUI();
	}

	private applyColorTheme(root: HTMLElement): void {
		const colorTheme = this.plugin.settings.colorTheme ?? 'default';
		if (colorTheme === 'default') {
			root.removeAttribute('data-theme');
		} else {
			root.setAttribute('data-theme', colorTheme);
		}
	}

	private destroyDraftsTab(): void {
		if (this.draftsTab) {
			this.draftsTab.destroy();
			this.draftsTab = null;
		}
	}

	private buildUI(): void {
		// Destroy any live drafts listener before rebuilding the UI
		this.destroyDraftsTab();

		const root = this.contentEl;
		root.empty();
		root.addClass('wl-view');
		this.applyColorTheme(root);

		// Tab bar
		const tabBar = root.createDiv({ cls: 'wl-tab-bar' });
		const dashBtn = tabBar.createEl('button', {
			cls: `wl-tab-btn${this.activeTab === 'dashboard' ? ' is-active' : ''}`,
			text: 'Dashboard',
		});
		const listBtn = tabBar.createEl('button', {
			cls: `wl-tab-btn${this.activeTab === 'watchlist' ? ' is-active' : ''}`,
			text: 'Watchlist',
		});
		this.airtimeBtn = tabBar.createEl('button', {
			cls: `wl-tab-btn${this.activeTab === 'upcoming' ? ' is-active' : ''}`,
			text: 'Upcoming',
		});
		const customListsBtn = tabBar.createEl('button', {
			cls: `wl-tab-btn${this.activeTab === 'custom-lists' ? ' is-active' : ''}`,
			text: 'Custom lists',
		});
		this.draftsBtn = tabBar.createEl('button', {
			cls: `wl-tab-btn${this.activeTab === 'drafts' ? ' is-active' : ''}`,
			text: 'Drafts',
		});

		const allBtns = [dashBtn, listBtn, this.airtimeBtn, customListsBtn, this.draftsBtn];

		dashBtn.addEventListener('click', () => {
			if (this.activeTab === 'dashboard') return;
			this.destroyDraftsTab();
			this.activeTab = 'dashboard';
			allBtns.forEach((b) => b.removeClass('is-active'));
			dashBtn.addClass('is-active');
			this.renderTabContent();
		});

		listBtn.addEventListener('click', () => {
			if (this.activeTab === 'watchlist') return;
			this.destroyDraftsTab();
			this.activeTab = 'watchlist';
			allBtns.forEach((b) => b.removeClass('is-active'));
			listBtn.addClass('is-active');
			this.renderTabContent();
		});

		this.airtimeBtn.addEventListener('click', () => {
			if (this.activeTab === 'upcoming') return;
			this.destroyDraftsTab();
			this.activeTab = 'upcoming';
			allBtns.forEach((b) => b.removeClass('is-active'));
			this.airtimeBtn!.addClass('is-active');
			this.renderTabContent();
		});

		customListsBtn.addEventListener('click', () => {
			if (this.activeTab === 'custom-lists') return;
			this.destroyDraftsTab();
			this.activeTab = 'custom-lists';
			allBtns.forEach((b) => b.removeClass('is-active'));
			customListsBtn.addClass('is-active');
			this.renderTabContent();
		});

		this.draftsBtn.addEventListener('click', () => {
			if (this.activeTab === 'drafts') return;
			this.activeTab = 'drafts';
			allBtns.forEach((b) => b.removeClass('is-active'));
			this.draftsBtn!.addClass('is-active');
			this.renderTabContent();
		});

		this.tabContentEl = root.createDiv({ cls: 'wl-tab-content' });
		this.renderTabContent();

		// Initialize Upcoming badge immediately
		this.updateUpcomingBadge();
	}

	private renderTabContent(): void {
		if (!this.tabContentEl) return;
		this.tabContentEl.empty();

		if (this.activeTab === 'dashboard') {
			this.dashboardTab = new DashboardTab(this.tabContentEl, this.plugin, this.dataManager);
			this.dashboardTab.render();
		} else if (this.activeTab === 'watchlist') {
			// Always create a new instance when switching to Watchlist tab so that the
			// container element is correct; state (filters, expandedId) is preserved
			// via the instance kept on this.listTab during data-change refreshes.
			this.listTab = new ListTab(this.tabContentEl, this.plugin, this.dataManager);
			this.listTab.render();
		} else if (this.activeTab === 'upcoming') {
			this.airtimeTab = new AirtimeTab(this.tabContentEl, this.plugin, this.dataManager, (count) => {
				if (this.airtimeBtn) {
					this.airtimeBtn.textContent = count > 0 ? `Upcoming (${count})` : 'Upcoming';
				}
			});
			this.airtimeTab.render();
		} else if (this.activeTab === 'drafts') {
			this.draftsTab = new DraftsTab(
				this.tabContentEl,
				this.plugin,
				this.dataManager,
				(count) => {
					if (this.draftsBtn) {
						this.draftsBtn.textContent = count > 0 ? `Drafts (${count})` : 'Drafts';
					}
				},
			);
			void this.draftsTab.render();
		} else {
			// custom-lists
			this.customListsTab = new CustomListsTab(this.tabContentEl, this.plugin, this.dataManager);
			void this.customListsTab.render();
		}
	}

	/**
	 * Called by the data change listener.  Re-renders the active tab without
	 * destroying the ListTab instance, so expandedId and filter state survive.
	 */
	private refreshActiveTab(): void {
		this.applyColorTheme(this.contentEl);
		if (this.activeTab === 'watchlist' && this.listTab) {
			this.listTab.render();
		} else if (this.activeTab === 'dashboard' && this.dashboardTab) {
			this.dashboardTab.render();
		} else if (this.activeTab === 'upcoming' && this.airtimeTab) {
			this.airtimeTab.render();
		} else if (this.activeTab === 'custom-lists' && this.customListsTab) {
			void this.customListsTab.render();
		} else if (this.activeTab === 'drafts' && this.draftsTab) {
			void this.draftsTab.render();
		} else {
			this.renderTabContent();
		}

		this.updateUpcomingBadge();
	}

	private updateUpcomingBadge(): void {
		if (!this.airtimeBtn) return;
		const count = AirtimeTab.getAiredDueCount(this.dataManager) + AirtimeTab.getMaybeDueCount(this.dataManager);
		this.airtimeBtn.textContent = count > 0 ? `Upcoming (${count})` : 'Upcoming';
	}

}

