<?php
/**
 * Central configuration.
 *
 * Everything deployment-specific lives here, and every value below is a
 * DEFAULT: lib/config.local.php is read first (it is written by the installer
 * and never shipped), so anything it defines wins and the matching line here
 * becomes a no-op. That is why every constant is guarded by defined() rather
 * than declared with `const` — a `const` cannot be overridden.
 */

declare(strict_types=1);

// --- Deployment overrides --------------------------------------------------
//
// Must come first: a constant can only be defined once, so the local file only
// has a say if it runs before the defaults. It is absent on a fresh checkout
// and that is a working state — the defaults below are all neutral.
if (is_file(__DIR__ . '/config.local.php')) {
    require_once __DIR__ . '/config.local.php';
}

// --- Paths -----------------------------------------------------------------

/**
 * Directory holding the JSON data files (this project's root).
 *
 * The TRAX_DATA_DIR environment variable overrides it, but only when it names a
 * readable directory. Production sets nothing and gets the project root exactly
 * as before; the test runner points it at a throwaway sandbox so the suites can
 * drive the real API over HTTP without ever writing to the live data.
 */
$traxDataDir = getenv('TRAX_DATA_DIR');
if (!defined('TRAX_DATA_DIR')) {
    define(
        'TRAX_DATA_DIR',
        (is_string($traxDataDir) && $traxDataDir !== '' && is_dir($traxDataDir) && is_readable($traxDataDir))
            ? rtrim($traxDataDir, '/')
            : __DIR__ . '/..'
    );
}
unset($traxDataDir);

if (!defined('TRAX_DATA_FILE')) define('TRAX_DATA_FILE', TRAX_DATA_DIR . '/data.json');
if (!defined('TRAX_CHECKOUT_FILE')) define('TRAX_CHECKOUT_FILE', TRAX_DATA_DIR . '/checkout.json');
if (!defined('TRAX_UPLOAD_DIR')) define('TRAX_UPLOAD_DIR', TRAX_DATA_DIR . '/uploads');

/**
 * Attached documents — manuals, receipts, insurance certificates.
 *
 * Deliberately NOT uploads/. Every photo is decoded and re-encoded through GD,
 * so the bytes that end up in uploads/ are ours and an unauthenticated
 * directory is acceptable there. A PDF cannot be laundered that way, and a
 * receipt is a different sensitivity class from a picture of a lens: this
 * directory denies the web outright (documents/.htaccess) and download.php is
 * the only way to read anything out of it.
 */
if (!defined('TRAX_DOC_DIR')) define('TRAX_DOC_DIR', TRAX_DATA_DIR . '/documents');

// --- Authentication --------------------------------------------------------
//
// Two ways in. 'builtin' is the login this app ships with — users.json,
// login.php, a session. 'external' hands the job to a gate that already exists
// on the host: a PHP file outside the docroot that redirects anonymous visitors
// and puts an identity in $_SESSION. See "Using an existing login system" in
// README.md for the contract that file has to keep.
//
// Both are set by the installer, changed later under Settings → Authentication,
// or edited here. Deleting the TRAX_AUTH_MODE line in config.local.php always
// brings the built-in login back — that is the way out of a lock-out.

/** 'builtin' or 'external'. Anything else reads as 'builtin'. */
if (!defined('TRAX_AUTH_MODE')) define('TRAX_AUTH_MODE', 'builtin');

/**
 * Absolute filesystem path of the external gate, e.g.
 * '/var/www/example.com/auth/check_auth.php'. Only consulted in external mode,
 * and only when it names a readable file — see trax_auth_mode().
 */
if (!defined('TRAX_AUTH_INCLUDE')) define('TRAX_AUTH_INCLUDE', '');

/**
 * Where "Sign out" goes in external mode: the host's own logout endpoint.
 * Empty means "destroy the local session and return to admin.php", which is all
 * this app can do on its own.
 */
if (!defined('TRAX_AUTH_LOGOUT_URL')) define('TRAX_AUTH_LOGOUT_URL', '');

/**
 * Set true by the installer when it commits. It is not the only signal —
 * trax_is_installed() also accepts a users.json with an operator in it, so
 * installs made before this constant existed keep working.
 */
if (!defined('TRAX_INSTALLED')) define('TRAX_INSTALLED', false);

// --- Mail ------------------------------------------------------------------

/**
 * The three mail identities. All default to '' — an unconfigured install sends
 * no mail at all rather than mail from a made-up address. lib/mailer.php checks
 * for the empty case and skips the send; the Settings view is the normal place
 * to fill them in, and config.local.php can pin them per deployment.
 */

/** Operator address: receives a copy of every checkout/return and all lost reports. */
if (!defined('TRAX_OWNER_EMAIL')) define('TRAX_OWNER_EMAIL', '');

