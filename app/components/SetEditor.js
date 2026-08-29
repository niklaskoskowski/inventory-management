import { ref, computed, watch } from 'vue';
import { state, items, getAsset, mutate, toast, clearSelection } from '../store.js';
import Drawer from './ui/Drawer.js';
import StatusBadge from './ui/StatusBadge.js';

/**
 * Build or edit a kit.
 *
 * A kit is itself an asset record (kind: SET), so it gets its own ID and its
 * own printable QR label — you can scan the bag, not just the gear inside it.
 * Nesting is refused server-side; only items can be members.
 */
export default {
  name: 'SetEditor',
  components: { Drawer, StatusBadge },
  props: {
    setId: { type: Number, default: null },
  },
  emits: ['close', 'open'],
  setup(props, { emit }) {
    const name = ref('');
    const notes = ref('');
    const category = ref('Kit');
    const location = ref('');
    const members = ref([]);
    const search = ref('');
    const busy = ref(false);

    const existing = computed(() => (props.setId ? getAsset(props.setId) : null));
    const isNew = computed(() => !props.setId);

    watch(
      existing,
      (set) => {
        if (set) {
          name.value = set.name;
          notes.value = set.notes;
          category.value = set.category;
          location.value = set.location;
          // Members are {assetId, qty} now.
          members.value = set.members.map((m) => ({
            assetId: Number(m?.assetId ?? m),
            qty: Math.max(1, Number(m?.qty ?? 1)),
          }));
        } else {
          // Seed a new kit from the current selection, minus any kits in it.
          members.value = state.selected
            .filter((id) => getAsset(id)?.kind === 'ITEM')
            .map((id) => ({ assetId: id, qty: 1 }));
        }
      },
      { immediate: true },
    );

    /**
     * Candidate members: items only, never other kits.
     *
     * Items already in the kit are NOT filtered out — adding one again bumps
     * its required quantity, which is the point of a quantity-carrying kit.
     */
    const candidates = computed(() => {
      const query = search.value.trim().toLowerCase();
      return items.value
        .filter((asset) => {
          if (!query) return true;
          return `${asset.id} ${asset.name} ${asset.category} ${asset.serial}`
            .toLowerCase()
            .includes(query);
        })
        .slice(0, 40);
    });

    const chosen = computed(() =>
      members.value
        .map((member) => {
          const asset = getAsset(member.assetId);
          return asset ? { asset, qty: member.qty } : null;
        })
        .filter(Boolean),
    );

    /**
     * Mirrors the server's derivation so the preview matches what will be
     * stored: a member is missing when fewer units are free than the kit needs.
     */
    const derivedStatus = computed(() => {
      if (!chosen.value.length) return 'FREE';
      if (chosen.value.some(({ asset, qty }) =>
        (Number(asset.availableQty) || 0) < qty
        || asset.status === 'UNAV' || asset.status === 'LOCK')) return 'PARTIAL';
      if (chosen.value.some(({ asset }) => asset.status === 'RSVD')) return 'RSVD';
      return 'FREE';
    });

    /** Adding an item already in the kit raises its required quantity. */
    const add = (id) => {
      const existingMember = members.value.find((m) => m.assetId === id);
      if (existingMember) existingMember.qty += 1;
      else members.value.push({ assetId: id, qty: 1 });
    };

    const setMemberQty = (id, qty) => {
      const member = members.value.find((m) => m.assetId === id);
      if (!member) return;
      const wanted = Math.floor(Number(qty));
      member.qty = Math.max(1, Number.isFinite(wanted) ? wanted : 1);
    };

    const remove = (id) => {
      const index = members.value.findIndex((m) => m.assetId === id);
      if (index >= 0) members.value.splice(index, 1);
    };

    /** members: [{assetId, qty}] — the shape set.create/set.update expect. */
    const memberPayload = () =>
      members.value.map((m) => ({ assetId: m.assetId, qty: Math.max(1, m.qty) }));

    const save = async () => {
      if (!name.value.trim()) {
        toast('Give the kit a name.', 'warning');
        return;
      }
      busy.value = true;
      try {
        if (isNew.value) {
          const data = await mutate('set.create', {
            name: name.value,
            notes: notes.value,
            category: category.value,
            location: location.value,
            members: memberPayload(),
          });
          toast(`Kit "${name.value}" created.`, 'success');
          clearSelection();
          emit('close');
          emit('open', data.newId);
        } else {
          await mutate('set.update', {
            id: props.setId,
            patch: {
              name: name.value,
              notes: notes.value,
              category: category.value,
              location: location.value,
              members: memberPayload(),
            },
          });
          toast('Kit saved.', 'success');
          emit('close');
        }
      } catch { /* toast already raised */ } finally {
        busy.value = false;
      }
    };

    return {
      name, notes, category, location, members, search, busy,
      isNew, candidates, chosen, derivedStatus, add, setMemberQty, remove, save, emit,
    };
  },
  template: `
    <Drawer :title="isNew ? 'New kit' : 'Edit kit'" icon="bi-box-seam" wide @close="emit('close')">
      <template #header-actions>
        <StatusBadge :status="derivedStatus" title="Derived from contents" />
      </template>

      <div class="row g-2 mb-3">
        <div class="col-12 col-md-6">
          <label class="form-label small" for="k-name">Kit name</label>
          <input id="k-name" class="form-control form-control-sm" v-model="name"
                 placeholder="e.g. Camera Kit A" data-autofocus>
        </div>
        <div class="col-6 col-md-3">
          <label class="form-label small" for="k-category">Category</label>
          <input id="k-category" class="form-control form-control-sm" v-model="category">
        </div>
        <div class="col-6 col-md-3">
          <label class="form-label small" for="k-location">Location</label>
          <input id="k-location" class="form-control form-control-sm" v-model="location">
        </div>
        <div class="col-12">
          <label class="form-label small" for="k-notes">Notes</label>
          <input id="k-notes" class="form-control form-control-sm" v-model="notes">
        </div>
      </div>

      <div class="row g-3">
        <!-- Contents -->
        <div class="col-12 col-md-6">
          <h3 class="trax-page-title mb-2">
            Contents <span class="text-secondary small">({{ chosen.length }})</span>
          </h3>

          <ul class="list-group list-group-flush">
            <li v-for="row in chosen" :key="'m' + row.asset.id"
                class="list-group-item bg-transparent d-flex align-items-center gap-2 py-1">
              <img v-if="row.asset.photo" class="trax-thumb" :src="'uploads/thumb/' + row.asset.photo" alt="">
              <span v-else class="trax-thumb trax-thumb-placeholder"><i class="bi bi-camera"></i></span>
              <span class="flex-grow-1 text-truncate">{{ row.asset.name }}</span>
              <input class="form-control form-control-sm text-center" type="number" min="1"
                     style="width:4.5rem" :value="row.qty"
                     @input="setMemberQty(row.asset.id, $event.target.value)"
                     :aria-label="'Units of ' + row.asset.name + ' in this kit'">
              <StatusBadge :status="row.asset.effectiveStatus" :kind="row.asset.kind" />
              <button class="btn btn-sm btn-outline-danger py-0 px-1"
                      @click="remove(row.asset.id)" :aria-label="'Remove ' + row.asset.name">
                <i class="bi bi-x"></i>
              </button>
            </li>
            <li v-if="!chosen.length" class="text-secondary small py-3">
              Add items from the right. A kit with no items is always available.
            </li>
          </ul>
        </div>

        <!-- Picker -->
        <div class="col-12 col-md-6">
          <h3 class="trax-page-title mb-2">Add items</h3>
          <input class="form-control form-control-sm mb-2" v-model="search"
                 placeholder="Search items…" aria-label="Search items to add">

          <ul class="list-group list-group-flush" style="max-height:420px; overflow-y:auto">
            <li v-for="asset in candidates" :key="'c' + asset.id"
                class="list-group-item bg-transparent d-flex align-items-center gap-2 py-1">
              <span class="flex-grow-1 text-truncate">
                {{ asset.name }}
                <span class="text-secondary font-monospace small">#{{ asset.id }}</span>
              </span>
              <StatusBadge :status="asset.effectiveStatus" :kind="asset.kind"
                           :detail="asset.quantity > 1 ? (asset.availableQty + ' of ' + asset.quantity + ' free') : ''" />
              <button class="btn btn-sm btn-outline-primary py-0 px-1"
                      @click="add(asset.id)" :aria-label="'Add ' + asset.name">
                <i class="bi bi-plus"></i>
              </button>
            </li>
            <li v-if="!candidates.length" class="text-secondary small py-3">No matching items.</li>
          </ul>
        </div>
      </div>

      <p class="small text-secondary mt-3 mb-0">
        <i class="bi bi-info-circle"></i>
        Kits cannot contain other kits. A kit's status is always derived from its contents,
        and deleting a kit never deletes the gear inside it.
      </p>

      <template #footer>
        <span class="flex-grow-1"></span>
        <button class="btn btn-sm btn-outline-secondary" @click="emit('close')">Cancel</button>
        <button class="btn btn-sm btn-primary" :disabled="busy" @click="save">
          <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
          {{ isNew ? 'Create kit' : 'Save kit' }}
        </button>
      </template>
    </Drawer>
  `,
};
