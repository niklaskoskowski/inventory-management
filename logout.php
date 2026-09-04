<?php
/**
 * Sign out.
 *
 *   POST logout.php  with a `csrf` field   (the form in the admin shell)
 *   GET  logout.php?t=<csrf token>         (a plain link)
 *
 * Both carry the token. A bare GET without one is refused rather than obeyed:
 * <img src="logout.php"> on any page on the internet would otherwise sign the
 * operator out mid-checkout. That is only a nuisance, not a breach — but it is
 * a nuisance that costs one comparison to remove.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/auth.php';

header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

trax_ensure_session();

$token = (string)((($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST')
    ? ($_POST['csrf'] ?? '')
    : ($_GET['t'] ?? ''));

if (!trax_csrf_verify($token)) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo "403 invalid or missing token\n";
    exit;
}

// Where to go afterwards, decided before the session is destroyed.
//
// In external mode the local session is only half the story: the host's own
// login is what actually holds the visitor, and only its logout endpoint can
// end that. TRAX_AUTH_LOGOUT_URL names it. Empty — or refused by the
// validator — means all this can do is drop what it owns and return to
// admin.php, which sends the visitor through the external gate again.
$external = trax_auth_mode() === 'external';
$dest     = 'login.php';

if ($external) {
    $configured = trax_safe_logout_url(defined('TRAX_AUTH_LOGOUT_URL') ? TRAX_AUTH_LOGOUT_URL : '');
    $dest       = $configured !== '' ? $configured : 'admin.php';
}

trax_logout();

http_response_code(302);
header('Location: ' . $dest);
exit;
