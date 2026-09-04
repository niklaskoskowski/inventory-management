# Changelog

All notable changes to Trax. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project has no released versions, so sections are dated.

**Every change must add an entry here** — together with [project.md](project.md), this file is the
only record. There is no git history to mine.

## 2026-09-04

### Added

- **Warranty date auto-filled from the purchase date.** Entering *Purchased* on the asset
  sheet fills *Warranty until* with the same day N months later, month-end clamped
  (`addMonths()`, `app/components/AssetSheet.js:24`). N is
  `settings.defaults.warrantyMonths` — new, integer 0..120, default 24, `0` turns the auto-fill
  off (`lib/store.php:1231`, Settings → Defaults). A warranty date the operator typed is never
  overwritten, and opening an existing asset never changes its stored dates.
- **Per-unit tracking ("units" / Exemplare).** An `ITEM` asset may list its physical units
  individually; a `SET` never does. Unit `12.3` is unit 3 of asset 12.
  - Data model: `units: [{no, label, serial, condition, outOfService, note}]` on the asset
    (`trax_normalize_unit()`, `lib/store.php:302`). A non-empty list *derives* `quantity` —
    `quantity = count(units)` (`lib/store.php:383-387`). Cap `TRAX_MAX_UNITS = 500`
    (`lib/config.php:402`).
  - Derived per-unit state `FREE | OUT | OOS`, never stored: `trax_unit_states()`
    (`lib/store.php:1502`), `trax_available_unit_nos()` (`lib/store.php:1547`),
    `trax_asset_has_units()` (`lib/store.php:1480`), `trax_unit_code()` (`lib/store.php:1486`).
  - Snapshot decoration (`trax_decorate_assets()`, `lib/store.php:2120-2162`) adds `state`,
    `lineId`, `customerName`, `dueAt` per unit and `availableUnitNos` per asset.
  - Checkout lines, history events and booking items carry `unitNos: int[]`.
- **API**: `units` accepted in `asset.create` / `asset.update` (`apply_units_patch()`,
  `api.php:616`). Refuses a kit, a duplicate number, a list over 500, and removing a unit that is
  out. Unit numbers are assigned server-side, never by the client, and never reused — see the
  `unitSeq` entry under Fixed.
- **API**: `checkout.create` accepts `items[].unitNos`; requested units must be free or the call is
  a 409 `CONFLICT` with `blocked[].unitNos`. The remainder of the quantity is auto-assigned the
  lowest free numbers (`trax_pick_units()`, `api.php:688`). `reservation.convert` auto-assigns the
  same way — reservations are product-level and name no unit.
- **API**: `checkout.checkin` accepts `lines[].unitNos` (partial return of named units of a line)
  and `units: [{assetId, no}]` (a scanned single unit, found wherever it is out). The response
  carries `notOut[]` — scanned units nothing had out.
- **UI**: `AssetSheet` "Units" tab — track N units, edit label / serial / condition /
  out-of-service / note, add, remove, save. The quantity field is disabled once units exist.
- **UI**: `AssetTable` / `AssetCards` chips "N units" and "N out of service";
  `BulkEditDrawer` help text; `BasketDrawer` per-unit chips (checkout mode only, capped at
  `availableQty`, with an auto-assignment hint and unit codes in the blocked list);
  `CheckoutsView` unit codes per line plus per-unit return check boxes (the stepper stays for
  unit-less lines) and "(12.1, 12.3)" in handover PDF item names; `ReservationsView` blocked unit
  codes; `booking.php` "· units 12.1, 12.2".
- **UI**: `app/store.js` `unitChoice` state with `getUnitChoice` / `setUnitChoice` /
  `toggleUnitChoice`.
- **Scanning**: `ScanDrawer` understands `12.1`, `/12.1` and `?id=12&u=1` (`extractRef()`, exported
  for testing). Collect mode adds that exact unit, return mode returns that exact unit, lookup mode
  toasts it.
