<?php
/**
 * Attached documents — manuals, receipts, insurance certificates.
 *
 * Deliberately not lib/photo.php. Every photo is decoded and re-encoded by GD,
 * so the bytes that reach uploads/ are ours and the original upload is thrown
 * away. A PDF cannot be laundered like that: the file we store IS the file the
 * operator handed us. Two consequences run through this whole file —
 *
 *   1. The bytes live in TRAX_DOC_DIR, which the web server denies outright
 *      (documents/.htaccess). download.php, behind the same auth gate as the
 *      rest of the admin, is the only reader.
 *   2. Nothing about the client's filename is trusted. The type is sniffed,
 *      the extension is derived from the sniffed type, and the stored name is
 *      doc-<32 hex> — 128 bits, unguessable, the same reasoning as a condition
 *      photo's name even though the proxy already gates access.
 */

declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/store.php';
// For trax_upload_error_message() and trax_photo_batch_entries(): the $_FILES
// shapes and the UPLOAD_ERR_* wording are not photo-specific, and a second copy
// of either would be a second thing to keep in step.
require_once __DIR__ . '/photo.php';

/**
 * The deny rules written into a documents/ directory that has none.
 *
 * Only a fallback: the shipped documents/.htaccess is copied when it can be
 * found. A directory created on a fresh deploy — or in a test sandbox — must
 * not be reachable just because the .htaccess was not uploaded with it.
 */
const TRAX_DOC_HTACCESS = <<<'HTACCESS'
# Attached documents. Nothing in here is web-readable — see download.php.

php_flag engine off

<IfModule mod_authz_core.c>
    Require all denied
</IfModule>

<IfModule !mod_authz_core.c>
    Order allow,deny
    Deny from all
</IfModule>

Options -Indexes -ExecCGI
HTACCESS;

/** Creates TRAX_DOC_DIR if needed, always with the deny rules beside the files. */
function trax_ensure_document_dir(): void
{
    if (!is_dir(TRAX_DOC_DIR) && !@mkdir(TRAX_DOC_DIR, 0755, true)) {
        throw new TraxInvalid('The documents directory is not writable.');
    }

    $guard = TRAX_DOC_DIR . '/.htaccess';
    if (is_file($guard)) {
        return;
    }
    // Prefer the file that ships with the repo, so there is one source of truth
    // for the rules; fall back to the copy above when it is not there.
    $shipped = __DIR__ . '/../documents/.htaccess';
    if (is_file($shipped) && realpath($shipped) !== realpath($guard)) {
        @copy($shipped, $guard);
    }
    if (!is_file($guard)) {
        @file_put_contents($guard, TRAX_DOC_HTACCESS . "\n");
    }
}

/** The extension we store a sniffed type under, or null if it is not allowed. */
function trax_document_ext(string $mime): ?string
{
    return TRAX_DOCUMENT_TYPES[strtolower($mime)] ?? null;
}

/** What a stored document is served as. Keyed off OUR extension, not a record. */
function trax_document_content_type(string $file): string
{
    $ext  = strtolower((string)pathinfo($file, PATHINFO_EXTENSION));
    $mime = array_search($ext, TRAX_DOCUMENT_TYPES, true);
    if ($mime === false) {
        return 'application/octet-stream';
    }

    return $mime === 'text/plain' ? 'text/plain; charset=utf-8' : $mime;
}

/** A stored name: 128 bits of randomness, carrying no asset or customer id. */
function trax_new_document_name(string $ext): string
{
    return 'doc-' . bin2hex(random_bytes(16)) . '.' . $ext;
}

/** Removes a stored document. Unknown or unsafe names are ignored. */
function trax_delete_document_file(string $file): void
{
    $safe = trax_document_name($file);
    if ($safe === null) {
        return;
    }
    @unlink(TRAX_DOC_DIR . '/' . $safe);
}

/**
 * The third opinion on what a file is.
 *
 * finfo is magic-based itself, so this rarely disagrees with it — that is the
 * point. It is here so that a single wrong answer from libmagic (or a build
 * without it) cannot on its own decide that an executable is a PDF.
 */
function trax_document_magic_matches(string $path, string $mime): bool
{
    $handle = @fopen($path, 'rb');
    if ($handle === false) {
        return false;
    }
    $head = (string)fread($handle, 16);
    fclose($handle);

    switch ($mime) {
        case 'application/pdf':
            return str_starts_with($head, '%PDF-');
        case 'image/jpeg':
            return str_starts_with($head, "\xFF\xD8\xFF");
        case 'image/png':
            return str_starts_with($head, "\x89PNG\r\n\x1A\n");
        case 'image/webp':
            return str_starts_with($head, 'RIFF') && substr($head, 8, 4) === 'WEBP';
        case 'text/plain':
            // Text has no magic number, so the check is what text is NOT: no
            // NUL bytes anywhere, and decodable as UTF-8. A file that fails
            // either is a binary that libmagic guessed at.
            $bytes = (string)@file_get_contents($path);
            return !str_contains($bytes, "\0") && mb_check_encoding($bytes, 'UTF-8');
        default:
            return false;
    }
}

