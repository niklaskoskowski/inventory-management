/**
 * The single reactive store.
 *
 * Module identity gives us a singleton for free — components just import
 * `state`. No bundler, no Pinia, and none of the implicit-global coupling
 * the old checkout.module.js relied on.
 *
 * Mutations send a delta and receive the whole snapshot back. The data set is
 * ~20 KB, so replacing it wholesale removes all client-side merge logic.
 */

import { reactive, computed } from 'vue';
import * as api from './api.js';
import { parseDate, isOverdue, setUiLocale, totalPriceOf } from './lib/format.js';

const VIEW_STATE_KEY = 'traxAdminViewStateV2';

/**
 * Bumped whenever DEFAULT_VIEW.columns gains a column.
 *
 * A saved `columns` array used to replace the default wholesale, so anyone who
 * had ever touched a filter never saw a column shipped later — the feature was
 * invisible to exactly the people already using the app. Saved state below the
 * current version gets the columns listed in COLUMNS_ADDED merged in once.
 */
const COLUMNS_VERSION = 1;

/**
 * version => columns introduced at that version.
 *
 * Per version rather than a union with the whole default set: a user who hid
 * `notes` must keep it hidden, and a plain union would hand it straight back.
 */
const COLUMNS_ADDED = {
  1: ['quantity'],
};

const DEFAULT_VIEW = {
  search: '',
  status: '',
  category: '',
  location: '',
  kind: '',
  sortBy: 'name',
  sortDir: 'asc',
  density: 'comfortable',
  columns: ['quantity', 'category', 'location', 'notes'],
  columnsVersion: COLUMNS_VERSION,
};

/** Saved columns plus everything added after `from`, in DEFAULT_VIEW order. */
function mergeColumns(saved, from) {
  const wanted = new Set(saved.filter((column) => typeof column === 'string'));
  for (const [version, added] of Object.entries(COLUMNS_ADDED)) {
    if (Number(version) > from) for (const column of added) wanted.add(column);
  }
  // Unknown columns — a future build's, on a browser that downgraded — keep
  // their place at the end rather than being silently dropped.
  return [
    ...DEFAULT_VIEW.columns.filter((column) => wanted.has(column)),
    ...[...wanted].filter((column) => !DEFAULT_VIEW.columns.includes(column)),
  ];
}

