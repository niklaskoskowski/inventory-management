import { computed, ref } from 'vue';
import { state, setFilter, resetFilters, categories, locations } from '../store.js';
import { STATUSES, statusLabel } from '../lib/format.js';

export default {
  name: 'FilterBar',
  setup() {
    const searchInput = ref(null);

    // On the Kits view the kind is pinned to SET by the view itself, so the
    // All/Items/Kits toggle would only offer ways to empty the list. It is
    // hidden there, and a kind left over from Inventory does not count as an
    // active filter while it has no effect.
    const kindPinned = computed(() => state.view === 'kits');

    const hasFilters = computed(() => {
      const f = state.filters;
      return Boolean(
        f.search || f.status || f.category || f.location || (!kindPinned.value && f.kind),
      );
    });

    const focusSearch = () => searchInput.value?.focus();

    return {
      state,
      setFilter,
      resetFilters,
      categories,
      locations,
      STATUSES,
      statusLabel,
      hasFilters,
      kindPinned,
      searchInput,
      focusSearch,
    };
  },
  template: `
    <div class="trax-filters">
      <div class="trax-search">
        <i class="bi bi-search"></i>
        <input ref="searchInput" type="search" class="form-control" id="trax-search"
               placeholder="Search" aria-label="Search assets" autocomplete="off"
               :value="state.filters.search"
               @input="setFilter({ search: $event.target.value })">
      </div>

      <div class="trax-chips">
        <div v-if="!kindPinned" class="btn-group btn-group-sm" role="group" aria-label="Filter by type">
          <button type="button" class="btn"
                  :class="state.filters.kind === '' ? 'btn-secondary' : 'btn-outline-secondary'"
                  @click="setFilter({ kind: '' })">All</button>
          <button type="button" class="btn"
                  :class="state.filters.kind === 'ITEM' ? 'btn-secondary' : 'btn-outline-secondary'"
                  @click="setFilter({ kind: 'ITEM' })">Items</button>
          <button type="button" class="btn"
                  :class="state.filters.kind === 'SET' ? 'btn-secondary' : 'btn-outline-secondary'"
                  @click="setFilter({ kind: 'SET' })">Kits</button>
        </div>

        <select class="trax-chip-select" :class="{ 'is-set': state.filters.status }"
                aria-label="Filter by status" :value="state.filters.status"
                @change="setFilter({ status: $event.target.value })">
          <option value="">Status</option>
          <option v-for="s in STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
          <option value="PARTIAL">Incomplete (kits)</option>
        </select>

        <select v-if="categories.length" class="trax-chip-select" :class="{ 'is-set': state.filters.category }"
                aria-label="Filter by category" :value="state.filters.category"
                @change="setFilter({ category: $event.target.value })">
          <option value="">Category</option>
          <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
        </select>

        <select v-if="locations.length" class="trax-chip-select" :class="{ 'is-set': state.filters.location }"
                aria-label="Filter by location" :value="state.filters.location"
                @change="setFilter({ location: $event.target.value })">
          <option value="">Location</option>
          <option v-for="l in locations" :key="l" :value="l">{{ l }}</option>
        </select>

        <button v-if="hasFilters" type="button" class="trax-chip-btn"
                aria-label="Reset filters" @click="resetFilters()">
          <i class="bi bi-x-circle-fill"></i> Reset
        </button>
      </div>

      <slot></slot>
    </div>
  `,
};
