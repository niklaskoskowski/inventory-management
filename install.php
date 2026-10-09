<?php
/**
 * The installer.
 *
 *   GET  install.php    the wizard, at whatever step the session is on
 *   POST install.php    one step's answers, then Back / Next / Install
 *
 * Seven steps, English only, no JavaScript framework: this file runs on a host
 * nobody has configured yet, so it depends on as little as possible — bootstrap
 * and public.css for the look, a handful of inline lines for the colour picker.
 *
 * The wizard is reachable only while trax_is_installed() is false. The instant
 * users.json holds an operator this file answers 403 and nothing here can be
 * reached again: an installer that stays open is a way to overwrite a running
 * deployment's settings from the outside.
 *
 * Every step re-validates on the server (lib/install.php), and step 7 validates
 * the whole collected state again before it writes anything — the session is
 * state the browser gets to influence the shape of, so the last check is the
 * one that counts. See trax_install_commit() for the write order and how it is
 * rolled back.
 */

declare(strict_types=1);

require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/auth.php';
require_once __DIR__ . '/lib/store.php';
require_once __DIR__ . '/lib/install.php';

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

/** Escapes for HTML text and attributes. Mirrors admin_e() / esc() elsewhere. */
function install_e(mixed $value): string
{
    return htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

if (trax_is_installed()) {
    http_response_code(403);
    header('Content-Type: text/html; charset=utf-8');
    $brandColor = (string)trax_setting('branding.brandColor', '#1F2937');
    ?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>Already installed</title>
<link rel="stylesheet" href="public.css">
<link rel="stylesheet" href="vendor/bootstrap-icons.css">
<style>:root { --trax-brand: <?php echo install_e($brandColor); ?>; }</style>
</head>
<body class="pub-page pub-solo">
  <main class="pub-solo-main">
    <div class="pub-card">
      <div class="pub-solo-head">
        <div class="pub-appicon" aria-hidden="true"><i class="bi bi-check-lg"></i></div>
        <h1 class="pub-solo-title">Already installed</h1>
        <p class="pub-solo-sub">The installer is closed. To start over, delete <code>users.json</code>
           and <code>lib/config.local.php</code> — <code>data.json</code> stays.</p>
      </div>
      <a class="pub-btn pub-btn-primary" href="login.php">Sign in</a>
    </div>
  </main>
</body>
</html>
    <?php
    exit;
}

trax_ensure_session();

$state  = trax_install_state();
$errors = [];
$notice = '';
$done   = null;   // list of written paths, set once the install has happened

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $submitted = trax_clamp_int($_POST['step'] ?? null, 1, TRAX_INSTALL_STEPS, 1);
    $action    = (string)($_POST['action'] ?? 'next');
    $reached   = trax_clamp_int($state['maxStep'] ?? 0, 0, TRAX_INSTALL_STEPS, 0);

    // The steps are a sequence, not a menu. Posting step 5 while the session has
    // only got through step 1 would run step 5's validation over defaults for
    // everything in between and call the result an answer — so the only step
    // numbers accepted are the ones already reached, plus the next one. Anything
    // further is bounced back to where the operator actually is, with nothing
    // written to the session: 303 so the browser turns it into a GET and a
    // reload cannot repeat the POST.
    if ($submitted > $reached + 1) {
        header('Location: install.php', true, 303);
        exit;
    }

    if (!trax_csrf_verify((string)($_POST['csrf'] ?? ''))) {
        // Same wording as login.php: a stale form is a stale form, not an attack.
        $errors[] = 'This form expired. Please try again.';
        $state['step'] = $submitted;
    } elseif ($action === 'back') {
        // Going back never validates — the point of Back is to escape a form
        // that will not validate.
        $state['step'] = max(1, $submitted - 1);
    } elseif ($action === 'restart') {
        trax_install_reset();
        $state = trax_install_state();
        $notice = 'Starting over. Nothing had been written yet.';
    } elseif ($action === 'regenerate') {
        trax_install_validate(5, $_POST, $_FILES, $state);
        $state['cronSecret'] = trax_install_new_secret();
        $state['step']       = 5;
        $notice              = 'A new secret was generated. It is not saved until you finish the install.';
    } else {
        $errors = trax_install_validate($submitted, $_POST, $_FILES, $state);

        if ($errors === [] && $submitted < 6) {
            $state['step']    = $submitted + 1;
            // Only a step that actually validated counts as reached, so the gate
            // above can never be widened by a step that errored out.
            $state['maxStep'] = max($reached, $submitted);
        } elseif ($errors === [] && $submitted === 6) {
            // The commit. Everything is re-checked first, because the session
            // could have been assembled in any order.
            $errors = trax_install_validate_all($state);
            if ($errors === []) {
                try {
                    $done          = trax_install_commit($state);
                    $state['step'] = 7;
                } catch (Throwable $e) {
                    $errors[]      = $e->getMessage();
                    $state['step'] = 6;
                }
            } else {
                $state['step'] = 6;
            }
        } else {
            $state['step'] = $submitted;
        }
    }

    // The password never goes back into the session once it has been used.
    if ($done !== null) {
        $state['password'] = '';
    }
    trax_install_save($state);

    if ($done !== null) {
        // The wizard is over; the session only holds answers now, and the next
        // request to this file gets the 403 above.
        $doneState = $state;
        trax_install_reset();
    }
}

