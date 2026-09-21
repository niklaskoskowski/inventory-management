/**
 * Rental pricing.
 *
 * What a piece of gear is WORTH is `price`, and insights.js adds those up.
 * What it costs to HIRE is a rule, and a rule is resolved rather than stored:
 *
 *     unit.rental  ->  asset.rental  ->  settings.rental.categories[category]
 *                                    ->  settings.rental.default
 *
 * A rule is either a daily PERCENT of the item's value or a FIXED amount —
 * some gear is simply "50 a day" or "120 for the job", whatever it is worth.
 * A percent rule carries a ladder of discounts (`tiers`): "from 2 days on it
 * is 4% a day, from 7 days on 3%". The ladder lives on the CATEGORY, because
 * it is a commercial decision about a class of gear rather than about one
 * camera; an asset or a unit overrides the base rate and the ladder then
 * applies to it **in proportion** — a category charging 5% a day and 3% from a
 * week on gives a unit overridden to 6% a rate of 6 x (3/5) = 3.6% from a week
 * on. Anything else would mean either losing the discount on every overridden
 * record or making every override carry its own ladder.
 *
 * A hire is also either DRY or SERVICE. Dry hire is the gear on its own and IS
 * what every rate above says — which is why nothing had to declare it before
 * this existed. On a serviced job the operator's own time is invoiced
 * separately, so the equipment side of it is the dry-hire price times the
 * category's `serviceFactor` (typically below 1). The factor is a commercial
 * decision about a class of gear, so it lives on the RULE beside the discount
 * ladder, and never on an asset or a unit.
 *
 * Nothing here is stored: a rental figure is always worked out from the rule
 * that is in force now, exactly like availability and value. What IS stored is
 * which KIND of job a booking is — that is a fact about the booking, like the
 * customer's name, and it rides on the checkout line, the reservation and the
 * booking record.
 */

import { parseDate, diffDays, unitPriceOf } from './format.js';
import { currencyOf } from './insights.js';

/** A category rate is one of these two. Mirrors TRAX_RENTAL_MODES. */
export const RENTAL_MODES = ['PERCENT', 'FIXED'];
/** An asset's or a unit's own rate may also defer to whatever is above it. */
export const OVERRIDE_MODES = ['INHERIT', 'PERCENT', 'FIXED'];
/** A fixed amount is charged once for the hire, or once per day of it. */
export const FIXED_PER = ['RENTAL', 'DAY'];

/** Dry hire, or the gear as part of a serviced job. Mirrors TRAX_HIRE_MODES. */
export const HIRE_MODES = ['DRY', 'SERVICE'];

export const HIRE_LABEL = { DRY: 'Dry hire', SERVICE: 'Full service' };

/** What a record says it is, defaulted. Everything older than this is dry hire. */
export function hireOf(record) {
  const value = String(record?.hire ?? '').toUpperCase();
  return HIRE_MODES.includes(value) ? value : 'DRY';
}

/** The shape of a complete rate, and what a missing one reads as. */
export const BLANK_RULE = {
  mode: 'PERCENT', percent: 0, fixed: 0, fixedPer: 'RENTAL', tiers: [], serviceFactor: null,
};
/** The shape of a record's own rate. `null` means "not set on this one". */
export const BLANK_OVERRIDE = { mode: 'INHERIT', percent: null, fixed: null, fixedPer: 'RENTAL' };

const round2 = (value) => Math.round(value * 100) / 100;
const round3 = (value) => Math.round(value * 1000) / 1000;

/**
 * A finite number, or null. An empty box is never 0 here.
 *
 * A comma is read as a decimal point, the same courtesy trax_float() does on
 * the way in: the rate boxes are plain text inputs and "4,5" is what a German
 * keyboard produces.
 */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(typeof value === 'string' ? value.trim().replace(',', '.') : value);
  return Number.isFinite(number) ? number : null;
}

/**
 * How many days a hire runs for.
 *
 * Whole calendar days, the way a counter actually charges: out on the 19th and
 * back on the 26th is seven days whatever the hours say, and anything shorter
 * than a day is one day. diffDays() measures from midnight to midnight, so a
 * due time of 18:00 cannot quietly become an eighth day.
 */
export function rentalDays(from, to) {
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end) return 1;
  return Math.max(1, diffDays(start, end));
}

/** settings.rental in a shape every caller below can rely on. */
export function rentalSettings(settings) {
  const block = settings?.rental || {};
  return {
    default: { ...BLANK_RULE, ...(block.default || {}), tiers: [...(block.default?.tiers || [])] },
    categories: Array.isArray(block.categories) ? block.categories : [],
  };
}

