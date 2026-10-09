import { computed } from 'vue';
import {
  sortedAssets, toggleSelected, isSelected, soonestLine, getLines, openAssetPhoto,
} from '../store.js';
import { formatDateTime, isOverdue, parseDate, statusLabel, getUiLocale } from '../lib/format.js';
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

    /** "Available", "2 of 8 free" — the status in the words a list row has room for. */
    const statusText = (asset) => {
      const detail = stockDetail(asset);
      if (detail && asset.effectiveStatus !== 'LOCK' && asset.effectiveStatus !== 'FREE') return detail;
      return statusLabel(asset.effectiveStatus, asset.kind);
    };

    /** "Oct 14" — the time is in the sheet. */
    const formatShort = (value) => {
      const date = parseDate(value);
      return date ? date.toLocaleDateString(getUiLocale(), { month: 'short', day: 'numeric' }) : '';
    };

    return {
      statusText, formatShort,
      rows, toggleSelected, isSelected, dueFor, stockDetail, holderCount,
      oosCount, unitTitle, formatDateTime, isOverdue, emit, openAssetPhoto,
    };
  },
  template: `
    <div v-if="rows.length" class="trax-list" style="--trax-row-inset: 6.6rem">
      <div v-for="asset in rows" :key="asset.id" class="trax-row is-tappable"
           :class="{ 'is-selected': isSelected(asset.id) }" @click="emit('open', asset.id)">
        <input class="trax-check" type="checkbox" :checked="isSelected(asset.id)"
               @click.stop @change="toggleSelected(asset.id)" :aria-label="'Select ' + asset.name">

        <button v-if="asset.photo" type="button" class="trax-thumb-btn"
                :aria-label="'Show the photo of ' + asset.name"
                @click.stop="openAssetPhoto(asset)">
          <img class="trax-thumb" :src="'uploads/thumb/' + asset.photo" alt="" loading="lazy">
        </button>
        <span v-else class="trax-thumb trax-thumb-placeholder">
          <i class="bi" :class="asset.kind === 'SET' ? 'bi-box-seam' : 'bi-camera'"></i>
        </span>

        <div class="trax-row-main">
          <div class="trax-row-title">
            <span>{{ asset.name }}</span>
            <span v-if="asset.kind === 'SET'" class="trax-kind-chip">Kit · {{ asset.members.length }}</span>
            <span v-else-if="asset.units?.length" class="trax-kind-chip" :title="unitTitle(asset)">
              {{ asset.units.length }} units
            </span>
          </div>
          <div class="trax-row-meta">
            <span class="trax-status-dot" :class="'status-' + asset.effectiveStatus">
              {{ statusText(asset) }}
            </span>
            <span v-if="dueFor(asset)" :class="{ 'text-danger': isOverdue(dueFor(asset)) }">
              due {{ formatShort(dueFor(asset)) }}
            </span>
            <span v-else-if="asset.category">{{ asset.category }}</span>
            <span v-if="oosCount(asset)" class="text-warning">{{ oosCount(asset) }} out of service</span>
          </div>
        </div>
        <i class="bi bi-chevron-right trax-row-chevron"></i>
      </div>
    </div>

    <div v-else class="trax-empty">
      <i class="bi bi-search"></i>
      No matches
    </div>
  `,
};