/** Envelope sender for transactional mail (checkout, extend, check-in). */
if (!defined('TRAX_FROM_EMAIL')) define('TRAX_FROM_EMAIL', '');

/** Envelope sender for the public "lost item" report form. */
if (!defined('TRAX_REPORT_FROM_EMAIL')) define('TRAX_REPORT_FROM_EMAIL', '');

/**
 * The two address guards live here, not in lib/mailer.php, because both the
 * mailer AND the settings normaliser in lib/store.php need them. With them in
 * the mailer those two files had to require_once each other; the cycle was
 * inert only for as long as both stayed declaration-only, which is not a
 * property anyone can be expected to preserve by accident.
 */

/** Strips CR/LF and trims — mandatory for anything reaching a mail header. */
function trax_mail_header_safe(string $value): string
{
    return trim(str_replace(["\r", "\n", "\0"], ' ', $value));
}

/** Returns the address if it is a valid single mailbox, else null. */
function trax_valid_email(mixed $value): ?string
{
    if (!is_string($value)) {
        return null;
    }
    $clean = trax_mail_header_safe($value);
    if ($clean === '' || strlen($clean) > 254) {
        return null;
    }
    return filter_var($clean, FILTER_VALIDATE_EMAIL) ? $clean : null;
}

// --- Branding / URLs -------------------------------------------------------

/**
 * Public path of the asset landing page that QR labels point at.
 * Combined with the current host at runtime, so labels keep working
 * on staging or a renamed domain instead of hardcoding one.
 * '/' is the docroot deployment; a subdirectory install names it here.
 */
if (!defined('TRAX_PUBLIC_PATH')) define('TRAX_PUBLIC_PATH', '/');

/**
 * Host used only where there is no request host — CLI label generation, cron.
 * Empty is the default and means "derive it from the request"; trax_base_url()
 * falls back to 'localhost' when there is no usable Host header either.
 */
if (!defined('TRAX_FALLBACK_HOST')) define('TRAX_FALLBACK_HOST', '');

/**
 * The number behind "Message on WhatsApp" on the public asset page, until an
 * operator sets settings.branding.whatsapp. Deploy identity like the owner
 * address above, so it lives here rather than as a literal in the normaliser.
 * Stored as typed; the digits wa.me wants are derived by trax_whatsapp_digits().
 * Empty — the default — is an intentional "no WhatsApp" and hides the button.
 */
if (!defined('TRAX_WHATSAPP')) define('TRAX_WHATSAPP', '');

/**
 * Which payload the printed QR encodes: 'short' or 'query'.
 *
 * Scan distance is set by the MODULE size, not the pixel size. The label is a
 * fixed ~12 mm square, so fewer modules means bigger modules means readable
 * from further away. Measured with this repo's phpqrcode at QR_ECLEVEL_L:
 *
 *   'query'  https://host/r/?id=3  byte mode          version 2, 25 modules
 *   'short'  HTTPS://HOST/3        alphanumeric mode  version 1, 21 modules
 *
 * QR's alphanumeric charset is `0-9 A-Z space $%*+-./:` — it has no '?', no '='
 * and no lower case, so only an upper-case, path-shaped URL reaches the denser
 * mode. 25 -> 21 modules is a 1.19x larger module at the same printed size.
 *
 * Version 1 holds 25 alphanumeric characters at this ECC level, so the headroom
 * depends on how long the host is: HTTPS://EXAMPLE.ORG/ is 20 characters and
 * leaves room for a 5-digit id, while a host six characters longer spills into
 * version 2 at the first id. A longer host makes the query form worse in the
 * same way, so the short form is never the worse of the two — it just stops
 * being a whole version better.
 *
 * 'short' REQUIRES the rewrite rule in the root .htaccess, so it needs
 * mod_rewrite; without it that URL 404s. Set this to 'query' on such a host.
 * The choice is a constant and deliberately not auto-detected: label.php cannot
 * see whether mod_rewrite is loaded (apache_get_modules() does not exist under
 * php-fpm or CGI), and a wrong guess prints labels that lead nowhere.
 *
 * Either setting leaves already-printed labels alone: index.php accepts ?id=N
 * unconditionally and always will.
 */
if (!defined('TRAX_LABEL_URL_FORM')) define('TRAX_LABEL_URL_FORM', 'short');

/**
 * Directory the short form is served from — it must be the directory holding
 * the .htaccess with the rewrite rule. '/' — the default — is this repo as the
 * docroot. Deployed under a subdirectory instead? Then this has to name it,
 * subject to the case rule below.
 *
 * It must contain no lower-case letter. The whole payload gets upper-cased to
 * reach alphanumeric mode, and Apache paths are case-sensitive on Linux, so a
 * '/r/' here would be printed as '/R/' and 404. A path that breaks the rule
 * makes trax_label_url() emit the query form rather than a dead label.
 */
