<?php
/**
 * The data store.
 *
 * Replaces the previous model where the browser POSTed the entire data.json
 * back on every change. All mutations now go through store_mutate(), which
 * holds an exclusive lock across the whole read-modify-write cycle and
 * commits via tmp-file + rename() so a crash can never truncate the data.
 */

declare(strict_types=1);

// Settings validate addresses with trax_valid_email(), which lives in config.php
// alongside trax_mail_header_safe(). This file must NOT require mailer.php: the
// mailer requires this one for trax_setting(), and that was a require cycle.
require_once __DIR__ . '/config.php';

/** Thrown when the client's rev is stale — someone else wrote first. */
class TraxConflict extends RuntimeException
{
    public array $current;

    public function __construct(string $message, array $current = [])
    {
        parent::__construct($message);
        $this->current = $current;
    }
}

/** Thrown for validation failures; surfaces as HTTP 400. */
class TraxInvalid extends RuntimeException
{
}

/**
 * Thrown when an operation is refused because specific items are unavailable.
 * Carries the blocking detail so the UI can name what is in the way and offer
 * to proceed with the rest.
 */
class TraxBlocked extends RuntimeException
{
    public array $blocked;

    public function __construct(array $blocked)
    {
        parent::__construct('Some items are not available.');
        $this->blocked = $blocked;
    }
}

// ---------------------------------------------------------------------------
// Scalar coercion
// ---------------------------------------------------------------------------

function trax_str(mixed $value, int $max = TRAX_MAX_STRING): string
{
    if ($value === null || is_array($value) || is_object($value)) {
        return '';
    }
    $s = trim((string)$value);
    // Strip control characters except tab/newline.
    $s = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $s) ?? '';
    if (mb_strlen($s) > $max) {
        $s = mb_substr($s, 0, $max);
    }
    return $s;
}

function trax_int(mixed $value, ?int $default = null): ?int
{
    if (is_int($value)) {
        return $value;
    }
    if (is_string($value) && preg_match('/^-?\d+$/', trim($value))) {
        return (int)trim($value);
    }
    if (is_float($value) && floor($value) === $value) {
        return (int)$value;
    }
    return $default;
}

function trax_float(mixed $value): ?float
{
    if (is_int($value) || is_float($value)) {
        return (float)$value;
    }
    if (is_string($value)) {
        // Accept both "1234.50" and the German "1234,50".
        $s = str_replace(',', '.', trim($value));
        if ($s !== '' && is_numeric($s)) {
            return (float)$s;
        }
    }
    return null;
}

/** Reads a boolean from the several shapes a JSON client sends one in. */
function trax_bool(mixed $value, bool $default = false): bool
{
    if (is_bool($value)) {
        return $value;
    }
    if (is_int($value) || is_float($value)) {
        return (float)$value !== 0.0;
    }
    if (is_string($value)) {
        $s = strtolower(trim($value));
        if (in_array($s, ['1', 'true', 'yes', 'on'], true)) {
            return true;
        }
        if (in_array($s, ['0', 'false', 'no', 'off'], true)) {
            return false;
        }
    }
    return $default;
}

/**
 * An integer confined to a range. Anything that is not a number at all falls
 * back to the default rather than being clamped to an edge of the range, so a
 * garbage value never silently becomes a plausible-looking setting.
 */
function trax_clamp_int(mixed $value, int $min, int $max, int $default): int
{
    $n = trax_int($value);
    if ($n === null) {
        return $default;
    }
    return max($min, min($max, $n));
}

function trax_enum(mixed $value, array $allowed, string $default): string
{
    $s = is_string($value) ? strtoupper(trim($value)) : '';
    return in_array($s, $allowed, true) ? $s : $default;
}

/**
 * Normalises a date to "YYYY-MM-DD", or null.
 *
 * This is a calendar day (a purchase date, a warranty end), not an instant, so
 * it is formatted with date() in the same timezone trax_parse_datetime() reads
 * it in. Formatting with gmdate() instead would turn local midnight into the
 * previous day for every timezone east of UTC, and because the stored value is
 * re-normalised on every save the date would walk backwards one day per write.
 */
function trax_date(mixed $value): ?string
{
    $s = trax_str($value, 40);
    if ($s === '') {
        return null;
    }
    $ts = trax_parse_datetime($s);
    return $ts === null ? null : date('Y-m-d', $ts);
}

/** Normalises a timestamp to an ISO-8601 UTC string, or null. */
function trax_iso(mixed $value): ?string
{
    $s = trax_str($value, 60);
    if ($s === '') {
        return null;
    }
    $ts = trax_parse_datetime($s);
    return $ts === null ? null : gmdate('Y-m-d\TH:i:s.000\Z', $ts);
}

/**
 * Parses the several date shapes this codebase has accumulated:
 * German "dd.mm.yyyy hh:mm" (checkout.json returnDate), ISO-8601,
 * "YYYY-MM-DDTHH:MM" from datetime-local inputs, and "YYYY-MM-DD".
 * Returns a Unix timestamp, or null.
 */
function trax_parse_datetime(string $value): ?int
{
    $s = trim($value);
    if ($s === '') {
        return null;
    }

    // German display format, e.g. "13.03.2026 17:52" — interpreted as local time.
    if (preg_match('/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?$/', $s, $m)) {
        $ts = mktime(
            (int)($m[4] ?? 0),
            (int)($m[5] ?? 0),
            0,
            (int)$m[2],
            (int)$m[1],
            (int)$m[3]
        );
        return $ts === false ? null : $ts;
    }

    $ts = strtotime($s);
    return $ts === false ? null : $ts;
}

/**
 * Formats a timestamp with the operator's configured date format.
 *
 * The format is settings.defaults.dateFormat, a plain PHP date() string, so an
 * operator outside the ISO-ish default can have 'd.m.Y H:i' or 'm/d/Y g:ia'
 * without a code change. A format that renders to nothing (an empty or
 * all-literal setting) is not accepted — a mail that says "due " helps nobody —
 * so it falls back to the built-in.
 */
function trax_format_date(int $timestamp): string
{
    $format = trax_setting('defaults.dateFormat', 'Y-m-d H:i');
    if (!is_string($format) || trim($format) === '') {
        $format = 'Y-m-d H:i';
    }
    return date($format, $timestamp);
}

/**
 * The former name of trax_format_date(), kept because it is called from
 * api.php, cron.php and the mail renderers. It has not been German-only since
 * the format became a setting; only the name is left over.
 */
function trax_format_de(int $timestamp): string
{
    return trax_format_date($timestamp);
}

// ---------------------------------------------------------------------------
// Normalizers — every record passes through these on read and on write, so
// the 26 existing records gain the new fields with defaults and nothing else
// changes.
// ---------------------------------------------------------------------------

/**
 * A list of unit numbers as unique positive ints, ascending.
 *
 * The canonical reading for every `unitNos` in the system — payload, line,
 * history event and booking snapshot all pass through here, so a duplicate or
 * a "3" can never survive to mean something different in two places.
 *
 * @return array<int, int>
 */
function trax_unit_nos(mixed $raw): array
{
    if (!is_array($raw)) {
        return [];
    }
    $nos = [];
    foreach ($raw as $entry) {
        $no = trax_int(is_array($entry) ? ($entry['no'] ?? null) : $entry);
        if ($no !== null && $no > 0 && !in_array($no, $nos, true)) {
            $nos[] = $no;
        }
        if (count($nos) >= TRAX_MAX_UNITS) {
            break;
        }
    }
    sort($nos);
    return $nos;
}

/**
 * Reads one "item" entry as [assetId, qty, unitNos].
 *
 * Accepts a bare id (`6`, qty 1) as well as the quantity-carrying shapes
 * `{"assetId":6,"qty":3}` and `{"id":6,"qty":3}`, so legacy payloads and
 * legacy records keep working unchanged. An entry may name specific physical
 * units with `"unitNos":[1,3]`; the third slot is appended rather than folded
 * into the second so every existing `[$id, $qty] = trax_item_pair(...)` reads
 * exactly what it always did.
 *
 * @return array{0:?int, 1:int, 2:array<int,int>}
 */
function trax_item_pair(mixed $raw, int $maxQty = TRAX_MAX_QUANTITY): array
{
    $unitNos = [];
    if (is_array($raw)) {
        $id      = trax_int($raw['assetId'] ?? $raw['id'] ?? null);
        $qty     = trax_int($raw['qty'] ?? null, 1) ?? 1;
        $unitNos = trax_unit_nos($raw['unitNos'] ?? null);
    } else {
        $id  = trax_int($raw);
        $qty = 1;
    }
    if ($id === null || $id <= 0) {
        return [null, 1, []];
    }
    return [$id, max(1, min($maxQty, $qty)), $unitNos];
}

/**
 * One physical unit of an ITEM — the thing an operator can tell apart from its
 * neighbour: unit 12.1 is the Sommer cable, 12.2 the Cordial.
 *
 * `no` is the unit's permanent number within its asset. It is assigned by the
 * API (never by the client, never reused) and is what a checkout line, a
 * history event and a printed label all point at, so a record without a usable
 * one is not a unit and is dropped by the caller.
 *
 * There is no `state` here: FREE / OUT / OOS is derived from the open checkout
 * lines by trax_unit_states() and would go stale the moment it were stored.
 */
function trax_normalize_unit(mixed $raw): ?array
{
    $raw = is_array($raw) ? $raw : [];

    $no = trax_int($raw['no'] ?? null);
    if ($no === null || $no <= 0) {
        return null;
    }

    // What this one piece cost. Normalised exactly like the asset's own price;
    // the currency stays on the asset, because a unit is one of the same thing.
    $price = trax_float($raw['price'] ?? null);

    return [
        'no'            => $no,
        'label'         => trax_str($raw['label'] ?? '', 120),
        'serial'        => trax_str($raw['serial'] ?? '', 120),
        'condition'     => trax_enum($raw['condition'] ?? null, TRAX_CONDITIONS, 'GOOD'),
        'price'         => $price !== null && $price >= 0 ? round($price, 2) : null,
        // When this one piece was bought and how long its warranty runs.
        // Normalised exactly like the asset's own dates: stored YYYY-MM-DD or
        // null. Two of the same model are rarely bought on the same day.
        'purchasedAt'   => trax_date($raw['purchasedAt'] ?? null),
        'warrantyUntil' => trax_date($raw['warrantyUntil'] ?? null),
        // Taken off the shelf by hand: broken, lent to the workshop, whatever.
        // It stays part of the asset and keeps its number.
        'outOfService'  => !empty($raw['outOfService']),
        'note'          => trax_str($raw['note'] ?? '', 500),
    ];
}

