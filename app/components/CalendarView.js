import { ref, computed } from 'vue';
import { state, items, sets, getAsset } from '../store.js';
import { buildTimeline } from '../lib/schedule.js';
import { startOfDay, addDays, formatDate, formatDateTime, getUiLocale } from '../lib/format.js';

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
      // Narrower on a phone, so the days get most of the screen.
      '--trax-tl-label': 'clamp(104px, 26vw, 200px)',
      '--trax-tl-lane': '18px',
      gridTemplateColumns: `var(--trax-tl-label) repeat(${model.value.dayCount}, minmax(26px, 1fr))`,
    }));

    const shift = (n) => { anchor.value = addDays(anchor.value, n); };
    const today = () => { anchor.value = startOfDay(new Date()); };

    const pickBand = (band, row) => {
      picked.value = { band, row };
    };

    /** "Oct 9 – Nov 9, 2026": the window, compactly. */
    const rangeLabel = computed(() => {
      const from = model.value.windowStart;
      const to = model.value.windowEnd;
      try {
        const locale = getUiLocale();
        const sameYear = from.getFullYear() === to.getFullYear();
        const a = from.toLocaleDateString(locale, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
        const b = to.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
        return `${a} – ${b}`;
      } catch {
        return `${formatDate(from)} – ${formatDate(to)}`;
      }
    });

    return {
      state, anchor, days, scope, onlyBusy, picked, model, visibleRows, gridStyle,
      shift, today, pickBand, rangeLabel, formatDate, formatDateTime, getAsset, emit,
    };
  },
  template: `
    <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
      <div class="btn-group btn-group-sm" role="group" aria-label="Move the range">
        <button class="btn btn-outline-secondary" @click="shift(-days)"
                aria-label="Previous period" title="Previous period">
          <i class="bi bi-chevron-double-left"></i>
        </button>
        <button class="btn btn-outline-secondary" @click="shift(-7)"
                aria-label="Back 7 days" title="Back 7 days">
          <i class="bi bi-chevron-left"></i>
        </button>
        <button class="btn btn-outline-secondary" @click="today()">Today</button>
        <button class="btn btn-outline-secondary" @click="shift(7)"
                aria-label="Forward 7 days" title="Forward 7 days">
          <i class="bi bi-chevron-right"></i>
        </button>
        <button class="btn btn-outline-secondary" @click="shift(days)"
                aria-label="Next period" title="Next period">
          <i class="bi bi-chevron-double-right"></i>
        </button>
      </div>

      <strong class="text-nowrap" :title="formatDate(model.windowStart) + ' – ' + formatDate(model.windowEnd)">
        {{ rangeLabel }}
      </strong>

      <div class="d-flex align-items-center gap-2 flex-wrap ms-lg-auto">
        <select class="trax-chip-select" v-model.number="days" aria-label="Range length">
          <option :value="14">2 weeks</option>
          <option :value="31">1 month</option>
          <option :value="62">2 months</option>
          <option :value="92">3 months</option>
        </select>

        <div class="btn-group btn-group-sm" role="group" aria-label="Rows">
          <button class="btn" :class="scope === 'assets' ? 'btn-secondary' : 'btn-outline-secondary'"
                  @click="scope = 'assets'">Items</button>
          <button class="btn" :class="scope === 'sets' ? 'btn-secondary' : 'btn-outline-secondary'"
                  @click="scope = 'sets'">Kits</button>
        </div>

        <div class="form-check form-switch mb-0">
          <input class="form-check-input" type="checkbox" role="switch" id="only-busy" v-model="onlyBusy">
          <label class="form-check-label small ms-1" for="only-busy">Booked only</label>
        </div>
      </div>
    </div>

    <div class="trax-tl-legend mb-2" aria-label="Legend">
      <span><i class="trax-tl-key kind-reservation"></i> Reserved</span>
      <span><i class="trax-tl-key kind-checkout"></i> Out</span>
      <span><i class="trax-tl-key kind-overdue"></i> Overdue</span>
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
    <div v-if="picked" class="trax-list mt-3">
      <div class="trax-row">
        <span class="trax-tl-key flex-shrink-0" :class="'kind-' + picked.band.kind"></span>
        <div class="trax-row-main">
          <div class="trax-row-title">
            <span>{{ picked.band.label }}</span>
            <span class="text-secondary fw-normal small flex-shrink-0">
              {{ picked.band.kind === 'reservation' ? 'Reservation' : 'Checkout' }}
            </span>
          </div>
          <div class="trax-row-meta">
            <span>{{ picked.row.label }}</span>
            <span>{{ picked.band.tooltip }}</span>
          </div>
        </div>
        <button class="btn btn-sm btn-outline-secondary" @click="emit('open', picked.row.id)">
          Open
        </button>
        <button class="trax-close" aria-label="Close" @click="picked = null">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>
  `,
};
