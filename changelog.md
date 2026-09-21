# Changelog

All notable changes to Trax. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project has no released versions, so sections are dated.

**Every change must add an entry here** — together with [project.md](project.md), this file is the
only record. There is no git history to mine.

## 2026-09-22

### Added

- **A QR code on the hand-over sheet, and the sheet itself on the booking page.**
  - The **handover PDF now carries a QR code** of the customer's own booking link, top right of the
    details block. Scanned off the paper it leads straight back to the page — to sign for the gear
    when it was not signed at the counter, to look at the condition photos, or to pull the sheet
    again. Encoded **server-side** by the `phpqrcode` the printed labels already use, from
    `trax_booking_url()` — the one place that builds this link, so the printed code and the
    e-mailed link can never point at different pages. The endpoint is `booking.php?t=<token>&qr=1`,
    guarded by the same token as the page, and it encodes the link for **that token only**, never
    text from the request.
  - **The booking page can download the very same sheet** — one button, no server round trip. The
    sheet doubles as the packing checklist (a tick box per unit), and whoever is loading the van
    needs it more often than the paper survives the journey.
  - To make that possible, `app/lib/pdf.js` **no longer imports the store**: branding is injected
    through `configurePdf({ settings })` — from the store in the admin, from a three-field array in
    `booking.php` — so one builder serves both pages and the customer's page does not drag the
    admin's API client and reactive state onto a public URL.
  - The customer's copy has its own allow-list: no operator notes, no e-mail address, and **no
    `handedOverBy`** — that is a login name, and their copy has no business carrying it.

- **One signature on the hand-over, stored and shown everywhere it matters.**
  - The handover sheet used to print **four** rules — *Handed over by / Received by* and
    *Packed by / Checked by*. It prints **one** now. The other side of a hand-over is never the
    part in dispute, so it is recorded rather than signed: `handedOverBy` is stamped from the
    operator who made the checkout and printed as a fact.
  - **Signed at the counter**, from the checkout card: hand the tablet over, the customer types
    their name and signs, done. Pointer events, so a finger, a stylus and a mouse are one code
    path, and the drawing is cropped to the ink before it is stored — storing the empty pad around
    a signature means printing the signature small.
  - **Or signed by the customer**, on their own booking link. This is the first write this public
    page accepts, and it is narrow by construction: the token in the URL is the capability (it
    already shows everything the page would tell you), plus a honeypot field, a per-session attempt
    counter, and **one signature ever** — re-checked under the lock, so two taps on a slow phone
    cannot produce two. Only the operator can clear it, from the admin, and then it can be signed
    again. Answers are POST/redirect/GET, so a reload never re-posts.
  - The signature shows in **all three places**: on the handover PDF (the drawing itself, over the
    rule, with the typed name and the time), on the customer's own page, and on the checkout card —
    with who signed, when, and whether it happened at the counter or on their link.
  - Storage: `signature` (`{file, name, at, source, actor}`) and `handedOverBy` on the booking. The
    drawing goes through the ordinary image pipeline — sniffed, decoded and re-encoded by GD — and
    lands in `uploads/` under a 128-bit random name, which is what lets the customer's own page
    show it back to them. Removing a signature deletes the file; so does deleting the asset it
    hangs off.

## 2026-09-21 (events)

### Added

- **Events — the jobs the gear goes out on.**
  - A new **Events** view: create, edit and delete a job (name, client, location, on-site contact,
    start and end, notes), filter by Open / Running / Closed / All, and see everything booked on it
    — the checkout lines with their units and due dates, and the reservations — with the value and
    what the job bills over its own window.
  - **Statuses**, moved by hand from the list while somebody is holding a flight case: the workflow
    ships as *Reserved → Packed → At customer → Returned* and is **configurable** under
    **Settings → Events** — rename, recolour, reorder, add or remove, and mark the ones that end a
    job as *closed* so it drops out of the open list. A status is stored by its **id**, so renaming
    "At customer" to "Beim Kunden" leaves every event on it exactly where it was.
  - **Pick an event when checking out or reserving**: an optional select in the selection drawer,
    which stores `eventId` on the checkout line, the reservation and the booking. Optional by
    design — plenty of gear leaves the building without a project behind it — and the picker can be
    switched off entirely for an install that does no event work.
  - The checkout list and the reservations list chip the job they belong to; the Events view can
    export the **rental quote** for one job, priced over the event's own dates.
  - **Gear is never "inside" an event.** It is checked out or reserved *against* one, so
    availability is still decided exactly where it was before — no second opinion on what is free,
    and no second place to change what is booked. Deleting an event deletes nothing else: the
    bookings simply stop naming it, and the app says how many did.
  - Storage: a top-level `events` list, `settings.events` (`statuses`, `defaultStatus`, `enabled`)
    and a nullable `eventId` on the checkout line, the reservation and the booking. Everything
    written before this reads back with no event, which is what it had. `api.php` refuses an
    unknown event id, an end before its start, a workflow with no statuses left and two statuses
    sharing a name — each with the reason, before the mutation.

