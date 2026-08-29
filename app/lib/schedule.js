/**
 * Availability and timeline maths.
 *
 * Consolidates the two near-identical conflict detectors the old code had
 * (findReservationConflicts at admin.php:1421 and findCheckoutConflicts at
 * :1433) into one, and builds the data the calendar renders.
 */

import { parseDate, startOfDay, addDays, diffDays, isOverdue } from './format.js';

/** Half-open overlap: touching intervals do not conflict. Ported verbatim. */
export function intervalsOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

/** How many units of `assetId` a reservation asks for. 0 when it does not. */
function reservedQtyOf(reservation, id) {
  if (Array.isArray(reservation.items)) {
    let qty = 0;
    for (const item of reservation.items) {
      if (Number(item.assetId) === id) qty += Math.max(1, Number(item.qty) || 1);
    }
    return qty;
  }
  // Pre-quantity payloads only carry the unique ids.
  return (reservation.assetIds || []).map(Number).includes(id) ? 1 : 0;
}

/**
 * Everything booking `assetId` in [start, end), once demand exceeds stock.
 *
 * Mirrors trax_conflicts_for() in api.php: an overlapping booking is only a
 * conflict when the units already spoken for plus the units now wanted exceed
 * what the asset actually has. Two people can hold one of eight batteries each
 * without either of them being in the other's way.
 *
 * @param {object} ctx  { reservations, checkouts, assets }
 * @param {object} ignore  { reservationId, wanted }
 */
export function findConflicts(assetId, start, end, ctx, ignore = {}) {
  const hits = [];
  const id = Number(assetId);
  const wanted = Math.max(1, Number(ignore.wanted) || 1);

  let reservedQty = 0;
  let outQty = 0;

  for (const reservation of ctx.reservations || []) {
    if (reservation.status !== 'ACTIVE') continue;
    if (ignore.reservationId && Number(reservation.id) === Number(ignore.reservationId)) continue;

    const qty = reservedQtyOf(reservation, id);
    if (!qty) continue;

    const from = parseDate(reservation.startAt);
    const to = parseDate(reservation.endAt);
    if (from && to && intervalsOverlap(start, end, from, to)) {
      reservedQty += qty;
      hits.push({
        kind: 'reservation',
        refId: reservation.id,
        qty,
        who: reservation.customerName,
        start: from,
        end: to,
      });
    }
  }

  for (const line of ctx.checkouts || []) {
    if (Number(line.assetId ?? line.id) !== id) continue;

    const from = parseDate(line.checkedOut) || new Date(0);
    const to = parseDate(line.dueAt || line.returnDate) || new Date('2999-12-31T23:59:59Z');
    if (intervalsOverlap(start, end, from, to)) {
      const qty = Math.max(1, Number(line.qty) || 1);
      outQty += qty;
      hits.push({
        kind: 'checkout',
        refId: line.lineId ?? line.assetId ?? line.id,
        qty,
        who: line.customerName,
        start: from,
        end: to,
      });
    }
  }

  const asset = (ctx.assets || []).find((a) => Number(a.id) === id);
  const quantity = Math.max(1, Number(asset?.quantity) || 1);
  const shortfall = Math.max(0, reservedQty + outQty + wanted - quantity);

  return shortfall > 0 ? hits : [];
}

/**
 * Expands a mixed selection of items and kits into the units it resolves to.
 *
 * Quantities are SUMMED, not deduped away — a kit holding two batteries plus
 * one loose battery is a demand for three. Mirrors trax_expand_items().
 *
 * @return {Array<{id: number, qty: number}>}
 */
export function expandIds(items, assetById) {
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

  for (const raw of items) {
    const id = Number(raw?.id ?? raw?.assetId ?? raw);
    const want = Math.max(1, Number(raw?.qty) || 1);
    const asset = assetById.get(id);
    if (!asset) continue;

    if (asset.kind === 'SET') {
      for (const entry of asset.members) {
        const memberId = Number(entry?.assetId ?? entry);
        const member = assetById.get(memberId);
        if (member && member.kind !== 'SET') {
          add(memberId, want * Math.max(1, Number(entry?.qty) || 1));
        }
      }
    } else {
      add(asset.id, want);
    }
  }

  return out;
}

