import { ref, computed, onMounted } from 'vue';
import { state, openInvoice, invoiceSync, invoiceUnlink, toast } from '../store.js';
import { formatMoney, formatDate } from '../lib/format.js';
import { HIRE_LABEL, isUncharged } from '../lib/rental.js';
import { buildInvoiceLines, bookingPeriod, INVOICE_STATUS } from '../lib/invoice-lines.js';
import Menu from './ui/Menu.js';

/**
 * Invoicing — every booking with what it would bill and whether it has an
 * invoice in the Invoice app yet. Only reachable while Settings → Invoicing
 * is switched on.
 *
 * Bookings outlive their checkout lines, so a rental that came back long ago
 * is still listed here and can be invoiced after the return.
 */
const FILTERS = [
  { id: 'todo', label: 'To invoice' },
  { id: 'done', label: 'Invoiced' },
  { id: 'all', label: 'All' },
];

const BOOKING_STATE = {
  OPEN: { label: 'Out', cls: 'status-UNAV' },
  RETURNED: { label: 'Returned', cls: 'status-FREE' },
  RESERVED: { label: 'Reserved', cls: 'status-RSVD' },
  CANCELLED: { label: 'Cancelled', cls: 'status-LOCK' },
};

export default {
  name: 'BillingView',
  components: { Menu },
  setup() {
    const filter = ref('todo');
    const q = ref('');
    const syncing = ref(false);

    const stateOf = (b) => (b.status === 'OPEN' && b.kind === 'reservation' ? 'RESERVED' : b.status);

    const rows = computed(() => state.bookings
      .filter((b) => b.status !== 'CANCELLED')
      .map((b) => {
        const proposal = buildInvoiceLines(b, state.assets, state.settings);
        const period = bookingPeriod(b);
        return {
          booking: b,
          state: stateOf(b),
          from: period.from,
          to: period.to,
          days: proposal.days,
          net: proposal.total,
          currency: proposal.currency,
          unpriced: proposal.unpriced,
          units: (b.items || []).reduce((sum, item) => sum + (Number(item.qty) || 1), 0),
          uncharged: isUncharged(b.hire),
        };
      })
      .filter((r) => {
        if (filter.value === 'todo') return !r.booking.invoice && !r.uncharged;
        if (filter.value === 'done') return Boolean(r.booking.invoice);
        return true;
      })
      .filter((r) => {
        const needle = q.value.trim().toLowerCase();
        if (!needle) return true;
        const b = r.booking;
        return [b.customerName, b.customerEmail, `#${b.id}`, b.invoice?.number || ''].some((v) => String(v || '').toLowerCase().includes(needle));
      })
      .sort((a, b) => String(b.from || '').localeCompare(String(a.from || '')) || b.booking.id - a.booking.id));

    const counts = computed(() => {
      const live = state.bookings.filter((b) => b.status !== 'CANCELLED');
      return {
        todo: live.filter((b) => !b.invoice && !isUncharged(b.hire)).length,
        done: live.filter((b) => b.invoice).length,
        all: live.length,
      };
    });

    const sync = async (quiet = false) => {
      syncing.value = true;
      const changed = await invoiceSync([]);
      syncing.value = false;
      if (quiet) return;
      if (changed === null) toast('Could not reach Invoice.', 'warning');
      else toast(changed ? `${changed} invoice${changed === 1 ? '' : 's'} updated.` : 'Up to date.', 'success');
    };

    const open = (url) => { if (url) window.open(url, '_blank', 'noopener'); };

    const unlink = async (b) => {
      try {
        await invoiceUnlink(b.id);
        toast('Link removed. The document in Invoice is unchanged.', 'success');
      } catch { /* toast raised by the store */ }
    };

    // Number/status move in Invoice (finalised, paid, deleted) — refresh once.
    onMounted(() => { if (state.bookings.some((b) => b.invoice)) sync(true); });

    return {
      FILTERS, BOOKING_STATE, INVOICE_STATUS, HIRE_LABEL, filter, q, rows, counts, syncing, sync,
      openInvoice, open, unlink, formatMoney, formatDate,
    };
  },
  template: `
    <div class="d-flex flex-wrap gap-2 align-items-center mb-3">
      <div class="btn-group btn-group-sm" role="group" aria-label="Filter bookings">
        <button v-for="f in FILTERS" :key="f.id" type="button"
                class="btn" :class="filter === f.id ? 'btn-secondary' : 'btn-outline-secondary'"
                :aria-pressed="filter === f.id ? 'true' : 'false'" @click="filter = f.id">
          {{ f.label }} <span class="opacity-75">{{ counts[f.id] }}</span>
        </button>
      </div>
      <input class="form-control form-control-sm" style="max-width: 16rem" v-model="q" placeholder="Search customer, booking, invoice no.">
      <span class="flex-grow-1"></span>
      <button class="btn btn-sm btn-outline-secondary" :disabled="syncing" @click="sync(false)" title="Fetch numbers and status from Invoice">
        <span v-if="syncing" class="spinner-border spinner-border-sm"></span>
        <i v-else class="bi bi-arrow-repeat"></i> Refresh status
      </button>
    </div>

    <div v-if="!rows.length" class="trax-empty">
      <i class="bi bi-receipt"></i>
      {{ filter === 'todo' ? 'Nothing left to invoice.' : 'No bookings here.' }}
    </div>

    <div v-else class="trax-list">
      <article v-for="r in rows" :key="r.booking.id" class="trax-row align-items-start">
        <div class="trax-row-main">
          <div class="d-flex align-items-start gap-2">
            <div class="trax-row-title flex-grow-1 min-w-0 pt-1">
              <span :title="r.booking.customerEmail">{{ r.booking.customerName || 'Booking #' + r.booking.id }}</span>
            </div>
            <div class="d-flex align-items-center gap-1 flex-shrink-0">
              <template v-if="r.booking.invoice">
                <button class="btn btn-sm btn-outline-primary" @click="open(r.booking.invoice.url)" :disabled="!r.booking.invoice.url">
                  <i class="bi bi-box-arrow-up-right"></i> {{ r.booking.invoice.number || 'Draft' }}
                </button>
                <Menu :label="'More for booking #' + r.booking.id">
                  <button class="trax-menu-item" @click="openInvoice(r.booking.id)">
                    <i class="bi bi-receipt"></i> Invoice again…
                  </button>
                  <div class="trax-menu-sep"></div>
                  <button class="trax-menu-item is-danger" @click="unlink(r.booking)">
                    <i class="bi bi-link-45deg"></i> Remove link
                  </button>
                </Menu>
              </template>
              <button v-else class="btn btn-sm btn-primary" @click="openInvoice(r.booking.id)">
                <i class="bi bi-receipt"></i> Create invoice
              </button>
            </div>
          </div>
          <div class="trax-row-meta d-flex flex-wrap gap-2 align-items-center">
            <span class="trax-badge" :class="BOOKING_STATE[r.state]?.cls">{{ BOOKING_STATE[r.state]?.label || r.state }}</span>
            <span v-if="r.booking.invoice" class="badge" :class="INVOICE_STATUS[r.booking.invoice.status]?.cls">
              {{ INVOICE_STATUS[r.booking.invoice.status]?.label || r.booking.invoice.status }}
            </span>
            <span>#{{ r.booking.id }}</span>
            <span>{{ formatDate(r.from) }}<template v-if="r.to && formatDate(r.to) !== formatDate(r.from)"> – {{ formatDate(r.to) }}</template> · {{ r.days }}d</span>
            <span>{{ r.units }} unit{{ r.units === 1 ? '' : 's' }}</span>
            <span>{{ HIRE_LABEL[r.booking.hire] || r.booking.hire }}</span>
            <strong v-if="r.booking.invoice && r.booking.invoice.gross !== null" class="ms-auto">{{ formatMoney(r.booking.invoice.gross, r.booking.invoice.currency) }} gross</strong>
            <strong v-else class="ms-auto">{{ formatMoney(r.net, r.currency) }} net</strong>
            <span v-if="!r.booking.invoice && r.unpriced" class="text-warning-emphasis small">
              <i class="bi bi-exclamation-triangle"></i> {{ r.unpriced }} without price
            </span>
          </div>
        </div>
      </article>
    </div>
  `,
};