function trax_normalize_asset(mixed $raw, int $fallbackId = 0): array
{
    $raw  = is_array($raw) ? $raw : [];
    $kind = trax_enum($raw['kind'] ?? null, TRAX_ASSET_KINDS, 'ITEM');

    // Members carry a quantity now. Both the legacy flat [3,4,5] and the new
    // [{"assetId":3,"qty":2}] are accepted, and normalising twice is a no-op.
    $members = [];
    $seen    = [];
    if ($kind === 'SET' && isset($raw['members']) && is_array($raw['members'])) {
        foreach ($raw['members'] as $member) {
            [$mid, $mqty] = trax_item_pair($member, TRAX_MAX_MEMBER_QTY);
            if ($mid === null || isset($seen[$mid])) {
                continue;
            }
            $seen[$mid] = true;
            $members[]  = ['assetId' => $mid, 'qty' => $mqty];
            if (count($members) >= TRAX_MAX_MEMBERS) {
                break;
            }
        }
    }

    // The individually tracked units of an ITEM, if the owner keeps them that
    // way. Optional: an asset with no units is the pre-feature record and is
    // counted by `quantity` alone. A kit never has units — its members do.
    $units = [];
    if ($kind !== 'SET' && isset($raw['units']) && is_array($raw['units'])) {
        $seenNo = [];
        foreach ($raw['units'] as $entry) {
            $unit = trax_normalize_unit($entry);
            if ($unit === null || isset($seenNo[$unit['no']])) {
                continue;   // no usable number, or a number already taken
            }
            $seenNo[$unit['no']] = true;
            $units[]             = $unit;
            if (count($units) >= TRAX_MAX_UNITS) {
                break;
            }
        }
        usort($units, static fn(array $a, array $b): int => $a['no'] <=> $b['no']);
    }

    // The highest unit number this asset has ever handed out. Server-managed
    // and never in the client's patch whitelist: it only ever goes up, so a
    // deleted unit's number is retired rather than handed to the next unit and
    // an already printed label can never come to mean different gear. A legacy
    // record without the field heals itself off its own units on first read.
    $unitSeq = max(0, trax_int($raw['unitSeq'] ?? null, 0) ?? 0);
    foreach ($units as $unit) {
        $unitSeq = max($unitSeq, $unit['no']);
    }
    if ($kind === 'SET') {
        $unitSeq = 0;   // a kit never has units; its members carry the numbers
    }

    // How many physical units this one record stands for. Everything that
    // existed before quantities reads back as 1. A kit is always 1 — the
    // count of a kit is meaningless, its members carry the numbers.
    // Once units are listed the count IS the list: two sources of truth for
    // "how many are there" is how an asset ends up owing units it never had.
    $quantity = trax_int($raw['quantity'] ?? null, 1) ?? 1;
    $quantity = $kind === 'SET' ? 1 : max(1, min(TRAX_MAX_QUANTITY, $quantity));
    if ($units !== []) {
        $quantity = count($units);
    }

    $tags = [];
    if (isset($raw['tags']) && is_array($raw['tags'])) {
        foreach ($raw['tags'] as $tag) {
            $t = trax_str($tag, 60);
            if ($t !== '' && !in_array($t, $tags, true)) {
                $tags[] = $t;
            }
        }
    }

    $price = trax_float($raw['price'] ?? null);

    // The asset's own condition log. Independent of any booking: an item on the
    // shelf has no booking to hang a photo off, and this record has to outlive
    // every loan the item ever goes on.
    $conditionLog = [];
    foreach ((array)($raw['conditionLog'] ?? []) as $entry) {
        $shot = trax_normalize_condition_photo($entry);
        if ($shot === null) {
            continue;   // an entry pointing at no file is not a photo
        }
        $conditionLog[] = $shot;
        if (count($conditionLog) >= TRAX_MAX_ASSET_CONDITION_PHOTOS) {
            break;
        }
    }

    // Attached documents — manuals, receipts, insurance certificates. Like the
    // condition log this is the asset's own record and outlives every loan.
    $documents = [];
    foreach ((array)($raw['documents'] ?? []) as $entry) {
        $doc = trax_normalize_document($entry);
        if ($doc === null) {
            continue;   // an entry pointing at no file is not a document
        }
        $documents[] = $doc;
        if (count($documents) >= TRAX_MAX_ASSET_DOCUMENTS) {
            break;
        }
    }

    return [
        // Existing fields — byte-identical round-trip for the current records.
        'id'       => trax_int($raw['id'] ?? null, $fallbackId) ?? $fallbackId,
        'name'     => trax_str($raw['name'] ?? '', TRAX_MAX_NAME),
        'status'   => trax_enum($raw['status'] ?? null, TRAX_STATUSES, 'FREE'),
        'notes'    => trax_str($raw['notes'] ?? ''),
        'category' => trax_str($raw['category'] ?? '', 120),
        'location' => trax_str($raw['location'] ?? '', 120),

        // Quantities
        'quantity' => $quantity,
        // Per-unit tracking. Empty on every record written before the feature.
        'units'    => $units,
        // High-water mark of the numbers handed out, so they are never reused.
        'unitSeq'  => $unitSeq,

        // Sets
        'kind'    => $kind,
        'members' => $members,

        // Richer record
        'serial'        => trax_str($raw['serial'] ?? '', 120),
        'supplier'      => trax_str($raw['supplier'] ?? '', 120),
        'purchasedAt'   => trax_date($raw['purchasedAt'] ?? null),
        'price'         => $price !== null && $price >= 0 ? round($price, 2) : null,
        'currency'      => trax_str($raw['currency'] ?? 'EUR', 8) ?: 'EUR',
        'warrantyUntil' => trax_date($raw['warrantyUntil'] ?? null),
        'condition'     => trax_enum($raw['condition'] ?? null, TRAX_CONDITIONS, 'GOOD'),
        'photo'         => trax_photo_name($raw['photo'] ?? null),
        'tags'          => $tags,
        // Dated condition photos of this one piece of gear, oldest first.
        'conditionLog'  => $conditionLog,
        // Attached documents, oldest first. Served only through download.php.
        'documents'     => $documents,
    ];
}

/**
 * One entry in an asset's condition log: what was photographed, when, and what
 * the operator said about it.
 *
 * There is no assetId here — the entry already lives on the asset. Returns null
 * for an entry with no usable filename, so the caller can drop it.
 */
function trax_normalize_condition_photo(mixed $raw): ?array
{
    $raw = is_array($raw) ? $raw : [];

    // Same guard as an asset photo: a basename we generated, never a path.
    $file = trax_photo_name($raw['file'] ?? null);
    if ($file === null) {
        return null;
    }

    return [
        'file' => $file,
        'at'   => trax_iso($raw['at'] ?? null) ?? gmdate('Y-m-d\TH:i:s.000\Z'),
        'note' => trax_str($raw['note'] ?? ''),
    ];
}

/**
 * One attached document: what is stored, what it was called, what it is.
 *
 * Returns null for an entry with no usable stored filename, so the caller can
 * drop it — the same contract as trax_normalize_condition_photo().
 */
function trax_normalize_document(mixed $raw): ?array
{
    $raw = is_array($raw) ? $raw : [];

    $file = trax_document_name($raw['file'] ?? null);
    if ($file === null) {
        return null;
    }

    // The stored extension is the authority on what this is: it was derived
    // from the sniffed type when the file was written, never from the client.
    $ext  = strtolower((string)pathinfo($file, PATHINFO_EXTENSION));
    $mime = array_search($ext, TRAX_DOCUMENT_TYPES, true);

    $size = trax_int($raw['size'] ?? null, 0) ?? 0;

    return [
        'file'    => $file,
        'name'    => trax_document_client_name($raw['name'] ?? ''),
        'title'   => trax_str($raw['title'] ?? '', TRAX_MAX_NAME),
        'size'    => max(0, min(TRAX_MAX_DOCUMENT_BYTES, $size)),
        'mime'    => $mime !== false ? $mime : 'application/octet-stream',
        'addedAt' => trax_iso($raw['addedAt'] ?? null) ?? gmdate('Y-m-d\TH:i:s.000\Z'),
    ];
}

/**
 * Stored document filenames are generated by us: doc-<32 hex>.<ext>.
 *
 * Parallel to trax_photo_name() rather than a widening of it — that pattern is
 * shared by five call sites, all of which mean "a photo in uploads/", and a
 * document is a different file in a different directory. \z, not $: '$' also
 * matches before a trailing newline, which a filename must never carry.
 */
function trax_document_name(mixed $value): ?string
{
    $s = trax_str($value, 120);
    if ($s === '' || !preg_match('/^doc-[0-9a-f]{32}\.(pdf|jpg|png|webp|txt)\z/', $s)) {
        return null;
    }
    return $s;
}

/**
 * The original filename, reduced to something safe to display and to put in a
 * Content-Disposition header. It is NEVER used as a path — download.php reads
 * by stored name only — so this is about display and header hygiene, not access.
 */
function trax_document_client_name(mixed $value): string
{
    // trax_str() has already dropped control characters; the rest is the path
    // separators and the quote that would end the header parameter early.
    $s = str_replace(['\\', '/', '"'], ' ', trax_str($value, 160));
    $s = trim(preg_replace('/\s+/u', ' ', $s) ?? '');

    return $s === '' ? 'document' : $s;
}

/** Photo filenames are generated by us; reject anything with a path in it. */
function trax_photo_name(mixed $value): ?string
{
    $s = trax_str($value, 120);
    if ($s === '' || !preg_match('/^[A-Za-z0-9_\-]+\.(jpg|png|webp)$/', $s)) {
        return null;
    }
    return $s;
}