/**
 * Packs overlapping bands into lanes so none are drawn on top of each other.
 * Returns the number of lanes used.
 */
function assignLanes(bands) {
  const laneEnds = [];
  for (const band of bands.sort((a, b) => a.index - b.index)) {
    let lane = laneEnds.findIndex((end) => end <= band.index);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    band.lane = lane;
    laneEnds[lane] = band.index + band.span;
  }
  return Math.max(1, laneEnds.length);
}

/**
 * Builds the calendar model.
 *
 * The layout engine is a single CSS grid: columns are [label, ...days], and a
 * band is placed with `grid-column: index+2 / span days`. No pixel maths and
 * no absolute positioning, so it reflows on resize for free.
 */
export function buildTimeline({ windowStart, windowEnd, rows, reservations, checkouts, now = new Date() }) {
  const start = startOfDay(windowStart);
  const dayCount = Math.max(1, diffDays(start, windowEnd));
  const todayIndex = diffDays(start, now);

  const days = [];
  for (let i = 0; i < dayCount; i++) {
    const date = addDays(start, i);
    const weekday = date.getDay();
    days.push({
      index: i,
      iso: date.toISOString().slice(0, 10),
      dom: date.getDate(),
      dow: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][weekday],
      weekend: weekday === 0 || weekday === 6,
      today: i === todayIndex,
    });
  }

  /** Clips an interval to the visible window and returns grid coordinates. */
  const place = (from, to) => {
    if (!from || !to) return null;
    const rawStart = diffDays(start, from);
    const rawEnd = diffDays(start, to);
    if (rawEnd < 0 || rawStart > dayCount - 1) return null;

    const index = Math.max(0, rawStart);
    const endIndex = Math.min(dayCount - 1, rawEnd);
    return {
      index,
      span: Math.max(1, endIndex - index + 1),
      clipStart: rawStart < 0,
      clipEnd: rawEnd > dayCount - 1,
    };
  };

  const builtRows = rows.map((row) => {
    const bands = [];
    const memberIds = row.kind === 'set' ? row.memberIds : [row.id];

    for (const reservation of reservations) {
      if (reservation.status !== 'ACTIVE' && reservation.status !== 'CONVERTED') continue;

      const qty = memberIds.reduce((sum, id) => sum + reservedQtyOf(reservation, Number(id)), 0);
      if (!qty) continue;

      const box = place(parseDate(reservation.startAt), parseDate(reservation.endAt));
      if (!box) continue;
      bands.push({
        ...box,
        key: `r${reservation.id}-${row.key}`,
        kind: 'reservation',
        qty,
        label: (reservation.customerName || 'Reserved') + (qty > 1 ? ` ×${qty}` : ''),
        tooltip: `Reserved ×${qty} · ${reservation.customerName} · ${reservation.notes || ''}`.trim(),
        refId: reservation.id,
        refKind: 'reservation',
      });
    }

    for (const line of checkouts) {
      if (!memberIds.includes(Number(line.assetId ?? line.id))) continue;

      const due = parseDate(line.dueAt || line.returnDate);
      const box = place(parseDate(line.checkedOut), due || addDays(start, dayCount));
      if (!box) continue;
      const qty = Math.max(1, Number(line.qty) || 1);
      // Keyed by lineId: one asset can carry several concurrent lines, and an
      // asset id would collide between them.
      bands.push({
        ...box,
        key: `c${line.lineId ?? line.assetId ?? line.id}-${row.key}`,
        kind: isOverdue(due, now) ? 'overdue' : 'checkout',
        qty,
        label: (line.customerName || 'Out') + (qty > 1 ? ` ×${qty}` : ''),
        tooltip: `Checked out ×${qty} · ${line.customerName} · due ${line.returnDate}`,
        refId: line.lineId ?? line.assetId ?? line.id,
        refKind: 'checkout',
      });
    }

    const lanes = assignLanes(bands);
    return { ...row, bands, lanes };
  });

  return { windowStart: start, windowEnd: addDays(start, dayCount), days, rows: builtRows, dayCount };
}
