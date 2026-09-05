<?php
/**
 * TRAX Landscape Label PNG endpoint
 *
 * Physical format:
 * 30 x 14 mm by default, overridable through ?w=<mm>&h=<mm> so a roll of a
 * different width can be tried without editing anything.
 *
 * Render scale:
 * 1x = ~300 DPI
 * 3x = ~900 DPI
 *
 * The physical layout stays identical at either scale — every measurement in
 * here is a millimetre or a fraction of the plate, never a hard pixel count.
 *
 * Layout (landscape):
 *
 *   +--------------------------------------------+
 *   | [QR]  logo  ORGANISATION                   |
 *   |       ------------------------------------ |
 *   |       Asset name, auto-sized                |
 *   |       [ID 12] category · location          |
 *   +--------------------------------------------+
 *
 * This file deliberately duplicates the small helpers of label-w.php instead
 * of including it: label-w.php renders and exits, so requiring it would print
 * the wide label rather than lend its functions.
 */

@ini_set('display_errors', '0');
@ini_set('log_errors', '1');
error_reporting(E_ALL);

ob_start();


/*
|--------------------------------------------------------------------------
| MODE
|--------------------------------------------------------------------------
*/

$mode = 'prod'; // prod | dev | test

$testLogoFallback = true;

$testId       = 123;
$testName     = 'MacBook Pro 16" 2021';
$testCategory = 'Hardware';
$testLocation = 'Lager A';

$testLogo = __DIR__ . '/logo.png';

$isTestMode = in_array($mode, ['dev', 'test'], true);


/*
|--------------------------------------------------------------------------
| RENDER SCALE DEFAULT
|--------------------------------------------------------------------------
|
| 1 = ~300 DPI
| 3 = ~900 DPI
|
| Production can override this through:
|
|     label.renderScale
|
*/

$defaultRenderScale = 3;

$renderScale = $defaultRenderScale;


/*
|--------------------------------------------------------------------------
| Pixel scaling helpers
|--------------------------------------------------------------------------
*/

/** Scale a base 300-DPI pixel value. */
function lp(float $value): int
{
    global $renderScale;

    return (int)round($value * $renderScale);
}

/** Scale font sizes while retaining decimals. */
function lf(float $value): float
{
    global $renderScale;

    return $value * $renderScale;
}

/**
 * Millimetres to output pixels.
 *
 * The whole layout is expressed through this, which is why the same code
 * draws a 30x14 and an 80x40 sticker without a second set of constants.
 */
function lmm(float $millimetres): int
{
    return lp($millimetres * 300.0 / 25.4);
}


/*
|--------------------------------------------------------------------------
| Error image
|--------------------------------------------------------------------------
*/

function landscape_label_error_png(Throwable $e): void
{
    global $isTestMode;

    error_log(
        '[TRAX LANDSCAPE LABEL] ' . get_class($e) . ': ' . $e->getMessage()
        . ' in ' . $e->getFile() . ':' . $e->getLine()
    );

    header('X-Robots-Tag: noindex, nofollow');

    if (!$isTestMode) {
        if (ob_get_length() !== false) {
            ob_end_clean();
        }
        http_response_code(500);
        return;
    }

    if (!function_exists('imagecreatetruecolor')) {
        if (ob_get_length() !== false) {
            ob_end_clean();
        }
        http_response_code(500);
        header('Content-Type: text/plain; charset=UTF-8');
        echo $e->getMessage();
        return;
    }

    $image = imagecreatetruecolor(700, 220);
    $white = imagecolorallocate($image, 255, 255, 255);
    $black = imagecolorallocate($image, 0, 0, 0);

    imagefilledrectangle($image, 0, 0, 699, 219, $white);

    $lines = [
        'TRAX LANDSCAPE LABEL ERROR',
        '',
        get_class($e),
        $e->getMessage(),
        '',
        basename($e->getFile()) . ':' . $e->getLine(),
    ];

    $y = 15;

    foreach ($lines as $line) {

        $parts = str_split($line, 90);

        if (!$parts) {
            $parts = [''];
        }

        foreach ($parts as $part) {
            imagestring($image, 3, 10, $y, $part, $black);
            $y += 18;
        }
    }

    if (ob_get_length() !== false) {
        ob_end_clean();
    }

    http_response_code(200);
    header('Content-Type: image/png');
    header('Cache-Control: no-cache, no-store, must-revalidate');

    imagepng($image);

    @imagedestroy($image);
}


/*
|--------------------------------------------------------------------------
| Setting helper
|--------------------------------------------------------------------------
*/

function landscape_label_setting(string $key, mixed $default = null): mixed
{
    if (function_exists('trax_setting')) {
        return trax_setting($key, $default);
    }

    return $default;
}


/*
|--------------------------------------------------------------------------
| Font helper
|--------------------------------------------------------------------------
|
| 'bold'    — the name, the heading, the chip
| 'regular' — the muted footer strip and the ID line under the QR
|
| Null means the TTF cannot be used and GD's built-in face has to do; every
| text helper below answers for that case, so a host with no FreeType still
| prints a (crude) label rather than a broken image.
*/

