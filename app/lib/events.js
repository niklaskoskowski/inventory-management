/**
 * Events — the jobs the gear goes out on.
 *
 * An event is a festival, a conference, a shoot. Equipment is not "in" an
 * event the way it is in a kit: it is CHECKED OUT or RESERVED against one. So
 * an event is a label the existing booking machinery carries (`eventId` on the
 * checkout line, the reservation and the booking) and what is booked against
 * it is worked out here, from those records, rather than stored a second time.
 *
 * Its status — reserved, packed, at customer — is a workflow marker the
 * operator moves by hand, and the list of them is configurable because every
 * shop spells its workflow differently. It is deliberately NOT wired into
 * availability: what is free is decided by checkouts and reservations, and a
 * second opinion on that is how two screens come to disagree.
 */

import { parseDate } from './format.js';

/** What a workflow reads as before the first snapshot lands. Mirrors lib/store.php. */
export const DEFAULT_STATUSES = [
  { id: 'reserved', label: 'Reserved', color: '#6B7280', closed: false },
  { id: 'packed', label: 'Packed', color: '#D97706', closed: false },
  { id: 'at-customer', label: 'At customer', color: '#2563EB', closed: false },
  { id: 'returned', label: 'Returned', color: '#16A34A', closed: true },
];

/** settings.events in a shape every caller below can rely on. */
export function eventSettings(settings) {
  const block = settings?.events || {};
  const statuses = Array.isArray(block.statuses) && block.statuses.length
    ? block.statuses
    : DEFAULT_STATUSES;
  const ids = statuses.map((status) => status.id);
  return {
    statuses,
    defaultStatus: ids.includes(block.defaultStatus) ? block.defaultStatus : ids[0],
    // Whether the booking forms offer an event at all.
    enabled: block.enabled !== false,
  };
}

/**
 * The status entry an event is on.
 *
 * Never null: a status the workflow no longer has still has to render, because
 * the event genuinely is on it — it is shown as itself, greyed, rather than
 * quietly rewritten to something it never said.
 */
export function statusOf(settings, event) {
  const id = String(event?.status ?? '');
  const found = eventSettings(settings).statuses.find((status) => status.id === id);
  if (found) return { ...found, known: true };
  return {
    id,
    label: id ? `${id} (unknown)` : 'No status',
    color: '#6B7280',
    closed: false,
    known: false,
  };
}

/** Is this event finished — a closed status, so it drops out of the active list? */
export function isClosed(settings, event) {
  return statusOf(settings, event).closed === true;
}

/** A readable id for an event, for chips and PDFs. */
export function eventLabel(event) {
  if (!event) return '';
  return event.name || `Event #${event.id}`;
}

/** Everything booked against one event, out of the records that name it. */
export function bookedOn(event, { checkouts = [], reservations = [] } = {}) {
  const id = Number(event?.id);
  if (!Number.isFinite(id) || id <= 0) return { lines: [], reservations: [], units: 0 };

  const lines = checkouts.filter((line) => Number(line?.eventId) === id);
  const booked = reservations.filter((row) => Number(row?.eventId) === id);

  return {
    lines,
    reservations: booked,
    // Units actually out with the customer right now, which is not the same as
    // what the reservations promise.
    units: lines.reduce((sum, line) => sum + Math.max(1, Number(line.qty) || 1), 0),
  };
}

/** The lines of an event as the [{id, qty, unitNos, hire}] shape the pricing helpers take. */
export function linesOf(event, checkouts = []) {
  return bookedOn(event, { checkouts }).lines.map((line) => ({
    id: line.assetId,
    qty: line.qty,
    unitNos: line.unitNos || [],
    hire: line.hire,
  }));
}

/**
 * The window an event runs over, as a sortable number.
 *
 * An event with no dates yet is still a real event — it sorts to the end
 * rather than to 1970, which is where an empty date would otherwise put it.
 */
export function startTime(event) {
  const start = parseDate(event?.startAt);
  return start ? start.getTime() : Number.POSITIVE_INFINITY;
}

/** Soonest first, undated last, newest id breaking a tie. */
export function byStart(a, b) {
  return startTime(a) - startTime(b) || (Number(b?.id) || 0) - (Number(a?.id) || 0);
}

/** Is the event's window running right now? */
export function isRunning(event, now = new Date()) {
  const start = parseDate(event?.startAt);
  const end = parseDate(event?.endAt);
  if (!start && !end) return false;
  if (start && start > now) return false;
  if (end && end < now) return false;
  return true;
}

