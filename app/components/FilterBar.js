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
    <div class="row g-2 align-items-center mb-3">
      <div class="col-12 col-lg-4">
        <div class="input-group input-group-sm">
          <span class="input-group-text"><i class="bi bi-search"></i></span>
          <input ref="searchInput" type="search" class="form-control" id="trax-search"
                 placeholder="Search name, ID, serial, notes, tags…"
                 aria-label="Search assets"
                 :value="state.filters.search"
                 @input="setFilter({ search: $event.target.value })">
        </div>
      </div>

      <div class="col-6 col-lg-2">
        <select class="form-select form-select-sm" aria-label="Filter by status"
                :value="state.filters.status"
                @change="setFilter({ status: $event.target.value })">
          <option value="">All statuses</option>
          <option v-for="s in STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
          <option value="PARTIAL">Incomplete (kits)</option>
        </select>
      </div>

      <div class="col-6 col-lg-2">
        <select class="form-select form-select-sm" aria-label="Filter by category"
                :value="state.filters.category"
                @change="setFilter({ category: $event.target.value })">
          <option value="">All categories</option>
          <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>

      <div class="col-6 col-lg-2">
        <select class="form-select form-select-sm" aria-label="Filter by location"
                :value="state.filters.location"
                @change="setFilter({ location: $event.target.value })">
          <option value="">All locations</option>
          <option v-for="l in locations" :key="l" :value="l">{{ l }}</option>
        </select>
      </div>

      <div class="col-6 col-lg-2 d-flex gap-2">
        <div v-if="!kindPinned" class="btn-group btn-group-sm flex-grow-1" role="group"
             aria-label="Filter by type">
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
        <button v-if="hasFilters" type="button" class="btn btn-sm btn-outline-secondary"
                title="Reset filters" aria-label="Reset filters" @click="resetFilters()">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>
  `,
};