$step = trax_clamp_int($state['step'] ?? 1, 1, TRAX_INSTALL_STEPS, 1);
if ($done !== null) {
    $state = $doneState;
    $step  = 7;
}

$csrf         = trax_csrf_token();
$requirements = $step === 1 ? trax_install_requirements() : [];
$blocked      = $step === 1 && trax_install_blocked($requirements);

$titles = [
    1 => 'Before we start',
    2 => 'Organisation & branding',
    3 => 'Administrator account',
    4 => 'Site & mail',
    5 => 'Automation',
    6 => 'Demo data & review',
    7 => 'Done',
];
$shortTitles = [
    1 => 'Checks',
    2 => 'Branding',
    3 => 'Account',
    4 => 'Site',
    5 => 'Cron',
    6 => 'Review',
    7 => 'Done',
];

$localePresets   = ['en-US' => 'English (US)', 'en-GB' => 'English (UK)', 'de-DE' => 'German (Germany)', 'fr-FR' => 'French (France)'];
$currencyPresets = ['EUR' => 'EUR — Euro', 'USD' => 'USD — US dollar', 'GBP' => 'GBP — Pound sterling', 'CHF' => 'CHF — Swiss franc'];
$formatPresets   = [
    'Y-m-d H:i'  => date('Y-m-d H:i') . '  (ISO)',
    'd.m.Y H:i'  => date('d.m.Y H:i') . '  (day.month.year)',
    'd/m/Y H:i'  => date('d/m/Y H:i') . '  (day/month/year)',
    'm/d/Y g:ia' => date('m/d/Y g:ia') . '  (month/day/year)',
    'j M Y H:i'  => date('j M Y H:i') . '  (spelled month)',
];

$cronUrl = trax_install_cron_url($state);

header('Content-Type: text/html; charset=utf-8');
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>Install · Step <?php echo $step; ?> of <?php echo TRAX_INSTALL_STEPS; ?></title>
<!-- public.css carries the whole look, including the installer (ins-*). -->
<link rel="stylesheet" href="public.css">
<link rel="stylesheet" href="vendor/bootstrap-icons.css">
<style>:root { --trax-brand: <?php echo install_e(trax_hex_color($state['brandColor']) ?? '#1F2937'); ?>; }</style>
</head>
<body class="pub-page pub-solo">
  <main class="pub-solo-main pub-solo-wide" data-step="<?php echo $step; ?>">
    <div class="pub-card">

      <ol class="ins-steps" aria-hidden="true">
        <?php for ($i = 1; $i <= TRAX_INSTALL_STEPS; $i++): ?>
          <li class="<?php echo $i === $step ? 'is-now' : ($i < $step ? 'is-past' : ''); ?>"
              title="<?php echo install_e($shortTitles[$i]); ?>"></li>
        <?php endfor; ?>
      </ol>
      <p class="ins-stepno">Step <?php echo $step; ?> of <?php echo TRAX_INSTALL_STEPS; ?> · <?php echo install_e($shortTitles[$step]); ?></p>

      <h1 class="ins-title"><?php echo install_e($titles[$step]); ?></h1>

      <?php if ($notice !== ''): ?>
        <div class="pub-flash pub-flash-info"><i class="bi bi-info-circle-fill" aria-hidden="true"></i><span><?php echo install_e($notice); ?></span></div>
      <?php endif; ?>

      <?php if ($errors !== []): ?>
        <div class="pub-flash pub-flash-bad" role="alert">
          <i class="bi bi-exclamation-circle-fill" aria-hidden="true"></i>
          <div>
          <?php foreach ($errors as $message): ?>
            <div><?php echo install_e($message); ?></div>
          <?php endforeach; ?>
          </div>
        </div>
      <?php endif; ?>

