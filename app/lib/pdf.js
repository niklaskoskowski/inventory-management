/**
 * PDF export.
 *
 * jsPDF is a UMD bundle, not an ES module, so it is loaded on demand and read
 * off `window`. Doing it lazily keeps ~400 KB out of the initial page load —
 * the old admin pulled it from a CDN on every visit whether or not anyone
 * exported anything.
 */

import {
  formatDate, formatDateTime, formatMoney, formatTotals, statusLabel, parseDate,
  purchasedAtOf,
} from './format.js';
import { computeValue, valueOfLines, currencyOf, priceOf, unitsOf } from './insights.js';
import { state } from '../store.js';

/** The brand colour's fallback, matching lib/store.php's default. */
const BRAND_FALLBACK = [31, 41, 55];

/** '#1f2937' or '#1f2' -> [31, 41, 55]. Anything else -> the fallback. */
function hexToRgb(hex) {
  const text = String(hex ?? '').trim().replace(/^#/, '');
  const full = text.length === 3 ? text.replace(/./g, (c) => c + c) : text;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return BRAND_FALLBACK.slice();
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * settings.branding.brandColor as [r, g, b]. Everything in these documents that
 * is not body text is this colour.
 *
 * A function, not a constant: settings can change under a long-lived tab, and
 * an export started after a save must use the colour that was saved.
 */
const BRAND = () => hexToRgb(state.settings?.branding?.brandColor);

/** What the operator calls this install; used in headers and file names. */
const appName = () => state.settings?.branding?.appName || 'Assets';

/** Zebra striping on every table, kept from the first report. */
const ZEBRA = () => [246, 248, 250];

/**
 * The header logo is settings.branding.logoFile, the same artwork the printed
 * labels use — dark marks on transparency, drawn for a white background. So the
 * header band stays white and the rule under it carries the brand colour.
 *
 * Empty means the install has no logo, and the header sets the app name instead.
 */
const LOGO_WIDTH = 42;
/** Where the navy rule sits, and where a page's content may start.  */
const RULE_Y = 22;
const CONTENT_TOP = 40;
/** How many kits a value caveat names before it falls back to `+N more`. */
const CAVEAT_NAMES = 3;

/**
 * The printed tick boxes on a booking sheet, in mm.
 *
 * They are STROKED RECTANGLES, never a character. jsPDF's default font is
 * WinAnsi-encoded and has no ☐ (U+2610) — the same gap that turns the
 * inventory report's arrow into `!'`. A glyph here would print as mojibake on
 * the one document that has to survive being carried around a warehouse.
 *
 * A row is one line but `qty` physical units, so it gets one box per unit up
 * to TICK_CAP; past that a single box plus a `+N` label, because thirty boxes
 * would neither fit nor be tickable.
 */
const TICK_BOX = 3.4;
const TICK_GAP = 1.3;
const TICK_CAP = 5;
/** Matches the booking table's cellPadding, so the first box sits on the text grid. */
const TICK_PAD = 1.8;
/** Room reserved after the last box for the `+N` on a capped row. */
const TICK_OVERFLOW = 6;

let loading = null;
let logoLoading = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

async function jsPdf() {
  if (!window.jspdf) {
    loading = loading || (async () => {
      await loadScript('vendor/jspdf.umd.min.js');
      await loadScript('vendor/jspdf.plugin.autotable.min.js');
    })();
    await loading;
  }
  return window.jspdf.jsPDF;
}

/**
 * The logo as {dataUri, format, width, height}, fetched once per file name and
 * remembered.
 *
 * `decorate()` has to stay synchronous — it runs again on every page break — so
 * the bytes AND the natural size are resolved before the first call and handed
 * in. The size comes from an Image element rather than a hardcoded pair, so
 * replacing the logo with a differently-shaped one cannot squash it.
 *
 * Resolves to null when there is no logo configured, when the fetch fails, or
 * when the bytes are not a decodable image. The header then sets the app name
 * as text: an export never fails over artwork.
 */
function brandLogo() {
  const src = state.settings?.branding?.logoFile || '';
  if (src === '') return Promise.resolve(null);
  // Keyed by name so a logo changed in Settings is re-fetched rather than
  // served from a cache that remembers the old one.
  if (logoLoading?.src !== src) {
    logoLoading = { src, promise: loadLogo(src) };
  }
  return logoLoading.promise;
}

async function loadLogo(src) {
  try {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = (response.headers.get('content-type') || '').toLowerCase();
    const jpeg = type.includes('jpeg') || type.includes('jpg') || /\.jpe?g$/i.test(src);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const dataUri = `data:image/${jpeg ? 'jpeg' : 'png'};base64,${base64Of(bytes)}`;

    const size = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = dataUri;
    });
    if (!size || !size.width || !size.height) return null;

    return { dataUri, format: jpeg ? 'JPEG' : 'PNG', ...size };
  } catch {
    return null;
  }
}

/**
 * Asset thumbnails, fetched once per file and remembered.
 *
 * Same shape as brandLogo(): fetch -> bytes -> data URI, resolved BEFORE the
 * document is drawn so the autoTable hooks can stay synchronous. Differences:
 * there are dozens of them, so they are keyed by filename and fetched in
 * parallel, and the natural pixel size is read out of the file header — a
 * thumbnail is never stretched to fill its cell, and there is no Image element
 * to ask off the main thread.
 *
 * The THUMBNAIL is deliberate: uploads/thumb/x.jpg is 5-15 KB where the
 * original is megabytes. A schedule of 28 full photos would be a document
 * nobody can email.
 *
 * A photo that 404s, times out or is in a format whose size cannot be read
 * resolves to null. The cell is then left blank and the export carries on —
 * a missing picture may never cost the operator the whole document.
 */