if (!defined('TRAX_LABEL_SHORT_PATH')) define('TRAX_LABEL_SHORT_PATH', '/');

/**
 * Absolute base (scheme://host, no path) that labels point at. Empty means
 * "whatever host served the label", which is what lets the same code print
 * working labels on staging or a renamed domain. Pin it only when labels must
 * always name one host no matter where the admin is opened. A value that is not
 * a bare scheme://host is ignored in favour of the request host.
 */
if (!defined('TRAX_LABEL_URL_BASE')) define('TRAX_LABEL_URL_BASE', '');

// --- Locale ----------------------------------------------------------------

/**
 * The timezone every stored timestamp is rendered in. PHP warns and falls back
 * to UTC on an unset default, and due dates are computed from strtotime(), so
 * this is set explicitly rather than left to php.ini. 'UTC' is the neutral
 * default; an installer writes the operator's zone into config.local.php.
 */
if (!defined('TRAX_TIMEZONE')) define('TRAX_TIMEZONE', 'UTC');

// An unknown identifier here would otherwise take out every page with a
// warning, so a bad value degrades to UTC instead of to a broken install.
if (!@date_default_timezone_set(TRAX_TIMEZONE)) {
    date_default_timezone_set('UTC');
}

// --- Fonts -----------------------------------------------------------------

/**
 * The TrueType faces the printed labels are drawn with. Liberation Sans ships
 * in fonts/ under the SIL Open Font License, which is why it is here rather
 * than a system font: label.php runs on hosts with no fontconfig at all.
 *
 * Both roles point at the bold face by default — a label is set entirely in
 * bold — but they stay separate constants so a deployment can give the big
 * heading a heavier face without touching the rest. A missing file is not
 * fatal: both renderers fall back to GD's built-in bitmap font.
 */
if (!defined('TRAX_FONT_BOLD')) define('TRAX_FONT_BOLD', __DIR__ . '/../fonts/LiberationSans-Bold.ttf');
if (!defined('TRAX_FONT_HEAVY')) define('TRAX_FONT_HEAVY', __DIR__ . '/../fonts/LiberationSans-Bold.ttf');

/**
 * The four helpers below are what label.php and label-w.php draw through.
 *
 * They exist because a printed label must come out of the printer even on a
 * host where the TTF is missing — the endpoint used to die() with "Font
 * missing", which turns a cosmetic problem into an <img> that never loads and
 * an operator with no labels at all. Everything here degrades instead: no
 * font means GD's built-in bitmap face, no logo means no logo.
 *
 * They live in config.php rather than in a file of their own because both
 * endpoints already require it and the constants they resolve are right above.
 */

/** The TTF to draw with, or null when it cannot be used and GD's own must do. */
function trax_label_font(string $path): ?string
{
    if ($path === '' || !function_exists('imagettftext') || !is_file($path) || !is_readable($path)) {
        return null;
    }
    return $path;
}

/**
 * GD's built-in bitmap face closest to a requested point size (1 = 5x8 px
 * through 5 = 9x15 px). Coarse on purpose: this is the fallback, and the only
 * thing that matters is that a 20pt heading still comes out bigger than 14pt
 * notes.
 */
function trax_label_builtin_font(float $size): int
{
    if ($size >= 18.0) {
        return 5;
    }
    if ($size >= 13.0) {
        return 4;
    }
    if ($size >= 10.0) {
        return 3;
    }
    return 2;
}

/**
 * How wide $text renders, in pixels. Used by the word-wrapper, so it has to
 * answer for the fallback face too.
 *
 * The fallback measures with strlen(), which counts UTF-8 bytes rather than
 * characters and so over-estimates an accented name. That errs towards
 * wrapping early, which is the harmless direction: a label that breaks a line
 * sooner than it had to still fits the sticker.
 */
function trax_label_text_width(?string $font, float $size, string $text): int
{
    if ($font !== null) {
        $box = imagettfbbox($size, 0, $font, $text);
        return is_array($box) ? (int)($box[2] - $box[0]) : 0;
    }
    return imagefontwidth(trax_label_builtin_font($size)) * strlen($text);
}

/**
 * Draws $text with its baseline at $y — imagettftext()'s convention, which the
 * callers were written against. The fallback draws from the top-left, so the
 * face height is subtracted to put it on the same line.
 */
function trax_label_text($image, ?string $font, float $size, int $x, int $y, int $colour, string $text): void
{
    if ($font !== null) {
        imagettftext($image, $size, 0, $x, $y, $colour, $font, $text);
        return;
    }
    $builtin = trax_label_builtin_font($size);
    imagestring($image, $builtin, $x, $y - imagefontheight($builtin), $text, $colour);
}

