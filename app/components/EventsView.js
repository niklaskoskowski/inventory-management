import { ref, computed } from 'vue';
import { state, saveEvent, toast, getAsset } from '../store.js';
import { formatDateTime, formatTotals, parseDate, getUiLocale } from '../lib/format.js';
import { valueOfLines } from '../lib/insights.js';
import {
  rentalDays as hireDays, rentalOfLines, daysLabel, HIRE_LABEL, hireOf,
} from '../lib/rental.js';
import { bookedOn, byStart, eventSettings, isClosed, isRunning, linesOf, statusOf } from '../lib/events.js';
import { exportRentalPdf } from '../lib/pdf.js';
import Menu from './ui/Menu.js';

/**
 * The jobs the gear goes out on.
 *
 * Every figure on this page is derived: what is booked on an event is the
 * checkout lines and reservations that NAME it, so the list cannot drift from
 * the counter. The one thing stored here is the event itself — and its status,
 * which the operator moves by hand as the job walks from the shelf to the van.
 */
const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'running', label: 'Running' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' },
];

export default {
  name: 'EventsView',
  components: { Menu },
  emits: ['open', 'edit'],
  setup(props, { emit }) {
    const filter = ref('open');
    const busy = ref(null);
    const exporting = ref(null);
    // Which cards have their gear list open, by event id.
    const expanded = ref({});

    const workflow = computed(() => eventSettings(state.settings));

    /** Every event with what is booked on it, its value and what it bills. */
    const rows = computed(() => {
      const now = new Date();

      return [...state.events]
        .sort(byStart)
        .map((event) => {
          const booked = bookedOn(event, {
            checkouts: state.checkouts,
            reservations: state.reservations,
          });
          const lines = linesOf(event, state.checkouts);

          // The window the gear is billed for: the event's own dates when it
          // has them, otherwise the period its lines are out for.
          const first = booked.lines[0];
          const from = event.startAt || first?.checkedOut || null;
          const to = event.endAt || first?.dueAt || first?.returnDate || null;
          const days = from && to ? hireDays(from, to) : 1;

          return {
            event,
            status: statusOf(state.settings, event),
            closed: isClosed(state.settings, event),
            running: isRunning(event, now),
            booked,
            days,
            hire: booked.lines.length ? hireOf(booked.lines[0]) : 'DRY',
            value: valueOfLines(lines, getAsset),
            rental: rentalOfLines(lines, getAsset, state.settings, days),
          };
        })
        .filter((row) => {
          if (filter.value === 'all') return true;
          if (filter.value === 'closed') return row.closed;
          if (filter.value === 'running') return row.running && !row.closed;
          return !row.closed;
        });
    });

    const counts = computed(() => ({
      open: state.events.filter((event) => !isClosed(state.settings, event)).length,
      total: state.events.length,
    }));

    /**
     * Move the job along: the one edit made straight from the list, because it
     * is the one that happens while somebody is holding a flight case.
     */
    const setStatus = async (row, status) => {
      if (!status || status === row.event.status) return;
      busy.value = row.event.id;
      try {
        await saveEvent({ ...row.event, status });
        const label = workflow.value.statuses.find((entry) => entry.id === status)?.label || status;
        toast(`${row.event.name} → ${label}.`, 'success');
      } catch {
        /* toast already raised by the store */
      } finally {
        busy.value = null;
      }
    };

    const toggle = (id) => { expanded.value = { ...expanded.value, [id]: !expanded.value[id] }; };

    /** The quote for one job: everything out on it, priced over its window. */
    const rentalPdf = async (row) => {
      exporting.value = row.event.id;
      try {
        await exportRentalPdf(linesOf(row.event, state.checkouts), state.assets, {
          days: row.days,
          hire: row.hire,
          kind: 'checkout',
          from: row.event.startAt || row.booked.lines[0]?.checkedOut,
          to: row.event.endAt || row.booked.lines[0]?.dueAt,
          customerName: row.event.client || row.booked.lines[0]?.customerName || '',
          customerEmail: row.booked.lines[0]?.customerEmail || '',
          reference: row.event.name,
          notes: row.event.location ? `Location: ${row.event.location}` : '',
        });
      } catch (error) {
        toast(`Could not build the rental PDF: ${error.message}`, 'danger', 8000);
      } finally {
        exporting.value = null;
      }
    };

    /** "Oct 12, 8:00 AM", the year only when it is not this one. */
    const shortWhen = (value) => {
      const date = parseDate(value);
      if (!date) return '—';
      const options = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
      if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
      try {
        return date.toLocaleString(getUiLocale(), options);
      } catch {
        return formatDateTime(value);
      }
    };

    /** "Jun 12, 8:00 AM → Jun 14, 11:00 PM", or what is known of it. */
    const dateWindow = (event) => {
      if (!event.startAt && !event.endAt) return 'No dates yet';
      if (event.startAt && event.endAt) {
        return `${shortWhen(event.startAt)} → ${shortWhen(event.endAt)}`;
      }
      return event.startAt ? `from ${shortWhen(event.startAt)}` : `until ${shortWhen(event.endAt)}`;
    };

    const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;

    return {
      state, FILTERS, plural, filter, rows, counts, workflow, busy, exporting, expanded,
      setStatus, toggle, rentalPdf, dateWindow, shortWhen,
      formatDateTime, formatTotals, daysLabel, HIRE_LABEL, parseDate, getAsset, emit,
    };
  },
  template: `
    <div class="d-flex align-items-center gap-2 mb-3">
      <div class="btn-group btn-group-sm" role="group" aria-label="Filter events">
        <button v-for="tab in FILTERS" :key="tab.id" type="button" class="btn"
                :class="filter === tab.id ? 'btn-secondary active' : 'btn-outline-secondary'"
                :aria-pressed="filter === tab.id ? 'true' : 'false'"
                @click="filter = tab.id">
          {{ tab.label }}
        </button>
      </div>
      <span class="text-secondary small flex-grow-1 d-none d-sm-inline">
        {{ counts.open }} open · {{ counts.total }} total
      </span>
      <span class="flex-grow-1 d-sm-none"></span>
      <button class="btn btn-sm btn-primary" @click="emit('edit', null)" aria-label="New event">
        <i class="bi bi-plus-lg"></i> New<span class="d-none d-sm-inline"> event</span>
      </button>
    </div>

    <div v-if="!rows.length" class="trax-empty">
      <i class="bi bi-calendar-event"></i>
      <strong>No events</strong>
      <div class="small mt-1 mb-3">Group gear by job: a festival, a shoot, a conference.</div>
      <button class="btn btn-sm btn-primary" @click="emit('edit', null)">
        <i class="bi bi-plus-lg"></i> New event
      </button>
    </div>

    <div v-else class="trax-list">
      <article v-for="row in rows" :key="row.event.id" class="trax-row align-items-start flex-wrap">
        <div class="trax-row-main">
          <div class="d-flex align-items-start gap-2">
            <div class="trax-row-title flex-grow-1 min-w-0 pt-1">
              <button class="trax-name-btn text-truncate mw-100" @click="emit('edit', row.event.id)">
                {{ row.event.name }}
              </button>
              <span v-if="row.running" class="trax-badge status-FREE flex-shrink-0">
                <span class="trax-badge-dot"></span> Running
              </span>
            </div>
            <Menu :label="'More for ' + row.event.name">
              <button class="trax-menu-item" @click="emit('edit', row.event.id)"
                      :aria-label="'Edit ' + row.event.name">
                <i class="bi bi-pencil"></i> Edit
              </button>
              <button class="trax-menu-item"
                      :disabled="exporting === row.event.id || !row.booked.lines.length"
                      :aria-label="'Rental quote PDF for ' + row.event.name"
                      @click="rentalPdf(row)">
                <i class="bi bi-receipt"></i> Rental quote PDF
              </button>
            </Menu>
          </div>

          <div class="trax-row-meta">
            <span>{{ dateWindow(row.event) }}</span>
            <span v-if="row.event.client">{{ row.event.client }}</span>
            <span v-if="row.event.location"><i class="bi bi-geo-alt"></i> {{ row.event.location }}</span>
            <span v-if="row.event.contact"><i class="bi bi-person"></i> {{ row.event.contact }}</span>
          </div>

          <div class="trax-row-meta">
            <span v-if="!row.booked.units && !row.booked.reservations.length">Nothing booked</span>
            <span v-else>
              {{ plural(row.booked.units, 'unit') }} out<span v-if="row.booked.reservations.length">
              · {{ plural(row.booked.reservations.length, 'reservation') }}</span>
            </span>
            <template v-if="row.booked.lines.length">
              <span class="trax-kind-chip">{{ HIRE_LABEL[row.hire] }}</span>
              <span>Value {{ formatTotals(row.value.totals) }}</span>
              <span>Rental · {{ daysLabel(row.days) }} <strong class="fw-semibold">{{ formatTotals(row.rental.totals) }}</strong></span>
            </template>
            <span v-if="exporting === row.event.id" class="spinner-border spinner-border-sm"></span>
          </div>

          <div v-if="row.event.notes" class="trax-row-notes">{{ row.event.notes }}</div>

          <div class="d-flex align-items-center gap-2 flex-wrap mt-2">
            <!-- The status is how the job moves along: the one edit made
                 straight from the list, while somebody holds a flight case. -->
            <span class="trax-color-dot" :style="{ color: row.status.color }" aria-hidden="true"></span>
            <select class="trax-chip-select"
                    :value="row.event.status" :disabled="busy === row.event.id"
                    :aria-label="'Status of ' + row.event.name"
                    @change="setStatus(row, $event.target.value)">
              <option v-for="status in workflow.statuses" :key="status.id" :value="status.id">
                {{ status.label }}
              </option>
              <!-- A status the workflow no longer has still has to be listed,
                   or the select would silently show something else. -->
              <option v-if="!row.status.known" :value="row.status.id">{{ row.status.label }}</option>
            </select>
            <button v-if="row.booked.lines.length || row.booked.reservations.length"
                    class="btn btn-sm btn-link px-1 ms-auto"
                    :aria-expanded="expanded[row.event.id] ? 'true' : 'false'"
                    :aria-label="'Show what is booked on ' + row.event.name"
                    @click="toggle(row.event.id)">
              {{ expanded[row.event.id] ? 'Hide gear' : 'Show gear' }}
              <i class="bi" :class="expanded[row.event.id] ? 'bi-chevron-up' : 'bi-chevron-down'"></i>
            </button>
          </div>

          <!-- What is on the job, out of the records that name it. -->
          <div v-if="expanded[row.event.id]" class="trax-card mt-2">
            <div v-for="line in row.booked.lines" :key="'l' + line.lineId" class="trax-row">
              <i class="bi bi-box-arrow-right text-secondary"></i>
              <div class="trax-row-main">
                <div class="trax-row-title">
                  <button class="trax-name-btn text-truncate mw-100" @click="emit('open', line.assetId)">
                    {{ line.name || ('#' + line.assetId) }}
                  </button>
                </div>
                <div class="trax-row-meta">
                  <span>×{{ line.qty }}</span>
                  <span v-if="line.unitNos?.length" class="trax-kind-chip font-monospace">
                    {{ line.unitNos.map(no => line.assetId + '.' + no).join(', ') }}
                  </span>
                  <span>{{ line.customerName }}</span>
                  <span>due {{ shortWhen(line.dueAt || line.returnDate) }}</span>
                </div>
              </div>
            </div>

            <div v-for="reservation in row.booked.reservations" :key="'r' + reservation.id" class="trax-row">
              <i class="bi bi-calendar-check text-secondary"></i>
              <div class="trax-row-main">
                <div class="trax-row-title">
                  <span>{{ reservation.customerName }}</span>
                  <span class="text-secondary fw-normal small">#{{ reservation.id }}</span>
                </div>
                <div class="trax-row-meta">
                  <span>{{ plural((reservation.items || []).length, 'item') }}</span>
                  <span>{{ shortWhen(reservation.startAt) }} → {{ shortWhen(reservation.endAt) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>
  `,
};
