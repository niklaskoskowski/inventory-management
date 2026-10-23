<?php
/**
 * Sign a hand-over on a phone.
 *
 *   GET  sign.php?t=<token>              the page: booking, terms tick, pad
 *   POST sign.php?t=<token>&op=strokes   JSON {strokes, aspect} — the live drawing
 *   POST sign.php?t=<token>&op=submit    multipart: the PNG and the tick — stores it
 *
 * Reached by scanning the QR code the signature dialog shows on a desktop
 * (lib/signing.php). No login: the token is the key, it names one booking and
 * expires. The customer sees who the booking is for and what goes out, ticks
 * the terms / privacy notice themselves, and signs; the strokes reach the
 * desktop while they draw, and "Sign" stores the signature on the booking
 * through the same rule the counter uses (trax_booking_store_signature()).
 *
 * Like the other public pages it does NOT load lib/auth.php — an external
 * auth include would otherwise gate the customer's own phone.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/store.php';
require_once __DIR__ . '/lib/photo.php';
require_once __DIR__ . '/lib/signing.php';

header('X-Robots-Tag: noindex, nofollow');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('Cache-Control: no-store');

$token   = trax_sign_token($_GET['t'] ?? null);
$session = trax_sign_session($token);
$op      = (string)($_GET['op'] ?? '');

/** JSON out and stop. */
function sign_json(array $body, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

// --- Writes ------------------------------------------------------------------
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    // Same-origin only: the token is the secret, but a write should still
    // come from this page and not from a form on another site.
    $origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
    $host   = (string)($_SERVER['HTTP_HOST'] ?? '');
    if ($origin !== '' && parse_url($origin, PHP_URL_HOST) . (parse_url($origin, PHP_URL_PORT) ? ':' . parse_url($origin, PHP_URL_PORT) : '') !== $host) {
        sign_json(['ok' => false, 'error' => 'Wrong origin.'], 403);
    }
    if ($session === null || !in_array($session['status'], ['open', 'signing'], true)) {
        sign_json(['ok' => false, 'gone' => true, 'error' => 'This signing link has expired.'], 410);
    }

    if ($op === 'strokes') {
        $raw  = file_get_contents('php://input', false, null, 0, 400000) ?: '';
        $body = json_decode($raw, true);
        if (!is_array($body)) {
            sign_json(['ok' => false, 'error' => 'Bad request.'], 400);
        }
        $ok = trax_sign_session_strokes($token, $body['strokes'] ?? [], $body['aspect'] ?? null);
        sign_json(['ok' => $ok]);
    }

    if ($op === 'submit') {
        $entries = isset($_FILES['photos']) ? trax_photo_batch_entries($_FILES['photos']) : [];
        if (count($entries) !== 1) {
            sign_json(['ok' => false, 'error' => 'No signature was sent.'], 400);
        }
        $name           = trax_str($_POST['signedName'] ?? '', TRAX_MAX_NAME);
        $accept         = ($_POST['acceptTerms'] ?? '') === '1';
        $termsVersion   = trax_int($_POST['termsVersion'] ?? null);
        $privacyVersion = trax_int($_POST['privacyVersion'] ?? null);
        $bookingId      = (int)$session['bookingId'];
        $actor          = (string)$session['actor'];

        $file = trax_new_signature_name();
        try {
            trax_store_photo_as($file, $entries[0]);
            $result = trax_mutate(null, static function (array &$data, array &$checkouts) use (
                $bookingId, $name, $file, $actor, $accept, $termsVersion, $privacyVersion
            ): array {
                return trax_booking_store_signature(
                    $data, $bookingId, $name, $file, $actor, 'CUSTOMER', $accept, $termsVersion, $privacyVersion
                );
            });
        } catch (TraxInvalid $e) {
            trax_delete_photo_files($file);
            sign_json(['ok' => false, 'error' => $e->getMessage()], 400);
        } catch (Throwable $e) {
            trax_delete_photo_files($file);
            error_log('[app] sign.php submit failed: ' . $e->getMessage());
            sign_json(['ok' => false, 'error' => 'The signature could not be stored. Please try again.'], 500);
        }

        $replaced = $result['result']['replaced'] ?? null;
        if (is_string($replaced) && $replaced !== '' && $replaced !== $file) {
            trax_delete_photo_files($replaced);
        }
        trax_sign_session_finish($token, 'done');
        sign_json(['ok' => true]);
    }

    sign_json(['ok' => false, 'error' => 'Unknown request.'], 400);
}

