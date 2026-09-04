> Keep this file and `changelog.md` updated with every change.

# Trax — project overview

Developer-facing map of the codebase. Operator-facing instructions (hosting requirements,
installing, backups, cron, external auth) live in [README.md](README.md) and are not repeated here.

## Purpose

Trax is a self-hosted inventory and lending tool: what an organisation owns, who has it, when it
is due back. Every asset gets a printable QR label; scanning it opens an unauthenticated public page
saying whether the item is available and how to reach the owner. Customers get a token-addressed
booking page for their own transaction. Sized for one or two operators. No database.

## Stack & constraints

- **PHP 8.1+**, extensions `gd`, `mbstring`, `json`, `fileinfo`, `session`. Apache with `.htaccess`
  for the protection and clean-URL rules.
- **Vue 3 via ESM importmap**, no bundler: `admin.php:87-93` maps `vue` to
  `vendor/vue.esm-browser.prod.js` — the full build *with* the runtime compiler, because every
  component ships a `template` string (`app/main.js`).
- **No database, no composer, no npm, no build step.** Third-party code is vendored under `vendor/`
  (Bootstrap 5, Bootstrap Icons, Vue, jsPDF + autotable, jsQR, qr.min.js), `phpqrcode/` and `fonts/`.
- **Cache busting** is `asset_version()` (`admin.php:39-43`): `?v=<filemtime>` on `app/app.css` and
  `app/main.js`. There is no build hash.
- Data is JSON files on disk; concurrency is a lock file plus a revision number.

## Directory map

