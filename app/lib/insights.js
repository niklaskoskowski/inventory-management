/**
 * Utilization maths.
 *
 * Ported from computeUtilization (admin.php:1642) with the same algorithm, so
 * numbers stay comparable with the old reports. Two fixes: history events are
 * paired per asset rather than assuming strict alternation, and an asset that
 * was never returned no longer double-counts once from history and again from
 * the open checkout record.
 */

import { parseDate, daysOverdue, unitPriceOf } from './format.js';

export function computeInsights({ assets, checkouts, history, rangeStart, rangeEnd, statusFilter = '' }) {
  const inScope = assets.filter(
    (asset) => asset.kind !== 'SET' && (!statusFilter || asset.effectiveStatus === statusFilter),
  );

  const windowMs = Math.max(1, rangeEnd.getTime() - rangeStart.getTime());

  // assetId => [open lines]. An asset can be out with several people at once.
  const openByAsset = new Map();
  for (const line of checkouts) {
    const key = Number(line.assetId ?? line.id);
    const bucket = openByAsset.get(key);
    if (bucket) bucket.push(line);
    else openByAsset.set(key, [line]);
  }

  const usage = inScope.map((asset) => {
    const quantity = Math.max(1, Number(asset.quantity) || 1);

    const events = history
      .filter(
        (entry) =>
          Number(entry.assetId) === Number(asset.id)
          && (entry.type === 'checkout' || entry.type === 'checkin'),
      )
      .map((entry) => ({
        ...entry,
        when: parseDate(entry.at),
        units: Math.max(1, Number(entry.qty) || 1),
      }))
      .filter((entry) => entry.when)
      .sort((a, b) => a.when - b.when);

    let usedMs = 0;

    const clipAdd = (from, to, units) => {
      const start = Math.max(from.getTime(), rangeStart.getTime());
      const end = Math.min(to.getTime(), rangeEnd.getTime());
      if (end > start) usedMs += (end - start) * units;
    };

    // Concurrent lines, not a single open/close cursor: with 8 units, three
    // can be out at once and each one counts for its own unit-hours.
    let openUnits = 0;
    let cursor = null;

    for (const event of events) {
      if (openUnits > 0 && cursor) clipAdd(cursor, event.when, openUnits);
      openUnits = event.type === 'checkout'
        ? openUnits + event.units
        : Math.max(0, openUnits - event.units);
      cursor = event.when;
    }

    if (openUnits > 0 && cursor) {
      // Still out at the end of the window. The open lines describe the same
      // span, so they must not be added a second time below.
      clipAdd(cursor, rangeEnd, openUnits);
    } else {
      for (const line of openByAsset.get(Number(asset.id)) || []) {
        const since = parseDate(line.checkedOut);
        if (since) clipAdd(since, rangeEnd, Math.max(1, Number(line.qty) || 1));
      }
    }

    return {
      assetId: asset.id,
      assetName: asset.name,
      category: asset.category,
      quantity,
      units: openByAsset.get(Number(asset.id))?.reduce(
        (sum, line) => sum + Math.max(1, Number(line.qty) || 1), 0,
      ) || 0,
      hours: usedMs / 3600000,
      // Weighted by stock: 8 units out for the whole window is 100%, not 800%.
      utilPct: (usedMs / (windowMs * quantity)) * 100,
    };
  });

  const overdue = checkouts
    .filter((record) => {
      const due = parseDate(record.dueAt || record.returnDate);
      return due && due < new Date();
    })
    .map((line) => ({
      id: line.lineId ?? line.assetId ?? line.id,
      assetId: line.assetId ?? line.id,
      qty: Math.max(1, Number(line.qty) || 1),
      name: line.name || `#${line.assetId ?? line.id}`,
      customer: line.customerName,
      due: line.returnDate,
      daysLate: daysOverdue(line.dueAt || line.returnDate),
    }))
    .sort((a, b) => b.daysLate - a.daysLate);

  // `count` is units of stock, not rows — a category holding eight of one
  // battery is not the same size as one holding eight different lenses.
  const byCategory = new Map();
  for (const row of usage) {
    const key = row.category || 'Uncategorised';
    const entry = byCategory.get(key) || { category: key, hours: 0, count: 0, assets: 0 };
    entry.hours += row.hours;
    entry.count += row.quantity;
    entry.assets += 1;
    byCategory.set(key, entry);
  }

  const unitsOut = checkouts.reduce((sum, line) => sum + Math.max(1, Number(line.qty) || 1), 0);

  return {
    rangeStart,
    rangeEnd,
    totalAssets: inScope.length,
    totalUnits: inScope.reduce((sum, a) => sum + Math.max(1, Number(a.quantity) || 1), 0),
    checkedOutNow: unitsOut,
    checkedOutLines: checkouts.length,
    overdueNow: overdue.length,
    avgUtil: usage.length ? usage.reduce((sum, r) => sum + r.utilPct, 0) / usage.length : 0,
    topUsed: [...usage].sort((a, b) => b.hours - a.hours).slice(0, 10),
    neverUsed: usage.filter((row) => row.hours === 0).sort((a, b) => a.assetName.localeCompare(b.assetName)),
    byCategory: [...byCategory.values()].sort((a, b) => b.hours - a.hours),
    overdue,
  };
}