- **Labels / public pages**: `trax_label_url($id, $unit = null)` (`lib/config.php:514`) →
  short `HTTPS://HOST/12.1` (still QR alphanumeric mode, same QR version as without a unit) or
  query `?id=12&u=1`. `.htaccess` numeric rewrite `^(\d+)(?:\.(\d+))?/?$ → index.php?id=$1&u=$2`
  (`.htaccess:70`). `index.php` parses `u` and `/12.1`, renders "ID 12.1 · label" and unit-level
  availability wording. `public.php` accepts `u` and returns `unit {no, code, label, state}` —
  never the holder. `label.php` / `label-w.php` accept `u`, print "ID: 12.1" and the unit label.
  `LabelDrawer` gained a unit selector and "Print all unit labels".
- **UI**: `LabelDrawer` "Download all unit labels" — both label formats of every unit fetched and
  packed client-side into one `labels-<assetId>.zip`, entries `<assetId>.<no>.png` (portrait) and
  `<assetId>.<no>-wide.png`. One archive rather than one download per PNG because a browser blocks
  or prompts on the second programmatic download onwards. Out-of-service units are included: the
  physical item still needs its label.
- **`app/lib/zip.js`**: `buildZip(entries) -> Blob`, a hand-written store-only (method 0) ZIP
  writer — local file headers, central directory, end-of-central-directory, table-based CRC-32,
  UTF-8 names (flag bit 11), DOS timestamps. No ZIP64 and no compression: the entries are PNGs,
  already deflated, and nothing here approaches 4 GB. Nothing is vendored for this and there is no
  npm, so the format is written out by hand.
- **Mail**: item lines spell out the units — " (units 12.1, 12.3)" (`lib/mailer.php:141-162`).
- **Captcha**: self-hosted image captcha + honeypot on the public found-item report form
  (`captcha.php`, session-bound, 10-min expiry, one-time). GD draws five distorted characters from
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; the answer never leaves the session. `index.php:80-127` checks
  the hidden `website` field first (filled → silent thank-you, no mail) and then the code; a failure
  sends no mail, spends the code and re-renders the dialog open with the values still in it. The
  image is fetched only when the dialog opens, so a plain label scan still starts no session.
- **Per-unit prices, with the asset's value derived from them.** A unit carries its own
  `price` — float ≥ 0 rounded to 2 dp or `null`, normalised exactly like the asset price
  (`trax_normalize_unit()`, `lib/store.php:302-326`). There is no per-unit currency; `asset.currency`
  still covers the whole record. Two of the same model rarely cost the same twice, so the list is
  the truth as soon as one unit names a figure.
  - Derived, never stored (`trax_asset_value()`, `lib/store.php:2138-2164`, added to every asset by
    `trax_decorate_assets()`): `unitPriced` (bool — an `ITEM` with units, at least one priced),
    `priceTotal` (the sum of the unit prices with an unpriced unit counting as `0`; otherwise
    `price × quantity`, or `null` when there is no price at all) and `pricedUnits` (how many units
    carry one). Each unit price is rounded on write, so `[10, null, 5.255]` stores `[10, null,
    5.26]` and totals `15.26`. Out-of-service and checked-out units count in — the money is still
    the organisation's.
  - The stored `asset.price` is left exactly as the client sends it: the server never derives it
    from the units and never overwrites it, it is simply not consulted while `unitPriced`.
  - No price of any kind reaches the public endpoints — `public.php`'s allow-list is unchanged and
    the derived keys are not in it.
  - **UI**: a price input per unit on the sheet's Units tab; the asset's own price field goes
    read-only and shows the sum once any unit is priced; the inventory Value column shows
    `totalPriceOf()` with a "Sum of N unit prices" tooltip (`app/components/AssetTable.js:82`);
    insights and the PDF value maths go through `unitPriceOf()` — the sum divided by the count — so
    the `price × quantity` arithmetic every report already does still lands on the sum
    (`app/lib/format.js:259-268`, `app/lib/insights.js:176`, `app/lib/pdf.js:612-621`).