const THUMB_DIR = 'uploads/thumb/';
const thumbCache = new Map();

/** btoa() wants a binary string, and apply() blows the stack on 30 KB at once. */
function base64Of(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Format and pixel size, straight out of the file header.
 *
 * JPEG: walk the marker chain to the first SOF (0xC0-0xCF, minus the DHT/JPG/DAC
 * markers that share the range) and read its frame header. PNG: IHDR is always
 * the first chunk, at a fixed offset. Anything else returns null.
 */
function imageMeta(bytes) {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    const at = (i) => (bytes[i] << 24 | bytes[i + 1] << 16 | bytes[i + 2] << 8 | bytes[i + 3]) >>> 0;
    return { format: 'PNG', mime: 'image/png', width: at(16), height: at(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = (bytes[i + 2] << 8) | bytes[i + 3];
      const isFrame = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        return {
          format: 'JPEG',
          mime: 'image/jpeg',
          height: (bytes[i + 5] << 8) | bytes[i + 6],
          width: (bytes[i + 7] << 8) | bytes[i + 8],
        };
      }
      if (length < 2) break;
      i += 2 + length;
    }
  }
  return null;
}

/** One thumbnail as {uri, format, width, height, alias}, or null. */
function assetThumb(file) {
  const name = String(file ?? '').trim();
  if (!name) return Promise.resolve(null);

  let pending = thumbCache.get(name);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(THUMB_DIR + encodeURIComponent(name));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const meta = imageMeta(bytes);
        if (!meta || !meta.width || !meta.height) return null;
        return {
          ...meta,
          uri: `data:${meta.mime};base64,${base64Of(bytes)}`,
          // Stable per file, so jsPDF stores the bytes ONCE however many rows
          // (or pages) draw that asset.
          alias: `trax-thumb-${name}`,
        };
      } catch {
        return null;
      }
    })();
    thumbCache.set(name, pending);
  }
  return pending;
}

/**
 * filename => thumb|null for a whole document, fetched concurrently.
 *
 * Distinct filenames only: 28 rows of the same photo are one request and one
 * embedded image.
 */
async function loadThumbs(files) {
  const names = [...new Set((files || []).map((file) => String(file ?? '').trim()).filter(Boolean))];
  const loaded = await Promise.all(names.map((name) => assetThumb(name)));
  return new Map(names.map((name, index) => [name, loaded[index]]));
}

/**
 * Draws one thumbnail into its cell, contained and centred.
 *
 * Scaled by the smaller of the two ratios, so a portrait shot letterboxes
 * rather than being squashed into a landscape box. Failure here is swallowed:
 * see the note on assetThumb().
 */
function drawThumb(doc, cell, thumb, pad = 1.2) {
  if (!thumb) return;
  const boxWidth = cell.width - pad * 2;
  const boxHeight = cell.height - pad * 2;
  if (boxWidth <= 0 || boxHeight <= 0) return;

  const scale = Math.min(boxWidth / thumb.width, boxHeight / thumb.height);
  const width = thumb.width * scale;
  const height = thumb.height * scale;
  try {
    doc.addImage(
      thumb.uri,
      thumb.format,
      cell.x + (cell.width - width) / 2,
      cell.y + (cell.height - height) / 2,
      width,
      height,
      thumb.alias,
      'FAST',
    );
  } catch { /* a picture is never worth the document */ }
}

function reportId() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `TRX-${stamp}-${String(Math.floor(Math.random() * 900) + 100)}`;
}

/**
 * Branded header: white band, logo top-left at its true aspect ratio, a rule in
 * the brand colour, then the document title. `logo` is the object brandLogo()
 * resolved, or null — synchronous by design, see the note there.
 */
function decorate(doc, title, subtitle, logo) {
  const width = doc.internal.pageSize.getWidth();
  const [r, g, b] = BRAND();

  doc.setFillColor(255, 255, 255);
  doc.rect(0, 0, width, RULE_Y + 12, 'F');

  let drew = false;
  if (logo) {
    try {
      // Height comes from the artwork's OWN pixel size, never from a guessed
      // box, so any logo an operator uploads keeps its proportions. The alias
      // keeps one copy in the file however many pages ask for it, and the raw
      // RGBA of a large mark is megabytes, so it gets deflated.
      const height = LOGO_WIDTH * (logo.height / logo.width);
      doc.addImage(logo.dataUri, logo.format, 14, 9, LOGO_WIDTH, height, 'brand-logo', 'FAST');
      drew = true;
    } catch { /* fall through to the wordmark */ }
  }
  if (!drew) {
    doc.setFontSize(15);
    doc.setTextColor(r, g, b);
    doc.text(appName(), 14, 15);
  }

  doc.setDrawColor(r, g, b);
  doc.setLineWidth(0.6);
  doc.line(14, RULE_Y, width - 14, RULE_Y);
  doc.setLineWidth(0.2);

  doc.setFontSize(13);
  doc.setTextColor(r, g, b);
  doc.text(title, 14, RULE_Y + 8);

  doc.setFontSize(8);
  doc.setTextColor(110, 120, 140);
  doc.text(subtitle, width - 14, RULE_Y + 8, { align: 'right' });

  doc.setTextColor(0, 0, 0);
  doc.setDrawColor(0, 0, 0);
}