function trax_normalize_reservation(mixed $raw): array
{
    $raw = is_array($raw) ? $raw : [];

    // What was booked, with quantities. Legacy records carry only `assetIds`,
    // which become one unit each; `assetIds` is then kept as a derived mirror
    // of the unique asset ids so all the existing conflict and status code
    // that reads it keeps working untouched.
    $items = [];
    $index = [];
    $source = is_array($raw['items'] ?? null) && $raw['items'] !== []
        ? $raw['items']
        : (array)($raw['assetIds'] ?? []);
    foreach ($source as $item) {
        [$aid, $qty] = trax_item_pair($item);
        if ($aid === null) {
            continue;
        }
        if (isset($index[$aid])) {
            $items[$index[$aid]]['qty'] = min(TRAX_MAX_QUANTITY, $items[$index[$aid]]['qty'] + $qty);
            continue;
        }
        $index[$aid] = count($items);
        $items[]     = ['assetId' => $aid, 'qty' => $qty];
    }
    $assetIds = array_column($items, 'assetId');

    // New: what the user actually booked, so the UI can say "Camera Kit A"
    // instead of listing its members. Absent on existing records.
    $setIds = [];
    foreach ((array)($raw['setIds'] ?? []) as $setId) {
        $sid = trax_int($setId);
        if ($sid !== null && !in_array($sid, $setIds, true)) {
            $setIds[] = $sid;
        }
    }

    $now = gmdate('Y-m-d\TH:i:s.000\Z');

    return [
        'id'            => trax_int($raw['id'] ?? null, 0) ?? 0,
        'assetIds'      => $assetIds,
        'items'         => $items,
        'setIds'        => $setIds,
        'customerName'  => trax_str($raw['customerName'] ?? '', TRAX_MAX_NAME),
        'customerEmail' => trax_str($raw['customerEmail'] ?? '', TRAX_MAX_NAME),
        'startAt'       => trax_iso($raw['startAt'] ?? null) ?? $now,
        'endAt'         => trax_iso($raw['endAt'] ?? $raw['returnDate'] ?? $raw['dueAt'] ?? null) ?? $now,
        'status'        => trax_enum($raw['status'] ?? null, TRAX_RESERVATION_STATUSES, 'ACTIVE'),
        'notes'         => trax_str($raw['notes'] ?? ''),
        'createdAt'     => trax_iso($raw['createdAt'] ?? null) ?? $now,
        'convertedAt'   => trax_iso($raw['convertedAt'] ?? null),
        'completedAt'   => trax_iso($raw['completedAt'] ?? null),
        'cancelledAt'   => trax_iso($raw['cancelledAt'] ?? null),
    ];
}

function trax_normalize_history(mixed $raw): array
{
    $raw = is_array($raw) ? $raw : [];

    // How many units the event moved. Everything written before quantities —
    // and every event that moves no units at all — reads back as 1, so the 26
    // existing entries are unchanged and re-normalising is a no-op.
    $qty = trax_int($raw['qty'] ?? null, 1) ?? 1;

    return [
        'id'            => trax_int($raw['id'] ?? null, 0) ?? 0,
        'type'          => trax_str($raw['type'] ?? '', 40),
        'assetId'       => trax_int($raw['assetId'] ?? null),
        'qty'           => max(1, min(TRAX_MAX_QUANTITY, $qty)),
        // Which physical units the event moved, when the asset tracks them.
        'unitNos'       => trax_unit_nos($raw['unitNos'] ?? null),
        'reservationId' => trax_int($raw['reservationId'] ?? null),
        'setId'         => trax_int($raw['setId'] ?? null),
        'customerName'  => trax_str($raw['customerName'] ?? '', TRAX_MAX_NAME),
        'customerEmail' => trax_str($raw['customerEmail'] ?? '', TRAX_MAX_NAME),
        'at'            => trax_iso($raw['at'] ?? null) ?? gmdate('Y-m-d\TH:i:s.000\Z'),
        'dueAt'         => trax_iso($raw['dueAt'] ?? null),
        'note'          => trax_str($raw['note'] ?? ''),
        'actor'         => trax_str($raw['actor'] ?? '', 120),
    ];
}

/**
 * A checkout record is one transaction line: `qty` units of `assetId` out to
 * one person. It is keyed by `lineId`, not by asset id, so the same asset can
 * be out to several people at once — which the old asset-id keying made
 * impossible, because normalization silently destroyed the second holder.
 *
 * There is deliberately no `id` key: it used to mean "asset id", and leaving
 * it in place would let a consumer keep that assumption without noticing.
 *
 * `returnDate` keeps the German display string the emails and labels already
 * expect; `dueAt` is the ISO value all new logic reads.
 */
function trax_normalize_checkout(mixed $raw): array
{
    $raw = is_array($raw) ? $raw : [];

    $returnDate = trax_str($raw['returnDate'] ?? '', 40);
    $dueAt      = trax_iso($raw['dueAt'] ?? null);

    // Backfill whichever side is missing, so old records gain dueAt for free.
    if ($dueAt === null && $returnDate !== '') {
        $dueAt = trax_iso($returnDate);
    }
    if ($returnDate === '' && $dueAt !== null) {
        $ts = trax_parse_datetime($dueAt);
        if ($ts !== null) {
            $returnDate = trax_format_de($ts);
        }
    }

    // A legacy row keys itself by asset id under `id` and has no lineId; it
    // becomes one line of one unit, and trax_normalize_checkouts() hands it
    // the next free lineId.
    $assetId = trax_int($raw['assetId'] ?? $raw['id'] ?? null, 0) ?? 0;
    $qty     = trax_int($raw['qty'] ?? null, 1) ?? 1;

    return [
        'lineId'        => max(0, trax_int($raw['lineId'] ?? null, 0) ?? 0),
        'assetId'       => $assetId,
        'qty'           => max(1, min(TRAX_MAX_QUANTITY, $qty)),
        // Exactly which units left, for an asset that tracks them. Empty on
        // every line written before the feature — those are counted, not named,
        // and the availability maths reads that emptiness literally.
        'unitNos'       => trax_unit_nos($raw['unitNos'] ?? null),
        'name'          => trax_str($raw['name'] ?? '', TRAX_MAX_NAME),
        'checkedOut'    => trax_iso($raw['checkedOut'] ?? null) ?? gmdate('Y-m-d\TH:i:s.000\Z'),
        'returnDate'    => $returnDate,
        'dueAt'         => $dueAt,
        'customerName'  => trax_str($raw['customerName'] ?? '', TRAX_MAX_NAME),
        'customerEmail' => trax_str($raw['customerEmail'] ?? '', TRAX_MAX_NAME),
        'reservationId' => trax_int($raw['reservationId'] ?? null),
        'setId'         => trax_int($raw['setId'] ?? null),
        // Which customer-facing booking this line belongs to, so a return can
        // close that booking without guessing from names and dates.
        'bookingId'     => trax_int($raw['bookingId'] ?? null),
        'note'          => trax_str($raw['note'] ?? ''),
    ];
}

// ---------------------------------------------------------------------------
// Bookings
//
// One record per customer transaction, addressed publicly by an unguessable
// token. The item list is a SNAPSHOT taken at creation: checkout lines are
// deleted on a full return, so a booking that looked its items up later would
// go blank the moment the customer handed the gear back.
// ---------------------------------------------------------------------------

/** A 64-hex-character token, lower-cased, or null if it is not exactly that. */
function trax_booking_token(mixed $value): ?string
{
    // Read long, then match exactly: truncating to 64 first would let
    // "<valid token>junk" pass as the token it is a prefix of.
    $s = trax_str($value, 200);
    return preg_match('/^[0-9a-fA-F]{64}$/', $s) === 1 ? strtolower($s) : null;
}

/** A fresh 256-bit token. */
function trax_new_booking_token(): string
{
    return bin2hex(random_bytes(32));
}

/** One snapshotted line of a booking: what it was, how many, and which kit it came in. */
function trax_normalize_booking_item(mixed $raw): array
{
    $raw = is_array($raw) ? $raw : [];
    [$assetId, $qty, $unitNos] = trax_item_pair($raw);

    return [
        'assetId' => $assetId ?? 0,
        'qty'     => $qty,
        'unitNos' => $unitNos,
        'name'    => trax_str($raw['name'] ?? '', TRAX_MAX_NAME),
        'setId'   => trax_int($raw['setId'] ?? null),
        'setName' => trax_str($raw['setName'] ?? '', TRAX_MAX_NAME),
    ];
}

/**
 * What cron.php has already told this customer, so an hourly run cannot say it
 * twice. A booking written before reminders existed defaults to "nothing sent",
 * which is the only safe reading of a missing block.
 */
function trax_normalize_notified(mixed $raw): array
{
    $raw = is_array($raw) ? $raw : [];

    return [
        'dueSoonAt'    => trax_iso($raw['dueSoonAt'] ?? null),
        'overdueAt'    => trax_iso($raw['overdueAt'] ?? null),
        'overdueCount' => trax_clamp_int($raw['overdueCount'] ?? null, 0, 9999, 0),
    ];
}

/**
 * One condition photo hung off a booking: what was photographed at hand-over or
 * hand-back, when, optionally which item it shows, and what the operator said
 * about it.
 *
 * The booking owns these, not the history and not the checkout line: history
 * entries are a fixed literal that would discard the extra keys, and checkout
 * lines are deleted on a full return — which is exactly when a damage photo
 * matters most.
 *
 * Returns null for an entry with no usable filename, so the caller can drop it.
 */
function trax_normalize_booking_photo(mixed $raw): ?array
{
    $raw = is_array($raw) ? $raw : [];

    // Same guard as an asset photo: a basename we generated, never a path.
    $file = trax_photo_name($raw['file'] ?? null);
    if ($file === null) {
        return null;
    }

    $assetId = trax_int($raw['assetId'] ?? null);

    return [
        'file'    => $file,
        'at'      => trax_iso($raw['at'] ?? null) ?? gmdate('Y-m-d\TH:i:s.000\Z'),
        'assetId' => $assetId !== null && $assetId > 0 ? $assetId : null,
        'note'    => trax_str($raw['note'] ?? ''),
    ];
}

/**
 * Normalises one booking. Running it twice changes nothing — including the
 * token, which is only regenerated when the stored one is not exactly 64 hex
 * characters (missing, truncated, or hand-edited).
 */
