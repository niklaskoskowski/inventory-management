<?php
/**
 * The network label printer: a Brother PT-P750W behind the pt750w-print-trax
 * bridge (a small HTTP service on a Raspberry Pi next to the printer, usually
 * reached through a Cloudflare Tunnel).
 *
 * The browser never talks to the bridge. It hands api.php the label PNG it
 * already shows as a preview, and api.php forwards it with the bridge token —
 * so the token stays on this server, and no CORS is involved.
 *
 * Off by default (settings.printer.enabled). Only api.php loads this file.
 */

declare(strict_types=1);

final class TraxPrinterError extends RuntimeException
{
    public function __construct(string $message, public readonly string $bridgeCode = 'BRIDGE', public readonly int $status = 0)
    {
        parent::__construct($message);
    }
}

/** settings.printer as stored, normalised. */
function trax_printer_settings(?array $data = null): array
{
    $data ??= trax_read_data();
    return trax_normalize_settings($data['settings'] ?? null)['printer'];
}

/**
 * Physical size of a label format in mm, [width, height] as rendered — the
 * bridge lays a portrait label on its side by itself.
 */
function trax_printer_label_mm(string $format, array $settings): array
{
    return match ($format) {
        'portrait' => [14.0, 30.0],
        'cable'    => [60.0 + (float)($settings['labels']['cableGapMm'] ?? TRAX_CABLE_GAP_DEFAULT), 14.0],
        default    => [30.0, 14.0],
    };
}

/**
 * Checked BEFORE settings.update mutates anything, like the other patch
 * validators: a URL nobody can call is refused with the reason rather than
 * normalised to '' — the operator would otherwise find an empty field and a
 * printer that silently never prints.
 */
function trax_printer_patch_error(mixed $patch, array $current): ?string
{
    if (!is_array($patch)) {
        return null;
    }
    if (array_key_exists('bridgeUrl', $patch) && trax_printer_url($patch['bridgeUrl']) === null) {
        return 'Printer bridge URL: use http(s)://host[:port][/path], without user, query or fragment.';
    }
    foreach (['token' => 'Bridge token', 'accessClientId' => 'Access client ID', 'accessClientSecret' => 'Access client secret'] as $key => $label) {
        if (array_key_exists($key, $patch) && trax_str($patch[$key], 300) !== trax_printer_secret($patch[$key])) {
            return "{$label}: printable characters only, no spaces.";
        }
    }

    $merged = trax_normalize_printer(array_merge($current, $patch));
    if ($merged['enabled'] && $merged['bridgeUrl'] === '') {
        return 'Set the bridge URL before switching the printer on.';
    }
    if (($merged['accessClientId'] === '') !== ($merged['accessClientSecret'] === '')) {
        return 'The Cloudflare Access service token needs both the client ID and the secret.';
    }
    return null;
}

/**
 * One request to the bridge. Returns the decoded JSON of a successful answer
 * (`ok: true`); everything else becomes a TraxPrinterError whose message says
 * what to look at.
 */
