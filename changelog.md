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
- **Docs**: `project.md` and this changelog.
- **Housekeeping**: four `phpqrcode/q*.png-errors.txt` GD warning logs, left behind by a scratch
  probe rather than by the app, removed from the working tree.

### Fixed

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