/**
 * Loads the configured label logo from the project root, or null when there is
 * none. imagecreatefromstring() sniffs the format, so a PNG and a JPEG are both
 * accepted without the caller having to care which was uploaded.
 *
 * The name is expected to have been through trax_logo_file() already; the
 * basename() and is_file() here are belt-and-braces for a caller that reads
 * data.json directly.
 */
function trax_label_logo_image(string $file)
{
    if ($file === '' || $file !== basename($file)) {
        return null;
    }
    $path = __DIR__ . '/../' . $file;
    if (!is_file($path) || !is_readable($path)) {
        return null;
    }
    $bytes = @file_get_contents($path);
    if ($bytes === false || $bytes === '') {
        return null;
    }
    $image = @imagecreatefromstring($bytes);
    return $image === false ? null : $image;
}

// --- Domain vocabulary -----------------------------------------------------

/** Stored asset statuses. PARTIAL is derived for sets and never written to disk. */
if (!defined('TRAX_STATUSES')) define('TRAX_STATUSES', ['FREE', 'RSVD', 'UNAV', 'LOCK']);

if (!defined('TRAX_ASSET_KINDS')) define('TRAX_ASSET_KINDS', ['ITEM', 'SET']);

if (!defined('TRAX_CONDITIONS')) define('TRAX_CONDITIONS', ['NEW', 'GOOD', 'FAIR', 'POOR', 'DEFECT']);

if (!defined('TRAX_RESERVATION_STATUSES')) define('TRAX_RESERVATION_STATUSES', ['ACTIVE', 'CONVERTED', 'COMPLETED', 'CANCELLED']);

/** What kind of transaction a customer-facing booking stands for. Lower case — it is not a status. */
if (!defined('TRAX_BOOKING_KINDS')) define('TRAX_BOOKING_KINDS', ['checkout', 'reservation']);

if (!defined('TRAX_BOOKING_STATUSES')) define('TRAX_BOOKING_STATUSES', ['OPEN', 'RETURNED', 'CANCELLED']);

// --- Limits ----------------------------------------------------------------

if (!defined('TRAX_MAX_STRING')) define('TRAX_MAX_STRING', 2000);   // characters, any single text field
if (!defined('TRAX_MAX_NAME')) define('TRAX_MAX_NAME', 200);
/**
 * An operator-edited mail subject. One line, and it is MIME-encoded into a
 * header, so it stays short: base64 of 200 UTF-8 characters is still well
 * inside the 998-octet line limit of RFC 5322 once folded.
 */
if (!defined('TRAX_MAX_MAIL_SUBJECT')) define('TRAX_MAX_MAIL_SUBJECT', 200);
/**
 * An operator-edited mail body. TRAX_MAX_STRING (2000) is a field, not a
 * letter: the longest built-in body is ~400 characters and a real one carries
 * opening hours, damage terms and a signature, often in two languages, which
 * passes 2000 without trying.
 *
 * 8000 is where this stops. It is roughly four A4 pages of plain text — past
 * any mail a customer will read — and it bounds the settings block: eight
 * templates at 8 KB each is 64 KB worst case, against a data.json that is
 * 31 KB today, so a full set of long templates cannot double the file that is
 * read and rewritten on every mutation.
 */
if (!defined('TRAX_MAX_MAIL_BODY')) define('TRAX_MAX_MAIL_BODY', 8000);
if (!defined('TRAX_MAX_MEMBERS')) define('TRAX_MAX_MEMBERS', 100);    // distinct members per set
if (!defined('TRAX_MAX_QUANTITY')) define('TRAX_MAX_QUANTITY', 9999);   // physical units one asset record may stand for
if (!defined('TRAX_MAX_MEMBER_QTY')) define('TRAX_MAX_MEMBER_QTY', 999);    // units of a single member inside one set
if (!defined('TRAX_MAX_UPLOAD_BYTES')) define('TRAX_MAX_UPLOAD_BYTES', 12 * 1024 * 1024);
/** How long a customer's booking link stays alive past the return date. */
if (!defined('TRAX_BOOKING_LINK_DAYS')) define('TRAX_BOOKING_LINK_DAYS', 30);
/** Items snapshotted onto one booking; a cap so one record can never grow unbounded. */
if (!defined('TRAX_MAX_BOOKING_ITEMS')) define('TRAX_MAX_BOOKING_ITEMS', 500);
if (!defined('TRAX_PHOTO_MAX_EDGE')) define('TRAX_PHOTO_MAX_EDGE', 1600);   // px, long edge after re-encode
if (!defined('TRAX_THUMB_MAX_EDGE')) define('TRAX_THUMB_MAX_EDGE', 320);    // px, long edge of the generated thumbnail
/** Files one multipart upload may carry. Each one is decoded twice by GD. */
if (!defined('TRAX_MAX_PHOTOS_PER_BATCH')) define('TRAX_MAX_PHOTOS_PER_BATCH', 8);
/** Condition photos one booking may accumulate, across all batches. */
if (!defined('TRAX_MAX_BOOKING_PHOTOS')) define('TRAX_MAX_BOOKING_PHOTOS', 40);
/**
 * Condition photos one asset may accumulate in its own log.
 *
 * An asset on the shelf has no booking, so the booking's photos cannot document
 * it. This log is the asset's own history and outlives every loan, which is why
 * it needs a cap of its own rather than sharing the booking's.
 */