<?php if ($step === 7): ?>

      <p class="ins-lead">All set. Sign in and add your gear.</p>

      <?php if ($state['authMode'] === 'external'): ?>
        <p class="pub-note">Sign-in runs through <code><?php echo install_e($state['authInclude']); ?></code>.
           <b><?php echo install_e($state['username']); ?></b> stays as a fallback via <code>login.php</code>
           if the include goes missing.</p>
      <?php else: ?>
        <p class="pub-note">Built-in login. Switch under Settings &rarr; Authentication.</p>
      <?php endif; ?>

      <div class="pub-actions" style="margin-top:1.25rem">
        <a class="pub-btn pub-btn-primary" href="<?php echo $state['authMode'] === 'external' ? 'admin.php' : 'login.php'; ?>">Sign in as <?php echo install_e($state['username']); ?></a>
      </div>

      <h2 class="ins-section">Files written</h2>
      <ul class="ins-req">
        <?php foreach (($done ?? []) as $path): ?>
          <li><span class="ins-mark ins-ok">&check;</span><?php echo install_e($path); ?></li>
        <?php endforeach; ?>
      </ul>

      <h2 class="ins-section">Reminders (cron)</h2>
      <?php if ($cronUrl !== ''): ?>
        <p class="pub-label">Call every 15 minutes:</p>
        <code class="ins-pre"><?php echo install_e($cronUrl); ?></code>
      <?php else: ?>
        <p class="pub-note pub-note-bad">No cron secret, so the web trigger is off. Use the crontab line.</p>
      <?php endif; ?>
      <p class="pub-label" style="margin-top:0.75rem">Or as a crontab line:</p>
      <code class="ins-pre"><?php echo install_e(trax_install_crontab_line()); ?></code>

      <h2 class="ins-section">Two last things</h2>
      <ul class="ins-req">
        <li><span class="ins-mark ins-warn">!</span>
          <span><code>chmod 600 users.json</code> if your host allows it — it holds the password hashes.</span></li>
        <li><span class="ins-mark ins-warn">!</span>
          <span>You may delete <code>install.php</code>; it no longer runs.</span></li>
      </ul>

<?php else: ?>

      <form method="post" action="install.php" enctype="multipart/form-data" autocomplete="off">
        <input type="hidden" name="csrf" value="<?php echo install_e($csrf); ?>">
        <input type="hidden" name="step" value="<?php echo $step; ?>">

<?php if ($step === 1): ?>

        <p class="ins-lead">Writes settings, an admin account and the upload folders. Nothing is written until the last step.</p>

        <ul class="ins-req">
          <?php foreach ($requirements as $row): ?>
            <li>
              <?php if ($row['ok']): ?>
                <span class="ins-mark ins-ok">&check;</span>
              <?php elseif ($row['hard']): ?>
                <span class="ins-mark ins-bad">&times;</span>
              <?php else: ?>
                <span class="ins-mark ins-warn">!</span>
              <?php endif; ?>
              <span>
                <?php echo install_e($row['label']); ?>
                <?php if ($row['detail'] !== ''): ?>
                  <span class="ins-detail"><?php echo install_e($row['detail']); ?></span>
                <?php endif; ?>
              </span>
            </li>
          <?php endforeach; ?>
        </ul>

        <?php if ($blocked): ?>
          <p class="pub-note pub-note-bad">Fix the items marked &times;, then reload. The others are optional.</p>
        <?php endif; ?>

