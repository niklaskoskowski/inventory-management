import { ref, computed } from 'vue';
import {
  state, overdueCheckouts, activeReservations, sets, items, getAsset, toast,
} from '../store.js';
import {
  formatDate, formatDateTime, daysOverdue, parseDate, isOverdue, formatMoney, formatTotals,
  warrantyUntilOf, relativeDays,
} from '../lib/format.js';
import { computeValue } from '../lib/insights.js';
import {
  STATE_CLASS, STATE_LABEL, assetState, isTested, needsAttention, nextDueOf,
} from '../lib/inspection.js';
import { exportInsurancePdf } from '../lib/pdf.js';
import StatusBadge from './ui/StatusBadge.js';

/** Worst first, so the failures are at the top of the card and not the bottom. */
const ATTENTION = { FAIL: 0, OVERDUE: 1, DUE: 2, NONE: 3, OK: 4 };

/** STATE_CLASS (Bootstrap contextual) → the status-dot colour it reads as. */
const TEST_DOT = { danger: 'UNAV', warning: 'RSVD', secondary: 'LOCK', success: 'FREE' };

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

    // The next warranty to lapse, which for a unit-tracking asset is one
    // unit's rather than the record's own — warrantyUntilOf() picks whichever
    // the asset actually answers with.
    const warrantyExpiring = computed(() => {
      const now = new Date();
      const horizon = new Date(now.getTime() + 60 * 86400000);
      return items.value
        .filter((asset) => {
          const until = parseDate(warrantyUntilOf(asset));
          return until && until >= now && until <= horizon;
        })
        .sort((a, b) => parseDate(warrantyUntilOf(a)) - parseDate(warrantyUntilOf(b)))
        .slice(0, 5);
    });

    /**
     * Gear whose test record is not in order — failed, overdue, due soon, or
     * never tested at all. Only for categories that ask for a test: everything
     * else has no record to be missing.
     */
    const inspectionDue = computed(() =>
      items.value
        .filter((asset) => isTested(state.settings, asset))
        .map((asset) => ({ asset, state: assetState(asset), nextAt: nextDueOf(asset) }))
        .filter((row) => needsAttention(row.state))
        .sort((a, b) => (ATTENTION[a.state] - ATTENTION[b.state])
          || String(a.nextAt || '9999').localeCompare(String(b.nextAt || '9999')))
        .slice(0, 6),
    );

    /** Units on a reservation: its lines' qty, or one per asset on old records. */
    const upcomingUnits = (r) => (r.items || []).reduce((s, i) => s + i.qty, 0) || r.assetIds.length;

    /** "checkout_extended" → "Checkout extended". */
    const activityLabel = (type) => {
      const text = String(type || '').replace(/_/g, ' ');
      return text.charAt(0).toUpperCase() + text.slice(1);
    };

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
      upcoming, dueSoon, warrantyExpiring, recent, inspectionDue,
      STATE_CLASS, STATE_LABEL, TEST_DOT, formatDate, upcomingUnits, activityLabel,
      exportingInsurance, insurancePdf,
      overdueCheckouts, activeReservations, sets, items, getAsset,
      formatDateTime, daysOverdue, isOverdue, formatTotals, warrantyUntilOf, relativeDays, emit,
    };
  },
  template: `
    <div class="trax-dash">
      <!-- The day's numbers. -->
      <div class="row g-2 g-md-3 mb-2 mb-md-3">
        <div class="col-6 col-lg-3">
          <div class="trax-kpi">
            <div class="trax-kpi-label"><i class="bi bi-box-seam text-primary"></i>Items</div>
            <div class="trax-kpi-value">{{ items.length }}</div>
            <div class="trax-kpi-note">{{ totalUnits }} units · {{ sets.length }} kits</div>
          </div>
        </div>
        <div class="col-6 col-lg-3">
          <div class="trax-kpi">
            <div class="trax-kpi-label"><i class="bi bi-check-circle text-success"></i>Available</div>
            <div class="trax-kpi-value">{{ byStatus.FREE }}</div>
            <div class="trax-kpi-note">{{ byStatus.RSVD }} reserved</div>
          </div>
        </div>
        <div class="col-6 col-lg-3">
          <div class="trax-kpi">
            <div class="trax-kpi-label"><i class="bi bi-box-arrow-up-right text-warning"></i>Out</div>
            <div class="trax-kpi-value">{{ unitsOut }}</div>
            <div class="trax-kpi-note">{{ state.checkouts.length }} lines · {{ dueSoon.length }} due soon</div>
          </div>
        </div>
        <div class="col-6 col-lg-3">
          <div class="trax-kpi">
            <div class="trax-kpi-label">
              <i class="bi bi-exclamation-circle" :class="overdueCheckouts.length ? 'text-danger' : 'text-secondary'"></i>Overdue
            </div>
            <div class="trax-kpi-value" :class="overdueCheckouts.length ? 'text-danger' : ''">
              {{ overdueCheckouts.length }}
            </div>
            <div class="trax-kpi-note">{{ activeReservations.length }} reservations</div>
          </div>
        </div>
      </div>

      <!-- What the gear is worth. Internal only: nothing here reaches a customer
           page, an email or a PDF. -->
      <div class="row g-2 g-md-3 mb-3">
        <div class="col-12 col-lg-6">
          <div class="trax-kpi">
            <div class="trax-kpi-label"><i class="bi bi-cash-stack text-success"></i>Inventory value</div>
            <div class="trax-kpi-value">{{ formatTotals(value.totals, zeroLabel) }}</div>
            <div class="trax-kpi-note">
              {{ value.pricedAssets }} of {{ items.length }} priced · {{ totalUnits }} units
              <span v-if="value.currencies.length > 1"
                    title="Different currencies are not added together">· {{ value.currencies.join(' + ') }}</span>
            </div>
          </div>
        </div>
        <div class="col-6 col-lg-3">
          <div class="trax-kpi">
            <div class="trax-kpi-label"><i class="bi bi-person-up text-primary"></i>Value out</div>
            <div class="trax-kpi-value is-sm">{{ formatTotals(value.outTotals, zeroLabel) }}</div>
            <div class="trax-kpi-note">
              {{ value.outUnits }} units<span v-if="value.outUnpricedCount"> · {{ value.outUnpricedCount }} unpriced</span>
            </div>
          </div>
        </div>
        <div class="col-6 col-lg-3">
          <div class="trax-kpi">
            <div class="trax-kpi-label">
              <i class="bi bi-tag" :class="value.unpricedCount ? 'text-warning' : 'text-secondary'"></i>No price
            </div>
            <div class="trax-kpi-value is-sm">{{ value.unpricedCount }}</div>
            <div class="trax-kpi-note">
              <span v-if="value.unpricedCount" title="Missing from the inventory value">{{ value.unpricedUnits }} units not counted</span>
              <span v-else>All priced</span>
            </div>
          </div>
        </div>
      </div>

      <!-- A kit is worth its members, so its own price is not counted. -->
      <div v-if="value.pricedSets.length" class="alert alert-warning py-2 px-3 small">
        <i class="bi bi-exclamation-triangle"></i>
        Kit prices are not counted:
        <button v-for="kit in value.pricedSets" :key="kit.id" class="trax-name-btn ms-1"
                @click="emit('open', kit.id)">{{ kit.name }}</button>
      </div>

      <div class="row g-3">
        <div class="col-12 col-xl-6 d-flex flex-column gap-3">
          <!-- Overdue -->
          <section class="trax-list">
            <div class="trax-dash-head">
              <h2 class="trax-dash-title">
                <i class="bi bi-exclamation-triangle-fill" :class="overdueCheckouts.length ? 'text-danger' : ''"></i>Overdue
                <span v-if="overdueCheckouts.length" class="trax-dash-count">{{ overdueCheckouts.length }}</span>
              </h2>
              <button class="trax-dash-link" @click="emit('view', 'checkouts')">Checkouts</button>
            </div>
            <!-- keyed by lineId: an asset id collides across holders now -->
            <button v-for="line in overdueCheckouts" :key="line.lineId" type="button"
                    class="trax-row is-tappable" @click="emit('open', line.assetId)">
              <div class="trax-row-main">
                <div class="trax-row-title">
                  <span>{{ line.name || ('#' + line.assetId) }}</span>
                  <span v-if="line.qty > 1" class="trax-kind-chip">×{{ line.qty }}</span>
                </div>
                <div class="trax-row-meta"><span>{{ line.customerName }}</span></div>
              </div>
              <span class="trax-badge status-UNAV">{{ daysOverdue(line.dueAt || line.returnDate) }}d late</span>
            </button>
            <div v-if="!overdueCheckouts.length" class="trax-row trax-row-empty">Nothing overdue</div>
          </section>

          <!-- Due soon -->
          <section class="trax-list">
            <div class="trax-dash-head">
              <h2 class="trax-dash-title"><i class="bi bi-clock"></i>Due in 3 days</h2>
            </div>
            <button v-for="line in dueSoon" :key="line.lineId" type="button"
                    class="trax-row is-tappable" @click="emit('open', line.assetId)">
              <div class="trax-row-main">
                <div class="trax-row-title">
                  <span>{{ line.name || ('#' + line.assetId) }}</span>
                  <span v-if="line.qty > 1" class="trax-kind-chip">×{{ line.qty }}</span>
                </div>
                <div class="trax-row-meta"><span>{{ line.customerName }}</span></div>
              </div>
              <span class="trax-row-end">{{ formatDateTime(line.dueAt || line.returnDate) }}</span>
            </button>
            <div v-if="!dueSoon.length" class="trax-row trax-row-empty">Nothing due</div>
          </section>

          <!-- Upcoming reservations -->
          <section class="trax-list">
            <div class="trax-dash-head">
              <h2 class="trax-dash-title"><i class="bi bi-calendar-event"></i>Upcoming</h2>
              <button class="trax-dash-link" @click="emit('view', 'calendar')">Calendar</button>
            </div>
            <div v-for="r in upcoming" :key="r.id" class="trax-row">
              <div class="trax-row-main">
                <div class="trax-row-title"><span>{{ r.customerName }}</span></div>
                <div class="trax-row-meta">
                  <span>{{ formatDateTime(r.startAt) }} → {{ formatDateTime(r.endAt) }}</span>
                  <span v-if="r.notes" :title="r.notes">{{ r.notes }}</span>
                </div>
              </div>
              <span class="trax-row-end" :title="r.assetIds.length + ' items'">{{ upcomingUnits(r) }} units</span>
            </div>
            <div v-if="!upcoming.length" class="trax-row trax-row-empty">Nothing in the next 2 weeks</div>
          </section>

          <!-- Test records that are not in order. Only categories that ask for a
               test appear here, so an install that tests nothing sees nothing. -->
          <section v-if="inspectionDue.length" class="trax-list">
            <div class="trax-dash-head">
              <h2 class="trax-dash-title">
                <i class="bi bi-clipboard-check"></i>Tests
                <span class="trax-dash-count">{{ inspectionDue.length }}</span>
              </h2>
            </div>
            <button v-for="row in inspectionDue" :key="row.asset.id" type="button"
                    class="trax-row is-tappable" @click="emit('open', row.asset.id)">
              <div class="trax-row-main">
                <div class="trax-row-title"><span>{{ row.asset.name }}</span></div>
                <div v-if="row.nextAt" class="trax-row-meta"><span>{{ formatDate(row.nextAt) }}</span></div>
              </div>
              <span class="trax-status-dot small" :class="'status-' + (TEST_DOT[STATE_CLASS[row.state]] || 'LOCK')">
                {{ STATE_LABEL[row.state] }}
              </span>
            </button>
          </section>
        </div>

        <div class="col-12 col-xl-6 d-flex flex-column gap-3">
          <!-- Where the money sits -->
          <section class="trax-list">
            <div class="trax-dash-head">
              <h2 class="trax-dash-title"><i class="bi bi-pie-chart"></i>Value by category</h2>
              <!-- The insurer's copy of exactly these figures. Internal document:
                   it prints prices and never leaves this side of the app. -->
              <button class="trax-dash-link" :disabled="exportingInsurance" @click="insurancePdf"
                      title="Insurance schedule with photos, prices and serial numbers"
                      aria-label="Insurance schedule PDF with photos, prices and serial numbers">
                <span v-if="exportingInsurance" class="spinner-border spinner-border-sm"></span>
                <i v-else class="bi bi-filetype-pdf"></i>
                {{ exportingInsurance ? 'Building…' : 'PDF' }}
              </button>
            </div>
            <div v-for="row in value.byCategory" :key="row.category" class="trax-row">
              <div class="trax-row-main">
                <div class="trax-row-title"><span>{{ row.category }}</span></div>
                <div class="trax-row-meta">
                  <span>{{ row.units }} units</span>
                  <span v-if="row.unpricedCount" class="trax-kind-chip">{{ row.unpricedCount }} unpriced</span>
                </div>
              </div>
              <span class="trax-row-end"><strong>{{ formatTotals(row.totals, zeroLabel) }}</strong></span>
            </div>
            <div v-if="!value.byCategory.length" class="trax-row trax-row-empty">No items yet</div>
          </section>

          <!-- What is missing from the total, one tap from being fixed. -->
          <section v-if="value.unpricedCount" class="trax-list">
            <div class="trax-dash-head">
              <h2 class="trax-dash-title">
                <i class="bi bi-tag text-warning"></i>No price
                <span class="trax-dash-count">{{ value.unpricedCount }}</span>
              </h2>
            </div>
            <button v-for="asset in unpricedTop" :key="asset.id" type="button"
                    class="trax-row is-tappable" @click="emit('open', asset.id)">
              <div class="trax-row-main"><div class="trax-row-title"><span>{{ asset.name }}</span></div></div>
              <i class="bi bi-chevron-right trax-row-chevron"></i>
            </button>
            <div v-if="value.unpricedCount > unpricedTop.length" class="trax-row trax-row-empty">
              + {{ value.unpricedCount - unpricedTop.length }} more
            </div>
          </section>

          <!-- Warranty -->
          <section class="trax-list">
            <div class="trax-dash-head">
              <h2 class="trax-dash-title"><i class="bi bi-shield-check"></i>Warranty ends</h2>
              <span class="small text-secondary">60 days</span>
            </div>
            <button v-for="asset in warrantyExpiring" :key="asset.id" type="button"
                    class="trax-row is-tappable" @click="emit('open', asset.id)">
              <div class="trax-row-main">
                <div class="trax-row-title"><span>{{ asset.name }}</span></div>
                <div v-if="asset.warrantyNextUnit" class="trax-row-meta">
                  <span>Unit {{ asset.id }}.{{ asset.warrantyNextUnit }}</span>
                </div>
              </div>
              <span class="trax-row-end" :title="formatDateTime(warrantyUntilOf(asset))">{{ formatDate(warrantyUntilOf(asset)) }}</span>
            </button>
            <div v-if="!warrantyExpiring.length" class="trax-row trax-row-empty"
                 title="Add purchase dates to track warranties">Nothing ending</div>
          </section>

          <!-- Activity -->
          <section class="trax-list">
            <div class="trax-dash-head">
              <h2 class="trax-dash-title"><i class="bi bi-activity"></i>Recent activity</h2>
            </div>
            <component :is="entry.assetId ? 'button' : 'div'" v-for="entry in recent" :key="entry.id"
                       :type="entry.assetId ? 'button' : null"
                       class="trax-row" :class="{ 'is-tappable': entry.assetId }"
                       @click="entry.assetId && emit('open', entry.assetId)">
              <div class="trax-row-main">
                <div class="trax-row-title">
                  <span>{{ entry.assetId ? (getAsset(entry.assetId)?.name || ('#' + entry.assetId)) : activityLabel(entry.type) }}</span>
                </div>
                <div class="trax-row-meta">
                  <span v-if="entry.assetId">{{ activityLabel(entry.type) }}</span>
                  <span v-if="entry.customerName">{{ entry.customerName }}</span>
                </div>
              </div>
              <span class="trax-row-end" :title="formatDateTime(entry.at)">{{ relativeDays(entry.at) }}</span>
            </component>
            <div v-if="!recent.length" class="trax-row trax-row-empty">No activity yet</div>
          </section>
        </div>
      </div>
    </div>
  `,
};
