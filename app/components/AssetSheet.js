import { ref, computed, watch } from 'vue';
import {
  state, getAsset, getLines, historyFor, membersOf, mutate, uploadPhoto,
  uploadConditionPhotos, uploadDocuments, deleteDocument, toast,
  categories, locations,
} from '../store.js';
import {
  STATUSES, CONDITIONS, CONDITION_LABEL, statusLabel,
  formatDate, formatDateTime, formatMoney, toDateInput, isOverdue,
} from '../lib/format.js';
import Drawer from './ui/Drawer.js';
import StatusBadge from './ui/StatusBadge.js';
import ConfirmDialog from './ui/ConfirmDialog.js';

const BLANK = {
  name: '', status: 'FREE', notes: '', category: '', location: '',
  serial: '', supplier: '', purchasedAt: '', price: '', currency: 'EUR',
  warrantyUntil: '', condition: 'GOOD', tags: '', quantity: 1,
};

/**
 * `YYYY-MM-DD` plus N months, clamped to the last day of the target month —
 * 2024-01-31 + 1 is 2024-02-29, not 2024-03-02. Anything else in, '' out.
 */
const addMonths = (value, months) => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!parts || !Number.isFinite(months)) return '';

  const day = Number(parts[3]);
  const target = new Date(Number(parts[1]), Number(parts[2]) - 1 + months, 1);
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return toDateInput(target);
};