// --- The page ----------------------------------------------------------------
$appName    = (string)trax_setting('branding.appName', 'Assets');
$brandColor = (string)trax_setting('branding.brandColor', '#1F2937');
$favicon    = (string)trax_setting('branding.faviconFile', '');

$de = str_starts_with(strtolower((string)($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? '')), 'de');
$t  = $de ? [
    'title' => 'Übergabe unterschreiben', 'for' => 'Ausleihe für', 'items' => 'Artikel',
    'name' => 'Name', 'sign' => 'Unterschrift', 'tap' => 'Zum Unterschreiben tippen', 'here' => 'Hier unterschreiben',
    'clear' => 'Löschen', 'done' => 'Fertig', 'submit' => 'Unterschreiben', 'accept' => 'Ich akzeptiere die',
    'terms' => 'AGB', 'and' => 'und habe die', 'read' => 'gelesen', 'privacy' => 'Datenschutzhinweise',
    'ihave' => 'Ich habe die', 'confirm' => 'Bestätigt den Empfang der aufgeführten Artikel.',
    'thanks' => 'Danke — unterschrieben.', 'close' => 'Diese Seite kann geschlossen werden.',
    'gone' => 'Dieser Link ist abgelaufen.', 'goneHint' => 'Bitte am Tresen einen neuen QR-Code anzeigen lassen.',
    'needSign' => 'Bitte zuerst unterschreiben.', 'needTick' => 'Bitte zuerst den Haken setzen.',
    'turn' => 'Handy quer halten',
] : [
    'title' => 'Sign the hand-over', 'for' => 'Booking for', 'items' => 'Items',
    'name' => 'Name', 'sign' => 'Signature', 'tap' => 'Tap to sign', 'here' => 'Sign here',
    'clear' => 'Clear', 'done' => 'Done', 'submit' => 'Sign', 'accept' => 'I accept the',
    'terms' => 'terms & conditions', 'and' => 'and have read the', 'read' => '', 'privacy' => 'privacy notice',
    'ihave' => 'I have read the', 'confirm' => 'Confirms receipt of the items listed.',
    'thanks' => 'Thank you — signed.', 'close' => 'You can close this page now.',
    'gone' => 'This link has expired.', 'goneHint' => 'Ask at the counter for a new QR code.',
    'needSign' => 'Please sign first.', 'needTick' => 'Please tick the box first.',
    'turn' => 'Turn your phone sideways',
];

// A link that was used, or called off at the counter, takes no more writes:
// used, it says so; cancelled, it reads like an expired one.
$alreadySigned = $session !== null && $session['status'] === 'done';
if ($session !== null && !in_array($session['status'], ['open', 'signing'], true)) {
    $session = null;
}

$data    = $session === null ? null : trax_read_data();
$booking = $data === null ? null : trax_find_booking($data['bookings'] ?? [], (int)$session['bookingId']);
if ($booking === null) {
    $session = null;
}

$items = [];
if ($booking !== null) {
    foreach ($booking['items'] as $line) {
        $asset   = trax_find_asset($data['assets'] ?? [], (int)$line['assetId']);
        $items[] = [
            'name' => $line['name'] !== '' ? $line['name'] : (string)($asset['name'] ?? ('#' . $line['assetId'])),
            'qty'  => max(1, (int)$line['qty']),
        ];
    }
}
$terms   = $data === null ? null : trax_legal_current($data, 'terms');
$privacy = $data === null ? null : trax_legal_current($data, 'privacy');
$lang    = $de ? 'de' : 'en';

if ($session === null && !$alreadySigned) {
    http_response_code(410);
}

function sign_e(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}
?>
<!DOCTYPE html>
<html lang="<?php echo $lang; ?>">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no, viewport-fit=cover">
    <meta name="color-scheme" content="light dark">
    <meta name="robots" content="noindex, nofollow">
    <title><?php echo sign_e($t['title']); ?> · <?php echo sign_e($appName); ?></title>
<?php if ($favicon !== ''): ?>
    <link rel="icon" type="image/png" href="<?php echo sign_e($favicon); ?>">
