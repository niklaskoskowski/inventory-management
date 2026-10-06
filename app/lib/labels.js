import { buildZip } from './zip.js';

/**
 * Label files: their URLs, their names, and packing many of them into one ZIP.
 *
 * One place for the names so a single download, a shelf of unit labels and
 * the whole inventory all call the same label the same thing. The ID goes
 * last — `label-12.png`, `label-wide-12.1.png` — so a folder of them sorts by
 * format first and reads the asset off the end.
 */

/** `12`, or `12.1` for a unit. */
export function labelCode(assetId, unitNo = null) {
  return unitNo ? `${assetId}.${unitNo}` : String(assetId);
}

/**
 * The three formats of one label: [{format, name, url}], always in this order —
 * portrait (14 x 30 mm), wide (30 x 14 mm) and the cable flag (90 x 14 mm:
 * front, 30 mm round the cable, back).
 */
export function labelFiles(assetId, unitNo = null) {
  const code = labelCode(assetId, unitNo);
  const query = `id=${assetId}${unitNo ? `&u=${unitNo}` : ''}`;
  return [
    { format: 'portrait', name: `label-${code}.png`, url: `label.php?${query}` },
    { format: 'wide', name: `label-wide-${code}.png`, url: `label-w.php?${query}` },
    { format: 'cable', name: `label-cable-${code}.png`, url: `label-c.php?${query}` },
  ];
}

/**
 * Every label an asset has, as items: the asset's own and one per unit, each
 * with whether it is already on the gear (`labeled`).
 */
export function assetLabelItems(asset) {
  return [null, ...(asset.units || [])].map((unit) => ({
    assetId: asset.id,
    unitNo: unit?.no ?? null,
    code: labelCode(asset.id, unit?.no ?? null),
    title: unit?.label ? `${asset.name} – ${unit.label}` : asset.name,
    labeled: Boolean(unit ? unit.labeled : asset.labeled),
  }));
}

/**
 * A short key that changes only when what is printed on a label can: the
 * asset's name and notes, the unit's label, the branding and the cable gap.
 * The label endpoints ignore it (`&v=`); it is there so a preview <img> is
 * fetched again after such a change, and not after every other save — a
 * Labeled tick would otherwise re-render every tile on the page.
 */
export function labelVersion(asset, unitNo = null, settings = {}) {
  const unit = unitNo ? (asset?.units || []).find((entry) => entry.no === unitNo) : null;
  const branding = settings?.branding || {};
  const text = JSON.stringify([
    asset?.name, asset?.notes, unit?.label,
    branding.labelHeading, branding.orgName, branding.appName, branding.logoFile, branding.publicPath,
    settings?.labels?.cableGapMm, settings?.label?.renderScale,
  ]);
  // FNV-1a: short, stable, good enough to tell two versions apart.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// Same-origin, so the session cookie rides along and the PNG comes back
// rendered for this asset. The bytes go into the archive as they are.
async function labelBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * How many labels render at once. Every one is a GD render on the server, and
 * a whole inventory is hundreds of them: all at once would queue them behind
 * each other on a shared host anyway, one by one is a visibly slow button.
 */
const PARALLEL = 6;

/**
 * Fetches `files` and saves them as one ZIP called `filename`.
 *
 * One archive rather than one download per PNG because a browser blocks or
 * prompts on the second programmatic download onwards. `onProgress(done,
 * total)` is called as labels arrive, for a button that says how far it is.
 */
export async function downloadLabelZip(files, filename, onProgress = () => {}) {
  const entries = new Array(files.length);
  let next = 0;
  let done = 0;
  onProgress(0, files.length);

  const worker = async () => {
    while (next < files.length) {
      const index = next;
      next += 1;
      entries[index] = { name: files[index].name, data: await labelBytes(files[index].url) };
      done += 1;
      onProgress(done, files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, files.length) }, worker));

  saveBlob(buildZip(entries), filename);
}

// A Blob has no address a download attribute can point at, so it gets a
// temporary one. Revoked afterwards, or the bytes stay pinned for the life of
// the document.
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