- **Per-unit purchase date and warranty date, with the asset's dates derived from them.** A unit
  carries its own `purchasedAt` and `warrantyUntil` — stored `YYYY-MM-DD` or `null`, normalised by
  `trax_date()` exactly like the asset's own two fields (`trax_normalize_unit()`,
  `lib/store.php:302-331`). Both are edited in the sheet's Units tab and get the same warranty
  auto-fill as the asset sheet: typing a purchase date fills that unit's warranty
  `settings.defaults.warrantyMonths` later, and a date the operator typed is never overwritten.
  Units of the same model are bought on different days, so the list is the truth as soon as one
  unit names a date.
  - Derived, never stored (`trax_asset_dates()`, `lib/store.php:2186-2213`, added to every asset by
    `trax_decorate_assets()`): `unitDated` (bool — an `ITEM` with units, at least one of which
    names a `purchasedAt` or a `warrantyUntil`), `purchasedFirst` (the earliest unit purchase date,
    else the asset's own), `warrantyNext` (the earliest unit warranty date — the next one to lapse
    — else the asset's own) and `warrantyNextUnit` (the `no` of the unit that supplies it, `null`
    when the asset is not `unitDated`). `YYYY-MM-DD` sorts lexically, so "earliest" is a string
    comparison. Out-of-service and checked-out units count in: the warranty runs regardless.
  - The dashboard's "Warranty expiring" widget and the insurance PDF read `warrantyNext` /
    `purchasedFirst`, so a unit-tracking asset is judged by the unit whose cover lapses first
    rather than by an asset-level date nobody maintains.
  - The stored `asset.purchasedAt` / `asset.warrantyUntil` are left exactly as the client sends
    them: the server never derives them from the units and never overwrites them. The sheet hides
    the asset-level pair once the asset tracks units and omits them from the patch, so a legacy
    record keeps whatever it already had.
  - First "Track N units" copies the asset's existing purchase date, warranty date and condition
    onto every unit it creates, so switching an old record over to units does not lose them.
  - No date of any kind reaches the public endpoints — `public.php`'s allow-list is unchanged and
    the derived keys are not in it.
- **Condition `BLOCKED`.** Appended to `TRAX_CONDITIONS` (`lib/config.php:365`), so it is offered for
  an asset and for a single unit, and it rides the bootstrap `meta.conditions` like the rest. It is
  purely informational: availability, unit `state` and effective status are decided by the stored
  status and by the `outOfService` switch, and a `BLOCKED` unit that is not out of service is `FREE`
  and countable exactly as before.
- **Asset-level condition is hidden on the sheet once the asset tracks units** — the grade lives on
  each unit there, and a second one on the asset would only disagree with them. The inventory table
  shows a per-unit summary instead ("2× Good, 1× Blocked", `conditionSummary()`
  `app/lib/format.js:70-93`), falling back to the asset's own grade only for an asset without units.
- **The desktop drawer is at least a third of the viewport.** `.trax-drawer` is now
  `min(max(520px, 33vw), 100vw)` and `.trax-drawer-wide` `min(max(860px, 33vw), 100vw)`
  (`app/app.css:411`, `:421`) — the asset sheet's two-column rows and the unit table were cramped at
  a flat 520px on a wide screen. Below 992px the drawer is still `100vw`.
- **"Create backup now" on `restore.php`.** A POST button (own CSRF, PRG redirect) that runs the
  same code the nightly cron runs and drops the result at the top of the backup list. `backup.php`
  was refactored for it: its body is now `trax_run_backup(string $root, string $backupRoot,
  ?callable $log = null): array` (`backup.php:106`), its four helpers are prefixed `bk_*` so they
  no longer collide with `restore.php`'s own `ensureDir()` / `copyFileSafe()` /
  `copyDirectorySafe()` / `removeTree()`, and the CLI runner is guarded by
  `PHP_SAPI === 'cli' && realpath($argv[0]) === __FILE__` (`backup.php:236`) so that
  `require 'backup.php'` prints nothing and exits nothing. `php backup.php` is unchanged, down to
  the exit code 2 when another backup holds the lock; a direct HTTP hit on `backup.php` is still
  refused with 403 (`backup.php:226`). A finished backup for today is still left alone — the
  button then says so instead of copying again.
- **"Repair upload permissions" on `restore.php`.** A second POST button that runs
  `fixUploadPermissions()` (`restore.php:219`) over the live `uploads/` tree without restoring
  anything: chmod 0755 on the directories, 0644 on the files, counted, chmod failures counted
  separately and named in the flash rather than thrown. This is the manual fix for a folder that
  arrived by FTP or from an older restore and answers 403 on every photo.
