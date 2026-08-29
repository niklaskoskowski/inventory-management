# Asset manager

A small, self-hosted inventory and lending tool. It keeps track of what you own,
who has it, and when it is due back. Every item gets a printable QR label; a scan
opens a public page that says whether the item is available and how to reach you.

It needs no database and no build step. Upload the files, open `install.php`, and
answer seven short questions.

---

## What your host needs

| Requirement | Notes |
|---|---|
| PHP 8.1 or newer | 8.2+ recommended |
| PHP extensions: `gd`, `mbstring`, `json`, `fileinfo`, `session` | all standard on shared hosting |
| Apache with `.htaccess` support | nginx works too, but you have to translate the rules yourself |
| `mod_rewrite` (optional) | only for the short QR label URLs, e.g. `example.com/42` |
| HTTPS (strongly recommended) | see [Scanning with the camera](#scanning-with-the-camera) |

No composer, no npm, no cron daemon required — though a scheduled task makes the
reminder emails work.

---

## Installing

1. **Upload the whole folder** to your web space, keeping the directory
   structure. FTP, SFTP or your host's file manager are all fine.
   If your FTP client skips empty folders, do not worry: the installer creates
   `uploads/`, `uploads/thumb/`, `documents/` and `phpqrcode/cache/` for you.

2. **Make the folder writable.** The app stores everything in plain files next to
   itself, so the directory it lives in has to be writable by the web server
   (usually mode `755`, on some hosts `775`).

3. **Open `install.php` in a browser** — `https://example.com/install.php`, or
   `https://example.com/assets/install.php` if you uploaded it into a subfolder.

4. **Work through the seven steps:**

   | Step | What it asks |
   |---|---|
   | 1. Checks | Nothing. It reports what your host provides and blocks only on real problems. |
   | 2. Branding | Application name, organisation, brand colour, a logo (optional), the heading printed on labels, a WhatsApp number (optional). |
   | 3. Account | Whether to use the built-in login or [an existing one](#using-an-existing-login-system-external-auth), then the administrator username, an email address, and a password of at least 10 characters. |
   | 4. Site & mail | The folder the app is reached at, your timezone, locale, currency, date format, and up to three sender/owner email addresses. |
   | 5. Automation | A cron secret (generated for you) plus the default loan period. |
   | 6. Review | Optionally load eight demo assets, then check everything over. |
   | 7. Done | Confirmation, the cron URL, and a link to sign in. |

   Nothing is written to disk until you press **Install** on step 6. If any part
   of the write fails, everything it had already written is removed again.

5. **Sign in** with the account you just created.

6. Optional but tidy: **delete `install.php`**. It refuses to run once an
   administrator exists, so leaving it there is harmless — there is just no
   reason to keep it.

7. If your host lets you set file permissions, set `users.json` to `600`. It
   holds the password hashes. The installer already asks for that mode; some
   hosts ignore the request.

---

## Using an existing login system (external auth)

If this host already has a login you want to keep — an intranet gate, a customer
portal, a hand-rolled `check_auth.php` — the app can defer to it instead of
showing its own sign-in form.

Pick **External auth include** on step 3 of the installer, or switch later under
**Settings → Authentication**. Either way it comes down to three constants in
`lib/config.local.php`, which you can also edit by hand:

```php
define('TRAX_AUTH_MODE', 'external');
define('TRAX_AUTH_INCLUDE', '/var/www/example.com/auth/check_auth.php');
define('TRAX_AUTH_LOGOUT_URL', 'https://example.com/logout');   // optional
```

`TRAX_AUTH_INCLUDE` has to be an absolute path to a file whose name ends in
`.php`, and that file has to live **outside** the application folder — not
inside the app directory, its `uploads/`, or its `documents/`. Anything inside
is refused, by the installer and by Settings alike. The reason is blunt: those
directories are where uploaded photos and documents land, so an include that
could sit there would turn "upload a file" into "run a file on every request".
Keep the gate next to the app, not in it: `/var/www/example.com/auth/…` while
the app is in `/var/www/example.com/inventory/`.

### What the include file has to do

It is `require_once`d at the top of **every** admin page and **every** API
request, before anything else runs, with a session already started. Its job is
to answer one question: who is this?

1. **End the request for anyone who is not signed in.** Redirect them to your own
   login page and `exit`. Do not return — returning without an identity gets a
   403 page, not a login form, because there is no form to send them to.
2. **Put the identity in `$_SESSION`** for everyone who is. Any one of these keys
   is read, in this order: `trax_user`, `username`, `user`, `email`, `login`,
   `user_name`. `$_SESSION['user']` may also be an array with `name`, `email` or
   `username` in it. Whatever is found becomes the name on every history entry.
3. **Do not call `session_start()` unguarded.** The session is already active by
   the time your file is included, and a second call emits a notice. Guard it:
   `if (session_status() === PHP_SESSION_NONE) { session_start(); }`
4. Keep it to that. The file is included inside a function, so anything it
   declares at the top level is a local variable and disappears afterwards.

A minimal example:

```php
<?php
if (session_status() === PHP_SESSION_NONE) { session_start(); }

if (empty($_SESSION['my_portal_user'])) {
    header('Location: https://example.com/login?next=' . rawurlencode($_SERVER['REQUEST_URI'] ?? '/'));
    exit;
}

$_SESSION['trax_user'] = $_SESSION['my_portal_user'];
```

In external mode `login.php` stops showing a form and simply forwards to
`admin.php`, so your include gets the chance to ask. **Sign out** destroys the
local session and then goes to `TRAX_AUTH_LOGOUT_URL` — set it to your own logout
endpoint, because only that can end the session your gate keeps. Left empty, the
button drops the local session and returns to `admin.php`, where your include
takes over again.

### The fallback, and getting back in

The installer asks for an administrator account in both modes, and it is worth
keeping. Before every request the app checks that `TRAX_AUTH_INCLUDE` still names
a readable file. If it does not — renamed, moved by a deploy, permissions
changed — the miss is written to the PHP error log and **the built-in login comes
back automatically**, so `login.php` works and that account can sign in and fix
the path.

If you are locked out anyway, edit `lib/config.local.php` over FTP and delete
this line:

```php
define('TRAX_AUTH_MODE', 'external');
```

That is the whole recovery. The built-in login is in force again on the very next
request, and nothing else in the file has to change.

---

## Reminder emails (cron)

`cron.php` sends the "due soon" and "overdue" reminders and a daily digest to the
owner address. It does nothing unless something calls it, so give it a schedule.
Every 15 minutes is plenty.

**If your host offers a web cron** (most shared hosting does), point it at the URL
the installer showed you on the last step:

```
https://example.com/cron.php?secret=YOUR_SECRET
```

The secret is what keeps strangers from triggering it. You can change it later
under Settings. An empty secret refuses every web request outright.

**If you have shell access**, a crontab line needs no secret at all:

```
*/15 * * * * /usr/bin/php /full/path/to/cron.php > /dev/null 2>&1
```

Mail is sent with PHP's built-in `mail()`. If your host does not send mail, leave
the address fields empty and the app simply sends nothing.

---

## Scanning with the camera

The built-in QR scanner uses your browser's camera. Browsers only grant camera
access to pages served over **HTTPS** (localhost excepted). Over plain HTTP the
rest of the app works, but the scanner will not open. Most hosts include a free
certificate — turn it on.

---

## Where your data lives

Everything is a plain file in the application folder:

| Path | What it holds |
|---|---|
| `data.json` | Assets, reservations, history, bookings, settings. The main file. |
| `data.json.bak` | An automatic copy of the previous version, rewritten on every save. |
| `checkout.json` | What is currently out on loan. |
| `users.json` | The operator accounts and their password hashes. |
| `lib/config.local.php` | The deployment settings the installer wrote (timezone, paths, addresses). |
| `uploads/` | Item photos, plus generated thumbnails in `uploads/thumb/`. |
| `documents/` | Attached manuals, receipts and certificates. Not reachable from the web. |
| `logo.png`, `favicon.png` | Your branding, if you uploaded a logo. |

`data.json`, `checkout.json` and `users.json` are denied to the web by
`.htaccess`, and `lib/` and `documents/` are denied wholesale. If you move the
app to a host without `.htaccess` support, reproduce those rules — otherwise
anyone could download your customer list.

### Backing up

Copy the folder. That is the whole procedure. If you want the minimum:

```
data.json  checkout.json  users.json  lib/config.local.php  uploads/  documents/
```

Do it on a schedule you can live with losing — daily, if the app is in daily use.
Restoring is the same thing backwards: copy the files back.

---

## Starting over

Delete these two files:

```
users.json
lib/config.local.php
```

The installer opens again on the next visit. **Your data stays**: `data.json` is
not touched, so all your items, loans and history are still there, and the new
installation adopts them. Delete `data.json` too if you want a genuinely empty
system.

---

## Forgotten password

There is no password-reset email — the app does not know whether your host can
send mail at all. Reset it from the command line instead, from the application
folder:

```
php -r 'require "lib/config.php"; require "lib/auth.php";
        trax_user_change_password(1, "your-new-password-here");
        echo "done\n";'
```

`1` is the user's id, which you can read out of `users.json`. The new password
must be at least 10 characters. If your host has no shell, most control panels
offer a "run a PHP script" or "cron job (run once)" box that will do the same
thing — or, as a last resort, delete `users.json` and run the installer again as
described above.

---

## Day-to-day

- **Add an item**, print its label, stick it on. The QR code points at a public
  page for that item.
- **Check out** to a person with a due date; they get an email with a link to
  their own booking page if you configured a sender address.
- **Reserve** an item for a future date range; conflicts are shown before you
  confirm.
- **Sets** bundle several items into one thing to lend, e.g. a camera with its
  tripod.
- Anyone who finds a lost item can scan its label and reach you through the
  public page, without an account.
