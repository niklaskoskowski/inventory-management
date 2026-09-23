import { ref, computed, watch } from 'vue';
import {
  state, settings, taxonomyUsage, mutate, toast, saveTerms, previewTerms, termsUrl,
} from '../store.js';
import * as api from '../api.js';
import { formatMoney, formatDateTime } from '../lib/format.js';
import {
  BLANK_RULE, daysLabel, formatPercent, serviceFactorOf, tierFor,
} from '../lib/rental.js';
import { BLANK_RULE as BLANK_INSPECTION } from '../lib/inspection.js';
import { DEFAULT_STATUSES } from '../lib/events.js';
import ConfirmDialog from './ui/ConfirmDialog.js';
import RentalRate from './RentalRate.js';

/**
 * Runtime settings, and the taxonomy editor that goes with them.
 *
 * A view rather than a drawer: it is navigable, list-shaped and has four
 * sections, none of which is "edit this one record and close".
 *
 * Everything is edited in a local draft and sent as a patch of the fields that
 * actually changed. Saving on every keystroke would mean a write, a full
 * snapshot and a history entry per typed character.
 */

const SECTIONS = [
  { id: 'taxonomy', label: 'Taxonomy', icon: 'bi-tags' },
  { id: 'rental', label: 'Rental rates', icon: 'bi-cash-coin' },
  { id: 'inspection', label: 'Inspections', icon: 'bi-clipboard-check' },
  { id: 'events', label: 'Events', icon: 'bi-calendar-event' },
  { id: 'email', label: 'Email', icon: 'bi-envelope' },
  { id: 'branding', label: 'Branding', icon: 'bi-palette' },
  { id: 'terms', label: 'Terms', icon: 'bi-file-earmark-text' },
  { id: 'defaults', label: 'Defaults & automation', icon: 'bi-sliders' },
  { id: 'account', label: 'Account', icon: 'bi-person-lock' },
  { id: 'authentication', label: 'Authentication', icon: 'bi-shield-lock' },
];

/** The two ways in. Mirrors TRAX_AUTH_MODE in lib/config.php. */
const AUTH_MODES = [
  {
    value: 'builtin',
    label: 'Built-in login',
    note: 'This app keeps the accounts and shows its own sign-in form at login.php.',
  },
  {
    value: 'external',
    label: 'External auth include',
    note: 'A PHP file already on this server signs people in. It is included on every admin and API request.',
  },
];

/** kind is what the API wants; key is what taxonomyUsage returns it under. */
const TAXONOMIES = [
  { kind: 'category', key: 'categories', label: 'Categories', icon: 'bi-folder2' },
  { kind: 'location', key: 'locations', label: 'Locations', icon: 'bi-geo-alt' },
  { kind: 'tag', key: 'tags', label: 'Tags', icon: 'bi-tag' },
];

// Grouped so the two very different audiences read apart: one set fires when an
// operator acts, the other only when cron.php runs.
const CUSTOMER_MAIL = [
  { key: 'sendCheckoutConfirmation', label: 'Checkout confirmation', note: 'Sent to the customer when items go out.' },
  { key: 'sendReservationConfirmation', label: 'Reservation confirmation', note: 'Sent when a reservation is booked.' },
  { key: 'sendExtend', label: 'Extension confirmed', note: 'Sent when a due date moves.' },
  { key: 'sendCheckin', label: 'Return receipt', note: 'Sent when items come back.' },
];

const CRON_MAIL = [
  { key: 'sendDueSoon', label: 'Due-soon reminder', note: 'To the customer, before the due date.' },
  { key: 'sendOverdue', label: 'Overdue reminder', note: 'To the customer, repeatedly, after it.' },
  { key: 'sendOwnerDigest', label: 'Owner digest', note: 'The daily summary to the owner address.' },
];

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/**
 * Suggestions for the locale field, not a whitelist. It is a <datalist>, so
 * anything Intl accepts can still be typed — a fixed <select> would lock out
 * every operator whose language is not one of four.
 */
const LOCALES = ['en-US', 'en-GB', 'de-DE', 'fr-FR'];

const clone = (value) => JSON.parse(JSON.stringify(value));

const EMPTY_TEMPLATE = { subject: '', body: '' };

/**
 * Expands {{token}} for the preview.
 *
 * The same rule the server renders with: exact "{{name}}", one pass, and a
 * placeholder that is not a token of this template is left standing — which is
 * what the operator would actually receive, so the preview shows it too.
 */
const expandTokens = (text, sample) =>
  String(text ?? '').replace(/\{\{([^{}]*)\}\}/g, (whole, name) =>
    (Object.prototype.hasOwnProperty.call(sample || {}, name) ? sample[name] : whole));

/**
 * Number inputs hand back strings, so a value retyped identically would look
 * changed. Compared against the stored value's type, not the draft's.
 */
const sameLeaf = (draftValue, storedValue) =>
  (typeof storedValue === 'number' ? Number(draftValue) === storedValue : draftValue === storedValue);

/**
 * The same question for a value that is a tree — the rental rates, whose leaves
 * sit inside objects and lists.
 *
 * Keys are sorted and numeric strings are read as numbers before comparing, so
 * a rate retyped identically is not "changed" and a rule rebuilt in a different
 * key order is not either. Comparison only: nothing here is what gets sent.
 */
const numeric = (value) => {
  if (Array.isArray(value)) return value.map(numeric);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = numeric(value[key]);
    return out;
  }
  if (typeof value === 'string') {
    const text = value.trim().replace(',', '.');
    if (text !== '' && Number.isFinite(Number(text))) return Number(text);
  }
  return value;
};

const sameValue = (draftValue, storedValue) =>
  (draftValue !== null && typeof draftValue === 'object'
    ? JSON.stringify(numeric(draftValue)) === JSON.stringify(numeric(storedValue))
    : sameLeaf(draftValue, storedValue));

