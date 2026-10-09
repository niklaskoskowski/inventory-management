import { ref, computed, watch } from 'vue';
import {
  state, assetById, selectedItemIds, selectedItems, selectedExpanded, selectedUnitCount,
  mutate, toast, toggleSelected, clearSelection, getAsset,
  getQuantity, setQuantity, getUnitChoice, toggleUnitChoice, stopReservationEdit,
} from '../store.js';
import { findConflicts } from '../lib/schedule.js';
import { valueOfLines } from '../lib/insights.js';
import {
  rentalDays as hireDays, rentalOfLines, daysLabel, HIRE_LABEL, serviceFactorOf, hireOf,
} from '../lib/rental.js';
import { byStart, eventSettings, isClosed } from '../lib/events.js';
import { exportBasketPdf, exportRentalPdf } from '../lib/pdf.js';
import { parseDate, toLocalInput, formatTotals } from '../lib/format.js';
import Drawer from './ui/Drawer.js';
import Menu from './ui/Menu.js';
import StatusBadge from './ui/StatusBadge.js';

/**
 * The selection tray: check out now, or reserve a window.
 *
 * A kit in the selection is shown as a group whose members are listed and
 * individually removable, so what is actually being handed over is explicit.
 *
 * While a reservation is being edited (state.reservationEdit) the tray is that
 * reservation: reserve mode only, its fields filled in, and saving writes
 * reservation.update instead of making a new one.
 */
