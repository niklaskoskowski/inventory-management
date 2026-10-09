import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import {
  state, load, setView, clearSelection, overdueCheckouts, activeReservations,
  selectedItemIds, selectedUnitCount, sets, toast,
} from '../store.js';
import * as api from '../api.js';
import { theme, setThemePref, THEME_OPTIONS } from '../lib/theme.js';
import ToastHost from './ui/ToastHost.js';
import Menu from './ui/Menu.js';
import Drawer from './ui/Drawer.js';
import Lightbox from './ui/Lightbox.js';
import FilterBar from './FilterBar.js';
import AssetTable from './AssetTable.js';
import AssetCards from './AssetCards.js';
import AssetSheet from './AssetSheet.js';
import DashboardView from './DashboardView.js';
import CheckoutsView, { openCheckout } from './CheckoutsView.js';
import ReservationsView from './ReservationsView.js';
import EventsView from './EventsView.js';
import EventSheet from './EventSheet.js';
import CalendarView from './CalendarView.js';
import InsightsView from './InsightsView.js';
import SettingsView from './SettingsView.js';
import SetEditor from './SetEditor.js';
import BasketDrawer from './BasketDrawer.js';
import LabelDrawer from './LabelDrawer.js';
import ScanDrawer from './ScanDrawer.js';
import BulkEditDrawer from './BulkEditDrawer.js';
import SignatureSheet from './SignatureSheet.js';

const NAV = [
  { id: 'dashboard', label: 'Overview', icon: 'bi-house', section: '' },
  { id: 'inventory', label: 'Inventory', icon: 'bi-grid', section: 'Gear' },
  { id: 'kits', label: 'Kits', icon: 'bi-box-seam', section: 'Gear' },
  { id: 'checkouts', label: 'Checkouts', icon: 'bi-box-arrow-up-right', section: 'Rentals' },
  { id: 'reservations', label: 'Reservations', icon: 'bi-calendar-check', section: 'Rentals' },
  { id: 'events', label: 'Events', icon: 'bi-flag', section: 'Rentals' },
  { id: 'calendar', label: 'Calendar', icon: 'bi-calendar3', section: 'Rentals' },
  { id: 'insights', label: 'Insights', icon: 'bi-bar-chart', section: 'Rentals' },
  { id: 'settings', label: 'Settings', icon: 'bi-gear', section: 'end' },
];

/** The sidebar, grouped: [{title, items}]. Settings sits at the bottom. */
const NAV_SECTIONS = ['', 'Gear', 'Rentals'].map((title) => ({
  title,
  items: NAV.filter((item) => item.section === title),
}));

// The phone's tab bar: four places and "More". Everything else is in the More
// sheet, so every view stays reachable without the sidebar.
const TABS = [
  { id: 'inventory', label: 'Inventory', icon: 'bi-grid', active: 'bi-grid-fill' },
  { id: 'checkouts', label: 'Checkouts', icon: 'bi-box-arrow-up-right', active: 'bi-box-arrow-up-right' },
  { id: 'scan', label: 'Scan', icon: 'bi-qr-code-scan', active: 'bi-qr-code-scan' },
  { id: 'reservations', label: 'Reservations', icon: 'bi-calendar-check', active: 'bi-calendar-check-fill' },
  { id: 'more', label: 'More', icon: 'bi-three-dots', active: 'bi-three-dots' },
];
const MORE = ['dashboard', 'kits', 'events', 'calendar', 'insights', 'settings'];

