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
    <div class="d-flex align-items-end gap-2 mb-3 flex-wrap">
      <div>
        <label class="form-label small" for="ins-range">Range</label>
        <select id="ins-range" class="form-select form-select-sm" v-model="preset" style="width:auto">
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="365">Last year</option>
          <option value="custom">Custom…</option>
        </select>
      </div>

      <template v-if="preset === 'custom'">
        <div>
          <label class="form-label small" for="ins-from">From</label>
          <input id="ins-from" type="date" class="form-control form-control-sm" v-model="customStart">
        </div>
        <div>
          <label class="form-label small" for="ins-to">To</label>
          <input id="ins-to" type="date" class="form-control form-control-sm" v-model="customEnd">
        </div>
      </template>

      <div>
        <label class="form-label small" for="ins-status">Status</label>
        <select id="ins-status" class="form-select form-select-sm" v-model="statusFilter" style="width:auto">
          <option value="">All</option>
          <option value="FREE">Available</option>
          <option value="RSVD">Reserved</option>
          <option value="UNAV">Checked out</option>
          <option value="LOCK">Blocked</option>
        </select>
      </div>

      <span class="flex-grow-1"></span>

      <button class="btn btn-sm btn-outline-secondary" :disabled="exporting" @click="doExport('inventory')">
        <i class="bi bi-filetype-pdf"></i> Inventory PDF
      </button>
      <button class="btn btn-sm btn-outline-secondary" :disabled="exporting" @click="doExport('insights')">
        <i class="bi bi-filetype-pdf"></i> Insights PDF
      </button>
    </div>

    <p class="small text-secondary">
      {{ formatDate(insights.rangeStart) }} – {{ formatDate(insights.rangeEnd) }}
    </p>

    <div class="row g-3 mb-3">
      <div class="col-6 col-lg-3">
        <div class="trax-kpi">
          <div class="trax-kpi-label">Assets in scope</div>
          <div class="trax-kpi-value">{{ insights.totalAssets }}</div>
          <div class="trax-kpi-note">{{ insights.totalUnits }} units</div>
        </div>
      </div>
      <div class="col-6 col-lg-3">
        <div class="trax-kpi">
          <div class="trax-kpi-label">Units out now</div>
          <div class="trax-kpi-value">{{ insights.checkedOutNow }}</div>
          <div class="trax-kpi-note">{{ insights.checkedOutLines }} line(s)</div>
        </div>
      </div>
      <div class="col-6 col-lg-3">
        <div class="trax-kpi">
          <div class="trax-kpi-label">Overdue</div>
          <div class="trax-kpi-value" :class="insights.overdueNow ? 'text-danger' : ''">
            {{ insights.overdueNow }}
          </div>
        </div>
      </div>
      <div class="col-6 col-lg-3">
        <div class="trax-kpi">
          <div class="trax-kpi-label">Avg utilization</div>
          <div class="trax-kpi-value">{{ insights.avgUtil.toFixed(1) }}%</div>
        </div>
      </div>
    </div>

    <div class="row g-3">
      <div class="col-12 col-xl-6">
        <div class="trax-card h-100">
          <div class="trax-card-pad"><h2 class="trax-page-title">Most used</h2></div>
          <table class="trax-table">
            <thead>
              <tr><th>Item</th><th class="text-end">Hours</th><th class="text-end">Utilization</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in insights.topUsed" :key="row.assetId">
                <td><button class="trax-name-btn" @click="emit('open', row.assetId)">{{ row.assetName }}</button></td>
                <td class="text-end">{{ row.hours.toFixed(1) }}</td>
                <td class="text-end">{{ row.utilPct.toFixed(1) }}%</td>
              </tr>
              <tr v-if="!insights.topUsed.length">
                <td colspan="3" class="text-secondary small">No usage in this range.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="col-12 col-xl-6">
        <div class="trax-card h-100">
          <div class="trax-card-pad"><h2 class="trax-page-title">Hours by category</h2></div>
          <div class="trax-card-pad pt-0">
            <div v-for="row in insights.byCategory" :key="row.category" class="mb-2">
              <div class="d-flex justify-content-between small">
                <span>{{ row.category }}</span>
                <span class="text-secondary">{{ row.hours.toFixed(0) }} h · {{ row.count }} units</span>
              </div>
              <div class="progress" style="height:6px" role="img"
                   :aria-label="row.category + ': ' + row.hours.toFixed(0) + ' hours'">
                <div class="progress-bar" :style="{ width: (row.hours / maxCategoryHours * 100) + '%' }"></div>
              </div>
            </div>
            <p v-if="!insights.byCategory.length" class="text-secondary small mb-0">No data.</p>
          </div>
        </div>
      </div>

      <div class="col-12 col-xl-6">
        <div class="trax-card h-100">
          <div class="trax-card-pad"><h2 class="trax-page-title">Overdue now</h2></div>
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
                <td class="text-secondary">{{ row.due }}</td>
                <td class="text-end text-danger">{{ row.daysLate }}d</td>
              </tr>
              <tr v-if="!insights.overdue.length">
                <td colspan="4" class="text-secondary small">Nothing overdue.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="col-12 col-xl-6">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">
              Idle in this range
              <span class="text-secondary small">({{ insights.neverUsed.length }})</span>
            </h2>
            <p class="small text-secondary mb-0">Never checked out during the selected window.</p>
          </div>
          <div class="trax-card-pad pt-0 d-flex flex-wrap gap-1">
            <button v-for="row in insights.neverUsed" :key="row.assetId"
                    class="btn btn-sm btn-outline-secondary py-0 px-1" style="font-size:.72rem"
                    @click="emit('open', row.assetId)">
              {{ row.assetName }}
            </button>
            <span v-if="!insights.neverUsed.length" class="text-secondary small">Everything saw use.</span>
          </div>
        </div>
      </div>
    </div>
  `,
};