/** The stored rule for one category, or null when it has none of its own. */
export function categoryRule(settings, category) {
  const name = String(category ?? '').trim();
  if (!name) return null;
  const found = rentalSettings(settings).categories
    .find((rule) => String(rule?.category ?? '') === name);
  return found ? { ...BLANK_RULE, ...found, tiers: [...(found.tiers || [])] } : null;
}

/** The rule an asset is priced by: its category's, or the install's default. */
export function ruleFor(settings, category) {
  const own = categoryRule(settings, category);
  if (own) return { rule: own, source: 'category' };
  return { rule: rentalSettings(settings).default, source: 'default' };
}

/**
 * What the gear costs on a serviced job, as a multiple of the dry-hire price.
 *
 * The category's answer, then the install's, then 1 — which means "the same
 * money either way" and is what an install that has never been told a factor
 * charges. Resolved separately from the rate itself because an asset or a unit
 * may overrule the rate without overruling a commercial policy about the class
 * of gear it belongs to.
 */
export function serviceFactorOf(settings, category) {
  const own = categoryRule(settings, category);
  if (own && own.serviceFactor !== null && own.serviceFactor !== undefined && own.serviceFactor !== '') {
    const value = num(own.serviceFactor);
    if (value !== null) return value;
  }
  const fallback = num(rentalSettings(settings).default.serviceFactor);
  return fallback === null ? 1 : fallback;
}

/** One record's own rate, defaulted. Accepts an asset, a unit or nothing. */
export function overrideOf(record) {
  const raw = record?.rental || {};
  return {
    mode: OVERRIDE_MODES.includes(raw.mode) ? raw.mode : 'INHERIT',
    percent: num(raw.percent),
    fixed: num(raw.fixed),
    fixedPer: FIXED_PER.includes(raw.fixedPer) ? raw.fixedPer : 'RENTAL',
  };
}

/** Does this record say anything about its own rate? */
export function hasOverride(record) {
  const own = overrideOf(record);
  if (own.mode === 'INHERIT') return false;
  return own.mode === 'FIXED' ? own.fixed !== null : own.percent !== null;
}

/**
 * The rate actually in force for one unit of an asset.
 *
 * `unit` may be null — that is the untracked record, and the asset answers for
 * itself. An override that names no number is not an override: an empty box
 * falls through to whatever is above it rather than charging zero.
 *
 * Returns the resolved rate plus the category rule it came from, because the
 * ladder is read off that rule and not off the override.
 */
export function resolveRate(asset, unit, settings) {
  const { rule, source: ruleSource } = ruleFor(settings, asset?.category);

  for (const [source, own] of [['unit', overrideOf(unit)], ['asset', overrideOf(asset)]]) {
    if (own.mode === 'INHERIT') continue;
    if (own.mode === 'FIXED') {
      if (own.fixed === null) continue;
      return {
        mode: 'FIXED',
        percent: null,
        fixed: own.fixed,
        fixedPer: own.fixedPer,
        tiers: rule.tiers,
        rule,
        source,
      };
    }
    if (own.percent === null) continue;
    return {
      mode: 'PERCENT',
      percent: own.percent,
      fixed: null,
      fixedPer: 'RENTAL',
      tiers: rule.tiers,
      rule,
      source,
    };
  }

  return {
    mode: rule.mode,
    percent: rule.mode === 'PERCENT' ? rule.percent : null,
    fixed: rule.mode === 'FIXED' ? rule.fixed : null,
    fixedPer: rule.fixedPer,
    tiers: rule.tiers,
    rule,
    source: ruleSource,
  };
}

/** The discount step that applies to a hire of `days`, or null for none. */
export function tierFor(tiers, days) {
  let hit = null;
  for (const tier of tiers || []) {
    const from = Number(tier?.days);
    if (Number.isFinite(from) && from <= days) hit = tier;
  }
  return hit;
}

/**
 * The daily percentage charged for a hire of `days`, or null for a fixed rate.
 *
 * The ladder is absolute — the operator types "from 7 days: 3%" — so it is
 * used as typed when the rate came from the category. An asset or unit that
 * overrides the base rate keeps the ladder's SHAPE: the discounted rate is
 * scaled by tier/base, so a discount stays a discount of the same size. With
 * no base to scale against (a category priced by a fixed amount, say) the
 * override is charged flat.
 */
