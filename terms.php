<?php
/**
 * Public terms & conditions.
 *
 *   GET terms.php          the version in force
 *   GET terms.php?v=<n>    one version by number
 *
 * The numbered form is what a signature links to: a hand-over records the
 * version the customer accepted, and that text has to stay readable after the
 * terms have moved on. An earlier version says so, and when it stopped
 * applying, above the text.
 *
 * Nothing here is private — terms are published to be read before anybody
 * signs — so there is no token, only the archive in data.json and the one
 * Markdown renderer (lib/markdown.php) that booking.php uses too.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/store.php';
require_once __DIR__ . '/lib/markdown.php';

header('X-Robots-Tag: noindex, nofollow');
header('X-Content-Type-Options: nosniff');

$appName    = (string)trax_setting('branding.appName', 'Assets');
$orgName    = (string)trax_setting('branding.orgName', '');
$brandColor = (string)trax_setting('branding.brandColor', '#1F2937');
$favicon    = (string)trax_setting('branding.faviconFile', '');

/** Short-hand for the escaping this file does on every interpolation. */
function pub_e(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}

/** The configured date format, or a dash. */
function terms_date(?string $iso): string
{
    $ts = $iso === null ? null : trax_parse_datetime($iso);
    return $ts === null ? '—' : trax_format_date($ts);
}

$data    = trax_read_data();
$current = trax_terms_current($data);

// Which version to show. A number that is not a positive integer is treated
// as no number at all rather than as an error: it is a link somebody typed.
$asked = trax_int($_GET['v'] ?? null);
$shown = $asked !== null && $asked > 0 ? trax_terms_version($data, $asked) : $current;
if ($shown !== null && $shown['text'] === '') {
    $shown = null;
}

// Superseded when a newer version exists; `until` is when that one arrived.
$until = null;
if ($shown !== null) {
    foreach ($data['terms']['versions'] as $entry) {
        if ($entry['version'] > $shown['version']) {
            $until = $entry['at'];
            break;
        }
    }
}

if ($shown === null) {
    http_response_code(404);
}

$heading = 'Terms & conditions' . ($orgName !== '' ? ' · ' . $orgName : '');
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Terms &amp; conditions – <?php echo pub_e($orgName !== '' ? $orgName : $appName); ?></title>
    <meta name="theme-color" content="<?php echo pub_e($brandColor); ?>">
    <meta name="robots" content="noindex, nofollow">
<?php if ($favicon !== ''): ?>
    <link rel="icon" type="image/png" href="<?php echo pub_e($favicon); ?>">
<?php endif; ?>
    <link rel="stylesheet" href="public.css">
    <style>:root{--trax-brand:<?php echo pub_e($brandColor); ?>;}</style>
</head>
<body class="pub-page">

<header class="pub-top">
    <div class="pub-top-inner pub-main-wide">
<?php if ($favicon !== ''): ?>
        <img class="pub-mark" src="<?php echo pub_e($favicon); ?>" alt="" width="26" height="26">
<?php endif; ?>
        <span class="pub-wordmark"><?php echo pub_e($appName); ?></span>
        <span class="pub-top-tag">Terms</span>
    </div>
</header>

<main class="pub-main pub-main-wide">
<?php if ($shown === null): ?>
    <p class="pub-empty">
        <?php echo $asked !== null ? 'There is no such version of the terms &amp; conditions.'
            : 'No terms &amp; conditions are published.'; ?>
    </p>
<?php else: ?>
    <section class="pub-card">
        <h1 class="pub-title"><?php echo pub_e($heading); ?></h1>
        <p class="pub-sub">
            <span>Version <?php echo pub_e((string)$shown['version']); ?></span>
            <span>published <?php echo pub_e(terms_date($shown['at'])); ?></span>
        </p>

    <?php if ($until !== null): ?>
        <p class="pub-terms-old">
            This is an earlier version. It applied until <?php echo pub_e(terms_date($until)); ?>.
            <?php if ($current !== null): ?>
                <a href="terms.php">Read the current version</a>.
            <?php endif; ?>
        </p>
    <?php endif; ?>

        <div class="pub-terms"><?php echo trax_markdown($shown['text']); ?></div>
    </section>
<?php endif; ?>
</main>

<footer class="pub-foot"><?php echo pub_e($orgName !== '' ? $orgName : $appName); ?></footer>

</body>
</html>
