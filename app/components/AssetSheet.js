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
import Menu from './ui/Menu.js';
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
  components: { Drawer, StatusBadge, ConfirmDialog, Menu, RentalRate },
  props: {
    assetId: { type: Number, default: null },
  },
  emits: ['close', 'label', 'open', 'edit-kit'],
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

    const categoryRateLabel = computed(() => (categoryRate.value.source === 'category'
      ? `${asset.value?.category} rate`
      : 'Default rate'));

    const categoryRateText = computed(() => {
      const { rule } = categoryRate.value;
      if (rule.mode === 'FIXED') {
        return formatMoney(rule.fixed, rentalCurrency.value)
          + (rule.fixedPer === 'DAY' ? ' / day' : ' / rental');
      }
      const ladder = (rule.tiers || [])
        .map((tier) => `${tier.days}+ d ${formatPercent(tier.percent)} %`)
        .join(', ');
      return `${formatPercent(rule.percent)} %/day` + (ladder ? ` · ${ladder}` : '');
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
          : `${money} fixed`;
      }
      if (priced.unpriced) {
        return `${formatPercent(priced.rate)} %/day · no value set`;
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
        ? 'No value'
        : `${formatMoney(fallback, rentalCurrency.value)} (asset)`;
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

    // --- Presentation only -------------------------------------------------
    // The unit row whose fields are expanded; the list itself stays compact.
    const openUnit = ref(null);
    watch(() => props.assetId, () => { openUnit.value = null; });
    const toggleUnit = (index) => { openUnit.value = openUnit.value === index ? null : index; };
    const addUnitOpen = () => { addUnit(); openUnit.value = unitsForm.value.length - 1; };
    const removeUnitAt = (index) => { openUnit.value = null; removeUnit(index); };

    /** Bootstrap colour of a test state, as the quiet status dot. */
    const STATE_DOT = { danger: 'UNAV', warning: 'RSVD', success: 'FREE', secondary: 'LOCK' };
    const stateDot = (state) => `status-${STATE_DOT[STATE_CLASS[state]] || 'LOCK'}`;

    /** "#12 · Power · Store room" under the status in the sheet's header. */
    const heroMeta = computed(() => (asset.value
      ? [`#${asset.value.id}`, asset.value.category, asset.value.location].filter(Boolean).join(' · ')
      : ''));

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
      categoryRate, categoryRateLabel, categoryRateText, activeTier, rentalUnitAt, rateText, rateSource,
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
      openUnit, toggleUnit, addUnitOpen, removeUnitAt, stateDot, heroMeta,
    };
  },
  template: `
    <Drawer :title="isNew ? 'New asset' : asset?.name || 'Asset'"
            :icon="isSet ? 'bi-box-seam' : 'bi-camera'"
            @close="emit('close')">

      <input v-if="!isNew" ref="fileInput" type="file" class="d-none"
             accept="image/jpeg,image/png,image/webp" @change="onPhotoPicked">

      <!-- Header: photo, status, and the live facts every tab needs. -->
      <div v-if="asset" class="trax-sheet-hero">
        <button v-if="asset.photo" type="button" class="trax-thumb-btn"
                :aria-label="'Show the photo of ' + asset.name" @click="openAssetPhoto(asset)">
          <img class="trax-sheet-photo" :src="'uploads/thumb/' + asset.photo" alt="">
        </button>
        <button v-else type="button" class="trax-sheet-photo is-empty" title="Add photo"
                aria-label="Add photo" @click="fileInput.click()">
          <i class="bi" :class="isSet ? 'bi-box-seam' : 'bi-camera'"></i>
        </button>
        <div class="min-w-0 flex-grow-1">
          <div class="d-flex flex-wrap align-items-center gap-2">
            <StatusBadge :status="asset.effectiveStatus" :kind="asset.kind"
                         :detail="asset.quantity > 1 ? (asset.availableQty + ' of ' + asset.quantity + ' free') : ''" />
            <span v-if="isSet" class="trax-kind-chip">Kit</span>
          </div>
          <div class="trax-sheet-hero-meta">{{ heroMeta }}</div>
        </div>
      </div>

      <!-- Units of one asset can be out with several people, so every open
           line is listed rather than one holder. -->
      <div v-if="asset && (lines.length || warrantyUntilOf(asset) || ((testEnabled || testRecords.length) && needsAttention(testState)))"
           class="trax-list mb-3">
        <template v-if="lines.length">
          <div class="trax-kv">
            <span><i class="bi bi-box-arrow-right me-1"></i>Out · {{ outUnits }} of {{ asset.quantity }}</span>
            <button type="button" class="btn btn-sm btn-outline-secondary" @click="quickCheckIn">Check in all</button>
          </div>
          <div v-for="line in lines" :key="line.lineId" class="trax-kv">
            <span class="text-truncate">{{ line.customerName }} <span v-if="line.qty > 1">×{{ line.qty }}</span></span>
            <strong :class="{ 'text-danger': isOverdue(line.dueAt || line.returnDate) }">
              <span class="fw-normal">{{ isOverdue(line.dueAt || line.returnDate) ? 'Overdue' : 'due' }}</span>
              {{ formatDateTime(line.dueAt || line.returnDate) }}
            </strong>
          </div>
        </template>
        <div v-if="warrantyUntilOf(asset)" class="trax-kv">
          <span>Warranty<span v-if="hasUnits && asset.warrantyNextUnit"> · next {{ asset.id }}.{{ asset.warrantyNextUnit }}</span></span>
          <strong :class="{ 'text-warning': warrantyExpired }"
                  :title="expiredUnits.length ? 'Expired: ' + expiredUnits.join(', ') : ''">
            <span v-if="warrantyExpired">Expired · </span>{{ formatDate(warrantyUntilOf(asset)) }}
          </strong>
        </div>
        <div v-if="(testEnabled || testRecords.length) && needsAttention(testState)" class="trax-kv">
          <span>{{ testRule ? testRule.label : 'Tests' }}</span>
          <button type="button" class="btn btn-link btn-sm p-0 text-decoration-none" @click="tab = 'inspection'">
            <span class="trax-status-dot" :class="stateDot(testState)">{{ STATE_LABEL[testState] }}</span>
          </button>
        </div>
      </div>

      <ul class="nav nav-tabs nav-tabs-sm trax-sheet-tabs mb-3" v-if="!isNew">
        <li class="nav-item">
          <button class="nav-link" :class="{ active: tab === 'details' }" @click="tab = 'details'">Details</button>
        </li>
        <li class="nav-item" v-if="!isSet">
          <button class="nav-link" :class="{ active: tab === 'units' }" @click="tab = 'units'">
            Units <span v-if="asset?.units?.length" class="trax-tab-count">{{ asset.units.length }}</span>
          </button>
        </li>
        <li class="nav-item" v-if="isSet">
          <button class="nav-link" :class="{ active: tab === 'members' }" @click="tab = 'members'">
            Contents <span v-if="members.length" class="trax-tab-count">{{ members.length }}</span>
          </button>
        </li>
        <li class="nav-item">
          <button class="nav-link" :class="{ active: tab === 'rental' }" @click="tab = 'rental'">
            Rental <i v-if="rentalDirty" class="bi bi-dot text-warning"></i>
          </button>
        </li>
        <!-- Only where a test is asked for, or records already exist. -->
        <li class="nav-item" v-if="testEnabled || testRecords.length">
          <button class="nav-link" :class="{ active: tab === 'inspection' }" @click="tab = 'inspection'">
            Tests <span v-if="testRecords.length" class="trax-tab-count"
                        :class="{ 'text-danger': needsAttention(testState) }">{{ testRecords.length }}</span>
          </button>
        </li>
        <li class="nav-item">
          <button class="nav-link" :class="{ active: tab === 'condition' }" @click="tab = 'condition'">
            Condition <span v-if="conditionLog.length" class="trax-tab-count">{{ conditionLog.length }}</span>
          </button>
        </li>
        <li class="nav-item">
          <button class="nav-link" :class="{ active: tab === 'documents' }" @click="tab = 'documents'">
            Files <span v-if="documents.length" class="trax-tab-count">{{ documents.length }}</span>
          </button>
        </li>
        <li class="nav-item">
          <button class="nav-link" :class="{ active: tab === 'history' }" @click="tab = 'history'">History</button>
        </li>
      </ul>

      <!-- Details -->
      <form v-show="tab === 'details'" class="trax-form" @submit.prevent="save">
        <div class="trax-group">
          <div class="row g-2">
            <div class="col-12">
              <label class="form-label" for="f-name">Name</label>
              <input id="f-name" class="form-control" data-autofocus="desktop"
                     v-model="form.name" required maxlength="200">
            </div>
            <div class="col-6">
              <label class="form-label" for="f-category">Category</label>
              <input id="f-category" class="form-control" v-model="form.category" list="trax-categories">
            </div>
            <div class="col-6">
              <label class="form-label" for="f-location">Location</label>
              <input id="f-location" class="form-control" v-model="form.location" list="trax-locations">
            </div>
          </div>
        </div>

        <div class="trax-group">
          <div class="trax-group-title">Availability</div>
          <div class="row g-2">
            <div class="col-6" v-if="!isSet">
              <label class="form-label" for="f-status">Status</label>
              <select id="f-status" class="form-select" v-model="form.status">
                <option v-for="s in STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
              </select>
            </div>
            <div class="col-6" v-else>
              <label class="form-label">Status</label>
              <div class="trax-plain">From contents</div>
            </div>

            <div class="col-6" v-if="!isSet">
              <label class="form-label" for="f-quantity">Quantity</label>
              <input id="f-quantity" type="number" min="1" class="form-control"
                     v-model="form.quantity" :disabled="hasUnits">
              <div v-if="hasUnits" class="form-text">From {{ asset.units.length }} units</div>
              <div v-else-if="asset" class="form-text"
                   :title="outUnits ? 'Cannot go below ' + outUnits + ' while those are out' : ''">
                {{ asset.availableQty }} of {{ asset.quantity }} free<span v-if="outUnits"> · min. {{ outUnits }}</span>
              </div>
            </div>

            <!-- A tracked asset has no single grade: each unit carries its own. -->
            <div class="col-6" v-if="!hasUnits">
              <label class="form-label" for="f-condition">Condition</label>
              <select id="f-condition" class="form-select" v-model="form.condition">
                <option v-for="c in CONDITIONS" :key="c" :value="c">{{ CONDITION_LABEL[c] }}</option>
              </select>
            </div>
            <div class="col-6" v-else>
              <label class="form-label">Condition</label>
              <div class="trax-plain" title="Per unit">{{ unitConditions }}</div>
            </div>
          </div>
        </div>

        <div class="trax-group">
          <div class="trax-group-title">Purchase</div>
          <div class="row g-2">
            <div class="col-6">
              <label class="form-label" for="f-serial">Serial number</label>
              <input id="f-serial" class="form-control font-monospace" v-model="form.serial">
            </div>
            <div class="col-6">
              <label class="form-label" for="f-supplier">Supplier</label>
              <input id="f-supplier" class="form-control" v-model="form.supplier">
            </div>

            <!-- A tracked asset's units carry both dates; the summary reads them back. -->
            <div class="col-6" v-if="!hasUnits">
              <label class="form-label" for="f-purchased">Purchased</label>
              <input id="f-purchased" type="date" class="form-control" v-model="form.purchasedAt">
            </div>
            <div class="col-6" v-else>
              <label class="form-label">Purchased</label>
              <div class="trax-plain" title="Per unit, earliest">{{ formatDate(asset.purchasedFirst) }}</div>
            </div>

            <div class="col-6" v-if="!hasUnits">
              <label class="form-label" for="f-warranty">Warranty until</label>
              <input id="f-warranty" type="date" class="form-control" v-model="form.warrantyUntil">
              <div v-if="warrantyIsAuto" class="form-text">Auto · +{{ warrantyMonths }} months</div>
            </div>
            <div class="col-6" v-else>
              <label class="form-label">Warranty until</label>
              <div class="trax-plain" title="Per unit, next to expire">{{ formatDate(asset.warrantyNext) }}</div>
            </div>

            <div class="col-6">
              <label class="form-label" for="f-price">Price</label>
              <div class="input-group">
                <input id="f-price" class="form-control" v-model="priceField" inputmode="decimal"
                       placeholder="0,00" :disabled="unitPriced">
                <input class="form-control trax-currency" v-model="form.currency" maxlength="8" aria-label="Currency">
              </div>
              <div v-if="unitPriced" class="form-text">Sum of {{ asset.pricedUnits }} units</div>
            </div>

            <div class="col-6">
              <label class="form-label" for="f-tags">Tags</label>
              <input id="f-tags" class="form-control" v-model="form.tags" placeholder="comma, separated">
            </div>
          </div>
        </div>

        <div class="trax-group">
          <label class="trax-group-title" for="f-notes">Notes</label>
          <textarea id="f-notes" class="form-control" rows="2" v-model="form.notes"></textarea>
        </div>
      </form>

      <!-- Per-unit tracking. The server assigns the numbers, so a row reads
           "12.–" until saved. Saved on its own; the details form never carries
           the unit list. -->
      <div v-show="tab === 'units'">
        <div v-if="!unitsForm.length" class="trax-empty py-4">
          <i class="bi bi-list-ol"></i>
          Units aren't tracked individually.
          <div class="mt-3">
            <button type="button" class="btn btn-sm btn-outline-primary" @click="trackUnits"
                    :title="'Each unit gets a number like ' + asset?.id + '.1 and its own label'">
              Track {{ asset?.quantity }} units
            </button>
          </div>
        </div>

        <div v-else class="trax-list">
          <template v-for="(unit, ui) in unitsForm" :key="ui + '-' + (unit.no || 'new')">
            <div class="trax-row is-tappable" role="button" tabindex="0"
                 :aria-expanded="openUnit === ui ? 'true' : 'false'"
                 @click="toggleUnit(ui)" @keydown.enter.prevent="toggleUnit(ui)">
              <span class="trax-unit-code">{{ unitCode(unit) }}</span>
              <div class="trax-row-main">
                <div class="trax-row-title"><span>{{ unit.label || 'Unit ' + unitCode(unit) }}</span></div>
                <div class="trax-row-meta">
                  <span v-if="unit.state === 'OUT'" class="trax-status-dot status-UNAV">{{ unitDetail(unit) }}</span>
                  <span v-else-if="unit.state === 'OOS' || unit.outOfService" class="trax-status-dot status-LOCK">Out of service</span>
                  <span v-else-if="unit.state" class="trax-status-dot status-FREE">Available</span>
                  <span v-else class="trax-kind-chip">Unsaved</span>
                  <span>{{ CONDITION_LABEL[unit.condition] }}</span>
                  <span v-if="unit.serial" class="font-monospace">{{ unit.serial }}</span>
                </div>
              </div>
              <i class="bi trax-row-chevron" :class="openUnit === ui ? 'bi-chevron-up' : 'bi-chevron-down'"></i>
            </div>

            <div v-if="openUnit === ui" class="trax-unit-edit">
              <div class="row g-2">
                <div class="col-6">
                  <label class="form-label" :for="'f-unit-label-' + ui">Label</label>
                  <input class="form-control form-control-sm" :id="'f-unit-label-' + ui"
                         v-model="unit.label" maxlength="120" placeholder="e.g. Red" @input="touchUnits">
                </div>
                <div class="col-6">
                  <label class="form-label" :for="'f-unit-serial-' + ui">Serial</label>
                  <input class="form-control form-control-sm font-monospace" :id="'f-unit-serial-' + ui"
                         v-model="unit.serial" maxlength="120" @input="touchUnits">
                </div>
                <div class="col-6">
                  <label class="form-label" :for="'f-unit-cond-' + ui">Condition</label>
                  <select class="form-select form-select-sm" :id="'f-unit-cond-' + ui"
                          v-model="unit.condition" @change="touchUnits">
                    <option v-for="c in CONDITIONS" :key="c" :value="c">{{ CONDITION_LABEL[c] }}</option>
                  </select>
                </div>
                <div class="col-6">
                  <label class="form-label" :for="'f-unit-price-' + ui">Price</label>
                  <input class="form-control form-control-sm" :id="'f-unit-price-' + ui" type="text"
                         inputmode="decimal" v-model="unit.price" placeholder="0,00" @input="touchUnits">
                </div>
                <!-- Bound by hand, not with v-model: onUnitPurchased() needs the
                     date the row had to tell an auto-filled warranty from a
                     typed one. -->
                <div class="col-6">
                  <label class="form-label" :for="'f-unit-bought-' + ui">Purchased</label>
                  <input class="form-control form-control-sm" type="date" :id="'f-unit-bought-' + ui"
                         :value="unit.purchasedAt" @input="onUnitPurchased(unit, $event.target.value)">
                </div>
                <div class="col-6">
                  <label class="form-label" :for="'f-unit-warranty-' + ui">Warranty until</label>
                  <input class="form-control form-control-sm" type="date" :id="'f-unit-warranty-' + ui"
                         v-model="unit.warrantyUntil" @input="touchUnits">
                  <div v-if="unitWarrantyIsAuto(unit)" class="form-text">Auto · +{{ warrantyMonths }} months</div>
                </div>
                <div class="col-12">
                  <label class="form-label" :for="'f-unit-note-' + ui">Note</label>
                  <input class="form-control form-control-sm" :id="'f-unit-note-' + ui"
                         v-model="unit.note" maxlength="500" @input="touchUnits">
                </div>
              </div>
              <div class="d-flex align-items-center gap-2 mt-3">
                <div class="form-check form-switch mb-0 flex-grow-1">
                  <input class="form-check-input" type="checkbox" :id="'f-unit-oos-' + ui"
                         v-model="unit.outOfService" @change="touchUnits">
                  <label class="form-check-label small" :for="'f-unit-oos-' + ui">Out of service</label>
                </div>
                <button type="button" class="btn btn-sm btn-outline-danger"
                        :disabled="unit.state === 'OUT'"
                        :title="unit.state === 'OUT' ? 'Checked out — return it first' : 'Remove this unit'"
                        :aria-label="'Remove unit ' + unitCode(unit)"
                        @click="removeUnitAt(ui)">
                  <i class="bi bi-trash"></i> Remove
                </button>
              </div>
            </div>
          </template>
        </div>

        <div v-if="unitsForm.length || unitsDirty" class="d-flex align-items-center gap-2 mt-3">
          <button type="button" class="btn btn-sm btn-outline-primary" @click="addUnitOpen">
            <i class="bi bi-plus-lg"></i> Add unit
          </button>
          <span class="flex-grow-1 small text-secondary text-end">{{ unitsDirty ? 'Unsaved changes' : '' }}</span>
          <button type="button" class="btn btn-sm btn-primary"
                  :disabled="!unitsDirty || saving" @click="saveUnits">
            <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>
            Save units
          </button>
        </div>
      </div>

      <!-- Rental rates: what the gear costs to HIRE. The value below is only
           the basis a percentage rate is worked out from. -->
      <div v-if="tab === 'rental' && !isNew">
        <div v-if="isSet" class="trax-empty py-4">
          <i class="bi bi-tags"></i>
          Kits are charged by their contents.
        </div>

        <template v-else>
          <div class="trax-list">
            <div class="trax-kv">
              <span title="Edit under Settings → Rental rates">{{ categoryRateLabel }}</span>
              <strong class="text-end">{{ categoryRateText }}</strong>
            </div>
            <div class="trax-kv">
              <span title="Per unit. Percentage rates are based on this.">Value per unit</span>
              <strong>{{ formatMoney(unitPriceOf(asset), rentalCurrency) || '—' }}</strong>
            </div>
            <div class="trax-kv">
              <label class="mb-0" for="f-rental-days"
                     :title="activeTier ? 'Discount from ' + activeTier.days + ' days' : 'Preview only'">
                Preview for<span v-if="activeTier" class="text-success"> · discount</span>
              </label>
              <div class="input-group input-group-sm trax-days-input">
                <input id="f-rental-days" class="form-control text-end" type="number" min="1" max="3650"
                       v-model="rentalDays">
                <span class="input-group-text">days</span>
              </div>
            </div>
          </div>

          <div class="trax-group">
            <div class="trax-group-title">This asset</div>
            <RentalRate :rule="rentalForm.rental" variant="override" :currency="rentalCurrency"
                        :inherit-label="categoryRate.source === 'category'
                          ? 'Category rate' : 'Default rate'"
                        @change="touchRental" />
            <div class="form-text">
              {{ rateText(null) }} · {{ rateSource(null) }}
            </div>
          </div>

          <!-- Per unit. Only the rate is editable here; prices live in Units. -->
          <div v-if="rentalForm.units.length" class="trax-group">
            <div class="trax-group-title">Per unit</div>
            <div class="trax-list">
              <div v-for="(row, ri) in rentalForm.units" :key="row.no" class="trax-row d-block">
                <div class="d-flex align-items-center gap-2 mb-2">
                  <span class="trax-unit-code">{{ asset.id }}.{{ row.no }}</span>
                  <span v-if="asset?.units?.[ri]?.label" class="small fw-semibold text-truncate">{{ asset.units[ri].label }}</span>
                  <span class="flex-grow-1"></span>
                  <span class="small text-secondary">{{ unitValueText(ri) }}</span>
                </div>
                <RentalRate :rule="row.rental" variant="override" :dense="true"
                            :currency="rentalCurrency" inherit-label="Asset rate"
                            @change="touchRental" />
                <div class="form-text">
                  {{ rateText(rentalUnitAt(ri)) }} · {{ rateSource(rentalUnitAt(ri)) }}
                </div>
              </div>
            </div>
          </div>

          <div class="d-flex align-items-center gap-2 mt-3">
            <span class="flex-grow-1 small text-secondary">{{ rentalDirty ? 'Unsaved changes' : '' }}</span>
            <button type="button" class="btn btn-sm btn-primary"
                    title="Bookings are always priced at the rates in force"
                    :disabled="!rentalDirty || saving" @click="saveRental">
              <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>
              Save rates
            </button>
          </div>
        </template>
      </div>

      <!-- Test records. One history per physical piece: cable 183.5, not "cables". -->
      <div v-if="tab === 'inspection' && !isNew">
        <div class="d-flex align-items-start gap-2 mb-3">
          <div class="flex-grow-1 min-w-0 small">
            <template v-if="testEnabled">
              <div class="d-flex flex-wrap align-items-center gap-2">
                <strong>{{ testRule.label }}</strong>
                <span class="trax-status-dot" :class="stateDot(testState)">{{ STATE_LABEL[testState] }}</span>
              </div>
              <div class="text-secondary">
                {{ testRule.intervalMonths ? 'Every ' + testRule.intervalMonths + ' months' : 'No repeat' }}<span
                  v-if="(testRule.fields || []).length"> · {{ testRule.fields.join(', ') }}</span>
              </div>
            </template>
            <span v-else class="text-secondary" title="Switch tests on per category under Settings → Inspections">
              <i class="bi bi-info-circle"></i>
              Tests are off for {{ asset?.category ? '"' + asset.category + '"' : 'items without a category' }}.
            </span>
          </div>
          <button type="button" class="btn btn-sm btn-outline-secondary text-nowrap"
                  :disabled="exportingTest || !testRecords.length" @click="inspectionPdf"
                  aria-label="Test report PDF for this asset">
            <span v-if="exportingTest" class="spinner-border spinner-border-sm me-1"></span>
            <i v-else class="bi bi-file-earmark-text"></i>
            Report
          </button>
        </div>

        <div class="trax-list">
          <div v-for="row in testRows" :key="row.code" class="trax-row d-block">
            <div class="d-flex align-items-center gap-2">
              <span class="trax-unit-code">{{ row.code }}</span>
              <span v-if="row.label" class="small fw-semibold text-truncate">{{ row.label }}</span>
              <span class="trax-status-dot small" :class="stateDot(row.state)">{{ STATE_LABEL[row.state] }}</span>
              <span class="flex-grow-1"></span>
              <button type="button" class="btn btn-sm btn-outline-primary text-nowrap"
                      :disabled="testBusy" @click="openTest(row)"
                      :aria-label="'Record a test for ' + row.code">
                <i class="bi bi-plus-lg"></i> Test
              </button>
            </div>

            <!-- The form, under the piece it is about. -->
            <div v-if="testFor === row.code && testForm" class="trax-unit-edit px-0 pb-1">
              <div class="row g-2">
                <div class="col-6 col-md-4">
                  <label class="form-label" for="f-test-at">Tested on</label>
                  <input class="form-control form-control-sm" id="f-test-at" type="date"
                         :value="testForm.at" @input="onTestDate($event.target.value)">
                </div>
                <div class="col-6 col-md-4">
                  <label class="form-label" for="f-test-result">Result</label>
                  <!-- Bound by hand: onTestResult() compares the next date
                       against what the interval said before the change. -->
                  <select class="form-select form-select-sm" id="f-test-result"
                          :value="testForm.result" @change="onTestResult($event.target.value)">
                    <option v-for="r in RESULTS" :key="r" :value="r">{{ RESULT_LABEL[r] }}</option>
                  </select>
                </div>
                <div class="col-12 col-md-4">
                  <label class="form-label" for="f-test-next">Next test</label>
                  <input class="form-control form-control-sm" id="f-test-next" type="date"
                         v-model="testForm.nextAt">
                </div>
                <div class="col-6">
                  <label class="form-label" for="f-test-by">Tested by</label>
                  <input class="form-control form-control-sm" id="f-test-by" maxlength="120"
                         v-model="testForm.by">
                </div>
                <div class="col-6">
                  <label class="form-label" for="f-test-label">Test</label>
                  <input class="form-control form-control-sm" id="f-test-label" maxlength="120"
                         v-model="testForm.label" placeholder="e.g. DGUV V3">
                </div>

                <!-- The parameters the category asks for, in its order. -->
                <div v-for="(field, vi) in testForm.values" :key="vi" class="col-6">
                  <label class="form-label" :for="'f-test-value-' + vi">
                    {{ field.name || ('Parameter ' + (vi + 1)) }}
                  </label>
                  <input class="form-control form-control-sm" :id="'f-test-value-' + vi"
                         maxlength="120" v-model="field.value">
                </div>

                <div class="col-12">
                  <label class="form-label" for="f-test-note">Note</label>
                  <textarea class="form-control form-control-sm" id="f-test-note" rows="2"
                            maxlength="1000" v-model="testForm.note"></textarea>
                </div>

                <div class="col-12">
                  <label class="form-label" for="f-test-file">Certificate</label>
                  <input class="form-control form-control-sm" id="f-test-file" type="file"
                         accept="application/pdf,image/jpeg,image/png,image/webp,text/plain"
                         title="PDF, image or text — optional" @change="pickTestFile">
                </div>
              </div>

              <div class="d-flex justify-content-end gap-2 mt-3">
                <button type="button" class="btn btn-sm btn-outline-secondary"
                        :disabled="testBusy" @click="closeTest">Cancel</button>
                <button type="button" class="btn btn-sm btn-primary"
                        :disabled="testBusy" @click="submitTest">
                  <span v-if="testBusy" class="spinner-border spinner-border-sm me-1"></span>
                  Save test
                </button>
              </div>
            </div>

            <!-- This piece's history, newest first. -->
            <ol v-if="row.records.length" class="trax-test-log">
              <li v-for="record in row.records" :key="record.id">
                <div class="d-flex align-items-center gap-2 flex-wrap">
                  <span class="trax-status-dot" :class="record.result === 'PASS' ? 'status-FREE' : 'status-UNAV'">
                    {{ RESULT_LABEL[record.result] }}
                  </span>
                  <span>{{ formatDate(record.at) }}</span>
                  <span v-if="record.label" class="trax-kind-chip">{{ record.label }}</span>
                  <span class="flex-grow-1"></span>
                  <button v-if="record.file" type="button" class="btn btn-sm btn-outline-secondary"
                          title="Certificate" @click="openCertificate(record)"
                          :aria-label="'Open the certificate of the test on ' + formatDate(record.at)">
                    <i class="bi bi-paperclip"></i>
                  </button>
                  <label v-else class="btn btn-sm btn-outline-secondary mb-0" title="Attach certificate">
                    <i class="bi bi-upload"></i>
                    <input type="file" class="d-none" :disabled="testBusy"
                           accept="application/pdf,image/jpeg,image/png,image/webp,text/plain"
                           @change="attachCertificate(record, $event)">
                  </label>
                  <button type="button" class="btn btn-sm btn-outline-danger"
                          :disabled="testBusy" @click="testConfirm = record"
                          :aria-label="'Remove the test record of ' + formatDate(record.at)">
                    <i class="bi bi-trash"></i>
                  </button>
                </div>
                <div class="text-secondary">
                  <span v-if="record.nextAt">Next {{ formatDate(record.nextAt) }}</span><span
                    v-if="record.nextAt && record.by"> · </span><span v-if="record.by">{{ record.by }}</span>
                </div>
                <div v-if="record.values.length" class="text-secondary">
                  <span v-for="(value, xi) in record.values" :key="xi">
                    {{ value.name }}: <span class="font-monospace">{{ value.value }}</span><span
                      v-if="xi < record.values.length - 1"> · </span>
                  </span>
                </div>
                <div v-if="record.note" class="text-secondary">{{ record.note }}</div>
              </li>
            </ol>
            <div v-else class="small text-secondary mt-1">No tests yet</div>
          </div>
        </div>

        <!-- Records filed before the units were listed; they would otherwise vanish. -->
        <div v-if="testLoose.length" class="trax-group">
          <div class="trax-group-title">Whole asset</div>
          <div class="trax-list">
            <div v-for="record in testLoose" :key="record.id" class="trax-kv">
              <span>
                <span class="trax-status-dot" :class="record.result === 'PASS' ? 'status-FREE' : 'status-UNAV'">
                  {{ RESULT_LABEL[record.result] }}</span>
                {{ formatDate(record.at) }}<span v-if="record.by"> · {{ record.by }}</span>
              </span>
              <button v-if="record.file" type="button" class="btn btn-sm btn-outline-secondary"
                      title="Certificate" @click="openCertificate(record)">
                <i class="bi bi-paperclip"></i>
              </button>
              <button type="button" class="btn btn-sm btn-outline-danger" title="Remove"
                      :disabled="testBusy" @click="testConfirm = record">
                <i class="bi bi-trash"></i>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Kit contents -->
      <div v-show="tab === 'members'">
        <div class="trax-list-header">
          <span class="flex-grow-1" title="Deleting the kit never deletes these items">
            {{ members.length }} item(s) · status follows contents
          </span>
          <!-- The kit editor, opened on this kit. -->
          <button type="button" class="btn btn-sm btn-outline-secondary text-nowrap"
                  @click="emit('edit-kit', assetId)">
            <i class="bi bi-pencil"></i> Edit
          </button>
        </div>
        <div v-if="members.length" class="trax-list">
          <div v-for="(member, mi) in members" :key="mi + '-' + member.id" class="trax-row">
            <button v-if="member.photo" type="button" class="trax-thumb-btn"
                    :aria-label="'Show the photo of ' + member.name"
                    @click.stop="openAssetPhoto(member)">
              <img class="trax-thumb" :src="'uploads/thumb/' + member.photo" alt="">
            </button>
            <span v-else class="trax-thumb trax-thumb-placeholder"><i class="bi bi-camera"></i></span>
            <div class="trax-row-main">
              <button class="trax-name-btn text-truncate mw-100" @click="emit('open', member.id)">{{ member.name }}</button>
              <div class="trax-row-meta">
                <span class="trax-status-dot" :class="'status-' + member.effectiveStatus">
                  {{ statusLabel(member.effectiveStatus, member.kind) }}<span
                    v-if="member.quantity > 1"> · {{ member.availableQty }} of {{ member.quantity }} free</span>
                </span>
              </div>
            </div>
            <span v-if="member.reqQty > 1" class="trax-kind-chip">×{{ member.reqQty }}</span>
          </div>
        </div>
        <div v-else class="trax-empty py-4"><i class="bi bi-box-seam"></i>This kit is empty</div>
      </div>

      <!-- Condition log: belongs to the asset, not a booking, and outlives
           every loan. capture="environment" opens a phone's rear camera. -->
      <div v-show="tab === 'condition'">
        <div class="d-flex align-items-center gap-2 mb-3">
          <span class="small text-secondary flex-grow-1">Dated photos of this item</span>
          <label class="btn btn-sm btn-outline-primary mb-0" for="f-condition-photos"
                 :title="'Up to ' + MAX_PHOTOS + ' at once'">
            <i class="bi bi-camera"></i> Add photos
          </label>
          <input id="f-condition-photos" class="d-none" type="file"
                 multiple accept="image/*" capture="environment" @change="pickConditionPhotos">
        </div>

        <div v-if="conditionFiles.length" class="trax-card trax-card-pad mb-3">
          <input class="form-control form-control-sm" v-model="conditionNote"
                 aria-label="Comment on these photos" placeholder="Comment (scratch, dent…)">
          <div class="d-flex align-items-center gap-2 mt-2">
            <span class="trax-kind-chip"><i class="bi bi-camera"></i> {{ conditionFiles.length }} photo(s)</span>
            <span class="flex-grow-1"></span>
            <button type="button" class="btn btn-sm btn-outline-secondary" @click="clearConditionPick">Clear</button>
            <button type="button" class="btn btn-sm btn-primary"
                    :disabled="conditionBusy" @click="sendConditionPhotos">
              <span v-if="conditionBusy" class="spinner-border spinner-border-sm me-1"></span>
              Upload
            </button>
          </div>
        </div>

        <div v-if="conditionLog.length" class="trax-list">
          <div v-for="shot in conditionLog" :key="shot.file" class="trax-row">
            <button type="button" class="trax-thumb-btn"
                    :aria-label="'Show the condition photo from ' + formatDateTime(shot.at)"
                    @click="openConditionPhoto(shot.file)">
              <img class="trax-thumb" :src="'uploads/thumb/' + shot.file" alt="Condition photo">
            </button>
            <div class="trax-row-main">
              <div class="small fw-semibold">{{ formatDateTime(shot.at) }}</div>
              <div v-if="shot.note" class="trax-row-meta">{{ shot.note }}</div>
            </div>
            <button type="button" class="btn btn-sm btn-outline-danger"
                    :aria-label="'Delete the condition photo from ' + formatDateTime(shot.at)"
                    @click="removeConditionPhoto(shot.file)">
              <i class="bi bi-trash"></i>
            </button>
          </div>
        </div>
        <div v-else-if="!conditionFiles.length" class="trax-empty py-4">
          <i class="bi bi-images"></i>No condition photos
        </div>
      </div>

      <!-- Documents: manuals, receipts, certificates. Never public — served
           through download.php behind the login, on no customer page. -->
      <div v-show="tab === 'documents'">
        <div class="d-flex align-items-center gap-2 mb-3">
          <span class="small text-secondary flex-grow-1"
                :title="'PDF, JPEG, PNG, WebP or text · up to ' + MAX_ASSET_DOCS + ' per item'">
            Internal only · max. {{ MAX_ASSET_DOCS }}
          </span>
          <label class="btn btn-sm btn-outline-primary mb-0" for="f-documents"
                 :title="'Up to ' + MAX_DOCS + ' at once'">
            <i class="bi bi-paperclip"></i> Attach
          </label>
          <input id="f-documents" class="d-none" type="file"
                 multiple accept=".pdf,.txt,.jpg,.jpeg,.png,.webp,application/pdf,text/plain,image/jpeg,image/png,image/webp"
                 @change="pickDocuments">
        </div>

        <div v-if="docFiles.length" class="trax-card trax-card-pad mb-3">
          <input class="form-control form-control-sm" v-model="docTitle"
                 aria-label="Label for these documents" maxlength="200"
                 placeholder="Label (manual, receipt…)">
          <div class="d-flex align-items-center gap-2 mt-2">
            <span class="trax-kind-chip"><i class="bi bi-paperclip"></i> {{ docFiles.length }} file(s)</span>
            <span class="flex-grow-1"></span>
            <button type="button" class="btn btn-sm btn-outline-secondary" @click="clearDocPick">Clear</button>
            <button type="button" class="btn btn-sm btn-primary"
                    :disabled="docBusy" @click="sendDocuments">
              <span v-if="docBusy" class="spinner-border spinner-border-sm me-1"></span>
              Upload
            </button>
          </div>
        </div>

        <div v-if="documents.length" class="trax-list">
          <div v-for="doc in documents" :key="doc.file" class="trax-row">
            <span class="trax-thumb trax-thumb-placeholder"><i class="bi bi-file-earmark-text"></i></span>
            <div class="trax-row-main">
              <!-- The name previews; the button beside it downloads. -->
              <button type="button" class="trax-name-btn text-truncate mw-100 text-start"
                      :aria-label="'Preview ' + doc.name" @click="openDocument(doc)">
                {{ doc.title || doc.name }}
              </button>
              <div class="trax-row-meta text-truncate">
                <span v-if="doc.title" class="text-truncate">{{ doc.name }}</span>
                <span>{{ formatSize(doc.size) }}</span>
                <span>{{ formatDate(doc.addedAt) }}</span>
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
          </div>
        </div>
        <div v-else-if="!docFiles.length" class="trax-empty py-4">
          <i class="bi bi-folder2-open"></i>No files attached
        </div>
      </div>

      <!-- History -->
      <div v-show="tab === 'history'">
        <div v-if="history.length" class="trax-list">
          <div v-for="entry in history" :key="entry.id" class="trax-row">
            <div class="trax-row-main">
              <div class="trax-row-title">
                <span class="trax-history-type">{{ entry.type.replace(/_/g, ' ') }}</span>
              </div>
              <div class="trax-row-meta">
                <span>{{ formatDateTime(entry.at) }}</span>
                <span v-if="entry.customerName">{{ entry.customerName }}</span>
                <span v-if="entry.note">{{ entry.note }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="trax-empty py-4"><i class="bi bi-clock-history"></i>Nothing recorded yet</div>
      </div>

      <datalist id="trax-categories">
        <option v-for="c in categories" :key="c" :value="c"></option>
      </datalist>
      <datalist id="trax-locations">
        <option v-for="l in locations" :key="l" :value="l"></option>
      </datalist>

      <template #footer>
        <Menu v-if="!isNew" label="More actions" icon="bi-three-dots" up align="start"
              button-class="btn btn-outline-secondary trax-footer-more">
          <button type="button" class="trax-menu-item" @click="emit('label', asset.id)">
            <i class="bi bi-qr-code"></i> Print label
          </button>
          <button v-if="isSet" type="button" class="trax-menu-item" @click="emit('edit-kit', assetId)">
            <i class="bi bi-box-seam"></i> Edit contents
          </button>
          <button type="button" class="trax-menu-item" @click="fileInput.click()">
            <i class="bi bi-camera"></i> {{ asset?.photo ? 'Replace photo' : 'Add photo' }}
          </button>
          <button v-if="asset?.photo" type="button" class="trax-menu-item" @click="removePhoto">
            <i class="bi bi-image"></i> Remove photo
          </button>
          <div class="trax-menu-sep"></div>
          <button type="button" class="trax-menu-item is-danger" @click="confirmDelete = true">
            <i class="bi bi-trash"></i> {{ isSet ? 'Delete kit' : 'Delete asset' }}
          </button>
        </Menu>
        <span class="flex-grow-1"></span>
        <button type="button" class="btn btn-outline-secondary" @click="emit('close')">Cancel</button>
        <button type="button" class="btn btn-primary" :disabled="saving" @click="save">
          <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>
          {{ isNew ? 'Create' : 'Save' }}
        </button>
      </template>
    </Drawer>

    <ConfirmDialog v-if="confirmDelete"
                   :title="isSet ? 'Delete this kit?' : 'Delete this asset?'"
                   :message="isSet
                     ? 'The items inside it are kept.'
                     : 'The asset and its photo are removed. History is kept.'"
                   confirm-label="Delete" danger
                   @confirm="remove" @cancel="confirmDelete = false" />

    <!-- A test record is documentation, so removing one asks first. -->
    <ConfirmDialog v-if="testConfirm"
                   title="Remove this test record?"
                   :message="'The ' + (testConfirm.label || 'test') + ' of ' + formatDate(testConfirm.at)
                     + (testConfirm.file ? ' and its certificate' : '') + ' will be deleted. This cannot be undone.'"
                   confirm-label="Remove" danger
                   @confirm="removeTest" @cancel="testConfirm = null" />
  `,
};