function landscape_label_font(string $type = 'bold'): ?string
{
    if (function_exists('trax_label_font')) {

        if ($type === 'heavy' && defined('TRAX_FONT_HEAVY')) {
            return trax_label_font(TRAX_FONT_HEAVY);
        }

        if ($type === 'regular') {
            $regular = __DIR__ . '/fonts/LiberationSans-Regular.ttf';
            $resolved = trax_label_font($regular);
            if ($resolved !== null) {
                return $resolved;
            }
        }

        if (defined('TRAX_FONT_BOLD')) {
            return trax_label_font(TRAX_FONT_BOLD);
        }
    }

    $candidates = $type === 'regular'
        ? [__DIR__ . '/fonts/LiberationSans-Regular.ttf']
        : [__DIR__ . '/fonts/LiberationSans-Bold.ttf'];

    if ($type === 'heavy') {
        array_unshift($candidates, __DIR__ . '/Arial_Black.ttf');
    }

    $candidates[] = __DIR__ . '/Arial_Bold.ttf';

    foreach ($candidates as $candidate) {
        if (is_file($candidate) && function_exists('imagettftext')) {
            return $candidate;
        }
    }

    return null;
}


/*
|--------------------------------------------------------------------------
| Text measuring / drawing
|--------------------------------------------------------------------------
*/

function landscape_label_text_width(?string $font, float $fontSize, string $text): int
{
    if (function_exists('trax_label_text_width')) {
        return (int)trax_label_text_width($font, $fontSize, $text);
    }

    if ($font !== null && is_file($font) && function_exists('imagettfbbox')) {

        $box = imagettfbbox($fontSize, 0, $font, $text);

        if ($box !== false) {
            return (int)($box[2] - $box[0]);
        }
    }

    return (int)(strlen($text) * max(7, $fontSize * 0.45));
}


/** Draws $text with its baseline at $y — imagettftext()'s convention. */
function landscape_label_text($image, ?string $font, float $fontSize, int $x, int $y, int $color, string $text): void
{
    if (function_exists('trax_label_text')) {
        trax_label_text($image, $font, $fontSize, $x, $y, $color, $text);
        return;
    }

    if ($font !== null && is_file($font) && function_exists('imagettftext')) {
        imagettftext($image, $fontSize, 0, $x, $y, $color, $font, $text);
        return;
    }

    imagestring($image, 5, $x, max(0, $y - lp(15)), $text, $color);
}


/**
 * Ascent, descent and line height for one font size, in output pixels.
 *
 * Measured off a string carrying an umlaut and a descender so that a name
 * like "Sommer Kabeltrommel äöü" cannot poke out of the row that was sized
 * for it. Falls back to a flat ratio when FreeType is unavailable.
 *
 * @return array{ascent:int, descent:int, line:int}
 */
function landscape_label_metrics(?string $font, float $fontSize): array
{
    if ($font !== null && is_file($font) && function_exists('imagettfbbox')) {

        $box = imagettfbbox($fontSize, 0, $font, 'ÄHXgjqy');

        if ($box !== false) {

            $ascent  = (int)ceil(-min($box[5], $box[7]));
            $descent = (int)ceil(max($box[1], $box[3]));

            if ($ascent > 0) {
                return [
                    'ascent'  => $ascent,
                    'descent' => max(0, $descent),
                    'line'    => (int)ceil(($ascent + max(0, $descent)) * 1.16),
                ];
            }
        }
    }

    return [
        'ascent'  => (int)ceil($fontSize * 0.80),
        'descent' => (int)ceil($fontSize * 0.22),
        'line'    => (int)ceil($fontSize * 1.22),
    ];
}


/*
|--------------------------------------------------------------------------
| Word wrap
|--------------------------------------------------------------------------
*/

/** mb_substr() where the extension exists, substr() where it does not. */
function landscape_label_substr(string $text, int $start, ?int $length = null): string
{
    if (function_exists('mb_substr')) {
        return mb_substr($text, $start, $length, 'UTF-8');
    }

    return $length === null ? substr($text, $start) : substr($text, $start, $length);
}


function landscape_label_strlen(string $text): int
{
    return function_exists('mb_strlen') ? mb_strlen($text, 'UTF-8') : strlen($text);
}


/**
 * Greedy word wrap. A single word wider than the column is hard-broken rather
 * than allowed to run off the plate — a part number is exactly the kind of
 * "word" that has no space to break at.
 *
 * $allowBreak = false refuses instead and returns an empty array, which is how
 * the fitter asks "does this fit without cutting a word in half?". Shrinking
 * "Akkuschrauber" to one line beats printing "Akkuschrau" over "ber".
 *
 * @return string[]  empty when $allowBreak is false and a word does not fit
 */
