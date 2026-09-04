/**
 * Dates, money and status vocabulary.
 *
 * The old code had two parsers (parseReturnDate and parseFlexibleDate) because
 * checkout.json stores German "dd.mm.yyyy hh:mm" while everything else is ISO.
 * There is one parser here, and it handles every shape the data contains.
 */

/**
 * The BCP 47 tag Intl formats with — settings.defaults.locale.
 *
 * It is a module-level variable set by store.js rather than something read off
 * the store, because store.js already imports THIS file: importing it back
 * would close a cycle. The default holds only until the first snapshot lands.
 */
let uiLocale = 'en-US';

/**
 * The two date formatters, built lazily and kept.
 *
 * Building an Intl.DateTimeFormat costs far more than using one, and a full
 * table formats a date per row, so they are cached — and dropped whenever the
 * locale changes underneath them.
 */
let dateFormatter = null;
let dateTimeFormatter = null;

/** Called by store.js whenever a snapshot brings new settings. */
export function setUiLocale(locale) {
  if (typeof locale === 'string' && locale.trim() !== '') {
    uiLocale = locale.trim();
    dateFormatter = null;
    dateTimeFormatter = null;
  }
}

export function getUiLocale() {
  return uiLocale;
}

export const STATUSES = ['FREE', 'RSVD', 'UNAV', 'LOCK'];

export const STATUS_LABEL = {
  FREE: 'Available',
  RSVD: 'Reserved',
  UNAV: 'Checked out',
  LOCK: 'Blocked',
  PARTIAL: 'Incomplete',
};

export const STATUS_CLASS = {
  FREE: 'success',
  RSVD: 'warning',
  UNAV: 'danger',
  LOCK: 'secondary',
  PARTIAL: 'info',
};

export const CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'DEFECT', 'BLOCKED'];

export const CONDITION_LABEL = {
  NEW: 'New',
  GOOD: 'Good',
  FAIR: 'Fair',
  POOR: 'Poor',
  DEFECT: 'Defective',
  BLOCKED: 'Blocked',
};

/**
 * "2× Good, 1× Blocked" — the condition of a unit-tracking asset.
 *
 * Such an asset has no single condition: the grade lives on each unit, and the
 * asset's own stored value is left behind unread. Counted in CONDITIONS order
 * so the same list always reads the same way, and '' when there are no units,
 * which is the caller's cue to fall back to the asset's own grade.
 */
export function conditionSummary(asset) {
  const units = asset?.units || [];
  if (!units.length) return '';

  const counts = new Map();
  for (const unit of units) {
    const code = unit?.condition || 'GOOD';
    counts.set(code, (counts.get(code) || 0) + 1);
  }

  const known = CONDITIONS.filter((code) => counts.has(code));
  const rest = [...counts.keys()].filter((code) => !CONDITIONS.includes(code));
  return [...known, ...rest]
    .map((code) => `${counts.get(code)}\u00d7 ${CONDITION_LABEL[code] || code}`)
    .join(', ');
}

export function statusClass(status) {
  return STATUS_CLASS[status] || 'secondary';
}

/**
 * PARTIAL means two different things now, so the label needs the kind:
 * a kit is missing some of its contents, an item has some units out.
 */
export function statusLabel(status, kind = '') {
  if (status === 'PARTIAL' && kind === 'ITEM') return 'Partly out';
  return STATUS_LABEL[status] || status || '';
}

/**
 * Parses every date shape in this codebase:
 * German "dd.mm.yyyy hh:mm", ISO-8601, "YYYY-MM-DDTHH:mm", "YYYY-MM-DD".
 * Returns a Date, or null.
 */
