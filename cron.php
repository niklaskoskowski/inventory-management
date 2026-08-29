<?php
/**
 * The reminder cron.
 *
 *   php cron.php [--dry-run]                      (from a crontab, hourly)
 *   GET /cron.php?secret=<cron.secret>[&dry=1]    (shared hosting with only wget)
 *
 * Sends, per run:
 *   - a due-soon reminder, once per booking, cron.dueSoonHours before it is due
 *   - an overdue reminder, once when it goes overdue and then every
 *     cron.overdueRepeatDays for as long as it stays out
 *   - the operator's digest, at most once per calendar day
 *
 * It deliberately does NOT include api.php. That file is an HTTP endpoint: it
 * calls trax_require_login() at the top, which under CLI has no session to find
 * and would answer this run with a 401 before a line of it ran. The store and
 * the mailer are the whole dependency.
 *
 * Re-running is safe: what has already been said is recorded on the booking
 * (`notified`) and in `cronState`, so an hourly cron, a double-fired cron and a
 * curl by a curious operator all send the same nothing.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/store.php';
require_once __DIR__ . '/lib/mailer.php';

$traxIsCli = PHP_SAPI === 'cli';

// ---------------------------------------------------------------------------
// Access
//
// CLI is trusted: getting there already means shell access on the host. HTTP is
// not, so it needs the shared secret — and an unset secret refuses everything
// rather than opening the endpoint up. Both refusals answer identically, so the
// response never says which of the two it was.
// ---------------------------------------------------------------------------

if (!$traxIsCli) {
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Robots-Tag: noindex, nofollow');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');

    $configured = trax_str(trax_setting('cron.secret', ''), 200);
    $given      = is_string($_GET['secret'] ?? null) ? trax_str($_GET['secret'], 200) : '';

    if ($configured === '' || !hash_equals($configured, $given)) {
        http_response_code(403);
        echo "403 Forbidden\n";
        exit(1);
    }
}

$traxDryRun = $traxIsCli
    ? in_array('--dry-run', (array)($_SERVER['argv'] ?? []), true)
    : (($_GET['dry'] ?? '') === '1');

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** One digest line: "- #12 Max M — due 01.09.2026 12:00 (2 items)". */
function trax_cron_digest_line(array $booking, string $label, ?int $ts): string
{
    $name  = $booking['customerName'] !== '' ? $booking['customerName'] : 'Unknown customer';
    $when  = $ts === null ? 'unknown' : trax_format_de($ts);
    $count = count($booking['items']);

    return "- #{$booking['id']} {$name} — {$label} {$when} ({$count} item" . ($count === 1 ? '' : 's') . ')';
}

/**
 * Decides what this run would send. Pure: it reads the data it is handed and
 * touches neither the disk nor the MTA, which is exactly what --dry-run needs.
 *
 * @return array{dueSoon:array, overdue:array, digest:array, scanned:int}
 */
