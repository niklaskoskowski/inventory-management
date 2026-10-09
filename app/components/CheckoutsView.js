import { ref, computed, watch, onMounted } from 'vue';
import {
  state, mutate, toast, getAsset, load, eventById, openPreview,
  signBooking, unsignBooking, termsUrl,
} from '../store.js';
import * as api from '../api.js';
import {
  formatDateTime, daysOverdue, isOverdue, toLocalInput, parseDate, formatTotals, getUiLocale,
} from '../lib/format.js';
import { valueOfLines } from '../lib/insights.js';
import {
  rentalDays as hireDays, rentalOfLines, daysLabel, HIRE_LABEL, hireOf,
} from '../lib/rental.js';
import { exportBookingPdf, exportRentalPdf } from '../lib/pdf.js';
import ConfirmDialog from './ui/ConfirmDialog.js';
import Drawer from './ui/Drawer.js';
import Menu from './ui/Menu.js';
import SignaturePad from './SignaturePad.js';

/**
 * The booking a scan asked for, parked until this view is on screen.
 *
 * A module-level ref rather than a field on the store: nothing is persisted
 * and nothing else reads it — it is one hand-off, from whoever recognised a
 * booking to the view that can show it. Cleared as soon as it is acted on.
 */
const pending = ref(null);

/** Ask the checkouts view to open one booking's card in full. */
export function openCheckout(bookingId) {
  const id = Number(bookingId);
  pending.value = Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Open checkouts, grouped by customer.
 *
 * Replaces both the old #manageCheckoutsModal (manage-checkouts.js, which
 * never updated asset status on check-in) and the workflow panel's duplicate
 * of the same logic. There is one path now, and it lives in api.php.
 */
