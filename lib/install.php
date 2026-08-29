<?php
/**
 * Installer helpers — everything install.php needs that is not markup.
 *
 * The wizard itself is a single file of forms; this is where the decisions
 * live: what the host must provide before an install can succeed, what each
 * step accepts, and — the part that has to be right — how the four files an
 * install consists of are committed and how they are taken back if the last
 * one fails.
 *
 * Nothing here is loaded by the application at runtime. install.php is the only
 * caller, and once trax_is_installed() is true that file refuses to run at all.
 */

declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/config-local.php';
require_once __DIR__ . '/store.php';

/** How many steps the indicator draws. Step 7 is the Done page. */
const TRAX_INSTALL_STEPS = 7;

/** Uploaded logos are re-encoded to PNG at most this many pixels on the long edge. */
const TRAX_INSTALL_LOGO_MAX_EDGE = 600;

/** Square side of the generated favicon — the same 181 px .dev/make-favicon.php uses. */
const TRAX_INSTALL_FAVICON_SIZE = 181;

/** Logo uploads are small by nature; the limit keeps a 40-megapixel decode off the host. */
const TRAX_INSTALL_MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Session key holding the whole wizard state. */
const TRAX_INSTALL_SESSION_KEY = 'trax_install';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The project root — where logo.png and favicon.png must land.
 *
 * Deliberately NOT TRAX_DATA_DIR: trax_logo_file() resolves branding images
 * against dirname(__DIR__), so an image written anywhere else normalises back
 * to '' on the very next read and the branding silently disappears.
 */
function trax_install_root(): string
{
    return dirname(__DIR__);
}

