import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import {
  state, toast, signBooking, declineSignature, termsUrl, privacyUrl, getAsset, load,
} from '../store.js';
import * as api from '../api.js';
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

    // One tick for both documents: the terms are accepted and the privacy
    // notice acknowledged in the same step, whichever of them is published.
    const legalActive = computed(() => Boolean(state.terms.active || state.privacy?.active));
    const locked = computed(() => (legalActive.value && !acceptTerms.value
      ? (state.terms.active ? 'Accept the terms first.' : 'Acknowledge the privacy notice first.') : ''));

    const close = () => { state.signPrompt = null; };

    const save = async (blob) => {
      if (!booking.value) return;
      busy.value = true;
      try {
        await signBooking(booking.value.id, name.value.trim(), blob,
          state.terms.active ? state.terms.version : null,
          state.privacy?.active ? state.privacy.version : null);
        toast('Signed.', 'success');
        close();
      } catch {
        /* toast already raised by the store */
      } finally {
        busy.value = false;
      }
    };

    // --- Sign on a phone ---------------------------------------------------
    // A desktop with a mouse cannot take a signature, so the dialog also shows
    // a QR code: the customer scans it, ticks the terms and signs on their
    // phone (sign.php). The strokes show up here while they draw; when they
    // press "Sign" there, the signature is stored and this dialog closes.
    const finePointer = typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const phone = ref({ token: '', url: '', qr: '', status: 'idle', strokes: [], aspect: 2.2, error: '' });
    const live = ref(null);
    let pollTimer = null;
    let lastSeq = -1;

    const drawLive = () => {
      const canvas = live.value;
      if (!canvas) return;
      const width = canvas.clientWidth || 240;
      const height = width / Math.max(0.5, phone.value.aspect);
      const ratio = window.devicePixelRatio || 1;
      canvas.style.height = `${height}px`;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#111827'; ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const s of phone.value.strokes) {
        if (!s.length) continue;
        ctx.beginPath();
        ctx.moveTo(s[0].x * width, s[0].y * height);
        if (s.length === 1) ctx.lineTo(s[0].x * width + 0.1, s[0].y * height);
        for (let i = 1; i < s.length; i += 1) ctx.lineTo(s[i].x * width, s[i].y * height);
        ctx.stroke();
      }
    };

    const stopPolling = () => { clearTimeout(pollTimer); pollTimer = null; };

    const poll = async () => {
      if (!phone.value.token) return;
      try {
        const body = await api.get('sign.poll', { token: phone.value.token });
        const data = body.data || {};
        if (data.status === 'done') {
          stopPolling();
          phone.value.status = 'done';
          toast('Signed on the phone.', 'success');
          await load();
          close();
          return;
        }
        if (data.status === 'gone' || data.status === 'cancelled') {
          stopPolling();
          phone.value.status = 'gone';
          return;
        }
        phone.value.status = data.status;
        if (data.seq !== lastSeq) {
          lastSeq = data.seq;
          phone.value.strokes = data.strokes || [];
          phone.value.aspect = data.aspect || 2.2;
          await nextTick();
          drawLive();
        }
      } catch { /* a missed poll is retried */ }
      pollTimer = setTimeout(poll, 700);
    };

    const startPhone = async () => {
      if (!booking.value) return;
      stopPolling();
      lastSeq = -1;
      phone.value = { token: '', url: '', qr: '', status: 'loading', strokes: [], aspect: 2.2, error: '' };
      try {
        const body = await api.post('sign.start', { bookingId: booking.value.id });
        const data = body.data || {};
        phone.value = { ...phone.value, token: data.token, url: data.url, qr: data.qr, status: 'open' };
        pollTimer = setTimeout(poll, 700);
      } catch (error) {
        phone.value = { ...phone.value, status: 'error', error: error.message };
      }
    };

    const cancelPhone = () => {
      stopPolling();
      const { token, status } = phone.value;
      if (token && status !== 'done' && status !== 'gone') {
        api.post('sign.cancel', { token }).catch(() => {});
      }
    };

    onMounted(() => { if (finePointer) startPhone(); });
    onBeforeUnmount(cancelPhone);
    watch(() => state.signPrompt, (now, before) => {
      if (now && now !== before && finePointer) { cancelPhone(); startPhone(); }
    });

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
      close, save, decline, termsUrl, privacyUrl, legalActive, formatDateTime,
      finePointer, phone, live, startPhone,
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

          <!-- On a desktop: scan and sign on a phone. The drawing appears here live. -->
          <template v-if="finePointer">
            <div class="trax-list-header">Sign on a phone</div>
            <div class="trax-phone-sign">
              <template v-if="phone.status === 'signing'">
                <canvas ref="live" class="trax-phone-live" aria-label="Signature, live from the phone"></canvas>
                <div class="trax-phone-note"><span class="trax-live-dot"></span> Signing on the phone …</div>
              </template>
              <template v-else-if="phone.status === 'open' && phone.qr">
                <img :src="phone.qr" class="trax-phone-qr" alt="QR code to sign on a phone" width="148" height="148">
                <div class="trax-phone-note">
                  Scan with the customer's phone. They tick the terms and sign there — it shows up here and saves itself.
                  <a :href="phone.url" target="_blank" rel="noopener noreferrer" class="d-block small mt-1 text-truncate">{{ phone.url }}</a>
                </div>
              </template>
              <template v-else-if="phone.status === 'gone' || phone.status === 'error'">
                <div class="trax-phone-note">
                  {{ phone.status === 'gone' ? 'The QR code expired.' : phone.error }}
                  <button type="button" class="btn btn-sm btn-outline-secondary ms-2" @click="startPhone">New QR code</button>
                </div>
              </template>
              <div v-else class="trax-phone-note"><span class="spinner-border spinner-border-sm"></span></div>
            </div>
          </template>

          <div class="trax-list-header">{{ finePointer ? 'Or sign here' : 'Signature' }}</div>
          <SignaturePad :busy="busy" :locked="locked" cancel-label="Later" submit-label="Sign"
                        @submit="save" @cancel="close" />

          <div v-if="legalActive" class="form-check mt-3">
            <input class="form-check-input" type="checkbox" id="sign-terms" v-model="acceptTerms">
            <label class="form-check-label small" for="sign-terms">
              <template v-if="state.terms.active">
                I accept the
                <a :href="termsUrl()" target="_blank" rel="noopener noreferrer">terms &amp; conditions</a>
                (v{{ state.terms.version }})<template v-if="state.privacy?.active"> and </template><template v-else>.</template>
              </template>
              <template v-if="state.privacy?.active">
                {{ state.terms.active ? 'have' : 'I have' }} read the
                <a :href="privacyUrl()" target="_blank" rel="noopener noreferrer">privacy notice</a>
                (v{{ state.privacy.version }}).
              </template>
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