/** Does the event start within the next `days` days? */
export function startsWithin(event, days, now = new Date()) {
  const start = parseDate(event?.startAt);
  if (!start) return false;
  const horizon = new Date(now.getTime() + days * 86400000);
  return start >= now && start <= horizon;
}

/**
 * The event's gear as ONE row per asset, out of everything that names it:
 * the gear list (planned), active reservations, open checkout lines (out) and
 * the bookings' snapshots (what went out, so `went out − still out` is back).
 *
 * Row: {assetId, name, planned, reserved, out, back, toGo, overdue, unitsOut[],
 *       unitsPlanned[], entries[], late[], extra, lines[]}
 *   toGo  — still to check out: max(planned, reserved) − out − back
 *   extra — went out without being on the list (documented, not an error)
 */
export function gearOf(event, { checkouts = [], bookings = [], reservations = [], assets = null } = {}) {
  const id = Number(event?.id);
  const rows = new Map();
  const row = (assetId) => {
    const key = Number(assetId);
    if (!rows.has(key)) {
      rows.set(key, {
        assetId: key, name: '', planned: 0, reserved: 0, out: 0, wentOut: 0, back: 0, toGo: 0, overdue: false,
        unitsOut: [], unitsPlanned: [], entries: [], late: [], extra: false, lines: [], dueAt: null,
      });
    }
    return rows.get(key);
  };
  if (!Number.isFinite(id) || id <= 0) return [];

  for (const g of event.gear || []) {
    const r = row(g.assetId);
    r.planned += Math.max(1, Number(g.qty) || 1);
    for (const no of g.unitNos || []) if (!r.unitsPlanned.includes(no)) r.unitsPlanned.push(no);
    r.entries.push(g);
    if (g.late) r.late.push(g);
  }
  for (const res of reservations) {
    if (Number(res?.eventId) !== id || res.status !== 'ACTIVE') continue;
    for (const item of res.items || []) row(item.assetId).reserved += Math.max(1, Number(item.qty) || 1);
  }
  const now = Date.now();
  for (const line of checkouts) {
    if (Number(line?.eventId) !== id) continue;
    const r = row(line.assetId);
    r.out += Math.max(1, Number(line.qty) || 1);
    for (const no of line.unitNos || []) if (!r.unitsOut.includes(no)) r.unitsOut.push(no);
    r.lines.push(line);
    r.name = r.name || line.name || '';
    const due = parseDate(line.dueAt || line.returnDate);
    if (due && due.getTime() < now) r.overdue = true;
    if (due && (!r.dueAt || due < parseDate(r.dueAt))) r.dueAt = line.dueAt || line.returnDate;
  }
  for (const booking of bookings) {
    if (Number(booking?.eventId) !== id || booking.kind !== 'checkout' || booking.status === 'CANCELLED') continue;
    for (const item of booking.items || []) {
      const r = row(item.assetId);
      r.wentOut += Math.max(1, Number(item.qty) || 1);
      r.name = r.name || item.name || '';
    }
  }
  const find = typeof assets === 'function' ? assets : (aid) => null;
  for (const r of rows.values()) {
    r.back = Math.max(0, r.wentOut - r.out);
    const target = Math.max(r.planned, r.reserved);
    r.toGo = Math.max(0, target - r.out - r.back);
    r.extra = r.wentOut > 0 && target === 0;
    const asset = find(r.assetId);
    r.name = asset?.name || r.name || `#${r.assetId}`;
    r.asset = asset || null;
    // planned unit numbers that are not out (and not back) yet
    r.unitsToGo = r.unitsPlanned.filter((no) => !r.unitsOut.includes(no));
  }
  return [...rows.values()].sort((a, b) => (b.out > 0) - (a.out > 0) || (b.toGo > 0) - (a.toGo > 0) || a.name.localeCompare(b.name));
}

/** Counters over gearOf() rows. */
export function gearTotals(rows) {
  return rows.reduce((t, r) => ({
    toGo: t.toGo + r.toGo, out: t.out + r.out, back: t.back + r.back,
    planned: t.planned + Math.max(r.planned, r.reserved), overdue: t.overdue || r.overdue, late: t.late + r.late.length,
  }), { toGo: 0, out: 0, back: 0, planned: 0, overdue: false, late: 0 });
}
