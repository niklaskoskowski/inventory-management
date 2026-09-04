<?php

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/auth.php';

// No session, no shell: an anonymous visitor is sent to the login form, and an
// instance with no operators yet is sent to the installer.
trax_require_login('html');

/**
 * Admin — application shell.
 *
 * This file used to be 1938 lines of PHP, HTML, jQuery and seven modals. All
 * behaviour now lives in the Vue app under app/; all data access goes through
 * api.php. What remains here is the auth gate above, the CSRF token, and the
 * markup needed to mount the app.
 *
 * The branding below is rendered server-side rather than left to the app: the
 * title, the icon and the boot placeholder are all on screen before main.js has
 * parsed, and a shell that flashes a generic name first would be worse than one
 * that never showed it.
 */

require_once __DIR__ . '/lib/store.php';

$csrf = trax_csrf_token();

$appName    = (string)trax_setting('branding.appName', 'Assets');
$brandColor = (string)trax_setting('branding.brandColor', '#1F2937');
$favicon    = (string)trax_setting('branding.faviconFile', '');

/** Short-hand for the escaping this file does on every interpolation. */
function admin_e(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}

/** Cache-buster: shared hosts cache .js hard and there is no build hash. */
function asset_version(string $relative): string
{
    $path = __DIR__ . '/' . $relative;
    return $relative . '?v=' . (is_file($path) ? (string)filemtime($path) : '0');
}
?>
<!DOCTYPE html>
<html lang="en" data-bs-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no, viewport-fit=cover">
    <title><?php echo admin_e($appName); ?></title>

    <meta name="csrf-token" content="<?php echo htmlspecialchars($csrf, ENT_QUOTES, 'UTF-8'); ?>">
    <meta name="public-path" content="<?php echo htmlspecialchars(TRAX_PUBLIC_PATH, ENT_QUOTES, 'UTF-8'); ?>">

    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-touch-fullscreen" content="yes">
    <meta name="apple-mobile-web-app-title" content="<?php echo admin_e($appName); ?>">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="<?php echo admin_e($brandColor); ?>">

<?php if ($favicon !== ''): ?>
    <link rel="apple-touch-icon" sizes="180x180" href="<?php echo admin_e($favicon); ?>">
    <link rel="icon" type="image/png" href="<?php echo admin_e($favicon); ?>">
<?php endif; ?>

    <!-- Vendored, not CDN: the folder must work as uploaded. -->
    <link rel="stylesheet" href="vendor/bootstrap.min.css">
    <link rel="stylesheet" href="vendor/bootstrap-icons.css">
    <link rel="stylesheet" href="<?php echo htmlspecialchars(asset_version('app/app.css'), ENT_QUOTES, 'UTF-8'); ?>">
</head>
<body>

<div id="app">
    <!-- Replaced on mount; shown while the module graph loads. -->
    <div class="trax-boot">
        <div class="trax-boot-mark"><?php echo admin_e($appName); ?></div>
        <div class="spinner-border spinner-border-sm text-secondary" role="status">
            <span class="visually-hidden">Loading…</span>
        </div>
        <noscript>
            <p class="text-danger mt-3"><?php echo admin_e($appName); ?> needs JavaScript enabled.</p>
        </noscript>
    </div>
</div>

<script type="importmap">
{
  "imports": {
    "vue": "./vendor/vue.esm-browser.prod.js"
  }
}
</script>

<!--
  iOS Safari has ignored user-scalable=no and maximum-scale since iOS 10, so the
  viewport meta above only binds Android. Refusing the gesture is the only way to
  stop pinch-zoom on iPhone. Focus-zoom is handled separately, by the 16px rule
  in app.css.
-->
<script>
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
</script>

<!--
  The QR decoder defines a global; it is not an ES module, so it cannot be
  imported by app/. Loading it here rather than letting ScanDrawer inject it
  keeps the 131KB off the critical path of opening the camera. The drawer still
  injects it as a fallback if this tag ever goes missing.

  This replaced vendor/qr.min.js (html5-qrcode + zxing), which nothing under
  app/ references any more. That file stays on disk: scandebug.html loads its
  own copy to compare the two decoders.
-->
<script src="vendor/jsqr.min.js"></script>

<script type="module" src="<?php echo htmlspecialchars(asset_version('app/main.js'), ENT_QUOTES, 'UTF-8'); ?>"></script>

</body>
</html>