if (!defined('TRAX_MAX_ASSET_CONDITION_PHOTOS')) define('TRAX_MAX_ASSET_CONDITION_PHOTOS', 40);

/**
 * One attached document. Same 12 MB as a photo — a scanned A4 manual is the
 * big case and lands well under it.
 *
 * NOTE: PHP's own upload_max_filesize / post_max_size cut in first and this
 * repo sets neither. Wherever they are lower (the stock 2M/8M is common on
 * shared hosting, and is what the local dev PHP reports) that is the real cap
 * and this constant is never reached; an over-large file then arrives as
 * UPLOAD_ERR_INI_SIZE, which trax_upload_error_message() already reports as
 * "larger than the server allows". Raising it is a host/php.ini decision, not
 * one this file can make.
 */
if (!defined('TRAX_MAX_DOCUMENT_BYTES')) define('TRAX_MAX_DOCUMENT_BYTES', 12 * 1024 * 1024);

/**
 * Documents one asset may accumulate. A manual, a receipt, an insurance
 * certificate and a few scans is the real case; 20 is generous for that and
 * still keeps one asset record small enough to ship in every snapshot.
 */
if (!defined('TRAX_MAX_ASSET_DOCUMENTS')) define('TRAX_MAX_ASSET_DOCUMENTS', 20);

/** Files one multipart document upload may carry. Stored all-or-nothing. */
if (!defined('TRAX_MAX_DOCS_PER_BATCH')) define('TRAX_MAX_DOCS_PER_BATCH', 8);

/**
 * What a document may be, sniffed => the extension we store it under.
 *
 * The client's filename never picks the extension; the sniffed type does.
 * Office formats are deliberately absent: they are containers for macros, and
 * nothing here can tell a benign .docx from an armed one.
 */
if (!defined('TRAX_DOCUMENT_TYPES')) {
    define('TRAX_DOCUMENT_TYPES', [
    'application/pdf' => 'pdf',
    'image/jpeg'      => 'jpg',
    'image/png'       => 'png',
    'image/webp'      => 'webp',
    'text/plain'      => 'txt',
]);
}

/**
 * Absolute base URL (scheme + host) for the current request.
 * Used by label generation so the QR points back at whatever host served it.
 */
