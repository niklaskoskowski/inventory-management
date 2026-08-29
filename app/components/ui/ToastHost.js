import { state, dismissToast } from '../../store.js';

/** Replaces the ~20 blocking alert() calls the old admin used for feedback. */
export default {
  name: 'ToastHost',
  setup() {
    const icon = (kind) => ({
      success: 'bi-check-circle-fill',
      danger: 'bi-exclamation-octagon-fill',
      warning: 'bi-exclamation-triangle-fill',
      info: 'bi-info-circle-fill',
    }[kind] || 'bi-info-circle-fill');

    return { state, dismissToast, icon };
  },
  template: `
    <div class="trax-toasts" role="status" aria-live="polite">
      <div v-for="t in state.toasts" :key="t.id" class="trax-toast" :class="'kind-' + t.kind">
        <i class="bi" :class="icon(t.kind)"></i>
        <span class="flex-grow-1">{{ t.message }}</span>
        <button type="button" class="btn-close btn-close-white btn-sm"
                aria-label="Dismiss" @click="dismissToast(t.id)"></button>
      </div>
    </div>
  `,
};