- **Docs**: `project.md` and this changelog.
- **Housekeeping**: four `phpqrcode/q*.png-errors.txt` GD warning logs, left behind by a scratch
  probe rather than by the app, removed from the working tree.

### Fixed

- **A restore left `uploads/` unreadable by the web server: every item photo answered 403.**
  `restore.php` wrote *everything* it copied as 0640 in 0750 directories. That is right for
  `data.json`, `checkout.json`, `users.json`, `documents/` and `lib/config.local.php` — PHP is the
  only reader — but wrong for `uploads/`, which Apache serves itself, and on a host where the web
  server runs as a different user than PHP a 0640 photo is a 403. `lib/photo.php` has always
  written 0755/0644 there (`lib/photo.php:121-125`, `:267`); a restore silently undid it.
  `copyFileSafe()`, `copyDirectorySafe()` and `restoreDirectorySnapshot()` now take a mode set,
  and pass its directory mode on to `ensureDir()` — `RESTORE_PRIVATE_MODES` (0750/0640) or
  `RESTORE_PUBLIC_MODES` (0755/0644), `restore.php:72-73`. The uploads branch is the only caller
  that passes the public one
  (`restore.php:713-718`), followed by a `fixUploadPermissions()` sweep of the whole live tree whose
  count goes into the success flash. Everything else, the pre-restore safety snapshot included,
  stays private exactly as before.
- **The admin shell hung on the boot spinner after pulling the two per-unit pushes.** Only
  `app/main.js` and `app/app.css` were cache-busted (`admin.php:42`); the other 28 modules are
  reached through the relative specifiers written inside the files (`../lib/format.js` &c.), which
  no server-side URL can touch, so the browser cached each of them on its own heuristic. Neither
  push changed `main.js`, so its `?v=<mtime>` stayed the same and its cached copy was reused —
  while `AssetSheet.js`, modified minutes before the pull and therefore heuristically stale, was
  re-fetched. That mix is not a stale screen but a dead one: the new component asks for exports
  the cached `format.js` does not have, and
  `Uncaught SyntaxError: The requested module '../lib/format.js' does not provide an export named
  'addMonths'` kills the whole module graph before `app.mount()` — leaving the server-rendered
  `.trax-boot` placeholder (app name + spinner) on screen for ever, with nothing in the UI to say
  why. `conditionSummary`, `unitPriceOf`, `totalPriceOf`, `purchasedAtOf` and `warrantyUntilOf`
  are all new cross-module exports from these two pushes, so any pairing of a fresh importer with
  a cached `format.js` fails the same way. The version is now ONE token — the newest mtime under
  `app/` — carried into every module by a generated import map, so a deploy invalidates the graph
  whole or not at all (`admin.php:41-127`, `admin.php:172`). Reproduced end to end with a static
  server that sends `Last-Modified`/`ETag` and no `Cache-Control`, as stock Apache does: the old
  generation loaded and cached, the two pushes applied as a pull, reload → the boot spinner and
  that exact SyntaxError; the same browser with the same dirty cache mounted and rendered the
  inventory as soon as the fixed `admin.php` was in place, all 29 module URLs re-fetched under the
  shared token. The data on disk was ruled out first: `api.php?action=bootstrap` answers HTTP 200
  with valid JSON for records written before both pushes (units with no `price`, `purchasedAt` or
  `warrantyUntil`, assets with no `unitSeq`, a kit, checkout lines with no `unitNos`), and the app
  renders that data — inventory, dashboard, asset sheet for a unit-tracked and a plain asset —
  with a clean console.

- **Sorting by value ordered a unit-priced asset by a price that is not on the screen.** The Value
  column renders `totalPriceOf()` — the sum of the unit prices once any unit carries one, else
  `price x quantity` (`app/lib/format.js:265`) — while `sortedAssets` still compared the stored
  `asset.price` (`app/store.js:320`), which a unit-priced asset keeps unchanged and which is
  therefore stale the moment the units are priced. An asset showing €22.50 sorted as 99.99. The
  price branch now reads `totalPriceOf()` for both sides (`app/store.js:320-328`); every other
  branch and the existing null handling (a missing value still compares as 0, so unpriced assets
  stay first ascending) are unchanged. Verified in a sandbox with an asset priced 3 x €7.50 per
  unit over a stored price of 99.99: ascending it was last (after €100.00) before and sits between
  €12.00 and €100.00 after; descending is the exact reverse. Note that nothing in the UI sets
  `sortBy: 'price'` today — the Value header carries no sort button — so the path is reachable
  only from a saved view state.