function trax_normalize_booking(mixed $raw): array
{
    $raw = is_array($raw) ? $raw : [];
    $now = gmdate('Y-m-d\TH:i:s.000\Z');

    $kind = strtolower(trax_str($raw['kind'] ?? '', 20));
    if (!in_array($kind, TRAX_BOOKING_KINDS, true)) {
        $kind = 'checkout';
    }

    $items = [];
    foreach ((array)($raw['items'] ?? []) as $item) {
        $line = trax_normalize_booking_item($item);
        if ($line['assetId'] <= 0) {
            continue;   // a line that points at no asset is not a line
        }
        $items[] = $line;
        if (count($items) >= TRAX_MAX_BOOKING_ITEMS) {
            break;
        }
    }

    $photos = [];
    foreach ((array)($raw['photos'] ?? []) as $photo) {
        $entry = trax_normalize_booking_photo($photo);
        if ($entry === null) {
            continue;   // an entry pointing at no file is not a photo
        }
        $photos[] = $entry;
        if (count($photos) >= TRAX_MAX_BOOKING_PHOTOS) {
            break;
        }
    }

    $createdAt = trax_iso($raw['createdAt'] ?? null) ?? $now;
    $startAt   = trax_iso($raw['startAt'] ?? null);
    $dueAt     = trax_iso($raw['dueAt'] ?? null);

    // The link dies 30 days after the gear was due back. A stored value is kept
    // as-is so an operator-shortened link stays shortened.
    $expiresAt = trax_iso($raw['expiresAt'] ?? null)
        ?? trax_booking_expiry($dueAt ?? $startAt ?? $createdAt);

    return [
        'id'            => trax_int($raw['id'] ?? null, 0) ?? 0,
        'token'         => trax_booking_token($raw['token'] ?? null) ?? trax_new_booking_token(),
        'kind'          => $kind,
        'reservationId' => trax_int($raw['reservationId'] ?? null),
        'customerName'  => trax_str($raw['customerName'] ?? '', TRAX_MAX_NAME),
        'customerEmail' => trax_str($raw['customerEmail'] ?? '', TRAX_MAX_NAME),
        'createdAt'     => $createdAt,
        'startAt'       => $startAt,
        'dueAt'         => $dueAt,
        'expiresAt'     => $expiresAt,
        'status'        => trax_enum($raw['status'] ?? null, TRAX_BOOKING_STATUSES, 'OPEN'),
        'items'         => $items,
        'notes'         => trax_str($raw['notes'] ?? ''),
        // What the reminder cron has already sent about this booking.
        'notified'      => trax_normalize_notified($raw['notified'] ?? null),
        // Condition photos taken at hand-over or check-in.
        'photos'        => $photos,
    ];
}

/** TRAX_BOOKING_LINK_DAYS after the given ISO timestamp, as ISO. */
function trax_booking_expiry(?string $isoDate): string
{
    $ts = $isoDate === null ? null : trax_parse_datetime($isoDate);
    $ts ??= time();
    return gmdate('Y-m-d\TH:i:s.000\Z', $ts + TRAX_BOOKING_LINK_DAYS * 86400);
}

/** Next unused booking id. Monotonic, so a token is never re-issued for an id. */
function trax_next_booking_id(array $bookings): int
{
    $max = 0;
    foreach ($bookings as $booking) {
        $max = max($max, (int)($booking['id'] ?? 0));
    }
    return $max + 1;
}

/**
 * Finds a booking by token in constant shape: every record is compared, with
 * hash_equals, whether or not one has already matched — so the work done for a
 * hit and for a miss is the same.
 */
function trax_find_booking_by_token(array $bookings, string $token): ?array
{
    $found = null;
    foreach ($bookings as $booking) {
        $stored = (string)($booking['token'] ?? '');
        if (strlen($stored) === strlen($token) && hash_equals($stored, $token) && $found === null) {
            $found = $booking;
        }
    }
    return $found;
}

/** Whether the customer's link is still alive. */
function trax_booking_expired(array $booking, ?int $nowTs = null): bool
{
    $expires = trax_parse_datetime((string)($booking['expiresAt'] ?? ''));
    if ($expires === null) {
        return true;    // an unreadable expiry is a dead link, not an eternal one
    }
    return $expires < ($nowTs ?? time());
}

/** Applies a callback to the booking with the given id, in place. */
function trax_update_booking(array &$data, int $id, callable $fn): bool
{
    foreach ($data['bookings'] as $index => $booking) {
        if ((int)$booking['id'] === $id) {
            $data['bookings'][$index] = $fn($booking);
            return true;
        }
    }
    return false;
}

/**
 * Closes the bookings whose last checkout line has just gone.
 *
 * Called from checkout.checkin with the lines it removed, so only bookings that
 * this return actually touched are considered — a reservation booking that was
 * never converted has no lines and must not be closed by someone else's return.
 *
 * @param array $returned   the lines handed back
 * @param array $checkouts  the lines still open, after the return
 */
function trax_close_returned_bookings(array &$data, array $returned, array $checkouts): array
{
    $bookingIds = [];
    foreach ($returned as $line) {
        $bookingId = trax_int($line['bookingId'] ?? null);
        if ($bookingId !== null && $bookingId > 0 && !in_array($bookingId, $bookingIds, true)) {
            $bookingIds[] = $bookingId;
        }
    }

    $stillOpen = [];
    foreach ($checkouts as $line) {
        $bookingId = trax_int($line['bookingId'] ?? null);
        if ($bookingId !== null) {
            $stillOpen[$bookingId] = true;
        }
    }

    $closed = [];
    foreach ($bookingIds as $bookingId) {
        if (isset($stillOpen[$bookingId])) {
            continue;
        }
        trax_update_booking($data, $bookingId, static function (array $booking) use (&$closed): array {
            if ($booking['status'] === 'OPEN') {
                $booking['status'] = 'RETURNED';
                $closed[]          = $booking['id'];
            }
            return $booking;
        });
    }

    return $closed;
}

/**
 * Bookkeeping for the reminder cron. `lastDigestOn` is a calendar day, not a
 * timestamp: the owner digest goes out at most once per day whatever hour the
 * cron happens to fire.
 */
function trax_normalize_cron_state(mixed $raw): array
{
    $raw = is_array($raw) ? $raw : [];

    // Matched literally rather than run through trax_date(): a stored day that is
    // not already "YYYY-MM-DD" is bookkeeping we did not write, and coercing it
    // into a plausible-looking day is worse than dropping it — a day that does
    // not read back as the day it was written is a digest sent twice.
    $day = trax_str($raw['lastDigestOn'] ?? '', 10);
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $day) !== 1) {
        $day = null;
    }

    return [
        'lastRunAt'    => trax_iso($raw['lastRunAt'] ?? null),
        'lastDigestOn' => $day,
    ];
}

// ---------------------------------------------------------------------------
// Settings
//
// The runtime half of lib/config.php. Every field is defaulted from the
// matching constant, so a data.json written before settings existed loads
// unchanged and behaves exactly as it did. Deploy-time constants — paths,
// limits, TRAX_MAX_QUANTITY (a default parameter value, so it cannot be
// runtime at all) — deliberately stay constants.
// ---------------------------------------------------------------------------

/** A #RRGGBB colour, uppercased, or null. */
function trax_hex_color(mixed $value): ?string
{
    $s = trax_str($value, 7);
    return preg_match('/^#[0-9A-Fa-f]{6}$/', $s) === 1 ? strtoupper($s) : null;
}

/** A site-root-relative path with a trailing slash, or null. Never a URL. */
function trax_public_path(mixed $value): ?string
{
    $s = trax_str($value, 120);
    if ($s === '' || str_contains($s, '..') || str_contains($s, '//')) {
        return null;
    }
    if (preg_match('#^/[A-Za-z0-9._~/\-]*$#', $s) !== 1) {
        return null;
    }
    return rtrim($s, '/') . '/';
}

/**
 * The digits wa.me wants, or '' if this cannot be a WhatsApp number.
 *
 * The stored value is what the operator typed — "+49 172 956 6476" — because
 * that is what the settings field has to show back. The deep link takes digits
 * only, so the two forms are derived here, in one place, and never assembled in
 * a template: whatever comes out of this function is [0-9]* and therefore
 * cannot carry a scheme, a quote or anything else out of an href.
 *
 * The rules, in the order they are applied:
 *   - only human phone punctuation may appear: digits, space, + - ( ) / .
 *     and a '+' only as the first character;
 *   - a written-out trunk prefix "(0)" is dropped — "+49 (0)172 …" is a number
 *     to be dialled without the zero, and keeping it would build a wrong link;
 *   - a leading "00" is the international prefix and becomes nothing;
 *   - what is left must be 7 to 15 digits (15 is E.164's ceiling) and must not
 *     start with 0: wa.me dials internationally and a national "0172 …" reaches
 *     nobody, so it is not accepted as a number.
 */
function trax_whatsapp_digits(mixed $value): string
{
    $s = trax_str($value, 40);
    if ($s === '') {
        return '';
    }

    $s = str_replace('(0)', '', $s);
    if (preg_match('/^\+?[0-9 ()\/.\-]+$/', $s) !== 1) {
        return '';
    }

    $digits = preg_replace('/\D+/', '', $s) ?? '';
    if (str_starts_with($digits, '00')) {
        $digits = substr($digits, 2);
    }

    $length = strlen($digits);
    if ($length < 7 || $length > 15 || str_starts_with($digits, '0')) {
        return '';
    }
    return $digits;
}

/**
 * A BCP 47 language tag, e.g. 'en-US', 'de-DE', 'pt-BR'. Shape only: letters,
 * digits and single hyphens, because the value is passed to Intl constructors
 * in the browser and a malformed tag throws RangeError there.
 */
function trax_locale(mixed $value): string
{
    $s = trax_str($value, 35);
    if (preg_match('/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/', $s) !== 1) {
        return 'en-US';
    }
    return $s;
}

/**
 * The stored form of the WhatsApp number: what was typed, or '' for "no
 * WhatsApp button". A value that cannot yield a link is not kept — api.php
 * refuses one with a message, so anything arriving here that fails came from a
 * hand-edited data.json, and storing it would only put a dead button on the
 * public page.
 */
function trax_whatsapp(mixed $value): string
{
    $s = trax_str($value, 40);
    return trax_whatsapp_digits($s) === '' ? '' : $s;
}

/**
 * An image file referenced by the settings — the label logo, the favicon.
 *
 * It is read off disk by the label renderer and emitted into a <link href>, so
 * it must name a real file in the project root: basename only, no traversal, no
 * subdirectory. Anything else, or a name that points at nothing, normalises to
 * '' — "there is no image". Every caller has to handle that anyway (a fresh
 * install ships no logo), so returning '' is strictly safer than returning a
 * filename that 404s or makes imagecreatefrom*() emit a warning.
 */