/** Create/edit one asset, plus its live state and history. */
export default {
  name: 'AssetSheet',
  components: { Drawer, StatusBadge, ConfirmDialog },
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

    const asset = computed(() => (props.assetId ? getAsset(props.assetId) : null));
    const isNew = computed(() => !props.assetId);
    const isSet = computed(() => asset.value?.kind === 'SET');
    // Quantity is derived server-side once units are tracked.
    const hasUnits = computed(() => !!asset.value?.units?.length);
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

    const warrantyExpired = computed(() => {
      const until = asset.value?.warrantyUntil;
      return until ? isOverdue(until) : false;
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
          unitsForm.value = (value?.units || []).map((unit) => ({ ...unit }));
          unitsDirty.value = false;
        }
        unitsFor.value = value?.id ?? null;
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

    // `form` deliberately has no `units` key: saving the details must never
    // rewrite the unit list, which the Units tab owns.
    const patch = () => ({
      ...form.value,
      // A kit has no quantity of its own; the server pins it to 1 anyway.
      quantity: isSet.value ? undefined : Math.max(1, Number(form.value.quantity) || 1),
      price: form.value.price === '' ? null : form.value.price,
      purchasedAt: form.value.purchasedAt || null,
      warrantyUntil: form.value.warrantyUntil || null,
      tags: form.value.tags
        ? form.value.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [],
    });

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

    const blankUnit = () => ({
      no: null, label: '', serial: '',
      condition: form.value.condition || 'GOOD', outOfService: false, note: '',
    });

    /** "12.1" — the code that goes on this unit's own label. */
    const unitCode = (unit) => `${props.assetId}.${unit.no ? unit.no : '\u2013'}`;
    const unitDetail = (unit) =>
      `${unit.customerName || 'out'} \u00b7 due ${formatDate(unit.dueAt)}`;

    const touchUnits = () => { unitsDirty.value = true; };

    /** Turn a plain quantity into that many blank, editable units. */
    const trackUnits = () => {
      const count = Math.max(1, Number(asset.value?.quantity) || 1);
      unitsForm.value = Array.from({ length: count }, blankUnit);
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

    /** Only the six stored keys go back; `state`, `lineId` &c. are derived. */
    const saveUnits = async () => {
      saving.value = true;
      try {
        const units = unitsForm.value.map((unit) => ({
          no: unit.no || null,
          label: unit.label || '',
          serial: unit.serial || '',
          condition: unit.condition || 'GOOD',
          outOfService: !!unit.outOfService,
          note: unit.note || '',
        }));
        await mutate('asset.update', { id: props.assetId, patch: { units } });
        toast('Units saved.', 'success');
        unitsDirty.value = false;
        // The server assigns the numbers, so take the list back from it.
        unitsForm.value = (asset.value?.units || []).map((unit) => ({ ...unit }));
      } catch {
        /* toast already raised by the store */
      } finally {
        saving.value = false;
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
      asset, isNew, isSet, hasUnits, lines, outUnits, history, members, warrantyExpired,
      warrantyMonths, warrantyIsAuto,
      unitsForm, unitsDirty, unitCode, unitDetail, touchUnits,
      trackUnits, addUnit, removeUnit, saveUnits,
      MAX_PHOTOS, conditionFiles, conditionNote, conditionBusy, conditionLog,
      pickConditionPhotos, clearConditionPick, sendConditionPhotos, removeConditionPhoto,
      MAX_DOCS, MAX_ASSET_DOCS, docFiles, docTitle, docBusy, documents,
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

      <div v-if="warrantyExpired" class="alert alert-warning py-2 px-3 small">
        <i class="bi bi-shield-exclamation"></i>
        Warranty expired {{ formatDateTime(asset.warrantyUntil) }}.
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

          <div class="col-6">
            <label class="form-label small" for="f-condition">Condition</label>
            <select id="f-condition" class="form-select form-select-sm" v-model="form.condition">
              <option v-for="c in CONDITIONS" :key="c" :value="c">{{ CONDITION_LABEL[c] }}</option>
            </select>
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

          <div class="col-6">
            <label class="form-label small" for="f-purchased">Purchased</label>
            <input id="f-purchased" type="date" class="form-control form-control-sm" v-model="form.purchasedAt">
          </div>

          <div class="col-6">
            <label class="form-label small" for="f-warranty">Warranty until</label>
            <input id="f-warranty" type="date" class="form-control form-control-sm" v-model="form.warrantyUntil">
            <div v-if="warrantyIsAuto" class="form-text small">
              Auto-filled as purchase date + {{ warrantyMonths }} months — change it if the
              warranty is longer.
            </div>
          </div>

          <div class="col-6">
            <label class="form-label small" for="f-price">Price</label>
            <div class="input-group input-group-sm">
              <input id="f-price" class="form-control" v-model="form.price" inputmode="decimal" placeholder="0,00">
              <input class="form-control" style="max-width:5rem" v-model="form.currency" maxlength="8" aria-label="Currency">
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
              <img v-if="asset?.photo" :src="'uploads/' + asset.photo" alt=""
                   style="width:96px;height:96px;object-fit:cover;border-radius:8px">
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
              <div class="col-4 d-flex align-items-center">
                <div class="form-check form-switch mb-0">
                  <input class="form-check-input" type="checkbox" :id="'f-unit-oos-' + ui"
                         v-model="unit.outOfService" @change="touchUnits">
                  <label class="form-check-label small" :for="'f-unit-oos-' + ui">Out of service</label>
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

      <!-- Kit contents -->
      <div v-show="tab === 'members'">
        <p class="small text-secondary">
          A kit's status is derived from its contents. Deleting the kit never deletes these items.
        </p>
        <ul class="list-group list-group-flush">
          <li v-for="(member, mi) in members" :key="mi + '-' + member.id"
              class="list-group-item bg-transparent d-flex align-items-center gap-2 px-0">
            <img v-if="member.photo" class="trax-thumb" :src="'uploads/thumb/' + member.photo" alt="">
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
            <a :href="'uploads/' + shot.file" target="_blank" rel="noopener noreferrer">
              <img class="trax-thumb" :src="'uploads/thumb/' + shot.file" alt="Condition photo">
            </a>
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
              <div class="small text-truncate">
                <strong v-if="doc.title">{{ doc.title }}</strong>
                <span v-else>{{ doc.name }}</span>
              </div>
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
  `,
};
