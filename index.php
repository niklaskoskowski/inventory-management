<?php
/**
 * Public asset page — the target of every printed QR label (/r/?id=N).
 *
 * Unauthenticated by design, so it must never expose customer data. Asset
 * lookup goes through public.php, which returns an explicit allow-list of
 * fields; the previous `?api=` proxy here streamed data.json and
 * checkout.json verbatim to anyone who asked.
 *
 * Whoever opens this is holding the item, or looking for it. The page is built
 * around that: what the thing is, what state it is in, and how to reach the
 * owner — in that order, with the recovery block server-rendered so it is on
 * screen before public.php has answered.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/store.php';
require_once __DIR__ . '/lib/mailer.php';

$id    = filter_input(INPUT_GET, 'id', FILTER_VALIDATE_INT) ?: null;
$asset = null;

/**
 * Short label URLs (/3) reach this file as ?id=3 through the .htaccess rewrite.
 * Read the id off the path as well, so the page still resolves where the
 * rewrite hands the path through instead (index.php/3). ?id= is checked first
 * and stays unconditional: every label ever printed carries that form.
 */
if ($id === null) {
    $requestPath = (string)($_SERVER['PATH_INFO'] ?? '');
    if ($requestPath === '') {
        $requestPath = (string)(parse_url((string)($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH) ?: '');
    }
    if (preg_match('#/(\d+)/?$#', $requestPath, $m)) {
        $id = (int)$m[1] ?: null;
    }
}

if ($id !== null) {
    $data  = trax_read_data();
    $asset = trax_find_asset($data['assets'], $id);
}

// --- Lost item report ---
$reportSuccess = null;
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['reportName'])) {
    $reportSuccess = trax_mail_lost_report(
        $asset,
        trax_str($_POST['reportName'] ?? '', 200),
        trax_str($_POST['reportPhone'] ?? '', 60),
        trax_str($_POST['reportEmail'] ?? '', 200),
        trax_str($_POST['reportMessage'] ?? '', 4000)
    );
}

/**
 * Branding — all of it from settings.branding, none of it hardcoded here.
 *
 * The org name is what a finder reads on this page ("Property of X"), and it is
 * allowed to be empty: an install that has not named an organisation shows the
 * app name instead of an invented one.
 *
 * The WhatsApp number is read WITHOUT a fallback literal on purpose: the
 * normaliser already fills a missing key with TRAX_WHATSAPP, so anything empty
 * at this point is either an unconfigured install or an operator who cleared
 * the field, and the button is left out rather than pointed at nobody. What
 * reaches the href is digits only — see trax_whatsapp_digits().
 *
 * The favicon is likewise optional: trax_logo_file() has already checked that
 * the file exists, so '' here means "emit no icon link" rather than a 404.
 */
$appName    = (string)trax_setting('branding.appName', 'Assets');
$ownerName  = (string)trax_setting('branding.orgName', '') ?: $appName;
$brandColor = (string)trax_setting('branding.brandColor', '#1F2937');
$whatsapp   = trax_whatsapp_digits(trax_setting('branding.whatsapp', ''));
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
  <title><?php echo pub_e($asset['name'] ?? ($appName . ' • Asset')); ?></title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no">
  <meta name="theme-color" content="<?php echo pub_e($brandColor); ?>">
  <meta name="robots" content="noindex">
<?php if ($favicon !== ''): ?>
  <link rel="icon" type="image/png" href="<?php echo pub_e($favicon); ?>">
<?php endif; ?>

  <!-- Vendored, not CDN: the folder must work as uploaded. This replaced
       cdn.tailwindcss.com and the Manrope webfont; public.css is self-contained
       and sets a system font stack. The iOS 16px focus-zoom fix lives there. -->
  <link rel="stylesheet" href="public.css">
  <link rel="stylesheet" href="vendor/bootstrap-icons.css">
  <style>:root{--trax-brand:<?php echo pub_e($brandColor); ?>;}</style>
</head>
<body class="pub-page">

<header class="pub-top">
  <div class="pub-top-inner">
<?php if ($favicon !== ''): ?>
    <img class="pub-mark" src="<?php echo pub_e($favicon); ?>" alt="" width="26" height="26">
