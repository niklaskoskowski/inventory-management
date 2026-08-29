<?php
/**
 * The document proxy — the only way to read anything out of documents/.
 *
 * The directory itself is denied by its own .htaccess, so this file is not a
 * convenience wrapper around a public URL: it IS the access path. Everything
 * below is therefore written as if the regex were the only thing between a
 * stranger and data.json, and then a second, stronger check is applied anyway.
 *
 *   GET download.php?file=doc-<32 hex>.<ext>
 *
 * Three gates, in this order:
 *   1. The same auth gate as admin.php and api.php — no session, no bytes.
 *   2. A strict whitelist regex on the name. Not a blacklist of "../" and its
 *      encodings: the name may contain nothing but [0-9a-f], one dot and a
 *      known extension, which no traversal, absolute path, backslash, encoded
 *      separator or NUL byte can satisfy.
 *   3. The name must actually appear in some asset's `documents` in data.json.
 *      This is the guard that matters. Even a bypassed regex reaches only
 *      files this application deliberately wrote and still tracks; there is no
 *      arbitrary read behind it.
 *
 * The response is always an attachment. Nothing here ever renders inline.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/store.php';
require_once __DIR__ . '/lib/auth.php';
require_once __DIR__ . '/lib/documents.php';

// Gate one of three. The same one admin.php and api.php use — no session, no
// bytes. A browser following this link gets the login form, not a document.
trax_require_login('html');

/** A refusal says nothing about what does or does not exist on disk. */
function trax_download_fail(int $status, string $message): never
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    echo $message . "\n";
    exit;
}

$requested = $_GET['file'] ?? '';
if (!is_string($requested)) {
    trax_download_fail(400, 'Bad request.');
}

// Gate 2. trax_document_name() anchors with \z, so a trailing newline — which
// '$' would have allowed — is refused along with everything else. The identity
// comparison then insists on the canonical form: the normaliser trims and
// truncates, and a request that only becomes valid after being cleaned up is
// not a request this endpoint should be answering.
$file = trax_document_name($requested);
if ($file === null || $file !== $requested) {
    trax_download_fail(400, 'Bad request.');
}

// Gate 3. The reference check. A syntactically perfect name that no asset
// points at is not a document, however real it is on disk.
$data      = trax_read_data();
$reference = null;
foreach ($data['assets'] as $asset) {
    foreach ($asset['documents'] ?? [] as $doc) {
        if (($doc['file'] ?? '') === $file) {
            $reference = $doc;
            break 2;
        }
    }
}
if ($reference === null) {
    trax_download_fail(404, 'Not found.');
}

$path = TRAX_DOC_DIR . '/' . $file;
if (!is_file($path) || !is_readable($path)) {
    trax_download_fail(404, 'Not found.');
}

/**
 * Content-Disposition, per RFC 6266.
 *
 * `filename` may only carry ASCII, so non-ASCII names get an RFC 5987
 * `filename*` alongside it and every client that understands it prefers it.
 * The ASCII fallback keeps the rest readable rather than dropping the name.
 */
$display = trax_document_client_name($reference['name'] ?? '');
$ascii   = preg_replace('/[^\x20-\x7E]/', '_', $display) ?? 'document';
$ascii   = str_replace(['\\', '"'], '_', $ascii);
if (trim($ascii, '_ .') === '') {
    $ascii = 'document';
}

$disposition = 'attachment; filename="' . $ascii . '"';
if ($ascii !== $display) {
    $disposition .= "; filename*=UTF-8''" . rawurlencode($display);
}

// Serving from the type WE recorded on the extension WE chose, never from
// anything the client said. nosniff then stops a browser second-guessing it.
header('Content-Type: ' . trax_document_content_type($file));
header('X-Content-Type-Options: nosniff');
header('Content-Disposition: ' . $disposition);
header('Content-Length: ' . (string)filesize($path));
// The response is per-operator and behind a login: no shared cache may keep a
// copy, and no browser may leave one on disk for the next person at the desk.
header('Cache-Control: private, no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('Expires: 0');
// A receipt is not something another origin may frame or embed.
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');

// Nothing may be buffered here: these files can be megabytes.
while (ob_get_level() > 0) {
    ob_end_clean();
}
readfile($path);
