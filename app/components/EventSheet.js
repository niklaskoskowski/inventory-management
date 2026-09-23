import { ref, computed, watch } from 'vue';
import { state, saveEvent, deleteEvent, toast } from '../store.js';
import { toLocalInput } from '../lib/format.js';
import { eventSettings } from '../lib/events.js';
import Drawer from './ui/Drawer.js';
import ConfirmDialog from './ui/ConfirmDialog.js';

/**
 * Create or edit one event.
 *
 * A drawer rather than a page, like the asset sheet: it is "edit this one
 * record and close". What is BOOKED on the event is not edited here — gear
 * reaches an event by being checked out or reserved against it, and a second
 * place to change that would be a second truth.
 */
const BLANK = {
  name: '', client: '', location: '', contact: '',
  startAt: '', endAt: '', status: '', notes: '',
};

export default {
  name: 'EventSheet',
  components: { Drawer, ConfirmDialog },
  props: {
    // null (or 0) means "new event".
    eventId: { type: Number, default: null },
  },
  emits: ['close', 'saved'],
  setup(props, { emit }) {
    const form = ref({ ...BLANK });
    const saving = ref(false);
    const confirmDelete = ref(false);

    const workflow = computed(() => eventSettings(state.settings));
    const event = computed(
      () => (props.eventId ? state.events.find((row) => row.id === props.eventId) || null : null),
    );
    const isNew = computed(() => !props.eventId);

    watch(
      event,
      (value) => {
        form.value = value
          ? {
            name: value.name,
            client: value.client,
            location: value.location,
            contact: value.contact,
            // Stored as instants; the inputs are datetime-local, so they go
            // through the same conversion the reservation window does.
            startAt: toLocalInput(value.startAt) || '',
            endAt: toLocalInput(value.endAt) || '',
            status: value.status,
            notes: value.notes,
          }
          : { ...BLANK, status: workflow.value.defaultStatus };
      },
      { immediate: true },
    );

    /** Everything booked against this event right now — read-only context. */
    const booked = computed(() => {
      const id = Number(props.eventId);
      if (!id) return { lines: 0, units: 0, reservations: 0 };
      const lines = state.checkouts.filter((line) => Number(line.eventId) === id);
      return {
        lines: lines.length,
        units: lines.reduce((sum, line) => sum + Math.max(1, Number(line.qty) || 1), 0),
        reservations: state.reservations.filter((row) => Number(row.eventId) === id).length,
      };
    });

    const save = async () => {
      if (!form.value.name.trim()) {
        toast('An event needs a name.', 'warning');
        return;
      }
      if (form.value.startAt && form.value.endAt && form.value.endAt < form.value.startAt) {
        toast('The event cannot end before it starts.', 'warning');
        return;
      }

      saving.value = true;
      try {
        const data = await saveEvent({
          id: props.eventId || undefined,
          ...form.value,
          // An empty box is "no date yet", which is a real answer for an event
          // that is pencilled in before anything is fixed.
          startAt: form.value.startAt || null,
          endAt: form.value.endAt || null,
        });
        toast(isNew.value ? `Created "${form.value.name}".` : 'Event saved.', 'success');
        emit('saved', data?.id ?? props.eventId);
        emit('close');
      } catch {
        /* toast already raised by the store */
      } finally {
        saving.value = false;
      }
    };

    const remove = async () => {
      confirmDelete.value = false;
      try {
        const data = await deleteEvent(props.eventId);
        const cleared = Number(data?.cleared) || 0;
        toast(
          cleared
            ? `Event deleted. ${cleared} booking(s) no longer name it.`
            : 'Event deleted.',
          'success',
        );
        emit('close');
      } catch {
        /* toast already raised */
      }
    };

    return {
      state, form, saving, confirmDelete, workflow, event, isNew, booked,
      save, remove, emit,
    };
  },
  template: `
    <Drawer :title="isNew ? 'New event' : (event?.name || 'Event')" icon="bi-calendar-event"
            @close="emit('close')">
      <template #header-actions>
        <span v-if="!isNew" class="text-secondary small">#{{ eventId }}</span>
      </template>

      <form @submit.prevent="save">
        <div class="row g-3">
          <div class="col-12">
            <label class="form-label small" for="f-ev-name">Name</label>
            <input id="f-ev-name" class="form-control form-control-sm" data-autofocus
                   v-model="form.name" required maxlength="200"
                   placeholder="e.g. Sommerfestival 2026">
          </div>

          <div class="col-12 col-md-6">
            <label class="form-label small" for="f-ev-client">Client</label>
            <input id="f-ev-client" class="form-control form-control-sm"
                   v-model="form.client" maxlength="200">
          </div>
          <div class="col-12 col-md-6">
            <label class="form-label small" for="f-ev-status">Status</label>
            <select id="f-ev-status" class="form-select form-select-sm" v-model="form.status">
              <option v-for="status in workflow.statuses" :key="status.id" :value="status.id">
                {{ status.label }}
              </option>
            </select>
            <div class="form-text small">
              Where the job is. Edit the workflow under Settings → Events.
            </div>
          </div>

          <div class="col-12 col-md-6">
            <label class="form-label small" for="f-ev-start">Starts</label>
            <input id="f-ev-start" type="datetime-local" class="form-control form-control-sm"
                   v-model="form.startAt">
          </div>
          <div class="col-12 col-md-6">
            <label class="form-label small" for="f-ev-end">Ends</label>
            <input id="f-ev-end" type="datetime-local" class="form-control form-control-sm"
                   v-model="form.endAt">
          </div>

          <div class="col-12 col-md-6">
            <label class="form-label small" for="f-ev-location">Location</label>
            <input id="f-ev-location" class="form-control form-control-sm"
                   v-model="form.location" maxlength="200">
          </div>
          <div class="col-12 col-md-6">
            <label class="form-label small" for="f-ev-contact">On-site contact</label>
            <input id="f-ev-contact" class="form-control form-control-sm"
                   v-model="form.contact" maxlength="200"
                   placeholder="Name, phone, whatever gets you through">
          </div>

          <div class="col-12">
            <label class="form-label small" for="f-ev-notes">Notes</label>
            <textarea id="f-ev-notes" class="form-control form-control-sm" rows="3"
                      v-model="form.notes"></textarea>
          </div>
        </div>
      </form>

      <!-- What is on the job. Read-only on purpose: gear reaches an event by
           being checked out or reserved against it. -->
      <div v-if="!isNew" class="trax-card mt-3">
        <div class="trax-card-pad">
          <h3 class="trax-page-title">On this job</h3>
          <p class="small text-secondary mb-0">
            <strong>{{ booked.units }}</strong> unit(s) out on
            <strong>{{ booked.lines }}</strong> line(s) ·
            <strong>{{ booked.reservations }}</strong> reservation(s).
            Gear joins a job from the selection drawer, by picking this event when checking out or
            reserving — deleting the event here never takes the gear with it.
          </p>
        </div>
      </div>

      <template #footer>
        <button v-if="!isNew" class="btn btn-sm btn-outline-danger" @click="confirmDelete = true">
          <i class="bi bi-trash"></i> Delete
        </button>
        <span class="flex-grow-1"></span>
        <button class="btn btn-sm btn-outline-secondary" @click="emit('close')">Cancel</button>
        <button class="btn btn-sm btn-primary" :disabled="saving" @click="save">
          <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>
          {{ isNew ? 'Create event' : 'Save' }}
        </button>
      </template>
    </Drawer>

    <ConfirmDialog v-if="confirmDelete"
                   title="Delete this event?"
                   :message="booked.lines || booked.reservations
                     ? 'The gear stays exactly where it is — ' + booked.lines + ' checkout line(s) and '
                       + booked.reservations + ' reservation(s) simply stop naming this job.'
                     : 'Nothing is booked on it, so nothing else changes.'"
                   confirm-label="Delete" danger
                   @confirm="remove" @cancel="confirmDelete = false" />
  `,
};