function footer(doc) {
  const pages = doc.internal.getNumberOfPages();
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();

  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setFontSize(8);
    doc.setTextColor(120, 120, 120);
    doc.text(`Generated ${formatDateTime(new Date())}`, 14, height - 8);
    doc.text(`Page ${page} of ${pages}`, width - 14, height - 8, { align: 'right' });
  }
}

/** Two signature rules with captions, at `y`. */
function signatures(doc, y, left, right) {
  doc.setDrawColor(150);
  doc.line(14, y + 12, 92, y + 12);
  doc.line(112, y + 12, 190, y + 12);
  doc.setFontSize(8);
  doc.setTextColor(100);
  doc.text(left, 14, y + 16);
  doc.text(right, 112, y + 16);
  doc.setTextColor(0, 0, 0);
  doc.setDrawColor(0, 0, 0);
}

/** Full inventory listing, grouped by category. */
export async function exportInventoryPdf(assets, checkouts) {
  const JsPDF = await jsPdf();
  const logo = await brandLogo();
  const doc = new JsPDF();
  const id = reportId();
  // assetId => [lines]; units of one asset can be out with several people.
  const openByAsset = new Map();
  for (const line of checkouts) {
    const key = Number(line.assetId ?? line.id);
    const bucket = openByAsset.get(key);
    if (bucket) bucket.push(line);
    else openByAsset.set(key, [line]);
  }

  decorate(doc, 'Asset Inventory Report', id, logo);

  const groups = new Map();
  for (const asset of assets) {
    const key = asset.category || 'Uncategorised';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(asset);
  }

  let y = CONTENT_TOP;
  // Value is computeValue()'s, not this report's own arithmetic: items only (a
  // kit's own price would count its members twice), a separate total per
  // currency, never a sum across them. The dashboard shows the same figure
  // because it is the same figure — two authoritative numbers that disagree is
  // the last thing an insurance report may do.
  const value = computeValue({ assets, checkouts });
  const unitsOut = checkouts.reduce((sum, line) => sum + Math.max(1, Number(line.qty) || 1), 0);

  doc.setFontSize(9);
  doc.text(
    `${assets.length} assets · ${unitsOut} unit(s) checked out · ${formatTotals(value.totals)} total value`,
    14,
    y,
  );
  y += 5;

  // What the total leaves out travels with it, in the subtitle grey. Unpriced
  // gear is missing money, and a kit that prices itself contradicts the rule
  // above — both have to be visible on the page, not just in the model.
  const caveats = [];
  if (value.unpricedCount) {
    caveats.push(
      `${value.unpricedCount} asset(s), ${value.unpricedUnits} unit(s) have no price and are not in this total`,
    );
  }
  if (value.pricedSets.length) {
    // Named up to a point; a long list would push the first table down the page.
    const named = value.pricedSets.slice(0, CAVEAT_NAMES).map((set) => set.name);
    const extra = value.pricedSets.length - named.length;
    caveats.push(
      `${value.pricedSets.length} kit(s) priced in their own right, excluded so their members `
      + `count once: ${named.join(', ')}${extra > 0 ? ` +${extra} more` : ''}`,
    );
  }
  if (caveats.length) {
    doc.setFontSize(8);
    doc.setTextColor(110, 120, 140);
    const room = doc.internal.pageSize.getWidth() - 28;
    for (const caveat of caveats) {
      for (const line of doc.splitTextToSize(caveat, room)) {
        doc.text(line, 14, y);
        y += 3.6;
      }
    }
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(9);
  }
  y += 3;

  for (const [category, rows] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    doc.autoTable({
      startY: y,
      head: [[category, 'Status', 'Qty', 'Location', 'Serial', 'Out with', 'ID']],
      body: rows.map((asset) => {
        const open = openByAsset.get(asset.id) || [];
        const quantity = Math.max(1, Number(asset.quantity) || 1);
        return [
          asset.name + (asset.kind === 'SET' ? `  (kit · ${asset.members.length})` : ''),
          statusLabel(asset.effectiveStatus, asset.kind),
          asset.kind === 'SET' ? '' : `${asset.availableQty ?? quantity} / ${quantity}`,
          asset.location || '',
          asset.serial || '',
          // Several holders: list them all rather than naming the first.
          open.map((line) => `${line.customerName} ×${line.qty} → ${line.returnDate}`).join('\n'),
          String(asset.id),
        ];
      }),
      styles: { fontSize: 8, cellPadding: 1.6 },
      headStyles: { fillColor: BRAND(), textColor: 255 },
      alternateRowStyles: { fillColor: ZEBRA() },
      margin: { left: 14, right: 14 },
    });
    y = doc.lastAutoTable.finalY + 6;

    if (y > doc.internal.pageSize.getHeight() - 30) {
      doc.addPage();
      decorate(doc, 'Asset Inventory Report', id, logo);
      y = CONTENT_TOP;
    }
  }

  // Signature block — this is a handover document as often as a report.
  if (y > doc.internal.pageSize.getHeight() - 40) {
    doc.addPage();
    decorate(doc, 'Asset Inventory Report', id, logo);
    y = CONTENT_TOP;
  }
  signatures(doc, y, 'Prepared by', 'Approved by');

  footer(doc);
  doc.save('asset_inventory_report.pdf');
}

