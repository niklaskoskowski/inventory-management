/**
 * Invoice lines for one booking — the rental priced exactly like the rental
 * quote PDF (rentalOfLines), turned into the line shape the Invoice app takes.
 *
 * Money only, never the rate behind it: a percentage is a fraction of what the
 * gear cost to buy (see rental.js formatPercent()).
 *
 * The lines are written in German: Invoice is a German invoicing tool and the
 * operator can edit every line in the dialog before it is sent.
 */

import { rentalDays, rentalOfLines, hireOf } from './rental.js';
import { parseDate } from './format.js';

const round = (value, digits = 2) => {
  const f = 10 ** digits;
  return Math.round((Number(value) || 0) * f) / f;
};

/** `YYYY-MM-DD` (local) or ''. */
export function isoDay(value) {
  const date = parseDate(value);
  if (!date) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 01.11.2026 */
export function deDate(value) {
  const date = parseDate(value);
  return date ? date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
}

/** Where the hire starts and ends, for a booking of either kind. */
export function bookingPeriod(booking) {
  const from = booking?.startAt || booking?.createdAt || null;
  const to = booking?.dueAt || from;
  return { from, to, days: rentalDays(from, to) };
}

const dayWord = (days) => (days === 1 ? '1 Tag' : `${days} Tage`);

/** "3 Tage · 01.11.2026 – 04.11.2026" */
export function periodText(booking) {
  const { from, to, days } = bookingPeriod(booking);
  const a = deDate(from);
  const b = deDate(to);
  return `${dayWord(days)}${a ? ` · ${a}${b && b !== a ? ` – ${b}` : ''}` : ''}`;
}

/** The booking's items in the shape rentalOfLines() takes. */
function linesOf(booking) {
  return (booking?.items || []).map((item) => ({
    id: item.assetId,
    qty: item.qty,
    unitNos: item.unitNos || [],
  }));
}

/**
 * Builds the proposed invoice for `booking`.
 *
 * Returns `{ lines, days, hire, total, currency, unpriced, currencies }`.
 * Each line: {title, description, sku, quantity, unit, unit_price, vat_rate, missing}
 * — `missing` flags a line nothing could price (no value or no rate), so the
 * dialog can ask for a price instead of sending 0 silently.
 */
export function buildInvoiceLines(booking, assets, settings) {
  const cfg = settings?.invoice || {};
  const vat = Number.isFinite(Number(cfg.vatRate)) ? Number(cfg.vatRate) : 19;
  const toNet = cfg.pricesIncludeVat ? 1 / (1 + vat / 100) : 1;
  const { days } = bookingPeriod(booking);
  const hire = hireOf(booking || {});
  const quote = rentalOfLines(linesOf(booking), assets, settings, days, { hire });
  const period = periodText(booking);
  const service = hire === 'SERVICE' ? ' · Full Service' : '';

  const rows = quote.rows.filter((row) => row.asset);
  const currencies = [...new Set(rows.map((row) => row.currency || 'EUR'))];

  let lines = rows.map((row) => {
    const asset = row.asset;
    const units = (booking.items || [])
      .filter((item) => Number(item.assetId) === Number(asset.id) && item.unitNos?.length)
      .flatMap((item) => item.unitNos.map((no) => `${asset.id}.${no}`));
    const description = [
      `Mietzeitraum: ${period}${service}`,
      row.via ? `Teil von: ${row.via.name}` : '',
      units.length ? `Einheiten: ${units.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const total = row.amount === null ? 0 : row.amount;
    // Per piece for the whole period. A line whose units are priced
    // differently has no single figure: total / qty, 4 decimals, so qty × price
    // still lands on the same total.
    const perUnit = row.unitAmount !== null ? row.unitAmount : (row.qty ? total / row.qty : total);
    return {
      title: String(asset.name || `#${asset.id}`),
      description,
      sku: `#${asset.id}`,
      quantity: row.qty,
      unit: 'C62',
      unit_price: round(perUnit * toNet, 4),
      vat_rate: vat,
      missing: row.amount === null || row.unpricedUnits > 0 || row.unratedUnits > 0,
    };
  });

  if (cfg.lineMode === 'summary' && lines.length) {
    const sum = lines.reduce((acc, line) => acc + line.quantity * line.unit_price, 0);
    lines = [{
      title: `Miete Equipment${service}`,
      description: [`Mietzeitraum: ${period}`, ...rows.map((row) => `${row.qty}× ${row.asset.name || `#${row.asset.id}`}`)].join('\n'),
      sku: '',
      quantity: 1,
      unit: 'C62',
      unit_price: round(sum, 4),
      vat_rate: vat,
      missing: lines.some((line) => line.missing),
    }];
  }

  return {
    lines,
    days,
    hire,
    currencies,
    currency: currencies[0] || 'EUR',
    unpriced: lines.filter((line) => line.missing).length,
    total: round(lines.reduce((acc, line) => acc + line.quantity * line.unit_price, 0)),
  };
}

/** Net total of edited lines. */
export function linesNet(lines) {
  return round((lines || []).reduce((acc, line) => acc + round((Number(line.quantity) || 0) * (Number(line.unit_price) || 0)), 0));
}

/** Gross total of edited lines (VAT per line rate, grouped like Invoice). */
export function linesGross(lines) {
  const groups = new Map();
  for (const line of lines || []) {
    const rate = Number(line.vat_rate) || 0;
    groups.set(rate, (groups.get(rate) || 0) + round((Number(line.quantity) || 0) * (Number(line.unit_price) || 0)));
  }
  let gross = 0;
  for (const [rate, basis] of groups) gross += round(basis) + round(basis * rate / 100);
  return round(gross);
}

/** Splits "Max Mustermann" into first/last for a new person customer. */
export function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first_name: '', last_name: parts[0] || '' };
  return { first_name: parts.slice(0, -1).join(' '), last_name: parts[parts.length - 1] };
}

/** Invoice-side document status → chip text and class. */
export const INVOICE_STATUS = {
  draft: { label: 'Draft', cls: 'text-bg-secondary' },
  open: { label: 'Open', cls: 'text-bg-primary' },
  partial: { label: 'Part-paid', cls: 'text-bg-warning' },
  paid: { label: 'Paid', cls: 'text-bg-success' },
  cancelled: { label: 'Cancelled', cls: 'text-bg-danger' },
  invoiced: { label: 'Invoiced', cls: 'text-bg-primary' },
};