<?php elseif ($step === 2): ?>

        <p class="ins-lead">Shown on screen and on labels. Changeable later in Settings.</p>

        <div class="ins-cols">
          <label class="pub-field">
            <span class="pub-label">Application name</span>
            <input class="pub-input" type="text" name="appName" maxlength="60" required
                   value="<?php echo install_e($state['appName']); ?>">
          </label>
          <label class="pub-field">
            <span class="pub-label">Organisation <span class="pub-optional">optional</span></span>
            <input class="pub-input" type="text" name="orgName" maxlength="120"
                   value="<?php echo install_e($state['orgName']); ?>">
            <span class="pub-hint">Printed on labels.</span>
          </label>
        </div>

        <div class="ins-cols">
          <div>
            <span class="pub-label">Brand colour</span>
            <div class="ins-colour">
              <input type="color" id="ins-colour-pick" value="<?php echo install_e($state['brandColor']); ?>"
                     aria-label="Brand colour picker">
              <input class="pub-input" type="text" name="brandColor" id="ins-colour-hex"
                     maxlength="7" pattern="#[0-9A-Fa-f]{6}" aria-label="Brand colour"
                     value="<?php echo install_e($state['brandColor']); ?>">
            </div>
          </div>
          <label class="pub-field">
            <span class="pub-label">Label heading</span>
            <input class="pub-input" type="text" name="labelHeading" maxlength="40"
                   value="<?php echo install_e($state['labelHeading']); ?>">
            <span class="pub-hint">Above the organisation on labels.</span>
          </label>
        </div>

        <label class="pub-field">
          <span class="pub-label">Logo <span class="pub-optional">optional</span></span>
          <input class="pub-input" type="file" name="logo" accept="image/png,image/jpeg,image/webp">
          <span class="pub-hint">PNG, JPEG or WebP, max 2 MB. Also makes the favicon.</span>
        </label>

        <?php if ($state['logoClient'] !== ''): ?>
          <label class="pub-check">
            <input type="checkbox" name="removeLogo" value="1">
            <span>Remove uploaded logo (<?php echo install_e($state['logoClient']); ?>)</span>
          </label>
        <?php endif; ?>

        <label class="pub-field">
          <span class="pub-label">WhatsApp number <span class="pub-optional">optional</span></span>
          <input class="pub-input" type="text" name="whatsapp" maxlength="40"
                 placeholder="+49 172 1234567"
                 value="<?php echo install_e($state['whatsapp']); ?>">
          <span class="pub-hint">Adds a WhatsApp button to public asset pages.</span>
        </label>

<?php elseif ($step === 3): ?>

        <p class="ins-lead">How people sign in.</p>

        <label class="pub-check">
          <input type="radio" name="authMode" value="builtin" id="ins-auth-builtin"
                 <?php echo $state['authMode'] === 'external' ? '' : 'checked'; ?>>
          <span><b>Built-in login</b> (recommended)<span class="ins-detail">Accounts live in this app.</span></span>
        </label>

        <label class="pub-check">
          <input type="radio" name="authMode" value="external" id="ins-auth-external"
                 <?php echo $state['authMode'] === 'external' ? 'checked' : ''; ?>>
          <span><b>External auth include</b><span class="ins-detail">An existing PHP login on this host.</span></span>
        </label>

        <div id="ins-auth-fields" class="ins-auth-fields">
          <label class="pub-field">
            <span class="pub-label">Path to the include</span>
            <input class="pub-input" type="text" name="authInclude" maxlength="512"
                   placeholder="/var/www/example.com/auth/check_auth.php"
                   value="<?php echo install_e($state['authInclude']); ?>">
            <span class="pub-hint">Absolute path; sets <code>$_SESSION['trax_user']</code>. See README.md.</span>
          </label>

          <label class="pub-field">
            <span class="pub-label">Sign-out URL <span class="pub-optional">optional</span></span>
            <input class="pub-input" type="text" name="authLogoutUrl" maxlength="512"
                   placeholder="https://example.com/logout"
                   value="<?php echo install_e($state['authLogoutUrl']); ?>">
          </label>
        </div>

        <h2 class="ins-section">Administrator</h2>
        <p class="pub-hint" style="margin:-0.25rem 0 1rem">Needed in both modes — it is the fallback if an include breaks.</p>

        <div class="ins-cols">
          <label class="pub-field">
            <span class="pub-label">Username</span>
            <input class="pub-input" type="text" name="username" maxlength="64" required
                   autocomplete="username" autocapitalize="none" spellcheck="false"
                   value="<?php echo install_e($state['username']); ?>">
            <span class="pub-hint">Letters, digits, . _ -</span>
          </label>
          <label class="pub-field">
            <span class="pub-label">Email</span>
            <input class="pub-input" type="email" name="email" maxlength="254" required
                   autocomplete="email" value="<?php echo install_e($state['email']); ?>">
          </label>
        </div>

        <div class="ins-cols">
          <label class="pub-field">
            <span class="pub-label">Password</span>
            <input class="pub-input" type="password" name="password" required
                   autocomplete="new-password" minlength="<?php echo TRAX_MIN_PASSWORD_LEN; ?>">
            <span class="pub-hint">At least <?php echo TRAX_MIN_PASSWORD_LEN; ?> characters.</span>
          </label>
          <label class="pub-field">
            <span class="pub-label">Repeat password</span>
            <input class="pub-input" type="password" name="password2" required
                   autocomplete="new-password" minlength="<?php echo TRAX_MIN_PASSWORD_LEN; ?>">
            <span class="pub-hint">There is no reset mail.</span>
          </label>
        </div>

