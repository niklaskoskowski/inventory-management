import { onMounted, onBeforeUnmount, ref, nextTick } from 'vue';
import { lockScroll, unlockScroll } from '../../lib/scroll-lock.js';

/**
 * Side panel used for asset detail, kit editing, checkout and scanning.
 *
 * Desktop: a floating inspector on the right. Phone: a sheet from the bottom,
 * dragged down by its header to dismiss — it follows the finger 1:1 and a
 * flick carries it away. Handles Escape, focus capture and background scroll
 * locking. Closing from the panel itself (×, backdrop, Escape, swipe) plays
 * the way out before `close` is emitted.
 */

const PHONE = '(max-width: 991.98px)';
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Where a flick would come to rest (Apple's projection, d = 0.998). */
const project = (velocity, rate = 0.998) => ((velocity / 1000) * rate) / (1 - rate);

export default {
  name: 'Drawer',
  props: {
    title: { type: String, default: '' },
    icon: { type: String, default: '' },
    wide: { type: Boolean, default: false },
  },
  emits: ['close'],
  setup(props, { emit }) {
    const panel = ref(null);
    const leaving = ref(false);
    const previouslyFocused = ref(null);

    const requestClose = () => {
      if (leaving.value) return;
      if (reducedMotion()) {
        emit('close');
        return;
      }
      leaving.value = true;
      setTimeout(() => emit('close'), 220);
    };

    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        // An open menu or alert on top takes the Escape for itself.
        if (document.querySelector('.trax-menu-list, [role="alertdialog"]')) return;
        event.stopPropagation();
        requestClose();
        return;
      }

      // Keep Tab inside the panel while it is open.
      if (event.key === 'Tab' && panel.value) {
        const focusable = panel.value.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    // --- Swipe down to dismiss (phone sheet only) ---------------------------
    let drag = null;

    const onPointerDown = (event) => {
      if (!window.matchMedia(PHONE).matches || event.button > 0) return;
      if (event.target.closest('button, a, input, select, textarea')) return;
      drag = { id: event.pointerId, y0: event.clientY, dy: 0, history: [], active: false };
    };

    const onPointerMove = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dy = event.clientY - drag.y0;
      if (!drag.active) {
        if (Math.abs(dy) < 8) return; // a tap is not a drag
        drag.active = true;
        panel.value.setPointerCapture?.(event.pointerId);
        panel.value.style.transition = 'none';
      }
      // Upwards it resists, the way an edge does.
      drag.dy = dy >= 0 ? dy : -Math.sqrt(-dy) * 2;
      drag.history.push({ y: event.clientY, t: event.timeStamp });
      if (drag.history.length > 6) drag.history.shift();
      panel.value.style.transform = `translateY(${drag.dy}px)`;
    };

    const onPointerUp = () => {
      if (!drag) return;
      const { active, dy, history } = drag;
      drag = null;
      if (!active || !panel.value) return;
      const first = history[0];
      const last = history[history.length - 1];
      const velocity = first && last && last.t > first.t ? ((last.y - first.y) / (last.t - first.t)) * 1000 : 0;
      const height = panel.value.offsetHeight;
      const resting = dy + project(velocity);
      panel.value.style.transition = '';
      if (resting > height * 0.4) {
        panel.value.style.transform = 'translateY(100%)';
        setTimeout(() => emit('close'), 240);
      } else {
        panel.value.style.transform = '';
      }
    };

    onMounted(async () => {
      previouslyFocused.value = document.activeElement;
      document.addEventListener('keydown', onKeydown, true);
      lockScroll();
      await nextTick();
      // On a phone a focused field pops the keyboard over half the sheet, so
      // only an explicit data-autofocus is honoured there.
      // data-autofocus="desktop" asks for focus only where no keyboard pops up.
      const phone = window.matchMedia(PHONE).matches;
      const target = panel.value?.querySelector('[data-autofocus]:not([data-autofocus="desktop"])')
        || (phone ? null : panel.value?.querySelector('[data-autofocus="desktop"]'))
        || (phone ? null : panel.value?.querySelector('input, select, textarea'))
        || panel.value?.querySelector('.trax-close');
      target?.focus({ preventScroll: true });
    });

    onBeforeUnmount(() => {
      document.removeEventListener('keydown', onKeydown, true);
      unlockScroll();
      previouslyFocused.value?.focus?.({ preventScroll: true });
    });

    return { panel, leaving, requestClose, onPointerDown, onPointerMove, onPointerUp };
  },
  template: `
    <div class="trax-drawer-backdrop" :class="{ 'is-leaving': leaving }" @click="requestClose"></div>
    <aside ref="panel" class="trax-drawer" :class="{ 'trax-drawer-wide': wide, 'is-leaving': leaving }"
           role="dialog" aria-modal="true" :aria-label="title">
      <header class="trax-drawer-header"
              @pointerdown="onPointerDown" @pointermove="onPointerMove"
              @pointerup="onPointerUp" @pointercancel="onPointerUp">
        <span class="trax-grabber" aria-hidden="true"></span>
        <i v-if="icon" class="bi trax-drawer-icon" :class="icon"></i>
        <h2 class="trax-drawer-title flex-grow-1">{{ title }}</h2>
        <slot name="header-actions"></slot>
        <button type="button" class="trax-close" aria-label="Close" @click="requestClose">
          <i class="bi bi-x-lg"></i>
        </button>
      </header>

      <div class="trax-drawer-body">
        <slot></slot>
      </div>

      <footer v-if="$slots.footer" class="trax-drawer-footer">
        <slot name="footer"></slot>
      </footer>
    </aside>
  `,
};