function loadViewState() {
  let saved = null;
  try {
    const raw = localStorage.getItem(VIEW_STATE_KEY);
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null; // corrupt entry, or no storage at all — the defaults are fine
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { ...DEFAULT_VIEW };

  const view = { ...DEFAULT_VIEW, ...saved };
  const version = Number(saved.columnsVersion) || 0;

  if (!Array.isArray(saved.columns)) {
    view.columns = [...DEFAULT_VIEW.columns];
  } else if (version >= COLUMNS_VERSION) {
    view.columns = [...saved.columns];
  } else {
    view.columns = mergeColumns(saved.columns, version);
  }

  // Adopted here; setFilter() persists it with the next preference change.
  view.columnsVersion = COLUMNS_VERSION;
  return view;
}

/**
 * Mirrors trax_normalize_settings() in lib/store.php.
 *
 * Seeded rather than left empty so the Settings view can bind to
 * `state.settings.email.ownerEmail` before the first snapshot lands — an
 * undefined intermediate there is a render error, not an empty field.
 * The server's values overwrite all of this on the first load().
 */
const DEFAULT_SETTINGS = {
  email: {
    ownerEmail: '',
    fromEmail: '',
    reportFromEmail: '',
    sendCheckoutConfirmation: true,
    sendReservationConfirmation: true,
    sendExtend: true,
    sendCheckin: true,
    sendDueSoon: true,
    sendOverdue: true,
    sendOwnerDigest: true,
    // Per-template subject/body overrides, keyed like trax_mail_templates().
    // Empty until the first snapshot lands; an empty subject or body means
    // "use the built-in default", which is also what an absent key means.
    templates: {},
  },
  branding: {
    // What this install calls itself — the wordmark, the tab title, the name in
    // every exported PDF's file name. Never empty on the server side.
    appName: 'Assets',
    orgName: '',
    brandColor: '#1F2937',
    publicPath: '/',
    logoFile: '',
    faviconFile: 'favicon.png',
    labelHeading: 'PROPERTY OF',
    // The number behind the WhatsApp button on the public asset page. Empty
    // here only until the first snapshot lands; empty THERE means no button.
    whatsapp: '',
  },
  defaults: {
    loanDays: 7,
    dueHour: 18,
    reservationStartHour: 9,
    warrantyMonths: 24,
    currency: 'EUR',
    allowPartialDefault: false,
    overdueGraceDays: 0,
    locale: 'en-US',
    dateFormat: 'Y-m-d H:i',
  },
  cron: {
    secret: '',
    dueSoonHours: 24,
    overdueRepeatDays: 7,
  },
};

export const state = reactive({
  rev: 0,
  assets: [],
  reservations: [],
  checkouts: [],
  history: [],
  bookings: [],
  settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
  meta: {},

  selected: [],
  // How many units of each selected asset are wanted. Kept parallel to
  // `selected` rather than folded into it, so every existing selection call
  // site keeps working with bare ids.
  quantities: {},
  // Which physical units of a selected asset the operator picked by hand,
  // assetId => [no, …]. Empty or missing means "the server assigns them",
  // which is what every pre-units call site keeps doing.
  unitChoice: {},
  view: 'inventory',
  filters: loadViewState(),
  expandedSets: {},

  loading: false,
  booting: true,
  error: null,
  toasts: [],
});

// --- Toasts ----------------------------------------------------------------

let toastSeq = 0;

export function toast(message, kind = 'info', timeout = 4500) {
  const entry = { id: ++toastSeq, message, kind };
  state.toasts.push(entry);
  if (timeout) {
    setTimeout(() => dismissToast(entry.id), timeout);
  }
  return entry.id;
}

export function dismissToast(id) {
  const index = state.toasts.findIndex((t) => t.id === id);
  if (index >= 0) state.toasts.splice(index, 1);
}

// --- Derived ---------------------------------------------------------------

export const assetById = computed(
  () => new Map(state.assets.map((asset) => [asset.id, asset])),
);

/**
 * assetId => [lines].
 *
 * A checkout record is a transaction LINE now: it has a `lineId`, an `assetId`
 * and a `qty`, and several lines can exist for the same asset (two people can
 * hold units of the same item). Keying by `record.id` — which no longer exists
 * — silently produced a map of `undefined => lastRecord`.
 */
export const checkoutByAssetId = computed(() => {
  const map = new Map();
  for (const line of state.checkouts) {
    const key = Number(line.assetId);
    const bucket = map.get(key);
    if (bucket) bucket.push(line);
    else map.set(key, [line]);
  }
  return map;
});

export const items = computed(() => state.assets.filter((a) => a.kind === 'ITEM'));
export const sets = computed(() => state.assets.filter((a) => a.kind === 'SET'));

export const categories = computed(() =>
  [...new Set(state.assets.map((a) => a.category).filter(Boolean))].sort(),
);

export const locations = computed(() =>
  [...new Set(state.assets.map((a) => a.location).filter(Boolean))].sort(),
);

/** The live settings block. Always populated — see DEFAULT_SETTINGS. */
export const settings = computed(() => state.settings);

/** value => count, biggest first, then alphabetical. */
function countValues(values) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * Every category, location and tag in use, with how many assets carry it.
 *
 * Categories and locations have `categories`/`locations` computeds already, but
 * those are bare sorted lists for datalists — a taxonomy editor has to show
 * what a rename or delete would actually touch, so the count comes along. Tags
 * had no computed at all before this.
 */
export const taxonomyUsage = computed(() => ({
  categories: countValues(state.assets.map((asset) => asset.category)),
  locations: countValues(state.assets.map((asset) => asset.location)),
  tags: countValues(state.assets.flatMap((asset) => asset.tags || [])),
}));

export const overdueCheckouts = computed(() =>
  state.checkouts.filter((record) => isOverdue(record.dueAt || record.returnDate)),
);

export const activeReservations = computed(() =>
  state.reservations.filter((r) => r.status === 'ACTIVE'),
);

/**
 * Assets that pass the current filter set.
 *
 * The Kits view IS the kind filter, pinned by the view rather than written into
 * state.filters on entry: a written filter would still be there after switching
 * back to Inventory — and would have been persisted to localStorage, so it
 * would survive a reload too. Pinning it here also means an ITEM filter carried
 * in from Inventory cannot silently empty the Kits view.
 */
export const filteredAssets = computed(() => {
  const { search, status, category, location, kind } = state.filters;
  const query = search.trim().toLowerCase();
  const wantedKind = state.view === 'kits' ? 'SET' : kind;

  return state.assets.filter((asset) => {
    if (status && asset.effectiveStatus !== status) return false;
    if (category && asset.category !== category) return false;
    if (location && asset.location !== location) return false;
    if (wantedKind && asset.kind !== wantedKind) return false;

    if (!query) return true;

    // Scanning a serial into the search box should find the item.
    const haystack = [
      asset.id,
      asset.name,
      asset.notes,
      asset.category,
      asset.location,
      asset.serial,
      asset.supplier,
      ...(asset.tags || []),
    ]
      .join(' ')
      .toLowerCase();

    return haystack.includes(query);
  });
});

export const sortedAssets = computed(() => {
  const { sortBy, sortDir } = state.filters;
  const direction = sortDir === 'desc' ? -1 : 1;

  return [...filteredAssets.value].sort((a, b) => {
    let left = a[sortBy];
    let right = b[sortBy];

    if (sortBy === 'status') {
      left = a.effectiveStatus;
      right = b.effectiveStatus;
    }
    // Value sorts by what the Value column shows — totalPriceOf(), i.e. the
    // unit prices when the asset carries any, else price x quantity. Sorting
    // the stored `price` instead put a unit-priced asset in the position of a
    // number that is not on the screen anywhere.
    if (sortBy === 'price') {
      left = totalPriceOf(a);
      right = totalPriceOf(b);
    }
    if (sortBy === 'id' || sortBy === 'price') {
      return ((Number(left) || 0) - (Number(right) || 0)) * direction;
    }

    return String(left ?? '').localeCompare(String(right ?? ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    }) * direction;
  });
});

/**
 * The selection as the API wants it: `items: [{id, qty}]`.
 *
 * Kits stay unexpanded — the server expands them and multiplies the member
 * quantities itself. Ids are never repeated here, because duplicates would be
 * SUMMED server-side and quietly ask for twice as much.
 */
export const selectedItems = computed(() =>
  state.selected.map((id) => {
    const row = { id, qty: getQuantity(id) };
    const nos = getUnitChoice(id);
    if (nos.length) row.unitNos = nos;
    return row;
  }),
);

/**
 * The selection expanded through kits, as `[{id, qty}]`.
 *
 * A kit member's quantity is multiplied by how many of the kit were asked for,
 * and an item reachable twice (loose plus inside a kit) has its quantities
 * SUMMED rather than the second occurrence dropped — asking for a kit holding
 * two batteries plus one loose battery is a demand for three batteries. This
 * mirrors trax_expand_items() in lib/store.php.
 */
export const selectedExpanded = computed(() => {
  const out = [];
  const index = new Map();

  const add = (id, qty) => {
    const at = index.get(id);
    if (at === undefined) {
      index.set(id, out.length);
      out.push({ id, qty });
    } else {
      out[at].qty += qty;
    }
  };

  for (const id of state.selected) {
    const asset = assetById.value.get(id);
    if (!asset) continue;
    const want = getQuantity(id);
    if (asset.kind === 'SET') {
      for (const member of asset.members) {
        const memberId = Number(member?.assetId ?? member);
        const target = assetById.value.get(memberId);
        if (target && target.kind !== 'SET') {
          add(memberId, want * Math.max(1, Number(member?.qty ?? 1)));
        }
      }
    } else {
      add(asset.id, want);
    }
  }

  return out;
});

/** Selected ids expanded through sets, so the basket shows real items. */
export const selectedItemIds = computed(() => selectedExpanded.value.map((row) => row.id));

/** Total units the selection resolves to, which is not the same as its length. */
export const selectedUnitCount = computed(() =>
  selectedExpanded.value.reduce((sum, row) => sum + row.qty, 0),
);

// --- Selection -------------------------------------------------------------

export function toggleSelected(id) {
  const index = state.selected.indexOf(id);
  if (index >= 0) {
    state.selected.splice(index, 1);
    delete state.quantities[Number(id)];
    delete state.unitChoice[Number(id)];
  } else {
    state.selected.push(id);
  }
}

export function isSelected(id) {
  return state.selected.includes(id);
}

export function clearSelection() {
  state.selected.splice(0, state.selected.length);
  for (const key of Object.keys(state.quantities)) delete state.quantities[key];
  for (const key of Object.keys(state.unitChoice)) delete state.unitChoice[key];
}

export function selectAll(ids) {
  state.selected.splice(0, state.selected.length, ...ids);
  const keep = new Set(ids.map(Number));
  for (const key of Object.keys(state.quantities)) {
    if (!keep.has(Number(key))) delete state.quantities[key];
  }
  for (const key of Object.keys(state.unitChoice)) {
    if (!keep.has(Number(key))) delete state.unitChoice[key];
  }
}

/** How many units of `id` are wanted. Always at least 1. */
export function getQuantity(id) {
  const value = state.quantities[Number(id)];
  return value === undefined ? 1 : value;
}

/**
 * The most units of `id` that can be asked for.
 *
 * For an item that is its `availableQty`. A kit always has quantity 1 of its
 * own, so its ceiling is however many complete copies its contents allow.
 */
export function maxQuantity(id) {
  const asset = assetById.value.get(Number(id));
  if (!asset) return 1;

  if (asset.kind === 'SET') {
    if (!asset.members.length) return 1;
    const copies = asset.members.map((member) => {
      const target = assetById.value.get(Number(member?.assetId ?? member));
      if (!target) return 0;
      const need = Math.max(1, Number(member?.qty ?? 1));
      return Math.floor((Number(target.availableQty) || 0) / need);
    });
    return Math.max(1, Math.min(...copies));
  }

  return Math.max(1, Number(asset.availableQty ?? asset.quantity ?? 1) || 1);
}

/** Sets the wanted units for `id`, clamped to 1..availableQty. */
export function setQuantity(id, qty) {
  const key = Number(id);
  const wanted = Math.floor(Number(qty));
  const clamped = Math.min(
    maxQuantity(key),
    Math.max(1, Number.isFinite(wanted) ? wanted : 1),
  );
  state.quantities[key] = clamped;
  // Asking for fewer than were picked by hand drops the tail of the picks:
  // a choice longer than the quantity is a request the server would reject.
  const chosen = state.unitChoice[key];
  if (Array.isArray(chosen) && chosen.length > clamped) {
    state.unitChoice[key] = chosen.slice(0, clamped);
  }
  return clamped;
}

// --- Unit choice -----------------------------------------------------------

/** The units of `id` the operator picked by hand. Empty means "auto-assign". */
export function getUnitChoice(id) {
  const nos = state.unitChoice[Number(id)];
  return Array.isArray(nos) ? nos : [];
}

/**
 * Replaces the hand-picked units of `id`.
 *
 * Deduped and sorted, capped at the asset's `availableQty` — which is NOT the
 * same as the length of `availableUnitNos`: a pre-units checkout line holds
 * quantity without naming units, so more units can read as free than the asset
 * has left. The wanted quantity is raised to cover the picks, since asking for
 * three named units while wanting one is the same contradiction.
 */
export function setUnitChoice(id, nos) {
  const key = Number(id);
  const asset = assetById.value.get(key);
  const cap = Math.max(0, Number(asset?.availableQty ?? 0) || 0);

  const clean = [...new Set((Array.isArray(nos) ? nos : []).map(Number).filter(
    (no) => Number.isInteger(no) && no > 0,
  ))].sort((a, b) => a - b).slice(0, cap);

  if (clean.length) state.unitChoice[key] = clean;
  else delete state.unitChoice[key];

  if (clean.length > getQuantity(key)) setQuantity(key, clean.length);
  return clean;
}

/** Adds or removes one unit number from the hand-picked list of `id`. */
export function toggleUnitChoice(id, no) {
  const key = Number(id);
  const current = getUnitChoice(key);
  const next = current.includes(Number(no))
    ? current.filter((entry) => entry !== Number(no))
    : [...current, Number(no)];
  return setUnitChoice(key, next);
}

// --- Filters ---------------------------------------------------------------

export function setFilter(patch) {
  Object.assign(state.filters, patch);
  try {
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(state.filters));
  } catch {
    /* private browsing — filters just won't persist */
  }
}

