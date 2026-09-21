import { ref, computed } from 'vue';
import { state, saveEvent, toast, getAsset } from '../store.js';
import { formatDateTime, formatTotals, parseDate } from '../lib/format.js';
import { valueOfLines } from '../lib/insights.js';
import {
  rentalDays as hireDays, rentalOfLines, daysLabel, HIRE_LABEL, hireOf,
} from '../lib/rental.js';
import { bookedOn, byStart, eventSettings, isClosed, isRunning, linesOf, statusOf } from '../lib/events.js';
import { exportRentalPdf } from '../lib/pdf.js';

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

    /** "12 Jun, 08:00 → 14 Jun, 23:00", or what is known of it. */
    const dateWindow = (event) => {
      if (!event.startAt && !event.endAt) return 'No dates yet';
      if (event.startAt && event.endAt) {
        return `${formatDateTime(event.startAt)} → ${formatDateTime(event.endAt)}`;
      }
      return event.startAt ? `from ${formatDateTime(event.startAt)}` : `until ${formatDateTime(event.endAt)}`;
    };

    return {
      state, FILTERS, filter, rows, counts, workflow, busy, exporting, expanded,
      setStatus, toggle, rentalPdf, dateWindow,
      formatDateTime, formatTotals, daysLabel, HIRE_LABEL, parseDate, getAsset, emit,
    };
  },
  template: `
    <div class="d-flex align-items-center gap-2 mb-3 flex-wrap">
      <div class="btn-group btn-group-sm" role="group" aria-label="Filter events">
        <button v-for="tab in FILTERS" :key="tab.id" type="button" class="btn"
                :class="filter === tab.id ? 'btn-secondary active' : 'btn-outline-secondary'"
                @click="filter = tab.id">
          {{ tab.label }}
        </button>
      </div>
      <span class="text-secondary small flex-grow-1">
        {{ counts.open }} open · {{ counts.total }} in total
      </span>
      <button class="btn btn-sm btn-primary" @click="emit('edit', null)">
        <i class="bi bi-plus-lg"></i> New event
      </button>
    </div>

    <div v-if="!rows.length" class="trax-empty">
      <i class="bi bi-calendar-event"></i>
      <p class="mb-1"><strong>No events here</strong></p>
      <p class="small mb-3">
        An event is a job the gear goes out on — a festival, a conference, a shoot. Create one, then
        pick it in the selection drawer when you check gear out or reserve it, and everything on the
        job is listed together.
      </p>
      <button class="btn btn-sm btn-primary" @click="emit('edit', null)">
        <i class="bi bi-plus-lg"></i> New event
      </button>
    </div>

    <div v-else class="d-flex flex-column gap-3">
      <article v-for="row in rows" :key="row.event.id" class="trax-card">
        <div class="trax-card-pad d-flex align-items-start gap-2 flex-wrap">
          <div class="flex-grow-1 min-w-0">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <button class="trax-name-btn" @click="emit('edit', row.event.id)">
                <strong>{{ row.event.name }}</strong>
              </button>
              <!-- The status is a chip in its own colour, and the select next
                   to it is how the job actually moves along. -->
              <span class="trax-badge" :style="{ backgroundColor: row.status.color, color: '#fff' }">
                {{ row.status.label }}
              </span>
              <span v-if="row.running" class="trax-kind-chip">
                <i class="bi bi-broadcast"></i> running
              </span>
              <span v-if="row.event.client" class="text-secondary small">{{ row.event.client }}</span>
            </div>

            <div class="small text-secondary mt-1">
              {{ dateWindow(row.event) }}
              <span v-if="row.event.location"> · {{ row.event.location }}</span>
              <span v-if="row.event.contact"> · {{ row.event.contact }}</span>
            </div>

            <div class="small text-secondary">
              <strong>{{ row.booked.units }}</strong> unit(s) out on
              {{ row.booked.lines.length }} line(s)<span v-if="row.booked.reservations.length">,
              {{ row.booked.reservations.length }} reservation(s)</span>
              <span v-if="row.booked.lines.length">
                · <span class="trax-kind-chip">{{ HIRE_LABEL[row.hire] }}</span>
                Value {{ formatTotals(row.value.totals) }} ·
                Rental {{ daysLabel(row.days) }}: <strong>{{ formatTotals(row.rental.totals) }}</strong>
              </span>
            </div>
          </div>

          <div class="d-flex align-items-center gap-1 flex-wrap">
            <select class="form-select form-select-sm" style="width:10rem"
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
            <button class="btn btn-sm btn-outline-secondary"
                    :disabled="exporting === row.event.id || !row.booked.lines.length"
                    :aria-label="'Rental quote PDF for ' + row.event.name"
                    @click="rentalPdf(row)">
              <span v-if="exporting === row.event.id" class="spinner-border spinner-border-sm"></span>
              <i v-else class="bi bi-receipt"></i>
            </button>
            <button class="btn btn-sm btn-outline-secondary"
                    :aria-label="'Edit ' + row.event.name" @click="emit('edit', row.event.id)">
              <i class="bi bi-pencil"></i>
            </button>
            <button v-if="row.booked.lines.length || row.booked.reservations.length"
                    class="btn btn-sm btn-outline-secondary"
                    :aria-label="'Show what is booked on ' + row.event.name"
                    @click="toggle(row.event.id)">
              <i class="bi" :class="expanded[row.event.id] ? 'bi-chevron-up' : 'bi-chevron-down'"></i>
            </button>
          </div>
        </div>

        <!-- What is on the job, out of the records that name it. -->
        <ul v-if="expanded[row.event.id]" class="list-group list-group-flush">
          <li v-for="line in row.booked.lines" :key="'l' + line.lineId"
              class="list-group-item bg-transparent d-flex align-items-center gap-2">
            <i class="bi bi-box-arrow-right text-secondary"></i>
            <button class="trax-name-btn flex-grow-1" @click="emit('open', line.assetId)">
              {{ line.name || ('#' + line.assetId) }}
            </button>
            <span class="trax-kind-chip">×{{ line.qty }}</span>
            <span v-if="line.unitNos?.length" class="trax-kind-chip font-monospace">
              {{ line.unitNos.map(no => line.assetId + '.' + no).join(', ') }}
            </span>
            <span class="small text-secondary">
              {{ line.customerName }} · due {{ formatDateTime(line.dueAt || line.returnDate) }}
            </span>
          </li>

          <li v-for="reservation in row.booked.reservations" :key="'r' + reservation.id"
              class="list-group-item bg-transparent d-flex align-items-center gap-2">
            <i class="bi bi-calendar-check text-secondary"></i>
            <span class="flex-grow-1">
              Reservation #{{ reservation.id }} · {{ reservation.customerName }}
            </span>
            <span class="trax-kind-chip">{{ (reservation.items || []).length }} item(s)</span>
            <span class="small text-secondary">
              {{ formatDateTime(reservation.startAt) }} → {{ formatDateTime(reservation.endAt) }}
            </span>
          </li>
        </ul>

        <div v-if="row.event.notes" class="trax-card-pad pt-0 small text-secondary">
          {{ row.event.notes }}
        </div>
      </article>
    </div>
  `,
};
