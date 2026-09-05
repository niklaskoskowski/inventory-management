import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import {
  state, load, setView, clearSelection, overdueCheckouts, activeReservations,
  selectedItemIds, selectedUnitCount, sets, toast,
} from '../store.js';
import * as api from '../api.js';
import ToastHost from './ui/ToastHost.js';
import Lightbox from './ui/Lightbox.js';
import FilterBar from './FilterBar.js';
import AssetTable from './AssetTable.js';
import AssetCards from './AssetCards.js';
import AssetSheet from './AssetSheet.js';
import DashboardView from './DashboardView.js';
import CheckoutsView from './CheckoutsView.js';
import ReservationsView from './ReservationsView.js';
import CalendarView from './CalendarView.js';
import InsightsView from './InsightsView.js';
import SettingsView from './SettingsView.js';
import SetEditor from './SetEditor.js';
import BasketDrawer from './BasketDrawer.js';
import LabelDrawer from './LabelDrawer.js';
import ScanDrawer from './ScanDrawer.js';
import BulkEditDrawer from './BulkEditDrawer.js';

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'bi-speedometer2' },
  { id: 'inventory', label: 'Inventory', icon: 'bi-grid-3x3-gap' },
  { id: 'kits', label: 'Kits', icon: 'bi-box-seam' },
  { id: 'checkouts', label: 'Checkouts', icon: 'bi-box-arrow-right' },
  { id: 'reservations', label: 'Reservations', icon: 'bi-calendar-check' },
  { id: 'calendar', label: 'Calendar', icon: 'bi-calendar3' },
  { id: 'insights', label: 'Insights', icon: 'bi-graph-up-arrow' },
  { id: 'settings', label: 'Settings', icon: 'bi-gear' },
];

// The sidebar is display:none below 992px, so anything not listed here (or on
// the topbar, as Settings is) cannot be reached on a phone at all.
const MOBILE_NAV = ['inventory', 'checkouts', 'reservations', 'scan', 'calendar', 'dashboard'];

