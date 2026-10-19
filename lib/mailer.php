<?php
/**
 * Transactional mail.
 *
 * Replaces the three ad-hoc mail() call sites in admin.php, manage_checkouts.php
 * and index.php. Those interpolated unvalidated user input straight into the
 * recipient list and headers; everything here is validated and CR/LF-stripped
 * first, so header injection is not possible.
 */

declare(strict_types=1);

require_once __DIR__ . '/config.php';
// For trax_setting(). This require goes one way only: the address guards
// trax_valid_email()/trax_mail_header_safe() moved into config.php, so store.php
// no longer has to require this file back.
require_once __DIR__ . '/store.php';

/**
 * The operator address, from the runtime settings, falling back to the config
 * constant. Every send resolves it through here so an address changed in the
 * UI takes effect without a redeploy.
 */
function trax_owner_email(): string
{
    return trax_valid_email(trax_setting('email.ownerEmail', TRAX_OWNER_EMAIL)) ?? TRAX_OWNER_EMAIL;
}

/** Envelope sender for transactional mail. */
function trax_from_email(): string
{
    return trax_valid_email(trax_setting('email.fromEmail', TRAX_FROM_EMAIL)) ?? TRAX_FROM_EMAIL;
}

/** Envelope sender for the public lost-item report. */
function trax_report_from_email(): string
{
    return trax_valid_email(trax_setting('email.reportFromEmail', TRAX_REPORT_FROM_EMAIL)) ?? TRAX_REPORT_FROM_EMAIL;
}

// trax_mail_header_safe() and trax_valid_email() are in lib/config.php — the
// settings normaliser needs them too, and having them here made store.php and
// this file require each other.

/**
 * The test sink, or null when mail really goes out.
 *
 * TRAX_MAIL_SINK names a file the whole message is appended to instead of being
 * handed to the MTA. Production sets nothing and mail() is called exactly as
 * before; the test suites set it so a run can assert on what WOULD have been
 * sent without the local MTA actually delivering it.
 *
 * Deliberately fail-closed: once the variable is set, mail() is never called,
 * even if the append fails (that reports false instead). Falling back to a real
 * send there would be the one behaviour a test harness must never have.
 */
function trax_mail_sink_path(): ?string
{
    $path = getenv('TRAX_MAIL_SINK');
    return (is_string($path) && trim($path) !== '') ? trim($path) : null;
}

/** Appends one rendered message to the sink file. */
function trax_mail_sink_write(string $path, array $recipients, string $subject, string $body, string $headers): bool
{
    $entry = "===== mail " . gmdate('Y-m-d\TH:i:s\Z') . " =====\n"
        . 'To: ' . implode(', ', $recipients) . "\n"
        . 'Subject: ' . $subject . "\n"
        . $headers . "\n\n"
        . $body . "\n"
        . "----- end -----\n";

    $ok = @file_put_contents($path, $entry, FILE_APPEND | LOCK_EX);
    if ($ok === false) {
        error_log("[app] TRAX_MAIL_SINK is set to {$path} but could not be written; mail dropped.");
        return false;
    }
    return true;
}

/**
 * Sends a UTF-8 plain-text mail.
 *
 * @param string[] $to Recipient addresses; invalid ones are dropped.
 * @return bool True if at least one recipient was addressed and mail() accepted it.
 */