// ---------------------------------------------------------------------------
// Monetary value — what the inventory is worth, for insurance.
// ---------------------------------------------------------------------------

/**
 * The rules, decided once here and applied by every caller:
 *
 * 1. ONLY `kind: 'ITEM'` records contribute to a total. A kit is a label around
 *    gear that is already in the list, so adding a kit's own price would count
 *    the same camera twice. A kit's *displayed* worth is the sum of its members
 *    (valueOfLines expands kits into their members). A kit that nonetheless
 *    carries a price of its own is reported in `pricedSets` rather than
 *    swallowed — the operator has to see that the record disagrees with itself.
 * 2. `price` is per unit. Owned value is price x quantity; the value of a
 *    checkout or reservation line is price x the LINE's qty, so 3 of 8 units
 *    out is worth 3, not 8.
 * 3. Money is never added across currencies. Every total is a list of
 *    {currency, amount}; formatTotals() in format.js renders it.
 * 4. An item with no price adds nothing and is COUNTED. A total that silently
 *    omits unpriced gear is worse than useless on an insurance form, so the gap
 *    travels with the number.
 */

const DEFAULT_CURRENCY = 'EUR';

/** The record's currency, or EUR. Never an empty string. */
export function currencyOf(asset) {
  const code = String(asset?.currency ?? '').trim();
  return code || DEFAULT_CURRENCY;
}

/**
 * The per-unit price as a number, or null when none is recorded.
 *
 * unitPriceOf() is what makes this right for an asset that prices its units
 * one by one: it hands back the unit sum divided by the count, so the
 * `price x quantity` every caller below does still lands on the sum.
 */
export function priceOf(asset) {
  const raw = unitPriceOf(asset);
  if (raw === null || raw === undefined || raw === '') return null;
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Stock held by one record. Kits are always 1 unit of themselves. */
export function unitsOf(asset) {
  return Math.max(1, Number(asset?.quantity) || 1);
}

/** Accumulates amounts in separate per-currency buckets. */
function moneyBag() {
  const buckets = new Map();
  return {
    add(currency, amount) {
      if (!Number.isFinite(amount)) return;
      buckets.set(currency, (buckets.get(currency) || 0) + amount);
    },
    totals() {
      return [...buckets.entries()]
        .map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 }))
        .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency));
    },
  };
}

/** Accepts a Map, an array of assets, or a lookup function. */
function lookupFor(source) {
  if (typeof source === 'function') return source;
  if (source && typeof source.get === 'function') return (id) => source.get(Number(id));
  const map = new Map((source || []).map((asset) => [Number(asset.id), asset]));
  return (id) => map.get(Number(id));
}

/**
 * What a set of lines is worth. `lines` is [{id|assetId, qty}] — the shape the
 * basket, a checkout group and a reservation all already have.
 *
 * A line pointing at a kit is expanded into the kit's members, exactly as
 * store.js expands the selection, so the kit's own price is never what is
 * counted. Nested kits are skipped, as they are there.
 */