export function resetFilters() {
  setFilter({ search: '', status: '', category: '', location: '', kind: '' });
}

export function toggleSort(column) {
  if (state.filters.sortBy === column) {
    setFilter({ sortDir: state.filters.sortDir === 'asc' ? 'desc' : 'asc' });
  } else {
    setFilter({ sortBy: column, sortDir: 'asc' });
  }
}

// --- Loading and mutating --------------------------------------------------

function applySnapshot(data) {
  if (!data) return;
  if (typeof data.rev === 'number') state.rev = data.rev;
  // `bookings` and `settings` ride in every snapshot, not just bootstrap. They
  // were missing from this list, so the server's answer to settings.update was
  // dropped on the floor and the Settings view kept showing its own defaults.
  for (const key of ['assets', 'reservations', 'checkouts', 'history', 'bookings']) {
    if (Array.isArray(data[key])) state[key] = data[key];
  }
  if (data.settings && typeof data.settings === 'object') {
    state.settings = data.settings;
    // format.js cannot read the store (it is imported BY the store), so the
    // locale is pushed to it here, on every snapshot — a settings save that
    // changes it takes effect without a reload.
    setUiLocale(data.settings?.defaults?.locale);
  }
  if (data.meta) state.meta = data.meta;
}

export async function load() {
  state.loading = true;
  state.error = null;
  try {
    const body = await api.get('bootstrap');
    applySnapshot(body.data);
    state.rev = body.rev ?? state.rev;
  } catch (error) {
    // api.js has already sent the browser to login.php: an error box and a
    // sticky toast would sit there blaming the data for a session that ended.
    if (error.isRedirecting) throw error;
    state.error = error.message;
    toast(error.message, 'danger', 0);
    throw error;
  } finally {
    state.loading = false;
    state.booting = false;
  }
}

