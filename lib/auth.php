<?php
/**
 * Authentication and CSRF protection.
 *
 * This app used to lean on the host's own login system: every entry point pulled in
 * an external gate that lived outside the docroot, and this file only layered a
 * CSRF token on top of whatever session that gate had already started. It made
 * the tool unshippable — the login belonged to one particular hosting account.
 *
 * The login now lives here. Operators are kept in a flat JSON file next to
 * data.json (denied to the web by .htaccess), passwords are hashed with
 * password_hash(), and every authenticated entry point calls
 * trax_require_login() as its first statement.
 *
 * Users file layout — TRAX_DATA_DIR . '/users.json':
 *
 *   {"users":[{"id":1,"username":"admin","email":"a@b.c",
 *              "passwordHash":"$2y$…","role":"admin","createdAt":"…"}]}
 */

declare(strict_types=1);

const TRAX_CSRF_SESSION_KEY = 'trax_csrf';
const TRAX_CSRF_HEADER      = 'HTTP_X_TRAX_CSRF';

/** Where the session remembers who is logged in. */
const TRAX_SESSION_UID_KEY  = 'trax_uid';
const TRAX_SESSION_NAME_KEY = 'trax_user';

/** Login rules. Kept here rather than in config.php: they are not deployment knobs. */
const TRAX_USERNAME_PATTERN = '/^[A-Za-z0-9._-]{2,64}$/';
const TRAX_MIN_PASSWORD_LEN = 10;

/**
 * In-session brute-force brake. Five wrong passwords and the sixth attempt is
 * refused for half a minute. Per session, not per user: it costs an attacker
 * only a cookie jar to reset, so it is a brake on a careless human at the
 * keyboard, not a defence against a determined script — that is what a long
 * password is for.
 */
const TRAX_LOGIN_MAX_FAILURES = 5;
const TRAX_LOGIN_LOCK_SECONDS = 30;

const TRAX_SESSION_FAILS_KEY  = 'trax_login_fails';
const TRAX_SESSION_LOCKED_KEY = 'trax_login_locked_until';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Starts the session if nothing has started one yet. */
function trax_ensure_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    // The cookie is never read by JavaScript and never needed on a cross-site
    // navigation, so it is closed down as far as it goes. Secure only when the
    // request actually arrived over TLS — setting it unconditionally would drop
    // the cookie on a plain-HTTP dev server and make login silently impossible.
    $https = (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

    session_start([
        'cookie_httponly' => true,
        'cookie_samesite' => 'Lax',
        'cookie_secure'   => $https,
        'use_strict_mode' => true,
    ]);
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/** Returns the session's CSRF token, minting one on first use. */
function trax_csrf_token(): string
{
    trax_ensure_session();

    if (empty($_SESSION[TRAX_CSRF_SESSION_KEY]) || !is_string($_SESSION[TRAX_CSRF_SESSION_KEY])) {
        $_SESSION[TRAX_CSRF_SESSION_KEY] = bin2hex(random_bytes(32));
    }

    return $_SESSION[TRAX_CSRF_SESSION_KEY];
}

/**
 * Verifies the token supplied by a mutating request.
 * Accepts it from the X-Trax-Csrf header (normal path) or a `csrf` body
 * field (multipart uploads, which cannot set custom headers as easily).
 */
function trax_csrf_verify(?string $supplied): bool
{
    $expected = trax_csrf_token();

    if ($supplied === null || $supplied === '') {
        $supplied = $_SERVER[TRAX_CSRF_HEADER] ?? '';
    }

    return is_string($supplied)
        && $supplied !== ''
        && hash_equals($expected, $supplied);
}

// ---------------------------------------------------------------------------
// The users file
// ---------------------------------------------------------------------------

/** Absolute path of the operator store. */
function trax_users_file(): string
{
    if (!defined('TRAX_DATA_DIR')) {
        throw new RuntimeException('lib/config.php must be loaded before lib/auth.php.');
    }

    return TRAX_DATA_DIR . '/users.json';
}

/**
 * Reads the operator store. A missing or unreadable file is "no operators yet",
 * not an error: that state is exactly what the installer looks for, and a
 * corrupt file must not turn into a fatal on every single page.
 *
 * @return array{users: list<array>}
 */
function trax_users_load(): array
{
    $path = trax_users_file();
    if (!is_file($path)) {
        return ['users' => []];
    }

    $raw = @file_get_contents($path);
    if ($raw === false || trim($raw) === '') {
        return ['users' => []];
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded) || !is_array($decoded['users'] ?? null)) {
        error_log('[app] users.json is not readable as JSON — treating as empty.');
        return ['users' => []];
    }

    $users = [];
    foreach ($decoded['users'] as $user) {
        if (!is_array($user) || !isset($user['username'], $user['passwordHash'])) {
            continue;
        }
        $users[] = [
            'id'           => (int)($user['id'] ?? 0),
            'username'     => (string)$user['username'],
            'email'        => (string)($user['email'] ?? ''),
            'passwordHash' => (string)$user['passwordHash'],
            'role'         => (string)($user['role'] ?? 'admin'),
            'createdAt'    => (string)($user['createdAt'] ?? ''),
        ];
    }

    return ['users' => $users];
}