<?php endif; ?>
    <link rel="stylesheet" href="<?php echo trax_public_css(); ?>">
    <link rel="stylesheet" href="vendor/bootstrap-icons.css">
    <style>:root{--trax-brand:<?php echo sign_e($brandColor); ?>;}</style>
    <?php echo trax_accent_style_tags(); ?>
</head>
<body class="pub-page">

<header class="pub-bar">
    <div class="pub-bar-inner">
        <?php echo trax_brand_header_html($appName, $favicon !== ''
            ? '<img class="pub-mark" src="' . sign_e($favicon) . '" alt="" width="26" height="26">'
            : ''); ?>
    </div>
</header>

<main class="pub-main">
<?php if ($alreadySigned): ?>
    <section class="pub-card sign-done">
        <i class="bi bi-check-circle-fill" aria-hidden="true"></i>
        <h1 class="pub-title"><?php echo sign_e($t['thanks']); ?></h1>
        <p class="pub-hint"><?php echo sign_e($t['close']); ?></p>
    </section>
<?php elseif ($session === null): ?>
    <p class="pub-empty">
        <i class="bi bi-clock-history" aria-hidden="true"></i>
        <?php echo sign_e($t['gone']); ?><br>
        <span class="pub-hint"><?php echo sign_e($t['goneHint']); ?></span>
    </p>
<?php else: ?>
    <section class="pub-card" id="sign-form">
        <h1 class="pub-title"><?php echo sign_e($t['title']); ?></h1>
        <p class="pub-sub"><span><?php echo sign_e($t['for']); ?> <?php echo sign_e((string)$booking['customerName']); ?></span></p>

        <ul class="sign-items" aria-label="<?php echo sign_e($t['items']); ?>">
        <?php foreach ($items as $item): ?>
            <li><span><?php echo sign_e($item['name']); ?></span><span>×<?php echo (int)$item['qty']; ?></span></li>
        <?php endforeach; ?>
        </ul>

        <label class="pub-field">
            <span class="pub-fieldlabel"><?php echo sign_e($t['name']); ?></span>
            <input class="pub-input" type="text" id="sign-name" maxlength="200" autocomplete="name"
                   value="<?php echo sign_e((string)$booking['customerName']); ?>">
        </label>

        <span class="pub-fieldlabel"><?php echo sign_e($t['sign']); ?></span>
        <button type="button" class="sign-field" id="sign-field">
            <canvas id="sign-preview" aria-hidden="true"></canvas>
            <span class="sign-hint" id="sign-hint"><i class="bi bi-pen" aria-hidden="true"></i> <?php echo sign_e($t['tap']); ?></span>
        </button>

    <?php if ($terms !== null || $privacy !== null): ?>
        <label class="sign-tick">
            <input type="checkbox" id="sign-accept">
            <span>
            <?php if ($terms !== null): ?>
                <?php echo sign_e($t['accept']); ?>
                <a href="terms.php?lang=<?php echo $lang; ?>" target="_blank" rel="noopener"><?php echo sign_e($t['terms']); ?></a>
                (v<?php echo (int)$terms['version']; ?>)<?php echo $privacy !== null ? ' ' . sign_e($t['and']) : '.'; ?>
            <?php endif; ?>
            <?php if ($privacy !== null): ?>
                <?php echo $terms === null ? sign_e($t['ihave']) : ''; ?>
                <a href="privacy.php?lang=<?php echo $lang; ?>" target="_blank" rel="noopener"><?php echo sign_e($t['privacy']); ?></a>
                (v<?php echo (int)$privacy['version']; ?>)<?php echo $t['read'] !== '' ? ' ' . sign_e($t['read']) : ''; ?>.
            <?php endif; ?>
            </span>
        </label>
    <?php endif; ?>

        <p class="pub-hint"><?php echo sign_e($t['confirm']); ?></p>
        <div class="pub-flash pub-flash-bad" id="sign-error" role="alert" hidden></div>
        <button type="button" class="pub-btn pub-btn-primary sign-submit" id="sign-submit" disabled>
            <?php echo sign_e($t['submit']); ?>
        </button>
    </section>

    <section class="pub-card sign-done" id="sign-done" hidden>
        <i class="bi bi-check-circle-fill" aria-hidden="true"></i>
        <h1 class="pub-title"><?php echo sign_e($t['thanks']); ?></h1>
        <p class="pub-hint"><?php echo sign_e($t['close']); ?></p>
    </section>

    <div class="sign-overlay" id="sign-overlay" hidden role="dialog" aria-modal="true" aria-label="<?php echo sign_e($t['here']); ?>">
        <div class="sign-stage" id="sign-stage">
            <div class="sign-bar">
                <button type="button" class="pub-btn pub-btn-ghost pub-btn-sm" id="sign-clear"><?php echo sign_e($t['clear']); ?></button>
                <span class="sign-title"><?php echo sign_e($t['here']); ?></span>
                <button type="button" class="pub-btn pub-btn-primary pub-btn-sm" id="sign-close"><?php echo sign_e($t['done']); ?></button>
            </div>
            <div class="sign-area" id="sign-area">
                <canvas id="sign-canvas" aria-label="<?php echo sign_e($t['sign']); ?>"></canvas>
                <div class="sign-line" aria-hidden="true"><span>×</span></div>
            </div>
        </div>
    </div>