function trax_printer_request(array $printer, string $method, string $path, ?array $json = null, int $timeout = TRAX_PRINTER_TIMEOUT): array
{
    if ($printer['bridgeUrl'] === '') {
        throw new TraxPrinterError('No print bridge URL is configured (Settings → Printer).', 'NOT_CONFIGURED');
    }

    $url     = $printer['bridgeUrl'] . $path;
    $headers = ['Accept: application/json', 'User-Agent: trax-inventory'];
    if ($printer['token'] !== '') {
        $headers[] = 'Authorization: Bearer ' . $printer['token'];
    }
    if ($printer['accessClientId'] !== '' && $printer['accessClientSecret'] !== '') {
        $headers[] = 'CF-Access-Client-Id: ' . $printer['accessClientId'];
        $headers[] = 'CF-Access-Client-Secret: ' . $printer['accessClientSecret'];
    }

    $body = null;
    if ($json !== null) {
        $body      = json_encode($json, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        $headers[] = 'Content-Type: application/json';
    }

    [$status, $raw, $transportError] = function_exists('curl_init')
        ? trax_printer_curl($method, $url, $headers, $body, $timeout)
        : trax_printer_stream($method, $url, $headers, $body, $timeout);

    if ($raw === null) {
        throw new TraxPrinterError(
            'Cannot reach the print bridge at ' . $printer['bridgeUrl'] . ': ' . $transportError,
            'UNREACHABLE'
        );
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        // Not the bridge talking: Cloudflare's error page, an Access login, a
        // proxy. Name the likely culprit.
        $hint = match (true) {
            $status >= 300 && $status < 400 => 'it redirected — Cloudflare Access wants a login. Add a service token below.',
            $status === 401, $status === 403 => 'access was refused — check the Cloudflare Access service token.',
            in_array($status, [502, 503, 504, 520, 521, 522, 523, 524, 530], true)
                => 'Cloudflare cannot reach the bridge — is the Pi up, the tunnel running, the origin http://…:8750?',
            default => 'is the URL the bridge, e.g. https://print.example.com?',
        };
        throw new TraxPrinterError("The print bridge answered HTTP {$status} without JSON: {$hint}", 'NOT_BRIDGE', $status);
    }

    if (($decoded['ok'] ?? false) !== true) {
        $code    = trax_str($decoded['error']['code'] ?? 'BRIDGE', 40);
        $message = trax_str($decoded['error']['message'] ?? "HTTP {$status}", 300);
        if ($code === 'UNAUTHORIZED') {
            $message = 'The bridge refused the token — compare it with PTB_TOKEN on the Pi.';
        }
        throw new TraxPrinterError($message, $code, $status);
    }

    return $decoded;
}

/** @return array{0:int,1:?string,2:string} status, body (null on transport failure), error */
function trax_printer_curl(string $method, string $url, array $headers, ?string $body, int $timeout): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_FOLLOWLOCATION => false,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    $raw    = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $error  = curl_error($ch);
    curl_close($ch);

    return [$status, $raw === false ? null : (string)$raw, $error];
}

/** The same without the curl extension. */
function trax_printer_stream(string $method, string $url, array $headers, ?string $body, int $timeout): array
{
    $context = stream_context_create([
        'http' => [
            'method'          => $method,
            'header'          => implode("\r\n", $headers),
            'content'         => $body ?? '',
            'timeout'         => $timeout,
            'ignore_errors'   => true,
            'follow_location' => 0,
        ],
    ]);
    $raw = @file_get_contents($url, false, $context);
    if ($raw === false) {
        $error = error_get_last()['message'] ?? 'connection failed';
        return [0, null, $error];
    }
    $status = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('~^HTTP/\S+\s+(\d{3})~', $line, $m) === 1) {
            $status = (int)$m[1];
        }
    }
    return [$status, $raw, ''];
}

/**
 * Sends one label PNG with the size its format prints at and the defaults
 * from settings.printer. The asset (and unit) only name the job in the
 * bridge's history. Returns the bridge's job record and, when it has one, the
 * printer status.
 */
function trax_printer_print_png(array $data, string $png, string $format, ?int $assetId, ?int $unitNo, int $copies): array
{
    $settings = trax_normalize_settings($data['settings'] ?? null);
    $printer  = $settings['printer'];
    [$widthMm, $heightMm] = trax_printer_label_mm($format, $settings);

    $name = trax_printer_label_name($data, $format, $assetId, $unitNo);

    $payload = [
        'image'    => base64_encode($png),
        'widthMm'  => $widthMm,
        'heightMm' => $heightMm,
        'fit'      => $printer['fit'],
        'copies'   => $copies,
        'cut'      => $printer['cut'],
        'chain'    => $printer['chain'],
        'marginMm' => $printer['marginMm'],
        'highRes'  => $printer['highRes'],
        'shiftMm'  => $printer['shiftMm'],
        'jobName'  => trax_str($name, 120),
        'source'   => trax_str($settings['branding']['appName'] ?? 'inventory', 60),
    ];
    if ($printer['tapeMm'] > 0) {
        $payload['tapeMm'] = $printer['tapeMm'];
    }

    $answer = trax_printer_request($printer, 'POST', '/api/print', $payload);

    return array_filter([
        'job'     => is_array($answer['job'] ?? null) ? $answer['job'] : null,
        'printer' => is_array($answer['printer'] ?? null) ? $answer['printer'] : null,
    ], static fn($v) => $v !== null);
}