/**
 * The only write path.
 *
 * On a stale revision it reloads and retries exactly once — the common case is
 * two tabs touching unrelated records, where the retry just succeeds. A
 * CONFLICT (items unavailable) is re-thrown so the caller can offer a choice.
 */
export async function mutate(action, payload = {}, { retryOnStale = true } = {}) {
  state.loading = true;
  try {
    const body = await api.post(action, payload, state.rev);
    applySnapshot(body.data);
    state.rev = body.rev ?? state.rev;
    return body.data;
  } catch (error) {
    if (error.isStale && retryOnStale) {
      if (error.details?.snapshot) {
        applySnapshot(error.details.snapshot);
        state.rev = error.details.rev ?? state.rev;
      } else {
        await load();
      }
      toast('Reloaded — this changed in another tab. Retrying…', 'warning');
      return mutate(action, payload, { retryOnStale: false });
    }
    if (error.isBlocked) throw error;
    // Same as load(): the page is on its way to login.php, so the save is not
    // what needs explaining.
    if (error.isRedirecting) throw error;
    toast(error.message, 'danger', 8000);
    throw error;
  } finally {
    state.loading = false;
  }
}

export async function uploadPhoto(assetId, file) {
  state.loading = true;
  try {
    const body = await api.upload('asset.uploadPhoto', file, { id: assetId });
    applySnapshot(body.data);
    state.rev = body.rev ?? state.rev;
    return body.data;
  } catch (error) {
    toast(error.message, 'danger', 8000);
    throw error;
  } finally {
    state.loading = false;
  }
}

