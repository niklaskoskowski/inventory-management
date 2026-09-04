import { ref, computed } from 'vue';
import { state, mutate, toast, getAsset } from '../store.js';
import { formatDateTime, parseDate, toLocalInput, formatTotals } from '../lib/format.js';
import { valueOfLines } from '../lib/insights.js';
import { exportBookingPdf } from '../lib/pdf.js';
import ConfirmDialog from './ui/ConfirmDialog.js';

const STATUS_CLASS = {
  ACTIVE: 'status-RSVD',
  CONVERTED: 'status-UNAV',
  COMPLETED: 'status-FREE',
  CANCELLED: 'status-LOCK',
};

export default {
  name: 'ReservationsView',
  components: { ConfirmDialog },
  emits: ['open'],
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
        toast('Reservation cancelled.', 'success');
      } catch { /* toast already raised */ }
    };

    /**
     * `12.1, 12.3` for a blocked entry that named the units it could not give.
     *
     * A reservation never asks for a unit — the server assigns them when it is
     * converted — but the conversion is a checkout, so its refusal can still
     * name the ones it wanted.
     */
    const blockedUnitCodes = (b) => (b.unitNos || []).map((no) => `${b.assetId}.${no}`).join(', ');

    return {
      state, rows, filter, nameOf, STATUS_CLASS, blockedUnitCodes,
      converting, cancelling, convertDue, allowPartial, blocked,
      startConvert, doConvert, doCancel, formatDateTime, formatTotals, emit,
      exporting, bookingPdf,
    };
  },
  template: `
    <div class="btn-group btn-group-sm mb-3" role="group" aria-label="Filter reservations">
      <button v-for="s in ['ACTIVE', 'CONVERTED', 'COMPLETED', 'CANCELLED', '']" :key="s || 'all'"
              class="btn" :class="filter === s ? 'btn-secondary' : 'btn-outline-secondary'"
              @click="filter = s">
        {{ s || 'All' }}
      </button>
    </div>

    <div v-if="!rows.length" class="trax-empty">
      <i class="bi bi-calendar-x"></i>
      No reservations here.
    </div>

    <div v-else class="d-flex flex-column gap-2">
      <article v-for="r in rows" :key="r.id" class="trax-card trax-card-pad">
        <div class="d-flex align-items-start gap-2 flex-wrap">
          <div class="flex-grow-1 min-w-0">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <strong>{{ r.customerName }}</strong>
              <span class="trax-badge" :class="STATUS_CLASS[r.status]">{{ r.status }}</span>
              <span class="text-secondary small">{{ r.customerEmail }}</span>
            </div>
            <div class="small text-secondary mt-1">
              {{ formatDateTime(r.startAt) }} → {{ formatDateTime(r.endAt) }}
              <span v-if="r.notes"> · {{ r.notes }}</span>
            </div>
            <!-- Internal figure: what this reservation holds. -->
            <div class="small text-secondary">
              Value: <strong>{{ formatTotals(r.value.totals) }}</strong>
              <span v-if="r.value.unpricedCount">
                · {{ r.value.unpricedCount }} item(s) without a price
              </span>
            </div>
            <!-- items carries the quantities; assetIds is its id mirror. -->
            <div class="mt-2 d-flex flex-wrap gap-1">
              <span v-for="setId in r.setIds" :key="'s' + setId" class="trax-kind-chip">
                <i class="bi bi-box-seam"></i> {{ nameOf(setId) }}
              </span>
              <button v-for="item in (r.items || r.assetIds.map(id => ({ assetId: id, qty: 1 })))"
                      :key="'i' + item.assetId"
                      class="btn btn-sm btn-outline-secondary py-0 px-1"
                      style="font-size:.7rem" @click="emit('open', item.assetId)">
                {{ nameOf(item.assetId) }}<span v-if="item.qty > 1"> ×{{ item.qty }}</span>
              </button>
            </div>
          </div>

          <div class="d-flex gap-1">
            <!-- Outside the ACTIVE guard: a converted booking still needs its sheet. -->
            <button class="btn btn-sm btn-outline-secondary" :disabled="exporting"
                    @click="bookingPdf(r)"
                    :aria-label="'Booking PDF for ' + r.customerName">
              <i class="bi bi-filetype-pdf"></i> PDF
            </button>
            <template v-if="r.status === 'ACTIVE'">
              <button class="btn btn-sm btn-primary" @click="startConvert(r)">
                <i class="bi bi-box-arrow-right"></i> Check out
              </button>
              <button class="btn btn-sm btn-outline-danger" @click="cancelling = r">
                Cancel
              </button>
            </template>
          </div>
        </div>
      </article>
    </div>

    <ConfirmDialog v-if="converting"
                   title="Convert to checkout"
                   :confirm-label="allowPartial ? 'Check out available' : 'Check out'"
                   @confirm="doConvert" @cancel="converting = null">
      <p class="small text-secondary mt-2 mb-2">
        {{ converting.assetIds.length }} item(s),
        {{ (converting.items || []).reduce((s, i) => s + i.qty, 0) || converting.assetIds.length }} unit(s)
        for {{ converting.customerName }}.
      </p>

      <label class="form-label small" for="convert-due">Return date</label>
      <input id="convert-due" type="datetime-local" class="form-control form-control-sm"
             v-model="convertDue" data-autofocus>

      <div v-if="blocked.length" class="alert alert-warning mt-3 py-2 px-3 small mb-0">
        <strong>{{ blocked.length }} item(s) already out:</strong>
        <ul class="mb-2 mt-1 ps-3">
          <!-- who/until are empty when the shortfall is capacity, not a holder. -->
          <li v-for="b in blocked" :key="b.assetId">
            {{ b.name }} — {{ b.wanted }} wanted, {{ b.available }} free
            <span v-if="b.who">· with {{ b.who }}<span v-if="b.until"> until {{ b.until }}</span></span>
            <span v-if="b.unitNos?.length" class="text-secondary"> · units {{ blockedUnitCodes(b) }}</span>
          </li>
        </ul>
        <div class="form-check">
          <input class="form-check-input" type="checkbox" id="allow-partial-res" v-model="allowPartial">
          <label class="form-check-label" for="allow-partial-res">
            Check out the rest anyway
          </label>
        </div>
      </div>
    </ConfirmDialog>

    <ConfirmDialog v-if="cancelling"
                   title="Cancel this reservation?"
                   message="Reserved items are released unless they are physically out."
                   confirm-label="Cancel reservation" danger
                   @confirm="doCancel" @cancel="cancelling = null" />
  `,
};
