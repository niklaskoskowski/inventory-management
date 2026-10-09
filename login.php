<?php
/**
 * The sign-in page.
 *
 *   GET  login.php[?next=<relative path>]   the form
 *   POST login.php                          username + password + csrf
 *
 * There is nothing to configure here and nothing to link to: the page exists
 * only to turn a username and a password into a session. Before any operator
 * exists at all this file is not the right answer either — the installer is —
 * so an uninstalled instance is handed straight to install.php.
 *
 * The `next` parameter only ever survives trax_safe_next(), which refuses
 * anything that could leave this host. A login form that redirects wherever it
 * is told is a phishing kit with the operator's own domain on it.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/auth.php';
// For the brand colour only. The form itself needs nothing out of the store,
// but a sign-in page in someone else's colours is the first thing an operator
// sees of the install.
require_once __DIR__ . '/lib/store.php';

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

if (!trax_is_installed()) {
    http_response_code(302);
    header('Location: install.php');
    exit;
}

// External mode: this form is not the way in and must not pretend to be. The
// include runs on admin.php, so sending the visitor there is what starts the
// host's own sign-in. (When the include has gone missing trax_auth_mode()
// reports 'builtin' and the form below is served as usual — that is the way
// back in after a broken deploy.)
if (trax_auth_mode() === 'external') {
    http_response_code(302);
    header('Location: admin.php');
    exit;
}

trax_ensure_session();

$next = trax_safe_next($_POST['next'] ?? $_GET['next'] ?? '');
$dest = $next !== '' ? $next : 'admin.php';

/** Already signed in? Then this page has nothing to ask. */
if (trax_current_user() !== null && ($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(302);
    header('Location: ' . $dest);
    exit;
}

$error    = '';
$username = '';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $username = trim((string)($_POST['username'] ?? ''));
    $password = (string)($_POST['password'] ?? '');

    $wait = trax_login_lock_seconds();

    if (!trax_csrf_verify((string)($_POST['csrf'] ?? ''))) {
        // A stale form — the session expired while it sat open, or the token
        // was rotated by a login in another tab. Not an attack worth a lecture.
        $error = 'This form expired. Please try again.';
    } elseif ($wait > 0) {
        $error = 'Too many failed attempts. Please wait ' . $wait . ' seconds and try again.';
    } elseif ($username === '' || $password === '') {
        $error = 'Please enter your username and password.';
    } else {
        $user = trax_user_verify($username, $password);
        if ($user === null) {
            // One message for "no such user" and "wrong password" alike: the
            // form must not tell a stranger which usernames exist.
            trax_login_register_failure();
            $error = 'Wrong username or password.';
        } else {
            trax_login($user);
            http_response_code(302);
            header('Location: ' . $dest);
            exit;
        }
    }
}

// A refused login answers 200 with the form and the reason, not 401: some
// shared hosts run PHP behind mod_proxy_fcgi with ProxyErrorOverride on, which
// throws away the body of any 4xx and serves a generic error page instead —
// and an operator who mistypes their password would then see no form at all.

$csrf       = trax_csrf_token();
$brandColor = (string)trax_setting('branding.brandColor', '#1F2937');
// The app icon and name above the form; trax_logo_file() has already checked
// the favicon exists, so '' means "draw the brand tile instead".
$appName    = (string)trax_setting('branding.appName', 'Assets');
$favicon    = (string)trax_setting('branding.faviconFile', '');

/** Escapes for HTML text and attributes. Mirrors the esc() idiom in booking.php / view.php. */
function esc(mixed $value): string
{
    return htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

header('Content-Type: text/html; charset=utf-8');
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>Sign in · <?php echo esc($appName); ?></title>
<?php if ($favicon !== ''): ?>
<link rel="icon" type="image/png" href="<?php echo esc($favicon); ?>">
<?php endif; ?>
<link rel="stylesheet" href="public.css">
<link rel="stylesheet" href="vendor/bootstrap-icons.css">
<style>:root { --trax-brand: <?php echo esc($brandColor); ?>; }</style>
</head>
<body class="pub-page pub-solo">
  <main class="pub-solo-main">
    <div class="pub-card">
      <div class="pub-solo-head">
        <div class="pub-appicon" aria-hidden="true">
<?php if ($favicon !== ''): ?>
          <img src="<?php echo esc($favicon); ?>" alt="" width="64" height="64">
<?php else: ?>
          <i class="bi bi-box-seam"></i>
<?php endif; ?>
        </div>
        <h1 class="pub-solo-title">Sign in</h1>
        <p class="pub-solo-sub"><?php echo esc($appName); ?></p>
      </div>

      <?php if ($error !== ''): ?>
        <div class="pub-flash pub-flash-bad" role="alert">
          <i class="bi bi-exclamation-circle-fill" aria-hidden="true"></i>
          <span><?php echo esc($error); ?></span>
        </div>
      <?php endif; ?>

      <form method="post" action="login.php" autocomplete="on">
        <input type="hidden" name="csrf" value="<?php echo esc($csrf); ?>">
        <input type="hidden" name="next" value="<?php echo esc($next); ?>">

        <label class="pub-field">
          <span class="pub-label">Username</span>
          <input class="pub-input" type="text" name="username" autocomplete="username"
                 autocapitalize="none" spellcheck="false"
                 value="<?php echo esc($username); ?>" required autofocus>
        </label>

        <label class="pub-field">
          <span class="pub-label">Password</span>
          <input class="pub-input" type="password" name="password"
                 autocomplete="current-password" required>
        </label>

        <button class="pub-btn pub-btn-primary pub-solo-submit" type="submit">Sign in</button>
      </form>
    </div>
  </main>
</body>
</html>