/**
 * A batch of condition photos for one asset, stored all-or-nothing.
 *
 * Separate from uploadPhoto(): that one replaces the asset's single catalogue
 * photo, this one appends to the asset's own condition log — which an item on
 * the shelf needs, because it has no booking to hang a photo off.
 */
export async function uploadConditionPhotos(assetId, files, note = '') {
  state.loading = true;
  try {
    const body = await api.uploadMany('asset.uploadConditionPhotos', files, { id: assetId, note });
    applySnapshot(body.data);
    state.rev = body.rev ?? state.rev;
    return body.data;
  } catch (error) {
    toast(error.message, 'danger', 8000);
    throw error;
  } finally {
    state.loading = false;
  }
}

/**
 * A batch of documents onto one asset, stored all-or-nothing.
 *
 * Documents are not photos: they are never re-encoded, they live outside
 * uploads/, and download.php is the only way to read one back. The client side
 * of that is just this — the same shape as uploadConditionPhotos(), under a
 * different field name.
 */
export async function uploadDocuments(assetId, files, title = '') {
  state.loading = true;
  try {
    const body = await api.uploadBatch('asset.uploadDocuments', 'documents[]', files, {
      id: assetId,
      title,
    });
    applySnapshot(body.data);
    state.rev = body.rev ?? state.rev;
    return body.data;
  } catch (error) {
    toast(error.message, 'danger', 8000);
    throw error;
  } finally {
    state.loading = false;
  }
}

