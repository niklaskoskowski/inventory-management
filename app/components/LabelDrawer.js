import { computed, ref, watch } from 'vue';
import { state, getAsset, toast, markLabeled } from '../store.js';
import { labelCode, labelFiles, downloadLabelZip } from '../lib/labels.js';
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
    const code = computed(() => labelCode(props.assetId, unitNo.value));

    const unitOption = (unit) => {
      const label = unit.label ? ` · ${unit.label}` : '';
      const oos = unit.outOfService ? ' (out of service)' : '';
      return `${props.assetId}.${unit.no}${label}${oos}`;
    };

    // URL and download name of each format, ID at the end of the name:
    // `label-12.png`, `label-wide-12.1.png`.
    const files = computed(() => labelFiles(props.assetId, unitNo.value));
    const portrait = computed(() => files.value[0].url);
    const wide = computed(() => files.value[1].url);
    const cable = computed(() => files.value[2].url);
    const portraitName = computed(() => files.value[0].name);
    const wideName = computed(() => files.value[1].name);
    const cableName = computed(() => files.value[2].name);

    /** The cable flag's blank middle, from Settings → Labels. */
    const cableGapMm = computed(() => Number(state.settings?.labels?.cableGapMm) || 30);

    /** Whether the label picked above — the asset's or a unit's — is on the gear. */
    const labeled = computed(() => {
      if (!asset.value) return false;
      if (unitNo.value === null) return Boolean(asset.value.labeled);
      return Boolean(units.value.find((unit) => unit.no === unitNo.value)?.labeled);
    });
    const labeledBusy = ref(false);
    const toggleLabeled = async () => {
      labeledBusy.value = true;
      try {
        await markLabeled(props.assetId, unitNo.value, !labeled.value);
      } catch {
        /* toast already raised by the store */
      } finally {
        labeledBusy.value = false;
      }
    };

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

    /**
     * The same shelf as printAllUnits(), but as files: both label formats of
     * every unit, packed into one ZIP.
     */
    const downloadingAll = ref(false);
    const downloadAllUnits = async () => {
      if (!hasUnits.value || downloadingAll.value) return;
      downloadingAll.value = true;
      try {
        const wanted = units.value.flatMap((unit) => labelFiles(props.assetId, unit.no));
        await downloadLabelZip(wanted, `labels-${props.assetId}.zip`);
      } catch (error) {
        toast(`Could not build the label archive: ${error.message}`, 'danger', 8000);
      } finally {
        downloadingAll.value = false;
      }
    };

    return {
      asset, appName, units, hasUnits, selected, code, unitOption,
      portrait, wide, cable, portraitName, wideName, cableName, printLabel,
      labeled, labeledBusy, toggleLabeled, cableGapMm, printAllUnits, downloadingAll,
      downloadAllUnits, emit,
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
              <a class="btn btn-sm btn-outline-secondary" :href="portrait" :download="portraitName">
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
              <a class="btn btn-sm btn-outline-secondary" :href="wide" :download="wideName">
                <i class="bi bi-download"></i> Download
              </a>
              <button class="btn btn-sm btn-outline-secondary" @click="printLabel(wide)">
                <i class="bi bi-printer"></i> Print
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="col-12 mt-3">
        <div class="trax-card p-2 text-center">
          <div class="small text-secondary mb-2">
            Cable flag · {{ 60 + cableGapMm }} × 14 mm — the middle {{ cableGapMm }} mm wraps the
            cable, the ends meet back to back
          </div>
          <img :src="cable" alt="Cable flag label preview" class="img-fluid bg-white rounded">
          <div class="d-flex gap-1 mt-2 justify-content-center">
            <a class="btn btn-sm btn-outline-secondary" :href="cable" :download="cableName">
              <i class="bi bi-download"></i> Download
            </a>
            <button class="btn btn-sm btn-outline-secondary" @click="printLabel(cable)">
              <i class="bi bi-printer"></i> Print
            </button>
          </div>
        </div>
      </div>

      <!-- Whether this label is on the gear yet. Per label: the product label
           and every unit's label each have their own. -->
      <div class="form-check form-switch mt-3">
        <input class="form-check-input" type="checkbox" role="switch" id="label-labeled"
               :checked="labeled" :disabled="labeledBusy" @change="toggleLabeled">
        <label class="form-check-label small" for="label-labeled">
          Labeled — the {{ code }} label is on the gear
        </label>
      </div>

      <div v-if="hasUnits" class="d-grid gap-2 mt-3">
        <button class="btn btn-sm btn-outline-secondary" @click="printAllUnits">
          <i class="bi bi-printer"></i> Print all unit labels
        </button>
        <button class="btn btn-sm btn-outline-secondary"
                :disabled="downloadingAll" @click="downloadAllUnits">
          <span v-if="downloadingAll" class="spinner-border spinner-border-sm me-1"></span>
          <i v-else class="bi bi-file-earmark-zip"></i>
          {{ downloadingAll ? 'Preparing…' : 'Download all unit labels' }}
        </button>
      </div>

      <template #footer>
        <span class="flex-grow-1 small text-secondary font-monospace">ID {{ code }}</span>
        <button class="btn btn-sm btn-outline-secondary" @click="emit('close')">Close</button>
      </template>
    </Drawer>
  `,
};