export function valueOfLines(lines, assets) {
  const find = lookupFor(assets);
  const bag = moneyBag();
  const unpriced = [];
  let units = 0;
  let pricedUnits = 0;

  const take = (asset, qty) => {
    if (!asset || qty <= 0) return;
    units += qty;
    const price = priceOf(asset);
    if (price === null) {
      unpriced.push({ id: asset.id, name: asset.name || `#${asset.id}`, qty });
      return;
    }
    pricedUnits += qty;
    bag.add(currencyOf(asset), price * qty);
  };

  for (const line of lines || []) {
    const id = Number(line?.id ?? line?.assetId);
    const qty = Math.max(1, Number(line?.qty) || 1);
    const asset = find(id);
    if (!asset) continue;
    if (asset.kind === 'SET') {
      for (const member of asset.members || []) {
        const memberId = Number(member?.assetId ?? member);
        const target = find(memberId);
        if (target && target.kind !== 'SET') {
          take(target, qty * Math.max(1, Number(member?.qty ?? 1)));
        }
      }
    } else {
      take(asset, qty);
    }
  }

  return {
    totals: bag.totals(),
    units,
    pricedUnits,
    unpriced,
    unpricedCount: unpriced.length,
    unpricedUnits: unpriced.reduce((sum, row) => sum + row.qty, 0),
  };
}

/**
 * The whole picture: what is owned, what is out with somebody, where the money
 * sits, and what is not priced at all.
 *
 * `checkouts` are transaction lines, so `line.qty` is what is out — never the
 * asset's stock.
 */
export function computeValue({ assets = [], checkouts = [] } = {}) {
  const find = lookupFor(assets);
  const owned = moneyBag();
  const byCategory = new Map();
  const unpriced = [];
  const pricedSets = [];
  const currencies = new Set();

  let ownedUnits = 0;
  let pricedAssets = 0;

  for (const asset of assets) {
    if (asset.kind === 'SET') {
      // Not counted, but not hidden either: a priced kit means the record
      // disagrees with rule 1 and the operator has to know.
      if (priceOf(asset) !== null) {
        pricedSets.push({
          id: asset.id,
          name: asset.name || `#${asset.id}`,
          price: priceOf(asset),
          currency: currencyOf(asset),
        });
      }
      continue;
    }
    if (asset.kind !== 'ITEM') continue;

    const units = unitsOf(asset);
    const price = priceOf(asset);
    const currency = currencyOf(asset);
    const category = asset.category || 'Uncategorised';

    const entry = byCategory.get(category)
      || { category, bag: moneyBag(), units: 0, assets: 0, unpricedCount: 0 };
    entry.units += units;
    entry.assets += 1;

    ownedUnits += units;

    if (price === null) {
      unpriced.push({
        id: asset.id,
        name: asset.name || `#${asset.id}`,
        category: asset.category || '',
        quantity: units,
      });
      entry.unpricedCount += 1;
    } else {
      pricedAssets += 1;
      currencies.add(currency);
      owned.add(currency, price * units);
      entry.bag.add(currency, price * units);
    }

    byCategory.set(category, entry);
  }

  // Value out is per LINE quantity, so a partial checkout values what is
  // actually gone.
  const out = valueOfLines(
    checkouts.map((line) => ({ id: line.assetId ?? line.id, qty: line.qty })),
    find,
  );
  for (const row of out.totals) currencies.add(row.currency);

  const categories = [...byCategory.values()]
    .map((entry) => ({
      category: entry.category,
      totals: entry.bag.totals(),
      units: entry.units,
      assets: entry.assets,
      unpricedCount: entry.unpricedCount,
    }))
    .sort((a, b) => {
      const av = a.totals[0]?.amount || 0;
      const bv = b.totals[0]?.amount || 0;
      return bv - av || a.category.localeCompare(b.category);
    });

  const currencyList = [...currencies].sort();

  return {
    totals: owned.totals(),
    outTotals: out.totals,
    outUnits: out.units,
    outUnpricedCount: out.unpricedCount,
    byCategory: categories,
    unpriced: unpriced.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    unpricedCount: unpriced.length,
    unpricedUnits: unpriced.reduce((sum, row) => sum + row.quantity, 0),
    pricedAssets,
    totalUnits: ownedUnits,
    currencies: currencyList,
    // null when the data mixes currencies, so a caller can keep the common
    // single-currency case plain without ever guessing.
    singleCurrency: currencyList.length === 1 ? currencyList[0] : null,
    pricedSets,
  };
}
