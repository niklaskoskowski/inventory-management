import { ref, computed } from 'vue';
import { state, getAsset, mutate, toast, clearSelection, categories, locations } from '../store.js';
import { STATUSES, CONDITIONS, CONDITION_LABEL, statusLabel } from '../lib/format.js';
import Drawer from './ui/Drawer.js';
import StatusBadge from './ui/StatusBadge.js';

/** Apply one change across the selection. */
export default {
  name: 'BulkEditDrawer',
  components: { Drawer, StatusBadge },
  emits: ['close'],
  setup(props, { emit }) {
    const patch = ref({
      status: '', category: '', location: '', condition: '', supplier: '', quantity: '',
    });
    const busy = ref(false);

    const chosen = computed(() => state.selected.map(getAsset).filter(Boolean));
    const setCount = computed(() => chosen.value.filter((a) => a.kind === 'SET').length);

    const filled = computed(() =>
      Object.fromEntries(Object.entries(patch.value).filter(([, v]) => v !== '')),
    );

    const apply = async () => {
      if (!Object.keys(filled.value).length) {
        toast('Nothing to change.', 'warning');
        return;
      }
      busy.value = true;
      try {
        const data = await mutate('asset.bulkUpdate', {
          ids: state.selected,
          patch: filled.value,
        });
        toast(`Updated ${data.changed} item(s).`, 'success');
        clearSelection();
        emit('close');
      } catch { /* toast already raised */ } finally {
        busy.value = false;
      }
    };

    return {
      state, patch, busy, chosen, setCount, filled, apply,
      STATUSES, CONDITIONS, CONDITION_LABEL, statusLabel, categories, locations, emit,
    };
  },
  template: `
    <Drawer title="Edit selected" icon="bi-pencil-square" @close="emit('close')">
      <p class="small text-secondary">
        Leave a field blank to keep it unchanged. {{ chosen.length }} item(s) selected.
      </p>

      <div v-if="setCount" class="alert alert-info py-2 px-3 small">
        <i class="bi bi-info-circle"></i>
        {{ setCount }} kit(s) in the selection will not take a status — a kit's
        status is always derived from its contents.
      </div>

      <div class="row g-2">
        <div class="col-12">
          <label class="form-label small" for="bulk-status">Status</label>
          <select id="bulk-status" class="form-select form-select-sm" v-model="patch.status" data-autofocus>
            <option value="">— keep —</option>
            <option v-for="s in STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
          </select>
        </div>

        <div class="col-12">
          <label class="form-label small" for="bulk-condition">Condition</label>
          <select id="bulk-condition" class="form-select form-select-sm" v-model="patch.condition">
            <option value="">— keep —</option>
            <option v-for="c in CONDITIONS" :key="c" :value="c">{{ CONDITION_LABEL[c] }}</option>
          </select>
        </div>

        <div class="col-12">
          <label class="form-label small" for="bulk-category">Category</label>
          <input id="bulk-category" class="form-control form-control-sm" v-model="patch.category"
                 list="bulk-cats" placeholder="— keep —">
          <datalist id="bulk-cats">
            <option v-for="c in categories" :key="c" :value="c"></option>
          </datalist>
        </div>

        <div class="col-12">
          <label class="form-label small" for="bulk-location">Location</label>
          <input id="bulk-location" class="form-control form-control-sm" v-model="patch.location"
                 list="bulk-locs" placeholder="— keep —">
          <datalist id="bulk-locs">
            <option v-for="l in locations" :key="l" :value="l"></option>
          </datalist>
        </div>

        <div class="col-12">
          <label class="form-label small" for="bulk-supplier">Supplier</label>
          <input id="bulk-supplier" class="form-control form-control-sm" v-model="patch.supplier"
                 placeholder="— keep —">
        </div>

        <div class="col-12">
          <label class="form-label small" for="bulk-quantity">Quantity</label>
          <input id="bulk-quantity" type="number" min="1" class="form-control form-control-sm"
                 v-model="patch.quantity" placeholder="— keep —">
          <div class="form-text small">
            Refused for any item with more units already out than the new quantity.
          </div>
        </div>
      </div>

      <h3 class="trax-page-title mt-4 mb-2">Affected</h3>
      <ul class="list-group list-group-flush" style="max-height:240px; overflow-y:auto">
        <li v-for="asset in chosen" :key="asset.id"
            class="list-group-item bg-transparent d-flex align-items-center gap-2 py-1">
          <span class="flex-grow-1 text-truncate">{{ asset.name }}</span>
          <span v-if="asset.kind === 'SET'" class="trax-kind-chip">kit</span>
          <StatusBadge :status="asset.effectiveStatus" />
        </li>
      </ul>

      <template #footer>
        <span class="flex-grow-1"></span>
        <button class="btn btn-sm btn-outline-secondary" @click="emit('close')">Cancel</button>
        <button class="btn btn-sm btn-primary" :disabled="busy || !Object.keys(filled).length" @click="apply">
          <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
          Apply to {{ chosen.length }}
        </button>
      </template>
    </Drawer>
  `,
};
