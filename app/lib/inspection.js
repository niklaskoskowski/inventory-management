/**
 * Inspections — the test record a piece of gear has to be able to show.
 *
 * "Cable 183.5, tested 2026-03-14, passed, next test 2027-03-14, certificate
 * attached." Switched on per CATEGORY and nowhere else: a folding table is not
 * tested, and putting an empty obligation on every record would make the one
 * that matters invisible.
 *
 * Like availability and the rental price, nothing here is stored. The records
 * are (they are documentation), but whether one is still valid is worked out
 * from the record and today's date every time it is asked for.
 */

import { parseDate, startOfDay, addMonths, formatDate } from './format.js';

/** A test either passed or it did not. Mirrors TRAX_INSPECTION_RESULTS. */
export const RESULTS = ['PASS', 'FAIL'];

export const RESULT_LABEL = { PASS: 'Passed', FAIL: 'Failed' };

/** The shape of a category's rule, and what a missing one reads as. */
export const BLANK_RULE = { label: 'Inspection', intervalMonths: 12, fields: [] };

/**
 * How long before a due date it starts being worth saying so.
 *
 * Thirty days: long enough to book a tester, short enough that the warning
 * still means something when it appears.
 */
export const DUE_SOON_DAYS = 30;

/** settings.inspection in a shape every caller below can rely on. */
export function inspectionSettings(settings) {
  const block = settings?.inspection || {};
  return { categories: Array.isArray(block.categories) ? block.categories : [] };
}

/**
 * The rule for a category, or null when that category is not tested.
 *
 * Being in the list IS the checkbox: there is no `enabled` flag to disagree
 * with the entry's own presence.
 */
export function inspectionRule(settings, category) {
  const name = String(category ?? '').trim();
  if (!name) return null;
  const found = inspectionSettings(settings).categories
    .find((rule) => String(rule?.category ?? '') === name);
  return found ? { ...BLANK_RULE, ...found, fields: [...(found.fields || [])] } : null;
}

/** Does this asset's category ask for a test record? */
export function isTested(settings, asset) {
  return inspectionRule(settings, asset?.category) !== null;
}

/** Every stored record, newest first. The server already sorts; this is the guard. */
export function recordsOf(asset) {
  return [...(asset?.inspections || [])].sort((a, b) => {
    const byDate = String(b.at || '').localeCompare(String(a.at || ''));
    return byDate || (Number(b.id) || 0) - (Number(a.id) || 0);
  });
}

/**
 * The records about one piece.
 *
 * `unitNo` null means the asset as a whole — the only answer for a record that
 * does not track its units one by one. A record about the asset is NOT shown
 * under a unit: it was a test of something else.
 */
export function recordsFor(asset, unitNo = null) {
  const wanted = unitNo === null || unitNo === undefined ? null : Number(unitNo);
  return recordsOf(asset).filter((record) => {
    const on = record.unitNo === null || record.unitNo === undefined ? null : Number(record.unitNo);
    return on === wanted;
  });
}

/** The most recent test of one piece, or null. */
export function latestFor(asset, unitNo = null) {
  return recordsFor(asset, unitNo)[0] || null;
}

/** Whole days from today until `date`; negative once it is past. */
function daysUntil(date) {
  const target = parseDate(date);
  if (!target) return null;
  return Math.round((startOfDay(target) - startOfDay(new Date())) / 86400000);
}

/**
 * What the last test means today.
 *
 *   NONE     — never tested
 *   FAIL     — the last test failed; the date is beside the point
 *   OVERDUE  — the next test was due before today
 *   DUE      — it falls due inside DUE_SOON_DAYS
 *   OK       — tested, and either not due yet or not on a repeat at all
 */
export function stateOf(record) {
  if (!record) return 'NONE';
  if (record.result === 'FAIL') return 'FAIL';
  if (!record.nextAt) return 'OK';

  const days = daysUntil(record.nextAt);
  if (days === null) return 'OK';
  if (days < 0) return 'OVERDUE';
  return days <= DUE_SOON_DAYS ? 'DUE' : 'OK';
}

