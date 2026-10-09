import { ref, onBeforeUnmount, nextTick } from 'vue';

/**
 * A small pop-up menu: a trigger button, and a list that grows out of it.
 * Closes on a pick, an outside tap or Escape. Items are plain buttons in the
 * default slot (class "trax-menu-item"); `align` puts the list under the
 * trigger's left or right edge, `up` opens it above (for footers and bars).
 */
export default {
  name: 'Menu',
  props: {
    label: { type: String, default: 'More' },
    icon: { type: String, default: 'bi-three-dots' },
    text: { type: String, default: '' },
    align: { type: String, default: 'end' },
    up: { type: Boolean, default: false },
    buttonClass: { type: String, default: 'btn btn-sm btn-outline-secondary' },
  },
  setup() {
    const open = ref(false);
    const root = ref(null);

    const onDocument = (event) => {
      if (event.type === 'keydown') {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
        return;
      }
      if (root.value && !root.value.contains(event.target)) close();
    };

    function close() {
      open.value = false;
      document.removeEventListener('pointerdown', onDocument, true);
      document.removeEventListener('keydown', onDocument, true);
    }

    const toggle = async () => {
      if (open.value) return close();
      open.value = true;
      await nextTick();
      document.addEventListener('pointerdown', onDocument, true);
      document.addEventListener('keydown', onDocument, true);
      root.value?.querySelector('.trax-menu-item')?.focus();
    };

    // A pick closes the menu; the item's own @click still runs.
    const onPick = (event) => {
      if (event.target.closest('.trax-menu-item')) close();
    };

    onBeforeUnmount(close);

    return { open, root, toggle, onPick };
  },
  template: `
    <div class="trax-menu" ref="root">
      <button type="button" :class="buttonClass" :aria-label="label" :title="label"
              aria-haspopup="menu" :aria-expanded="open ? 'true' : 'false'" @click="toggle">
        <i v-if="icon" class="bi" :class="icon"></i><span v-if="text" :class="{ 'ms-1': icon }">{{ text }}</span>
      </button>
      <div v-if="open" class="trax-menu-list" role="menu"
           :class="['align-' + align, { 'is-up': up }]" @click="onPick">
        <slot></slot>
      </div>
    </div>
  `,
};
