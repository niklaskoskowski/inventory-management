import { onMounted, onBeforeUnmount, ref } from 'vue';

/** Replaces the blocking confirm() calls the old code used before destructive actions. */
export default {
  name: 'ConfirmDialog',
  props: {
    title: { type: String, default: 'Are you sure?' },
    message: { type: String, default: '' },
    confirmLabel: { type: String, default: 'Confirm' },
    cancelLabel: { type: String, default: 'Cancel' },
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
  // An iOS-style alert: centred title and message, slot content (forms,
  // lists) left-aligned below, two full-width buttons side by side.
  template: `
    <div class="trax-alert-backdrop" @click="$emit('cancel')"></div>
    <div class="trax-alert" role="alertdialog" aria-modal="true"
         aria-labelledby="trax-alert-title" ref="box">
      <div class="trax-alert-body">
        <h3 id="trax-alert-title" class="trax-alert-title">{{ title }}</h3>
        <p v-if="message" class="trax-alert-message">{{ message }}</p>
        <div v-if="$slots.default" class="trax-alert-slot"><slot></slot></div>
      </div>
      <div class="trax-alert-actions">
        <button type="button" class="trax-alert-btn" @click="$emit('cancel')">{{ cancelLabel }}</button>
        <button type="button" data-autofocus
                class="trax-alert-btn is-primary" :class="{ 'is-danger': danger }"
                @click="$emit('confirm')">{{ confirmLabel }}</button>
      </div>
    </div>
  `,
};
