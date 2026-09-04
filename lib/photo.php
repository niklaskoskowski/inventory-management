<?php
/**
 * Asset photo handling — plain GD, no composer.
 *
 * The uploaded bytes are never kept. Everything is decoded and re-encoded
 * through GD, which strips EXIF (including GPS coordinates) and neutralises
 * any payload smuggled inside an otherwise-valid image.
 */

declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/store.php';

/** Pixel budget. A 25000x25000 PNG is a one-request OOM on shared hosting. */
const TRAX_MAX_PIXELS = 40_000_000;

function trax_upload_error_message(int $code): string
{
    return match ($code) {
        UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'The file is larger than the server allows.',
        UPLOAD_ERR_PARTIAL                        => 'The upload was interrupted. Try again.',
        UPLOAD_ERR_NO_FILE                        => 'No file was uploaded.',
        UPLOAD_ERR_NO_TMP_DIR                     => 'The server has no temporary directory configured.',
        UPLOAD_ERR_CANT_WRITE                     => 'The server could not write the file to disk.',
        UPLOAD_ERR_EXTENSION                      => 'A server extension blocked the upload.',
        default                                   => 'The upload failed.',
    };
}

/**
 * Validates, re-encodes and stores an uploaded photo plus its thumbnail.
 *
 * @param  array $file One entry from $_FILES
 * @return string The stored filename, relative to uploads/
 * @throws TraxInvalid on anything the server will not accept
 */
function trax_store_photo(int $assetId, array $file): string
{
    // Server-generated name only — the client never influences the path.
    return trax_store_photo_as($assetId . '-' . bin2hex(random_bytes(4)) . '.jpg', $file);
}

/**
 * The validation-and-write chain itself, under a caller-chosen (still
 * server-generated) filename. Split out of trax_store_photo() so a batch can
 * run the identical checks without a second copy of them existing.
 *
 * @param  string $filename Basename only; the caller owns the naming policy.
 * @return string The stored filename, relative to uploads/
 * @throws TraxInvalid on anything the server will not accept
 */
function trax_store_photo_as(string $filename, array $file): string
{
    // Both callers generate the name themselves. Checked anyway, because this
    // is the one string in here that becomes a path: a future caller passing
    // something client-derived must not be able to write outside uploads/.
    if (trax_photo_name($filename) !== $filename) {
        throw new TraxInvalid('The server generated an unusable filename.');
    }

    $error = (int)($file['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($error !== UPLOAD_ERR_OK) {
        throw new TraxInvalid(trax_upload_error_message($error));
    }

    $tmp = (string)($file['tmp_name'] ?? '');
    if ($tmp === '' || !is_uploaded_file($tmp)) {
        throw new TraxInvalid('The upload could not be verified.');
    }

    if ((int)($file['size'] ?? 0) > TRAX_MAX_UPLOAD_BYTES) {
        throw new TraxInvalid('Images must be ' . (TRAX_MAX_UPLOAD_BYTES / 1024 / 1024) . ' MB or smaller.');
    }

    // Sniff the real type. The client filename and its extension are ignored.
    $info = @getimagesize($tmp);
    if ($info === false) {
        throw new TraxInvalid('That file is not a readable image.');
    }

    [$width, $height] = $info;
    $mime = $info['mime'] ?? '';

    if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)) {
        throw new TraxInvalid('Photos must be JPEG, PNG or WebP.');
    }
    if ($width < 1 || $height < 1 || $width * $height > TRAX_MAX_PIXELS) {
        throw new TraxInvalid('That image has too many pixels to process.');
    }

    $source = match ($mime) {
        'image/jpeg' => @imagecreatefromjpeg($tmp),
        'image/png'  => @imagecreatefrompng($tmp),
        'image/webp' => @imagecreatefromwebp($tmp),
        default      => false,
    };
    if ($source === false) {
        throw new TraxInvalid('That image could not be decoded.');
    }

    // Phone photos carry their rotation in EXIF, which re-encoding discards —
    // so apply it first, or portrait shots come out sideways.
    if ($mime === 'image/jpeg' && function_exists('exif_read_data')) {
        $exif        = @exif_read_data($tmp);
        $orientation = (int)($exif['Orientation'] ?? 0);
        $rotation    = match ($orientation) {
            3       => 180,
            6       => -90,
            8       => 90,
            default => 0,
        };
        if ($rotation !== 0) {
            $rotated = @imagerotate($source, $rotation, 0);
            if ($rotated !== false) {
                $source = $rotated;
            }
        }
    }

    if (!is_dir(TRAX_UPLOAD_DIR) && !@mkdir(TRAX_UPLOAD_DIR, 0755, true)) {
        throw new TraxInvalid('The uploads directory is not writable.');
    }
    $thumbDir = TRAX_UPLOAD_DIR . '/thumb';
    if (!is_dir($thumbDir) && !@mkdir($thumbDir, 0755, true)) {
        throw new TraxInvalid('The uploads directory is not writable.');
    }

    trax_write_scaled_jpeg($source, TRAX_UPLOAD_DIR . '/' . $filename, TRAX_PHOTO_MAX_EDGE, 82);
    trax_write_scaled_jpeg($source, $thumbDir . '/' . $filename, TRAX_THUMB_MAX_EDGE, 78);

    return $filename;
}