/** Utilization summary. */
export async function exportInsightsPdf(insights) {
  const JsPDF = await jsPdf();
  const logo = await brandLogo();
  const doc = new JsPDF();
  const id = reportId();

  decorate(doc, 'Rental Insights Report', id, logo);

  doc.setFontSize(9);
  doc.text(
    `${formatDateTime(insights.rangeStart)} – ${formatDateTime(insights.rangeEnd)}`,
    14,
    CONTENT_TOP,
  );

  doc.autoTable({
    startY: CONTENT_TOP + 6,
    head: [['Metric', 'Value']],
    body: [
      ['Assets in scope', `${insights.totalAssets} (${insights.totalUnits} units)`],
      ['Units checked out now', `${insights.checkedOutNow} on ${insights.checkedOutLines} line(s)`],
      ['Overdue now', String(insights.overdueNow)],
      ['Average utilization', `${insights.avgUtil.toFixed(1)}%`],
    ],
    styles: { fontSize: 9 },
    headStyles: { fillColor: BRAND(), textColor: 255 },
    alternateRowStyles: { fillColor: ZEBRA() },
    margin: { left: 14, right: 14 },
  });

  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 6,
    head: [['Most used', 'Hours', 'Utilization']],
    body: insights.topUsed.map((row) => [
      row.assetName,
      row.hours.toFixed(1),
      `${row.utilPct.toFixed(1)}%`,
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: BRAND(), textColor: 255 },
    alternateRowStyles: { fillColor: ZEBRA() },
    margin: { left: 14, right: 14 },
  });

  if (insights.overdue.length) {
    doc.autoTable({
      startY: doc.lastAutoTable.finalY + 6,
      head: [['Overdue', 'Customer', 'Due', 'Days late']],
      body: insights.overdue.map((row) => [row.name, row.customer, row.due, String(row.daysLate)]),
      styles: { fontSize: 8 },
      // Overdue keeps its red head — that is a signal, not decoration.
      headStyles: { fillColor: [140, 30, 30], textColor: 255 },
      alternateRowStyles: { fillColor: ZEBRA() },
      margin: { left: 14, right: 14 },
    });
  }

  footer(doc);
  doc.save('rental_insights_report.pdf');
}

// --- Insurance schedule and selection value (INTERNAL, money on the page) ---
//
// Everything below this comment and above buildBookingDocument() is for the
// operator and the operator's insurer. It prints prices, and it must stay on
// this side of the file: the customer half further down is asserted to contain
// no money at all.

/**
 * Layout of a valued row, in mm.
 *
 * The photo column is a fixed box and every body row is at least
 * SCHEDULE_ROW_HEIGHT tall, so the thumbnails sit on one baseline down the page
 * instead of jumping with the length of each name. Serial and purchase date are
 * empty on most records here (1 of 28 and 15 of 28 on the live data), so they
 * get a FIXED width — a column that is blank on most rows must not be allowed
 * to collapse and drag the table's geometry around.
 */
const THUMB_COLUMN = 18;
const SCHEDULE_ROW_HEIGHT = 15;
const SCHEDULE_PAD = 1.4;
/** What an empty cell prints. Never `null`, never blank, never `undefined`. */
const DASH = '—';

/**
 * The category a record is filed under.
 *
 * The same key computeValue() uses, in one place, because both documents group
 * by it and their subtotals have to line up with the dashboard's. An empty
 * category is 'Uncategorised' — never blank, never a heading nobody can name.
 */
function categoryOf(asset) {
  return (asset && asset.category) || 'Uncategorised';
}

/**
 * Selected lines grouped into categories, each with its own subtotal.
 *
 * The subtotal is valueOfLines() over that category's lines — the same helper
 * that produces the grand total, so a group can never be worth something this
 * file worked out on its own. Ordering copies computeValue().byCategory: most
 * valuable first, ties broken by name.
 */