function trax_cron_plan(array $data, int $now): array
{
    $graceDays    = (int)trax_setting('defaults.overdueGraceDays', 0);
    $dueSoonHours = (int)trax_setting('cron.dueSoonHours', 24);
    $repeatDays   = (int)trax_setting('cron.overdueRepeatDays', 7);
    $today        = date('Y-m-d', $now);

    $dueSoon = [];
    $overdue = [];
    $digest  = ['overdue' => [], 'dueToday' => [], 'startingToday' => []];
    $scanned = 0;

    foreach ($data['bookings'] as $booking) {
        // RETURNED and CANCELLED are done with; nobody gets reminded about them.
        if ($booking['status'] !== 'OPEN') {
            continue;
        }
        $scanned++;

        $notified = $booking['notified'];
        $dueTs    = $booking['dueAt'] === null ? null : trax_parse_datetime($booking['dueAt']);
        $startTs  = $booking['startAt'] === null ? null : trax_parse_datetime($booking['startAt']);
        $isOverdue = $dueTs !== null && ($dueTs + $graceDays * 86400) < $now;

        if ($isOverdue) {
            $digest['overdue'][] = trax_cron_digest_line($booking, 'due', $dueTs);
        } elseif ($dueTs !== null && date('Y-m-d', $dueTs) === $today) {
            $digest['dueToday'][] = trax_cron_digest_line($booking, 'due', $dueTs);
        }
        if ($booking['kind'] === 'reservation' && $startTs !== null && date('Y-m-d', $startTs) === $today) {
            $digest['startingToday'][] = trax_cron_digest_line($booking, 'starts', $startTs);
        }

        if ($dueTs === null) {
            continue;   // nothing to remind against
        }

        // Due soon: still in the future, inside the window, and never yet said.
        if (
            $notified['dueSoonAt'] === null
            && $dueTs >= $now
            && $dueTs <= $now + $dueSoonHours * 3600
        ) {
            $dueSoon[] = ['booking' => $booking, 'dueTs' => $dueTs];
        }

        if ($isOverdue) {
            $lastTs = $notified['overdueAt'] === null ? null : trax_parse_datetime($notified['overdueAt']);
            // Once when it first goes overdue, then every overdueRepeatDays.
            if ($lastTs === null || $lastTs + $repeatDays * 86400 <= $now) {
                $overdue[] = [
                    'booking' => $booking,
                    'dueTs'   => $dueTs,
                    'days'    => max(1, (int)floor(($now - $dueTs) / 86400)),
                ];
            }
        }
    }

    return ['dueSoon' => $dueSoon, 'overdue' => $overdue, 'digest' => $digest, 'scanned' => $scanned];
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
    $now   = time();
    $today = date('Y-m-d', $now);
    $iso   = gmdate('Y-m-d\TH:i:s.000\Z', $now);

    // Read outside the lock, and send outside it too: holding the exclusive
    // write lock across mail() would stall every operator in the web UI for as
    // long as the MTA felt like taking.
    $data = trax_read_data();
    $plan = trax_cron_plan($data, $now);

    $wantDueSoon = (bool)trax_setting('email.sendDueSoon', true);
    $wantOverdue = (bool)trax_setting('email.sendOverdue', true);
    $wantDigest  = (bool)trax_setting('email.sendOwnerDigest', true);

    $digestHas   = $plan['digest']['overdue'] !== []
        || $plan['digest']['dueToday'] !== []
        || $plan['digest']['startingToday'] !== [];
    $digestDueToday = $wantDigest
        && $digestHas
        && ($data['cronState']['lastDigestOn'] ?? null) !== $today;

    $stamps      = [];      // bookingId => what to record
    $preview     = [];      // --dry-run: one line per mail that would go out
    $sentDueSoon = 0;
    $sentOverdue = 0;
    $failed      = 0;
    $digestSent  = false;

    if ($wantDueSoon) {
        foreach ($plan['dueSoon'] as $item) {
            if ($traxDryRun) {
                $preview[] = "  would send due-soon to {$item['booking']['customerEmail']}"
                    . " (booking #{$item['booking']['id']}, due " . trax_format_de($item['dueTs']) . ')';
                continue;
            }
            if (trax_mail_due_soon($item['booking'], trax_format_de($item['dueTs']))) {
                $stamps[$item['booking']['id']]['dueSoonAt'] = $iso;
                $sentDueSoon++;
            } else {
                // Not stamped: an unsent reminder must still be pending, so the
                // next run tries again rather than going quiet forever.
                $failed++;
            }
        }
    }

    if ($wantOverdue) {
        foreach ($plan['overdue'] as $item) {
            if ($traxDryRun) {
                $preview[] = "  would send overdue to {$item['booking']['customerEmail']}"
                    . " (booking #{$item['booking']['id']}, {$item['days']} day(s) over)";
                continue;
            }
            if (trax_mail_overdue($item['booking'], trax_format_de($item['dueTs']), $item['days'])) {
                $stamps[$item['booking']['id']]['overdueAt'] = $iso;
                $sentOverdue++;
            } else {
                $failed++;
            }
        }
    }

    if ($digestDueToday && !$traxDryRun) {
        $digestSent = trax_mail_owner_digest($plan['digest'], $today);
        if (!$digestSent) {
            $failed++;
        }
    }

    // One write, after all the sending, holding the lock for as short as it takes.
    if (!$traxDryRun) {
        trax_mutate(null, static function (array &$data, array &$checkouts) use ($stamps, $iso, $today, $digestSent): array {
            foreach ($stamps as $bookingId => $stamp) {
                trax_update_booking($data, (int)$bookingId, static function (array $booking) use ($stamp): array {
                    if (isset($stamp['dueSoonAt'])) {
                        $booking['notified']['dueSoonAt'] = $stamp['dueSoonAt'];
                    }
                    if (isset($stamp['overdueAt'])) {
                        $booking['notified']['overdueAt']     = $stamp['overdueAt'];
                        $booking['notified']['overdueCount'] += 1;
                    }
                    return $booking;
                });
            }

            $data['cronState']['lastRunAt'] = $iso;
            if ($digestSent) {
                $data['cronState']['lastDigestOn'] = $today;
            }
            return [];
        });
    }

    // --- Summary -----------------------------------------------------------

    $mode  = $traxDryRun ? ' (dry-run: nothing sent, nothing written)' : '';
    $lines = ['cron ' . $iso . $mode];
    $lines[] = "bookings scanned (OPEN): {$plan['scanned']}";
    $lines[] = $wantDueSoon
        ? 'due soon: ' . count($plan['dueSoon']) . " eligible, sent {$sentDueSoon}"
        : 'due soon: ' . count($plan['dueSoon']) . ' eligible, disabled (email.sendDueSoon off)';
    $lines[] = $wantOverdue
        ? 'overdue: ' . count($plan['overdue']) . " eligible, sent {$sentOverdue}"
        : 'overdue: ' . count($plan['overdue']) . ' eligible, disabled (email.sendOverdue off)';

    if (!$wantDigest) {
        $lines[] = 'digest: disabled (email.sendOwnerDigest off)';
    } elseif (!$digestHas) {
        $lines[] = 'digest: skipped (nothing to report)';
    } elseif (!$digestDueToday) {
        $lines[] = 'digest: skipped (already sent on ' . ($data['cronState']['lastDigestOn'] ?? '?') . ')';
    } else {
        $lines[] = 'digest: ' . ($traxDryRun ? 'would send' : ($digestSent ? 'sent' : 'FAILED'))
            . ' (' . count($plan['digest']['overdue']) . ' overdue, '
            . count($plan['digest']['dueToday']) . ' due today, '
            . count($plan['digest']['startingToday']) . ' starting today)';
    }
    if ($digestDueToday && $traxDryRun) {
        $preview[] = '  would send the digest to ' . trax_owner_email();
    }
    $lines[] = "failed sends: {$failed}";

    echo implode("\n", array_merge($lines, $preview)) . "\n";
    exit(0);
} catch (Throwable $e) {
    error_log('[app cron] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    if (!$traxIsCli) {
        http_response_code(500);
        echo "cron failed\n";
    } else {
        fwrite(STDERR, 'cron failed: ' . $e->getMessage() . "\n");
    }
    exit(1);
}
