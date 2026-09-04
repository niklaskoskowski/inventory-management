import { ref, computed } from 'vue';
import { state, mutate, toast, getAsset, load } from '../store.js';
import * as api from '../api.js';
import {
  formatDateTime, daysOverdue, isOverdue, toLocalInput, parseDate, formatTotals,
} from '../lib/format.js';
import { valueOfLines } from '../lib/insights.js';
import { exportBookingPdf } from '../lib/pdf.js';
import ConfirmDialog from './ui/ConfirmDialog.js';

/**
 * Open checkouts, grouped by customer.
 *
 * Replaces both the old #manageCheckoutsModal (manage-checkouts.js, which
 * never updated asset status on check-in) and the workflow panel's duplicate
 * of the same logic. There is one path now, and it lives in api.php.
 */
export default {
  name: 'CheckoutsView',
  components: { ConfirmDialog },
  emits: ['open'],
  setup(props, { emit }) {
    // Selection is by lineId now — an asset id can appear on several lines.
    const selected = ref([]);
    // lineId => units to hand back. Absent means "the whole line".
    const returnQty = ref({});
    // lineId => which numbered units to hand back, for a line that tracks
    // them. Absent or empty means "the whole line", same as returnQty.
    const returnUnits = ref({});
    const extending = ref(false);
    const extendTo = ref('');
    const confirmReturn = ref(false);
    const notify = ref(true);
    const exporting = ref(false);

    // Condition photos are taken of ONE item at a time: the line being
    // photographed, the files picked for it, and the comment that goes with it.
    // Mirrors TRAX_MAX_PHOTOS_PER_BATCH: the server refuses the whole batch
    // above it, so the count is checked here rather than after a 400.
    const MAX_PHOTOS = 8;
    const photoLine = ref(null);
    const itemFiles = ref([]);
    const itemNote = ref('');
    const uploading = ref(false);
    // A batch the server refused. Kept so the photos are not silently lost —
    // they can be retried or explicitly dropped.
    const failedPhotos = ref(null);

    /** One card per customer, since a kit checkout produces many lines. */
    const groups = computed(() => {
      const map = new Map();
      for (const line of state.checkouts) {
        const key = `${line.customerEmail}|${line.returnDate}`;
        if (!map.has(key)) {
          map.set(key, {
            key,
            customerName: line.customerName,
            customerEmail: line.customerEmail,
            dueAt: line.dueAt || line.returnDate,
            returnDate: line.returnDate,
            reservationId: line.reservationId,
            lines: [],
            units: 0,
            setIds: new Set(),
          });
        }
        const group = map.get(key);
        group.lines.push(line);
        group.units += Math.max(1, Number(line.qty) || 1);
        if (line.setId) group.setIds.add(line.setId);
      }
      return [...map.values()]
        // What this customer is holding is worth. Valued off the LINE's qty,
        // so 3 of 8 units out counts 3. Internal only — the handover PDF and
        // the customer's emails carry none of it.
        .map((group) => ({
          ...group,
          value: valueOfLines(
            group.lines.map((line) => ({ id: line.assetId, qty: line.qty })),
            getAsset,
          ),
        }))
        .sort((a, b) => (parseDate(a.dueAt) || 0) - (parseDate(b.dueAt) || 0));
    });

    const lineById = computed(
      () => new Map(state.checkouts.map((line) => [Number(line.lineId), line])),
    );

    const qtyFor = (lineId) => {
      const line = lineById.value.get(Number(lineId));
      const whole = Math.max(1, Number(line?.qty) || 1);
      // A line that tracks units is counted by the units picked on it: the
      // numbers ARE the quantity, so the stepper never applies to it.
      const picked = returnUnits.value[Number(lineId)];
      if (picked && picked.length) return Math.min(whole, picked.length);
      const wanted = returnQty.value[Number(lineId)];
      return wanted === undefined ? whole : Math.min(whole, Math.max(1, wanted));
    };

    const setQtyFor = (lineId, qty) => {
      const line = lineById.value.get(Number(lineId));
      const whole = Math.max(1, Number(line?.qty) || 1);
      const wanted = Math.floor(Number(qty));
      returnQty.value[Number(lineId)] = Math.min(
        whole,
        Math.max(1, Number.isFinite(wanted) ? wanted : 1),
      );
    };

    // --- Which units come back ----------------------------------------------

    /** The units of `line`, as `12.1, 12.3`. Empty for a unit-less line. */
    const unitCodes = (line) =>
      (line.unitNos || []).map((no) => `${line.assetId}.${no}`).join(', ');

    /**
     * The same list with whatever labels the asset still carries.
     *
     * The asset can have been deleted, or its units renamed since the line
     * left — the line's numbers are the record, the labels are decoration.
     */
    const unitTitle = (line) => {
      const units = getAsset(line.assetId)?.units || [];
      return (line.unitNos || [])
        .map((no) => {
          const unit = units.find((entry) => Number(entry.no) === Number(no));
          return unit?.label ? `${line.assetId}.${no} ${unit.label}` : `${line.assetId}.${no}`;
        })
        .join(', ');
    };

    /** The label of one unit of `line`, for the per-unit check box. */
    const unitLabel = (line, no) => {
      const unit = (getAsset(line.assetId)?.units || [])
        .find((entry) => Number(entry.no) === Number(no));
      return unit?.label || '';
    };

    const unitPicked = (lineId, no) =>
      (returnUnits.value[Number(lineId)] || []).includes(Number(no));

    const toggleUnitFor = (lineId, no) => {
      const key = Number(lineId);
      const current = returnUnits.value[key] || [];
      const next = current.includes(Number(no))
        ? current.filter((entry) => entry !== Number(no))
        : [...current, Number(no)].sort((a, b) => a - b);
      returnUnits.value = { ...returnUnits.value, [key]: next };
    };

    /** Units the selection covers, which is not the number of lines. */
    const selectedUnits = computed(() =>
      selected.value.reduce((sum, lineId) => sum + qtyFor(lineId), 0),
    );

    const toggle = (lineId) => {
      const index = selected.value.indexOf(lineId);
      if (index >= 0) {
        selected.value.splice(index, 1);
        delete returnQty.value[Number(lineId)];
        delete returnUnits.value[Number(lineId)];
      } else {
        selected.value.push(lineId);
      }
    };

    const toggleGroup = (group) => {
      const ids = group.lines.map((r) => r.lineId);
      const allOn = ids.every((id) => selected.value.includes(id));
      selected.value = allOn
        ? selected.value.filter((id) => !ids.includes(id))
        : [...new Set([...selected.value, ...ids])];
    };

    const setName = (id) => getAsset(id)?.name || `Kit #${id}`;

    // --- The customer's booking ---------------------------------------------
    // Every line carries a bookingId, and the booking holds the token the
    // customer's link is built from. Without these two buttons the token is
    // invisible to the operator.

    const bookingById = computed(
      () => new Map(state.bookings.map((booking) => [Number(booking.id), booking])),
    );

    const bookingIdsOf = (lines) => [...new Set(
      lines
        .map((line) => Number(line.bookingId))
        .filter((id) => Number.isFinite(id) && id > 0),
    )];

    /** The one booking a group's lines belong to, or null if it is ambiguous. */
    const bookingOf = (group) => {
      const ids = bookingIdsOf(group.lines);
      return ids.length === 1 ? bookingById.value.get(ids[0]) || null : null;
    };

    /** Built here, not taken from the server: `<origin><publicPath>booking.php?t=…`. */
    const bookingUrl = (booking) => {
      if (!booking || !booking.token) return '';
      const origin = (typeof location === 'object' && location.origin) || '';
      const base = state.settings?.branding?.publicPath || '/';
      return `${origin}${base}booking.php?t=${booking.token}`;
    };

    const copyLink = async (group) => {
      const url = bookingUrl(bookingOf(group));
      if (!url) {
        toast('These lines have no booking link.', 'warning');
        return;
      }
      try {
        await navigator.clipboard.writeText(url);
        toast('Booking link copied.', 'success');
      } catch {
        // Clipboard access is refused outside a secure context, so the link
        // still has to reach the operator somehow.
        toast(`Could not copy — the link is ${url}`, 'warning', 0);
      }
    };

    const resendEmail = async (group) => {
      const booking = bookingOf(group);
      if (!booking) {
        toast('These lines have no booking to re-send.', 'warning');
        return;
      }
      try {
        const data = await mutate('booking.resend', { id: booking.id });
        toast(
          data.mailed
            ? `Confirmation re-sent to ${booking.customerEmail}.`
            : 'The confirmation email could not be sent.',
          data.mailed ? 'success' : 'warning',
        );
      } catch { /* toast already raised */ }
    };

    // --- Condition photos, per item -----------------------------------------
    // One line, one batch, one comment: a photo of a cracked housing documents
    // the piece it was taken of, not everything the customer happens to hold.

    const openPhotos = (line) => {
      photoLine.value = line;
      itemFiles.value = [];
      itemNote.value = '';
    };

    const closePhotos = () => {
      photoLine.value = null;
      itemFiles.value = [];
      itemNote.value = '';
    };

    const pickItemPhotos = (event) => {
      const files = [...(event?.target?.files || [])];
      if (files.length > MAX_PHOTOS) {
        toast(
          `Up to ${MAX_PHOTOS} photos can be uploaded at once — ${files.length} were picked.`,
          'warning',
        );
        itemFiles.value = [];
        if (event?.target) event.target.value = '';
        return;
      }
      itemFiles.value = files;
    };

    /**
     * Posts one all-or-nothing batch for one item.
     *
     * The answer carries a fresh snapshot, but applying one is store-internal,
     * so a reload is how the new photos reach `state.bookings`.
     */
    const sendItemPhotos = async (batch) => {
      uploading.value = true;
      try {
        await api.uploadMany('booking.uploadPhotos', batch.files, {
          bookingId: batch.bookingId,
          assetId: batch.assetId,
          note: batch.note,
        });
        await load().catch(() => { /* the photos are stored either way */ });
        failedPhotos.value = null;
        return { ok: true, message: '' };
      } catch (error) {
        failedPhotos.value = { ...batch, message: error.message };
        return { ok: false, message: error.message };
      } finally {
        uploading.value = false;
      }
    };

    /** The dialog's confirm: upload what was picked for the one open line. */
    const uploadItemPhotos = async () => {
      const line = photoLine.value;
      if (!line) return;

      const files = [...itemFiles.value];
      if (!files.length) {
        toast('Pick at least one photo.', 'warning');
        return;
      }

      // Photos hang off the booking, so a line without one has nowhere to put
      // them. Said before the files are dropped, not after.
      const bookingId = Number(line.bookingId);
      if (!Number.isFinite(bookingId) || bookingId <= 0) {
        toast(
          `"${line.name || '#' + line.assetId}" belongs to no booking, `
          + 'so its photos have nowhere to go.',
          'warning',
        );
        return;
      }

      const batch = {
        bookingId,
        assetId: Number(line.assetId),
        name: line.name || `#${line.assetId}`,
        files,
        note: itemNote.value,
      };
      closePhotos();

      const sent = await sendItemPhotos(batch);
      if (sent.ok) {
        toast(`${files.length} condition photo(s) added to ${batch.name}.`, 'success');
      } else {
        toast(
          `The ${files.length} condition photo(s) for ${batch.name} were NOT stored: `
          + `${sent.message} They are still here — retry or discard them.`,
          'danger', 0,
        );
      }
    };

    const retryPhotos = async () => {
      const batch = failedPhotos.value;
      if (!batch) return;
      const sent = await sendItemPhotos(batch);
      if (sent.ok) {
        toast(`${batch.files.length} condition photo(s) added to ${batch.name}.`, 'success');
      } else {
        toast(`The photos still could not be stored: ${sent.message}`, 'danger', 8000);
      }
    };

    const discardPhotos = () => {
      failedPhotos.value = null;
    };

    /** The handover sheet for one customer's open lines. */
    const bookingPdf = async (group) => {
      exporting.value = true;
      try {
        const first = group.lines[0] || {};
        await exportBookingPdf({
          kind: 'checkout',
          customerName: group.customerName,
          customerEmail: group.customerEmail,
          reference: group.reservationId ? `Reservation #${group.reservationId}` : '',
          startAt: first.checkedOut,
          endAt: group.dueAt,
          status: isOverdue(group.dueAt)
            ? `Overdue by ${daysOverdue(group.dueAt)} day(s)`
            : 'Checked out',
          notes: first.note || '',
          items: group.lines.map((line) => ({
            // The units are part of the name on the sheet the customer signs:
            // "5m XLR cable (12.1, 12.3)" is what was physically handed over.
            name: line.unitNos?.length ? `${line.name} (${unitCodes(line)})` : line.name,
            assetId: line.assetId,
            qty: line.qty,
            setId: line.setId,
            setName: line.setId ? setName(line.setId) : '',
          })),
        });
      } finally {
        exporting.value = false;
      }
    };

    const doReturn = async () => {
      confirmReturn.value = false;
      try {
        // lines: [{lineId, qty}] — a partial return leaves the rest out.
        // On a line that tracks units the request names them instead, so the
        // right ones come back rather than the first ones out.
        const data = await mutate('checkout.checkin', {
          lines: selected.value.map((lineId) => {
            const picked = returnUnits.value[Number(lineId)] || [];
            if (picked.length) return { lineId, unitNos: picked };
            return { lineId, qty: qtyFor(lineId) };
          }),
          notify: notify.value,
        });
        toast(
          `Checked in ${data.returned} unit(s) on ${data.lines} line(s).`
          + (data.mailed ? ' Customer notified.' : ''),
          'success',
        );
        selected.value = [];
        returnQty.value = {};
        returnUnits.value = {};
      } catch {
        // Nothing was returned; the pick stays so it can be tried again.
      }
    };

    const doExtend = async () => {
      if (!extendTo.value) {
        toast('Pick a new return date.', 'warning');
        return;
      }
      try {
        const data = await mutate('checkout.extend', {
          lineIds: selected.value,
          dueAt: extendTo.value,
        });
        toast(`Extended ${data.extended} unit(s) on ${data.lines} line(s).`, 'success');
        extending.value = false;
        extendTo.value = '';
        selected.value = [];
      } catch { /* toast already raised */ }
    };

    const startExtend = () => {
      const first = state.checkouts.find((r) => selected.value.includes(r.lineId));
      extendTo.value = toLocalInput(first?.dueAt || first?.returnDate) || '';
      extending.value = true;
    };

    return {
      state, groups, selected, selectedUnits, toggle, toggleGroup, setName,
      qtyFor, setQtyFor, extending, extendTo, confirmReturn, notify,
      unitCodes, unitTitle, unitLabel, unitPicked, toggleUnitFor,
      doReturn, doExtend, startExtend, exporting, bookingPdf,
      MAX_PHOTOS, photoLine, itemFiles, itemNote, uploading, failedPhotos,
      openPhotos, closePhotos, pickItemPhotos, uploadItemPhotos,
      retryPhotos, discardPhotos,
      bookingOf, bookingUrl, copyLink, resendEmail,
      formatDateTime, daysOverdue, isOverdue, formatTotals, emit,
    };
  },
  template: `
    <!-- The upload was refused. The files are still in memory, so they are
         offered back rather than dropped. -->
    <div v-if="failedPhotos" class="alert alert-danger d-flex align-items-center gap-2 flex-wrap">
      <i class="bi bi-exclamation-octagon"></i>
      <div class="flex-grow-1 small">
        <strong>{{ failedPhotos.files.length }} condition photo(s) were not stored</strong>
        for {{ failedPhotos.name }} on booking #{{ failedPhotos.bookingId }} —
        {{ failedPhotos.message }}
      </div>
      <button class="btn btn-sm btn-light" :disabled="uploading" @click="retryPhotos()">
        <span v-if="uploading" class="spinner-border spinner-border-sm me-1"></span>
        Retry upload
      </button>
      <button class="btn btn-sm btn-outline-light" @click="discardPhotos()">Discard</button>
    </div>

    <div v-if="!state.checkouts.length" class="trax-empty">
      <i class="bi bi-check2-circle"></i>
      Nothing is checked out.
    </div>

    <div v-else class="d-flex flex-column gap-3">
      <article v-for="group in groups" :key="group.key" class="trax-card">
        <div class="trax-card-pad d-flex align-items-center gap-2 flex-wrap border-bottom border-secondary-subtle">
          <input class="form-check-input" type="checkbox"
                 :checked="group.lines.every(r => selected.includes(r.lineId))"
                 @change="toggleGroup(group)"
                 :aria-label="'Select all items out with ' + group.customerName">
          <div class="flex-grow-1 min-w-0">
            <strong>{{ group.customerName }}</strong>
            <span class="text-secondary small ms-2">{{ group.customerEmail }}</span>
            <div class="small" :class="isOverdue(group.dueAt) ? 'text-danger' : 'text-secondary'">
              {{ group.units }} unit(s) on {{ group.lines.length }} line(s) · due {{ formatDateTime(group.dueAt) }}
              <span v-if="isOverdue(group.dueAt)">— {{ daysOverdue(group.dueAt) }} days late</span>
            </div>
            <!-- Internal figure: what this customer is holding. -->
            <div class="small text-secondary">
              Value out: <strong>{{ formatTotals(group.value.totals) }}</strong>
              <span v-if="group.value.unpricedCount">
                · {{ group.value.unpricedCount }} item(s) without a price
              </span>
            </div>
          </div>
          <span v-for="setId in [...group.setIds]" :key="setId" class="trax-kind-chip">
            <i class="bi bi-box-seam"></i> {{ setName(setId) }}
          </span>
          <button class="btn btn-sm btn-outline-secondary" :disabled="exporting"
                  @click="bookingPdf(group)"
                  :aria-label="'Handover PDF for ' + group.customerName">
            <i class="bi bi-filetype-pdf"></i> PDF
          </button>
          <button v-if="bookingOf(group)" class="btn btn-sm btn-outline-secondary"
                  @click="copyLink(group)"
                  :aria-label="'Copy the booking link for ' + group.customerName">
            <i class="bi bi-link-45deg"></i> Copy link
          </button>
          <button v-if="bookingOf(group)" class="btn btn-sm btn-outline-secondary"
                  :disabled="state.loading" @click="resendEmail(group)"
                  :aria-label="'Re-send the confirmation to ' + group.customerEmail">
            <i class="bi bi-envelope"></i> Resend email
          </button>
        </div>

        <!-- Keyed by lineId: the same asset id can appear on several lines. -->
        <ul class="list-group list-group-flush">
          <li v-for="line in group.lines" :key="line.lineId"
              class="list-group-item bg-transparent d-flex flex-wrap align-items-center gap-2">
            <input class="form-check-input" type="checkbox"
                   :checked="selected.includes(line.lineId)" @change="toggle(line.lineId)"
                   :aria-label="'Select ' + line.name">
            <button class="trax-name-btn flex-grow-1" @click="emit('open', line.assetId)">
              {{ line.name || ('#' + line.assetId) }}
            </button>
            <span class="trax-kind-chip">×{{ line.qty }}</span>
            <!-- Which physical units left, when the asset tracks them. -->
            <span v-if="line.unitNos?.length" class="trax-kind-chip font-monospace"
                  :title="unitTitle(line)">{{ unitCodes(line) }}</span>

            <!-- Partial return: hand back some of the units on this line. -->
            <div v-if="selected.includes(line.lineId) && !line.unitNos?.length && line.qty > 1"
                 class="input-group input-group-sm" style="width:8rem">
              <button class="btn btn-outline-secondary py-0 px-2"
                      @click="setQtyFor(line.lineId, qtyFor(line.lineId) - 1)"
                      :aria-label="'Return one fewer ' + line.name">−</button>
              <input class="form-control text-center px-0" type="number" min="1" :max="line.qty"
                     :value="qtyFor(line.lineId)"
                     @input="setQtyFor(line.lineId, $event.target.value)"
                     :aria-label="'Units of ' + line.name + ' to check in'">
              <button class="btn btn-outline-secondary py-0 px-2"
                      @click="setQtyFor(line.lineId, qtyFor(line.lineId) + 1)"
                      :aria-label="'Return one more ' + line.name">+</button>
            </div>

            <!-- Photos belong to one piece of gear, so they are taken from
                 the line rather than from the check-in dialog. -->
            <button class="btn btn-sm btn-outline-secondary" @click="openPhotos(line)"
                    :aria-label="'Condition photos of ' + (line.name || ('#' + line.assetId))">
              <i class="bi bi-camera"></i>
            </button>

            <span class="text-secondary font-monospace small">#{{ line.assetId }}</span>
            <span v-if="line.setId" class="trax-kind-chip">in kit</span>

            <!-- Partial return, unit by unit: the numbers are the quantity, so
                 a line that names them gets check boxes instead of a stepper. -->
            <div v-if="selected.includes(line.lineId) && line.unitNos?.length && line.qty > 1"
                 class="w-100 d-flex flex-wrap gap-3 ps-4">
              <div v-for="no in line.unitNos" :key="no" class="form-check mb-0">
                <input class="form-check-input" type="checkbox"
                       :id="'ret-' + line.lineId + '-' + no"
                       :checked="unitPicked(line.lineId, no)"
                       @change="toggleUnitFor(line.lineId, no)">
                <label class="form-check-label small" :for="'ret-' + line.lineId + '-' + no">
                  <span class="font-monospace">{{ line.assetId }}.{{ no }}</span>
                  <span v-if="unitLabel(line, no)" class="text-secondary ms-1">{{ unitLabel(line, no) }}</span>
                </label>
              </div>
            </div>
          </li>
        </ul>
      </article>
    </div>

    <div v-if="selected.length" class="trax-selection-bar">
      <strong>{{ selected.length }}</strong> line(s) · {{ selectedUnits }} unit(s)
      <span class="flex-grow-1"></span>
      <button class="btn btn-sm btn-outline-secondary" @click="startExtend">
        <i class="bi bi-calendar-plus"></i> Extend
      </button>
      <button class="btn btn-sm btn-success" @click="confirmReturn = true">
        <i class="bi bi-box-arrow-in-left"></i> Check in
      </button>
      <button class="btn btn-sm btn-outline-secondary" @click="selected = []">Clear</button>
    </div>

    <ConfirmDialog v-if="confirmReturn"
                   title="Check these items back in?"
                   :message="selectedUnits + ' unit(s) across ' + selected.length + ' line(s) will be marked returned.'"
                   confirm-label="Check in"
                   @confirm="doReturn" @cancel="confirmReturn = false">
      <div class="form-check mt-3">
        <input class="form-check-input" type="checkbox" id="notify-return" v-model="notify">
        <label class="form-check-label small" for="notify-return">Email the customer</label>
      </div>
    </ConfirmDialog>

    <!-- One item, one batch. capture="environment" so a phone opens the rear
         camera directly: this is somebody standing at the counter with it. -->
    <ConfirmDialog v-if="photoLine"
                   title="Condition photos"
                   :message="'Of ' + (photoLine.name || ('#' + photoLine.assetId)) + ' — up to ' + MAX_PHOTOS + ' at once.'"
                   confirm-label="Upload"
                   @confirm="uploadItemPhotos" @cancel="closePhotos()">
      <div class="mt-3">
        <label class="form-label small mb-1" for="item-photos">Photos</label>
        <input id="item-photos" class="form-control form-control-sm" type="file"
               multiple accept="image/*" capture="environment" @change="pickItemPhotos">

        <div v-if="itemFiles.length" class="d-flex align-items-center gap-2 mt-2">
          <span class="trax-kind-chip">
            <i class="bi bi-camera"></i> {{ itemFiles.length }} photo(s) ready
          </span>
        </div>
        <input class="form-control form-control-sm mt-2"
               v-model="itemNote" aria-label="Comment on these photos"
               placeholder="What is damaged on this item?">
      </div>
    </ConfirmDialog>

    <ConfirmDialog v-if="extending"
                   title="Extend the return date"
                   confirm-label="Extend"
                   @confirm="doExtend" @cancel="extending = false">
      <label class="form-label small mt-3" for="extend-to">New return date</label>
      <input id="extend-to" type="datetime-local" class="form-control form-control-sm"
             v-model="extendTo" data-autofocus>
    </ConfirmDialog>
  `,
};
