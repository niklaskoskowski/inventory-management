<?php
/**
 * The optional connection to the Invoice app: a booking becomes an invoice
 * DRAFT there, with the customer picked from Invoice's own customer list.
 *
 * The browser never talks to Invoice. api.php forwards to Invoice's
 * integration.php with the key from settings.invoice — so the key stays on
 * this server and no CORS is involved (same pattern as lib/printer.php).
 *
 * Off by default (settings.invoice.enabled). Only api.php loads this file.
 */

declare(strict_types=1);

require_once __DIR__ . '/printer.php';

final class TraxInvoiceError extends RuntimeException
{
    public function __construct(string $message, public readonly string $remoteCode = 'INVOICE', public readonly int $status = 0)
    {
        parent::__construct($message);
    }
}

/** settings.invoice as stored, normalised. */
function trax_invoice_settings(?array $data = null): array
{
    $data ??= trax_read_data();
    return trax_normalize_settings($data['settings'] ?? null)['invoice'];
}

/** The saved settings, or a refusal when the feature is off or incomplete. */
function trax_invoice_enabled_or_fail(?array $data = null): array
{
    $invoice = trax_invoice_settings($data);
    if (!$invoice['enabled']) {
        throw new TraxInvoiceError('Invoicing is switched off (Settings → Invoicing).', 'DISABLED');
    }
    return $invoice;
}

/** Checked BEFORE settings.update mutates anything, like the printer patch. */
function trax_invoice_patch_error(mixed $patch, array $current): ?string
{
    if (!is_array($patch)) {
        return null;
    }
    if (array_key_exists('url', $patch) && trax_printer_url($patch['url']) === null) {
        return 'Invoice URL: use http(s)://host[/path], without user, query or fragment.';
    }
    if (array_key_exists('key', $patch) && trax_str($patch['key'], 300) !== trax_printer_secret($patch['key'])) {
        return 'Invoice API key: printable characters only, no spaces.';
    }
    if (array_key_exists('vatRate', $patch)) {
        $rate = trax_float($patch['vatRate']);
        if ($rate === null || $rate < 0 || $rate > 100) {
            return 'VAT rate: a percentage between 0 and 100.';
        }
    }
    $merged = trax_normalize_invoice_settings(array_merge($current, $patch));
    if ($merged['enabled'] && ($merged['url'] === '' || $merged['key'] === '')) {
        return 'Set the Invoice URL and API key before switching invoicing on.';
    }
    return null;
}

/**
 * One call to Invoice's integration.php. Returns `data` of a successful answer;
 * everything else becomes a TraxInvoiceError that says what to look at.
 */
function trax_invoice_request(array $invoice, string $action, array $body = [], int $timeout = TRAX_INVOICE_TIMEOUT): mixed
{
    if ($invoice['url'] === '' || $invoice['key'] === '') {
        throw new TraxInvoiceError('No Invoice URL or API key is configured (Settings → Invoicing).', 'NOT_CONFIGURED');
    }

    $url = preg_match('~\.php$~', $invoice['url']) === 1 ? $invoice['url'] : $invoice['url'] . '/integration.php';
    $headers = [
        'Accept: application/json',
        'Content-Type: application/json',
        'User-Agent: trax-inventory',
        // Plesk/FastCGI often drops Authorization; Invoice reads this first.
        'X-Invoice-Key: ' . $invoice['key'],
        'Authorization: Bearer ' . $invoice['key'],
    ];
    $json = json_encode(['action' => $action, 'actor' => trax_actor()] + $body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);

    [$status, $raw, $transportError] = function_exists('curl_init')
        ? trax_printer_curl('POST', $url, $headers, $json, $timeout)
        : trax_printer_stream('POST', $url, $headers, $json, $timeout);

    if ($raw === null) {
        throw new TraxInvoiceError('Cannot reach Invoice at ' . $invoice['url'] . ': ' . $transportError, 'UNREACHABLE');
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        $hint = match (true) {
            $status >= 300 && $status < 400 => 'it redirected — is the URL the Invoice folder (https://…/invoice)?',
            $status === 404 => 'integration.php not found — update Invoice or check the URL.',
            default => 'is the URL the Invoice app, e.g. https://example.com/invoice?',
        };
        throw new TraxInvoiceError("Invoice answered HTTP {$status} without JSON: {$hint}", 'NOT_INVOICE', $status);
    }

    if (($decoded['ok'] ?? false) !== true) {
        $code    = trax_str($decoded['code'] ?? 'INVOICE', 40);
        $message = trax_str($decoded['error'] ?? "HTTP {$status}", 500);
        if ($code === 'unauthorized') {
            $message = 'Invoice refused the API key — generate one in Invoice → Einstellungen → Integrationen and paste it here.';
        } elseif ($code === 'disabled') {
            $message = 'The connection is switched off in Invoice (Einstellungen → Integrationen).';
        }
        throw new TraxInvoiceError('Invoice: ' . $message, $code, $status);
    }

    return $decoded['data'] ?? null;
}