<?php elseif ($step === 4): ?>

        <p class="ins-lead">Location, formats and mail. Mail fields are optional.</p>

        <div class="ins-cols">
          <label class="pub-field">
            <span class="pub-label">Public path</span>
            <input class="pub-input" type="text" name="publicPath" maxlength="120" required
                   value="<?php echo install_e($state['publicPath']); ?>">
            <span class="pub-hint">"/" or "/assets/". Used in QR labels.</span>
          </label>
          <label class="pub-field">
            <span class="pub-label">Timezone</span>
            <select class="pub-input" name="timezone" required>
              <?php foreach (DateTimeZone::listIdentifiers() as $zone): ?>
                <option value="<?php echo install_e($zone); ?>"
                  <?php echo $zone === $state['timezone'] ? 'selected' : ''; ?>>
                  <?php echo install_e($zone); ?>
                </option>
              <?php endforeach; ?>
            </select>
          </label>
        </div>

        <div class="ins-cols">
          <div>
            <label class="pub-field">
              <span class="pub-label">Locale</span>
              <select class="pub-input" name="locale">
                <?php foreach ($localePresets as $tag => $label): ?>
                  <option value="<?php echo install_e($tag); ?>"
                    <?php echo $tag === $state['locale'] ? 'selected' : ''; ?>>
                    <?php echo install_e($label); ?> — <?php echo install_e($tag); ?>
                  </option>
                <?php endforeach; ?>
                <option value="__other" <?php echo isset($localePresets[$state['locale']]) ? '' : 'selected'; ?>>
                  Other (type it below)
                </option>
              </select>
            </label>
            <label class="pub-field">
              <span class="pub-label">Other locale</span>
              <input class="pub-input" type="text" name="localeOther" maxlength="35" placeholder="pt-BR"
                     value="<?php echo isset($localePresets[$state['locale']]) ? '' : install_e($state['locale']); ?>">
            </label>
          </div>
          <div>
            <label class="pub-field">
              <span class="pub-label">Currency</span>
              <select class="pub-input" name="currency">
                <?php foreach ($currencyPresets as $code => $label): ?>
                  <option value="<?php echo install_e($code); ?>"
                    <?php echo $code === $state['currency'] ? 'selected' : ''; ?>>
                    <?php echo install_e($label); ?>
                  </option>
                <?php endforeach; ?>
                <option value="__other" <?php echo isset($currencyPresets[$state['currency']]) ? '' : 'selected'; ?>>
                  Other (type it below)
                </option>
              </select>
            </label>
            <label class="pub-field">
              <span class="pub-label">Other currency</span>
              <input class="pub-input" type="text" name="currencyOther" maxlength="8" placeholder="SEK"
                     value="<?php echo isset($currencyPresets[$state['currency']]) ? '' : install_e($state['currency']); ?>">
            </label>
          </div>
        </div>

        <div class="ins-cols">
          <label class="pub-field">
            <span class="pub-label">Date format</span>
            <select class="pub-input" name="dateFormat">
              <?php foreach ($formatPresets as $format => $sample): ?>
                <option value="<?php echo install_e($format); ?>"
                  <?php echo $format === $state['dateFormat'] ? 'selected' : ''; ?>>
                  <?php echo install_e($sample); ?>
                </option>
              <?php endforeach; ?>
              <option value="__other" <?php echo isset($formatPresets[$state['dateFormat']]) ? '' : 'selected'; ?>>
                Other (type it below)
              </option>
            </select>
          </label>
          <label class="pub-field">
            <span class="pub-label">Other date format</span>
            <input class="pub-input" type="text" name="dateFormatOther" maxlength="40" placeholder="D, d M Y H:i"
                   value="<?php echo isset($formatPresets[$state['dateFormat']]) ? '' : install_e($state['dateFormat']); ?>">
            <span class="pub-hint">PHP <code>date()</code> format.</span>
          </label>
        </div>

        <div class="ins-cols ins-cols-3">
          <label class="pub-field">
            <span class="pub-label">Owner address</span>
            <input class="pub-input" type="email" name="ownerEmail" maxlength="254"
                   value="<?php echo install_e($state['ownerEmail']); ?>">
            <span class="pub-hint">Copies and lost reports.</span>
          </label>
          <label class="pub-field">
            <span class="pub-label">Sender address</span>
            <input class="pub-input" type="email" name="fromEmail" maxlength="254"
                   value="<?php echo install_e($state['fromEmail']); ?>">
            <span class="pub-hint">From of customer mail.</span>
          </label>
          <label class="pub-field">
            <span class="pub-label">Report sender</span>
            <input class="pub-input" type="email" name="reportFromEmail" maxlength="254"
                   value="<?php echo install_e($state['reportFromEmail']); ?>">
            <span class="pub-hint">From of lost reports.</span>
          </label>
        </div>