/**
 * Commits the operator store.
 *
 * Same tempnam + rename dance as trax_write_atomic() in lib/store.php, written
 * out again rather than reached for: auth.php is loaded by login.php and by
 * the installer, neither of which has any other reason to pull in the store.
 * The mode is 0600, not store.php's 0644 — this file is password hashes.
 */
function trax_users_save(array $store): void
{
    $users = [];
    foreach (($store['users'] ?? []) as $user) {
        if (is_array($user)) {
            $users[] = $user;
        }
    }

    $path = trax_users_file();
    $dir  = dirname($path);
    $json = json_encode(['users' => $users], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        throw new RuntimeException('Cannot encode users.json: ' . json_last_error_msg());
    }

    $tmp = tempnam($dir, '.traxusers');
    if ($tmp === false) {
        throw new RuntimeException("Cannot create a temporary file in {$dir}.");
    }

    try {
        @chmod($tmp, 0600);
        $fh = fopen($tmp, 'wb');
        if ($fh === false) {
            throw new RuntimeException("Cannot open {$tmp}.");
        }
        try {
            if (fwrite($fh, $json) !== strlen($json)) {
                throw new RuntimeException("Short write to {$tmp}.");
            }
            fflush($fh);
            if (function_exists('fsync')) {
                @fsync($fh);
            }
        } finally {
            fclose($fh);
        }

        // rename() is atomic within a filesystem, so a reader never sees a
        // half-written user list and never locks itself out mid-save.
        if (!rename($tmp, $path)) {
            throw new RuntimeException("Cannot commit {$path}.");
        }
        @chmod($path, 0600);
    } catch (Throwable $e) {
        @unlink($tmp);
        throw $e;
    }
}

/**
 * True once this instance has been installed.
 *
 * Two signals, either of which is enough. TRAX_INSTALLED is what the installer
 * writes and the only one an external-auth install can rely on — there the
 * operator record is a fallback, not the thing that proves the wizard ran. A
 * users.json with someone in it counts too, because every install made before
 * that constant existed has one and none of them has the constant.
 */
