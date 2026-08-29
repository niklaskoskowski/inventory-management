import { onMounted, onBeforeUnmount, ref } from 'vue';

/** Replaces the blocking confirm() calls the old code used before destructive actions. */
export default {
  name: 'ConfirmDialog',
  props: {
    title: { type: String, default: 'Are you sure?' },
    message: { type: String, default: '' },
    confirmLabel: { type: String, default: 'Confirm' },
    danger: { type: Boolean, default: false },
  },
  emits: ['confirm', 'cancel'],
  setup(_, { emit }) {
    const box = ref(null);

    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        emit('cancel');
      }
    };

    onMounted(() => {
      document.addEventListener('keydown', onKeydown, true);
      box.value?.querySelector('[data-autofocus]')?.focus();
    });

    onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true));

    return { box };
  },
  template: `
    <div class="trax-drawer-backdrop" @click="$emit('cancel')"></div>
    <div class="position-fixed top-50 start-50 translate-middle trax-card"
         style="z-index:1060; width:min(420px, calc(100vw - 2rem));"
         role="alertdialog" aria-modal="true" ref="box">
      <div class="trax-card-pad">
        <h3 class="trax-page-title mb-2">{{ title }}</h3>
        <p class="mb-0 small text-secondary" v-if="message">{{ message }}</p>
        <slot></slot>
      </div>
      <div class="trax-drawer-footer justify-content-end">
        <button type="button" class="btn btn-sm btn-outline-secondary" @click="$emit('cancel')">Cancel</button>
        <button type="button" data-autofocus
                class="btn btn-sm" :class="danger ? 'btn-danger' : 'btn-primary'"
                @click="$emit('confirm')">{{ confirmLabel }}</button>
      </div>
    </div>
  `,
};
