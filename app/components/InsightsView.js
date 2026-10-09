import { ref, computed } from 'vue';
import { state, sortedAssets } from '../store.js';
import { computeInsights } from '../lib/insights.js';
import { exportInventoryPdf, exportInsightsPdf } from '../lib/pdf.js';
import { addDays, startOfDay, formatDate, parseDate } from '../lib/format.js';

export default {
  name: 'InsightsView',
  emits: ['open'],
  setup(props, { emit }) {
    const preset = ref('30');
    const customStart = ref('');
    const customEnd = ref('');
    const statusFilter = ref('');
    const exporting = ref(false);

    const range = computed(() => {
      const end = new Date();
      if (preset.value === 'custom') {
        const from = parseDate(customStart.value);
        const to = parseDate(customEnd.value);
        return {
          start: from || addDays(end, -30),
          end: to ? new Date(to.getTime() + 86400000 - 1) : end,
        };
      }
      return { start: addDays(startOfDay(end), -Number(preset.value)), end };
    });

    const insights = computed(() =>
      computeInsights({
        assets: state.assets,
        checkouts: state.checkouts,
        history: state.history,
        rangeStart: range.value.start,
        rangeEnd: range.value.end,
        statusFilter: statusFilter.value,
      }),
    );

    const maxCategoryHours = computed(
      () => Math.max(1, ...insights.value.byCategory.map((c) => c.hours)),
    );

    const doExport = async (kind) => {
      exporting.value = true;
      try {
        if (kind === 'inventory') {
          await exportInventoryPdf(sortedAssets.value, state.checkouts);
        } else {
          await exportInsightsPdf(insights.value);
        }
      } finally {
        exporting.value = false;
      }
    };

    return {
      state, preset, customStart, customEnd, statusFilter, exporting,
      insights, maxCategoryHours, formatDate, doExport, emit,
    };
  },
  template: `
    <div class="trax-dash">
      <!-- Range, filter, exports: one toolbar row. -->
      <div class="d-flex align-items-center gap-2 mb-1 flex-wrap">
        <select id="ins-range" class="form-select form-select-sm w-auto" v-model="preset" aria-label="Range">
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="365">Last year</option>
          <option value="custom">Custom…</option>
        </select>

        <template v-if="preset === 'custom'">
          <input id="ins-from" type="date" class="form-control form-control-sm w-auto" v-model="customStart"
                 aria-label="From">
          <span class="text-secondary small">–</span>
          <input id="ins-to" type="date" class="form-control form-control-sm w-auto" v-model="customEnd"
                 aria-label="To">
        </template>

        <select id="ins-status" class="form-select form-select-sm w-auto" v-model="statusFilter" aria-label="Status">
          <option value="">All statuses</option>
          <option value="FREE">Available</option>
          <option value="RSVD">Reserved</option>
          <option value="UNAV">Checked out</option>
          <option value="LOCK">Blocked</option>
        </select>

        <span class="flex-grow-1"></span>

        <button class="btn btn-sm btn-outline-secondary" :disabled="exporting" @click="doExport('inventory')"
                title="Inventory PDF">
          <i class="bi bi-filetype-pdf"></i> Inventory
        </button>
        <button class="btn btn-sm btn-outline-secondary" :disabled="exporting" @click="doExport('insights')"
                title="Insights PDF">
          <i class="bi bi-filetype-pdf"></i> Insights
        </button>
      </div>

      <p class="small text-secondary mb-3">
        {{ formatDate(insights.rangeStart) }} – {{ formatDate(insights.rangeEnd) }}
      </p>

      <div class="row g-2 g-md-3 mb-3">
        <div class="col-6 col-lg-3">
          <div class="trax-kpi">
            <div class="trax-kpi-label"><i class="bi bi-box-seam text-primary"></i>In scope</div>
            <div class="trax-kpi-value">{{ insights.totalAssets }}</div>
            <div class="trax-kpi-note">{{ insights.totalUnits }} units</div>
          </div>
        </div>
        <div class="col-6 col-lg-3">
          <div class="trax-kpi">
            <div class="trax-kpi-label"><i class="bi bi-box-arrow-up-right text-warning"></i>Out now</div>
            <div class="trax-kpi-value">{{ insights.checkedOutNow }}</div>
            <div class="trax-kpi-note">{{ insights.checkedOutLines }} lines</div>
          </div>
        </div>
        <div class="col-6 col-lg-3">
          <div class="trax-kpi">
            <div class="trax-kpi-label">
              <i class="bi bi-exclamation-circle" :class="insights.overdueNow ? 'text-danger' : 'text-secondary'"></i>Overdue
            </div>
            <div class="trax-kpi-value" :class="insights.overdueNow ? 'text-danger' : ''">
              {{ insights.overdueNow }}
            </div>
            <div class="trax-kpi-note">right now</div>
          </div>
        </div>
        <div class="col-6 col-lg-3">
          <div class="trax-kpi">
            <div class="trax-kpi-label"><i class="bi bi-speedometer2 text-success"></i>Utilization</div>
            <div class="trax-kpi-value">{{ insights.avgUtil.toFixed(1) }}%</div>
            <div class="trax-kpi-note">average</div>
          </div>
        </div>
      </div>

      <div class="row g-3">
        <div class="col-12 col-xl-6 d-flex flex-column gap-3">
          <section class="trax-list">
            <div class="trax-dash-head">
              <h2 class="trax-dash-title"><i class="bi bi-graph-up"></i>Most used</h2>
            </div>
            <div class="trax-table-wrap">
              <table class="trax-table">
                <thead>
                  <tr><th>Item</th><th class="text-end">Hours</th><th class="text-end">Use</th></tr>
                </thead>
                <tbody>
                  <tr v-for="row in insights.topUsed" :key="row.assetId">
                    <td><button class="trax-name-btn" @click="emit('open', row.assetId)">{{ row.assetName }}</button></td>
                    <td class="text-end text-secondary">{{ row.hours.toFixed(1) }}</td>
                    <td class="text-end">{{ row.utilPct.toFixed(1) }}%</td>
                  </tr>
                  <tr v-if="!insights.topUsed.length">
                    <td colspan="3" class="text-secondary small">No usage in this range</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="trax-list">
            <div class="trax-dash-head">
              <h2 class="trax-dash-title"><i class="bi bi-exclamation-triangle"></i>Overdue now</h2>
            </div>
            <div class="trax-table-wrap">
              <table class="trax-table">
                <thead>
                  <tr><th>Item</th><th>Customer</th><th>Due</th><th class="text-end">Late</th></tr>
                </thead>
                <tbody>
                  <!-- keyed by lineId; the button still opens the asset -->
                  <tr v-for="row in insights.overdue" :key="row.id">
                    <td>
                      <button class="trax-name-btn" @click="emit('open', row.assetId)">{{ row.name }}</button>
                      <span v-if="row.qty > 1" class="trax-kind-chip ms-1">×{{ row.qty }}</span>
                    </td>
                    <td class="text-secondary">{{ row.customer }}</td>
                    <td class="text-secondary trax-nowrap">{{ row.due }}</td>
                    <td class="text-end"><span class="trax-badge status-UNAV">{{ row.daysLate }}d</span></td>
                  </tr>
                  <tr v-if="!insights.overdue.length">
                    <td colspan="4" class="text-secondary small">Nothing overdue</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div class="col-12 col-xl-6 d-flex flex-column gap-3">
          <section class="trax-list">
            <div class="trax-dash-head">
              <h2 class="trax-dash-title"><i class="bi bi-bar-chart"></i>Hours by category</h2>
            </div>
            <div v-for="row in insights.byCategory" :key="row.category" class="trax-row">
              <div class="trax-row-main" role="img"
                   :aria-label="row.category + ': ' + row.hours.toFixed(0) + ' hours'">
                <div class="d-flex align-items-baseline gap-2 small">
                  <span class="fw-semibold flex-grow-1 text-truncate">{{ row.category }}</span>
                  <span class="text-secondary trax-nowrap">{{ row.hours.toFixed(0) }} h · {{ row.count }} units</span>
                </div>
                <div class="trax-bar">
                  <span :style="{ width: (row.hours / maxCategoryHours * 100) + '%' }"></span>
                </div>
              </div>
            </div>
            <div v-if="!insights.byCategory.length" class="trax-row trax-row-empty">No data</div>
          </section>

          <section class="trax-list">
            <div class="trax-dash-head">
              <h2 class="trax-dash-title" title="Never checked out in this range">
                <i class="bi bi-moon"></i>Idle
                <span class="trax-dash-count">{{ insights.neverUsed.length }}</span>
              </h2>
            </div>
            <div class="px-3 pb-3 pt-1 d-flex flex-wrap gap-1">
              <button v-for="row in insights.neverUsed" :key="row.assetId"
                      class="btn btn-sm btn-outline-secondary"
                      @click="emit('open', row.assetId)">
                {{ row.assetName }}
              </button>
              <span v-if="!insights.neverUsed.length" class="text-secondary small">Everything was used</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  `,
};
