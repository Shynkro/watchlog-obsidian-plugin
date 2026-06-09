import { ItemView, Platform, WorkspaceLeaf } from 'obsidian';
import type WatchLogPlugin from './main';
import type { DataManager } from './DataManager';
import { DashboardTab } from './DashboardTab';
import { ListTab } from './ListTab';
import { AirtimeTab } from './AirtimeTab';
import { CustomListsTab } from './CustomListsTab';
import { DraftsTab } from './DraftsTab';
import { ReadingTab } from './ReadingTab';
import { LogTab } from './LogTab';

export const WATCHLOG_VIEW_TYPE = 'watchlog-view';

export type TabName = 'dashboard' | 'watchlist' | 'upcoming' | 'reading' | 'custom-lists' | 'drafts' | 'log';

const TAB_CLASSES = ['wl-dashboard', 'wl-list', 'wl-airtime', 'wl-reading-tab', 'wl-custom-lists', 'wl-log-tab'];

export class WatchLogView extends ItemView {
	private plugin: WatchLogPlugin;
	private dataManager: DataManager;
	private activeTab: TabName;
	private dashboardTab: DashboardTab | null = null;
	private listTab: ListTab | null = null;
	private airtimeTab: AirtimeTab | null = null;
	private readingTab: ReadingTab | null = null;
	private customListsTab: CustomListsTab | null = null;
	private draftsTab: DraftsTab | null = null;
	private logTab: LogTab | null = null;
	private airtimeBtn: HTMLButtonElement | null = null;
	private draftsBtn: HTMLButtonElement | null = null;
	private tabButtons: Partial<Record<TabName, HTMLButtonElement>> = {};
	private tabContentEl: HTMLElement | null = null;
	private dataChangeListener: () => void;
	private mobileResizeObserver: ResizeObserver | null = null;
	private mobileSizerRaf: number | null = null;
	private lastAppliedTabHeight = -1;
	// --- Mobile keyboard "edit pin" state (see edit-pin block below) ---
	private editPinActive = false;
	private smallestEditHeight = -1;
	private pinReleaseTimer: number | null = null;
	private focusListenersBound = false;

	constructor(leaf: WorkspaceLeaf, plugin: WatchLogPlugin, dataManager: DataManager) {
		super(leaf);
		this.plugin = plugin;
		this.dataManager = dataManager;
		// The panel always opens on the Dashboard tab.
		this.activeTab = 'dashboard';
		// Re-render in-place so tab instances (and their state) are preserved
		this.dataChangeListener = () => {
			this.refreshActiveTab();
		};
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

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.dataManager.onChange(this.dataChangeListener);
		this.buildUI();

		if (Platform.isMobile) {
			this.setupTabContentSizer();
		}
	}

	// ===================== Mobile keyboard layout fix =====================
	// Permanent fix for the iOS/Android on-screen-keyboard layout collapse.
	// When the keyboard opens, this WebView freezes .wl-tab-content at its
	// content height instead of distributing .wl-view's free space via
	// flex-grow, leaving the tab content the wrong size until a reflow forces
	// it. Fix: observe .wl-view (contentEl) and, on every settle (keyboard
	// open/close, rotation, split resize), imperatively set an explicit pixel
	// height (+ flex:none !important) on the *current* .wl-tab-content. The
	// element is re-queried in the callback so it survives tab-content rebuilds.
	// =====================================================================
	private setupTabContentSizer(): void {
		// Never run more than one observer (onOpen could run again, etc.).
		this.mobileResizeObserver?.disconnect();
		this.mobileResizeObserver = new ResizeObserver(() => {
			// Coalesce bursts of resize events (keyboard animation fires many)
			// into a single write per frame so we don't thrash the DOM.
			if (this.mobileSizerRaf !== null) return;
			this.mobileSizerRaf = window.requestAnimationFrame(() => {
				this.mobileSizerRaf = null;
				this.applyTabContentHeight();
			});
		});
		this.mobileResizeObserver.observe(this.contentEl);

		// --- Mobile keyboard fix, layer 2: the "edit pin" (focus listeners) ---
		// Detect when an inline editor inside the scroller (.wl-tab-content) gains
		// or loses focus, so we can pin/release the scroller height. Bound once.
		if (!this.focusListenersBound) {
			this.registerDomEvent(this.contentEl, 'focusin', (e: FocusEvent) => this.onScrollerFocusIn(e));
			this.registerDomEvent(this.contentEl, 'focusout', (e: FocusEvent) => this.onScrollerFocusOut(e));
			this.focusListenersBound = true;
		}
	}