/** "12.1 Sommer cable (wide)" – what the bridge's history calls a label. */
function trax_printer_label_name(array $data, string $format, ?int $assetId, ?int $unitNo): string
{
    if ($assetId === null) {
        return $format;
    }
    $asset = trax_find_asset($data['assets'] ?? [], $assetId);
    $code  = $unitNo !== null ? trax_unit_code($assetId, $unitNo) : (string)$assetId;
    return trax_str($code . ' ' . trax_str($asset['name'] ?? '', 80) . ' (' . $format . ')', 120);
}

// ---------------------------------------------------------------------------
// Batches: many labels, one job – see the printer.batch* actions in api.php
// ---------------------------------------------------------------------------

function trax_printer_batch_start(array $printer): string
{
    $answer = trax_printer_request($printer, 'POST', '/api/batches', [], 20);
    $id = (string)($answer['batchId'] ?? '');
    if (preg_match('/^[0-9a-f]{24}$/', $id) !== 1) {
        throw new TraxPrinterError('The bridge did not start a batch – is it up to date?', 'BRIDGE');
    }
    return $id;
}

/** Adds one label; returns how many the batch holds now. */
function trax_printer_batch_add(array $data, string $batchId, int $index, string $png, string $format,
                                ?int $assetId, ?int $unitNo): int
{
    $settings = trax_normalize_settings($data['settings'] ?? null);
    [$widthMm, $heightMm] = trax_printer_label_mm($format, $settings);

    $answer = trax_printer_request($settings['printer'], 'POST', '/api/batches/' . $batchId . '/labels', [
        'image'    => base64_encode($png),
        'widthMm'  => $widthMm,
        'heightMm' => $heightMm,
        'index'    => $index,
        'name'     => trax_printer_label_name($data, $format, $assetId, $unitNo),
    ], 30);
    return (int)($answer['count'] ?? 0);
}

/**
 * Prints the batch as one job – or, with $dryRun, answers with a preview of
 * the strip and keeps the batch for the real print.
 */
function trax_printer_batch_print(array $data, string $batchId, string $format, string $orientation,
                                  string $cut, int $copies, bool $dryRun): array
{
    $settings = trax_normalize_settings($data['settings'] ?? null);
    $printer  = $settings['printer'];

    $payload = [
        'orientation' => $orientation,
        'cut'         => $cut,
        // The strip ends with a feed and a full cut, whatever chain printing
        // single labels use.
        'chain'       => false,
        'fit'         => $printer['fit'],
        'marginMm'    => $printer['marginMm'],
        'highRes'     => $printer['highRes'],
        'shiftMm'     => $printer['shiftMm'],
        'copies'      => $copies,
        'batchMode'   => $printer['batchMode'] !== '' ? $printer['batchMode'] : null,
        'dryRun'      => $dryRun,
        'jobName'     => trax_str('Batch (' . $format . ($orientation === 'across' ? ', rotated' : '') . ')', 120),
        'source'      => trax_str($settings['branding']['appName'] ?? 'inventory', 60),
    ];
    if ($printer['tapeMm'] > 0) {
        $payload['tapeMm'] = $printer['tapeMm'];
    }
    $payload = array_filter($payload, static fn($v) => $v !== null);

    $answer = trax_printer_request($printer, 'POST', '/api/batches/' . $batchId . '/print', $payload,
        TRAX_PRINTER_BATCH_TIMEOUT);

    $preview = (string)($answer['preview'] ?? '');
    return array_filter([
        'job'     => is_array($answer['job'] ?? null) ? $answer['job'] : null,
        'printer' => is_array($answer['printer'] ?? null) ? $answer['printer'] : null,
        // Only the strip the bridge drew, and only for a preview.
        'preview' => $dryRun && str_starts_with($preview, 'data:image/png;base64,') ? $preview : null,
    ], static fn($v) => $v !== null);
}

function trax_printer_batch_cancel(array $printer, string $batchId): void
{
    trax_printer_request($printer, 'DELETE', '/api/batches/' . $batchId, null, 10);
}