function landscape_label_wrap_text(
    string $text,
    ?string $font,
    float $fontSize,
    int $maxWidth,
    bool $allowBreak = true
): array {
    $maxWidth = max(1, $maxWidth);

    $words = preg_split('/\s+/u', trim($text));

    if (!is_array($words)) {
        return [$text];
    }

    $lines   = [];
    $current = '';

    foreach ($words as $word) {

        if ($word === '') {
            continue;
        }

        $test = $current === '' ? $word : $current . ' ' . $word;

        if (landscape_label_text_width($font, $fontSize, $test) <= $maxWidth) {
            $current = $test;
            continue;
        }

        if ($current !== '') {
            $lines[] = $current;
            $current = '';
        }

        if (landscape_label_text_width($font, $fontSize, $word) <= $maxWidth) {
            $current = $word;
            continue;
        }

        if (!$allowBreak) {
            return [];
        }

        /* Hard-break an overlong word. */
        while ($word !== '') {

            $length = landscape_label_strlen($word);
            $found  = false;

            for ($i = $length; $i > 0; $i--) {

                $part = landscape_label_substr($word, 0, $i);

                if (landscape_label_text_width($font, $fontSize, $part) > $maxWidth) {
                    continue;
                }

                if ($i === $length) {
                    $current = $part;
                    $word    = '';
                } else {
                    $lines[] = $part;
                    $word    = landscape_label_substr($word, $i);
                }

                $found = true;
                break;
            }

            if (!$found) {
                /* Not even one character fits; take it anyway and stop. */
                $current = $word;
                $word    = '';
                break;
            }
        }
    }

    if ($current !== '') {
        $lines[] = $current;
    }

    return $lines === [] ? [''] : $lines;
}


/** Shortens $text with an ellipsis until it fits $maxWidth. */
function landscape_label_ellipsize(string $text, ?string $font, float $fontSize, int $maxWidth): string
{
    if (landscape_label_text_width($font, $fontSize, $text) <= $maxWidth) {
        return $text;
    }

    $dots = $font !== null ? '…' : '...';

    for ($i = landscape_label_strlen($text) - 1; $i > 0; $i--) {

        $candidate = rtrim(landscape_label_substr($text, 0, $i)) . $dots;

        if (landscape_label_text_width($font, $fontSize, $candidate) <= $maxWidth) {
            return $candidate;
        }
    }

    return $dots;
}


/*
|--------------------------------------------------------------------------
| Auto sizing
|--------------------------------------------------------------------------
*/

/**
 * The largest font size at which $text wraps into at most $maxLines lines and
 * fits inside $maxW x $maxH, found by binary search.
 *
 * This is what makes a two-word asset name print large and a sixty-character
 * one print small without either being clipped — the box is fixed by the
 * tape, so the type has to move.
 *
 * When even $minSize does not fit, the wrap at $minSize is truncated to
 * $maxLines and the last line ellipsised: something legible always comes out.
 *
 * @return array{0: float, 1: string[]}  [size, lines]
 */
function landscape_label_fit_text(
    string $text,
    ?string $font,
    int $maxW,
    int $maxH,
    int $maxLines,
    float $minSize,
    float $maxSize
): array {

    $text     = trim($text);
    $maxW     = max(1, $maxW);
    $maxH     = max(1, $maxH);
    $maxLines = max(1, $maxLines);

    if ($text === '') {
        return [$minSize, []];
    }

    if ($maxSize < $minSize) {
        $maxSize = $minSize;
    }

    $attempt = static function (float $size, bool $allowBreak) use ($text, $font, $maxW, $maxH, $maxLines): ?array {

        $lines = landscape_label_wrap_text($text, $font, $size, $maxW, $allowBreak);

        if ($lines === [] || count($lines) > $maxLines) {
            return null;
        }

        $metrics = landscape_label_metrics($font, $size);

        if ($metrics['line'] * count($lines) > $maxH) {
            return null;
        }

        foreach ($lines as $line) {
            if (landscape_label_text_width($font, $size, $line) > $maxW) {
                return null;
            }
        }

        return $lines;
    };

    $search = static function (bool $allowBreak) use ($attempt, $minSize, $maxSize): ?array {

        $lines = $attempt($maxSize, $allowBreak);

        if ($lines !== null) {
            return [$maxSize, $lines];
        }

        $best = $attempt($minSize, $allowBreak);

        if ($best === null) {
            return null;
        }

        $low  = $minSize;
        $high = $maxSize;
        $size = $minSize;

        for ($i = 0; $i < 20 && ($high - $low) > 0.1; $i++) {

            $mid   = ($low + $high) / 2.0;
            $lines = $attempt($mid, $allowBreak);

            if ($lines !== null) {
                $best = $lines;
                $size = $mid;
                $low  = $mid;
            } else {
                $high = $mid;
            }
        }

        return [$size, $best];
    };

    /* Whole words first; cutting one in half is the last resort. */
    $result = $search(false) ?? $search(true);

    if ($result !== null) {
        return $result;
    }

    /*
     * Nothing fits even at $minSize: print what does and say so. The ellipsis
     * is forced rather than left to landscape_label_ellipsize(), because a
     * dropped LINE leaves the kept one narrow enough to "fit" — that is how a
     * name silently lost its last two words.
     */

    $wrapped = landscape_label_wrap_text($text, $font, $minSize, $maxW);

    $heightLimit = max(1, (int)floor($maxH / max(1, landscape_label_metrics($font, $minSize)['line'])));

    $lines = array_slice($wrapped, 0, min($maxLines, $heightLimit));

    $last = count($lines) - 1;

    if ($last >= 0) {

        $line = $lines[$last];

        if (count($lines) < count($wrapped)) {
            $line .= $font !== null ? '…' : '...';
        }

        $lines[$last] = landscape_label_ellipsize($line, $font, $minSize, $maxW);
    }

    return [$minSize, $lines];
}


