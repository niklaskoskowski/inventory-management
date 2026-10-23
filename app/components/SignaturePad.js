import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { lockScroll, unlockScroll } from '../lib/scroll-lock.js';

/**
 * A signature pad, for the counter.
 *
 * Inline it is only a field: "Tap to sign", or the signature once there is
 * one. Tapping it opens a full-screen sheet whose drawing area always runs
 * along the LONG side of the screen — on a phone held upright the sheet is
 * drawn turned by 90°, so the customer turns the phone and signs across it.
 * On a desktop or a tablet in landscape it is simply a large, wide box.
 *
 * The strokes are kept as points, not pixels. A resize — the device turned,
 * the browser bar sliding away — redraws them at the new size instead of
 * wiping the canvas, which is what used to lose a signature on rotation.
 *
 * Pointer events, so a finger, a stylus and a mouse are one code path. The
 * canvas is backed at device resolution and drawn in CSS pixels, or a
 * signature taken on a phone arrives as a staircase.
 *
 * It draws **dark ink on white**, not on transparency, because that is what
 * the bitmap is stored and printed on: the same picture travels from the
 * tablet to the customer's booking page to the PDF without an inversion.
 *
 * Hands back a PNG Blob through `submit`, cropped to the ink; the parent
 * decides what to do with it. Deliberately knows nothing about bookings.
 */

const INK = '#111827';
const PEN = 2.6;

/** Strokes are stored normalised to the drawing area: x and y in 0..1. */
function paint(canvas, strokes, width, height, { pen = PEN, background = true } = {}) {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (background) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = pen;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of strokes) {
    if (!stroke.length) continue;
    ctx.beginPath();
    ctx.moveTo(stroke[0].x * width, stroke[0].y * height);
    // A tap that never moved is still a mark, so it lands as a dot.
    if (stroke.length === 1) ctx.lineTo(stroke[0].x * width + 0.1, stroke[0].y * height);
    for (let i = 1; i < stroke.length; i += 1) ctx.lineTo(stroke[i].x * width, stroke[i].y * height);
    ctx.stroke();
  }
  return ctx;
}

/** The box the ink occupies, in 0..1 units, or null when nothing is drawn. */
function inkBox(strokes) {
  let box = null;
  for (const stroke of strokes) {
    for (const p of stroke) {
      if (!box) box = { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y };
      else {
        box.minX = Math.min(box.minX, p.x); box.maxX = Math.max(box.maxX, p.x);
        box.minY = Math.min(box.minY, p.y); box.maxY = Math.max(box.maxY, p.y);
      }
    }
  }
  return box;
}

