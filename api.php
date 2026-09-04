<?php
/**
 * The API — the single authenticated entry point.
 *
 * Replaces the previous arrangement where admin.php sniffed the shape of a
 * POST body, checkout.php and manage_checkouts.php sat unauthenticated beside
 * it, and the browser POSTed the whole database on every change.
 *
 * Contract
 *   GET  api.php?action=<read action>
 *   POST api.php  {"action":"…","rev":<int>,"payload":{…}}   Content-Type: application/json
 *
 *   { "ok": true,  "rev": 42, "data": { … } }
 *   { "ok": false, "error": { "code": "STALE", "message": "…", "details": { … } } }
 *
 * Every mutation sends a delta and receives the full snapshot back. The data
 * set is ~20 KB and there are one or two operators, so returning the snapshot
 * removes all client-side merge logic — and with it, a whole class of bugs.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/store.php';
require_once __DIR__ . '/lib/auth.php';
// The shared writer of lib/config.local.php. Not lib/install.php: the installer
// is a separate program that happens to write the same file, and loading it
// here would put its whole surface behind the API.
require_once __DIR__ . '/lib/config-local.php';
require_once __DIR__ . '/lib/mailer.php';
require_once __DIR__ . '/lib/photo.php';
require_once __DIR__ . '/lib/documents.php';

// The same gate as admin.php, answering in JSON: a redirect to the login form
// would reach this endpoint's client as an unparseable body and no clue why.
trax_require_login('api');

/**
 * This endpoint emits JSON only. Anything printed before it — a PHP notice
 * from a bundled library, a stray newline after a `?>` — corrupts the body and
 * the client sees an unreadable response. Diagnostics go to the log, and
 * output is buffered so it can be discarded at the point of writing.
 */
@ini_set('display_errors', '0');
@ini_set('log_errors', '1');
ob_start();

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * JSON_HEX_* escapes <, >, & and quotes inside strings. The response is
 * application/json with nosniff and Vue escapes on render, so this is defence
 * in depth rather than the primary control — but it costs nothing and means an
 * asset named "<script>" can never be mistaken for markup by anything
 * downstream, including a log viewer or a future consumer of this API.
 */
const TRAX_JSON_FLAGS = JSON_UNESCAPED_UNICODE
    | JSON_UNESCAPED_SLASHES
    | JSON_PRESERVE_ZERO_FRACTION
    | JSON_HEX_TAG
    | JSON_HEX_AMP
    | JSON_HEX_APOS
    | JSON_HEX_QUOT;

/** Drops anything buffered before the JSON body is written. */
function trax_discard_stray_output(): void
{
    while (ob_get_level() > 0) {
        $stray = ob_get_clean();
        if ($stray !== false && trim((string)$stray) !== '') {
            error_log('[app] discarded stray output before JSON: ' . substr((string)$stray, 0, 500));
        }
    }
}

function trax_fail(string $code, string $message, int $status = 400, array $details = []): never
{
    trax_discard_stray_output();
    http_response_code($status);
    echo json_encode([
        'ok'    => false,
        'error' => array_filter([
            'code'    => $code,
            'message' => $message,
            'details' => $details ?: null,
        ], static fn($v) => $v !== null),
    ], TRAX_JSON_FLAGS);
    exit;
}

function trax_ok(array $data, ?int $rev = null): never
{
    trax_discard_stray_output();
    echo json_encode(array_filter([
        'ok'   => true,
        'rev'  => $rev,
        'data' => $data,
    ], static fn($v) => $v !== null), TRAX_JSON_FLAGS);
    exit;
}

/**
 * The full client-visible state. Assets carry their derived set status.
 *
 * Settings ride here rather than in the bootstrap-only `meta` block: the client
 * assigns `meta` on bootstrap alone, so a settings change would otherwise not
 * reach it until the page was reloaded.
 */