export default {
  name: 'SettingsView',
  components: { ConfirmDialog, RentalRate },
  setup() {
    const section = ref('taxonomy');
    const busy = ref(false);

    // --- Mail templates ---
    // The registry rides in on bootstrap: labels, the built-in subject/body,
    // the tokens each mail takes and sample values for the preview. Read from
    // the server rather than duplicated here, so the help text, the preview and
    // "reset to default" cannot drift from what actually gets sent.
    const mailTemplates = computed(() => state.meta.mailTemplates || {});
    const templateKeys = computed(() => Object.keys(mailTemplates.value));
    const templateKey = ref('checkout');
    const subjectMax = computed(() => state.meta.mailSubjectMax || 200);
    const bodyMax = computed(() => state.meta.mailBodyMax || 8000);

    /** Per-field messages from the server's last refusal: key => field => text. */
    const templateErrors = ref({});

    /**
     * A draft that always has an entry for every template.
     *
     * The stored settings carry all eight, but DEFAULT_SETTINGS is empty until
     * the first snapshot lands and v-model needs something to bind to.
     */
    const withTemplates = (value) => {
      const next = clone(value);
      next.email = next.email || {};
      next.email.templates = next.email.templates || {};
      // Same reason as the templates: the form binds to it before the first
      // snapshot lands, and an undefined intermediate is a render error.
      next.rental = next.rental || {};
      next.rental.default = { ...clone(BLANK_RULE), ...(next.rental.default || {}) };
      next.rental.categories = Array.isArray(next.rental.categories) ? next.rental.categories : [];
      next.events = next.events || {};
      // The server ships the built-in workflow when an install has none, so an
      // empty list here only happens before the first snapshot lands.
      next.events.statuses = Array.isArray(next.events.statuses) && next.events.statuses.length
        ? next.events.statuses
        : clone(DEFAULT_STATUSES);
      next.events.defaultStatus = next.events.defaultStatus || next.events.statuses[0].id;
      next.events.enabled = next.events.enabled !== false;
      next.inspection = next.inspection || {};
      next.inspection.categories = Array.isArray(next.inspection.categories)
        ? next.inspection.categories
        : [];
      for (const key of templateKeys.value) {
        next.email.templates[key] = { ...EMPTY_TEMPLATE, ...(next.email.templates[key] || {}) };
      }
      return next;
    };

    const draft = ref(withTemplates(settings.value));

    // The server re-normalises everything it is sent, so the saved values can
    // differ from what was typed. Adopting the snapshot keeps the form honest
    // about what is actually stored.
    watch(settings, (next) => { draft.value = withTemplates(next); templateErrors.value = {}; });
    // The registry arrives with the bootstrap, which can land after the first
    // draft was cloned from the seeded defaults.
    watch(templateKeys, () => { draft.value = withTemplates(draft.value); });

    const templateSpec = computed(() => mailTemplates.value[templateKey.value] || null);

    const templateEntry = (key) => draft.value.email.templates?.[key] || EMPTY_TEMPLATE;

    const storedTemplate = (key) => settings.value.email.templates?.[key] || EMPTY_TEMPLATE;

    /** Only what differs from what is stored — an empty field IS a value here. */
    const changedTemplates = computed(() => {
      const out = {};
      for (const key of templateKeys.value) {
        const entry = templateEntry(key);
        const stored = storedTemplate(key);
        const changed = {};
        for (const field of ['subject', 'body']) {
          if ((entry[field] ?? '') !== (stored[field] ?? '')) changed[field] = entry[field] ?? '';
        }
        if (Object.keys(changed).length) out[key] = changed;
      }
      return out;
    });

    /** Only the leaves that differ from the stored settings, grouped as sent. */
    const patch = computed(() => {
      const out = {};
      for (const [group, stored] of Object.entries(settings.value)) {
        const changed = {};
        for (const [key, value] of Object.entries(draft.value[group] || {})) {
          // templates is a map, not a leaf: comparing it with sameLeaf would
          // call it changed on every render and send all eight on every save.
          if (group === 'email' && key === 'templates') continue;
          if (!sameValue(value, stored[key])) changed[key] = value;
        }
        if (group === 'email' && Object.keys(changedTemplates.value).length) {
          changed.templates = changedTemplates.value;
        }
        if (Object.keys(changed).length) out[group] = changed;
      }
      return out;
    });

    const dirty = computed(() => Object.keys(patch.value).length > 0);

    const revert = () => { draft.value = withTemplates(settings.value); templateErrors.value = {}; };

    const save = async () => {
      if (!dirty.value) {
        toast('Nothing to save.', 'warning');
        return;
      }
      busy.value = true;
      templateErrors.value = {};
      try {
        await mutate('settings.update', { patch: patch.value });
        toast('Settings saved.', 'success');
      } catch (error) {
        // A refused template is reported against the field that caused it —
        // the toast alone would not say which of sixteen boxes is wrong.
        if (error?.details?.templates) {
          templateErrors.value = error.details.templates;
          const firstKey = Object.keys(error.details.templates)[0];
          if (firstKey) {
            section.value = 'email';
            templateKey.value = firstKey;
          }
        }
      } finally {
        busy.value = false;
      }
    };

    const templateError = (key, field) => templateErrors.value[key]?.[field] || '';

    /** Typing in a refused field clears its message rather than leaving a stale one. */
    const clearTemplateError = (key, field) => {
      if (templateErrors.value[key]?.[field]) {
        delete templateErrors.value[key][field];
        templateErrors.value = { ...templateErrors.value };
      }
    };

    /** The tokens this template takes, with the required ones marked. */
    const templateTokens = computed(() => {
      const spec = templateSpec.value;
      if (!spec) return [];
      return Object.entries(spec.tokens || {}).map(([name, note]) => ({
        name,
        token: `{{${name}}}`,
        note,
        required: (spec.required || []).includes(name),
      }));
    });

    /** Has this template been edited away from the built-in text? */
    const isCustomised = (key) => {
      const stored = storedTemplate(key);
      const entry = templateEntry(key);
      return Boolean(stored.subject || stored.body || entry.subject || entry.body);
    };

    /** Back to the built-in mail: an empty field is what the server reads as "default". */
    const resetTemplate = (key) => {
      draft.value.email.templates[key] = { ...EMPTY_TEMPLATE };
      delete templateErrors.value[key];
      templateErrors.value = { ...templateErrors.value };
    };

    /** Copies the built-in text into the boxes so it can be edited from there. */
    const loadDefault = (key) => {
      const spec = mailTemplates.value[key];
      if (!spec) return;
      draft.value.email.templates[key] = { subject: spec.subject, body: spec.body };
    };

    /** What would actually be sent, with the sample values filled in. */
    const previewSubject = computed(() => {
      const spec = templateSpec.value;
      if (!spec) return '';
      const entry = templateEntry(templateKey.value);
      return expandTokens(entry.subject || spec.subject, spec.sample);
    });

    const previewBody = computed(() => {
      const spec = templateSpec.value;
      if (!spec) return '';
      const entry = templateEntry(templateKey.value);
      return expandTokens(entry.body || spec.body, spec.sample);
    });

    // --- Rental rates ---
    // The rates are keyed by category name, which is free text on the assets —
    // so the editor lists every category in use, plus any rate whose category
    // no longer exists (renames move the rate with them, but a hand-edited
    // data.json can still leave one behind).

    /** The draft's rule for one category, or null. A reference, so editing it edits the draft. */
    const rentalRuleFor = (name) =>
      (draft.value.rental.categories || []).find((rule) => rule.category === name) || null;

    const rentalRows = computed(() => {
      const names = new Set(taxonomyUsage.value.categories.map((row) => row.value));
      for (const rule of draft.value.rental.categories || []) names.add(rule.category);
      return [...names]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ name, count: usageOf('categories', name), rule: rentalRuleFor(name) }));
    });

    /** Give a category its own rate, seeded from the default so nothing jumps. */
    const addRentalRule = (name) => {
      if (rentalRuleFor(name)) return;
      draft.value.rental.categories.push({
        category: name,
        ...clone(draft.value.rental.default),
      });
    };

    const removeRentalRule = (name) => {
      draft.value.rental.categories = (draft.value.rental.categories || [])
        .filter((rule) => rule.category !== name);
    };

    /** What a rate means in money, on a made-up item, for a hire of `previewDays`. */
    const SAMPLE_VALUE = 1000;
    const previewDays = ref(7);

    const currency = computed(() => draft.value.defaults?.currency || 'EUR');

    /** The factor a category with an empty box falls back to. */
    const defaultFactor = computed(() => {
      const raw = draft.value.rental.default?.serviceFactor;
      const value = raw === null || raw === undefined || raw === ''
        ? 1
        : Number(String(raw).replace(',', '.'));
      return Number.isFinite(value) ? value : 1;
    });

    /** The factor a rule charges, its own or the inherited one. */
    const factorOf = (rule) => {
      const raw = rule?.serviceFactor;
      if (raw === null || raw === undefined || raw === '') return defaultFactor.value;
      const value = Number(String(raw).replace(',', '.'));
      return Number.isFinite(value) ? value : defaultFactor.value;
    };

    const rulePreview = (rule) => {
      if (!rule) return '';
      const days = Math.max(1, Number(previewDays.value) || 1);
      // Both prices, because the pair is the point: dry hire is the rate, full
      // service is that times the factor.
      const service = (amount) => {
        const factor = factorOf(rule);
        return factor === 1 ? '' : ` · full service ${formatMoney(amount * factor, currency.value)}`;
      };

      if (rule.mode === 'FIXED') {
        const fixed = Number(rule.fixed) || 0;
        const total = rule.fixedPer === 'DAY' ? fixed * days : fixed;
        return `${formatMoney(total, currency.value)} for ${daysLabel(days)}${service(total)}`;
      }
      const tier = tierFor(rule.tiers, days);
      const percent = Number(tier ? tier.percent : rule.percent) || 0;
      const total = (SAMPLE_VALUE * percent) / 100 * days;
      return `${formatPercent(percent)} %/day · ${formatMoney(total, currency.value)} for `
        + `${daysLabel(days)} on a ${formatMoney(SAMPLE_VALUE, currency.value)} item`
        + service(total);
    };

    // --- Events ---
    // The workflow an event walks through. Stored by ID and shown by LABEL, so
    // renaming "Packed" to "Gepackt" leaves every packed event packed.

    /** The same slug rule as trax_slug() on the server. */
    const slugify = (value) => String(value ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);

    const eventStatuses = computed(() => draft.value.events.statuses || []);

    const addEventStatus = () => {
      if (eventStatuses.value.length >= 12) return;
      draft.value.events.statuses.push({ id: '', label: '', color: '#6B7280', closed: false });
    };

    /**
     * A new row gets its id from its label, once — after that the id is fixed.
     *
     * That is what makes a rename safe: the events store the id, so changing
     * the label must never change it. A row that has never been saved has no
     * id yet, which is the only moment one may be handed out.
     */
    const nameEventStatus = (status) => {
      if (!status.id) status.id = slugify(status.label);
    };

    const removeEventStatus = (index) => {
      const [gone] = draft.value.events.statuses.splice(index, 1);
      // The default has to point at something that still exists.
      if (gone && draft.value.events.defaultStatus === gone.id) {
        draft.value.events.defaultStatus = draft.value.events.statuses[0]?.id || '';
      }
    };

    /** The workflow reads in order, so the order is editable. */
    const moveEventStatus = (index, by) => {
      const list = draft.value.events.statuses;
      const to = index + by;
      if (to < 0 || to >= list.length) return;
      const [row] = list.splice(index, 1);
      list.splice(to, 0, row);
    };

    /** How many events are on a status — what removing it would orphan. */
    const eventsOnStatus = (id) =>
      state.events.filter((event) => event.status === id).length;

    // --- Inspections ---
    // Ticking a category is what switches testing on for it: the rule's
    // PRESENCE in the list is the flag, so there is nothing that can disagree
    // with it. Untick and the rule goes; the records already filed stay, they
    // are documentation of something that happened.

    const inspectionRuleFor = (name) =>
      (draft.value.inspection.categories || []).find((rule) => rule.category === name) || null;

    const inspectionRows = computed(() => {
      const names = new Set(taxonomyUsage.value.categories.map((row) => row.value));
      for (const rule of draft.value.inspection.categories || []) names.add(rule.category);
      return [...names]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ name, count: usageOf('categories', name), rule: inspectionRuleFor(name) }));
    });

    const toggleInspection = (name, on) => {
      if (on) {
        if (!inspectionRuleFor(name)) {
          draft.value.inspection.categories.push({ category: name, ...clone(BLANK_INSPECTION) });
        }
        return;
      }
      draft.value.inspection.categories = (draft.value.inspection.categories || [])
        .filter((rule) => rule.category !== name);
    };

    /** One more measurement to write down. Named here, filled in per test. */
    const addInspectionField = (rule) => {
      if (!Array.isArray(rule.fields)) rule.fields = [];
      if (rule.fields.length >= 12) return;
      rule.fields.push('');
    };

    const removeInspectionField = (rule, index) => {
      rule.fields.splice(index, 1);
    };

    /** How a rule reads in one line, under the row. */
    const inspectionSummary = (rule) => {
      if (!rule) return 'Not tested — no record is asked for.';
      const months = Math.max(0, Number(rule.intervalMonths) || 0);
      const every = months
        ? `every ${months} month${months === 1 ? '' : 's'}`
        : 'no repeat — nothing falls due on its own';
      const fields = (rule.fields || []).filter(Boolean);
      return `${rule.label || 'Inspection'} · ${every}`
        + (fields.length ? ` · records ${fields.join(', ')}` : ' · no measured parameters');
    };

    // --- Taxonomy ---

    // {kind, value, mode} — the row with its inline rename/merge form open.
    const editing = ref(null);
    const editValue = ref('');
    const pending = ref(null);

    const usageOf = (key, value) =>
      taxonomyUsage.value[key].find((row) => row.value === value)?.count || 0;

    /** Other values of the same kind — the only sensible merge targets. */
    const mergeOptions = (key, value) =>
      taxonomyUsage.value[key].filter((row) => row.value !== value);

    const isEditing = (kind, value, mode) =>
      Boolean(editing.value) && editing.value.kind === kind
        && editing.value.value === value && editing.value.mode === mode;

    const startEdit = (kind, value, mode) => {
      editing.value = { kind, value, mode };
      editValue.value = mode === 'rename' ? value : '';
    };

    const cancelEdit = () => { editing.value = null; editValue.value = ''; };

    /**
     * taxonomy.rename takes a scalar `from`, taxonomy.merge a list, and
     * taxonomy.delete neither — it takes `value`. Kept in one place because
     * getting it wrong is a 400 rather than anything visible.
     */
    const taxonomyPayload = (mode, kind, from, to) => {
      if (mode === 'delete') return { kind, value: from };
      if (mode === 'merge') return { kind, from: [from], to };
      return { kind, from, to };
    };

    const applyTaxonomy = async (mode, kind, from, to) => {
      busy.value = true;
      try {
        const data = await mutate(`taxonomy.${mode}`, taxonomyPayload(mode, kind, from, to));
        toast(`${data.changed} asset(s) rewritten.`, 'success');
        cancelEdit();
      } catch { /* toast already raised */ } finally {
        busy.value = false;
      }
    };

    // Returns the promise so a caller — a test, mostly — can wait for it.
    const rename = (group, value) => {
      const to = editValue.value.trim();
      if (!to) {
        toast('Give it a name.', 'warning');
        return null;
      }
      if (to === value) {
        cancelEdit();
        return null;
      }
      return applyTaxonomy('rename', group.kind, value, to);
    };

    // Merge and delete rewrite every asset carrying the value, so both stop for
    // a confirmation that names the count.
    const askMerge = (group, value) => {
      const to = editValue.value.trim();
      if (!to) {
        toast('Pick what to merge into.', 'warning');
        return;
      }
      const count = usageOf(group.key, value);
      pending.value = {
        mode: 'merge', kind: group.kind, from: value, to,
        title: `Merge "${value}" into "${to}"?`,
        message: `This rewrites ${count} asset(s). "${value}" disappears.`,
        confirmLabel: `Merge ${count} asset(s)`,
      };
    };

    const askDelete = (group, value) => {
      const count = usageOf(group.key, value);
      pending.value = {
        mode: 'delete', kind: group.kind, from: value, to: null,
        title: `Clear "${value}"?`,
        message: `This rewrites ${count} asset(s), leaving their ${group.kind} empty.`,
        confirmLabel: `Clear on ${count} asset(s)`,
      };
    };

    const runPending = () => {
      const job = pending.value;
      pending.value = null;
      return job ? applyTaxonomy(job.mode, job.kind, job.from, job.to) : null;
    };

    // --- Cron ---

    const generateSecret = () => {
      const bytes = new Uint8Array(24);
      if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(bytes);
      } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      }
      draft.value.cron.secret = [...bytes]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    };

    /** Empty until a secret is SAVED — an unsaved one would not authenticate. */
    const cronUrl = computed(() => {
      const secret = settings.value.cron.secret;
      if (!secret) return '';
      const origin = (typeof location === 'object' && location.origin) || '';
      const base = settings.value.branding.publicPath || '/';
      return `${origin}${base}cron.php?secret=${encodeURIComponent(secret)}`;
    });

    const copyCronUrl = async () => {
      try {
        await navigator.clipboard.writeText(cronUrl.value);
        toast('Cron URL copied.', 'success');
      } catch {
        toast('Could not copy — select the URL and copy it manually.', 'warning');
      }
    };

    // --- Terms & conditions ---
    // Not part of the settings draft: every save publishes a VERSION, which
    // signatures point at, so it has its own action (terms.update), its own
    // save bar and no "save along with the branding" by accident.

    /** Server-side the text is trimmed with LF line ends; compare the same way. */
    const termsNormal = (text) => String(text ?? '').replace(/\r\n?/g, '\n').trim();

    const termsDraft = ref(state.terms.text || '');
    // A new version — ours or another operator's — replaces the draft.
    watch(() => state.terms.version, () => { termsDraft.value = state.terms.text || ''; });

    const termsBusy = ref(false);
    const termsMax = computed(() => state.meta?.termsMax || 30000);
    const termsDirty = computed(() => termsNormal(termsDraft.value) !== termsNormal(state.terms.text));
    /** Saving an empty text while terms are in force takes them down. */
    const termsWithdraw = computed(() => state.terms.active && termsNormal(termsDraft.value) === '');
    const termsVersions = computed(() => [...(state.terms.versions || [])].reverse());

    const saveTermsDraft = async () => {
      termsBusy.value = true;
      try {
        await saveTerms(termsDraft.value);
        toast(state.terms.active
          ? `Terms published as version ${state.terms.version}.`
          : 'Terms withdrawn. Nothing is shown or accepted any more.', 'success');
      } catch {
        /* toast already raised by the store */
      } finally {
        termsBusy.value = false;
      }
    };

    const revertTerms = () => { termsDraft.value = state.terms.text || ''; };

    // The preview is the server's renderer, so it is exactly what terms.php
    // and the booking page will show. Debounced: a request per keystroke
    // would be a request per keystroke.
    const termsHtml = ref('');
    const termsPreviewError = ref('');
    let previewTimer = null;
    let previewSeq = 0;
    const refreshPreview = () => {
      clearTimeout(previewTimer);
      if (section.value !== 'terms') return;
      previewTimer = setTimeout(async () => {
        const seq = ++previewSeq;
        const text = termsNormal(termsDraft.value);
        if (!text) {
          termsHtml.value = '';
          termsPreviewError.value = '';
          return;
        }
        try {
          const html = await previewTerms(text);
          // A slow answer to an older draft must not overwrite a newer one.
          if (seq === previewSeq) {
            termsHtml.value = html;
            termsPreviewError.value = '';
          }
        } catch (error) {
          if (seq === previewSeq) termsPreviewError.value = error.message;
        }
      }, 350);
    };
    watch([termsDraft, section], refreshPreview, { immediate: true });

    // --- Account ---
    // The one thing on this view that is not a setting: it writes users.json,
    // not data.json, and it is the only way to change the password without
    // shell access to the server.

    // `username` is only read in external mode: there the request arrives with
    // no built-in session behind it, so the server cannot work out on its own
    // which fallback account the change is aimed at. Prefilled from
    // auth.config's builtinUsers, which is the answer for every install that
    // has exactly one.
    const account = ref({ username: '', current: '', next: '', confirm: '' });
    const accountError = ref('');
    const accountBusy = ref(false);

    /**
     * Posted straight through api.post() rather than mutate().
     *
     * The action moves no record, returns no snapshot and has no revision, so
     * there is nothing for mutate() to apply — and its blanket error toast
     * would double every refusal that belongs beside the boxes instead: a wrong
     * current password (403) and a new one that is too short (400).
     */
    const changePassword = async () => {
      accountError.value = '';

      if (!account.value.current || !account.value.next) {
        accountError.value = 'Enter your current password and the new one.';
        return;
      }
      if (account.value.next !== account.value.confirm) {
        accountError.value = 'The two new passwords do not match.';
        return;
      }

      accountBusy.value = true;
      const username = account.value.username;
      try {
        await api.post('auth.changePassword', {
          username,
          currentPassword: account.value.current,
          newPassword: account.value.next,
        });
        // The name stays: it is a target, not a secret, and clearing it would
        // make a second change on a multi-account install retype it.
        account.value = { username, current: '', next: '', confirm: '' };
        toast('Password changed.', 'success');
      } catch (error) {
        accountError.value = error.message;
      } finally {
        accountBusy.value = false;
      }
    };

    // --- Authentication ---
    // Also not a setting: it writes lib/config.local.php, which is PHP source
    // read before anything else on the next request. Nothing here can be part
    // of the settings draft, so this block loads, tests and saves on its own.

    const auth = ref({ mode: 'builtin', include: '', logoutUrl: '' });
    /** The server's own reading: effective mode, include status, user count. */
    const authInfo = ref(null);
    const authError = ref('');
    const authBusy = ref(false);
    /** Result of the last "Test path", shown inline. Cleared when the path changes. */
    const authTest = ref(null);

    const adoptAuthConfig = (data) => {
      auth.value = {
        mode: data.mode === 'external' ? 'external' : 'builtin',
        include: data.include || '',
        logoutUrl: data.logoutUrl || '',
      };
      authInfo.value = {
        effectiveMode: data.effectiveMode,
        includeStatus: data.includeStatus || null,
        hasBuiltinUsers: data.hasBuiltinUsers || 0,
        builtinUsers: Array.isArray(data.builtinUsers) ? data.builtinUsers : [],
      };

      // Only ever a prefill: whatever the operator typed wins.
      if (!account.value.username && authInfo.value.builtinUsers.length) {
        account.value.username = authInfo.value.builtinUsers[0];
      }
    };

    /**
     * Read on open, not on mount: this view is four other sections most of the
     * time, and the answer touches the filesystem.
     */
    const loadAuthConfig = async () => {
      authError.value = '';
      authBusy.value = true;
      try {
        const body = await api.get('auth.config');
        adoptAuthConfig(body.data || {});
      } catch (error) {
        authError.value = error.message;
      } finally {
        authBusy.value = false;
      }
    };

    // Account needs it too: it is where the external-mode notice and the
    // fallback account name come from, and both are wrong when authInfo is null.
    watch(section, (next) => {
      if ((next === 'authentication' || next === 'account') && authInfo.value === null) loadAuthConfig();
    });

    const testAuthInclude = async () => {
      authError.value = '';
      authTest.value = null;
      authBusy.value = true;
      try {
        const body = await api.post('auth.testInclude', { include: auth.value.include });
        authTest.value = body.data || null;
      } catch (error) {
        authError.value = error.message;
      } finally {
        authBusy.value = false;
      }
    };

    /**
     * Posted through api.post() rather than mutate(), like the password change:
     * no record moves, no snapshot comes back, and the server's refusals — a
     * path that is not there, a sign-out URL it will not put in a header —
     * belong beside the fields rather than in a blanket toast.
     */
    const saveAuthConfig = async () => {
      authError.value = '';
      authBusy.value = true;
      try {
        const body = await api.post('auth.configUpdate', {
          mode: auth.value.mode,
          include: auth.value.include,
          logoutUrl: auth.value.logoutUrl,
        });
        adoptAuthConfig(body.data || {});
        authTest.value = null;
        toast('Authentication saved.', 'success');
        if (body.data && body.data.warning) toast(body.data.warning, 'warning');
      } catch (error) {
        authError.value = error.message;
      } finally {
        authBusy.value = false;
      }
    };

    return {
      settings, taxonomyUsage,
      SECTIONS, AUTH_MODES, TAXONOMIES, CUSTOMER_MAIL, CRON_MAIL, HOURS, LOCALES,
      section, draft, busy, patch, dirty, save, revert,
      rentalRows, addRentalRule, removeRentalRule, rulePreview, previewDays,
      defaultFactor, factorOf, serviceFactorOf,
      eventStatuses, addEventStatus, nameEventStatus, removeEventStatus,
      moveEventStatus, eventsOnStatus,
      inspectionRows, toggleInspection, addInspectionField, removeInspectionField,
      inspectionSummary,
      currency, daysLabel, formatPercent,
      editing, editValue, pending, usageOf, mergeOptions, isEditing,
      startEdit, cancelEdit, taxonomyPayload, applyTaxonomy,
      rename, askMerge, askDelete, runPending,
      generateSecret, cronUrl, copyCronUrl,
      mailTemplates, templateKeys, templateKey, templateSpec, templateEntry,
      templateTokens, templateError, clearTemplateError, isCustomised,
      resetTemplate, loadDefault, previewSubject, previewBody,
      subjectMax, bodyMax,
      account, accountError, accountBusy, changePassword,
      auth, authInfo, authError, authBusy, authTest,
      loadAuthConfig, testAuthInclude, saveAuthConfig,
      state, termsDraft, termsBusy, termsMax, termsDirty, termsWithdraw, termsVersions,
      saveTermsDraft, revertTerms, termsHtml, termsPreviewError, termsUrl, formatDateTime,
    };
  },
  template: `
    <div class="trax-tabs mb-3">
      <button v-for="tab in SECTIONS" :key="tab.id" type="button"
              class="trax-tab" :class="{ active: section === tab.id }"
              :aria-current="section === tab.id ? 'true' : undefined"
              @click="section = tab.id">
        <i class="bi" :class="tab.icon"></i> {{ tab.label }}
      </button>
    </div>

    <!-- Taxonomy ------------------------------------------------------- -->
    <div v-if="section === 'taxonomy'" class="row g-3">
      <div v-for="group in TAXONOMIES" :key="group.kind" class="col-12 col-xl-4">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">
              <i class="bi" :class="group.icon"></i> {{ group.label }}
              <span class="text-secondary small">({{ taxonomyUsage[group.key].length }})</span>
            </h2>
            <p class="trax-page-sub">Free text on the assets — editing here rewrites the records.</p>
          </div>

          <ul class="list-group list-group-flush">
            <li v-for="row in taxonomyUsage[group.key]" :key="row.value"
                class="list-group-item bg-transparent py-1">
              <div class="d-flex align-items-center gap-2">
                <span class="flex-grow-1 text-truncate">{{ row.value }}</span>
                <span class="trax-kind-chip">{{ row.count }}</span>
                <button class="btn btn-sm btn-outline-secondary py-0 px-1" :disabled="busy"
                        :title="'Rename ' + row.value"
                        @click="startEdit(group.kind, row.value, 'rename')">
                  <i class="bi bi-pencil"></i>
                </button>
                <button class="btn btn-sm btn-outline-secondary py-0 px-1"
                        :disabled="busy || !mergeOptions(group.key, row.value).length"
                        :title="'Merge ' + row.value + ' into another value'"
                        @click="startEdit(group.kind, row.value, 'merge')">
                  <i class="bi bi-sign-merge-left"></i>
                </button>
                <button class="btn btn-sm btn-outline-danger py-0 px-1" :disabled="busy"
                        :title="'Clear ' + row.value + ' on ' + row.count + ' asset(s)'"
                        @click="askDelete(group, row.value)">
                  <i class="bi bi-trash"></i>
                </button>
              </div>

              <div v-if="isEditing(group.kind, row.value, 'rename')" class="d-flex gap-1 mt-1">
                <input class="form-control form-control-sm" v-model="editValue"
                       :aria-label="'New name for ' + row.value"
                       @keydown.enter="rename(group, row.value)">
                <button class="btn btn-sm btn-primary" :disabled="busy" @click="rename(group, row.value)">
                  Rename
                </button>
                <button class="btn btn-sm btn-outline-secondary" @click="cancelEdit()">Cancel</button>
              </div>

              <div v-if="isEditing(group.kind, row.value, 'merge')" class="d-flex gap-1 mt-1">
                <select class="form-select form-select-sm" v-model="editValue"
                        :aria-label="'Merge ' + row.value + ' into'">
                  <option value="">— merge into —</option>
                  <option v-for="option in mergeOptions(group.key, row.value)"
                          :key="option.value" :value="option.value">
                    {{ option.value }} ({{ option.count }})
                  </option>
                </select>
                <button class="btn btn-sm btn-primary" :disabled="busy || !editValue"
                        @click="askMerge(group, row.value)">Merge</button>
                <button class="btn btn-sm btn-outline-secondary" @click="cancelEdit()">Cancel</button>
              </div>
            </li>

            <li v-if="!taxonomyUsage[group.key].length"
                class="list-group-item bg-transparent small text-secondary">
              Nothing uses a {{ group.kind }} yet.
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- Rental rates ---------------------------------------------------- -->
    <div v-else-if="section === 'rental'" class="row g-3">
      <div class="col-12 col-xl-5">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title"><i class="bi bi-cash-coin"></i> Default rate</h2>
            <p class="trax-page-sub">
              What hiring gear out costs when its category says nothing else. A percentage
              is charged per day of the hire, on what the item is worth; a fixed price
              ignores the item's value altogether. That rate <strong>is</strong> the dry-hire
              price; full service is that times the factor below, because the crew's time is
              invoiced separately.
            </p>
          </div>
          <div class="trax-card-pad pt-0">
            <RentalRate :rule="draft.rental.default" variant="rule" :show-tiers="true"
                        :show-service="true" :inherit-factor="1" :currency="currency" />
            <div class="d-flex align-items-center gap-2 mt-3 pt-2 border-top border-secondary-subtle">
              <label class="form-label small mb-0" for="set-rental-preview">Preview for</label>
              <input id="set-rental-preview" class="form-control form-control-sm text-end"
                     style="width:5rem" type="number" min="1" max="3650" v-model="previewDays">
              <span class="small text-secondary">days</span>
            </div>
            <div class="small text-secondary mt-1">{{ rulePreview(draft.rental.default) }}</div>
          </div>
        </div>
      </div>

      <div class="col-12 col-xl-7">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">
              <i class="bi bi-folder2"></i> Per category
              <span class="text-secondary small">({{ rentalRows.length }})</span>
            </h2>
            <p class="trax-page-sub">
              A category without a rate of its own is hired out at the default. An asset
              or a single unit can still overrule both, in its own Rental tab.
            </p>
          </div>

          <ul class="list-group list-group-flush">
            <li v-for="row in rentalRows" :key="row.name" class="list-group-item bg-transparent">
              <div class="d-flex align-items-center gap-2">
                <span class="flex-grow-1 text-truncate">{{ row.name }}</span>
                <span class="trax-kind-chip">{{ row.count }}</span>
                <button v-if="!row.rule" type="button" class="btn btn-sm btn-outline-primary py-0 px-2"
                        :disabled="busy" @click="addRentalRule(row.name)">
                  <i class="bi bi-plus"></i> Rate
                </button>
                <button v-else type="button" class="btn btn-sm btn-outline-danger py-0 px-1"
                        :disabled="busy" :title="'Hire ' + row.name + ' at the default rate again'"
                        :aria-label="'Remove the rate for ' + row.name"
                        @click="removeRentalRule(row.name)">
                  <i class="bi bi-x"></i>
                </button>
              </div>

              <div v-if="row.rule" class="mt-2">
                <RentalRate :rule="row.rule" variant="rule" :show-tiers="true"
                            :show-service="true" :inherit-factor="defaultFactor"
                            :currency="currency" />
                <div class="small text-secondary mt-1">{{ rulePreview(row.rule) }}</div>
              </div>
              <div v-else class="small text-secondary">
                Default rate — {{ rulePreview(draft.rental.default) }}
              </div>
            </li>

            <li v-if="!rentalRows.length" class="list-group-item bg-transparent small text-secondary">
              Nothing uses a category yet, so there is nothing to price separately.
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- Events ------------------------------------------------------------ -->
    <div v-else-if="section === 'events'" class="row g-3">
      <div class="col-12 col-xl-7">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">
              <i class="bi bi-calendar-event"></i> Workflow
              <span class="text-secondary small">({{ eventStatuses.length }})</span>
            </h2>
            <p class="trax-page-sub">
              The states a job walks through — booked, in a case in the warehouse, out with the
              customer. They read top to bottom; the arrows reorder them. A <strong>closed</strong>
              status ends the job and drops it out of the open list.
            </p>
          </div>

          <ul class="list-group list-group-flush">
            <li v-for="(status, si) in eventStatuses" :key="si"
                class="list-group-item bg-transparent">
              <div class="d-flex align-items-center gap-2 flex-wrap">
                <div class="btn-group btn-group-sm">
                  <button type="button" class="btn btn-outline-secondary py-0 px-1"
                          :disabled="si === 0" :aria-label="'Move ' + (status.label || 'status') + ' up'"
                          @click="moveEventStatus(si, -1)">
                    <i class="bi bi-chevron-up"></i>
                  </button>
                  <button type="button" class="btn btn-outline-secondary py-0 px-1"
                          :disabled="si === eventStatuses.length - 1"
                          :aria-label="'Move ' + (status.label || 'status') + ' down'"
                          @click="moveEventStatus(si, 1)">
                    <i class="bi bi-chevron-down"></i>
                  </button>
                </div>

                <input class="form-control form-control-sm" style="max-width:14rem"
                       v-model="status.label" maxlength="40" placeholder="e.g. At customer"
                       :aria-label="'Name of status ' + (si + 1)"
                       @blur="nameEventStatus(status)">

                <input class="form-control form-control-color form-control-sm" type="color"
                       style="width:2.75rem" v-model="status.color"
                       :aria-label="'Colour of ' + (status.label || 'status ' + (si + 1))">

                <div class="form-check form-switch mb-0">
                  <input class="form-check-input" type="checkbox" role="switch"
                         :id="'ev-closed-' + si" v-model="status.closed">
                  <label class="form-check-label small" :for="'ev-closed-' + si">Closed</label>
                </div>

                <span class="flex-grow-1"></span>
                <span v-if="status.id && eventsOnStatus(status.id)" class="trax-kind-chip">
                  {{ eventsOnStatus(status.id) }}
                </span>
                <button type="button" class="btn btn-sm btn-outline-danger py-0 px-1"
                        :disabled="eventStatuses.length <= 1"
                        :aria-label="'Remove ' + (status.label || 'status ' + (si + 1))"
                        @click="removeEventStatus(si)">
                  <i class="bi bi-x"></i>
                </button>
              </div>
              <div v-if="status.id" class="form-text small mb-0 font-monospace">{{ status.id }}</div>
            </li>
          </ul>

          <div class="trax-card-pad d-flex align-items-center gap-2">
            <span class="small text-secondary flex-grow-1">
              A status is stored by its id, so renaming one leaves every event on it where it is.
            </span>
            <button type="button" class="btn btn-sm btn-outline-primary"
                    :disabled="busy || eventStatuses.length >= 12" @click="addEventStatus()">
              <i class="bi bi-plus"></i> Status
            </button>
          </div>
        </div>
      </div>

      <div class="col-12 col-xl-5">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title"><i class="bi bi-sliders"></i> Defaults</h2>

            <div class="form-check form-switch mb-3">
              <input class="form-check-input" type="checkbox" role="switch" id="ev-enabled"
                     v-model="draft.events.enabled">
              <label class="form-check-label small" for="ev-enabled">
                Offer an event when checking out and reserving
                <span class="d-block text-secondary" style="font-size:.72rem">
                  Off hides the picker in the selection drawer. Events already booked keep theirs.
                </span>
              </label>
            </div>

            <label class="form-label small" for="ev-default">A new event starts as</label>
            <select id="ev-default" class="form-select form-select-sm"
                    v-model="draft.events.defaultStatus">
              <option v-for="status in eventStatuses" :key="status.id || status.label"
                      :value="status.id">
                {{ status.label || status.id }}
              </option>
            </select>
          </div>

          <div class="trax-card-pad pt-0">
            <h3 class="trax-page-title">How it works</h3>
            <ul class="small text-secondary ps-3 mb-0">
              <li class="mb-2">
                An event is a <strong>job</strong>: a festival, a conference, a shoot. It is created
                under Events and picked in the selection drawer when gear is checked out or reserved.
              </li>
              <li class="mb-2">
                Gear is never "inside" an event. The checkout line and the reservation carry the
                job's name, so availability is decided exactly where it was before.
              </li>
              <li class="mb-2">
                The status is moved by hand, from the Events list, while somebody is holding the
                flight case. It changes no stock: what is free is still what is not checked out.
              </li>
              <li>
                Deleting an event never deletes gear — the bookings simply stop naming it.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- Inspections ------------------------------------------------------ -->
    <div v-else-if="section === 'inspection'" class="row g-3">
      <div class="col-12 col-xl-8">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">
              <i class="bi bi-clipboard-check"></i> Tested categories
              <span class="text-secondary small">({{ inspectionRows.length }})</span>
            </h2>
            <p class="trax-page-sub">
              Tick a category and every item in it gets a Test tab: when it was tested, whether it
              passed, what was measured and the certificate. Nothing is asked of the categories you
              leave unticked — a folding table does not get a test record.
            </p>
          </div>

          <ul class="list-group list-group-flush">
            <li v-for="row in inspectionRows" :key="row.name" class="list-group-item bg-transparent">
              <div class="d-flex align-items-center gap-2">
                <div class="form-check mb-0 flex-grow-1 min-w-0">
                  <input class="form-check-input" type="checkbox" :id="'insp-' + row.name"
                         :checked="!!row.rule" :disabled="busy"
                         @change="toggleInspection(row.name, $event.target.checked)">
                  <label class="form-check-label text-truncate" :for="'insp-' + row.name">
                    {{ row.name }}
                  </label>
                </div>
                <span class="trax-kind-chip">{{ row.count }}</span>
              </div>

              <div v-if="row.rule" class="row g-2 mt-1">
                <div class="col-12 col-sm-6">
                  <label class="form-label small mb-1" :for="'insp-label-' + row.name">
                    What the test is called
                  </label>
                  <input class="form-control form-control-sm" :id="'insp-label-' + row.name"
                         v-model="row.rule.label" maxlength="120" placeholder="e.g. DGUV V3">
                </div>
                <div class="col-12 col-sm-6">
                  <label class="form-label small mb-1" :for="'insp-months-' + row.name">
                    Valid for
                  </label>
                  <div class="input-group input-group-sm">
                    <input class="form-control text-end" :id="'insp-months-' + row.name"
                           type="number" min="0" max="240" step="1"
                           v-model="row.rule.intervalMonths">
                    <span class="input-group-text">months</span>
                  </div>
                  <div class="form-text small">0 = record it, but let nothing fall due.</div>
                </div>

                <div class="col-12">
                  <div class="d-flex align-items-center gap-2">
                    <span class="small text-secondary flex-grow-1">
                      Measured parameters
                      <span v-if="(row.rule.fields || []).length">({{ row.rule.fields.length }})</span>
                    </span>
                    <button type="button" class="btn btn-sm btn-outline-primary py-0 px-2"
                            :disabled="busy || (row.rule.fields || []).length >= 12"
                            @click="addInspectionField(row.rule)">
                      <i class="bi bi-plus"></i> Parameter
                    </button>
                  </div>
                  <div v-for="(field, fi) in (row.rule.fields || [])" :key="fi"
                       class="d-flex align-items-center gap-1 mt-1">
                    <input class="form-control form-control-sm" v-model="row.rule.fields[fi]"
                           maxlength="120" placeholder="e.g. Insulation resistance"
                           :aria-label="'Parameter ' + (fi + 1) + ' of ' + row.name">
                    <button type="button" class="btn btn-sm btn-outline-danger py-0 px-1"
                            :aria-label="'Remove parameter ' + (fi + 1)"
                            @click="removeInspectionField(row.rule, fi)">
                      <i class="bi bi-x"></i>
                    </button>
                  </div>
                  <p class="form-text small mb-0">
                    These become the boxes on the test form, in this order, so the same readings are
                    written down every time.
                  </p>
                </div>
              </div>

              <div class="small text-secondary">{{ inspectionSummary(row.rule) }}</div>
            </li>

            <li v-if="!inspectionRows.length"
                class="list-group-item bg-transparent small text-secondary">
              Nothing uses a category yet, so there is nothing to put a test on.
            </li>
          </ul>
        </div>
      </div>

      <div class="col-12 col-xl-4">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title"><i class="bi bi-info-circle"></i> How it works</h2>
            <ul class="small text-secondary ps-3 mb-0">
              <li class="mb-2">
                A record belongs to <strong>one piece</strong>: cable 183.5 and cable 183.6 keep
                separate histories, so each one can show its own documentation.
              </li>
              <li class="mb-2">
                An item that does not track units individually files its records against the record
                as a whole.
              </li>
              <li class="mb-2">
                Each record carries the date, pass or fail, who tested it, the measured values, a
                note and one certificate (PDF, image or text).
              </li>
              <li class="mb-2">
                The next test date is filled in from the interval above and can be overruled per
                record — a re-test agreed for six months is a real answer.
              </li>
              <li class="mb-2">
                Overdue and failed pieces are flagged in the asset sheet and on the dashboard.
                Nothing is blocked from going out: the app documents, the operator decides.
              </li>
              <li>
                Un-ticking a category stops the asking. The records already filed stay — they are
                documentation of something that happened.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- Email ---------------------------------------------------------- -->
    <div v-else-if="section === 'email'" class="row g-3">
      <div class="col-12 col-xl-5">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">Addresses</h2>
            <p class="trax-page-sub">Anything invalid falls back to the deploy-time constant.</p>
          </div>
          <div class="trax-card-pad pt-0">
            <label class="form-label small" for="set-owner">Owner address</label>
            <input id="set-owner" type="email" class="form-control form-control-sm mb-2"
                   v-model="draft.email.ownerEmail">
            <label class="form-label small" for="set-from">From address</label>
            <input id="set-from" type="email" class="form-control form-control-sm mb-2"
                   v-model="draft.email.fromEmail">
            <label class="form-label small" for="set-report-from">Report from address</label>
            <input id="set-report-from" type="email" class="form-control form-control-sm"
                   v-model="draft.email.reportFromEmail">
            <div class="form-text small">The digest and reminder mails are sent from this one.</div>
          </div>
        </div>
      </div>

      <div class="col-12 col-xl-7">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">To the customer</h2>
            <p class="trax-page-sub">Sent the moment an operator acts.</p>
          </div>
          <div class="trax-card-pad pt-0">
            <div v-for="row in CUSTOMER_MAIL" :key="row.key" class="form-check form-switch mb-2">
              <input class="form-check-input" type="checkbox" role="switch"
                     :id="'set-' + row.key" v-model="draft.email[row.key]">
              <label class="form-check-label small" :for="'set-' + row.key">
                {{ row.label }}
                <span class="d-block text-secondary" style="font-size:.72rem">{{ row.note }}</span>
              </label>
            </div>
          </div>

          <div class="trax-card-pad pt-0">
            <h2 class="trax-page-title">From cron.php</h2>
            <p class="trax-page-sub mb-2">Only ever sent by the scheduled run.</p>
            <div v-for="row in CRON_MAIL" :key="row.key" class="form-check form-switch mb-2">
              <input class="form-check-input" type="checkbox" role="switch"
                     :id="'set-' + row.key" v-model="draft.email[row.key]">
              <label class="form-check-label small" :for="'set-' + row.key">
                {{ row.label }}
                <span class="d-block text-secondary" style="font-size:.72rem">{{ row.note }}</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- Texts ------------------------------------------------------- -->
      <div class="col-12">
        <div class="trax-card">
          <div class="trax-card-pad">
            <h2 class="trax-page-title"><i class="bi bi-body-text"></i> Texts</h2>
            <p class="trax-page-sub">
              Subject and body of every mail. A box left empty sends the built-in text,
              so anything you have not touched goes out exactly as before.
            </p>
          </div>

          <div class="row g-3 trax-card-pad pt-0">
            <div class="col-12 col-xl-3">
              <ul class="list-group list-group-flush">
                <li v-for="key in templateKeys" :key="key" class="list-group-item bg-transparent py-1 px-0">
                  <button type="button"
                          class="btn btn-sm w-100 text-start d-flex align-items-center gap-2"
                          :class="key === templateKey ? 'btn-primary' : 'btn-outline-secondary'"
                          @click="templateKey = key">
                    <span class="flex-grow-1 text-truncate">{{ mailTemplates[key].label }}</span>
                    <i v-if="templateError(key, 'subject') || templateError(key, 'body')"
                       class="bi bi-exclamation-triangle-fill text-danger"></i>
                    <span v-else-if="isCustomised(key)" class="trax-kind-chip">edited</span>
                  </button>
                </li>
                <li v-if="!templateKeys.length" class="list-group-item bg-transparent small text-secondary">
                  The template list arrives with the next reload.
                </li>
              </ul>
            </div>

            <div v-if="templateSpec" class="col-12 col-xl-5">
              <p class="trax-page-sub">{{ templateSpec.note }}</p>

              <label class="form-label small" for="set-tpl-subject">Subject</label>
              <input id="set-tpl-subject" class="form-control form-control-sm"
                     :class="{ 'is-invalid': templateError(templateKey, 'subject') }"
                     :maxlength="subjectMax" :placeholder="templateSpec.subject"
                     v-model="draft.email.templates[templateKey].subject"
                     @input="clearTemplateError(templateKey, 'subject')">
              <div v-if="templateError(templateKey, 'subject')" class="invalid-feedback d-block">
                {{ templateError(templateKey, 'subject') }}
              </div>

              <label class="form-label small mt-2" for="set-tpl-body">Body</label>
              <textarea id="set-tpl-body" rows="12"
                        class="form-control form-control-sm font-monospace"
                        :class="{ 'is-invalid': templateError(templateKey, 'body') }"
                        :maxlength="bodyMax" :placeholder="templateSpec.body"
                        v-model="draft.email.templates[templateKey].body"
                        @input="clearTemplateError(templateKey, 'body')"></textarea>
              <div v-if="templateError(templateKey, 'body')" class="invalid-feedback d-block">
                {{ templateError(templateKey, 'body') }}
              </div>
              <div class="form-text small d-flex gap-2">
                <span class="flex-grow-1">
                  Empty = the built-in text, shown greyed out above.
                </span>
                <span>{{ templateEntry(templateKey).body.length }} / {{ bodyMax }}</span>
              </div>

              <div class="d-flex gap-1 mt-2">
                <button class="btn btn-sm btn-outline-secondary" :disabled="busy"
                        @click="loadDefault(templateKey)">
                  <i class="bi bi-clipboard-plus"></i> Start from the default
                </button>
                <button class="btn btn-sm btn-outline-danger" :disabled="busy || !isCustomised(templateKey)"
                        @click="resetTemplate(templateKey)">
                  <i class="bi bi-arrow-counterclockwise"></i> Reset to default
                </button>
              </div>

              <h3 class="form-label small mt-3 mb-1">Tokens for this mail</h3>
              <ul class="list-unstyled small mb-0">
                <li v-for="token in templateTokens" :key="token.name" class="mb-1">
                  <code>{{ token.token }}</code>
                  <span v-if="token.required" class="trax-kind-chip">required</span>
                  <span class="d-block text-secondary" style="font-size:.72rem">{{ token.note }}</span>
                </li>
              </ul>
            </div>

            <div v-if="templateSpec" class="col-12 col-xl-4">
              <h3 class="form-label small">Preview</h3>
              <div class="trax-card">
                <div class="trax-card-pad">
                  <div class="small text-secondary">Subject</div>
                  <div class="mb-2"><strong>{{ previewSubject }}</strong></div>
                  <div class="small text-secondary">Body</div>
                  <pre class="small mb-0" style="white-space:pre-wrap; word-break:break-word">{{ previewBody }}</pre>
                </div>
              </div>
              <div class="form-text small">
                Sample values, not a real booking — it shows what the tokens turn into.
                A token this mail does not have is left standing here, and would be sent
                that way, which is why saving one is refused.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Branding ------------------------------------------------------- -->
    <div v-else-if="section === 'branding'" class="row g-3">
      <div class="col-12 col-xl-7">
        <div class="trax-card h-100">
          <div class="trax-card-pad"><h2 class="trax-page-title">Branding</h2></div>
          <div class="trax-card-pad pt-0">
            <label class="form-label small" for="set-appname">App name</label>
            <input id="set-appname" class="form-control form-control-sm mb-1"
                   v-model="draft.branding.appName" maxlength="60">
            <div class="form-text small">
              What this install calls itself: the browser tab, the wordmark in the sidebar
              and the name of every exported PDF. Cannot be empty — those all have to say
              something.
            </div>

            <label class="form-label small mt-2" for="set-org">Organisation name</label>
            <input id="set-org" class="form-control form-control-sm mb-1" v-model="draft.branding.orgName">
            <div class="form-text small">
              Who owns the equipment. Printed on every label under the heading below, and
              shown to a finder on the public asset page. Leave it empty and the app name
              is used instead.
            </div>

            <label class="form-label small mt-2" for="set-color">Brand colour</label>
            <div class="d-flex gap-2 mb-2">
              <input id="set-color" type="color" class="form-control form-control-color form-control-sm"
                     v-model="draft.branding.brandColor">
              <input class="form-control form-control-sm" v-model="draft.branding.brandColor"
                     aria-label="Brand colour hex" placeholder="#1F2937" maxlength="7">
            </div>

            <label class="form-label small" for="set-whatsapp">WhatsApp number</label>
            <input id="set-whatsapp" class="form-control form-control-sm mb-1" v-model="draft.branding.whatsapp"
                   inputmode="tel" placeholder="+1 555 0100" maxlength="40">
            <div class="form-text small">
              The "Message on WhatsApp" button on the public asset page. Write it with the
              country code, e.g. <code>+1 555 0100</code> — wa.me dials internationally,
              so a national <code>0…</code> form is refused. Spaces, dashes and brackets are
              fine; they are stripped from the link. <strong>Leave it empty</strong> and the
              button is left out of the page entirely, so finders only get "Report it found".
            </div>

            <label class="form-label small mt-2" for="set-public">Public path</label>
            <input id="set-public" class="form-control form-control-sm mb-1" v-model="draft.branding.publicPath">
            <div class="form-text small">
              Site-root-relative, e.g. <code>/assets/</code>. Customer links are built from it.
            </div>

            <label class="form-label small mt-2" for="set-logo">Logo file</label>
            <input id="set-logo" class="form-control form-control-sm" v-model="draft.branding.logoFile">
            <div class="form-text small">
              A PNG or JPEG in the project root, e.g. <code>logo.png</code>, <strong>or an
              absolute URL</strong> like <code>https://cdn.example.org/logo.png</code>.
              A file name that points at nothing is dropped, and so is a URL that is not
              plain <code>http(s)</code> — never one carrying a password.
              <br>
              The two are not interchangeable: <strong>labels</strong> are drawn on the server
              and read the file off disk, so a URL prints the organisation name as text instead;
              <strong>PDFs</strong> are built in the browser and load either, as long as the
              host allows it (a CDN that sends no <code>Access-Control-Allow-Origin</code>
              header leaves the header as text too). Leave it empty for no logo at all.
            </div>

            <label class="form-label small mt-2" for="set-favicon">Favicon file</label>
            <input id="set-favicon" class="form-control form-control-sm" v-model="draft.branding.faviconFile">
            <div class="form-text small">
              A PNG in the project root, used as the browser icon and the iOS home-screen
              icon. Same rule as the logo: unknown name, no icon.
            </div>

            <label class="form-label small mt-2" for="set-labelheading">Label heading</label>
            <input id="set-labelheading" class="form-control form-control-sm"
                   v-model="draft.branding.labelHeading" maxlength="40">
            <div class="form-text small">
              The line above the logo on every printed label — <code>PROPERTY OF</code> by
              default. The only label text that is not taken from the asset.
            </div>
          </div>
        </div>
      </div>

      <div class="col-12 col-xl-5">
        <div class="trax-card h-100">
          <div class="trax-card-pad"><h2 class="trax-page-title">Preview</h2></div>
          <div class="trax-card-pad pt-0">
            <div class="trax-brand-preview" :style="{ background: draft.branding.brandColor }">
              {{ draft.branding.orgName || 'Your organisation' }}
            </div>
            <p class="small text-secondary mt-2 mb-0">
              {{ draft.branding.brandColor }} — used on labels and customer-facing pages.
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Terms & conditions ---------------------------------------------- -->
    <div v-else-if="section === 'terms'" class="row g-3">
      <div class="col-12 col-xl-6">
        <div class="trax-card">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">Terms &amp; conditions</h2>
            <p class="trax-page-sub">
              What a customer accepts when they sign for a hand-over. Once published, the terms are
              linked in the footer of every public page, have to be ticked next to the signature
              pad (at the counter and on the customer's booking link), and are named on the
              hand-over sheet.
            </p>
            <p v-if="state.terms.active" class="small mb-0">
              <i class="bi bi-check-circle text-success"></i>
              In force: <strong>version {{ state.terms.version }}</strong>,
              published {{ formatDateTime(state.terms.at) }}<span v-if="state.terms.actor">
              by {{ state.terms.actor }}</span> ·
              <a :href="termsUrl()" target="_blank" rel="noopener noreferrer">open public page</a>
            </p>
            <p v-else class="small text-secondary mb-0">
              <i class="bi bi-dash-circle"></i>
              Nothing is published: no footer link, no tick box, no line on the sheet.
            </p>
          </div>
          <div class="trax-card-pad pt-0">
            <label class="form-label small" for="set-terms">Text (Markdown)</label>
            <textarea id="set-terms" class="form-control form-control-sm font-monospace" rows="18"
                      spellcheck="true" :maxlength="termsMax" v-model="termsDraft"
                      placeholder="# Terms &amp; conditions&#10;&#10;## 1. Scope&#10;These terms apply to every hire …"></textarea>
            <div class="form-text small d-flex gap-2">
              <span class="flex-grow-1">
                <code># Heading</code>, <code>**bold**</code>, <code>*italic*</code>,
                <code>- list</code>, <code>1. list</code>, <code>[label](https://…)</code>.
                A line break stays a line break.
              </span>
              <span class="text-nowrap">{{ termsDraft.length }} / {{ termsMax }}</span>
            </div>
            <div class="form-text small">
              Every save publishes a new version. Signatures already taken keep pointing at the
              version they accepted, which stays readable at its own link below.
            </div>
          </div>
        </div>

        <div v-if="termsVersions.length" class="trax-card mt-3">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">Versions</h2>
            <ul class="list-unstyled small mb-0">
              <li v-for="entry in termsVersions" :key="entry.version" class="py-1">
                <a v-if="!entry.empty" :href="termsUrl(entry.version)" target="_blank"
                   rel="noopener noreferrer">Version {{ entry.version }}</a>
                <span v-else class="text-secondary">Version {{ entry.version }} (withdrawn)</span>
                <span class="text-secondary">
                  · {{ formatDateTime(entry.at) }}<span v-if="entry.actor"> · {{ entry.actor }}</span>
                </span>
                <span v-if="entry.version === state.terms.version && state.terms.active"
                      class="trax-kind-chip ms-1">in force</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div class="col-12 col-xl-6">
        <div class="trax-card">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">Preview</h2>
            <p class="trax-page-sub">As customers see it, rendered by the server.</p>
          </div>
          <div class="trax-card-pad pt-0">
            <div v-if="termsPreviewError" class="alert alert-danger py-2 px-3 small" role="alert">
              {{ termsPreviewError }}
            </div>
            <div v-if="termsHtml" class="trax-terms-preview" v-html="termsHtml"></div>
            <p v-else class="small text-secondary mb-0">Nothing to preview.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Account --------------------------------------------------------- -->
    <div v-else-if="section === 'account'" class="row g-3">
      <div class="col-12 col-xl-6">
        <div class="trax-card">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">Account</h2>
            <p class="trax-page-sub">The password this operator signs in with.</p>
            <p v-if="authInfo && authInfo.effectiveMode === 'external'"
               class="trax-page-sub text-warning-emphasis">
              Sign-in currently goes through the external include, so this password is only
              used as a fallback — if that include disappears, login.php comes back.
            </p>
          </div>
          <div class="trax-card-pad pt-0">
            <template v-if="authInfo && authInfo.effectiveMode === 'external'">
              <label class="form-label small" for="set-pw-user">Fallback account username</label>
              <input id="set-pw-user" type="text" autocomplete="username"
                     class="form-control form-control-sm mb-1" v-model="account.username">
              <div class="form-text small mb-2">
                Which built-in account to change. The external include does not sign you in
                as one of these, so it has to be named.
              </div>
            </template>

            <label class="form-label small" for="set-pw-current">Current password</label>
            <input id="set-pw-current" type="password" autocomplete="current-password"
                   class="form-control form-control-sm mb-2" v-model="account.current">

            <label class="form-label small" for="set-pw-new">New password</label>
            <input id="set-pw-new" type="password" autocomplete="new-password"
                   class="form-control form-control-sm mb-1" v-model="account.next">
            <div class="form-text small">At least 10 characters.</div>

            <label class="form-label small mt-2" for="set-pw-confirm">Repeat new password</label>
            <input id="set-pw-confirm" type="password" autocomplete="new-password"
                   class="form-control form-control-sm mb-2" v-model="account.confirm">

            <div v-if="accountError" class="alert alert-danger py-2 px-3 small" role="alert">
              {{ accountError }}
            </div>

            <button class="btn btn-sm btn-primary" :disabled="accountBusy"
                    @click="changePassword()">
              <span v-if="accountBusy" class="spinner-border spinner-border-sm me-1"></span>
              Change password
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Authentication --------------------------------------------------- -->
    <div v-else-if="section === 'authentication'" class="row g-3">
      <div class="col-12 col-xl-7">
        <div class="trax-card">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">Authentication</h2>
            <p class="trax-page-sub">
              How people get into this installation. Saved to lib/config.local.php, in force
              from the next request.
            </p>
          </div>

          <div class="trax-card-pad pt-0">
            <div v-if="authInfo" class="small text-secondary mb-3">
              In force now:
              <strong>{{ authInfo.effectiveMode === 'external' ? 'external include' : 'built-in login' }}</strong>.
              <span v-if="auth.mode === 'external' && authInfo.effectiveMode === 'builtin'"
                    class="text-danger">
                The configured include is not usable, so the built-in login is standing in.
              </span>
              <span v-if="authInfo.includeStatus && auth.mode === 'external'">
                Include: {{ authInfo.includeStatus.message }}
              </span>
              <div>{{ authInfo.hasBuiltinUsers }} built-in account(s) on file.</div>
            </div>

            <div v-for="option in AUTH_MODES" :key="option.value" class="form-check mb-2">
              <input class="form-check-input" type="radio" :value="option.value"
                     :id="'set-auth-' + option.value" v-model="auth.mode">
              <label class="form-check-label" :for="'set-auth-' + option.value">
                {{ option.label }}
                <span class="d-block form-text small mt-0">{{ option.note }}</span>
              </label>
            </div>

            <div v-if="auth.mode === 'external'" class="mt-3">
              <label class="form-label small" for="set-auth-include">Path to the include</label>
              <div class="input-group input-group-sm mb-1">
                <input id="set-auth-include" type="text" class="form-control form-control-sm"
                       placeholder="/var/www/example.com/auth/check_auth.php"
                       v-model="auth.include" @input="authTest = null">
                <button class="btn btn-outline-secondary" :disabled="authBusy"
                        @click="testAuthInclude()">Test path</button>
              </div>
              <div class="form-text small">
                An absolute path on this server. It has to end the request for anonymous
                visitors and put the username in $_SESSION['trax_user'].
              </div>
              <div v-if="authTest" class="small mt-1"
                   :class="authTest.ok ? 'text-success' : 'text-danger'">
                {{ authTest.message }}
              </div>

              <label class="form-label small mt-3" for="set-auth-logout">Sign-out URL</label>
              <input id="set-auth-logout" type="text" class="form-control form-control-sm"
                     placeholder="https://example.com/logout" v-model="auth.logoutUrl">
              <div class="form-text small">
                Optional. Where the Sign out button goes. Empty drops the local session and
                returns to the app.
              </div>
            </div>

            <div v-if="authError" class="alert alert-danger py-2 px-3 small mt-3" role="alert">
              {{ authError }}
            </div>

            <button class="btn btn-sm btn-primary mt-3" :disabled="authBusy"
                    @click="saveAuthConfig()">
              <span v-if="authBusy" class="spinner-border spinner-border-sm me-1"></span>
              Save authentication
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Defaults & automation ------------------------------------------ -->
    <div v-else class="row g-3">
      <div class="col-12 col-xl-6">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">Defaults</h2>
            <p class="trax-page-sub">What a new checkout or reservation starts with.</p>
          </div>
          <div class="trax-card-pad pt-0 row g-2">
            <div class="col-6">
              <label class="form-label small" for="set-loan">Loan days</label>
              <input id="set-loan" type="number" min="1" max="365"
                     class="form-control form-control-sm" v-model.number="draft.defaults.loanDays">
            </div>
            <div class="col-6">
              <label class="form-label small" for="set-grace">Overdue grace days</label>
              <input id="set-grace" type="number" min="0" max="90"
                     class="form-control form-control-sm" v-model.number="draft.defaults.overdueGraceDays">
            </div>
            <div class="col-6">
              <label class="form-label small" for="set-due-hour">Due hour</label>
              <select id="set-due-hour" class="form-select form-select-sm" v-model.number="draft.defaults.dueHour">
                <option v-for="hour in HOURS" :key="hour" :value="hour">{{ hour }}:00</option>
              </select>
            </div>
            <div class="col-6">
              <label class="form-label small" for="set-start-hour">Reservation start hour</label>
              <select id="set-start-hour" class="form-select form-select-sm"
                      v-model.number="draft.defaults.reservationStartHour">
                <option v-for="hour in HOURS" :key="hour" :value="hour">{{ hour }}:00</option>
              </select>
            </div>
            <div class="col-6">
              <label class="form-label small" for="set-warranty-months">Default warranty (months)</label>
              <input id="set-warranty-months" type="number" min="0" max="120"
                     class="form-control form-control-sm" v-model.number="draft.defaults.warrantyMonths">
              <div class="form-text small">
                Applied to the warranty date when a purchase date is entered. 0 turns it off.
              </div>
            </div>
            <div class="col-6">
              <label class="form-label small" for="set-currency">Currency</label>
              <input id="set-currency" class="form-control form-control-sm" maxlength="8"
                     v-model="draft.defaults.currency">
            </div>
            <div class="col-6">
              <label class="form-label small" for="set-locale">Locale</label>
              <input id="set-locale" class="form-control form-control-sm" list="set-locale-options"
                     maxlength="35" v-model="draft.defaults.locale">
              <datalist id="set-locale-options">
                <option v-for="tag in LOCALES" :key="tag" :value="tag"></option>
              </datalist>
              <div class="form-text small">
                A BCP 47 tag. Formats money in the admin. Pick one or type any tag your
                browser knows, e.g. <code>pt-BR</code>.
              </div>
            </div>
            <div class="col-6">
              <label class="form-label small" for="set-dateformat">Date format</label>
              <input id="set-dateformat" class="form-control form-control-sm" maxlength="40"
                     v-model="draft.defaults.dateFormat">
              <div class="form-text small">
                PHP <code>date()</code> format for labels, mails and the public page —
                <code>Y-m-d H:i</code> gives 2026-08-28 17:00, <code>d.m.Y H:i</code> gives
                28.08.2026 17:00, <code>m/d/Y g:ia</code> gives 08/28/2026 5:00pm.
              </div>
            </div>
            <div class="col-12">
              <div class="form-check form-switch">
                <input class="form-check-input" type="checkbox" role="switch" id="set-partial"
                       v-model="draft.defaults.allowPartialDefault">
                <label class="form-check-label small" for="set-partial">
                  Allow partial fulfilment by default
                  <span class="d-block text-secondary" style="font-size:.72rem">
                    Hand out what is free instead of refusing the whole request.
                  </span>
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="col-12 col-xl-6">
        <div class="trax-card h-100">
          <div class="trax-card-pad">
            <h2 class="trax-page-title">Scheduled run</h2>
            <p class="trax-page-sub">cron.php sends the reminders and the owner digest.</p>
          </div>
          <div class="trax-card-pad pt-0">
            <div class="row g-2 mb-2">
              <div class="col-6">
                <label class="form-label small" for="set-duesoon">Due-soon window (hours)</label>
                <input id="set-duesoon" type="number" min="1" max="168"
                       class="form-control form-control-sm" v-model.number="draft.cron.dueSoonHours">
              </div>
              <div class="col-6">
                <label class="form-label small" for="set-repeat">Overdue repeat (days)</label>
                <input id="set-repeat" type="number" min="1" max="90"
                       class="form-control form-control-sm" v-model.number="draft.cron.overdueRepeatDays">
              </div>
            </div>

            <label class="form-label small" for="set-secret">Shared secret</label>
            <div class="d-flex gap-1">
              <input id="set-secret" class="form-control form-control-sm" v-model="draft.cron.secret"
                     placeholder="not set — the HTTP trigger is refused">
              <button class="btn btn-sm btn-outline-secondary" @click="generateSecret()">
                <i class="bi bi-shuffle"></i> Generate
              </button>
            </div>

            <div v-if="!cronUrl" class="alert alert-warning py-2 px-3 small mt-2 mb-0">
              <i class="bi bi-exclamation-triangle"></i>
              No secret is saved, so <code>cron.php</code> refuses every HTTP request.
              Generate one and save — the URL to hand to the host appears here.
              A command-line run (<code>php cron.php</code>) never needs it.
            </div>

            <div v-else class="mt-2">
              <label class="form-label small" for="set-cron-url">Give this URL to the host's cron</label>
              <div class="d-flex gap-1">
                <input id="set-cron-url" class="form-control form-control-sm font-monospace"
                       :value="cronUrl" readonly>
                <button class="btn btn-sm btn-outline-secondary" @click="copyCronUrl()"
                        title="Copy the cron URL">
                  <i class="bi bi-clipboard"></i>
                </button>
              </div>
              <div class="form-text small">
                Once every hour is plenty. Append <code>&amp;dry=1</code> to see what it would send.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Save bar -------------------------------------------------------- -->
    <!-- Account and Authentication are not part of the settings draft: they
         write users.json and lib/config.local.php, and each saves itself.
         Terms neither: a save there publishes a version, so it has its own bar. -->
    <div v-if="section === 'terms'" class="trax-selection-bar">
      <span v-if="termsWithdraw" class="small text-warning-emphasis">
        Saving an empty text withdraws the terms.
      </span>
      <span v-else-if="termsDirty" class="small">
        Unsaved changes. Saving publishes <strong>version {{ state.terms.version + 1 }}</strong>.
      </span>
      <span v-else class="text-secondary small">No unsaved changes.</span>
      <span class="flex-grow-1"></span>
      <button class="btn btn-sm btn-outline-secondary" :disabled="!termsDirty || termsBusy"
              @click="revertTerms()">
        Discard
      </button>
      <button class="btn btn-sm" :class="termsWithdraw ? 'btn-outline-danger' : 'btn-primary'"
              :disabled="!termsDirty || termsBusy" @click="saveTermsDraft()">
        <span v-if="termsBusy" class="spinner-border spinner-border-sm me-1"></span>
        {{ termsWithdraw ? 'Withdraw terms' : 'Publish' }}
      </button>
    </div>
    <div v-else-if="section !== 'taxonomy' && section !== 'account' && section !== 'authentication'"
         class="trax-selection-bar">
      <span v-if="dirty"><strong>{{ Object.keys(patch).length }}</strong> section(s) changed</span>
      <span v-else class="text-secondary small">No unsaved changes.</span>
      <span class="flex-grow-1"></span>
      <button class="btn btn-sm btn-outline-secondary" :disabled="!dirty || busy" @click="revert()">
        Discard
      </button>
      <button class="btn btn-sm btn-primary" :disabled="!dirty || busy" @click="save()">
        <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
        Save settings
      </button>
    </div>

    <ConfirmDialog v-if="pending" :title="pending.title" :message="pending.message"
                   :confirm-label="pending.confirmLabel" danger
                   @confirm="runPending()" @cancel="pending = null" />
  `,
};
