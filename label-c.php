<?php
/**
 * TRAX Cable Flag Label PNG endpoint
 *
 * Physical format:
 * 90 x 14 mm — three 30 mm thirds of one strip:
 *
 *   +----------------+----------------+----------------+
 *   |  front (label  |  wraps the     |  back (label   |
 *   |  top → centre) |  cable   |     |  top → centre) |
 *   +----------------+----------------+----------------+
 *        30 mm             30 mm            30 mm
 *
 * The middle goes round the cable and the two ends are stuck back to back,
 * so the strip becomes a flag readable from both sides. Each end is the
 * portrait label (14 x 30 mm) exactly as label.php draws it, turned so that
 * its top faces the cable; the back is the front turned by 180 degrees, which
 * is what makes both faces read the right way up once folded.
 *
 * The middle third is blank apart from a thin centre mark, to line the strip
 * up on the cable.
 *
 * Takes the same ?id=<n>&u=<unit> as label.php, at the same render scale.
 */

declare(strict_types=1);

// label.php renders the portrait label and hands the image back instead of
// answering. Everything it sets up — config, scale, the lookup of $id and
// $unitNo — is in this scope afterwards.
define('TRAX_LABEL_EMBED', true);

require __DIR__ . '/label.php';

$portrait = $GLOBALS['traxLabelImage'] ?? null;

while (ob_get_level() > 0) {
    ob_end_clean();
}

// label.php has already logged the failure and set the status.
if (!$portrait instanceof GdImage) {
    if (http_response_code() === 200) {
        http_response_code(500);
    }
    exit;
}

$side  = imagesx($portrait);   // 14 mm
$third = imagesy($portrait);   // 30 mm

$strip = imagecreatetruecolor($third * 3, $side);
$white = imagecolorallocate($strip, 255, 255, 255);
imagefilledrectangle($strip, 0, 0, $third * 3 - 1, $side - 1, $white);

// imagerotate() turns counter-clockwise: 270 puts the label's top on the
// right (towards the cable), 90 puts it on the left (towards the cable).
$front = imagerotate($portrait, 270, $white);
$back  = imagerotate($portrait, 90, $white);

imagecopy($strip, $front, 0, 0, 0, 0, $third, $side);
imagecopy($strip, $back, $third * 2, 0, 0, 0, $third, $side);

// The centre mark: one thin black line across the strip, halfway along, to
// lay against the cable so both ends come out the same length. 0.25 mm at
// any render scale ($side is 14 mm).
$black  = imagecolorallocate($strip, 0, 0, 0);
$stroke = max(1, (int)round($side * 0.25 / 14));
$centre = intdiv($third * 3, 2);
imagefilledrectangle(
    $strip,
    $centre - intdiv($stroke, 2),
    0,
    $centre - intdiv($stroke, 2) + $stroke - 1,
    $side - 1,
    $black
);

imagedestroy($front);
imagedestroy($back);
imagedestroy($portrait);

$code = $unitNo !== null ? $id . '.' . $unitNo : (string)$id;

http_response_code(200);
header('Content-Type: image/png');
header('Cache-Control: no-cache, no-store, must-revalidate');
header('X-Robots-Tag: noindex, nofollow');
header('Content-Disposition: inline; filename="label-cable-' . $code . '.png"');

imagepng($strip);
imagedestroy($strip);