export default {
  name: 'BasketDrawer',
  components: { Drawer, Menu, StatusBadge },
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

    // --- What the hire costs --------------------------------------------
    // Priced off the window the drawer is showing: now to the due date when
    // checking out, the reservation window when reserving. Nothing is stored —
    // a hire is always priced by the rates in force when it is worked out.

    const hireLength = computed(() => (mode.value === 'checkout'
      ? hireDays(new Date(), dueAt.value)
      : hireDays(startAt.value, endAt.value)));

    // Dry hire or a serviced job. Stored on what this drawer creates — the
    // lines, the booking, the reservation — because it is a fact about the
    // job, not a price: the price is worked out from it every time.
    const hire = ref('DRY');

    // Which job this is going out on, or none. Optional by design: plenty of
    // gear leaves the building without belonging to a project.
    const eventId = ref('');

    const eventsEnabled = computed(() => eventSettings(state.settings).enabled);

    // --- Editing a reservation ------------------------------------------

    const editing = computed(() => state.reservationEdit);
    const editedReservation = computed(() => (editing.value
      ? state.reservations.find((r) => Number(r.id) === Number(editing.value.id)) || null
      : null));
    /** Converted, cancelled or deleted elsewhere since the edit began. */
    const editGone = computed(() => Boolean(editing.value)
      && editedReservation.value?.status !== 'ACTIVE');

    const formFields = { customerName, customerEmail, notes, startAt, endAt, hire, eventId, force };
    if (editing.value) {
      mode.value = 'reserve';
      const r = editedReservation.value;
      const saved = editing.value.form || (r ? {
        customerName: r.customerName || '',
        customerEmail: r.customerEmail || '',
        notes: r.notes || '',
        startAt: toLocalInput(r.startAt),
        endAt: toLocalInput(r.endAt),
        hire: hireOf(r),
        eventId: r.eventId ? String(r.eventId) : '',
        force: false,
      } : {});
      for (const [key, field] of Object.entries(formFields)) {
        if (key in saved) field.value = saved[key];
      }
    }
    // The tray closes while items are added from the inventory; what was
    // typed meanwhile is kept with the edit, not in this component.
    watch(Object.values(formFields), () => {
      if (!editing.value) return;
      editing.value.form = Object.fromEntries(
        Object.entries(formFields).map(([key, field]) => [key, field.value]),
      );
    });

    const discardEdit = () => {
      stopReservationEdit();
      emit('close');
    };

    /**
     * The jobs worth picking: the open ones, soonest first.
     *
     * A closed job is not offered — gear going out on something that is over
     * is a typo, not a workflow — but one already picked stays listed so the
     * form never silently drops what it is showing.
     */
    const eventOptions = computed(() => [...state.events]
      .filter((event) => !isClosed(state.settings, event) || String(event.id) === eventId.value)
      .sort(byStart));

    const rentalQuote = computed(() => rentalOfLines(
      selectedExpanded.value,
      assetById.value,
      state.settings,
      hireLength.value,
      { unitChoice: state.unitChoice, hire: hire.value },
    ));

    /** The same selection as dry hire, for the line that says what it saves. */
    const dryQuote = computed(() => rentalOfLines(
      selectedExpanded.value,
      assetById.value,
      state.settings,
      hireLength.value,
      { unitChoice: state.unitChoice, hire: 'DRY' },
    ));

    /**
     * The factors actually in play, so the hint can say "70 % of dry hire"
     * instead of naming a number that only applies to half the basket.
     */
    const serviceFactors = computed(() => {
      const seen = new Set();
      for (const row of selectedExpanded.value) {
        const asset = assetById.value.get(Number(row.id));
        if (asset) seen.add(serviceFactorOf(state.settings, asset.category));
      }
      return [...seen].sort((a, b) => a - b);
    });

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
          // An edited reservation does not collide with itself.
          hits: findConflicts(row.id, from, to, state, {
            wanted: row.qty, reservationId: editing.value?.id,
          }),
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
            hire: hire.value,
            eventId: eventId.value ? Number(eventId.value) : null,
          });
          toast(
            `Checked out ${data.checkedOut} unit(s) on ${data.lines} line(s).`
            + (data.mailed ? ' Confirmation sent.' : ' Confirmation email could not be sent.'),
            data.mailed ? 'success' : 'warning',
          );
        } else if (editing.value) {
          const id = editing.value.id;
          await mutate('reservation.update', {
            id,
            items: selectedItems.value,
            customerName: customerName.value,
            customerEmail: customerEmail.value,
            startAt: startAt.value,
            endAt: endAt.value,
            notes: notes.value,
            force: force.value,
            hire: hire.value,
            eventId: eventId.value ? Number(eventId.value) : null,
          });
          toast(`Reservation #${id} saved.`, 'success');
          stopReservationEdit();
          emit('close');
          return;
        } else {
          const data = await mutate('reservation.create', {
            items: selectedItems.value,
            customerName: customerName.value,
            customerEmail: customerEmail.value,
            startAt: startAt.value,
            endAt: endAt.value,
            notes: notes.value,
            force: force.value,
            hire: hire.value,
            eventId: eventId.value ? Number(eventId.value) : null,
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

    // --- Unit picker ---------------------------------------------------
    // An item that tracks its units lets the operator name which ones leave.
    // Only in checkout mode: a reservation is product-level, the server picks
    // the units when it is converted. Kit members are not offered either —
    // the kit is what was booked, its contents are the server's business.

    const unitsOf = (member) => (Array.isArray(member?.units) ? member.units : []);

    const showUnits = (group, member) =>
      mode.value === 'checkout' && group.kind === 'loose' && unitsOf(member).length > 0;

    const unitCode = (member, unit) => `${member.id}.${unit.no}`;

    const unitChosen = (member, unit) => getUnitChoice(member.id).includes(unit.no);

    /**
     * The ceiling is availableQty, NOT availableUnitNos.length: a checkout line
     * written before units existed holds quantity without naming any, so more
     * units can read as free than the asset actually has left.
     */
    const unitLimitReached = (member) =>
      getUnitChoice(member.id).length >= Math.max(0, Number(member.availableQty) || 0);

    const unitDisabled = (member, unit) =>
      unit.state !== 'FREE' || (!unitChosen(member, unit) && unitLimitReached(member));

    const unitTitle = (member, unit) => {
      if (unit.state === 'OOS') return 'out of service';
      if (unit.state === 'OUT') return `out — ${unit.customerName || 'someone'}`;
      if (unitDisabled(member, unit)) return 'quantity limit reached — raise the quantity first';
      const parts = [unit.serial, unit.note].filter(Boolean);
      return parts.length ? parts.join(' · ') : 'free';
    };

    const unitHint = (member) => {
      const chosen = getUnitChoice(member.id).length;
      if (!chosen) return 'All units assigned automatically';
      return `${chosen} of ${getQuantity(member.id)} chosen · the rest are assigned automatically`;
    };

    /** `12.1, 12.3` for a blocked entry that named the units it could not give. */
    const blockedUnitCodes = (b) => (b.unitNos || []).map((no) => `${b.assetId}.${no}`).join(', ');

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

    /**
     * The same selection as a quote: what it costs to hire for the window
     * above, with the rates but without a single purchase value on it. The one
     * of the two documents a customer may see.
     */
    const exportingQuote = ref(false);
    const rentalPdf = async () => {
      if (exportingQuote.value || !selectedItemIds.value.length) return;
      exportingQuote.value = true;
      try {
        await exportRentalPdf(selectedExpanded.value, assetById.value, {
          days: hireLength.value,
          kind: mode.value === 'checkout' ? 'checkout' : 'reservation',
          from: mode.value === 'checkout' ? new Date() : startAt.value,
          to: mode.value === 'checkout' ? dueAt.value : endAt.value,
          customerName: customerName.value,
          customerEmail: customerEmail.value,
          notes: notes.value,
          unitChoice: state.unitChoice,
          hire: hire.value,
          // The job is what a quote is headed with, when there is one.
          reference: eventOptions.value.find((event) => String(event.id) === eventId.value)?.name || '',
        });
      } catch (error) {
        toast(`Could not build the rental PDF: ${error.message}`, 'danger', 8000);
      } finally {
        exportingQuote.value = false;
      }
    };

    return {
      state, mode, customerName, customerEmail, notes, dueAt, startAt, endAt,
      busy, blocked, allowPartial, force, groups, unavailable, windowConflicts,
      selectionValue, formatTotals, exportingPdf, selectionPdf,
      hireLength, rentalQuote, daysLabel, exportingQuote, rentalPdf,
      hire, dryQuote, serviceFactors, HIRE_LABEL, editing, editGone, discardEdit,
      eventId, eventsEnabled, eventOptions,
      selectedItemIds, selectedUnitCount, toggleSelected, clearSelection,
      getAsset, getQuantity, setQuantity, submit, emit,
      unitsOf, showUnits, unitCode, unitChosen, unitDisabled, unitTitle, unitHint,
      toggleUnitChoice, blockedUnitCodes,
    };
  },
  template: `
    <Drawer :title="editing ? 'Reservation #' + editing.id : 'Selection'"
            :icon="editing ? 'bi-pencil-square' : 'bi-bag'" @close="emit('close')">
      <template #header-actions>
        <span class="text-secondary small text-nowrap">
          {{ selectedUnitCount }} {{ selectedUnitCount === 1 ? 'unit' : 'units' }}
        </span>
      </template>

      <!-- Editing: the tray IS the reservation. Items are added from the
           inventory as for a new one, and the tray can be closed meanwhile. -->
      <div v-if="editing" class="alert py-2 px-3 small mb-3"
           :class="editGone ? 'alert-danger' : 'alert-info'">
        <template v-if="editGone">
          <i class="bi bi-exclamation-triangle-fill"></i>
          #{{ editing.id }} is no longer active. Discard to restore your selection.
        </template>
        <template v-else>
          <i class="bi bi-pencil-square"></i>
          Editing — close to add items from Inventory.
        </template>
      </div>

      <div v-else class="btn-group w-100 mb-3" role="group" aria-label="Check out or reserve">
        <button type="button" class="btn btn-sm" :class="mode === 'checkout' ? 'btn-secondary' : 'btn-outline-secondary'"
                @click="mode = 'checkout'">Check out now</button>
        <button type="button" class="btn btn-sm" :class="mode === 'reserve' ? 'btn-secondary' : 'btn-outline-secondary'"
                @click="mode = 'reserve'">Reserve</button>
      </div>

      <!-- What is in the basket -->
      <template v-for="(group, i) in groups" :key="i">
        <div class="trax-list-header">
          <template v-if="group.kind === 'set'">
            <i class="bi bi-box-seam"></i>
            <span class="text-truncate">{{ group.asset.name }}</span>
            <span class="flex-grow-1"></span>
            <div class="input-group input-group-sm" style="width:6.75rem">
              <button class="btn btn-outline-secondary px-2"
                      @click="setQuantity(group.asset.id, getQuantity(group.asset.id) - 1)"
                      :aria-label="'One fewer ' + group.asset.name">−</button>
              <input class="form-control text-center px-0" type="number" min="1"
                     :value="getQuantity(group.asset.id)"
                     @input="setQuantity(group.asset.id, $event.target.value)"
                     :aria-label="'Quantity of ' + group.asset.name">
              <button class="btn btn-outline-secondary px-2"
                      @click="setQuantity(group.asset.id, getQuantity(group.asset.id) + 1)"
                      :aria-label="'One more ' + group.asset.name">+</button>
            </div>
            <button class="trax-close" @click="toggleSelected(group.asset.id)"
                    :aria-label="'Remove ' + group.asset.name"><i class="bi bi-x-lg"></i></button>
          </template>
          <template v-else>Items</template>
        </div>

        <div class="trax-list">
          <div v-for="member in group.members" :key="member.id" class="trax-row flex-wrap"
               :class="{ 'opacity-50': member.availableQty <= 0 }">
            <div class="trax-row-main">
              <button class="trax-name-btn d-block text-truncate mw-100" @click="emit('open', member.id)">{{ member.name }}</button>
              <div class="trax-row-meta">
                <span class="trax-status-dot" :class="'status-' + member.effectiveStatus">
                  {{ member.quantity > 1 ? member.availableQty + ' of ' + member.quantity + ' free' : (member.availableQty > 0 ? 'Available' : 'Not available') }}
                </span>
              </div>
            </div>

            <!-- Kit members carry a fixed required qty; loose items get a stepper. -->
            <span v-if="group.kind === 'set'" class="trax-kind-chip">
              ×{{ member.reqQty * getQuantity(group.asset.id) }}
            </span>
            <template v-else>
              <div class="input-group input-group-sm" style="width:6.75rem">
                <button class="btn btn-outline-secondary px-2"
                        @click="setQuantity(member.id, getQuantity(member.id) - 1)"
                        :aria-label="'One fewer ' + member.name">−</button>
                <input class="form-control text-center px-0" type="number" min="1"
                       :max="member.availableQty || 1"
                       :value="getQuantity(member.id)"
                       @input="setQuantity(member.id, $event.target.value)"
                       :aria-label="'Quantity of ' + member.name">
                <button class="btn btn-outline-secondary px-2"
                        @click="setQuantity(member.id, getQuantity(member.id) + 1)"
                        :aria-label="'One more ' + member.name">+</button>
              </div>
              <button class="trax-close" @click="toggleSelected(member.id)" :aria-label="'Remove ' + member.name">
                <i class="bi bi-x-lg"></i>
              </button>
            </template>

            <!-- Which physical units leave; the rest the server assigns. -->
            <div v-if="showUnits(group, member)" class="w-100">
              <div class="d-flex flex-wrap gap-1">
                <button v-for="unit in unitsOf(member)" :key="unit.no" type="button"
                        class="btn btn-sm py-0 px-2"
                        :class="unitChosen(member, unit) ? 'btn-primary' : 'btn-outline-secondary'"
                        :disabled="unitDisabled(member, unit)"
                        :title="unitTitle(member, unit)"
                        @click="toggleUnitChoice(member.id, unit.no)">
                  {{ unitCode(member, unit) }}<span v-if="unit.label" class="ms-1 opacity-75">{{ unit.label }}</span>
                </button>
              </div>
              <div class="small text-secondary mt-1">{{ unitHint(member) }}</div>
            </div>
          </div>
        </div>
      </template>

      <div v-if="unavailable.length" class="alert alert-warning py-2 px-3 small mt-3 mb-0">
        <i class="bi bi-exclamation-triangle-fill"></i>
        Not enough free:
        <span v-for="(row, ri) in unavailable" :key="row.asset.id">
          {{ row.asset.name }} ({{ row.asset.availableQty }}/{{ row.qty }})<span v-if="ri < unavailable.length - 1">, </span>
        </span>
      </div>

      <!-- Price: hire type, rental for the window, and what it is worth.
           Internal until the rental PDF is printed. -->
      <template v-if="selectedItemIds.length">
        <div class="trax-list-header">Price</div>
        <div class="btn-group w-100 mb-2" role="group" aria-label="Hire type">
          <button type="button" class="btn btn-sm" :class="hire === 'DRY' ? 'btn-secondary' : 'btn-outline-secondary'"
                  :aria-pressed="hire === 'DRY' ? 'true' : 'false'" @click="hire = 'DRY'">
            {{ HIRE_LABEL.DRY }}
          </button>
          <button type="button" class="btn btn-sm" :class="hire === 'SERVICE' ? 'btn-secondary' : 'btn-outline-secondary'"
                  :aria-pressed="hire === 'SERVICE' ? 'true' : 'false'" @click="hire = 'SERVICE'">
            {{ HIRE_LABEL.SERVICE }}
          </button>
          <button type="button" class="btn btn-sm" :class="hire === 'FREE' ? 'btn-secondary' : 'btn-outline-secondary'"
                  :aria-pressed="hire === 'FREE' ? 'true' : 'false'" :title="HIRE_LABEL.FREE" @click="hire = 'FREE'">
            Free
          </button>
        </div>
        <div class="trax-list">
          <div class="trax-kv">
            <span>Rental · {{ daysLabel(hireLength) }}</span>
            <span v-if="rentalQuote.unratedCount" class="trax-kind-chip"
                  title="No rental rate set — Settings → Rental rates, or the asset's Rental tab.">
              {{ rentalQuote.unratedCount }} no rate
            </span>
            <span v-if="rentalQuote.unpricedCount" class="trax-kind-chip" title="Priced by a value that is not recorded.">
              {{ rentalQuote.unpricedCount }} no value
            </span>
            <strong>{{ formatTotals(rentalQuote.totals) }}</strong>
          </div>
          <div class="trax-kv">
            <span>Value</span>
            <span v-if="selectionValue.unpricedCount" class="trax-kind-chip">
              {{ selectionValue.unpricedCount }} no price
            </span>
            <strong>{{ formatTotals(selectionValue.totals) }}</strong>
          </div>
        </div>
        <div v-if="hire === 'SERVICE'" class="form-text ms-1">
          Gear at
          <span v-for="(factor, fi) in serviceFactors" :key="factor">{{ Math.round(factor * 1000) / 10 }} %<span v-if="fi < serviceFactors.length - 1">, </span></span>
          of dry hire ({{ formatTotals(dryQuote.totals) }}).
        </div>
        <div v-else-if="hire === 'FREE'" class="form-text ms-1">
          Dry hire would be {{ formatTotals(dryQuote.totals) }}.
        </div>
      </template>

      <!-- Customer & dates -->
      <div class="trax-list-header">Customer</div>
      <div class="row g-2">
        <div class="col-12 col-md-6">
          <input id="b-name" class="form-control" v-model="customerName" placeholder="Name" data-autofocus="desktop"
                 aria-label="Customer name" autocomplete="off">
        </div>
        <div class="col-12 col-md-6">
          <input id="b-email" type="email" class="form-control" v-model="customerEmail" placeholder="Email"
                 aria-label="Customer email" autocomplete="off">
        </div>
      </div>

      <div class="trax-list-header">{{ mode === 'checkout' ? 'Return by' : 'When' }}</div>
      <div class="row g-2">
        <div v-if="mode === 'checkout'" class="col-12">
          <input id="b-due" type="datetime-local" class="form-control" v-model="dueAt" aria-label="Return by">
        </div>
        <template v-else>
          <div class="col-6">
            <label class="form-label" for="b-start">From</label>
            <input id="b-start" type="datetime-local" class="form-control" v-model="startAt">
          </div>
          <div class="col-6">
            <label class="form-label" for="b-end">Until</label>
            <input id="b-end" type="datetime-local" class="form-control" v-model="endAt">
          </div>
        </template>
      </div>

      <template v-if="eventsEnabled">
        <div class="trax-list-header">Event</div>
        <select id="b-event" class="form-select" v-model="eventId" aria-label="Event">
          <option value="">None</option>
          <option v-for="event in eventOptions" :key="event.id" :value="String(event.id)">
            {{ event.name }}<span v-if="event.client"> · {{ event.client }}</span>
          </option>
        </select>
      </template>

      <div class="trax-list-header">Notes</div>
      <textarea id="b-notes" class="form-control" rows="2" v-model="notes" aria-label="Notes" placeholder="Optional"></textarea>

      <!-- Conflict preview while choosing a window -->
      <div v-if="windowConflicts.length" class="alert alert-warning mt-3 py-2 px-3 small">
        <strong>Already booked in that window:</strong>
        <ul class="mb-2 mt-1 ps-3">
          <li v-for="row in windowConflicts" :key="row.asset.id">
            {{ row.asset.name }} —
            <span v-for="(hit, j) in row.hits" :key="j">
              {{ hit.kind }} ×{{ hit.qty }} · {{ hit.who }}{{ j < row.hits.length - 1 ? ', ' : '' }}
            </span>
          </li>
        </ul>
        <div class="form-check">
          <input class="form-check-input" type="checkbox" id="force-res" v-model="force">
          <label class="form-check-label" for="force-res">{{ editing ? 'Save anyway' : 'Reserve anyway' }}</label>
        </div>
      </div>

      <!-- Server refusal -->
      <div v-if="blocked.length" class="alert alert-danger mt-3 py-2 px-3 small">
        <strong>Not available:</strong>
        <ul class="mb-2 mt-1 ps-3">
          <!-- who/until are empty strings when the shortfall is plain capacity
               rather than a named holder, so they must not be printed blind. -->
          <li v-for="b in blocked" :key="b.assetId">
            {{ b.name }}
            <span v-if="b.viaSet" class="text-secondary">(in {{ b.viaSet }})</span>
            — {{ b.wanted }} wanted, {{ b.available }} free
            <span v-if="b.who">· {{ b.who }}<span v-if="b.until"> until {{ b.until }}</span></span>
            <span v-if="b.unitNos?.length" class="text-secondary"> · {{ blockedUnitCodes(b) }}</span>
          </li>
        </ul>
        <div class="form-check" v-if="mode === 'checkout'">
          <input class="form-check-input" type="checkbox" id="allow-partial" v-model="allowPartial">
          <label class="form-check-label" for="allow-partial">Hand over the rest anyway</label>
        </div>
      </div>

      <template #footer>
        <Menu label="More actions" up align="start">
          <button type="button" class="trax-menu-item" :disabled="exportingQuote || !selectedItemIds.length"
                  @click="rentalPdf">
            <i class="bi bi-receipt"></i> Rental PDF
          </button>
          <button type="button" class="trax-menu-item" :disabled="exportingPdf || !selectedItemIds.length"
                  @click="selectionPdf">
            <i class="bi bi-filetype-pdf"></i> Value PDF
          </button>
          <div class="trax-menu-sep"></div>
          <button v-if="editing" type="button" class="trax-menu-item is-danger" @click="discardEdit">
            <i class="bi bi-arrow-counterclockwise"></i> Discard changes
          </button>
          <button v-else type="button" class="trax-menu-item is-danger" @click="clearSelection(); emit('close')">
            <i class="bi bi-trash3"></i> Clear selection
          </button>
        </Menu>
        <span v-if="exportingPdf || exportingQuote" class="spinner-border spinner-border-sm text-secondary"></span>
        <span class="flex-grow-1"></span>
        <button class="btn btn-outline-secondary" @click="emit('close')">
          {{ editing ? 'Close' : 'Cancel' }}
        </button>
        <button class="btn btn-primary" :disabled="busy || !selectedItemIds.length || editGone"
                @click="submit">
          <span v-if="busy" class="spinner-border spinner-border-sm"></span>
          <template v-if="editing">{{ force ? 'Save anyway' : 'Save' }}</template>
          <template v-else>
            {{ mode === 'checkout'
                ? (allowPartial ? 'Check out available' : 'Check out')
                : (force ? 'Reserve anyway' : 'Reserve') }}
          </template>
        </button>
      </template>
    </Drawer>
  `,
};