- **The public QR page and its captcha no longer demand a login on an external-auth host.**
  Adding the captcha put `require_once lib/auth.php` into `index.php` and `captcha.php` — and
  `lib/auth.php` runs `require_once TRAX_AUTH_INCLUDE` at *global* scope whenever the install is in
  external-auth mode (everything but `install.php`). On a host whose `check_auth.php` redirects an
  unauthenticated request, that bootstrap fired before a single byte of the public page: scanning a
  printed label answered `302 → the host login page`, and so did `captcha.php`. Verified against a
  sandbox in external mode with a redirecting `check_auth.php`: both were `302 /login-external`
  before, both are `200` after (`index.php` HTML and no `Set-Cookie`, `captcha.php` `image/png`),
  while `admin.php` still redirects. Both files now include the new `lib/public-session.php` and
  call `trax_public_session()` (`index.php:21`, `:87`; `captcha.php:19`, `:36`) — a standalone twin
  of `trax_ensure_session()` with the same cookie flags (`httponly`, `SameSite=Lax`, `secure` only
  on TLS incl. `X-Forwarded-Proto`, `use_strict_mode`) and no auth. Neither public file references
  any function that lives only in `lib/auth.php`.
- **Category and location suggestions on the asset sheet no longer repeat a value once per
  asset.** The two `<datalist>`s in `AssetSheet` mapped over `state.assets` directly
  (`app/components/AssetSheet.js:869-874`), so a category used by three assets was offered three
  times. They now read the shared, de-duplicated and sorted `categories` / `locations` computeds
  (`app/store.js:223-228`) that `FilterBar` and `BulkEditDrawer` already used. Both fields stay
  free-text inputs — a new category can still simply be typed.
- **Blocked items no longer show or grant free units.** `trax_is_blocked()` (`lib/store.php:1473`,
  stored status `LOCK` or `UNAV`) makes `trax_available_qty()` / `trax_available_qty_for()` and the
  snapshot decorator report `availableQty 0`; `public.php` reports the same. Previously a `LOCK`
  asset could still be checked out: `checkout.create` and `reservation.convert` now treat a blocked
  asset as 0 available and answer 409 `CONFLICT` with the usual `blocked[]` payload.
- `StatusBadge` suppresses the "X of Y free" detail when the status is `LOCK`; `AssetCards` hides
  its standalone free-count span for `LOCK`.
- `public.php` uses the shared availability function instead of a hand-rolled copy, which used to
  report an all-out-of-service asset as `LOCK` **and** `availableQty 2` in the same payload.
- **Asset table wheel-scroll stutter.** `AssetTable` no longer sets `overflow:auto` inline; the new
  `.trax-table-wrap` class (`app/app.css:216`) is `overflow-x: auto; overflow-y: hidden`, so
  vertical wheel input chains to the page scroller.
- `checkout.checkin` with only `units[]` that are all not out answers 200 with `notOut` instead of
  400.
- `extractRef()` rejects unit 0.
- **Unit numbers are never reused.** The asset carries `unitSeq`, the high-water mark of the numbers
  it has handed out (`trax_normalize_asset()`, `lib/store.php:371-377, 445`); `apply_units_patch()`
  numbers a new unit `max(unitSeq, existing nos, patch nos) + 1` (`api.php:634`) and writes the mark
  back onto the asset (`api.php:928`, `api.php:970`). Deleting `12.3` used to free `12.3` for the
  next unit added, so a label already printed for it came to mean different gear; the number is now
  retired and the list simply keeps a gap. `unitSeq` is server-managed — it is not in the
  `apply_asset_patch()` whitelist, so a client cannot lower it — and a record written before the
  field existed rebuilds it from `max(unit no)` on first read.
