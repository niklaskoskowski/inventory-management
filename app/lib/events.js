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