function trax_is_installed(): bool
{
    if (defined('TRAX_INSTALLED') && TRAX_INSTALLED === true) {
        return true;
    }

    return trax_users_load()['users'] !== [];
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

/** Length in characters, not bytes: a 10-character passphrase is 10 either way. */
function trax_password_length(string $password): int
{
    return function_exists('mb_strlen') ? mb_strlen($password, 'UTF-8') : strlen($password);
}

/** Throws unless the password clears the minimum length. */
function trax_assert_password(string $password): void
{
    if (trax_password_length($password) < TRAX_MIN_PASSWORD_LEN) {
        throw new InvalidArgumentException(
            'The password must be at least ' . TRAX_MIN_PASSWORD_LEN . ' characters long.'
        );
    }
}

/**
 * Creates an operator and commits the store.
 *
 * @throws InvalidArgumentException on a bad username, a bad email, a short
 *         password, or a username already taken (compared case-insensitively —
 *         "Admin" and "admin" must not both exist to be confused later).
 * @return array The stored record, including its hash.
 */
function trax_user_create(string $username, string $email, string $password): array
{
    $username = trim($username);
    $email    = trim($email);

    if (preg_match(TRAX_USERNAME_PATTERN, $username) !== 1) {
        throw new InvalidArgumentException(
            'The username must be 2–64 characters and may use letters, digits, dot, underscore and hyphen only.'
        );
    }
    if ($email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
        throw new InvalidArgumentException('That email address is not valid.');
    }
    trax_assert_password($password);

    $store  = trax_users_load();
    $nextId = 1;
    foreach ($store['users'] as $existing) {
        if (strcasecmp($existing['username'], $username) === 0) {
            throw new InvalidArgumentException('That username is already taken.');
        }
        $nextId = max($nextId, (int)$existing['id'] + 1);
    }

    $hash = password_hash($password, PASSWORD_DEFAULT);
    if (!is_string($hash) || $hash === '') {
        throw new RuntimeException('Cannot hash the password.');
    }

    $user = [
        'id'           => $nextId,
        'username'     => $username,
        'email'        => $email,
        'passwordHash' => $hash,
        'role'         => 'admin',
        'createdAt'    => date('c'),
    ];

    $store['users'][] = $user;
    trax_users_save($store);

    return $user;
}

/**
 * Checks a username/password pair.
 *
 * A missing user still costs one password_verify() against a throwaway hash, so
 * the answer takes about as long either way and the form cannot be used to
 * enumerate who exists.
 *
 * @return array|null The stored record, or null if the pair is wrong.
 */
function trax_user_verify(string $username, string $password): ?array
{
    $username = trim($username);
    $store    = trax_users_load();

    $found = null;
    foreach ($store['users'] as $index => $user) {
        if (strcasecmp($user['username'], $username) === 0) {
            $found = $index;
            break;
        }
    }

    if ($found === null) {
        password_verify($password, '$2y$10$usesomesillystringfore7hnbRJHxXVLeakoG8K30M1PIx1WkQi');
        return null;
    }

    $user = $store['users'][$found];
    if (!password_verify($password, $user['passwordHash'])) {
        return null;
    }

    // PHP's default algorithm and cost can change under our feet on an upgrade.
    // The one moment the plaintext is available is the moment to catch up.
    if (password_needs_rehash($user['passwordHash'], PASSWORD_DEFAULT)) {
        $rehashed = password_hash($password, PASSWORD_DEFAULT);
        if (is_string($rehashed) && $rehashed !== '') {
            $store['users'][$found]['passwordHash'] = $rehashed;
            $user['passwordHash'] = $rehashed;
            try {
                trax_users_save($store);
            } catch (Throwable $e) {
                // A failed rehash must never cost a valid operator their login.
                error_log('[app] could not persist password rehash: ' . $e->getMessage());
            }
        }
    }

    return $user;
}

/**
 * Replaces an operator's password. The caller is responsible for having proved
 * the operator is who they say they are.
 *
 * @throws InvalidArgumentException if the password is too short or no such user.
 */
function trax_user_change_password(int $id, string $newPassword): void
{
    trax_assert_password($newPassword);

    $store = trax_users_load();
    foreach ($store['users'] as $index => $user) {
        if ((int)$user['id'] !== $id) {
            continue;
        }
        $hash = password_hash($newPassword, PASSWORD_DEFAULT);
        if (!is_string($hash) || $hash === '') {
            throw new RuntimeException('Cannot hash the password.');
        }
        $store['users'][$index]['passwordHash'] = $hash;
        trax_users_save($store);
        return;
    }

    throw new InvalidArgumentException('No such user.');
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/**
 * Marks the session as belonging to $user.
 *
 * The id is regenerated first: the anonymous session id was visible to whoever
 * handed out the login form, and reusing it would leave a fixation window.
 */
function trax_login(array $user): void
{
    trax_ensure_session();
    session_regenerate_id(true);

    $_SESSION[TRAX_SESSION_UID_KEY]  = (int)($user['id'] ?? 0);
    $_SESSION[TRAX_SESSION_NAME_KEY] = (string)($user['username'] ?? '');

    // A fresh token for a fresh session: the pre-login token was minted for an
    // anonymous visitor and must not carry authority across the boundary.
    unset(
        $_SESSION[TRAX_CSRF_SESSION_KEY],
        $_SESSION[TRAX_SESSION_FAILS_KEY],
        $_SESSION[TRAX_SESSION_LOCKED_KEY]
    );
    trax_csrf_token();
}

/** Drops the session entirely — data, cookie and all. */
function trax_logout(): void
{
    trax_ensure_session();

    $_SESSION = [];

    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(session_name(), '', [
            'expires'  => time() - 42000,
            'path'     => $params['path'],
            'domain'   => $params['domain'],
            'secure'   => $params['secure'],
            'httponly' => $params['httponly'],
            'samesite' => $params['samesite'] ?: 'Lax',
        ]);
    }

    session_destroy();
}

/** The logged-in operator's stored record, or null. */
function trax_current_user(): ?array
{
    trax_ensure_session();

    $id = (int)($_SESSION[TRAX_SESSION_UID_KEY] ?? 0);
    if ($id <= 0) {
        return null;
    }

    foreach (trax_users_load()['users'] as $user) {
        if ((int)$user['id'] === $id) {
            return $user;
        }
    }

    // The account was deleted while its session was still alive.
    return null;
}

// ---------------------------------------------------------------------------
// Login throttle
// ---------------------------------------------------------------------------

/** Seconds the current session must wait before another attempt. 0 = go ahead. */
function trax_login_lock_seconds(): int
{
    trax_ensure_session();

    $until = (int)($_SESSION[TRAX_SESSION_LOCKED_KEY] ?? 0);
    return $until > time() ? $until - time() : 0;
}

/** Records a wrong password and arms the brake once the limit is reached. */
function trax_login_register_failure(): void
{
    trax_ensure_session();

    $fails = (int)($_SESSION[TRAX_SESSION_FAILS_KEY] ?? 0) + 1;
    $_SESSION[TRAX_SESSION_FAILS_KEY] = $fails;

    if ($fails >= TRAX_LOGIN_MAX_FAILURES) {
        $_SESSION[TRAX_SESSION_LOCKED_KEY] = time() + TRAX_LOGIN_LOCK_SECONDS;
        $_SESSION[TRAX_SESSION_FAILS_KEY]  = 0;
    }
}

// ---------------------------------------------------------------------------
// External authentication
//
// Some hosts already have a login, and this app used to be one of the things
// behind it: every entry point pulled in a check_auth.php that lived outside
// the docroot, redirected anonymous visitors and left an identity in $_SESSION.
// That include is optional again — TRAX_AUTH_MODE decides.
// ---------------------------------------------------------------------------

/**
 * Which gate is actually in force: 'external' or 'builtin'.
 *
 * THE LOCK-OUT GUARD. External mode is only reported when the include really is
 * a readable file. A path that has been renamed, moved by a deploy, or lost to
 * a permission change would otherwise take every entry point down with it and
 * leave nobody a way back in — there is no login form in external mode. Instead
 * the miss is logged once per request and the built-in login comes back, so the
 * operator can sign in with the account the installer made and fix the path
 * under Settings → Authentication. Deleting the TRAX_AUTH_MODE line in
 * lib/config.local.php does the same thing by hand.
 */
function trax_auth_mode(): string
{
    static $warned = false;

    if (!defined('TRAX_AUTH_MODE') || TRAX_AUTH_MODE !== 'external') {
        return 'builtin';
    }

    $path = defined('TRAX_AUTH_INCLUDE') ? (string)TRAX_AUTH_INCLUDE : '';
    if ($path !== '' && is_file($path) && is_readable($path)) {
        return 'external';
    }

    if (!$warned) {
        $warned = true;
        error_log(
            '[app] TRAX_AUTH_MODE is "external" but TRAX_AUTH_INCLUDE ('
            . ($path !== '' ? $path : '<empty>')
            . ') is not a readable file — falling back to the built-in login.'
        );
    }

    return 'builtin';
}

/**
 * Is $path usable as the external gate?
 *
 * Deliberately no shelling out to `php -l`: shared hosts routinely disable
 * exec(), and a tool that only validates where it can run a subprocess is worse
 * than one that does not try. The file has to exist, be readable, and open with
 * `<?php` — enough to catch the three real mistakes (a typo, a relative path,
 * and pointing at the login PAGE instead of the include).
 *
 * And it has to live OUTSIDE the application, under a name ending in .php. That
 * last pair is not ergonomics, it is the upload chain: an operator can put
 * arbitrary bytes on this filesystem through the document and photo uploads,
 * which land in TRAX_DOC_DIR and TRAX_UPLOAD_DIR under TRAX_DATA_DIR. Without
 * this rule, "point the gate at a file" and "run a file you just uploaded" are
 * the same feature — every request would require_once it. So the resolved real
 * path (symlinks and .. already collapsed) must end in .php and must not sit
 * inside any of those three directories.
 *
 * @return array{ok: bool, message: string}
 */
function trax_external_auth_check(string $path): array
{
    $bad = static fn(string $message): array => ['ok' => false, 'message' => $message];

    if (trim($path) === '') {
        return $bad('Enter the full path to the include file.');
    }
    if (preg_match('/[\x00-\x1f\x7f]/', $path) === 1) {
        return $bad('That path contains a control character.');
    }
    // Absolute only. A relative path resolves against whatever directory the
    // current entry point happens to run from, which is not the same for
    // admin.php, api.php and cron.php.
    if (!str_starts_with($path, '/') && preg_match('#^[A-Za-z]:[\\\\/]#', $path) !== 1) {
        return $bad('The path must be absolute, e.g. /var/www/example.com/auth/check_auth.php.');
    }
    if (!is_file($path)) {
        return $bad('There is no file at that path.');
    }
    if (!is_readable($path)) {
        return $bad('That file exists, but PHP is not allowed to read it.');
    }

    $handle = @fopen($path, 'rb');
    if ($handle === false) {
        return $bad('That file cannot be opened.');
    }
    $head = (string)fread($handle, 512);
    fclose($handle);

    // A UTF-8 BOM and leading blank lines are common in files edited over FTP.
    $head = preg_replace('/^\xEF\xBB\xBF/', '', $head) ?? $head;
    if (!str_starts_with(ltrim($head), '<?php')) {
        return $bad('That file does not start with <?php, so it is not a PHP include.');
    }

    // Everything from here is judged on the REAL path: a symlink or a "../"
    // that lands back in uploads/ has to be caught by where it ends up, not by
    // how it was spelled.
    $real = realpath($path);
    if ($real === false) {
        return $bad('There is no file at that path.');
    }

    $outside = 'The include must be a .php file outside the application folder.';

    if (strtolower(substr($real, -4)) !== '.php') {
        return $bad($outside);
    }

    foreach (['TRAX_UPLOAD_DIR', 'TRAX_DOC_DIR', 'TRAX_DATA_DIR'] as $constant) {
        if (!defined($constant)) {
            continue;
        }
        $base = realpath((string)constant($constant));
        if ($base === false) {
            continue;
        }
        $base = rtrim($base, '/\\') . DIRECTORY_SEPARATOR;
        if (str_starts_with($real, $base)) {
            return $bad($outside);
        }
    }

    return ['ok' => true, 'message' => 'The file exists, is readable and starts with <?php.'];
}

/**
 * Runs the external gate.
 *
 * A function, so that whatever the included file declares at its top level
 * becomes a local of THIS call and not a global that could shadow something
 * here. Nothing is assigned before the require, so the include inherits an
 * empty local scope — the old check_auth.php only ever read $_SERVER and wrote
 * $_SESSION, but an include is someone else's code and gets as little to trip
 * over as possible.
 *
 * The session is started first: the contract is that the include finds an
 * already-active session and writes into it. An include that calls
 * session_start() itself unguarded will emit a notice — README says to guard it.
 */
function trax_external_auth_run(): void
{
    trax_ensure_session();
    require_once TRAX_AUTH_INCLUDE;
}

/**
 * Who the external gate says this is, '' for nobody.
 *
 * A built-in session wins if there is one — an operator who signed in at
 * login.php before the mode was switched keeps their own name. Otherwise the
 * identity is sniffed out of $_SESSION by trax_actor(), which already knows the
 * key names these gates use (trax_user, username, user, email, login).
 */
function trax_external_identity(): string
{
    return trax_actor();
}

/**
 * Sanitises the "Sign out" destination for external mode.
 *
 * An absolute http(s) URL is allowed — the host's logout endpoint is usually on
 * another path or another host entirely — and so is a same-site relative path.
 * Everything else, javascript: above all, yields ''. This value ends up in a
 * Location header, so control characters are refused outright.
 */
function trax_safe_logout_url(mixed $candidate): string
{
    if (!is_string($candidate) || $candidate === '' || strlen($candidate) > 512) {
        return '';
    }
    if (preg_match('/[\x00-\x1f\x7f]/', $candidate) === 1) {
        return '';
    }

    if (preg_match('#^https?://#i', $candidate) === 1) {
        return filter_var($candidate, FILTER_VALIDATE_URL) !== false ? $candidate : '';
    }

    // Not a URL, so it has to be a path this site can serve. '//host' and
    // 'javascript:' are refused by trax_safe_next() for the same reason.
    return trax_safe_next($candidate);
}

/**
 * The authentication settings, as the API hands them to the Settings screen.
 *
 * $override lets the caller ask "what would this look like once saved?", which
 * is what auth.configUpdate answers with: the constants of the current request
 * were fixed when lib/config.php ran and cannot show the values just written.
 *
 * @param array{mode?: string, include?: string, logoutUrl?: string}|null $override
 */
function trax_auth_config(?array $override = null): array
{
    $mode = defined('TRAX_AUTH_MODE') && TRAX_AUTH_MODE === 'external' ? 'external' : 'builtin';
    $include   = defined('TRAX_AUTH_INCLUDE') ? (string)TRAX_AUTH_INCLUDE : '';
    $logoutUrl = defined('TRAX_AUTH_LOGOUT_URL') ? (string)TRAX_AUTH_LOGOUT_URL : '';

    if ($override !== null) {
        $mode      = ($override['mode'] ?? $mode) === 'external' ? 'external' : 'builtin';
        $include   = (string)($override['include'] ?? $include);
        $logoutUrl = (string)($override['logoutUrl'] ?? $logoutUrl);
    }

    $status = trax_external_auth_check($include);
    $users  = trax_users_load()['users'];

    return [
        'mode'          => $mode,
        'include'       => $include,
        'logoutUrl'     => $logoutUrl,
        // What the next request will actually use — the fallback made visible.
        'effectiveMode' => ($mode === 'external' && $status['ok']) ? 'external' : 'builtin',
        'includeStatus' => $status,
        // How many accounts would still be able to sign in at login.php if the
        // external gate went away, and what they are called. The names are for
        // the Account section: in external mode there is no session record to
        // aim a password change at, so the client has to name one. Usernames
        // only — this is already behind the gate, and it is the one detail an
        // operator cannot look up without shell access to users.json.
        'hasBuiltinUsers' => count($users),
        'builtinUsers'    => array_values(array_map(
            static fn(array $user): string => (string)$user['username'],
            $users
        )),
    ];
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Sanitises a post-login destination.
 *
 * The only shapes allowed back out are same-document-root relative paths. An
 * absolute URL, a protocol-relative "//evil.example", anything carrying a
 * scheme, a backslash or a header-splitting newline yields '' — the caller then
 * falls back to admin.php. Without this the login form is an open redirect that
 * a phishing mail can point anywhere.
 */
function trax_safe_next(mixed $candidate): string
{
    if (!is_string($candidate) || $candidate === '' || strlen($candidate) > 512) {
        return '';
    }
    if (preg_match('/[\x00-\x1f\x7f\\\\]/', $candidate) === 1) {
        return '';
    }
    if (str_starts_with($candidate, '//')) {
        return '';
    }
    // "http:", "javascript:", "data:" — anything with a scheme is off-site.
    if (preg_match('#^[A-Za-z][A-Za-z0-9+.\-]*:#', $candidate) === 1) {
        return '';
    }

    return $candidate;
}

/** The path (with query) the current request was aiming at, if it is safe to keep. */
function trax_current_next(): string
{
    return trax_safe_next($_SERVER['REQUEST_URI'] ?? '');
}

/**
 * The gate every authenticated entry point opens with.
 *
 * $mode decides what a refusal looks like, because the two callers cannot use
 * each other's: a browser needs a redirect it can follow, and api.php's client
 * needs JSON it can read — an HTML redirect there would surface as a parse
 * error with no clue what went wrong.
 *
 * In external mode the include is the gate: it either lets the request through
 * or ends it itself. Everything below the include is the case where it did
 * neither, which is a misconfiguration and not something to paper over.
 *
 * @param string $mode 'html' for a page, 'api' for a JSON endpoint.
 */
function trax_require_login(string $mode = 'html'): void
{
    $isApi = $mode === 'api';

    if (!trax_is_installed()) {
        if ($isApi) {
            http_response_code(503);
            header('Content-Type: application/json; charset=utf-8');
            header('X-Content-Type-Options: nosniff');
            header('Cache-Control: no-store');
            echo json_encode(['ok' => false, 'code' => 'install-required']);
            exit;
        }

        http_response_code(302);
        header('Location: install.php');
        exit;
    }

    if (trax_auth_mode() === 'external') {
        trax_external_auth_run();

        if (trax_external_identity() !== '') {
            return;
        }

        // The include returned without signing anyone in and without ending the
        // request. Sending the visitor to login.php here would be a loop —
        // login.php bounces straight back in external mode — so this says what
        // happened instead.
        if ($isApi) {
            http_response_code(401);
            header('Content-Type: application/json; charset=utf-8');
            header('X-Content-Type-Options: nosniff');
            header('Cache-Control: no-store');
            echo json_encode(['ok' => false, 'code' => 'unauthenticated']);
            exit;
        }

        http_response_code(403);
        header('Content-Type: text/html; charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: no-store');
        header('X-Robots-Tag: noindex, nofollow');
        echo "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
            . "<meta name=\"robots\" content=\"noindex, nofollow\">"
            . "<title>Not signed in</title></head><body>"
            . "<h1>External auth did not sign you in</h1>"
            . "<p>This installation hands sign-in to an external include, and that"
            . " include let the request through without setting an identity in the"
            . " session.</p>"
            . "<p>Fix it in <code>lib/config.local.php</code>: correct"
            . " <code>TRAX_AUTH_INCLUDE</code>, or delete the"
            . " <code>TRAX_AUTH_MODE</code> line to return to the built-in login.</p>"
            . "</body></html>\n";
        exit;
    }

    if (trax_current_user() !== null) {
        return;
    }

    if ($isApi) {
        http_response_code(401);
        header('Content-Type: application/json; charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: no-store');
        echo json_encode(['ok' => false, 'code' => 'unauthenticated']);
        exit;
    }

    $next = trax_current_next();
    http_response_code(302);
    header('Location: login.php' . ($next !== '' ? '?next=' . rawurlencode($next) : ''));
    exit;
}

/** Best-effort identity of the logged-in operator, for the audit trail. */
function trax_actor(): string
{
    trax_ensure_session();

    $user = trax_current_user();
    if ($user !== null && $user['username'] !== '') {
        return substr($user['username'], 0, 120);
    }

    foreach (['trax_user', 'username', 'user', 'email', 'login', 'user_name'] as $key) {
        if (!empty($_SESSION[$key]) && is_string($_SESSION[$key])) {
            return substr($_SESSION[$key], 0, 120);
        }
    }

    // Some login systems nest the identity one level down.
    if (!empty($_SESSION['user']) && is_array($_SESSION['user'])) {
        foreach (['name', 'email', 'username'] as $key) {
            if (!empty($_SESSION['user'][$key]) && is_string($_SESSION['user'][$key])) {
                return substr($_SESSION['user'][$key], 0, 120);
            }
        }
    }

    return '';
}
