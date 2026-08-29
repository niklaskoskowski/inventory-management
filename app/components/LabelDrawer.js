import { computed } from 'vue';
import { state, getAsset } from '../store.js';
import Drawer from './ui/Drawer.js';

/** Preview and download the two server-rendered label formats. */
export default {
  name: 'LabelDrawer',
  components: { Drawer },
  props: {
    assetId: { type: Number, required: true },
  },
  emits: ['close'],
  setup(props, { emit }) {
    const asset = computed(() => getAsset(props.assetId));
    const appName = computed(() => state.settings?.branding?.appName || 'Assets');

    // Note the plain `?` — the old code built "label.php/?id=" with a stray
    // slash, which only worked because of how that host rewrites PATH_INFO.
    const portrait = computed(() => `label.php?id=${props.assetId}`);
    const wide = computed(() => `label-w.php?id=${props.assetId}`);

    const printLabel = (url) => {
      const frame = document.createElement('iframe');
      frame.style.position = 'fixed';
      frame.style.right = '100%';
      frame.style.bottom = '100%';
      frame.onload = () => {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        setTimeout(() => frame.remove(), 1000);
      };
      frame.src = url;
      document.body.appendChild(frame);
    };

    return { asset, appName, portrait, wide, printLabel, emit };
  },
  template: `
    <Drawer :title="'Label · ' + (asset?.name || '')" icon="bi-printer" @close="emit('close')">
      <p class="small text-secondary">
        The QR code points at this asset's public page, so scanning it works from
        any phone camera — not just from inside {{ appName }}.
      </p>

      <div class="row g-3">
        <div class="col-6">
          <div class="trax-card p-2 text-center">
            <div class="small text-secondary mb-2">Portrait · 14 × 30 mm</div>
            <img :src="portrait" alt="Portrait label preview"
                 class="img-fluid bg-white rounded" style="max-height:280px">
            <div class="d-grid gap-1 mt-2">
              <a class="btn btn-sm btn-outline-secondary" :href="portrait" download>
                <i class="bi bi-download"></i> Download
              </a>
              <button class="btn btn-sm btn-outline-secondary" @click="printLabel(portrait)">
                <i class="bi bi-printer"></i> Print
              </button>
            </div>
          </div>
        </div>

        <div class="col-6">
          <div class="trax-card p-2 text-center">
            <div class="small text-secondary mb-2">Wide · 30 × 14 mm</div>
            <img :src="wide" alt="Wide label preview"
                 class="img-fluid bg-white rounded" style="max-height:280px">
            <div class="d-grid gap-1 mt-2">
              <a class="btn btn-sm btn-outline-secondary" :href="wide" download>
                <i class="bi bi-download"></i> Download
              </a>
              <button class="btn btn-sm btn-outline-secondary" @click="printLabel(wide)">
                <i class="bi bi-printer"></i> Print
              </button>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <span class="flex-grow-1 small text-secondary font-monospace">ID {{ assetId }}</span>
        <button class="btn btn-sm btn-outline-secondary" @click="emit('close')">Close</button>
      </template>
    </Drawer>
  `,
};