export function rateForDays(resolved, days) {
  if (!resolved || resolved.mode !== 'PERCENT') return null;

  const tier = tierFor(resolved.tiers, days);
  if (!tier) return resolved.percent;

  const tierPercent = Number(tier.percent) || 0;
  if (resolved.source !== 'unit' && resolved.source !== 'asset') return tierPercent;

  const base = Number(resolved.rule?.percent) || 0;
  if (base <= 0) return resolved.percent;
  return round3(resolved.percent * (tierPercent / base));
}

/**
 * What one unit is worth, as the basis for a percentage rate.
 *
 * Once an asset prices its units the units are the truth — so a unit without a
 * price of its own has no basis rather than borrowing the average of its
 * siblings. Everything else falls back to the asset's per-unit price.
 */
export function priceBasis(asset, unit) {
  if (unit) {
    const own = num(unit.price);
    if (own !== null) return own;
    return asset?.unitPriced ? null : num(unitPriceOf(asset));
  }
  return num(unitPriceOf(asset));
}

/** Is a rate actually set, or is this gear simply not hired out for money? */
export function isRated(resolved) {
  if (!resolved) return false;
  return resolved.mode === 'FIXED'
    ? Number(resolved.fixed) > 0
    : Number(resolved.percent) > 0;
}

/**
 * What hiring ONE unit for `days` days costs.
 *
 * `amount` is null when the rate is a percentage and nothing says what the
 * item is worth — an unpriced line is reported, never silently charged at 0.
 */
export function rentalOfUnit(asset, unit, settings, days, hire = 'DRY') {
  const resolved = resolveRate(asset, unit, settings);
  const rated = isRated(resolved);
  // The factor multiplies the finished amount, whichever way it was worked
  // out: "full service is 0.7 x dry hire" holds for a percentage of value and
  // for a flat price alike.
  const service = hireOf({ hire }) === 'SERVICE';
  const factor = service ? serviceFactorOf(settings, asset?.category) : 1;
  const charge = (amount) => round2(amount * factor);

  if (resolved.mode === 'FIXED') {
    const fixed = Number(resolved.fixed) || 0;
    const dry = round2(resolved.fixedPer === 'DAY' ? fixed * days : fixed);
    return {
      amount: charge(dry),
      dry,
      factor,
      rate: null,
      basis: null,
      resolved,
      rated,
      unpriced: false,
    };
  }

  const rate = rateForDays(resolved, days);
  const basis = priceBasis(asset, unit);
  if (basis === null) {
    return { amount: null, dry: null, factor, rate, basis: null, resolved, rated, unpriced: true };
  }
  const dry = round2(basis * (rate / 100) * days);
  return {
    amount: charge(dry),
    dry,
    factor,
    rate,
    basis,
    resolved,
    rated,
    unpriced: false,
  };
}

/** Accepts a Map, an array of assets, or a lookup function — like insights.js. */
function lookupFor(source) {
  if (typeof source === 'function') return source;
  if (source && typeof source.get === 'function') return (id) => source.get(Number(id));
  const map = new Map((source || []).map((asset) => [Number(asset.id), asset]));
  return (id) => map.get(Number(id));
}

/** Per-currency buckets. Money is never added across currencies. */
function moneyBag() {
  const buckets = new Map();
  return {
    add(currency, amount) {
      if (!Number.isFinite(amount)) return;
      buckets.set(currency, (buckets.get(currency) || 0) + amount);
    },
    totals() {
      return [...buckets.entries()]
        .map(([currency, amount]) => ({ currency, amount: round2(amount) }))
        .sort((a, b) => b.amount - a.amount || a.currency.localeCompare(b.currency));
    },
  };
}

/**
 * Which physical units a line will actually hand over.
 *
 * Whatever the operator picked, then the free ones in number order — which is
 * how the server assigns them. It matters because a unit can carry a rate of
 * its own, so "3 of these" is not necessarily three times the same money.
 */
function unitsForLine(asset, qty, chosen) {
  const units = Array.isArray(asset?.units) ? asset.units : [];
  if (!units.length) return [];

  const byNo = new Map(units.map((unit) => [Number(unit.no), unit]));
  const picked = (chosen && chosen.length ? chosen : (asset.availableUnitNos || []))
    .map((no) => byNo.get(Number(no)))
    .filter(Boolean)
    .slice(0, qty);

  // Short of `qty` named units the rest are priced at the asset's own rate:
  // the line is for more units than are free, which the drawer already warns
  // about, and guessing which ones would be worse than saying "the usual rate".
  return picked;
}