export default {
  name: 'SignaturePad',
  props: {
    height: { type: Number, default: 180 },
    busy: { type: Boolean, default: false },
    // Why the drawing may not be saved yet, e.g. terms still to be accepted.
    // Empty means nothing is in the way. The pad stays drawable either way:
    // the order the customer does things in is theirs.
    locked: { type: String, default: '' },
    cancelLabel: { type: String, default: 'Cancel' },
    submitLabel: { type: String, default: 'Save signature' },
  },
  emits: ['submit', 'cancel'],
  setup(props, { emit }) {
    const strokes = ref([]);
    const drawn = computed(() => strokes.value.some((s) => s.length));

    // --- The inline field: a preview of what was signed ---
    const preview = ref(null);
    const renderPreview = () => {
      const canvas = preview.value;
      if (!canvas) return;
      const width = canvas.clientWidth || 300;
      const height = canvas.clientHeight || props.height;
      // The drawing area was wide; fit it into the field at its own aspect.
      const aspect = sheetSize.value.width / Math.max(1, sheetSize.value.height);
      let w = width;
      let h = width / aspect;
      if (h > height) { h = height; w = height * aspect; }
      const ctx = paint(canvas, [], width, height);
      const inner = document.createElement('canvas');
      paint(inner, strokes.value, w, h, { pen: Math.max(1.4, PEN * (w / sheetSize.value.width) * 1.6) });
      ctx.drawImage(inner, (width - w) / 2, (height - h) / 2, w, h);
    };

    // --- The full-screen sheet ---
    const open = ref(false);
    const pad = ref(null);
    const stage = ref(null);
    // Turned when the screen is taller than wide: the long side is the width.
    const rotated = ref(false);
    const sheetSize = ref({ width: 900, height: 400 });

    const layout = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      rotated.value = vh > vw;
      const long = Math.max(vw, vh);
      const short = Math.min(vw, vh);
      // A phone or tablet: the whole screen. A desktop: a large box, not a
      // wall of white — signing with a mouse across 2,500 px helps nobody.
      const big = long > 1100 && short > 700;
      const width = big ? Math.min(1000, long - 96) : long;
      const height = big ? Math.min(460, short - 160) : short;
      sheetSize.value = { width, height };
    };

    // The drawing area inside the sheet, below its bar, in sheet units.
    const BAR = 52;
    const areaSize = computed(() => ({
      width: sheetSize.value.width,
      height: Math.max(120, sheetSize.value.height - BAR),
    }));

    const redraw = () => {
      if (pad.value) paint(pad.value, strokes.value, areaSize.value.width, areaSize.value.height);
    };

    const onResize = () => {
      layout();
      nextTick(() => { redraw(); renderPreview(); });
    };

    const openSheet = async () => {
      if (props.busy) return;
      layout();
      open.value = true;
      lockScroll();
      await nextTick();
      redraw();
    };

    const closeSheet = () => {
      if (!open.value) return;
      open.value = false;
      unlockScroll();
      nextTick(renderPreview);
    };

    const clear = () => {
      strokes.value = [];
      redraw();
      nextTick(renderPreview);
    };

    // Screen point → drawing-area point in 0..1. When the sheet is turned by
    // 90° clockwise, the area's x runs down the screen and its y runs from
    // right to left, so the two are read off the rotated box accordingly.
    const at = (event) => {
      const box = pad.value.getBoundingClientRect();
      const { width, height } = areaSize.value;
      const x = rotated.value ? event.clientY - box.top : event.clientX - box.left;
      const y = rotated.value ? box.right - event.clientX : event.clientY - box.top;
      return { x: Math.min(1, Math.max(0, x / width)), y: Math.min(1, Math.max(0, y / height)) };
    };

    let drawing = false;
    let ctx = null;
    let current = null;

    const down = (event) => {
      event.preventDefault();
      drawing = true;
      current = [at(event)];
      strokes.value.push(current);
      ctx = pad.value.getContext('2d');
      const { width, height } = areaSize.value;
      const p = current[0];
      ctx.beginPath();
      ctx.moveTo(p.x * width, p.y * height);
      ctx.lineTo(p.x * width + 0.1, p.y * height);
      ctx.stroke();
      // Capture keeps the stroke alive when the pen leaves the box, and it is
      // the last thing done here on purpose: a browser that refuses it must
      // not cost the customer the signature itself.
      try { pad.value.setPointerCapture(event.pointerId); } catch { /* fine without */ }
    };

    const move = (event) => {
      if (!drawing) return;
      event.preventDefault();
      const point = at(event);
      const prev = current[current.length - 1];
      current.push(point);
      const { width, height } = areaSize.value;
      ctx.beginPath();
      ctx.moveTo(prev.x * width, prev.y * height);
      ctx.lineTo(point.x * width, point.y * height);
      ctx.stroke();
    };

    const up = (event) => {
      if (!drawing) return;
      drawing = false;
      current = null;
      // Vue sees the pushed points now, not on every pointermove.
      strokes.value = [...strokes.value];
      try {
        if (event?.pointerId !== undefined && pad.value?.hasPointerCapture(event.pointerId)) {
          pad.value.releasePointerCapture(event.pointerId);
        }
      } catch { /* nothing was captured; nothing to release */ }
    };

    const onKey = (event) => { if (open.value && event.key === 'Escape') closeSheet(); };

    /**
     * The drawing as a PNG, cropped to the ink, handed up.
     *
     * Rendered fresh from the points, landscape, at the drawing area's size —
     * whichever way the phone was held. Cropped because everything downstream
     * scales it to fit: storing the whole pad would print the signature small.
     */
    const submit = () => {
      if (!drawn.value || props.busy || props.locked) return;
      const box = inkBox(strokes.value);
      if (!box) return;
      const { width, height } = areaSize.value;
      const full = document.createElement('canvas');
      paint(full, strokes.value, width, height);
      const ratio = window.devicePixelRatio || 1;
      const pad2 = 8;
      const left = Math.max(0, Math.floor((box.minX * width - pad2) * ratio));
      const top = Math.max(0, Math.floor((box.minY * height - pad2) * ratio));
      const right = Math.min(full.width, Math.ceil((box.maxX * width + pad2) * ratio));
      const bottom = Math.min(full.height, Math.ceil((box.maxY * height + pad2) * ratio));
      const w = Math.max(1, right - left);
      const h = Math.max(1, bottom - top);
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const outCtx = out.getContext('2d');
      outCtx.fillStyle = '#ffffff';
      outCtx.fillRect(0, 0, w, h);
      outCtx.drawImage(full, left, top, w, h, 0, 0, w, h);
      out.toBlob((blob) => { if (blob) emit('submit', blob); }, 'image/png');
    };

    // The sheet's box on screen. Turned, it is laid out landscape and rotated
    // about its centre, so it sits centred on the upright screen.
    const stageStyle = computed(() => ({
      width: `${sheetSize.value.width}px`,
      height: `${sheetSize.value.height}px`,
      transform: `translate(-50%, -50%)${rotated.value ? ' rotate(90deg)' : ''}`,
    }));

    watch(strokes, () => nextTick(renderPreview));

    onMounted(() => {
      layout();
      renderPreview();
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);
      document.addEventListener('keydown', onKey);
    });
    onBeforeUnmount(() => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      document.removeEventListener('keydown', onKey);
      if (open.value) unlockScroll();
    });

    return {
      preview, pad, stage, open, rotated, drawn, areaSize, stageStyle,
      openSheet, closeSheet, clear, down, move, up, submit, emit,
    };
  },
  template: `
    <div>
      <button type="button" class="trax-sig-field" :style="{ height: height + 'px' }"
              :disabled="busy" @click="openSheet"
              :aria-label="drawn ? 'Signature — tap to change' : 'Tap to sign'">
        <canvas ref="preview" class="trax-sig-preview" aria-hidden="true"></canvas>
        <span v-if="!drawn" class="trax-sig-hint">
          <i class="bi bi-pen"></i> Tap to sign
        </span>
        <span v-else class="trax-sig-edit"><i class="bi bi-pencil"></i></span>
      </button>

      <div v-if="drawn && locked" class="small text-warning mt-2">
        <i class="bi bi-exclamation-circle"></i> {{ locked }}
      </div>
      <div class="d-flex align-items-center gap-2 mt-2">
        <button type="button" class="btn btn-sm btn-outline-secondary"
                :disabled="busy || !drawn" @click="clear">Clear</button>
        <span class="flex-grow-1"></span>
        <button type="button" class="btn btn-sm btn-outline-secondary"
                :disabled="busy" @click="emit('cancel')">{{ cancelLabel }}</button>
        <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !drawn || !!locked"
                @click="submit">
          <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
          {{ submitLabel }}
        </button>
      </div>

      <Teleport to="body">
        <div v-if="open" class="trax-sig-overlay" role="dialog" aria-modal="true" aria-label="Sign">
          <div ref="stage" class="trax-sig-stage" :class="{ 'is-rotated': rotated }" :style="stageStyle">
            <div class="trax-sig-bar">
              <button type="button" class="btn btn-sm btn-outline-secondary" :disabled="!drawn" @click="clear">
                <i class="bi bi-eraser"></i> Clear
              </button>
              <span class="trax-sig-title">Sign here</span>
              <button type="button" class="btn btn-sm btn-primary" @click="closeSheet">Done</button>
            </div>
            <div class="trax-sig-area" :style="{ height: areaSize.height + 'px' }">
              <canvas ref="pad" class="trax-sig-canvas"
                      :style="{ width: areaSize.width + 'px', height: areaSize.height + 'px' }"
                      aria-label="Signature pad"
                      @pointerdown="down" @pointermove="move"
                      @pointerup="up" @pointercancel="up"></canvas>
              <div class="trax-sig-line" aria-hidden="true"><span>×</span></div>
            </div>
          </div>
        </div>
      </Teleport>
    </div>
  `,
};
