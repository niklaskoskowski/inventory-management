import { ref, onMounted, onBeforeUnmount } from 'vue';

/**
 * A signature pad, for the counter.
 *
 * Pointer events, so a finger on a tablet, a stylus and a mouse are one code
 * path. The canvas is backed at device resolution and drawn on in CSS pixels,
 * or a signature taken on a phone arrives as a staircase.
 *
 * It draws **dark ink on white**, not on transparency, because that is what
 * the bitmap is stored and printed on: the same picture travels from the
 * tablet to the customer's booking page to the PDF without a single inversion
 * along the way. The twin of this pad lives inline in booking.php, where the
 * customer signs on their own phone — same rules, no build step to share it.
 *
 * Hands back a PNG Blob through `submit`; the parent decides what to do with
 * it. Deliberately knows nothing about bookings.
 */
export default {
  name: 'SignaturePad',
  props: {
    height: { type: Number, default: 180 },
    busy: { type: Boolean, default: false },
  },
  emits: ['submit', 'cancel'],
  setup(props, { emit }) {
    const pad = ref(null);
    const drawn = ref(false);

    let ctx = null;
    let drawing = false;
    let last = null;
    // The box the ink actually occupies, in CSS pixels. Tracked while drawing
    // so what gets stored is the SIGNATURE and not the empty pad around it: on
    // the PDF the drawing is fitted into 78 mm, and a name written across a
    // third of a wide canvas would print at a third of the size it should.
    let ink = null;

    const reset = () => {
      const canvas = pad.value;
      if (!canvas) return;
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 300;
      const height = canvas.clientHeight || props.height;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      drawn.value = false;
      ink = null;
    };

    /** Grows the ink box to include one point, plus the pen's own width. */
    const mark = (point) => {
      const pad2 = 6;
      if (!ink) {
        ink = {
          minX: point.x - pad2, maxX: point.x + pad2,
          minY: point.y - pad2, maxY: point.y + pad2,
        };
        return;
      }
      ink.minX = Math.min(ink.minX, point.x - pad2);
      ink.maxX = Math.max(ink.maxX, point.x + pad2);
      ink.minY = Math.min(ink.minY, point.y - pad2);
      ink.maxY = Math.max(ink.maxY, point.y + pad2);
    };

    const at = (event) => {
      const box = pad.value.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };

    const down = (event) => {
      event.preventDefault();
      drawing = true;
      last = at(event);
      // A tap that never moves is still a mark, so it lands as a dot.
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(last.x + 0.1, last.y);
      ctx.stroke();
      mark(last);
      drawn.value = true;

      // Capture is a nicety — it keeps the stroke alive when the pen leaves
      // the box — and it is the last thing done here on purpose: a browser
      // that refuses it must not cost the operator the signature itself.
      try {
        pad.value.setPointerCapture(event.pointerId);
      } catch { /* drawing works without it */ }
    };

    const move = (event) => {
      if (!drawing) return;
      event.preventDefault();
      const point = at(event);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      mark(point);
      last = point;
    };

    const up = (event) => {
      if (!drawing) return;
      drawing = false;
      try {
        if (event?.pointerId !== undefined && pad.value?.hasPointerCapture(event.pointerId)) {
          pad.value.releasePointerCapture(event.pointerId);
        }
      } catch { /* nothing was captured; nothing to release */ }
    };

    /**
     * The drawing as a PNG, cropped to the ink, handed up.
     *
     * Cropped because everything downstream scales it to fit: the card, the
     * customer's page and the 78 mm it gets on the PDF. Storing the whole pad
     * would mean storing mostly white and printing the signature small.
     */
    const submit = () => {
      if (!drawn.value || props.busy || !ink) return;

      const canvas = pad.value;
      const ratio = window.devicePixelRatio || 1;
      // Clamped to the pad: the pen's width can push the box past the edge.
      const left = Math.max(0, Math.floor(ink.minX * ratio));
      const top = Math.max(0, Math.floor(ink.minY * ratio));
      const right = Math.min(canvas.width, Math.ceil(ink.maxX * ratio));
      const bottom = Math.min(canvas.height, Math.ceil(ink.maxY * ratio));
      const width = Math.max(1, right - left);
      const height = Math.max(1, bottom - top);

      const out = document.createElement('canvas');
      out.width = width;
      out.height = height;
      const outCtx = out.getContext('2d');
      // White first: the crop is opaque, like the pad, so nothing downstream
      // has to know what a transparent signature would look like.
      outCtx.fillStyle = '#ffffff';
      outCtx.fillRect(0, 0, width, height);
      outCtx.drawImage(canvas, left, top, width, height, 0, 0, width, height);

      out.toBlob((blob) => {
        if (blob) emit('submit', blob);
      }, 'image/png');
    };

    // Resizing rebuilds the bitmap at the new size; keeping a stretched
    // drawing would be worse than asking for it again.
    onMounted(() => { reset(); window.addEventListener('resize', reset); });
    onBeforeUnmount(() => window.removeEventListener('resize', reset));

    return { pad, drawn, reset, down, move, up, submit, emit };
  },
  template: `
    <div>
      <canvas ref="pad" class="trax-sig-pad" :style="{ height: height + 'px' }"
              aria-label="Signature pad"
              @pointerdown="down" @pointermove="move"
              @pointerup="up" @pointercancel="up" @pointerleave="up"></canvas>

      <div class="d-flex align-items-center gap-2 mt-2">
        <button type="button" class="btn btn-sm btn-outline-secondary"
                :disabled="busy || !drawn" @click="reset">Clear</button>
        <span class="small text-secondary flex-grow-1">
          {{ drawn ? 'Ready to save.' : 'Sign in the box above.' }}
        </span>
        <button type="button" class="btn btn-sm btn-outline-secondary"
                :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !drawn"
                @click="submit">
          <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
          Save signature
        </button>
      </div>
    </div>
  `,
};
