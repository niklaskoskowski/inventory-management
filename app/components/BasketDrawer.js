import { ref, computed } from 'vue';
import {
  state, assetById, selectedItemIds, selectedItems, selectedExpanded, selectedUnitCount,
  mutate, toast, toggleSelected, clearSelection, getAsset,
  getQuantity, setQuantity,
} from '../store.js';
import { findConflicts } from '../lib/schedule.js';
import { valueOfLines } from '../lib/insights.js';
import { exportBasketPdf } from '../lib/pdf.js';
import { parseDate, toLocalInput, formatTotals } from '../lib/format.js';
import Drawer from './ui/Drawer.js';
import StatusBadge from './ui/StatusBadge.js';

/**
 * The selection tray: check out now, or reserve a window.
 *
 * A kit in the selection is shown as a group whose members are listed and
 * individually removable, so what is actually being handed over is explicit.
 */
export default {
  name: 'BasketDrawer',
  components: { Drawer, StatusBadge },
  emits: ['close', 'open'],
  setup(props, { emit }) {
    const mode = ref('checkout');
    const customerName = ref('');
    const customerEmail = ref('');
    const notes = ref('');
    const dueAt = ref('');
    const startAt = ref('');
    const endAt = ref('');
    const busy = ref(false);
    const blocked = ref([]);
    const force = ref(false);

    /** A configured value, or the hard-coded default if settings are absent. */
    const configured = (value, fallback, max) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 && number <= max ? number : fallback;
    };

    // The loan period and the office hours are settings now. They may still be
    // unset — the drawer can open before the first snapshot lands — so each one
    // falls back to what used to be hard-coded here.
    const defaults = state.settings?.defaults || {};
    const loanDays = configured(defaults.loanDays, 7, 3650);
    const dueHour = configured(defaults.dueHour, 18, 23);
    const startHour = configured(defaults.reservationStartHour, 9, 23);

    const allowPartial = ref(Boolean(defaults.allowPartialDefault));

    const defaultDue = new Date();
    defaultDue.setDate(defaultDue.getDate() + loanDays);
    defaultDue.setHours(dueHour, 0, 0, 0);
    dueAt.value = toLocalInput(defaultDue);

    const defaultStart = new Date();
    defaultStart.setHours(startHour, 0, 0, 0);
    startAt.value = toLocalInput(defaultStart);
    endAt.value = toLocalInput(defaultDue);

    /** Selection grouped into kits and loose items. */
    const groups = computed(() => {
      const out = [];
      const loose = [];
      for (const id of state.selected) {
        const asset = assetById.value.get(id);
        if (!asset) continue;
        if (asset.kind === 'SET') {
          out.push({
            kind: 'set',
            asset,
            members: asset.members
              .map((m) => {
                const member = assetById.value.get(Number(m?.assetId ?? m));
                return member ? { ...member, reqQty: Math.max(1, Number(m?.qty ?? 1)) } : null;
              })
              .filter(Boolean),
          });
        } else {
          loose.push(asset);
        }
      }
      if (loose.length) out.push({ kind: 'loose', members: loose });
      return out;
    });

    /**
     * What the selection is worth. Internal only — it is never sent anywhere.
     *
     * selectedExpanded has already resolved kits into their members, so the
     * kit's own price cannot be counted on top of the gear inside it.
     */
    const selectionValue = computed(() =>
      valueOfLines(selectedExpanded.value, assetById.value),
    );

    /** Selected items with fewer free units than the selection asks for. */
    const unavailable = computed(() =>
      selectedExpanded.value
        .map((row) => ({ asset: assetById.value.get(row.id), qty: row.qty }))
        .filter((row) => row.asset && (Number(row.asset.availableQty) || 0) < row.qty),
    );

    /** Live conflict preview for the reservation window. */
    const windowConflicts = computed(() => {
      if (mode.value !== 'reserve') return [];
      const from = parseDate(startAt.value);
      const to = parseDate(endAt.value);
      if (!from || !to || from >= to) return [];

      return selectedExpanded.value
        .map((row) => ({
          asset: assetById.value.get(row.id),
          hits: findConflicts(row.id, from, to, state, { wanted: row.qty }),
        }))
        .filter((row) => row.hits.length);
    });

    const submit = async () => {
      if (!customerName.value.trim() || !customerEmail.value.trim()) {
        toast('Customer name and email are required.', 'warning');
        return;
      }

      busy.value = true;
      blocked.value = [];
      try {
        if (mode.value === 'checkout') {
          // selectedItems is [{id, qty}] and never repeats an id — duplicates
          // are summed server-side, which would silently double the request.
          const data = await mutate('checkout.create', {
            items: selectedItems.value,
            customerName: customerName.value,
            customerEmail: customerEmail.value,
            dueAt: dueAt.value,
            notes: notes.value,
            allowPartial: allowPartial.value,
          });
          toast(
            `Checked out ${data.checkedOut} unit(s) on ${data.lines} line(s).`
            + (data.mailed ? ' Confirmation sent.' : ' Confirmation email could not be sent.'),
            data.mailed ? 'success' : 'warning',
          );
        } else {
          const data = await mutate('reservation.create', {
            items: selectedItems.value,
            customerName: customerName.value,
            customerEmail: customerEmail.value,
            startAt: startAt.value,
            endAt: endAt.value,
            notes: notes.value,
            force: force.value,
          });
          toast(`Reservation #${data.reservationId} created.`, 'success');
        }
        clearSelection();
        emit('close');
      } catch (error) {
        if (error.isBlocked) {
          blocked.value = error.details?.blocked || [];
        }
      } finally {
        busy.value = false;
      }
    };

    /**
     * The selection and its sum, as a page. Internal: for the operator to look
     * at, never handed to the customer — the handover sheet is a different
     * document and carries no money at all.
     *
     * selectedExpanded is what the value above is computed from, so the sheet
     * and the line in the tray cannot disagree.
     */
    const exportingPdf = ref(false);
    const selectionPdf = async () => {
      if (exportingPdf.value || !selectedItemIds.value.length) return;
      exportingPdf.value = true;
      try {
        await exportBasketPdf(selectedExpanded.value, assetById.value);
      } catch (error) {
        toast(`Could not build the selection PDF: ${error.message}`, 'danger', 8000);
      } finally {
        exportingPdf.value = false;
      }
    };

    return {
      state, mode, customerName, customerEmail, notes, dueAt, startAt, endAt,
      busy, blocked, allowPartial, force, groups, unavailable, windowConflicts,
      selectionValue, formatTotals, exportingPdf, selectionPdf,
      selectedItemIds, selectedUnitCount, toggleSelected, clearSelection,
      getAsset, getQuantity, setQuantity, submit, emit,
    };
  },
  template: `
    <Drawer title="Selection" icon="bi-cart2" @close="emit('close')">
      <template #header-actions>
        <span class="text-secondary small">
          {{ selectedItemIds.length }} items · {{ selectedUnitCount }} units
        </span>
      </template>

      <ul class="nav nav-pills nav-fill mb-3">
        <li class="nav-item">
          <button class="nav-link" :class="{ active: mode === 'checkout' }" @click="mode = 'checkout'">
            <i class="bi bi-box-arrow-right"></i> Check out now
          </button>
        </li>
        <li class="nav-item">
          <button class="nav-link" :class="{ active: mode === 'reserve' }" @click="mode = 'reserve'">
            <i class="bi bi-calendar-plus"></i> Reserve
          </button>
        </li>
      </ul>

      <!-- What is in the basket -->
      <div v-for="(group, i) in groups" :key="i" class="mb-3">
        <div v-if="group.kind === 'set'" class="d-flex align-items-center gap-2 mb-1">
          <i class="bi bi-box-seam"></i>
          <strong>{{ group.asset.name }}</strong>
          <StatusBadge :status="group.asset.effectiveStatus" :kind="group.asset.kind" />
          <div class="input-group input-group-sm" style="width:7.5rem">
            <button class="btn btn-outline-secondary py-0 px-2"
                    @click="setQuantity(group.asset.id, getQuantity(group.asset.id) - 1)"
                    :aria-label="'One fewer ' + group.asset.name">−</button>
            <input class="form-control text-center px-0" type="number" min="1"
                   :value="getQuantity(group.asset.id)"
                   @input="setQuantity(group.asset.id, $event.target.value)"
                   :aria-label="'Quantity of ' + group.asset.name">
            <button class="btn btn-outline-secondary py-0 px-2"
                    @click="setQuantity(group.asset.id, getQuantity(group.asset.id) + 1)"
                    :aria-label="'One more ' + group.asset.name">+</button>
          </div>
          <span class="flex-grow-1"></span>
          <button class="btn btn-sm btn-outline-danger py-0 px-1"
                  @click="toggleSelected(group.asset.id)"
                  :aria-label="'Remove ' + group.asset.name">
            <i class="bi bi-x"></i>
          </button>
        </div>
        <div v-else class="small text-secondary mb-1">Loose items</div>

        <ul class="list-group list-group-flush">
          <li v-for="member in group.members" :key="member.id"
              class="list-group-item bg-transparent d-flex align-items-center gap-2 py-1"
              :class="{ 'opacity-50': member.availableQty <= 0 }">
            <span v-if="group.kind === 'set'" class="text-secondary"><i class="bi bi-arrow-return-right"></i></span>
            <button class="trax-name-btn flex-grow-1" @click="emit('open', member.id)">{{ member.name }}</button>

            <!-- Kit members carry a fixed required qty; loose items get a stepper. -->
            <span v-if="group.kind === 'set'" class="trax-kind-chip">
              ×{{ member.reqQty * getQuantity(group.asset.id) }}
            </span>
            <div v-else class="input-group input-group-sm" style="width:7.5rem">
              <button class="btn btn-outline-secondary py-0 px-2"
                      @click="setQuantity(member.id, getQuantity(member.id) - 1)"
                      :aria-label="'One fewer ' + member.name">−</button>
              <input class="form-control text-center px-0" type="number" min="1"
                     :max="member.availableQty || 1"
                     :value="getQuantity(member.id)"
                     @input="setQuantity(member.id, $event.target.value)"
                     :aria-label="'Quantity of ' + member.name">
              <button class="btn btn-outline-secondary py-0 px-2"
                      @click="setQuantity(member.id, getQuantity(member.id) + 1)"
                      :aria-label="'One more ' + member.name">+</button>
            </div>

            <StatusBadge :status="member.effectiveStatus" :kind="member.kind"
                         :detail="member.quantity > 1 ? (member.availableQty + ' of ' + member.quantity + ' free') : ''" />
            <button v-if="group.kind === 'loose'" class="btn btn-sm btn-outline-danger py-0 px-1"
                    @click="toggleSelected(member.id)" :aria-label="'Remove ' + member.name">
              <i class="bi bi-x"></i>
            </button>
          </li>
        </ul>
      </div>

      <!-- What is in the tray is worth this much. Internal figure: it is not
           part of any payload, email or PDF. -->
      <div v-if="selectedItemIds.length"
           class="d-flex align-items-center gap-2 small border-top border-secondary-subtle pt-2 mb-3">
        <span class="text-secondary flex-grow-1">Selection value</span>
        <span v-if="selectionValue.unpricedCount" class="trax-kind-chip">
          {{ selectionValue.unpricedCount }} without a price
        </span>
        <strong>{{ formatTotals(selectionValue.totals) }}</strong>
      </div>

      <div v-if="unavailable.length" class="alert alert-warning py-2 px-3 small">
        <i class="bi bi-exclamation-triangle"></i>
        {{ unavailable.length }} selected item(s) have fewer free units than asked for:
        <ul class="mb-0 mt-1 ps-3">
          <li v-for="row in unavailable" :key="row.asset.id">
            {{ row.asset.name }} — {{ row.qty }} wanted, {{ row.asset.availableQty }} free
          </li>
        </ul>
      </div>

      <hr>

      <!-- Customer -->
      <div class="row g-2">
        <div class="col-12 col-md-6">
          <label class="form-label small" for="b-name">Customer name</label>
          <input id="b-name" class="form-control form-control-sm" v-model="customerName" data-autofocus>
        </div>
        <div class="col-12 col-md-6">
          <label class="form-label small" for="b-email">Customer email</label>
          <input id="b-email" type="email" class="form-control form-control-sm" v-model="customerEmail">
        </div>

        <template v-if="mode === 'checkout'">
          <div class="col-12">
            <label class="form-label small" for="b-due">Return by</label>
            <input id="b-due" type="datetime-local" class="form-control form-control-sm" v-model="dueAt">
          </div>
        </template>

        <template v-else>
          <div class="col-6">
            <label class="form-label small" for="b-start">From</label>
            <input id="b-start" type="datetime-local" class="form-control form-control-sm" v-model="startAt">
          </div>
          <div class="col-6">
            <label class="form-label small" for="b-end">Until</label>
            <input id="b-end" type="datetime-local" class="form-control form-control-sm" v-model="endAt">
          </div>
        </template>

        <div class="col-12">
          <label class="form-label small" for="b-notes">Notes</label>
          <textarea id="b-notes" class="form-control form-control-sm" rows="2" v-model="notes"></textarea>
        </div>
      </div>

      <!-- Conflict preview while choosing a window -->
      <div v-if="windowConflicts.length" class="alert alert-warning mt-3 py-2 px-3 small">
        <strong>{{ windowConflicts.length }} item(s) are already booked in that window:</strong>
        <ul class="mb-2 mt-1 ps-3">
          <li v-for="row in windowConflicts" :key="row.asset.id">
            {{ row.asset.name }} —
            <span v-for="(hit, j) in row.hits" :key="j">
              {{ hit.kind }} ×{{ hit.qty }} with {{ hit.who }}{{ j < row.hits.length - 1 ? ', ' : '' }}
            </span>
          </li>
        </ul>
        <div class="form-check">
          <input class="form-check-input" type="checkbox" id="force-res" v-model="force">
          <label class="form-check-label" for="force-res">Reserve anyway</label>
        </div>
      </div>

      <!-- Server refusal -->
      <div v-if="blocked.length" class="alert alert-danger mt-3 py-2 px-3 small">
        <strong>{{ blocked.length }} item(s) are not available:</strong>
        <ul class="mb-2 mt-1 ps-3">
          <!-- who/until are empty strings when the shortfall is plain capacity
               rather than a named holder, so they must not be printed blind. -->
          <li v-for="b in blocked" :key="b.assetId">
            {{ b.name }}
            <span v-if="b.viaSet" class="text-secondary">(in {{ b.viaSet }})</span>
            — {{ b.wanted }} wanted, {{ b.available }} free
            <span v-if="b.who">· with {{ b.who }}<span v-if="b.until"> until {{ b.until }}</span></span>
          </li>
        </ul>
        <div class="form-check" v-if="mode === 'checkout'">
          <input class="form-check-input" type="checkbox" id="allow-partial" v-model="allowPartial">
          <label class="form-check-label" for="allow-partial">Hand over the rest anyway</label>
        </div>
      </div>

      <template #footer>
        <button class="btn btn-sm btn-outline-secondary" @click="clearSelection(); emit('close')">
          Clear selection
        </button>
        <!-- What the tray is worth, as a page. Internal figure, same helper as
             the line above; disabled while the thumbnails are being fetched. -->
        <button class="btn btn-sm btn-outline-secondary"
                :disabled="exportingPdf || !selectedItemIds.length"
                @click="selectionPdf"
                aria-label="PDF of the current selection and its value">
          <span v-if="exportingPdf" class="spinner-border spinner-border-sm me-1"></span>
          <i v-else class="bi bi-filetype-pdf"></i>
          Value PDF
        </button>
        <span class="flex-grow-1"></span>
        <button class="btn btn-sm btn-outline-secondary" @click="emit('close')">Cancel</button>
        <button class="btn btn-sm btn-primary" :disabled="busy || !selectedItemIds.length" @click="submit">
          <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
          {{ mode === 'checkout'
              ? (allowPartial ? 'Check out available' : 'Check out')
              : (force ? 'Reserve anyway' : 'Reserve') }}
        </button>
      </template>
    </Drawer>
  `,
};
