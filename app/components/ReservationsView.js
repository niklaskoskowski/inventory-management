import { ref, computed } from 'vue';
import {
  state, mutate, toast, getAsset, eventById, startReservationEdit,
} from '../store.js';
import {
  formatDateTime, parseDate, toLocalInput, formatTotals, getUiLocale,
} from '../lib/format.js';
import { valueOfLines } from '../lib/insights.js';
import { HIRE_LABEL, hireOf } from '../lib/rental.js';
import { exportBookingPdf } from '../lib/pdf.js';
import ConfirmDialog from './ui/ConfirmDialog.js';
import Menu from './ui/Menu.js';

const STATUS_CLASS = {
  ACTIVE: 'status-RSVD',
  CONVERTED: 'status-UNAV',
  COMPLETED: 'status-FREE',
  CANCELLED: 'status-LOCK',
};

const STATUS_LABEL = {
  ACTIVE: 'Active',
  CONVERTED: 'Converted',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** The filter segments; '' is every status. */
const FILTERS = [
  { id: 'ACTIVE', label: 'Active' },
  { id: 'CONVERTED', label: 'Converted' },
  { id: 'COMPLETED', label: 'Completed' },
  { id: 'CANCELLED', label: 'Cancelled' },
  { id: '', label: 'All' },
];

export default {
  name: 'ReservationsView',
  components: { ConfirmDialog, Menu },
  emits: ['open', 'basket'],
  setup(props, { emit }) {
    const filter = ref('ACTIVE');
    const converting = ref(null);
    const cancelling = ref(null);
    const convertDue = ref('');
    const allowPartial = ref(false);
    const blocked = ref([]);
    const exporting = ref(false);

    const rows = computed(() =>
      state.reservations
        .filter((r) => !filter.value || r.status === filter.value)
        .sort((a, b) => (parseDate(b.startAt) || 0) - (parseDate(a.startAt) || 0))
        // What the customer has spoken for is worth. `items` is already
        // expanded to items with quantities server-side, so a kit's own price
        // is never added on top of its members. Internal only — none of this
        // goes on the booking sheet or into an email.
        .map((r) => ({
          ...r,
          value: valueOfLines(
            r.items || (r.assetIds || []).map((id) => ({ assetId: id, qty: 1 })),
            getAsset,
          ),
        })),
    );

    const nameOf = (id) => getAsset(id)?.name || `#${id}`;

    /** Which of the reservation's kits an item arrived in, if any. */
    const kitOf = (reservation, assetId) => {
      for (const setId of reservation.setIds || []) {
        const set = getAsset(setId);
        const holds = (set?.members || []).some(
          (member) => Number(member?.assetId ?? member) === Number(assetId),
        );
        if (holds) return nameOf(setId);
      }
      return '';
    };

    /** The booking sheet — available for every status, not just ACTIVE ones. */
    const bookingPdf = async (reservation) => {
      exporting.value = true;
      try {
        // items carries the quantities; assetIds is its id mirror.
        const items = reservation.items
          || (reservation.assetIds || []).map((id) => ({ assetId: id, qty: 1 }));
        await exportBookingPdf({
          kind: 'reservation',
          customerName: reservation.customerName,
          customerEmail: reservation.customerEmail,
          reference: `Reservation #${reservation.id}`,
          startAt: reservation.startAt,
          endAt: reservation.endAt,
          hire: reservation.hire,
          status: reservation.status,
          notes: reservation.notes || '',
          items: items.map((item) => ({
            name: nameOf(item.assetId),
            assetId: item.assetId,
            qty: item.qty,
            setName: kitOf(reservation, item.assetId),
          })),
        });
      } finally {
        exporting.value = false;
      }
    };

    const startConvert = (reservation) => {
      converting.value = reservation;
      convertDue.value = toLocalInput(reservation.endAt);
      allowPartial.value = false;
      blocked.value = [];
    };

    const doConvert = async () => {
      try {
        const data = await mutate('reservation.convert', {
          id: converting.value.id,
          dueAt: convertDue.value || null,
          allowPartial: allowPartial.value,
        });
        toast(
          `Checked out ${data.checkedOut} unit(s) on ${data.lines} line(s).`
          + (data.mailed ? ' Customer notified.' : ''),
          'success',
        );
        converting.value = null;
      } catch (error) {
        if (error.isBlocked) {
          // Keep the dialog open and show exactly what is in the way.
          blocked.value = error.details?.blocked || [];
          allowPartial.value = false;
        } else {
          converting.value = null;
        }
      }
    };

    const doCancel = async () => {
      const id = cancelling.value.id;
      cancelling.value = null;
      try {
        await mutate('reservation.cancel', { id });
        toast('Reservation cancelled. It can be restored from Cancelled.', 'success');
      } catch { /* toast already raised */ }
    };

    /** Into the Selection with it: changed there like a new one, saved back. */
    const edit = (reservation) => {
      startReservationEdit(reservation);
      emit('basket');
    };

    /** Back to ACTIVE — refused by the server if anything on it is taken meanwhile. */
    const restoring = ref(null);
    const restore = async (reservation) => {
      restoring.value = reservation.id;
      try {
        await mutate('reservation.restore', { id: reservation.id });
        toast(`Reservation #${reservation.id} restored.`, 'success');
      } catch (error) {
        if (error.isBlocked) {
          const taken = (error.details?.blocked || [])
            .map((b) => `${b.name} (${b.wanted} wanted, ${b.available} free)`)
            .join(', ');
          toast(`Cannot restore — booked elsewhere in that window: ${taken}.`, 'warning', 10000);
        }
      } finally {
        restoring.value = null;
      }
    };

    /**
     * `12.1, 12.3` for a blocked entry that named the units it could not give.
     *
     * A reservation never asks for a unit — the server assigns them when it is
     * converted — but the conversion is a checkout, so its refusal can still
     * name the ones it wanted.
     */
    const blockedUnitCodes = (b) => (b.unitNos || []).map((no) => `${b.assetId}.${no}`).join(', ');

    /** "Oct 12, 9:00 AM" — the year only when it is not this one. */
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

    const itemsOf = (r) => r.items || (r.assetIds || []).map((id) => ({ assetId: id, qty: 1 }));
    const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;

    return {
      state, rows, filter, nameOf, STATUS_CLASS, STATUS_LABEL, FILTERS, blockedUnitCodes,
      shortWhen, itemsOf, plural,
      converting, cancelling, convertDue, allowPartial, blocked,
      startConvert, doConvert, doCancel, edit, restore, restoring, formatDateTime, formatTotals, emit,
      exporting, bookingPdf, HIRE_LABEL, hireOf, eventById,
    };
  },
  template: `
    <div class="btn-group btn-group-sm trax-seg-fill mb-3" role="group" aria-label="Filter reservations">
      <button v-for="f in FILTERS" :key="f.id || 'all'" type="button"
              class="btn" :class="filter === f.id ? 'btn-secondary' : 'btn-outline-secondary'"
              :aria-pressed="filter === f.id ? 'true' : 'false'"
              @click="filter = f.id">
        {{ f.label }}
      </button>
    </div>

    <div v-if="!rows.length" class="trax-empty">
      <i class="bi bi-calendar-x"></i>
      No reservations here.
    </div>

    <div v-else class="trax-list">
      <article v-for="r in rows" :key="r.id" class="trax-row align-items-start">
        <div class="trax-row-main">
          <div class="d-flex align-items-start gap-2">
            <div class="trax-row-title flex-grow-1 min-w-0 pt-1">
              <span :title="r.customerEmail">{{ r.customerName }}</span>
            </div>

            <!-- The one thing to do with it, visible; the rest in the menu. -->
            <div class="d-flex align-items-center gap-1 flex-shrink-0">
              <template v-if="r.status === 'ACTIVE'">
                <button class="btn btn-sm btn-primary" @click="startConvert(r)">
                  <i class="bi bi-box-arrow-right"></i> Check out
                </button>
                <Menu :label="'More for ' + r.customerName">
                  <button class="trax-menu-item" @click="edit(r)"
                          :aria-label="'Edit the reservation of ' + r.customerName">
                    <i class="bi bi-pencil"></i> Edit
                  </button>
                  <button class="trax-menu-item" :disabled="exporting" @click="bookingPdf(r)"
                          :aria-label="'Booking PDF for ' + r.customerName">
                    <i class="bi bi-filetype-pdf"></i> Booking PDF
                  </button>
                  <div class="trax-menu-sep"></div>
                  <button class="trax-menu-item is-danger" @click="cancelling = r">
                    <i class="bi bi-x-circle"></i> Cancel reservation
                  </button>
                </Menu>
              </template>
              <template v-else>
                <button v-if="r.status === 'CANCELLED'" class="btn btn-sm btn-outline-secondary"
                        :disabled="restoring === r.id" @click="restore(r)">
                  <span v-if="restoring === r.id" class="spinner-border spinner-border-sm"></span>
                  <i v-else class="bi bi-arrow-counterclockwise"></i> Restore
                </button>
                <!-- Outside the ACTIVE guard: a converted booking still needs its sheet. -->
                <button class="btn btn-sm btn-outline-secondary" :disabled="exporting"
                        @click="bookingPdf(r)" title="Booking PDF"
                        :aria-label="'Booking PDF for ' + r.customerName">
                  <i class="bi bi-filetype-pdf"></i>
                </button>
              </template>
            </div>
          </div>

          <div class="trax-row-meta">
            <span v-if="!filter" class="trax-status-dot" :class="STATUS_CLASS[r.status]">{{ STATUS_LABEL[r.status] || r.status }}</span>
            <span :title="formatDateTime(r.startAt) + ' → ' + formatDateTime(r.endAt)">
              {{ shortWhen(r.startAt) }} → {{ shortWhen(r.endAt) }}
            </span>
          </div>
          <!-- Internal figure: what this reservation holds. -->
          <div class="trax-row-meta">
            <span class="text-truncate">{{ r.customerEmail }}</span>
            <span>
              <strong class="fw-semibold" title="Reserved value">{{ formatTotals(r.value.totals) }}</strong>
              <span v-if="r.value.unpricedCount"
                    :title="r.value.unpricedCount + ' item(s) without a price'"> · {{ r.value.unpricedCount }} unpriced</span>
            </span>
            <!-- Only what is not dry hire says so: dry hire is what almost
                 every reservation is, and a chip on all of them says nothing. -->
            <span v-if="hireOf(r) !== 'DRY'" class="trax-kind-chip">
              <i class="bi" :class="hireOf(r) === 'FREE' ? 'bi-gift' : 'bi-person-gear'"></i>
              {{ HIRE_LABEL[hireOf(r)] }}
            </span>
            <span v-if="eventById.get(Number(r.eventId))" class="trax-kind-chip">
              <i class="bi bi-calendar-event"></i> {{ eventById.get(Number(r.eventId)).name }}
            </span>
          </div>
          <div v-if="r.notes" class="trax-row-notes">{{ r.notes }}</div>

          <!-- items carries the quantities; assetIds is its id mirror. -->
          <div class="trax-row-chips">
            <span v-for="setId in r.setIds" :key="'s' + setId" class="trax-kind-chip">
              <i class="bi bi-box-seam"></i> {{ nameOf(setId) }}
            </span>
            <button v-for="item in itemsOf(r)" :key="'i' + item.assetId" type="button"
                    class="trax-chip-btn" @click="emit('open', item.assetId)">
              {{ nameOf(item.assetId) }}<span v-if="item.qty > 1" class="text-secondary">×{{ item.qty }}</span>
            </button>
          </div>
        </div>
      </article>
    </div>

    <ConfirmDialog v-if="converting"
                   title="Check out"
                   :message="converting.customerName + ' · ' + plural(converting.assetIds.length, 'item') + ', '
                     + plural((converting.items || []).reduce((s, i) => s + i.qty, 0) || converting.assetIds.length, 'unit')"
                   :confirm-label="allowPartial ? 'Check out available' : 'Check out'"
                   @confirm="doConvert" @cancel="converting = null">
      <label class="form-label mt-2" for="convert-due">Return by</label>
      <input id="convert-due" type="datetime-local" class="form-control form-control-sm"
             v-model="convertDue" data-autofocus>

      <div v-if="blocked.length" class="alert alert-warning mt-3 py-2 px-3 small mb-0">
        <i class="bi bi-exclamation-triangle-fill"></i>
        <strong>{{ plural(blocked.length, 'item') }} not available</strong>
        <ul class="mb-2 mt-1 ps-3">
          <!-- who/until are empty when the shortfall is capacity, not a holder. -->
          <li v-for="b in blocked" :key="b.assetId">
            {{ b.name }} — {{ b.available }} of {{ b.wanted }} free
            <span v-if="b.who">· with {{ b.who }}<span v-if="b.until"> until {{ b.until }}</span></span>
            <span v-if="b.unitNos?.length" class="text-secondary"> · units {{ blockedUnitCodes(b) }}</span>
          </li>
        </ul>
        <div class="form-check mb-0">
          <input class="form-check-input" type="checkbox" id="allow-partial-res" v-model="allowPartial">
          <label class="form-check-label" for="allow-partial-res">
            Check out the rest anyway
          </label>
        </div>
      </div>
    </ConfirmDialog>

    <ConfirmDialog v-if="cancelling"
                   title="Cancel reservation?"
                   message="Its items are released (unless already out). No email is sent. You can restore it under Cancelled."
                   confirm-label="Cancel reservation" cancel-label="Keep" danger
                   @confirm="doCancel" @cancel="cancelling = null" />
  `,
};
