<?php
/**
 * Captcha image for the public "Report this item found" form (index.php).
 *
 * Self-hosted on purpose: the folder must work as uploaded, so nothing here
 * talks to a third-party captcha service. The answer lives in the session and
 * never reaches the client — the page only ever sees the pixels.
 *
 * One image, one code: index.php clears the session slot on every submit, so a
 * code is good for a single attempt and for ten minutes.
 *
 * Requested lazily (index.php sets the img src when the dialog opens), which is
 * what keeps a plain label scan from starting a session at all.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/public-session.php';

/**
 * No GD, no image. Answering with a broken PNG would leave the finder staring
 * at a field they cannot fill, so say what happened in plain text instead.
 */
if (!function_exists('imagecreatetruecolor') || !function_exists('imagepng')) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=UTF-8');
    echo "Captcha unavailable: PHP is missing the gd extension.\n";
    return;
}

/** No 0/O and no 1/I: a finder is reading this off a phone screen. */
const TRAX_CAPTCHA_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TRAX_CAPTCHA_LENGTH   = 5;

trax_public_session();

$code = '';
for ($i = 0; $i < TRAX_CAPTCHA_LENGTH; $i++) {
    $code .= TRAX_CAPTCHA_ALPHABET[random_int(0, strlen(TRAX_CAPTCHA_ALPHABET) - 1)];
}

$_SESSION['trax_captcha'] = ['code' => $code, 'at' => time()];

$width  = 200;
$height = 64;

$image = imagecreatetruecolor($width, $height);
imagefilledrectangle($image, 0, 0, $width, $height, imagecolorallocate($image, 244, 246, 248));

// Thin lines first, so they sit under the glyphs rather than across them.
$lines = random_int(3, 4);
for ($i = 0; $i < $lines; $i++) {
    $line = imagecolorallocate($image, random_int(150, 200), random_int(150, 200), random_int(160, 210));
    imageline(
        $image,
        random_int(0, 24),
        random_int(0, $height),
        random_int($width - 24, $width),
        random_int(0, $height),
        $line
    );
}

$font = TRAX_FONT_BOLD;
$ttf  = function_exists('imagettftext') && is_string($font) && is_file($font);

$slot = intdiv($width - 24, TRAX_CAPTCHA_LENGTH);
for ($i = 0; $i < TRAX_CAPTCHA_LENGTH; $i++) {
    // Dark enough to read on the light plate, different per character.
    $ink  = imagecolorallocate($image, random_int(20, 70), random_int(20, 70), random_int(50, 110));
    $size = random_int(24, 30);
    $x    = 14 + ($i * $slot) + random_int(-2, 2);
    $y    = intdiv($height + $size, 2) + random_int(-5, 5);

    if ($ttf) {
        imagettftext($image, (float)$size, (float)random_int(-20, 20), $x, $y, $ink, $font, $code[$i]);
        continue;
    }

    // Same fallback label.php keeps: a bitmap font, no rotation, still readable.
    imagestring($image, 5, $x, max(0, $y - 22), $code[$i], $ink);
}

// Dots last: speckle over the glyphs is what a naive threshold trips on.
for ($i = 0; $i < 60; $i++) {
    $dot = imagecolorallocate($image, random_int(80, 180), random_int(80, 180), random_int(90, 190));
    imagesetpixel($image, random_int(0, $width - 1), random_int(0, $height - 1), $dot);
}

header('Content-Type: image/png');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('Pragma: no-cache');

imagepng($image);
imagedestroy($image);