/**
 * A name for a condition photo.
 *
 * Deliberately carries NO id. An asset photo is named after its asset, which is
 * a public number on a QR label — fine for a picture of the gear, not for a
 * picture of one customer's handling of it. uploads/ is served without auth, so
 * the name is the only thing standing between a stranger and the file: 128 bits
 * of randomness, unrelated to the booking, the asset, or the customer.
 */
function trax_new_condition_photo_name(): string
{
    return 'd-' . bin2hex(random_bytes(16)) . '.jpg';
}

/** Removes a stored photo and its thumbnail. Unknown or unsafe names are ignored. */
function trax_delete_photo_files(string $filename): void
{
    $safe = trax_photo_name($filename);
    if ($safe === null) {
        return;
    }
    @unlink(TRAX_UPLOAD_DIR . '/' . $safe);
    @unlink(TRAX_UPLOAD_DIR . '/thumb/' . $safe);
}

/**
 * Turns one $_FILES entry into a list of single-file entries.
 *
 * With `photos[]` in the form, PHP hands over ONE entry whose name/tmp_name/
 * error/size are themselves arrays — not a list of entries. Both shapes are
 * accepted so a single `photos` field still works.
 *
 * Slots the browser sent empty (UPLOAD_ERR_NO_FILE with no filename) are
 * dropped rather than failing the batch: an unfilled file input is not an
 * error, and an empty batch is reported separately by the caller.
 */
function trax_photo_batch_entries(array $files): array
{
    if (!is_array($files['name'] ?? null)) {
        $files = [$files];
    } else {
        $count   = count($files['name']);
        $entries = [];
        for ($i = 0; $i < $count; $i++) {
            $entries[] = [
                'name'     => $files['name'][$i] ?? '',
                'type'     => $files['type'][$i] ?? '',
                'tmp_name' => $files['tmp_name'][$i] ?? '',
                'error'    => $files['error'][$i] ?? UPLOAD_ERR_NO_FILE,
                'size'     => $files['size'][$i] ?? 0,
            ];
        }
        $files = $entries;
    }

    $out = [];
    foreach ($files as $entry) {
        if (!is_array($entry)) {
            continue;
        }
        $empty = (int)($entry['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE
            && trim((string)($entry['name'] ?? '')) === '';
        if (!$empty) {
            $out[] = $entry;
        }
    }
    return $out;
}

/**
 * Stores a whole batch of condition photos, or none of them.
 *
 * Every file runs the same chain as a single upload. The moment one is refused,
 * everything this call has already written is removed again — a half-stored
 * batch would leave the caller with files it cannot record and nobody can find.
 *
 * @param  array $files One $_FILES entry, in either shape
 * @return string[] The stored filenames, relative to uploads/
 * @throws TraxInvalid on anything the server will not accept
 */
function trax_store_photos(array $files): array
{
    $entries = trax_photo_batch_entries($files);
    if ($entries === []) {
        throw new TraxInvalid('No file was uploaded.');
    }
    if (count($entries) > TRAX_MAX_PHOTOS_PER_BATCH) {
        throw new TraxInvalid('Up to ' . TRAX_MAX_PHOTOS_PER_BATCH . ' photos can be uploaded at once.');
    }

    $stored = [];
    try {
        foreach ($entries as $entry) {
            // Recorded before the write, so a file that fails halfway through
            // (full image written, thumbnail refused) is cleaned up as well.
            $name     = trax_new_condition_photo_name();
            $stored[] = $name;
            trax_store_photo_as($name, $entry);
        }
    } catch (Throwable $e) {
        foreach ($stored as $name) {
            trax_delete_photo_files($name);
        }
        throw $e;
    }

    return $stored;
}

/** Scales an image so its long edge is at most $maxEdge, then writes JPEG. */
function trax_write_scaled_jpeg(GdImage $source, string $path, int $maxEdge, int $quality): void
{
    $width  = imagesx($source);
    $height = imagesy($source);
    $scale  = min(1.0, $maxEdge / max($width, $height));

    $targetWidth  = max(1, (int)round($width * $scale));
    $targetHeight = max(1, (int)round($height * $scale));

    $canvas = imagecreatetruecolor($targetWidth, $targetHeight);
    if ($canvas === false) {
        throw new TraxInvalid('The server ran out of memory processing that image.');
    }

    // JPEG has no alpha, so flatten transparency onto white rather than black.
    $white = imagecolorallocate($canvas, 255, 255, 255);
    imagefilledrectangle($canvas, 0, 0, $targetWidth, $targetHeight, $white);
    imagecopyresampled($canvas, $source, 0, 0, 0, 0, $targetWidth, $targetHeight, $width, $height);

    if (!imagejpeg($canvas, $path, $quality)) {
        throw new TraxInvalid('The processed image could not be saved.');
    }
    @chmod($path, 0644);
}

/*
 * Note: there are deliberately no imagedestroy() calls here. It has been a
 * no-op since PHP 8.0 (GdImage is garbage collected) and is deprecated in 8.5,
 * where the notice would be printed straight into the JSON response body and
 * corrupt it. GD memory is reclaimed when the objects go out of scope.
 */
