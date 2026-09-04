<?php
/**
 * Public asset lookup — unauthenticated, deliberately minimal.
 *
 * Replaces the `?api=` proxy that index.php used to expose (index.php:35-40),
 * which streamed data.json and checkout.json verbatim to anyone who asked —
 * every reservation, every customer name and every email address.
 *
 * This returns an explicit allow-list of fields. It is an allow-list rather
 * than an unset() blacklist so that adding a field to the schema can never
 * leak it here by accident.
 *
 *   GET public.php?id=3      one asset
 *   GET public.php?list=1    the whole inventory, same fields
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/store.php';

// JSON-only endpoint: keep PHP notices out of the response body (see api.php).
@ini_set('display_errors', '0');
@ini_set('log_errors', '1');
ob_start();

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Robots-Tag: noindex, nofollow');
header('Cache-Control: public, max-age=20');

const TRAX_PUBLIC_JSON_FLAGS = JSON_UNESCAPED_UNICODE
    | JSON_UNESCAPED_SLASHES
    | JSON_HEX_TAG
    | JSON_HEX_AMP
    | JSON_HEX_APOS
    | JSON_HEX_QUOT;

/** Emits the response, discarding anything buffered before it. */
function trax_public_emit(array $body, int $status = 200): never
{
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    http_response_code($status);
    echo json_encode($body, TRAX_PUBLIC_JSON_FLAGS);
    exit;
}

/**
 * The only fields that ever leave this endpoint.
 *
 * Quantity and availability are counts of things on a shelf, not customer
 * data, so they are safe to publish; who holds the units is not, and never
 * appears here.
 */
function trax_public_view(array $asset, array $linesByAsset): array
{
    $lines    = $linesByAsset[(int)$asset['id']] ?? [];
    $outQty   = trax_lines_qty($lines);
    $quantity = max(1, (int)$asset['quantity']);

    return [
        'id'           => (int)$asset['id'],
        'name'         => $asset['name'],
        'status'       => $asset['status'],
        'notes'        => $asset['notes'],
        'category'     => $asset['category'],
        'kind'         => $asset['kind'],
        'quantity'     => $quantity,
        // The one availability function, blocked- and unit-aware. Hand-rolling
        // it here once made an all-units-out-of-service asset report LOCK and
        // availableQty 2 in the same payload.
        'availableQty' => trax_available_qty_for($asset, $lines),
        // Whether any unit is out — never who has it, or until when.
        'isOut'        => $outQty > 0,
    ];
}

$data      = trax_read_data();
$checkouts = trax_read_checkouts();

// Derived status for kits, so a public label on a kit still reads correctly.
$assetsById   = trax_index_assets($data['assets']);
$linesByAsset = trax_group_checkouts_by_asset($checkouts);

if (isset($_GET['list'])) {
    $rows = [];
    foreach ($data['assets'] as $asset) {
        $view           = trax_public_view($asset, $linesByAsset);
        $view['status'] = trax_effective_status($asset, $assetsById, $linesByAsset);
        $rows[]         = $view;
    }

    trax_public_emit(['ok' => true, 'data' => $rows]);
}

$id = filter_input(INPUT_GET, 'id', FILTER_VALIDATE_INT);
if ($id === false || $id === null) {
    trax_public_emit(['ok' => false, 'error' => 'A numeric id is required.'], 400);
}

$unit = filter_input(INPUT_GET, 'u', FILTER_VALIDATE_INT);
$unit = ($unit !== false && $unit !== null && $unit > 0) ? (int)$unit : null;

$asset = trax_find_asset($data['assets'], $id);
if ($asset === null) {
    trax_public_emit(['ok' => false, 'error' => 'Not found.'], 404);
}

$view           = trax_public_view($asset, $linesByAsset);
$view['status'] = trax_effective_status($asset, $assetsById, $linesByAsset);

// A label printed for one physical unit says which unit it is and whether that
// one is on the shelf. Never who holds it — same rule as above.
if ($unit !== null && trax_asset_has_units($asset)) {
    foreach ($asset['units'] as $row) {
        if ((int)$row['no'] !== $unit) {
            continue;
        }

        $states       = trax_unit_states($asset, $linesByAsset[$id] ?? []);
        $view['unit'] = [
            'no'    => $unit,
            'code'  => trax_unit_code($id, $unit),
            'label' => (string)($row['label'] ?? ''),
            'state' => $states[$unit]['state'] ?? 'FREE',
        ];
        break;
    }
}

trax_public_emit(['ok' => true, 'data' => $view]);