export default {
  name: 'CheckoutsView',
  components: { ConfirmDialog, Drawer, Menu, SignaturePad },
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
        .map((group) => {
          // What this hire is billed for: the days it was booked for, priced by
          // the rates in force now. Never stored on the line — see
          // app/lib/rental.js — so a rate change re-prices what is still out.
          const days = hireDays(group.lines[0]?.checkedOut, group.dueAt);
          // Every line carries its own answer, so a group of lines that
          // somehow disagree is priced line by line rather than averaged; this
          // is only what the CHIP says.
          const hire = hireOf(group.lines[0]);
          // The job these went out on, when they name one. Read off the first
          // line: a group is one hand-over, so they all carry the same answer.
          const event = eventById.value.get(Number(group.lines[0]?.eventId)) || null;
          return {
            ...group,
            days,
            hire,
            event,
            value: valueOfLines(
              group.lines.map((line) => ({ id: line.assetId, qty: line.qty })),
              getAsset,
            ),
            rental: rentalOfLines(
              group.lines.map((line) => ({
                id: line.assetId,
                qty: line.qty,
                // The units that actually left, so a unit with its own rate is
                // priced as itself rather than as the asset's average.
                unitNos: line.unitNos || [],
                // Dry hire or a serviced job, as it was booked.
                hire: line.hire,
              })),
              getAsset,
              state.settings,
              days,
            ),
          };
        })
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

    /**
     * The terms line for the sheet: what the signature accepted, or — not
     * signed yet — what signing on this paper would accept. Null when neither.
     */
    const pdfTerms = (booking) => {
      if (booking?.signature) {
        const accepted = booking.signature.terms;
        return accepted
          ? { version: accepted.version, at: accepted.at, url: termsUrl(accepted.version) }
          : null;
      }
      if (!state.terms.active) return null;
      return { version: state.terms.version, at: state.terms.at, url: termsUrl(state.terms.version) };
    };

    /** The handover sheet for one customer's open lines. */
    const bookingPdf = async (group) => {
      exporting.value = true;
      try {
        const first = group.lines[0] || {};
        const booking = bookingOf(group);
        await exportBookingPdf({
          kind: 'checkout',
          customerName: group.customerName,
          customerEmail: group.customerEmail,
          // The hand-over block: who handed it over, and what the customer
          // signed. Absent on a legacy line that has no booking, which then
          // prints the rule to sign on paper.
          handedOverBy: booking?.handedOverBy || '',
          signature: booking?.signature || null,
          terms: pdfTerms(booking),
          // Printed as a QR code: the sheet is the checklist the gear travels
          // with, and the code is how the customer gets from paper back to
          // their own page — to sign, or to pull the sheet again.
          bookingUrl: bookingUrl(booking),
          reference: group.reservationId ? `Reservation #${group.reservationId}` : '',
          startAt: first.checkedOut,
          endAt: group.dueAt,
          hire: group.hire,
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

    /** The quote for one customer's open lines: no values, only what it costs. */
    const rentalPdf = async (group) => {
      exporting.value = true;
      try {
        const first = group.lines[0] || {};
        await exportRentalPdf(
          group.lines.map((line) => ({
            id: line.assetId,
            qty: line.qty,
            unitNos: line.unitNos || [],
            hire: line.hire,
          })),
          state.assets,
          {
            days: group.days,
            hire: group.hire,
            kind: 'checkout',
            from: first.checkedOut,
            to: group.dueAt,
            customerName: group.customerName,
            customerEmail: group.customerEmail,
            reference: group.reservationId ? `Reservation #${group.reservationId}` : '',
            notes: first.note || '',
          },
        );
      } catch (error) {
        toast(`Could not build the rental PDF: ${error.message}`, 'danger', 8000);
      } finally {
        exporting.value = false;
      }
    };

    // --- One card, in full -------------------------------------------------
    // The overview says what is out and when it is due; everything else about
    // a hand-over — the money, the link, the documents, the signature — lives
    // in here, so the list stays readable when twenty customers are out.

    /** The group whose panel is open, by group key, or null. */
    const detailKey = ref(null);
    const detail = computed(
      () => groups.value.find((group) => group.key === detailKey.value) || null,
    );

    const openDetail = (group) => { detailKey.value = group.key; };

    /**
     * What the panel's two buttons act on: the lines ticked in it, or the
     * whole hand-over when nothing is. Opening the panel and pressing Check in
     * is the common case — a partial return is the one that needs ticking.
     */
    const detailLines = computed(() => {
      const lines = detail.value?.lines || [];
      const picked = lines.filter((line) => selected.value.includes(line.lineId));
      return picked.length ? picked : lines;
    });

    const detailUnits = computed(
      () => detailLines.value.reduce((sum, line) => sum + qtyFor(line.lineId), 0),
    );

    /** Hand the selection to the bar's own flow, so there is one check-in path. */
    const takeDetail = () => { selected.value = detailLines.value.map((line) => line.lineId); };
    const detailCheckIn = () => { takeDetail(); confirmReturn.value = true; };
    const detailExtend = () => { takeDetail(); startExtend(); };
    const closeDetail = () => { detailKey.value = null; closeSignature(); };

    /**
     * Open the card holding one booking — the id a scanned hand-over sheet
     * resolves to. The booking is the address, not the group key: a key is an
     * implementation detail of how lines are grouped here.
     */
    const showBooking = (bookingId) => {
      const id = Number(bookingId);
      const group = groups.value.find((entry) => Number(bookingOf(entry)?.id) === id);
      if (!group) {
        toast(`Booking #${id} has nothing checked out.`, 'warning');
        return false;
      }
      detailKey.value = group.key;
      return true;
    };

    // A scan can land before this view is mounted, or while it already is.
    const takePending = () => {
      if (pending.value === null) return;
      const id = pending.value;
      pending.value = null;
      showBooking(id);
    };
    onMounted(takePending);
    watch(pending, takePending);

    // --- Hand-over signature ---------------------------------------------
    // One per booking, the customer's alone. Captured here at the counter, or
    // by the customer on their own link — either way it lands in the same
    // place and shows up on the sheet, the PDF and their page.

    /** The group whose pad is open, or null. */
    const signing = ref(null);
    const signName = ref('');
    // The customer's tick against the terms in force. Reset with every pad,
    // and whenever the terms change under an open one.
    const signTerms = ref(false);
    watch(() => state.terms.version, () => { signTerms.value = false; });
    const signLocked = computed(() => (
      state.terms.active && !signTerms.value
        ? 'The customer has to accept the terms first.'
        : ''
    ));
    const signBusy = ref(false);
    const unsigning = ref(null);

    const openSignature = (group) => {
      signing.value = group.key;
      // Prefilled with who the booking is for; whoever actually signs can
      // overwrite it, which is the point of asking at all.
      signName.value = group.customerName || '';
      signTerms.value = false;
    };

    const closeSignature = () => { signing.value = null; signName.value = ''; signTerms.value = false; };

    const saveSignature = async (group, blob) => {
      const booking = bookingOf(group);
      if (!booking) return;
      signBusy.value = true;
      try {
        // The version on screen, not whatever is newest by the time this
        // lands: if the terms changed meanwhile the server says so.
        await signBooking(
          booking.id,
          signName.value.trim(),
          blob,
          state.terms.active ? state.terms.version : null,
        );
        toast('Signature stored.', 'success');
        closeSignature();
      } catch {
        /* toast already raised by the store */
      } finally {
        signBusy.value = false;
      }
    };

    const removeSignature = async () => {
      const booking = unsigning.value;
      unsigning.value = null;
      if (!booking) return;
      try {
        await unsignBooking(booking.id);
        toast('Signature removed.', 'success');
      } catch { /* toast already raised */ }
    };

    /** The stored drawing in the preview overlay, at a readable size. */
    const openSignatureImage = (booking) => {
      openPreview({
        kind: 'image',
        src: `uploads/${booking.signature.file}`,
        title: `${booking.signature.name} · ${formatDateTime(booking.signature.at)}`,
      });
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

    // --- Presentation only ---------------------------------------------------

    /** "2 units", "1 unit". */
    const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;

    /** "Oct 14, 6:00 PM" — the year only when it is not this one. */
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

    /** Overdue hand-overs first, under their own header. */
    const sections = computed(() => {
      const late = groups.value.filter((group) => isOverdue(group.dueAt));
      const out = groups.value.filter((group) => !isOverdue(group.dueAt));
      return [
        { key: 'late', title: 'Overdue', groups: late },
        { key: 'out', title: late.length ? 'Out' : 'Checked out', groups: out },
      ].filter((section) => section.groups.length);
    });

    const startExtend = () => {
      const first = state.checkouts.find((r) => selected.value.includes(r.lineId));
      extendTo.value = toLocalInput(first?.dueAt || first?.returnDate) || '';
      extending.value = true;
    };

    return {
      state, groups, sections, plural, shortWhen, selected, selectedUnits, toggle, toggleGroup, setName,
      qtyFor, setQtyFor, extending, extendTo, confirmReturn, notify,
      unitCodes, unitTitle, unitLabel, unitPicked, toggleUnitFor,
      doReturn, doExtend, startExtend, exporting, bookingPdf,
      MAX_PHOTOS, photoLine, itemFiles, itemNote, uploading, failedPhotos,
      openPhotos, closePhotos, pickItemPhotos, uploadItemPhotos,
      retryPhotos, discardPhotos,
      bookingOf, bookingUrl, copyLink, resendEmail,
      detailKey, detail, openDetail, closeDetail, showBooking,
      detailLines, detailUnits, detailCheckIn, detailExtend,
      formatDateTime, daysOverdue, isOverdue, formatTotals, emit,
      rentalPdf, daysLabel, HIRE_LABEL,
      signing, signName, signBusy, unsigning, signTerms, signLocked, termsUrl,
      openSignature, closeSignature, saveSignature, removeSignature, openSignatureImage,
    };
  },
  template: `
    <!-- The upload was refused. The files are still in memory, so they are
         offered back rather than dropped. -->
    <div v-if="failedPhotos" class="alert alert-danger d-flex align-items-center gap-2 flex-wrap">
      <i class="bi bi-exclamation-octagon"></i>
      <div class="flex-grow-1 small min-w-0">
        <strong>{{ plural(failedPhotos.files.length, 'photo') }} not stored</strong>
        · {{ failedPhotos.name }}, booking #{{ failedPhotos.bookingId }} — {{ failedPhotos.message }}
      </div>
      <button class="btn btn-sm btn-outline-secondary" @click="discardPhotos()">Discard</button>
      <button class="btn btn-sm btn-primary" :disabled="uploading" @click="retryPhotos()">
        <span v-if="uploading" class="spinner-border spinner-border-sm"></span>
        Retry
      </button>
    </div>

    <div v-if="!state.checkouts.length" class="trax-empty">
      <i class="bi bi-check2-circle"></i>
      Nothing is checked out.
    </div>

    <!-- One row per hand-over. The row opens it; the tick selects its lines. -->
    <template v-for="section in sections" :key="section.key">
      <div class="trax-list-header">
        {{ section.title }} <span class="fw-normal">{{ section.groups.length }}</span>
      </div>
      <div class="trax-list">
        <div v-for="group in section.groups" :key="group.key" class="trax-row is-tappable"
             role="button" tabindex="0"
             :aria-label="'Open the hand-over for ' + group.customerName"
             @click="openDetail(group)"
             @keydown.enter.prevent="openDetail(group)"
             @keydown.space.prevent="openDetail(group)">
          <label class="trax-tick-hit" @click.stop @keydown.stop>
            <input class="trax-check" type="checkbox"
                   :checked="group.lines.every(r => selected.includes(r.lineId))"
                   @change="toggleGroup(group)"
                   :aria-label="'Select all items out with ' + group.customerName">
          </label>
          <div class="trax-row-main">
            <div class="trax-row-title">
              <span>{{ group.customerName }}</span>
              <i v-if="bookingOf(group) && bookingOf(group).signature" class="bi bi-pen text-secondary small"
                 :title="'Signed by ' + bookingOf(group).signature.name"></i>
            </div>
            <div class="trax-row-meta">
              <span :class="{ 'text-danger': isOverdue(group.dueAt) }"
                    :title="formatDateTime(group.dueAt)">Due {{ shortWhen(group.dueAt) }}</span>
              <span>{{ plural(group.units, 'unit') }}<template v-if="group.lines.length > 1"> · {{ plural(group.lines.length, 'line') }}</template></span>
              <span class="d-none d-md-inline">{{ group.customerEmail }}</span>
              <span v-if="group.event" class="trax-kind-chip">
                <i class="bi bi-calendar-event"></i> {{ group.event.name }}
              </span>
              <span v-for="setId in [...group.setIds]" :key="setId" class="trax-kind-chip">
                <i class="bi bi-box-seam"></i> {{ setName(setId) }}
              </span>
            </div>
          </div>
          <span v-if="isOverdue(group.dueAt)" class="trax-badge status-UNAV">
            {{ daysOverdue(group.dueAt) }}d late
          </span>
          <i class="bi bi-chevron-right trax-row-chevron"></i>
        </div>
      </div>
    </template>

    <div v-if="selected.length" class="trax-selection-bar">
      <span class="trax-sel-count">{{ plural(selectedUnits, 'unit') }}</span>
      <span class="small text-secondary text-nowrap d-none d-sm-inline">{{ plural(selected.length, 'line') }}</span>
      <span class="flex-grow-1"></span>
      <button class="btn btn-sm btn-outline-secondary" @click="startExtend" aria-label="Extend">
        <i class="bi bi-calendar-plus"></i><span class="btn-label">Extend</span>
      </button>
      <button class="btn btn-sm btn-primary" @click="confirmReturn = true">
        <i class="bi bi-box-arrow-in-left"></i> Check in
      </button>
      <button class="trax-close" @click="selected = []" aria-label="Clear selection" title="Clear selection">
        <i class="bi bi-x-lg"></i>
      </button>
    </div>

    <!-- One hand-over, in full: what it is worth, what it bills, the customer's
         link, the documents and the signature. Opened from the row, and by
         booking id from a scanned hand-over sheet. -->
    <Drawer v-if="detail" wide icon="bi-box-arrow-right"
            :title="detail.customerName" @close="closeDetail">
      <template #header-actions>
        <span v-if="isOverdue(detail.dueAt)" class="trax-badge status-UNAV">
          {{ daysOverdue(detail.dueAt) }}d late
        </span>
      </template>

      <p class="text-secondary small mb-3">
        {{ detail.customerEmail }}
        <span v-if="bookingOf(detail)"> · Booking #{{ bookingOf(detail).id }}</span>
      </p>

      <!-- Internal figures (value, rental) never reach the customer's documents. -->
      <div class="trax-list">
        <div class="trax-kv">
          <span>Due</span>
          <strong :class="{ 'text-danger': isOverdue(detail.dueAt) }">{{ formatDateTime(detail.dueAt) }}</strong>
        </div>
        <div class="trax-kv">
          <span>Out</span>
          <strong>{{ plural(detail.units, 'unit') }} · {{ plural(detail.lines.length, 'line') }}</strong>
        </div>
        <div class="trax-kv">
          <span>Hire</span>
          <strong>{{ HIRE_LABEL[detail.hire] }}</strong>
        </div>
        <div v-if="detail.event" class="trax-kv">
          <span>Event</span>
          <strong>{{ detail.event.name }}</strong>
        </div>
        <div class="trax-kv">
          <span>Value
            <span v-if="detail.value.unpricedCount" class="small"> · {{ detail.value.unpricedCount }} unpriced</span>
          </span>
          <strong>{{ formatTotals(detail.value.totals) }}</strong>
        </div>
        <div class="trax-kv">
          <span>Rental · {{ daysLabel(detail.days) }}
            <span v-if="detail.rental.unratedCount" class="small"> · {{ detail.rental.unratedCount }} without rate</span>
            <span v-if="detail.rental.unpricedCount" class="small"> · {{ detail.rental.unpricedCount }} without value</span>
          </span>
          <strong>{{ formatTotals(detail.rental.totals) }}</strong>
        </div>
      </div>

      <!-- The ticks here feed the same selection the overview's bar acts on:
           what is ticked is checked in, nothing ticked means everything. -->
      <div class="trax-list-header">
        Items
        <span class="ms-auto fw-normal small">Tick to return only some</span>
      </div>
      <div class="trax-list">
        <div v-for="line in detail.lines" :key="line.lineId" class="trax-row align-items-start flex-wrap"
             :class="{ 'is-selected': selected.includes(line.lineId) }">
          <label class="trax-tick-hit mt-1">
            <input class="trax-check" type="checkbox"
                   :checked="selected.includes(line.lineId)" @change="toggle(line.lineId)"
                   :aria-label="'Select ' + line.name">
          </label>
          <div class="trax-row-main">
            <div class="trax-row-title">
              <button class="trax-name-btn text-truncate mw-100" @click="emit('open', line.assetId)">
                {{ line.name || ('#' + line.assetId) }}
              </button>
            </div>
            <div class="trax-row-meta">
              <span>×{{ line.qty }}</span>
              <span class="font-monospace">#{{ line.assetId }}</span>
              <!-- Which physical units left, when the asset tracks them. -->
              <span v-if="line.unitNos?.length" class="trax-kind-chip font-monospace"
                    :title="unitTitle(line)">{{ unitCodes(line) }}</span>
              <span v-if="line.setId" class="trax-kind-chip"><i class="bi bi-box-seam"></i> in kit</span>
            </div>

            <!-- Partial return: hand back some of the units on this line. -->
            <div v-if="selected.includes(line.lineId) && !line.unitNos?.length && line.qty > 1"
                 class="d-flex align-items-center gap-2 mt-2">
              <span class="small text-secondary">Return</span>
              <div class="input-group input-group-sm" style="width:8rem">
                <button class="btn btn-outline-secondary px-2"
                        @click="setQtyFor(line.lineId, qtyFor(line.lineId) - 1)"
                        :aria-label="'Return one fewer ' + line.name">−</button>
                <input class="form-control text-center px-0" type="number" min="1" :max="line.qty"
                       :value="qtyFor(line.lineId)"
                       @input="setQtyFor(line.lineId, $event.target.value)"
                       :aria-label="'Units of ' + line.name + ' to check in'">
                <button class="btn btn-outline-secondary px-2"
                        @click="setQtyFor(line.lineId, qtyFor(line.lineId) + 1)"
                        :aria-label="'Return one more ' + line.name">+</button>
              </div>
              <span class="small text-secondary">of {{ line.qty }}</span>
            </div>

            <!-- Partial return, unit by unit: the numbers are the quantity, so
                 a line that names them gets check boxes instead of a stepper. -->
            <div v-if="selected.includes(line.lineId) && line.unitNos?.length && line.qty > 1"
                 class="d-flex flex-wrap gap-3 mt-2">
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
          </div>

          <!-- Photos belong to one piece of gear, so they are taken per line. -->
          <button class="trax-icon-btn" @click="openPhotos(line)"
                  :title="'Condition photos'"
                  :aria-label="'Condition photos of ' + (line.name || ('#' + line.assetId))">
            <i class="bi bi-camera"></i>
          </button>
        </div>
      </div>

      <!-- Only where there is a booking to hang it on: a legacy line without
           one has nothing to sign for. -->
      <template v-if="bookingOf(detail)">
        <div class="trax-list-header">Signature</div>
        <div class="trax-list">
          <!-- What was signed for, once it has been. -->
          <div v-if="bookingOf(detail).signature" class="trax-row">
            <button type="button" class="trax-thumb-btn"
                    :aria-label="'Show the signature of ' + bookingOf(detail).signature.name"
                    @click="openSignatureImage(bookingOf(detail))">
              <img class="trax-sig-thumb" :src="'uploads/thumb/' + bookingOf(detail).signature.file"
                   alt="">
            </button>
            <div class="trax-row-main">
              <div class="trax-row-title"><span>{{ bookingOf(detail).signature.name }}</span></div>
              <div class="trax-row-meta">
                <span>{{ shortWhen(bookingOf(detail).signature.at) }}</span>
                <span>{{ bookingOf(detail).signature.source === 'CUSTOMER' ? 'via booking link' : 'at the counter' }}</span>
                <span v-if="bookingOf(detail).handedOverBy">by {{ bookingOf(detail).handedOverBy }}</span>
                <a v-if="bookingOf(detail).signature.terms"
                   :href="termsUrl(bookingOf(detail).signature.terms.version)" target="_blank"
                   rel="noopener noreferrer">Terms v{{ bookingOf(detail).signature.terms.version }}</a>
              </div>
            </div>
            <button class="trax-icon-btn text-danger" title="Remove signature"
                    :aria-label="'Remove the signature of ' + bookingOf(detail).signature.name"
                    @click="unsigning = bookingOf(detail)">
              <i class="bi bi-trash"></i>
            </button>
          </div>

          <div v-else-if="signing !== detail.key" class="trax-row">
            <i class="bi bi-pen text-secondary"></i>
            <div class="trax-row-main">
              <div class="trax-row-title"><span>Not signed</span></div>
              <div class="trax-row-meta">Or via the booking link</div>
            </div>
            <button class="btn btn-sm btn-outline-primary"
                    :aria-label="'Take a hand-over signature from ' + detail.customerName"
                    @click="openSignature(detail)">
              Sign now
            </button>
          </div>

          <!-- The pad: hand the tablet over, done. -->
          <div v-else class="p-3">
            <label class="form-label" :for="'sig-name-' + detail.key">Signed by</label>
            <input class="form-control form-control-sm mb-2" :id="'sig-name-' + detail.key"
                   v-model="signName" maxlength="200" placeholder="Name in block letters">
            <SignaturePad :busy="signBusy" :locked="signLocked"
                          @submit="saveSignature(detail, $event)" @cancel="closeSignature" />
            <!-- The tick is the customer's, on the same screen they sign on; the
                 version it was given for goes to the server with the drawing. -->
            <div v-if="state.terms.active" class="form-check mt-2">
              <input class="form-check-input" type="checkbox" :id="'sig-terms-' + detail.key"
                     v-model="signTerms">
              <label class="form-check-label small" :for="'sig-terms-' + detail.key">
                I accept the
                <a :href="termsUrl()" target="_blank" rel="noopener noreferrer">terms &amp; conditions</a>
                (v{{ state.terms.version }}, {{ shortWhen(state.terms.at) }}).
              </label>
            </div>
            <p class="form-text mb-0">
              Confirms receipt of the listed items<span v-if="state.terms.active"> and the terms</span>.
            </p>
          </div>
        </div>
      </template>

      <!-- The same two actions as the overview's bar, on this hand-over: what
           is ticked here, or the whole booking when nothing is. -->
      <template #footer>
        <Menu up align="start" label="Documents and sharing" icon="bi-three-dots"
              button-class="trax-icon-btn">
          <button class="trax-menu-item" :disabled="exporting" @click="bookingPdf(detail)"
                  :aria-label="'Handover PDF for ' + detail.customerName">
            <i class="bi bi-filetype-pdf"></i> Handover PDF
          </button>
          <button class="trax-menu-item" :disabled="exporting" @click="rentalPdf(detail)"
                  :aria-label="'Rental quote PDF for ' + detail.customerName">
            <i class="bi bi-receipt"></i> Rental quote PDF
          </button>
          <template v-if="bookingOf(detail)">
            <div class="trax-menu-sep"></div>
            <button class="trax-menu-item" @click="copyLink(detail)"
                    :aria-label="'Copy the booking link for ' + detail.customerName">
              <i class="bi bi-link-45deg"></i> Copy booking link
            </button>
            <button class="trax-menu-item" :disabled="state.loading" @click="resendEmail(detail)"
                    :aria-label="'Re-send the confirmation to ' + detail.customerEmail">
              <i class="bi bi-envelope"></i> Resend confirmation
            </button>
          </template>
        </Menu>
        <span class="small text-secondary text-nowrap" :title="plural(detailLines.length, 'line')">
          {{ plural(detailUnits, 'unit') }}
        </span>
        <span class="flex-grow-1"></span>
        <button class="btn btn-outline-secondary" @click="detailExtend">
          <i class="bi bi-calendar-plus"></i> Extend
        </button>
        <button class="btn btn-primary" @click="detailCheckIn">
          <i class="bi bi-box-arrow-in-left"></i> Check in
        </button>
      </template>
    </Drawer>

    <ConfirmDialog v-if="unsigning"
                   title="Remove signature?"
                   :message="'Deletes the signature of ' + unsigning.signature.name + '. The booking can be signed again.'"
                   confirm-label="Remove" danger
                   @confirm="removeSignature" @cancel="unsigning = null" />

    <ConfirmDialog v-if="confirmReturn"
                   title="Check in?"
                   :message="plural(selectedUnits, 'unit') + ' on ' + plural(selected.length, 'line') + ' will be marked returned.'"
                   confirm-label="Check in"
                   @confirm="doReturn" @cancel="confirmReturn = false">
      <div class="form-check form-switch mt-3 mb-0">
        <input class="form-check-input" type="checkbox" role="switch" id="notify-return" v-model="notify">
        <label class="form-check-label small ms-1" for="notify-return">Email the customer</label>
      </div>
    </ConfirmDialog>

    <!-- One item, one batch. capture="environment" so a phone opens the rear
         camera directly: this is somebody standing at the counter with it. -->
    <ConfirmDialog v-if="photoLine"
                   title="Condition photos"
                   :message="(photoLine.name || ('#' + photoLine.assetId)) + ' · up to ' + MAX_PHOTOS + ' at once'"
                   confirm-label="Upload"
                   @confirm="uploadItemPhotos" @cancel="closePhotos()">
      <div class="mt-3">
        <input id="item-photos" class="form-control form-control-sm" type="file"
               multiple accept="image/*" capture="environment" aria-label="Photos"
               @change="pickItemPhotos">
        <div v-if="itemFiles.length" class="small text-secondary mt-2">
          <i class="bi bi-camera"></i> {{ plural(itemFiles.length, 'photo') }} ready
        </div>
        <input class="form-control form-control-sm mt-2"
               v-model="itemNote" aria-label="Comment on these photos"
               placeholder="What is damaged?">
      </div>
    </ConfirmDialog>

    <ConfirmDialog v-if="extending"
                   title="Extend"
                   confirm-label="Extend"
                   @confirm="doExtend" @cancel="extending = false">
      <label class="form-label mt-2" for="extend-to">New return date</label>
      <input id="extend-to" type="datetime-local" class="form-control form-control-sm"
             v-model="extendTo" data-autofocus>
    </ConfirmDialog>
  `,
};