/** Worst first — what a summary shows when several pieces disagree. */
const SEVERITY = { FAIL: 4, OVERDUE: 3, DUE: 2, NONE: 1, OK: 0 };

export const STATE_LABEL = {
  FAIL: 'Failed',
  OVERDUE: 'Test overdue',
  DUE: 'Test due soon',
  NONE: 'Never tested',
  OK: 'Valid',
};

/** The Bootstrap contextual class each state is shown in. */
export const STATE_CLASS = {
  FAIL: 'danger',
  OVERDUE: 'danger',
  DUE: 'warning',
  NONE: 'secondary',
  OK: 'success',
};

/**
 * One row per thing that can be tested: every unit, or the asset itself when
 * it does not track units.
 *
 * `code` is what goes on the paperwork — "183.5", or "#183" for the whole
 * record — so the same string identifies the piece on screen and in the PDF.
 */
export function inspectionRows(asset) {
  const units = Array.isArray(asset?.units) ? asset.units : [];
  if (!units.length) {
    const latest = latestFor(asset, null);
    return [{
      unitNo: null,
      code: `#${asset?.id}`,
      label: '',
      latest,
      state: stateOf(latest),
      records: recordsFor(asset, null),
    }];
  }

  return units.map((unit) => {
    const latest = latestFor(asset, unit.no);
    return {
      unitNo: unit.no,
      code: `${asset.id}.${unit.no}`,
      label: unit.label || '',
      latest,
      state: stateOf(latest),
      records: recordsFor(asset, unit.no),
    };
  });
}

/**
 * The worst state across an asset's pieces.
 *
 * Records filed against the asset as a whole count too, even when it tracks
 * units: an older record from before the units were listed is still the last
 * thing anybody knows about it.
 */
export function assetState(asset) {
  const rows = inspectionRows(asset);
  const states = rows.map((row) => row.state);
  if ((asset?.units || []).length) {
    const own = latestFor(asset, null);
    if (own) states.push(stateOf(own));
  }
  return states.reduce(
    (worst, state) => (SEVERITY[state] > SEVERITY[worst] ? state : worst),
    'OK',
  );
}

/** Does this asset need looking at — for the dashboard and the sheet's banner? */
export function needsAttention(state) {
  return state === 'FAIL' || state === 'OVERDUE' || state === 'DUE' || state === 'NONE';
}

/** The soonest due date across an asset's pieces, or ''. */
export function nextDueOf(asset) {
  return inspectionRows(asset)
    .map((row) => row.latest?.nextAt)
    .filter(Boolean)
    .sort()[0] || '';
}

/** The next test date a rule implies for a test done on `at`. '' when it does not repeat. */
export function nextDueFrom(at, months) {
  const interval = Math.max(0, Number(months) || 0);
  return interval ? addMonths(at, interval) : '';
}

/** "Passed 14/03/2026 · next 14/03/2027" — one record, as a line. */
export function recordSummary(record) {
  if (!record) return 'Never tested';
  const parts = [`${RESULT_LABEL[record.result] || record.result} ${formatDate(record.at)}`];
  if (record.nextAt) parts.push(`next ${formatDate(record.nextAt)}`);
  if (record.by) parts.push(record.by);
  return parts.join(' · ');
}

/**
 * The blank form for a new record, filled in from the rule.
 *
 * The parameters come from the category so the same three measurements are
 * written down every time, in the same order — which is the whole point of
 * naming them in the settings.
 */
export function blankRecord(rule, { unitNo = null, by = '' } = {}) {
  const today = new Date();
  const at = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return {
    unitNo,
    at,
    result: 'PASS',
    by,
    label: rule?.label || BLANK_RULE.label,
    nextAt: nextDueFrom(at, rule?.intervalMonths),
    note: '',
    values: (rule?.fields || []).map((name) => ({ name, value: '' })),
  };
}