/** Absolute path of the file the wizard writes its deployment constants to. */
function trax_install_config_file(): string
{
    return __DIR__ . '/config.local.php';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The wizard's answers, with every field defaulted.
 *
 * Defaults are the values a host would get by doing nothing, so a run that
 * clicks straight through produces a working — if plain — installation.
 */
function trax_install_defaults(): array
{
    return [
        'step' => 1,

        // The furthest step whose answers have actually been accepted. The
        // wizard is a sequence, not a menu: install.php refuses a POST for a
        // step past maxStep + 1, so the validation of the steps in between
        // cannot be skipped by posting a later step number directly.
        'maxStep' => 0,

        // 2. Organisation & branding
        'appName'      => 'Assets',
        'orgName'      => '',
        'brandColor'   => '#1F2937',
        'labelHeading' => 'PROPERTY OF',
        'whatsapp'     => '',
        'logoTmp'      => '',   // server-generated temp path, never user input
        'faviconTmp'   => '',
        'logoClient'   => '',   // the uploaded file's name, shown back to the operator

        // 3. Admin account, and how this installation signs people in.
        // 'builtin' is the login this app ships with; 'external' hands the job
        // to an include the host already has. The account below is asked for
        // either way — in external mode it is the fallback that gets the
        // operator back in if that include ever disappears.
        'authMode'      => 'builtin',
        'authInclude'   => '',
        'authLogoutUrl' => '',
        'username' => '',
        'email'    => '',
        // Held in the session only until step 7 hands it to trax_user_create(),
        // which is the one function allowed to hash it. Sessions are server-side
        // files; the alternative — hashing early — would mean writing the users
        // file from somewhere other than the auth module.
        'password' => '',

        // 4. Site & mail
        'publicPath'      => '/',
        'timezone'        => 'UTC',
        'locale'          => 'en-US',
        'dateFormat'      => 'Y-m-d H:i',
        'currency'        => 'EUR',
        'ownerEmail'      => '',
        'fromEmail'       => '',
        'reportFromEmail' => '',

        // 5. Automation
        'cronSecret'        => '',
        'loanDays'          => 7,
        'dueHour'           => 18,
        'dueSoonHours'      => 24,
        'overdueRepeatDays' => 7,

        // 6. Demo data
        'demoData' => false,
    ];
}

/** A 32-character hex secret for the cron trigger. */
function trax_install_new_secret(): string
{
    return bin2hex(random_bytes(16));
}

/**
 * The site-root-relative directory this installer is being served from.
 *
 * "/install.php" -> "/", "/assets/install.php" -> "/assets/". It is only a
 * default: the operator can correct it in step 4, and trax_public_path()
 * refuses anything that is not a plain absolute path.
 */
function trax_install_default_public_path(): string
{
    $script = (string)($_SERVER['SCRIPT_NAME'] ?? '/install.php');
    $dir    = str_replace('\\', '/', dirname($script));
    if ($dir === '' || $dir === '.' || $dir === '/') {
        return '/';
    }
    return trax_public_path($dir) ?? '/';
}

/** The best guess at the host's timezone, or UTC. */
function trax_install_default_timezone(): string
{
    $guess = @date_default_timezone_get();
    return in_array($guess, DateTimeZone::listIdentifiers(), true) ? $guess : 'UTC';
}

/**
 * Loads the wizard state from the session, seeding it on the first request.
 *
 * Unknown keys are dropped and missing ones defaulted, so a session left over
 * from an older version of this file cannot make a step read a value that no
 * longer exists.
 */
function trax_install_state(): array
{
    $defaults = trax_install_defaults();
    $stored   = $_SESSION[TRAX_INSTALL_SESSION_KEY] ?? null;

    if (!is_array($stored)) {
        $defaults['publicPath'] = trax_install_default_public_path();
        $defaults['timezone']   = trax_install_default_timezone();
        $defaults['cronSecret'] = trax_install_new_secret();
        $_SESSION[TRAX_INSTALL_SESSION_KEY] = $defaults;
        return $defaults;
    }

    $state = [];
    foreach ($defaults as $key => $value) {
        $state[$key] = array_key_exists($key, $stored) ? $stored[$key] : $value;
    }
    return $state;
}

/** Commits the wizard state back to the session. */
function trax_install_save(array $state): void
{
    $_SESSION[TRAX_INSTALL_SESSION_KEY] = $state;
}

/** Forgets everything, including the temporary images the wizard made. */
function trax_install_reset(): void
{
    $stored = $_SESSION[TRAX_INSTALL_SESSION_KEY] ?? null;
    if (is_array($stored)) {
        foreach (['logoTmp', 'faviconTmp'] as $key) {
            $path = (string)($stored[$key] ?? '');
            if ($path !== '' && is_file($path)) {
                @unlink($path);
            }
        }
    }
    unset($_SESSION[TRAX_INSTALL_SESSION_KEY]);
}

// ---------------------------------------------------------------------------
// Step 1 — what the host has to provide
// ---------------------------------------------------------------------------

/**
 * One requirement row: label, whether it holds, and what to do about it.
 *
 * @return array{label:string, ok:bool, hard:bool, detail:string}
 */
function trax_install_check(string $label, bool $ok, bool $hard, string $detail = ''): array
{
    return ['label' => $label, 'ok' => $ok, 'hard' => $hard, 'detail' => $detail];
}

/**
 * A directory this install writes to.
 *
 * A directory that does not exist yet is not a failure as long as its parent is
 * writable — step 7 creates it. That is the normal state of a fresh upload:
 * FTP clients skip empty directories, so uploads/thumb/ and documents/ usually
 * arrive missing.
 */
function trax_install_check_dir(string $label, string $path, bool $hard = true): array
{
    if (is_dir($path)) {
        return is_writable($path)
            ? trax_install_check($label, true, $hard, 'writable')
            : trax_install_check($label, false, $hard, 'exists but is not writable — chmod 755 (or 775) it');
    }

    // Walk up to the first directory that does exist: uploads/thumb/ is missing
    // exactly when uploads/ is too, and asking whether a directory inside a
    // directory that is not there yet is writable answers "no" for the wrong
    // reason. mkdir(..., recursive: true) creates the chain in one call.
    $parent = dirname($path);
    while ($parent !== '' && $parent !== '/' && $parent !== '.' && !is_dir($parent)) {
        $up = dirname($parent);
        if ($up === $parent) {
            break;
        }
        $parent = $up;
    }

    if (is_dir($parent) && is_writable($parent)) {
        return trax_install_check($label, true, $hard, 'missing — will be created');
    }
    return trax_install_check($label, false, $hard, 'missing, and ' . $parent . ' is not writable');
}

/**
 * Everything step 1 reports.
 *
 * @return list<array{label:string, ok:bool, hard:bool, detail:string}>
 */
function trax_install_requirements(): array
{
    $root  = trax_install_root();
    $rows  = [];

    $rows[] = trax_install_check(
        'PHP 8.1 or newer',
        PHP_VERSION_ID >= 80100,
        true,
        'found ' . PHP_VERSION
    );

    foreach (['gd', 'mbstring', 'json', 'fileinfo', 'session'] as $ext) {
        $rows[] = trax_install_check(
            'Extension: ' . $ext,
            extension_loaded($ext),
            true,
            extension_loaded($ext) ? 'loaded' : 'ask your host to enable it'
        );
    }

    $rows[] = trax_install_check(
        'random_bytes()',
        function_exists('random_bytes'),
        true,
        'used for the cron secret and the booking tokens'
    );

    $rows[] = trax_install_check_dir('Data directory (' . basename(TRAX_DATA_DIR) . ')', TRAX_DATA_DIR);
    $rows[] = trax_install_check_dir('lib/ (for config.local.php)', __DIR__);
    $rows[] = trax_install_check_dir('uploads/', TRAX_UPLOAD_DIR);
    $rows[] = trax_install_check_dir('uploads/thumb/', TRAX_UPLOAD_DIR . '/thumb');
    $rows[] = trax_install_check_dir('documents/', TRAX_DOC_DIR);
    $rows[] = trax_install_check_dir('phpqrcode/cache/', $root . '/phpqrcode/cache', false);

    // A warning, never a block: plenty of hosts run PHP behind a proxy that
    // terminates TLS, and this test cannot see through that.
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
        || (int)($_SERVER['SERVER_PORT'] ?? 0) === 443;
    $rows[] = trax_install_check(
        'HTTPS',
        $https,
        false,
        $https ? 'on' : 'not detected — browsers only allow camera scanning on https, so the QR scanner will not open'
    );

    // mod_rewrite drives the short label URLs. It is only visible when PHP runs
    // as an Apache module; under CGI/FPM the honest answer is "cannot tell".
    if (function_exists('apache_get_modules')) {
        $has = in_array('mod_rewrite', apache_get_modules(), true);
        $rows[] = trax_install_check(
            'mod_rewrite',
            $has,
            false,
            $has ? 'available' : 'not loaded — short QR label URLs will 404, the ?id= form still works'
        );
    } else {
        $rows[] = trax_install_check(
            'mod_rewrite',
            true,
            false,
            'unknown — verify manually (PHP cannot see the Apache module list here)'
        );
    }

    return $rows;
}

/** True when a requirement that cannot be worked around is unmet. */
function trax_install_blocked(array $rows): bool
{
    foreach ($rows as $row) {
        if ($row['hard'] && !$row['ok']) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/**
 * Turns an uploaded logo into two PNGs in the system temp directory and returns
 * their paths.
 *
 * Nothing is written into the project until step 7, so an abandoned wizard
 * leaves the deployment untouched. The type is sniffed with getimagesize() and
 * the bytes are decoded and re-encoded through GD, so what is eventually
 * committed is our own PNG and not the uploaded file.
 *
 * @return array{0:string, 1:string} [logo path, favicon path]
 * @throws RuntimeException with a message meant for the operator
 */
function trax_install_process_logo(array $file, string $brandColor): array
{
    $error = (int)($file['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($error !== UPLOAD_ERR_OK) {
        throw new RuntimeException('The logo did not upload (error code ' . $error . ').');
    }

    $tmp = (string)($file['tmp_name'] ?? '');
    if ($tmp === '' || !is_uploaded_file($tmp)) {
        throw new RuntimeException('The upload could not be verified.');
    }
    if ((int)($file['size'] ?? 0) > TRAX_INSTALL_MAX_LOGO_BYTES) {
        throw new RuntimeException('The logo must be 2 MB or smaller.');
    }

    $info = @getimagesize($tmp);
    if ($info === false) {
        throw new RuntimeException('That file is not a readable image.');
    }
    [$width, $height] = $info;
    $mime = (string)($info['mime'] ?? '');
    if (!in_array($mime, ['image/png', 'image/jpeg', 'image/webp'], true)) {
        throw new RuntimeException('The logo must be a PNG, JPEG or WebP image.');
    }
    if ($width < 1 || $height < 1 || $width * $height > 40_000_000) {
        throw new RuntimeException('That image has too many pixels to process.');
    }

    $source = match ($mime) {
        'image/png'  => @imagecreatefrompng($tmp),
        'image/jpeg' => @imagecreatefromjpeg($tmp),
        'image/webp' => @imagecreatefromwebp($tmp),
        default      => false,
    };
    if (!$source instanceof GdImage) {
        throw new RuntimeException('That image could not be decoded.');
    }

    // No imagedestroy() anywhere in here, for the reason lib/photo.php gives:
    // it has been a no-op since PHP 8.0 and is deprecated in 8.5, where the
    // notice would be printed into the page.
    $logoPath    = trax_install_temp_file('logo');
    $faviconPath = trax_install_temp_file('icon');

    trax_install_write_logo_png($source, $logoPath);
    trax_install_write_favicon_png($source, $faviconPath, $brandColor);

    return [$logoPath, $faviconPath];
}

/** A fresh temp file path. The name is generated here; no part of it is user input. */
function trax_install_temp_file(string $tag): string
{
    $path = tempnam(sys_get_temp_dir(), 'trax' . $tag);
    if ($path === false) {
        throw new RuntimeException('The server has no writable temporary directory.');
    }
    return $path;
}

/** Writes the logo as PNG, scaled down to fit TRAX_INSTALL_LOGO_MAX_EDGE, alpha kept. */
function trax_install_write_logo_png(GdImage $source, string $path): void
{
    $w = imagesx($source);
    $h = imagesy($source);

    $scale = min(1.0, TRAX_INSTALL_LOGO_MAX_EDGE / max($w, $h));
    $tw    = max(1, (int)round($w * $scale));
    $th    = max(1, (int)round($h * $scale));

    $out = imagecreatetruecolor($tw, $th);
    imagealphablending($out, false);
    imagesavealpha($out, true);
    imagefill($out, 0, 0, imagecolorallocatealpha($out, 0, 0, 0, 127));
    imagealphablending($out, true);
    imagecopyresampled($out, $source, 0, 0, 0, 0, $tw, $th, $w, $h);

    if (!imagepng($out, $path, 9)) {
        throw new RuntimeException('The logo could not be written.');
    }
}

/**
 * Writes a square favicon: the logo contain-fitted, centred, on the brand colour.
 *
 * Contain rather than cover, because a cropped wordmark is unrecognisable at
 * 16 px; the brand colour behind it is what makes a transparent logo visible on
 * both a light and a dark browser tab.
 */
function trax_install_write_favicon_png(GdImage $source, string $path, string $brandColor): void
{
    $size = TRAX_INSTALL_FAVICON_SIZE;
    $hex  = trax_hex_color($brandColor) ?? '#1F2937';
    [$r, $g, $b] = [
        (int)hexdec(substr($hex, 1, 2)),
        (int)hexdec(substr($hex, 3, 2)),
        (int)hexdec(substr($hex, 5, 2)),
    ];

    $out = imagecreatetruecolor($size, $size);
    imagealphablending($out, false);
    imagesavealpha($out, true);
    imagefilledrectangle($out, 0, 0, $size - 1, $size - 1, imagecolorallocate($out, $r, $g, $b));
    imagealphablending($out, true);

    $pad   = (int)round($size * 0.12);
    $boxW  = $size - 2 * $pad;
    $w     = imagesx($source);
    $h     = imagesy($source);
    $scale = min($boxW / $w, $boxW / $h);
    $tw    = max(1, (int)round($w * $scale));
    $th    = max(1, (int)round($h * $scale));

    imagecopyresampled(
        $out,
        $source,
        (int)round(($size - $tw) / 2),
        (int)round(($size - $th) / 2),
        0,
        0,
        $tw,
        $th,
        $w,
        $h
    );

    if (!imagepng($out, $path, 9)) {
        throw new RuntimeException('The favicon could not be written.');
    }
}

// ---------------------------------------------------------------------------
// Validation — one function per step, all of them server-side
// ---------------------------------------------------------------------------

/**
 * Validates one step's POST and merges what it accepted into $state.
 *
 * @param  array $post   the raw $_POST
 * @param  array $files  the raw $_FILES
 * @param  array $state  modified in place, so a rejected form still shows back
 *                       what the operator typed
 * @return list<string>  human-readable errors; empty means the step passed
 */
function trax_install_validate(int $step, array $post, array $files, array &$state): array
{
    return match ($step) {
        1       => trax_install_validate_1($state),
        2       => trax_install_validate_2($post, $files, $state),
        3       => trax_install_validate_3($post, $state),
        4       => trax_install_validate_4($post, $state),
        5       => trax_install_validate_5($post, $state),
        6       => trax_install_validate_6($post, $state),
        default => ['Unknown step.'],
    };
}

/** Step 1: nothing to type, but the hard requirements still have to hold. */
function trax_install_validate_1(array &$state): array
{
    if (trax_install_blocked(trax_install_requirements())) {
        return ['Some requirements are not met yet. Fix them and reload this page.'];
    }
    return [];
}

/** Step 2: organisation and branding. */
function trax_install_validate_2(array $post, array $files, array &$state): array
{
    $errors = [];

    $state['appName']      = trax_str($post['appName'] ?? '', 60);
    $state['orgName']      = trax_str($post['orgName'] ?? '', 120);
    $state['labelHeading'] = trax_str($post['labelHeading'] ?? '', 40);
    $state['whatsapp']     = trax_str($post['whatsapp'] ?? '', 40);

    if ($state['appName'] === '') {
        $errors[] = 'The application name is required.';
    }
    if ($state['labelHeading'] === '') {
        $state['labelHeading'] = 'PROPERTY OF';
    }

    $colour = trax_hex_color($post['brandColor'] ?? '');
    if ($colour === null) {
        $errors[] = 'The brand colour must be a hex value like #1F2937.';
    } else {
        $state['brandColor'] = $colour;
    }

    if ($state['whatsapp'] !== '' && trax_whatsapp_digits($state['whatsapp']) === '') {
        $errors[] = 'That WhatsApp number cannot be dialled internationally. Use the +country form, e.g. +49 172 1234567.';
    }

    // "Remove the logo" wins over an upload in the same request: the operator
    // ticked it deliberately, the file field may just be a leftover.
    if (!empty($post['removeLogo'])) {
        trax_install_forget_logo($state);
    }

    $upload = $files['logo'] ?? null;
    if (is_array($upload) && (int)($upload['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_NO_FILE) {
        try {
            [$logo, $icon] = trax_install_process_logo($upload, $state['brandColor']);
            trax_install_forget_logo($state);
            $state['logoTmp']    = $logo;
            $state['faviconTmp'] = $icon;
            $state['logoClient'] = trax_str(basename((string)($upload['name'] ?? 'logo')), 120);
        } catch (RuntimeException $e) {
            $errors[] = $e->getMessage();
        }
    }

    return $errors;
}

/** Drops the pending logo and its generated favicon. */
function trax_install_forget_logo(array &$state): void
{
    foreach (['logoTmp', 'faviconTmp'] as $key) {
        if ($state[$key] !== '' && is_file($state[$key])) {
            @unlink($state[$key]);
        }
        $state[$key] = '';
    }
    $state['logoClient'] = '';
}

/**
 * Step 3: how sign-in works, and the first operator.
 *
 * The account is required in both modes. Making it optional under external auth
 * would save one form field and cost the only way back in when the external
 * include is renamed by a deploy — so it stays, and the form says why.
 */
function trax_install_validate_3(array $post, array &$state): array
{
    $errors = [];

    $state['authMode'] = ($post['authMode'] ?? '') === 'external' ? 'external' : 'builtin';
    $state['authInclude']   = trim(trax_str($post['authInclude'] ?? '', 512));
    $state['authLogoutUrl'] = trim(trax_str($post['authLogoutUrl'] ?? '', 512));

    if ($state['authMode'] === 'external') {
        $check = trax_external_auth_check($state['authInclude']);
        if (!$check['ok']) {
            $errors[] = 'The external auth include: ' . $check['message'];
        }
        if ($state['authLogoutUrl'] !== '' && trax_safe_logout_url($state['authLogoutUrl']) === '') {
            $errors[] = 'The sign-out URL must be an http(s) address or a path on this site.';
        }
    }

    $state['username'] = trim(trax_str($post['username'] ?? '', 64));
    $state['email']    = trim(trax_str($post['email'] ?? '', 254));
    $password          = (string)($post['password'] ?? '');
    $confirm           = (string)($post['password2'] ?? '');

    // The same rules trax_user_create() enforces, checked early so the operator
    // hears about them on this step instead of on the last one.
    if (preg_match(TRAX_USERNAME_PATTERN, $state['username']) !== 1) {
        $errors[] = 'The username must be 2–64 characters: letters, digits, dot, underscore and hyphen only.';
    }
    if ($state['email'] === '' || trax_valid_email($state['email']) === null) {
        $errors[] = 'Enter a valid email address — it is where a password reset would be sent.';
    }
    if (trax_password_length($password) < TRAX_MIN_PASSWORD_LEN) {
        $errors[] = 'The password must be at least ' . TRAX_MIN_PASSWORD_LEN . ' characters long.';
    } elseif ($password !== $confirm) {
        $errors[] = 'The two passwords do not match.';
    } else {
        $state['password'] = $password;
    }

    return $errors;
}

/** Step 4: where the site lives and which addresses it mails from. */
function trax_install_validate_4(array $post, array &$state): array
{
    $errors = [];

    $path = trax_public_path($post['publicPath'] ?? '');
    if ($path === null) {
        $errors[] = 'The public path must start with / and contain no "..", e.g. / or /assets/.';
    } else {
        $state['publicPath'] = $path;
    }

    $zone = trax_str($post['timezone'] ?? '', 64);
    if (!in_array($zone, DateTimeZone::listIdentifiers(), true)) {
        $errors[] = 'Pick a timezone from the list.';
    } else {
        $state['timezone'] = $zone;
    }

    $locale = trax_str($post['locale'] ?? '', 35);
    if ($locale === '__other') {
        $locale = trax_str($post['localeOther'] ?? '', 35);
    }
    if ($locale === '' || trax_locale($locale) !== $locale) {
        $errors[] = 'The locale must be a language tag such as en-US, de-DE or pt-BR.';
    } else {
        $state['locale'] = $locale;
    }

    $currency = trax_str($post['currency'] ?? '', 8);
    if ($currency === '__other') {
        $currency = trax_str($post['currencyOther'] ?? '', 8);
    }
    if ($currency === '') {
        $errors[] = 'The currency is required — EUR, USD, or whatever you price in.';
    } else {
        $state['currency'] = $currency;
    }

    $format = trax_str($post['dateFormat'] ?? '', 40);
    if ($format === '__other') {
        $format = trax_str($post['dateFormatOther'] ?? '', 40);
    }
    if ($format === '' || trim(@date($format, time())) === '') {
        $errors[] = 'The date format must be a PHP date() format that renders something, e.g. Y-m-d H:i.';
    } else {
        $state['dateFormat'] = $format;
    }

    foreach (['ownerEmail', 'fromEmail', 'reportFromEmail'] as $field) {
        $value = trim(trax_str($post[$field] ?? '', 254));
        if ($value !== '' && trax_valid_email($value) === null) {
            $errors[] = 'That is not a valid address: ' . $value;
            continue;
        }
        $state[$field] = $value;
    }

    return $errors;
}

/** Step 5: the cron trigger and the loan defaults. */
function trax_install_validate_5(array $post, array &$state): array
{
    $errors = [];

    // A secret with a newline in it is one nobody can put in a URL, which is
    // exactly what the settings normaliser says too.
    $secret = trax_mail_header_safe(trax_str($post['cronSecret'] ?? '', 200));
    if ($secret !== '' && strlen($secret) < 16) {
        $errors[] = 'The cron secret should be at least 16 characters, or empty to disable the web trigger.';
    } else {
        $state['cronSecret'] = $secret;
    }

    $state['loanDays']          = trax_clamp_int($post['loanDays'] ?? null, 1, 365, 7);
    $state['dueHour']           = trax_clamp_int($post['dueHour'] ?? null, 0, 23, 18);
    $state['dueSoonHours']      = trax_clamp_int($post['dueSoonHours'] ?? null, 1, 168, 24);
    $state['overdueRepeatDays'] = trax_clamp_int($post['overdueRepeatDays'] ?? null, 1, 90, 7);

    return $errors;
}

/** Step 6: demo data, then the review. */
function trax_install_validate_6(array $post, array &$state): array
{
    $state['demoData'] = !empty($post['demoData']);
    return [];
}

/**
 * Re-runs every step's validation over the collected state.
 *
 * The wizard already validated each step as it was submitted; this runs the lot
 * again immediately before anything is written, because a session can be edited
 * between two steps by anything that can reach it and because a step reached by
 * going Back and then jumping forward must not be able to skip its own rules.
 *
 * @return list<string>
 */
function trax_install_validate_all(array $state): array
{
    $errors = [];

    if (trax_install_blocked(trax_install_requirements())) {
        $errors[] = 'The host no longer meets the requirements from step 1.';
    }

    if (trax_str($state['appName'], 60) === '') {
        $errors[] = 'The application name is missing (step 2).';
    }
    if (trax_hex_color($state['brandColor']) === null) {
        $errors[] = 'The brand colour is not a hex value (step 2).';
    }
    if ($state['whatsapp'] !== '' && trax_whatsapp_digits($state['whatsapp']) === '') {
        $errors[] = 'The WhatsApp number is not usable (step 2).';
    }

    if (preg_match(TRAX_USERNAME_PATTERN, (string)$state['username']) !== 1) {
        $errors[] = 'The administrator username is missing or invalid (step 3).';
    }
    if (trax_valid_email((string)$state['email']) === null) {
        $errors[] = 'The administrator email address is missing or invalid (step 3).';
    }
    if (trax_password_length((string)$state['password']) < TRAX_MIN_PASSWORD_LEN) {
        $errors[] = 'The administrator password is missing or too short (step 3).';
    }
    if (($state['authMode'] ?? 'builtin') === 'external') {
        $check = trax_external_auth_check((string)$state['authInclude']);
        if (!$check['ok']) {
            $errors[] = 'The external auth include is not usable (step 3): ' . $check['message'];
        }
        if ($state['authLogoutUrl'] !== '' && trax_safe_logout_url($state['authLogoutUrl']) === '') {
            $errors[] = 'The sign-out URL is invalid (step 3).';
        }
    }

    if (trax_public_path($state['publicPath']) === null) {
        $errors[] = 'The public path is invalid (step 4).';
    }
    if (!in_array($state['timezone'], DateTimeZone::listIdentifiers(), true)) {
        $errors[] = 'The timezone is invalid (step 4).';
    }
    if (trax_locale($state['locale']) !== $state['locale']) {
        $errors[] = 'The locale is invalid (step 4).';
    }
    if (trax_str($state['currency'], 8) === '') {
        $errors[] = 'The currency is missing (step 4).';
    }
    if (trax_str($state['dateFormat'], 40) === '') {
        $errors[] = 'The date format is missing (step 4).';
    }
    foreach (['ownerEmail', 'fromEmail', 'reportFromEmail'] as $field) {
        if ($state[$field] !== '' && trax_valid_email($state[$field]) === null) {
            $errors[] = 'One of the mail addresses is invalid (step 4).';
            break;
        }
    }

    if ($state['cronSecret'] !== '' && strlen($state['cronSecret']) < 16) {
        $errors[] = 'The cron secret is too short (step 5).';
    }

    return $errors;
}

// ---------------------------------------------------------------------------
// What gets written
// ---------------------------------------------------------------------------

/** The settings block, normalised exactly as the store will store it. */
function trax_install_settings(array $state): array
{
    return trax_normalize_settings([
        'email' => [
            'ownerEmail'      => $state['ownerEmail'],
            'fromEmail'       => $state['fromEmail'],
            'reportFromEmail' => $state['reportFromEmail'],
        ],
        'branding' => [
            'appName'      => $state['appName'],
            'orgName'      => $state['orgName'],
            'brandColor'   => $state['brandColor'],
            'publicPath'   => $state['publicPath'],
            // '' unless a logo was uploaded; trax_logo_file() drops a name that
            // points at nothing, which is why the images are committed before
            // data.json is.
            'logoFile'     => $state['logoTmp'] !== '' ? 'logo.png' : '',
            'faviconFile'  => 'favicon.png',
            'labelHeading' => $state['labelHeading'],
            'whatsapp'     => $state['whatsapp'],
        ],
        'defaults' => [
            'loanDays'   => $state['loanDays'],
            'dueHour'    => $state['dueHour'],
            'currency'   => $state['currency'],
            'locale'     => $state['locale'],
            'dateFormat' => $state['dateFormat'],
        ],
        'cron' => [
            'secret'            => $state['cronSecret'],
            'dueSoonHours'      => $state['dueSoonHours'],
            'overdueRepeatDays' => $state['overdueRepeatDays'],
        ],
    ]);
}

/**
 * The constants lib/config.local.php gets.
 *
 * Values only: the file itself is written by trax_config_local_write() in
 * lib/config-local.php, which is also what Settings → Authentication uses. One
 * writer, one format, one whitelist — the installer used to be the only author
 * of this file and no longer is.
 *
 * TRAX_INSTALLED is the last line and the meaningful one: it is what
 * trax_is_installed() reads on an external-auth install, where users.json is a
 * fallback rather than proof the wizard ever ran.
 */
function trax_install_config_values(array $state, string $host): array
{
    return [
        'TRAX_TIMEZONE'          => $state['timezone'],
        'TRAX_PUBLIC_PATH'       => $state['publicPath'],
        'TRAX_FALLBACK_HOST'     => $host,
        'TRAX_OWNER_EMAIL'       => $state['ownerEmail'],
        'TRAX_FROM_EMAIL'        => $state['fromEmail'],
        'TRAX_REPORT_FROM_EMAIL' => $state['reportFromEmail'],
        'TRAX_WHATSAPP'          => $state['whatsapp'],
        'TRAX_AUTH_MODE'         => $state['authMode'],
        'TRAX_AUTH_INCLUDE'      => $state['authInclude'],
        'TRAX_AUTH_LOGOUT_URL'   => $state['authLogoutUrl'],
        'TRAX_INSTALLED'         => true,
    ];
}

/**
 * The data.json payload: the settings block, plus the demo records if asked for.
 *
 * Everything goes through trax_normalize_data() before it is encoded — the same
 * call trax_mutate() makes — so what lands on disk is what the store would have
 * written itself. rev starts at 1 because that is the floor the normaliser
 * enforces, and every later write increments from there.
 */
function trax_install_data(array $state): array
{
    $settings = trax_install_settings($state);

    if (!empty($state['demoData'])) {
        $demo = require __DIR__ . '/demo-data.php';
        $data = $demo($settings);
    } else {
        $data = [
            'rev'           => 1,
            'assets'        => [],
            'events'        => [],
            'reservations'  => [],
            'rentalHistory' => [],
            'bookings'      => [],
            'settings'      => $settings,
            'cronState'     => [],
        ];
    }

    $data['rev']      = 1;
    $data['settings'] = $settings;

    return trax_normalize_data($data);
}

// ---------------------------------------------------------------------------
// Step 7 — the commit
// ---------------------------------------------------------------------------

/**
 * Writes the installation, or writes nothing at all.
 *
 * The order matters twice over:
 *
 *   1. The branding images go in before data.json, because trax_logo_file()
 *      drops the name of a file that does not exist yet — write data.json first
 *      and settings.branding.logoFile normalises to '' before the logo lands.
 *   2. users.json goes LAST, because trax_is_installed() flips the moment it
 *      holds a user: from that instant install.php answers 403 and there is no
 *      way back into the wizard. Nothing may be left half-written behind it.
 *
 * Anything this function created is removed again if a later write throws, and
 * a file it overwrote is restored from a copy taken first. Directories it made
 * are removed too, but only while still empty.
 *
 * @return list<string> the paths written, for the Done page
 * @throws RuntimeException
 */
function trax_install_commit(array $state): array
{
    $root      = trax_install_root();
    $created   = [];   // path => true, for files that did not exist before
    $restore   = [];   // path => backup path
    $madeDirs  = [];

    $begin = static function (string $path) use (&$created, &$restore): void {
        if (!is_file($path)) {
            $created[$path] = true;
            return;
        }
        $backup = $path . '.trax-install-backup';
        if (@copy($path, $backup)) {
            $restore[$path] = $backup;
        }
    };

    try {
        // The directories the app writes into. FTP uploads routinely drop empty
        // ones, and an install that cannot store a photo is not installed.
        foreach ([TRAX_UPLOAD_DIR, TRAX_UPLOAD_DIR . '/thumb', TRAX_DOC_DIR, $root . '/phpqrcode/cache'] as $dir) {
            if (!is_dir($dir)) {
                if (!@mkdir($dir, 0755, true)) {
                    throw new RuntimeException('Cannot create ' . $dir . '.');
                }
                $madeDirs[] = $dir;
            }
        }

        // 1. Deployment constants.
        $configFile = trax_install_config_file();
        $begin($configFile);
        trax_config_local_write(trax_install_config_values($state, trax_install_host()));

        // 2. Branding images — before data.json, see the note above.
        if ($state['logoTmp'] !== '' && is_file($state['logoTmp'])) {
            $logoTarget = $root . '/logo.png';
            $begin($logoTarget);
            $bytes = @file_get_contents($state['logoTmp']);
            if ($bytes === false) {
                throw new RuntimeException('The prepared logo has gone missing. Go back to step 2 and upload it again.');
            }
            trax_write_atomic($logoTarget, $bytes);

            if ($state['faviconTmp'] !== '' && is_file($state['faviconTmp'])) {
                $iconTarget = $root . '/favicon.png';
                $begin($iconTarget);
                $iconBytes = @file_get_contents($state['faviconTmp']);
                if ($iconBytes === false) {
                    throw new RuntimeException('The generated favicon has gone missing. Go back to step 2 and upload the logo again.');
                }
                trax_write_atomic($iconTarget, $iconBytes);
            }
        }

        // 3. The data file, through the store's own encode + atomic write, so
        //    the result is normalised exactly like every later save.
        $begin(TRAX_DATA_FILE);
        trax_write_atomic(TRAX_DATA_FILE, trax_encode(trax_install_data($state)));

        // 4. The operator. This is the point of no return.
        $begin(trax_users_file());
        trax_user_create($state['username'], $state['email'], $state['password']);
    } catch (Throwable $e) {
        foreach (array_keys($created) as $path) {
            @unlink($path);
        }
        foreach ($restore as $path => $backup) {
            @copy($backup, $path);
            @unlink($backup);
        }
        foreach (array_reverse($madeDirs) as $dir) {
            @rmdir($dir);   // fails harmlessly if something already wrote into it
        }
        throw new RuntimeException('The installation could not be completed: ' . $e->getMessage(), 0, $e);
    }

    foreach ($restore as $backup) {
        @unlink($backup);
    }

    $written = array_keys($created);
    foreach (array_keys($restore) as $path) {
        $written[] = $path;
    }
    return $written;
}

/** The host this installer was reached on, for TRAX_FALLBACK_HOST. */
function trax_install_host(): string
{
    $host = (string)($_SERVER['HTTP_HOST'] ?? '');
    return preg_match('/^[A-Za-z0-9.\-]+(:\d+)?$/', $host) === 1 ? $host : '';
}

/** The URL a cron job would call, secret included. '' when there is no secret. */
function trax_install_cron_url(array $state): string
{
    if ($state['cronSecret'] === '') {
        return '';
    }
    $base = rtrim(trax_base_url(), '/') . rtrim($state['publicPath'], '/');
    return $base . '/cron.php?secret=' . rawurlencode($state['cronSecret']);
}

/** The crontab line for a host that can run PHP directly — no secret needed there. */
function trax_install_crontab_line(): string
{
    $php = PHP_BINARY !== '' ? PHP_BINARY : 'php';
    return '*/15 * * * * ' . $php . ' ' . trax_install_root() . '/cron.php > /dev/null 2>&1';
}
