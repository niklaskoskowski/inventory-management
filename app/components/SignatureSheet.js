import { ref, computed } from 'vue';
import {
  state, toast, signBooking, declineSignature, termsUrl, getAsset,
} from '../store.js';
import { formatDateTime } from '../lib/format.js';
import Drawer from './ui/Drawer.js';
import SignaturePad from './SignaturePad.js';

/**
 * The hand-over signature, asked for at the counter.
 *
 * Opens right after a checkout (and from Checkouts → Sign now) for
 * state.signPrompt. Three ways out, each of them an answer: signed, declined
 * (recorded with who asked and when), or later (nothing stored — the booking
 * shows "Not signed" in Checkouts).
 */
export default {
  name: 'SignatureSheet',
  components: { Drawer, SignaturePad },
  setup() {
    const booking = computed(() => state.bookings.find((b) => Number(b.id) === Number(state.signPrompt)) || null);

    const name = ref(booking.value?.customerName || '');
    const acceptTerms = ref(false);
    const busy = ref(false);
    const declining = ref(false);
    const declineNote = ref('');

    const items = computed(() => (booking.value?.items || []).map((item) => ({
      key: `${item.assetId}-${item.unitNos?.join('.') || ''}`,
      name: item.name || getAsset(item.assetId)?.name || `#${item.assetId}`,
      qty: Math.max(1, Number(item.qty) || 1),
      units: (item.unitNos || []).map((no) => `${item.assetId}.${no}`).join(', '),
    })));

    const units = computed(() => items.value.reduce((sum, item) => sum + item.qty, 0));

    const locked = computed(() => (state.terms.active && !acceptTerms.value ? 'Accept the terms first.' : ''));

    const close = () => { state.signPrompt = null; };

    const save = async (blob) => {
      if (!booking.value) return;
      busy.value = true;
      try {
        await signBooking(booking.value.id, name.value.trim(), blob, state.terms.active ? state.terms.version : null);
        toast('Signed.', 'success');
        close();
      } catch {
        /* toast already raised by the store */
      } finally {
        busy.value = false;
      }
    };

    const decline = async () => {
      if (!booking.value) return;
      busy.value = true;
      try {
        await declineSignature(booking.value.id, declineNote.value.trim());
        toast('Recorded: signature declined.', 'warning');
        close();
      } catch {
        /* toast already raised by the store */
      } finally {
        busy.value = false;
      }
    };

    return {
      state, booking, name, acceptTerms, busy, declining, declineNote, items, units, locked,
      close, save, decline, termsUrl, formatDateTime,
    };
  },
  template: `
    <Drawer title="Signature" icon="bi-pen" @close="close">
      <template v-if="booking">
        <div class="trax-list">
          <div class="trax-kv">
            <span>Customer</span><strong class="text-truncate">{{ booking.customerName }}</strong>
          </div>
          <div class="trax-kv">
            <span>Items</span><strong>{{ units }} {{ units === 1 ? 'unit' : 'units' }}</strong>
          </div>
          <div v-for="item in items" :key="item.key" class="trax-kv small">
            <span class="text-truncate">{{ item.name }}<span v-if="item.units" class="text-secondary"> · {{ item.units }}</span></span>
            <span class="text-secondary">×{{ item.qty }}</span>
          </div>
        </div>

        <div v-if="booking.signatureDeclined && !declining" class="alert alert-warning py-2 px-3 small mt-3 mb-0">
          <i class="bi bi-exclamation-triangle-fill"></i>
          Declined {{ formatDateTime(booking.signatureDeclined.at) }}<span v-if="booking.signatureDeclined.note">: {{ booking.signatureDeclined.note }}</span>
        </div>

        <template v-if="!declining">
          <div class="trax-list-header">Signed by</div>
          <input class="form-control" v-model="name" maxlength="200" placeholder="Name" aria-label="Signed by"
                 autocomplete="off">

          <div class="trax-list-header">Signature</div>
          <SignaturePad :busy="busy" :locked="locked" cancel-label="Later" submit-label="Sign"
                        @submit="save" @cancel="close" />

          <div v-if="state.terms.active" class="form-check mt-3">
            <input class="form-check-input" type="checkbox" id="sign-terms" v-model="acceptTerms">
            <label class="form-check-label small" for="sign-terms">
              I accept the
              <a :href="termsUrl()" target="_blank" rel="noopener noreferrer">terms &amp; conditions</a>
              (v{{ state.terms.version }}).
            </label>
          </div>
          <p class="form-text">Confirms receipt of the items above.</p>

          <button type="button" class="btn btn-sm btn-outline-danger mt-2" :disabled="busy"
                  @click="declining = true">
            <i class="bi bi-x-circle"></i> Customer declines to sign
          </button>
        </template>

        <template v-else>
          <div class="trax-list-header">Declined</div>
          <p class="small text-secondary mb-2">Recorded on the booking with your name and the time.</p>
          <textarea class="form-control" rows="2" v-model="declineNote" maxlength="500"
                    placeholder="Reason (optional)" aria-label="Reason"></textarea>
          <div class="d-flex gap-2 mt-3">
            <button type="button" class="btn btn-outline-secondary" :disabled="busy" @click="declining = false">
              Back
            </button>
            <span class="flex-grow-1"></span>
            <button type="button" class="btn btn-danger" :disabled="busy" @click="decline">
              <span v-if="busy" class="spinner-border spinner-border-sm"></span>
              Record decline
            </button>
          </div>
        </template>
      </template>

      <div v-else class="trax-empty">
        <i class="bi bi-question-circle"></i>
        Booking not found.
      </div>
    </Drawer>
  `,
};
