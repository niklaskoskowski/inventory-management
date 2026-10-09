<?php
/**
 * Customer-facing booking page — unauthenticated, addressed only by token.
 *
 *   GET booking.php?t=<64 hex characters>
 *
 * The token is the ONLY key. Reservation and booking ids are small sequential
 * integers, so an id-addressable form of this page would be enumerable by
 * anyone; there deliberately is none.
 *
 * Unknown, malformed and expired tokens all produce the same 404 body, with the
 * same work done to produce it, so this page never tells a stranger that a
 * booking exists — only that theirs does not.
 *
 * Like public.php, the view model is an explicit allow-list rather than an
 * unset() blacklist: a field added to the schema later cannot leak here by
 * accident. What a booking holds beyond that list — the token itself, the
 * operator's notes, anything the assets carry (price, serial, supplier,
 * purchase data, internal notes) — never reaches the markup.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/store.php';
require_once __DIR__ . '/lib/markdown.php';

// These links must never turn up in a search index.
header('X-Robots-Tag: noindex, nofollow');
header('X-Content-Type-Options: nosniff');
// The token rides in the URL, so do not hand it to whatever the customer clicks.
header('Referrer-Policy: no-referrer');
header('Cache-Control: no-store');
header('Content-Type: text/html; charset=utf-8');

/** Escapes for HTML text and attributes. Mirrors the esc() idiom in index.php / view.php. */
function esc(mixed $value): string
{
    return htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/**
 * The one and only negative response. Fixed bytes, no detail, same for a token
 * that never existed as for one that has run out.
 */
function trax_booking_gone(): never
{
    http_response_code(404);
    echo <<<HTML
        <!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no, viewport-fit=cover">
        <meta name="robots" content="noindex, nofollow">
        <meta name="color-scheme" content="light dark">
        <title>Link not available</title>
        <link rel="stylesheet" href="public.css">
        <link rel="stylesheet" href="vendor/bootstrap-icons.css">
        </head>
        <body class="pub-page pub-solo">
        <main class="pub-solo-main">
        <div class="pub-card pub-solo-head">
        <div class="pub-appicon" aria-hidden="true"><i class="bi bi-link-45deg"></i></div>
        <h1 class="pub-solo-title">Link not available</h1>
        <p class="pub-solo-sub">It may have expired. Ask the lender for a new link.</p>
        </div>
        </main>
        </body>
        </html>

        HTML;
    exit;
}

/** German display date, or an em dash. */
function trax_booking_date(?string $iso): string
{
    $ts = $iso === null ? null : trax_parse_datetime($iso);
    return $ts === null ? '—' : trax_format_de($ts);
}

// --- Lookup ----------------------------------------------------------------
// A malformed token still costs a read and a full scan: the shape of the work
// must not tell the caller which of the two failures they hit.

$token = trax_booking_token($_GET['t'] ?? null) ?? bin2hex(random_bytes(32));

$data    = trax_read_data();
$booking = trax_find_booking_by_token($data['bookings'], $token);

if ($booking === null || trax_booking_expired($booking)) {
    trax_booking_gone();
}

// --- View model (allow-list) ----------------------------------------------

$assetsById = trax_index_assets($data['assets']);

$items    = [];
$lineOf   = [];   // assetId => index of the first line carrying it
foreach ($booking['items'] as $line) {
    $assetId = (int)$line['assetId'];
    $asset   = $assetsById[$assetId] ?? null;

    // The only thing taken off the live asset record is its thumbnail; the
    // name comes from the snapshot, so a later rename cannot rewrite history.
    $photo = $asset === null ? null : trax_photo_name($asset['photo'] ?? null);

    // Which physical units this line covers, as their display codes ("12.1").
    // The numbers come off the snapshot, so a unit renamed or removed later
    // cannot change what this booking says was handed over.
    $unitNos = [];
    foreach (trax_unit_nos($line['unitNos'] ?? null) as $no) {
        $unitNos[] = trax_unit_code($assetId, $no);
    }

    $lineOf[$assetId] ??= count($items);
    $items[] = [
        'name'    => $line['name'] !== '' ? $line['name'] : 'Item',
        'qty'     => max(1, (int)$line['qty']),
        'unitNos' => $unitNos,
        'setName' => (string)$line['setName'],
        'thumb'   => $photo === null ? null : 'uploads/thumb/' . $photo,
        // Filled in below — condition photos taken of this one piece.
        'photos'  => [],
    ];
}


/**
 * The QR code for THIS booking, as a PNG.
 *
 *   GET booking.php?t=<token>&qr=1
 *
 * It encodes a URL this file builds from the token it was given — never text
 * from the request — so the endpoint cannot be used to print a QR code that
 * points anywhere else. Guarded by the same token as the page, and answered
 * with the same nothing for an unknown or expired one.
 *
 * Server-side because the repo already carries phpqrcode for the labels, and
 * a second QR library — in JavaScript, for one small picture — would be a
 * second thing to keep.
 */
if (($_GET['qr'] ?? '') === '1') {
    $qrLibrary = __DIR__ . '/phpqrcode/qrlib.php';
    if (!is_file($qrLibrary)) {
        trax_booking_gone();
    }
    require_once $qrLibrary;

    header('Content-Type: image/png');
    header('Cache-Control: no-store');
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    // trax_booking_url() is the one place that builds this link — the mails
    // and the admin's "copy link" use it too, so the printed code and the
    // e-mailed link can never point at different pages.
    // Level M: this is read off paper in a warehouse, and the URL is short
    // enough that the extra correction costs nothing worth having.
    QRcode::png(trax_booking_url($token), false, QR_ECLEVEL_M, 6, 2);
    exit;
}

// Signatures are taken at the counter only (admin → Checkouts); this page
// shows one once it exists and takes no writes.

// Condition photos, taken at hand-over or check-in. Only the four fields the
// page renders are lifted across, and the filename is re-checked here rather
// than trusted: this file builds a URL out of it.
//
// They name the item they were taken of now, so each one is shown under that
// item — "which piece is this scratch on?" is the whole point of the photo.
// One that names no item, or one this booking does not list, is still shown
// rather than hidden: it belongs to the booking as a whole.
//
// The asset's own conditionLog is deliberately NOT touched here. That is
// internal history of the item across every loan, not this customer's booking.
$photos = [];
foreach ((array)($booking['photos'] ?? []) as $photo) {
    $file = trax_photo_name($photo['file'] ?? null);
    if ($file === null) {
        continue;
    }
    $entry = [
        'full'  => 'uploads/' . $file,
        'thumb' => 'uploads/thumb/' . $file,
        'at'    => trax_booking_date($photo['at'] ?? null),
        'note'  => (string)($photo['note'] ?? ''),
    ];

    $assetId = (int)($photo['assetId'] ?? 0);
    if ($assetId > 0 && isset($lineOf[$assetId])) {
        $items[$lineOf[$assetId]]['photos'][] = $entry;
        continue;
    }
    $photos[] = $entry;
}

/**
 * {version, at, url} for one version of the terms, for the page and the PDF.
 * The URL names the version, so what is linked is what was accepted even
 * after the terms have moved on.
 */
function trax_booking_terms_ref(int $version, ?string $at): array
{
    return [
        'version' => $version,
        'at'      => trax_booking_date($at),
        'atRaw'   => $at,
        'url'     => trax_terms_url($version),
    ];
}

$currentTerms = trax_terms_current($data);
$signedTerms  = $booking['signature']['terms'] ?? null;

$view = [
    // An install that has not named an organisation falls back to the app name,
    // so the heading and the title always say something the customer recognises.
    'orgName'      => (string)trax_setting('branding.orgName', '')
        ?: (string)trax_setting('branding.appName', 'Assets'),
    'brandColor'   => (string)trax_setting('branding.brandColor', '#1F2937'),
    'customerName' => (string)$booking['customerName'],
    'kind'         => (string)$booking['kind'],
    'status'       => (string)$booking['status'],
    'createdAt'    => trax_booking_date($booking['createdAt']),
    'startAt'      => $booking['startAt'] === null ? null : trax_booking_date($booking['startAt']),
    'dueAt'        => $booking['dueAt'] === null ? null : trax_booking_date($booking['dueAt']),
    'items'        => $items,
    'photos'       => $photos,
    // The hand-over signature, when there is one. `handedOverBy` deliberately
    // does NOT come along: it is an operator's login name, which is the
    // organisation's business and not the customer's.
    'signature'    => ($booking['signature'] ?? null) === null ? null : [
        'src'  => 'uploads/' . $booking['signature']['file'],
        'name' => (string)$booking['signature']['name'],
        'at'   => trax_booking_date($booking['signature']['at']),
        // What was accepted with it. Null for a signature given while no
        // terms were in force — and for every one taken before they existed.
        'terms' => $signedTerms === null ? null
            : trax_booking_terms_ref((int)$signedTerms['version'], $signedTerms['at'] ?? null),
    ],
    // The terms in force, shown and ticked under the pad. Rendered here by the
    // one Markdown renderer terms.php uses too.
    'terms'        => $currentTerms === null ? null : array_merge(
        trax_booking_terms_ref($currentTerms['version'], $currentTerms['at']),
        ['html' => trax_markdown($currentTerms['text'])]
    ),
];


$statusText = match ($view['status']) {
    'RETURNED'  => 'Returned',
    'CANCELLED' => 'Cancelled',
    default     => $view['kind'] === 'reservation' ? 'Reserved' : 'Checked out',
};
$statusClass = match ($view['status']) {
    'RETURNED'  => 's-done',
    'CANCELLED' => 's-void',
    default     => 's-open',
};
$dueLabel = $view['kind'] === 'reservation' ? 'Reserved until' : 'Return by';

/**
 * The hand-over sheet, as the document builder in app/lib/pdf.js wants it.
 *
 * The SAME builder the counter uses, handed the same booking — so what the
 * customer downloads here is the sheet they were given, tick boxes and all.
 * That is the point of the button: the paper doubles as the packing list, and
 * whoever is loading the van needs it more often than it survives the journey.
 *
 * Its own allow-list, like $view above, and a shorter one: no operator notes,
 * no e-mail address, and no `handedOverBy` — that is a login name, and the
 * customer's copy has no business carrying it. Dates go out RAW here, not
 * formatted, because the builder formats them itself.
 */
/** {version, at, url} for the sheet's terms line, or null. */
function trax_booking_pdf_terms(array $booking, ?array $current): ?array
{
    $signature = $booking['signature'] ?? null;
    if ($signature !== null) {
        $terms = $signature['terms'] ?? null;
        return $terms === null ? null : [
            'version' => (int)$terms['version'],
            'at'      => $terms['at'] ?? null,
            'url'     => trax_terms_url((int)$terms['version']),
        ];
    }
    return $current === null ? null : [
        'version' => $current['version'],
        'at'      => $current['at'],
        'url'     => trax_terms_url($current['version']),
    ];
}

$pdfItems = [];
foreach ($booking['items'] as $line) {
    $assetId = (int)$line['assetId'];
    $codes   = [];
    foreach (trax_unit_nos($line['unitNos'] ?? null) as $no) {
        $codes[] = trax_unit_code($assetId, $no);
    }
    $name = $line['name'] !== '' ? $line['name'] : 'Item';
    $pdfItems[] = [
        // The units are part of the name on a sheet somebody ticks off:
        // "5m XLR cable (12.1, 12.3)" is what physically went out.
        'name'    => $codes === [] ? $name : $name . ' (' . implode(', ', $codes) . ')',
        'assetId' => $assetId,
        'qty'     => max(1, (int)$line['qty']),
        'setName' => (string)$line['setName'],
    ];
}

$pdf = [
    'kind'         => $view['kind'],
    'customerName' => $view['customerName'],
    // A checkout that never recorded a start was handed over when it was
    // created; the sheet says a date either way.
    'startAt'      => $booking['startAt'] ?? $booking['createdAt'],
    'endAt'        => $booking['dueAt'],
    'hire'         => (string)$booking['hire'],
    'status'       => $statusText,
    'items'        => $pdfItems,
    // Printed as a QR code on the sheet, so the paper leads back here.
    'bookingUrl'   => trax_booking_url($token),
    'signatureDeclined' => ($booking['signature'] ?? null) === null && ($booking['signatureDeclined'] ?? null) !== null
        ? ['at' => (string)$booking['signatureDeclined']['at'], 'note' => (string)$booking['signatureDeclined']['note']]
        : null,
    'signature'    => ($booking['signature'] ?? null) === null ? null : [
        'file' => (string)$booking['signature']['file'],
        'name' => (string)$booking['signature']['name'],
        'at'   => (string)$booking['signature']['at'],
    ],
    // The terms line under the signature: what was accepted when signed, what
    // signing would accept when not. Nothing when neither applies.
    'terms'        => trax_booking_pdf_terms($booking, $currentTerms),
];

/**
 * The three branding fields the document builder reads, and nothing else.
 *
 * It takes them from whoever is hosting it — the store in the admin, this
 * array here — which is why app/lib/pdf.js imports no store at all.
 */
$pdfBranding = [
    'appName'    => (string)trax_setting('branding.appName', 'Assets'),
    'brandColor' => $view['brandColor'],
    'logoFile'   => (string)trax_setting('branding.logoFile', ''),
];
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no, viewport-fit=cover">
    <meta name="robots" content="noindex, nofollow">
    <meta name="color-scheme" content="light dark">
    <title>Your booking · <?php echo esc($view['orgName']); ?></title>
    <!-- All styling lives in public.css. Deliberately no inline style block:
         api_test.sh asserts the rendered page contains no at-sign at all. -->
    <link rel="stylesheet" href="public.css">
    <link rel="stylesheet" href="vendor/bootstrap-icons.css">
</head>
<body class="pub-page">
<header class="pub-top">
    <div class="pub-top-inner">
        <span class="pub-appicon bk-mark" style="background: <?php echo esc($view['brandColor']); ?>;" aria-hidden="true"><i class="bi bi-box-seam"></i></span>
        <span class="pub-wordmark"><?php echo esc($view['orgName']); ?></span>
    </div>
</header>

<main class="pub-main">
    <div class="bk-head">
        <div class="bk-head-text">
            <h1 class="pub-title">Your booking</h1>
        </div>
        <span class="bk-badge <?php echo esc($statusClass); ?>"><?php echo esc($statusText); ?></span>
    </div>

    <section class="bk-section">
        <div class="pub-group">
            <div class="pub-row pub-kv"><span>Booked for</span><strong><?php echo esc($view['customerName']); ?></strong></div>
            <?php if ($view['startAt'] !== null): ?>
                <div class="pub-row pub-kv"><span>From</span><strong><?php echo esc($view['startAt']); ?></strong></div>
            <?php endif; ?>
            <?php if ($view['dueAt'] !== null): ?>
                <div class="pub-row pub-kv"><span><?php echo esc($dueLabel); ?></span><strong><?php echo esc($view['dueAt']); ?></strong></div>
            <?php endif; ?>
            <div class="pub-row pub-kv"><span>Issued</span><strong><?php echo esc($view['createdAt']); ?></strong></div>
        </div>
    </section>

    <section class="bk-section">
        <h2 class="pub-eyebrow"><?php echo count($view['items']); ?> <?php echo count($view['items']) === 1 ? 'item' : 'items'; ?></h2>
        <?php if ($view['items'] === []): ?>
            <p class="pub-empty">Nothing is listed.</p>
        <?php else: ?>
            <div class="pub-group bk-items">
            <?php foreach ($view['items'] as $item): ?>
                <div class="bk-item">
                    <div class="pub-row">
                        <?php if ($item['thumb'] !== null): ?>
                            <img class="bk-thumb" src="<?php echo esc($item['thumb']); ?>" alt="">
                        <?php else: ?>
                            <span class="bk-thumb bk-thumb-empty"><i class="bi bi-box-seam"></i></span>
                        <?php endif; ?>
                        <div class="pub-row-main">
                            <div class="pub-row-title"><?php echo esc($item['name']); ?></div>
                            <?php if ($item['setName'] !== '' || $item['unitNos'] !== []): ?>
                                <div class="pub-row-meta">
                                    <?php if ($item['setName'] !== ''): ?>in <?php echo esc($item['setName']); ?><?php endif; ?>
                                    <?php if ($item['setName'] !== '' && $item['unitNos'] !== []): ?> · <?php endif; ?>
                                    <?php if ($item['unitNos'] !== []): ?>units <?php echo esc(implode(', ', $item['unitNos'])); ?><?php endif; ?>
                                </div>
                            <?php endif; ?>
                        </div>
                        <div class="pub-row-end bk-qty">× <?php echo esc((string)$item['qty']); ?></div>
                    </div>

                    <?php if ($item['photos'] !== []): ?>
                        <!-- Photos of THIS piece, so the note reads as being
                             about it and not about the whole booking. -->
                        <div class="bk-shots" aria-label="Condition photos of <?php echo esc($item['name']); ?>">
                            <?php foreach ($item['photos'] as $photo): ?>
                                <div class="bk-shot">
                                    <a href="<?php echo esc($photo['full']); ?>" target="_blank" rel="noopener noreferrer">
                                        <img src="<?php echo esc($photo['thumb']); ?>" alt="Condition photo">
                                    </a>
                                    <div><?php echo esc($photo['at']); ?></div>
                                    <?php if ($photo['note'] !== ''): ?>
                                        <div class="bk-shot-note"><?php echo esc($photo['note']); ?></div>
                                    <?php endif; ?>
                                </div>
                            <?php endforeach; ?>
                        </div>
                    <?php endif; ?>
                </div>
            <?php endforeach; ?>
            </div>
        <?php endif; ?>
    </section>

    <?php if ($view['photos'] !== []): ?>
        <!-- What is left: photos naming no item, or an item this booking does
             not list. Shown rather than dropped. -->
        <section class="bk-section">
            <h2 class="pub-eyebrow">Condition photos</h2>
            <div class="pub-group">
                <div class="bk-shots bk-shots-loose">
                    <?php foreach ($view['photos'] as $photo): ?>
                        <div class="bk-shot">
                            <a href="<?php echo esc($photo['full']); ?>" target="_blank" rel="noopener noreferrer">
                                <img src="<?php echo esc($photo['thumb']); ?>" alt="Condition photo">
                            </a>
                            <div><?php echo esc($photo['at']); ?></div>
                            <?php if ($photo['note'] !== ''): ?>
                                <div class="bk-shot-note"><?php echo esc($photo['note']); ?></div>
                            <?php endif; ?>
                        </div>
                    <?php endforeach; ?>
                </div>
            </div>
        </section>
    <?php endif; ?>

    <!-- Hand-over: the signature taken at the counter, when there is one. -->
    <?php if ($view['signature'] !== null): ?>
        <section class="bk-section">
            <h2 class="pub-eyebrow">Received by</h2>
            <div class="pub-group bk-sig">
                <img class="sig-shot" src="<?php echo esc($view['signature']['src']); ?>"
                     alt="Signature of <?php echo esc($view['signature']['name']); ?>">
                <div class="sig-name"><?php echo esc($view['signature']['name']); ?></div>
                <div class="kit"><?php echo esc($view['signature']['at']); ?></div>
                <?php if ($view['signature']['terms'] !== null): ?>
                    <div class="kit mt-1">
                        Accepted
                        <a class="terms-link" href="<?php echo esc($view['signature']['terms']['url']); ?>"
                           target="_blank" rel="noopener noreferrer">terms v<?php echo esc((string)$view['signature']['terms']['version']); ?></a>
                        of <?php echo esc($view['signature']['terms']['at']); ?>
                    </div>
                <?php endif; ?>
            </div>
        </section>
    <?php endif; ?>

    <!-- The sheet, again. Hidden until the module below has wired it up: a
         button that cannot do anything is worse than no button. -->
    <div class="bk-pdf">
        <button class="pub-btn pub-btn-tinted d-none" id="pdf-get" type="button">
            <i class="bi bi-file-earmark-arrow-down"></i> Download checklist (PDF)
        </button>
    </div>

    <p class="bk-private">
        <i class="bi bi-lock-fill" aria-hidden="true"></i> Private link — please don't share it.
    </p>
</main>

<?php if ($currentTerms !== null): ?>
    <footer class="pub-foot">
        <a href="<?php echo esc(trax_terms_url()); ?>" target="_blank" rel="noopener noreferrer">Terms &amp; conditions</a>
    </footer>
<?php endif; ?>
<script type="module">
/**
 * The hand-over sheet, built on the customer's own device.
 *
 * It is the very same builder the counter runs — app/lib/pdf.js, which takes
 * its branding from whoever hosts it rather than importing a store — so this
 * button hands back the sheet that was printed at hand-over, tick boxes, QR
 * code and signature included. Nothing is generated on the server and nothing
 * is stored: the booking is already on this page, and the PDF is one more way
 * of reading it.
 *
 * A module, so a browser too old for one simply never reveals the button and
 * the page stays exactly what it was.
 */
import { configurePdf, exportBookingPdf } from './app/lib/pdf.js';

const button = document.getElementById('pdf-get');
if (button) {
    const booking = <?php echo json_encode($pdf); ?>;
    const branding = <?php echo json_encode($pdfBranding); ?>;
    configurePdf({ settings: () => ({ branding: branding }) });
    button.classList.remove('d-none');

    button.addEventListener('click', function () {
        const label = button.innerHTML;
        button.disabled = true;
        // jsPDF is ~400 KB fetched on the first click and a big booking takes
        // a moment to lay out, so the button says what it is doing.
        button.textContent = 'Building…';
        exportBookingPdf(booking)
            .then(function () { button.innerHTML = label; })
            .catch(function () { button.textContent = 'That did not work.'; })
            .finally(function () { button.disabled = false; });
    });
}
</script>
</body>
</html>
