<?php
/**
 * Public read-only inventory board.
 *
 * Reads through public.php, which exposes an allow-list of safe fields. It
 * previously fetched data.json directly, which meant that file had to be
 * web-readable — and with it every reservation and customer email address.
 *
 * The five-column table this used to draw could not fit a 320px screen without
 * scrolling sideways, so it is a list of cards: name and state on one line,
 * everything else under it.
 *
 * The rows arrive from public.php over fetch(); the only thing PHP renders here
 * is the branding, read from settings the same way index.php reads it so the
 * two public pages cannot drift apart.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/store.php';

// The public board is for people with the link, not for search engines.
header('X-Robots-Tag: noindex, nofollow');

$appName    = (string)trax_setting('branding.appName', 'Assets');
$brandColor = (string)trax_setting('branding.brandColor', '#1F2937');
$favicon    = (string)trax_setting('branding.faviconFile', '');

/** Short-hand for the escaping this file does on every interpolation. */
function pub_e(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no">
    <title><?php echo pub_e($appName); ?> – Inventory</title>
    <meta name="theme-color" content="<?php echo pub_e($brandColor); ?>">
    <meta name="robots" content="noindex, nofollow">
<?php if ($favicon !== ''): ?>
    <link rel="icon" type="image/png" href="<?php echo pub_e($favicon); ?>">
<?php endif; ?>

    <!-- Vendored, not CDN: the folder must work as uploaded. public.css is the
         shared public-page stylesheet and carries the iOS 16px focus-zoom fix
         the search box needs. -->
    <link rel="stylesheet" href="public.css">
    <link rel="stylesheet" href="vendor/bootstrap-icons.css">
    <style>:root{--trax-brand:<?php echo pub_e($brandColor); ?>;}</style>
</head>
<body class="pub-page">

<header class="pub-top">
    <div class="pub-top-inner pub-main-wide">
<?php if ($favicon !== ''): ?>
        <img class="pub-mark" src="<?php echo pub_e($favicon); ?>" alt="" width="26" height="26">
<?php endif; ?>
        <span class="pub-wordmark"><?php echo pub_e($appName); ?></span>
        <span class="pub-top-tag">Inventory</span>
    </div>
</header>

<main class="pub-main pub-main-wide">
    <div class="pub-board-head">
        <h1 class="pub-board-title">Inventory</h1>
        <span class="pub-count" id="summary">Loading…</span>
    </div>

    <div class="pub-search">
        <label class="pub-sr" for="q">Search inventory</label>
        <i class="bi bi-search pub-search-icon" aria-hidden="true"></i>
        <input id="q" class="pub-input" type="search" placeholder="Search name, category or ID…"
               autocomplete="off" autocapitalize="none" spellcheck="false">
    </div>

    <!-- Honest loading state: three placeholder rows, replaced on the first
         answer by the list, an empty state or an error. -->
    <div id="rows" aria-live="polite">
        <div class="pub-list">
            <div class="pub-skeleton-row"></div>
            <div class="pub-skeleton-row"></div>
            <div class="pub-skeleton-row"></div>
        </div>
    </div>
</main>

<footer class="pub-foot">Live view · refreshes every 30 seconds.</footer>

<script>
const STATUS_TEXT = {
  FREE: 'Available', RSVD: 'Reserved', UNAV: 'In use',
  LOCK: 'Blocked', PARTIAL: 'Incomplete'
};

let assets = null;   // null until the first answer, so "empty" is not claimed early

function esc(value){
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function empty(text){
  return `<p class="pub-empty">${esc(text)}</p>`;
}

function render(){
  const box = document.getElementById('rows');
  const summary = document.getElementById('summary');
  if (assets === null) return;               // the skeleton stays put

  const query = document.getElementById('q').value.trim().toLowerCase();
  const rows = assets
    .filter(a => !query || `${a.id} ${a.name} ${a.category} ${a.notes}`.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!assets.length) {
    box.innerHTML = empty('Nothing is registered yet.');
  } else if (!rows.length) {
    box.innerHTML = empty(`Nothing matches “${query}”.`);
  } else {
    box.innerHTML = '<ul class="pub-list">' + rows.map(a => {
      const meta = [
        `<span>ID <span class="pub-id">${esc(a.id)}</span></span>`,
        a.category ? `<span>${esc(a.category)}</span>` : '',
        a.kind === 'SET' ? '<span class="pub-chip">Kit</span>' : ''
      ].join('');

      const notes = a.notes
        ? `<p class="pub-item-notes">${esc(a.notes)}</p>`
        : '';

      return `
        <li class="pub-item">
          <div class="pub-item-head">
            <h2 class="pub-item-name">${esc(a.name)}</h2>
            <span class="pub-status status-${esc(a.status)}">
              <span class="pub-status-dot" aria-hidden="true"></span>
              ${esc(STATUS_TEXT[a.status] || a.status)}
            </span>
          </div>
          <p class="pub-item-meta">${meta}</p>
          ${notes}
        </li>`;
    }).join('') + '</ul>';
  }

  const free = assets.filter(a => a.status === 'FREE').length;
  summary.textContent = query
    ? `${rows.length} of ${assets.length} shown`
    : `${assets.length} items · ${free} available`;
}

async function load(){
  try{
    const res = await fetch('public.php?list=1&_t=' + Date.now());
    const body = await res.json();
    if (body.ok) { assets = body.data; render(); }
  }catch(err){
    console.error('Failed to load inventory', err);
    // Only claim a problem when there is nothing on screen to keep; a failed
    // refresh should leave the last good list alone.
    if (assets === null) {
      document.getElementById('rows').innerHTML = empty('Could not reach the server. Retrying shortly.');
      document.getElementById('summary').textContent = 'Offline';
    }
  }
}

document.getElementById('q').addEventListener('input', render);
load();
setInterval(load, 30000);
</script>
</body>
</html>