/**
 * The name shown in the UI and sent in Content-Disposition.
 *
 * The stored extension wins: a file the operator called "manual.pdf" whose
 * bytes are a PNG is stored, and downloaded, as a PNG — so the name must not
 * keep claiming otherwise.
 */
function trax_document_display_name(mixed $clientName, string $ext): string
{
    $name = trax_document_client_name($clientName);
    if (strtolower((string)pathinfo($name, PATHINFO_EXTENSION)) === $ext) {
        return $name;
    }

    return mb_substr($name, 0, 150) . '.' . $ext;
}

/**
 * Validates and stores one uploaded document.
 *
 * @param  array  $file  One entry from $_FILES
 * @param  string $title Operator's label for the batch, optional
 * @return array  The record to append to the asset's `documents`
 * @throws TraxInvalid on anything the server will not accept
 */
function trax_store_document(array $file, string $title = ''): array
{
    $error = (int)($file['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($error !== UPLOAD_ERR_OK) {
        throw new TraxInvalid(trax_upload_error_message($error));
    }

    $tmp = (string)($file['tmp_name'] ?? '');
    if ($tmp === '' || !is_uploaded_file($tmp)) {
        throw new TraxInvalid('The upload could not be verified.');
    }

    $size = (int)@filesize($tmp);
    if ($size <= 0) {
        throw new TraxInvalid('That file is empty.');
    }
    if ($size > TRAX_MAX_DOCUMENT_BYTES) {
        throw new TraxInvalid(
            'Documents must be ' . (int)(TRAX_MAX_DOCUMENT_BYTES / 1024 / 1024) . ' MB or smaller.'
        );
    }

    // Sniffed, not claimed. $_FILES['type'] comes from the browser and the
    // extension comes from whoever named the file; neither is consulted.
    $finfo = @finfo_open(FILEINFO_MIME_TYPE);
    $mime  = $finfo !== false ? (string)@finfo_file($finfo, $tmp) : '';
    if ($finfo !== false) {
        finfo_close($finfo);
    }
    $mime = strtolower(trim(explode(';', $mime)[0]));

    $ext = trax_document_ext($mime);
    if ($ext === null) {
        throw new TraxInvalid(
            'Documents must be PDF, JPEG, PNG, WebP or plain text — that file is ' . ($mime ?: 'unrecognised') . '.'
        );
    }
    if (!trax_document_magic_matches($tmp, $mime)) {
        throw new TraxInvalid('That file\'s contents do not match its type.');
    }

    trax_ensure_document_dir();

    $stored = trax_new_document_name($ext);
    $target = TRAX_DOC_DIR . '/' . $stored;
    if (!@move_uploaded_file($tmp, $target)) {
        throw new TraxInvalid('The document could not be saved.');
    }
    @chmod($target, 0644);

    return [
        'file'    => $stored,
        'name'    => trax_document_display_name($file['name'] ?? '', $ext),
        'title'   => trax_str($title, TRAX_MAX_NAME),
        'size'    => $size,
        'mime'    => $mime,
        'addedAt' => gmdate('Y-m-d\TH:i:s.000\Z'),
    ];
}

/**
 * Stores a whole batch of documents, or none of them.
 *
 * The moment one file is refused, everything this call has already written is
 * removed again: a half-stored batch leaves bytes on disk that no record points
 * at, and nothing in this codebase ever sweeps for orphans.
 *
 * @param  array  $files One $_FILES entry, in either shape
 * @param  string $title Operator's label, applied to every file in the batch
 * @return array  One record per file, in upload order
 * @throws TraxInvalid on anything the server will not accept
 */
function trax_store_documents(array $files, string $title = ''): array
{
    $entries = trax_photo_batch_entries($files);
    if ($entries === []) {
        throw new TraxInvalid('No file was uploaded.');
    }
    if (count($entries) > TRAX_MAX_DOCS_PER_BATCH) {
        throw new TraxInvalid('Up to ' . TRAX_MAX_DOCS_PER_BATCH . ' documents can be uploaded at once.');
    }

    $stored = [];
    try {
        foreach ($entries as $entry) {
            $stored[] = trax_store_document($entry, $title);
        }
    } catch (Throwable $e) {
        foreach ($stored as $doc) {
            trax_delete_document_file((string)$doc['file']);
        }
        throw $e;
    }

    return $stored;
}
