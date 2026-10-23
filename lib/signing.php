<?php
/**
 * Signing a hand-over on a phone.
 *
 * At the counter the operator's screen may be a desktop with a mouse — no way
 * to sign. The signature dialog then shows a QR code; the customer scans it
 * and signs on the phone, on sign.php?t=<token>. While they draw, the strokes
 * reach the desktop (it polls sign.poll) so the operator sees the signature
 * appear; "Done" on the phone stores it on the booking directly.
 *
 * A sign session is short-lived and lives OUTSIDE data.json, in
 * sign-sessions.json beside it: live strokes are written several times a
 * second while somebody draws, and none of that is data worth a revision,
 * a backup or a place in every snapshot. Only the finished signature is, and
 * it goes through trax_mutate() like every other write.
 *
 * The token is the only key (192 random bits), it names one booking, and it
 * dies after TRAX_SIGN_TTL seconds, on cancel, or once used.
 */

declare(strict_types=1);

require_once __DIR__ . '/store.php';

if (!defined('TRAX_SIGN_FILE')) define('TRAX_SIGN_FILE', TRAX_DATA_DIR . '/sign-sessions.json');
/** How long a QR code stays valid. Long enough to read the terms. */
if (!defined('TRAX_SIGN_TTL')) define('TRAX_SIGN_TTL', 20 * 60);
/** Upper bounds for a live drawing — far beyond any real signature. */
const TRAX_SIGN_MAX_STROKES = 400;
const TRAX_SIGN_MAX_POINTS  = 12000;

/** A sign token: 48 lowercase hex characters, or null. */
function trax_sign_token(mixed $value): ?string
{
    $s = is_string($value) ? strtolower(trim($value)) : '';
    return preg_match('/^[0-9a-f]{48}$/', $s) === 1 ? $s : null;
}

/**
 * Read-modify-write of the session file under its own lock, expired sessions
 * dropped on the way. $fn gets the sessions by reference and returns a result.
 */