<?php endif; ?>
    <span class="pub-wordmark"><?php echo pub_e($appName); ?></span>
    <span class="pub-top-tag">Asset tag</span>
  </div>
</header>

<main class="pub-main">
  <?php if ($reportSuccess === true): ?>
    <div class="pub-flash pub-flash-ok" role="status">
      <i class="bi bi-check2-circle" aria-hidden="true"></i>
      <span>Thank you — your report has been sent to the owner.</span>
    </div>
  <?php elseif ($reportSuccess === false): ?>
    <div class="pub-flash pub-flash-bad" role="alert">
      <i class="bi bi-exclamation-triangle" aria-hidden="true"></i>
      <span>The report could not be sent.
        <?php echo $whatsapp !== '' ? 'Please try WhatsApp instead.' : 'Please try again in a moment.'; ?></span>
    </div>
  <?php endif; ?>

  <?php if (!$id || !$asset): ?>
    <section class="pub-card">
      <h1 class="pub-heading">
        <?php echo $id ? 'No asset with that ID' : 'Look up an asset'; ?>
      </h1>
      <p class="pub-lead">
        <?php echo $id
            ? 'Nothing in the register carries that number. Check the number printed under the code.'
            : 'Enter the number printed on the label to see what the item is and how to reach its owner.'; ?>
      </p>
      <form method="GET" action="">
        <label class="pub-field">
          <span class="pub-label">Asset ID</span>
          <input class="pub-input" type="text" name="id" inputmode="numeric"
                 placeholder="e.g. 3" autocomplete="off" required>
        </label>
        <button class="pub-btn pub-btn-ghost" type="submit">
          <i class="bi bi-search" aria-hidden="true"></i> Look up
        </button>
      </form>
    </section>
  <?php else: ?>
    <!-- Server-rendered identity, so the item names itself on first paint. The
         live status is fetched below and replaces this whole card. -->
    <div id="assetDataContainer">
      <article class="pub-card">
        <p class="pub-eyebrow">Asset</p>
        <h1 class="pub-title"><?php echo pub_e((string)$asset['name']); ?></h1>
        <p class="pub-sub">
          <span>ID <span class="pub-id"><?php echo pub_e((string)$id); ?></span></span>
        </p>
        <p class="pub-note" id="assetNote" aria-live="polite">Checking current status…</p>
      </article>
    </div>

    <section class="pub-found">
      <h2 class="pub-found-title">Found this item?</h2>
      <p class="pub-found-text">
<?php if ($whatsapp !== ''): ?>
        Thank you for picking it up. Either message the owner directly, or leave
        your details and they will come back to you.
<?php else: ?>
        Thank you for picking it up. Leave your details and the owner will come
        back to you.
<?php endif; ?>
      </p>
      <!-- No number configured, no button: a dead deep link on a lost-item page
           is worse than not offering that route at all, and the report form
           below stands on its own. The tags sit flush left so the markup they
           guard is emitted exactly as it was when it was unconditional. -->
      <div class="pub-actions">
<?php if ($whatsapp !== ''): ?>
        <a class="pub-btn pub-btn-primary" href="https://wa.me/<?php echo pub_e($whatsapp); ?>">
          <i class="bi bi-whatsapp" aria-hidden="true"></i> Message on WhatsApp
        </a>
<?php endif; ?>
        <button class="pub-btn pub-btn-ghost" type="button" id="lostContactOpen">
          <i class="bi bi-envelope" aria-hidden="true"></i> Report it found
        </button>
      </div>
    </section>
  <?php endif; ?>
</main>

<footer class="pub-foot">
  Property of <strong><?php echo pub_e($ownerName); ?></strong>
</footer>

