<?php
/**
 * Session start for the unauthenticated public pages.
 *
 * index.php and captcha.php need a session for the captcha code and nothing
 * else. They must NOT load lib/auth.php to get one: that file runs
 * `require_once TRAX_AUTH_INCLUDE` at global scope whenever the install is in
 * external-auth mode (lib/auth.php, "External-auth bootstrap"), and a host-wide
 * check_auth.php redirects an unauthenticated visitor to the login page. That
 * would put the printed QR label — and the captcha image it needs — behind a
 * login, which is the one thing the public page must never do.
 *
 * So this is a deliberate, standalone twin of trax_ensure_session(): same
 * cookie flags, same strict mode, no auth. Keep the two in step.
 */

declare(strict_types=1);

/** Starts the session if nothing has started one yet. */
function trax_public_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    // The cookie is never read by JavaScript and never needed on a cross-site
    // navigation, so it is closed down as far as it goes. Secure only when the
    // request actually arrived over TLS — setting it unconditionally would drop
    // the cookie on a plain-HTTP dev server and make the captcha unsolvable.
    $https = (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

    session_start([
        'cookie_httponly' => true,
        'cookie_samesite' => 'Lax',
        'cookie_secure'   => $https,
        'use_strict_mode' => true,
    ]);
}
