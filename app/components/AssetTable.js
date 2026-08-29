import { computed } from 'vue';
import {
  state, sortedAssets, toggleSort, toggleSelected, isSelected, selectAll,
  clearSelection, toggleSetExpanded, membersOf, soonestLine, getLines,
} from '../store.js';
import { formatDateTime, formatMoney, isOverdue } from '../lib/format.js';
import StatusBadge from './ui/StatusBadge.js';

/**
 * Desktop inventory table.
 *
 * Category and location are real columns here — the old table had them
 * commented out (admin.php:222-223) even though you could filter by them.
 * Kits expand in place to show their members and each member's live status.
 */
export default {
  name: 'AssetTable',
  components: { StatusBadge },
  emits: ['open', 'label'],
  setup(props, { emit }) {
    const rows = computed(() => sortedAssets.value);

    const allSelected = computed(
      () => rows.value.length > 0 && rows.value.every((a) => isSelected(a.id)),
    );

    const toggleAll = () => {
      if (allSelected.value) clearSelection();
      else selectAll(rows.value.map((a) => a.id));
    };

    const shows = (column) => state.filters.columns.includes(column);

    const sortIcon = (column) => {
      if (state.filters.sortBy !== column) return 'bi-arrow-down-up opacity-50';
      return state.filters.sortDir === 'asc' ? 'bi-sort-down-alt' : 'bi-sort-up-alt';
    };

    const ariaSort = (column) => {
      if (state.filters.sortBy !== column) return 'none';
      return state.filters.sortDir === 'asc' ? 'ascending' : 'descending';
    };

    // Several people can hold units of the same asset, so "the" due date is
    // whichever line comes back first.
    const dueFor = (asset) => {
      const line = soonestLine(asset.id);
      return line ? (line.dueAt || line.returnDate) : null;
    };

    /** "5 of 8 free" — only worth saying when there is more than one unit. */
    const stockDetail = (asset) => {
      const quantity = Number(asset.quantity) || 1;
      if (quantity <= 1) return '';
      return `${Number(asset.availableQty) || 0} of ${quantity} free`;
    };

    const holderCount = (asset) => getLines(asset.id).length;

    const columnCount = computed(
      () => 5 + ['quantity', 'category', 'location', 'notes', 'serial', 'condition', 'value'].filter(shows).length,
    );

    return {
      state, rows, allSelected, toggleAll, toggleSort, toggleSelected, isSelected,
      toggleSetExpanded, membersOf, shows, sortIcon, ariaSort,
      formatDateTime, formatMoney, isOverdue, dueFor, stockDetail, holderCount,
      columnCount, emit,
    };
  },
  template: `
    <div class="trax-card" :class="'trax-density-' + state.filters.density" style="overflow:auto">
      <table class="trax-table">
        <caption class="visually-hidden">Inventory</caption>
        <thead>
          <tr>
            <th style="width:2.2rem">
              <input class="form-check-input" type="checkbox"
                     :checked="allSelected" @change="toggleAll"
                     aria-label="Select all visible assets">
            </th>
            <th style="width:2.6rem"></th>
            <th :aria-sort="ariaSort('name')">
              <button class="sort-btn" @click="toggleSort('name')">Item <i class="bi" :class="sortIcon('name')"></i></button>
            </th>
            <th :aria-sort="ariaSort('status')" style="width:8.5rem">
              <button class="sort-btn" @click="toggleSort('status')">Status <i class="bi" :class="sortIcon('status')"></i></button>
            </th>
            <th v-if="shows('category')" :aria-sort="ariaSort('category')">
              <button class="sort-btn" @click="toggleSort('category')">Category <i class="bi" :class="sortIcon('category')"></i></button>
            </th>
            <th v-if="shows('location')" :aria-sort="ariaSort('location')">
              <button class="sort-btn" @click="toggleSort('location')">Location <i class="bi" :class="sortIcon('location')"></i></button>
            </th>
            <th v-if="shows('serial')">Serial</th>
            <th v-if="shows('condition')">Condition</th>
            <th v-if="shows('value')" class="text-end">Value</th>
            <th v-if="shows('quantity')" class="text-end" style="width:7rem">Qty free</th>
            <th v-if="shows('notes')">Notes</th>
            <th :aria-sort="ariaSort('id')" style="width:4.5rem">
              <button class="sort-btn" @click="toggleSort('id')">ID <i class="bi" :class="sortIcon('id')"></i></button>
            </th>
            <th style="width:5.5rem"></th>
          </tr>
        </thead>

        <tbody>
          <template v-for="asset in rows" :key="asset.id">
            <tr :class="{ 'is-selected': isSelected(asset.id) }">
              <td>
                <input class="form-check-input" type="checkbox"
                       :checked="isSelected(asset.id)"
                       @change="toggleSelected(asset.id)"
                       :aria-label="'Select ' + asset.name">
              </td>

              <td>
                <img v-if="asset.photo" class="trax-thumb"
                     :src="'uploads/thumb/' + asset.photo" :alt="''" loading="lazy">
                <span v-else class="trax-thumb trax-thumb-placeholder">
                  <i class="bi" :class="asset.kind === 'SET' ? 'bi-box-seam' : 'bi-camera'"></i>
                </span>
              </td>

              <td>
                <div class="d-flex align-items-center gap-2">
                  <button v-if="asset.kind === 'SET'" class="btn btn-sm btn-link p-0 text-secondary"
                          @click="toggleSetExpanded(asset.id)"
                          :aria-expanded="!!state.expandedSets[asset.id]"
                          :aria-label="(state.expandedSets[asset.id] ? 'Collapse ' : 'Expand ') + asset.name">
                    <i class="bi" :class="state.expandedSets[asset.id] ? 'bi-chevron-down' : 'bi-chevron-right'"></i>
                  </button>
                  <button class="trax-name-btn" @click="emit('open', asset.id)">{{ asset.name }}</button>
                  <span v-if="asset.kind === 'SET'" class="trax-kind-chip">
                    kit · {{ asset.members.length }}
                  </span>
                  <i v-if="asset.memberOf.length" class="bi bi-link-45deg text-secondary"
                     :title="'Part of ' + asset.memberOf.length + ' kit(s)'"></i>
                </div>
              </td>

              <td>
                <StatusBadge :status="asset.effectiveStatus" :kind="asset.kind"
                             :detail="stockDetail(asset)" />
                <div v-if="dueFor(asset)" class="small mt-1"
                     :class="isOverdue(dueFor(asset)) ? 'text-danger' : 'text-secondary'">
                  due {{ formatDateTime(dueFor(asset)) }}
                  <span v-if="holderCount(asset) > 1">· {{ holderCount(asset) }} holders</span>
                </div>
              </td>

              <td v-if="shows('category')" class="text-secondary">{{ asset.category || '—' }}</td>
              <td v-if="shows('location')" class="text-secondary">{{ asset.location || '—' }}</td>
              <td v-if="shows('serial')" class="text-secondary font-monospace small">{{ asset.serial || '—' }}</td>
              <td v-if="shows('condition')" class="text-secondary">{{ asset.condition }}</td>
              <td v-if="shows('value')" class="text-secondary text-end">{{ formatMoney(asset.price, asset.currency) || '—' }}</td>
              <td v-if="shows('quantity')" class="text-secondary text-end font-monospace">
                <span v-if="asset.quantity > 1">{{ asset.availableQty }} of {{ asset.quantity }}</span>
                <span v-else>{{ asset.availableQty }}</span>
              </td>
              <td v-if="shows('notes')" class="text-secondary small">{{ asset.notes || '' }}</td>

              <td class="text-secondary font-monospace">{{ asset.id }}</td>

              <td>
                <div class="d-flex justify-content-end gap-1">
                  <button class="btn btn-sm btn-outline-secondary" @click="emit('label', asset.id)"
                          :aria-label="'Print label for ' + asset.name" title="Label">
                    <i class="bi bi-printer"></i>
                  </button>
                  <button class="btn btn-sm btn-outline-secondary" @click="emit('open', asset.id)"
                          :aria-label="'Open ' + asset.name" title="Details">
                    <i class="bi bi-chevron-right"></i>
                  </button>
                </div>
              </td>
            </tr>

            <!-- Kit members, expanded in place. -->
            <tr v-for="(member, mi) in (state.expandedSets[asset.id] ? membersOf(asset) : [])"
                :key="asset.id + '-' + mi + '-' + member.id" class="is-member">
              <td></td>
              <td></td>
              <td>
                <span class="text-secondary me-1"><i class="bi bi-arrow-return-right"></i></span>
                <button class="trax-name-btn" @click="emit('open', member.id)">{{ member.name }}</button>
                <span v-if="member.reqQty > 1" class="trax-kind-chip ms-1">×{{ member.reqQty }}</span>
              </td>
              <td>
                <StatusBadge :status="member.effectiveStatus" :kind="member.kind"
                             :detail="stockDetail(member)" />
              </td>
              <td v-if="shows('category')" class="text-secondary">{{ member.category || '—' }}</td>
              <td v-if="shows('location')" class="text-secondary">{{ member.location || '—' }}</td>
              <td v-if="shows('serial')" class="text-secondary font-monospace small">{{ member.serial || '—' }}</td>
              <td v-if="shows('condition')" class="text-secondary">{{ member.condition }}</td>
              <td v-if="shows('value')" class="text-secondary text-end">{{ formatMoney(member.price, member.currency) || '—' }}</td>
              <td v-if="shows('quantity')" class="text-secondary text-end font-monospace">
                {{ member.availableQty }} of {{ member.quantity }} · need {{ member.reqQty }}
              </td>
              <td v-if="shows('notes')" class="text-secondary small">{{ member.notes || '' }}</td>
              <td class="text-secondary font-monospace">{{ member.id }}</td>
              <td></td>
            </tr>
          </template>

          <tr v-if="!rows.length">
            <td :colspan="columnCount">
              <div class="trax-empty">
                <i class="bi bi-inbox"></i>
                Nothing matches these filters.
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  `,
};