/**
 * Draws already-wrapped lines, vertically centred between $top and $bottom.
 *
 * $align is 'left' or 'center' within [$x, $x + $maxW).
 */
function landscape_label_draw_lines(
    $image,
    ?string $font,
    float $fontSize,
    array $lines,
    int $x,
    int $maxW,
    int $top,
    int $bottom,
    int $color,
    string $align = 'left'
): void {

    if ($lines === []) {
        return;
    }

    $metrics = landscape_label_metrics($font, $fontSize);

    $blockHeight = $metrics['line'] * count($lines);

    /* Centre the ink, not the leading: the last line's descent is not text. */
    $startTop = $top + (int)round((($bottom - $top + 1) - $blockHeight) / 2);

    foreach (array_values($lines) as $index => $line) {

        if ($line === '') {
            continue;
        }

        $baseline = $startTop + $metrics['ascent'] + ($index * $metrics['line']);

        $lineX = $x;

        if ($align === 'center') {
            $lineWidth = landscape_label_text_width($font, $fontSize, $line);
            $lineX     = $x + (int)round(($maxW - $lineWidth) / 2);
        }

        landscape_label_text($image, $font, $fontSize, $lineX, $baseline, $color, $line);
    }
}


/*
|--------------------------------------------------------------------------
| Tracked (monospace-ish) text
|--------------------------------------------------------------------------
|
| The ID under the QR is a code, not prose. Spacing it out is what makes it
| read as one — and it is the cheapest way to get a technical look out of the
| one font family that ships with TRAX.
*/

function landscape_label_tracked_width(?string $font, float $fontSize, string $text, int $tracking): int
{
    $count = landscape_label_strlen($text);

    if ($count === 0) {
        return 0;
    }

    $width = 0;

    for ($i = 0; $i < $count; $i++) {
        $width += landscape_label_text_width($font, $fontSize, landscape_label_substr($text, $i, 1));
    }

    return $width + $tracking * ($count - 1);
}


function landscape_label_tracked_text(
    $image,
    ?string $font,
    float $fontSize,
    int $x,
    int $y,
    int $color,
    string $text,
    int $tracking
): void {

    $count = landscape_label_strlen($text);

    for ($i = 0; $i < $count; $i++) {

        $char = landscape_label_substr($text, $i, 1);

        landscape_label_text($image, $font, $fontSize, $x, $y, $color, $char);

        $x += landscape_label_text_width($font, $fontSize, $char) + $tracking;
    }
}


/*
|--------------------------------------------------------------------------
| Rounded rectangle
|--------------------------------------------------------------------------
*/

function landscape_label_rounded_rect($image, int $x1, int $y1, int $x2, int $y2, int $radius, int $color): void
{
    if ($x2 < $x1 || $y2 < $y1) {
        return;
    }

    $maxRadius = (int)floor(min($x2 - $x1, $y2 - $y1) / 2);

    if ($radius > $maxRadius) {
        $radius = $maxRadius;
    }

    if ($radius <= 0) {
        imagefilledrectangle($image, $x1, $y1, $x2, $y2, $color);
        return;
    }

    imagefilledrectangle($image, $x1 + $radius, $y1, $x2 - $radius, $y2, $color);
    imagefilledrectangle($image, $x1, $y1 + $radius, $x2, $y2 - $radius, $color);

    $diameter = $radius * 2;

    imagefilledellipse($image, $x1 + $radius, $y1 + $radius, $diameter, $diameter, $color);
    imagefilledellipse($image, $x2 - $radius, $y1 + $radius, $diameter, $diameter, $color);
    imagefilledellipse($image, $x1 + $radius, $y2 - $radius, $diameter, $diameter, $color);
    imagefilledellipse($image, $x2 - $radius, $y2 - $radius, $diameter, $diameter, $color);
}


/*
|--------------------------------------------------------------------------
| MAIN
|--------------------------------------------------------------------------
*/