/** Detaches one document and deletes its bytes. */
export async function deleteDocument(assetId, file) {
  return mutate('asset.deleteDocument', { id: assetId, file });
}

// --- Lookups used across components ----------------------------------------

export function getAsset(id) {
  return assetById.value.get(Number(id)) || null;
}

/** Every open checkout line for one asset. Empty when nothing is out. */
export function getLines(assetId) {
  return checkoutByAssetId.value.get(Number(assetId)) || [];
}

/** Units of `assetId` currently out, across all holders. */
export function outQtyOf(assetId) {
  return getLines(assetId).reduce((sum, line) => sum + Math.max(1, Number(line.qty) || 1), 0);
}

/**
 * The line that comes back first.
 *
 * With several holders there is no single "the checkout" any more, so every
 * place that wants one date has to say which one it means. The soonest due
 * date is the one worth showing next to an asset.
 */
export function soonestLine(assetId) {
  const lines = getLines(assetId);
  if (!lines.length) return null;
  return lines.reduce((soonest, line) => {
    const a = parseDate(line.dueAt || line.returnDate);
    const b = parseDate(soonest.dueAt || soonest.returnDate);
    if (!a) return soonest;
    if (!b) return line;
    return a < b ? line : soonest;
  });
}

/**
 * Members of a set, resolved to asset records.
 * Members are `{assetId, qty}` now; the required qty rides along as `reqQty`.
 */
export function membersOf(set) {
  if (!set || set.kind !== 'SET') return [];
  return set.members
    .map((member) => {
      const asset = assetById.value.get(Number(member?.assetId ?? member));
      return asset ? { ...asset, reqQty: Math.max(1, Number(member?.qty ?? 1)) } : null;
    })
    .filter(Boolean);
}

/** History for one asset, newest first. */
export function historyFor(assetId) {
  return state.history
    .filter((entry) => Number(entry.assetId) === Number(assetId))
    .sort((a, b) => (parseDate(b.at) || 0) - (parseDate(a.at) || 0));
}

export function setView(view) {
  state.view = view;
}

export function toggleSetExpanded(id) {
  state.expandedSets[id] = !state.expandedSets[id];
}