function linesByCategory(rows, lookup) {
  const groups = new Map();
  for (const row of rows) {
    const key = categoryOf(row.asset);
    const group = groups.get(key) || { category: key, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.value = valueOfLines(
      group.rows.map((row) => ({ id: row.asset.id, qty: row.qty })),
      lookup,
    );
  }
  return [...groups.values()].sort((a, b) => {
    const av = a.value.totals[0]?.amount || 0;
    const bv = b.value.totals[0]?.amount || 0;
    return bv - av || a.category.localeCompare(b.category);
  });
}

/**
 * One asset as a schedule row.
 *
 * The two money cells are NOT computed here: the unit price is priceOf() —
 * the stored field, or the unit sum divided by the count once an asset prices
 * its units — rendered with its own currency, and the line value comes back
 * from valueOfLines(), the same helper the basket and the dashboard use. An
 * unpriced asset falls out of it as an empty total bag, which formatTotals()
 * renders as a dash, so it appears in the document with no value rather than
 * disappearing from it.
 */
function scheduleRow(asset, lookup) {
  const units = unitsOf(asset);
  const unit = priceOf(asset);
  return [
    '', // the thumbnail is painted over this cell by didDrawCell
    String(asset.name || `#${asset.id}`),
    `#${asset.id}`,
    String(asset.serial ?? '').trim() || DASH,
    // The earliest of the units once they carry their own dates; already a
    // dash when there is no date at all.
    formatDate(purchasedAtOf(asset)),
    String(units),
    unit === null ? DASH : formatMoney(unit, currencyOf(asset)),
    formatTotals(valueOfLines([{ id: asset.id, qty: units }], lookup).totals),
  ];
}

/**
 * The insurance schedule: every asset, with its photo, grouped by category,
 * with a subtotal per category and a grand total.
 *
 * Written to be handed to an insurer, which sets the rules:
 *
 * - Every figure on it comes from computeValue()/valueOfLines(). This document
 *   does no arithmetic of its own, so it cannot disagree with the dashboard.
 * - Unpriced gear is LISTED, with a dash where its value would be, and counted
 *   in the disclosure under the total. It is still gear that would be claimed
 *   for; a schedule that quietly dropped it would understate the inventory
 *   without saying so.
 * - Kits are not rows. A kit is a label around items that are already listed,
 *   and one that carries a price of its own is named in the caveats, exactly as
 *   the dashboard names it.
 * - Money is per currency, always with its currency.
 */
export async function exportInsurancePdf(assets = [], checkouts = []) {
  const items = assets.filter((asset) => asset.kind === 'ITEM');
  const kits = assets.filter((asset) => asset.kind === 'SET');

  // Thumbnails, the fonts and the wordmark all at once: 28 fetches in series
  // would be a visibly slow button.
  const [JsPDF, logo, thumbs] = await Promise.all([
    jsPdf(),
    brandLogo(),
    loadThumbs(items.map((asset) => asset.photo)),
  ]);

  const doc = new JsPDF();
  const id = reportId();
  const title = 'Inventory Overview';
  const value = computeValue({ assets, checkouts });
  const lookup = new Map(assets.map((asset) => [Number(asset.id), asset]));
  const pricedTotal = formatTotals(value.totals);
  // Assets the schedule accounts for: priced ones plus the ones listed at zero.
  const covered = value.pricedAssets + value.unpricedCount;

  decorate(doc, title, id, logo);

  let y = CONTENT_TOP;
  doc.setFontSize(11);
  const [r, g, b] = BRAND();
  doc.setTextColor(r, g, b);
  doc.text(`Total value: ${pricedTotal}`, 14, y);
  doc.setTextColor(0, 0, 0);
  y += 5;

  doc.setFontSize(9);
  doc.text(
    `${covered} asset(s) · ${value.totalUnits} unit(s) · ${value.byCategory.length} categor`
    + `${value.byCategory.length === 1 ? 'y' : 'ies'} · valued ${formatDateTime(new Date())}`,
    14,
    y,
  );
  y += 5;

  // What the total does NOT cover travels with it, in the same grey the
  // inventory report uses. An insurer has to be able to see the gap.
  const caveats = [];
  caveats.push(
    value.unpricedCount
      ? `The total covers ${value.pricedAssets} of ${covered} asset(s). `
        + `${value.unpricedCount} asset(s), ${value.unpricedUnits} unit(s) have no price on record: `
        + `they are listed below in their category with ${DASH} for a value and are NOT in any total.`
      : `The total covers all ${covered} asset(s); every one has a price on record.`,
  );
  if (kits.length) {
    caveats.push(
      `${kits.length} kit(s) are not listed `
      + '',
    );
  }
  if (value.pricedSets.length) {
    const named = value.pricedSets.slice(0, CAVEAT_NAMES).map((set) => set.name);
    const extra = value.pricedSets.length - named.length;
    caveats.push(
      `${value.pricedSets.length} kit(s) carry a price of their own, excluded so their members `
      + `count once: ${named.join(', ')}${extra > 0 ? ` +${extra} more` : ''}`,
    );
  }

  doc.setFontSize(8);
  doc.setTextColor(110, 120, 140);
  const room = doc.internal.pageSize.getWidth() - 28;
  for (const caveat of caveats) {
    for (const line of doc.splitTextToSize(caveat, room)) {
      doc.text(line, 14, y);
      y += 3.6;
    }
  }
  doc.setTextColor(0, 0, 0);
  y += 4;

  // Grouped for the tables; the SUBTOTALS come from computeValue's own
  // per-category bags, so a category's figure is the dashboard's figure.
  const rowsByCategory = new Map();
  for (const asset of items) {
    const key = categoryOf(asset);
    if (!rowsByCategory.has(key)) rowsByCategory.set(key, []);
    rowsByCategory.get(key).push(asset);
  }

  for (const group of value.byCategory) {
    const assetsHere = rowsByCategory.get(group.category) || [];
    // Row order follows the table, so the drawing hook can index straight in.
    const drawn = assetsHere.map((asset) => thumbs.get(String(asset.photo ?? '').trim()) || null);

    doc.autoTable({
      startY: y,
      // The category names itself in the name column, the way the inventory
      // report does; the photo column's header stays blank.
      head: [['', group.category, 'ID', 'Serial', 'Purchased', 'Qty', 'Unit price', 'Value']],
      body: assetsHere.map((asset) => scheduleRow(asset, lookup)),
      // The label spans the photo and name columns and the unpriced count sits
      // in the serial column: in the name column alone a long category wraps
      // onto a second line and the subtotal stops reading as one row.
      foot: [[
        { content: `Subtotal · ${group.category}`, colSpan: 2 },
        '',
        group.unpricedCount ? `${group.unpricedCount} unpriced` : '',
        '',
        String(group.units),
        '',
        formatTotals(group.totals),
      ]],
      styles: { fontSize: 8, cellPadding: SCHEDULE_PAD, valign: 'middle' },
      bodyStyles: { minCellHeight: SCHEDULE_ROW_HEIGHT },
      headStyles: { fillColor: BRAND(), textColor: 255 },
      footStyles: { fillColor: [232, 236, 243], textColor: BRAND(), fontStyle: 'bold' },
      // Once, at the end of the category. autoTable repeats a foot on every
      // page by default, which would print the same subtotal twice for any
      // category that spans a page break and read like two of them.
      showFoot: 'lastPage',
      alternateRowStyles: { fillColor: ZEBRA() },
      columnStyles: {
        0: { cellWidth: THUMB_COLUMN },
        2: { cellWidth: 13 },
        // Wide enough for a full 20-character serial on one line, even though
        // only one asset in the live data has one — a serial that wraps is the
        // one field an insurer will misread.
        3: { cellWidth: 38 },
        4: { cellWidth: 21 },
        5: { cellWidth: 11, halign: 'right' },
        6: { cellWidth: 23, halign: 'right' },
        7: { cellWidth: 25, halign: 'right' },
      },
      margin: { left: 14, right: 14, top: CONTENT_TOP },
      // A category longer than a page keeps the header on the pages it spills on.
      didDrawPage: (data) => {
        if (data.pageNumber > 1) decorate(doc, title, id, logo);
      },
      // After the cell so the photo sits on top of the zebra fill, exactly like
      // the booking sheet's tick boxes.
      didDrawCell: (data) => {
        if (data.section !== 'body' || data.column.index !== 0) return;
        drawThumb(doc, data.cell, drawn[data.row.index], SCHEDULE_PAD);
      },
    });

    y = doc.lastAutoTable.finalY + 6;
    if (y > doc.internal.pageSize.getHeight() - 40) {
      doc.addPage();
      decorate(doc, title, id, logo);
      y = CONTENT_TOP;
    }
  }

  if (y > doc.internal.pageSize.getHeight() - 26) {
    doc.addPage();
    decorate(doc, title, id, logo);
    y = CONTENT_TOP;
  }

  doc.setDrawColor(r, g, b);
  doc.setLineWidth(0.4);
  doc.line(14, y, doc.internal.pageSize.getWidth() - 14, y);
  doc.setLineWidth(0.2);
  doc.setDrawColor(0, 0, 0);
  y += 6;

  doc.setFontSize(12);
  doc.setTextColor(r, g, b);
  doc.text(`Grand total: ${pricedTotal}`, 14, y);
  doc.setTextColor(0, 0, 0);
  y += 5;

  doc.setFontSize(8);
  doc.setTextColor(110, 120, 140);
  doc.text(
    `Sum of the category subtotals above. ${value.pricedAssets} of ${covered} asset(s) priced`
    + `${value.unpricedCount ? `; the other ${value.unpricedCount} asset(s) are listed with ${DASH}` : ''}.`
    + (value.currencies.length > 1 ? ' Currencies are never added together.' : ''),
    14,
    y,
  );
  doc.setTextColor(0, 0, 0);

  footer(doc);
  doc.save(`${slug(appName(), 'assets')}-inventory-overview-${dateStamp(new Date())}.pdf`);
}

/**
 * The current selection, by category, with what each one comes to.
 *
 * Internal and deliberately light — this is the operator eyeballing a sum, not
 * a document anybody is handed. `lines` is [{id, qty}], the shape the basket
 * already has (kits already expanded into members by the store).
 *
 * It groups the way the insurance schedule groups, through the same two
 * helpers: categoryOf() for the key, so an empty category reads 'Uncategorised'
 * on both documents, and linesByCategory() for the subtotals, which are
 * valueOfLines() over each category's own lines. The grand total is
 * valueOfLines() over the whole selection — one helper, so the parts and the
 * whole cannot drift.
 *
 * A selection of ONE category gets no subtotal row: it would be the grand
 * total printed twice, and a second authoritative-looking figure is exactly
 * what these documents are careful not to produce.
 */
export async function exportBasketPdf(lines = [], assets = []) {
  const lookup = assets instanceof Map
    ? assets
    : new Map((assets || []).map((asset) => [Number(asset.id), asset]));

  const rows = (lines || [])
    .map((line) => ({
      asset: lookup.get(Number(line?.id ?? line?.assetId)),
      qty: Math.max(1, Number(line?.qty) || 1),
    }))
    .filter((row) => row.asset);

  // No selection, no document. A blank page with a 0 on it is worse than the
  // button doing nothing; the drawer disables the button for the same reason.
  if (!rows.length) throw new Error('Nothing is selected.');

  const [JsPDF, logo, thumbs] = await Promise.all([
    jsPdf(),
    brandLogo(),
    loadThumbs(rows.map((row) => row.asset.photo)),
  ]);

  const doc = new JsPDF();
  const id = reportId();
  const title = 'Selection Value';
  // One call, one total — the same number the basket drawer is showing.
  const value = valueOfLines(lines, lookup);
  const groups = linesByCategory(rows, lookup);
  const grandTotal = formatTotals(value.totals);
  const [r, g, b] = BRAND();

  decorate(doc, title, id, logo);

  let y = CONTENT_TOP;
  for (const group of groups) {
    // Row order follows the table, so the drawing hook can index straight in.
    const drawn = group.rows.map((row) => thumbs.get(String(row.asset.photo ?? '').trim()) || null);

    doc.autoTable({
      startY: y,
      // The category names itself in the item column; the photo column's
      // header stays blank, exactly as on the schedule.
      head: [['', group.category, 'ID', 'Qty', 'Unit price', 'Value']],
      body: group.rows.map((row) => {
        // A kit's own price is never what is counted, so it is never shown as
        // a unit price either; the line's value is its members', via
        // valueOfLines().
        const unit = row.asset.kind === 'SET' ? null : priceOf(row.asset);
        return [
          '',
          String(row.asset.name || `#${row.asset.id}`)
          + (row.asset.kind === 'SET' ? '  (kit · valued as its members)' : ''),
          `#${row.asset.id}`,
          String(row.qty),
          unit === null ? DASH : formatMoney(unit, currencyOf(row.asset)),
          formatTotals(valueOfLines([{ id: row.asset.id, qty: row.qty }], lookup).totals),
        ];
      }),
      foot: groups.length > 1
        ? [[
          { content: `Subtotal · ${group.category}`, colSpan: 2 },
          '',
          String(group.value.units),
          group.value.unpricedCount ? `${group.value.unpricedCount} unpriced` : '',
          formatTotals(group.value.totals),
        ]]
        : [],
      styles: { fontSize: 9, cellPadding: SCHEDULE_PAD, valign: 'middle' },
      bodyStyles: { minCellHeight: SCHEDULE_ROW_HEIGHT },
      headStyles: { fillColor: BRAND(), textColor: 255 },
      footStyles: { fillColor: [232, 236, 243], textColor: BRAND(), fontStyle: 'bold' },
      // Once, at the end of the category — see the note on the schedule.
      showFoot: 'lastPage',
      alternateRowStyles: { fillColor: ZEBRA() },
      columnStyles: {
        0: { cellWidth: THUMB_COLUMN },
        2: { cellWidth: 16 },
        3: { cellWidth: 14, halign: 'right' },
        4: { cellWidth: 26, halign: 'right' },
        5: { cellWidth: 28, halign: 'right' },
      },
      margin: { left: 14, right: 14, top: CONTENT_TOP },
      didDrawPage: (data) => {
        if (data.pageNumber > 1) decorate(doc, title, id, logo);
      },
      didDrawCell: (data) => {
        if (data.section !== 'body' || data.column.index !== 0) return;
        drawThumb(doc, data.cell, drawn[data.row.index], SCHEDULE_PAD);
      },
    });

    y = doc.lastAutoTable.finalY + 6;
    if (y > doc.internal.pageSize.getHeight() - 34) {
      doc.addPage();
      decorate(doc, title, id, logo);
      y = CONTENT_TOP;
    }
  }

  if (y > doc.internal.pageSize.getHeight() - 26) {
    doc.addPage();
    decorate(doc, title, id, logo);
    y = CONTENT_TOP;
  }

  doc.setDrawColor(r, g, b);
  doc.setLineWidth(0.4);
  doc.line(14, y, doc.internal.pageSize.getWidth() - 14, y);
  doc.setLineWidth(0.2);
  doc.setDrawColor(0, 0, 0);
  y += 6;

  doc.setFontSize(12);
  doc.setTextColor(r, g, b);
  doc.text(`Grand total: ${grandTotal}`, 14, y);
  doc.setTextColor(0, 0, 0);
  y += 5;

  doc.setFontSize(9);
  doc.text(
    `${rows.length} line(s) · ${value.units} unit(s) · ${groups.length} categor`
    + `${groups.length === 1 ? 'y' : 'ies'}`,
    14,
    y,
  );
  y += 4;

  // Same honesty as the schedule: an unpriced line is in the list and in the
  // count, so the sum is never mistaken for the whole selection.
  if (value.unpricedCount) {
    doc.setFontSize(8);
    doc.setTextColor(110, 120, 140);
    const room = doc.internal.pageSize.getWidth() - 28;
    const names = value.unpriced.slice(0, CAVEAT_NAMES).map((row) => row.name);
    const extra = value.unpriced.length - names.length;
    const text = `${value.unpricedCount} line(s), ${value.unpricedUnits} unit(s) have no price and `
      + `are not in this total: ${names.join(', ')}${extra > 0 ? ` +${extra} more` : ''}`;
    for (const line of doc.splitTextToSize(text, room)) {
      doc.text(line, 14, y);
      y += 3.6;
    }
    doc.setTextColor(0, 0, 0);
  }

  footer(doc);
  doc.save(`${slug(appName(), 'assets')}-selection-${dateStamp(new Date())}.pdf`);
}

// --- Booking (one checkout group, or one reservation) ----------------------

function slug(value, fallback) {
  const out = String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || fallback;
}

function dateStamp(value) {
  const date = parseDate(value) || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Booking object -> everything the document needs, with no jsPDF in sight.
 *
 * Kept pure so the shaping (rows, totals, title, filename) is testable; the
 * drawing below is a thin layer on top. A `booking` is:
 *
 *   {
 *     kind: 'checkout' | 'reservation',
 *     customerName, customerEmail,
 *     startAt,          // checked out (checkout) / start (reservation)
 *     endAt,            // due back    (checkout) / end   (reservation)
 *     status, notes, reference,
 *     items: [{ name, assetId, qty, setId, setName }]
 *   }
 */
export function buildBookingDocument(booking = {}) {
  const kind = booking.kind === 'reservation' ? 'reservation' : 'checkout';
  const reservation = kind === 'reservation';
  const items = Array.isArray(booking.items) ? booking.items : [];

  // Per row: how many boxes to stroke, and what is left over above the cap.
  // Worked out here rather than in the drawing hook so it is testable and the
  // hook stays a pure translation of the model into ink.
  const ticks = [];
  const rows = items.map((item) => {
    const qty = Math.max(1, Math.floor(Number(item.qty)) || 1);
    const id = item.assetId ?? item.id;
    // A kit member says where it came from; a loose item leaves the cell empty.
    const kit = item.setName || (item.setId ? `Kit #${item.setId}` : '');
    ticks.push({ qty, boxes: Math.min(qty, TICK_CAP), extra: Math.max(0, qty - TICK_CAP) });
    return [
      // The tick column carries no text — the boxes are drawn over the cell.
      '',
      String(item.name || (id != null ? `#${id}` : '')),
      id == null || id === '' ? '' : `#${id}`,
      String(qty),
      String(kit),
    ];
  });

  const totalItems = rows.length;
  const totalUnits = rows.reduce((sum, row) => sum + Number(row[3]), 0);

  // One fixed width for the whole column so the boxes line up down the page,
  // wide enough for the busiest row rather than for every possible row.
  const maxBoxes = ticks.reduce((most, tick) => Math.max(most, tick.boxes), 1);
  const tickWidth = TICK_PAD * 2
    + maxBoxes * TICK_BOX
    + (maxBoxes - 1) * TICK_GAP
    + (ticks.some((tick) => tick.extra > 0) ? TICK_OVERFLOW : 0);

  const details = [
    ['Customer', String(booking.customerName || '').trim() || '—'],
    ['Email', String(booking.customerEmail || '').trim()],
    ['Reference', booking.reference == null ? '' : String(booking.reference)],
    [reservation ? 'Starts' : 'Checked out', formatDateTime(booking.startAt)],
    [reservation ? 'Ends' : 'Due back', formatDateTime(booking.endAt)],
    ['Status', String(booking.status || '').trim()],
    ['Notes', String(booking.notes || '').trim()],
  ].filter(([, value]) => value !== '');

  return {
    kind,
    title: reservation ? 'Reservation Confirmation' : 'Checkout Handover',
    // The leading blank column is the tick column; its header stays empty
    // because there is no printable glyph for a check mark in this encoding.
    head: ['', 'Item', 'ID', 'Qty', 'Kit'],
    details,
    rows,
    ticks,
    tickColumn: 0,
    tickWidth,
    totalItems,
    totalUnits,
    summary: `${totalItems} item(s) · ${totalUnits} unit(s)`,
    // Only a handover gets signed; a reservation is not a transfer of custody.
    signature: !reservation,
    filename: `${slug(appName(), 'assets')}-${kind}-${slug(booking.customerName, 'customer')}-${dateStamp(booking.startAt)}.pdf`,
  };
}

/**
 * Strokes one row's tick boxes over its cell in the tick column.
 *
 * Vector rectangles, not text: see the TICK_* notes. `doc.rect()` with no
 * style argument strokes, which is exactly the hairline outline wanted.
 */
function tickBoxes(doc, cell, tick) {
  const [r, g, b] = BRAND();
  doc.setDrawColor(r, g, b);
  doc.setLineWidth(0.25);

  const top = cell.y + (cell.height - TICK_BOX) / 2;
  let x = cell.x + TICK_PAD;
  for (let i = 0; i < tick.boxes; i++) {
    doc.rect(x, top, TICK_BOX, TICK_BOX);
    x += TICK_BOX + TICK_GAP;
  }
  // A capped row says how many units the one box stands for, so nobody packs
  // five of a line of thirty and calls it done.
  if (tick.extra > 0) {
    doc.setFontSize(7);
    doc.setTextColor(r, g, b);
    doc.text(`+${tick.extra}`, x, top + TICK_BOX - 0.4);
  }

  doc.setLineWidth(0.2);
  doc.setDrawColor(0, 0, 0);
  doc.setTextColor(0, 0, 0);
}

/** One checkout group or one reservation, as a handover document. */
export async function exportBookingPdf(booking) {
  const model = buildBookingDocument(booking);
  const JsPDF = await jsPdf();
  const logo = await brandLogo();
  const doc = new JsPDF();
  const id = reportId();
  const height = doc.internal.pageSize.getHeight();

  decorate(doc, model.title, id, logo);

  doc.autoTable({
    startY: CONTENT_TOP,
    body: model.details,
    theme: 'plain',
    styles: { fontSize: 9, cellPadding: 1.2 },
    columnStyles: { 0: { fontStyle: 'bold', textColor: BRAND(), cellWidth: 32 } },
    margin: { left: 14, right: 14 },
  });

  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 6,
    head: [model.head],
    body: model.rows,
    styles: { fontSize: 9, cellPadding: 1.8 },
    headStyles: { fillColor: BRAND(), textColor: 255 },
    alternateRowStyles: { fillColor: ZEBRA() },
    columnStyles: {
      [model.tickColumn]: { cellWidth: model.tickWidth },
      2: { cellWidth: 20 },
      3: { cellWidth: 16, halign: 'right' },
    },
    // A long booking spills over; those pages need the header too.
    margin: { left: 14, right: 14, top: CONTENT_TOP },
    didDrawPage: (data) => {
      if (data.pageNumber > 1) decorate(doc, model.title, id, logo);
    },
    // After the cell, so the boxes sit on top of the zebra fill.
    didDrawCell: (data) => {
      if (data.section !== 'body' || data.column.index !== model.tickColumn) return;
      const tick = model.ticks[data.row.index];
      if (tick) tickBoxes(doc, data.cell, tick);
    },
  });

  let y = doc.lastAutoTable.finalY + 7;
  doc.setFontSize(9);
  doc.text(model.summary, 14, y);
  y += 4;

  if (model.signature) {
    // Two rules now, so the taller block needs more room left on the page than
    // the old single pair did.
    if (y > height - 58) {
      doc.addPage();
      decorate(doc, model.title, id, logo);
      y = CONTENT_TOP;
    }
    signatures(doc, y, 'Handed over by', 'Received by');
    // The ticked boxes above are only a packing record if someone owns them.
    signatures(doc, y + 18, 'Packed by', 'Checked by');
  }

  footer(doc);
  doc.save(model.filename);
}