## 2026-09-21

### Added

- **Dry hire and full service.**
  - The rental rates are, and always were, the **dry-hire** rates — the gear on its own. A serviced
    job is the same gear with the operator's own time invoiced separately, so its equipment side is
    the dry-hire price times a **full-service factor**, normally below 1. The factor sits under the
    default rate in Settings → Rental rates and can be overruled per category (empty = inherit the
    default); both previews now name both prices, e.g. "3 %/day · €210.00 for 7 days (1 week) on a
    €1,000.00 item · full service €147.00".
  - **A toggle in the selection drawer**, Dry hire / Full service, for a checkout and for a
    reservation alike. The rental line follows it live, and on full service a hint says what the
    gear is being charged at ("Gear at 50 %, 70 % of dry hire (€116.55). The crew is invoiced
    separately.") so the two numbers are never a mystery.
  - The choice is **stored**, because it is a fact about the job and not a price: on every checkout
    line, on the reservation and on the booking. A reservation booked as full service is still full
    service when it is converted months later, and the booking keeps the answer after the gear has
    come back and its lines are gone.
  - The checkout list shows a **Dry hire / Full service** chip per customer and prices each line by
    what that line says — a list holding both kinds stays right. Reservations show the chip when
    they are serviced. The rental PDF carries a "Hire" row and the handover sheet gains one when the
    job is serviced; neither prints the factor, for the same reason neither prints the percentage.
  - The factor lives on the RULE, beside the discount ladder, and never on an asset or a unit: it is
    a commercial decision about a class of gear, not about one camera. `serviceFactorOf()` resolves
    category → default → 1, so an install that has never been told a factor charges the same either
    way and nothing changes until somebody says otherwise.
  - Storage: `serviceFactor` (nullable, 0..10) on every rental rule, and `hire` (`DRY` | `SERVICE`)
    on the checkout line, the reservation and the booking. Everything written before this reads back
    as `DRY`, which is exactly what it was. `api.php` refuses a factor outside 0..10 before the
    mutation, with the reason.

## 2026-09-20

### Added

- **Inspection records — the test documentation for one physical piece.**
  - **Settings → Inspections**, a checkbox per category. Tick "Power" and every cable in it starts
    asking for a record; leave "Furniture" unticked and nothing is asked of it — the obligation goes
    where it belongs instead of onto every record in the install. A ticked category carries what the
    test is **called** ("DGUV V3"), how many **months** a pass is valid for (0 = record it, let
    nothing fall due) and the **measured parameters** to write down, added with a + button. Those
    names become the boxes on the test form, in that order, so the same readings are taken every
    time.
  - **Asset sheet → Tests tab.** One history per physical piece: cable 183.5 and cable 183.6 keep
    separate records, which is the whole point — an item that does not track units files against the
    record as a whole. Each record carries the date, **passed / failed**, who tested it, the next
    test date, the measured values, a note and one **certificate** (PDF, image or text), attached
    with the record or added later. A failure does not start a new validity period: switching the
    result to failed takes the prefilled next date back, and a date typed by hand is never moved.
  - **Test report PDF** per asset (`exportInspectionPdf()`): one block per piece, every record on
    file, failures in red, never-tested pieces listed as such rather than left out, certificates
    named. This is the "show me the paperwork for 183.5" document.
  - **Flagged where it is noticed**: a banner in the asset sheet on every tab (failed, overdue, due
    within 30 days, never tested) and a **Tests needing attention** card on the dashboard, worst
    first. Nothing is blocked from going out — the app documents, the operator decides.
  - Storage: `settings.inspection.categories` (a list, like the rental rates, so un-ticking a
    category actually removes it through a deep-merged patch) and `asset.inspections` +
    `asset.inspectionSeq`. A record names the `unitNo` it is about and lives on the **asset**, not
    inside `units`: a units patch rewrites that list whole, and a test certificate must not be
    something an operator can delete by renaming a cable. Ids are server-issued and never reused.
  - Written through `asset.inspect`, `asset.inspectionDocument` and `asset.inspectionDelete`, never
    through an asset patch — a record can point at a file on disk. The certificate goes through the
    same pipeline as an attached document (sniffed type, stored under a name we chose, in the denied
    `documents/` directory) and `download.php` now accepts a file referenced by an inspection as
    well as one in `documents`. Deleting the record, or the asset, deletes the certificate with it.
  - Renaming or merging a category moves its test rule with it, in the same mutation as its rental
    rate. Records already filed always stay — they document something that happened.

## 2026-09-19

### Added

- **Rental pricing: what the gear costs to hire, next to what it is worth.**
  - **Settings → Rental rates** (`SettingsView.js`, new section). A *default rate* for the whole
    install and, per category, a rate of its own. A rate is either a percentage of the item's value
    charged **per day**, or a **fixed price** charged once for the hire or once per day — some gear
    is simply "95 for the job" whatever it cost. Under a percentage rate sits the discount ladder:
    **+ Discount** adds a step, any number of them, each "from N days on → X %/day", applied to a
    hire of that many days or more for every day of it. A live preview spells each rate out in money
    ("3 %/day · €210.00 for 7 days (1 week) on a €1,000.00 item") for a duration the operator picks.
  - **Asset sheet → Rental tab** (`AssetSheet.js`). The asset's value read-only (it is only ever the
    basis a percentage is worked out from), the category rate it inherits, and the same three fields
    to overrule it — per asset and, underneath, per **unit**. A unit that is worth more, or that is
    hired out at a flat price, is priced as itself. Each row says what it resolves to and where the
    rate came from ("4.8 %/day · €396.48 for 7 days (1 week) · from this unit").
  - Resolution order is `unit → asset → category → default`. An override replaces the base rate but
    keeps the ladder's shape — scaled by `tier/base` — so a discount stays a discount of the same
    size instead of being lost on every overridden record.
  - **Rental price in the selection drawer** (`BasketDrawer.js`), under the existing internal
    "Selection value" line: priced for the window the drawer is showing (now → due date when
    checking out, the reservation window when reserving), with a chip for lines that have no rate
    and for lines charged by a percentage of a value nobody recorded.
  - **Rental price in the checkout list** (`CheckoutsView.js`), per customer card, for the days the
    hire was booked for.
  - **Rental PDF** (`exportRentalPdf()` `app/lib/pdf.js`), from the selection drawer and from each
    checkout card. The customer-facing sibling of the internal Value PDF: the same grouping and
    subtotals, but the period, the price for one unit over that period and the line total. **Money
    only** — no purchase value and no rate. A percentage is a fraction of what the gear cost to buy,
    so "3 %/day" beside "€210.00" would hand the purchase value over by division; the rate stays on
    the operator's screens. A line that could not be priced is listed with a dash and named in the
    caveat under the total rather than quietly dropped.
  - `app/lib/rental.js` is the one place the arithmetic lives: `rentalDays()` (whole calendar days,
    minimum 1 — out on the 19th and back on the 26th is seven days whatever the hours say),
    `resolveRate()`, `rateForDays()`, `rentalOfUnit()` and `rentalOfLines()`, which takes the
    `[{id, qty, unitNos?}]` shape the basket, a checkout group and a reservation already have and
    expands a kit into its members exactly as `valueOfLines()` does. Nothing is stored on a booking:
    a hire is always priced by the rates in force when the figure is worked out, so correcting a
    rate re-prices what is still out.
  - Storage: `settings.rental` = `{default: rule, categories: [rule + {category}]}`, plus a
    `rental` override on every asset and every unit (`lib/store.php`, `trax_normalize_rental*()`).
    `categories` is a list rather than a map keyed by name because settings are saved as a
    deep-merged patch — a map would merge key by key and a rate could never be removed. Renaming,
    merging or deleting a category rewrites its rate inside the same mutation
    (`trax_taxonomy_apply_rental()`); a merge keeps the target's rate. Every record written before
    this reads back as `INHERIT` with null numbers, i.e. exactly as it behaved.
  - `api.php` refuses a percentage outside 0..100, a negative fixed price and a discount step that
    starts at fewer than one day **before** the mutation, with the reason — the same rule the mail
    templates and the WhatsApp number are saved under, rather than normalising a bad number away
    and leaving the operator an empty box.