try {

    /*
    |--------------------------------------------------------------------------
    | QR library
    |--------------------------------------------------------------------------
    */

    $qrLibrary = __DIR__ . '/phpqrcode/qrlib.php';

    if (!is_file($qrLibrary)) {
        throw new RuntimeException('phpqrcode/qrlib.php not found.');
    }

    require_once $qrLibrary;


    /*
    |--------------------------------------------------------------------------
    | TRAX environment
    |--------------------------------------------------------------------------
    */

    $configFile = __DIR__ . '/lib/config.php';
    $storeFile  = __DIR__ . '/lib/store.php';

    $traxAvailable = is_file($configFile) && is_file($storeFile);

    if (!$traxAvailable && !$isTestMode) {
        throw new RuntimeException('TRAX config.php/store.php not found.');
    }

    if ($traxAvailable) {
        require_once $configFile;
        require_once $storeFile;
    }


    /*
    |--------------------------------------------------------------------------
    | RENDER SCALE SETTING
    |--------------------------------------------------------------------------
    */

    $configuredRenderScale = (int)landscape_label_setting('label.renderScale', $defaultRenderScale);

    /* Convenient testing: label-l.php?scale=3 — dev/test only. */
    if ($isTestMode && isset($_GET['scale'])) {
        $configuredRenderScale = (int)$_GET['scale'];
    }

    if (!in_array($configuredRenderScale, [1, 3], true)) {
        $configuredRenderScale = 1;
    }

    $renderScale = $configuredRenderScale;


    /*
    |--------------------------------------------------------------------------
    | INPUTS
    |--------------------------------------------------------------------------
    */

    $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;

    /*
     * ?u= names one physical unit of the asset ("12.1"). It is honoured only
     * once the unit is found on the record below; an unknown one falls back to
     * the product label rather than printing a code that resolves to nothing.
     */

    $inputUnit = filter_input(INPUT_GET, 'u', FILTER_VALIDATE_INT);

    $unitNo = ($inputUnit !== false && $inputUnit !== null && $inputUnit > 0)
        ? (int)$inputUnit
        : null;

    /*
     * Tape size. Bounded rather than free: below 20x10 mm the QR stops being
     * scannable, and above 80x40 mm this is not a label any more.
     */

    $widthMm  = 30.0;
    $heightMm = 14.0;

    if (isset($_GET['w']) && is_numeric($_GET['w'])) {
        $widthMm = min(80.0, max(20.0, (float)$_GET['w']));
    }

    if (isset($_GET['h']) && is_numeric($_GET['h'])) {
        $heightMm = min(40.0, max(10.0, (float)$_GET['h']));
    }

    $unitLabel        = '';
    $unitFound        = false;
    $unitOutOfService = false;

    $name     = '';
    $category = '';
    $location = '';


    /*
    |--------------------------------------------------------------------------
    | LOAD FROM TRAX STORE
    |--------------------------------------------------------------------------
    */

    if ($traxAvailable && function_exists('trax_read_data') && function_exists('trax_find_asset')) {

        $labelData = trax_read_data();

        if (is_array($labelData) && isset($labelData['assets']) && is_array($labelData['assets'])) {

            $labelAsset = trax_find_asset($labelData['assets'], $id);

            if (is_array($labelAsset)) {

                $name     = (string)($labelAsset['name'] ?? '');
                $category = (string)($labelAsset['category'] ?? '');
                $location = (string)($labelAsset['location'] ?? '');

                if (
                    $unitNo !== null
                    && function_exists('trax_asset_has_units')
                    && trax_asset_has_units($labelAsset)
                ) {

                    foreach ($labelAsset['units'] as $unitRow) {

                        if ((int)$unitRow['no'] !== $unitNo) {
                            continue;
                        }

                        $unitFound        = true;
                        $unitLabel        = (string)($unitRow['label'] ?? '');
                        $unitOutOfService = !empty($unitRow['outOfService']);

                        break;
                    }
                }
            }
        }
    }

    /*
     * No matching unit on a real record means no unit: fall back to the
     * product label rather than print a code that resolves to nothing.
     */

    if (!$unitFound) {
        $unitNo           = null;
        $unitLabel        = '';
        $unitOutOfService = false;
    }


    /*
    |--------------------------------------------------------------------------
    | DEV / TEST DATA
    |--------------------------------------------------------------------------
    */

    if ($isTestMode) {

        if ($id <= 0) {
            $id = $testId;
        }

        if (!empty($_GET['name'])) {
            $name = landscape_label_substr((string)$_GET['name'], 0, 200);
        }

        if ($name === '') {
            $name = $testName;
        }

        if ($category === '' && $location === '') {
            $category = $testCategory;
            $location = $testLocation;
        }
    }

    if ($name === '') {
        $name = 'Unknown';
    }

    /*
     * The unit's own label rides along after the name, as on the portrait
     * label — the landscape plate has no notes strip to put it in.
     */

    if ($unitLabel !== '') {
        $name = $name . ' – ' . $unitLabel;
    }


    /*
    |--------------------------------------------------------------------------
    | QR DATA
    |--------------------------------------------------------------------------
    */

    if (function_exists('trax_label_url')) {

        $qrLink = trax_label_url($id, $unitNo);

    } else {

        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $host   = $_SERVER['HTTP_HOST'] ?? 'localhost';

        $qrLink = $scheme . '://' . $host . '/?id=' . urlencode((string)$id)
            . ($unitNo !== null ? '&u=' . urlencode((string)$unitNo) : '');
    }


    /*
    |--------------------------------------------------------------------------
    | TEXTS
    |--------------------------------------------------------------------------
    */

    $idText = 'ID ' . (
        $unitNo !== null && function_exists('trax_unit_code')
            ? trax_unit_code($id, $unitNo)
            : (string)$id
    );

    $metaParts = [];

    if ($category !== '') {
        $metaParts[] = $category;
    }

    if ($unitOutOfService) {
        $metaParts[] = 'OUT OF SERVICE';
    }

    /*
     * The middot needs the TTF: GD's built-in face is Latin-1 and prints the
     * two UTF-8 bytes of "·" as mojibake.
     */

    $metaText = implode(
        landscape_label_font('regular') !== null ? ' · ' : ' - ',
        $metaParts
    );

    $headingText = (string)landscape_label_setting('branding.orgName', '');

    if ($headingText === '') {
        $headingText = (string)landscape_label_setting('branding.appName', 'Assets');
    }

    /* Small-caps-ish: one case, bold, tracked by the fitter's own spacing. */
    $headingText = function_exists('mb_strtoupper')
        ? mb_strtoupper($headingText, 'UTF-8')
        : strtoupper($headingText);


    /*
    |--------------------------------------------------------------------------
    | CANVAS
    |--------------------------------------------------------------------------
    */

    $width  = lmm($widthMm);
    $height = lmm($heightMm);

    $image = imagecreatetruecolor($width, $height);

    if ($image === false) {
        throw new RuntimeException('GD could not create label canvas.');
    }

    if (function_exists('imageresolution')) {
        @imageresolution($image, 300 * $renderScale, 300 * $renderScale);
    }

    $white = imagecolorallocate($image, 255, 255, 255);
    $ink   = imagecolorallocate($image, 0x0c, 0x0f, 0x12);
    $muted = imagecolorallocate($image, 0x5b, 0x64, 0x70);
    $hair  = imagecolorallocate($image, 0xc3, 0xc8, 0xce);

    $fontBold    = landscape_label_font('bold');
    $fontRegular = landscape_label_font('regular');


    /*
    |--------------------------------------------------------------------------
    | PLATE
    |--------------------------------------------------------------------------
    */

    imagefilledrectangle($image, 0, 0, $width - 1, $height - 1, $white);

    $borderWidth = max(1, lp(1));
    $plateRadius = lmm(1.0);

    landscape_label_rounded_rect($image, 0, 0, $width - 1, $height - 1, $plateRadius, $ink);

    landscape_label_rounded_rect(
        $image,
        $borderWidth,
        $borderWidth,
        $width - 1 - $borderWidth,
        $height - 1 - $borderWidth,
        max(0, $plateRadius - $borderWidth),
        $white
    );


    /*
    |--------------------------------------------------------------------------
    | GEOMETRY
    |--------------------------------------------------------------------------
    */

    $pad = lmm(1.0);

    $innerX1 = $borderWidth + $pad;
    $innerY1 = $borderWidth + $pad;
    $innerX2 = $width  - 1 - $borderWidth - $pad;
    $innerY2 = $height - 1 - $borderWidth - $pad;

    $innerW = max(1, $innerX2 - $innerX1 + 1);
    $innerH = max(1, $innerY2 - $innerY1 + 1);

    /*
     * The ID gets a line of its own under the QR only on a tape tall enough to
     * spare it; on a 14 mm one it lives in the footer chip alone.
     */

    $idLineHeight = $heightMm >= 18.0 ? lmm(2.4) : 0;

    $leftSide = $innerH - $idLineHeight;

    /* The square may never eat the text column. */
    $leftSide = min($leftSide, (int)round($innerW * 0.55));
    $leftSide = max(1, $leftSide);

    $quietZone = lmm(0.3);

    $qrSize = max(1, $leftSide - (2 * $quietZone));
    $qrX    = $innerX1 + $quietZone;
    $qrY    = $innerY1 + $quietZone;

    $columnGap = lmm(0.6);

    $rightX1 = $innerX1 + $leftSide + $columnGap;
    $rightX2 = $innerX2;
    $rightW  = max(1, $rightX2 - $rightX1 + 1);

    $headerH = max(1, (int)round($innerH * 0.18));
    $footerH = max(1, (int)round($innerH * 0.22));
    $nameH   = max(1, $innerH - $headerH - $footerH);

    $headerTop = $innerY1;
    $nameTop   = $innerY1 + $headerH;
    $footerTop = $nameTop + $nameH;


    /*
    |--------------------------------------------------------------------------
    | QR CODE
    |--------------------------------------------------------------------------
    */

    $qrTemp = tempnam(sys_get_temp_dir(), 'qr_');

    if ($qrTemp === false) {
        throw new RuntimeException('Could not create QR temporary file.');
    }

    QRcode::png($qrLink, $qrTemp, QR_ECLEVEL_L, 2 * $renderScale, 1);

    $qrImg = @imagecreatefrompng($qrTemp);

    if ($qrImg === false) {
        @unlink($qrTemp);
        throw new RuntimeException('Generated QR code could not be read as PNG.');
    }

    imagecopyresampled(
        $image,
        $qrImg,
        $qrX,
        $qrY,
        0,
        0,
        $qrSize,
        $qrSize,
        imagesx($qrImg),
        imagesy($qrImg)
    );

    @imagedestroy($qrImg);
    @unlink($qrTemp);


    /*
    |--------------------------------------------------------------------------
    | ID LINE UNDER THE QR
    |--------------------------------------------------------------------------
    */

    if ($idLineHeight > 0) {

        $idLineTop    = $innerY1 + $leftSide;
        $idLineBottom = $idLineTop + $idLineHeight - 1;

        [$idLineSize] = landscape_label_fit_text(
            $idText,
            $fontRegular,
            $leftSide,
            (int)round($idLineHeight * 0.9),
            1,
            lf(5.0),
            lf(11.0)
        );

        $tracking = max(1, (int)round($idLineSize * 0.09));

        /* Shrink until the tracked width fits too — tracking adds real width. */
        while (
            $idLineSize > lf(5.0)
            && landscape_label_tracked_width($fontRegular, $idLineSize, $idText, $tracking) > $leftSide
        ) {
            $idLineSize -= lf(0.5);
            $tracking = max(1, (int)round($idLineSize * 0.09));
        }

        $idMetrics = landscape_label_metrics($fontRegular, $idLineSize);

        $idWidth = landscape_label_tracked_width($fontRegular, $idLineSize, $idText, $tracking);

        $idX = $innerX1 + (int)round(($leftSide - $idWidth) / 2);

        $idBaseline = $idLineTop
            + (int)round((($idLineBottom - $idLineTop + 1) - $idMetrics['line']) / 2)
            + $idMetrics['ascent'];

        landscape_label_tracked_text(
            $image,
            $fontRegular,
            $idLineSize,
            $idX,
            $idBaseline,
            $muted,
            $idText,
            $tracking
        );
    }


    /*
    |--------------------------------------------------------------------------
    | HEADER: LOGO + ORGANISATION
    |--------------------------------------------------------------------------
    |
    | Primary:
    |     branding.logoFile
    |
    | Dev/test fallback:
    |     ./logo.png
    */

    $logo = null;

    $configuredLogo = (string)landscape_label_setting('branding.logoFile', '');

    if ($configuredLogo !== '' && function_exists('trax_label_logo_image')) {

        $candidate = trax_label_logo_image($configuredLogo);

        if ($candidate !== null && $candidate !== false) {
            $logo = $candidate;
        }
    }

    if ($logo === null && $isTestMode && $testLogoFallback && is_file($testLogo)) {

        $candidate = @imagecreatefrompng($testLogo);

        if ($candidate !== false) {
            $logo = $candidate;
        }
    }

    $headingX = $rightX1;

    if ($logo !== null) {

        $srcLogoW = imagesx($logo);
        $srcLogoH = imagesy($logo);

        if ($srcLogoW > 0 && $srcLogoH > 0) {

            $logoH = max(1, $headerH - max(1, lp(1)));
            $logoW = max(1, (int)round($srcLogoW * ($logoH / $srcLogoH)));

            /* A wide wordmark must still leave room for the organisation. */
            $maxLogoW = max(1, (int)round($rightW * 0.42));

            if ($logoW > $maxLogoW) {
                $logoW = $maxLogoW;
                $logoH = max(1, (int)round($srcLogoH * ($logoW / $srcLogoW)));
            }

            $logoY = $headerTop + (int)round(($headerH - $logoH) / 2);

            imagecopyresampled(
                $image,
                $logo,
                $rightX1,
                $logoY,
                0,
                0,
                $logoW,
                $logoH,
                $srcLogoW,
                $srcLogoH
            );

            $headingX = $rightX1 + $logoW + lmm(0.8);
            $headingText = '';
        }

        @imagedestroy($logo);
    }

    $headingW = $rightX2 - $headingX + 1;

    if ($headingText !== '' && $headingW > lmm(1.0)) {

        [$headingSize, $headingLines] = landscape_label_fit_text(
            $headingText,
            $fontBold,
            $headingW,
            (int)round($headerH * 0.86),
            1,
            lf(4.5),
            lf(14.0)
        );

        landscape_label_draw_lines(
            $image,
            $fontBold,
            $headingSize,
            $headingLines,
            $headingX,
            $headingW,
            $headerTop,
            $headerTop + $headerH - 1,
            $ink
        );
    }

    /* Separator under the header row. */
    $ruleHeight = max(1, lp(0.7));
    $ruleY      = $headerTop + $headerH - $ruleHeight;

    imagefilledrectangle($image, $rightX1, $ruleY, $rightX2, $ruleY + $ruleHeight - 1, $ink);


    /*
    |--------------------------------------------------------------------------
    | NAME
    |--------------------------------------------------------------------------
    */

    $nameGap = min(lmm(0.5), (int)round($nameH * 0.12));

    $nameBoxTop    = $nameTop + $nameGap;
    $nameBoxBottom = $nameTop + $nameH - 1 - $nameGap;
    $nameBoxH      = max(1, $nameBoxBottom - $nameBoxTop + 1);

    /*
     * How many lines the row can carry at a readable size. Measured against
     * the line height of a 11 unit face — the smallest size still worth
     * setting a name in — so a short row gets one big line instead of three
     * unreadable ones.
     */

    $referenceLine = max(1, landscape_label_metrics($fontBold, lf(11.0))['line']);

    $nameLines = 3;

    if ($nameBoxH < 2 * $referenceLine) {
        $nameLines = 1;
    } elseif ($nameBoxH < 3 * $referenceLine) {
        $nameLines = 2;
    }

    /*
     * Prefer the fewest lines: a name that fits on one line at a readable
     * size stays on one line even if two lines would allow a bigger face.
     * Only when a single line would drop below the comfortable floor does
     * the layout allow another line.
     */
    $nameMin      = lf(6.0);
    $nameMax      = lf(21.0);
    $nameComfort  = lf(12.0);
    $nameSize     = $nameMin;
    $nameWrapped  = [];
    $nameFallback = null;

    for ($tryLines = 1; $tryLines <= $nameLines; $tryLines++) {
        [$trySize, $tryWrapped] = landscape_label_fit_text(
            $name,
            $fontBold,
            $rightW,
            $nameBoxH,
            $tryLines,
            $nameMin,
            $nameMax
        );

        if ($nameFallback === null || $trySize > $nameFallback[0]) {
            $nameFallback = [$trySize, $tryWrapped];
        }

        if ($trySize >= $nameComfort && count($tryWrapped) <= $tryLines) {
            $nameSize    = $trySize;
            $nameWrapped = $tryWrapped;
            break;
        }
    }

    if ($nameWrapped === [] && $nameFallback !== null) {
        [$nameSize, $nameWrapped] = $nameFallback;
    }

    landscape_label_draw_lines(
        $image,
        $fontBold,
        $nameSize,
        $nameWrapped,
        $rightX1,
        $rightW,
        $nameBoxTop,
        $nameBoxBottom,
        $ink
    );


    /*
    |--------------------------------------------------------------------------
    | FOOTER: ID CHIP + META
    |--------------------------------------------------------------------------
    */

    $chipPadX = lmm(0.7);

    $chipMaxTextW = max(1, (int)round($rightW * 0.5) - (2 * $chipPadX));

    [$chipSize, $chipLines] = landscape_label_fit_text(
        $idText,
        $fontBold,
        $chipMaxTextW,
        (int)round($footerH * 0.56),
        1,
        lf(4.0),
        lf(13.0)
    );

    /*
     * The chip is sized around its own text, not around the row: on a 25 mm
     * tape the row is tall enough that a full-height chip came out a circle.
     */

    $chipH = max(
        1,
        min(
            (int)round($footerH * 0.86),
            (int)round(landscape_label_metrics($fontBold, $chipSize)['line'] * 1.75)
        )
    );

    $chipY = $footerTop + (int)round(($footerH - $chipH) / 2);

    $chipLabel = $chipLines[0] ?? $idText;

    $chipTextW = landscape_label_text_width($fontBold, $chipSize, $chipLabel);

    $chipW = min($rightW, $chipTextW + (2 * $chipPadX));

    landscape_label_rounded_rect(
        $image,
        $rightX1,
        $chipY,
        $rightX1 + $chipW - 1,
        $chipY + $chipH - 1,
        (int)floor($chipH / 2),
        $ink
    );

    landscape_label_draw_lines(
        $image,
        $fontBold,
        $chipSize,
        [$chipLabel],
        $rightX1,
        $chipW,
        $chipY,
        $chipY + $chipH - 1,
        $white,
        'center'
    );

    $metaX = $rightX1 + $chipW + lmm(0.4);
    $metaW = $rightX2 - $metaX + 1;

    if ($metaText !== '' && $metaW > lmm(1.5)) {

        [$metaSize, $metaLines] = landscape_label_fit_text(
            $metaText,
            $fontRegular,
            $metaW,
            (int)round($footerH * 0.8),
            1,
            lf(4.0),
            lf(9.5)
        );

        $metaLine = $metaLines[0] ?? '';

        $metaLine = landscape_label_ellipsize($metaLine, $fontRegular, $metaSize, $metaW);

        landscape_label_draw_lines(
            $image,
            $fontRegular,
            $metaSize,
            [$metaLine],
            $metaX,
            $metaW,
            $chipY,
            $chipY + $chipH - 1,
            $muted
        );
    }


    /*
    |--------------------------------------------------------------------------
    | OUTPUT
    |--------------------------------------------------------------------------
    */

    if (ob_get_length() !== false) {
        ob_end_clean();
    }

    http_response_code(200);

    header('Content-Type: image/png');
    header('Cache-Control: no-cache, no-store, must-revalidate');
    header('X-Robots-Tag: noindex, nofollow');

    /* Handy for checking what the server produced. */
    header('X-TRAX-Render-Scale: ' . $renderScale);

    imagepng($image);

    @imagedestroy($image);

} catch (Throwable $e) {

    landscape_label_error_png($e);
}