<?php endif; ?>
</main>

<?php if ($session !== null): ?>
<script>
(() => {
  'use strict';
  // The twin of app/components/SignaturePad.js: strokes as points in 0..1,
  // drawn along the long side of the screen (turned by 90° on an upright
  // phone), redrawn on every resize so turning the phone loses nothing.
  const TOKEN = <?php echo json_encode($token); ?>;
  const TERMS = <?php echo json_encode($terms === null ? null : (int)$terms['version']); ?>;
  const PRIVACY = <?php echo json_encode($privacy === null ? null : (int)$privacy['version']); ?>;
  const T = <?php echo json_encode(['needSign' => $t['needSign'], 'needTick' => $t['needTick']], JSON_UNESCAPED_UNICODE); ?>;
  const INK = '#111827';
  const PEN = 2.6;
  const BAR = 52;

  const $ = (id) => document.getElementById(id);
  const field = $('sign-field'), preview = $('sign-preview'), hint = $('sign-hint');
  const overlay = $('sign-overlay'), stage = $('sign-stage'), canvas = $('sign-canvas');
  const submitBtn = $('sign-submit'), accept = $('sign-accept'), errorBox = $('sign-error');

  let strokes = [];
  let rotated = false;
  let size = { width: 800, height: 360 };
  const drawn = () => strokes.some((s) => s.length);

  function paint(cv, list, width, height, pen = PEN) {
    const ratio = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(width * ratio));
    cv.height = Math.max(1, Math.round(height * ratio));
    const ctx = cv.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = INK; ctx.lineWidth = pen; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of list) {
      if (!s.length) continue;
      ctx.beginPath();
      ctx.moveTo(s[0].x * width, s[0].y * height);
      if (s.length === 1) ctx.lineTo(s[0].x * width + 0.1, s[0].y * height);
      for (let i = 1; i < s.length; i += 1) ctx.lineTo(s[i].x * width, s[i].y * height);
      ctx.stroke();
    }
    return ctx;
  }

  function layout() {
    const vw = window.innerWidth, vh = window.innerHeight;
    rotated = vh > vw;
    const long = Math.max(vw, vh), short = Math.min(vw, vh);
    size = { width: long, height: Math.max(120, short - BAR) };
    stage.style.width = long + 'px';
    stage.style.height = short + 'px';
    stage.style.transform = 'translate(-50%, -50%)' + (rotated ? ' rotate(90deg)' : '');
    canvas.style.width = size.width + 'px';
    canvas.style.height = size.height + 'px';
  }

  function renderPreview() {
    const w = field.clientWidth || 300, h = field.clientHeight || 160;
    const aspect = size.width / size.height;
    let pw = w, ph = w / aspect;
    if (ph > h) { ph = h; pw = h * aspect; }
    const ctx = paint(preview, [], w, h);
    const inner = document.createElement('canvas');
    paint(inner, strokes, pw, ph, Math.max(1.4, PEN * (pw / size.width) * 1.6));
    ctx.drawImage(inner, (w - pw) / 2, (h - ph) / 2, pw, ph);
    hint.hidden = drawn();
    update();
  }

  function update() {
    submitBtn.disabled = !drawn() || (accept && !accept.checked);
  }

  const redraw = () => { if (!overlay.hidden) paint(canvas, strokes, size.width, size.height); };

  // Live: the drawing reaches the desktop while it is being made. At most
  // one request in flight, coalesced, so a fast pen does not queue dozens.
  let dirty = false, sending = false;
  async function sendStrokes() {
    if (sending || !dirty) return;
    dirty = false; sending = true;
    try {
      await fetch('sign.php?t=' + TOKEN + '&op=strokes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strokes, aspect: size.width / size.height }),
      });
    } catch { dirty = true; } finally { sending = false; }
  }
  setInterval(sendStrokes, 450);
  const changed = () => { dirty = true; };

  function at(e) {
    const box = canvas.getBoundingClientRect();
    const x = rotated ? e.clientY - box.top : e.clientX - box.left;
    const y = rotated ? box.right - e.clientX : e.clientY - box.top;
    return { x: Math.min(1, Math.max(0, x / size.width)), y: Math.min(1, Math.max(0, y / size.height)) };
  }

  let drawing = false, current = null, ctx = null;
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drawing = true; current = [at(e)]; strokes.push(current);
    ctx = canvas.getContext('2d');
    const p = current[0];
    ctx.beginPath(); ctx.moveTo(p.x * size.width, p.y * size.height);
    ctx.lineTo(p.x * size.width + 0.1, p.y * size.height); ctx.stroke();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* fine without */ }
    changed();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    const p = at(e), prev = current[current.length - 1];
    current.push(p);
    ctx.beginPath(); ctx.moveTo(prev.x * size.width, prev.y * size.height);
    ctx.lineTo(p.x * size.width, p.y * size.height); ctx.stroke();
    changed();
  });
  const up = () => { if (drawing) { drawing = false; current = null; changed(); } };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  field.addEventListener('click', () => {
    layout(); overlay.hidden = false; document.body.style.overflow = 'hidden'; redraw();
  });
  $('sign-close').addEventListener('click', () => {
    overlay.hidden = true; document.body.style.overflow = ''; renderPreview(); changed();
  });
  $('sign-clear').addEventListener('click', () => { strokes = []; redraw(); changed(); });
  if (accept) accept.addEventListener('change', update);
  window.addEventListener('resize', () => { layout(); redraw(); if (overlay.hidden) renderPreview(); });

  // The PNG, landscape and cropped to the ink, exactly like the counter's.
  function toBlob() {
    let box = null;
    for (const s of strokes) for (const p of s) {
      box = box ? { minX: Math.min(box.minX, p.x), maxX: Math.max(box.maxX, p.x), minY: Math.min(box.minY, p.y), maxY: Math.max(box.maxY, p.y) }
        : { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y };
    }
    if (!box) return Promise.resolve(null);
    const full = document.createElement('canvas');
    paint(full, strokes, size.width, size.height);
    const r = window.devicePixelRatio || 1, pad = 8;
    const left = Math.max(0, Math.floor((box.minX * size.width - pad) * r));
    const top = Math.max(0, Math.floor((box.minY * size.height - pad) * r));
    const w = Math.max(1, Math.min(full.width, Math.ceil((box.maxX * size.width + pad) * r)) - left);
    const h = Math.max(1, Math.min(full.height, Math.ceil((box.maxY * size.height + pad) * r)) - top);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const o = out.getContext('2d');
    o.fillStyle = '#fff'; o.fillRect(0, 0, w, h);
    o.drawImage(full, left, top, w, h, 0, 0, w, h);
    return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  }

  submitBtn.addEventListener('click', async () => {
    errorBox.hidden = true;
    if (!drawn()) { errorBox.textContent = T.needSign; errorBox.hidden = false; return; }
    if (accept && !accept.checked) { errorBox.textContent = T.needTick; errorBox.hidden = false; return; }
    submitBtn.disabled = true;
    const blob = await toBlob();
    const form = new FormData();
    form.append('signedName', $('sign-name').value.trim());
    if (accept && accept.checked) form.append('acceptTerms', '1');
    if (TERMS) form.append('termsVersion', String(TERMS));
    if (PRIVACY) form.append('privacyVersion', String(PRIVACY));
    form.append('photos[]', blob, 'signature.png');
    try {
      const res = await fetch('sign.php?t=' + TOKEN + '&op=submit', { method: 'POST', body: form });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) throw new Error(body.error || 'Error');
      $('sign-form').hidden = true;
      $('sign-done').hidden = false;
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      update();
    }
  });

  layout();
  renderPreview();
})();
</script>
<?php endif; ?>
</body>
</html>
