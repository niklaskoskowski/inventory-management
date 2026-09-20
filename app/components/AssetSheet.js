import { ref, computed, watch } from 'vue';
import {
  state, getAsset, getLines, historyFor, membersOf, mutate, uploadPhoto,
  uploadConditionPhotos, uploadDocuments, deleteDocument, toast,
  categories, locations, openPreview, openAssetPhoto,
  recordInspection, uploadInspectionCertificate, deleteInspection,
} from '../store.js';
import {
  STATUSES, CONDITIONS, CONDITION_LABEL, conditionSummary, statusLabel,
  formatDate, formatDateTime, formatMoney, toDateInput, isOverdue,
  addMonths, warrantyUntilOf, unitPriceOf,
} from '../lib/format.js';
import {
  BLANK_OVERRIDE, daysLabel, formatPercent, priceBasis, rentalOfUnit, ruleFor, tierFor,
} from '../lib/rental.js';
import {
  RESULTS, RESULT_LABEL, STATE_CLASS, STATE_LABEL,
  assetState, blankRecord, inspectionRows, inspectionRule, needsAttention,
  nextDueFrom, recordSummary, recordsOf,
} from '../lib/inspection.js';
import { exportInspectionPdf } from '../lib/pdf.js';
import Drawer from './ui/Drawer.js';
import StatusBadge from './ui/StatusBadge.js';
import ConfirmDialog from './ui/ConfirmDialog.js';
import RentalRate from './RentalRate.js';

const BLANK = {
  name: '', status: 'FREE', notes: '', category: '', location: '',
  serial: '', supplier: '', purchasedAt: '', price: '', currency: 'EUR',
  warrantyUntil: '', condition: 'GOOD', tags: '', quantity: 1,
};

/**
 * One stored unit as an editable row.
 *
 * The two dates come back from the server as `YYYY-MM-DD` or null, and a null
 * in a `<input type="date">` renders as the string "null" — so they go through
 * toDateInput() exactly like the asset's own dates on the details form.
 */
const unitRow = (unit) => ({
  ...unit,
  purchasedAt: toDateInput(unit.purchasedAt),
  warrantyUntil: toDateInput(unit.warrantyUntil),
});

/**
 * The hire rates of an asset and of each of its units, as an editable draft.
 *
 * Only the rates: the Rental tab never edits a label, a serial or a price, and
 * carrying them would put a second writer on the unit list.
 */
const rentalDraft = (asset) => ({
  rental: { ...BLANK_OVERRIDE, ...(asset?.rental || {}) },
  units: (asset?.units || []).map((unit) => ({
    no: unit.no,
    rental: { ...BLANK_OVERRIDE, ...(unit.rental || {}) },
  })),
});

/** An empty rate box is "not set on this one", never zero. */
const cleanOverride = (rule) => ({
  mode: rule?.mode || 'INHERIT',
  percent: rule?.percent === '' || rule?.percent === undefined ? null : rule.percent,
  fixed: rule?.fixed === '' || rule?.fixed === undefined ? null : rule.fixed,
  fixedPer: rule?.fixedPer || 'RENTAL',
});

