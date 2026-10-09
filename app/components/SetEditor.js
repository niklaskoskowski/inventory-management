import { ref, computed, watch } from 'vue';
import {
  state, items, getAsset, mutate, toast, clearSelection, openAssetPhoto,
} from '../store.js';
import { statusLabel } from '../lib/format.js';
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
          // Back to the kit's sheet, which is where "Edit contents" came from.
          emit('open', props.setId);
        }
      } catch { /* toast already raised */ } finally {
        busy.value = false;
      }
    };

    return {
      name, notes, category, location, members, search, busy,
      isNew, candidates, chosen, derivedStatus, add, setMemberQty, remove, save, emit,
      openAssetPhoto, statusLabel,
    };
  },
  template: `
    <Drawer :title="isNew ? 'New kit' : 'Edit kit'" icon="bi-box-seam" wide @close="emit('close')">
      <template #header-actions>
        <StatusBadge :status="derivedStatus" title="Derived from contents" />
      </template>

      <div class="trax-form">
        <div class="trax-group">
          <div class="row g-2">
            <div class="col-12 col-md-6">
              <label class="form-label" for="k-name">Name</label>
              <input id="k-name" class="form-control" v-model="name"
                     placeholder="e.g. Camera kit A" data-autofocus="desktop">
            </div>
            <div class="col-6 col-md-3">
              <label class="form-label" for="k-category">Category</label>
              <input id="k-category" class="form-control" v-model="category">
            </div>
            <div class="col-6 col-md-3">
              <label class="form-label" for="k-location">Location</label>
              <input id="k-location" class="form-control" v-model="location">
            </div>
            <div class="col-12">
              <label class="form-label" for="k-notes">Notes</label>
              <input id="k-notes" class="form-control" v-model="notes">
            </div>
          </div>
        </div>
      </div>

      <div class="row g-3 mt-1">
        <!-- Contents -->
        <div class="col-12 col-md-6">
          <div class="trax-list-header">
            <span title="A kit's status follows its contents. Deleting a kit keeps the items.">
              Contents · {{ chosen.length }}
            </span>
          </div>

          <div v-if="chosen.length" class="trax-list">
            <div v-for="row in chosen" :key="'m' + row.asset.id" class="trax-row">
              <button v-if="row.asset.photo" type="button" class="trax-thumb-btn"
                      :aria-label="'Show the photo of ' + row.asset.name"
                      @click.stop="openAssetPhoto(row.asset)">
                <img class="trax-thumb" :src="'uploads/thumb/' + row.asset.photo" alt="">
              </button>
              <span v-else class="trax-thumb trax-thumb-placeholder"><i class="bi bi-camera"></i></span>
              <div class="trax-row-main">
                <div class="trax-row-title"><span>{{ row.asset.name }}</span></div>
                <div class="trax-row-meta">
                  <span class="trax-status-dot" :class="'status-' + row.asset.effectiveStatus">
                    {{ statusLabel(row.asset.effectiveStatus, row.asset.kind) }}
                  </span>
                </div>
              </div>
              <span class="text-secondary small" aria-hidden="true">×</span>
              <input class="form-control form-control-sm text-center px-1" type="number" min="1"
                     style="width:3.5rem; flex:0 0 auto" :value="row.qty"
                     @input="setMemberQty(row.asset.id, $event.target.value)"
                     :aria-label="'Units of ' + row.asset.name + ' in this kit'">
              <button class="btn btn-sm btn-outline-danger"
                      @click="remove(row.asset.id)" :aria-label="'Remove ' + row.asset.name">
                <i class="bi bi-dash-lg"></i>
              </button>
            </div>
          </div>
          <div v-else class="trax-empty py-4">
            <i class="bi bi-box-seam"></i>No items yet
          </div>
        </div>

        <!-- Picker. Adding an item already in the kit raises its quantity. -->
        <div class="col-12 col-md-6">
          <div class="trax-list-header">Add items</div>
          <div class="trax-search mb-2">
            <i class="bi bi-search"></i>
            <input type="search" class="form-control form-control-sm" v-model="search"
                   placeholder="Search" aria-label="Search items to add" autocomplete="off">
          </div>

          <div v-if="candidates.length" class="trax-list" style="max-height:420px; overflow-y:auto">
            <div v-for="asset in candidates" :key="'c' + asset.id" class="trax-row is-tappable"
                 @click="add(asset.id)">
              <div class="trax-row-main">
                <div class="trax-row-title">
                  <span>{{ asset.name }}</span>
                  <span class="text-secondary font-monospace small fw-normal">#{{ asset.id }}</span>
                </div>
                <div class="trax-row-meta">
                  <span class="trax-status-dot" :class="'status-' + asset.effectiveStatus">
                    {{ statusLabel(asset.effectiveStatus, asset.kind) }}<span
                      v-if="asset.quantity > 1"> · {{ asset.availableQty }} of {{ asset.quantity }} free</span>
                  </span>
                </div>
              </div>
              <button class="btn btn-sm btn-outline-primary"
                      @click.stop="add(asset.id)" :aria-label="'Add ' + asset.name">
                <i class="bi bi-plus-lg"></i>
              </button>
            </div>
          </div>
          <div v-else class="trax-empty py-4"><i class="bi bi-search"></i>No matching items</div>
        </div>
      </div>

      <template #footer>
        <span class="flex-grow-1"></span>
        <button class="btn btn-outline-secondary" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="busy" @click="save">
          <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
          {{ isNew ? 'Create kit' : 'Save' }}
        </button>
      </template>
    </Drawer>
  `,
};
