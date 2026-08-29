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
        <html lang="en" data-bs-theme="dark">
        <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no">
        <meta name="robots" content="noindex, nofollow">
        <title>Link not available</title>
        <link rel="stylesheet" href="vendor/bootstrap.min.css">
        <style>body{background:#0c0f12;color:#e6edf3;touch-action:manipulation;} .wrap{max-width:520px;margin:0 auto;padding:4rem 1rem;}</style>
        </head>
        <body>
        <div class="wrap">
        <h1 class="h5">This link is not available.</h1>
        <p class="text-secondary small mb-0">It may have expired, or it may never have been valid. If you still need
        your booking details, please ask the person who lent you the equipment for a new link.</p>
        </div>
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

    $lineOf[$assetId] ??= count($items);
    $items[] = [
        'name'    => $line['name'] !== '' ? $line['name'] : 'Item',
        'qty'     => max(1, (int)$line['qty']),
        'setName' => (string)$line['setName'],
        'thumb'   => $photo === null ? null : 'uploads/thumb/' . $photo,
        // Filled in below — condition photos taken of this one piece.
        'photos'  => [],
    ];
}

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
?>
<!DOCTYPE html>
<html lang="en" data-bs-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no">
    <meta name="robots" content="noindex, nofollow">
    <title>Your booking · <?php echo esc($view['orgName']); ?></title>
    <link rel="stylesheet" href="vendor/bootstrap.min.css">
    <link rel="stylesheet" href="vendor/bootstrap-icons.css">
    <style>
        body { background: #0c0f12; color: #e6edf3; touch-action: manipulation; }
        button, .btn { touch-action: manipulation; }
        .sheet { max-width: 720px; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
        .brandbar { height: 4px; border-radius: 999px; margin-bottom: 1.25rem; }
        .card-t { background: #11161b; border: 1px solid #1b232b; border-radius: .75rem; }
        .thumb { width: 56px; height: 56px; object-fit: cover; border-radius: .5rem; background: #1b232b; }
        .thumb-empty { display: inline-flex; align-items: center; justify-content: center; color: #55606b; }
        .meta-label { font-size: .68rem; text-transform: uppercase; letter-spacing: .05em; color: #8b98a5; }
        .badge-status { font-size: .7rem; font-weight: 600; padding: .2rem .55rem; border-radius: 999px; }
        .s-open { color: #f0c674; background: rgba(210,153,34,.15); }
        .s-done { color: #7ee2a0; background: rgba(46,160,67,.15); }
        .s-void { color: #b1bac4; background: rgba(110,118,129,.18); }
        .kit { font-size: .7rem; color: #8b98a5; }
        .shot { width: 120px; }
        .shot-img { width: 120px; height: 90px; object-fit: cover; border-radius: .5rem; background: #1b232b; }
        /* Deliberately no 16px focus-zoom rule: this sheet is read-only and has
           no form controls, and api_test.sh asserts the rendered page contains
           no at-sign at all, which any media block would violate. */
    </style>
</head>
<body>
<div class="sheet">
    <div class="brandbar" style="background: <?php echo esc($view['brandColor']); ?>;"></div>

    <div class="d-flex align-items-center gap-2 mb-3">
        <h1 class="h5 mb-0 flex-grow-1"><?php echo esc($view['orgName']); ?> · Your booking</h1>
        <span class="badge-status <?php echo esc($statusClass); ?>"><?php echo esc($statusText); ?></span>
    </div>

    <div class="card-t p-3 mb-3">
        <div class="meta-label">Booked for</div>
        <div class="mb-3"><?php echo esc($view['customerName']); ?></div>

        <div class="row g-3">
            <?php if ($view['startAt'] !== null): ?>
                <div class="col-6 col-md-4">
                    <div class="meta-label">From</div>
                    <div><?php echo esc($view['startAt']); ?></div>
                </div>
            <?php endif; ?>
            <?php if ($view['dueAt'] !== null): ?>
                <div class="col-6 col-md-4">
                    <div class="meta-label"><?php echo esc($dueLabel); ?></div>
                    <div><?php echo esc($view['dueAt']); ?></div>
                </div>
            <?php endif; ?>
            <div class="col-6 col-md-4">
                <div class="meta-label">Issued</div>
                <div><?php echo esc($view['createdAt']); ?></div>
            </div>
        </div>
    </div>

    <div class="card-t p-3">
        <div class="meta-label mb-2"><?php echo count($view['items']); ?> item(s)</div>
        <?php if ($view['items'] === []): ?>
            <p class="text-secondary small mb-0">Nothing is listed on this booking.</p>
        <?php else: ?>
            <?php foreach ($view['items'] as $item): ?>
                <div class="border-bottom border-dark-subtle">
                    <div class="d-flex align-items-center gap-3 py-2">
                        <?php if ($item['thumb'] !== null): ?>
                            <img class="thumb" src="<?php echo esc($item['thumb']); ?>" alt="">
                        <?php else: ?>
                            <span class="thumb thumb-empty"><i class="bi bi-box-seam"></i></span>
                        <?php endif; ?>
                        <div class="flex-grow-1">
                            <div><?php echo esc($item['name']); ?></div>
                            <?php if ($item['setName'] !== ''): ?>
                                <div class="kit">in <?php echo esc($item['setName']); ?></div>
                            <?php endif; ?>
                        </div>
                        <div class="text-secondary small">× <?php echo esc((string)$item['qty']); ?></div>
                    </div>

                    <?php if ($item['photos'] !== []): ?>
                        <!-- Photos of THIS piece, so the note is readable as
                             being about it and not about the whole booking. -->
                        <div class="meta-label mb-2">Condition photos of <?php echo esc($item['name']); ?></div>
                        <div class="d-flex flex-wrap gap-3 pb-3">
                            <?php foreach ($item['photos'] as $photo): ?>
                                <div class="shot">
                                    <a href="<?php echo esc($photo['full']); ?>" target="_blank" rel="noopener noreferrer">
                                        <img class="shot-img" src="<?php echo esc($photo['thumb']); ?>" alt="Condition photo">
                                    </a>
                                    <div class="kit mt-1"><?php echo esc($photo['at']); ?></div>
                                    <?php if ($photo['note'] !== ''): ?>
                                        <div class="small text-secondary"><?php echo esc($photo['note']); ?></div>
                                    <?php endif; ?>
                                </div>
                            <?php endforeach; ?>
                        </div>
                    <?php endif; ?>
                </div>
            <?php endforeach; ?>
        <?php endif; ?>
    </div>

    <?php if ($view['photos'] !== []): ?>
        <!-- What is left: photos naming no item, or an item this booking does
             not list. Shown rather than dropped. -->
        <div class="card-t p-3 mt-3">
            <div class="meta-label mb-2">Condition photos</div>
            <div class="d-flex flex-wrap gap-3">
                <?php foreach ($view['photos'] as $photo): ?>
                    <div class="shot">
                        <a href="<?php echo esc($photo['full']); ?>" target="_blank" rel="noopener noreferrer">
                            <img class="shot-img" src="<?php echo esc($photo['thumb']); ?>" alt="Condition photo">
                        </a>
                        <div class="kit mt-1"><?php echo esc($photo['at']); ?></div>
                        <?php if ($photo['note'] !== ''): ?>
                            <div class="small text-secondary"><?php echo esc($photo['note']); ?></div>
                        <?php endif; ?>
                    </div>
                <?php endforeach; ?>
            </div>
        </div>
    <?php endif; ?>

    <p class="text-secondary small mt-4 mb-0">
        This page is private to you. Please do not share the link.
    </p>
</div>
</body>
</html>