	// ===================== Mobile keyboard fix — edit pin =====================
	// Layer 2 of the permanent mobile keyboard fix. On short lists (notably the
	// Custom Lists tab) inline-editing a cell opens the keyboard, but some resize
	// readings during that window momentarily report the FULL no-keyboard height.
	// Honouring them re-expands .wl-tab-content below the keyboard and exposes a
	// dark band under the short content. Fix: while an editor inside the scroller
	// is focused, pin the scroller to the SMALLEST clientHeight observed and
	// ignore any larger reading. Release is guaranteed on focusout (after a grace
	// window, so cell-to-cell navigation doesn't flicker), with a safety net in
	// applyTabContentHeight() for the case where focus leaves without a focusout.
	// =========================================================================

	/** True when `target` is an input/textarea/contenteditable inside .wl-tab-content. */
	private isEditorInScroller(target: EventTarget | null): boolean {
		const node = target as HTMLElement | null;
		if (!node || typeof node.tagName !== 'string') return false;
		const tabContent = this.contentEl.querySelector(':scope > .wl-tab-content');
		if (!tabContent || !tabContent.contains(node)) return false;
		const tag = node.tagName.toLowerCase();
		return tag === 'input' || tag === 'textarea' || node.isContentEditable === true;
	}

	private onScrollerFocusIn(e: FocusEvent): void {
		if (!Platform.isMobile || !this.isEditorInScroller(e.target)) return;
		// Re-focusing within the grace window (cell navigation) — keep the pin.
		if (this.pinReleaseTimer !== null) {
			window.clearTimeout(this.pinReleaseTimer);
			this.pinReleaseTimer = null;
		}
		// Start a fresh editing session: re-measure the smallest height.
		if (!this.editPinActive) this.smallestEditHeight = -1;
		this.editPinActive = true;
		// Force the next reading (keyboard-shrunk) to be applied & pinned.
		this.lastAppliedTabHeight = -1;
		this.applyTabContentHeight();
	}

	private onScrollerFocusOut(e: FocusEvent): void {
		if (!this.isEditorInScroller(e.target)) return;
		if (this.pinReleaseTimer !== null) window.clearTimeout(this.pinReleaseTimer);
		// Grace window: only release if focus has truly left every editor in the
		// scroller (cell-to-cell navigation re-focuses within this window).
		this.pinReleaseTimer = window.setTimeout(() => {
			this.pinReleaseTimer = null;
			const active = this.contentEl.ownerDocument.activeElement;
			if (this.isEditorInScroller(active)) return;
			this.releaseEditPin();
		}, 250);
	}

	/** Drops the pin and hands sizing back to the ResizeObserver (full height). */
	private releaseEditPin(): void {
		if (!this.editPinActive) return;
		this.editPinActive = false;
		this.smallestEditHeight = -1;
		const tabContent = this.contentEl.querySelector<HTMLElement>(':scope > .wl-tab-content');
		// Remove the pinned height and let the observer re-assert the correct
		// full height now the keyboard has closed.
		tabContent?.style.removeProperty('height');
		this.lastAppliedTabHeight = -1;
		this.applyTabContentHeight();
	}

	private applyTabContentHeight(): void {
		const viewContent = this.contentEl;
		if (!viewContent) return;
		const tabBar = viewContent.querySelector<HTMLElement>(':scope > .wl-tab-bar');
		const tabContent = viewContent.querySelector<HTMLElement>(':scope > .wl-tab-content');
		if (!tabContent) return;

		const wlViewClientHeight = viewContent.clientHeight;
		const tabBarHeight = tabBar ? tabBar.offsetHeight : 0;
		let target = wlViewClientHeight - tabBarHeight;

		// Guard: don't write until wl-view has a real measured height.
		if (target <= 0) return;

		// --- Edit pin layer ---------------------------------------------------
		if (this.editPinActive) {
			// Safety net: focus left the scroller without a focusout firing
			// (e.g. the editor element was removed on save). Release now so the
			// scroller doesn't stay pinned at the keyboard-shrunk height.
			if (!this.isEditorInScroller(this.contentEl.ownerDocument.activeElement)) {
				this.releaseEditPin();
				return;
			}
			// Track the smallest height seen while editing and pin to it,
			// ignoring any larger (no-keyboard) reading during this window.
			if (this.smallestEditHeight < 0 || target < this.smallestEditHeight) {
				this.smallestEditHeight = target;
			}
			target = this.smallestEditHeight;
		}

		// Guard: skip redundant writes when the height hasn't changed.
		if (target === this.lastAppliedTabHeight) return;
		this.lastAppliedTabHeight = target;

		// Explicit px height + flex:none beats the `flex: 1 1 0%` base rule, which
		// this WebView fails to distribute. min-height:0 / overflow-y stay intact.
		tabContent.style.setProperty('height', `${target}px`, 'important');
		tabContent.style.setProperty('flex', 'none', 'important');
	}