- **The drawer tab bar fits all five tabs.** Five tabs measured ~578px against a ~487px drawer, so
  "History" was clipped off the right with nothing to show it was there. `.nav-tabs-sm .nav-link`
  now uses `0.35rem 0.55rem` padding at `0.8rem`, with smaller count badges
  (`app/app.css:461-470`); measured 487px against 487px on the asset sheet. The nowrap/scroll rules
  stay as the fallback below ~600px viewport width.

### Changed

- **`asset.bulkUpdate` now skips `condition` for an asset that tracks units**, the same way it
  already skipped `quantity`: the patch key is unset per asset behind
  `trax_asset_has_units()` before `apply_asset_patch()` runs (`api.php:1078-1086`), so a bulk grade
  lands on plain assets and silently leaves unit-tracking ones alone rather than writing a value
  nothing displays. The rest of the same patch — status, category, location, supplier — still
  applies to them. `BulkEditDrawer` says so under the condition select.
- **The whole instance is now out of search engines, uniformly.**
  `Header always set X-Robots-Tag "noindex, nofollow"` in `.htaccess` (inside `<IfModule
  mod_headers.c>`, so a host without the module does not 500) covers every response from the
  folder, static files included. Because mod_headers may be absent, the same header is also sent
  from PHP on `admin.php:7`, `restore.php:26`, `download.php:34` (all three ahead of the auth gate,
  so the 302 to `login.php` carries it too), `index.php:24`, `view.php:24`, `public.php:29`,
  `captcha.php:28,94`, `label.php:115,1856` and `label-w.php:120,2178` (both label files set it in
  the error-image helper as well as on the rendered PNG). `<meta name="robots" content="noindex,
  nofollow">` added to `admin.php`, `restore.php` and `scandebug.html`; `index.php` and `view.php`
  upgraded from plain `noindex`. New `robots.txt` disallows everything.
- `trax_available_qty_for()` (`lib/store.php:1572`) is now **the** availability function —
  blocked-aware and unit-aware. `trax_available_qty()`, the decorator, `trax_effective_status()`,
  `checkout.create` and `reservation.convert` all route through it; they used to carry separate
  copies of `quantity - lines_qty` and the copies drifted. A legacy line that holds quantity without
  naming a unit still subtracts.
- Effective status of a unit-tracking item (`trax_effective_status()`, `lib/store.php:1619`): every
  unit out of service and nothing out → `LOCK`; some free, some out of service → `PARTIAL`.
- `asset.bulkUpdate` silently skips `quantity` for an asset that tracks units, rather than pretend
  it was applied (`api.php:1067`).
- The all-blocked + `allowPartial` message is now "None of the selected items is available right
  now." (`api.php:1544`) — a locked or out-of-service asset is unavailable while sitting on the
  shelf, not "checked out".
- `StatusBadge` takes an optional `label` prop; an out-of-service unit badge reads "Out of service".
- Portrait label ID bar shrinks to fit, like the wide one already did.
- `trax_label_url()` docblock updated for the unit argument.

### Known gaps / unverified

- `reservation.create` still accepts a blocked asset: the reservation conflict engine is
  time-window based and does not consult `trax_is_blocked()`. Converting such a reservation is
  refused.
- The `.htaccess` numeric rewrite is **unverified** — there is no Apache in the local environment
  and the PHP built-in server ignores `.htaccess`. The `?id=&u=` form is verified.
- The portrait label prints `<name> – <unit label>` in a name area capped at three wrapped lines
  (`label.php:1646-1712`); a long pair is cut off silently. The wide label puts the unit label in
  the notes strip instead.
- The asset-table wheel fix is **structural, not proven against the reported symptom**: the phantom
  vertical scrollbar could not be reproduced in headless Chrome. The sticky `thead th` rule remains
  ineffective (pre-existing, untouched).
- The per-unit price and `BLOCKED` **server** behaviour is verified end to end — normaliser suite
  plus live `asset.create` / `asset.update` / `asset.bulkUpdate` / `public.php` against a sandbox
  install. The **browser** half of those two entries (the unit price input, the read-only asset
  price field, the Value column, the condition summary, the wider drawer) was written and checked
  separately; it is not covered by any of the server checks above.