<?php elseif ($step === 5): ?>

        <p class="ins-lead">cron.php sends reminders and a daily digest. Trigger it from your host's cron.</p>

        <label class="pub-field">
          <span class="pub-label">Cron secret</span>
          <input class="pub-input" type="text" name="cronSecret" maxlength="200" value="<?php echo install_e($state['cronSecret']); ?>">
          <span class="pub-hint">Empty turns the web trigger off.</span>
        </label>

        <button class="pub-btn pub-btn-tinted pub-btn-sm" type="submit" name="action" value="regenerate">
          Regenerate secret
        </button>

        <?php if ($cronUrl !== ''): ?>
          <p class="pub-label" style="margin-top:1.25rem">Web cron, every 15 minutes:</p>
          <code class="ins-pre"><?php echo install_e($cronUrl); ?></code>
        <?php endif; ?>
        <p class="pub-label" style="margin-top:0.75rem">Or a crontab line:</p>
        <code class="ins-pre"><?php echo install_e(trax_install_crontab_line()); ?></code>

        <h2 class="ins-section">Loans</h2>
        <div class="ins-cols ins-cols-4">
          <label class="pub-field">
            <span class="pub-label">Loan days</span>
            <input class="pub-input" type="number" name="loanDays" min="1" max="365"
                   value="<?php echo (int)$state['loanDays']; ?>">
          </label>
          <label class="pub-field">
            <span class="pub-label">Due hour</span>
            <input class="pub-input" type="number" name="dueHour" min="0" max="23"
                   value="<?php echo (int)$state['dueHour']; ?>">
          </label>
          <label class="pub-field">
            <span class="pub-label">Due-soon hours</span>
            <input class="pub-input" type="number" name="dueSoonHours" min="1" max="168"
                   value="<?php echo (int)$state['dueSoonHours']; ?>">
          </label>
          <label class="pub-field">
            <span class="pub-label">Overdue repeat</span>
            <input class="pub-input" type="number" name="overdueRepeatDays" min="1" max="90"
                   value="<?php echo (int)$state['overdueRepeatDays']; ?>">
          </label>
        </div>
        <p class="pub-hint">Defaults suit most setups.</p>

