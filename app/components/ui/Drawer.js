import { onMounted, onBeforeUnmount, ref, nextTick } from 'vue';
import { lockScroll, unlockScroll } from '../../lib/scroll-lock.js';

/**
 * Side panel used for asset detail, kit editing, checkout and scanning.
 *
 * Replaces the Bootstrap modal lifecycle the old code drove through jQuery
 * `shown.bs.modal` / `hidden.bs.modal` events. Handles Escape, focus capture
 * and background scroll locking.
 */
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
    const previouslyFocused = ref(null);

    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        emit('close');
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

    onMounted(async () => {
      previouslyFocused.value = document.activeElement;
      document.addEventListener('keydown', onKeydown, true);
      lockScroll();
      await nextTick();
      const target = panel.value?.querySelector('[data-autofocus]')
        || panel.value?.querySelector('input, select, textarea, button');
      target?.focus();
    });

    onBeforeUnmount(() => {
      document.removeEventListener('keydown', onKeydown, true);
      unlockScroll();
      previouslyFocused.value?.focus?.();
    });

    return { panel };
  },
  template: `
    <div class="trax-drawer-backdrop" @click="$emit('close')"></div>
    <aside ref="panel" class="trax-drawer" :class="{ 'trax-drawer-wide': wide }"
           role="dialog" aria-modal="true" :aria-label="title">
      <header class="trax-drawer-header">
        <i v-if="icon" class="bi" :class="icon"></i>
        <h2 class="trax-page-title flex-grow-1">{{ title }}</h2>
        <slot name="header-actions"></slot>
        <button type="button" class="btn-close btn-close-white"
                aria-label="Close" @click="$emit('close')"></button>
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
