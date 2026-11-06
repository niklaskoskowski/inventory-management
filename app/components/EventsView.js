import { ref, computed } from 'vue';
import { state, saveEvent, toast, getAsset, mutate, eventGearAdd, eventGearRemove, selectForEvent } from '../store.js';
import { formatDateTime, formatTotals, parseDate, getUiLocale } from '../lib/format.js';
import { valueOfLines } from '../lib/insights.js';
import {
  rentalDays as hireDays, rentalOfLines, daysLabel, HIRE_LABEL, hireOf,
} from '../lib/rental.js';
import { bookedOn, byStart, eventSettings, isClosed, isRunning, linesOf, statusOf, gearOf, gearTotals } from '../lib/events.js';
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
  emits: ['open', 'edit', 'basket', 'scan'],
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

          const gear = gearOf(event, {
            checkouts: state.checkouts, bookings: state.bookings, reservations: state.reservations, assets: getAsset,
          });
          return {
            event,
            gear,
            gearTotals: gearTotals(gear),
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

    // --- Gear list: one line per item, add / scan / check out / return ----
    const picked = ref({});            // eventId -> [assetId]
    const pickedOf = (row) => picked.value[row.event.id] || [];
    const togglePick = (row, assetId) => {
      const list = new Set(pickedOf(row));
      if (list.has(assetId)) list.delete(assetId); else list.add(assetId);
      picked.value = { ...picked.value, [row.event.id]: [...list] };
    };
    const search = ref({ eventId: null, q: '', qty: 1 });
    const openSearch = (row) => {
      search.value = { eventId: row.event.id, q: '', qty: 1 };
      expanded.value = { ...expanded.value, [row.event.id]: true };
    };
    /** Assets matching the search: name, ID, or a unit code like 161.2. */
    const suggestions = computed(() => {
      const q = search.value.q.trim().toLowerCase();
      if (q.length < 1) return [];
      const unit = /^(\d+)\.(\d+)$/.exec(q);
      if (unit) {
        const asset = getAsset(Number(unit[1]));
        const no = Number(unit[2]);
        return asset && (asset.units || []).some((u) => Number(u.no) === no) ? [{ asset, unitNo: no }] : [];
      }
      return state.assets
        .filter((a) => String(a.id) === q || (a.name || '').toLowerCase().includes(q) || (a.serial || '').toLowerCase().includes(q))
        .slice(0, 8)
        .map((asset) => ({ asset, unitNo: null }));
    });
    const addGear = async (row, hit) => {
      try {
        const qty = hit.unitNo ? 1 : Math.max(1, Number(search.value.qty) || 1);
        const data = await eventGearAdd(row.event.id, [{ id: hit.asset.id, qty, unitNos: hit.unitNo ? [hit.unitNo] : [] }]);
        toast(`${hit.unitNo ? hit.asset.id + '.' + hit.unitNo : hit.asset.name}${qty > 1 ? ' ×' + qty : ''} added${data.late ? ' (later)' : ''}.`, 'success', 1800);
        search.value = { ...search.value, q: '', qty: 1 };
      } catch { /* toast raised by the store */ }
    };
    const removeGear = async (row, gearRow) => {
      try { await eventGearRemove(row.event.id, { assetId: gearRow.assetId }); } catch { /* toast raised */ }
    };
    const scanTo = (row) => { state.scanEvent = row.event.id; emit('scan'); };
    /** Check out what is still to go — the ticked lines, or everything. */
    const checkOut = (row) => {
      const ticked = pickedOf(row);
      const rows = row.gear.filter((g) => g.toGo > 0 && (!ticked.length || ticked.includes(g.assetId)));
      if (!rows.length) { toast('Nothing left to check out.', 'info'); return; }
      const hire = row.booked.lines[0]?.hire || null;
      selectForEvent(row.event.id, rows.map((g) => ({ assetId: g.assetId, qty: g.toGo, unitNos: g.unitsToGo.slice(0, g.toGo) })), hire);
      picked.value = { ...picked.value, [row.event.id]: [] };
      emit('basket');
    };
    const returning = ref(null);
    /** Return what is out — the ticked lines, or everything on the event. */
    const returnGear = async (row) => {
      const ticked = pickedOf(row);
      const lines = row.gear.filter((g) => g.out > 0 && (!ticked.length || ticked.includes(g.assetId))).flatMap((g) => g.lines);
      if (!lines.length) { toast('Nothing is out on this event.', 'info'); return; }
      returning.value = row.event.id;
      try {
        const units = lines.reduce((n, l) => n + Math.max(1, Number(l.qty) || 1), 0);
        await mutate('checkout.checkin', { lines: lines.map((l) => ({ lineId: l.lineId })) });
        toast(`${units} unit(s) returned from ${row.event.name}.`, 'success');
        picked.value = { ...picked.value, [row.event.id]: [] };
      } catch { /* toast raised */ } finally { returning.value = null; }
    };
    const shortDate = (value) => shortWhen(value);

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
      picked, pickedOf, togglePick, search, openSearch, suggestions, addGear, removeGear, scanTo, checkOut, returnGear, returning, shortDate,
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
            <span v-if="!row.gear.length">No gear yet</span>
            <template v-else>
              <span v-if="row.gearTotals.toGo">{{ row.gearTotals.toGo }} to check out</span>
              <span v-if="row.gearTotals.out" :class="{ 'text-danger': row.gearTotals.overdue }">{{ row.gearTotals.out }} out</span>
              <span v-if="row.gearTotals.back">{{ row.gearTotals.back }} back</span>
              <span v-if="row.gearTotals.late" class="trax-kind-chip">{{ row.gearTotals.late }} added later</span>
            </template>
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
            <button class="btn btn-sm btn-link px-1 ms-auto"
                    :aria-expanded="expanded[row.event.id] ? 'true' : 'false'"
                    :aria-label="'Gear of ' + row.event.name"
                    @click="toggle(row.event.id)">
              Gear<span v-if="row.gear.length"> ({{ row.gear.length }})</span>
              <i class="bi" :class="expanded[row.event.id] ? 'bi-chevron-up' : 'bi-chevron-down'"></i>
            </button>
          </div>

          <!-- The gear list: one line per item, whatever state it is in. -->
          <div v-if="expanded[row.event.id]" class="trax-card mt-2">
            <div class="d-flex flex-wrap align-items-center gap-2 p-2">
              <button class="btn btn-sm btn-outline-primary" @click="openSearch(row)"><i class="bi bi-plus-lg"></i> Add</button>
              <button class="btn btn-sm btn-outline-primary" @click="scanTo(row)"><i class="bi bi-qr-code-scan"></i> Scan</button>
              <span class="flex-grow-1"></span>
              <button class="btn btn-sm btn-primary" :disabled="!row.gearTotals.toGo" @click="checkOut(row)">
                <i class="bi bi-box-arrow-right"></i> Check out{{ pickedOf(row).length ? ' ticked' : (row.gearTotals.toGo ? ' ' + row.gearTotals.toGo : '') }}
              </button>
              <button class="btn btn-sm btn-outline-secondary" :disabled="!row.gearTotals.out || returning === row.event.id" @click="returnGear(row)">
                <span v-if="returning === row.event.id" class="spinner-border spinner-border-sm"></span>
                <i v-else class="bi bi-box-arrow-in-left"></i> Return{{ pickedOf(row).length ? ' ticked' : (row.gearTotals.out ? ' ' + row.gearTotals.out : '') }}
              </button>
            </div>

            <div v-if="search.eventId === row.event.id" class="px-2 pb-2 position-relative">
              <div class="input-group input-group-sm">
                <span class="input-group-text"><i class="bi bi-search"></i></span>
                <input class="form-control" v-model="search.q" placeholder="Name, ID or unit (e.g. 161.2)" autocomplete="off"
                       @keydown.enter.prevent="suggestions[0] && addGear(row, suggestions[0])">
                <input class="form-control" style="max-width: 4.5rem" type="number" min="1" v-model.number="search.qty" aria-label="Quantity">
                <button class="btn btn-outline-secondary" @click="search.eventId = null" aria-label="Close search"><i class="bi bi-x-lg"></i></button>
              </div>
              <div v-if="suggestions.length" class="trax-list mt-1">
                <button v-for="hit in suggestions" :key="hit.asset.id + '-' + hit.unitNo" type="button"
                        class="trax-row w-100 text-start border-0 bg-transparent" @click="addGear(row, hit)">
                  <span class="flex-grow-1">{{ hit.asset.name }}
                    <span class="text-secondary small">#{{ hit.asset.id }}<span v-if="hit.unitNo">.{{ hit.unitNo }}</span>
                      <span v-if="hit.asset.kind === 'SET'"> · kit</span> · {{ hit.asset.availableQty ?? hit.asset.quantity }} free now</span></span>
                  <i class="bi bi-plus-circle text-primary"></i>
                </button>
              </div>
            </div>

            <div v-if="!row.gear.length" class="trax-row text-secondary small">Nothing planned yet — add, scan, or pick in the inventory and choose “Only add to the event's gear list”.</div>
            <div v-for="g in row.gear" :key="g.assetId" class="trax-row">
              <input class="form-check-input flex-shrink-0" type="checkbox" :checked="pickedOf(row).includes(g.assetId)"
                     @change="togglePick(row, g.assetId)" :aria-label="'Tick ' + g.name">
              <div class="trax-row-main">
                <div class="trax-row-title">
                  <button class="trax-name-btn text-truncate mw-100" @click="emit('open', g.assetId)">{{ g.name }}</button>
                </div>
                <div class="trax-row-meta">
                  <span v-if="g.toGo" class="trax-badge status-RSVD">{{ g.toGo }} planned</span>
                  <span v-if="g.out" class="trax-badge" :class="g.overdue ? 'status-UNAV' : 'status-LOCK'">{{ g.out }} out<span v-if="g.dueAt"> · due {{ shortDate(g.dueAt) }}</span></span>
                  <span v-if="g.back" class="trax-badge status-FREE">{{ g.back }} back</span>
                  <span v-if="g.unitsOut.length || g.unitsToGo.length" class="trax-kind-chip font-monospace">
                    {{ [...g.unitsOut, ...g.unitsToGo].map(no => g.assetId + '.' + no).join(', ') }}
                  </span>
                  <span v-if="g.reserved && !g.planned" class="small">reserved</span>
                  <span v-if="g.extra" class="small text-secondary">not on the list</span>
                  <span v-for="l in g.late" :key="l.id" class="small text-warning-emphasis">
                    <i class="bi bi-plus-circle"></i> {{ l.qty }} added later · {{ shortDate(l.addedAt) }}<span v-if="l.addedBy"> · {{ l.addedBy }}</span>
                  </span>
                </div>
              </div>
              <button v-if="g.planned && !g.out && !g.back" class="trax-icon-btn" :aria-label="'Remove ' + g.name + ' from the list'"
                      title="Remove from the list" @click="removeGear(row, g)"><i class="bi bi-trash"></i></button>
            </div>
          </div>
        </div>
      </article>
    </div>
  `,
};