<?php elseif ($step === 6): ?>

        <p class="ins-lead">Last look. Nothing is written yet.</p>

        <label class="pub-check">
          <input type="checkbox" name="demoData" value="1" <?php echo $state['demoData'] ? 'checked' : ''; ?>>
          <span>Load demo data<span class="ins-detail">Eight assets, one kit, one reservation.</span></span>
        </label>

        <dl class="ins-review">
          <div><dt>Application</dt><dd><?php echo install_e($state['appName']); ?></dd></div>
          <div><dt>Organisation</dt><dd><?php echo install_e($state['orgName'] !== '' ? $state['orgName'] : '—'); ?></dd></div>
          <div><dt>Brand colour</dt><dd><?php echo install_e($state['brandColor']); ?></dd></div>
          <div><dt>Logo</dt><dd><?php echo install_e($state['logoClient'] !== '' ? $state['logoClient'] . ' → logo.png' : 'none'); ?></dd></div>
          <div><dt>Sign-in</dt><dd><?php
            echo $state['authMode'] === 'external'
              ? 'External include — ' . install_e($state['authInclude'])
              : 'Built-in login';
          ?></dd></div>
          <div><dt>Administrator</dt><dd><?php echo install_e($state['username']); ?> &lt;<?php echo install_e($state['email']); ?>&gt;<?php
            echo $state['authMode'] === 'external' ? ' (fallback)' : '';
          ?></dd></div>
          <div><dt>Public path</dt><dd><?php echo install_e($state['publicPath']); ?></dd></div>
          <div><dt>Timezone</dt><dd><?php echo install_e($state['timezone']); ?></dd></div>
          <div><dt>Locale / currency</dt><dd><?php echo install_e($state['locale']); ?> / <?php echo install_e($state['currency']); ?></dd></div>
          <div><dt>Date format</dt><dd><?php echo install_e($state['dateFormat']); ?></dd></div>
          <div><dt>Owner address</dt><dd><?php echo install_e($state['ownerEmail'] !== '' ? $state['ownerEmail'] : '—'); ?></dd></div>
          <div><dt>Sender address</dt><dd><?php echo install_e($state['fromEmail'] !== '' ? $state['fromEmail'] : '—'); ?></dd></div>
          <div><dt>Report sender</dt><dd><?php echo install_e($state['reportFromEmail'] !== '' ? $state['reportFromEmail'] : '—'); ?></dd></div>
          <div><dt>WhatsApp</dt><dd><?php echo install_e($state['whatsapp'] !== '' ? $state['whatsapp'] : '—'); ?></dd></div>
          <div><dt>Cron trigger</dt><dd><?php echo $cronUrl !== '' ? 'secret set' : 'web trigger off'; ?></dd></div>
          <div><dt>Loan default</dt><dd><?php echo (int)$state['loanDays']; ?> days, due at <?php echo (int)$state['dueHour']; ?>:00</dd></div>
        </dl>

        <p class="pub-hint">Writes lib/config.local.php, data.json,
           <?php echo $state['logoClient'] !== '' ? 'logo.png, favicon.png, ' : ''; ?>users.json — all or nothing.</p>

<?php endif; ?>

        <div class="ins-actions">
          <?php if ($step > 1): ?>
            <button class="pub-btn pub-btn-ghost" type="submit" name="action" value="back">Back</button>
          <?php endif; ?>
          <button class="pub-btn pub-btn-primary" type="submit" name="action" value="next"
                  <?php echo $blocked ? 'disabled' : ''; ?>>
            <?php echo $step === 6 ? 'Install' : 'Next'; ?>
          </button>
        </div>
      </form>

      <?php if ($step > 1): ?>
        <form method="post" action="install.php" class="ins-restart">
          <input type="hidden" name="csrf" value="<?php echo install_e($csrf); ?>">
          <input type="hidden" name="step" value="<?php echo $step; ?>">
          <button class="pub-btn pub-btn-quiet" type="submit" name="action" value="restart">
            Start over
          </button>
        </form>
      <?php endif; ?>

<?php endif; ?>

    </div>
  </main>

<script>
// The only script in the wizard: keep the colour swatch and the hex field in
// step. Everything else works with JavaScript switched off.
(function () {
  var pick = document.getElementById('ins-colour-pick');
  var hex  = document.getElementById('ins-colour-hex');
  if (!pick || !hex) { return; }
  pick.addEventListener('input', function () { hex.value = pick.value.toUpperCase(); });
  hex.addEventListener('input', function () {
    if (/^#[0-9A-Fa-f]{6}$/.test(hex.value)) { pick.value = hex.value; }
  });
})();

// Step 3: hide the external-auth fields while the built-in login is selected.
// Progressive enhancement only — with JavaScript off both are simply visible,
// and the server ignores them unless the radio says "external".
(function () {
  var builtin  = document.getElementById('ins-auth-builtin');
  var external = document.getElementById('ins-auth-external');
  var fields   = document.getElementById('ins-auth-fields');
  if (!builtin || !external || !fields) { return; }
  var sync = function () { fields.style.display = external.checked ? '' : 'none'; };
  builtin.addEventListener('change', sync);
  external.addEventListener('change', sync);
  sync();
})();
</script>
</body>
</html>
