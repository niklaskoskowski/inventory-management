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
      <p class="small text-secondary mb-3">Blank fields stay unchanged.</p>

      <div v-if="setCount" class="alert alert-info py-2 px-3 small">
        <i class="bi bi-info-circle"></i>
        {{ setCount }} kit(s) keep their status — it follows their contents.
      </div>

      <div class="trax-form">
        <div class="trax-group">
          <div class="row g-2">
            <div class="col-6">
              <label class="form-label" for="bulk-status">Status</label>
              <select id="bulk-status" class="form-select" v-model="patch.status" data-autofocus>
                <option value="">Keep</option>
                <option v-for="s in STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
              </select>
            </div>

            <div class="col-6">
              <label class="form-label" for="bulk-condition">Condition</label>
              <select id="bulk-condition" class="form-select" v-model="patch.condition"
                      title="Skipped for items that track units">
                <option value="">Keep</option>
                <option v-for="c in CONDITIONS" :key="c" :value="c">{{ CONDITION_LABEL[c] }}</option>
              </select>
            </div>

            <div class="col-6">
              <label class="form-label" for="bulk-category">Category</label>
              <input id="bulk-category" class="form-control" v-model="patch.category"
                     list="bulk-cats" placeholder="Keep">
              <datalist id="bulk-cats">
                <option v-for="c in categories" :key="c" :value="c"></option>
              </datalist>
            </div>

            <div class="col-6">
              <label class="form-label" for="bulk-location">Location</label>
              <input id="bulk-location" class="form-control" v-model="patch.location"
                     list="bulk-locs" placeholder="Keep">
              <datalist id="bulk-locs">
                <option v-for="l in locations" :key="l" :value="l"></option>
              </datalist>
            </div>

            <div class="col-6">
              <label class="form-label" for="bulk-supplier">Supplier</label>
              <input id="bulk-supplier" class="form-control" v-model="patch.supplier" placeholder="Keep">
            </div>

            <div class="col-6">
              <label class="form-label" for="bulk-quantity">Quantity</label>
              <input id="bulk-quantity" type="number" min="1" class="form-control"
                     v-model="patch.quantity" placeholder="Keep"
                     title="Skipped for items that track units; refused below the units out">
            </div>
          </div>
          <div class="form-text">Condition and quantity skip items that track units.</div>
        </div>
      </div>

      <div class="trax-list-header mt-4">{{ chosen.length }} selected</div>
      <div class="trax-list" style="max-height:240px; overflow-y:auto">
        <div v-for="asset in chosen" :key="asset.id" class="trax-row py-2" style="min-height:0">
          <div class="trax-row-main">
            <div class="trax-row-title">
              <span>{{ asset.name }}</span>
              <span v-if="asset.kind === 'SET'" class="trax-kind-chip">Kit</span>
            </div>
          </div>
          <span class="trax-status-dot small" :class="'status-' + asset.effectiveStatus">
            {{ statusLabel(asset.effectiveStatus, asset.kind) }}
          </span>
        </div>
      </div>

      <template #footer>
        <span class="flex-grow-1"></span>
        <button class="btn btn-outline-secondary" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="busy || !Object.keys(filled).length" @click="apply">
          <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
          Apply to {{ chosen.length }}
        </button>
      </template>
    </Drawer>
  `,
};
