import { computed } from 'vue';
import { statusLabel } from '../../lib/format.js';

/**
 * Status pill.
 *
 * PARTIAL is no longer a kit-only status: an item with some of its units out
 * is PARTIAL too, so the pill takes the kind to pick the right wording, and an
 * optional `detail` for the counts ("5 of 8 free").
 *
 * `label` overrides the wording only. The colour still follows `status`, so a
 * unit pill can say "Out of service" and stay the LOCK grey.
 */
export default {
  name: 'StatusBadge',
  props: {
    status: { type: String, required: true },
    title: { type: String, default: '' },
    kind: { type: String, default: '' },
    detail: { type: String, default: '' },
    label: { type: String, default: '' },
  },
  setup(props) {
    const text = computed(() => props.label || statusLabel(props.status, props.kind));
    return { text };
  },
  template: `
    <span class="trax-badge" :class="'status-' + status" :title="title || text">
      <span class="trax-badge-dot"></span>{{ text }}<span v-if="detail && status !== 'LOCK'"> · {{ detail }}</span>
    </span>
  `,
};