function trax_sign_sessions_update(callable $fn): mixed
{
    $lock = fopen(TRAX_DATA_DIR . '/.sign.lock', 'c');
    if ($lock === false) {
        throw new RuntimeException('Cannot open the signing lock.');
    }
    try {
        flock($lock, LOCK_EX);
        $raw      = trax_read_json_file(TRAX_SIGN_FILE, []);
        $sessions = is_array($raw) ? $raw : [];
        $now      = time();
        foreach ($sessions as $token => $session) {
            if (!is_array($session) || (int)($session['expires'] ?? 0) < $now) {
                unset($sessions[$token]);
            }
        }
        $result = $fn($sessions);
        trax_write_atomic(TRAX_SIGN_FILE, json_encode($sessions, JSON_UNESCAPED_SLASHES) ?: '{}');
        return $result;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/** One live session by token, or null when unknown, expired or finished. */
function trax_sign_session(?string $token): ?array
{
    if ($token === null) {
        return null;
    }
    $raw     = trax_read_json_file(TRAX_SIGN_FILE, []);
    $session = is_array($raw) ? ($raw[$token] ?? null) : null;
    if (!is_array($session) || (int)($session['expires'] ?? 0) < time()) {
        return null;
    }
    return $session;
}

/** Opens a session for one booking and returns its token. */
function trax_sign_session_create(int $bookingId, string $actor): string
{
    $token = bin2hex(random_bytes(24));
    trax_sign_sessions_update(static function (array &$sessions) use ($token, $bookingId, $actor): void {
        // One open session per booking: a second QR code replaces the first.
        foreach ($sessions as $key => $session) {
            if ((int)($session['bookingId'] ?? 0) === $bookingId && ($session['status'] ?? '') === 'open') {
                unset($sessions[$key]);
            }
        }
        $sessions[$token] = [
            'bookingId' => $bookingId,
            'actor'     => $actor,
            'status'    => 'open',     // open | signing | done | cancelled
            'expires'   => time() + TRAX_SIGN_TTL,
            'strokes'   => [],
            'aspect'    => 2.2,
            'seq'       => 0,
        ];
    });
    return $token;
}

/**
 * Strokes as they may be stored: a list of lists of {x, y} in 0..1, rounded,
 * capped. Anything else is dropped rather than refused — it is a preview.
 */
function trax_sign_clean_strokes(mixed $raw): array
{
    $out    = [];
    $points = 0;
    foreach (is_array($raw) ? $raw : [] as $stroke) {
        if (count($out) >= TRAX_SIGN_MAX_STROKES || !is_array($stroke)) {
            break;
        }
        $clean = [];
        foreach ($stroke as $p) {
            if ($points >= TRAX_SIGN_MAX_POINTS || !is_array($p)) {
                break;
            }
            $x = is_numeric($p['x'] ?? null) ? (float)$p['x'] : null;
            $y = is_numeric($p['y'] ?? null) ? (float)$p['y'] : null;
            if ($x === null || $y === null) {
                continue;
            }
            $clean[] = ['x' => round(min(1, max(0, $x)), 4), 'y' => round(min(1, max(0, $y)), 4)];
            $points++;
        }
        if ($clean !== []) {
            $out[] = $clean;
        }
    }
    return $out;
}

/** Stores the live drawing of a session; false when it is gone. */
function trax_sign_session_strokes(string $token, mixed $strokes, mixed $aspect): bool
{
    $clean     = trax_sign_clean_strokes($strokes);
    $aspectNum = is_numeric($aspect) ? min(6, max(0.5, (float)$aspect)) : 2.2;
    return (bool)trax_sign_sessions_update(static function (array &$sessions) use ($token, $clean, $aspectNum): bool {
        if (!isset($sessions[$token]) || !in_array($sessions[$token]['status'], ['open', 'signing'], true)) {
            return false;
        }
        $sessions[$token]['strokes'] = $clean;
        $sessions[$token]['aspect']  = round($aspectNum, 3);
        $sessions[$token]['status']  = $clean === [] ? 'open' : 'signing';
        $sessions[$token]['seq']     = (int)$sessions[$token]['seq'] + 1;
        return true;
    });
}

/** Marks a session done or cancelled. It stays readable until it expires. */
function trax_sign_session_finish(string $token, string $status): void
{
    trax_sign_sessions_update(static function (array &$sessions) use ($token, $status): void {
        if (isset($sessions[$token])) {
            $sessions[$token]['status'] = $status;
            if ($status === 'cancelled') {
                $sessions[$token]['strokes'] = [];
            }
        }
    });
}

/**
 * Stores a hand-over signature on a booking, inside trax_mutate().
 *
 * The one rule for both ways of signing — the counter (booking.sign) and the
 * customer's phone (sign.php): the terms and the privacy notice in force must
 * be ticked, against the versions the page showed, checked under the lock.
 *
 * @return array{replaced: ?string, customerName: string}
 * @throws TraxInvalid
 */
function trax_booking_store_signature(
    array &$data, int $bookingId, string $name, string $file, string $actor, string $source,
    bool $accept, ?int $termsVersion, ?int $privacyVersion
): array {
    $booking = trax_find_booking($data['bookings'], $bookingId);
    if ($booking === null) {
        throw new TraxInvalid("Booking #{$bookingId} not found.");
    }

    $terms = trax_signature_terms($data, $accept, $termsVersion);
    if ($terms['error'] === 'accept') {
        throw new TraxInvalid('The customer has to accept the terms & conditions before signing.');
    }
    if ($terms['error'] === 'changed') {
        throw new TraxInvalid('The terms & conditions were changed since this page was loaded. '
            . 'Reload, let the customer read the new version and sign again.');
    }
    $privacy = trax_signature_legal($data, 'privacy', $accept, $privacyVersion);
    if ($privacy['error'] === 'accept') {
        throw new TraxInvalid('The customer has to acknowledge the privacy notice before signing.');
    }
    if ($privacy['error'] === 'changed') {
        throw new TraxInvalid('The privacy notice was changed since this page was loaded. '
            . 'Reload, let the customer read the new version and sign again.');
    }

    $replaced = $booking['signature']['file'] ?? null;
    $signedBy = $name !== '' ? $name : (string)$booking['customerName'];

    trax_update_booking($data, $bookingId, static function (array $b) use ($signedBy, $file, $actor, $source, $terms, $privacy): array {
        $b['signatureDeclined'] = null;
        $b['signature'] = [
            'file'    => $file,
            'name'    => $signedBy,
            'at'      => gmdate('Y-m-d\TH:i:s.000\Z'),
            'source'  => $source,
            'actor'   => $actor,
            'terms'   => $terms['terms'],
            'privacy' => $privacy['ref'],
        ];
        return $b;
    });

    trax_append_history($data, 'booking_signed', [
        'customerName' => $booking['customerName'],
        'note'         => 'Hand-over signed by ' . $signedBy . ($source === 'CUSTOMER' ? ' (on their phone)' : ''),
        'actor'        => $actor,
    ]);

    return ['replaced' => is_string($replaced) ? $replaced : null, 'customerName' => (string)$booking['customerName']];
}

/** The QR code for a sign link, as a PNG data URI ('' without phpqrcode). */
function trax_sign_qr_data_uri(string $url): string
{
    $library = dirname(__DIR__) . '/phpqrcode/qrlib.php';
    if (!is_file($library)) {
        return '';
    }
    require_once $library;
    // Into a temp file, not to output: with no file phpqrcode also sends a
    // Content-Type header, which would turn the API's JSON answer into a PNG.
    $tmp = tempnam(sys_get_temp_dir(), 'trax-qr');
    if ($tmp === false) {
        return '';
    }
    try {
        QRcode::png($url, $tmp, QR_ECLEVEL_M, 6, 2);
        $png = (string)@file_get_contents($tmp);
    } finally {
        @unlink($tmp);
    }
    return $png === '' ? '' : 'data:image/png;base64,' . base64_encode($png);
}

/** sign.php for a token. */
function trax_sign_url(string $token): string
{
    return trax_base_url() . '/sign.php?t=' . $token;
}
