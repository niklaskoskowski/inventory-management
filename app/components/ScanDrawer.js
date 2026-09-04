import { ref, onMounted, onBeforeUnmount, computed, nextTick } from 'vue';
import {
  state, getAsset, toggleSelected, isSelected, getQuantity, setQuantity,
  getUnitChoice, setUnitChoice, selectedUnitCount, mutate, toast,
} from '../store.js';
import Drawer from './ui/Drawer.js';
import StatusBadge from './ui/StatusBadge.js';

/**
 * Reads a label payload into `{id, unit}`.
 *
 * Accepts every payload a printed label has ever carried:
 *   - a bare numeric id, `12`, or a unit of it, `12.1`
 *   - the old query URL, https://host/r/?id=3 — still printed wherever
 *     TRAX_LABEL_URL_FORM is 'query', and on every label already in the
 *     field, so this must never stop working; `&u=1` names a unit
 *   - the short URL, HTTPS://HOST/3 (or HTTPS://HOST/3.1), which is upper
 *     case because that is what puts it in QR's alphanumeric mode (21
 *     modules instead of 25)
 *
 * `unit` is null unless the code named one. The dot is part of the id match,
 * not an afterthought: a tail pattern that only knew about `/(\d+)$` reads
 * HTTPS://HOST/12.1 as asset **1**, which is a different asset that exists.
 *
 * Case-insensitive: URL parsing already lower-cases scheme and host, and the
 * loose fallbacks below carry the /i themselves. Exported for testing.
 */