function trax_send_mail(array $to, string $subject, string $body, ?string $from = null): bool
{
    $recipients = [];
    foreach ($to as $address) {
        $valid = trax_valid_email($address);
        if ($valid !== null && !in_array($valid, $recipients, true)) {
            $recipients[] = $valid;
        }
    }

    if ($recipients === []) {
        return false;
    }

    // A fresh install has no sender configured (TRAX_FROM_EMAIL defaults to ''
    // and nothing has been saved in Settings yet). Sending anyway would put an
    // empty or invented From: on the wire, which MTAs either reject or deliver
    // as spam under the host's default identity — so nothing goes out until an
    // operator names an address, and the caller sees the same false it gets for
    // any other refusal.
    $from = trax_valid_email($from) ?? trax_valid_email(trax_from_email());
    if ($from === null) {
        error_log('[app] no sender address configured (settings.email.fromEmail); mail not sent.');
        return false;
    }

    // The display name is the app's, encoded: "Trax <info@example.com>".
    $fromName = trax_mail_header_safe((string)trax_setting('branding.appName', ''));
    $fromHeader = $fromName !== ''
        ? mb_encode_mimeheader($fromName, 'UTF-8', 'Q', "\r\n") . ' <' . $from . '>'
        : $from;
    $domain = substr(strrchr($from, '@') ?: '@localhost', 1);

    // The message: the text as written (the templates are plain text and
    // stay the source of truth) plus an HTML rendering of the same text with
    // the logo, as multipart/alternative — wrapped in multipart/related when
    // the logo travels inline (cid:), so no client has to fetch an image.
    $logo = trax_mail_logo();
    $cid  = 'logo.' . bin2hex(random_bytes(6)) . '@' . $domain;
    $html = trax_mail_html($subject, $body, $logo === null ? null : ($logo['url'] ?? 'cid:' . $cid));
    $mime = trax_mail_mime($body, $html, ($logo !== null && isset($logo['bytes'])) ? $logo + ['cid' => $cid] : null);

    $headers = implode("\r\n", [
        'From: ' . $fromHeader,
        'Reply-To: ' . $from,
        'Date: ' . date('r'),
        'Message-ID: <' . bin2hex(random_bytes(12)) . '.' . time() . '@' . $domain . '>',
        'MIME-Version: 1.0',
        'Content-Type: ' . $mime['type'],
        'X-Mailer: AssetTool',
    ]);

    // Subject is header data: encode it so UTF-8 survives and CR/LF cannot escape.
    $subject = mb_encode_mimeheader(trax_mail_header_safe($subject), 'UTF-8', 'B', "\r\n");

    // Handed to sendmail with plain \n line ends, which it expects.
    $body = str_replace("\r\n", "\n", $mime['body']);

    $sink = trax_mail_sink_path();
    if ($sink !== null) {
        return trax_mail_sink_write($sink, $recipients, $subject, $body, $headers);
    }

    // The envelope sender is the From address, so SPF, DMARC alignment and
    // bounces all point at the operator's own domain instead of the host's
    // system user. $from is a validated address; mail() shell-escapes it.
    $params = TRAX_MAIL_ENVELOPE_FROM ? '-f' . $from : '';

    return @mail(implode(', ', $recipients), $subject, $body, $headers, $params);
}

/**
 * Text as a 7-bit quoted-printable part body. CRLF line ends, which
 * quoted-printable keeps as real line breaks (a bare \n would become =0A).
 * Declared and true: a bare UTF-8 body under an implied 7bit header is what
 * spam filters score as CTE_8BIT_MISMATCH.
 */
function trax_mail_qp(string $text): string
{
    return quoted_printable_encode(str_replace(["\r\n", "\r", "\n"], ["\n", "\n", "\r\n"], $text));
}

/**
 * The MIME body: text + HTML alternatives, and the inline logo if given.
 *
 * @param array{bytes:string, mime:string, name:string, cid:string}|null $logo
 * @return array{type:string, body:string}
 */