export default {
  name: 'AppShell',
  components: {
    ToastHost, Lightbox, Menu, Drawer, FilterBar, AssetTable, AssetCards, AssetSheet,
    DashboardView, CheckoutsView, ReservationsView, EventsView, EventSheet,
    CalendarView, InsightsView,
    SettingsView, SetEditor, BasketDrawer, LabelDrawer, ScanDrawer, BulkEditDrawer, SignatureSheet,
  },
  setup() {
    // Open drawers. Only one asset sheet at a time; `sheetId === 0` means "new".
    const sheetId = ref(null);
    const sheetOpen = ref(false);
    const labelId = ref(null);
    const showBasket = ref(false);
    const showScanner = ref(false);
    const showBulk = ref(false);
    const showSetEditor = ref(false);
    const editingSetId = ref(null);
    // The event sheet. `eventSheetId === null` with the sheet open means "new",
    // the same convention the set editor uses.
    const showEventSheet = ref(false);
    const eventSheetId = ref(null);
    const isNarrow = ref(window.matchMedia('(max-width: 991.98px)').matches);
    const showMore = ref(false);

    // The bar gets its hairline, and on a phone the page title, once the
    // large title has scrolled under it.
    const scrolled = ref(false);
    const onScroll = () => { scrolled.value = window.scrollY > 24; };

    const tabActive = (id) => {
      if (id === 'scan') return showScanner.value;
      if (id === 'more') return showMore.value || MORE.includes(state.view);
      return state.view === id;
    };

    const onTab = (id) => {
      if (id === 'scan') showScanner.value = true;
      else if (id === 'more') showMore.value = true;
      else {
        setView(id);
        window.scrollTo({ top: 0 });
      }
    };

    const go = (id) => {
      showMore.value = false;
      setView(id);
      window.scrollTo({ top: 0 });
    };

    const navItem = (id) => NAV.find((item) => item.id === id);

    /** One line under the title: what this view holds, said briefly. */
    const subtitle = computed(() => {
      const c = counts.value;
      switch (state.view) {
        case 'inventory': return `${state.assets.length} assets`;
        case 'kits': return `${c.kits} kits`;
        case 'checkouts': return c.overdue ? `${c.checkoutUnits} out · ${c.overdue} overdue` : `${c.checkoutUnits} out`;
        case 'reservations': return `${c.reservations} active`;
        default: return '';
      }
    });

    const currentNav = computed(() => NAV.find((n) => n.id === state.view) || NAV[1]);

    /**
     * What this install calls itself. Read through a computed rather than
     * inlined in the template so the brand link, the error box and anything
     * added later cannot drift apart. The `||` covers the window before the
     * first snapshot lands, when state.settings is still DEFAULT_SETTINGS.
     */
    const appName = computed(() => state.settings?.branding?.appName || 'Assets');

    /**
     * Who is signed in, for the sidebar footer.
     *
     * The bootstrap already carries it as meta.actor, so the extra request is
     * only made when it does not — an older snapshot, or a bootstrap that
     * failed. The name is decoration: a refusal leaves it blank rather than
     * raising anything, because the shell works without it.
     */
    const fetchedActor = ref('');
    const account = computed(() => state.meta.actor || fetchedActor.value);

    const loadAccount = () => {
      if (state.meta.actor) return Promise.resolve();
      return api.get('auth.me')
        .then((body) => { fetchedActor.value = body.data?.username || ''; })
        .catch(() => { /* no name in the footer, nothing else */ });
    };

    /** A scanned hand-over sheet: Checkouts, with that booking's card open. */
    const openHandover = (bookingId) => {
      setView('checkouts');
      openCheckout(bookingId);
    };

    const openAsset = (id) => {
      sheetId.value = Number(id) || null;
      sheetOpen.value = true;
    };
    const openNewAsset = () => {
      sheetId.value = null;
      sheetOpen.value = true;
    };
    const closeSheet = () => {
      sheetOpen.value = false;
      sheetId.value = null;
    };

    const openSetEditor = (id = null) => {
      editingSetId.value = id;
      showSetEditor.value = true;
    };

    /**
     * The kit editor on an existing kit, from its sheet's Contents tab. The
     * sheet closes first — two drawers over each other, both editing the same
     * kit, is one too many — and the editor reopens it after saving.
     */
    const editKit = (id) => {
      closeSheet();
      openSetEditor(id);
    };

    const openEvent = (id = null) => {
      eventSheetId.value = id;
      showEventSheet.value = true;
    };

    /**
     * "The selected asset" is ambiguous here: `state.selected` is a multi-select
     * used by the basket and bulk edit, while the asset sheet holds exactly one.
     * LabelDrawer takes a single id, so prefer the open sheet, fall back to the
     * checkbox selection only when it is unambiguous, and say so otherwise
     * rather than guessing which of several rows was meant.
     */
    const labelTarget = computed(() => {
      if (sheetOpen.value && sheetId.value) return sheetId.value;
      if (state.selected.length === 1) return state.selected[0];
      return null;
    });

    const openLabel = () => {
      if (labelTarget.value) {
        labelId.value = labelTarget.value;
      } else if (state.selected.length > 1) {
        toast('Select a single asset to print its label.', 'warning');
      } else {
        toast('Select an asset first.', 'warning');
      }
    };

    // A checkout record is a line, and one line can hold several units. The
    // rest of the app counts units, so the shell has to as well.
    const counts = computed(() => ({
      checkoutUnits: state.checkouts.reduce(
        (sum, line) => sum + Math.max(1, Number(line.qty) || 1),
        0,
      ),
      overdue: overdueCheckouts.value.length,
      reservations: activeReservations.value.length,
      kits: sets.value.length,
    }));

    /**
     * The Kits view before the first kit exists — which is where every install
     * starts. A filter that hides the kits is a different thing entirely and
     * keeps the normal table with its "nothing matches" row.
     */
    const noKitsYet = computed(() => state.view === 'kits' && counts.value.kits === 0);

    // --- Keyboard shortcuts ---
    const onKeydown = (event) => {
      const tag = document.activeElement?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // Shift was not excluded, so Shift+S fired the scanner. The letter
      // shortcuts are all unshifted; `/` is deliberately exempt, because on a
      // German keyboard it IS Shift+7.
      const key = event.shiftKey ? '' : event.key;

      // `s` is search: the first letter of the word, and the key the rest of
      // the world uses for it. `/` stays as an alias — it costs nothing and it
      // is what this app trained people on.
      if ((key === 's' || event.key === '/') && !typing) {
        event.preventDefault();
        document.getElementById('trax-search')?.focus();
      } else if (key === 'n' && !typing) {
        event.preventDefault();
        openNewAsset();
      } else if (key === 'q' && !typing) {
        // The scanner keeps a key of its own: the topbar button and the mobile
        // nav are its only other routes.
        event.preventDefault();
        showScanner.value = true;
      } else if (key === 'b' && !typing && (selectedItemIds.value.length || state.reservationEdit)) {
        event.preventDefault();
        showBasket.value = true;
      } else if (key === 'l' && !typing) {
        // The asset sheet may stay open behind the label (its footer offers the
        // same action), but stacking a label over the basket, scanner, bulk
        // editor or kit editor would fight over focus capture and scroll lock.
        if (showBasket.value || showScanner.value || showBulk.value || showSetEditor.value) return;
        event.preventDefault();
        openLabel();
      }
    };

    const mql = window.matchMedia('(max-width: 991.98px)');
    const onResize = (event) => { isNarrow.value = event.matches; };

    onMounted(() => {
      document.addEventListener('keydown', onKeydown);
      window.addEventListener('scroll', onScroll, { passive: true });
      mql.addEventListener('change', onResize);
      load().then(() => {
        // Deep link from a scanned label: admin.php?id=3
        const id = new URLSearchParams(location.search).get('id');
        if (id) openAsset(id);
        loadAccount();
      }).catch(() => { /* error surfaced as a toast */ });
    });

    onBeforeUnmount(() => {
      document.removeEventListener('keydown', onKeydown);
      window.removeEventListener('scroll', onScroll);
      mql.removeEventListener('change', onResize);
    });

    return {
      state, NAV, NAV_SECTIONS, TABS, MORE, setView, load, clearSelection,
      showMore, scrolled, tabActive, onTab, go, navItem, subtitle,
      theme, setThemePref, THEME_OPTIONS,
      sheetId, sheetOpen, labelId, showBasket, showScanner, showBulk,
      showSetEditor, editingSetId, isNarrow, currentNav, counts, noKitsYet, appName,
      selectedItemIds, selectedUnitCount, account, loadAccount, csrf: api.csrf,
      openAsset, openHandover, openNewAsset, closeSheet, openSetEditor, editKit, openLabel, labelTarget,
      showEventSheet, eventSheetId, openEvent,
      // Not used by the template — exposed so the shortcut table can be driven
      // with synthetic events instead of a browser.
      onKeydown,
    };
  },
  template: `
    <div class="trax-shell">
      <!-- Sidebar -->
      <nav class="trax-sidebar" aria-label="Main">
        <a class="trax-brand" href="admin.php">
          <img v-if="state.settings?.branding?.faviconFile" class="trax-app-icon"
               :src="state.settings.branding.faviconFile" alt="">
          <span v-else class="trax-app-icon"><i class="bi bi-box-seam"></i></span>
          <span class="text-truncate">{{ appName }}</span>
        </a>

        <template v-for="section in NAV_SECTIONS" :key="section.title">
          <div v-if="section.title" class="trax-nav-section">{{ section.title }}</div>
          <button v-for="item in section.items" :key="item.id" type="button"
                  class="trax-nav-link" :class="{ active: state.view === item.id }"
                  :aria-current="state.view === item.id ? 'page' : undefined"
                  @click="setView(item.id)">
            <i class="bi" :class="item.icon"></i>
            <span>{{ item.label }}</span>
            <span v-if="item.id === 'checkouts' && counts.overdue" class="trax-nav-count alert-count"
                  :title="counts.overdue + ' overdue'">{{ counts.overdue }}</span>
            <span v-else-if="item.id === 'checkouts' && counts.checkoutUnits" class="trax-nav-count">
              {{ counts.checkoutUnits }}
            </span>
            <span v-else-if="item.id === 'reservations' && counts.reservations" class="trax-nav-count">
              {{ counts.reservations }}
            </span>
            <span v-else-if="item.id === 'kits' && counts.kits" class="trax-nav-count">
              {{ counts.kits }}
            </span>
          </button>
        </template>

        <div class="trax-sidebar-foot">
          <button type="button" class="trax-nav-link flex-grow-1"
                  :class="{ active: state.view === 'settings' }" @click="setView('settings')">
            <i class="bi bi-gear"></i><span>Settings</span>
          </button>
        </div>
        <div class="d-flex align-items-center gap-1">
          <div class="trax-account">
            <span class="trax-avatar">{{ (account || '?').slice(0, 1) }}</span>
            <span class="text-truncate">{{ account || 'Signed in' }}</span>
          </div>
          <Menu label="Account" icon="bi-three-dots" up align="end" button-class="trax-close">
            <div class="trax-menu-label">Appearance</div>
            <button v-for="option in THEME_OPTIONS" :key="option.id" type="button" class="trax-menu-item"
                    @click="setThemePref(option.id)">
              <i class="bi" :class="option.icon"></i> {{ option.label }}
              <i v-if="theme.pref === option.id" class="bi bi-check2 trax-menu-check"></i>
            </button>
            <div class="trax-menu-sep"></div>
            <div class="trax-menu-label">Shortcuts: s search · n new · q scan · b selection</div>
            <div class="trax-menu-sep"></div>
            <!-- Signing out is a state change, so it is a POST carrying the same
                 CSRF token every write does; logout.php refuses one without it. -->
            <form method="post" action="logout.php">
              <input type="hidden" name="csrf" :value="csrf">
              <button class="trax-menu-item is-danger" type="submit">
                <i class="bi bi-box-arrow-right"></i> Sign out
              </button>
            </form>
          </Menu>
        </div>
      </nav>

      <!-- Main -->
      <div class="trax-main">
        <header class="trax-topbar" :class="{ 'is-scrolled': scrolled }">
          <div class="trax-topbar-heading flex-grow-1 min-w-0">
            <h1 class="trax-topbar-title">{{ currentNav.label }}</h1>
            <p v-if="subtitle" class="trax-topbar-sub">{{ subtitle }}</p>
          </div>

          <button class="trax-icon-btn d-none d-lg-inline-flex" @click="load()"
                  :disabled="state.loading" title="Reload" aria-label="Reload data">
            <span v-if="state.loading" class="spinner-border spinner-border-sm"></span>
            <i v-else class="bi bi-arrow-clockwise"></i>
          </button>

          <button class="trax-icon-btn d-none d-lg-inline-flex" @click="showScanner = true"
                  title="Scan (q)" aria-label="Scan a QR label">
            <i class="bi bi-qr-code-scan"></i>
          </button>

          <!-- While a reservation is being edited the tray is that reservation,
               and it must stay reachable even with nothing in it. -->
          <button v-if="selectedItemIds.length || state.reservationEdit"
                  class="btn btn-sm btn-primary rounded-pill" @click="showBasket = true"
                  :title="state.reservationEdit
                    ? 'Editing reservation #' + state.reservationEdit.id
                    : selectedUnitCount + ' unit(s) selected'"
                  :aria-label="state.reservationEdit ? 'Open the reservation being edited' : 'Open selection'">
            <i class="bi" :class="state.reservationEdit ? 'bi-pencil-square' : 'bi-bag'"></i>
            <span class="trax-count-pill">{{ selectedUnitCount }}</span>
          </button>

          <button class="trax-icon-btn is-accent" @click="openNewAsset()"
                  title="New asset (n)" aria-label="Add an asset">
            <i class="bi bi-plus-lg"></i>
          </button>
        </header>

        <main class="trax-content">
          <div v-if="state.booting" class="trax-empty">
            <div class="spinner-border spinner-border-sm"></div>
          </div>

          <div v-else-if="state.error" class="alert alert-danger">
            <h2 class="h6">Could not load {{ appName }}</h2>
            <p class="mb-2 small">{{ state.error }}</p>
            <button class="btn btn-sm btn-outline-secondary" @click="load()">Try again</button>
          </div>

          <template v-else>
            <DashboardView v-if="state.view === 'dashboard'"
                           @open="openAsset" @view="setView" />

            <template v-else-if="state.view === 'inventory' || state.view === 'kits'">
              <!-- Nothing to filter and nothing to list until the first kit
                   exists, so the view invites making one instead. -->
              <div v-if="noKitsYet" class="trax-empty">
                <i class="bi bi-box-seam"></i>
                <p class="mb-1"><strong>No kits yet</strong></p>
                <p class="small mb-3">Bundle gear that always goes out together.</p>
                <button class="btn btn-primary" @click="openSetEditor(null)">
                  <i class="bi bi-plus-lg"></i> New kit
                </button>
              </div>

              <template v-else>
                <FilterBar>
                  <button v-if="state.view === 'kits'" class="btn btn-sm btn-outline-primary"
                          @click="openSetEditor(null)">
                    <i class="bi bi-plus-lg"></i> New kit
                  </button>
                </FilterBar>

                <AssetCards v-if="isNarrow" @open="openAsset" @label="labelId = $event" />
                <AssetTable v-else @open="openAsset" @label="labelId = $event" />
              </template>

              <div v-if="state.selected.length" class="trax-selection-bar">
                <span class="trax-sel-count">{{ state.selected.length }} selected</span>
                <button class="btn btn-sm btn-outline-secondary" @click="showBulk = true" title="Edit">
                  <i class="bi bi-pencil"></i><span class="btn-label">Edit</span>
                </button>
                <button class="btn btn-sm btn-outline-secondary" :disabled="!labelTarget"
                        :title="labelTarget ? 'Label (l)' : 'Select one asset to print its label'"
                        @click="openLabel()">
                  <i class="bi bi-printer"></i><span class="btn-label">Label</span>
                </button>
                <button class="btn btn-sm btn-outline-secondary" @click="openSetEditor(null)" title="Make kit">
                  <i class="bi bi-box-seam"></i><span class="btn-label">Kit</span>
                </button>
                <span class="flex-grow-1"></span>
                <button class="btn btn-sm btn-primary" @click="showBasket = true">
                  <template v-if="state.reservationEdit">
                    <i class="bi bi-pencil-square"></i> #{{ state.reservationEdit.id }}
                  </template>
                  <template v-else><i class="bi bi-bag"></i> Check out</template>
                </button>
                <button class="trax-close" @click="clearSelection()" title="Clear" aria-label="Clear selection">
                  <i class="bi bi-x-lg"></i>
                </button>
              </div>
            </template>

            <CheckoutsView v-else-if="state.view === 'checkouts'" @open="openAsset" />
            <ReservationsView v-else-if="state.view === 'reservations'" @open="openAsset"
                              @basket="showBasket = true" />

            <EventsView v-else-if="state.view === 'events'"
                        @open="openAsset" @edit="openEvent" />
            <CalendarView v-else-if="state.view === 'calendar'" @open="openAsset" />
            <InsightsView v-else-if="state.view === 'insights'" @open="openAsset" />
            <SettingsView v-else-if="state.view === 'settings'" />
          </template>
        </main>
      </div>
    </div>

    <!-- Phone tab bar -->
    <nav class="trax-tabbar" aria-label="Main">
      <button v-for="tab in TABS" :key="tab.id" type="button"
              :class="{ active: tabActive(tab.id) }"
              :aria-current="tabActive(tab.id) ? 'page' : undefined"
              @click="onTab(tab.id)">
        <i class="bi" :class="tabActive(tab.id) ? tab.active : tab.icon"></i>
        <span>{{ tab.label }}</span>
        <span v-if="tab.id === 'checkouts' && counts.overdue" class="trax-tabbar-badge">{{ counts.overdue }}</span>
      </button>
    </nav>

    <!-- Phone: everything the tab bar has no room for -->
    <Drawer v-if="showMore" title="More" @close="showMore = false">
      <div class="trax-list">
        <div v-for="id in MORE" :key="id" class="trax-row is-tappable" role="button" tabindex="0"
             @click="go(id)" @keydown.enter="go(id)">
          <span class="trax-app-icon" style="width:28px;height:28px;font-size:.85rem">
            <i class="bi" :class="navItem(id).icon"></i>
          </span>
          <span class="trax-row-main fw-semibold">{{ navItem(id).label }}</span>
          <span v-if="id === 'kits' && counts.kits" class="text-secondary small">{{ counts.kits }}</span>
          <i class="bi bi-chevron-right trax-row-chevron"></i>
        </div>
      </div>

      <div class="trax-list-header">Appearance</div>
      <div class="btn-group trax-segmented w-100" role="group" aria-label="Appearance">
        <button v-for="option in THEME_OPTIONS" :key="option.id" type="button"
                class="btn btn-sm flex-fill" :class="theme.pref === option.id ? 'btn-secondary' : 'btn-outline-secondary'"
                @click="setThemePref(option.id)">
          <i class="bi" :class="option.icon"></i> {{ option.label }}
        </button>
      </div>

      <div class="trax-list-header">Account</div>
      <div class="trax-list">
        <div class="trax-row">
          <span class="trax-avatar">{{ (account || '?').slice(0, 1) }}</span>
          <span class="trax-row-main fw-semibold">{{ account || 'Signed in' }}</span>
          <form method="post" action="logout.php">
            <input type="hidden" name="csrf" :value="csrf">
            <button class="btn btn-sm btn-outline-danger" type="submit">Sign out</button>
          </form>
        </div>
      </div>
    </Drawer>

    <!-- Drawers -->
    <AssetSheet v-if="sheetOpen" :asset-id="sheetId"
                @close="closeSheet" @open="openAsset" @label="labelId = $event"
                @edit-kit="editKit" />

    <SetEditor v-if="showSetEditor" :set-id="editingSetId"
               @close="showSetEditor = false" @open="openAsset" />

    <EventSheet v-if="showEventSheet" :event-id="eventSheetId"
                @close="showEventSheet = false" />

    <BasketDrawer v-if="showBasket" @close="showBasket = false" @open="openAsset" />

    <BulkEditDrawer v-if="showBulk" @close="showBulk = false" />

    <LabelDrawer v-if="labelId" :asset-id="labelId" @close="labelId = null" />

    <ScanDrawer v-if="showScanner" @close="showScanner = false"
                @open="openAsset" @basket="showBasket = true"
                @booking="openHandover" />

    <!-- The hand-over signature: asked for right after a checkout. -->
    <SignatureSheet v-if="state.signPrompt" :key="state.signPrompt" />

    <ToastHost />

    <!-- One preview for the whole app; it sits above every drawer above. -->
    <Lightbox />
  `,
};