function trax_logo_file(mixed $value, string $default = ''): string
{
    $s = trax_str($value, 120);
    if ($s === '' || $s !== basename($s) || str_contains($s, '..')
        || preg_match('/^[A-Za-z0-9 ._\-]+$/', $s) !== 1) {
        $s = $default;
    }

    $root = dirname(__DIR__);
    if ($s === '' || !is_file($root . '/' . $s)) {
        $s = ($default !== '' && is_file($root . '/' . $default)) ? $default : '';
    }
    return $s;
}

/**
 * Normalises the operator's mail-template overrides.
 *
 * Shape: templates.<key>.{subject, body}, one entry per key in
 * trax_mail_templates(). An empty string means "use the built-in default" —
 * lib/mailer.php falls back to the registry — so the block is always present
 * and always complete, and an unknown key is dropped rather than carried.
 *
 * This is a last line of defence, not the validator: api.php refuses a save
 * with an unknown or missing token and says which. What can still arrive here
 * is a settings block edited by hand or written before a template key existed,
 * so the rules are the ones that must hold no matter what — a subject is one
 * line (it becomes a header) and neither field may be unbounded.
 */
function trax_normalize_mail_templates(mixed $raw): array
{
    $raw = is_array($raw) ? $raw : [];
    $out = [];

    foreach (trax_mail_template_keys() as $key) {
        $entry = is_array($raw[$key] ?? null) ? $raw[$key] : [];

        // Same guard the mailer puts on every header: a newline in a subject is
        // header injection, and this field is operator-editable.
        $subject = str_replace("\r\n", "\n", (string)($entry['subject'] ?? ''));
        $subject = trax_mail_header_safe(trax_str($subject, TRAX_MAX_MAIL_SUBJECT));

        // Bodies keep their newlines but not their carriage returns: a textarea
        // posts CRLF and trax_send_mail() folds them anyway, so storing LF is
        // what makes a saved template compare equal to the one that was typed.
        $body = str_replace(["\r\n", "\r"], "\n", (string)($entry['body'] ?? ''));
        $body = trax_str($body, TRAX_MAX_MAIL_BODY);

        $out[$key] = ['subject' => $subject, 'body' => $body];
    }

    return $out;
}

/** Normalises the settings block. Running it twice changes nothing. */
function trax_normalize_settings(mixed $raw): array
{
    $raw      = is_array($raw) ? $raw : [];
    $email    = is_array($raw['email'] ?? null) ? $raw['email'] : [];
    $branding = is_array($raw['branding'] ?? null) ? $raw['branding'] : [];
    $defaults = is_array($raw['defaults'] ?? null) ? $raw['defaults'] : [];
    $cron     = is_array($raw['cron'] ?? null) ? $raw['cron'] : [];

    return [
        'email' => [
            // Addresses reach mail headers, so they pass the same validator the
            // mailer uses; anything else falls back to the config constant.
            'ownerEmail'                  => trax_valid_email($email['ownerEmail'] ?? null) ?? TRAX_OWNER_EMAIL,
            'fromEmail'                   => trax_valid_email($email['fromEmail'] ?? null) ?? TRAX_FROM_EMAIL,
            'reportFromEmail'             => trax_valid_email($email['reportFromEmail'] ?? null) ?? TRAX_REPORT_FROM_EMAIL,
            'sendCheckoutConfirmation'    => trax_bool($email['sendCheckoutConfirmation'] ?? null, true),
            'sendReservationConfirmation' => trax_bool($email['sendReservationConfirmation'] ?? null, true),
            'sendExtend'                  => trax_bool($email['sendExtend'] ?? null, true),
            'sendCheckin'                 => trax_bool($email['sendCheckin'] ?? null, true),
            // The three cron.php reminders. Each is an independent kill switch:
            // an operator who wants the digest but not the customer nagging can
            // have exactly that.
            'sendDueSoon'                 => trax_bool($email['sendDueSoon'] ?? null, true),
            'sendOverdue'                 => trax_bool($email['sendOverdue'] ?? null, true),
            'sendOwnerDigest'             => trax_bool($email['sendOwnerDigest'] ?? null, true),
            // The editable subject/body of each of the eight mails. Registered
            // HERE or it is dropped on the next unrelated write: trax_mutate()
            // re-normalises the whole tree before it commits, so a key this
            // literal does not name does not survive. Empty entries are the
            // normal state — they mean "use the built-in default".
            'templates'                   => trax_normalize_mail_templates($email['templates'] ?? null),
        ],
        'branding' => [
            // What the product calls itself: the browser title, the wordmark,
            // the PDF file names. Never empty — those three have to say
            // something — so it falls back rather than accepting ''.
            'appName'      => trax_str($branding['appName'] ?? '', 60) ?: 'Assets',
            // Who operates it. Empty is a real value: an install that has not
            // been told an organisation shows the app name alone rather than a
            // placeholder, on screen and on printed labels.
            'orgName'      => trax_str($branding['orgName'] ?? '', 120),
            // Upper case because that is what trax_hex_color() returns; a lower-case
            // literal here would make normalising twice produce a different value.
            'brandColor'   => trax_hex_color($branding['brandColor'] ?? null) ?? '#1F2937',
            'publicPath'   => trax_public_path($branding['publicPath'] ?? null) ?? TRAX_PUBLIC_PATH,
            'logoFile'     => trax_logo_file($branding['logoFile'] ?? null),
            // The generated placeholder favicon ships with the repo, so the
            // default resolves; an install that deletes it gets '' and the
            // templates simply emit no icon link.
            'faviconFile'  => trax_logo_file($branding['faviconFile'] ?? null, 'favicon.png'),
            // The line printed above the organisation on every label. Operators
            // outside English change it here; it is the one label string that
            // is not derived from the asset.
            'labelHeading' => trax_str($branding['labelHeading'] ?? '', 40) ?: 'PROPERTY OF',
            // The number behind the public page's WhatsApp button. Registered
            // HERE or it is dropped on the next unrelated write, like the mail
            // templates above. An empty string is a real, kept value — it means
            // "no WhatsApp button" — so only a MISSING key falls back to the
            // deploy constant, which is why this one tests array_key_exists()
            // instead of using ?: like orgName does. For the same reason it is
            // deliberately absent from trax_setting_constant(): that map fills
            // in on empty, and would resurrect a number the operator cleared.
            'whatsapp'   => array_key_exists('whatsapp', $branding)
                ? trax_whatsapp($branding['whatsapp'])
                : TRAX_WHATSAPP,
        ],
        'defaults' => [
            'loanDays'             => trax_clamp_int($defaults['loanDays'] ?? null, 1, 365, 7),
            'dueHour'              => trax_clamp_int($defaults['dueHour'] ?? null, 0, 23, 18),
            'reservationStartHour' => trax_clamp_int($defaults['reservationStartHour'] ?? null, 0, 23, 9),
            // How far a warranty runs from the purchase date. The asset sheet
            // fills the warranty field in from it when a purchase date is
            // entered; 0 turns that off. Ten years is the ceiling because the
            // field is a convenience, not a contract.
            'warrantyMonths'       => trax_clamp_int($defaults['warrantyMonths'] ?? null, 0, 120, 24),
            'currency'             => trax_str($defaults['currency'] ?? '', 8) ?: 'EUR',
            'allowPartialDefault'  => trax_bool($defaults['allowPartialDefault'] ?? null, false),
            'overdueGraceDays'     => trax_clamp_int($defaults['overdueGraceDays'] ?? null, 0, 90, 0),
            // BCP 47 tag, handed to Intl in the browser for every date, number
            // and currency. Not validated against a list: Intl accepts far more
            // than any list here would name and degrades to the closest match
            // on its own, so the only rule is that it looks like a tag at all.
            'locale'               => trax_locale($defaults['locale'] ?? null),
            // PHP date() format for everything rendered server-side — labels,
            // mails, the public page. The browser uses `locale` instead.
            'dateFormat'           => trax_str($defaults['dateFormat'] ?? '', 40) ?: 'Y-m-d H:i',
        ],
        'cron' => [
            // Shared secret for triggering cron.php over HTTP. Empty means the
            // HTTP trigger is refused outright; CLI never needs it.
            // Single-line: it is compared against a query parameter, and a
            // secret with a newline in it is one nobody can put in a URL.
            'secret'            => trax_mail_header_safe(trax_str($cron['secret'] ?? '', 200)),
            'dueSoonHours'      => trax_clamp_int($cron['dueSoonHours'] ?? null, 1, 168, 24),
            'overdueRepeatDays' => trax_clamp_int($cron['overdueRepeatDays'] ?? null, 1, 90, 7),
        ],
    ];
}

/** The deploy-time constant a settings path falls back to, if it has one. */
function trax_setting_constant(string $path): mixed
{
    return match ($path) {
        'email.ownerEmail'      => TRAX_OWNER_EMAIL,
        'email.fromEmail'       => TRAX_FROM_EMAIL,
        'email.reportFromEmail' => TRAX_REPORT_FROM_EMAIL,
        'branding.publicPath'   => TRAX_PUBLIC_PATH,
        default                 => null,
    };
}

/**
 * Reads one setting by dot path, e.g. trax_setting('email.ownerEmail').
 *
 * Falls back to the matching config constant and then to $default, so it is
 * safe to call against a data.json that has no settings block at all — which
 * is every one written before this existed.
 *
 * The block is read once per request. Mail is sent after trax_mutate() has
 * committed, so the value seen is the one just written.
 */
function trax_setting(string $path, mixed $default = null): mixed
{
    static $settings = null;

    if ($settings === null) {
        $raw      = trax_read_json_file(TRAX_DATA_FILE, []);
        $settings = trax_normalize_settings(is_array($raw) ? ($raw['settings'] ?? null) : null);
    }

    $value = $settings;
    foreach (explode('.', $path) as $key) {
        if (!is_array($value) || !array_key_exists($key, $value)) {
            $value = null;
            break;
        }
        $value = $value[$key];
    }

    if ($value !== null && $value !== '') {
        return $value;
    }
    return trax_setting_constant($path) ?? $default;
}

/**
 * Merges a patch into a settings tree. Nested maps merge key by key so a patch
 * can name one field; lists and scalars replace wholesale.
 */
function trax_deep_merge(array $base, array $patch): array
{
    foreach ($patch as $key => $value) {
        if (is_array($value) && !array_is_list($value) && is_array($base[$key] ?? null)) {
            $base[$key] = trax_deep_merge($base[$key], $value);
            continue;
        }
        $base[$key] = $value;
    }
    return $base;
}

