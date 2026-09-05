import { computed } from 'vue';
import {
  sortedAssets, toggleSelected, isSelected, soonestLine, getLines, openAssetPhoto,
} from '../store.js';
import { formatDateTime, isOverdue } from '../lib/format.js';
import StatusBadge from './ui/StatusBadge.js';

/** Mobile inventory list. The table does not fit under ~600px. */
export default {
  name: 'AssetCards',
  components: { StatusBadge },
  emits: ['open', 'label'],
  setup(props, { emit }) {
    const rows = computed(() => sortedAssets.value);

    // Several holders means several due dates; show the one that lands first.
    const dueFor = (asset) => {
      const line = soonestLine(asset.id);
      return line ? (line.dueAt || line.returnDate) : null;
    };

    const stockDetail = (asset) => {
      const quantity = Number(asset.quantity) || 1;
      if (quantity <= 1) return '';
      return `${Number(asset.availableQty) || 0} of ${quantity} free`;
    };

    const holderCount = (asset) => getLines(asset.id).length;

    // Per-unit tracking is opt-in per item, so these stay silent for the
    // items that just have a quantity.
    const UNIT_STATE_TEXT = { FREE: 'free', OUT: 'checked out', OOS: 'out of service' };
    const oosCount = (asset) =>
      (asset.units || []).filter((unit) => unit.state === 'OOS' || unit.outOfService).length;
    const unitTitle = (asset) => (asset.units || [])
      .map((unit) => [
        `${asset.id}.${unit.no}`,
        unit.label,
        `\u00b7 ${UNIT_STATE_TEXT[unit.state] || 'free'}`,
      ].filter(Boolean).join(' '))
      .join(' / ');

    return {
      rows, toggleSelected, isSelected, dueFor, stockDetail, holderCount,
      oosCount, unitTitle, formatDateTime, isOverdue, emit, openAssetPhoto,
    };
  },
  template: `
    <div class="d-flex flex-column gap-2">
      <article v-for="asset in rows" :key="asset.id"
               class="trax-asset-card" :class="{ 'is-selected': isSelected(asset.id) }">
        <input class="form-check-input mt-1" type="checkbox"
               :checked="isSelected(asset.id)" @change="toggleSelected(asset.id)"
               :aria-label="'Select ' + asset.name">

        <button v-if="asset.photo" type="button" class="trax-thumb-btn"
                :aria-label="'Show the photo of ' + asset.name"
                @click.stop="openAssetPhoto(asset)">
          <img class="trax-thumb" :src="'uploads/thumb/' + asset.photo" alt="" loading="lazy">
        </button>
        <span v-else class="trax-thumb trax-thumb-placeholder">
          <i class="bi" :class="asset.kind === 'SET' ? 'bi-box-seam' : 'bi-camera'"></i>
        </span>

        <div class="flex-grow-1 min-w-0" @click="emit('open', asset.id)" style="cursor:pointer">
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <strong class="text-truncate">{{ asset.name }}</strong>
            <span v-if="asset.kind === 'SET'" class="trax-kind-chip">kit · {{ asset.members.length }}</span>
            <span v-if="asset.units?.length" class="trax-kind-chip" :title="unitTitle(asset)">
              <i class="bi bi-list-ol"></i> {{ asset.units.length }} units
            </span>
            <span v-if="oosCount(asset)" class="trax-kind-chip text-warning" :title="unitTitle(asset)">
              {{ oosCount(asset) }} out of service
            </span>
          </div>

          <div class="d-flex align-items-center gap-2 mt-1 flex-wrap">
            <StatusBadge :status="asset.effectiveStatus" :kind="asset.kind"
                         :detail="stockDetail(asset)" />
            <span class="text-secondary small font-monospace">#{{ asset.id }}</span>
            <span v-if="asset.quantity > 1 && asset.effectiveStatus !== 'LOCK'" class="text-secondary small">
              {{ asset.availableQty }} of {{ asset.quantity }} free
            </span>
            <span v-if="asset.category" class="text-secondary small">{{ asset.category }}</span>
          </div>

          <div v-if="dueFor(asset)" class="small mt-1"
               :class="isOverdue(dueFor(asset)) ? 'text-danger' : 'text-secondary'">
            due {{ formatDateTime(dueFor(asset)) }}
            <span v-if="holderCount(asset) > 1">· {{ holderCount(asset) }} holders</span>
          </div>

          <div v-if="asset.notes" class="text-secondary small mt-1 text-truncate">{{ asset.notes }}</div>
        </div>

        <button class="btn btn-sm btn-outline-secondary" @click.stop="emit('label', asset.id)"
                :aria-label="'Print label for ' + asset.name">
          <i class="bi bi-printer"></i>
        </button>
      </article>

      <div v-if="!rows.length" class="trax-empty">
        <i class="bi bi-inbox"></i>
        Nothing matches these filters.
      </div>
    </div>
  `,
};