export function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const text = String(value).trim();
  if (!text) return null;

  // German display format — local time.
  const german = text.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (german) {
    const date = new Date(
      Number(german[3]),
      Number(german[2]) - 1,
      Number(german[1]),
      Number(german[4] || 0),
      Number(german[5] || 0),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // datetime-local — local time, not UTC. Parsing this with `new Date()`
  // would be UTC in some engines and shift the value by the offset.
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
  if (local) {
    const date = new Date(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Dates are DISPLAYED for settings.defaults.locale, the same tag money uses.
 *
 * They are still PARSED by parseDate() above, which reads every shape the
 * stored data contains — including the German dd.mm.yyyy that checkout.json
 * was written in. Reading is about what is on disk; writing to the screen is
 * about who is looking, and the two stopped being the same question when the
 * locale became a setting.
 */
const DATE_PARTS = { year: 'numeric', month: '2-digit', day: '2-digit' };
const TIME_PARTS = { hour: '2-digit', minute: '2-digit' };

/** Falls back to en-US rather than throwing: a typo'd tag must not eat a table. */
function makeDateFormatter(options) {
  try {
    return new Intl.DateTimeFormat(uiLocale, options);
  } catch {
    return new Intl.DateTimeFormat('en-US', options);
  }
}

/** Date and time, for the locale. */
export function formatDateTime(value) {
  const date = parseDate(value);
  if (!date) return '—';
  if (!dateTimeFormatter) {
    dateTimeFormatter = makeDateFormatter({ ...DATE_PARTS, ...TIME_PARTS });
  }
  return dateTimeFormatter.format(date);
}

/** The date alone, for the locale. */
export function formatDate(value) {
  const date = parseDate(value);
  if (!date) return '—';
  if (!dateFormatter) dateFormatter = makeDateFormatter(DATE_PARTS);
  return dateFormatter.format(date);
}

/**
 * Value for a <input type="datetime-local">.
 * Must be built from local parts — toISOString() would write UTC into a
 * local-time input, which is the timezone bug at admin.php:1891.
 */
export function toLocalInput(value) {
  const date = parseDate(value);
  if (!date) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Value for a <input type="date">. */
export function toDateInput(value) {
  const date = parseDate(value);
  if (!date) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "in 3 days" / "2 days ago" / "today" */
export function relativeDays(value) {
  const date = parseDate(value);
  if (!date) return '';

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfThen = new Date(date);
  startOfThen.setHours(0, 0, 0, 0);

  const days = Math.round((startOfThen - startOfToday) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

/** Whole days a due date is past. 0 when not overdue. */
export function daysOverdue(dueAt, now = new Date()) {
  const due = parseDate(dueAt);
  if (!due) return 0;
  return Math.max(0, Math.floor((now - due) / 86400000));
}

export function isOverdue(dueAt, now = new Date()) {
  const due = parseDate(dueAt);
  return due !== null && due < now;
}

export function formatMoney(value, currency = 'EUR') {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  try {
    return new Intl.NumberFormat(uiLocale, { style: 'currency', currency }).format(number);
  } catch {
    return `${number.toFixed(2)} ${currency}`;
  }
}

/**
 * What ONE unit of an asset is worth.
 *
 * A unit-tracking asset that prices its units is worth the sum of them, and
 * the server hands that sum over as `priceTotal`; the stored `asset.price` is
 * left alone underneath and is not what such an asset costs any more. Dividing
 * the sum back by the count is what keeps `price x quantity` — the arithmetic
 * every value report already does — landing on the sum again.
 */
export function unitPriceOf(asset) {
  if (asset?.unitPriced) return asset.priceTotal / Math.max(1, asset.quantity);
  return asset?.price ?? null;
}

/** What the whole record is worth: the unit sum, or price x quantity. */
export function totalPriceOf(asset) {
  if (asset?.priceTotal !== null && asset?.priceTotal !== undefined) return asset.priceTotal;
  return asset?.price != null ? asset.price * Math.max(1, asset.quantity) : null;
}

/**
 * A per-currency total bag, as one string.
 *
 * computeValue() never adds across currencies, so a total is a LIST of
 * {currency, amount}. This is the only way that list reaches the screen, which
 * is what keeps a bare number without its currency from ever being rendered.
 * One currency is the normal case and reads as a plain amount; several are
 * joined rather than summed.
 */
export function formatTotals(totals, empty = '—') {
  const rows = (totals || []).filter((row) => row && Number.isFinite(Number(row.amount)));
  if (!rows.length) return empty;
  return rows.map((row) => formatMoney(row.amount, row.currency || 'EUR')).join(' + ');
}

export function startOfDay(value = new Date()) {
  const date = new Date(parseDate(value) || new Date());
  date.setHours(0, 0, 0, 0);
  return date;
}

export function addDays(value, days) {
  const date = new Date(parseDate(value) || new Date());
  date.setDate(date.getDate() + days);
  return date;
}

/** Inclusive whole-day difference. */
export function diffDays(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}