## 2026-09-05

### Fixed

- PDF header: the branding logo is now fitted into a fixed header band (max 42 x 9 mm, aspect ratio preserved, vertically centred at x = 14 mm) instead of being scaled by width alone. A square or portrait logo used to be drawn 42 mm wide and therefore 42 mm or more tall — measured 42 x 42 mm for a 300x300 mark and 42 x 140 mm for a 120x400 one — running straight through the brand rule at y = 22 mm and over the title and summary lines beneath it. The rule's y is now derived from the band (`LOGO_TOP + LOGO_MAX_HEIGHT + RULE_GAP`, still 22 mm, so nothing else on the page moves), so no logo shape can cross it. One shared header (`decorate()`), so this covers the inventory report, the overview/insurance schedule, the selection value PDF, the booking/handover sheet and every continuation page (`app/lib/pdf.js:54`, `:340`).
- Lightbox: the PDF frame and image now fill the space below the toolbar instead of a fixed 90vh, so on phones (especially landscape / shrunken viewport) the preview no longer overlaps the Download/Open/Close bar or runs off the bottom; toolbar wraps on narrow screens, safe-area insets respected (`app/app.css`).

### Added

- **Click any image to see it full size; preview documents in the app.**
  - `app/components/ui/Lightbox.js` — one overlay, mounted once by `AppShell` next to `ToastHost`,
    driven by `state.preview` (`app/store.js:184`) and the actions `openPreview()`, `closePreview()`,
    `previewNext()` / `previewPrev()` and `openAssetPhoto()`. Three kinds: `image` (max 92vw/92vh,
    `object-fit: contain`), `pdf` (an iframe at 92vw × 90vh) and `file` (a card with the name, the
    size and a Download button). Backdrop click, Escape and Close all dismiss it; Download, "Open"
    in a new tab, a focus trap and a `n / N` counter with ← / → and prev/next arrows when the
    payload carries `items`. z-index 1070/1071, above `.trax-drawer` (1055), because most of the
    pictures being clicked sit inside a drawer.
  - Thumbnails are now buttons (`.trax-thumb-btn`): the inventory table (`AssetTable.js:147`),
    the cards (`AssetCards.js:56`), the asset sheet's main photo (`AssetSheet.js:778`), its kit
    members (`:915`) and its condition photos (`:969`, which used to open a new tab and now open
    the whole log as a gallery at the photo that was clicked), and the kit editor's contents list
    (`SetEditor.js:200`). The thumb still loads `uploads/thumb/<file>`; the preview loads the
    stored original `uploads/<file>`.
  - The document name in the asset sheet opens the preview (`AssetSheet.js:1036`): PDFs in the
    iframe, images on screen, everything else as a file card. The separate download button is
    unchanged.
  - `download.php` accepts `?inline=1` and answers `Content-Disposition: inline` for it — but only
    for `application/pdf` and `image/*`, decided from the extension the app itself chose, never from
    the request. Without the flag the response is the attachment it always was. `X-Frame-Options`
    relaxes to `SAMEORIGIN` on an inline response so our own iframe can hold it, and stays `DENY`
    otherwise. The auth gate, the name regex and the "must be referenced by an asset" check are
    untouched.
  - `app/lib/scroll-lock.js` — the background scroll lock is now counted, so a lightbox opened over
    an open drawer and then closed does not hand the page its scrollbar back while the drawer is
    still there. `Drawer.js` uses the same pair.