function trax_mail_mime(string $text, string $html, ?array $logo): array
{
    $alt = 'alt-' . bin2hex(random_bytes(8));
    $alternative = "--{$alt}\r\n"
        . "Content-Type: text/plain; charset=UTF-8\r\n"
        . "Content-Transfer-Encoding: quoted-printable\r\n\r\n"
        . trax_mail_qp($text) . "\r\n"
        . "--{$alt}\r\n"
        . "Content-Type: text/html; charset=UTF-8\r\n"
        . "Content-Transfer-Encoding: quoted-printable\r\n\r\n"
        . trax_mail_qp($html) . "\r\n"
        . "--{$alt}--\r\n";
    $altType = 'multipart/alternative; boundary="' . $alt . '"';

    if ($logo === null) {
        return ['type' => $altType, 'body' => $alternative];
    }

    $rel = 'rel-' . bin2hex(random_bytes(8));
    $body = "--{$rel}\r\n"
        . "Content-Type: {$altType}\r\n\r\n"
        . $alternative
        . "--{$rel}\r\n"
        . "Content-Type: {$logo['mime']}; name=\"{$logo['name']}\"\r\n"
        . "Content-Transfer-Encoding: base64\r\n"
        . "Content-ID: <{$logo['cid']}>\r\n"
        . "Content-Disposition: inline; filename=\"{$logo['name']}\"\r\n\r\n"
        . chunk_split(base64_encode($logo['bytes']), 76, "\r\n")
        . "--{$rel}--\r\n";

    return ['type' => 'multipart/related; type="multipart/alternative"; boundary="' . $rel . '"', 'body' => $body];
}

/**
 * The mail logo: the in-tool light logo, else the label/PDF logo — local PNG
 * or JPEG only (WebP shows as a broken image in Outlook), embedded inline.
 * A label/PDF logo that is an https URL is referenced instead. Null: no logo,
 * the header shows the app name.
 *
 * @return array{bytes:string, mime:string, name:string}|array{url:string}|null
 */
function trax_mail_logo(): ?array
{
    $root = dirname(__DIR__);
    foreach ([(string)trax_setting('branding.appLogoLight', ''), (string)trax_setting('branding.logoFile', '')] as $file) {
        if ($file === '') {
            continue;
        }
        if (preg_match('#^https://#i', $file) === 1) {
            return ['url' => $file];
        }
        $path = $root . '/' . basename($file);
        $info = is_file($path) ? @getimagesize($path) : false;
        $mime = match ($info[2] ?? null) {
            IMAGETYPE_PNG  => 'image/png',
            IMAGETYPE_JPEG => 'image/jpeg',
            default        => null,
        };
        $bytes = $mime !== null ? @file_get_contents($path) : false;
        if ($mime !== null && is_string($bytes) && $bytes !== '' && strlen($bytes) <= 512 * 1024) {
            return ['bytes' => $bytes, 'mime' => $mime, 'name' => $mime === 'image/png' ? 'logo.png' : 'logo.jpg'];
        }
    }
    return null;
}

/**
 * The HTML version of a plain-text mail: the same words, laid out.
 *
 * The templates are plain text the operator edits, so the layout is read off
 * the text rather than written into it:
 *   "Label: https://…"  → a button (the booking link)
 *   "Label: value"      → a row of a small details table
 *   "- item"            → a list
 *   "Heading:"          → a section heading
 *   anything else       → a paragraph, with URLs linked
 * Inline styles and tables only — what mail clients actually render.
 */