/** The ref a booking is known by in Invoice. */
function trax_invoice_ref(int $bookingId): string
{
    return 'booking:' . $bookingId;
}

/** Invoice's document record → the booking's `invoice` block. */
function trax_invoice_link_from_doc(array $doc, ?array $previous, string $actor): array
{
    return trax_normalize_booking_invoice([
        'kind'      => $doc['kind'] ?? 'document',
        'docId'     => $doc['id'] ?? null,
        'projectId'     => $doc['project_id'] ?? null,
        'projectNumber' => $doc['project_number'] ?? '',
        'projectName'   => $doc['project_name'] ?? '',
        'net'       => $doc['net'] ?? null,
        'number'    => $doc['number'] ?? null,
        'status'    => $doc['status'] ?? 'draft',
        'gross'     => $doc['gross'] ?? null,
        'currency'  => $doc['currency'] ?? 'EUR',
        'url'       => $doc['url'] ?? '',
        'createdAt' => $previous['createdAt'] ?? null,
        'actor'     => $previous['actor'] ?? $actor,
        'syncedAt'  => gmdate('Y-m-d\TH:i:s.000\Z'),
    ]);
}

/** A whitelisted customer record for customers.create. */
function trax_invoice_customer_payload(array $raw): array
{
    $kind = ($raw['kind'] ?? 'person') === 'company' ? 'company' : 'person';
    $out = ['kind' => $kind];
    foreach (['company' => 200, 'first_name' => 100, 'last_name' => 100, 'contact_person' => 150, 'email' => 200,
        'phone' => 60, 'street' => 200, 'zip' => 20, 'city' => 100, 'country' => 2, 'vat_id' => 30] as $key => $max) {
        $out[$key] = trax_str($raw[$key] ?? '', $max);
    }
    $out['country'] = strtoupper($out['country']) ?: 'DE';
    return $out;
}

/** Validated invoice lines from the client (the client prices; Invoice re-totals). */
function trax_invoice_items_payload(mixed $raw, float $defaultRate): array
{
    $items = [];
    foreach (array_slice(is_array($raw) ? $raw : [], 0, 300) as $line) {
        if (!is_array($line)) {
            continue;
        }
        $title = trax_str($line['title'] ?? '', 300);
        $desc  = trax_str($line['description'] ?? '', 4000);
        if ($title === '' && $desc === '') {
            continue;
        }
        $qty   = trax_float($line['quantity'] ?? null) ?? 1.0;
        $price = trax_float($line['unit_price'] ?? null) ?? 0.0;
        $rate  = trax_float($line['vat_rate'] ?? null) ?? $defaultRate;
        $unit  = trax_str($line['unit'] ?? 'C62', 3);
        $items[] = [
            'title'       => $title,
            'description' => $desc,
            'sku'         => trax_str($line['sku'] ?? '', 64),
            'quantity'    => round(max(-999999, min(999999, $qty)), 4),
            'unit'        => preg_match('/^[A-Z0-9]{1,3}$/', $unit) === 1 ? $unit : 'C62',
            'unit_price'  => round(max(-9999999, min(9999999, $price)), 4),
            'vat_rate'    => round(max(0, min(100, $rate)), 2),
        ];
    }
    return $items;
}
