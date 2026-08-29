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

    $headers = implode("\r\n", [
        'From: ' . $from,
        'Content-Type: text/plain; charset=UTF-8',
        'MIME-Version: 1.0',
        'X-Mailer: AssetTool',
    ]);

    // Subject is header data: encode it so UTF-8 survives and CR/LF cannot escape.
    $subject = mb_encode_mimeheader(trax_mail_header_safe($subject), 'UTF-8', 'B', "\r\n");

    // Body is not header data, but normalise line endings for broken MTAs.
    $body = str_replace(["\r\n", "\r"], "\n", $body);

    $sink = trax_mail_sink_path();
    if ($sink !== null) {
        return trax_mail_sink_write($sink, $recipients, $subject, $body, $headers);
    }

    return @mail(implode(', ', $recipients), $subject, $body, $headers);
}

/**
 * Renders "- [ID 4] – SD 128GB" lines for a set of checkout records.
 *
 * $withQty appends " ×3" where a record covers more than one unit. Off by
 * default: the checkout and reservation confirmations have never shown it and
 * this only exists for the check-in mail, which lists a whole return at once.
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