	/** Called after tab content changes on mobile to re-apply the height. */
	refreshMobileLayout(): void {
		if (!Platform.isMobile || !this.mobileResizeObserver) return;
		// Tab switch recreates .wl-tab-content with no inline height; force a
		// re-apply even if the wl-view height itself hasn't changed.
		this.lastAppliedTabHeight = -1;
		this.applyTabContentHeight();
	}

	async onClose(): Promise<void> {
		await super.onClose();
		this.dataManager.offChange(this.dataChangeListener);
		this.overflowObserver?.disconnect();
		this.overflowObserver = null;
		if (this.mobileResizeObserver) {
			this.mobileResizeObserver.disconnect();
			this.mobileResizeObserver = null;
		}
		if (this.mobileSizerRaf !== null) {
			window.cancelAnimationFrame(this.mobileSizerRaf);
			this.mobileSizerRaf = null;
		}
		// Clear edit-pin timer/state (focus listeners auto-removed via registerDomEvent).
		if (this.pinReleaseTimer !== null) {
			window.clearTimeout(this.pinReleaseTimer);
			this.pinReleaseTimer = null;
		}
		this.editPinActive = false;
		this.smallestEditHeight = -1;
		// Clear the explicit sizing the mobile keyboard fix applied to wl-tab-content.
		const tabContent = this.contentEl.querySelector<HTMLElement>('.wl-tab-content');
		if (tabContent) {
			tabContent.style.removeProperty('height');
			tabContent.style.removeProperty('flex');
		}
		this.destroyDraftsTab();
		this.customListsTab?.destroy();
		this.listTab?.destroy();
		this.readingTab?.destroy();
		this.readingTab = null;
		this.logTab?.destroy();
		this.logTab = null;
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
		const readingBtn = tabBar.createEl('button', {
			cls: `wl-tab-btn${this.activeTab === 'reading' ? ' is-active' : ''}`,
			text: 'Reading',
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
		const logBtn = tabBar.createEl('button', {
			cls: `wl-tab-btn${this.activeTab === 'log' ? ' is-active' : ''}`,
			text: 'Log',
		});

		const allBtns = [dashBtn, listBtn, this.airtimeBtn, readingBtn, customListsBtn, this.draftsBtn, logBtn];
		this.tabButtons = {
			dashboard: dashBtn,
			watchlist: listBtn,
			upcoming: this.airtimeBtn,
			reading: readingBtn,
			'custom-lists': customListsBtn,
			drafts: this.draftsBtn,
			log: logBtn,
		};

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

		readingBtn.addEventListener('click', () => {
			if (this.activeTab === 'reading') return;
			this.destroyDraftsTab();
			this.activeTab = 'reading';
			allBtns.forEach((b) => b.removeClass('is-active'));
			readingBtn.addClass('is-active');
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

		logBtn.addEventListener('click', () => {
			if (this.activeTab === 'log') return;
			this.destroyDraftsTab();
			this.activeTab = 'log';
			allBtns.forEach((b) => b.removeClass('is-active'));
			logBtn.addClass('is-active');
			this.renderTabContent();
		});

		this.tabContentEl = root.createDiv({ cls: 'wl-tab-content' });
		this.renderTabContent();

		// Initialize Upcoming badge immediately
		this.updateUpcomingBadge();

		// Initialize the Drafts badge. The count needs a count-only vault scan, so it
		// only becomes correct once the metadata cache is ready — gate it on 'resolved'
		// (also fires for changes made while Obsidian was closed, avoiding a stale count).
		// A direct call handles the case where the cache is already resolved when the
		// panel is (re)opened, since 'resolved' won't fire again then.
		void this.updateDraftsBadge();
		this.registerEvent(this.plugin.app.metadataCache.on('resolved', () => {
			void this.updateDraftsBadge();
		}));
	}

	/**
	 * Programmatically switch tabs (e.g. from the status-bar Upcoming counter).
	 * Mirrors a tab-button click: updates active state and re-renders the content.
	 */
	setActiveTab(tab: TabName): void {
		if (this.activeTab === tab) return;
		// UI not built yet — record the intent so the initial render reflects it.
		if (!this.tabContentEl) { this.activeTab = tab; return; }
		if (tab !== 'drafts') this.destroyDraftsTab();
		this.activeTab = tab;
		for (const b of Object.values(this.tabButtons)) b?.removeClass('is-active');
		this.tabButtons[tab]?.addClass('is-active');
		this.renderTabContent();
	}

	private renderTabContent(): void {
		if (!this.tabContentEl) return;
		// Tear down any active inline editors / document listeners from the previous tab
		this.customListsTab?.destroy();
		if (this.activeTab !== 'reading') {
			this.readingTab?.destroy();
			this.readingTab = null;
		}
		if (this.activeTab !== 'log') {
			this.logTab?.destroy();
			this.logTab = null;
		}
		this.tabContentEl.empty();
		for (const cls of TAB_CLASSES) this.tabContentEl.removeClass(cls);

		if (this.activeTab === 'dashboard') {
			this.dashboardTab = new DashboardTab(this.tabContentEl, this.plugin, this.dataManager, this.plugin.readingDataManager);
			this.dashboardTab.render();
		} else if (this.activeTab === 'watchlist') {
			// Always create a new instance when switching to Watchlist tab so that the
			// container element is correct; state (filters, expandedId) is preserved
			// via the instance kept on this.listTab during data-change refreshes.
			this.listTab?.destroy();
			this.listTab = new ListTab(this.tabContentEl, this.plugin, this.dataManager);
			this.listTab.render();
		} else if (this.activeTab === 'upcoming') {
			this.airtimeTab = new AirtimeTab(this.tabContentEl, this.plugin, this.dataManager, (count) => {
				if (this.airtimeBtn) {
					this.airtimeBtn.textContent = count > 0 ? `Upcoming (${count})` : 'Upcoming';
				}
			});
			this.airtimeTab.render();
		} else if (this.activeTab === 'reading') {
			this.readingTab?.destroy();
			this.readingTab = new ReadingTab(
				this.tabContentEl,
				this.plugin,
				this.plugin.readingDataManager,
			);
			this.readingTab.render();
		} else if (this.activeTab === 'drafts') {
			this.draftsTab = new DraftsTab(
				this.tabContentEl,
				this.plugin,
				this.dataManager,
				(count) => this.setDraftsBadge(count),
			);
			void this.draftsTab.render();
		} else if (this.activeTab === 'log') {
			this.logTab = new LogTab(this.tabContentEl, this.plugin);
			this.logTab.render();
		} else {
			// custom-lists
			this.customListsTab = new CustomListsTab(this.tabContentEl, this.plugin, this.dataManager);
			void this.customListsTab.render();
		}
		this.guardOverflow();
		this.refreshMobileLayout();
	}

	/**
	 * Called by the data change listener.  Re-renders the active tab without
	 * destroying the ListTab instance, so expandedId and filter state survive.
	 */
	private refreshActiveTab(): void {
		this.applyColorTheme(this.contentEl);
		if (this.tabContentEl) {
			for (const cls of TAB_CLASSES) this.tabContentEl.removeClass(cls);
		}
		if (this.activeTab === 'watchlist' && this.listTab) {
			this.listTab.render();
		} else if (this.activeTab === 'dashboard' && this.dashboardTab) {
			this.dashboardTab.render();
		} else if (this.activeTab === 'upcoming' && this.airtimeTab) {
			this.airtimeTab.render();
		} else if (this.activeTab === 'reading' && this.readingTab) {
			this.readingTab.render();
		} else if (this.activeTab === 'custom-lists' && this.customListsTab) {
			void this.customListsTab.render();
		} else if (this.activeTab === 'drafts' && this.draftsTab) {
			void this.draftsTab.render();
		} else if (this.activeTab === 'log' && this.logTab) {
			this.logTab.render();
		} else {
			this.renderTabContent();
			return;
		}
		this.guardOverflow();
		this.updateUpcomingBadge();
	}

	private overflowObserver: MutationObserver | null = null;

	private guardOverflow(): void {
		if (!this.tabContentEl) return;
		this.overflowObserver?.disconnect();

		const el = this.tabContentEl;
		const renderTime = Date.now();

		this.overflowObserver = new MutationObserver(() => {
			if (Date.now() - renderTime > 300) return;
			const computed = window.getComputedStyle(el).overflow;
			if (computed === 'hidden') {
				el.style.overflow = 'auto';
			}
		});
		this.overflowObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
	}

	private updateUpcomingBadge(): void {
		if (!this.airtimeBtn) return;
		const count = AirtimeTab.getAiredDueCount(this.dataManager, this.plugin.readingDataManager) + AirtimeTab.getMaybeDueCount(this.dataManager);
		this.airtimeBtn.textContent = count > 0 ? `Upcoming (${count})` : 'Upcoming';
	}

	private setDraftsBadge(count: number): void {
		if (this.draftsBtn) {
			this.draftsBtn.textContent = count > 0 ? `Drafts (${count})` : 'Drafts';
		}
	}

	/** Count-only drafts scan to keep the tab badge correct even before the Drafts tab is opened. */
	private async updateDraftsBadge(): Promise<void> {
		if (!this.draftsBtn) return;
		const count = await DraftsTab.computePendingCount(this.plugin, this.dataManager);
		this.setDraftsBadge(count);
	}
}