/** Create/edit one asset, plus its live state and history. */
export default {
  name: 'AssetSheet',
  components: { Drawer, StatusBadge, ConfirmDialog, RentalRate },
  props: {
    assetId: { type: Number, default: null },
  },
  emits: ['close', 'label', 'open'],
  setup(props, { emit }) {
    const form = ref({ ...BLANK });
    const saving = ref(false);
    const confirmDelete = ref(false);
    const fileInput = ref(null);
    const tab = ref('details');

    // The asset's own condition log — its history as a physical object, which
    // it has whether it is out with somebody or sitting on the shelf.
    // Mirrors TRAX_MAX_PHOTOS_PER_BATCH, so an over-large pick is caught here
    // rather than after the server refuses the whole batch.
    const MAX_PHOTOS = 8;
    const conditionFiles = ref([]);
    const conditionNote = ref('');
    const conditionBusy = ref(false);

    // Manuals, receipts, insurance certificates. Mirrors
    // TRAX_MAX_DOCS_PER_BATCH so an over-large pick is caught before the
    // request, and TRAX_MAX_ASSET_DOCUMENTS so the list cap is visible.
    const MAX_DOCS = 8;
    const MAX_ASSET_DOCS = 20;
    const docFiles = ref([]);
    const docTitle = ref('');
    const docBusy = ref(false);

    // Per-unit tracking ("Exemplare"). The rows are edited locally and saved
    // as one patch of their own, so the details form never carries them and
    // can never clobber them.
    const unitsForm = ref([]);
    const unitsDirty = ref(false);
    // Which asset unitsForm was built for, so an unsaved edit cannot follow
    // the sheet onto the next asset.
    const unitsFor = ref(null);

    // The hire rates, edited as their own draft for the same reason the units
    // are: the Rental tab owns them and saves them on its own, so the details
    // form can never carry — or clobber — a rate.
    const rentalForm = ref({ rental: { ...BLANK_OVERRIDE }, units: [] });
    const rentalDirty = ref(false);
    const rentalFor = ref(null);

    const asset = computed(() => (props.assetId ? getAsset(props.assetId) : null));
    const isNew = computed(() => !props.assetId);
    const isSet = computed(() => asset.value?.kind === 'SET');
    // Quantity is derived server-side once units are tracked.
    const hasUnits = computed(() => !!asset.value?.units?.length);
    // Once a single unit carries a price the sum of them IS the asset's price,
    // and the stored `price` underneath is neither shown nor written.
    const unitPriced = computed(() => !!asset.value?.unitPriced);
    // Several people can hold units of the same asset now, so this is a list.
    const lines = computed(() => (props.assetId ? getLines(props.assetId) : []));
    const outUnits = computed(() =>
      lines.value.reduce((sum, line) => sum + Math.max(1, Number(line.qty) || 1), 0),
    );
    const history = computed(() => (props.assetId ? historyFor(props.assetId) : []));
    const members = computed(() => membersOf(asset.value));
    // Newest first: what the thing looks like now is the interesting end.
    const conditionLog = computed(() => [...(asset.value?.conditionLog || [])].reverse());
    // Newest first as well: the receipt attached last is the one being looked for.
    const documents = computed(() => [...(asset.value?.documents || [])].reverse());

    // The date that matters is the units' once they carry their own: the
    // NEXT warranty to lapse, not the asset's own field underneath.
    const warrantyExpired = computed(() => {
      const until = warrantyUntilOf(asset.value);
      return until ? isOverdue(until) : false;
    });

    // Which units have run out, not just the earliest one: the operator is
    // about to decide what to do with each of them by name.
    const expiredUnits = computed(() => {
      if (!asset.value?.unitDated) return [];
      return (asset.value.units || [])
        .filter((unit) => unit.warrantyUntil && isOverdue(unit.warrantyUntil))
        .map((unit) => unitCode(unit));
    });

    watch(
      asset,
      (value) => {
        // A pick made for one asset must not follow the sheet to the next one.
        conditionFiles.value = [];
        conditionNote.value = '';
        docFiles.value = [];
        docTitle.value = '';
        form.value = value
          ? {
              name: value.name,
              status: value.status,
              notes: value.notes,
              category: value.category,
              location: value.location,
              serial: value.serial,
              supplier: value.supplier,
              purchasedAt: toDateInput(value.purchasedAt),
              price: value.price ?? '',
              currency: value.currency,
              warrantyUntil: toDateInput(value.warrantyUntil),
              condition: value.condition,
              tags: (value.tags || []).join(', '),
              quantity: value.quantity ?? 1,
            }
          : { ...BLANK };
        // Keep an unsaved unit edit across a snapshot refresh, but never
        // across a switch to another asset.
        if (!unitsDirty.value || unitsFor.value !== (value?.id ?? null)) {
          unitsForm.value = (value?.units || []).map(unitRow);
          unitsDirty.value = false;
        }
        unitsFor.value = value?.id ?? null;

        // Same rule for the rates: an unsaved edit survives a snapshot
        // refresh, never a switch to another asset.
        if (!rentalDirty.value || rentalFor.value !== (value?.id ?? null)) {
          rentalForm.value = rentalDraft(value);
          rentalDirty.value = false;
        }
        rentalFor.value = value?.id ?? null;
      },
      { immediate: true },
    );

    // --- Warranty auto-fill --------------------------------------------
    // Most gear carries the same warranty, so the date is derived from the
    // purchase date and only touched by hand when it is longer.
    const warrantyMonths = computed(() =>
      Math.max(0, Number(state.settings?.defaults?.warrantyMonths ?? 0) || 0),
    );
    // What the last auto-fill wrote, so a later purchase date may replace its
    // own answer but never a date the operator typed.
    const lastAutoWarranty = ref('');
    const autoWarranty = computed(() =>
      (warrantyMonths.value ? addMonths(form.value.purchasedAt, warrantyMonths.value) : ''),
    );
    const warrantyIsAuto = computed(() =>
      !!autoWarranty.value && form.value.warrantyUntil === autoWarranty.value,
    );

    watch(() => form.value.purchasedAt, (next, prev) => {
      // The watcher also fires when watch(asset) rebuilds `form` — on open and
      // on every snapshot refresh. A form that still matches the stored record
      // was not edited by anyone, so opening an asset changes nothing.
      if (
        next === toDateInput(asset.value?.purchasedAt || '')
        && form.value.warrantyUntil === toDateInput(asset.value?.warrantyUntil || '')
      ) {
        lastAutoWarranty.value = '';
        return;
      }

      const current = form.value.warrantyUntil;
      const months = warrantyMonths.value;

      if (!next) {
        // Purchase date cleared: take back our own answer, leave a typed one.
        if (current && current === lastAutoWarranty.value) {
          form.value.warrantyUntil = '';
          lastAutoWarranty.value = '';
        }
        return;
      }
      if (!months) return;

      const fromPrev = prev ? addMonths(prev, months) : '';
      if (current === '' || current === lastAutoWarranty.value || (fromPrev && current === fromPrev)) {
        const auto = addMonths(next, months);
        form.value.warrantyUntil = auto;
        lastAutoWarranty.value = auto;
      }
    });

    // The details Price box reads the derived total once the units are priced.
    // It is disabled then, so the setter only ever runs for the plain case.
    const priceField = computed({
      get: () => (unitPriced.value
        ? Number(asset.value.priceTotal ?? 0).toFixed(2)
        : form.value.price),
      set: (value) => { form.value.price = value; },
    });

    /** "2× Good, 1× Blocked" — what stands in for the asset's own grade. */
    const unitConditions = computed(() => conditionSummary(asset.value));

    // `form` deliberately has no `units` key: saving the details must never
    // rewrite the unit list, which the Units tab owns.
    const patch = () => {
      const out = {
        ...form.value,
        // A kit has no quantity of its own; the server pins it to 1 anyway.
        quantity: isSet.value ? undefined : Math.max(1, Number(form.value.quantity) || 1),
        price: form.value.price === '' ? null : form.value.price,
        purchasedAt: form.value.purchasedAt || null,
        warrantyUntil: form.value.warrantyUntil || null,
        tags: form.value.tags
          ? form.value.tags.split(',').map((t) => t.trim()).filter(Boolean)
          : [],
      };
      // Neither field is on the form once units take it over, so neither is
      // sent: the server writes only the keys a patch carries, and dropping
      // them is what leaves the stored values untouched instead of blanking
      // them with what the hidden control happened to hold.
      if (unitPriced.value) delete out.price;
      if (hasUnits.value) {
        delete out.condition;
        delete out.purchasedAt;
        delete out.warrantyUntil;
      }
      return out;
    };

    const save = async () => {
      if (!form.value.name.trim()) {
        toast('An asset needs a name.', 'warning');
        return;
      }
      saving.value = true;
      try {
        if (isNew.value) {
          const data = await mutate('asset.create', { patch: patch() });
          toast(`Created "${form.value.name}".`, 'success');
          emit('open', data.newId);
        } else if (isSet.value) {
          await mutate('set.update', { id: props.assetId, patch: patch() });
          toast('Kit saved.', 'success');
          emit('close');
        } else {
          await mutate('asset.update', { id: props.assetId, patch: patch() });
          toast('Saved.', 'success');
          emit('close');
        }
      } catch {
        /* toast already raised by the store */
      } finally {
        saving.value = false;
      }
    };

    const remove = async () => {
      confirmDelete.value = false;
      try {
        await mutate(isSet.value ? 'set.delete' : 'asset.delete', { id: props.assetId });
        toast(isSet.value ? 'Kit deleted. Its items were kept.' : 'Asset deleted.', 'success');
        emit('close');
      } catch {
        /* toast already raised */
      }
    };

    const onPhotoPicked = async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        await uploadPhoto(props.assetId, file);
        toast('Photo uploaded.', 'success');
      } catch {
        /* toast already raised */
      } finally {
        event.target.value = '';
      }
    };

    const removePhoto = async () => {
      try {
        await mutate('asset.deletePhoto', { id: props.assetId });
        toast('Photo removed.', 'success');
      } catch { /* toast already raised */ }
    };

    const pickConditionPhotos = (event) => {
      const files = [...(event?.target?.files || [])];
      if (files.length > MAX_PHOTOS) {
        toast(
          `Up to ${MAX_PHOTOS} photos can be uploaded at once — ${files.length} were picked.`,
          'warning',
        );
        conditionFiles.value = [];
        if (event?.target) event.target.value = '';
        return;
      }
      conditionFiles.value = files;
    };

    const clearConditionPick = () => {
      conditionFiles.value = [];
      conditionNote.value = '';
      const input = document.getElementById('f-condition-photos');
      if (input) input.value = '';
    };

    /** One all-or-nothing batch onto this asset's log, with one comment. */
    const sendConditionPhotos = async () => {
      const files = [...conditionFiles.value];
      if (!files.length) {
        toast('Pick at least one photo.', 'warning');
        return;
      }
      conditionBusy.value = true;
      try {
        await uploadConditionPhotos(props.assetId, files, conditionNote.value);
        toast(`${files.length} condition photo(s) added.`, 'success');
        clearConditionPick();
      } catch {
        // toast already raised, and the pick is kept so it can be retried
      } finally {
        conditionBusy.value = false;
      }
    };

    const removeConditionPhoto = async (file) => {
      try {
        await mutate('asset.deleteConditionPhoto', { id: props.assetId, file });
        toast('Condition photo removed.', 'success');
      } catch { /* toast already raised */ }
    };

    const pickDocuments = (event) => {
      const files = [...(event?.target?.files || [])];
      if (files.length > MAX_DOCS) {
        toast(
          `Up to ${MAX_DOCS} documents can be uploaded at once — ${files.length} were picked.`,
          'warning',
        );
        docFiles.value = [];
        if (event?.target) event.target.value = '';
        return;
      }
      docFiles.value = files;
    };

    const clearDocPick = () => {
      docFiles.value = [];
      docTitle.value = '';
      const input = document.getElementById('f-documents');
      if (input) input.value = '';
    };

    /** One all-or-nothing batch onto this asset, under one label. */
    const sendDocuments = async () => {
      const files = [...docFiles.value];
      if (!files.length) {
        toast('Pick at least one file.', 'warning');
        return;
      }
      docBusy.value = true;
      try {
        await uploadDocuments(props.assetId, files, docTitle.value);
        toast(`${files.length} document(s) attached.`, 'success');
        clearDocPick();
      } catch {
        // toast already raised, and the pick is kept so it can be retried
      } finally {
        docBusy.value = false;
      }
    };

    const removeDocument = async (file) => {
      try {
        await deleteDocument(props.assetId, file);
        toast('Document removed.', 'success');
      } catch { /* toast already raised */ }
    };

    /** Bytes as an operator reads them. 1 kB = 1024 B, one decimal from MB up. */
    const formatSize = (bytes) => {
      const n = Number(bytes) || 0;
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
      return `${(n / 1024 / 1024).toFixed(1)} MB`;
    };

    /**
     * The condition log as one gallery, opened at the photo that was clicked.
     *
     * The thumbs are `uploads/thumb/<file>`; the preview is the stored original.
     * The caption is the date the shot was taken plus whatever the operator
     * wrote about it, which is the only thing telling two dents apart.
     */
    const openConditionPhoto = (file) => {
      const items = conditionLog.value.map((shot) => ({
        kind: 'image',
        src: `uploads/${shot.file}`,
        title: [formatDateTime(shot.at), shot.note].filter(Boolean).join(' — '),
      }));
      const index = conditionLog.value.findIndex((shot) => shot.file === file);
      openPreview({ items, index: index < 0 ? 0 : index });
    };

    /**
     * A document in the overlay.
     *
     * What can be shown is decided by the extension WE chose when it was
     * stored, never by anything the client said — the same rule download.php
     * serves the bytes under. Anything else is a card with a download button.
     * `inline=1` is what makes download.php send `Content-Disposition: inline`;
     * the plain URL stays an attachment and is what "Download" uses.
     */
    const openDocument = (doc) => {
      const href = `download.php?file=${encodeURIComponent(doc.file)}`;
      const ext = String(doc.file || '').split('.').pop().toLowerCase();
      const kind = ext === 'pdf' ? 'pdf'
        : (['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? 'image' : 'file');
      openPreview({
        kind,
        src: kind === 'file' ? href : `${href}&inline=1`,
        downloadHref: href,
        title: doc.title || doc.name || doc.file,
        size: doc.size,
      });
    };

    const blankUnit = () => ({
      no: null, label: '', serial: '', price: null,
      condition: form.value.condition || 'GOOD', outOfService: false, note: '',
      purchasedAt: '', warrantyUntil: '',
    });

    /** "12.1" — the code that goes on this unit's own label. */
    const unitCode = (unit) => `${props.assetId}.${unit.no ? unit.no : '\u2013'}`;
    const unitDetail = (unit) =>
      `${unit.customerName || 'out'} \u00b7 due ${formatDate(unit.dueAt)}`;

    const touchUnits = () => { unitsDirty.value = true; };

    // --- Per-unit warranty auto-fill ------------------------------------
    // The asset-level rule again, once per row. Keyed by the row object, so
    // removing or re-ordering a row cannot make one unit inherit another
    // unit's last auto-fill; a dropped row takes its entry with it.
    const unitLastAuto = new WeakMap();

    const unitAutoWarranty = (unit) =>
      (warrantyMonths.value ? addMonths(unit.purchasedAt, warrantyMonths.value) : '');
    const unitWarrantyIsAuto = (unit) => {
      const auto = unitAutoWarranty(unit);
      return !!auto && unit.warrantyUntil === auto;
    };

    /**
     * A row's purchase date changed: derive its warranty unless it was typed.
     *
     * The input is bound by hand rather than with v-model precisely so that
     * `unit.purchasedAt` is still the PREVIOUS date here — which is what tells
     * "the operator typed this warranty" from "we wrote it last time".
     */
    const onUnitPurchased = (unit, next) => {
      const prev = unit.purchasedAt || '';
      unit.purchasedAt = next;
      touchUnits();

      const current = unit.warrantyUntil || '';
      const months = warrantyMonths.value;

      if (!next) {
        // Purchase date cleared: take back our own answer, leave a typed one.
        if (current && current === unitLastAuto.get(unit)) {
          unit.warrantyUntil = '';
          unitLastAuto.delete(unit);
        }
        return;
      }
      if (!months) return;

      const fromPrev = prev ? addMonths(prev, months) : '';
      if (current === '' || current === unitLastAuto.get(unit) || (fromPrev && current === fromPrev)) {
        const auto = addMonths(next, months);
        unit.warrantyUntil = auto;
        unitLastAuto.set(unit, auto);
      }
    };

    /**
     * Turn a plain quantity into that many blank, editable units.
     *
     * The asset's own condition and dates are copied down onto every row:
     * until somebody says otherwise the pieces were all bought together, and
     * the record would otherwise lose its purchase date the moment it starts
     * tracking units, which then answer for it.
     */
    const trackUnits = () => {
      const count = Math.max(1, Number(asset.value?.quantity) || 1);
      unitsForm.value = Array.from({ length: count }, () => ({
        ...blankUnit(),
        purchasedAt: form.value.purchasedAt || '',
        warrantyUntil: form.value.warrantyUntil || '',
      }));
      unitsDirty.value = true;
    };

    const addUnit = () => {
      unitsForm.value.push(blankUnit());
      unitsDirty.value = true;
    };

    const removeUnit = (index) => {
      unitsForm.value.splice(index, 1);
      unitsDirty.value = true;
    };

    /** Only the nine stored keys go back; `state`, `lineId` &c. are derived. */
    const saveUnits = async () => {
      saving.value = true;
      try {
        const units = unitsForm.value.map((unit) => ({
          no: unit.no || null,
          label: unit.label || '',
          serial: unit.serial || '',
          // An emptied box is "no price on this one", not zero.
          price: unit.price === '' || unit.price === undefined ? null : unit.price,
          condition: unit.condition || 'GOOD',
          // An empty box is "no date on this one", the same null the asset's
          // own dates are cleared to.
          purchasedAt: unit.purchasedAt || null,
          warrantyUntil: unit.warrantyUntil || null,
          outOfService: !!unit.outOfService,
          note: unit.note || '',
          // Carried through untouched. The server writes a unit whole, so a
          // patch that left this out would silently reset the unit's hire rate
          // to "inherit" every time somebody renamed it.
          rental: cleanOverride(unit.rental),
        }));
        await mutate('asset.update', { id: props.assetId, patch: { units } });
        toast('Units saved.', 'success');
        unitsDirty.value = false;
        // The server assigns the numbers, so take the list back from it.
        unitsForm.value = (asset.value?.units || []).map(unitRow);
      } catch {
        /* toast already raised by the store */
      } finally {
        saving.value = false;
      }
    };

    // --- Rental rates ---------------------------------------------------
    // What this gear costs to HIRE, as opposed to what it is worth. The rate
    // is resolved — unit, then asset, then category, then the install default
    // (app/lib/rental.js) — so this tab shows what is in force and lets the
    // two bottom levels be overruled.

    const rentalDays = ref(Math.max(1, Number(state.settings?.defaults?.loanDays) || 7));

    const touchRental = () => { rentalDirty.value = true; };

    /** The asset as the DRAFT has it, so the preview follows the boxes. */
    const rentalAsset = computed(() => ({ ...(asset.value || {}), rental: rentalForm.value.rental }));

    /** The stored unit with the draft's rate on it. */
    const rentalUnitAt = (index) => ({
      ...(asset.value?.units?.[index] || {}),
      rental: rentalForm.value.units[index]?.rental || { ...BLANK_OVERRIDE },
    });

    const rentalCurrency = computed(() => asset.value?.currency || 'EUR');

    /** The rule underneath this asset: its category's, or the install's. */
    const categoryRate = computed(() => ruleFor(state.settings, asset.value?.category));

    const categoryRateText = computed(() => {
      const { rule, source } = categoryRate.value;
      const name = source === 'category'
        ? `Category "${asset.value?.category}"`
        : 'Default rate';
      if (rule.mode === 'FIXED') {
        return `${name}: ${formatMoney(rule.fixed, rentalCurrency.value)}`
          + (rule.fixedPer === 'DAY' ? ' per day' : ' per rental');
      }
      const ladder = (rule.tiers || [])
        .map((tier) => `from ${tier.days} days ${formatPercent(tier.percent)} %`)
        .join(', ');
      return `${name}: ${formatPercent(rule.percent)} %/day`
        + (ladder ? ` · discounts: ${ladder}` : ' · no discounts');
    });

    /** The step that would apply to the previewed duration, for the hint. */
    const activeTier = computed(() => tierFor(categoryRate.value.rule.tiers, rentalDays.value));

    const pricedFor = (unit) => rentalOfUnit(
      rentalAsset.value,
      unit,
      state.settings,
      Math.max(1, Number(rentalDays.value) || 1),
    );

    /** "3 %/day · 210.00 for 7 days" — what this rate actually charges. */
    const rateText = (unit) => {
      const days = Math.max(1, Number(rentalDays.value) || 1);
      const priced = pricedFor(unit);
      const money = formatMoney(priced.amount, rentalCurrency.value);
      if (priced.resolved.mode === 'FIXED') {
        return priced.resolved.fixedPer === 'DAY'
          ? `${formatMoney(priced.resolved.fixed, rentalCurrency.value)}/day · ${money} for ${daysLabel(days)}`
          : `${money} · fixed, whatever the duration`;
      }
      if (priced.unpriced) {
        return `${formatPercent(priced.rate)} %/day · no value recorded, so no price`;
      }
      return `${formatPercent(priced.rate)} %/day · ${money} for ${daysLabel(days)}`;
    };

    const RATE_SOURCE = {
      unit: 'this unit', asset: 'this asset', category: 'category', default: 'default rate',
    };

    const rateSource = (unit) => RATE_SOURCE[pricedFor(unit).resolved.source] || '';

    /**
     * What a unit's rate is worked out from.
     *
     * A unit with no price of its own is not necessarily priceless: unless the
     * asset prices its units one by one, the asset's own value still answers
     * for it — and printing "no value" beside a rate that plainly produced a
     * number would read as a bug.
     */
    const unitValueText = (index) => {
      const unit = asset.value?.units?.[index];
      if (unit && unit.price !== null && unit.price !== undefined) {
        return formatMoney(unit.price, rentalCurrency.value);
      }
      const fallback = priceBasis(rentalAsset.value, unit || null);
      return fallback === null
        ? '— no value'
        : `${formatMoney(fallback, rentalCurrency.value)} · from the asset`;
    };

    /**
     * The rates, as one patch.
     *
     * The units go back WHOLE — the server writes a unit as a complete record —
     * so they are rebuilt from what is stored with only the rate replaced. An
     * unsaved edit in the Units tab is therefore not picked up here, and, more
     * importantly, not lost either.
     */
    const saveRental = async () => {
      saving.value = true;
      try {
        const patch = { rental: cleanOverride(rentalForm.value.rental) };
        if ((asset.value?.units || []).length) {
          patch.units = asset.value.units.map((unit, index) => ({
            ...unit,
            rental: cleanOverride(rentalForm.value.units[index]?.rental),
          }));
        }
        await mutate('asset.update', { id: props.assetId, patch });
        toast('Rental rates saved.', 'success');
        rentalDirty.value = false;
        rentalForm.value = rentalDraft(asset.value);
      } catch {
        /* toast already raised by the store */
      } finally {
        saving.value = false;
      }
    };

    // --- Inspections ------------------------------------------------------
    // The test record for this piece of gear: when, by whom, passed or not,
    // what was measured, and the certificate. Switched on by the asset's
    // CATEGORY (Settings -> Inspections) — nothing is asked of the rest.

    const testRule = computed(() => inspectionRule(state.settings, asset.value?.category));
    const testEnabled = computed(() => testRule.value !== null);
    const testRecords = computed(() => recordsOf(asset.value));
    const testRows = computed(() => (asset.value ? inspectionRows(asset.value) : []));
    const testState = computed(() => (asset.value ? assetState(asset.value) : 'OK'));
    /** Records filed against the whole asset although it tracks units now. */
    const testLoose = computed(() => (
      (asset.value?.units || []).length
        ? testRecords.value.filter((record) => record.unitNo === null || record.unitNo === undefined)
        : []
    ));

    // The open form, or null. `testFor` is the row it belongs to, so the panel
    // appears under the piece it is about rather than floating at the top.
    const testForm = ref(null);
    const testFor = ref(null);
    const testFile = ref(null);
    const testBusy = ref(false);
    const testConfirm = ref(null);

    const openTest = (row) => {
      testFor.value = row.code;
      testFile.value = null;
      testForm.value = blankRecord(testRule.value, {
        unitNo: row.unitNo,
        by: state.meta?.actor || '',
      });
    };

    const closeTest = () => {
      testFor.value = null;
      testForm.value = null;
      testFile.value = null;
      const input = document.getElementById('f-test-file');
      if (input) input.value = '';
    };

    /**
     * Re-derives the next test date while the test date is being typed, but
     * only while it still matches what the interval said — a date somebody
     * typed themselves is never moved.
     */
    const onTestDate = (next) => {
      const previous = testForm.value.at;
      const derived = nextDueFrom(previous, testRule.value?.intervalMonths);
      testForm.value.at = next;
      if (!testForm.value.nextAt || testForm.value.nextAt === derived) {
        testForm.value.nextAt = nextDueFrom(next, testRule.value?.intervalMonths);
      }
    };

    /**
     * A failure does not start a new validity period.
     *
     * The interval says how long a PASS is good for, so the prefilled next
     * date is taken back when the result is switched to failed — and put back
     * if it is switched round again. A date typed by hand is left alone
     * either way: "re-test by" is a real thing to write on a failure.
     */
    const onTestResult = (next) => {
      const derived = nextDueFrom(testForm.value.at, testRule.value?.intervalMonths);
      if (next === 'FAIL' && testForm.value.nextAt === derived) {
        testForm.value.nextAt = '';
      } else if (next === 'PASS' && !testForm.value.nextAt) {
        testForm.value.nextAt = derived;
      }
      testForm.value.result = next;
    };

    const pickTestFile = (event) => {
      testFile.value = event?.target?.files?.[0] || null;
    };

    /**
     * Files the record, then attaches the certificate to it.
     *
     * Two calls on purpose: a record that is written stays written even if the
     * upload then fails, and the operator is told which half did not happen
     * rather than losing the test they just typed in.
     */
    const submitTest = async () => {
      if (!testForm.value?.at) {
        toast('A test record needs the date it was done.', 'warning');
        return;
      }
      testBusy.value = true;
      try {
        const data = await recordInspection(props.assetId, {
          unitNo: testForm.value.unitNo,
          at: testForm.value.at,
          result: testForm.value.result,
          by: testForm.value.by,
          label: testForm.value.label,
          nextAt: testForm.value.nextAt || null,
          note: testForm.value.note,
          // Only what was actually filled in — an empty box is not a reading.
          values: (testForm.value.values || []).filter((row) => String(row.value || '').trim() !== ''),
        });

        const file = testFile.value;
        if (file && data?.inspectionId) {
          try {
            await uploadInspectionCertificate(props.assetId, data.inspectionId, file);
            toast('Test recorded, certificate attached.', 'success');
          } catch {
            // The record survived; say so, or it looks like nothing was saved.
            toast('Test recorded, but the certificate could not be stored. Attach it again.', 'warning', 8000);
          }
        } else {
          toast('Test recorded.', 'success');
        }
        closeTest();
      } catch {
        /* toast already raised by the store */
      } finally {
        testBusy.value = false;
      }
    };

    /** Attaches or replaces the certificate on a record that already exists. */
    const attachCertificate = async (record, event) => {
      const file = event?.target?.files?.[0];
      if (event?.target) event.target.value = '';
      if (!file) return;
      testBusy.value = true;
      try {
        await uploadInspectionCertificate(props.assetId, record.id, file);
        toast('Certificate attached.', 'success');
      } catch {
        /* toast already raised */
      } finally {
        testBusy.value = false;
      }
    };

    const removeTest = async () => {
      const record = testConfirm.value;
      testConfirm.value = null;
      if (!record) return;
      try {
        await deleteInspection(props.assetId, record.id);
        toast('Test record removed.', 'success');
      } catch { /* toast already raised */ }
    };

    /** The certificate in the preview overlay, exactly like an attached document. */
    const openCertificate = (record) => {
      const href = `download.php?file=${encodeURIComponent(record.file)}`;
      const ext = String(record.file || '').split('.').pop().toLowerCase();
      const kind = ext === 'pdf' ? 'pdf'
        : (['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? 'image' : 'file');
      openPreview({
        kind,
        src: kind === 'file' ? href : `${href}&inline=1`,
        downloadHref: href,
        title: `${record.label || 'Inspection'} · ${formatDate(record.at)}`,
        size: record.fileSize,
      });
    };

    const exportingTest = ref(false);
    const inspectionPdf = async () => {
      if (exportingTest.value || !asset.value) return;
      exportingTest.value = true;
      try {
        await exportInspectionPdf(asset.value, state.settings);
      } catch (error) {
        toast(`Could not build the test report: ${error.message}`, 'danger', 8000);
      } finally {
        exportingTest.value = false;
      }
    };

    const quickCheckIn = async () => {
      try {
        await mutate('checkout.checkin', { assetIds: [props.assetId] });
        toast('Checked in.', 'success');
      } catch { /* toast already raised */ }
    };

    return {
      state, form, saving, confirmDelete, fileInput, tab,
      categories, locations,
      asset, isNew, isSet, hasUnits, unitPriced, priceField, unitConditions,
      lines, outUnits, history, members, warrantyExpired, expiredUnits,
      warrantyMonths, warrantyIsAuto, warrantyUntilOf,
      unitsForm, unitsDirty, unitCode, unitDetail, touchUnits,
      testRule, testEnabled, testRecords, testRows, testState, testLoose,
      testForm, testFor, testFile, testBusy, testConfirm,
      openTest, closeTest, onTestDate, onTestResult, pickTestFile, submitTest,
      attachCertificate, removeTest, openCertificate,
      exportingTest, inspectionPdf,
      RESULTS, RESULT_LABEL, STATE_CLASS, STATE_LABEL, recordSummary, needsAttention,
      rentalForm, rentalDirty, rentalDays, rentalCurrency, touchRental, saveRental,
      categoryRate, categoryRateText, activeTier, rentalUnitAt, rateText, rateSource,
      unitValueText,
      daysLabel, formatPercent, unitPriceOf,
      onUnitPurchased, unitWarrantyIsAuto,
      trackUnits, addUnit, removeUnit, saveUnits,
      MAX_PHOTOS, conditionFiles, conditionNote, conditionBusy, conditionLog,
      pickConditionPhotos, clearConditionPick, sendConditionPhotos, removeConditionPhoto,
      MAX_DOCS, MAX_ASSET_DOCS, docFiles, docTitle, docBusy, documents,
      openPreview, openAssetPhoto, openConditionPhoto, openDocument,
      pickDocuments, clearDocPick, sendDocuments, removeDocument, formatSize,
      STATUSES, CONDITIONS, CONDITION_LABEL, statusLabel,
      formatDate, formatDateTime, formatMoney, isOverdue,
      save, remove, onPhotoPicked, removePhoto, quickCheckIn, emit,
    };
  },
  template: `
    <Drawer :title="isNew ? 'New asset' : asset?.name || 'Asset'"
            :icon="isSet ? 'bi-box-seam' : 'bi-camera'"
            @close="emit('close')">

      <template #header-actions>
        <span v-if="asset" class="text-secondary font-monospace small me-2">#{{ asset.id }}</span>
        <StatusBadge v-if="asset" :status="asset.effectiveStatus" :kind="asset.kind"
                     :detail="asset.quantity > 1 ? (asset.availableQty + ' of ' + asset.quantity + ' free') : ''" />
      </template>

      <!-- Live state. Units of one asset can be out with several people, so
           this lists every open line rather than naming one holder. -->
      <div v-if="lines.length" class="alert alert-danger py-2 px-3 small d-flex align-items-start gap-2">
        <i class="bi bi-box-arrow-right"></i>
        <div class="flex-grow-1">
          <div>
            {{ outUnits }} unit(s) out
            <span v-if="asset">of {{ asset.quantity }}</span>
            with {{ lines.length }} holder(s):
          </div>
          <ul class="mb-0 mt-1 ps-3">
            <li v-for="line in lines" :key="line.lineId">
              <strong>{{ line.customerName }}</strong> ×{{ line.qty }},
              due {{ formatDateTime(line.dueAt || line.returnDate) }}
              <span v-if="isOverdue(line.dueAt || line.returnDate)" class="fw-bold">— overdue</span>
            </li>
          </ul>
        </div>
        <button class="btn btn-sm btn-outline-light" @click="quickCheckIn">Check in all</button>
      </div>

      <!-- The test record, when it is not in order. Says it on every tab, like
           the warranty line: it is the kind of fact that must not need a click. -->
      <div v-if="(testEnabled || testRecords.length) && needsAttention(testState)"
           class="alert py-2 px-3 small" :class="'alert-' + STATE_CLASS[testState]">
        <i class="bi bi-clipboard-x"></i>
        {{ STATE_LABEL[testState] }}<span v-if="testRule"> · {{ testRule.label }}</span> —
        <button class="btn btn-link btn-sm p-0 align-baseline" @click="tab = 'inspection'">
          open the test record
        </button>
      </div>

      <div v-if="warrantyExpired" class="alert alert-warning py-2 px-3 small">
        <i class="bi bi-shield-exclamation"></i>
        <span v-if="expiredUnits.length">Warranty expired for {{ expiredUnits.join(', ') }}.</span>
        <span v-else>Warranty expired {{ formatDateTime(warrantyUntilOf(asset)) }}.</span>
      </div>

      <ul class="nav nav-tabs nav-tabs-sm mb-3" v-if="!isNew">
        <li class="nav-item">
          <button class="nav-link" :class="{ active: tab === 'details' }" @click="tab = 'details'">Details</button>
        </li>
        <li class="nav-item" v-if="!isSet">
          <button class="nav-link" :class="{ active: tab === 'units' }" @click="tab = 'units'">
            Units <span class="badge bg-secondary">{{ asset?.units?.length || 0 }}</span>
          </button>
        </li>
        <li class="nav-item" v-if="isSet">
          <button class="nav-link" :class="{ active: tab === 'members' }" @click="tab = 'members'">
            Contents <span class="badge bg-secondary">{{ members.length }}</span>
          </button>
        </li>
        <li class="nav-item">
          <button class="nav-link" :class="{ active: tab === 'rental' }" @click="tab = 'rental'">
            Rental <i v-if="rentalDirty" class="bi bi-dot text-warning"></i>
          </button>
        </li>
        <!-- Only where a test is actually asked for — plus anywhere records
             already exist, so un-ticking a category never hides documentation. -->
        <li class="nav-item" v-if="testEnabled || testRecords.length">
          <button class="nav-link" :class="{ active: tab === 'inspection' }"
                  @click="tab = 'inspection'">
            Tests <span class="badge" :class="'bg-' + (needsAttention(testState) ? STATE_CLASS[testState] : 'secondary')">
              {{ testRecords.length }}
            </span>
          </button>
        </li>
        <li class="nav-item">
          <button class="nav-link" :class="{ active: tab === 'condition' }" @click="tab = 'condition'">
            Condition <span class="badge bg-secondary">{{ conditionLog.length }}</span>
          </button>
        </li>
        <li class="nav-item">
          <button class="nav-link" :class="{ active: tab === 'documents' }" @click="tab = 'documents'">
            Documents <span class="badge bg-secondary">{{ documents.length }}</span>
          </button>
        </li>
        <li class="nav-item">
          <button class="nav-link" :class="{ active: tab === 'history' }" @click="tab = 'history'">
            History <span class="badge bg-secondary">{{ history.length }}</span>
          </button>
        </li>
      </ul>

      <!-- Details -->
      <form v-show="tab === 'details'" @submit.prevent="save">
        <div class="row g-3">
          <div class="col-12">
            <label class="form-label small" for="f-name">Name</label>
            <input id="f-name" class="form-control form-control-sm" data-autofocus
                   v-model="form.name" required maxlength="200">
          </div>

          <div class="col-6" v-if="!isSet">
            <label class="form-label small" for="f-status">Status</label>
            <select id="f-status" class="form-select form-select-sm" v-model="form.status">
              <option v-for="s in STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
            </select>
          </div>
          <div class="col-6" v-else>
            <label class="form-label small">Status</label>
            <p class="form-control-plaintext form-control-sm text-secondary small mb-0">
              Derived from contents
            </p>
          </div>

          <div class="col-6" v-if="!isSet">
            <label class="form-label small" for="f-quantity">Quantity</label>
            <input id="f-quantity" type="number" min="1" class="form-control form-control-sm"
                   v-model="form.quantity" :disabled="hasUnits">
            <div v-if="hasUnits" class="form-text small">
              Derived from the {{ asset.units.length }} tracked units — edit them in the Units tab.
            </div>
            <div v-else-if="asset" class="form-text small">
              {{ asset.availableQty }} of {{ asset.quantity }} free
              <span v-if="outUnits"> · cannot go below {{ outUnits }} while those are out</span>
            </div>
          </div>

          <!-- A tracked asset has no single grade: each unit carries its own,
               so the select goes and the counted summary takes its place. -->
          <div class="col-6" v-if="!hasUnits">
            <label class="form-label small" for="f-condition">Condition</label>
            <select id="f-condition" class="form-select form-select-sm" v-model="form.condition">
              <option v-for="c in CONDITIONS" :key="c" :value="c">{{ CONDITION_LABEL[c] }}</option>
            </select>
          </div>
          <div class="col-6" v-else>
            <label class="form-label small">Condition</label>
            <p class="form-control-plaintext form-control-sm text-secondary small mb-0">
              Condition per unit: {{ unitConditions }}
            </p>
          </div>

          <div class="col-6">
            <label class="form-label small" for="f-category">Category</label>
            <input id="f-category" class="form-control form-control-sm" v-model="form.category" list="trax-categories">
          </div>

          <div class="col-6">
            <label class="form-label small" for="f-location">Location</label>
            <input id="f-location" class="form-control form-control-sm" v-model="form.location" list="trax-locations">
          </div>

          <div class="col-12">
            <label class="form-label small" for="f-notes">Notes</label>
            <textarea id="f-notes" class="form-control form-control-sm" rows="2" v-model="form.notes"></textarea>
          </div>

          <div class="col-12"><hr class="my-1"><span class="small text-secondary">Purchase &amp; identity</span></div>

          <div class="col-6">
            <label class="form-label small" for="f-serial">Serial number</label>
            <input id="f-serial" class="form-control form-control-sm font-monospace" v-model="form.serial">
          </div>

          <div class="col-6">
            <label class="form-label small" for="f-supplier">Supplier</label>
            <input id="f-supplier" class="form-control form-control-sm" v-model="form.supplier">
          </div>

          <!-- Two of the same model are rarely bought on the same day, so a
               tracked asset has no single purchase date either: the units
               carry both dates and the summary reads them back. -->
          <div class="col-6" v-if="!hasUnits">
            <label class="form-label small" for="f-purchased">Purchased</label>
            <input id="f-purchased" type="date" class="form-control form-control-sm" v-model="form.purchasedAt">
          </div>
          <div class="col-6" v-else>
            <label class="form-label small">Purchased</label>
            <p class="form-control-plaintext form-control-sm text-secondary small mb-0">
              Purchased per unit — earliest {{ formatDate(asset.purchasedFirst) }}
            </p>
          </div>

          <div class="col-6" v-if="!hasUnits">
            <label class="form-label small" for="f-warranty">Warranty until</label>
            <input id="f-warranty" type="date" class="form-control form-control-sm" v-model="form.warrantyUntil">
            <div v-if="warrantyIsAuto" class="form-text small">
              Auto-filled as purchase date + {{ warrantyMonths }} months — change it if the
              warranty is longer.
            </div>
          </div>
          <div class="col-6" v-else>
            <label class="form-label small">Warranty until</label>
            <p class="form-control-plaintext form-control-sm text-secondary small mb-0">
              Warranty per unit — next {{ formatDate(asset.warrantyNext) }}<span
                v-if="asset.warrantyNextUnit"> (unit {{ asset.id }}.{{ asset.warrantyNextUnit }})</span>
            </p>
          </div>

          <div class="col-6">
            <label class="form-label small" for="f-price">Price</label>
            <div class="input-group input-group-sm">
              <input id="f-price" class="form-control" v-model="priceField" inputmode="decimal"
                     placeholder="0,00" :disabled="unitPriced">
              <input class="form-control" style="max-width:5rem" v-model="form.currency" maxlength="8" aria-label="Currency">
            </div>
            <div v-if="unitPriced" class="form-text small">
              Sum of {{ asset.pricedUnits }} unit prices — edit them in the Units tab.
            </div>
          </div>

          <div class="col-6">
            <label class="form-label small" for="f-tags">Tags</label>
            <input id="f-tags" class="form-control form-control-sm" v-model="form.tags" placeholder="comma, separated">
          </div>

          <!-- Photo -->
          <template v-if="!isNew">
            <div class="col-12"><hr class="my-1"><span class="small text-secondary">Photo</span></div>
            <div class="col-12 d-flex align-items-center gap-3">
              <button v-if="asset?.photo" type="button" class="trax-thumb-btn"
                      :aria-label="'Show the photo of ' + (asset?.name || 'this item')"
                      @click="openAssetPhoto(asset)">
                <img :src="'uploads/' + asset.photo" alt=""
                     style="width:96px;height:96px;object-fit:cover;border-radius:8px">
              </button>
              <div v-else class="trax-thumb trax-thumb-placeholder"
                   style="width:96px;height:96px;font-size:1.6rem">
                <i class="bi bi-image"></i>
              </div>
              <div class="d-flex flex-column gap-2">
                <input ref="fileInput" type="file" class="d-none"
                       accept="image/jpeg,image/png,image/webp" @change="onPhotoPicked">
                <button type="button" class="btn btn-sm btn-outline-secondary" @click="fileInput.click()">
                  <i class="bi bi-upload"></i> {{ asset?.photo ? 'Replace' : 'Upload' }}
                </button>
                <button v-if="asset?.photo" type="button" class="btn btn-sm btn-outline-danger" @click="removePhoto">
                  <i class="bi bi-trash"></i> Remove
                </button>
              </div>
            </div>
          </template>
        </div>
      </form>

      <!-- Per-unit tracking. The server assigns the numbers, so a row is
           only ever "12.–" until it has been saved once. Saved on its own;
           the details form never carries the unit list. -->
      <div v-show="tab === 'units'">
        <template v-if="!unitsForm.length">
          <p class="small text-secondary mb-2">Individual units are not tracked for this item.</p>
          <button type="button" class="btn btn-sm btn-outline-primary" @click="trackUnits">
            <i class="bi bi-list-ol"></i> Track {{ asset?.quantity }} units individually
          </button>
          <p class="form-text small mt-2 mb-0">
            Each unit gets a number like {{ asset?.id }}.1 and can be labelled, marked out of
            service and printed on its own label.
          </p>
        </template>

        <ul v-else class="list-group list-group-flush">
          <li v-for="(unit, ui) in unitsForm" :key="ui + '-' + (unit.no || 'new')"
              class="list-group-item bg-transparent px-0">
            <div class="d-flex align-items-center gap-2">
              <span class="font-monospace small">{{ unitCode(unit) }}</span>
              <StatusBadge v-if="unit.state === 'OUT'" status="UNAV" :detail="unitDetail(unit)" />
              <StatusBadge v-else-if="unit.state === 'OOS'" status="LOCK" label="Out of service"
                           title="Out of service" />
              <StatusBadge v-else-if="unit.state" status="FREE" />
              <span class="flex-grow-1"></span>
              <button type="button" class="btn btn-sm btn-outline-danger py-0 px-1"
                      :disabled="unit.state === 'OUT'"
                      :title="unit.state === 'OUT' ? 'Checked out — return it first' : 'Remove this unit'"
                      :aria-label="'Remove unit ' + unitCode(unit)"
                      @click="removeUnit(ui)">
                <i class="bi bi-x"></i>
              </button>
            </div>

            <div class="row g-2 mt-1">
              <div class="col-6">
                <input class="form-control form-control-sm" v-model="unit.label" maxlength="120"
                       placeholder="e.g. Sommer Cable" @input="touchUnits"
                       :aria-label="'Label for unit ' + unitCode(unit)">
              </div>
              <div class="col-6">
                <input class="form-control form-control-sm font-monospace" v-model="unit.serial"
                       maxlength="120" placeholder="Serial number" @input="touchUnits"
                       :aria-label="'Serial number of unit ' + unitCode(unit)">
              </div>
              <div class="col-4">
                <select class="form-select form-select-sm" v-model="unit.condition" @change="touchUnits"
                        :aria-label="'Condition of unit ' + unitCode(unit)">
                  <option v-for="c in CONDITIONS" :key="c" :value="c">{{ CONDITION_LABEL[c] }}</option>
                </select>
              </div>
              <div class="col-4">
                <input class="form-control form-control-sm" type="text" inputmode="decimal"
                       v-model="unit.price" placeholder="Price" @input="touchUnits"
                       :aria-label="'Price of unit ' + unitCode(unit)">
              </div>
              <div class="col-4 d-flex align-items-center">
                <div class="form-check form-switch mb-0">
                  <input class="form-check-input" type="checkbox" :id="'f-unit-oos-' + ui"
                         v-model="unit.outOfService" @change="touchUnits">
                  <label class="form-check-label small" :for="'f-unit-oos-' + ui">Out of service</label>
                </div>
              </div>
              <!-- Bound by hand, not with v-model: onUnitPurchased() needs the
                   date the row had to tell an auto-filled warranty from a
                   typed one. -->
              <div class="col-6">
                <label class="form-label small mb-1" :for="'f-unit-bought-' + ui">Purchased</label>
                <input class="form-control form-control-sm" type="date" :id="'f-unit-bought-' + ui"
                       :value="unit.purchasedAt" @input="onUnitPurchased(unit, $event.target.value)"
                       :aria-label="'Purchase date of unit ' + unitCode(unit)">
              </div>
              <div class="col-6">
                <label class="form-label small mb-1" :for="'f-unit-warranty-' + ui">Warranty until</label>
                <input class="form-control form-control-sm" type="date" :id="'f-unit-warranty-' + ui"
                       v-model="unit.warrantyUntil" @input="touchUnits"
                       :aria-label="'Warranty of unit ' + unitCode(unit)">
                <div v-if="unitWarrantyIsAuto(unit)" class="form-text small">
                  auto: purchase + {{ warrantyMonths }} months
                </div>
              </div>

              <div class="col-12">
                <input class="form-control form-control-sm" v-model="unit.note" maxlength="500"
                       placeholder="Note (optional)" @input="touchUnits"
                       :aria-label="'Note on unit ' + unitCode(unit)">
              </div>
            </div>
          </li>
        </ul>

        <div class="d-flex align-items-center gap-2 mt-3">
          <button type="button" class="btn btn-sm btn-outline-primary" @click="addUnit">
            <i class="bi bi-plus"></i> Add unit
          </button>
          <span class="flex-grow-1"></span>
          <button type="button" class="btn btn-sm btn-primary"
                  :disabled="!unitsDirty || saving" @click="saveUnits">
            <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>
            Save units
          </button>
        </div>
      </div>

      <!-- Rental rates. What the gear costs to HIRE, which is not what it is
           worth: the price below is read-only here and is only ever the basis
           a percentage rate is worked out from. -->
      <div v-if="tab === 'rental' && !isNew">
        <p v-if="isSet" class="small text-secondary">
          A kit is hired out as its contents: every item inside it is charged at its own
          rate, so a kit has no rate of its own. Open a member to change what it costs.
        </p>

        <template v-else>
          <div class="alert alert-secondary py-2 px-3 small d-flex align-items-start gap-2">
            <i class="bi bi-tags"></i>
            <div>
              {{ categoryRateText }}
              <div class="text-secondary">
                Edit it under Settings → Rental rates. Anything set below overrules it.
              </div>
            </div>
          </div>

          <div class="row g-3">
            <div class="col-12 col-sm-6">
              <label class="form-label small" for="f-rental-value">Value (read-only)</label>
              <input id="f-rental-value" class="form-control form-control-sm" readonly
                     :value="formatMoney(unitPriceOf(asset), rentalCurrency) || '—'">
              <div class="form-text small">
                Per unit<span v-if="unitPriced"> · the sum of the unit prices, divided by {{ asset?.quantity }}</span>.
                Percentage rates are worked out from this.
              </div>
            </div>
            <div class="col-12 col-sm-6">
              <label class="form-label small" for="f-rental-days">Price a hire of</label>
              <div class="input-group input-group-sm">
                <input id="f-rental-days" class="form-control text-end" type="number" min="1" max="3650"
                       v-model="rentalDays">
                <span class="input-group-text">days</span>
              </div>
              <div class="form-text small">
                <span v-if="activeTier">
                  Discount step: from {{ activeTier.days }} days on.
                </span>
                <span v-else>Preview only — nothing here is stored.</span>
              </div>
            </div>
          </div>

          <div class="mt-3">
            <h3 class="trax-page-title">This asset's rate</h3>
            <RentalRate :rule="rentalForm.rental" variant="override" :currency="rentalCurrency"
                        :inherit-label="categoryRate.source === 'category'
                          ? 'Use the category rate' : 'Use the default rate'"
                        @change="touchRental" />
            <div class="small text-secondary mt-1">
              {{ rateText(null) }} <span class="text-body-secondary">· from {{ rateSource(null) }}</span>
            </div>
          </div>

          <!-- Per unit. Only the rate is editable here; the price beside it is
               the unit's own and is edited in the Units tab. -->
          <div v-if="rentalForm.units.length" class="mt-3">
            <h3 class="trax-page-title">Per unit</h3>
            <ul class="list-group list-group-flush">
              <li v-for="(row, ri) in rentalForm.units" :key="row.no"
                  class="list-group-item bg-transparent px-0">
                <div class="d-flex align-items-center gap-2">
                  <span class="font-monospace small">{{ asset.id }}.{{ row.no }}</span>
                  <span v-if="asset?.units?.[ri]?.label"
                        class="small text-secondary text-truncate">{{ asset.units[ri].label }}</span>
                  <span class="flex-grow-1"></span>
                  <span class="small text-secondary">{{ unitValueText(ri) }}</span>
                </div>
                <div class="mt-1">
                  <RentalRate :rule="row.rental" variant="override" :dense="true"
                              :currency="rentalCurrency"
                              inherit-label="Use this asset's rate"
                              @change="touchRental" />
                </div>
                <div class="small text-secondary mt-1">
                  {{ rateText(rentalUnitAt(ri)) }}
                  <span class="text-body-secondary">· from {{ rateSource(rentalUnitAt(ri)) }}</span>
                </div>
              </li>
            </ul>
          </div>

          <div class="d-flex align-items-center gap-2 mt-3">
            <span class="small text-secondary flex-grow-1">
              Rates are never stored on a booking — a hire is always priced by what is in force now.
            </span>
            <button type="button" class="btn btn-sm btn-primary"
                    :disabled="!rentalDirty || saving" @click="saveRental">
              <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>
              Save rates
            </button>
          </div>
        </template>
      </div>

      <!-- Test records. One history per physical piece, because that is what a
           test certificate is about: cable 183.5, not "cables". -->
      <div v-if="tab === 'inspection' && !isNew">
        <div v-if="!testEnabled" class="alert alert-secondary py-2 px-3 small">
          <i class="bi bi-info-circle"></i>
          <span v-if="asset?.category">
            "{{ asset.category }}" is not set up for tests. Tick it under
            Settings → Inspections and this asset starts asking for a record.
          </span>
          <span v-else>
            This asset has no category, and tests are switched on per category
            under Settings → Inspections.
          </span>
          <span v-if="testRecords.length"> The records below stay either way.</span>
        </div>

        <div v-else class="alert py-2 px-3 small d-flex align-items-start gap-2"
             :class="'alert-' + STATE_CLASS[testState]">
          <i class="bi bi-clipboard-check"></i>
          <div>
            <strong>{{ testRule.label }}</strong> — {{ STATE_LABEL[testState] }}
            <div class="text-secondary">
              <span v-if="testRule.intervalMonths">
                Valid for {{ testRule.intervalMonths }} month(s) from each pass.
              </span>
              <span v-else>No repeat — nothing falls due on its own.</span>
              <span v-if="(testRule.fields || []).length">
                Records {{ testRule.fields.join(', ') }}.
              </span>
            </div>
          </div>
        </div>

        <div class="d-flex align-items-center gap-2 mb-2">
          <span class="small text-secondary flex-grow-1">
            {{ testRecords.length }} record(s) on {{ testRows.length }} piece(s)
          </span>
          <button type="button" class="btn btn-sm btn-outline-secondary"
                  :disabled="exportingTest || !testRecords.length" @click="inspectionPdf"
                  aria-label="Test report PDF for this asset">
            <span v-if="exportingTest" class="spinner-border spinner-border-sm me-1"></span>
            <i v-else class="bi bi-file-earmark-text"></i>
            Test report
          </button>
        </div>

        <ul class="list-group list-group-flush">
          <li v-for="row in testRows" :key="row.code" class="list-group-item bg-transparent px-0">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <span class="font-monospace small">{{ row.code }}</span>
              <span v-if="row.label" class="small text-secondary text-truncate">{{ row.label }}</span>
              <span class="badge" :class="'bg-' + STATE_CLASS[row.state]">
                {{ STATE_LABEL[row.state] }}
              </span>
              <span class="flex-grow-1"></span>
              <button type="button" class="btn btn-sm btn-outline-primary py-0 px-2"
                      :disabled="testBusy" @click="openTest(row)"
                      :aria-label="'Record a test for ' + row.code">
                <i class="bi bi-plus"></i> Record test
              </button>
            </div>
            <!-- Only when there IS a last test: the badge and the empty-state
                 line below already say "never tested", and a third copy of it
                 is noise on every untested piece. -->
            <div v-if="row.latest" class="small text-secondary">{{ recordSummary(row.latest) }}</div>

            <!-- The form, under the piece it is about. -->
            <div v-if="testFor === row.code && testForm" class="trax-card mt-2">
              <div class="trax-card-pad">
                <div class="row g-2">
                  <div class="col-6 col-md-4">
                    <label class="form-label small mb-1" for="f-test-at">Tested on</label>
                    <input class="form-control form-control-sm" id="f-test-at" type="date"
                           :value="testForm.at" @input="onTestDate($event.target.value)">
                  </div>
                  <div class="col-6 col-md-4">
                    <label class="form-label small mb-1" for="f-test-result">Result</label>
                    <!-- Bound by hand, not with v-model: onTestResult() needs
                         to compare the next date against what the interval
                         said before the result changed. -->
                    <select class="form-select form-select-sm" id="f-test-result"
                            :value="testForm.result" @change="onTestResult($event.target.value)">
                      <option v-for="r in RESULTS" :key="r" :value="r">{{ RESULT_LABEL[r] }}</option>
                    </select>
                  </div>
                  <div class="col-12 col-md-4">
                    <label class="form-label small mb-1" for="f-test-next">Next test</label>
                    <input class="form-control form-control-sm" id="f-test-next" type="date"
                           v-model="testForm.nextAt">
                  </div>
                  <div class="col-12 col-md-6">
                    <label class="form-label small mb-1" for="f-test-by">Tested by</label>
                    <input class="form-control form-control-sm" id="f-test-by" maxlength="120"
                           v-model="testForm.by" placeholder="Who did the test">
                  </div>
                  <div class="col-12 col-md-6">
                    <label class="form-label small mb-1" for="f-test-label">Test</label>
                    <input class="form-control form-control-sm" id="f-test-label" maxlength="120"
                           v-model="testForm.label" placeholder="e.g. DGUV V3">
                  </div>

                  <!-- The parameters the category asks for, in its order. -->
                  <div v-for="(field, vi) in testForm.values" :key="vi" class="col-12 col-md-6">
                    <label class="form-label small mb-1" :for="'f-test-value-' + vi">
                      {{ field.name || ('Parameter ' + (vi + 1)) }}
                    </label>
                    <input class="form-control form-control-sm" :id="'f-test-value-' + vi"
                           maxlength="120" v-model="field.value" placeholder="Measured value">
                  </div>

                  <div class="col-12">
                    <label class="form-label small mb-1" for="f-test-note">Note</label>
                    <textarea class="form-control form-control-sm" id="f-test-note" rows="2"
                              maxlength="1000" v-model="testForm.note"></textarea>
                  </div>

                  <div class="col-12">
                    <label class="form-label small mb-1" for="f-test-file">
                      Certificate (optional)
                    </label>
                    <input class="form-control form-control-sm" id="f-test-file" type="file"
                           accept="application/pdf,image/jpeg,image/png,image/webp,text/plain"
                           @change="pickTestFile">
                    <div class="form-text small">
                      PDF, image or text. It can also be attached to the record later.
                    </div>
                  </div>
                </div>

                <div class="d-flex align-items-center gap-2 mt-3">
                  <span class="small text-secondary flex-grow-1">
                    Filed against {{ row.code }}.
                  </span>
                  <button type="button" class="btn btn-sm btn-outline-secondary"
                          :disabled="testBusy" @click="closeTest">Cancel</button>
                  <button type="button" class="btn btn-sm btn-primary"
                          :disabled="testBusy" @click="submitTest">
                    <span v-if="testBusy" class="spinner-border spinner-border-sm me-1"></span>
                    Save test
                  </button>
                </div>
              </div>
            </div>

            <!-- This piece's history, newest first. -->
            <ol v-if="row.records.length" class="list-unstyled mb-0 mt-2 ps-3 border-start border-secondary-subtle">
              <li v-for="record in row.records" :key="record.id" class="py-1">
                <div class="d-flex align-items-center gap-2 flex-wrap">
                  <span class="badge" :class="record.result === 'PASS' ? 'bg-success' : 'bg-danger'">
                    {{ RESULT_LABEL[record.result] }}
                  </span>
                  <span class="small">{{ formatDate(record.at) }}</span>
                  <span v-if="record.label" class="trax-kind-chip">{{ record.label }}</span>
                  <span v-if="record.nextAt" class="small text-secondary">
                    next {{ formatDate(record.nextAt) }}
                  </span>
                  <span v-if="record.by" class="small text-secondary">· {{ record.by }}</span>
                  <span class="flex-grow-1"></span>
                  <button v-if="record.file" type="button" class="btn btn-sm btn-outline-secondary py-0 px-2"
                          @click="openCertificate(record)"
                          :aria-label="'Open the certificate of the test on ' + formatDate(record.at)">
                    <i class="bi bi-paperclip"></i> Certificate
                  </button>
                  <label v-else class="btn btn-sm btn-outline-secondary py-0 px-2 mb-0">
                    <i class="bi bi-upload"></i> Certificate
                    <input type="file" class="d-none" :disabled="testBusy"
                           accept="application/pdf,image/jpeg,image/png,image/webp,text/plain"
                           @change="attachCertificate(record, $event)">
                  </label>
                  <button type="button" class="btn btn-sm btn-outline-danger py-0 px-1"
                          :disabled="testBusy" @click="testConfirm = record"
                          :aria-label="'Remove the test record of ' + formatDate(record.at)">
                    <i class="bi bi-trash"></i>
                  </button>
                </div>
                <div v-if="record.values.length" class="small text-secondary">
                  <span v-for="(value, xi) in record.values" :key="xi">
                    {{ value.name }}: <span class="font-monospace">{{ value.value }}</span><span
                      v-if="xi < record.values.length - 1"> · </span>
                  </span>
                </div>
                <div v-if="record.note" class="small text-secondary">{{ record.note }}</div>
              </li>
            </ol>
            <div v-else class="small text-secondary mt-1">No test on record for this one yet.</div>
          </li>
        </ul>

        <!-- Records filed before the units were listed. They belong to the
             record as a whole and would otherwise simply vanish from view. -->
        <div v-if="testLoose.length" class="mt-3">
          <h3 class="trax-page-title">Filed against the whole asset</h3>
          <ol class="list-unstyled mb-0 small">
            <li v-for="record in testLoose" :key="record.id" class="d-flex align-items-center gap-2 py-1">
              <span class="badge" :class="record.result === 'PASS' ? 'bg-success' : 'bg-danger'">
                {{ RESULT_LABEL[record.result] }}
              </span>
              <span>{{ formatDate(record.at) }}</span>
              <span v-if="record.by" class="text-secondary">· {{ record.by }}</span>
              <span class="flex-grow-1"></span>
              <button v-if="record.file" type="button" class="btn btn-sm btn-outline-secondary py-0 px-2"
                      @click="openCertificate(record)">
                <i class="bi bi-paperclip"></i>
              </button>
              <button type="button" class="btn btn-sm btn-outline-danger py-0 px-1"
                      :disabled="testBusy" @click="testConfirm = record">
                <i class="bi bi-trash"></i>
              </button>
            </li>
          </ol>
        </div>
      </div>

      <!-- Kit contents -->
      <div v-show="tab === 'members'">
        <p class="small text-secondary">
          A kit's status is derived from its contents. Deleting the kit never deletes these items.
        </p>
        <ul class="list-group list-group-flush">
          <li v-for="(member, mi) in members" :key="mi + '-' + member.id"
              class="list-group-item bg-transparent d-flex align-items-center gap-2 px-0">
            <button v-if="member.photo" type="button" class="trax-thumb-btn"
                    :aria-label="'Show the photo of ' + member.name"
                    @click.stop="openAssetPhoto(member)">
              <img class="trax-thumb" :src="'uploads/thumb/' + member.photo" alt="">
            </button>
            <span v-else class="trax-thumb trax-thumb-placeholder"><i class="bi bi-camera"></i></span>
            <button class="trax-name-btn flex-grow-1" @click="emit('open', member.id)">{{ member.name }}</button>
            <span v-if="member.reqQty > 1" class="trax-kind-chip">×{{ member.reqQty }}</span>
            <StatusBadge :status="member.effectiveStatus" :kind="member.kind"
                         :detail="member.quantity > 1 ? (member.availableQty + ' of ' + member.quantity + ' free') : ''" />
          </li>
          <li v-if="!members.length" class="text-secondary small py-3">This kit is empty.</li>
        </ul>
      </div>

      <!-- Condition log. Belongs to the asset, not to a booking: an item on
           the shelf has no booking, and this record outlives every loan.
           capture="environment" so a phone opens the rear camera directly. -->
      <div v-show="tab === 'condition'">
        <p class="small text-secondary">
          Dated photos of this one item. Kept when it goes out and comes back.
        </p>

        <div class="row g-2 align-items-end mb-3">
          <div class="col-12">
            <label class="form-label small mb-1" for="f-condition-photos">
              Add photos <span class="text-secondary">— up to {{ MAX_PHOTOS }} at once</span>
            </label>
            <input id="f-condition-photos" class="form-control form-control-sm" type="file"
                   multiple accept="image/*" capture="environment" @change="pickConditionPhotos">
          </div>
          <div class="col-12">
            <input class="form-control form-control-sm" v-model="conditionNote"
                   aria-label="Comment on these photos"
                   placeholder="What do these show? (scratch, dent, missing part…)">
          </div>
          <div class="col-12 d-flex align-items-center gap-2">
            <span v-if="conditionFiles.length" class="trax-kind-chip">
              <i class="bi bi-camera"></i> {{ conditionFiles.length }} photo(s) ready
            </span>
            <button v-if="conditionFiles.length" type="button"
                    class="btn btn-sm btn-outline-secondary" @click="clearConditionPick">Clear</button>
            <span class="flex-grow-1"></span>
            <button type="button" class="btn btn-sm btn-primary"
                    :disabled="conditionBusy || !conditionFiles.length" @click="sendConditionPhotos">
              <span v-if="conditionBusy" class="spinner-border spinner-border-sm me-1"></span>
              <i class="bi bi-upload"></i> Upload
            </button>
          </div>
        </div>

        <ul class="list-group list-group-flush">
          <li v-for="shot in conditionLog" :key="shot.file"
              class="list-group-item bg-transparent d-flex align-items-center gap-2 px-0">
            <button type="button" class="trax-thumb-btn"
                    :aria-label="'Show the condition photo from ' + formatDateTime(shot.at)"
                    @click="openConditionPhoto(shot.file)">
              <img class="trax-thumb" :src="'uploads/thumb/' + shot.file" alt="Condition photo">
            </button>
            <div class="flex-grow-1 min-w-0">
              <div class="small">{{ formatDateTime(shot.at) }}</div>
              <div v-if="shot.note" class="text-secondary" style="font-size:.75rem">{{ shot.note }}</div>
            </div>
            <button type="button" class="btn btn-sm btn-outline-danger"
                    :aria-label="'Delete the condition photo from ' + formatDateTime(shot.at)"
                    @click="removeConditionPhoto(shot.file)">
              <i class="bi bi-trash"></i>
            </button>
          </li>
          <li v-if="!conditionLog.length" class="text-secondary small py-3">
            No condition photos yet.
          </li>
        </ul>
      </div>

      <!-- Documents. Manuals, receipts, insurance certificates — never public:
           every one of them is fetched through download.php, which is behind
           the same login as this page. They appear on no customer page. -->
      <div v-show="tab === 'documents'">
        <p class="small text-secondary">
          Manuals, receipts, insurance certificates. Only visible here — never on a
          customer's booking page. PDF, JPEG, PNG, WebP or plain text, up to
          {{ MAX_ASSET_DOCS }} per item.
        </p>

        <div class="row g-2 align-items-end mb-3">
          <div class="col-12">
            <label class="form-label small mb-1" for="f-documents">
              Attach files <span class="text-secondary">— up to {{ MAX_DOCS }} at once</span>
            </label>
            <input id="f-documents" class="form-control form-control-sm" type="file"
                   multiple accept=".pdf,.txt,.jpg,.jpeg,.png,.webp,application/pdf,text/plain,image/jpeg,image/png,image/webp"
                   @change="pickDocuments">
          </div>
          <div class="col-12">
            <input class="form-control form-control-sm" v-model="docTitle"
                   aria-label="Label for these documents" maxlength="200"
                   placeholder="What are these? (manual, receipt, insurance…)">
          </div>
          <div class="col-12 d-flex align-items-center gap-2">
            <span v-if="docFiles.length" class="trax-kind-chip">
              <i class="bi bi-paperclip"></i> {{ docFiles.length }} file(s) ready
            </span>
            <button v-if="docFiles.length" type="button"
                    class="btn btn-sm btn-outline-secondary" @click="clearDocPick">Clear</button>
            <span class="flex-grow-1"></span>
            <button type="button" class="btn btn-sm btn-primary"
                    :disabled="docBusy || !docFiles.length" @click="sendDocuments">
              <span v-if="docBusy" class="spinner-border spinner-border-sm me-1"></span>
              <i class="bi bi-upload"></i> Attach
            </button>
          </div>
        </div>

        <ul class="list-group list-group-flush">
          <li v-for="doc in documents" :key="doc.file"
              class="list-group-item bg-transparent d-flex align-items-center gap-2 px-0">
            <i class="bi bi-file-earmark-text fs-5 text-secondary"></i>
            <div class="flex-grow-1 min-w-0">
              <!-- The name opens the preview; the button beside it still
                   downloads, which is the only way to get a copy on disk. -->
              <button type="button" class="trax-name-btn small text-truncate w-100 text-start"
                      :aria-label="'Preview ' + doc.name" @click="openDocument(doc)">
                <strong v-if="doc.title">{{ doc.title }}</strong>
                <span v-else>{{ doc.name }}</span>
              </button>
              <div class="text-secondary text-truncate" style="font-size:.75rem">
                <span v-if="doc.title">{{ doc.name }} · </span>{{ formatSize(doc.size) }} ·
                {{ formatDateTime(doc.addedAt) }}
              </div>
            </div>
            <a class="btn btn-sm btn-outline-secondary" :href="'download.php?file=' + doc.file"
               :aria-label="'Download ' + doc.name" download>
              <i class="bi bi-download"></i>
            </a>
            <button type="button" class="btn btn-sm btn-outline-danger"
                    :aria-label="'Delete the document ' + doc.name"
                    @click="removeDocument(doc.file)">
              <i class="bi bi-trash"></i>
            </button>
          </li>
          <li v-if="!documents.length" class="text-secondary small py-3">
            No documents attached yet.
          </li>
        </ul>
      </div>

      <!-- History -->
      <div v-show="tab === 'history'">
        <ol class="list-unstyled mb-0">
          <li v-for="entry in history" :key="entry.id" class="d-flex gap-2 py-2 border-bottom border-secondary-subtle">
            <i class="bi bi-dot"></i>
            <div class="flex-grow-1">
              <div class="small"><strong>{{ entry.type.replace(/_/g, ' ') }}</strong>
                <span v-if="entry.customerName" class="text-secondary"> · {{ entry.customerName }}</span>
              </div>
              <div class="text-secondary" style="font-size:.75rem">
                {{ formatDateTime(entry.at) }}
                <span v-if="entry.note"> · {{ entry.note }}</span>
              </div>
            </div>
          </li>
          <li v-if="!history.length" class="text-secondary small py-3">Nothing recorded yet.</li>
        </ol>
      </div>

      <datalist id="trax-categories">
        <option v-for="c in categories" :key="c" :value="c"></option>
      </datalist>
      <datalist id="trax-locations">
        <option v-for="l in locations" :key="l" :value="l"></option>
      </datalist>

      <template #footer>
        <button v-if="!isNew" type="button" class="btn btn-sm btn-outline-danger"
                @click="confirmDelete = true">
          <i class="bi bi-trash"></i> Delete
        </button>
        <button v-if="!isNew" type="button" class="btn btn-sm btn-outline-secondary"
                @click="emit('label', asset.id)">
          <i class="bi bi-printer"></i> Label
        </button>
        <span class="flex-grow-1"></span>
        <button type="button" class="btn btn-sm btn-outline-secondary" @click="emit('close')">Cancel</button>
        <button type="button" class="btn btn-sm btn-primary" :disabled="saving" @click="save">
          <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>
          {{ isNew ? 'Create' : 'Save' }}
        </button>
      </template>
    </Drawer>

    <ConfirmDialog v-if="confirmDelete"
                   :title="isSet ? 'Delete this kit?' : 'Delete this asset?'"
                   :message="isSet
                     ? 'The kit definition is removed. The items inside it are kept.'
                     : 'This removes the asset and its photo. History entries are kept.'"
                   confirm-label="Delete" danger
                   @confirm="remove" @cancel="confirmDelete = false" />

    <!-- A test record is documentation, so removing one asks first and says
         what goes with it. -->
    <ConfirmDialog v-if="testConfirm"
                   title="Remove this test record?"
                   :message="'The ' + (testConfirm.label || 'test') + ' of ' + formatDate(testConfirm.at)
                     + ' is deleted' + (testConfirm.file ? ', together with its certificate.' : '.')
                     + ' This cannot be undone.'"
                   confirm-label="Remove" danger
                   @confirm="removeTest" @cancel="testConfirm = null" />
  `,
};