function trax_snapshot(array $data, array $checkouts): array
{
    return [
        'rev'          => $data['rev'],
        'assets'       => trax_decorate_assets($data['assets'], $checkouts),
        'reservations' => $data['reservations'],
        'history'      => $data['rentalHistory'],
        'checkouts'    => $checkouts,
        // Bookings carry their token: the operator needs it to resend or
        // re-open a customer's link. This endpoint is authenticated; nothing
        // in the public direction ever echoes a token back.
        'bookings'     => $data['bookings'] ?? [],
        'settings'     => trax_normalize_settings($data['settings'] ?? null),
    ];
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$isPost = $method === 'POST';

$action  = '';
$payload = [];
$clientRev = null;

if ($isPost) {
    $contentType = strtolower($_SERVER['CONTENT_TYPE'] ?? '');
    $isMultipart = str_contains($contentType, 'multipart/form-data');

    if ($isMultipart) {
        // Photo upload. multipart is a CORS-simple content type, so the token
        // cannot ride on the Content-Type check below and travels as a field —
        // which is why it is read here exactly like the JSON branch reads it.
        //
        // The payload is an explicit allow-list, not $_POST: a form field that
        // no upload action needs must not become reachable by being posted.
        $action  = trax_str($_POST['action'] ?? '', 60);
        $payload = [
            'id'        => trax_int($_POST['id'] ?? null),
            'bookingId' => trax_int($_POST['bookingId'] ?? null),
            'assetId'   => trax_int($_POST['assetId'] ?? null),
            'note'      => trax_str($_POST['note'] ?? ''),
            // The operator's label for a document batch. It has to be listed
            // here to exist at all: this array IS the multipart payload.
            'title'     => trax_str($_POST['title'] ?? '', TRAX_MAX_NAME),
        ];
        // Absent (every existing client) still means null, i.e. no rev check.
        $clientRev = trax_int($_POST['rev'] ?? null);
        $token     = trax_str($_POST['csrf'] ?? '', 200);
    } else {
        // Requiring JSON means a cross-origin <form> POST cannot reach any
        // mutation at all — the CSRF token is then defence in depth.
        if (!str_contains($contentType, 'application/json')) {
            trax_fail('UNSUPPORTED_MEDIA', 'Mutations must be sent as application/json.', 415);
        }

        $length = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($length > 2 * 1024 * 1024) {
            trax_fail('TOO_LARGE', 'Request body is too large.', 413);
        }

        $raw  = file_get_contents('php://input') ?: '';
        $body = json_decode($raw, true);
        if (!is_array($body)) {
            trax_fail('BAD_REQUEST', 'Request body is not valid JSON.');
        }

        $action    = trax_str($body['action'] ?? '', 60);
        $payload   = is_array($body['payload'] ?? null) ? $body['payload'] : [];
        $clientRev = trax_int($body['rev'] ?? null);
        $token     = trax_str($body['csrf'] ?? '', 200);
    }

    if (!trax_csrf_verify($token !== '' ? $token : null)) {
        trax_fail('FORBIDDEN', 'Invalid or missing CSRF token. Reload the page and try again.', 403);
    }
} else {
    $action  = trax_str($_GET['action'] ?? '', 60);
    $payload = $_GET;
}

if ($action === '') {
    trax_fail('BAD_REQUEST', 'No action given.');
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

function req_int(array $payload, string $key): int
{
    $value = trax_int($payload[$key] ?? null);
    if ($value === null) {
        trax_fail('BAD_REQUEST', "Field \"{$key}\" must be a number.");
    }
    return $value;
}

function req_str(array $payload, string $key, int $max = TRAX_MAX_STRING): string
{
    $value = trax_str($payload[$key] ?? '', $max);
    if ($value === '') {
        trax_fail('BAD_REQUEST', "Field \"{$key}\" is required.");
    }
    return $value;
}

function req_email(array $payload, string $key): string
{
    $value = trax_valid_email($payload[$key] ?? null);
    if ($value === null) {
        trax_fail('BAD_REQUEST', "Field \"{$key}\" must be a valid email address.");
    }
    return $value;
}

function req_iso(array $payload, string $key): string
{
    $value = trax_iso($payload[$key] ?? null);
    if ($value === null) {
        trax_fail('BAD_REQUEST', "Field \"{$key}\" must be a valid date.");
    }
    return $value;
}

/** Reads a list of asset ids from the payload. */
function req_ids(array $payload, string $key = 'ids'): array
{
    $raw = $payload[$key] ?? null;
    if (!is_array($raw)) {
        trax_fail('BAD_REQUEST', "Field \"{$key}\" must be a list of ids.");
    }

    $ids = [];
    foreach ($raw as $item) {
        $id = trax_int($item);
        if ($id !== null && $id > 0 && !in_array($id, $ids, true)) {
            $ids[] = $id;
        }
    }
    if ($ids === []) {
        trax_fail('BAD_REQUEST', 'Select at least one item.');
    }
    return $ids;
}

/**
 * Reads a list of items from the payload as [{assetId, qty, unitNos}].
 *
 * Accepts both the quantity-carrying [{"id":6,"qty":3}] and a bare [6,7]
 * (one unit each), so every existing caller keeps working unchanged. An entry
 * may also name the physical units it wants with "unitNos":[1,3]. Repeats of
 * the same asset are summed and their unit choices unioned.
 */
function req_items(array $payload, string $key): array
{
    $raw = $payload[$key] ?? null;
    if (!is_array($raw)) {
        trax_fail('BAD_REQUEST', "Field \"{$key}\" must be a list of items.");
    }

    $items = [];
    $index = [];
    foreach ($raw as $entry) {
        [$id, $qty, $unitNos] = trax_item_pair($entry);
        if ($id === null) {
            continue;
        }
        if (isset($index[$id])) {
            $items[$index[$id]]['qty']     = min(TRAX_MAX_QUANTITY, $items[$index[$id]]['qty'] + $qty);
            $items[$index[$id]]['unitNos'] = trax_unit_nos(array_merge($items[$index[$id]]['unitNos'], $unitNos));
            continue;
        }
        $index[$id] = count($items);
        $items[]    = ['assetId' => $id, 'qty' => $qty, 'unitNos' => $unitNos];
    }

    if ($items === []) {
        trax_fail('BAD_REQUEST', 'Select at least one item.');
    }
    return $items;
}

/**
 * Reads a set's member list as [{assetId, qty}], accepting both the legacy
 * flat [3,4,5] and [{"assetId":4,"qty":2}]. Duplicates keep the first entry,
 * which is what the pre-quantity code did.
 */
function trax_parse_members(array $raw): array
{
    $members = [];
    $seen    = [];
    foreach ($raw as $entry) {
        [$id, $qty] = trax_item_pair($entry, TRAX_MAX_MEMBER_QTY);
        if ($id === null || isset($seen[$id])) {
            continue;
        }
        $seen[$id] = true;
        $members[] = ['assetId' => $id, 'qty' => $qty];
    }
    return $members;
}

/**
 * lib/mailer.php renders "[ID n]" from a record's `id`. Checkout records no
 * longer carry one — `id` used to mean "asset id" and was dropped so nothing
 * could keep that assumption silently. Supply it here, at the boundary, so
 * the asset id never leaks back into checkout.json.
 */
function trax_mail_records(array $records): array
{
    return array_map(static function (array $record): array {
        $record['id'] = $record['assetId'];
        return $record;
    }, $records);
}

/**
 * Snapshots what a customer is taking, for their booking record.
 *
 * Taken at creation and never refreshed: checkout.checkin DELETES a line on a
 * full return, so a booking that resolved its items later would show the
 * customer an empty page the moment they handed the gear back.
 *
 * @param array $items      [{assetId, qty, unitNos}], already expanded
 * @param array $setIds     the kits these items were pulled in with
 */
function trax_booking_items(array $items, array $assetsById, array $setIds): array
{
    $lines = [];
    foreach ($items as $item) {
        $assetId = (int)$item['assetId'];
        $viaSet  = null;
        foreach ($setIds as $setId) {
            if (isset($assetsById[$setId]) && trax_set_holds($assetsById[$setId], $assetId)) {
                $viaSet = (int)$setId;
                break;
            }
        }

        $lines[] = [
            'assetId' => $assetId,
            'qty'     => max(1, (int)$item['qty']),
            // Which physical units the customer actually got, when the asset
            // tracks them. The snapshot is what the booking page shows.
            'unitNos' => trax_unit_nos($item['unitNos'] ?? null),
            'name'    => $assetsById[$assetId]['name'] ?? '',
            'setId'   => $viaSet,
            'setName' => $viaSet !== null ? ($assetsById[$viaSet]['name'] ?? '') : '',
        ];
    }
    return $lines;
}

/** Appends a booking and hands it back, so the caller can stamp its id on lines. */
function trax_add_booking(array &$data, array $fields): array
{
    $booking = trax_normalize_booking(array_merge([
        'id'        => trax_next_booking_id($data['bookings']),
        'token'     => trax_new_booking_token(),
        'status'    => 'OPEN',
        'createdAt' => gmdate('Y-m-d\TH:i:s.000\Z'),
    ], $fields));

    $data['bookings'][] = $booking;
    return $booking;
}

/** Finds the open booking a reservation was created with, or null. */
function trax_booking_for_reservation(array $bookings, int $reservationId): ?array
{
    foreach ($bookings as $booking) {
        if ((int)($booking['reservationId'] ?? 0) === $reservationId && $booking['status'] === 'OPEN') {
            return $booking;
        }
    }
    return null;
}

/**
 * lib/mailer.php renders "[ID n] – name" from `id` and `name`. Booking lines
 * key the asset as `assetId`, like everything else written since the rewrite.
 */
function trax_mail_booking_items(array $items): array
{
    return array_map(static fn(array $item): array => [
        'id'   => $item['assetId'],
        'name' => $item['name'],
    ], $items);
}

// ---------------------------------------------------------------------------
// Mail templates
// ---------------------------------------------------------------------------

/**
 * Every {{…}} placeholder in a template, as written.
 *
 * Deliberately not a token-shaped pattern: the renderer is strtr() over exact
 * "{{name}}" strings, so "{{ items }}" and "{{costumerName}}" both render as
 * literal text in the mail. Both have to come back from here to be refused,
 * which means matching what LOOKS like a placeholder, not what is one.
 */
function trax_mail_placeholders(string $text): array
{
    preg_match_all('/\{\{([^{}]*)\}\}/', $text, $matches);
    return array_values(array_unique($matches[1]));
}

/** "{{a}}, {{b}}" — token names as an operator sees them in the editor. */
function trax_mail_token_list(array $names): string
{
    return implode(', ', array_map('trax_mail_token', $names));
}

/**
 * Validates the mail templates a settings patch would leave behind.
 *
 * Checked against the MERGED result, not the patch alone: clearing the body
 * back to the built-in default must not be refused for missing a token the
 * default itself supplies, and editing only the subject must not be judged
 * against a body the patch never touched.
 *
 * @param array $patched  templates as they arrive in the patch
 * @param array $merged   templates as they would be stored
 * @return array<string, array<string,string>>  template key => field => message
 */
function trax_mail_template_errors(array $patched, array $merged): array
{
    $registry = trax_mail_templates();
    $errors   = [];

    foreach ($patched as $key => $entry) {
        $spec = $registry[$key] ?? null;
        if ($spec === null || !is_array($entry)) {
            continue;   // unknown keys are refused by the caller, which can name them
        }

        $known    = array_keys($spec['tokens']);
        $fieldSet = [];

        foreach (['subject', 'body'] as $field) {
            if (!array_key_exists($field, $entry)) {
                continue;
            }
            $fieldSet[] = $field;
            $value = $entry[$field];

            if (!is_string($value)) {
                $errors[$key][$field] = 'This must be text.';
                continue;
            }
            if (trim($value) === '') {
                continue;   // empty means "use the built-in default"
            }

            // A subject becomes a mail header. A newline in one is header
            // injection, and this field is now operator-editable, so it is
            // refused outright rather than silently rewritten — an operator
            // who pasted two lines should be told, not quietly corrected.
            if ($field === 'subject' && preg_match('/[\r\n]/', $value) === 1) {
                $errors[$key][$field] = 'A subject is one line — remove the line break.';
                continue;
            }

            $max = $field === 'subject' ? TRAX_MAX_MAIL_SUBJECT : TRAX_MAX_MAIL_BODY;
            $len = mb_strlen(str_replace("\r\n", "\n", $value));
            if ($len > $max) {
                $errors[$key][$field] = "Too long: {$len} characters, the limit is {$max}.";
                continue;
            }

            // An unknown token renders as literal "{{costumerName}}" text in a
            // mail nobody proof-reads, so it is refused and named here.
            $unknown = array_values(array_diff(trax_mail_placeholders($value), $known));
            if ($unknown !== []) {
                $errors[$key][$field] = 'Unknown token(s): ' . trax_mail_token_list($unknown)
                    . '. This template accepts: ' . trax_mail_token_list($known) . '.';
            }
        }

        if ($fieldSet === [] || isset($errors[$key])) {
            continue;
        }

        // Required tokens are judged on the whole mail — subject and body
        // together — because the lost report carries the asset in its subject.
        $effective = $merged[$key] ?? [];
        $subject   = (string)($effective['subject'] ?? '');
        $body      = (string)($effective['body'] ?? '');
        $whole     = ($subject !== '' ? $subject : $spec['subject'])
            . "\n" . ($body !== '' ? $body : $spec['body']);

        // str_contains, not a pattern: the test has to be "would strtr() replace
        // this", which is an exact-string question.
        $missing = array_values(array_filter(
            $spec['required'],
            static fn(string $name): bool => !str_contains($whole, trax_mail_token($name))
        ));
        if ($missing !== []) {
            $field = in_array('body', $fieldSet, true) ? 'body' : 'subject';
            $errors[$key][$field] = 'Missing required token(s): ' . trax_mail_token_list($missing)
                . '. Without them the mail leaves out something the recipient cannot get anywhere else.';
        }
    }

    return $errors;
}

/**
 * Why settings.branding.whatsapp cannot be saved, or null if it can.
 *
 * Permissive about how a human writes a number and strict about what can come
 * out of it: the accepted forms are exactly those trax_whatsapp_digits() can
 * turn into a wa.me link, so nothing that saves can leave a dead button on the
 * public page. Refused rather than silently corrected, and named field by
 * field, for the same reason a mail template with an unknown token is.
 *
 * An empty value is accepted: it is how an operator turns the button off.
 *
 * A national number ("0172 …") is refused, not accepted with a warning. wa.me
 * has no concept of a local dialling plan — it would build a link to a number
 * in some other country or to nobody — and this form has no channel to show a
 * warning in, so the only honest outcome is to say what is missing.
 */
function trax_whatsapp_error(mixed $value): ?string
{
    if (!is_string($value)) {
        return 'The WhatsApp number must be text.';
    }

    $typed = trax_str($value, 60);
    if ($typed === '') {
        return null;    // cleared on purpose — the page leaves the button out
    }
    if (mb_strlen($typed) > 40) {
        return 'That is longer than any phone number — 40 characters is the limit.';
    }

    // "(0)" is the optional trunk prefix; it is dropped, not rejected.
    $shaped = str_replace('(0)', '', $typed);
    if (preg_match('/^\+?[0-9 ()\/.\-]+$/', $shaped) !== 1) {
        return 'A phone number can only contain digits, spaces and + - ( ) / . — and a + only at the front.';
    }

    $digits = preg_replace('/\D+/', '', $shaped) ?? '';
    if (str_starts_with($digits, '00')) {
        $digits = substr($digits, 2);
    }
    if (str_starts_with($digits, '0')) {
        return 'WhatsApp dials internationally, so it needs the country code: write +49 172 … , not 0172 … .';
    }
    if (strlen($digits) < 7 || strlen($digits) > 15) {
        return 'That is ' . strlen($digits) . ' digit(s); a number with its country code is 7 to 15.';
    }

    // The normaliser is the authority on what can be stored. If the two ever
    // disagree, the save is refused rather than written on a hopeful reading.
    if (trax_whatsapp_digits($typed) === '') {
        return 'That cannot be turned into a WhatsApp number.';
    }
    return null;
}

/** Applies only the asset fields a client is allowed to set. */
function apply_asset_patch(array $asset, array $patch): array
{
    $writable = [
        'name', 'status', 'notes', 'category', 'location',
        'serial', 'supplier', 'purchasedAt', 'price', 'currency',
        'warrantyUntil', 'condition', 'tags', 'members', 'quantity', 'units',
    ];

    foreach ($writable as $field) {
        if (array_key_exists($field, $patch)) {
            $asset[$field] = $patch[$field];
        }
    }

    // id, kind, photo, conditionLog, documents and rev are never client-writable
    // through a patch: each of those names a file the server wrote, so a patch
    // that could set one could point a record at anything on disk.
    return trax_normalize_asset($asset, $asset['id']);
}

/**
 * Resolves a `units` patch against the asset it is being written to.
 *
 * Unit numbers are permanent and never reused: an entry that arrives without
 * one is a NEW unit and gets the next number after everything this asset has
 * ever had. Everything else is matched by number, so renaming unit 12.2 cannot
 * silently become "the second row in the list".
 *
 * @param  array $asset          the asset as it is stored right now
 * @param  mixed $units          the patch's raw `units` value
 * @param  array $linesForAsset  the open checkout lines of THIS asset
 * @param  ?int  $unitSeq        out: the asset's new high-water mark, to store
 * @return array                 the units list to hand to the normaliser
 */
function apply_units_patch(array $asset, mixed $units, array $linesForAsset, ?int &$unitSeq = null): array
{
    if (($asset['kind'] ?? 'ITEM') === 'SET') {
        throw new TraxInvalid('Kits do not have units.');
    }
    if (!is_array($units)) {
        throw new TraxInvalid('Field "units" must be a list of units.');
    }
    if (count($units) > TRAX_MAX_UNITS) {
        throw new TraxInvalid('An asset can track at most ' . TRAX_MAX_UNITS . ' units.');
    }

    $assetId = (int)($asset['id'] ?? 0);

    // The highest number this asset has ever handed out, patch included, so a
    // new row cannot land on a number a printed label already points at. The
    // stored `unitSeq` is what keeps a deleted unit's number retired: without
    // it, deleting 12.3 would hand 12.3 straight to the next unit added.
    $nextNo = max(0, (int)($asset['unitSeq'] ?? 0));
    foreach ((array)($asset['units'] ?? []) as $unit) {
        $nextNo = max($nextNo, (int)($unit['no'] ?? 0));
    }
    foreach ($units as $entry) {
        if (!is_array($entry)) {
            throw new TraxInvalid('Each unit must be an object.');
        }
        $nextNo = max($nextNo, trax_int($entry['no'] ?? null) ?? 0);
    }

    $out  = [];
    $seen = [];
    foreach ($units as $entry) {
        $no = trax_int($entry['no'] ?? null);
        if ($no === null || $no <= 0) {
            $no = ++$nextNo;    // a new unit
        }
        if (isset($seen[$no])) {
            throw new TraxInvalid('Unit ' . trax_unit_code($assetId, $no) . ' is listed twice.');
        }
        $seen[$no]   = true;
        $entry['no'] = $no;
        $out[]       = $entry;
    }

    // A unit that is physically with a customer cannot be deleted from under
    // them — the line naming it would point at a unit that no longer exists.
    foreach (trax_unit_states($asset, $linesForAsset) as $no => $state) {
        if ($state['state'] === 'OUT' && !isset($seen[$no])) {
            throw new TraxInvalid(
                'Unit ' . trax_unit_code($assetId, $no) . ' is checked out and cannot be removed.'
            );
        }
    }

    $unitSeq = $nextNo;
    return $out;
}

/**
 * Decides which physical units of an asset go out on one checkout line.
 *
 * The operator's choice comes first, in full; the rest of the count is filled
 * with the lowest free numbers, so an unchosen checkout is stable and boring.
 * A requested unit that is not free is reported back rather than quietly
 * swapped for another one — "give me the Sommer cable" is not the same request
 * as "give me a cable".
 *
 * @param  array $linesForAsset  the open checkout lines of THIS asset
 * @param  array $requestedNos   the unit numbers the caller asked for
 * @param  int   $take           how many units this line will carry
 * @return array{0:array<int,int>, 1:array<int,int>}  [chosen, unavailable requested]
 */
function trax_pick_units(array $asset, array $linesForAsset, array $requestedNos, int $take): array
{
    $known = array_map(static fn(array $u): int => (int)$u['no'], (array)($asset['units'] ?? []));
    $free  = trax_available_unit_nos($asset, $linesForAsset);

    // A number this asset does not have is not a request for anything.
    $requested = array_values(array_intersect(trax_unit_nos($requestedNos), $known));
    $missing   = array_values(array_diff($requested, $free));
    $chosen    = array_values(array_intersect($requested, $free));

    // More units named than the quantity covers: the lowest named ones win.
    if (count($chosen) > $take) {
        $chosen = array_slice($chosen, 0, max(0, $take));
    }
    foreach ($free as $no) {
        if (count($chosen) >= $take) {
            break;
        }
        if (!in_array($no, $chosen, true)) {
            $chosen[] = $no;
        }
    }
    sort($chosen);

    return [$chosen, $missing];
}

/**
 * Conflict detection, server-side and authoritative, and quantity-aware.
 *
 * An overlapping booking is only a conflict once the units already spoken for
 * plus the units now wanted exceed what the asset actually has. The result
 * reports the shortfall, so the caller can say "3 wanted, 1 free" instead of
 * just "no".
 *
 * @return array{hits:array, quantity:int, reservedQty:int, outQty:int, wanted:int, shortfall:int}
 */
function trax_conflicts_for(int $assetId, int $wantedQty, int $startTs, int $endTs, array $data, array $checkouts, ?int $ignoreReservationId = null): array
{
    $hits        = [];
    $reservedQty = 0;
    $outQty      = 0;

    foreach ($data['reservations'] as $reservation) {
        if ($reservation['status'] !== 'ACTIVE') {
            continue;
        }
        if ($ignoreReservationId !== null && (int)$reservation['id'] === $ignoreReservationId) {
            continue;
        }
        $qty = 0;
        foreach ($reservation['items'] as $item) {
            if ((int)$item['assetId'] === $assetId) {
                $qty += max(1, (int)$item['qty']);
            }
        }
        if ($qty === 0) {
            continue;
        }
        $rStart = trax_parse_datetime($reservation['startAt']);
        $rEnd   = trax_parse_datetime($reservation['endAt']);
        if ($rStart !== null && $rEnd !== null && $startTs < $rEnd && $rStart < $endTs) {
            $reservedQty += $qty;
            $hits[] = [
                'kind'  => 'reservation',
                'refId' => $reservation['id'],
                'qty'   => $qty,
                'who'   => $reservation['customerName'],
                'until' => $reservation['endAt'],
            ];
        }
    }

    foreach ($checkouts as $record) {
        if ((int)$record['assetId'] !== $assetId) {
            continue;
        }
        $cStart = trax_parse_datetime($record['checkedOut']) ?? 0;
        $cEnd   = $record['dueAt'] !== null
            ? (trax_parse_datetime($record['dueAt']) ?? PHP_INT_MAX)
            : PHP_INT_MAX;
        if ($startTs < $cEnd && $cStart < $endTs) {
            $outQty += max(1, (int)$record['qty']);
            $hits[] = [
                'kind'  => 'checkout',
                'refId' => $record['lineId'],
                'qty'   => (int)$record['qty'],
                'who'   => $record['customerName'],
                'until' => $record['returnDate'],
            ];
        }
    }

    $asset    = trax_find_asset($data['assets'], $assetId);
    $quantity = max(1, (int)($asset['quantity'] ?? 1));
    $shortfall = max(0, $reservedQty + $outQty + $wantedQty - $quantity);

    return [
        'hits'        => $shortfall > 0 ? $hits : [],
        'quantity'    => $quantity,
        'reservedQty' => $reservedQty,
        'outQty'      => $outQty,
        'wanted'      => $wantedQty,
        'shortfall'   => $shortfall,
    ];
}

/**
 * After a return, an asset goes back to FREE unless an ACTIVE reservation
 * still covers it. Ported from admin.php:1577.
 */
function trax_status_after_return(int $assetId, array $data, ?int $ignoreReservationId = null): string
{
    foreach ($data['reservations'] as $reservation) {
        if ($reservation['status'] !== 'ACTIVE') {
            continue;
        }
        if ($ignoreReservationId !== null && (int)$reservation['id'] === $ignoreReservationId) {
            continue;
        }
        if (in_array($assetId, $reservation['assetIds'], true)) {
            return 'RSVD';
        }
    }
    return 'FREE';
}

$actor = trax_actor();

// ---------------------------------------------------------------------------
// Read actions
// ---------------------------------------------------------------------------

if ($action === 'bootstrap') {
    $data      = trax_read_data();
    $checkouts = trax_read_checkouts();

    trax_ok(array_merge(trax_snapshot($data, $checkouts), [
        'csrf' => trax_csrf_token(),
        'meta' => [
            'statuses'    => TRAX_STATUSES,
            'conditions'  => TRAX_CONDITIONS,
            'kinds'       => TRAX_ASSET_KINDS,
            'actor'       => $actor,
            'publicPath'  => TRAX_PUBLIC_PATH,
            'maxUpload'   => TRAX_MAX_UPLOAD_BYTES,
            // The mail-template registry: labels, the built-in subject/body,
            // the tokens each one takes and sample values. Shipped rather than
            // duplicated in the client so the token help, the preview and
            // "reset to default" cannot drift from what the server renders.
            'mailTemplates'   => trax_mail_templates(),
            'mailSubjectMax'  => TRAX_MAX_MAIL_SUBJECT,
            'mailBodyMax'     => TRAX_MAX_MAIL_BODY,
        ],
    ]), $data['rev']);
}

/**
 * Who is signed in. The session settled that before a line of this file ran;
 * the action exists so the client can show it and offer a password change.
 *
 * `mode` says which gate let the request in, because the two answers mean
 * different things to the client: in builtin mode the name IS the account whose
 * password the Account section changes, and in external mode it is whoever the
 * include said this is — a name with no users.json record behind it, so the
 * password change has to be told which fallback account it is aimed at.
 */
if ($action === 'auth.me') {
    $mode = trax_auth_mode();
    $me   = trax_current_user();

    if ($me !== null) {
        trax_ok([
            'username' => $me['username'],
            'email'    => $me['email'],
            'mode'     => $mode,
        ]);
    }

    if ($mode === 'external') {
        // Whatever the include left in the session, if it happens to be an
        // address. There is no record to read it from.
        $sessionEmail = is_string($_SESSION['email'] ?? null) ? $_SESSION['email'] : '';

        trax_ok([
            'username' => trax_external_identity(),
            'email'    => trax_str($sessionEmail, TRAX_MAX_NAME),
            'mode'     => 'external',
        ]);
    }

    trax_fail('UNAUTHENTICATED', 'Not signed in.', 401);
}

/**
 * How this installation authenticates: the built-in login, or an external
 * include. Read-only; auth.configUpdate is the write.
 */
if ($action === 'auth.config') {
    trax_ok(trax_auth_config());
}

if (!$isPost) {
    trax_fail('BAD_REQUEST', "Unknown read action \"{$action}\".", 404);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

try {
    switch ($action) {

        // --- Assets --------------------------------------------------------

        case 'asset.create': {
            $patch = is_array($payload['patch'] ?? null) ? $payload['patch'] : [];
            if (trax_str($patch['name'] ?? '', TRAX_MAX_NAME) === '') {
                trax_fail('BAD_REQUEST', 'An asset needs a name.');
            }

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($patch, $actor): array {
                $id    = trax_next_asset_id($data['assets']);
                $fresh = trax_normalize_asset(['id' => $id]);

                // Units are numbered by the server, and the count of them is
                // the quantity — a `quantity` sent alongside is ignored.
                $unitSeq = 0;
                if (array_key_exists('units', $patch)) {
                    $patch['units'] = apply_units_patch($fresh, $patch['units'], [], $unitSeq);
                    if ($patch['units'] !== []) {
                        unset($patch['quantity']);
                    }
                }

                $asset = apply_asset_patch($fresh, $patch);
                $asset['kind']    = 'ITEM';
                $asset['members'] = [];
                // Server-managed, so it is not in the patch whitelist and has
                // to be written on after it.
                $asset['unitSeq'] = max((int)($asset['unitSeq'] ?? 0), (int)$unitSeq);

                $data['assets'][] = $asset;
                trax_append_history($data, 'asset_created', [
                    'assetId' => $id,
                    'note'    => $asset['name'],
                    'actor'   => $actor,
                ]);

                return ['newId' => $id];
            });

            trax_ok(array_merge(
                trax_snapshot($result['data'], $result['checkouts']),
                $result['result']
            ), $result['rev']);
        }

        case 'asset.update': {
            $id    = req_int($payload, 'id');
            $patch = is_array($payload['patch'] ?? null) ? $payload['patch'] : [];

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($id, $patch, $actor): array {
                // Units are matched by number against what is stored, so this
                // has to be resolved before the patch is applied. Once units
                // are listed they ARE the quantity; a `quantity` in the same
                // patch would only disagree with the list.
                $before  = trax_find_asset($data['assets'], $id);
                $unitSeq = 0;
                if ($before !== null && array_key_exists('units', $patch)) {
                    $lines          = trax_group_checkouts_by_asset($checkouts)[$id] ?? [];
                    $patch['units'] = apply_units_patch($before, $patch['units'], $lines, $unitSeq);
                    if ($patch['units'] !== []) {
                        unset($patch['quantity']);
                    }
                }

                $found = trax_update_asset($data, $id, static function (array $asset) use ($patch, $unitSeq): array {
                    $next = apply_asset_patch($asset, $patch);
                    // Server-managed: never in the patch whitelist, and it only
                    // ever goes up, so removing the last unit does not free its
                    // number for the next one.
                    $next['unitSeq'] = max((int)($next['unitSeq'] ?? 0), (int)$unitSeq);
                    return $next;
                });
                if (!$found) {
                    throw new TraxInvalid("Asset #{$id} not found.");
                }

                // A set's membership must still be legal after the patch, and
                // an item may not shrink below what is already out.
                $asset = trax_find_asset($data['assets'], $id);
                if ($asset !== null && $asset['kind'] === 'SET') {
                    trax_assert_valid_set($id, $asset['members'], trax_index_assets($data['assets']));
                }
                if ($asset !== null) {
                    trax_assert_quantity_covers_checkouts($asset, $checkouts);
                }

                trax_append_history($data, 'asset_updated', ['assetId' => $id, 'actor' => $actor]);
                return [];
            });

            trax_ok(trax_snapshot($result['data'], $result['checkouts']), $result['rev']);
        }

        case 'asset.delete': {
            $id = req_int($payload, 'id');

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($id, $actor): array {
                $asset = trax_find_asset($data['assets'], $id);
                if ($asset === null) {
                    throw new TraxInvalid("Asset #{$id} not found.");
                }

                foreach ($checkouts as $record) {
                    if ((int)$record['assetId'] === $id) {
                        throw new TraxInvalid(
                            "\"{$asset['name']}\" is currently checked out to {$record['customerName']}. Check it in first."
                        );
                    }
                }

                // Drop it from every set that contains it, so no set is left
                // pointing at a member that no longer exists.
                foreach ($data['assets'] as $index => $other) {
                    if ($other['kind'] === 'SET' && trax_set_holds($other, $id)) {
                        $data['assets'][$index]['members'] = array_values(array_filter(
                            $other['members'],
                            static fn(array $m): bool => (int)$m['assetId'] !== $id
                        ));
                    }
                }

                $data['assets'] = array_values(array_filter(
                    $data['assets'],
                    static fn(array $a): bool => (int)$a['id'] !== $id
                ));

                trax_append_history($data, 'asset_deleted', [
                    'assetId' => $id,
                    'note'    => $asset['name'],
                    'actor'   => $actor,
                ]);

                // Clean up the photo file, if any.
                if ($asset['photo'] !== null) {
                    @unlink(TRAX_UPLOAD_DIR . '/' . $asset['photo']);
                    @unlink(TRAX_UPLOAD_DIR . '/thumb/' . $asset['photo']);
                }

                // And the condition log, which nothing else points at: the
                // record is going, so its photos would be orphaned bytes.
                foreach ($asset['conditionLog'] ?? [] as $shot) {
                    trax_delete_photo_files((string)$shot['file']);
                }

                // Same for its documents. Nothing sweeps for orphans, and a
                // document nobody can reach through download.php any more is
                // exactly that — bytes leaked for the life of the install.
                foreach ($asset['documents'] ?? [] as $doc) {
                    trax_delete_document_file((string)$doc['file']);
                }

                return [];
            });

            trax_ok(trax_snapshot($result['data'], $result['checkouts']), $result['rev']);
        }

        case 'asset.bulkUpdate': {
            $ids   = req_ids($payload);
            $patch = is_array($payload['patch'] ?? null) ? $payload['patch'] : [];

            $allowed = ['status', 'category', 'location', 'condition', 'supplier', 'quantity'];
            $patch   = array_intersect_key($patch, array_flip($allowed));
            if ($patch === []) {
                trax_fail('BAD_REQUEST', 'Nothing to change.');
            }

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($ids, $patch, $actor): array {
                $changed = 0;
                foreach ($ids as $id) {
                    $asset = trax_find_asset($data['assets'], $id);
                    // Sets derive their status from members, so a bulk status
                    // change must not stamp one onto them.
                    $effective = $patch;
                    if ($asset !== null && $asset['kind'] === 'SET') {
                        unset($effective['status'], $effective['quantity']);
                    }
                    // An asset that tracks its units counts them; a bulk
                    // quantity would be overwritten by the list on write, so
                    // drop it here rather than pretend it was applied.
                    if ($asset !== null && trax_asset_has_units($asset)) {
                        unset($effective['quantity']);
                    }
                    if ($effective === []) {
                        continue;
                    }
                    if (trax_update_asset($data, $id, static fn(array $a): array => apply_asset_patch($a, $effective))) {
                        $changed++;
                        $patched = trax_find_asset($data['assets'], $id);
                        if ($patched !== null) {
                            trax_assert_quantity_covers_checkouts($patched, $checkouts);
                        }
                    }
                }

                trax_append_history($data, 'bulk_update', [
                    'note'  => $changed . ' item(s): ' . implode(', ', array_keys($patch)),
                    'actor' => $actor,
                ]);

                return ['changed' => $changed];
            });

            trax_ok(array_merge(
                trax_snapshot($result['data'], $result['checkouts']),
                $result['result']
            ), $result['rev']);
        }

        case 'asset.uploadPhoto': {
            $id = req_int($payload, 'id');

            if (!isset($_FILES['photo'])) {
                trax_fail('BAD_REQUEST', 'No file was uploaded.');
            }
            $stored = trax_store_photo($id, $_FILES['photo']);

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($id, $stored, $actor): array {
                $asset = trax_find_asset($data['assets'], $id);
                if ($asset === null) {
                    throw new TraxInvalid("Asset #{$id} not found.");
                }

                // Remove the file the new one replaces.
                if ($asset['photo'] !== null && $asset['photo'] !== $stored) {
                    @unlink(TRAX_UPLOAD_DIR . '/' . $asset['photo']);
                    @unlink(TRAX_UPLOAD_DIR . '/thumb/' . $asset['photo']);
                }

                trax_update_asset($data, $id, static function (array $a) use ($stored): array {
                    $a['photo'] = $stored;
                    return $a;
                });

                trax_append_history($data, 'photo_added', ['assetId' => $id, 'actor' => $actor]);
                return ['photo' => $stored];
            });

            trax_ok(array_merge(
                trax_snapshot($result['data'], $result['checkouts']),
                $result['result']
            ), $result['rev']);
        }

        case 'asset.deletePhoto': {
            $id = req_int($payload, 'id');

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($id, $actor): array {
                $asset = trax_find_asset($data['assets'], $id);
                if ($asset === null) {
                    throw new TraxInvalid("Asset #{$id} not found.");
                }
                if ($asset['photo'] !== null) {
                    @unlink(TRAX_UPLOAD_DIR . '/' . $asset['photo']);
                    @unlink(TRAX_UPLOAD_DIR . '/thumb/' . $asset['photo']);
                }

                trax_update_asset($data, $id, static function (array $a): array {
                    $a['photo'] = null;
                    return $a;
                });

                trax_append_history($data, 'photo_removed', ['assetId' => $id, 'actor' => $actor]);
                return [];
            });

            trax_ok(trax_snapshot($result['data'], $result['checkouts']), $result['rev']);
        }

        case 'asset.uploadConditionPhotos': {
            $id   = req_int($payload, 'id');
            $note = trax_str($payload['note'] ?? '');

            if (!isset($_FILES['photos'])) {
                trax_fail('BAD_REQUEST', 'No file was uploaded.');
            }

            // Same order as booking.uploadPhotos, for the same reason: GD reads
            // PHP's temporary uploads, which are gone by the time a deferred
            // write could run. The batch lands on disk first — and if the
            // mutation is then refused, every byte of it is removed again.
            $stored = trax_store_photos($_FILES['photos']);

            try {
                $result = trax_mutate(
                    $clientRev,
                    function (array &$data, array &$checkouts) use ($id, $note, $stored, $actor): array {
                        $asset = trax_find_asset($data['assets'], $id);
                        if ($asset === null) {
                            throw new TraxInvalid("Asset #{$id} not found.");
                        }

                        $already = count($asset['conditionLog'] ?? []);
                        if ($already + count($stored) > TRAX_MAX_ASSET_CONDITION_PHOTOS) {
                            throw new TraxInvalid(
                                'This asset already holds ' . $already . ' condition photo(s); the limit is '
                                . TRAX_MAX_ASSET_CONDITION_PHOTOS . '.'
                            );
                        }

                        // One timestamp for the batch: they were taken while
                        // looking at one item, not at N different moments.
                        $at = gmdate('Y-m-d\TH:i:s.000\Z');
                        trax_update_asset($data, $id, static function (array $a) use ($stored, $at, $note): array {
                            foreach ($stored as $file) {
                                $a['conditionLog'][] = ['file' => $file, 'at' => $at, 'note' => $note];
                            }
                            return $a;
                        });

                        trax_append_history($data, 'condition_photos_added', [
                            'assetId' => $id,
                            'qty'     => count($stored),
                            'note'    => count($stored) . ' condition photo(s)',
                            'actor'   => $actor,
                        ]);

                        return ['id' => $id, 'photos' => $stored];
                    }
                );
            } catch (Throwable $e) {
                foreach ($stored as $file) {
                    trax_delete_photo_files($file);
                }
                throw $e;
            }

            trax_ok(array_merge(
                trax_snapshot($result['data'], $result['checkouts']),
                $result['result']
            ), $result['rev']);
        }

        case 'asset.deleteConditionPhoto': {
            $id   = req_int($payload, 'id');
            $file = trax_photo_name($payload['file'] ?? null);
            if ($file === null) {
                trax_fail('BAD_REQUEST', 'Field "file" must name a stored photo.');
            }

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($id, $file, $actor): array {
                $removed = 0;
                $found   = trax_update_asset($data, $id, static function (array $a) use ($file, &$removed): array {
                    $kept = [];
                    foreach ($a['conditionLog'] as $shot) {
                        if ($shot['file'] === $file) {
                            $removed++;
                            continue;
                        }
                        $kept[] = $shot;
                    }
                    $a['conditionLog'] = $kept;
                    return $a;
                });
                if (!$found) {
                    throw new TraxInvalid("Asset #{$id} not found.");
                }
                if ($removed === 0) {
                    throw new TraxInvalid('That photo is not in this asset\'s condition log.');
                }

                trax_append_history($data, 'condition_photo_removed', [
                    'assetId' => $id,
                    'note'    => 'Condition photo removed',
                    'actor'   => $actor,
                ]);

                return ['id' => $id, 'file' => $file];
            });

            // Unlinked only once the write has committed — a mutation refused as
            // stale must not leave the surviving entry pointing at nothing.
            trax_delete_photo_files($file);

            trax_ok(array_merge(
                trax_snapshot($result['data'], $result['checkouts']),
                $result['result']
            ), $result['rev']);
        }

        case 'asset.uploadDocuments': {
            $id    = req_int($payload, 'id');
            $title = trax_str($payload['title'] ?? '', TRAX_MAX_NAME);

            if (!isset($_FILES['documents'])) {
                trax_fail('BAD_REQUEST', 'No file was uploaded.');
            }

            // Same order as the photo batches, for the same reason: PHP's
            // temporary uploads are gone by the time a deferred write could
            // run, so the bytes land first — and if the mutation is then
            // refused, every one of them is removed again.
            $stored = trax_store_documents($_FILES['documents'], $title);

            try {
                $result = trax_mutate(
                    $clientRev,
                    function (array &$data, array &$checkouts) use ($id, $stored, $actor): array {
                        $asset = trax_find_asset($data['assets'], $id);
                        if ($asset === null) {
                            throw new TraxInvalid("Asset #{$id} not found.");
                        }

                        $already = count($asset['documents'] ?? []);
                        if ($already + count($stored) > TRAX_MAX_ASSET_DOCUMENTS) {
                            throw new TraxInvalid(
                                'This asset already holds ' . $already . ' document(s); the limit is '
                                . TRAX_MAX_ASSET_DOCUMENTS . '.'
                            );
                        }

                        trax_update_asset($data, $id, static function (array $a) use ($stored): array {
                            foreach ($stored as $doc) {
                                $a['documents'][] = $doc;
                            }
                            return $a;
                        });

                        trax_append_history($data, 'documents_added', [
                            'assetId' => $id,
                            'qty'     => count($stored),
                            'note'    => count($stored) . ' document(s)',
                            'actor'   => $actor,
                        ]);

                        return ['id' => $id, 'documents' => array_column($stored, 'file')];
                    }
                );
            } catch (Throwable $e) {
                foreach ($stored as $doc) {
                    trax_delete_document_file((string)$doc['file']);
                }
                throw $e;
            }

            trax_ok(array_merge(
                trax_snapshot($result['data'], $result['checkouts']),
                $result['result']
            ), $result['rev']);
        }

        case 'asset.deleteDocument': {
            $id   = req_int($payload, 'id');
            $file = trax_document_name($payload['file'] ?? null);
            if ($file === null) {
                trax_fail('BAD_REQUEST', 'Field "file" must name a stored document.');
            }

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($id, $file, $actor): array {
                $removed = 0;
                $found   = trax_update_asset($data, $id, static function (array $a) use ($file, &$removed): array {
                    $kept = [];
                    foreach ($a['documents'] as $doc) {
                        if ($doc['file'] === $file) {
                            $removed++;
                            continue;
                        }
                        $kept[] = $doc;
                    }
                    $a['documents'] = $kept;
                    return $a;
                });
                if (!$found) {
                    throw new TraxInvalid("Asset #{$id} not found.");
                }
                if ($removed === 0) {
                    throw new TraxInvalid('That document is not attached to this asset.');
                }

                trax_append_history($data, 'document_removed', [
                    'assetId' => $id,
                    'note'    => 'Document removed',
                    'actor'   => $actor,
                ]);

                return ['id' => $id, 'file' => $file];
            });

            // Unlinked only once the write has committed — a mutation refused as
            // stale must not leave the surviving entry pointing at nothing.
            trax_delete_document_file($file);

            trax_ok(array_merge(
                trax_snapshot($result['data'], $result['checkouts']),
                $result['result']
            ), $result['rev']);
        }

        // --- Sets ----------------------------------------------------------

        case 'set.create': {
            $name    = req_str($payload, 'name', TRAX_MAX_NAME);
            $members = is_array($payload['members'] ?? null) ? $payload['members'] : [];

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($payload, $name, $members, $actor): array {
                $id   = trax_next_asset_id($data['assets']);
                $byId = trax_index_assets($data['assets']);

                $memberIds = trax_parse_members($members);
                trax_assert_valid_set($id, $memberIds, $byId);

                $set = trax_normalize_asset([
                    'id'       => $id,
                    'name'     => $name,
                    'kind'     => 'SET',
                    'members'  => $memberIds,
                    'status'   => 'FREE',
                    'notes'    => $payload['notes'] ?? '',
                    'category' => $payload['category'] ?? '',
                    'location' => $payload['location'] ?? '',
                ]);

                $data['assets'][] = $set;
                trax_append_history($data, 'set_created', [
                    'assetId' => $id,
                    'setId'   => $id,
                    'note'    => $name . ' (' . count($memberIds) . ' items)',
                    'actor'   => $actor,
                ]);

                return ['newId' => $id];
            });

            trax_ok(array_merge(
                trax_snapshot($result['data'], $result['checkouts']),
                $result['result']
            ), $result['rev']);
        }

        case 'set.update': {
            $id    = req_int($payload, 'id');
            $patch = is_array($payload['patch'] ?? null) ? $payload['patch'] : [];

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($id, $patch, $actor): array {
                $set = trax_find_asset($data['assets'], $id);
                if ($set === null || $set['kind'] !== 'SET') {
                    throw new TraxInvalid("Set #{$id} not found.");
                }

                if (array_key_exists('members', $patch)) {
                    $memberIds = trax_parse_members((array)$patch['members']);
                    trax_assert_valid_set($id, $memberIds, trax_index_assets($data['assets']));
                    $patch['members'] = $memberIds;
                }

                trax_update_asset($data, $id, static fn(array $a): array => apply_asset_patch($a, $patch));
                trax_append_history($data, 'set_updated', ['assetId' => $id, 'setId' => $id, 'actor' => $actor]);
                return [];
            });

            trax_ok(trax_snapshot($result['data'], $result['checkouts']), $result['rev']);
        }

        case 'set.delete': {
            $id = req_int($payload, 'id');

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($id, $actor): array {
                $set = trax_find_asset($data['assets'], $id);
                if ($set === null || $set['kind'] !== 'SET') {
                    throw new TraxInvalid("Set #{$id} not found.");
                }

                // Deleting a kit never deletes the gear in it.
                $data['assets'] = array_values(array_filter(
                    $data['assets'],
                    static fn(array $a): bool => (int)$a['id'] !== $id
                ));

                trax_append_history($data, 'set_deleted', [
                    'assetId' => $id,
                    'setId'   => $id,
                    'note'    => $set['name'],
                    'actor'   => $actor,
                ]);

                return [];
            });

            trax_ok(trax_snapshot($result['data'], $result['checkouts']), $result['rev']);
        }

        // --- Checkout ------------------------------------------------------

        case 'checkout.create': {
            $items         = req_items($payload, 'items');
            $customerName  = req_str($payload, 'customerName', TRAX_MAX_NAME);
            $customerEmail = req_email($payload, 'customerEmail');
            $dueAt         = req_iso($payload, 'dueAt');
            $notes         = trax_str($payload['notes'] ?? '');
            $reservationId = trax_int($payload['reservationId'] ?? null);
            $allowPartial  = !empty($payload['allowPartial']);

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use (
                $items, $customerName, $customerEmail, $dueAt, $notes, $reservationId, $allowPartial, $actor
            ): array {
                $byId = trax_index_assets($data['assets']);

                // A set in the basket contributes its members, times how many
                // of the set were asked for.
                [$setIds, ] = trax_partition_ids($items, $byId);
                $wanted     = trax_expand_items($items, $byId);
                if ($wanted === []) {
                    throw new TraxInvalid('Nothing to check out — the selection resolves to no items.');
                }

                // Availability is a count now, not a yes/no: an asset with 8
                // units and 3 out can still hand out 5.
                $linesByAsset = trax_group_checkouts_by_asset($checkouts);
                $blocked      = [];
                $granted      = [];
                foreach ($wanted as $want) {
                    $itemId    = $want['assetId'];
                    $asset     = $byId[$itemId] ?? null;
                    $lines     = $linesByAsset[$itemId] ?? [];
                    // One availability rule for the whole system: hand-blocked
                    // assets, per-unit assets and plain counted ones.
                    $available = $asset === null ? 0 : trax_available_qty_for($asset, $lines);
                    $take      = min($want['qty'], $available);

                    // Which physical units leave. A requested one that is not
                    // free is a shortfall even when some other unit could have
                    // covered the count — the operator asked for THAT cable.
                    [$unitNos, $missingNos] = $asset !== null && trax_asset_has_units($asset)
                        ? trax_pick_units($asset, $lines, $want['unitNos'] ?? [], $take)
                        : [[], []];

                    if ($take < $want['qty'] || $missingNos !== []) {
                        $holder    = $lines[0] ?? null;
                        $blocked[] = [
                            'assetId'   => $itemId,
                            'name'      => $asset['name'] ?? "#{$itemId}",
                            'wanted'    => $want['qty'],
                            'available' => $available,
                            'who'       => $holder['customerName'] ?? '',
                            'until'     => $holder['returnDate'] ?? '',
                            'viaSet'    => trax_blocking_set_name($itemId, $setIds, $byId),
                            // The requested units that cannot go out, so the
                            // client can say which ones rather than "some".
                            'unitNos'   => $missingNos,
                        ];
                    }
                    if ($take > 0) {
                        $granted[] = [
                            'assetId'   => $itemId,
                            'qty'       => $take,
                            'available' => $available,
                            'unitNos'   => $unitNos,
                        ];
                    }
                }

                if ($blocked !== [] && !$allowPartial) {
                    throw new TraxBlocked($blocked);
                }
                if ($granted === []) {
                    // Not necessarily "checked out": a locked or out-of-service
                    // asset is unavailable while sitting on the shelf.
                    throw new TraxInvalid('None of the selected items is available right now.');
                }

                $dueTs      = trax_parse_datetime($dueAt) ?? time();
                $returnDate = trax_format_de($dueTs);
                $now        = gmdate('Y-m-d\TH:i:s.000\Z');
                $nextLineId = trax_next_line_id($checkouts);
                $records    = [];

                // The customer's record of this transaction, with what they
                // actually got snapshotted onto it.
                $booking = trax_add_booking($data, [
                    'kind'          => 'checkout',
                    'reservationId' => $reservationId,
                    'customerName'  => $customerName,
                    'customerEmail' => $customerEmail,
                    'createdAt'     => $now,
                    'dueAt'         => $dueAt,
                    'items'         => trax_booking_items($granted, $byId, $setIds),
                    'notes'         => $notes,
                ]);

                foreach ($granted as $take) {
                    $itemId = $take['assetId'];
                    $asset  = $byId[$itemId] ?? null;

                    // Which basket set, if any, this item came in with.
                    $viaSet = null;
                    foreach ($setIds as $setId) {
                        if (isset($byId[$setId]) && trax_set_holds($byId[$setId], $itemId)) {
                            $viaSet = $setId;
                            break;
                        }
                    }

                    $record = trax_normalize_checkout([
                        'lineId'        => $nextLineId++,
                        'assetId'       => $itemId,
                        'qty'           => $take['qty'],
                        'unitNos'       => $take['unitNos'],
                        'name'          => $asset['name'] ?? '',
                        'checkedOut'    => $now,
                        'returnDate'    => $returnDate,
                        'dueAt'         => $dueAt,
                        'customerName'  => $customerName,
                        'customerEmail' => $customerEmail,
                        'reservationId' => $reservationId,
                        'setId'         => $viaSet,
                        'bookingId'     => $booking['id'],
                        'note'          => $notes,
                    ]);

                    // Append a new line. The old code upserted by asset id,
                    // which silently overwrote whoever already had the asset.
                    $checkouts[] = $record;
                    $records[]   = $record;

                    // Only stamp UNAV once the last unit has left the shelf.
                    if ($take['available'] - $take['qty'] === 0) {
                        trax_update_asset($data, $itemId, static function (array $a): array {
                            $a['status'] = 'UNAV';
                            return $a;
                        });
                    }

                    trax_append_history($data, 'checkout', [
                        'assetId'       => $itemId,
                        'qty'           => $take['qty'],
                        'unitNos'       => $take['unitNos'],
                        'reservationId' => $reservationId,
                        'setId'         => $viaSet,
                        'customerName'  => $customerName,
                        'customerEmail' => $customerEmail,
                        'dueAt'         => $dueAt,
                        'note'          => $notes,
                        'actor'         => $actor,
                    ]);
                }

                return [
                    'records'      => $records,
                    'blocked'      => $blocked,
                    'returnDate'   => $returnDate,
                    'units'        => array_sum(array_column($records, 'qty')),
                    'bookingId'    => $booking['id'],
                    'bookingToken' => $booking['token'],
                ];
            });

            // Mail AFTER the write commits. Previously the write only happened
            // if mail() succeeded, so a mail outage blocked all checkouts.
            $mailed = trax_setting('email.sendCheckoutConfirmation', true)
                ? trax_mail_checkout(
                    $customerName,
                    $customerEmail,
                    $result['result']['returnDate'],
                    $notes,
                    trax_mail_records($result['result']['records']),
                    $result['result']['bookingToken']
                )
                : false;

            trax_ok(array_merge(trax_snapshot($result['data'], $result['checkouts']), [
                'mailed'     => $mailed,
                'bookingId'  => $result['result']['bookingId'],
                'checkedOut' => $result['result']['units'],
                'lines'      => count($result['result']['records']),
                'blocked'    => $result['result']['blocked'],
            ]), $result['rev']);
        }

        case 'checkout.extend': {
            // Lines are the precise selector; assetIds stays supported and
            // extends every open line for those assets.
            $lineIds  = isset($payload['lineIds'])  ? req_ids($payload, 'lineIds')  : [];
            $assetIds = isset($payload['assetIds']) ? req_ids($payload, 'assetIds') : [];
            if ($lineIds === [] && $assetIds === []) {
                trax_fail('BAD_REQUEST', 'Select at least one item.');
            }
            $dueAt = req_iso($payload, 'dueAt');

            $notify = !array_key_exists('notify', $payload) || !empty($payload['notify']);

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($lineIds, $assetIds, $dueAt, $actor): array {
                $dueTs      = trax_parse_datetime($dueAt) ?? time();
                $returnDate = trax_format_de($dueTs);
                $touched    = [];

                foreach ($checkouts as $index => $record) {
                    $selected = in_array((int)$record['lineId'], $lineIds, true)
                        || in_array((int)$record['assetId'], $assetIds, true);
                    if (!$selected) {
                        continue;
                    }
                    $checkouts[$index]['returnDate'] = $returnDate;
                    $checkouts[$index]['dueAt']      = $dueAt;
                    $touched[] = $checkouts[$index];

                    trax_append_history($data, 'extend', [
                        'assetId'       => (int)$record['assetId'],
                        'qty'           => (int)$record['qty'],
                        'customerName'  => $record['customerName'],
                        'customerEmail' => $record['customerEmail'],
                        'dueAt'         => $dueAt,
                        'note'          => 'Extended to ' . $returnDate,
                        'actor'         => $actor,
                    ]);
                }

                if ($touched === []) {
                    throw new TraxInvalid('No open checkout found for the selected items.');
                }

                return ['touched' => $touched, 'returnDate' => $returnDate];
            });

            $mailed = false;
            // The per-request opt-out wins: "notify": false must not be undone
            // by the setting. It was ignored here entirely, so an extend that
            // asked for silence still mailed and still reported mailed:true.
            if ($notify && trax_setting('email.sendExtend', true)) {
                // One mail per customer, not one per line: extending a 3-line
                // kit used to send three near-identical "Asset Return Date
                // Extended" mails. A single call can span customers (lines are
                // picked by lineId, and assetIds extends every open line for an
                // asset), so group first.
                $groups = [];
                foreach (trax_mail_records($result['result']['touched']) as $record) {
                    // Keyed case-insensitively so Max@x.y and max@x.y are one
                    // customer and get one mail, not two.
                    $key = strtolower(trim((string)$record['customerEmail']));
                    if (!isset($groups[$key])) {
                        $groups[$key] = [
                            'name'    => $record['customerName'],
                            'email'   => $record['customerEmail'],
                            'records' => [],
                        ];
                    }
                    $groups[$key]['records'][] = $record;
                }

                // One request carries one dueAt, applied to every line it
                // touches, so the whole group shares the date in the heading.
                foreach ($groups as $group) {
                    $mailed = trax_mail_extend(
                        $group['name'],
                        $group['email'],
                        $group['records'],
                        $result['result']['returnDate']
                    ) || $mailed;
                }
            }

            trax_ok(array_merge(trax_snapshot($result['data'], $result['checkouts']), [
                'mailed'   => $mailed,
                'extended' => array_sum(array_column($result['result']['touched'], 'qty')),
                'lines'    => count($result['result']['touched']),
            ]), $result['rev']);
        }

        case 'checkout.checkin': {
            // lines: [{"lineId":12,"qty":1}] — an omitted qty returns the whole
            // line, and "unitNos":[3] returns exactly those units of it.
            // units: [{"assetId":12,"no":3}] returns one scanned unit wherever
            // it is out. assetIds stays supported and returns every line for
            // those assets in full.
            $lineRequests = [];
            if (isset($payload['lines']) && is_array($payload['lines'])) {
                foreach ($payload['lines'] as $entry) {
                    if (is_array($entry)) {
                        $lineId  = trax_int($entry['lineId'] ?? null);
                        $qty     = trax_int($entry['qty'] ?? null);
                        $unitNos = trax_unit_nos($entry['unitNos'] ?? null);
                    } else {
                        $lineId  = trax_int($entry);
                        $qty     = null;
                        $unitNos = [];
                    }
                    if ($lineId !== null && $lineId > 0) {
                        $lineRequests[$lineId] = [
                            'qty'     => $qty !== null && $qty > 0 ? $qty : null,
                            'unitNos' => $unitNos,
                        ];
                    }
                }
            }

            // Scanning a unit label in return mode: the client knows which
            // piece of gear is in its hand, not which line it left on.
            $unitRequests = [];
            if (isset($payload['units']) && is_array($payload['units'])) {
                foreach ($payload['units'] as $entry) {
                    if (!is_array($entry)) {
                        continue;
                    }
                    $assetId = trax_int($entry['assetId'] ?? null);
                    $no      = trax_int($entry['no'] ?? null);
                    if ($assetId !== null && $assetId > 0 && $no !== null && $no > 0) {
                        $unitRequests[] = ['assetId' => $assetId, 'no' => $no];
                    }
                }
            }

            $assetIds = isset($payload['assetIds']) ? req_ids($payload, 'assetIds') : [];
            if ($lineRequests === [] && $assetIds === [] && $unitRequests === []) {
                trax_fail('BAD_REQUEST', 'Select at least one item.');
            }

            // A pure scan: the operator held labels under the camera and named
            // no line and no asset. That shape may legitimately return nothing.
            $scanOnly = $lineRequests === [] && $assetIds === [];

            $notify = !array_key_exists('notify', $payload) || !empty($payload['notify']);

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($lineRequests, $assetIds, $unitRequests, $scanOnly, $actor): array {
                $returned = [];
                $kept     = [];
                $scanHit  = [];   // which scanned units were found on a line

                foreach ($checkouts as $record) {
                    $lineId     = (int)$record['lineId'];
                    $lineNos    = trax_unit_nos($record['unitNos'] ?? null);
                    $take       = null;
                    $takeNos    = [];

                    if (array_key_exists($lineId, $lineRequests)) {
                        $request = $lineRequests[$lineId];
                        if ($lineNos !== [] && $request['unitNos'] !== []) {
                            // Naming units is the precise form of the request:
                            // exactly those come back, and they have to be on
                            // this line.
                            foreach ($request['unitNos'] as $no) {
                                if (!in_array($no, $lineNos, true)) {
                                    throw new TraxInvalid(
                                        'Unit ' . trax_unit_code((int)$record['assetId'], $no)
                                        . ' is not on this checkout.'
                                    );
                                }
                            }
                            $takeNos = $request['unitNos'];
                            $take    = count($takeNos);
                        } else {
                            $take = $request['qty'] ?? (int)$record['qty'];
                        }
                    } elseif (in_array((int)$record['assetId'], $assetIds, true)) {
                        $take = (int)$record['qty'];
                    }

                    // A scanned unit returns itself, whatever else this line
                    // was asked for. First open line naming it wins.
                    foreach ($unitRequests as $i => $unitRequest) {
                        if (isset($scanHit[$i])
                            || $unitRequest['assetId'] !== (int)$record['assetId']
                            || !in_array($unitRequest['no'], $lineNos, true)) {
                            continue;
                        }
                        $scanHit[$i] = true;
                        if (!in_array($unitRequest['no'], $takeNos, true)) {
                            $takeNos[] = $unitRequest['no'];
                        }
                        $take = $take ?? 0;
                    }

                    if ($take === null) {
                        $kept[] = $record;
                        continue;
                    }

                    // On a unit-tracking line the numbers decide the count: an
                    // unnamed partial return hands back the first ones out.
                    if ($lineNos !== []) {
                        if ($takeNos === []) {
                            $takeNos = array_slice($lineNos, 0, max(0, $take));
                        }
                        sort($takeNos);
                        $take = count($takeNos);
                    }

                    // Returning part of a line decrements it; returning all of
                    // it drops the line.
                    $take = min($take, (int)$record['qty']);
                    if ($take <= 0) {
                        $kept[] = $record;
                        continue;
                    }

                    $slip            = $record;
                    $slip['qty']     = $take;
                    $slip['unitNos'] = $takeNos;
                    $returned[]      = $slip;

                    if ($take < (int)$record['qty']) {
                        $record['qty']    -= $take;
                        $record['unitNos'] = array_values(array_diff($lineNos, $takeNos));
                        $kept[]            = $record;
                    }
                }

                // Scanned units nothing had out. Not an error: the operator
                // scanned a label, and "that one is already back" is an answer.
                $notOut = [];
                foreach ($unitRequests as $i => $unitRequest) {
                    if (!isset($scanHit[$i])) {
                        $notOut[] = $unitRequest;
                    }
                }

                if ($returned === []) {
                    // Every scanned unit was already back. Saying so is the
                    // answer to the question the operator asked; nothing is
                    // written and nobody is mailed. Only a request that also
                    // named lines or assets is a mistake worth a 400.
                    if (!$scanOnly) {
                        throw new TraxInvalid('No open checkout found for the selected items.');
                    }
                    return ['returned' => [], 'closedBookings' => [], 'notOut' => $notOut];
                }

                $checkouts = $kept;

                foreach ($returned as $record) {
                    trax_append_history($data, 'checkin', [
                        'assetId'       => (int)$record['assetId'],
                        'qty'           => (int)$record['qty'],
                        'unitNos'       => $record['unitNos'] ?? [],
                        'reservationId' => $record['reservationId'],
                        'setId'         => $record['setId'],
                        'customerName'  => $record['customerName'],
                        'customerEmail' => $record['customerEmail'],
                        'note'          => 'Returned',
                        'actor'         => $actor,
                    ]);
                }

                // Only lift UNAV once a unit is actually back on the shelf.
                $linesByAsset = trax_group_checkouts_by_asset($checkouts);
                foreach (array_unique(array_map('intval', array_column($returned, 'assetId'))) as $assetId) {
                    $asset = trax_find_asset($data['assets'], $assetId);
                    if ($asset === null) {
                        continue;
                    }
                    $quantity  = max(1, (int)$asset['quantity']);
                    $available = max(0, $quantity - trax_lines_qty($linesByAsset[$assetId] ?? []));
                    if ($available > 0) {
                        trax_update_asset($data, $assetId, static function (array $a) use ($assetId, $data): array {
                            $a['status'] = trax_status_after_return($assetId, $data);
                            return $a;
                        });
                    }
                }

                // A reservation completes once no unit of its assets is out.
                foreach ($data['reservations'] as $index => $reservation) {
                    if ($reservation['status'] !== 'CONVERTED') {
                        continue;
                    }
                    $stillOut = 0;
                    foreach ($reservation['items'] as $item) {
                        $stillOut += trax_out_qty((int)$item['assetId'], $checkouts);
                    }
                    if ($stillOut === 0) {
                        $data['reservations'][$index]['status']      = 'COMPLETED';
                        $data['reservations'][$index]['completedAt'] = gmdate('Y-m-d\TH:i:s.000\Z');
                    }
                }

                // Same pass, same question one level up: a customer's booking
                // is done once the last of ITS lines is back. Only the bookings
                // this return touched are considered.
                $closed = trax_close_returned_bookings($data, $returned, $checkouts);

                return ['returned' => $returned, 'closedBookings' => $closed, 'notOut' => $notOut];
            });

            // The per-request opt-out wins: "notify": false must not be undone
            // by a settings-level opt-in.
            $mailed = false;
            if ($notify && trax_setting('email.sendCheckin', true)) {
                // One mail per customer, not one per line: returning a 5-item
                // kit used to send five near-identical "Asset Returned" mails.
                // A single call can span customers (lines are picked by lineId,
                // and assetIds returns every line for an asset), so group first.
                $groups = [];
                foreach (trax_mail_records($result['result']['returned']) as $record) {
                    // Keyed case-insensitively so Max@x.y and max@x.y are one
                    // customer and get one mail, not two.
                    $key = strtolower(trim((string)$record['customerEmail']));
                    if (!isset($groups[$key])) {
                        $groups[$key] = [
                            'name'    => $record['customerName'],
                            'email'   => $record['customerEmail'],
                            'records' => [],
                        ];
                    }
                    $groups[$key]['records'][] = $record;
                }

                // What each of them still has out, from the checkout state this
                // mutation already left behind — no second read.
                $stillOut = [];
                foreach ($result['checkouts'] as $line) {
                    $key = strtolower(trim((string)($line['customerEmail'] ?? '')));
                    $stillOut[$key] = ($stillOut[$key] ?? 0) + max(1, (int)($line['qty'] ?? 1));
                }

                foreach ($groups as $key => $group) {
                    $mailed = trax_mail_checkin(
                        $group['name'],
                        $group['email'],
                        $group['records'],
                        $stillOut[$key] ?? 0
                    ) || $mailed;
                }
            }

            trax_ok(array_merge(trax_snapshot($result['data'], $result['checkouts']), [
                'mailed'         => $mailed,
                'returned'       => array_sum(array_column($result['result']['returned'], 'qty')),
                'lines'          => count($result['result']['returned']),
                'closedBookings' => $result['result']['closedBookings'],
                // Units the client scanned that were not out on any line.
                'notOut'         => $result['result']['notOut'],
            ]), $result['rev']);
        }

        // --- Reservations --------------------------------------------------

        case 'reservation.create': {
            $items         = req_items($payload, 'items');
            $customerName  = req_str($payload, 'customerName', TRAX_MAX_NAME);
            $customerEmail = req_email($payload, 'customerEmail');
            $startAt       = req_iso($payload, 'startAt');
            $endAt         = req_iso($payload, 'endAt');
            $notes         = trax_str($payload['notes'] ?? '');
            $force         = !empty($payload['force']);

            $startTs = trax_parse_datetime($startAt);
            $endTs   = trax_parse_datetime($endAt);
            if ($startTs === null || $endTs === null || $startTs >= $endTs) {
                trax_fail('BAD_REQUEST', 'The end of the window must be after its start.');
            }

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use (
                $items, $customerName, $customerEmail, $startAt, $endAt, $startTs, $endTs, $notes, $force, $actor
            ): array {
                $byId          = trax_index_assets($data['assets']);
                [$setIds, ]    = trax_partition_ids($items, $byId);
                $wanted        = trax_expand_items($items, $byId);

                if ($wanted === []) {
                    throw new TraxInvalid('Nothing to reserve — the selection resolves to no items.');
                }

                $conflicts = [];
                foreach ($wanted as $want) {
                    $itemId = $want['assetId'];
                    $report = trax_conflicts_for($itemId, $want['qty'], $startTs, $endTs, $data, $checkouts);
                    if ($report['shortfall'] > 0) {
                        $conflicts[] = [
                            'assetId'   => $itemId,
                            'name'      => $byId[$itemId]['name'] ?? "#{$itemId}",
                            'wanted'    => $report['wanted'],
                            'available' => max(0, $report['quantity'] - $report['reservedQty'] - $report['outQty']),
                            'shortfall' => $report['shortfall'],
                            'hits'      => $report['hits'],
                        ];
                    }
                }

                if ($conflicts !== [] && !$force) {
                    throw new TraxBlocked($conflicts);
                }

                $reservation = trax_normalize_reservation([
                    'id'            => trax_next_reservation_id($data['reservations']),
                    'items'         => $wanted,
                    'setIds'        => $setIds,
                    'customerName'  => $customerName,
                    'customerEmail' => $customerEmail,
                    'startAt'       => $startAt,
                    'endAt'         => $endAt,
                    'status'        => 'ACTIVE',
                    'notes'         => $notes,
                    'createdAt'     => gmdate('Y-m-d\TH:i:s.000\Z'),
                ]);

                $data['reservations'][] = $reservation;

                // The customer's own record of the booking, with its items
                // snapshotted the same way a checkout's are.
                $booking = trax_add_booking($data, [
                    'kind'          => 'reservation',
                    'reservationId' => $reservation['id'],
                    'customerName'  => $customerName,
                    'customerEmail' => $customerEmail,
                    'createdAt'     => $reservation['createdAt'],
                    'startAt'       => $startAt,
                    'dueAt'         => $endAt,
                    'items'         => trax_booking_items($reservation['items'], $byId, $setIds),
                    'notes'         => $notes,
                ]);

                // Iterated over `items`, not the derived `assetIds`, so the
                // history entry can carry how many units were booked.
                foreach ($reservation['items'] as $item) {
                    $itemId = (int)$item['assetId'];
                    trax_update_asset($data, $itemId, static function (array $a): array {
                        if ($a['status'] === 'FREE') {
                            $a['status'] = 'RSVD';
                        }
                        return $a;
                    });

                    trax_append_history($data, 'reservation_created', [
                        'assetId'       => $itemId,
                        'qty'           => max(1, (int)$item['qty']),
                        'reservationId' => $reservation['id'],
                        'customerName'  => $customerName,
                        'customerEmail' => $customerEmail,
                        'dueAt'         => $endAt,
                        'note'          => $notes,
                        'actor'         => $actor,
                    ]);
                }

                return [
                    'reservationId' => $reservation['id'],
                    'conflicts'     => $conflicts,
                    'bookingId'     => $booking['id'],
                    'bookingToken'  => $booking['token'],
                    'bookingItems'  => $booking['items'],
                ];
            });

            // Reservations used to send nothing at all. Mail AFTER the commit,
            // like every other send here.
            $mailed = trax_setting('email.sendReservationConfirmation', true)
                ? trax_mail_reservation(
                    $customerName,
                    $customerEmail,
                    trax_format_de($startTs),
                    trax_format_de($endTs),
                    $notes,
                    trax_mail_booking_items($result['result']['bookingItems']),
                    $result['result']['bookingToken']
                )
                : false;

            trax_ok(array_merge(
                trax_snapshot($result['data'], $result['checkouts']),
                [
                    'reservationId' => $result['result']['reservationId'],
                    'conflicts'     => $result['result']['conflicts'],
                    'bookingId'     => $result['result']['bookingId'],
                    'mailed'        => $mailed,
                ]
            ), $result['rev']);
        }

        case 'reservation.convert': {
            $id           = req_int($payload, 'id');
            $allowPartial = !empty($payload['allowPartial']);
            $overrideDue  = trax_iso($payload['dueAt'] ?? null);

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($id, $overrideDue, $allowPartial, $actor): array {
                $index = null;
                foreach ($data['reservations'] as $i => $reservation) {
                    if ((int)$reservation['id'] === $id) {
                        $index = $i;
                        break;
                    }
                }
                if ($index === null) {
                    throw new TraxInvalid("Reservation #{$id} not found.");
                }

                $reservation = $data['reservations'][$index];
                if ($reservation['status'] !== 'ACTIVE') {
                    throw new TraxInvalid('Only active reservations can be converted.');
                }

                $dueAt = $overrideDue ?? $reservation['endAt'];
                $dueTs = trax_parse_datetime($dueAt);
                if ($dueTs === null) {
                    throw new TraxInvalid('The reservation has no usable end date.');
                }
                $returnDate = trax_format_de($dueTs);

                $byId         = trax_index_assets($data['assets']);
                $linesByAsset = trax_group_checkouts_by_asset($checkouts);
                $blocked      = [];
                $granted      = [];
                foreach ($reservation['items'] as $item) {
                    $assetId   = (int)$item['assetId'];
                    $asset     = $byId[$assetId] ?? null;
                    $lines     = $linesByAsset[$assetId] ?? [];
                    // The same availability rule checkout.create uses.
                    $available = $asset === null ? 0 : trax_available_qty_for($asset, $lines);
                    $take      = min(max(1, (int)$item['qty']), $available);

                    // A reservation is product-level: nothing on it names a
                    // unit, so conversion takes the lowest free ones.
                    [$unitNos, ] = $asset !== null && trax_asset_has_units($asset)
                        ? trax_pick_units($asset, $lines, [], $take)
                        : [[], []];

                    if ($take < max(1, (int)$item['qty'])) {
                        $holder    = $lines[0] ?? null;
                        $blocked[] = [
                            'assetId'   => $assetId,
                            'name'      => $asset['name'] ?? "#{$assetId}",
                            'wanted'    => max(1, (int)$item['qty']),
                            'available' => $available,
                            'who'       => $holder['customerName'] ?? '',
                            'until'     => $holder['returnDate'] ?? '',
                            'unitNos'   => [],
                        ];
                    }
                    if ($take > 0) {
                        $granted[] = [
                            'assetId'   => $assetId,
                            'qty'       => $take,
                            'available' => $available,
                            'unitNos'   => $unitNos,
                        ];
                    }
                }
                if ($blocked !== [] && !$allowPartial) {
                    throw new TraxBlocked($blocked);
                }
                if ($granted === []) {
                    throw new TraxInvalid('Every asset on this reservation is already checked out.');
                }

                $now        = gmdate('Y-m-d\TH:i:s.000\Z');
                $records    = [];
                $nextLineId = trax_next_line_id($checkouts);

                // A reservation made since bookings exist already has one; the
                // lines join it, so returning the gear closes the customer's
                // link. A reservation older than this feature has none — see
                // below.
                $booking = trax_booking_for_reservation($data['bookings'], (int)$reservation['id']);

                // The booking still carries the RESERVED end date. When the
                // operator overrides the due date at conversion, the lines get
                // the new one and the booking kept the old — so the customer's
                // page showed the wrong date and cron.php would remind against
                // it. Move the booking onto the date the gear is actually due.
                if ($booking !== null && $dueAt !== $booking['dueAt']) {
                    trax_update_booking($data, (int)$booking['id'], static function (array $b) use ($dueAt): array {
                        $b['dueAt'] = $dueAt;
                        return $b;
                    });
                    $booking['dueAt'] = $dueAt;
                }

                // A reservation from before the feature has no booking, and
                // conversion made none either: the lines came out with no
                // booking to belong to and the checkout confirmation with no
                // link in it at all — the customer got a mail about gear they
                // had no page for. Give it the record checkout.create would
                // have written, so this hand-over is a checkout like any other.
                if ($booking === null) {
                    $booking = trax_add_booking($data, [
                        'kind'          => 'checkout',
                        'reservationId' => (int)$reservation['id'],
                        'customerName'  => $reservation['customerName'],
                        'customerEmail' => $reservation['customerEmail'],
                        'createdAt'     => $now,
                        'dueAt'         => $dueAt,
                        'items'         => trax_booking_items($granted, $byId, $reservation['setIds']),
                        'notes'         => $reservation['notes'],
                    ]);
                }

                // The booking was snapshotted when the reservation was made,
                // product-level and unit-less. The units exist now, so the
                // customer's own record gets them too — otherwise their page
                // says "2 × DI box" while the counter knows it is 16.1 and 16.2.
                $assignedNos = [];
                foreach ($granted as $take) {
                    if ($take['unitNos'] !== []) {
                        $assignedNos[$take['assetId']] = $take['unitNos'];
                    }
                }
                if ($assignedNos !== [] && $booking !== null) {
                    trax_update_booking($data, (int)$booking['id'], static function (array $b) use ($assignedNos): array {
                        foreach ($b['items'] as $i => $item) {
                            $assetId = (int)($item['assetId'] ?? 0);
                            if (isset($assignedNos[$assetId])) {
                                $b['items'][$i]['unitNos'] = $assignedNos[$assetId];
                            }
                        }
                        return $b;
                    });
                }

                foreach ($granted as $take) {
                    $assetId = $take['assetId'];
                    $viaSet  = null;
                    foreach ($reservation['setIds'] as $setId) {
                        if (isset($byId[$setId]) && trax_set_holds($byId[$setId], $assetId)) {
                            $viaSet = $setId;
                            break;
                        }
                    }

                    $record = trax_normalize_checkout([
                        'lineId'        => $nextLineId++,
                        'assetId'       => $assetId,
                        'qty'           => $take['qty'],
                        'unitNos'       => $take['unitNos'],
                        'name'          => $byId[$assetId]['name'] ?? '',
                        'checkedOut'    => $now,
                        'returnDate'    => $returnDate,
                        'dueAt'         => $dueAt,
                        'customerName'  => $reservation['customerName'],
                        'customerEmail' => $reservation['customerEmail'],
                        'reservationId' => $reservation['id'],
                        'setId'         => $viaSet,
                        'bookingId'     => $booking['id'] ?? null,
                        'note'          => $reservation['notes'],
                    ]);

                    $checkouts[] = $record;
                    $records[]   = $record;

                    if ($take['available'] - $take['qty'] === 0) {
                        trax_update_asset($data, $assetId, static function (array $a): array {
                            $a['status'] = 'UNAV';
                            return $a;
                        });
                    }

                    trax_append_history($data, 'checkout', [
                        'assetId'       => $assetId,
                        'qty'           => $take['qty'],
                        'unitNos'       => $take['unitNos'],
                        'reservationId' => $reservation['id'],
                        'setId'         => $viaSet,
                        'customerName'  => $reservation['customerName'],
                        'customerEmail' => $reservation['customerEmail'],
                        'dueAt'         => $dueAt,
                        'note'          => 'Converted from reservation',
                        'actor'         => $actor,
                    ]);
                }

                $data['reservations'][$index]['status']      = 'CONVERTED';
                $data['reservations'][$index]['convertedAt'] = $now;

                return [
                    'records'      => $records,
                    'blocked'      => $blocked,
                    'returnDate'   => $returnDate,
                    'customer'     => [$reservation['customerName'], $reservation['customerEmail']],
                    'notes'        => $reservation['notes'],
                    'units'        => array_sum(array_column($records, 'qty')),
                    'bookingToken' => $booking['token'] ?? null,
                ];
            });

            // A conversion sends the checkout confirmation, so it follows the
            // checkout toggle.
            [$name, $email] = $result['result']['customer'];
            $mailed = trax_setting('email.sendCheckoutConfirmation', true)
                ? trax_mail_checkout(
                    $name,
                    $email,
                    $result['result']['returnDate'],
                    $result['result']['notes'],
                    trax_mail_records($result['result']['records']),
                    $result['result']['bookingToken']
                )
                : false;

            trax_ok(array_merge(trax_snapshot($result['data'], $result['checkouts']), [
                'mailed'     => $mailed,
                'checkedOut' => $result['result']['units'],
                'lines'      => count($result['result']['records']),
                'blocked'    => $result['result']['blocked'],
            ]), $result['rev']);
        }

        case 'reservation.cancel': {
            $id = req_int($payload, 'id');

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($id, $actor): array {
                $index = null;
                foreach ($data['reservations'] as $i => $reservation) {
                    if ((int)$reservation['id'] === $id) {
                        $index = $i;
                        break;
                    }
                }
                if ($index === null) {
                    throw new TraxInvalid("Reservation #{$id} not found.");
                }
                if ($data['reservations'][$index]['status'] !== 'ACTIVE') {
                    throw new TraxInvalid('Only active reservations can be cancelled.');
                }

                $reservation = $data['reservations'][$index];
                $data['reservations'][$index]['status']      = 'CANCELLED';
                $data['reservations'][$index]['cancelledAt'] = gmdate('Y-m-d\TH:i:s.000\Z');

                // The customer's link follows the reservation it stands for.
                foreach ($data['bookings'] as $bIndex => $booking) {
                    if ((int)($booking['reservationId'] ?? 0) === $id && $booking['status'] === 'OPEN') {
                        $data['bookings'][$bIndex]['status'] = 'CANCELLED';
                    }
                }

                $byId         = trax_index_assets($data['assets']);
                $linesByAsset = trax_group_checkouts_by_asset($checkouts);
                foreach ($reservation['items'] as $item) {
                    $assetId = (int)$item['assetId'];
                    // Release the reserved units, but don't free an asset that
                    // has no unit physically on the shelf.
                    $quantity = max(1, (int)($byId[$assetId]['quantity'] ?? 1));
                    if ($quantity - trax_lines_qty($linesByAsset[$assetId] ?? []) <= 0) {
                        continue;
                    }
                    trax_update_asset($data, $assetId, static function (array $a) use ($assetId, $data, $id): array {
                        if ($a['status'] === 'RSVD') {
                            $a['status'] = trax_status_after_return((int)$assetId, $data, $id);
                        }
                        return $a;
                    });

                    trax_append_history($data, 'reservation_cancelled', [
                        'assetId'       => (int)$assetId,
                        'qty'           => max(1, (int)$item['qty']),
                        'reservationId' => $id,
                        'customerName'  => $reservation['customerName'],
                        'customerEmail' => $reservation['customerEmail'],
                        'actor'         => $actor,
                    ]);
                }

                return [];
            });

            trax_ok(trax_snapshot($result['data'], $result['checkouts']), $result['rev']);
        }

        // --- Bookings ------------------------------------------------------

        case 'booking.resend': {
            $id = req_int($payload, 'id');

            $data      = trax_read_data();
            $checkouts = trax_read_checkouts();

            $booking = null;
            foreach ($data['bookings'] as $row) {
                if ((int)$row['id'] === $id) {
                    $booking = $row;
                    break;
                }
            }
            if ($booking === null) {
                trax_fail('BAD_REQUEST', "Booking #{$id} not found.", 404);
            }

            $dueTs   = $booking['dueAt'] !== null ? trax_parse_datetime($booking['dueAt']) : null;
            $startTs = $booking['startAt'] !== null ? trax_parse_datetime($booking['startAt']) : null;
            $records = trax_mail_booking_items($booking['items']);

            // Operator-initiated, so it is not gated by the per-event toggles:
            // those govern the automatic sends, and this one was asked for.
            $mailed = $booking['kind'] === 'reservation'
                ? trax_mail_reservation(
                    $booking['customerName'],
                    $booking['customerEmail'],
                    $startTs !== null ? trax_format_de($startTs) : '',
                    $dueTs !== null ? trax_format_de($dueTs) : '',
                    $booking['notes'],
                    $records,
                    $booking['token']
                )
                : trax_mail_checkout(
                    $booking['customerName'],
                    $booking['customerEmail'],
                    $dueTs !== null ? trax_format_de($dueTs) : '',
                    $booking['notes'],
                    $records,
                    $booking['token']
                );

            trax_ok(array_merge(trax_snapshot($data, $checkouts), [
                'mailed'    => $mailed,
                'bookingId' => $booking['id'],
            ]), $data['rev']);
        }

        case 'booking.uploadPhotos': {
            $bookingId = req_int($payload, 'bookingId');
            $assetId   = trax_int($payload['assetId'] ?? null);
            $note      = trax_str($payload['note'] ?? '');

            if (!isset($_FILES['photos'])) {
                trax_fail('BAD_REQUEST', 'No file was uploaded.');
            }

            // The files must be written before the lock is taken: GD reads
            // PHP's temporary uploads, which are gone by the time a deferred
            // write could run. So the batch lands on disk first — and if the
            // mutation is then refused, every byte of it is removed again.
            $stored = trax_store_photos($_FILES['photos']);

            try {
                $result = trax_mutate(
                    $clientRev,
                    function (array &$data, array &$checkouts) use ($bookingId, $assetId, $note, $stored, $actor): array {
                        $found = trax_update_booking(
                            $data,
                            $bookingId,
                            static function (array $booking) use ($assetId, $note, $stored): array {
                                $already = count($booking['photos'] ?? []);
                                if ($already + count($stored) > TRAX_MAX_BOOKING_PHOTOS) {
                                    throw new TraxInvalid(
                                        'This booking already holds ' . $already . ' photo(s); the limit is '
                                        . TRAX_MAX_BOOKING_PHOTOS . '.'
                                    );
                                }

                                // One timestamp for the batch: they were taken
                                // in one handover, not at N different moments.
                                $at = gmdate('Y-m-d\TH:i:s.000\Z');
                                foreach ($stored as $file) {
                                    $booking['photos'][] = [
                                        'file'    => $file,
                                        'at'      => $at,
                                        'assetId' => $assetId,
                                        'note'    => $note,
                                    ];
                                }
                                return $booking;
                            }
                        );
                        if (!$found) {
                            throw new TraxInvalid("Booking #{$bookingId} not found.");
                        }

                        // A history entry is a fixed literal, so which booking
                        // this was goes in the note — the only field that can
                        // carry it without being discarded on normalization.
                        trax_append_history($data, 'booking_photos_added', [
                            'assetId' => $assetId,
                            'qty'     => count($stored),
                            'note'    => count($stored) . ' condition photo(s) on booking #' . $bookingId,
                            'actor'   => $actor,
                        ]);

                        return ['bookingId' => $bookingId, 'photos' => $stored];
                    }
                );
            } catch (Throwable $e) {
                foreach ($stored as $file) {
                    trax_delete_photo_files($file);
                }
                throw $e;
            }

            trax_ok(array_merge(
                trax_snapshot($result['data'], $result['checkouts']),
                $result['result']
            ), $result['rev']);
        }

        case 'booking.deletePhoto': {
            $bookingId = req_int($payload, 'bookingId');
            $file      = trax_photo_name($payload['file'] ?? null);
            if ($file === null) {
                trax_fail('BAD_REQUEST', 'Field "file" must name a stored photo.');
            }

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($bookingId, $file, $actor): array {
                $removed = 0;
                $found   = trax_update_booking($data, $bookingId, static function (array $booking) use ($file, &$removed): array {
                    $kept = [];
                    foreach ($booking['photos'] as $photo) {
                        if ($photo['file'] === $file) {
                            $removed++;
                            continue;
                        }
                        $kept[] = $photo;
                    }
                    $booking['photos'] = $kept;
                    return $booking;
                });
                if (!$found) {
                    throw new TraxInvalid("Booking #{$bookingId} not found.");
                }
                if ($removed === 0) {
                    throw new TraxInvalid('That photo is not on this booking.');
                }

                trax_append_history($data, 'booking_photo_removed', [
                    'note'  => 'Condition photo removed from booking #' . $bookingId,
                    'actor' => $actor,
                ]);

                return ['bookingId' => $bookingId, 'file' => $file];
            });

            // Unlinked only once the write has committed. A mutation refused as
            // stale must not leave the surviving record pointing at a file that
            // is already gone — a broken image on the customer's page.
            trax_delete_photo_files($file);

            trax_ok(array_merge(
                trax_snapshot($result['data'], $result['checkouts']),
                $result['result']
            ), $result['rev']);
        }

        // --- Settings ------------------------------------------------------

        case 'settings.update': {
            $patch = is_array($payload['patch'] ?? null) ? $payload['patch'] : [];
            if ($patch === []) {
                trax_fail('BAD_REQUEST', 'Nothing to update.');
            }

            // Mail templates are validated BEFORE the mutation, so a refused
            // save writes nothing at all — not the templates, and not the
            // unrelated fields that happened to ride in the same patch.
            $patchedTemplates = is_array($patch['email']['templates'] ?? null)
                ? $patch['email']['templates']
                : [];
            if ($patchedTemplates !== []) {
                $unknownKeys = array_values(array_diff(
                    array_keys($patchedTemplates),
                    trax_mail_template_keys()
                ));
                if ($unknownKeys !== []) {
                    trax_fail('BAD_REQUEST', 'Unknown mail template(s): ' . implode(', ', $unknownKeys)
                        . '. Known templates: ' . implode(', ', trax_mail_template_keys()) . '.');
                }

                $current = trax_normalize_settings(trax_read_data()['settings'] ?? null);
                $merged  = trax_normalize_settings(trax_deep_merge($current, $patch));
                $errors  = trax_mail_template_errors(
                    $patchedTemplates,
                    $merged['email']['templates'] ?? []
                );

                if ($errors !== []) {
                    $first = reset($errors);
                    trax_fail(
                        'BAD_REQUEST',
                        trax_mail_templates()[array_key_first($errors)]['label']
                            . ': ' . reset($first),
                        400,
                        ['templates' => $errors]
                    );
                }
            }

            // Same rule as the templates: checked BEFORE the mutation, so a
            // refused number writes nothing at all and leaves rev where it was.
            // The normaliser would otherwise drop a bad value silently and the
            // operator would find an empty field and no WhatsApp button.
            if (array_key_exists('whatsapp', (array)($patch['branding'] ?? []))) {
                $whatsappError = trax_whatsapp_error($patch['branding']['whatsapp']);
                if ($whatsappError !== null) {
                    trax_fail('BAD_REQUEST', 'WhatsApp number: ' . $whatsappError);
                }
            }

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($patch): array {
                // Deep-merged so a patch can name one field, then re-validated
                // as a whole — the same normaliser that runs on every read.
                $data['settings'] = trax_normalize_settings(
                    trax_deep_merge($data['settings'] ?? [], $patch)
                );
                return [];
            });

            trax_ok(trax_snapshot($result['data'], $result['checkouts']), $result['rev']);
        }

        // --- Account -------------------------------------------------------

        case 'auth.changePassword': {
            $me = trax_current_user();

            // External mode has no built-in session to read the target off, but
            // the fallback account is exactly the one an operator needs to be
            // able to rotate — it is what gets them back in when the include
            // breaks, and it was last set during the install. So the request
            // names it, or, on the overwhelmingly common single-account
            // install, does not have to.
            if ($me === null && trax_auth_mode() === 'external') {
                $wanted = trax_str($payload['username'] ?? '', 64);
                $users  = trax_users_load()['users'];

                if ($wanted !== '') {
                    foreach ($users as $user) {
                        if (strcasecmp($user['username'], $wanted) === 0) {
                            $me = $user;
                            break;
                        }
                    }
                    if ($me === null) {
                        trax_fail('BAD_REQUEST', 'No built-in account is called "' . $wanted . '".');
                    }
                } elseif (count($users) === 1) {
                    $me = $users[0];
                } else {
                    trax_fail('BAD_REQUEST', 'Specify which fallback account to change');
                }
            }

            if ($me === null) {
                trax_fail('UNAUTHENTICATED', 'Not signed in.', 401);
            }

            // Read straight off the payload rather than through trax_str():
            // that helper trims and strips control characters, which would
            // quietly change a password before it was ever compared.
            $currentPassword = is_string($payload['currentPassword'] ?? null) ? $payload['currentPassword'] : '';
            $newPassword     = is_string($payload['newPassword'] ?? null) ? $payload['newPassword'] : '';

            if ($currentPassword === '' || $newPassword === '') {
                trax_fail('BAD_REQUEST', 'Both the current and the new password are required.');
            }

            // Proving the current password is what makes this safe to expose:
            // a session left open on an unlocked screen must not be enough to
            // lock the owner out of their own instance.
            if (trax_user_verify($me['username'], $currentPassword) === null) {
                trax_fail('FORBIDDEN', 'The current password is not correct.', 403);
            }

            try {
                trax_user_change_password((int)$me['id'], $newPassword);
            } catch (InvalidArgumentException $e) {
                trax_fail('BAD_REQUEST', $e->getMessage());
            }

            // Nothing in data.json moved, so there is no snapshot and no rev.
            trax_ok(['changed' => true]);
        }

        // --- Authentication mode -------------------------------------------
        // These two write lib/config.local.php, not data.json, so like the
        // password change they answer without a snapshot or a rev.

        case 'auth.testInclude': {
            // A POST because it takes a path in a body and is CSRF-protected
            // like every other mutation, even though it saves nothing: it
            // reports whether a file exists on the server's filesystem, which
            // is not something to hand out on a GET.
            $include = trax_str($payload['include'] ?? '', 512);
            trax_ok(trax_external_auth_check($include));
        }

        case 'auth.configUpdate': {
            $mode      = trax_str($payload['mode'] ?? '', 20);
            $include   = trax_str($payload['include'] ?? '', 512);
            $logoutUrl = trax_str($payload['logoutUrl'] ?? '', 512);

            if (!in_array($mode, ['builtin', 'external'], true)) {
                trax_fail('BAD_REQUEST', 'Field "mode" must be "builtin" or "external".');
            }

            if ($logoutUrl !== '' && trax_safe_logout_url($logoutUrl) === '') {
                trax_fail('BAD_REQUEST', 'The sign-out URL must be an http(s) address or a path on this site.');
            }

            // Refusing a bad path here is what keeps the switch survivable: an
            // external mode saved against a file that is not there would leave
            // no login form and no include. (trax_auth_mode() would fall back
            // anyway — this is the belt to that pair of braces.)
            if ($mode === 'external') {
                $check = trax_external_auth_check($include);
                if (!$check['ok']) {
                    trax_fail('BAD_REQUEST', $check['message']);
                }
            }
            // Builtin keeps whatever path was sent on file, unchecked: it is
            // inert until the mode says otherwise, and remembering it means a
            // switch back does not have to be retyped.

            try {
                trax_config_local_write([
                    'TRAX_AUTH_MODE'       => $mode,
                    'TRAX_AUTH_INCLUDE'    => $include,
                    'TRAX_AUTH_LOGOUT_URL' => $logoutUrl,
                ]);
            } catch (Throwable $e) {
                error_log('[app] could not write lib/config.local.php: ' . $e->getMessage());
                trax_fail(
                    'SERVER',
                    'lib/config.local.php could not be written. Check that the lib/ directory is writable.',
                    500
                );
            }

            $config = trax_auth_config([
                'mode'      => $mode,
                'include'   => $include,
                'logoutUrl' => $logoutUrl,
            ]);
            // Said out loud because switching to external from a built-in
            // session is exactly the moment it stops being obvious.
            $config['warning'] = $mode === 'external'
                ? 'Built-in login stays available as fallback only if the external file disappears'
                : '';

            trax_ok($config);
        }

        // --- Taxonomy ------------------------------------------------------
        // Categories, locations and tags are free text on the assets. There is
        // no registry to edit, so these actions rewrite the records themselves.

        case 'taxonomy.rename':
        case 'taxonomy.merge':
        case 'taxonomy.delete': {
            $kind = strtolower(trax_str($payload['kind'] ?? '', 20));
            if (!in_array($kind, TRAX_TAXONOMY_KINDS, true)) {
                trax_fail('BAD_REQUEST', 'Field "kind" must be one of: ' . implode(', ', TRAX_TAXONOMY_KINDS) . '.');
            }

            if ($action === 'taxonomy.delete') {
                $from = [req_str($payload, 'value', 120)];
                $to   = null;
            } else {
                $raw  = $action === 'taxonomy.merge' ? ($payload['from'] ?? null) : [$payload['from'] ?? null];
                if (!is_array($raw)) {
                    trax_fail('BAD_REQUEST', 'Field "from" must be a list of values.');
                }
                $from = $raw;
                $to   = trax_str($payload['to'] ?? '', 120);
                if ($to === '') {
                    trax_fail('BAD_REQUEST', 'Field "to" is required — use taxonomy.delete to clear a value.');
                }
            }

            $result = trax_mutate($clientRev, function (array &$data, array &$checkouts) use ($action, $kind, $from, $to, $actor): array {
                $changed = trax_taxonomy_apply($data, $kind, $from, $to);

                $verb = match ($action) {
                    'taxonomy.rename' => 'Renamed',
                    'taxonomy.merge'  => 'Merged',
                    default           => 'Deleted',
                };
                $sources = implode('", "', array_map(static fn($v) => trax_str($v, 120), $from));
                $note    = $to === null
                    ? "{$verb} {$kind} \"{$sources}\" on {$changed} asset(s)"
                    : "{$verb} {$kind} \"{$sources}\" to \"{$to}\" on {$changed} asset(s)";

                trax_append_history($data, str_replace('.', '_', $action), [
                    'note'  => $note,
                    'actor' => $actor,
                ]);

                return ['changed' => $changed];
            });

            trax_ok(array_merge(
                trax_snapshot($result['data'], $result['checkouts']),
                $result['result']
            ), $result['rev']);
        }

        default:
            trax_fail('BAD_REQUEST', "Unknown action \"{$action}\".", 404);
    }
} catch (TraxConflict $e) {
    trax_fail('STALE', $e->getMessage(), 409, [
        'rev'      => $e->current['rev'] ?? null,
        'snapshot' => isset($e->current['data'])
            ? trax_snapshot($e->current['data'], $e->current['checkouts'])
            : null,
    ]);
} catch (TraxBlocked $e) {
    trax_fail('CONFLICT', 'Some items are not available.', 409, ['blocked' => $e->blocked]);
} catch (TraxInvalid $e) {
    trax_fail('BAD_REQUEST', $e->getMessage(), 400);
} catch (Throwable $e) {
    error_log('[app] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    trax_fail('SERVER', 'Something went wrong on the server.', 500);
}