/**
 * What a set of lines costs to hire for `days` days.
 *
 * `lines` is [{id|assetId, qty, unitNos?}] — the shape the basket, a checkout
 * group and a reservation already have. A line pointing at a kit is expanded
 * into its members, exactly as valueOfLines() does, so a kit's own rate is
 * never charged on top of the gear inside it.
 *
 * `options`:
 *   - `unitChoice` — the basket's assetId => [no] map, used when a line does
 *     not carry `unitNos` itself.
 *   - `hire` — DRY or SERVICE for the whole set. A line that names its OWN
 *     `hire` wins over it, which is what makes a checkout list of several
 *     bookings price each of them as what it actually is.
 */
export function rentalOfLines(lines, assets, settings, days, options = {}) {
  const { unitChoice = null, hire = 'DRY' } = options;
  const find = lookupFor(assets);
  const bag = moneyBag();
  const rows = [];
  const unpriced = [];
  const unrated = [];
  let units = 0;

  const take = (asset, qty, chosen, via, lineHire) => {
    if (!asset || qty <= 0) return;
    units += qty;

    const picked = unitsForLine(asset, qty, chosen);
    const currency = currencyOf(asset);
    const bits = [];
    let amount = 0;
    let missing = 0;
    let unratedUnits = 0;

    for (let index = 0; index < qty; index++) {
      const priced = rentalOfUnit(asset, picked[index] || null, settings, days, lineHire);
      bits.push(priced);
      if (priced.amount === null) missing += 1;
      else amount += priced.amount;
      if (!priced.rated) unratedUnits += 1;
    }

    if (missing) unpriced.push({ id: asset.id, name: asset.name || `#${asset.id}`, qty: missing });
    if (unratedUnits) unrated.push({ id: asset.id, name: asset.name || `#${asset.id}`, qty: unratedUnits });

    amount = round2(amount);
    bag.add(currency, amount);

    // One row per line, with the FIRST unit's rate as the line's headline —
    // mixed rates inside one line are flagged rather than averaged away.
    const first = bits[0];
    const mixed = bits.some((bit) => bit.rate !== first.rate || bit.amount !== first.amount);
    rows.push({
      asset,
      via,
      qty,
      days,
      hire: lineHire,
      currency,
      amount: missing === qty ? null : amount,
      unitAmount: mixed ? null : first.amount,
      rate: mixed ? null : first.rate,
      mode: first.resolved.mode,
      fixedPer: first.resolved.fixedPer,
      source: first.resolved.source,
      mixed,
      unpricedUnits: missing,
      unratedUnits,
    });
  };

  for (const line of lines || []) {
    const id = Number(line?.id ?? line?.assetId);
    const qty = Math.max(1, Number(line?.qty) || 1);
    const asset = find(id);
    if (!asset) continue;

    const chosen = Array.isArray(line?.unitNos) && line.unitNos.length
      ? line.unitNos
      : (unitChoice ? unitChoice[Number(id)] || [] : []);
    // The line's own answer when it has one — a checkout line and a
    // reservation both carry it — otherwise what the caller is asking for.
    const lineHire = line?.hire ? hireOf(line) : hireOf({ hire });

    if (asset.kind === 'SET') {
      for (const member of asset.members || []) {
        const target = find(Number(member?.assetId ?? member));
        if (target && target.kind !== 'SET') {
          take(target, qty * Math.max(1, Number(member?.qty ?? 1)), [], asset, lineHire);
        }
      }
    } else {
      take(asset, qty, chosen, null, lineHire);
    }
  }

  return {
    days,
    hire: hireOf({ hire }),
    rows,
    totals: bag.totals(),
    units,
    unpriced,
    unpricedCount: unpriced.length,
    unpricedUnits: unpriced.reduce((sum, row) => sum + row.qty, 0),
    unrated,
    unratedCount: unrated.length,
  };
}

/**
 * A percentage without trailing zero noise: 3, 3.5, 3.75.
 *
 * For the operator's screens only. A rate is a fraction of what the gear cost
 * to buy, so it never reaches a document a customer is handed — the rental PDF
 * prints money and nothing else.
 */
export function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(round3(number));
}

/** "1 day", "7 days (1 week)" — how a duration reads in the rate editor. */
export function daysLabel(days) {
  const number = Math.max(1, Math.floor(Number(days) || 1));
  if (number === 1) return '1 day';
  if (number % 7 === 0) {
    const weeks = number / 7;
    return `${number} days (${weeks} week${weeks === 1 ? '' : 's'})`;
  }
  return `${number} days`;
}