<dialog id="lostContactModal" class="pub-modal" aria-labelledby="lostContactTitle">
  <form method="post" action="" id="lostContactForm">
    <div class="pub-modal-head">
      <h2 class="pub-modal-title" id="lostContactTitle">Report this item found</h2>
      <button type="button" class="pub-icon-btn" id="lostContactClose" aria-label="Close">
        <i class="bi bi-x-lg" aria-hidden="true"></i>
      </button>
    </div>
    <div class="pub-modal-body">
      <label class="pub-field">
        <span class="pub-label">Your name</span>
        <input class="pub-input" type="text" name="reportName" autocomplete="name" required>
      </label>
      <label class="pub-field">
        <span class="pub-label">Phone</span>
        <input class="pub-input" type="tel" name="reportPhone" autocomplete="tel" required>
      </label>
      <label class="pub-field">
        <span class="pub-label">Email <span class="pub-optional">(optional)</span></span>
        <input class="pub-input" type="email" name="reportEmail" autocomplete="email">
      </label>
      <label class="pub-field">
        <span class="pub-label">Where is it?</span>
        <textarea class="pub-input" name="reportMessage" rows="4" required
                  placeholder="e.g. Found on the train from Cologne, I can drop it off."></textarea>
      </label>
    </div>
    <div class="pub-modal-foot">
      <button type="button" class="pub-btn pub-btn-quiet" id="lostContactCancel">Cancel</button>
      <button type="submit" class="pub-btn pub-btn-ghost">Send report</button>
    </div>
  </form>
</dialog>

<script>
// Empty unless an asset actually resolved, so the lookup and not-found pages
// do not start a 90-second poll against a container that is not there.
const id = "<?php echo $asset ? pub_e((string)$id) : ''; ?>";

/**
 * Asset name and notes are operator-entered text. The old code interpolated
 * them straight into innerHTML, which made any asset name a stored-XSS
 * payload on this public page.
 */
function esc(value){
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

const STATUS_TEXT = {
  FREE:'Available',
  RSVD:'Reserved',
  UNAV:'In use',
  PARTIAL:'Incomplete',
  LOCK:'Blocked'
};

const modal = document.getElementById('lostContactModal');
for (const trigger of ['lostContactClose', 'lostContactCancel']) {
  const button = document.getElementById(trigger);
  if (button) button.addEventListener('click', () => modal.close());
}
const opener = document.getElementById('lostContactOpen');
if (opener) opener.addEventListener('click', () => modal.showModal());

/** Leaves the identity card standing and only rewrites the status line. */
function setNote(text){
  const note = document.getElementById('assetNote');
  if (note) note.textContent = text;
}

async function loadAssetData(){
  if(!id) return;
  const cont = document.getElementById('assetDataContainer');
  if(!cont) return;
  try{
    const res = await fetch('public.php?id='+encodeURIComponent(id)+'&_t='+Date.now());
    const body = await res.json();

    if(!body.ok || !body.data){
      setNote('This ID is not in the register.');
      return;
    }

    const asset = body.data;

    // Deliberately no customer name, email or return date: this page is
    // reachable by whoever finds the item.
    const outNote = asset.isOut
      ? '<p class="pub-status-note">This item is signed out at the moment. If you have found it, it is being missed.</p>'
      : '';

    const notes = asset.notes
      ? `<div class="pub-notes">
           <p class="pub-label">Notes</p>
           <div class="pub-notes-body">${esc(asset.notes)}</div>
         </div>`
      : '';

    const meta = [
      `<span>ID <span class="pub-id">${esc(asset.id)}</span></span>`,
      asset.category ? `<span>${esc(asset.category)}</span>` : '',
      asset.kind === 'SET' ? '<span class="pub-chip">Kit</span>' : ''
    ].join('');

    cont.innerHTML = `
      <article class="pub-card">
        <p class="pub-eyebrow">Asset</p>
        <h1 class="pub-title">${esc(asset.name)}</h1>
        <p class="pub-sub">${meta}</p>
        <p class="pub-sr">Status</p>
        <span class="pub-status status-${esc(asset.status)}">
          <span class="pub-status-dot" aria-hidden="true"></span>
          ${esc(STATUS_TEXT[asset.status] || asset.status)}
        </span>
        ${outNote}
        ${notes}
        <p class="pub-note" id="assetNote" aria-live="polite"></p>
      </article>`;
  }catch(err){
    console.error('Fetch failed', err);
    setNote('Offline — showing what was on the label. Retrying shortly.');
  }
}
if(id){loadAssetData();setInterval(loadAssetData,90000);}
</script>
</body>
</html>
