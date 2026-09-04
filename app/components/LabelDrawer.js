import { computed, ref, watch } from 'vue';
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

    // The physical units of this asset, if it keeps any. An ITEM that does not
    // is the ordinary case and gets exactly the drawer it always had.
    const units = computed(() => asset.value?.units || []);
    const hasUnits = computed(() => units.value.length > 0);

    // '' is the product label; otherwise the unit number as a string, because
    // that is what a <select> value is.
    const selected = ref('');
    watch(() => props.assetId, () => { selected.value = ''; });
    watch(hasUnits, (has) => { if (!has) selected.value = ''; });

    const unitNo = computed(() => (selected.value ? Number(selected.value) : null));
    const suffix = computed(() => (unitNo.value ? `&u=${unitNo.value}` : ''));
    const code = computed(() => (unitNo.value ? `${props.assetId}.${unitNo.value}` : String(props.assetId)));

    const unitOption = (unit) => {
      const label = unit.label ? ` · ${unit.label}` : '';
      const oos = unit.outOfService ? ' (out of service)' : '';
      return `${props.assetId}.${unit.no}${label}${oos}`;
    };

    // Note the plain `?` — the old code built "label.php/?id=" with a stray
    // slash, which only worked because of how that host rewrites PATH_INFO.
    const portrait = computed(() => `label.php?id=${props.assetId}${suffix.value}`);
    const wide = computed(() => `label-w.php?id=${props.assetId}${suffix.value}`);

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

    /**
     * One print job for the whole shelf: every unit's portrait label, one per
     * page. Same hidden-iframe trick as printLabel(), except the document is
     * written by us and the print waits for all the images to decode — an
     * iframe fires load before its <img> children are painted.
     */
    const printAllUnits = () => {
      if (!hasUnits.value) return;

      const blocks = units.value.map((unit) => `
        <div class="sheet"><img src="label.php?id=${props.assetId}&u=${unit.no}" alt=""></div>
      `).join('');

      const frame = document.createElement('iframe');
      frame.style.position = 'fixed';
      frame.style.right = '100%';
      frame.style.bottom = '100%';
      document.body.appendChild(frame);

      // No frame.onload here: an about:blank iframe fires load once on insert
      // and again on document.close(), which printed the job twice.
      const doc = frame.contentDocument;
      if (!doc) { frame.remove(); return; }
      doc.open();
      doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Labels</title>
        <style>
          body { margin: 0; }
          .sheet { page-break-after: always; break-after: page; text-align: center; }
          .sheet:last-child { page-break-after: auto; break-after: auto; }
          img { max-width: 100%; }
        </style></head><body>${blocks}</body></html>`);
      doc.close();

      const images = Array.from(doc.images);
      Promise.all(images.map((img) => (img.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        })))).then(() => {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        setTimeout(() => frame.remove(), 1000);
      });
    };

    return {
      asset, appName, units, hasUnits, selected, code, unitOption,
      portrait, wide, printLabel, printAllUnits, emit,
    };
  },
  template: `
    <Drawer :title="'Label · ' + (asset?.name || '')" icon="bi-printer" @close="emit('close')">
      <p class="small text-secondary">
        The QR code points at this asset's public page, so scanning it works from
        any phone camera — not just from inside {{ appName }}.
      </p>

      <template v-if="hasUnits">
        <label class="form-label small text-secondary mb-1">Label for</label>
        <select class="form-select form-select-sm mb-2" v-model="selected">
          <option value="">Product label (ID {{ assetId }})</option>
          <option v-for="unit in units" :key="unit.no" :value="String(unit.no)">
            {{ unitOption(unit) }}
          </option>
        </select>
        <p class="small text-secondary">
          Each unit gets its own QR label; scanning it selects that exact unit.
        </p>
      </template>

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

      <div v-if="hasUnits" class="d-grid mt-3">
        <button class="btn btn-sm btn-outline-secondary" @click="printAllUnits">
          <i class="bi bi-printer"></i> Print all unit labels
        </button>
      </div>

      <template #footer>
        <span class="flex-grow-1 small text-secondary font-monospace">ID {{ code }}</span>
        <button class="btn btn-sm btn-outline-secondary" @click="emit('close')">Close</button>
      </template>
    </Drawer>
  `,
};