### Changed

- **Portrait label: a touch more air between the wrapped name lines.** The asset-name block's
  line height went from 20 to 22 label units (`label.php:1671`); the font size, the first
  baseline at 240 and the three-line cap are unchanged. Baselines move from 240/260/280 to
  240/262/284, so a third line — including the `– unit label` suffix that rides along in the
  block — still clears the ID bar at 300 with room for descenders.

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
- **Force a second backup on the same day.** `trax_run_backup()` takes a fourth argument
  `bool $force = false` (`backup.php:111`). Without it a finished backup for today is still left
  alone and reported back with `existing => true`; with it a second backup is written beside the
  daily folder under the pre-restore snapshot's name pattern minus the random suffix —
  `2026-09-04_21-34-52` (`backup.php:159`). The daily folder is never overwritten or deleted, the
  manifest is written as usual and the lock is held exactly as before. Two ways in: the CLI flag
  `php backup.php --force` (`backup.php:274`) and a "Force a second backup today" check box next
  to "Create backup now" on `restore.php` (`restore.php:603`, `:990`). `listBackups()` sorts by
  the manifest's `created_at` and `resolveBackupByName()` validates the path rather than a date
  pattern, so a time-stamped folder lists and restores like any other.
- **Docs**: `project.md` and this changelog.
- **Housekeeping**: four `phpqrcode/q*.png-errors.txt` GD warning logs, left behind by a scratch
  probe rather than by the app, removed from the working tree.

### Fixed

- **Double-encoded UTF-8 in `restore.php`.** Five strings carried a mojibake em dash or ellipsis
  (`C3 A2 C2 80 C2 94` / `C3 A2 C2 80 C2 A6` instead of `E2 80 94` / `E2 80 A6`) and rendered as
  "â€”": the three `ensureDir()` / `copyFileSafe()` exception texts (`restore.php:85`,
  `:139`, `:195`), the empty-cell dash in the backup table (`restore.php:944`) and the
  "Restoring…" button label (`restore.php:1340`). Replaced with the real characters; the file
  is valid UTF-8 and no `C3 A2 C2` or `C3 83` sequence is left.

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
