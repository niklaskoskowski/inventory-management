import { computed } from 'vue';
import { statusLabel } from '../../lib/format.js';

/**
 * Status pill.
 *
 * PARTIAL is no longer a kit-only status: an item with some of its units out
 * is PARTIAL too, so the pill takes the kind to pick the right wording, and an
 * optional `detail` for the counts ("5 of 8 free").
 */
export default {
  name: 'StatusBadge',
  props: {
    status: { type: String, required: true },
    title: { type: String, default: '' },
    kind: { type: String, default: '' },
    detail: { type: String, default: '' },
  },
  setup(props) {
    const label = computed(() => statusLabel(props.status, props.kind));
    return { label };
  },
  template: `
    <span class="trax-badge" :class="'status-' + status" :title="title || label">
      <span class="trax-badge-dot"></span>{{ label }}<span v-if="detail"> · {{ detail }}</span>
    </span>
  `,
};