/** Normalises a whole data.json payload. */
function trax_normalize_data(mixed $raw): array
{
    $raw = is_array($raw) ? $raw : [];

    $assets   = [];
    $seenIds  = [];
    $maxId    = 0;
    foreach ((array)($raw['assets'] ?? []) as $item) {
        $asset = trax_normalize_asset($item, ++$maxId);
        if ($asset['id'] <= 0 || in_array($asset['id'], $seenIds, true)) {
            continue;   // drop id-less or duplicate records rather than corrupt the set
        }
        $seenIds[] = $asset['id'];
        $maxId     = max($maxId, $asset['id']);
        $assets[]  = $asset;
    }

    $reservations = array_map('trax_normalize_reservation', (array)($raw['reservations'] ?? []));
    $history      = array_map('trax_normalize_history', (array)($raw['rentalHistory'] ?? []));

    // Bookings are id-keyed like the rest; an id-less record gets the next free
    // one rather than being dropped, because it holds the customer's only copy
    // of what they took.
    $bookings = [];
    $nextId   = 0;
    foreach ((array)($raw['bookings'] ?? []) as $item) {
        $booking = trax_normalize_booking($item);
        $nextId  = max($nextId, $booking['id']);
        if ($booking['id'] <= 0) {
            $booking['id'] = ++$nextId;
        }
        $bookings[] = $booking;
    }

    // This literal IS the schema: a top-level key that is not listed here is
    // dropped on the next write, because trax_mutate() re-normalises before it
    // commits. Add a key only together with its normaliser.
    return [
        'rev'           => max(1, trax_int($raw['rev'] ?? null, 1) ?? 1),
        'assets'        => $assets,
        'events'        => is_array($raw['events'] ?? null) ? $raw['events'] : [],
        'reservations'  => array_values($reservations),
        'rentalHistory' => array_values($history),
        'bookings'      => array_values($bookings),
        'settings'      => trax_normalize_settings($raw['settings'] ?? null),
        'cronState'     => trax_normalize_cron_state($raw['cronState'] ?? null),
    ];
}

/**
 * Normalises the whole checkout list.
 *
 * Deduping happens on `lineId`, never on asset id — that is the change that
 * lets 3 of 8 batteries be out to one person and 2 of 8 to another. Legacy
 * rows (an `id`, no `lineId`) are migrated in place and given the next free
 * lineId, and running this twice changes nothing.
 */
function trax_normalize_checkouts(mixed $raw): array
{
    $byLine  = [];
    $pending = [];

    foreach ((array)$raw as $item) {
        $row = trax_normalize_checkout($item);
        if ($row['assetId'] <= 0) {
            continue;   // drop rows that point at no asset rather than keep a stub
        }
        if ($row['lineId'] > 0) {
            $byLine[$row['lineId']] = $row;   // dedupe by line id
        } else {
            $pending[] = $row;
        }
    }

    $next = 0;
    foreach ($byLine as $lineId => $_) {
        $next = max($next, (int)$lineId);
    }
    foreach ($pending as $row) {
        $row['lineId']          = ++$next;
        $byLine[$row['lineId']] = $row;
    }

    ksort($byLine, SORT_NUMERIC);
    return array_values($byLine);
}

