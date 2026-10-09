import { ref, computed, watch } from 'vue';
import { state, saveEvent, deleteEvent, toast } from '../store.js';
import { toLocalInput } from '../lib/format.js';
import { eventSettings } from '../lib/events.js';
import Drawer from './ui/Drawer.js';
import ConfirmDialog from './ui/ConfirmDialog.js';
import Menu from './ui/Menu.js';

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
  components: { Drawer, ConfirmDialog, Menu },
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
        <span v-if="!isNew" class="text-secondary small font-monospace">#{{ eventId }}</span>
      </template>

      <!-- What is on the job. Read-only: gear joins an event by being checked
           out or reserved against it. -->
      <div v-if="!isNew" class="trax-list mb-3"
           title="Gear joins a job when it is checked out or reserved for this event">
        <div class="trax-kv">
          <span>On this job</span>
          <strong class="fw-normal">
            <b>{{ booked.units }}</b> unit(s) on {{ booked.lines }} line(s) · <b>{{ booked.reservations }}</b> reserv.
          </strong>
        </div>
      </div>

      <form class="trax-form" @submit.prevent="save">
        <div class="trax-group">
          <div class="row g-2">
            <div class="col-12">
              <label class="form-label" for="f-ev-name">Name</label>
              <input id="f-ev-name" class="form-control" data-autofocus="desktop"
                     v-model="form.name" required maxlength="200"
                     placeholder="e.g. Summer festival 2026">
            </div>
            <div class="col-6">
              <label class="form-label" for="f-ev-client">Client</label>
              <input id="f-ev-client" class="form-control"
                     v-model="form.client" maxlength="200">
            </div>
            <div class="col-6">
              <label class="form-label" for="f-ev-status">Status</label>
              <select id="f-ev-status" class="form-select" v-model="form.status"
                      title="Edit the workflow under Settings → Events">
                <option v-for="status in workflow.statuses" :key="status.id" :value="status.id">
                  {{ status.label }}
                </option>
              </select>
            </div>
          </div>
        </div>

        <div class="trax-group">
          <div class="trax-group-title">When</div>
          <div class="row g-2">
            <div class="col-12 col-sm-6">
              <label class="form-label" for="f-ev-start">Starts</label>
              <input id="f-ev-start" type="datetime-local" class="form-control"
                     v-model="form.startAt">
            </div>
            <div class="col-12 col-sm-6">
              <label class="form-label" for="f-ev-end">Ends</label>
              <input id="f-ev-end" type="datetime-local" class="form-control"
                     v-model="form.endAt">
            </div>
          </div>
        </div>

        <div class="trax-group">
          <div class="trax-group-title">Where</div>
          <div class="row g-2">
            <div class="col-6">
              <label class="form-label" for="f-ev-location">Location</label>
              <input id="f-ev-location" class="form-control"
                     v-model="form.location" maxlength="200">
            </div>
            <div class="col-6">
              <label class="form-label" for="f-ev-contact">On-site contact</label>
              <input id="f-ev-contact" class="form-control"
                     v-model="form.contact" maxlength="200" placeholder="Name, phone">
            </div>
          </div>
        </div>

        <div class="trax-group">
          <label class="trax-group-title" for="f-ev-notes">Notes</label>
          <textarea id="f-ev-notes" class="form-control" rows="3" v-model="form.notes"></textarea>
        </div>
      </form>

      <template #footer>
        <Menu v-if="!isNew" label="More actions" icon="bi-three-dots" up align="start"
              button-class="btn btn-outline-secondary">
          <button type="button" class="trax-menu-item is-danger" @click="confirmDelete = true">
            <i class="bi bi-trash"></i> Delete event
          </button>
        </Menu>
        <span class="flex-grow-1"></span>
        <button class="btn btn-outline-secondary" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="saving" @click="save">
          <span v-if="saving" class="spinner-border spinner-border-sm me-1"></span>
          {{ isNew ? 'Create' : 'Save' }}
        </button>
      </template>
    </Drawer>

    <ConfirmDialog v-if="confirmDelete"
                   title="Delete this event?"
                   :message="booked.lines || booked.reservations
                     ? 'The gear stays put. ' + booked.lines + ' checkout line(s) and '
                       + booked.reservations + ' reservation(s) stop naming this job.'
                     : 'Nothing is booked on it.'"
                   confirm-label="Delete" danger
                   @confirm="remove" @cancel="confirmDelete = false" />
  `,
};
