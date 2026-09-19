import { computed } from 'vue';
import { FIXED_PER, OVERRIDE_MODES, daysLabel, formatPercent } from '../lib/rental.js';

/**
 * One rental rate, as a form.
 *
 * The same three fields are edited in four places — the install's default
 * rate, a category's rate, an asset's own and a unit's own — so they are one
 * component rather than four copies that drift. It edits the object it is
 * given IN PLACE: the rates live inside a settings draft or a units draft that
 * their own view owns and saves, and handing a fresh object back on every
 * keystroke would mean rebuilding that draft on every keystroke too.
 *
 * Two variants:
 *   - `rule`     — a category or the default: PERCENT or FIXED, with the
 *                  discount ladder (`tiers`) when it is a percentage.
 *   - `override` — an asset's or a unit's: may also say INHERIT, which is what
 *                  every record says until somebody changes it. The ladder is
 *                  never edited here; it belongs to the category.
 */
export default {
  name: 'RentalRate',
  props: {
    // Mutated in place — see above.
    rule: { type: Object, required: true },
    variant: { type: String, default: 'rule' },
    // The ladder, on a rule. Off for the asset/unit override.
    showTiers: { type: Boolean, default: false },
    // One row of small controls instead of a labelled grid.
    dense: { type: Boolean, default: false },
    // What a fixed amount is denominated in. Display only.
    currency: { type: String, default: 'EUR' },
    // What this rate falls back to, as a sentence, for the INHERIT option.
    inheritLabel: { type: String, default: 'Use the category rate' },
    disabled: { type: Boolean, default: false },
  },
  emits: ['change'],
  setup(props, { emit }) {
    const isOverride = computed(() => props.variant === 'override');

    const touch = () => emit('change');

    const setMode = (mode) => {
      if (!OVERRIDE_MODES.includes(mode)) return;
      props.rule.mode = mode;
      // A rate switched on with nothing in its box would resolve back to the
      // category's — so the box is seeded rather than left empty.
      if (mode === 'PERCENT' && (props.rule.percent === null || props.rule.percent === '')) {
        props.rule.percent = 0;
      }
      if (mode === 'FIXED' && (props.rule.fixed === null || props.rule.fixed === '')) {
        props.rule.fixed = 0;
        if (!FIXED_PER.includes(props.rule.fixedPer)) props.rule.fixedPer = 'RENTAL';
      }
      touch();
    };

    const tiers = computed(() => (Array.isArray(props.rule.tiers) ? props.rule.tiers : []));

    /**
     * A new step, one duration past the last one: 2 days, then a week, then a
     * fortnight — the ladder operators actually build. Its rate starts at the
     * step above it, so adding one never silently changes what is charged.
     */
    const addTier = () => {
      if (!Array.isArray(props.rule.tiers)) props.rule.tiers = [];
      const last = props.rule.tiers[props.rule.tiers.length - 1];
      const days = last ? Math.min(3650, Math.max(2, Number(last.days) || 1) * 2) : 2;
      const percent = last ? last.percent : props.rule.percent;
      props.rule.tiers.push({ days, percent });
      touch();
    };

    const removeTier = (index) => {
      props.rule.tiers.splice(index, 1);
      touch();
    };

    /** Sorted on blur, not while typing: re-ordering under the cursor is worse. */
    const sortTiers = () => {
      props.rule.tiers.sort((a, b) => (Number(a.days) || 0) - (Number(b.days) || 0));
      touch();
    };

    return {
      isOverride, tiers, setMode, addTier, removeTier, sortTiers, touch,
      daysLabel, formatPercent,
    };
  },
  template: `
    <div>
      <div class="row g-2" :class="dense ? 'align-items-center' : 'align-items-end'">
        <div :class="dense ? 'col-12 col-sm-5' : 'col-12 col-md-5'">
          <label v-if="!dense" class="form-label small mb-1">Charged as</label>
          <select class="form-select form-select-sm" :value="rule.mode" :disabled="disabled"
                  aria-label="How this rate is charged"
                  @change="setMode($event.target.value)">
            <option v-if="isOverride" value="INHERIT">{{ inheritLabel }}</option>
            <option value="PERCENT">% of value, per day</option>
            <option value="FIXED">Fixed price</option>
          </select>
        </div>

        <div v-if="rule.mode === 'PERCENT'" :class="dense ? 'col-12 col-sm-4' : 'col-6 col-md-4'">
          <label v-if="!dense" class="form-label small mb-1">Daily rate</label>
          <div class="input-group input-group-sm">
            <input class="form-control text-end" type="text" inputmode="decimal"
                   v-model="rule.percent" :disabled="disabled"
                   aria-label="Daily rate as a percentage of the item value"
                   @input="touch()">
            <span class="input-group-text">% / day</span>
          </div>
        </div>

        <template v-if="rule.mode === 'FIXED'">
          <div :class="dense ? 'col-6 col-sm-4' : 'col-6 col-md-4'">
            <label v-if="!dense" class="form-label small mb-1">Fixed price</label>
            <div class="input-group input-group-sm">
              <input class="form-control text-end" type="text" inputmode="decimal"
                     v-model="rule.fixed" :disabled="disabled"
                     aria-label="Fixed rental price"
                     @input="touch()">
              <span class="input-group-text">{{ currency }}</span>
            </div>
          </div>
          <div :class="dense ? 'col-6 col-sm-3' : 'col-6 col-md-3'">
            <label v-if="!dense" class="form-label small mb-1">Charged</label>
            <select class="form-select form-select-sm" v-model="rule.fixedPer" :disabled="disabled"
                    aria-label="How often the fixed price is charged" @change="touch()">
              <option value="RENTAL">per rental</option>
              <option value="DAY">per day</option>
            </select>
          </div>
        </template>
      </div>

      <!-- The discount ladder. A step is "from N days on, this rate" — so the
           base rate above is what a hire shorter than the first step costs. -->
      <div v-if="showTiers && rule.mode === 'PERCENT'" class="mt-2">
        <div class="d-flex align-items-center gap-2">
          <span class="small text-secondary flex-grow-1">
            Discounts <span v-if="tiers.length">({{ tiers.length }})</span>
          </span>
          <button type="button" class="btn btn-sm btn-outline-primary py-0 px-2"
                  :disabled="disabled || tiers.length >= 24" @click="addTier()">
            <i class="bi bi-plus"></i> Discount
          </button>
        </div>

        <div v-for="(tier, index) in tiers" :key="index"
             class="d-flex align-items-center gap-1 mt-1">
          <span class="small text-secondary">from</span>
          <input class="form-control form-control-sm text-end" style="width:5rem"
                 type="number" min="1" max="3650" step="1" v-model="tier.days"
                 :disabled="disabled" :aria-label="'Discount ' + (index + 1) + ': from how many days'"
                 @input="touch()" @change="sortTiers()">
          <span class="small text-secondary">days →</span>
          <div class="input-group input-group-sm" style="width:7rem">
            <input class="form-control text-end" type="text" inputmode="decimal"
                   v-model="tier.percent" :disabled="disabled"
                   :aria-label="'Discount ' + (index + 1) + ': rate per day'"
                   @input="touch()">
            <span class="input-group-text">%/d</span>
          </div>
          <button type="button" class="btn btn-sm btn-outline-danger py-0 px-1"
                  :disabled="disabled" :aria-label="'Remove discount ' + (index + 1)"
                  @click="removeTier(index)">
            <i class="bi bi-x"></i>
          </button>
          <span class="small text-secondary d-none d-md-inline">{{ daysLabel(tier.days) }}</span>
        </div>

        <p v-if="!tiers.length" class="form-text small mb-0">
          No discounts — every day of a hire costs {{ formatPercent(rule.percent) }} %.
        </p>
        <p v-else class="form-text small mb-0">
          A hire of that many days or more is charged the step's rate for every day of it.
        </p>
      </div>
    </div>
  `,
};