/** Next unused line id. Monotonic, so a returned line never has its id reused. */
function trax_next_line_id(array $checkouts): int
{
    $max = 0;
    foreach ($checkouts as $row) {
        $max = max($max, (int)($row['lineId'] ?? 0));
    }
    return $max + 1;
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

/** Indexes assets by id. */
function trax_index_assets(array $assets): array
{
    $byId = [];
    foreach ($assets as $asset) {
        $byId[$asset['id']] = $asset;
    }
    return $byId;
}

/**
 * Groups open checkout lines by asset id.
 *
 * Replaces trax_index_checkouts(), which collapsed the list to one row per
 * asset and so could not represent two holders of the same asset.
 *
 * @return array<int, array<int, array>>  assetId => [lines]
 */
function trax_group_checkouts_by_asset(array $checkouts): array
{
    $byAsset = [];
    foreach ($checkouts as $row) {
        $assetId = (int)($row['assetId'] ?? 0);
        if ($assetId > 0) {
            $byAsset[$assetId][] = $row;
        }
    }
    return $byAsset;
}

/** Sums the units on a list of checkout lines. A line with no qty counts as 1. */
function trax_lines_qty(array $lines): int
{
    $sum = 0;
    foreach ($lines as $line) {
        $sum += is_array($line) ? max(1, trax_int($line['qty'] ?? null, 1) ?? 1) : 1;
    }
    return $sum;
}

/** Units of one asset currently out across every open line. */
function trax_out_qty(int $assetId, array $checkouts): int
{
    $sum = 0;
    foreach ($checkouts as $row) {
        if ((int)($row['assetId'] ?? 0) === $assetId) {
            $sum += max(1, (int)($row['qty'] ?? 1));
        }
    }
    return $sum;
}

/**
 * An asset an operator has taken off the shelf by hand: LOCK (blocked) or a
 * stamped UNAV. Nothing of it can go out, whatever the unit maths says. This
 * is the same rule kit members are already judged by in
 * trax_effective_status().
 */
function trax_is_blocked(array $asset): bool
{
    $status = $asset['status'] ?? '';
    return $status === 'LOCK' || $status === 'UNAV';
}

/** True when this asset tracks its physical units one by one. */
function trax_asset_has_units(array $asset): bool
{
    return ($asset['kind'] ?? 'ITEM') !== 'SET' && !empty($asset['units']);
}

/** How a unit is written and scanned everywhere: asset id, dot, unit number. */
function trax_unit_code(int $assetId, int $no): string
{
    return $assetId . '.' . $no;
}

/**
 * What each unit of an asset is doing right now, keyed by unit number.
 *
 * The state is derived, never stored: OUT when an open line names the unit —
 * even a unit flagged out of service, because the gear is physically gone and
 * saying otherwise would let it be handed out twice — else OOS when it is
 * flagged, else FREE.
 *
 * @param  array $linesForAsset  the open checkout lines of THIS asset
 * @return array<int, array{state:string, lineId:?int, customerName:?string, dueAt:?string}>
 */
function trax_unit_states(array $asset, array $linesForAsset): array
{
    // Where each unit number is out, if it is. First line wins; a unit named
    // on two open lines is a data error, not a state.
    $outBy = [];
    foreach ($linesForAsset as $line) {
        foreach (trax_unit_nos($line['unitNos'] ?? null) as $no) {
            if (!isset($outBy[$no])) {
                $outBy[$no] = $line;
            }
        }
    }

    $states = [];
    foreach ((array)($asset['units'] ?? []) as $unit) {
        $no = (int)($unit['no'] ?? 0);
        if ($no <= 0) {
            continue;
        }
        $line = $outBy[$no] ?? null;
        if ($line !== null) {
            $states[$no] = [
                'state'        => 'OUT',
                'lineId'       => (int)($line['lineId'] ?? 0),
                'customerName' => (string)($line['customerName'] ?? ''),
                'dueAt'        => $line['dueAt'] ?? null,
            ];
            continue;
        }
        $states[$no] = [
            'state'        => !empty($unit['outOfService']) ? 'OOS' : 'FREE',
            'lineId'       => null,
            'customerName' => null,
            'dueAt'        => null,
        ];
    }
    return $states;
}

/**
 * The unit numbers that could go out right now, ascending.
 *
 * @param  array $linesForAsset  the open checkout lines of THIS asset
 * @return array<int, int>
 */
function trax_available_unit_nos(array $asset, array $linesForAsset): array
{
    $free = [];
    foreach (trax_unit_states($asset, $linesForAsset) as $no => $state) {
        if ($state['state'] === 'FREE') {
            $free[] = $no;
        }
    }
    sort($free);
    return $free;
}

/**
 * Units of an asset that could go out right now, from the lines of that one
 * asset. THE availability rule: trax_available_qty(), the decorator and the
 * checkout and conversion loops all come here. They used to carry three
 * copies of `quantity - lines_qty` and the copies drifted.
 *
 * For a unit-tracking asset the count is the free units, minus whatever a
 * pre-feature line still holds without naming which unit it took — that line
 * is a claim on some unit, and counting the free ones in full would hand the
 * same piece of gear out twice.
 *
 * @param array $linesForAsset  the open checkout lines of THIS asset
 */
function trax_available_qty_for(array $asset, array $linesForAsset): int
{
    if (trax_is_blocked($asset)) {
        return 0;
    }

    if (trax_asset_has_units($asset)) {
        $legacyQty = 0;
        foreach ($linesForAsset as $line) {
            if (trax_unit_nos($line['unitNos'] ?? null) === []) {
                $legacyQty += max(1, trax_int($line['qty'] ?? null, 1) ?? 1);
            }
        }
        return max(0, count(trax_available_unit_nos($asset, $linesForAsset)) - $legacyQty);
    }

    $quantity = max(1, (int)($asset['quantity'] ?? 1));
    return max(0, $quantity - trax_lines_qty($linesForAsset));
}

/** Units of an asset that could go out right now, from the whole checkout list. */
function trax_available_qty(array $asset, array $checkouts): int
{
    $assetId = (int)($asset['id'] ?? 0);
    $lines   = array_values(array_filter(
        $checkouts,
        static fn($row): bool => is_array($row) && (int)($row['assetId'] ?? 0) === $assetId
    ));
    return trax_available_qty_for($asset, $lines);
}

/**
 * An item's status is derived from how many of its units are out:
 *   own LOCK                    -> LOCK
 *   available == 0              -> UNAV
 *   0 < available < quantity    -> PARTIAL
 *   otherwise                   -> the stored status (FREE / RSVD)
 * For a quantity-1 asset this reduces to the stored status, exactly as before.
 *
 * A set's status is derived, never stored:
 *   own LOCK                    -> LOCK
 *   any member short of its qty -> PARTIAL
 *   any member RSVD             -> RSVD
 *   otherwise                   -> FREE
 *
 * @param array<int, array<int, array>> $linesByAssetId  from trax_group_checkouts_by_asset()
 */
function trax_effective_status(array $asset, array $assetsById, array $linesByAssetId): string
{
    if ($asset['status'] === 'LOCK') {
        return 'LOCK';
    }

    if ($asset['kind'] !== 'SET') {
        $lines     = $linesByAssetId[$asset['id']] ?? [];
        $quantity  = max(1, (int)($asset['quantity'] ?? 1));
        $available = trax_available_qty_for($asset, $lines);

        // Nothing free and nothing out: every unit this asset has is flagged
        // out of service. That is not "lent out", it is off the shelf — the
        // same thing a hand-set LOCK means. Unreachable without units: an
        // asset counted by quantity alone can only reach 0 by lending.
        if ($available === 0 && !trax_is_blocked($asset) && trax_lines_qty($lines) === 0) {
            return 'LOCK';
        }
        if ($available === 0) {
            return 'UNAV';
        }
        if ($available < $quantity) {
            return 'PARTIAL';
        }
        return $asset['status'];
    }

    if ($asset['members'] === []) {
        return $asset['status'];
    }

    $anyShort = false;
    $anyRsvd  = false;
    foreach ($asset['members'] as $member) {
        $memberId = (int)($member['assetId'] ?? 0);
        $target   = $assetsById[$memberId] ?? null;
        if ($target === null) {
            continue;
        }
        $wanted    = max(1, (int)($member['qty'] ?? 1));
        $available = trax_available_qty_for($target, $linesByAssetId[$memberId] ?? []);

        // A member stamped UNAV or LOCK by hand blocks the kit too, which is
        // what the pre-quantity code did and what an operator expects.
        if ($available < $wanted || $target['status'] === 'UNAV' || $target['status'] === 'LOCK') {
            $anyShort = true;
        } elseif ($target['status'] === 'RSVD') {
            $anyRsvd = true;
        }
    }

    if ($anyShort) {
        return 'PARTIAL';
    }
    if ($anyRsvd) {
        return 'RSVD';
    }
    return 'FREE';
}

/**
 * Refuses a quantity that is smaller than what is already out, which would
 * otherwise leave an asset with a negative availability it can never clear.
 */
function trax_assert_quantity_covers_checkouts(array $asset, array $checkouts): void
{
    $out = trax_out_qty((int)$asset['id'], $checkouts);
    if ((int)$asset['quantity'] < $out) {
        throw new TraxInvalid(
            "\"{$asset['name']}\" has {$out} unit(s) checked out; its quantity cannot be set below {$out}."
        );
    }
}

/**
 * Expands a mixed list of items and sets into the flat list of item units
 * they resolve to. Sets contribute their members, multiplied by how many of
 * the set was asked for; unknown ids are dropped. Because nesting is one
 * level deep, this needs no recursion.
 *
 * Multiplicities are SUMMED, not deduped away: asking for a kit that holds
 * 2 batteries plus 1 loose battery is a demand for 3 batteries.
 *
 * @param  array $items  bare ids and/or {assetId|id, qty, unitNos}
 * @return array<int, array{assetId:int, qty:int, unitNos:array<int,int>}>
 */
function trax_expand_items(array $items, array $assetsById): array
{
    $out   = [];
    $index = [];

    $add = static function (int $assetId, int $qty, array $unitNos = []) use (&$out, &$index): void {
        $qty = max(1, min(TRAX_MAX_QUANTITY, $qty));
        if (isset($index[$assetId])) {
            $out[$index[$assetId]]['qty']     = min(TRAX_MAX_QUANTITY, $out[$index[$assetId]]['qty'] + $qty);
            $out[$index[$assetId]]['unitNos'] = trax_unit_nos(array_merge($out[$index[$assetId]]['unitNos'], $unitNos));
            return;
        }
        $index[$assetId] = count($out);
        $out[]           = ['assetId' => $assetId, 'qty' => $qty, 'unitNos' => $unitNos];
    };

    foreach ($items as $item) {
        [$id, $qty, $unitNos] = trax_item_pair($item);
        $asset                = $id === null ? null : ($assetsById[$id] ?? null);
        if ($asset === null) {
            continue;
        }
        if ($asset['kind'] === 'SET') {
            foreach ($asset['members'] as $member) {
                $memberId = (int)($member['assetId'] ?? 0);
                $target   = $assetsById[$memberId] ?? null;
                if ($target !== null && $target['kind'] !== 'SET') {
                    // A unit choice on a kit line is meaningless — it would
                    // name units of the kit, which has none. Members are
                    // auto-assigned at checkout like any unnamed demand.
                    $add($memberId, $qty * max(1, (int)($member['qty'] ?? 1)));
                }
            }
        } else {
            $add($id, $qty, $unitNos);
        }
    }

    return $out;
}

/**
 * The asset ids trax_expand_items() resolves to, without the quantities.
 * Kept for callers and checks that only care about which assets are involved.
 */
function trax_expand_ids(array $ids, array $assetsById): array
{
    return array_column(trax_expand_items($ids, $assetsById), 'assetId');
}

/** Splits a mixed item list into [setIds, itemIds] without expanding. */
function trax_partition_ids(array $items, array $assetsById): array
{
    $sets  = [];
    $items_ = [];
    foreach ($items as $item) {
        [$id, ] = trax_item_pair($item);
        $asset  = $id === null ? null : ($assetsById[$id] ?? null);
        if ($asset === null) {
            continue;
        }
        if ($asset['kind'] === 'SET') {
            $sets[] = $id;
        } else {
            $items_[] = $id;
        }
    }
    return [array_values(array_unique($sets)), array_values(array_unique($items_))];
}

/**
 * Names the set an item was pulled in with, for a blocking message like
 * "SD 128GB (in Camera Kit A) is out with MaxM". Returns null for loose items.
 */
function trax_blocking_set_name(int $itemId, array $setIds, array $assetsById): ?string
{
    foreach ($setIds as $setId) {
        $set = $assetsById[$setId] ?? null;
        if ($set === null) {
            continue;
        }
        foreach ($set['members'] as $member) {
            if ((int)($member['assetId'] ?? 0) === $itemId) {
                return $set['name'];
            }
        }
    }
    return null;
}

/** Whether a set holds a given member, whatever quantity of it. */
function trax_set_holds(array $set, int $memberId): bool
{
    foreach ($set['members'] ?? [] as $member) {
        if ((int)($member['assetId'] ?? 0) === $memberId) {
            return true;
        }
    }
    return false;
}

/**
 * Rejects set definitions that would nest or self-reference.
 * Nesting is capped at one level, which is what makes status derivation
 * a single pass and cycles impossible.
 */
function trax_assert_valid_set(int $setId, array $members, array $assetsById): void
{
    foreach ($members as $entry) {
        [$memberId, ] = trax_item_pair($entry, TRAX_MAX_MEMBER_QTY);
        if ($memberId === null) {
            continue;
        }
        if ($memberId === $setId) {
            throw new TraxInvalid('A set cannot contain itself.');
        }
        $member = $assetsById[$memberId] ?? null;
        if ($member === null) {
            throw new TraxInvalid("Member #{$memberId} does not exist.");
        }
        if ($member['kind'] === 'SET') {
            throw new TraxInvalid(
                "\"{$member['name']}\" is itself a set. Sets cannot be nested — add its items directly."
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function trax_read_json_file(string $path, mixed $fallback): mixed
{
    if (!is_file($path)) {
        return $fallback;
    }
    $raw = file_get_contents($path);
    if ($raw === false || trim($raw) === '') {
        return $fallback;
    }
    $decoded = json_decode($raw, true);
    return $decoded === null && json_last_error() !== JSON_ERROR_NONE ? $fallback : $decoded;
}

function trax_read_data(): array
{
    return trax_normalize_data(trax_read_json_file(TRAX_DATA_FILE, []));
}

function trax_read_checkouts(): array
{
    return trax_normalize_checkouts(trax_read_json_file(TRAX_CHECKOUT_FILE, []));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Writes a file atomically: tmp file in the same directory, then rename(). */
function trax_write_atomic(string $path, string $contents): void
{
    $dir = dirname($path);
    $tmp = tempnam($dir, '.trax');
    if ($tmp === false) {
        throw new RuntimeException("Cannot create a temporary file in {$dir}.");
    }

    try {
        $fh = fopen($tmp, 'wb');
        if ($fh === false) {
            throw new RuntimeException("Cannot open {$tmp}.");
        }
        try {
            if (fwrite($fh, $contents) !== strlen($contents)) {
                throw new RuntimeException("Short write to {$tmp}.");
            }
            fflush($fh);
            // Without this, a power loss between rename() and the kernel flushing
            // its buffers can leave a zero-length file at the committed path.
            if (function_exists('fsync')) {
                @fsync($fh);
            }
        } finally {
            fclose($fh);
        }

        @chmod($tmp, 0644);
        // rename() is atomic within a filesystem, so readers never see a partial file.
        if (!rename($tmp, $path)) {
            throw new RuntimeException("Cannot commit {$path}.");
        }
    } catch (Throwable $e) {
        @unlink($tmp);
        throw $e;
    }
}

function trax_encode(mixed $value): string
{
    $json = json_encode(
        $value,
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
        | JSON_PRESERVE_ZERO_FRACTION
    );
    if ($json === false) {
        throw new RuntimeException('Cannot encode data: ' . json_last_error_msg());
    }
    return $json;
}

/**
 * The single write path.
 *
 * Holds an exclusive lock across read-modify-write of BOTH data.json and
 * checkout.json, so operations that span the two (a checkout touches asset
 * status, checkout records and history) commit together.
 *
 * $mutator receives both datasets by reference and may modify them freely;
 * whatever it returns is passed back to the caller as the action's result.
 *
 * @param  ?int     $expectedRev  rev the client last saw; null skips the check
 * @param  callable $mutator      fn(array &$data, array &$checkouts): mixed
 * @return array{rev:int, data:array, checkouts:array, result:mixed}
 * @throws TraxConflict when $expectedRev is stale
 */
function trax_mutate(?int $expectedRev, callable $mutator): array
{
    $lockPath = TRAX_DATA_DIR . '/.trax.lock';
    $lock     = fopen($lockPath, 'c');
    if ($lock === false) {
        throw new RuntimeException('Cannot open the data lock. Is the directory writable?');
    }

    try {
        if (!flock($lock, LOCK_EX)) {
            throw new RuntimeException('Cannot acquire the data lock.');
        }

        // Read inside the lock — this is what the old code failed to do.
        $data      = trax_read_data();
        $checkouts = trax_read_checkouts();

        if ($expectedRev !== null && $expectedRev !== $data['rev']) {
            throw new TraxConflict(
                'This was changed elsewhere since you loaded it.',
                ['rev' => $data['rev'], 'data' => $data, 'checkouts' => $checkouts]
            );
        }

        $result = $mutator($data, $checkouts);

        // Re-normalise so a mutator can never persist a malformed record.
        $data          = trax_normalize_data($data);
        $checkouts     = trax_normalize_checkouts($checkouts);
        $data['rev']   = $data['rev'] + 1;

        // Keep one rolling backup so a bad write stays recoverable.
        if (is_file(TRAX_DATA_FILE)) {
            @copy(TRAX_DATA_FILE, TRAX_DATA_FILE . '.bak');
        }

        trax_write_atomic(TRAX_DATA_FILE, trax_encode($data));
        trax_write_atomic(TRAX_CHECKOUT_FILE, trax_encode($checkouts));

        return [
            'rev'       => $data['rev'],
            'data'      => $data,
            'checkouts' => $checkouts,
            'result'    => $result,
        ];
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

// ---------------------------------------------------------------------------
// Helpers used by the API actions
// ---------------------------------------------------------------------------

function trax_next_asset_id(array $assets): int
{
    $max = 0;
    foreach ($assets as $asset) {
        $max = max($max, (int)$asset['id']);
    }
    return $max + 1;
}

function trax_next_reservation_id(array $reservations): int
{
    $max = 0;
    foreach ($reservations as $reservation) {
        $max = max($max, (int)$reservation['id']);
    }
    return $max + 1;
}

/** Appends a history entry in place. */
function trax_append_history(array &$data, string $type, array $payload = []): void
{
    $entry = trax_normalize_history(array_merge(
        [
            'id'   => (int)(microtime(true) * 1000),
            'type' => $type,
            'at'   => gmdate('Y-m-d\TH:i:s.000\Z'),
        ],
        $payload
    ));

    // Guarantee a unique id even when several entries land in the same millisecond.
    $used = [];
    foreach ($data['rentalHistory'] as $row) {
        $used[$row['id']] = true;
    }
    while (isset($used[$entry['id']])) {
        $entry['id']++;
    }

    $data['rentalHistory'][] = $entry;
}

/** The taxonomy fields that live as free text on an asset. */
const TRAX_TAXONOMY_KINDS = ['category', 'location', 'tag'];

/**
 * Rewrites a category, location or tag across every asset.
 *
 * There is no registry of these values — they are free text on the records, and
 * a registry would drift from them. Renaming is therefore a bulk rewrite of the
 * assets themselves, done inside trax_mutate() so it commits under the lock.
 *
 * Matching is exact on the trax_str-normalised value, which is the form the
 * assets store. $to === null deletes: the field is cleared, or the tag dropped.
 *
 * @param  string[] $from  values to replace; blanks and repeats are ignored
 * @return int             how many assets changed
 */
function trax_taxonomy_apply(array &$data, string $kind, array $from, ?string $to): int
{
    if (!in_array($kind, TRAX_TAXONOMY_KINDS, true)) {
        throw new TraxInvalid("Unknown taxonomy kind \"{$kind}\".");
    }

    $needles = [];
    foreach ($from as $value) {
        $needle = trax_str($value, 120);
        if ($needle !== '' && !in_array($needle, $needles, true)) {
            $needles[] = $needle;
        }
    }
    if ($needles === []) {
        throw new TraxInvalid('Name at least one value to change.');
    }

    $changed = 0;
    foreach ($data['assets'] as $index => $asset) {
        if ($kind === 'tag') {
            $tags = [];
            foreach ($asset['tags'] as $tag) {
                if (in_array($tag, $needles, true)) {
                    if ($to === null) {
                        continue;       // delete
                    }
                    $tag = $to;         // rename / merge, then re-dedupe below
                }
                if ($tag !== '' && !in_array($tag, $tags, true)) {
                    $tags[] = $tag;
                }
            }
            if ($tags !== $asset['tags']) {
                $data['assets'][$index]['tags'] = $tags;
                $changed++;
            }
            continue;
        }

        $replacement = $to ?? '';
        if (in_array($asset[$kind], $needles, true) && $asset[$kind] !== $replacement) {
            $data['assets'][$index][$kind] = $replacement;
            $changed++;
        }
    }

    return $changed;
}

/** Finds an asset by id, or null. */
function trax_find_asset(array $assets, int $id): ?array
{
    foreach ($assets as $asset) {
        if ((int)$asset['id'] === $id) {
            return $asset;
        }
    }
    return null;
}

/** Applies a callback to the asset with the given id, in place. */
function trax_update_asset(array &$data, int $id, callable $fn): bool
{
    foreach ($data['assets'] as $index => $asset) {
        if ((int)$asset['id'] === $id) {
            $data['assets'][$index] = $fn($asset);
            return true;
        }
    }
    return false;
}

/**
 * What one asset is worth, derived — never stored.
 *
 * A unit-tracking asset prices itself unit by unit: as soon as a single unit
 * carries a price the list is the source of truth, and units still without one
 * count as 0 rather than guessing the asset price onto them. Everything else
 * falls back to the old `price x quantity`. Each unit price is already rounded
 * to 2 dp by the normaliser, so the sum is rounded once more only to clear the
 * float noise of adding them up.
 *
 * @return array{0:bool, 1:?float, 2:int}  [unitPriced, priceTotal, pricedUnits]
 */
function trax_asset_value(array $asset): array
{
    $pricedUnits = 0;
    $sum         = 0.0;

    if (trax_asset_has_units($asset)) {
        foreach ((array)($asset['units'] ?? []) as $unit) {
            $price = $unit['price'] ?? null;
            if ($price === null) {
                continue;
            }
            $pricedUnits++;
            $sum += (float)$price;
        }
    }

    if ($pricedUnits > 0) {
        return [true, round($sum, 2), $pricedUnits];
    }

    $price = $asset['price'] ?? null;
    if ($price === null) {
        return [false, null, 0];
    }

    return [false, round((float)$price * (int)($asset['quantity'] ?? 1), 2), 0];
}

/**
 * When an asset was bought and when its warranty runs out, derived — never
 * stored.
 *
 * Same shape as trax_asset_value(): once a single unit names a date, the unit
 * list is the source of truth and the asset's own dates are not consulted.
 * A unit list is a list of things bought on different days, so a single
 * asset-level "purchased" is a fiction there — and the warranty that matters
 * is the *next* one to lapse, not the asset's.
 *
 * `YYYY-MM-DD` sorts lexically, so plain string comparison is the earliest.
 *
 * @return array{0:bool, 1:?string, 2:?string, 3:?int}
 *         [unitDated, purchasedFirst, warrantyNext, warrantyNextUnit]
 */
function trax_asset_dates(array $asset): array
{
    $purchasedFirst   = null;
    $warrantyNext     = null;
    $warrantyNextUnit = null;

    if (trax_asset_has_units($asset)) {
        foreach ((array)($asset['units'] ?? []) as $unit) {
            $purchased = $unit['purchasedAt'] ?? null;
            if ($purchased !== null && ($purchasedFirst === null || $purchased < $purchasedFirst)) {
                $purchasedFirst = $purchased;
            }

            $warranty = $unit['warrantyUntil'] ?? null;
            if ($warranty !== null && ($warrantyNext === null || $warranty < $warrantyNext)) {
                $warrantyNext     = $warranty;
                $warrantyNextUnit = (int)$unit['no'];
            }
        }
    }

    if ($purchasedFirst !== null || $warrantyNext !== null) {
        return [true, $purchasedFirst, $warrantyNext, $warrantyNextUnit];
    }

    // No unit named a date — the asset's own fields still stand.
    return [false, $asset['purchasedAt'] ?? null, $asset['warrantyUntil'] ?? null, null];
}

/**
 * Decorates assets with their derived status and set membership info for
 * the client, without ever persisting the derived values.
 */
function trax_decorate_assets(array $assets, array $checkouts): array
{
    $assetsById = trax_index_assets($assets);
    $linesBy    = trax_group_checkouts_by_asset($checkouts);

    $memberOf = [];
    foreach ($assets as $asset) {
        if ($asset['kind'] === 'SET') {
            foreach ($asset['members'] as $member) {
                $memberOf[(int)($member['assetId'] ?? 0)][] = $asset['id'];
            }
        }
    }

    return array_map(static function (array $asset) use ($assetsById, $linesBy, $memberOf): array {
        $lines  = $linesBy[$asset['id']] ?? [];
        $outQty = trax_lines_qty($lines);

        $asset['effectiveStatus'] = trax_effective_status($asset, $assetsById, $linesBy);
        $asset['memberOf']        = $memberOf[$asset['id']] ?? [];
        $asset['outQty']          = $outQty;
        $asset['availableQty']    = trax_available_qty_for($asset, $lines);
        $asset['isOut']           = $outQty > 0;

        // Per-unit state, for the drawer and the return screen. Derived keys
        // only: trax_normalize_asset() drops them again on write, so nothing
        // here can be persisted or read back as truth.
        if (trax_asset_has_units($asset)) {
            $states = trax_unit_states($asset, $lines);
            foreach ($asset['units'] as $i => $unit) {
                $state = $states[(int)$unit['no']] ?? null;
                $asset['units'][$i]['state']        = $state['state']        ?? 'FREE';
                $asset['units'][$i]['lineId']       = $state['lineId']       ?? null;
                $asset['units'][$i]['customerName'] = $state['customerName'] ?? null;
                $asset['units'][$i]['dueAt']        = $state['dueAt']        ?? null;
            }
            $asset['availableUnitNos'] = trax_available_unit_nos($asset, $lines);
        } else {
            $asset['availableUnitNos'] = [];
        }

        // What the asset is worth. Once any unit carries a price, the units are
        // the source of truth and the asset's own price is not consulted at all
        // — two of the same model rarely cost the same twice, and the stored
        // asset price stays exactly as the client last sent it.
        [$asset['unitPriced'], $asset['priceTotal'], $asset['pricedUnits']] = trax_asset_value($asset);

        // When it was bought and when the warranty lapses, by the same rule:
        // the units answer for themselves as soon as one of them names a date.
        [
            $asset['unitDated'],
            $asset['purchasedFirst'],
            $asset['warrantyNext'],
            $asset['warrantyNextUnit'],
        ] = trax_asset_dates($asset);

        return $asset;
    }, $assets);
}
