import { ref, computed } from 'vue';
import { state, items, sets, getAsset } from '../store.js';
import { buildTimeline } from '../lib/schedule.js';
import { startOfDay, addDays, formatDate, formatDateTime } from '../lib/format.js';

/**
 * Booking calendar.
 *
 * One CSS grid: columns are [label, ...days] and a band is placed with
 * `grid-column: index + 2 / span days`. No chart library, no absolute
 * positioning, no pixel maths — it reflows on resize for free.
 */
export default {
  name: 'CalendarView',
  emits: ['open'],
  setup(props, { emit }) {
    const anchor = ref(startOfDay(new Date()));
    const days = ref(31);
    const scope = ref('assets');
    const onlyBusy = ref(false);
    const picked = ref(null);

    const rows = computed(() => {
      const source = scope.value === 'sets'
        ? sets.value.map((set) => ({
            key: `s${set.id}`,
            label: set.name,
            kind: 'set',
            id: set.id,
            // Members are {assetId, qty} now; the timeline only needs the ids.
            memberIds: set.members.map((m) => Number(m?.assetId ?? m)),
          }))
        : items.value.map((asset) => ({
            key: `a${asset.id}`,
            label: asset.name,
            kind: 'asset',
            id: asset.id,
            memberIds: [asset.id],
          }));
      return source;
    });

    const model = computed(() =>
      buildTimeline({
        windowStart: anchor.value,
        windowEnd: addDays(anchor.value, days.value),
        rows: rows.value,
        reservations: state.reservations,
        checkouts: state.checkouts,
        now: new Date(),
      }),
    );

    const visibleRows = computed(() =>
      onlyBusy.value ? model.value.rows.filter((row) => row.bands.length) : model.value.rows,
    );

    const gridStyle = computed(() => ({
      '--trax-tl-label': '180px',
      '--trax-tl-lane': '18px',
      gridTemplateColumns: `var(--trax-tl-label) repeat(${model.value.dayCount}, minmax(26px, 1fr))`,
    }));

    const shift = (n) => { anchor.value = addDays(anchor.value, n); };
    const today = () => { anchor.value = startOfDay(new Date()); };

    const pickBand = (band, row) => {
      picked.value = { band, row };
    };

    return {
      state, anchor, days, scope, onlyBusy, picked, model, visibleRows, gridStyle,
      shift, today, pickBand, formatDate, formatDateTime, getAsset, emit,
    };
  },
  template: `
    <div class="d-flex align-items-center gap-2 mb-3 flex-wrap">
      <div class="btn-group btn-group-sm">
        <button class="btn btn-outline-secondary" @click="shift(-days)" aria-label="Previous period">
          <i class="bi bi-chevron-double-left"></i>
        </button>
        <button class="btn btn-outline-secondary" @click="shift(-7)">−7d</button>
        <button class="btn btn-outline-secondary" @click="today()">Today</button>
        <button class="btn btn-outline-secondary" @click="shift(7)">+7d</button>
        <button class="btn btn-outline-secondary" @click="shift(days)" aria-label="Next period">
          <i class="bi bi-chevron-double-right"></i>
        </button>
      </div>

      <strong class="small">
        {{ formatDate(model.windowStart) }} – {{ formatDate(model.windowEnd) }}
      </strong>

      <select class="form-select form-select-sm" style="width:auto" v-model.number="days"
              aria-label="Range length">
        <option :value="14">2 weeks</option>
        <option :value="31">1 month</option>
        <option :value="62">2 months</option>
        <option :value="92">3 months</option>
      </select>

      <div class="btn-group btn-group-sm" role="group" aria-label="Row scope">
        <button class="btn" :class="scope === 'assets' ? 'btn-secondary' : 'btn-outline-secondary'"
                @click="scope = 'assets'">Items</button>
        <button class="btn" :class="scope === 'sets' ? 'btn-secondary' : 'btn-outline-secondary'"
                @click="scope = 'sets'">Kits</button>
      </div>

      <div class="form-check form-switch ms-1">
        <input class="form-check-input" type="checkbox" id="only-busy" v-model="onlyBusy">
        <label class="form-check-label small" for="only-busy">Only booked</label>
      </div>

      <span class="ms-auto small text-secondary d-flex align-items-center gap-2">
        <span><i class="trax-tl-key" style="background:var(--trax-rsvd)"></i> reserved</span>
        <span><i class="trax-tl-key" style="background:var(--trax-unav)"></i> out</span>
        <span><i class="trax-tl-key" style="background:repeating-linear-gradient(45deg,#e5534b 0 4px,#7d1f1a 4px 8px)"></i> overdue</span>
      </span>
    </div>

    <div class="trax-timeline-scroll">
      <div class="trax-timeline" :style="gridStyle" role="grid" aria-label="Booking calendar">
        <div class="trax-tl-corner"></div>
        <div v-for="day in model.days" :key="day.iso" class="trax-tl-head"
             :class="{ 'is-weekend': day.weekend, 'is-today': day.today }">
          <span class="trax-tl-dow">{{ day.dow }}</span>
          <span class="trax-tl-dom">{{ day.dom }}</span>
        </div>

        <template v-for="(row, r) in visibleRows" :key="row.key">
          <div class="trax-tl-label" :style="{ gridRow: r + 2 }" :title="row.label">
            <button class="trax-name-btn" @click="emit('open', row.id)">{{ row.label }}</button>
          </div>

          <div v-for="day in model.days" :key="row.key + day.iso"
               class="trax-tl-cell"
               :class="{ 'is-weekend': day.weekend, 'is-today': day.today }"
               :style="{
                 gridRow: r + 2,
                 gridColumn: day.index + 2,
                 minHeight: 'calc(var(--trax-tl-lane) * ' + row.lanes + ' + 8px)'
               }"></div>

          <button v-for="band in row.bands" :key="band.key" type="button"
                  class="trax-tl-band"
                  :class="['kind-' + band.kind, { 'clip-start': band.clipStart, 'clip-end': band.clipEnd }]"
                  :style="{
                    gridRow: r + 2,
                    gridColumn: (band.index + 2) + ' / span ' + band.span,
                    marginTop: 'calc(var(--trax-tl-lane) * ' + band.lane + ' + 3px)'
                  }"
                  :title="band.tooltip"
                  @click="pickBand(band, row)">
            {{ band.label }}
          </button>
        </template>
      </div>
    </div>

    <p v-if="!visibleRows.length" class="trax-empty">
      <i class="bi bi-calendar3"></i>
      Nothing booked in this range.
    </p>

    <!-- Detail for a clicked band -->
    <div v-if="picked" class="trax-card trax-card-pad mt-3">
      <div class="d-flex align-items-start gap-2">
        <div class="flex-grow-1">
          <h3 class="trax-page-title">
            {{ picked.band.kind === 'reservation' ? 'Reservation' : 'Checkout' }} · {{ picked.band.label }}
          </h3>
          <p class="small text-secondary mb-1">{{ picked.band.tooltip }}</p>
          <p class="small mb-0">Row: {{ picked.row.label }}</p>
        </div>
        <button class="btn btn-sm btn-outline-secondary" @click="emit('open', picked.row.id)">
          Open asset
        </button>
        <button class="btn-close btn-close-white" aria-label="Close" @click="picked = null"></button>
      </div>
    </div>
  `,
};