function trax_mail_html(string $subject, string $text, ?string $logoSrc): string
{
    $e      = static fn(string $v): string => htmlspecialchars($v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $accent = (string)trax_setting('branding.accentLight', '') ?: (string)trax_setting('branding.brandColor', '#1F2937');
    $accent = trax_hex_color($accent) ?? '#1F2937';
    $appName = (string)trax_setting('branding.appName', 'Assets');
    $orgName = (string)trax_setting('branding.orgName', '') ?: $appName;
    $font    = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

    $link = static function (string $escaped) use ($accent): string {
        return (string)preg_replace(
            '#https?://[^\s<>"\']+#',
            '<a href="$0" style="color:' . $accent . ';text-decoration:underline;">$0</a>',
            $escaped
        );
    };

    $out    = '';
    $list   = [];
    $rows   = [];
    $para   = [];
    // Consecutive plain lines are one paragraph (a multi-line note), so they
    // are collected and written together.
    $flushPara = static function () use (&$para, &$out, $e, $link): void {
        if ($para !== []) {
            $out .= '<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#111827;">'
                . implode('<br>', array_map(static fn(string $l): string => $link($e($l)), $para)) . '</p>';
            $para = [];
        }
    };
    $flush  = static function () use (&$list, &$rows, &$out, $e, $link, $flushPara): void {
        $flushPara();
        if ($list !== []) {
            $out .= '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 16px;border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;">';
            foreach ($list as $i => $item) {
                $border = $i > 0 ? 'border-top:1px solid #e5e7eb;' : '';
                $out .= '<tr><td style="padding:10px 14px;font-size:14px;color:#111827;' . $border . '">' . $link($e($item)) . '</td></tr>';
            }
            $out .= '</table>';
            $list = [];
        }
        if ($rows !== []) {
            $out .= '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">';
            foreach ($rows as [$label, $value]) {
                $out .= '<tr><td style="padding:4px 12px 4px 0;font-size:14px;color:#6b7280;white-space:nowrap;vertical-align:top;width:1%;">'
                    . $e($label) . '</td><td style="padding:4px 0;font-size:14px;color:#111827;font-weight:600;">'
                    . $link($e($value)) . '</td></tr>';
            }
            $out .= '</table>';
            $rows = [];
        }
    };

    foreach (preg_split('/\R/', trim($text)) ?: [] as $raw) {
        $line = trim($raw);
        if ($line === '') {
            // A blank line ends a list or a paragraph, but not the details
            // table: "Customer: …", blank, "Return Date: …" is one table.
            $flushPara();
            if ($list !== []) {
                $flush();
            }
            continue;
        }
        if (preg_match('/^[-•]\s+(.*)$/u', $line, $m) === 1) {
            if ($rows !== []) { $flush(); }
            $list[] = $m[1];
            continue;
        }
        if ($list !== []) {
            $flush();
        }
        if (preg_match('#^([^:]{1,60}):\s+(https?://\S+)$#u', $line, $m) === 1) {
            $flush();
            $out .= '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;"><tr>'
                . '<td style="border-radius:8px;background:' . $accent . ';">'
                . '<a href="' . $e($m[2]) . '" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">'
                . $e($m[1]) . '</a></td></tr></table>';
            continue;
        }
        if (preg_match('/^([^:]{1,40}):\s+(.+)$/u', $line, $m) === 1 && !preg_match('#^https?$#i', $m[1])) {
            $flushPara();
            $rows[] = [$m[1], $m[2]];
            continue;
        }
        if (preg_match('/^([^:]{1,60}):$/u', $line, $m) === 1) {
            $flush();
            $out .= '<p style="margin:16px 0 6px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;">' . $e($m[1]) . '</p>';
            continue;
        }
        if ($rows !== []) {
            $flush();
        }
        $para[] = $line;
    }
    $flush();

    $header = $logoSrc !== null
        ? '<img src="' . $e($logoSrc) . '" alt="' . $e($appName) . '" height="36" style="display:block;height:36px;width:auto;max-width:220px;border:0;">'
        : '<span style="font-size:18px;font-weight:700;color:#111827;">' . $e($appName) . '</span>';

    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<meta name="color-scheme" content="light"><title>' . $e($subject) . '</title></head>'
        . '<body style="margin:0;padding:0;background:#f4f4f5;font-family:' . $font . ';">'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;"><tr><td align="center" style="padding:32px 16px;">'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">'
        . '<tr><td style="padding:0 4px 20px;">' . $header . '</td></tr>'
        . '<tr><td style="background:#ffffff;border-radius:12px;padding:28px 28px 16px;">'
        . '<h1 style="margin:0 0 20px;font-size:20px;line-height:1.3;font-weight:700;color:#111827;">' . $e($subject) . '</h1>'
        . $out
        . '</td></tr>'
        . '<tr><td style="padding:20px 4px 0;font-size:12px;line-height:1.5;color:#9ca3af;">' . $e($orgName)
        . ($orgName !== $appName ? ' · ' . $e($appName) : '') . '</td></tr>'
        . '</table></td></tr></table></body></html>';
}

/**
 * Renders "- [ID 4] – SD 128GB" lines for a set of checkout records.
 *
 * $withQty appends " ×3" where a record covers more than one unit. Off by
 * default: the checkout and reservation confirmations have never shown it and
 * this only exists for the check-in mail, which lists a whole return at once.
 *
 * A record naming physical units gets them spelled out — " (units 12.1, 12.3)"
 * — so the customer's mail says which cable they have, not just how many.
 *
 * @param array<int,array> $records
 */
function trax_mail_item_lines(array $records, bool $withQty = false): string
{
    $lines = [];
    foreach ($records as $record) {
        $name = $record['name'] !== '' ? $record['name'] : 'Unknown';
        $qty  = max(1, (int)($record['qty'] ?? 1));
        $line = "- [ID {$record['id']}] – {$name}";
        if ($withQty && $qty > 1) {
            $line .= " ×{$qty}";
        }
        $unitNos = is_array($record['unitNos'] ?? null) ? $record['unitNos'] : [];
        if ($unitNos !== []) {
            $codes = array_map(
                static fn($no): string => trax_unit_code((int)$record['id'], (int)$no),
                $unitNos
            );
            $line .= ' (units ' . implode(', ', $codes) . ')';
        }
        $lines[] = $line;
    }
    return implode("\n", $lines);
}

/**
 * The customer's own link, as a labelled line to append to a mail body.
 * Empty when there is no token, so a booking-less send is unchanged.
 */
function trax_mail_booking_line(?string $token): string
{
    if ($token === null || $token === '') {
        return '';
    }
    return "\nYour booking overview: " . trax_booking_url($token) . "\n";
}

/**
 * The "Notes:" block as it appears in a body, or nothing.
 * One token rather than a conditional an operator would have to write.
 */
function trax_mail_notes_block(string $notes): string
{
    return trim($notes) !== '' ? "\nNotes:\n{$notes}\n" : '';
}

// ---------------------------------------------------------------------------
// Templates
//
// Subject and body of every mail come from trax_mail_templates() in
// lib/config.php, overridden per template by settings.email.templates.<key>.
// There is exactly one rendering path: the built-in text is itself a template,
// so an untouched install and an edited one are rendered by the same code and
// the defaults cannot drift from what the Settings view shows.
// ---------------------------------------------------------------------------

/**
 * The stored override for one field of one template, or '' when there is none.
 * Empty means "use the built-in default" — never "send an empty mail".
 */
function trax_mail_template_override(string $key, string $field): string
{
    $value = trax_setting("email.templates.{$key}.{$field}", '');
    return is_string($value) ? $value : '';
}

/** Subject and body of one template, override first, built-in default second. */
function trax_mail_template(string $key): array
{
    $default = trax_mail_templates()[$key] ?? null;
    if ($default === null) {
        return ['subject' => '', 'body' => ''];
    }

    $subject = trax_mail_template_override($key, 'subject');
    $body    = trax_mail_template_override($key, 'body');

    return [
        'subject' => $subject !== '' ? $subject : $default['subject'],
        'body'    => $body !== '' ? $body : $default['body'],
    ];
}

/**
 * Expands {{token}} placeholders. strtr() replaces in a single pass, so a value
 * that itself contains "{{items}}" — a customer name, a note — is never
 * re-expanded. A placeholder that is not in the map is left standing: the save
 * path refuses unknown tokens, so one here means the settings were written
 * around the API, and printing it literally is louder than dropping it.
 */
function trax_mail_expand(string $template, array $tokens): string
{
    $map = [];
    foreach ($tokens as $name => $value) {
        $map[trax_mail_token($name)] = (string)$value;
    }
    return strtr($template, $map);
}

/** Renders one template: ['subject' => …, 'body' => …]. */
function trax_mail_render(string $key, array $tokens): array
{
    $template = trax_mail_template($key);
    return [
        'subject' => trax_mail_expand($template['subject'], $tokens),
        'body'    => trax_mail_expand($template['body'], $tokens),
    ];
}

/** Confirmation sent when items are checked out. */
function trax_mail_checkout(string $customerName, string $customerEmail, string $returnDate, string $notes, array $records, ?string $bookingToken = null): bool
{
    $mail = trax_mail_render('checkout', [
        'customerName'  => $customerName,
        'customerEmail' => $customerEmail,
        'returnDate'    => $returnDate,
        'items'         => trax_mail_item_lines($records),
        'notesBlock'    => trax_mail_notes_block($notes),
        'bookingLink'   => trax_mail_booking_line($bookingToken),
    ]);

    return trax_send_mail(
        [$customerEmail, trax_owner_email()],
        $mail['subject'],
        $mail['body']
    );
}

/**
 * Confirmation sent when a reservation is booked.
 *
 * reservation.create used to send nothing at all, so the customer had no record
 * of what they had booked and no link to it.
 */
function trax_mail_reservation(string $customerName, string $customerEmail, string $startDate, string $endDate, string $notes, array $records, ?string $bookingToken = null): bool
{
    $mail = trax_mail_render('reservation', [
        'customerName'  => $customerName,
        'customerEmail' => $customerEmail,
        'startDate'     => $startDate,
        'endDate'       => $endDate,
        'items'         => trax_mail_item_lines($records),
        'notesBlock'    => trax_mail_notes_block($notes),
        'bookingLink'   => trax_mail_booking_line($bookingToken),
    ]);

    return trax_send_mail(
        [$customerEmail, trax_owner_email()],
        $mail['subject'],
        $mail['body']
    );
}

/**
 * Notification sent when a checkout's return date is extended.
 *
 * One mail per customer, not per line: extending a three-line kit used to send
 * three near-identical messages because the caller looped the touched lines.
 * $records is everything THIS customer had extended in one call. One call
 * carries a single dueAt, so every line in it lands on the same new date and it
 * belongs in the heading rather than repeated per item.
 *
 * @param array<int,array> $records
 */
function trax_mail_extend(string $customerName, string $customerEmail, array $records, string $newReturnDate): bool
{
    $mail = trax_mail_render('extend', [
        'customerName'  => $customerName,
        'customerEmail' => $customerEmail,
        'items'         => trax_mail_item_lines($records, true),
        'itemNoun'      => count($records) === 1 ? 'item' : 'items',
        'newReturnDate' => $newReturnDate,
    ]);

    return trax_send_mail(
        [$customerEmail, trax_owner_email()],
        $mail['subject'],
        $mail['body']
    );
}

/**
 * Notification sent when items are checked back in.
 *
 * One mail per customer, not per line: returning a five-item kit used to send
 * five near-identical messages because the caller looped the returned slips.
 * $records is everything THIS customer handed back in one call; $stillOut is
 * how many units they have left out afterwards, so the mail closes the loop
 * instead of leaving them to count.
 *
 * @param array<int,array> $records
 */
function trax_mail_checkin(string $customerName, string $customerEmail, array $records, int $stillOut = 0): bool
{
    $mail = trax_mail_render('checkin', [
        'customerName'  => $customerName,
        'customerEmail' => $customerEmail,
        'items'         => trax_mail_item_lines($records, true),
        'itemNoun'      => count($records) === 1 ? 'item' : 'items',
        'stillOutLine'  => $stillOut > 0
            ? ($stillOut === 1
                ? 'You still have 1 item out with us.'
                : "You still have {$stillOut} items out with us.")
            : 'That is everything — you have no items out with us any more.',
        'stillOut'      => (string)$stillOut,
    ]);

    return trax_send_mail(
        [$customerEmail, trax_owner_email()],
        $mail['subject'],
        $mail['body']
    );
}

// ---------------------------------------------------------------------------
// Reminders — sent by cron.php, never by a request. Each one takes a whole
// booking record because the cron works in bookings, not in checkout lines.
// ---------------------------------------------------------------------------

/** Booking item snapshots rendered as "- [ID 4] – SD 128GB" lines. */
function trax_mail_booking_lines(array $items): string
{
    return trax_mail_item_lines(array_map(
        static fn(array $item): array => ['id' => $item['assetId'], 'name' => $item['name']],
        $items
    ));
}

/** Reminder that a booking is due back shortly. Sent once per booking. */
function trax_mail_due_soon(array $booking, string $dueDate): bool
{
    $mail = trax_mail_render('dueSoon', [
        'customerName'  => $booking['customerName'] !== '' ? $booking['customerName'] : 'there',
        'customerEmail' => $booking['customerEmail'],
        'dueDate'       => $dueDate,
        'items'         => trax_mail_booking_lines($booking['items']),
        'bookingLink'   => trax_mail_booking_line($booking['token'] ?? null),
    ]);

    return trax_send_mail(
        [$booking['customerEmail']],
        $mail['subject'],
        $mail['body']
    );
}

/**
 * Reminder that a booking is past its return date. Sent when it first goes
 * overdue and then once every cron.overdueRepeatDays, so $daysOverdue is spelled
 * out rather than left to the customer to work out.
 */
function trax_mail_overdue(array $booking, string $dueDate, int $daysOverdue): bool
{
    $mail = trax_mail_render('overdue', [
        'customerName'     => $booking['customerName'] !== '' ? $booking['customerName'] : 'there',
        'customerEmail'    => $booking['customerEmail'],
        'dueDate'          => $dueDate,
        'daysOverdue'      => $daysOverdue === 1 ? '1 day' : "{$daysOverdue} days",
        'daysOverdueCount' => (string)$daysOverdue,
        'items'            => trax_mail_booking_lines($booking['items']),
        'bookingLink'      => trax_mail_booking_line($booking['token'] ?? null),
    ]);

    return trax_send_mail(
        [$booking['customerEmail']],
        $mail['subject'],
        $mail['body']
    );
}

/**
 * The operator's daily summary. Each group is a list of ready-made lines, so
 * the caller decides what a line says and this only lays them out.
 *
 * @param array{overdue:string[], dueToday:string[], startingToday:string[]} $groups
 */
function trax_mail_owner_digest(array $groups, string $day): bool
{
    $section = static function (string $title, array $lines): string {
        if ($lines === []) {
            return "{$title}: none\n";
        }
        return "{$title} (" . count($lines) . "):\n" . implode("\n", $lines) . "\n";
    };

    $mail = trax_mail_render('ownerDigest', [
        'day'                  => $day,
        'overdueSection'       => $section('Overdue', $groups['overdue'] ?? []),
        'dueTodaySection'      => $section('Due today', $groups['dueToday'] ?? []),
        'startingTodaySection' => $section('Reservations starting today', $groups['startingToday'] ?? []),
        'overdueCount'         => (string)count($groups['overdue'] ?? []),
        'dueTodayCount'        => (string)count($groups['dueToday'] ?? []),
        'startingTodayCount'   => (string)count($groups['startingToday'] ?? []),
    ]);

    return trax_send_mail(
        [trax_owner_email()],
        $mail['subject'],
        $mail['body']
    );
}

/** Lost-item report from the public /r/ page. */
function trax_mail_lost_report(?array $asset, string $name, string $phone, string $email, string $message): bool
{
    $assetLabel = $asset !== null
        ? "{$asset['name']} (ID {$asset['id']})"
        : 'Unknown Asset';

    $mail = trax_mail_render('lostReport', [
        'finderName'  => $name,
        'finderPhone' => $phone,
        'finderEmail' => $email,
        'asset'       => $assetLabel,
        'message'     => $message,
    ]);

    return trax_send_mail(
        [trax_owner_email()],
        $mail['subject'],
        $mail['body'],
        trax_report_from_email()
    );
}