| Path | Role |
|---|---|
| `api.php` | The single authenticated JSON endpoint. Every admin read and write. |
| `admin.php` | SPA shell: auth gate, meta tags, importmap, mounts `app/main.js`. |
| `index.php` | Public asset page — the target of every printed QR label. |
| `public.php` | Public asset lookup, allow-list of safe fields. Feeds `index.php` and `view.php`. |
| `view.php` | Public read-only inventory board, refreshes every 30s. |
| `booking.php` | Customer booking page, addressed **only** by a 64-hex token (`?t=`). |
| `captcha.php` | GD-rendered captcha PNG for the public report form; the code lives in the session. |
| `label.php`, `label-w.php` | GD-rendered PNG labels, portrait 14×30 mm and wide 30×14 mm. |
| `download.php` | The only read path into `documents/`; that directory denies the web outright. |
| `cron.php` | Reminder cron. CLI (`php cron.php [--dry-run]`) or `GET ?secret=<cron.secret>`. |
| `login.php`, `logout.php` | Session in, session out. Both require the CSRF token. |
| `install.php` + `lib/install.php` | Seven-step wizard; nothing is written until "Install" on step 6. |
| `backup.php` | The daily backup. `trax_run_backup()` is the whole of it (`backup.php:106`); the CLI runner below it fires only when this file is the script being run, so `restore.php` can include it. A direct HTTP hit is still 403. |
| `restore.php` | Browser restore UI. Also "Create backup now" and "Repair upload permissions" (POST actions `backup` / `fixperms`). |
| `lib/config.php` | All `TRAX_*` constants, every one guarded by `defined()` so `lib/config.local.php` (loaded first) wins. |
| `lib/store.php` | The data layer: normalisers, derived status, atomic writes, `trax_mutate()`. |
| `lib/auth.php` | Sessions, CSRF, built-in vs. external auth mode. Includes `TRAX_AUTH_INCLUDE` at **global scope** in external mode — never load it from a public page. |
| `lib/public-session.php` | `trax_public_session()`, the auth-free session start for `index.php` and `captcha.php`. A standalone twin of `trax_ensure_session()`. |
| `lib/mailer.php` | Transactional mail; addresses and headers validated and CR/LF-stripped. |
| `lib/photo.php` | Photos re-encoded through GD (strips EXIF, neutralises payloads). |
| `lib/documents.php` | Documents are stored as uploaded — hence the separate, web-denied directory. |
| `lib/config-local.php` | The single writer of `lib/config.local.php` (installer + Settings → Authentication). |
| `lib/demo-data.php` | Optional demo dataset the installer can seed. |
| `app/` | The Vue app (see [Frontend architecture](#frontend-architecture)). |

## Data model

Storage lives in `TRAX_DATA_DIR` (`lib/config.php:33-42`; the project root by default, overridden by
the `TRAX_DATA_DIR` environment variable when it names a readable directory): `data.json` (+
`data.json.bak`, rewritten on every save, `lib/store.php:1979`), `checkout.json`, `users.json`,
`uploads/`, `documents/`, `.trax.lock`.

`trax_normalize_data()` (`lib/store.php:1329-1376`) **is** the schema: `rev`, `assets`, `events`,
`reservations`, `rentalHistory`, `bookings`, `settings`, `cronState`. A top-level key not in that
literal is dropped on the next write, because `trax_mutate()` re-normalises the whole tree before
committing. Add a key only together with its normaliser.

### Asset — `trax_normalize_asset()` (`lib/store.php:333-476`)

| Field | Notes |
|---|---|
| `id` | int, sequential |
| `name` | ≤ `TRAX_MAX_NAME` (200) |
| `status` | `FREE` \| `RSVD` \| `UNAV` \| `LOCK` (`lib/config.php:356`) |
| `notes`, `category`, `location` | free text; category/location ≤ 120 |
| `quantity` | int 1..`TRAX_MAX_QUANTITY` (9999); forced to 1 for a `SET`; **derived** from `units` when that list is non-empty |
| `units` | `[{no, label, serial, condition, price, purchasedAt, warrantyUntil, outOfService, note}]`, `ITEM` only, always `[]` for a `SET` — see [Units](#units-per-unit-tracking) |
| `kind` | `ITEM` \| `SET` (`lib/config.php:358`) |
| `members` | `[{assetId, qty}]`, sets only; legacy flat `[3,4,5]` still accepted |
| `serial`, `supplier` | ≤ 120 |
| `purchasedAt`, `warrantyUntil` | dates. Stored exactly as the client sends them — the server never derives or overwrites them, and they are ignored once the units carry their own (`unitDated`). Hidden in the sheet while the asset tracks units |
| `price`, `currency` | float ≥ 0 rounded to 2; currency defaults to `EUR`. The price of **one** piece. Stored exactly as the client sends it — the server never derives or overwrites it, and it is ignored for the value of an asset whose units carry their own prices |
| `condition` | `NEW` \| `GOOD` \| `FAIR` \| `POOR` \| `DEFECT` \| `BLOCKED` (`lib/config.php:365`). Informational only — nothing derives from it. Hidden in the sheet once the asset tracks units, which grade themselves |
| `photo`, `tags` | file name in `uploads/`; unique tag strings ≤ 60 |
| `conditionLog` | dated condition photos of the asset itself, independent of any loan |
| `documents` | attached files, served only via `download.php` |

### Units (per-unit tracking)

`trax_normalize_unit()` (`lib/store.php:302-331`). An `ITEM` may list its physical units one by
one — the thing an operator can tell apart from its neighbour: unit `12.1` is the Sommer cable,
`12.2` the Cordial. Optional: an asset with `units: []` is the pre-feature record and is counted
by `quantity` alone. A `SET` never has units; its members do.

| Field | Notes |
|---|---|
| `no` | int ≥ 1, the unit's number **within its asset**. Assigned server-side (`apply_units_patch()` `api.php:616`), never by the client. Written and scanned as `12.3` (`trax_unit_code()` `lib/store.php:1501`) |
| `label` | ≤ 120, what the operator calls this one ("Sommer") |
| `serial` | ≤ 120 |
| `condition` | `NEW` \| `GOOD` \| `FAIR` \| `POOR` \| `DEFECT` \| `BLOCKED`, defaults `GOOD` |
| `price` | float ≥ 0 rounded to 2, or `null`. What *this* piece cost — two of the same model rarely cost the same twice. Normalised exactly like the asset price (`trax_float()`, negative → `null`). There is no per-unit currency: `asset.currency` covers the whole record |
| `purchasedAt`, `warrantyUntil` | dates, `YYYY-MM-DD` or `null`. When *this* piece was bought and how long its cover runs — units of the same model are bought on different days. Normalised by `trax_date()`, exactly like the asset's own pair |
| `outOfService` | bool — off the shelf by hand: broken, in the workshop. It stays part of the asset and keeps its number |
| `note` | ≤ 500 |

The high-water mark lives on the asset, not on the unit:

| Field | Notes |
|---|---|
| `unitSeq` | int ≥ 0 on the **asset** (`lib/store.php:381-386, 455`). The highest unit number this asset has ever handed out. Server-managed: it is not in the `apply_asset_patch()` whitelist, and it only ever goes up, so removing a unit retires its number instead of freeing it. `0` for a `SET`. Absent on a legacy record and rebuilt from `max(unit no)` on first read |

Rules:

- The list is sorted by `no`, duplicate numbers are dropped, and it is capped at `TRAX_MAX_UNITS`
  (500, `lib/config.php:407`) — deliberately far below `TRAX_MAX_QUANTITY`, because units are
  hand-managed rows an operator reads, not a bulk counter.
- **A non-empty list *is* the count**: `quantity = count(units)` on write (`lib/store.php:394-397`).
  Two sources of truth for "how many are there" is how an asset ends up owing units it never had.
- **State is derived, never stored.** `trax_unit_states()` (`lib/store.php:1517`) returns
  `{state, lineId, customerName, dueAt}` per number:
  - `OUT` — an open checkout line names the number. This wins even over `outOfService`: the gear is
    physically gone, and saying otherwise would let it be handed out twice.
  - `OOS` — flagged `outOfService` and not out.
  - `FREE` — otherwise. `trax_available_unit_nos()` (`lib/store.php:1562`) is the ascending list of
    these.
- Checkout lines, history events and booking items carry `unitNos: int[]`
  (`trax_unit_nos()` `lib/store.php:242`, `trax_item_pair()` `lib/store.php:273`). An empty
  `unitNos` on a line for a unit-tracking asset is a **legacy** line: it claims *some* unit without
  naming it, and availability subtracts it (see below).
- `trax_asset_has_units()` (`lib/store.php:1495`) is the one test for "does this asset track units".

### Checkout line — `trax_normalize_checkout()` (`lib/store.php:672-717`)

Keyed by `lineId`, not by asset: one asset can be out on several lines at once.

| Field | Notes |
|---|---|
| `lineId` | primary key, from `trax_next_line_id()` |
| `assetId`, `qty` | which asset, how many units |
| `name` | asset name snapshot |
| `checkedOut`, `dueAt`, `returnDate` | ISO; `returnDate` is the localised mirror, either side backfilled |
| `customerName`, `customerEmail`, `note` | |
| `reservationId`, `setId`, `bookingId` | provenance links, nullable |

### Reservation — `trax_normalize_reservation()` (`lib/store.php:576-631`)

| Field | Notes |
|---|---|
| `id` | |
| `items` | `[{assetId, qty}]`; a legacy `assetIds` list becomes one unit each |
| `assetIds` | derived mirror of the unique ids, kept for the older conflict code |
| `setIds` | what the user actually booked, so the UI can say "Camera Kit A" |
| `customerName`, `customerEmail`, `notes` | |
| `startAt`, `endAt` | ISO |
| `status` | `ACTIVE` \| `CONVERTED` \| `COMPLETED` \| `CANCELLED` (`lib/config.php:367`) |
| `createdAt`, `convertedAt`, `completedAt`, `cancelledAt` | timestamps per transition |

### Booking — `trax_normalize_booking()` (`lib/store.php:812-874`)

One record per customer transaction, addressed publicly by an unguessable 64-hex
`token`. `items` is a **snapshot** taken at creation: checkout lines are deleted
on a full return, so a booking that looked its items up later would go blank the
moment the gear came back.

| Field | Notes |
|---|---|
| `id`, `token` | token is 64 lower-case hex, the only public key |
| `kind` | `checkout` \| `reservation` — lower case, it is not a status (`lib/config.php:370`) |
| `reservationId`, `customerName`, `customerEmail`, `notes` | `reservationId` nullable |
| `createdAt`, `startAt`, `dueAt` | ISO |
| `expiresAt` | `TRAX_BOOKING_LINK_DAYS` (30) after due; a stored value is kept |
| `status` | `OPEN` \| `RETURNED` \| `CANCELLED` |
| `items`, `photos` | snapshot lines; hand-over / check-in photos |
| `notified` | what the reminder cron has already sent |

### Settings

`trax_normalize_settings()` (`lib/store.php:1167-1264`), four groups: `email.*`
(addresses, per-mail kill switches, editable subject/body `templates`),
`branding.*` (`appName`, `orgName`, `brandColor`, `publicPath`, `logoFile`,
`faviconFile`, `labelHeading`, `whatsapp`), `defaults.*` (`loanDays`, `dueHour`,
`reservationStartHour`, `warrantyMonths` — 0..120, default 24, months added to a purchase date to
auto-fill the warranty date in the asset sheet, `0` off —, `currency`, `allowPartialDefault`,
`overdueGraceDays`, `locale`, `dateFormat`) and `cron.*` (`secret`, `dueSoonHours`,
`overdueRepeatDays`). Each key falls back to a `TRAX_*` constant.

## Derived availability & status rules

Nothing about availability is stored. `trax_decorate_assets()` (`lib/store.php:2219-2277`) adds
thirteen derived fields to every asset in the snapshot: `effectiveStatus`, `outQty`, `availableQty`,
`isOut`, `memberOf`, `availableUnitNos`, `unitPriced`, `priceTotal`, `pricedUnits`, `unitDated`,
`purchasedFirst`, `warrantyNext`, `warrantyNextUnit` — plus, on a unit-tracking asset, `state` /
`lineId` / `customerName` / `dueAt` on each entry of `units`. All of it is dropped again by
`trax_normalize_asset()` on write, so none of it can be read back as truth.

`trax_available_qty_for($asset, $linesForThatAsset)` (`lib/store.php:1587`) is **the** availability
function — blocked-aware and unit-aware. `trax_available_qty()`, the decorator,
`trax_effective_status()`, `checkout.create`, `reservation.convert` and `public.php` all route
through it. There used to be several copies of `quantity - lines_qty` and they drifted.

- `outQty` = sum of `qty` over all open checkout lines for the asset.
- `availableQty`:
  - `0` when the asset is *blocked* — stored `status` `LOCK` or `UNAV` (`trax_is_blocked()`
    `lib/store.php:1488`). This is checked first, so a blocked asset never shows or grants free
    units.
  - a unit-tracking asset: `count(free units) - (quantity held by legacy lines that name no unit)`,
    floored at 0. That subtraction matters — counting the free units in full would hand the same
    piece of gear out twice.
  - otherwise `quantity - outQty`.
- `effectiveStatus` (`trax_effective_status()` `lib/store.php:1634-1692`):
  - **ITEM**: own `LOCK` → `LOCK`; available 0 with *nothing out* → `LOCK` (every unit is flagged
    out of service, which is off the shelf, not lent out — unreachable without units); available 0
    → `UNAV`; `0 < available < quantity` → `PARTIAL`; else the stored status.
  - **SET**: own `LOCK` → `LOCK`; any member short of its `qty`, or stamped `UNAV`/`LOCK` by hand →
    `PARTIAL`; any member `RSVD` → `RSVD`; else `FREE`.
- **`PARTIAL` is derived only**, never written to disk — it is not in `TRAX_STATUSES`.
- `trax_assert_quantity_covers_checkouts()` (`lib/store.php:1698`) refuses a quantity edit smaller
  than what is already out.
- Which units actually leave on a line is decided by `trax_pick_units()` (`api.php:688`): the
  operator's named units first, in full, then the lowest free numbers to fill the count. A named
  unit that is not free is reported back as a shortfall rather than quietly swapped — "give me the
  Sommer cable" is not the same request as "give me a cable".

### Derived value — `trax_asset_value()` (`lib/store.php:2143-2169`)

What an asset is worth is derived the same way, from the units when they price themselves and from
the asset otherwise. Three keys, added by the decorator and dropped on write like the rest:

| Field | Notes |
|---|---|
| `unitPriced` | bool — an `ITEM` with units, at least one of which has a `price`. `false` for a `SET`, for a unit-less asset and for a unit list where nobody named a price |
| `priceTotal` | float\|null — `unitPriced`: the sum of the unit prices, a unit without one counting as `0`. Otherwise `price × quantity`, or `null` when the asset has no price either. Each unit price is already rounded to 2 dp on write, so the sum is rounded once more only to clear float noise: `[10, null, 5.255]` stores `[10, null, 5.26]` and totals `15.26` |
| `pricedUnits` | int — how many units carry a price; `0` whenever `unitPriced` is false. It is what tells "5 of 8 units priced" from "all 8 priced" |

Out-of-service and checked-out units count in the total: the money is still the organisation's. The
stored `asset.price` is never derived from the units and never overwritten — it stays whatever the
client last sent, and is simply not consulted while `unitPriced`.

### Derived dates — `trax_asset_dates()` (`lib/store.php:2186-2213`)

Same shape again, for "when was it bought" and "when does the cover lapse". Units of the same model
are bought on different days, so an asset-level purchase date is a fiction once units exist — and
the warranty that matters is the *next* one to run out, not the record's. Four keys, added by the
decorator and dropped on write:

| Field | Notes |
|---|---|
| `unitDated` | bool — an `ITEM` with units, at least one of which names a `purchasedAt` **or** a `warrantyUntil`. `false` for a `SET`, for a unit-less asset and for a unit list where nobody named a date |
| `purchasedFirst` | string\|null — `unitDated`: the earliest non-null unit `purchasedAt`. Otherwise the asset's own `purchasedAt` |
| `warrantyNext` | string\|null — `unitDated`: the earliest non-null unit `warrantyUntil`, the next cover to lapse. Otherwise the asset's own `warrantyUntil` |
| `warrantyNextUnit` | int\|null — the `no` of the unit that supplied `warrantyNext`; `null` when the asset is not `unitDated`, or when it is but no unit named a warranty. A tie goes to the lowest number, because the list is sorted by `no` |

`YYYY-MM-DD` sorts lexically, so "earliest" is a plain string comparison. `unitDated` is one flag
for both dates: a unit list that names only warranties reports `purchasedFirst: null` rather than
falling back to the asset's purchase date, so the two halves can never come from two sources.
Out-of-service and checked-out units count — the warranty runs regardless of where the gear is.
The stored `asset.purchasedAt` / `asset.warrantyUntil` are never derived or overwritten; the sheet
hides them and omits them from the patch while the asset tracks units, so a legacy record keeps
whatever it already had.

## API contract

`api.php` is the only authenticated endpoint. Contract at `api.php:9-18`:

```
GET  api.php?action=<read action>
POST api.php  {"action":"…","rev":<int>,"payload":{…}}   Content-Type: application/json

{ "ok": true,  "rev": 42, "data": { … } }
{ "ok": false, "error": { "code": "STALE", "message": "…", "details": { … } } }
```

Every mutation sends a delta and gets the **full snapshot** back (`trax_snapshot()`
`api.php:115-129`: `rev`, `assets` (decorated), `reservations`, `history`, `checkouts`, `bookings`,
`settings`). That is why the client has no merge logic at all.

- **Reads** (GET): `bootstrap` (snapshot + `csrf` + a `meta` block of vocabularies, limits and mail
  templates), `auth.me`, `auth.config`.
- **Writes** (POST): `asset.create|update|delete|bulkUpdate`, `asset.uploadPhoto`,
  `asset.deletePhoto`, `asset.uploadConditionPhotos|deleteConditionPhoto`,
  `asset.uploadDocuments|deleteDocument`, `set.create|update|delete`,
  `checkout.create|extend|checkin`, `reservation.create|convert|cancel`,
  `booking.resend|uploadPhotos|deletePhoto`, `settings.update`,
  `auth.changePassword|testInclude|configUpdate`, `taxonomy.rename|merge|delete`.
- **Concurrency**: `trax_mutate($expectedRev, $mutator)` (`lib/store.php:1946`) holds `LOCK_EX` on
  `.trax.lock` across the read-modify-write of *both* `data.json` and `checkout.json`, so cross-file
  operations commit together. Writes go through `trax_write_atomic()` (`lib/store.php:1880`): temp
  file in the same directory, `fsync`, `rename()`.
- **Error codes**: `STALE` (rev behind), `CONFLICT` (items unavailable; `details.blocked` says
  which), `BAD_REQUEST`, `UNAUTHENTICATED`, `FORBIDDEN` (CSRF), `TOO_LARGE`, `UNSUPPORTED_MEDIA`,
  `SERVER`. `INSTALL_REQUIRED` is synthesised client-side (`app/api.js:72`) from the gate's flat
  `{"ok":false,"code":"install-required"}` / HTTP 503.
- Mutations must be `application/json`, or `multipart/form-data` for uploads where the payload is an
  explicit allow-list (`api.php:153-162`), and must carry the CSRF token.

### Unit-aware payload shapes

```jsonc
// asset.create / asset.update — a unit with no "no" is a NEW unit and is numbered server-side.
{"action":"asset.update","payload":{"id":12,"units":[
  {"no":1,"label":"Sommer","serial":"","condition":"GOOD","outOfService":false,"note":""},
  {"label":"new one"}                       // -> gets the next free number
]}}
// 400 BAD_REQUEST: kits have no units; a number listed twice; > 500 units;
//                  removing a unit that is currently OUT.
// asset.bulkUpdate silently drops `quantity` AND `condition` for an asset that tracks units.

// checkout.create — name the units, or leave unitNos out and take the lowest free ones.
{"action":"checkout.create","payload":{"items":[{"assetId":12,"qty":2,"unitNos":[1,3]}], …}}
// 409 CONFLICT details.blocked[] = [{assetId, name, wanted, available, who, until, viaSet,
//                                    unitNos}]  <- unitNos = the requested units that cannot go

// reservation.convert — reservations are product-level, so units are auto-assigned.
//   blocked[].unitNos is always [] here.

// checkout.checkin — three request forms, combinable.
{"action":"checkout.checkin","payload":{
  "lines":[{"lineId":7,"qty":1,"unitNos":[3]}],   // omit qty for the whole line
  "units":[{"assetId":12,"no":3}],                // a scanned unit, found wherever it is out
  "assetIds":[12]                                 // every open line of those assets, in full
}}
// response adds: returned, lines, closedBookings, notOut[]  <- scanned units nothing had out
```

Everything that snapshots a loan carries the numbers too: checkout lines, `history` events and
booking `items` all have `unitNos: int[]`. Mail item lines spell them out — `" (units 12.1, 12.3)"`
(`lib/mailer.php:141-162`).

## Public pages, QR & label URLs

`trax_label_url($id, $unit = null)` (`lib/config.php:519`) is what a printed QR encodes. Two forms,
picked by `TRAX_LABEL_URL_FORM`:

| Form | Product | One unit |
|---|---|---|
| short | `HTTPS://HOST/12` | `HTTPS://HOST/12.1` |
| query | `https://host/?id=12` | `https://host/?id=12&u=1` |

(The query form is `TRAX_PUBLIC_PATH` — `/` by default, `lib/config.php:149` — with the id appended,
so it is served by `index.php` as the `DirectoryIndex`.)

- Upper case in the short form is not cosmetic: it puts the string in QR's **alphanumeric** mode.
  The dot is in that charset (unlike `?` and `=`), so naming a unit does not push the symbol to a
  larger QR version. The short form is skipped when `TRAX_LABEL_SHORT_PATH` contains a lower-case
  letter, which upper-casing would break on a case-sensitive filesystem.
- `.htaccess:70` maps the short form back: `^(\d+)(?:\.(\d+))?/?$ → index.php?id=$1&u=$2`,
  guarded by `!-f`.
- `index.php` resolves `?id=&u=` and re-parses `/12.1` off the path itself, so it still works where
  the rewrite does not. An unknown `u` falls back to the product page rather than claim a unit that
  no longer exists. It renders "ID 12.1 · <label>" and unit-level availability wording.
- `public.php?id=12&u=1` adds `unit: {no, code, label, state}` to the allow-listed payload. It never
  returns the holder or the due date for a unit — that is admin-only. No price ever leaves the
  public endpoint either: neither `price`, nor the derived `priceTotal` / `unitPriced`.
- The "Report this item found" form on `index.php` is gated by a honeypot field (`website`) and a
  five-character captcha drawn by `captcha.php`. The answer is `$_SESSION['trax_captcha']`, good for
  ten minutes and for one submit; the image is requested only when the dialog opens, so a plain scan
  still starts no session. `index.php` is the only public page that touches the session, and only on
  POST.
- Neither public page may include `lib/auth.php`: it does `require_once TRAX_AUTH_INCLUDE` at global
  scope in external-auth mode, which puts a scanned label behind the host login. They include
  `lib/public-session.php` and call `trax_public_session()` instead (`index.php:21`, `captcha.php:19`).
- `label.php` / `label-w.php` take the same `u` and print `ID: 12.1`. Portrait appends the unit's
  own label to the asset name; wide puts it in the notes strip.
- `ScanDrawer.extractRef()` is the client-side inverse and accepts all of `12.1`, `/12.1`,
  `?id=12&u=1` and the loose fallbacks. It is exported for testing.

## Frontend architecture

- `app/main.js` — creates the app, mounts `AppShell` on `#app`, routes component errors and
  unhandled rejections into a toast.
- `app/api.js` — the only fetch wrapper. Owns the CSRF token (read off the meta tag `admin.php`
  renders), the `ApiError` class (`isStale`, `isBlocked`, `isRedirecting`) and the redirects to
  `login.php` / `install.php`.
- `app/store.js` — one reactive singleton (module identity is the singleton; no Pinia). `load()` and
  `mutate()` are the only paths in and out; `mutate()` retries **once** on `STALE` and re-throws
  `CONFLICT` so the caller can offer a choice. Filters/columns/density persist to `localStorage`
  under `traxAdminViewStateV2`, with a `columnsVersion` migration for columns added later.
- `app/lib/` — `format.js` (dates, money, `STATUS_LABEL`/`STATUS_CLASS`, UI locale), `schedule.js`
  (interval conflicts and the calendar timeline), `insights.js` (utilisation maths), `pdf.js` (jsPDF
  is a UMD bundle, so it is injected as a `<script>` on demand and read off `window` — ~400 KB kept
  out of the initial load).
- `app/components/` — `AppShell` (nav, drawers, layout), `FilterBar`, `AssetTable` (desktop) /
  `AssetCards` (narrow), `AssetSheet`, `SetEditor`, `BasketDrawer`, `BulkEditDrawer`, `ScanDrawer`
  (jsQR, loaded on demand), `LabelDrawer`, and the views `DashboardView`, `CheckoutsView`,
  `ReservationsView`, `CalendarView`, `InsightsView`, `SettingsView`. Shared primitives in
  `app/components/ui/`: `Drawer`, `ConfirmDialog`, `ToastHost`, `StatusBadge`.
- Navigation ids: `dashboard`, `inventory`, `kits`, `checkouts`, `reservations`, `calendar`,
  `insights`, `settings` (`AppShell.js:24-32`). The table/cards switch and the mobile nav run off
  `matchMedia('(max-width: 991.98px)')` (`AppShell.js:56`, `:184`).
- CSS: `app/app.css` is a dark-only theme layer of `--trax-*` tokens that also re-points Bootstrap's
  `--bs-*` variables; `public.css` covers the public pages.

## Conventions & gotchas

- **All UI strings are hard-coded English. There is no i18n.** Only dates, numbers and currency
  follow `defaults.locale` (browser `Intl`) and `defaults.dateFormat` (server-side `date()`).
- Status labels exist **twice**: `app/lib/format.js:43` and, deliberately duplicated, `view.php:91` —
  and they do not match (`UNAV` is "Checked out" in the admin, "In use" on the public board).
- Every component is a plain Vue options object with a `template` string. No SFCs, no JSX — the
  runtime compiler is why the full Vue build is vendored.
- No bundler: **all imports are relative ESM paths with the `.js` extension**.
- A persisted field must be added to its normaliser in `lib/store.php`, or it is silently dropped on
  the next unrelated write.
- The public endpoints do **not** use the `api.php` envelope: `public.php` answers
  `{"ok":false,"error":"Not found."}` — a string, not an object.
- **Nothing here is for a search engine.** Every response carries `X-Robots-Tag: noindex, nofollow`
  — globally from `.htaccess` (`mod_headers`) and again from PHP on every entry point, since the
  module may be missing; the HTML pages repeat it as a `robots` meta tag, and `robots.txt`
  disallows all.
- `.htaccess` blocks `lib/` and `documents/` by rewrite, and `data.json`, `data.json.bak`,
  `checkout.json`, `users.json`, `.trax.lock` and `config.local.php` by `FilesMatch`. On a host
  without it, reproduce the rules by hand.
- Photos are re-encoded by GD (the stored bytes are ours); documents are stored verbatim, which is
  why they sit behind `download.php`. `backup.php` refuses a direct HTTP request; only an include
  gets past it.
- **`uploads/` is 0755/0644, everything else 0750/0640.** Apache serves the photos itself, and on a
  host where it runs as a different user than PHP a 0640 photo is a 403 — so `lib/photo.php` and
  the uploads branch of `restore.php` (`RESTORE_PUBLIC_MODES`) write the loose modes, while
  `data.json`, `checkout.json`, `users.json`, `documents/`, `lib/config.local.php` and the whole
  backup tree stay private. `fixUploadPermissions()` (`restore.php:219`) repairs an existing tree.
- **Drawer width is a floor, not a fixed size**: `.trax-drawer` is
  `min(max(520px, 33vw), 100vw)` and `.trax-drawer-wide` `min(max(860px, 33vw), 100vw)`
  (`app/app.css:406`, `:420`) — at least a third of a desktop viewport, so the asset sheet's
  two-column rows and the unit table have room, never wider than the screen. Below 992px the drawer
  is `100vw` regardless (`app/app.css:881`).

### Known behaviours

Deliberate or simply true, and surprising either way. Each was checked against the code on
2026-09-04.

- **Unit numbers are never reused.** The asset carries `unitSeq`, the high-water mark of the
  numbers it has ever handed out; a new unit gets `max(unitSeq, existing numbers, patch numbers) + 1`
  (`apply_units_patch()` `api.php:616`). Delete `12.3` and the next unit added is `12.4`, so a label
  already printed for `12.3` can never come to mean different gear — the number is retired, and the
  list keeps a gap. A record written before `unitSeq` existed heals itself off its own units on
  first read (`lib/store.php:381-386`).
- **A blocked asset can still be reserved.** `reservation.create` judges conflicts by time window
  (`trax_conflicts_for()`), not by `trax_is_blocked()`, so a `LOCK`/`UNAV` asset accepts a booking.
  `reservation.convert` refuses it, which is where the operator finds out.
- **The `.htaccess` numeric rewrite is unverified.** There is no Apache in the local environment and
  the built-in PHP server ignores `.htaccess` entirely, so `/12.1` has never been exercised end to
  end. The `?id=&u=` form is verified and is what `index.php` falls back on.
- **The portrait label can truncate a unit label.** It prints `<name> – <unit label>` in the name
  area, which is capped by a y-coordinate at three wrapped lines (`label.php:1646-1712`); the
  overflow is dropped silently, with no ellipsis. The wide label avoids this by putting the unit
  label in the notes strip instead.
- Sticky `thead th` in the asset table does not stick. Pre-existing, unrelated to the scroll fix.

## Local development & verification

```sh
cd /path/to/asset-v2
export TRAX_DATA_DIR=/tmp/trax-sandbox && mkdir -p "$TRAX_DATA_DIR"   # never touch real data
php -S localhost:8000
```

Then open `http://localhost:8000/install.php` and work through the wizard; step 6 offers the demo
dataset. Afterwards sign in at `login.php`.

Caveats:

- The PHP built-in server does **not** honour `.htaccess`: clean URLs (`/admin`, `/view`) and every
  deny rule are inactive locally. A passing local run is no evidence the protections work.
- Before the wizard has run, `admin.php` 302s to `install.php` and `api.php` answers
  `503 {"ok":false,"code":"install-required"}` — the expected uninstalled state, not a failure.
- There is **no test suite**. Verification is manual: drive the real endpoint, e.g.
  `curl -s 'http://localhost:8000/api.php?action=bootstrap'`.
- `TRAX_DATA_DIR` is honoured only when it names an existing, readable directory — create it first.

## Related docs

- [README.md](README.md) — operator manual: hosting requirements, installation, external auth, cron,
  backups, recovery.
- [changelog.md](changelog.md) — the running record of what changed and when, including the known
  gaps and the unverified claims of each pass. There is no git history; **every change adds an entry
  there** and, if it moves the map, here.