export function extractRef(text) {
  const raw = String(text || '').trim();
  const ref = (id, unit) => {
    const no = unit === undefined || unit === null ? null : Number(unit);
    // Units are numbered from 1, so `12.0` is a misread of something, but it
    // is not asset 12 — rejecting the whole payload beats acting on a guess.
    if (no !== null && no < 1) return null;
    return { id: Number(id), unit: no };
  };

  const bare = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (bare) return ref(bare[1], bare[2]);

  try {
    const url = new URL(raw);
    const id = url.searchParams.get('id');
    if (id && /^\d+$/.test(id)) {
      const unit = url.searchParams.get('u');
      return ref(id, unit && /^\d+$/.test(unit) ? unit : null);
    }
    // Short form: the whole path is the id, e.g. /3, /3.2 or /R/3.
    const tail = url.pathname.match(/\/(\d+)(?:\.(\d+))?\/?$/);
    if (tail) return ref(tail[1], tail[2]);
  } catch {
    // Not a URL. Fall through to loose matches so odd encoders still work.
  }

  const query = raw.match(/(?:^|[?&])id=(\d+)/i);
  if (query) {
    const unit = raw.match(/(?:^|[?&])u=(\d+)/i);
    return ref(query[1], unit ? unit[1] : null);
  }
  const path = raw.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+\/(?:[^/?#]+\/)*(\d+)(?:\.(\d+))?\/?$/i);
  return path ? ref(path[1], path[2]) : null;
}

/** Just the asset id of a label payload, or null. */
export function extractId(text) {
  const ref = extractRef(text);
  return ref ? ref.id : null;
}

/**
 * QR scanning.
 *
 * The camera is driven here, directly: getUserMedia -> a <video> this component
 * owns -> drawImage into a canvas this component owns -> jsQR. There is no
 * scanner library in the path any more, and that is the point.
 *
 * Why html5-qrcode had to go, measured in vendor/qr.min.js and then on the
 * user's iPhone (iOS 18.7 / Safari 26.5):
 *
 *   1. foreverScan sleeps a FIXED 1000/fps ms after every settled attempt
 *      (@byte 331496: `n.foreverScanTimeout=setTimeout(...,n.getTimeoutFps(t.fps))`,
 *      with `getTimeoutFps=function(t){return 1e3/t}` @byte 336341). At the
 *      fps: 10 this drawer passed, that is a hard 100 ms floor between looks
 *      before any decode cost at all.
 *   2. `disableFlip` was never set, and @byte 331569 reads
 *      `i||!0===t.disableFlip?u():(...scale(-1,1)...scanContext(...))` — so
 *      every failed frame was decoded a SECOND time, mirrored. While hunting
 *      for a code every frame fails, so every frame paid two full zxing passes.
 *
 *   On the device that priced out at: zxing itself 10.1 ms per call, but only
 *   8.27 frame cycles per second — 125.2 ms per cycle. The decode cost 10 ms
 *   and the loop cost 125. That is defects 1 and 2, on real hardware.
 *
 * What replaces it, and why each choice:
 *
 *   - Cadence is requestAnimationFrame with no artificial sleep. The next frame
 *     is only requested once the current decode has returned, so a slow device
 *     scans more slowly instead of queueing a backlog. A frame whose
 *     currentTime has not moved is skipped rather than decoded twice: the
 *     camera runs at 30 fps and rAF at 60 Hz, so half the callbacks have
 *     nothing new in them.
 *   - TWO regions, alternating frame by frame (see DECODE_WIDTH / CENTRE_SPAN):
 *     the whole frame, and the centre half. Both are read at the camera's own
 *     pixels wherever that fits under DECODE_WIDTH, which on the 720x1280
 *     stream the phone delivers means no resampling anywhere. Measured against
 *     real phpqrcode labels (12 placements each, blur + noise, that stream):
 *       full 720x1280 native   knee 12% of frame width, 18.1 ms an attempt
 *       centre 360x640 native  knee 11% for a centred label, 4.5 ms an attempt
 *       the two alternating    knee 11%
 *     against the old engine's 13% on the same frames — so the change is a
 *     gain, not a trade. Downscaling the full pass to 640 was measurably worse
 *     on BOTH counts (knee 14%, 19.3 ms) because a 1.125x resample costs more
 *     than the pixels it saves.
 *   - Both canvas dimensions are snapped to multiples of 8. jsQR is ~2.8x
 *     slower otherwise; measured here, 960x540 took 18 ms against 8 ms for
 *     960x544, and 640x358 took 8 ms against 4 ms for 640x360.
 *   - inversionAttempts: 'dontInvert', to skip looking for white-on-black codes
 *     this app has never printed. Measured on a 640x1136 frame with no code in it:
 *     dontInvert 8.9 ms, invertFirst 14.9 ms, attemptBoth 18.0 ms — and
 *     'onlyInvert' throws outright in jsQR 1.4.0 ("undefined is not an object
 *     (evaluating 'o.height')"), so this is the only mode worth having.
 *
 * The overlay is drawn from the SAME numbers the decoder uses (fitBox +
 * overlayBox below), so the corner guides on screen outline what is genuinely
 * read: the full-frame pass, i.e. everything. Nothing is outlined that is not
 * scanned, and nothing scanned is left outside them.
 *
 * The centre pass has no marker of its own. It used to have a dashed rectangle
 * and it read as a target to aim into, which is not what it is — it is where
 * the second pass spends native pixels, and a label anywhere in the frame is
 * read by the other one regardless. The pass stays (it moves the knee from 12%
 * to 11% of frame width and costs 4.5 ms an attempt); only the marker is gone.
 * That makes its geometry invisible on screen, so the test suite is now the
 * only thing holding it to the region it claims — see the overlay checks.
 *
 * Everything that made the previous rounds' start path survivable is kept,
 * because every one of these was a real black-preview report:
 *   - an insecure origin (iOS grants the camera on https:// or localhost only)
 *   - a missing navigator.mediaDevices
 *   - a refused / absent / busy camera
 *   - a 0x0 scanner region at start() time
 *   - a camera that opened but whose <video> never actually plays
 *   - a stream that played and then died under us
 *   - a picture that plays while the decode loop never started
 *
 * The layout has two shapes and one set of controls. Below app.css's own
 * mobile breakpoint (991.98px) .trax-scan-stage is the whole viewport, the
 * preview fills it, and the controls float over the picture on two scrims; at
 * every wider width the stage and its bars are display:contents and everything
 * lays out in the drawer exactly as it did before, because a full-screen
 * takeover of a 27" monitor is not an improvement. The preview stays
 * object-fit: contain in BOTH — 720x1280 into a 390x693 phone screen letterboxes
 * by a fraction of a pixel, and `cover` would push part of what is decoded off
 * the edge of the screen while the guides went on claiming it.
 *
 * Liveness is still readyState >= HAVE_CURRENT_DATA, not paused, and a
 * currentTime that actually moves between two samples — never videoWidth, which
 * is non-zero from `loadedmetadata` on even when playback was refused, and is
 * how this drawer once printed "Live · 1280×720" over a black box. When
 * playback is refused (iOS Low Power Mode refuses even muted inline autoplay)
 * the cure is a tap target that calls play() straight out of the user gesture.
 */
export default {
  name: 'ScanDrawer',
  components: { Drawer, StatusBadge },
  emits: ['close', 'open', 'basket'],
  setup(props, { emit }) {
    /**
     * What this install calls itself, for the messages below. A plain function
     * rather than a computed: every caller here is imperative (a toast, an
     * error string), so there is nothing for reactivity to update.
     */
    const appName = () => state.settings?.branding?.appName || 'Assets';

    const mode = ref('lookup');
    const status = ref('starting');
    const errorText = ref('');
    const errorDetail = ref('');
    const liveText = ref('');
    // Proof that our own decode loop is running: set by the first attempt,
    // decoded or not. Silence here means no frame was ever examined.
    const decodeAlive = ref(false);
    const decoderText = ref('');
    // What the loop is actually doing, for the status line: the two canvas
    // sizes and the measured attempts per second. A future slowdown is then
    // visible on the device instead of invisible.
    const scanNote = ref('');
    const scanRate = ref(0);
    // The stream's own shape, adopted by the viewfinder once it is known. A
    // 9:16 portrait stream in the 4/3 box the CSS starts with rendered as a
    // 164px strip in a 390px box — under half the width, and the whole point of
    // a preview is to aim with it.
    const streamAspect = ref(0);
    const hits = ref([]);
    const cameras = ref([]);
    const cameraId = ref('');
    const manualId = ref('');
    // The tap-to-start overlay: shown whenever the stream is attached but the
    // picture is not playing, whether or not a rejection was caught.
    const needsTap = ref(false);
    const tapText = ref('');
    // Kept for the whole run, not consumed by one message: a play() rejection
    // stays readable even when a later tap recovers the preview.
    const playError = ref('');
    // Camera controls, both capability-gated: null / false where the device
    // does not offer them, and then nothing is rendered at all.
    const zoomRange = ref(null);
    const zoom = ref(0);
    const torchAvailable = ref(false);
    const torchOn = ref(false);
    // Which of the two layouts app.css is in. The layout ITSELF is entirely
    // CSS's — one media query at the app's own mobile breakpoint — because two
    // sources of truth for "is this full-screen" is how a phone ends up with
    // a covered drawer header and no close button. This is only how the drawer
    // notices the box it measures the guides against has changed shape.
    const fullscreen = ref(false);

    let stream = null;
    let lastCode = '';
    let lastAt = 0;
    // Bumped by every start() and every stop(); the waiting loops below drop
    // out when their run is no longer the current one, so a drawer that closes
    // mid-start cannot overwrite the status afterwards.
    let runId = 0;
    let videoEl = null;
    let detachers = [];
    let liveSeen = false;
    // Only the newest liveness watch may write the status: `playing` events and
    // the post-start check can otherwise overlap.
    let liveSerial = 0;
    // Same rule for the decode heartbeat.
    let beatSerial = 0;
    // The decode loop's own state. `passes` is rebuilt whenever the stream's
    // size becomes known; `frameId` is the pending rAF handle, so a stop() can
    // cancel a loop that is between frames.
    let passes = [];
    let passAt = 0;
    // The stream size the current passes were built from, so the rebuild is
    // idempotent: `loadedmetadata`, `playing` and the liveness check can all
    // arrive with the same numbers.
    let streamSize = null;
    let frameId = null;
    // Belt and braces beside frameId: a callback that was already scheduled
    // when the loop was stopped must do nothing, whether or not the cancel
    // took. Nothing may keep decoding a stream the drawer has let go of.
    let looping = false;
    let lastStamp = -1;
    let attempts = 0;
    let rateMark = 0;

    const REGION_ID = 'trax-scan-region';
    const FRAME_CLASS = 'trax-scan-frame';
    // Every wait is counted in attempts rather than wall clock, so the test
    // harness can drive them through a fast setTimeout.
    const LAYOUT_TRIES = 12;
    const LAYOUT_WAIT_MS = 60;
    // Covers only what getUserMedia covers: the camera (or its permission
    // prompt) answering at all.
    const OPEN_TRIES = 40;
    const OPEN_WAIT_MS = 250;
    const LIVE_TRIES = 30;
    const LIVE_WAIT_MS = 150;
    // Once a play() rejection has been seen there is no point waiting the full
    // budget before offering the tap target.
    const REFUSED_TRIES = 6;
    // The decode heartbeat: ~4s of live picture with no attempt at all.
    const DECODE_TRIES = 27;
    const DECODE_WAIT_MS = 150;
    const HAVE_CURRENT_DATA = 2;

    /**
     * The decode resolution CAP. One number, deliberately: raise it for
     * distance, lower it for speed. A stream narrower than this is read at its
     * own width, untouched.
     *
     * 768 rather than 640, because on the 720x1280 portrait stream the phone
     * actually delivers, 768 means no downscale at all — and measured on this
     * machine over 12 placements of a real phpqrcode label, native is BOTH
     * cheaper and better:
     *   full 640x1136   draw 10.35 ms + decode  8.91 ms = 19.26 ms   knee 14%
     *   full 720x1280   draw  6.77 ms + decode 11.30 ms = 18.07 ms   knee 12%
     * 1.27x the pixels for 0.94x the cost, because a 1:1 drawImage is a copy
     * and a 1.125x one is a resample. The old scanner library, decoding the
     * same frames at the same native size, knee'd at 13%.
     *
     * The cap still bites on big sensors: 1920x1080 is read at 768x432,
     * 3840x2160 likewise, which is what keeps a 4K phone inside a frame budget.
     */
    const DECODE_WIDTH = 768;
    // The centre pass covers this fraction of the frame, in each axis, and is
    // read at native pixels wherever that is not wider than DECODE_WIDTH. Half
    // the frame is a quarter of its area, which is what makes it cheap.
    const CENTRE_SPAN = 0.5;
    // Below this the centre crop cannot hold a readable code, so the second
    // pass is dropped rather than spent. A 320x240 stream crops to 160 wide,
    // which is under it; the 720x1280 phone stream crops to 360, which is not.
    const MIN_CENTRE_WIDTH = 240;
    // jsQR walks the image in 8-px blocks; a dimension that is not a multiple
    // of 8 costs it a slow path (960x540: 18 ms, 960x544: 8 ms, measured).
    const SNAP = 8;
    // Camera zoom, where the device has it. The scanner opens at 1.0 — the
    // camera's own framing, nothing cropped away — because that is what the
    // user asked for and because a label he is already close to needs no help.
    // 2x is still one tap up the slider and still worth it at distance: on the
    // measured sweep it moves the 75% read threshold from 13% of frame width to
    // 7%, at no CPU cost, because those pixels are real rather than
    // interpolated. It is a starting point, not a policy — and whatever he
    // chooses is remembered below.
    const DEFAULT_ZOOM = 1;
    // Bumped from V1 deliberately: every browser that ever ran this drawer is
    // holding a zoom under the old key, and most of them are holding the old
    // 2x default. Changing DEFAULT_ZOOM alone would have changed nothing on any
    // phone that had already opened the scanner once. A new key abandons every
    // stored value, so everyone starts at 1.0 exactly once and their next
    // choice sticks from then on.
    const ZOOM_KEY = 'traxScanZoomV2';
    // app.css's own mobile breakpoint, not a new one: below it the scanner is
    // the whole screen and its controls float over the picture. Kept as a
    // number so the media query string and the innerWidth fallback cannot
    // drift apart from each other.
    const MOBILE_MAX_WIDTH = 991.98;
    const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;
    const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;
    // jsQR is not on the page: admin.php loads vendor/qr.min.js only, and this
    // component may not edit it. Resolved against this module's own URL so it
    // does not depend on which page mounted the app; where there is no URL
    // constructor (jsc, very old WebViews) the document-relative path is what
    // admin.php's own <script> tags use anyway.
    const DECODER_URL = (() => {
      try {
        return new URL('../../vendor/jsqr.min.js', import.meta.url).href;
      } catch {
        return 'vendor/jsqr.min.js';
      }
    })();

    const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

    /**
     * Acts on one decoded reference.
     *
     * `ref` is what extractRef() returned: an asset id and, when the label
     * named one, a unit number. Everything below the unit branches is exactly
     * the pre-units behaviour — a plain asset label still means "the asset".
     */
    const handle = async (ref) => {
      const id = ref.id;
      const asset = getAsset(id);
      if (!asset) {
        toast(`No asset with ID ${id}.`, 'warning');
        return;
      }

      const units = Array.isArray(asset.units) ? asset.units : [];
      const wantedNo = ref.unit;
      const unit = wantedNo === null
        ? null
        : units.find((entry) => Number(entry.no) === wantedNo) || null;
      const code = `${id}.${wantedNo}`;

      // A code that names a unit this asset does not have is refused rather
      // than quietly demoted to the whole asset: in return mode that would
      // hand back every unit of it.
      if (wantedNo !== null && !unit && units.length) {
        toast(`${code} is not a unit of ${asset.name}.`, 'warning');
        return;
      }

      hits.value.unshift({ at: Date.now(), asset, unit: unit ? wantedNo : null });
      hits.value = hits.value.slice(0, 25);

      if (mode.value === 'lookup') {
        if (unit) toast(unit.label ? `Unit ${code} — ${unit.label}` : `Unit ${code}`, 'info', 2500);
        await stop();
        emit('close');
        emit('open', id);
        return;
      }

      if (mode.value === 'collect') {
        if (unit) {
          if (unit.state !== 'FREE') {
            const why = unit.state === 'OOS'
              ? 'out of service'
              : `out to ${unit.customerName || 'someone'}`;
            toast(`${code} is ${why}.`, 'warning');
            return;
          }
          if (getUnitChoice(id).includes(wantedNo)) {
            toast(`${code} already in basket.`, 'info', 1800);
            return;
          }
          if (!isSelected(id)) {
            toggleSelected(id);
            setQuantity(id, 1);
          }
          // setUnitChoice caps at availableQty, so this can legitimately
          // refuse — say so rather than claiming a unit was added.
          if (!setUnitChoice(id, [...getUnitChoice(id), wantedNo]).includes(wantedNo)) {
            toast(`${code} does not fit — no free quantity left.`, 'warning');
            return;
          }
          toast(`Added ${code}.`, 'success', 1800);
          return;
        }
        // Scanning the same item twice means two units, not a no-op — that is
        // how you collect three identical batteries off the shelf.
        if (isSelected(id)) {
          const qty = setQuantity(id, getQuantity(id) + 1);
          toast(`${asset.name} ×${qty}.`, 'success', 1800);
        } else {
          toggleSelected(id);
          setQuantity(id, 1);
          toast(`Added ${asset.name}.`, 'success', 1800);
        }
        return;
      }

      if (mode.value === 'return') {
        if (unit) {
          try {
            const data = await mutate('checkout.checkin', {
              units: [{ assetId: id, no: wantedNo }],
              notify: false,
            });
            const missed = (data?.notOut || []).some(
              (entry) => Number(entry.assetId) === id && Number(entry.no) === wantedNo,
            );
            if (missed) toast(`${code} was not checked out.`, 'warning');
            else toast(`${code} returned.`, 'success', 2000);
          } catch { /* toast already raised */ }
          return;
        }
        if (!asset.isOut) {
          toast(`${asset.name} is not checked out.`, 'warning');
          return;
        }
        try {
          await mutate('checkout.checkin', { assetIds: [id], notify: false });
          toast(`Checked in ${asset.name}.`, 'success', 2000);
        } catch { /* toast already raised */ }
      }
    };

    /**
     * Called for every frame the loop examined, decoded or not.
     *
     * A scanner that looks perfect and decodes nothing is indistinguishable
     * from a working one until you know whether any frame was ever examined.
     */
    const onFrameScanned = () => {
      if (decodeAlive.value) return;
      decodeAlive.value = true;
      decoderText.value = '';
    };

    const onDecoded = (text) => {
      onFrameScanned();
      // The loop reads the same label many times a second; debounce repeats.
      const now = Date.now();
      if (text === lastCode && now - lastAt < 2500) return;
      lastCode = text;
      lastAt = now;

      const ref = extractRef(text);
      if (!ref) {
        toast(`That QR code is not a ${appName()} label.`, 'warning', 2500);
        return;
      }
      handle(ref);
    };

    /** getUserMedia rejects with DOMExceptions; older shims with plain strings. */
    const rawText = (error) => {
      if (!error) return '';
      if (typeof error === 'string') return error;
      return error.message || String(error);
    };

    /** A caught play() rejection, phrased for the detail line under any state. */
    const playNote = computed(() => (playError.value
      ? `The video refused to play: ${playError.value}`
      : ''));

    const failWith = (text, detail = '') => {
      status.value = 'error';
      errorText.value = text;
      // Never drop a play() rejection just because something else failed later.
      errorDetail.value = detail || playNote.value;
      liveText.value = '';
      needsTap.value = false;
      // A hard failure supersedes the heartbeat: there is no picture to decode.
      decoderText.value = '';
    };

    const describeError = (error) => {
      const name = (error && error.name) || '';
      const text = rawText(error);
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError'
        || /permission|denied|not allowed/i.test(text)) {
        return 'Camera access was refused. In Safari open the "AA" menu in the address bar → '
          + 'Website Settings → Camera → Allow, then try again.';
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError'
        || /no camera|camera not found|requested device not found/i.test(text)) {
        return 'No camera was found on this device. Type the asset ID below instead.';
      }
      if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
        return 'That camera could not be opened with the requested settings. '
          + 'Choose "Automatic (rear)" in the camera picker and try again.';
      }
      if (name === 'NotReadableError' || name === 'TrackStartError'
        || /in use|busy|could not start video source/i.test(text)) {
        return 'The camera is being used by another app or tab. Close that one and try again.';
      }
      if (name === 'SecurityError') {
        return `The browser blocked the camera for security reasons. ${appName()} has to be served over https://.`;
      }
      return text || 'The camera could not be started.';
    };

    const originLabel = () => {
      const loc = window.location || {};
      return loc.origin || loc.href || 'this page';
    };

    /**
     * iOS Safari hands out no camera at all off https:// — but it still lets
     * the page look like it is trying, which is exactly the black rectangle
     * that was reported. Name the origin so the cause is readable on a phone.
     */
    const contextProblem = () => {
      const loc = window.location || {};
      const local = LOCAL_HOSTS.test(loc.hostname || '');
      const secure = window.isSecureContext === true || loc.protocol === 'https:' || local;
      if (!secure) {
        return `${originLabel()} is not a secure context, so iOS Safari and Chrome refuse the `
          + `camera. Serve ${appName()} over https:// (or open it on localhost) and the scanner `
          + 'works. Until then, type the ID below.';
      }
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        return `This browser exposes no camera API at ${originLabel()} `
          + '(navigator.mediaDevices is missing). Type the ID below instead.';
      }
      return '';
    };

    /**
     * jsQR, taken from the global if it is already there and fetched once if it
     * is not.
     *
     * admin.php loads vendor/jsqr.min.js with a plain <script> tag, so the
     * normal path is the first line of this function: no fetch, no await that
     * does anything, nothing between opening the drawer and opening the camera.
     * The injection below is the fallback for a page that lost the tag — it
     * costs one branch to keep, and without it such a page would show a perfect
     * preview that can never read anything.
     */
    let decoderPromise = null;
    const ensureDecoder = () => {
      if (window.jsQR) return Promise.resolve(window.jsQR);
      if (decoderPromise) return decoderPromise;
      decoderPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = DECODER_URL;
        script.async = true;
        script.onload = () => {
          if (window.jsQR) resolve(window.jsQR);
          else reject(new Error(`${DECODER_URL} loaded but exposed no jsQR().`));
        };
        script.onerror = () => reject(new Error(`${DECODER_URL} could not be loaded.`));
        document.head.appendChild(script);
      });
      // A failed load must not poison every later attempt.
      decoderPromise.catch(() => { decoderPromise = null; });
      return decoderPromise;
    };

    const regionSize = (element) => {
      const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
      return {
        width: Math.round((rect && rect.width) || element.clientWidth || 0),
        height: Math.round((rect && rect.height) || element.clientHeight || 0),
      };
    };

    /**
     * The region lives inside a Drawer that mounts in the same tick. Starting
     * into a 0×0 box gives iOS a stream it never paints, so wait for layout.
     */
    const awaitLayout = async () => {
      let element = null;
      let size = { width: 0, height: 0 };
      for (let attempt = 0; attempt < LAYOUT_TRIES; attempt += 1) {
        element = document.getElementById(REGION_ID);
        size = element ? regionSize(element) : { width: 0, height: 0 };
        if (element && size.width > 0 && size.height > 0) return { ok: true, element, size };
        await wait(LAYOUT_WAIT_MS);
      }
      return { ok: false, element, size };
    };

    /**
     * muted + playsInline as PROPERTIES is what actually buys inline playback
     * on iOS; the attributes are belt and braces for older WebViews. The video
     * is in the template rather than created here so the drawer's DOM stays
     * Vue's, and so the stub-DOM harness can hand one over.
     */
    const prepareVideo = (element) => {
      const found = element && element.querySelector ? element.querySelector('video') : null;
      if (!found) return null;
      found.setAttribute('playsinline', 'true');
      found.setAttribute('webkit-playsinline', 'true');
      found.setAttribute('muted', 'true');
      found.setAttribute('autoplay', 'true');
      found.playsInline = true;
      found.muted = true;
      found.autoplay = true;
      return found;
    };

    const snapshot = (element) => ({
      ready: Number(element.readyState || 0),
      // An element without a `paused` property counts as paused: this check may
      // only ever report a picture it has actually seen move.
      paused: element.paused !== false,
      time: Number(element.currentTime || 0),
      width: Number(element.videoWidth || 0),
      height: Number(element.videoHeight || 0),
    });

    /* ------------------------------------------------------- the decoder -- */

    /**
     * Nearest multiple of SNAP, never above `cap` and never below SNAP itself.
     * The cap is the source's own size: upscaling into the decode canvas would
     * cost pixels without adding information.
     */
    const snap = (value, cap) => {
      const stepped = Math.round(value / SNAP) * SNAP;
      const capped = stepped > cap ? Math.floor(cap / SNAP) * SNAP : stepped;
      return Math.max(SNAP, capped);
    };

    /**
     * One decode pass: which rectangle of the frame to read, and how big the
     * canvas that receives it is.
     *
     * `source` is in the stream's own pixels — the video's intrinsic grid, not
     * its CSS box. That is the whole reason this component owns the canvas:
     * nothing in app.css can move the decoded area any more.
     */
    const makePass = (name, streamWidth, streamHeight, span) => {
      const sourceWidth = Math.round(streamWidth * span);
      const sourceHeight = Math.round(streamHeight * span);
      const width = snap(Math.min(sourceWidth, DECODE_WIDTH), sourceWidth);
      const height = snap((width * sourceHeight) / sourceWidth, sourceHeight);
      return {
        name,
        span,
        source: {
          x: Math.round((streamWidth - sourceWidth) / 2),
          y: Math.round((streamHeight - sourceHeight) / 2),
          width: sourceWidth,
          height: sourceHeight,
        },
        width,
        height,
        canvas: null,
        context: null,
      };
    };

    /**
     * The two passes, alternated frame by frame.
     *
     * full   — everything the camera sees, downscaled to DECODE_WIDTH. Catches
     *          labels anywhere in the picture and labels too big for the crop.
     * centre — the middle CENTRE_SPAN of the frame at native pixels (wherever
     *          that is no wider than DECODE_WIDTH). Not resampled at all, so it
     *          reads a smaller label than `full` does: 11% of frame width
     *          against 14% on the measured sweep.
     *
     * The centre pass is kept even when the full pass is already native, which
     * is not obvious: at equal resolution it still reads a label the full pass
     * misses, because jsQR binarizes in 8-px blocks and the same code fills a
     * larger share of the smaller image. Measured, 12 placements: full 720
     * alone knees at 12%, full 720 alternating with the native centre at 11%,
     * and the two extra reads at 11% are both centred labels — which is what
     * anyone pointing a phone at a label produces anyway, with or without a
     * rectangle drawn around the middle of the screen.
     *
     * It is dropped only when the crop would be too small to hold a code at
     * all; below MIN_CENTRE_WIDTH there is nothing left to read. Note that the
     * two canvases being the SAME width says nothing — a 1920x1080 stream gives
     * both passes 768 px, but the centre spends them on half the frame, which
     * is twice the detail.
     */
    const buildPasses = (streamWidth, streamHeight) => {
      const full = makePass('full', streamWidth, streamHeight, 1);
      const centre = makePass('centre', streamWidth, streamHeight, CENTRE_SPAN);
      if (centre.width < MIN_CENTRE_WIDTH) return [full];
      return [full, centre];
    };

    const passContext = (pass) => {
      if (pass.context) return pass.context;
      const canvas = document.createElement('canvas');
      canvas.width = pass.width;
      canvas.height = pass.height;
      // The loop reads the whole canvas back on every single frame.
      const context = canvas.getContext
        ? (canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d'))
        : null;
      pass.canvas = canvas;
      pass.context = context;
      return context;
    };

    /** The status line's decode note: what is scanned, and how fast. */
    const describePasses = () => passes
      .map((pass) => `${pass.width}×${pass.height} ${pass.name}`)
      .join(' + ');

    const stopLoop = () => {
      looping = false;
      if (frameId !== null) {
        if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frameId);
        else if (typeof window.clearTimeout === 'function') window.clearTimeout(frameId);
        // Where there is neither (the jsc harness), the pending callback still
        // drops out on its own: it checks its run token before doing anything.
        frameId = null;
      }
      lastStamp = -1;
    };

    /**
     * rAF where there is one, a timer where there is not (the jsc harness).
     * Either way exactly one callback is ever outstanding, because the next one
     * is only asked for after the current decode has returned — an overrun
     * skips a frame instead of queueing one.
     */
    const nextFrame = (fn) => (typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame(fn)
      : setTimeout(fn, 16));

    /**
     * One turn of the decode loop.
     *
     * No sleep anywhere in here. The only thing that is deliberately skipped is
     * a frame the camera has not replaced yet: currentTime has not moved, so
     * decoding it again could only produce the answer we already have.
     */
    const scanFrame = (token) => {
      if (token !== runId || !looping) { frameId = null; return; }
      const element = videoEl;
      const decode = window.jsQR;
      if (!element || !decode || !passes.length) { frameId = null; return; }

      const stamp = Number(element.currentTime || 0);
      const fresh = stamp !== lastStamp;
      if (fresh && element.readyState >= HAVE_CURRENT_DATA && !element.paused) {
        lastStamp = stamp;
        const pass = passes[passAt % passes.length];
        passAt += 1;
        const context = passContext(pass);
        if (context) {
          let image = null;
          try {
            context.drawImage(
              element,
              pass.source.x, pass.source.y, pass.source.width, pass.source.height,
              0, 0, pass.width, pass.height,
            );
            image = context.getImageData(0, 0, pass.width, pass.height);
          } catch {
            // A frame the browser will not hand over (a stream torn down
            // between the readyState check and here). The next one usually is.
            image = null;
          }
          if (image) {
            attempts += 1;
            const now = Date.now();
            if (!rateMark) rateMark = now;
            else if (now - rateMark >= 1000) {
              scanRate.value = Math.round((attempts * 1000) / (now - rateMark));
              attempts = 0;
              rateMark = now;
            }
            onFrameScanned();
            const found = decode(image.data, pass.width, pass.height, {
              inversionAttempts: 'dontInvert',
            });
            if (found && found.data) onDecoded(found.data);
          }
        }
      }
      if (token !== runId || !looping) { frameId = null; return; }
      frameId = nextFrame(() => scanFrame(token));
    };

    const startLoop = (token) => {
      if (token !== runId || frameId !== null) return;
      looping = true;
      attempts = 0;
      rateMark = 0;
      scanRate.value = 0;
      frameId = nextFrame(() => scanFrame(token));
    };

    /**
     * Rebuilds the passes (and with them the overlay) for a stream size. Called
     * from every event that can be the first to know it, so whichever arrives
     * first wins and the rest are no-ops.
     */
    const applyStreamSize = (token, width, height) => {
      if (token !== runId || !(width > 0) || !(height > 0)) return false;
      if (streamSize && streamSize.width === width && streamSize.height === height) return false;
      streamSize = { width, height };
      passes = buildPasses(width, height);
      passAt = 0;
      scanNote.value = describePasses();
      streamAspect.value = width / height;
      // Twice, deliberately. The first is for the box as it is right now; the
      // second is after Vue has applied the new aspect-ratio and the browser
      // has relaid the viewfinder, because a box that changes size by CSS fires
      // no resize event and the guides would otherwise be left on the old one.
      refitOverlay(token);
      nextTick(() => refitOverlay(token));
      return true;
    };

    /**
     * Start decoding as early as the stream's size is known — `loadedmetadata`,
     * which is well before the liveness check can have confirmed two advancing
     * frames. Waiting for that confirmation cost 150-300 ms of every scan for
     * nothing: the loop already skips any frame that is not ready, not playing,
     * or not new, so starting early costs nothing and reads the very first
     * frame the camera paints.
     */
    const beginScanning = (token) => {
      const element = videoEl;
      if (!element || token !== runId) return;
      applyStreamSize(token, Number(element.videoWidth || 0), Number(element.videoHeight || 0));
      if (passes.length) startLoop(token);
    };

    /* -------------------------------------------------------- the overlay -- */

    /**
     * How a `contain` letterbox lands the stream inside the viewfinder. The
     * overlay is positioned from this, and only from this, so the guides cannot
     * drift away from what is scanned.
     */
    const fitBox = (streamWidth, streamHeight, boxWidth, boxHeight) => {
      if (!(streamWidth > 0) || !(streamHeight > 0) || !(boxWidth > 0) || !(boxHeight > 0)) return null;
      const scale = Math.min(boxWidth / streamWidth, boxHeight / streamHeight);
      const width = streamWidth * scale;
      const height = streamHeight * scale;
      return {
        left: (boxWidth - width) / 2,
        top: (boxHeight - height) / 2,
        width,
        height,
      };
    };

    /**
     * The one rectangle the overlay draws, in viewfinder pixels: where the
     * full-frame pass lands on screen, which is the whole picture.
     *
     * There is deliberately nothing else. The dashed inner rectangle this used
     * to return marked where the centre pass gets extra pixels — a resolution
     * hint, not a scan boundary — and it read as a target you had to aim into
     * ("Remove the dashed guide from scanner? were anyways scanning the whole
     * feed?" — which is exactly right). The centre pass itself is still in the
     * loop; only its marker is gone. Nothing untrue is left behind: everything
     * inside these guides is scanned, and the middle simply gets more detail.
     *
     * Still derived from `passes`, so guides over a stream nothing is decoding
     * remain inexpressible.
     */
    const overlayBox = (element, box) => {
      if (!element || !passes.length) return null;
      return fitBox(
        Number(element.videoWidth || 0), Number(element.videoHeight || 0),
        box.width, box.height,
      );
    };

    const place = (element, rect) => {
      if (!element || !element.style) return;
      element.style.left = `${Math.round(rect.left)}px`;
      element.style.top = `${Math.round(rect.top)}px`;
      element.style.width = `${Math.round(rect.width)}px`;
      element.style.height = `${Math.round(rect.height)}px`;
    };

    /**
     * Re-lays the guides over the picture. Called when the stream's size
     * arrives and on every resize or rotation, because the viewfinder moves and
     * the decoded region does not.
     */
    const refitOverlay = (token) => {
      if (token !== runId) return null;
      const region = document.getElementById(REGION_ID);
      if (!region || !region.querySelector) return null;
      const frame = region.querySelector(`.${FRAME_CLASS}`);
      if (!frame) return null;
      const outer = overlayBox(videoEl, regionSize(region));
      if (!outer) return null;
      place(frame, outer);
      return outer;
    };

    /* ------------------------------------------------- the viewport shape -- */

    /**
     * Which layout app.css has chosen, asked of the browser rather than
     * guessed at: matchMedia evaluates the very same query the stylesheet
     * carries. Where there is no matchMedia at all the width is compared
     * against the same number, so the two answers cannot disagree by
     * construction.
     */
    const isFullscreenWidth = () => {
      try {
        if (typeof window.matchMedia === 'function') {
          const list = window.matchMedia(MOBILE_QUERY);
          if (list && typeof list.matches === 'boolean') return list.matches;
        }
      } catch {
        // An engine that has matchMedia but throws on it. Fall through.
      }
      const width = Number(window.innerWidth || 0);
      return width > 0 && width <= MOBILE_MAX_WIDTH;
    };

    /**
     * Crossing the breakpoint swaps a drawer-sized viewfinder for a
     * full-screen one. The decoded rectangles do not move — they are fractions
     * of the camera's own pixel grid — but the box the guides are fitted into
     * does, so they have to be re-measured or they keep outlining the old one.
     *
     * Refitted twice on a real change, for the same reason applyStreamSize is:
     * once for the box as it stands, once after the new layout has landed.
     */
    const syncFullscreen = () => {
      const now = isFullscreenWidth();
      const changed = now !== fullscreen.value;
      fullscreen.value = now;
      refitOverlay(runId);
      if (changed) nextTick(() => refitOverlay(runId));
      return now;
    };

    // Owned by the component's lifetime rather than by a run, so a rotation
    // while the camera is still refusing to open is noticed too.
    const viewportOff = [];
    const watchViewport = () => {
      let list = null;
      try {
        if (typeof window.matchMedia === 'function') list = window.matchMedia(MOBILE_QUERY);
      } catch {
        list = null;
      }
      if (list && typeof list.addEventListener === 'function') {
        list.addEventListener('change', syncFullscreen);
        viewportOff.push(() => list.removeEventListener('change', syncFullscreen));
      } else if (list && typeof list.addListener === 'function') {
        // Safari before 14 has no addEventListener on a MediaQueryList.
        list.addListener(syncFullscreen);
        viewportOff.push(() => list.removeListener(syncFullscreen));
      }
      if (typeof window.addEventListener === 'function') {
        for (const type of ['resize', 'orientationchange']) {
          window.addEventListener(type, syncFullscreen);
          viewportOff.push(() => window.removeEventListener(type, syncFullscreen));
        }
      }
    };
    const unwatchViewport = () => {
      while (viewportOff.length) {
        const off = viewportOff.pop();
        try { off(); } catch { /* the listener is already gone */ }
      }
    };

    /* --------------------------------------------------- camera controls -- */

    const videoTrack = () => {
      const tracks = stream && typeof stream.getVideoTracks === 'function'
        ? stream.getVideoTracks()
        : null;
      return (tracks && tracks[0]) || null;
    };

    const savedZoom = () => {
      try {
        const raw = localStorage.getItem(ZOOM_KEY);
        const value = raw === null ? NaN : Number(raw);
        return Number.isFinite(value) ? value : null;
      } catch {
        return null;   // private browsing — the default is fine
      }
    };

    const rememberZoom = (value) => {
      try { localStorage.setItem(ZOOM_KEY, String(value)); } catch { /* not persisted */ }
    };

    const applyTrackConstraint = async (settings) => {
      const track = videoTrack();
      if (!track || typeof track.applyConstraints !== 'function') return false;
      try {
        await track.applyConstraints({ advanced: [settings] });
        return true;
      } catch {
        // A capability the device advertised but will not accept right now.
        return false;
      }
    };

    /**
     * Zoom and torch are read off the track's own capabilities, so a camera
     * that has neither renders neither control. Nothing here may throw on a
     * browser without getCapabilities at all (Firefox, older WebKit).
     */
    const readCapabilities = async (token) => {
      zoomRange.value = null;
      torchAvailable.value = false;
      torchOn.value = false;
      const track = videoTrack();
      if (!track || typeof track.getCapabilities !== 'function') return;
      let caps = null;
      try { caps = track.getCapabilities(); } catch { caps = null; }
      if (!caps || token !== runId) return;

      if (caps.zoom && Number.isFinite(Number(caps.zoom.min)) && Number.isFinite(Number(caps.zoom.max))
        && Number(caps.zoom.max) > Number(caps.zoom.min)) {
        const min = Number(caps.zoom.min);
        const max = Number(caps.zoom.max);
        const step = Number(caps.zoom.step) > 0 ? Number(caps.zoom.step) : 0.1;
        zoomRange.value = { min, max, step };
        const wanted = savedZoom();
        const value = Math.min(max, Math.max(min, wanted === null ? DEFAULT_ZOOM : wanted));
        zoom.value = value;
        await applyTrackConstraint({ zoom: value });
      }
      if (caps.torch === true) torchAvailable.value = true;
    };

    const setZoom = async (value) => {
      const range = zoomRange.value;
      if (!range) return;
      const wanted = Math.min(range.max, Math.max(range.min, Number(value) || range.min));
      zoom.value = wanted;
      rememberZoom(wanted);
      await applyTrackConstraint({ zoom: wanted });
    };

    const nudgeZoom = (delta) => {
      const range = zoomRange.value;
      if (!range) return Promise.resolve();
      return setZoom(Number(zoom.value || range.min) + delta);
    };

    const toggleTorch = async () => {
      if (!torchAvailable.value) return;
      const wanted = !torchOn.value;
      const applied = await applyTrackConstraint({ torch: wanted });
      // Only claim the light is on if the device accepted it.
      if (applied) torchOn.value = wanted;
    };

    /** The light may never survive the drawer that lit it. */
    const douseTorch = async () => {
      if (!torchOn.value) return;
      await applyTrackConstraint({ torch: false });
      torchOn.value = false;
    };

    /* ------------------------------------------------------ the liveness -- */

    /**
     * The truthful liveness test. Returns 'live' only after two consecutive
     * samples with data, not paused, and an advancing currentTime; 'paused'
     * when playback is simply not running (the tap-to-start case, which covers
     * both a caught rejection and a silently swallowed one); and 'stalled' when
     * it claims to be playing but the clock never moves.
     */
    const sampleLive = async (element, token, tries) => {
      let previous = null;
      let last = snapshot(element);
      for (let attempt = 0; attempt < tries; attempt += 1) {
        if (token !== runId) return Object.assign({ result: 'cancelled' }, last);
        last = snapshot(element);
        if (last.ready >= HAVE_CURRENT_DATA && !last.paused) {
          if (previous !== null && last.time > previous) {
            return Object.assign({ result: 'live' }, last);
          }
          previous = last.time;
        } else {
          previous = null;
        }
        await wait(LIVE_WAIT_MS);
      }
      return Object.assign({ result: last.paused ? 'paused' : 'stalled' }, last);
    };

    const TAP_FIRST = 'The camera is open but iOS did not start the picture on its own. '
      + 'Tap the preview to start it.';
    const TAP_REFUSED = 'iOS refused to play the camera even on a tap. The usual cause is Low Power '
      + 'Mode — turn it off in Settings → Battery, then try again. If it is already off, check this '
      + 'site in Safari\'s "AA" menu → Website Settings, close any other app using the camera, and '
      + 'reload. Or type the ID below.';
    const INTERRUPTED = 'The camera stream was interrupted — another app took the camera, the screen '
      + 'locked, or the device revoked it. Restart the scanner to get the picture back.';
    const DECODER_DEAD = 'The camera is running but the decoder never started: no frame has been '
      + `examined in the last ${Math.round((DECODE_TRIES * DECODE_WAIT_MS) / 1000)} seconds, so no `
      + 'label can ever be read. Restart the scanner, or type the ID below.';

    /**
     * The decode heartbeat.
     *
     * The loop can only run once the picture does, so its silence over a live
     * preview means something in the decode path is broken rather than slow —
     * a decoder that never loaded, a canvas the browser refuses, a stream that
     * cannot be drawn from. All of those are invisible in the preview.
     */
    const watchDecoder = async (token) => {
      beatSerial += 1;
      const serial = beatSerial;
      for (let attempt = 0; attempt < DECODE_TRIES; attempt += 1) {
        if (token !== runId || serial !== beatSerial) return;
        if (decodeAlive.value) return;
        await wait(DECODE_WAIT_MS);
      }
      if (token !== runId || serial !== beatSerial || decodeAlive.value) return;
      decoderText.value = DECODER_DEAD;
    };

    const showTap = (text) => {
      needsTap.value = true;
      tapText.value = text;
      liveText.value = '';
      status.value = 'running';
    };

    const interrupt = (token) => {
      if (token !== runId) return;
      stopLoop();
      status.value = 'interrupted';
      errorText.value = INTERRUPTED;
      errorDetail.value = playNote.value;
      liveText.value = '';
      needsTap.value = false;
      decoderText.value = '';
      torchOn.value = false;
    };

    /**
     * Watches the current video until it is demonstrably playing, or until it
     * is clear that it is not. Called after the stream is attached, and again
     * from every `playing` event, so whichever happens first wins and the later
     * one is dropped by the serial.
     */
    const watchLive = async (token) => {
      const element = videoEl;
      if (!element || token !== runId) return;
      liveSerial += 1;
      const serial = liveSerial;
      // A rejection already told us the answer; do not make the user stare at a
      // black box for the full budget before offering the tap.
      const tries = playError.value ? REFUSED_TRIES : LIVE_TRIES;
      const seen = await sampleLive(element, token, tries);
      if (token !== runId || serial !== liveSerial) return;

      if (seen.result === 'live') {
        liveSeen = true;
        needsTap.value = false;
        status.value = 'running';
        // Usually a no-op by now — `loadedmetadata` got here first — but the
        // backstop for a stream whose metadata event was missed entirely.
        applyStreamSize(token, seen.width, seen.height);
        liveText.value = `Live · ${seen.width}×${seen.height}`;
        refitOverlay(token);
        startLoop(token);
        // Not awaited: a camera switch must not sit on the heartbeat's budget.
        watchDecoder(token);
        return;
      }
      if (seen.result === 'cancelled') return;
      if (seen.result === 'paused') {
        showTap(TAP_FIRST);
        return;
      }
      failWith(
        'The camera stream started but never delivered a picture — it reports playing, yet the '
        + `preview is still frozen at ${seen.width}×${seen.height} after `
        + `${Math.round((tries * LIVE_WAIT_MS) / 1000)} seconds. Try again, switch camera, `
        + 'or type the ID below.',
      );
    };

    /**
     * The cure. A play() issued directly inside a user gesture is allowed on
     * iOS even in Low Power Mode, where the automatic one is rejected with
     * NotAllowedError. Nothing may be awaited before the call — one await and
     * the gesture no longer counts as user activation.
     */
    const onTapStart = () => {
      const element = videoEl;
      const token = runId;
      if (!element || typeof element.play !== 'function') {
        failWith('There is no video element to start any more. Close the scanner and open it again.');
        return Promise.resolve();
      }

      const accepted = () => {
        if (token !== runId) return undefined;
        needsTap.value = false;
        return watchLive(token);
      };
      const refused = (error) => {
        if (token !== runId) return;
        const text = rawText(error);
        if (text) playError.value = text;
        showTap(TAP_REFUSED);
      };

      let played = null;
      try {
        played = element.play();
      } catch (error) {
        refused(error);
        return Promise.resolve();
      }
      if (played && typeof played.then === 'function') {
        return played.then(accepted, refused);
      }
      return Promise.resolve(accepted());
    };

    const listen = (target, type, handler, capture = false) => {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler, capture);
      detachers.push(() => {
        if (typeof target.removeEventListener === 'function') {
          target.removeEventListener(type, handler, capture);
        }
      });
    };

    const releaseListeners = () => {
      const pending = detachers;
      detachers = [];
      for (const off of pending) {
        try { off(); } catch { /* the element is already gone */ }
      }
    };

    /**
     * The state machine runs off the video's own events, because a stream that
     * has been attached says nothing about playback.
     */
    const watchVideo = (element, token) => {
      // Metadata is where videoWidth first exists, and it is the earliest
      // moment the decode loop can be built at all.
      listen(element, 'loadedmetadata', () => beginScanning(token));
      listen(element, 'playing', () => {
        if (token !== runId) return;
        needsTap.value = false;
        beginScanning(token);
        watchLive(token);
      });
      listen(element, 'pause', () => {
        // Before the first live frame the sampler owns the verdict; after it, a
        // pause is the preview dying and a tap can bring it back.
        if (token !== runId || !liveSeen) return;
        stopLoop();
        showTap(TAP_FIRST);
      });
      listen(element, 'ended', () => interrupt(token));
      // The stream's size can change under us (a camera switch, a rotation the
      // device answers with a different capture): rebuild both the passes and
      // the guides from the new numbers rather than keeping stale ones.
      listen(element, 'resize', () => {
        if (token !== runId || !liveSeen) return;
        const width = Number(element.videoWidth || 0);
        const height = Number(element.videoHeight || 0);
        if (!applyStreamSize(token, width, height)) return;
        liveText.value = `Live · ${width}×${height}`;
      });
    };

    /**
     * "Blinked on, then black": the track itself ends or mutes after the
     * picture was up — iOS handing the camera to another app, a lock, a
     * revoked permission. That is not a playback problem and a tap will not
     * fix it, so it gets its own message and a restart.
     */
    const watchTrack = (element, token) => {
      const track = videoTrack();
      if (!track) return;
      const died = () => { if (liveSeen) interrupt(token); };
      listen(track, 'ended', died);
      listen(track, 'mute', died);
    };

    /**
     * Deliberately not a second getUserMedia: iOS keeps only one capture alive,
     * so opening another to enumerate blacks out the preview that is running.
     * enumerateDevices() needs no stream and, once permission has been granted,
     * still carries the labels.
     */
    const listCameras = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        cameras.value = (devices || [])
          .filter((device) => device.kind === 'videoinput')
          .map((device) => ({ id: device.deviceId, label: device.label }));
      } catch {
        cameras.value = [];
      }
    };

    const start = async (deviceId = null) => {
      // A retry must not leave a second camera open on the same drawer.
      if (stream) await stop();

      const token = runId + 1;
      runId = token;
      status.value = 'starting';
      errorText.value = '';
      errorDetail.value = '';
      liveText.value = '';
      needsTap.value = false;
      tapText.value = '';
      playError.value = '';
      decodeAlive.value = false;
      decoderText.value = '';
      scanNote.value = '';
      scanRate.value = 0;
      streamAspect.value = 0;
      liveSeen = false;
      videoEl = null;
      passes = [];
      passAt = 0;
      streamSize = null;
      releaseListeners();

      const blocked = contextProblem();
      if (blocked) {
        failWith(blocked);
        return;
      }

      try {
        await ensureDecoder();
      } catch (error) {
        failWith('The QR decoder did not load, so nothing could be read even with a perfect '
          + 'picture. Reload the page and try again.', rawText(error));
        return;
      }
      if (token !== runId) return;

      const layout = await awaitLayout();
      if (token !== runId) return;
      if (!layout.ok) {
        failWith(layout.element
          ? `The scanner area never got a size (${layout.size.width}×${layout.size.height} pixels), `
            + 'so the camera would have nowhere to draw. Close the scanner and open it again.'
          : `The scanner area (#${REGION_ID}) is not on the page. Close the scanner and open it again.`);
        return;
      }

      const element = prepareVideo(layout.element);
      if (!element) {
        failWith('The scanner has no video element to draw into. '
          + 'Close the scanner and open it again.');
        return;
      }
      videoEl = element;

      // The guides follow the viewfinder, not the stream: a rotation or a
      // drawer resize moves where the picture is drawn, while the decoded
      // rectangle stays exactly the same fraction of the frame.
      const refit = () => refitOverlay(token);
      listen(window, 'resize', refit);
      listen(window, 'orientationchange', refit);

      let opened = null;
      try {
        // Ask generously: downscaling to the decode canvas should be a choice,
        // not a limit. The phone answers with whatever it likes — 720×1280
        // portrait on the device this was measured on — and every number below
        // is derived from what actually arrived.
        const source = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' };
        const constraints = {
          audio: false,
          video: Object.assign({ width: { ideal: 1920 }, height: { ideal: 1080 } }, source),
        };

        const asked = navigator.mediaDevices.getUserMedia(constraints);
        // Covers exactly one thing: getUserMedia (or the permission prompt)
        // never answering at all. Everything about the picture is decided by
        // the video's own events further down.
        let settled = false;
        let stalled = false;
        // Also keeps an eventual rejection from going unhandled once the race
        // below has already been decided by the deadline.
        asked.then(() => { settled = true; }, () => { settled = true; });
        const deadline = (async () => {
          for (let attempt = 0; attempt < OPEN_TRIES; attempt += 1) {
            await wait(OPEN_WAIT_MS);
            if (settled || token !== runId) return;
          }
          stalled = true;
        })();
        opened = await Promise.race([asked, deadline]);
        if (stalled) {
          failWith('The camera never opened: the permission prompt or getUserMedia did not answer '
            + `within ${Math.round((OPEN_TRIES * OPEN_WAIT_MS) / 1000)} seconds. Keep this tab in `
            + 'the foreground and try again, or type the ID below.');
          return;
        }
      } catch (error) {
        failWith(describeError(error), rawText(error));
        return;
      }
      if (token !== runId) {
        // The drawer closed while the camera was opening: do not leave it on.
        if (opened && typeof opened.getTracks === 'function') {
          for (const track of opened.getTracks()) { try { track.stop(); } catch { /* gone */ } }
        }
        return;
      }
      if (!opened) {
        failWith('The camera returned no stream. Try again, or type the ID below.');
        return;
      }

      stream = opened;
      status.value = 'running';
      element.srcObject = stream;
      watchVideo(element, token);
      watchTrack(element, token);

      // The automatic play() is where iOS refuses in Low Power Mode, and the
      // rejection is kept for the rest of the run: recovering by tap does not
      // make it untrue.
      try {
        const played = element.play ? element.play() : null;
        if (played && typeof played.then === 'function') await played;
      } catch (error) {
        playError.value = rawText(error);
      }
      if (token !== runId) return;

      await readCapabilities(token);
      if (token !== runId) return;

      await listCameras();
      if (token !== runId) return;

      await watchLive(token);
    };

    const stop = async () => {
      runId += 1;
      stopLoop();
      liveText.value = '';
      needsTap.value = false;
      decodeAlive.value = false;
      decoderText.value = '';
      scanNote.value = '';
      scanRate.value = 0;
      streamAspect.value = 0;
      liveSeen = false;
      passes = [];
      streamSize = null;
      releaseListeners();
      if (!stream) {
        videoEl = null;
        return;
      }
      // Before the tracks go: the torch is a property of the track, and a
      // stopped track cannot be told to switch its light off.
      await douseTorch();
      zoomRange.value = null;
      torchAvailable.value = false;
      if (typeof stream.getTracks === 'function') {
        for (const track of stream.getTracks()) {
          try { track.stop(); } catch { /* already gone */ }
        }
      }
      if (videoEl) {
        try { videoEl.srcObject = null; } catch { /* the element is already gone */ }
      }
      stream = null;
      videoEl = null;
      status.value = 'stopped';
    };

    const switchCamera = async () => {
      await stop();
      await start(cameraId.value || null);
    };

    /** Offered after an interruption: re-runs the whole start path. */
    const restart = async () => {
      await start(cameraId.value || null);
    };

    const submitManual = () => {
      const ref = extractRef(manualId.value);
      if (!ref) {
        toast('Enter an asset ID, or a unit like 12.1.', 'warning');
        return;
      }
      manualId.value = '';
      handle(ref);
    };

    /**
     * Whether the camera picker is offered at all.
     *
     * "Hide the camera selection. not necessary" — on his phone
     * facingMode: 'environment' picks the right lens every time, and a dropdown
     * sitting over the viewfinder is clutter. But it is the actual remedy where
     * the automatic choice is the thing that went wrong: a laptop with three
     * cameras, a device that hands back the front one, a stream that opens and
     * then never paints. So it appears exactly in those states — beside the
     * Restart and Try again that already live there — and nowhere else.
     *
     * The `> 1` is not decoration: enumerateDevices only runs once a camera has
     * actually opened, so this is empty for a camera that never opened at all,
     * and a device with one camera has nothing to switch to. Offering a picker
     * with a single entry as the cure for a broken preview would be a lie.
     *
     * The cost, stated plainly: a stream that goes live on the WRONG lens is
     * not a failure state, so the picker will not be there for it. That is the
     * trade the request asks for.
     */
    const cameraFix = computed(() => cameras.value.length > 1
      && (status.value === 'error'
        || status.value === 'interrupted'
        || Boolean(decoderText.value)));

    const modeHint = computed(() => ({
      lookup: 'Scan a label to open that asset.',
      collect: 'Keep scanning — each item is added to your selection.',
      return: 'Keep scanning — each item is checked straight back in.',
    }[mode.value]));

    /**
     * The honest decode line: the canvases actually being binarized, and the
     * rate actually achieved. If a future change makes the loop slow, this says
     * so on the device instead of hiding it.
     */
    const decodeNote = computed(() => {
      if (!scanNote.value) return '';
      return scanRate.value
        ? `${scanNote.value} · ${scanRate.value}/s`
        : `${scanNote.value} · measuring…`;
    });

    /**
     * The viewfinder's shape. Nothing until the stream's size is known, so the
     * CSS default (4/3) holds while the camera is opening; the stream's own
     * ratio afterwards. app.css caps the height so a tall portrait preview
     * cannot push the controls under it off a phone screen — when that cap
     * bites the picture letterboxes again, which is exactly what it did before.
     */
    const viewfinderStyle = computed(() => (streamAspect.value
      ? { aspectRatio: String(streamAspect.value) }
      : {}));

    const zoomLabel = computed(() => (zoomRange.value
      ? `${(Math.round(Number(zoom.value) * 10) / 10).toFixed(1)}×`
      : ''));

    onMounted(() => {
      syncFullscreen();
      watchViewport();
      start();
    });
    onBeforeUnmount(() => {
      unwatchViewport();
      stop();
    });

    return {
      state, mode, status, errorText, errorDetail, liveText, hits, cameras, cameraId, manualId,
      needsTap, tapText, playError, playNote, decodeAlive, decoderText, decodeNote, scanRate,
      viewfinderStyle, fullscreen, syncFullscreen,
      zoomRange, zoom, zoomLabel, setZoom, nudgeZoom, torchAvailable, torchOn, toggleTorch,
      REGION_ID,
      cameraFix,
      modeHint, switchCamera, submitManual, start, stop, restart, onTapStart, extractId, extractRef,
      isSelected, getQuantity, selectedUnitCount, emit,
    };
  },
  template: `
    <Drawer title="Scan" icon="bi-qr-code-scan" @close="stop().then(() => emit('close'))">
      <!-- One stage, two layouts, one set of controls.
           On a desktop the stage and its two bars are display:contents, so
           every child below lays itself out in the drawer body exactly as it
           did before this existed. Below app.css's own mobile breakpoint the
           stage is the whole viewport and the two bars become scrims floating
           over the picture. Nothing here is duplicated per layout except the
           two controls the drawer's own chrome provides on desktop and cannot
           provide from underneath a full-screen stage: the close button and
           the footer actions. -->
      <div class="trax-scan-stage">

      <div class="trax-scan-bar trax-scan-bar-top">
        <div class="trax-scan-toprow">
          <button type="button" class="trax-scan-close" aria-label="Close the scanner"
                  @click="stop().then(() => emit('close'))">
            <i class="bi bi-x-lg" aria-hidden="true"></i>
          </button>
          <div class="btn-group btn-group-sm w-100 trax-scan-modes" role="group" aria-label="Scan mode">
            <button class="btn" :class="mode === 'lookup' ? 'btn-secondary' : 'btn-outline-secondary'"
                    @click="mode = 'lookup'"><i class="bi bi-search"></i> Look up</button>
            <button class="btn" :class="mode === 'collect' ? 'btn-secondary' : 'btn-outline-secondary'"
                    @click="mode = 'collect'"><i class="bi bi-cart-plus"></i> Collect</button>
            <button class="btn" :class="mode === 'return' ? 'btn-secondary' : 'btn-outline-secondary'"
                    @click="mode = 'return'"><i class="bi bi-box-arrow-in-left"></i> Return</button>
          </div>
        </div>
        <p class="small text-secondary trax-scan-hint">{{ modeHint }}</p>
      </div>

      <div class="trax-scanner" :style="viewfinderStyle">
        <div :id="REGION_ID" class="trax-scan-region">
          <video class="trax-scan-video" playsinline webkit-playsinline muted autoplay></video>
          <!-- The corner guides, laid out in pixels from the full-frame pass's
               own drawImage source rect: this box IS what is decoded, all of
               it. There is nothing inside it to aim at. -->
          <div v-show="liveText" class="trax-scan-frame">
            <span class="trax-scan-corner tl"></span>
            <span class="trax-scan-corner tr"></span>
            <span class="trax-scan-corner bl"></span>
            <span class="trax-scan-corner br"></span>
          </div>
        </div>
        <button v-if="needsTap" type="button" class="btn btn-primary trax-scan-tap"
                @click="onTapStart">
          <span class="fs-5">▶ Tap to start the camera</span>
          <span class="small" style="opacity:.9;max-width:34ch">{{ tapText }}</span>
        </button>
      </div>

      <div class="trax-scan-bar trax-scan-bar-bottom">

        <div v-if="(zoomRange || torchAvailable) && liveText" class="d-flex align-items-center gap-2 mb-2">
          <template v-if="zoomRange">
            <button class="btn btn-sm btn-outline-secondary" type="button"
                    @click="nudgeZoom(-0.5)" aria-label="Zoom out">−</button>
            <input type="range" class="form-range flex-grow-1" :min="zoomRange.min"
                   :max="zoomRange.max" :step="zoomRange.step" :value="zoom"
                   aria-label="Camera zoom"
                   @input="setZoom($event.target.value)">
            <button class="btn btn-sm btn-outline-secondary" type="button"
                    @click="nudgeZoom(0.5)" aria-label="Zoom in">+</button>
            <span class="small text-secondary" style="min-width:3.2em">{{ zoomLabel }}</span>
          </template>
          <button v-if="torchAvailable" class="btn btn-sm"
                  :class="torchOn ? 'btn-warning' : 'btn-outline-secondary'"
                  type="button" @click="toggleTorch()"
                  :aria-label="torchOn ? 'Turn the torch off' : 'Turn the torch on'">
            <i class="bi" :class="torchOn ? 'bi-lightbulb-fill' : 'bi-lightbulb'" aria-hidden="true"></i>
          </button>
        </div>

        <div v-if="status === 'starting'" class="small text-secondary">
          <span class="spinner-border spinner-border-sm me-1"></span> Starting the camera…
        </div>

        <div v-if="status === 'running'" class="small text-secondary">
          <template v-if="liveText">
            <i class="bi bi-record-circle text-success"></i> {{ liveText }}<span v-if="decodeAlive"> · {{ decodeNote }}</span>
          </template>
          <template v-else-if="needsTap">
            <i class="bi bi-hand-index-thumb text-warning"></i> Waiting for a tap to start playback.
          </template>
          <template v-else>
            <span class="spinner-border spinner-border-sm me-1"></span> Waiting for the first frame…
          </template>
          <div v-if="playNote" class="mt-1">{{ playNote }}</div>
        </div>

        <div v-if="decoderText" class="alert alert-warning py-2 px-3 small mt-2">
          <strong>Decoder not running.</strong>
          <div class="mt-1">{{ decoderText }}</div>
          <button class="btn btn-sm btn-outline-light mt-2" @click="restart()">Restart the scanner</button>
        </div>

        <div v-if="status === 'error'" class="alert alert-warning py-2 px-3 small">
          <strong>Camera unavailable.</strong>
          <div class="mt-1">{{ errorText }}</div>
          <div v-if="errorDetail" class="mt-1 text-secondary">{{ errorDetail }}</div>
          <button class="btn btn-sm btn-outline-light mt-2" @click="start()">Try again</button>
        </div>

        <div v-if="status === 'interrupted'" class="alert alert-warning py-2 px-3 small">
          <strong>Camera interrupted.</strong>
          <div class="mt-1">{{ errorText }}</div>
          <div v-if="errorDetail" class="mt-1 text-secondary">{{ errorDetail }}</div>
          <button class="btn btn-sm btn-outline-light mt-2" @click="restart()">Restart</button>
        </div>

        <!-- Not part of normal operation any more; the remedy for the states
             above, next to their own Restart and Try again. -->
        <div v-if="cameraFix" class="mt-2">
          <label class="form-label small" for="cam">Try another camera</label>
          <div class="input-group input-group-sm">
            <select id="cam" class="form-select" v-model="cameraId">
              <option value="">Automatic (rear)</option>
              <option v-for="cam in cameras" :key="cam.id" :value="cam.id">{{ cam.label || cam.id }}</option>
            </select>
            <button class="btn btn-outline-secondary" @click="switchCamera">Switch</button>
          </div>
        </div>

        <hr>

        <label class="form-label small" for="manual-id">Or type an ID</label>
        <form class="input-group input-group-sm" @submit.prevent="submitManual">
          <input id="manual-id" class="form-control" v-model="manualId"
                 inputmode="decimal" placeholder="e.g. 12 or 12.1">
          <button class="btn btn-outline-secondary" type="submit">Go</button>
        </form>

        <div v-if="hits.length" class="mt-3">
          <h3 class="trax-page-title mb-2">Scanned ({{ hits.length }})</h3>
          <ul class="list-group list-group-flush trax-scan-hits">
            <li v-for="hit in hits" :key="hit.at"
                class="list-group-item bg-transparent d-flex align-items-center gap-2 py-1">
              <span class="flex-grow-1 text-truncate">{{ hit.asset.name }}</span>
              <span v-if="hit.unit" class="trax-kind-chip font-monospace">
                {{ hit.asset.id }}.{{ hit.unit }}
              </span>
              <StatusBadge :status="hit.asset.effectiveStatus" :kind="hit.asset.kind" />
              <span v-if="isSelected(hit.asset.id)" class="trax-kind-chip">
                ×{{ getQuantity(hit.asset.id) }}
              </span>
              <i v-if="isSelected(hit.asset.id)" class="bi bi-cart-check text-primary"></i>
            </li>
          </ul>
        </div>

        <!-- The drawer's own footer, again, for the layout that covers it. Both
             copies exist in the DOM at every width and app.css shows exactly one
             of them, so a phone can never end up with neither. -->
        <div class="trax-scan-actions">
          <span class="flex-grow-1 small text-secondary">
            {{ state.selected.length }} selected · {{ selectedUnitCount }} unit(s)
          </span>
          <button v-if="mode === 'collect' && state.selected.length" class="btn btn-sm btn-primary"
                  @click="stop().then(() => { emit('close'); emit('basket'); })">
            Review selection
          </button>
          <button class="btn btn-sm btn-outline-secondary" @click="stop().then(() => emit('close'))">
            Done
          </button>
        </div>

      </div>
      </div>

      <template #footer>
        <span class="flex-grow-1 small text-secondary">
          {{ state.selected.length }} selected · {{ selectedUnitCount }} unit(s)
        </span>
        <button v-if="mode === 'collect' && state.selected.length" class="btn btn-sm btn-primary"
                @click="stop().then(() => { emit('close'); emit('basket'); })">
          Review selection
        </button>
        <button class="btn btn-sm btn-outline-secondary" @click="stop().then(() => emit('close'))">
          Done
        </button>
      </template>
    </Drawer>
  `,
};
