import { ref, computed, onMounted, watch } from 'vue';
import {
  state, toast, invoicePing, invoiceCustomers, invoiceCustomerCreate, invoiceCreate, invoiceProjects, invoiceToProject,
} from '../store.js';
import { formatMoney } from '../lib/format.js';
import { HIRE_LABEL, isUncharged } from '../lib/rental.js';
import {
  buildInvoiceLines, bookingPeriod, isoDay, deDate, linesNet, linesGross, splitName, INVOICE_STATUS,
} from '../lib/invoice-lines.js';
import Drawer from './ui/Drawer.js';

/**
 * "Create invoice" for one booking (state.invoicePrompt).
 *
 * 1. Customer — picked from the Invoice app's customer list (search; an exact
 *    e-mail match is pre-selected), or created there from the booking's name
 *    and e-mail.
 * 2. Lines — priced like the rental quote PDF, editable before sending.
 * 3. Create — Invoice stores a DRAFT; the booking keeps the link.
 *
 * Invoice refuses a second live document for the same booking and answers
 * with the existing one; "Create another" (force) is offered only then.
 */
export default {
  name: 'InvoiceSheet',
  components: { Drawer },
  setup() {
    const booking = computed(() => state.bookings.find((b) => Number(b.id) === Number(state.invoicePrompt)) || null);
    const close = () => { state.invoicePrompt = null; };

    // --- Connection ---------------------------------------------------------
    const remote = ref(null);       // ping answer
    const remoteError = ref('');

    // --- Customer -----------------------------------------------------------
    const query = ref('');
    const results = ref([]);
    const searching = ref(false);
    const customer = ref(null);     // picked Invoice customer
    const creating = ref(false);    // "new customer" form open
    const draftCustomer = ref({});
    const savingCustomer = ref(false);

    const newCustomerFromBooking = () => {
      const b = booking.value || {};
      draftCustomer.value = {
        kind: 'person', company: '', ...splitName(b.customerName),
        email: b.customerEmail || '', phone: '', street: '', zip: '', city: '', country: 'DE',
      };
    };

    let searchTimer = null;
    const search = async (q = query.value, preselect = false) => {
      searching.value = true;
      try {
        const list = await invoiceCustomers(q, booking.value?.customerEmail || '');
        results.value = list;
        if (preselect && !customer.value) {
          const match = list.find((c) => c.emailMatch);
          if (match) customer.value = match;
        }
      } catch (error) {
        remoteError.value = error.message;
      } finally {
        searching.value = false;
      }
    };
    watch(query, (q) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => search(q), 250);
    });

    const createCustomer = async () => {
      const c = draftCustomer.value;
      if (c.kind === 'company' ? !c.company.trim() : !(c.last_name.trim() || c.first_name.trim())) {
        toast(c.kind === 'company' ? 'Company name is required.' : 'Name is required.', 'warning');
        return;
      }
      savingCustomer.value = true;
      try {
        customer.value = await invoiceCustomerCreate(c);
        creating.value = false;
        toast(`Customer ${customer.value.number} created in Invoice.`, 'success');
      } catch (error) {
        toast(error.message, 'danger', 8000);
      } finally {
        savingCustomer.value = false;
      }
    };

    // --- Lines --------------------------------------------------------------
    const proposal = ref(null);
    const lines = ref([]);
    const subject = ref('');
    const serviceFrom = ref('');
    const serviceTo = ref('');
    const notes = ref('');

    const rebuild = () => {
      if (!booking.value) return;
      proposal.value = buildInvoiceLines(booking.value, state.assets, state.settings);
      lines.value = proposal.value.lines.map((line) => ({ ...line }));
    };

    const addLine = () => lines.value.push({
      title: '', description: '', sku: '', quantity: 1, unit: 'C62',
      unit_price: 0, vat_rate: Number(state.settings?.invoice?.vatRate ?? 19), missing: false,
    });
    const removeLine = (index) => lines.value.splice(index, 1);

    const net = computed(() => linesNet(lines.value));
    const gross = computed(() => linesGross(lines.value));
    const currency = computed(() => proposal.value?.currency || 'EUR');
    const mixedCurrency = computed(() => (proposal.value?.currencies?.length || 0) > 1);
    const missing = computed(() => lines.value.filter((l) => l.missing && !(Number(l.unit_price) > 0)).length);
    const uncharged = computed(() => booking.value && isUncharged(booking.value.hire));

    // --- Submit -------------------------------------------------------------
    // --- Target: own invoice, or open posts in one of the customer's projects
    const projects = ref([]);
    const target = ref('invoice');  // 'invoice' | project id
    const loadingProjects = ref(false);
    watch(customer, async (c) => {
      projects.value = [];
      target.value = 'invoice';
      if (!c) return;
      loadingProjects.value = true;
      try { projects.value = await invoiceProjects(c.id); } catch { /* optional */ } finally { loadingProjects.value = false; }
    });
    const targetProject = computed(() => projects.value.find((p) => p.id === target.value) || null);

    const busy = ref(false);
    const result = ref(null);       // {created, duplicate, document}
    const existing = computed(() => booking.value?.invoice || null);

    const canSubmit = computed(() => !busy.value && customer.value && lines.value.some((l) => (l.title || '').trim()));

    const submit = async (force = false) => {
      if (!canSubmit.value) return;
      busy.value = true;
      try {
        const items = lines.value
          .filter((l) => (l.title || '').trim() || (l.description || '').trim())
          .map(({ missing: _m, ...line }) => ({
            ...line,
            quantity: Number(line.quantity) || 0,
            unit_price: Number(line.unit_price) || 0,
            vat_rate: Number(line.vat_rate) || 0,
          }));
        if (targetProject.value) {
          result.value = await invoiceToProject({ bookingId: booking.value.id, projectId: targetProject.value.id, items, date: serviceTo.value || serviceFrom.value, force });
          if (result.value?.created) toast(`Added to project ${targetProject.value.number}.`, 'success');
          return;
        }
        result.value = await invoiceCreate({
          bookingId: booking.value.id,
          customerId: customer.value.id,
          items,
          subject: subject.value.trim(),
          serviceFrom: serviceFrom.value,
          serviceTo: serviceTo.value,
          orderReference: `Booking #${booking.value.id}`,
          notes: notes.value.trim(),
          force,
        });
        if (result.value?.created) toast('Invoice draft created.', 'success');
      } catch {
        /* toast already raised by the store */
      } finally {
        busy.value = false;
      }
    };

    const openInInvoice = (url) => { if (url) window.open(url, '_blank', 'noopener'); };

    onMounted(async () => {
      if (!booking.value) return;
      const period = bookingPeriod(booking.value);
      serviceFrom.value = isoDay(period.from);
      serviceTo.value = isoDay(period.to);
      rebuild();
      newCustomerFromBooking();
      try {
        remote.value = await invoicePing();
      } catch (error) {
        remoteError.value = error.message;
        return;
      }
      const prefix = remote.value?.subjectPrefix || 'Miete';
      const a = deDate(period.from);
      const b = deDate(period.to);
      subject.value = `${prefix} ${a}${b && b !== a ? ` – ${b}` : ''} · Booking #${booking.value.id}`;
      search('', true);
    });

    return {
      booking, close, remote, remoteError,
      query, results, searching, customer, creating, draftCustomer, savingCustomer, createCustomer, newCustomerFromBooking,
      proposal, lines, subject, serviceFrom, serviceTo, notes, addLine, removeLine, rebuild,
      net, gross, currency, mixedCurrency, missing, uncharged,
      busy, result, existing, canSubmit, submit, openInInvoice, projects, target, targetProject, loadingProjects,
      state, formatMoney, HIRE_LABEL, INVOICE_STATUS,
    };
  },
  template: `
    <Drawer v-if="booking" wide icon="bi-receipt" :title="'Invoice · ' + (booking.customerName || 'Booking #' + booking.id)" @close="close">
      <p class="text-secondary small mb-3">
        Booking #{{ booking.id }} · {{ HIRE_LABEL[booking.hire] || booking.hire }}
        <span v-if="proposal"> · {{ proposal.days }} day{{ proposal.days === 1 ? '' : 's' }}</span>
        <span v-if="remote"> · Invoice: {{ remote.company || remote.app }}</span>
      </p>

      <div v-if="remoteError" class="alert alert-danger py-2 px-3 small">
        <i class="bi bi-x-circle"></i> {{ remoteError }}
      </div>

      <!-- Done -->
      <template v-if="result">
        <div class="alert py-2 px-3 small" :class="result.created ? 'alert-success' : 'alert-warning'">
          <template v-if="result.created && result.document.kind === 'project'">
            <i class="bi bi-check-circle"></i> Added as open posts to project
            <strong>{{ result.document.project_number }}</strong> ({{ formatMoney(result.document.net, result.document.currency) }} net).
            Bill it there together with times, trips and material.
          </template>
          <template v-else-if="result.created">
            <i class="bi bi-check-circle"></i> Draft created in Invoice
            ({{ formatMoney(result.document.gross, result.document.currency) }} gross).
            Finalise, number and send it there.
          </template>
          <template v-else>
            <i class="bi bi-exclamation-triangle"></i> This booking is already billed in Invoice
            <strong>{{ result.document.kind === 'project' ? 'project ' + result.document.project_number : (result.document.number || 'Draft #' + result.document.id) }}</strong>
            ({{ INVOICE_STATUS[result.document.status]?.label || result.document.status }}).
            Nothing new was created.
          </template>
        </div>
        <div class="d-flex flex-wrap gap-2">
          <button class="btn btn-primary btn-sm" @click="openInInvoice(result.document.url)">
            <i class="bi bi-box-arrow-up-right"></i> Open in Invoice
          </button>
          <button v-if="result.duplicate" class="btn btn-outline-danger btn-sm" :disabled="busy" @click="submit(true)">
            Create another anyway
          </button>
          <button class="btn btn-outline-secondary btn-sm" @click="close">Close</button>
        </div>
      </template>

      <template v-else-if="!remoteError">
        <div v-if="existing" class="alert alert-info py-2 px-3 small d-flex align-items-center gap-2">
          <i class="bi bi-info-circle"></i>
          <span class="flex-grow-1">Already invoiced: <strong>{{ existing.kind === 'project' ? 'project ' + existing.projectNumber : (existing.number || 'Draft #' + existing.docId) }}</strong>
            · {{ INVOICE_STATUS[existing.status]?.label || existing.status }}</span>
          <button class="btn btn-sm btn-outline-primary" @click="openInInvoice(existing.url)">Open</button>
        </div>
        <div v-if="uncharged" class="alert alert-warning py-2 px-3 small">
          <i class="bi bi-exclamation-triangle"></i> {{ HIRE_LABEL[booking.hire] }} — the rates price this at 0. Enter prices below if it should be charged.
        </div>

        <!-- 1. Customer -->
        <div class="trax-list-header">1 · Customer in Invoice</div>
        <div v-if="customer && !creating" class="trax-list">
          <div class="trax-row">
            <span class="flex-grow-1">
              <strong>{{ customer.name }}</strong> <span class="text-secondary small">{{ customer.number }}</span>
              <span class="d-block small text-secondary">{{ [customer.email, [customer.zip, customer.city].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || '—' }}</span>
            </span>
            <span v-if="customer.emailMatch" class="badge text-bg-success me-2">e-mail match</span>
            <button class="btn btn-sm btn-outline-secondary" @click="customer = null">Change</button>
          </div>
        </div>

        <template v-else-if="!creating">
          <div class="input-group input-group-sm mb-2">
            <span class="input-group-text"><i class="bi bi-search"></i></span>
            <input class="form-control" v-model="query" placeholder="Search name, number, e-mail, city" autocomplete="off">
            <span v-if="searching" class="input-group-text"><span class="spinner-border spinner-border-sm"></span></span>
          </div>
          <div class="trax-list" style="max-height: 16rem; overflow-y: auto;">
            <button v-for="c in results" :key="c.id" type="button" class="trax-row w-100 text-start border-0 bg-transparent" @click="customer = c">
              <span class="flex-grow-1">
                <strong>{{ c.name }}</strong> <span class="text-secondary small">{{ c.number }}</span>
                <span class="d-block small text-secondary">{{ [c.email, [c.zip, c.city].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || '—' }}</span>
              </span>
              <span v-if="c.emailMatch" class="badge text-bg-success">e-mail match</span>
            </button>
            <div v-if="!results.length && !searching" class="trax-row text-secondary small">No customers found.</div>
          </div>
          <button class="btn btn-sm btn-outline-primary mt-2" @click="newCustomerFromBooking(); creating = true">
            <i class="bi bi-person-plus"></i> New customer in Invoice
          </button>
        </template>

        <div v-else class="trax-list p-3">
          <div class="btn-group btn-group-sm mb-3" role="group">
            <button type="button" class="btn" :class="draftCustomer.kind === 'person' ? 'btn-primary' : 'btn-outline-primary'" @click="draftCustomer.kind = 'person'">Person</button>
            <button type="button" class="btn" :class="draftCustomer.kind === 'company' ? 'btn-primary' : 'btn-outline-primary'" @click="draftCustomer.kind = 'company'">Company</button>
          </div>
          <div class="row g-2">
            <div v-if="draftCustomer.kind === 'company'" class="col-12">
              <label class="form-label small mb-1">Company</label>
              <input class="form-control form-control-sm" v-model="draftCustomer.company" maxlength="200">
            </div>
            <div class="col-sm-6">
              <label class="form-label small mb-1">First name</label>
              <input class="form-control form-control-sm" v-model="draftCustomer.first_name" maxlength="100">
            </div>
            <div class="col-sm-6">
              <label class="form-label small mb-1">Last name</label>
              <input class="form-control form-control-sm" v-model="draftCustomer.last_name" maxlength="100">
            </div>
            <div class="col-sm-6">
              <label class="form-label small mb-1">E-mail</label>
              <input class="form-control form-control-sm" type="email" v-model="draftCustomer.email" maxlength="200">
            </div>
            <div class="col-sm-6">
              <label class="form-label small mb-1">Phone</label>
              <input class="form-control form-control-sm" v-model="draftCustomer.phone" maxlength="60">
            </div>
            <div class="col-12">
              <label class="form-label small mb-1">Street</label>
              <input class="form-control form-control-sm" v-model="draftCustomer.street" maxlength="200">
            </div>
            <div class="col-4 col-sm-3">
              <label class="form-label small mb-1">ZIP</label>
              <input class="form-control form-control-sm" v-model="draftCustomer.zip" maxlength="20">
            </div>
            <div class="col-8 col-sm-6">
              <label class="form-label small mb-1">City</label>
              <input class="form-control form-control-sm" v-model="draftCustomer.city" maxlength="100">
            </div>
            <div class="col-sm-3">
              <label class="form-label small mb-1">Country</label>
              <input class="form-control form-control-sm text-uppercase" v-model="draftCustomer.country" maxlength="2">
            </div>
          </div>
          <div class="d-flex gap-2 mt-3">
            <button class="btn btn-sm btn-primary" :disabled="savingCustomer" @click="createCustomer">
              <span v-if="savingCustomer" class="spinner-border spinner-border-sm me-1"></span>Create in Invoice
            </button>
            <button class="btn btn-sm btn-outline-secondary" @click="creating = false">Cancel</button>
          </div>
          <p class="small text-secondary mt-2 mb-0">The address is needed for a valid invoice; it can also be completed in Invoice later.</p>
        </div>

        <!-- Target -->
        <template v-if="customer && !creating && (projects.length || loadingProjects)">
          <div class="trax-list-header mt-3">Bill as</div>
          <div class="trax-list">
            <label class="trax-row">
              <input class="form-check-input me-2" type="radio" value="invoice" v-model="target">
              <span class="flex-grow-1">Own invoice <span class="d-block small text-secondary">Draft in Invoice for this booking only</span></span>
            </label>
            <label v-for="p in projects" :key="p.id" class="trax-row">
              <input class="form-check-input me-2" type="radio" :value="p.id" v-model="target">
              <span class="flex-grow-1">Posts in project <strong>{{ p.number }}</strong> · {{ p.name }}
                <span class="d-block small text-secondary">Billed later with the project's times, trips and material</span></span>
            </label>
            <div v-if="loadingProjects" class="trax-row small text-secondary"><span class="spinner-border spinner-border-sm me-2"></span>Loading projects…</div>
          </div>
        </template>

        <!-- 2. Lines -->
        <div class="trax-list-header mt-3">
          2 · Lines
          <span class="ms-auto fw-normal small">net · {{ state.settings.invoice.pricesIncludeVat ? 'converted from gross rates' : 'rates are net' }}</span>
        </div>
        <div v-if="mixedCurrency" class="alert alert-warning py-2 px-3 small">
          <i class="bi bi-exclamation-triangle"></i> The gear is priced in several currencies; Invoice bills in one. Check the prices.
        </div>
        <div v-if="missing" class="alert alert-warning py-2 px-3 small">
          <i class="bi bi-exclamation-triangle"></i> {{ missing }} line{{ missing === 1 ? ' has' : 's have' }} no rate or value — enter a price.
        </div>
        <div class="trax-list">
          <div v-for="(line, i) in lines" :key="i" class="trax-row d-block py-2">
            <div class="d-flex gap-2 align-items-start">
              <div class="flex-grow-1">
                <input class="form-control form-control-sm fw-semibold mb-1" v-model="line.title" placeholder="Title" maxlength="300">
                <textarea class="form-control form-control-sm small" rows="2" v-model="line.description" placeholder="Description" maxlength="4000"></textarea>
              </div>
              <button class="btn btn-sm btn-link text-danger p-1" title="Remove line" aria-label="Remove line" @click="removeLine(i)"><i class="bi bi-trash"></i></button>
            </div>
            <div class="d-flex flex-wrap gap-2 mt-2 align-items-center small">
              <label class="d-flex align-items-center gap-1">Qty
                <input class="form-control form-control-sm text-end" style="width: 5rem" type="number" step="any" v-model.number="line.quantity"></label>
              <label class="d-flex align-items-center gap-1">Price (net)
                <input class="form-control form-control-sm text-end" :class="{ 'is-invalid': line.missing && !(line.unit_price > 0) }" style="width: 7rem" type="number" step="0.01" v-model.number="line.unit_price"></label>
              <label class="d-flex align-items-center gap-1">VAT %
                <input class="form-control form-control-sm text-end" style="width: 4.5rem" type="number" step="any" min="0" max="100" v-model.number="line.vat_rate"></label>
              <span class="ms-auto fw-semibold">{{ formatMoney((Number(line.quantity) || 0) * (Number(line.unit_price) || 0), currency) }}</span>
            </div>
          </div>
          <div v-if="!lines.length" class="trax-row text-secondary small">No lines.</div>
        </div>
        <div class="d-flex gap-2 mt-2">
          <button class="btn btn-sm btn-outline-secondary" @click="addLine"><i class="bi bi-plus-lg"></i> Line</button>
          <button class="btn btn-sm btn-link" @click="rebuild">Reset to rental prices</button>
        </div>

        <!-- 3. Document -->
        <div class="trax-list-header mt-3">3 · Document</div>
        <div class="trax-list p-3">
          <div class="row g-2">
            <div v-if="!targetProject" class="col-12">
              <label class="form-label small mb-1">Subject</label>
              <input class="form-control form-control-sm" v-model="subject" maxlength="300">
            </div>
            <div class="col-6">
              <label class="form-label small mb-1">Service from</label>
              <input class="form-control form-control-sm" type="date" v-model="serviceFrom">
            </div>
            <div class="col-6">
              <label class="form-label small mb-1">Service to</label>
              <input class="form-control form-control-sm" type="date" v-model="serviceTo">
            </div>
            <div v-if="!targetProject" class="col-12">
              <label class="form-label small mb-1">Internal note <span class="text-secondary">(not printed)</span></label>
              <input class="form-control form-control-sm" v-model="notes" maxlength="2000">
            </div>
          </div>
        </div>
        <div class="trax-list mt-3">
          <div class="trax-kv"><span>Net</span><strong>{{ formatMoney(net, currency) }}</strong></div>
          <div class="trax-kv"><span>Gross (estimate)</span><strong>{{ formatMoney(gross, currency) }}</strong></div>
        </div>
        <p class="small text-secondary mt-2">Invoice recalculates the totals (e.g. small-business or reverse-charge customers) and keeps it as a draft.</p>
      </template>

      <template v-if="!result && !remoteError" #footer>
        <span class="small text-secondary">{{ customer ? customer.name : 'Pick a customer' }}</span>
        <span class="flex-grow-1"></span>
        <button class="btn btn-sm btn-outline-secondary" @click="close">Cancel</button>
        <button class="btn btn-sm btn-primary" :disabled="!canSubmit" @click="submit(false)">
          <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
          <i v-else class="bi bi-receipt"></i> {{ targetProject ? 'Add to ' + targetProject.number : 'Create invoice draft' }}
        </button>
      </template>
    </Drawer>
  `,
};
