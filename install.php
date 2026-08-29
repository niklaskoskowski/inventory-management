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
<html lang="en" data-bs-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Already installed</title>
<link rel="stylesheet" href="vendor/bootstrap.min.css">
<link rel="stylesheet" href="public.css">
<style>
  :root { --trax-brand: <?php echo install_e($brandColor); ?>; }
  .ins-btn { background: var(--trax-brand); color: var(--trax-brand-ink); }
</style>
</head>
<body>
<div class="pub-page">
  <main class="pub-main">
    <div class="pub-card">
      <h1 class="pub-title">Already installed</h1>
      <p class="pub-sub">This instance has an administrator, so the installer is closed.
         Deleting install.php is optional — it cannot run again either way.</p>
      <p class="pub-sub">To start over, delete <code>users.json</code> and
         <code>lib/config.local.php</code>. Your data in <code>data.json</code> stays.</p>
      <div class="pub-actions">
        <a class="pub-btn ins-btn" href="login.php">Sign in</a>
      </div>
    </div>
  </main>
</div>
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
<html lang="en" data-bs-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Install · Step <?php echo $step; ?> of <?php echo TRAX_INSTALL_STEPS; ?></title>
<link rel="stylesheet" href="vendor/bootstrap.min.css">
<link rel="stylesheet" href="public.css">
<style>
  :root { --trax-brand: <?php echo install_e(trax_hex_color($state['brandColor']) ?? '#1F2937'); ?>; }
  /* min-width: 0 because this is a flex item of .pub-page: without it the
     automatic minimum size is the content's min-content width, and one long
     unbreakable cron URL would hold the whole card open past a phone's
     viewport instead of wrapping inside it. */
  .ins-main { max-width: 720px; min-width: 0; margin: 0 auto; padding: 2rem 1rem 3rem; }
  .ins-card { padding: 1.25rem; }
  .ins-title { margin: 0 0 0.35rem; font-size: 1.25rem; font-weight: 600; }
  .ins-lead { margin: 0 0 1.1rem; color: var(--trax-muted); font-size: 0.92rem; }
  .ins-steps { display: flex; flex-wrap: wrap; gap: 0.35rem; list-style: none;
               margin: 0 0 1.25rem; padding: 0; }
  .ins-steps li { display: flex; align-items: center; gap: 0.35rem; padding: 0.25rem 0.55rem;
                  border: 1px solid var(--trax-line); border-radius: 999px;
                  font-size: 0.75rem; color: var(--trax-muted); }
  .ins-steps li b { font-weight: 600; }
  .ins-steps li.is-now { color: var(--trax-text); border-color: #3fb0c9; }
  .ins-steps li.is-past { color: #7ee2a0; border-color: rgba(46, 160, 67, 0.4); }
  .ins-req { list-style: none; margin: 0 0 1rem; padding: 0; }
  /* overflow-wrap because the rows carry absolute paths and shell commands the
     operator cannot shorten; without it one long path is a min-content width
     the flex row refuses to shrink below, and the card grows past the phone. */
  .ins-req li { display: flex; gap: 0.6rem; padding: 0.45rem 0; min-width: 0;
                overflow-wrap: anywhere;
                border-bottom: 1px solid var(--trax-line); font-size: 0.9rem; }
  .ins-req li:last-child { border-bottom: 0; }
  .ins-req .ins-mark { flex: 0 0 1.6rem; font-weight: 700; }
  .ins-ok { color: #7ee2a0; }
  .ins-bad { color: #ff9a94; }
  .ins-warn { color: #f0c674; }
  .ins-req .ins-detail { display: block; color: var(--trax-muted); font-size: 0.82rem; }
  .ins-actions { display: flex; gap: 0.6rem; align-items: center; margin-top: 1.25rem; }
  .ins-actions .pub-btn { flex: 1 1 auto; justify-content: center; }
  .ins-hint { display: block; margin-top: 0.3rem; color: var(--trax-muted); font-size: 0.8rem; }
  .ins-colour { display: flex; gap: 0.5rem; align-items: center; }
  .ins-colour input[type=color] { width: 3rem; height: 2.6rem; padding: 0.2rem;
                                  background: var(--trax-card); border: 1px solid var(--trax-line);
                                  border-radius: 8px; }
  .ins-pre { display: block; overflow-x: auto; padding: 0.6rem 0.75rem; margin: 0.35rem 0 0;
             background: rgba(0, 0, 0, 0.28); border: 1px solid var(--trax-line);
             border-radius: 8px; font-family: var(--trax-mono); font-size: 0.78rem;
             white-space: pre-wrap; overflow-wrap: anywhere; color: var(--trax-text); }
  .ins-review { margin: 0 0 1rem; }
  .ins-review div { display: flex; justify-content: space-between; gap: 1rem;
                    padding: 0.35rem 0; border-bottom: 1px solid var(--trax-line); font-size: 0.88rem; }
  .ins-review dt { color: var(--trax-muted); font-weight: 400; }
  .ins-review dd { margin: 0; text-align: right; word-break: break-word; }
  .ins-check { display: flex; gap: 0.6rem; align-items: flex-start; margin: 0.9rem 0; }
  .ins-check input { margin-top: 0.25rem; }
  /* The external-auth block hangs off the radio above it. */
  .ins-auth-fields { margin: 0 0 0.5rem 1.6rem; padding-left: 0.9rem;
                     border-left: 2px solid var(--trax-line, rgba(255,255,255,0.12)); }
  /* Not .pub-btn-primary: that is the WhatsApp green of the public page. The
     wizard's primary button previews the brand colour being chosen instead. */
  .ins-btn { background: var(--trax-brand); color: var(--trax-brand-ink); }
</style>
</head>
<body>
<div class="pub-page">
  <main class="ins-main" data-step="<?php echo $step; ?>">
    <div class="pub-card ins-card">

      <ol class="ins-steps">
        <?php for ($i = 1; $i <= TRAX_INSTALL_STEPS; $i++): ?>
          <li class="<?php echo $i === $step ? 'is-now' : ($i < $step ? 'is-past' : ''); ?>">
            <b><?php echo $i; ?></b> <?php echo install_e($shortTitles[$i]); ?>
          </li>
        <?php endfor; ?>
      </ol>

      <h1 class="ins-title"><?php echo install_e($titles[$step]); ?></h1>

      <?php if ($notice !== ''): ?>
        <div class="pub-flash pub-flash-ok"><?php echo install_e($notice); ?></div>
      <?php endif; ?>

      <?php if ($errors !== []): ?>
        <div class="pub-flash pub-flash-bad" role="alert">
          <?php foreach ($errors as $message): ?>
            <div><?php echo install_e($message); ?></div>
          <?php endforeach; ?>
        </div>
      <?php endif; ?>

<?php if ($step === 7): ?>

      <p class="ins-lead">Everything is written. Sign in and start adding your gear.</p>

      <?php if ($state['authMode'] === 'external'): ?>
        <p class="pub-note">Sign-in is handled by your external include,
           <code><?php echo install_e($state['authInclude']); ?></code>. The button below goes
           straight to the app and lets that include do the asking. The account
           <b><?php echo install_e($state['username']); ?></b> is kept as a fallback: if the
           include ever goes missing, the built-in form at <code>login.php</code> comes back
           and that account still works.</p>
      <?php else: ?>
        <p class="pub-note">Sign-in uses the built-in login. You can switch to an existing
           login system later under Settings &rarr; Authentication.</p>
      <?php endif; ?>

      <div class="pub-actions">
        <a class="pub-btn ins-btn" href="<?php echo $state['authMode'] === 'external' ? 'admin.php' : 'login.php'; ?>">Sign in as <?php echo install_e($state['username']); ?></a>
      </div>

      <h2 class="pub-eyebrow" style="margin-top:1.5rem">Files written</h2>
      <ul class="ins-req">
        <?php foreach (($done ?? []) as $path): ?>
          <li><span class="ins-mark ins-ok">&check;</span><?php echo install_e($path); ?></li>
        <?php endforeach; ?>
      </ul>

      <h2 class="pub-eyebrow" style="margin-top:1.5rem">Scheduled tasks</h2>
      <p class="ins-lead">cron.php sends the due-soon and overdue reminders and the daily
         owner digest. Without it the app works, but nobody gets reminded of anything.</p>
      <?php if ($cronUrl !== ''): ?>
        <p class="pub-label">Call this URL every 15 minutes (hosts with a web cron):</p>
        <code class="ins-pre"><?php echo install_e($cronUrl); ?></code>
      <?php else: ?>
        <p class="pub-note pub-note-bad">You left the cron secret empty, so the web trigger is
           refused. Use the crontab line below, or set a secret later in Settings.</p>
      <?php endif; ?>
      <p class="pub-label" style="margin-top:0.75rem">Or, with real shell access:</p>
      <code class="ins-pre"><?php echo install_e(trax_install_crontab_line()); ?></code>

      <h2 class="pub-eyebrow" style="margin-top:1.5rem">Two last things</h2>
      <ul class="ins-req">
        <li><span class="ins-mark ins-warn">!</span>
          <span>If your host lets you set file modes, make <code>users.json</code> readable
            only by the web user: <code>chmod 600 users.json</code>. It holds the password
            hashes. The installer already asked for that mode; some hosts ignore it.</span></li>
        <li><span class="ins-mark ins-warn">!</span>
          <span>You may delete <code>install.php</code>. It is harmless — it refuses to run
            now that an administrator exists — but there is no reason to keep it.</span></li>
      </ul>

<?php else: ?>

      <form method="post" action="install.php" enctype="multipart/form-data" autocomplete="off">
        <input type="hidden" name="csrf" value="<?php echo install_e($csrf); ?>">
        <input type="hidden" name="step" value="<?php echo $step; ?>">

<?php if ($step === 1): ?>

        <p class="ins-lead">This wizard writes three things: your settings, an administrator
           account, and the folders the app keeps photos and documents in. It takes a minute,
           and nothing is written until the last step.</p>

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
          <p class="pub-note pub-note-bad">Fix the items marked &times; and reload this page.
             The rest are advisory — you can continue with them unresolved.</p>
        <?php endif; ?>

<?php elseif ($step === 2): ?>

        <p class="ins-lead">What this installation calls itself, on screen and on printed labels.
           All of it can be changed later in Settings.</p>

        <div class="row">
          <div class="col-12 col-sm-6">
            <label class="pub-field">
              <span class="pub-label">Application name *</span>
              <input class="pub-input" type="text" name="appName" maxlength="60" required
                     value="<?php echo install_e($state['appName']); ?>">
              <span class="ins-hint">Shown in the browser tab and the header.</span>
            </label>
          </div>
          <div class="col-12 col-sm-6">
            <label class="pub-field">
              <span class="pub-label">Organisation</span>
              <input class="pub-input" type="text" name="orgName" maxlength="120"
                     value="<?php echo install_e($state['orgName']); ?>">
              <span class="ins-hint">Printed under "<?php echo install_e($state['labelHeading']); ?>" on labels.</span>
            </label>
          </div>
        </div>

        <div class="row">
          <div class="col-12 col-sm-6">
            <span class="pub-label">Brand colour</span>
            <div class="ins-colour pub-field">
              <input type="color" id="ins-colour-pick" value="<?php echo install_e($state['brandColor']); ?>"
                     aria-label="Brand colour picker">
              <input class="pub-input" type="text" name="brandColor" id="ins-colour-hex"
                     maxlength="7" pattern="#[0-9A-Fa-f]{6}"
                     value="<?php echo install_e($state['brandColor']); ?>">
            </div>
          </div>
          <div class="col-12 col-sm-6">
            <label class="pub-field">
              <span class="pub-label">Label heading</span>
              <input class="pub-input" type="text" name="labelHeading" maxlength="40"
                     value="<?php echo install_e($state['labelHeading']); ?>">
              <span class="ins-hint">The line above your organisation on every label.</span>
            </label>
          </div>
        </div>

        <label class="pub-field">
          <span class="pub-label">Logo</span>
          <input class="pub-input" type="file" name="logo" accept="image/png,image/jpeg,image/webp">
          <span class="ins-hint">PNG, JPEG or WebP, up to 2 MB. It is converted to
            <code>logo.png</code>, and a matching <code>favicon.png</code> is generated from it.
            Leave empty to run without a logo.</span>
        </label>

        <?php if ($state['logoClient'] !== ''): ?>
          <label class="ins-check">
            <input type="checkbox" name="removeLogo" value="1">
            <span>Remove the uploaded logo (<?php echo install_e($state['logoClient']); ?>)</span>
          </label>
        <?php endif; ?>

        <label class="pub-field">
          <span class="pub-label">WhatsApp number</span>
          <input class="pub-input" type="text" name="whatsapp" maxlength="40"
                 placeholder="+49 172 1234567"
                 value="<?php echo install_e($state['whatsapp']); ?>">
          <span class="ins-hint">Optional. Puts a "Message on WhatsApp" button on the public
            page of every asset. International form, please.</span>
        </label>

<?php elseif ($step === 3): ?>

        <p class="ins-lead">How people get in. Most installations want the built-in login;
           pick the second option only if this host already has one you want to keep using.</p>

        <label class="ins-check">
          <input type="radio" name="authMode" value="builtin" id="ins-auth-builtin"
                 <?php echo $state['authMode'] === 'external' ? '' : 'checked'; ?>>
          <span><b>Built-in login (recommended)</b> — this app keeps the accounts and shows
            its own sign-in form at <code>login.php</code>.</span>
        </label>

        <label class="ins-check">
          <input type="radio" name="authMode" value="external" id="ins-auth-external"
                 <?php echo $state['authMode'] === 'external' ? 'checked' : ''; ?>>
          <span><b>External auth include</b> — a PHP file you already have takes care of
            signing people in. It is included on every admin and API request.</span>
        </label>

        <div id="ins-auth-fields" class="ins-auth-fields">
          <label class="pub-field">
            <span class="pub-label">Path to the include *</span>
            <input class="pub-input" type="text" name="authInclude" maxlength="512"
                   placeholder="/var/www/example.com/auth/check_auth.php"
                   value="<?php echo install_e($state['authInclude']); ?>">
            <span class="ins-hint">An absolute path on this server, normally outside the web
              root. It must end the request for anonymous visitors and put the username in
              <code>$_SESSION['trax_user']</code>. See "Using an existing login system" in
              README.md for the full contract.</span>
          </label>

          <label class="pub-field">
            <span class="pub-label">Sign-out URL</span>
            <input class="pub-input" type="text" name="authLogoutUrl" maxlength="512"
                   placeholder="https://example.com/logout"
                   value="<?php echo install_e($state['authLogoutUrl']); ?>">
            <span class="ins-hint">Optional. Where the "Sign out" button goes — your own
              logout endpoint. Empty just drops the local session and returns to the app.</span>
          </label>
        </div>

        <p class="ins-lead" style="margin-top:1rem">The administrator account. It is the first —
           and, for now, only — one; further operators are added by editing users.json.
           <b>It is asked for in both modes:</b> with an external include it is kept as a
           fallback, so that a renamed or deleted include cannot lock you out of your own
           installation.</p>

        <div class="row">
          <div class="col-12 col-sm-6">
            <label class="pub-field">
              <span class="pub-label">Username *</span>
              <input class="pub-input" type="text" name="username" maxlength="64" required
                     autocomplete="username" value="<?php echo install_e($state['username']); ?>">
              <span class="ins-hint">2–64 characters: letters, digits, dot, underscore, hyphen.</span>
            </label>
          </div>
          <div class="col-12 col-sm-6">
            <label class="pub-field">
              <span class="pub-label">Email *</span>
              <input class="pub-input" type="email" name="email" maxlength="254" required
                     autocomplete="email" value="<?php echo install_e($state['email']); ?>">
              <span class="ins-hint">Only used to identify you — no mail is sent to it.</span>
            </label>
          </div>
        </div>

        <div class="row">
          <div class="col-12 col-sm-6">
            <label class="pub-field">
              <span class="pub-label">Password *</span>
              <input class="pub-input" type="password" name="password" required
                     autocomplete="new-password" minlength="<?php echo TRAX_MIN_PASSWORD_LEN; ?>">
              <span class="ins-hint">At least <?php echo TRAX_MIN_PASSWORD_LEN; ?> characters.
                Three unrelated words beat one clever word.</span>
            </label>
          </div>
          <div class="col-12 col-sm-6">
            <label class="pub-field">
              <span class="pub-label">Repeat password *</span>
              <input class="pub-input" type="password" name="password2" required
                     autocomplete="new-password" minlength="<?php echo TRAX_MIN_PASSWORD_LEN; ?>">
              <span class="ins-hint">There is no password reset mail — write it down somewhere safe.</span>
            </label>
          </div>
        </div>

<?php elseif ($step === 4): ?>

        <p class="ins-lead">Where this installation lives and how it formats things.
           The mail addresses are optional; mail goes out through PHP's <code>mail()</code>,
           so leave them empty if your host does not send mail.</p>

        <div class="row">
          <div class="col-12 col-sm-6">
            <label class="pub-field">
              <span class="pub-label">Public path *</span>
              <input class="pub-input" type="text" name="publicPath" maxlength="120" required
                     value="<?php echo install_e($state['publicPath']); ?>">
              <span class="ins-hint">The folder this app is reached at. "/" for a domain root,
                "/assets/" for a subfolder. QR labels are built from it.</span>
            </label>
          </div>
          <div class="col-12 col-sm-6">
            <label class="pub-field">
              <span class="pub-label">Timezone *</span>
              <select class="pub-input" name="timezone" required>
                <?php foreach (DateTimeZone::listIdentifiers() as $zone): ?>
                  <option value="<?php echo install_e($zone); ?>"
                    <?php echo $zone === $state['timezone'] ? 'selected' : ''; ?>>
                    <?php echo install_e($zone); ?>
                  </option>
                <?php endforeach; ?>
              </select>
              <span class="ins-hint">Due times, reminders and every printed date use it.</span>
            </label>
          </div>
        </div>

        <div class="row">
          <div class="col-12 col-sm-6">
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
              <span class="ins-hint">A BCP 47 tag. Used for numbers and dates in the browser.</span>
            </label>
          </div>
          <div class="col-12 col-sm-6">
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
          <span class="ins-hint">A PHP <code>date()</code> format, used for everything rendered
            on the server: labels, mails, the public page.</span>
        </label>

        <div class="row">
          <div class="col-12 col-sm-4">
            <label class="pub-field">
              <span class="pub-label">Owner address</span>
              <input class="pub-input" type="email" name="ownerEmail" maxlength="254"
                     value="<?php echo install_e($state['ownerEmail']); ?>">
              <span class="ins-hint">Gets a copy of every checkout and all lost reports.</span>
            </label>
          </div>
          <div class="col-12 col-sm-4">
            <label class="pub-field">
              <span class="pub-label">Sender address</span>
              <input class="pub-input" type="email" name="fromEmail" maxlength="254"
                     value="<?php echo install_e($state['fromEmail']); ?>">
              <span class="ins-hint">The From of customer mail.</span>
            </label>
          </div>
          <div class="col-12 col-sm-4">
            <label class="pub-field">
              <span class="pub-label">Report sender</span>
              <input class="pub-input" type="email" name="reportFromEmail" maxlength="254"
                     value="<?php echo install_e($state['reportFromEmail']); ?>">
              <span class="ins-hint">The From of the public "found this item" form.</span>
            </label>
          </div>
        </div>

<?php elseif ($step === 5): ?>

        <p class="ins-lead">cron.php sends due-soon reminders, overdue notices and a daily
           digest to the owner address. It has to be triggered from outside — by your host's
           cron, or by a real crontab.</p>

        <label class="pub-field">
          <span class="pub-label">Cron secret</span>
          <input class="pub-input" type="text" name="cronSecret" maxlength="200" value="<?php echo install_e($state['cronSecret']); ?>">
          <span class="ins-hint">Anyone who knows this can trigger the reminders over HTTP —
            which is all it can do. Empty means the web trigger is refused entirely.</span>
        </label>

        <button class="pub-btn pub-btn-ghost" type="submit" name="action" value="regenerate">
          Regenerate secret
        </button>

        <?php if ($cronUrl !== ''): ?>
          <p class="pub-label" style="margin-top:1rem">Web cron — call every 15 minutes:</p>
          <code class="ins-pre"><?php echo install_e($cronUrl); ?></code>
        <?php endif; ?>
        <p class="pub-label" style="margin-top:0.75rem">Or a crontab line, if you have shell access:</p>
        <code class="ins-pre"><?php echo install_e(trax_install_crontab_line()); ?></code>

        <div class="row" style="margin-top:1rem">
          <div class="col-6 col-sm-3">
            <label class="pub-field">
              <span class="pub-label">Loan days</span>
              <input class="pub-input" type="number" name="loanDays" min="1" max="365"
                     value="<?php echo (int)$state['loanDays']; ?>">
            </label>
          </div>
          <div class="col-6 col-sm-3">
            <label class="pub-field">
              <span class="pub-label">Due hour</span>
              <input class="pub-input" type="number" name="dueHour" min="0" max="23"
                     value="<?php echo (int)$state['dueHour']; ?>">
            </label>
          </div>
          <div class="col-6 col-sm-3">
            <label class="pub-field">
              <span class="pub-label">Due-soon hours</span>
              <input class="pub-input" type="number" name="dueSoonHours" min="1" max="168"
                     value="<?php echo (int)$state['dueSoonHours']; ?>">
            </label>
          </div>
          <div class="col-6 col-sm-3">
            <label class="pub-field">
              <span class="pub-label">Overdue repeat</span>
              <input class="pub-input" type="number" name="overdueRepeatDays" min="1" max="90"
                     value="<?php echo (int)$state['overdueRepeatDays']; ?>">
            </label>
          </div>
        </div>
        <p class="ins-hint">Defaults are fine for most operations: a 7-day loan due at 18:00,
           a reminder 24 hours before, and an overdue notice repeated weekly.</p>

<?php elseif ($step === 6): ?>

        <p class="ins-lead">Last look. Nothing has been written yet.</p>

        <label class="ins-check">
          <input type="checkbox" name="demoData" value="1" <?php echo $state['demoData'] ? 'checked' : ''; ?>>
          <span>Load demo data — eight sample assets, one kit and one reservation, no photos.
            Handy for a look around; delete them when you start entering your own.</span>
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

        <p class="ins-hint">Pressing Install writes lib/config.local.php, data.json,
           <?php echo $state['logoClient'] !== '' ? 'logo.png, favicon.png, ' : ''; ?>and users.json.
           If any of them fails, the others are removed again.</p>

<?php endif; ?>

        <div class="ins-actions">
          <?php if ($step > 1): ?>
            <button class="pub-btn pub-btn-ghost" type="submit" name="action" value="back">Back</button>
          <?php endif; ?>
          <button class="pub-btn ins-btn" type="submit" name="action" value="next"
                  <?php echo $blocked ? 'disabled' : ''; ?>>
            <?php echo $step === 6 ? 'Install' : 'Next'; ?>
          </button>
        </div>
      </form>

      <?php if ($step > 1): ?>
        <form method="post" action="install.php" style="margin-top:0.75rem">
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
</div>

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