function trax_base_url(): string
{
    $scheme = 'http';
    if (
        (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
        || (int)($_SERVER['SERVER_PORT'] ?? 0) === 443
    ) {
        $scheme = 'https';
    }

    // Host headers are attacker-controlled; allow only hostname[:port]. The
    // configured fallback is for CLI, where there is no request at all, and
    // 'localhost' is the last resort so this never returns a scheme with no
    // authority — a URL shaped 'https://' would silently print dead labels.
    $host = (string)($_SERVER['HTTP_HOST'] ?? '');
    if (preg_match('/^[A-Za-z0-9.\-]+(:\d+)?$/', $host) !== 1) {
        $host = TRAX_FALLBACK_HOST;
    }
    if (preg_match('/^[A-Za-z0-9.\-]+(:\d+)?$/', $host) !== 1) {
        $host = 'localhost';
    }

    return $scheme . '://' . $host;
}

/**
 * The long-standing query form of the public asset URL.
 *
 * Every label printed before the short form existed encodes this, and
 * index.php resolves it unconditionally, so it stays.
 */
function trax_asset_url(int $id): string
{
    return trax_base_url() . TRAX_PUBLIC_PATH . '?id=' . $id;
}

/**
 * What a printed label's QR should encode for an asset, per the config above.
 *
 * Upper case is not cosmetic: it is what puts the string in QR's alphanumeric
 * mode and takes the symbol from 25 modules down to 21. Schemes and hosts are
 * case-insensitive (RFC 3986 §3.1, §3.2.2) and the path is digits only, so the
 * upper-case URL is the same resource.
 */
function trax_label_url(int $id): string
{
    $base = '';
    if (TRAX_LABEL_URL_BASE !== '' && preg_match('#^https?://[A-Za-z0-9.\-]+(:\d+)?$#', TRAX_LABEL_URL_BASE)) {
        $base = TRAX_LABEL_URL_BASE;
    }
    if ($base === '') {
        $base = trax_base_url();
    }

    // A short path carrying a lower-case letter cannot survive the upper-casing
    // on a case-sensitive filesystem, so fall back rather than print a 404.
    if (TRAX_LABEL_URL_FORM === 'short' && !preg_match('/[a-z]/', TRAX_LABEL_SHORT_PATH)) {
        $path = trim(TRAX_LABEL_SHORT_PATH, '/');
        $path = $path === '' ? '/' : '/' . $path . '/';

        return strtoupper($base . $path . $id);
    }

    return $base . TRAX_PUBLIC_PATH . '?id=' . $id;
}

/**
 * Public URL of one customer's booking page. The token is the only key — there
 * is deliberately no id-addressable form of this page.
 */
function trax_booking_url(string $token): string
{
    return trax_base_url() . '/booking.php?t=' . rawurlencode($token);
}

// --- Mail templates --------------------------------------------------------
//
// The eight transactional mails, as editable templates. This registry is the
// single source of truth for three consumers that must not disagree:
//
//   lib/mailer.php   renders with it (the built-in text below IS what goes out
//                    when nothing is stored — there is no second code path)
//   lib/store.php    normalises the stored overrides against the key list
//   api.php          validates a save against the tokens, and ships the whole
//                    registry to the Settings view for the token help, the
//                    preview and "reset to default"
//
// It lives here rather than in mailer.php because store.php must read it and
// mailer.php already requires store.php; the require may only go one way.
//
// The bodies are byte-for-byte what the hand-written mails produced before
// they were templated, down to the blank lines. .dev/tests/store_test.php
// pins that against a frozen copy of the old renderers.

/**
 * Placeholder syntax: {{token}}. Rendered with strtr(), one pass, so a value
 * that happens to contain "{{...}}" is never expanded again.
 */
function trax_mail_token(string $name): string
{
    return '{{' . $name . '}}';
}

/**
 * The template registry: key => label, default subject, default body, the
 * tokens that key accepts, the ones it may not be saved without, and sample
 * values for the preview.
 *
 * On `required`. A token is required when dropping it loses something the
 * recipient cannot get anywhere else:
 *   - {{items}} — the mail's whole subject matter. Everywhere it exists.
 *   - {{bookingLink}} — the customer's only route to their own booking. A
 *     checkout confirmation once went out with no link at all and the customer
 *     had nowhere to look; that is why this is enforced rather than advised.
 *   - the date the mail is about ({{newReturnDate}}, {{dueDate}}) — a reminder
 *     that does not say when is not a reminder.
 *   - the digest's three sections — an operator who drops "overdue" stops
 *     seeing overdue bookings and will not notice.
 *   - the lost report's {{asset}}, {{message}} and BOTH contact tokens — you
 *     cannot know whether the finder left a phone or a mail address, so a
 *     template that carries only one can lose the only way to reach them.
 * Everything else is optional: {{daysOverdue}} is derivable from {{dueDate}},
 * {{stillOutLine}} and {{notesBlock}} are courtesies, and a name in the
 * greeting is not information.
 */
function trax_mail_templates(): array
{
    static $templates = null;
    if ($templates !== null) {
        return $templates;
    }

    $sampleItems = "- [ID 12] – Canon EOS R5\n- [ID 47] – Manfrotto Tripod";
    $sampleQty   = "- [ID 12] – Canon EOS R5 ×2\n- [ID 47] – Manfrotto Tripod";
    $sampleLink  = "\nYour booking overview: https://example.org/booking.php?t=3f9a…c17\n";

    $templates = [
        'checkout' => [
            'label'   => 'Checkout confirmation',
            'note'    => 'To the customer and the owner when items go out.',
            'subject' => 'Asset Checkout Confirmation',
            'body'    => "Customer: {{customerName}} <{{customerEmail}}>\n"
                . "\n"
                . "Return Date: {{returnDate}}\n"
                . "\n"
                . "Checked-out items:\n"
                . "{{items}}\n"
                . "{{notesBlock}}{{bookingLink}}",
            'tokens'  => [
                'customerName'  => "The customer's name.",
                'customerEmail' => "The customer's address.",
                'returnDate'    => 'When the items are due back.',
                'items'         => 'The checked-out items, one "- [ID 4] – Name" line each.',
                'notesBlock'    => 'The whole "Notes:" block, or nothing when there are no notes.',
                'bookingLink'   => 'The whole "Your booking overview: …" line, on its own line.',
            ],
            'required' => ['items', 'bookingLink'],
            'sample'   => [
                'customerName'  => 'Karla Meier',
                'customerEmail' => 'karla@example.org',
                'returnDate'    => '01.09.2026 18:00',
                'items'         => $sampleItems,
                'notesBlock'    => "\nNotes:\nhandle with care\n",
                'bookingLink'   => $sampleLink,
            ],
        ],

        'reservation' => [
            'label'   => 'Reservation confirmation',
            'note'    => 'To the customer and the owner when a reservation is booked.',
            'subject' => 'Asset Reservation Confirmation',
            'body'    => "Customer: {{customerName}} <{{customerEmail}}>\n"
                . "\n"
                . "Reserved from: {{startDate}}\n"
                . "Reserved until: {{endDate}}\n"
                . "\n"
                . "Reserved items:\n"
                . "{{items}}\n"
                . "{{notesBlock}}{{bookingLink}}",
            'tokens'  => [
                'customerName'  => "The customer's name.",
                'customerEmail' => "The customer's address.",
                'startDate'     => 'Start of the reservation.',
                'endDate'       => 'End of the reservation.',
                'items'         => 'The reserved items, one "- [ID 4] – Name" line each.',
                'notesBlock'    => 'The whole "Notes:" block, or nothing when there are no notes.',
                'bookingLink'   => 'The whole "Your booking overview: …" line, on its own line.',
            ],
            'required' => ['items', 'bookingLink'],
            'sample'   => [
                'customerName'  => 'Karla Meier',
                'customerEmail' => 'karla@example.org',
                'startDate'     => '01.12.2026 09:00',
                'endDate'       => '05.12.2026 18:00',
                'items'         => $sampleItems,
                'notesBlock'    => '',
                'bookingLink'   => $sampleLink,
            ],
        ],

        'extend' => [
            'label'   => 'Extension confirmed',
            'note'    => 'To the customer when a due date moves.',
            'subject' => 'Asset Return Date Extended',
            'body'    => "Hello {{customerName}},\n"
                . "\n"
                . "the return date for the following {{itemNoun}} has been extended:\n"
                . "\n"
                . "{{items}}\n"
                . "\n"
                . "New return date: {{newReturnDate}}\n",
            'tokens'  => [
                'customerName'  => "The customer's name.",
                'customerEmail' => "The customer's address.",
                'items'         => 'The extended items with their quantities ("×3" where more than one).',
                'itemNoun'      => '"item" or "items", matching how many lines there are.',
                'newReturnDate' => 'The new return date.',
            ],
            'required' => ['items', 'newReturnDate'],
            'sample'   => [
                'customerName'  => 'Karla Meier',
                'customerEmail' => 'karla@example.org',
                'items'         => $sampleQty,
                'itemNoun'      => 'items',
                'newReturnDate' => '15.09.2026 18:00',
            ],
        ],

        'checkin' => [
            'label'   => 'Return receipt',
            'note'    => 'To the customer when items come back.',
            'subject' => 'Asset Returned',
            'body'    => "Hello {{customerName}},\n"
                . "\n"
                . "we have received the following {{itemNoun}} back:\n"
                . "\n"
                . "{{items}}\n"
                . "\n"
                . "{{stillOutLine}}\n"
                . "\n"
                . "Thank you.\n",
            'tokens'  => [
                'customerName'  => "The customer's name.",
                'customerEmail' => "The customer's address.",
                'items'         => 'The returned items with their quantities ("×3" where more than one).',
                'itemNoun'      => '"item" or "items", matching how many lines there are.',
                'stillOutLine'  => 'One sentence: what they still have out, or that everything is back.',
                'stillOut'      => 'How many units they still have out, as a bare number.',
            ],
            'required' => ['items'],
            'sample'   => [
                'customerName'  => 'Karla Meier',
                'customerEmail' => 'karla@example.org',
                'items'         => $sampleQty,
                'itemNoun'      => 'items',
                'stillOutLine'  => 'You still have 1 item out with us.',
                'stillOut'      => '1',
            ],
        ],

        'dueSoon' => [
            'label'   => 'Due-soon reminder',
            'note'    => 'Sent by cron.php before the due date.',
            'subject' => 'Reminder: your booking is due back soon',
            'body'    => "Hello {{customerName}},\n"
                . "\n"
                . "a friendly reminder that the following items are due back on {{dueDate}}:\n"
                . "\n"
                . "{{items}}\n"
                . "{{bookingLink}}",
            'tokens'  => [
                'customerName'  => "The customer's name, or \"there\" when the booking has none.",
                'customerEmail' => "The customer's address.",
                'dueDate'       => 'When the booking is due back.',
                'items'         => 'The booked items, one "- [ID 4] – Name" line each.',
                'bookingLink'   => 'The whole "Your booking overview: …" line, on its own line.',
            ],
            'required' => ['items', 'dueDate', 'bookingLink'],
            'sample'   => [
                'customerName'  => 'Karla Meier',
                'customerEmail' => 'karla@example.org',
                'dueDate'       => '01.09.2026',
                'items'         => $sampleItems,
                'bookingLink'   => $sampleLink,
            ],
        ],

        'overdue' => [
            'label'   => 'Overdue reminder',
            'note'    => 'Sent by cron.php after the due date, repeatedly.',
            'subject' => 'Overdue: please return your booking',
            'body'    => "Hello {{customerName}},\n"
                . "\n"
                . "the following items were due back on {{dueDate}} and are now {{daysOverdue}} overdue:\n"
                . "\n"
                . "{{items}}\n"
                . "\n"
                . "Please return them, or get in touch if you need more time.\n"
                . "{{bookingLink}}",
            'tokens'  => [
                'customerName'    => "The customer's name, or \"there\" when the booking has none.",
                'customerEmail'   => "The customer's address.",
                'dueDate'         => 'When the booking was due back.',
                'daysOverdue'     => 'How late it is, as "1 day" or "5 days".',
                'daysOverdueCount' => 'How late it is, as a bare number.',
                'items'           => 'The booked items, one "- [ID 4] – Name" line each.',
                'bookingLink'     => 'The whole "Your booking overview: …" line, on its own line.',
            ],
            'required' => ['items', 'dueDate', 'bookingLink'],
            'sample'   => [
                'customerName'    => 'Karla Meier',
                'customerEmail'   => 'karla@example.org',
                'dueDate'         => '01.09.2026',
                'daysOverdue'     => '5 days',
                'daysOverdueCount' => '5',
                'items'           => $sampleItems,
                'bookingLink'     => $sampleLink,
            ],
        ],

        'ownerDigest' => [
            'label'   => 'Owner digest',
            'note'    => 'The daily summary cron.php sends to the owner address.',
            'subject' => 'Daily summary {{day}}',
            'body'    => "Daily summary for {{day}}\n"
                . "\n"
                . "{{overdueSection}}\n"
                . "{{dueTodaySection}}\n"
                . "{{startingTodaySection}}",
            'tokens'  => [
                'day'                  => 'The day the summary is for.',
                'overdueSection'       => 'The whole "Overdue" section, heading and lines.',
                'dueTodaySection'      => 'The whole "Due today" section, heading and lines.',
                'startingTodaySection' => 'The whole "Reservations starting today" section.',
                'overdueCount'         => 'How many bookings are overdue.',
                'dueTodayCount'        => 'How many are due today.',
                'startingTodayCount'   => 'How many reservations start today.',
            ],
            'required' => ['overdueSection', 'dueTodaySection', 'startingTodaySection'],
            'sample'   => [
                'day'                  => '2026-08-16',
                'overdueSection'       => "Overdue (1):\n- [ID 12] – Canon EOS R5 (Karla Meier, 5 days)\n",
                'dueTodaySection'      => "Due today: none\n",
                'startingTodaySection' => "Reservations starting today (1):\n- [ID 47] – Manfrotto Tripod (Jonas Weber)\n",
                'overdueCount'         => '1',
                'dueTodayCount'        => '0',
                'startingTodayCount'   => '1',
            ],
        ],

        'lostReport' => [
            'label'   => 'Lost-item report',
            'note'    => 'To the owner when a finder fills in the public /r/ form.',
            'subject' => '⚠️ LOST ITEM: {{asset}}',
            'body'    => "Report from: {{finderName}}\n"
                . "Phone: {{finderPhone}}\n"
                . "Email: {{finderEmail}}\n"
                . "\n"
                . "Asset: {{asset}}\n"
                . "\n"
                . "Message:\n"
                . "{{message}}\n",
            'tokens'  => [
                'finderName'  => 'What the finder typed as their name.',
                'finderPhone' => 'Their phone number, as typed.',
                'finderEmail' => 'Their address, as typed.',
                'asset'       => 'The asset, as "Name (ID 4)", or "Unknown Asset".',
                'message'     => 'What they wrote.',
            ],
            'required' => ['asset', 'message', 'finderPhone', 'finderEmail'],
            'sample'   => [
                'finderName'  => 'Jonas Weber',
                'finderPhone' => '+49 170 1234567',
                'finderEmail' => 'jonas@example.org',
                'asset'       => 'Canon EOS R5 (ID 12)',
                'message'     => "Found it on the S-Bahn, platform 3.\nHappy to drop it off.",
            ],
        ],
    ];

    return $templates;
}

/** The eight template keys, in the order the Settings view shows them. */
function trax_mail_template_keys(): array
{
    return array_keys(trax_mail_templates());
}
