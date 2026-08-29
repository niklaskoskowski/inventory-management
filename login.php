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

/** Escapes for HTML text and attributes. Mirrors the esc() idiom in booking.php / view.php. */
function esc(mixed $value): string
{
    return htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

header('Content-Type: text/html; charset=utf-8');
?>
<!DOCTYPE html>
<html lang="en" data-bs-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Sign in</title>
<link rel="stylesheet" href="vendor/bootstrap.min.css">
<link rel="stylesheet" href="public.css">
<style>
  /* The one thing this page takes from the install's settings. */
  :root { --trax-brand: <?php echo esc($brandColor); ?>; }
  .login-main { max-width: 380px; margin: 0 auto; padding: 3.5rem 1rem; }
  .login-card { padding: 1.25rem; }
  .login-title { margin: 0 0 1rem; font-size: 1.15rem; font-weight: 600; }
  .login-card .pub-btn { width: 100%; justify-content: center; margin-top: 1rem; }
  /* Not .pub-btn-primary: that one is the WhatsApp green, which belongs to the
     public "message us" button and says nothing about this install. */
  .login-btn { background: var(--trax-brand); color: var(--trax-brand-ink); }
</style>
</head>
<body>
<div class="pub-page">
  <main class="login-main">
    <div class="pub-card login-card">
      <h1 class="login-title">Sign in</h1>

      <?php if ($error !== ''): ?>
        <div class="pub-flash pub-flash-bad" role="alert"><?php echo esc($error); ?></div>
      <?php endif; ?>

      <form method="post" action="login.php" autocomplete="on">
        <input type="hidden" name="csrf" value="<?php echo esc($csrf); ?>">
        <input type="hidden" name="next" value="<?php echo esc($next); ?>">

        <label class="pub-field">
          <span class="pub-label">Username</span>
          <input class="pub-input" type="text" name="username" autocomplete="username"
                 value="<?php echo esc($username); ?>" required autofocus>
        </label>

        <label class="pub-field">
          <span class="pub-label">Password</span>
          <input class="pub-input" type="password" name="password"
                 autocomplete="current-password" required>
        </label>

        <button class="pub-btn login-btn" type="submit">Sign in</button>
      </form>
    </div>
  </main>
</div>
</body>
</html>