export default {
  name: 'AppShell',
  components: {
    ToastHost, Lightbox, FilterBar, AssetTable, AssetCards, AssetSheet,
    DashboardView, CheckoutsView, ReservationsView, CalendarView, InsightsView,
    SettingsView, SetEditor, BasketDrawer, LabelDrawer, ScanDrawer, BulkEditDrawer,
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
    const isNarrow = ref(window.matchMedia('(max-width: 991.98px)').matches);

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
      } else if (key === 'b' && !typing && selectedItemIds.value.length) {
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
      mql.removeEventListener('change', onResize);
    });

    return {
      state, NAV, MOBILE_NAV, setView, load, clearSelection,
      sheetId, sheetOpen, labelId, showBasket, showScanner, showBulk,
      showSetEditor, editingSetId, isNarrow, currentNav, counts, noKitsYet, appName,
      selectedItemIds, selectedUnitCount, account, loadAccount, csrf: api.csrf,
      openAsset, openNewAsset, closeSheet, openSetEditor, openLabel, labelTarget,
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
          <i class="bi bi-upc-scan"></i> {{ appName }}
        </a>

        <button v-for="item in NAV" :key="item.id" type="button"
                class="trax-nav-link" :class="{ active: state.view === item.id }"
                :aria-current="state.view === item.id ? 'page' : undefined"
                @click="setView(item.id)">
          <i class="bi" :class="item.icon"></i>
          <span>{{ item.label }}</span>
          <span v-if="item.id === 'checkouts' && counts.checkoutUnits"
                class="trax-nav-count" :class="{ 'alert-count': counts.overdue }">
            {{ counts.checkoutUnits }}
          </span>
          <span v-else-if="item.id === 'reservations' && counts.reservations" class="trax-nav-count">
            {{ counts.reservations }}
          </span>
          <span v-else-if="item.id === 'kits' && counts.kits" class="trax-nav-count">
            {{ counts.kits }}
          </span>
        </button>

        <div class="mt-auto pt-3 small text-secondary px-2" style="font-size:.7rem">
          <!-- Signing out is a state change, so it is a POST carrying the same
               CSRF token every write does; logout.php refuses one without it. -->
          <div class="d-flex align-items-center gap-2 mb-2">
            <span v-if="account" class="text-truncate flex-grow-1">
              <i class="bi bi-person-circle"></i> {{ account }}
            </span>
            <span v-else class="flex-grow-1"></span>
            <form method="post" action="logout.php">
              <input type="hidden" name="csrf" :value="csrf">
              <button class="btn btn-sm btn-outline-secondary py-0 px-2" type="submit"
                      title="Sign out" aria-label="Sign out">
                <i class="bi bi-box-arrow-right"></i> Sign out
              </button>
            </form>
          </div>
          <div>
            <kbd>s</kbd> search · <kbd>n</kbd> new · <kbd>q</kbd> scan ·
            <kbd>l</kbd> label · <kbd>b</kbd> basket
          </div>
        </div>
      </nav>

      <!-- Main -->
      <div class="trax-main">
        <header class="trax-topbar">
          <div class="flex-grow-1 min-w-0">
            <h1 class="trax-page-title">{{ currentNav.label }}</h1>
            <p class="trax-page-sub">
              {{ state.assets.length }} assets · {{ counts.checkoutUnits }} units out
              <span v-if="counts.overdue" class="text-danger">· {{ counts.overdue }} overdue</span>
            </p>
          </div>

          <button class="btn btn-sm btn-outline-secondary" @click="load()"
                  :disabled="state.loading" title="Reload" aria-label="Reload data">
            <span v-if="state.loading" class="spinner-border spinner-border-sm"></span>
            <i v-else class="bi bi-arrow-clockwise"></i>
          </button>

          <button class="btn btn-sm btn-outline-secondary" @click="showScanner = true"
                  title="Scan a QR label (q)" aria-label="Scan a QR label">
            <i class="bi bi-qr-code-scan"></i>
          </button>

          <!-- The sidebar is hidden below 992px and the mobile nav holds five
               entries, so this is the only way to reach Settings on a phone. -->
          <button class="btn btn-sm btn-outline-secondary d-lg-none"
                  :class="{ active: state.view === 'settings' }"
                  :aria-current="state.view === 'settings' ? 'page' : undefined"
                  @click="setView('settings')"
                  title="Settings" aria-label="Settings">
            <i class="bi bi-gear"></i>
          </button>

          <button class="btn btn-sm btn-primary position-relative" @click="showBasket = true"
                  :disabled="!selectedItemIds.length"
                  :title="selectedUnitCount + ' unit(s) selected'"
                  aria-label="Open selection">
            <i class="bi bi-cart2"></i>
            <span class="ms-1">{{ selectedUnitCount }}</span>
          </button>

          <button class="btn btn-sm btn-success" @click="openNewAsset()"
                  title="Add an asset" aria-label="Add an asset">
            <i class="bi bi-plus-lg"></i><span class="d-none d-md-inline ms-1">Add</span>
          </button>
        </header>

        <main class="trax-content">
          <div v-if="state.booting" class="trax-empty">
            <div class="spinner-border spinner-border-sm"></div>
            <p class="mt-2 mb-0">Loading inventory…</p>
          </div>

          <div v-else-if="state.error" class="alert alert-danger">
            <h2 class="h6">Could not load {{ appName }}</h2>
            <p class="mb-2 small">{{ state.error }}</p>
            <button class="btn btn-sm btn-outline-light" @click="load()">Try again</button>
          </div>

          <template v-else>
            <DashboardView v-if="state.view === 'dashboard'"
                           @open="openAsset" @view="setView" />

            <template v-else-if="state.view === 'inventory' || state.view === 'kits'">
              <!-- Nothing to filter and nothing to list until the first kit
                   exists, so the view invites making one instead of showing an
                   empty table under a full filter bar. -->
              <div v-if="noKitsYet" class="trax-empty">
                <i class="bi bi-box-seam"></i>
                <p class="mb-1"><strong>No kits yet</strong></p>
                <p class="small mb-3">
                  A kit bundles items that always go out together — a camera, its lens and the
                  tripod — so the whole set is checked out, reserved and tracked as one.
                </p>
                <button class="btn btn-sm btn-primary" @click="openSetEditor(null)">
                  <i class="bi bi-plus-lg"></i> New kit
                </button>
              </div>

              <template v-else>
                <div class="d-flex justify-content-between align-items-center mb-2 gap-2 flex-wrap">
                  <FilterBar class="flex-grow-1" />
                  <button v-if="state.view === 'kits'" class="btn btn-sm btn-outline-primary"
                          @click="openSetEditor(null)">
                    <i class="bi bi-plus-lg"></i> New kit
                  </button>
                </div>

                <AssetCards v-if="isNarrow" @open="openAsset" @label="labelId = $event" />
                <AssetTable v-else @open="openAsset" @label="labelId = $event" />
              </template>

              <div v-if="state.selected.length" class="trax-selection-bar">
                <strong>{{ state.selected.length }}</strong> selected
                <span class="text-secondary small" v-if="selectedItemIds.length !== state.selected.length">
                  ({{ selectedItemIds.length }} items after expanding kits)
                </span>
                <span class="flex-grow-1"></span>
                <button class="btn btn-sm btn-outline-secondary" @click="showBulk = true">
                  <i class="bi bi-pencil-square"></i> Edit
                </button>
                <button class="btn btn-sm btn-outline-secondary" :disabled="!labelTarget"
                        :title="labelTarget ? 'Print label (l)' : 'Select a single asset to print its label'"
                        @click="openLabel()">
                  <i class="bi bi-printer"></i> Label
                </button>
                <button class="btn btn-sm btn-outline-primary" @click="openSetEditor(null)">
                  <i class="bi bi-box-seam"></i> Make kit
                </button>
                <button class="btn btn-sm btn-primary" @click="showBasket = true">
                  <i class="bi bi-cart2"></i> Check out
                </button>
                <button class="btn btn-sm btn-outline-secondary" @click="clearSelection()">Clear</button>
              </div>
            </template>

            <CheckoutsView v-else-if="state.view === 'checkouts'" @open="openAsset" />
            <ReservationsView v-else-if="state.view === 'reservations'" @open="openAsset" />
            <CalendarView v-else-if="state.view === 'calendar'" @open="openAsset" />
            <InsightsView v-else-if="state.view === 'insights'" @open="openAsset" />
            <SettingsView v-else-if="state.view === 'settings'" />
          </template>
        </main>
      </div>
    </div>

    <!-- Mobile navigation -->
    <nav class="trax-mobile-nav" aria-label="Main">
      <button v-for="id in MOBILE_NAV" :key="id"
              :class="{ active: id === 'scan' ? showScanner : state.view === id }"
              @click="id === 'scan' ? (showScanner = true) : setView(id)">
        <i class="bi" :class="{
          inventory: 'bi-grid-3x3-gap', checkouts: 'bi-box-arrow-right',
          reservations: 'bi-calendar-check', scan: 'bi-qr-code-scan',
          calendar: 'bi-calendar3', dashboard: 'bi-speedometer2',
        }[id]"></i>
        <span>{{ id === 'scan' ? 'Scan' : (NAV.find(n => n.id === id)?.label || id) }}</span>
      </button>
    </nav>

    <!-- Drawers -->
    <AssetSheet v-if="sheetOpen" :asset-id="sheetId"
                @close="closeSheet" @open="openAsset" @label="labelId = $event" />

    <SetEditor v-if="showSetEditor" :set-id="editingSetId"
               @close="showSetEditor = false" @open="openAsset" />

    <BasketDrawer v-if="showBasket" @close="showBasket = false" @open="openAsset" />

    <BulkEditDrawer v-if="showBulk" @close="showBulk = false" />

    <LabelDrawer v-if="labelId" :asset-id="labelId" @close="labelId = null" />

    <ScanDrawer v-if="showScanner" @close="showScanner = false"
                @open="openAsset" @basket="showBasket = true" />

    <ToastHost />

    <!-- One preview for the whole app; it sits above every drawer above. -->
    <Lightbox />
  `,
};
