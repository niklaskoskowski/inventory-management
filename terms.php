<?php
/**
 * Public terms & conditions.
 *
 *   GET terms.php          the version in force
 *   GET terms.php?v=<n>    one version by number
 *   GET terms.php?lang=de  in German (or en); without it the browser's
 *                          language decides, when the version has both
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
if (!trax_terms_has_text($shown)) {
    $shown = null;
}

// Which language: ?lang= when the version has it, else the browser's first
// choice (German when it starts with "de"), else whichever text exists.
$langs = $shown === null ? [] : trax_terms_languages($shown);
$lang  = strtolower((string)($_GET['lang'] ?? ''));
if (!in_array($lang, $langs, true)) {
    $browser = strtolower(substr((string)($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''), 0, 2));
    $lang    = in_array($browser, $langs, true) ? $browser : ($langs[0] ?? 'en');
}
$text = $shown === null ? '' : ($lang === 'de' ? $shown['textDe'] : $shown['text']);

/** The few words this page says itself, in the language shown. */
$t = $lang === 'de'
    ? ['heading' => 'Allgemeine Geschäftsbedingungen', 'version' => 'Version', 'earlier' => 'Frühere Version, gültig bis',
       'current' => 'Aktuelle Version', 'none' => 'Es sind keine AGB veröffentlicht.', 'nosuch' => 'Diese Version gibt es nicht.']
    : ['heading' => 'Terms & conditions', 'version' => 'Version', 'earlier' => 'Earlier version, valid until',
       'current' => 'Current version', 'none' => 'No terms are published.', 'nosuch' => 'No such version.'];

/** This page in another language, keeping the version asked for. */
function terms_lang_url(string $lang, ?int $version): string
{
    $query = ['lang' => $lang];
    if ($version !== null && $version > 0) {
        $query = ['v' => $version] + $query;
    }
    return 'terms.php?' . http_build_query($query);
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

$heading = $t['heading'];
?>
<!DOCTYPE html>
<html lang="<?php echo $lang === 'de' ? 'de' : 'en'; ?>">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <meta name="color-scheme" content="light dark">
    <title><?php echo pub_e($heading); ?> – <?php echo pub_e($orgName !== '' ? $orgName : $appName); ?></title>
    <meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
    <meta name="robots" content="noindex, nofollow">
<?php if ($favicon !== ''): ?>
    <link rel="icon" type="image/png" href="<?php echo pub_e($favicon); ?>">
<?php endif; ?>
    <link rel="stylesheet" href="<?php echo trax_public_css(); ?>">
    <link rel="stylesheet" href="vendor/bootstrap-icons.css">
    <style>:root{--trax-brand:<?php echo pub_e($brandColor); ?>;}</style>
    <?php echo trax_accent_style_tags(); ?>
</head>
<body class="pub-page">

<header class="pub-bar">
    <div class="pub-bar-inner">
        <?php echo trax_brand_header_html($appName, $favicon !== ''
            ? '<img class="pub-mark" src="' . pub_e($favicon) . '" alt="" width="26" height="26">'
            : ''); ?>
    </div>
</header>

<main class="pub-main">
<?php if ($shown === null): ?>
    <p class="pub-empty">
        <i class="bi bi-file-earmark-text" aria-hidden="true"></i>
        <?php echo pub_e($asked !== null ? $t['nosuch'] : $t['none']); ?>
    </p>
<?php else: ?>
    <section class="pub-card">
    <?php if (count($langs) > 1): ?>
        <nav class="pub-lang" aria-label="Language">
        <?php foreach (['en' => 'English', 'de' => 'Deutsch'] as $code => $name): ?>
            <a href="<?php echo pub_e(terms_lang_url($code, $asked)); ?>" hreflang="<?php echo $code; ?>"
               class="<?php echo $code === $lang ? 'is-active' : ''; ?>"
               <?php echo $code === $lang ? 'aria-current="true"' : ''; ?>><?php echo $name; ?></a>
        <?php endforeach; ?>
        </nav>
    <?php endif; ?>
        <h1 class="pub-title"><?php echo pub_e($heading); ?></h1>
        <p class="pub-sub">
<?php if ($orgName !== ''): ?>
            <span><?php echo pub_e($orgName); ?></span>
<?php endif; ?>
            <span><?php echo pub_e($t['version']); ?> <?php echo pub_e((string)$shown['version']); ?> · <?php echo pub_e(terms_date($shown['at'])); ?></span>
        </p>

    <?php if ($until !== null): ?>
        <p class="pub-flash pub-flash-warn pub-terms-old">
            <i class="bi bi-clock-history" aria-hidden="true"></i>
            <span><?php echo pub_e($t['earlier']); ?> <?php echo pub_e(terms_date($until)); ?>.
            <?php if ($current !== null): ?>
                <a href="<?php echo pub_e(terms_lang_url($lang, null)); ?>"><?php echo pub_e($t['current']); ?></a>
            <?php endif; ?></span>
        </p>
    <?php endif; ?>

        <div class="pub-terms" lang="<?php echo $lang; ?>"><?php echo trax_markdown($text); ?></div>
    </section>
<?php endif; ?>
</main>

<footer class="pub-foot"><?php echo pub_e($orgName !== '' ? $orgName : $appName); ?></footer>

</body>
</html>
