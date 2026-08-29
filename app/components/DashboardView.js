import { ref, computed } from 'vue';
import {
  state, overdueCheckouts, activeReservations, sets, items, getAsset, toast,
} from '../store.js';
import {
  formatDateTime, daysOverdue, parseDate, isOverdue, formatMoney, formatTotals,
} from '../lib/format.js';
import { computeValue } from '../lib/insights.js';
import { exportInsurancePdf } from '../lib/pdf.js';
import StatusBadge from './ui/StatusBadge.js';

/** At-a-glance view: what is out, what is late, what is coming up. */
export default {
  name: 'DashboardView',
  components: { StatusBadge },
  emits: ['open', 'view'],
  setup(props, { emit }) {
    const byStatus = computed(() => {
      const counts = { FREE: 0, RSVD: 0, UNAV: 0, LOCK: 0, PARTIAL: 0 };
      for (const asset of items.value) {
        counts[asset.effectiveStatus] = (counts[asset.effectiveStatus] || 0) + 1;
      }
      return counts;
    });

    /**
     * What the inventory is worth — the number an insurer is quoted.
     *
     * The maths lives in insights.js: only ITEM records count (a kit would
     * count its members twice), price is per unit, checkout lines are valued
     * by the LINE's qty, and currencies are never added together. This view
     * only renders it.
     */
    const value = computed(() =>
      computeValue({ assets: state.assets, checkouts: state.checkouts }),
    );

    /** What to print when nothing is priced at all: 0, with a currency. */
    const zeroLabel = computed(() =>
      formatMoney(0, value.value.singleCurrency || state.settings?.defaults?.currency || 'EUR'),
    );

    /** The first few unpriced items, so the gap is one click from being fixed. */
    const unpricedTop = computed(() => value.value.unpriced.slice(0, 6));

    const totalUnits = computed(() =>
      items.value.reduce((sum, asset) => sum + Math.max(1, Number(asset.quantity) || 1), 0),
    );

    /** Units out, as opposed to the number of checkout lines. */
    const unitsOut = computed(() =>
      state.checkouts.reduce((sum, line) => sum + Math.max(1, Number(line.qty) || 1), 0),
    );

    /** Reservations starting within the next 14 days. */
    const upcoming = computed(() => {
      const now = new Date();
      const horizon = new Date(now.getTime() + 14 * 86400000);
      return activeReservations.value
        .filter((r) => {
          const start = parseDate(r.startAt);
          return start && start >= now && start <= horizon;
        })
        .sort((a, b) => parseDate(a.startAt) - parseDate(b.startAt))
        .slice(0, 6);
    });

    const dueSoon = computed(() => {
      const now = new Date();
      const horizon = new Date(now.getTime() + 3 * 86400000);
      return state.checkouts
        .filter((record) => {
          const due = parseDate(record.dueAt || record.returnDate);
          return due && due >= now && due <= horizon;
        })
        .sort((a, b) => parseDate(a.dueAt || a.returnDate) - parseDate(b.dueAt || b.returnDate));
    });

    const warrantyExpiring = computed(() => {
      const now = new Date();
      const horizon = new Date(now.getTime() + 60 * 86400000);
      return items.value
        .filter((asset) => {
          const until = parseDate(asset.warrantyUntil);
          return until && until >= now && until <= horizon;
        })
        .sort((a, b) => parseDate(a.warrantyUntil) - parseDate(b.warrantyUntil))
        .slice(0, 5);
    });

    const recent = computed(() =>
      [...state.history]
        .sort((a, b) => (parseDate(b.at) || 0) - (parseDate(a.at) || 0))
        .slice(0, 8),
    );

    /**
     * The schedule for the insurer: every asset with its photo, grouped by
     * category, with the same total this page is showing.
     *
     * It fetches one thumbnail per photographed asset before it can draw, which
     * on the real inventory is 28 requests — hence the busy state. A failure is
     * surfaced rather than swallowed: a button that silently does nothing is
     * how a missing document goes unnoticed until the insurer asks for it.
     */
    const exportingInsurance = ref(false);
    const insurancePdf = async () => {
      if (exportingInsurance.value) return;
      exportingInsurance.value = true;
      try {
        await exportInsurancePdf(state.assets, state.checkouts);
      } catch (error) {
        toast(`Could not build the insurance schedule: ${error.message}`, 'danger', 8000);
      } finally {
        exportingInsurance.value = false;
      }
    };

    return {
      state, byStatus, value, zeroLabel, unpricedTop, totalUnits, unitsOut,
      upcoming, dueSoon, warrantyExpiring, recent,
      exportingInsurance, insurancePdf,
      overdueCheckouts, activeReservations, sets, items, getAsset,
      formatDateTime, daysOverdue, isOverdue, formatTotals, emit,
    };
  },
  template: `
    <!-- What the gear is worth. Internal only: nothing here reaches a customer
         page, an email or a PDF. -->
    <div class="row g-3 mb-3">
      <div class="col-12 col-lg-6">
        <div class="trax-kpi">
          <div class="trax-kpi-label">Inventory value</div>
          <div class="trax-kpi-value">{{ formatTotals(value.totals, zeroLabel) }}</div>
          <div class="trax-kpi-note">
            {{ value.pricedAssets }} of {{ items.length }} items priced · {{ totalUnits }} units
            <span v-if="value.currencies.length > 1">· {{ value.currencies.join(' + ') }}, not added together</span>
          </div>
        </div>
      </div>
      <div class="col-6 col-lg-3">
        <div class="trax-kpi">
          <div class="trax-kpi-label">Value out</div>
          <div class="trax-kpi-value" :class="value.outTotals.length ? 'text-danger' : ''">
            {{ formatTotals(value.outTotals, zeroLabel) }}
          </div>
          <div class="trax-kpi-note">
            {{ value.outUnits }} unit(s) with customers
            <span v-if="value.outUnpricedCount">· {{ value.outUnpricedCount }} unpriced</span>
          </div>
        </div>
      </div>
      <div class="col-6 col-lg-3">
        <div class="trax-kpi">
          <div class="trax-kpi-label">No price recorded</div>
          <div class="trax-kpi-value" :class="value.unpricedCount ? 'text-warning' : 'text-success'">
            {{ value.unpricedCount }}
          </div>
          <div class="trax-kpi-note">
            <span v-if="value.unpricedCount">
              {{ value.unpricedUnits }} unit(s) missing from the total above
            </span>
            <span v-else>Every item has a price.</span>
          </div>
        </div>
      </div>
    </div>

    <!-- A kit is worth its members, so its own price is not counted. Saying so
         beats a total that quietly disagrees with the records. -->
    <div v-if="value.pricedSets.length" class="alert alert-warning py-2 px-3 small">
      <i class="bi bi-exclamation-triangle"></i>
      {{ value.pricedSets.length }} kit(s) carry a price of their own. A kit is worth what its
      members are worth, so those prices are NOT in the total:
      <button v-for="kit in value.pricedSets" :key="kit.id" class="trax-name-btn ms-1"
              @click="emit('open', kit.id)">{{ kit.name }}</button>
    </div>

    <div class="row g-3 mb-3">
      <div class="col-6 col-lg-3">
        <div class="trax-kpi">
          <div class="trax-kpi-label">Items</div>
          <div class="trax-kpi-value">{{ items.length }}</div>
          <div class="trax-kpi-note">
            {{ totalUnits }} units · {{ sets.length }} kits
          </div>
        </div>
      </div>
      <div class="col-6 col-lg-3">
        <div class="trax-kpi">
          <div class="trax-kpi-label">Available</div>
          <div class="trax-kpi-value text-success">{{ byStatus.FREE }}</div>
          <div class="trax-kpi-note">{{ byStatus.RSVD }} reserved</div>
        </div>
      </div>
      <div class="col-6 col-lg-3">
        <div class="trax-kpi">
          <div class="trax-kpi-label">Units out</div>
          <div class="trax-kpi-value">{{ unitsOut }}</div>
          <div class="trax-kpi-note">
            {{ state.checkouts.length }} line(s) · {{ dueSoon.length }} due in 3 days
          </div>
        </div>
      </div>
      <div class="col-6 col-lg-3">
        <div class="trax-kpi">
          <div class="trax-kpi-label">Overdue</div>
          <div class="trax-kpi-value" :class="overdueCheckouts.length ? 'text-danger' : ''">
            {{ overdueCheckouts.length }}
          </div>
          <div class="trax-kpi-note">{{ activeReservations.length }} active reservations</div>
        </div>
      </div>
    </div>

    <div class="row g-3">
      <!-- Where the money sits, and what is missing from it -->
      <div class="col-12 col-xl-6">
        <div class="trax-card h-100">
          <div class="trax-card-pad d-flex align-items-center">
            <h2 class="trax-page-title flex-grow-1"><i class="bi bi-cash-stack"></i> Value by category</h2>
            <!-- The insurer's copy of exactly these figures. Internal document:
                 it prints prices and never leaves this side of the app. -->
            <button class="btn btn-sm btn-outline-secondary" :disabled="exportingInsurance"
                    @click="insurancePdf"
                    aria-label="Insurance schedule PDF with photos, prices and serial numbers">
              <span v-if="exportingInsurance" class="spinner-border spinner-border-sm me-1"></span>
              <i v-else class="bi bi-filetype-pdf"></i>
              {{ exportingInsurance ? 'Building…' : 'Overview PDF' }}
            </button>
          </div>
          <ul class="list-group list-group-flush">
            <li v-for="row in value.byCategory" :key="row.category"
                class="list-group-item bg-transparent d-flex align-items-center gap-2">
              <span class="flex-grow-1">{{ row.category }}</span>
              <span class="small text-secondary">{{ row.units }} unit(s)</span>
              <span v-if="row.unpricedCount" class="trax-kind-chip">{{ row.unpricedCount }} unpriced</span>
              <strong>{{ formatTotals(row.totals, zeroLabel) }}</strong>
            </li>
            <li v-if="!value.byCategory.length" class="list-group-item bg-transparent text-secondary small">
              No items yet.
            </li>
          </ul>

          <div v-if="value.unpricedCount" class="trax-card-pad border-top border-secondary-subtle">
            <h3 class="trax-page-title mb-2">
              <i class="bi bi-tag"></i>
              {{ value.unpricedCount }} asset(s) have no price
            </h3>
            <p class="small text-secondary mb-2">
              They are worth nothing in the total above. Open one to record what it cost.
            </p>
            <div class="d-flex flex-wrap gap-1">
              <button v-for="asset in unpricedTop" :key="asset.id"
                      class="btn btn-sm btn-outline-secondary py-0 px-1" style="font-size:.7rem"
                      @click="emit('open', asset.id)">
                {{ asset.name }}
              </button>
              <span v-if="value.unpricedCount > unpricedTop.length" class="small text-secondary align-self-center">
                + {{ value.unpricedCount - unpricedTop.length }} more
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Overdue -->
      <div class="col-12 col-xl-6">
        <div class="trax-card h-100">
          <div class="trax-card-pad d-flex align-items-center">
            <h2 class="trax-page-title flex-grow-1">
              <i class="bi bi-exclamation-triangle text-danger"></i> Overdue
            </h2>
            <button class="btn btn-sm btn-outline-secondary" @click="emit('view', 'checkouts')">All checkouts</button>
          </div>
          <ul class="list-group list-group-flush">
            <!-- keyed by lineId: an asset id collides across holders now -->
            <li v-for="line in overdueCheckouts" :key="line.lineId"
                class="list-group-item bg-transparent d-flex align-items-center gap-2">
              <button class="trax-name-btn flex-grow-1" @click="emit('open', line.assetId)">
                {{ line.name || ('#' + line.assetId) }}
              </button>
              <span v-if="line.qty > 1" class="trax-kind-chip">×{{ line.qty }}</span>
              <span class="small text-secondary">{{ line.customerName }}</span>
              <span class="trax-badge status-UNAV">
                {{ daysOverdue(line.dueAt || line.returnDate) }}d late
              </span>
            </li>
            <li v-if="!overdueCheckouts.length" class="list-group-item bg-transparent text-secondary small">
              Nothing is overdue.
            </li>
          </ul>
        </div>
      </div>

      <!-- Due soon -->
      <div class="col-12 col-xl-6">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title"><i class="bi bi-clock-history"></i> Due in the next 3 days</h2>
          </div>
          <ul class="list-group list-group-flush">
            <li v-for="line in dueSoon" :key="line.lineId"
                class="list-group-item bg-transparent d-flex align-items-center gap-2">
              <button class="trax-name-btn flex-grow-1" @click="emit('open', line.assetId)">
                {{ line.name || ('#' + line.assetId) }}
              </button>
              <span v-if="line.qty > 1" class="trax-kind-chip">×{{ line.qty }}</span>
              <span class="small text-secondary">{{ line.customerName }}</span>
              <span class="small">{{ formatDateTime(line.dueAt || line.returnDate) }}</span>
            </li>
            <li v-if="!dueSoon.length" class="list-group-item bg-transparent text-secondary small">
              Nothing due soon.
            </li>
          </ul>
        </div>
      </div>

      <!-- Upcoming reservations -->
      <div class="col-12 col-xl-6">
        <div class="trax-card h-100">
          <div class="trax-card-pad d-flex align-items-center">
            <h2 class="trax-page-title flex-grow-1"><i class="bi bi-calendar-check"></i> Upcoming</h2>
            <button class="btn btn-sm btn-outline-secondary" @click="emit('view', 'calendar')">Calendar</button>
          </div>
          <ul class="list-group list-group-flush">
            <li v-for="r in upcoming" :key="r.id" class="list-group-item bg-transparent">
              <div class="d-flex align-items-center gap-2">
                <strong class="flex-grow-1">{{ r.customerName }}</strong>
                <span class="small text-secondary">
                  {{ r.assetIds.length }} items ·
                  {{ (r.items || []).reduce((s, i) => s + i.qty, 0) || r.assetIds.length }} units
                </span>
              </div>
              <div class="small text-secondary">
                {{ formatDateTime(r.startAt) }} → {{ formatDateTime(r.endAt) }}
                <span v-if="r.notes">· {{ r.notes }}</span>
              </div>
            </li>
            <li v-if="!upcoming.length" class="list-group-item bg-transparent text-secondary small">
              No reservations in the next two weeks.
            </li>
          </ul>
        </div>
      </div>

      <!-- Warranty + activity -->
      <div class="col-12 col-xl-6">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title"><i class="bi bi-shield-check"></i> Warranty expiring (60 days)</h2>
          </div>
          <ul class="list-group list-group-flush">
            <li v-for="asset in warrantyExpiring" :key="asset.id"
                class="list-group-item bg-transparent d-flex align-items-center gap-2">
              <button class="trax-name-btn flex-grow-1" @click="emit('open', asset.id)">{{ asset.name }}</button>
              <span class="small text-secondary">{{ formatDateTime(asset.warrantyUntil) }}</span>
            </li>
            <li v-if="!warrantyExpiring.length" class="list-group-item bg-transparent text-secondary small">
              Nothing expiring — add purchase dates to track this.
            </li>
          </ul>

          <div class="trax-card-pad border-top border-secondary-subtle">
            <h3 class="trax-page-title mb-2"><i class="bi bi-activity"></i> Recent activity</h3>
            <ol class="list-unstyled mb-0 small">
              <li v-for="entry in recent" :key="entry.id" class="d-flex gap-2 py-1">
                <span class="text-secondary" style="min-width:9.5rem">{{ formatDateTime(entry.at) }}</span>
                <span class="flex-grow-1">
                  {{ entry.type.replace(/_/g, ' ') }}
                  <button v-if="entry.assetId" class="trax-name-btn" @click="emit('open', entry.assetId)">
                    {{ getAsset(entry.assetId)?.name || ('#' + entry.assetId) }}
                  </button>
                  <span v-if="entry.customerName" class="text-secondary">· {{ entry.customerName }}</span>
                </span>
              </li>
              <li v-if="!recent.length" class="text-secondary">No activity recorded.</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  `,
};
