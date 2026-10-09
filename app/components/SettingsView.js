import { ref, computed, watch, onBeforeUnmount } from 'vue';
import {
  state, settings, taxonomyUsage, mutate, toast, saveTerms, previewTerms, termsUrl, markLabeled,
  markLabeledMany, assetById, printerEnabled, printerStatus, buildLabelBatch, printLabelBatch, cancelLabelBatch,
  batchPrefs as loadBatchPrefs, saveBatchPrefs,
} from '../store.js';
import * as api from '../api.js';
import { formatMoney, formatDateTime } from '../lib/format.js';
import {
  assetLabelItems, downloadLabelZip, labelFiles, labelVersion,
} from '../lib/labels.js';
import {
  BLANK_RULE, daysLabel, formatPercent, serviceFactorOf, tierFor,
} from '../lib/rental.js';
import { BLANK_RULE as BLANK_INSPECTION } from '../lib/inspection.js';
import { DEFAULT_STATUSES } from '../lib/events.js';
import { theme, setThemePref, THEME_OPTIONS } from '../lib/theme.js';
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

// 'defaults' is the General tab: appearance, defaults and the scheduled run.
const SECTIONS = [
  { id: 'defaults', label: 'General', icon: 'bi-gear' },
  { id: 'branding', label: 'Branding', icon: 'bi-palette' },
  { id: 'email', label: 'Email', icon: 'bi-envelope' },
  { id: 'rental', label: 'Rental rates', icon: 'bi-cash-coin' },
  { id: 'events', label: 'Events', icon: 'bi-calendar-event' },
  { id: 'inspection', label: 'Inspections', icon: 'bi-clipboard-check' },
  { id: 'taxonomy', label: 'Taxonomy', icon: 'bi-tags' },
  { id: 'labels', label: 'Labels', icon: 'bi-qr-code' },
  { id: 'printer', label: 'Printer', icon: 'bi-printer' },
  { id: 'terms', label: 'Terms', icon: 'bi-file-earmark-text' },
  { id: 'account', label: 'Account', icon: 'bi-person-lock' },
  { id: 'authentication', label: 'Sign-in', icon: 'bi-shield-lock' },
];

/** The formats Settings → Labels can show and pack. */
const LABEL_FORMATS = [
  { id: 'all', label: 'All' },
  { id: 'portrait', label: 'Portrait' },
  { id: 'wide', label: 'Wide' },
  { id: 'cable', label: 'Cable' },
];

/** The cable flag's blank middle, mm. Mirrors TRAX_CABLE_GAP_* in lib/config.php. */
const CABLE_GAP = { min: 2, max: 60, default: 30 };

/** Settings → Printer. Mirrors TRAX_PRINTER_* in lib/config.php. */
const PRINTER_FORMATS = [
  { id: 'wide', label: 'Wide · 30 × 14 mm' },
  { id: 'portrait', label: 'Portrait · 14 × 30 mm' },
  { id: 'cable', label: 'Cable flag · 14 mm high' },
];
const PRINTER_TAPES = [
  { mm: 0, label: 'Any (as loaded)' },
  { mm: 4, label: '3.5 mm' },
  { mm: 6, label: '6 mm' },
  { mm: 9, label: '9 mm' },
  { mm: 12, label: '12 mm' },
  { mm: 18, label: '18 mm' },
  { mm: 24, label: '24 mm' },
];

/** Printable height per tape width, mm (180 dpi head). Mirrors ptbridge/protocol.py. */
const TAPE_PRINTABLE_MM = { 4: 3.39, 6: 4.52, 9: 7.06, 12: 9.88, 18: 15.8, 24: 18.06 };

/** Which labels Settings → Labels lists: all, or by whether they are on the gear. */
const LABEL_STATES = [
  { id: 'all', label: 'All' },
  { id: 'unlabeled', label: 'Unlabeled' },
  { id: 'labeled', label: 'Labeled' },
];

/** The two ways in. Mirrors TRAX_AUTH_MODE in lib/config.php. */
const AUTH_MODES = [
  {
    value: 'builtin',
    label: 'Built-in login',
    note: 'Accounts kept here, sign-in at login.php',
  },
  {
    value: 'external',
    label: 'External auth include',
    note: 'A PHP file on this server signs people in',
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
  { key: 'sendCheckoutConfirmation', label: 'Checkout confirmation', note: 'When items go out' },
  { key: 'sendReservationConfirmation', label: 'Reservation confirmation', note: 'When a reservation is booked' },
  { key: 'sendExtend', label: 'Extension confirmed', note: 'When a due date moves' },
  { key: 'sendCheckin', label: 'Return receipt', note: 'When items come back' },
];

const CRON_MAIL = [
  { key: 'sendDueSoon', label: 'Due-soon reminder', note: 'Before the due date' },
  { key: 'sendOverdue', label: 'Overdue reminder', note: 'Repeats after the due date' },
  { key: 'sendOwnerDigest', label: 'Owner digest', note: 'Daily summary to the owner' },
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
    const section = ref('defaults');
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
      next.printer = next.printer || {};
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
      if (!rule) return 'Not tested';
      const months = Math.max(0, Number(rule.intervalMonths) || 0);
      const every = months
        ? `every ${months} month${months === 1 ? '' : 's'}`
        : 'never due';
      const fields = (rule.fields || []).filter(Boolean);
      return `${rule.label || 'Inspection'} · ${every}`
        + (fields.length ? ` · ${fields.join(', ')}` : '');
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

    // --- Labels ---

    /** Which formats the preview shows and the ZIP holds. */
    const labelFormat = ref('all');
    /** Which labels: all, only those still to stick on, or only those that are. */
    const labelState = ref('all');

    const wantsFormat = (format) => labelFormat.value === 'all' || labelFormat.value === format;

    /** Every label in the inventory (asset and unit), filtered by labelState. */
    const labelItems = computed(() => state.assets
      .flatMap(assetLabelItems)
      .filter((item) => labelState.value === 'all'
        || (labelState.value === 'labeled') === item.labeled));

    const labelCounts = computed(() => {
      const all = state.assets.flatMap(assetLabelItems);
      const labeled = all.filter((item) => item.labeled).length;
      return { all: all.length, labeled, unlabeled: all.length - labeled };
    });

    const chosenLabelFiles = computed(() => labelItems.value
      .flatMap((item) => labelFiles(item.assetId, item.unitNo))
      .filter((file) => wantsFormat(file.format)));

    const labelFileCount = computed(() => chosenLabelFiles.value.length);

    /** labelVersion() of one label, from the current inventory and settings. */
    const versionOf = (item) => labelVersion(assetById.value.get(item.assetId), item.unitNo, state.settings);

    /**
     * The live preview: the chosen labels, as the server renders them now.
     * `v` is ignored by the label endpoints; it changes only when something
     * printed on that label does (a rename, the branding, the cable gap), so
     * those re-render the tile, and a Labeled tick or any other save does not
     * re-render the whole page. The images load lazily, so a long inventory
     * costs only what is scrolled to.
     */
    const labelPreviews = computed(() => labelItems.value.map((item) => {
      const [portrait, wide, cable] = labelFiles(item.assetId, item.unitNo);
      const v = `&v=${versionOf(item)}`;
      return {
        ...item,
        key: `${item.assetId}.${item.unitNo ?? ''}`,
        portrait: wantsFormat('portrait') ? portrait.url + v : null,
        wide: wantsFormat('wide') ? wide.url + v : null,
        cable: wantsFormat('cable') ? cable.url + v : null,
      };
    }));

    /** The cable flag's blank middle in mm, and saving a new one. */
    const cableGapMm = computed(() => Number(state.settings?.labels?.cableGapMm) || CABLE_GAP.default);
    const cableGapBusy = ref(false);
    const saveCableGap = async (event) => {
      const raw = Math.round(Number(event.target.value));
      // Out of range or not a number: put the field back to what is stored
      // rather than letting the server clamp it to something not typed.
      if (!Number.isFinite(raw) || raw < CABLE_GAP.min || raw > CABLE_GAP.max) {
        toast(`The cable gap is ${CABLE_GAP.min}–${CABLE_GAP.max} mm.`, 'warning');
        event.target.value = cableGapMm.value;
        return;
      }
      if (raw === cableGapMm.value) return;
      cableGapBusy.value = true;
      try {
        await mutate('settings.update', { patch: { labels: { cableGapMm: raw } } });
      } catch {
        event.target.value = cableGapMm.value;
      } finally {
        cableGapBusy.value = false;
      }
    };

    /**
     * Ticks a label as on the gear, or takes the tick off again. The switch's
     * own state is the wish, so quick clicks on one or many tiles queue up in
     * the store instead of racing each other.
     */
    const toggleLabeled = async (item, event) => {
      const input = event.target;
      try {
        await markLabeled(item.assetId, item.unitNo, input.checked);
      } catch {
        /* toast already raised by the store */
      } finally {
        // Not saved, or ticked back: show what is stored, not the click.
        const stored = assetLabelItems(assetById.value.get(item.assetId) || { units: [] })
          .find((entry) => entry.unitNo === item.unitNo);
        if (stored) input.checked = stored.labeled;
      }
    };

    /**
     * The chosen labels as one ZIP, named after the choice: `labels-all.zip`,
     * `labels-cable-unlabeled.zip`. `labelZip` is {done, total} while it runs,
     * so the button can say how far it has got.
     */
    const labelZip = ref(null);
    const downloadAllLabels = async () => {
      if (labelZip.value) return;
      const files = chosenLabelFiles.value;
      if (!files.length) {
        toast('There are no labels to download for this choice.', 'warning');
        return;
      }
      const name = ['labels', labelFormat.value, labelState.value === 'all' ? '' : labelState.value]
        .filter(Boolean).join('-');
      labelZip.value = { done: 0, total: files.length };
      try {
        await downloadLabelZip(files, `${name}.zip`, (done, total) => {
          labelZip.value = { done, total };
        });
      } catch (error) {
        toast(`Could not build the label archive: ${error.message}`, 'danger', 8000);
      } finally {
        labelZip.value = null;
      }
    };

    // --- Label printer ---
    // The connection lives in the settings draft (saved through the save bar);
    // the test and the batch print use what is SAVED, never the draft.

    /** The printer group differs from what is stored. */
    const printerDirty = computed(() => Boolean(patch.value.printer));
    const showPrinterSecrets = ref(false);
    /** null | {busy} | {data} | {error} — the last "Test connection". */
    const printerTest = ref(null);
    const testPrinter = async () => {
      printerTest.value = { busy: true };
      try {
        printerTest.value = { data: await printerStatus() };
      } catch (error) {
        printerTest.value = { error: error.message };
      }
    };
    const printerTestStatus = computed(() => printerTest.value?.data?.printer?.status || null);

    // --- Batch printing (Settings → Labels) ---
    // Tick labels, pick format and orientation, print them as ONE job: the
    // bridge half-cuts between them and cuts once at the end – one strip,
    // no leading waste per label. The labels go up once (buildLabelBatch);
    // a preview and the print after it reuse them while nothing changed.

    const batchPrefs = loadBatchPrefs();
    /** Ticked labels, by `${assetId}.${unitNo}`. Replaced, never mutated, so Vue sees every change. */
    const picked = ref(new Set());
    const batchFormat = ref(batchPrefs.format);
    const batchOrientation = ref(batchPrefs.orientation);
    const batchCut = ref(batchPrefs.cut);
    const batchCopies = ref(1);
    // Remembered for this browser – the label drawer prints copies and unit
    // labels as a strip with the same cutting and orientation.
    watch([batchFormat, batchOrientation, batchCut], () => {
      saveBatchPrefs({ format: batchFormat.value, orientation: batchOrientation.value, cut: batchCut.value });
    });
    // Looking at one format means printing that one.
    watch(labelFormat, (format) => { if (format !== 'all') batchFormat.value = format; });

    const labelKey = (item) => `${item.assetId}.${item.unitNo ?? ''}`;
    /** The ticked labels, in inventory order – including ones the filter hides right now. */
    const batchItems = computed(() => state.assets.flatMap(assetLabelItems)
      .filter((item) => picked.value.has(labelKey(item))));
    const batchHidden = computed(() => {
      const shown = new Set(labelPreviews.value.map((label) => label.key));
      return batchItems.value.filter((item) => !shown.has(labelKey(item))).length;
    });
    const isPicked = (label) => picked.value.has(label.key);
    const togglePick = (label) => {
      const next = new Set(picked.value);
      if (next.has(label.key)) next.delete(label.key); else next.add(label.key);
      picked.value = next;
    };
    const pickAllShown = () => {
      const next = new Set(picked.value);
      for (const label of labelPreviews.value) next.add(label.key);
      picked.value = next;
    };
    const clearPicked = () => { picked.value = new Set(); };

    /** The tape the estimate is for: the expected one, else what the printer last said. */
    const printerTape = ref(null);
    const loadPrinterTape = async () => {
      if (!printerEnabled.value || printerTape.value !== null) return;
      printerTape.value = 0;
      try {
        const data = await printerStatus();
        printerTape.value = Number(data.printer?.status?.tapeMm) || 0;
      } catch {
        /* no estimate then – printing still tells */
      }
    };
    watch(section, (id) => { if (id === 'labels') loadPrinterTape(); }, { immediate: true });
    const batchTape = computed(() => Number(state.settings?.printer?.tapeMm) || printerTape.value || 0);

    const formatMm = (format) => {
      if (format === 'portrait') return [14, 30];
      if (format === 'cable') return [60 + cableGapMm.value, 14];
      return [30, 14];
    };

    /** What one label comes out as, and how long the strip gets – before anything is sent. */
    const batchEstimate = computed(() => {
      const printable = TAPE_PRINTABLE_MM[batchTape.value];
      if (!printable) return null;
      const [w, h] = formatMm(batchFormat.value);
      const across = batchOrientation.value === 'across' ? Math.max(w, h) : Math.min(w, h);
      const along = batchOrientation.value === 'across' ? Math.min(w, h) : Math.max(w, h);
      const scale = state.settings?.printer?.fit === 'fill'
        ? printable / across
        : Math.min(1, printable / across);
      const count = batchItems.value.length * Math.max(1, Number(batchCopies.value) || 1);
      const margin = Number(state.settings?.printer?.marginMm) || 0;
      return {
        tape: batchTape.value,
        length: (along * scale).toFixed(1),
        height: (across * scale).toFixed(1),
        pct: Math.round(scale * 100),
        strip: count ? ((count * along * scale + (count - 1) * 2 * margin) / 10).toFixed(1) : '0',
      };
    });

    /** null | {phase: upload|preview|print, done, total, stop} */
    const batchBusy = ref(null);
    /** The last preview: {src, job}. Cleared by anything that would change it. */
    const batchPreview = ref(null);
    /** Labels of the last printed batch, for "mark as labeled". */
    const batchPrinted = ref([]);
    let builtBatch = null;

    // What the uploaded PNGs depend on: a Labeled tick in between is no reason to upload again.
    const batchSignature = () => JSON.stringify([
      batchFormat.value, batchItems.value.map((item) => `${labelKey(item)}:${versionOf(item)}`),
    ]);

    watch(() => [batchSignature(), batchOrientation.value, batchCut.value, batchCopies.value].join('|'), () => {
      batchPreview.value = null;
    });

    const ensureBatch = async () => {
      const signature = batchSignature();
      if (builtBatch && builtBatch.signature === signature) return builtBatch.id;
      if (builtBatch) cancelLabelBatch(builtBatch.id);
      builtBatch = null;
      batchBusy.value = { phase: 'upload', done: 0, total: batchItems.value.length, stop: false };
      const id = await buildLabelBatch(batchItems.value, batchFormat.value, (done, total) => {
        if (batchBusy.value) batchBusy.value = { ...batchBusy.value, done, total };
      }, () => Boolean(batchBusy.value?.stop));
      builtBatch = { id, signature };
      return id;
    };

    const runBatch = async (dryRun) => {
      if (batchBusy.value) {
        if (batchBusy.value.phase === 'upload') batchBusy.value = { ...batchBusy.value, stop: true };
        return;
      }
      if (!batchItems.value.length) {
        toast('Tick the labels to print first.', 'warning');
        return;
      }
      const items = batchItems.value;
      const options = {
        format: batchFormat.value,
        orientation: batchOrientation.value,
        cut: batchCut.value,
        copies: Math.max(1, Math.min(20, Math.round(Number(batchCopies.value) || 1))),
        dryRun,
      };
      try {
        let result = null;
        for (let attempt = 0; attempt < 2 && !result; attempt += 1) {
          const id = await ensureBatch();
          batchBusy.value = { phase: dryRun ? 'preview' : 'print' };
          try {
            result = await printLabelBatch(id, options);
          } catch (error) {
            // Expired on the bridge (30 min) or the bridge restarted: upload once more.
            if (attempt === 0 && error?.details?.bridgeCode === 'NOT_FOUND') {
              builtBatch = null;
              continue;
            }
            throw error;
          }
        }
        const job = result.job || {};
        if (dryRun) {
          batchPreview.value = { src: result.preview || '', job };
          return;
        }
        builtBatch = null;
        batchPreview.value = null;
        batchPrinted.value = items;
        const verb = job.state === 'printed' ? 'Printed' : 'Sent';
        toast(`${verb} ${job.labels || items.length} labels as one job on ${job.tapeLabel || 'the'} tape.`, 'success');
        if (job.warnings?.length) toast(job.warnings[0], 'warning', 8000);
      } catch (error) {
        if (error?.message !== 'Stopped.') toast(error.message, 'danger', 9000);
      } finally {
        batchBusy.value = null;
      }
    };

    const markPrintedLabeled = async () => {
      const items = batchPrinted.value.filter((item) => !item.labeled);
      batchPrinted.value = [];
      if (!items.length) {
        toast('They are all marked as labeled already.', 'info');
        return;
      }
      try {
        await markLabeledMany(items, true);
      } catch {
        return; /* the store raised a toast */
      }
      toast(`${items.length} label${items.length === 1 ? '' : 's'} marked as on the gear.`, 'success');
    };

    onBeforeUnmount(() => {
      if (builtBatch) cancelLabelBatch(builtBatch.id);
    });

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
      SECTIONS, AUTH_MODES, theme, setThemePref, THEME_OPTIONS, TAXONOMIES, CUSTOMER_MAIL, CRON_MAIL, HOURS, LOCALES,
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
      CABLE_GAP, cableGapMm, cableGapBusy, saveCableGap,
      PRINTER_FORMATS, PRINTER_TAPES, printerEnabled, printerDirty, showPrinterSecrets,
      printerTest, printerTestStatus, testPrinter,
      batchFormat, batchOrientation, batchCut, batchCopies, batchItems, batchHidden, isPicked, togglePick,
      pickAllShown, clearPicked, batchEstimate, batchBusy, batchPreview, batchPrinted, runBatch,
      markPrintedLabeled,
      LABEL_FORMATS, LABEL_STATES, labelFormat, labelState, labelCounts, labelFileCount,
      labelZip, downloadAllLabels, labelPreviews, toggleLabeled,
      state, termsDraft, termsBusy, termsMax, termsDirty, termsWithdraw, termsVersions,
      saveTermsDraft, revertTerms, termsHtml, termsPreviewError, termsUrl, formatDateTime,
    };
  },
  template: `
    <div class="trax-settings">
    <nav class="trax-tabs" aria-label="Settings sections">
      <button v-for="tab in SECTIONS" :key="tab.id" type="button"
              class="trax-tab" :class="{ active: section === tab.id }"
              :aria-current="section === tab.id ? 'true' : undefined"
              @click="section = tab.id">
        <i class="bi" :class="tab.icon"></i> {{ tab.label }}
      </button>
    </nav>

    <div class="trax-set-body">

    <!-- Taxonomy ------------------------------------------------------- -->
    <div v-if="section === 'taxonomy'" class="row g-4">
      <div v-for="group in TAXONOMIES" :key="group.kind" class="col-12 col-lg-6 col-xxl-4">
        <div class="trax-list-header">
          <i class="bi" :class="group.icon"></i> {{ group.label }}
          <span class="fw-normal">{{ taxonomyUsage[group.key].length }}</span>
        </div>
        <div class="trax-list">
          <div v-for="row in taxonomyUsage[group.key]" :key="row.value" class="trax-row trax-set-stack">
            <div class="d-flex align-items-center gap-2">
              <span class="trax-set-label text-truncate">{{ row.value }}</span>
              <span class="trax-kind-chip">{{ row.count }}</span>
              <button type="button" class="trax-set-icon" :disabled="busy"
                      :title="'Rename ' + row.value" :aria-label="'Rename ' + row.value"
                      @click="startEdit(group.kind, row.value, 'rename')">
                <i class="bi bi-pencil"></i>
              </button>
              <button type="button" class="trax-set-icon"
                      :disabled="busy || !mergeOptions(group.key, row.value).length"
                      :title="'Merge ' + row.value + ' into another value'"
                      :aria-label="'Merge ' + row.value + ' into another value'"
                      @click="startEdit(group.kind, row.value, 'merge')">
                <i class="bi bi-sign-merge-left"></i>
              </button>
              <button type="button" class="trax-set-icon is-danger" :disabled="busy"
                      :title="'Clear ' + row.value + ' on ' + row.count + ' asset(s)'"
                      :aria-label="'Clear ' + row.value"
                      @click="askDelete(group, row.value)">
                <i class="bi bi-trash"></i>
              </button>
            </div>

            <div v-if="isEditing(group.kind, row.value, 'rename')" class="d-flex gap-1">
              <input class="form-control form-control-sm" v-model="editValue"
                     :aria-label="'New name for ' + row.value"
                     @keydown.enter="rename(group, row.value)">
              <button class="btn btn-sm btn-primary" :disabled="busy" @click="rename(group, row.value)">
                Rename
              </button>
              <button class="btn btn-sm btn-outline-secondary" @click="cancelEdit()">Cancel</button>
            </div>

            <div v-if="isEditing(group.kind, row.value, 'merge')" class="d-flex gap-1">
              <select class="form-select form-select-sm" v-model="editValue"
                      :aria-label="'Merge ' + row.value + ' into'">
                <option value="">Merge into…</option>
                <option v-for="option in mergeOptions(group.key, row.value)"
                        :key="option.value" :value="option.value">
                  {{ option.value }} ({{ option.count }})
                </option>
              </select>
              <button class="btn btn-sm btn-primary" :disabled="busy || !editValue"
                      @click="askMerge(group, row.value)">Merge</button>
              <button class="btn btn-sm btn-outline-secondary" @click="cancelEdit()">Cancel</button>
            </div>
          </div>

          <div v-if="!taxonomyUsage[group.key].length" class="trax-row">
            <span class="trax-set-label text-secondary">No {{ group.kind }} in use yet.</span>
          </div>
        </div>
      </div>
      <p class="trax-set-foot col-12 mt-2">Editing a value rewrites every asset that uses it.</p>
    </div>

    <!-- Rental rates ---------------------------------------------------- -->
    <div v-else-if="section === 'rental'" class="trax-set-col">
      <div>
        <div class="trax-list-header">Default rate</div>
        <div class="trax-list">
          <div class="trax-row trax-set-stack">
            <RentalRate :rule="draft.rental.default" variant="rule" :show-tiers="true"
                        :show-service="true" :inherit-factor="1" :currency="currency" />
          </div>
          <div class="trax-row">
            <label class="trax-set-label" for="set-rental-preview">
              Preview for
              <span class="trax-set-hint">{{ rulePreview(draft.rental.default) }}</span>
            </label>
            <div class="input-group input-group-sm trax-set-ctl is-narrow">
              <input id="set-rental-preview" class="form-control text-end"
                     type="number" min="1" max="3650" v-model="previewDays">
              <span class="input-group-text">days</span>
            </div>
          </div>
        </div>
        <p class="trax-set-foot">
          Per day, as % of the item's value, or a fixed price. Full service = rate × factor.
        </p>
      </div>

      <div class="mt-4">
        <div class="trax-list-header">
          Per category <span class="fw-normal">{{ rentalRows.length }}</span>
        </div>
        <div class="trax-list">
          <div v-for="row in rentalRows" :key="row.name" class="trax-row trax-set-stack">
            <div class="d-flex align-items-center gap-2">
              <span class="trax-set-label">
                {{ row.name }}
                <span v-if="!row.rule" class="trax-set-hint">Default rate</span>
              </span>
              <span class="trax-kind-chip">{{ row.count }}</span>
              <button v-if="!row.rule" type="button" class="btn btn-sm btn-outline-primary trax-set-act"
                      :disabled="busy" @click="addRentalRule(row.name)">
                <i class="bi bi-plus"></i> Rate
              </button>
              <button v-else type="button" class="trax-set-icon is-danger"
                      :disabled="busy" :title="'Hire ' + row.name + ' at the default rate again'"
                      :aria-label="'Remove the rate for ' + row.name"
                      @click="removeRentalRule(row.name)">
                <i class="bi bi-x-lg"></i>
              </button>
            </div>

            <template v-if="row.rule">
              <RentalRate :rule="row.rule" variant="rule" :show-tiers="true"
                          :show-service="true" :inherit-factor="defaultFactor"
                          :currency="currency" />
              <div class="trax-set-hint">{{ rulePreview(row.rule) }}</div>
            </template>
          </div>

          <div v-if="!rentalRows.length" class="trax-row">
            <span class="trax-set-label text-secondary">No categories in use yet.</span>
          </div>
        </div>
        <p class="trax-set-foot">Assets and units can still override this in their Rental tab.</p>
      </div>
    </div>

    <!-- Events ------------------------------------------------------------ -->
    <div v-else-if="section === 'events'" class="trax-set-col">
      <div class="trax-list">
        <div class="trax-row">
          <label class="trax-set-label" for="ev-enabled">
            Events on checkouts &amp; reservations
            <span class="trax-set-hint">Off hides the picker. Booked events stay.</span>
          </label>
          <div class="form-check form-switch trax-set-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="ev-enabled"
                   v-model="draft.events.enabled">
          </div>
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="ev-default">New events start as</label>
          <select id="ev-default" class="form-select form-select-sm trax-set-ctl"
                  v-model="draft.events.defaultStatus">
            <option v-for="status in eventStatuses" :key="status.id || status.label"
                    :value="status.id">
              {{ status.label || status.id }}
            </option>
          </select>
        </div>
      </div>

      <div class="trax-list-header">
        Workflow <span class="fw-normal">{{ eventStatuses.length }}</span>
        <span class="flex-grow-1"></span>
        <button type="button" class="btn btn-sm btn-outline-primary"
                :disabled="busy || eventStatuses.length >= 12" @click="addEventStatus()">
          <i class="bi bi-plus"></i> Status
        </button>
      </div>
      <div class="trax-list">
        <div v-for="(status, si) in eventStatuses" :key="si" class="trax-row flex-wrap gap-2">
          <div class="btn-group btn-group-sm flex-shrink-0">
            <button type="button" class="btn btn-outline-secondary trax-set-act"
                    :disabled="si === 0" :aria-label="'Move ' + (status.label || 'status') + ' up'"
                    @click="moveEventStatus(si, -1)">
              <i class="bi bi-chevron-up"></i>
            </button>
            <button type="button" class="btn btn-outline-secondary trax-set-act"
                    :disabled="si === eventStatuses.length - 1"
                    :aria-label="'Move ' + (status.label || 'status') + ' down'"
                    @click="moveEventStatus(si, 1)">
              <i class="bi bi-chevron-down"></i>
            </button>
          </div>

          <input class="form-control form-control-sm col-12 col-sm order-first order-sm-0 min-w-0"
                 v-model="status.label" maxlength="40" placeholder="e.g. At customer"
                 :title="status.id ? 'ID: ' + status.id : undefined"
                 :aria-label="'Name of status ' + (si + 1)"
                 @blur="nameEventStatus(status)">

          <input class="form-control form-control-color form-control-sm flex-shrink-0" type="color"
                 style="width:2.25rem" v-model="status.color"
                 :aria-label="'Colour of ' + (status.label || 'status ' + (si + 1))">

          <div class="form-check form-switch mb-0 flex-shrink-0" title="Closed ends the job">
            <input class="form-check-input" type="checkbox" role="switch"
                   :id="'ev-closed-' + si" v-model="status.closed">
            <label class="form-check-label small" :for="'ev-closed-' + si">Closed</label>
          </div>

          <span v-if="status.id && eventsOnStatus(status.id)" class="trax-kind-chip flex-shrink-0"
                :title="eventsOnStatus(status.id) + ' event(s) on this status'">
            {{ eventsOnStatus(status.id) }}
          </span>
          <button type="button" class="trax-set-icon is-danger ms-auto ms-sm-0"
                  :disabled="eventStatuses.length <= 1"
                  :aria-label="'Remove ' + (status.label || 'status ' + (si + 1))"
                  @click="removeEventStatus(si)">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      </div>
      <p class="trax-set-foot">
        Top to bottom. A closed status ends the job. Renaming keeps events where they are.
      </p>
    </div>

    <!-- Inspections ------------------------------------------------------ -->
    <div v-else-if="section === 'inspection'" class="trax-set-col">
      <div class="trax-list-header">
        Tested categories <span class="fw-normal">{{ inspectionRows.length }}</span>
      </div>
      <div class="trax-list">
        <div v-for="row in inspectionRows" :key="row.name" class="trax-row trax-set-stack">
          <div class="d-flex align-items-center gap-2">
            <label class="trax-set-label" :for="'insp-' + row.name">
              {{ row.name }}
              <span class="trax-set-hint">{{ inspectionSummary(row.rule) }}</span>
            </label>
            <span class="trax-kind-chip">{{ row.count }}</span>
            <div class="form-check form-switch trax-set-switch">
              <input class="form-check-input" type="checkbox" role="switch" :id="'insp-' + row.name"
                     :checked="!!row.rule" :disabled="busy"
                     @change="toggleInspection(row.name, $event.target.checked)">
            </div>
          </div>

          <div v-if="row.rule" class="row g-2">
            <div class="col-12 col-sm-7">
              <label class="form-label mb-1" :for="'insp-label-' + row.name">Test name</label>
              <input class="form-control form-control-sm" :id="'insp-label-' + row.name"
                     v-model="row.rule.label" maxlength="120" placeholder="e.g. DGUV V3">
            </div>
            <div class="col-12 col-sm-5">
              <label class="form-label mb-1" :for="'insp-months-' + row.name"
                     title="0 = record only, nothing falls due">Valid for</label>
              <div class="input-group input-group-sm">
                <input class="form-control text-end" :id="'insp-months-' + row.name"
                       type="number" min="0" max="240" step="1"
                       v-model="row.rule.intervalMonths">
                <span class="input-group-text">months</span>
              </div>
            </div>

            <div class="col-12">
              <div class="d-flex align-items-center gap-2">
                <span class="form-label mb-0 flex-grow-1">
                  Measured values
                  <span v-if="(row.rule.fields || []).length">({{ row.rule.fields.length }})</span>
                </span>
                <button type="button" class="btn btn-sm btn-outline-primary trax-set-act"
                        :disabled="busy || (row.rule.fields || []).length >= 12"
                        @click="addInspectionField(row.rule)">
                  <i class="bi bi-plus"></i> Value
                </button>
              </div>
              <div v-for="(field, fi) in (row.rule.fields || [])" :key="fi"
                   class="d-flex align-items-center gap-1 mt-1">
                <input class="form-control form-control-sm" v-model="row.rule.fields[fi]"
                       maxlength="120" placeholder="e.g. Insulation resistance"
                       :aria-label="'Parameter ' + (fi + 1) + ' of ' + row.name">
                <button type="button" class="trax-set-icon is-danger"
                        :aria-label="'Remove parameter ' + (fi + 1)"
                        @click="removeInspectionField(row.rule, fi)">
                  <i class="bi bi-x-lg"></i>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div v-if="!inspectionRows.length" class="trax-row">
          <span class="trax-set-label text-secondary">No categories in use yet.</span>
        </div>
      </div>
      <p class="trax-set-foot">
        Items in a ticked category get a Test tab. Overdue or failed items are flagged, never
        blocked. Unticking keeps the records already filed.
      </p>
    </div>

    <!-- Email ---------------------------------------------------------- -->
    <div v-else-if="section === 'email'" class="row g-4">
      <div class="col-12 col-xl-6">
        <div class="trax-list-header">Addresses</div>
        <div class="trax-list">
          <div class="trax-row">
            <label class="trax-set-label" for="set-owner">Owner</label>
            <input id="set-owner" type="email" class="form-control form-control-sm trax-set-ctl is-wide"
                   v-model="draft.email.ownerEmail">
          </div>
          <div class="trax-row">
            <label class="trax-set-label" for="set-from">From</label>
            <input id="set-from" type="email" class="form-control form-control-sm trax-set-ctl is-wide"
                   v-model="draft.email.fromEmail">
          </div>
          <div class="trax-row">
            <label class="trax-set-label" for="set-report-from">
              Reports from <span class="trax-set-hint">Digest &amp; reminders</span>
            </label>
            <input id="set-report-from" type="email" class="form-control form-control-sm trax-set-ctl is-wide"
                   v-model="draft.email.reportFromEmail">
          </div>
        </div>
        <p class="trax-set-foot">An invalid address falls back to the server default.</p>
      </div>

      <div class="col-12 col-xl-6">
        <div class="trax-list-header">To the customer</div>
        <div class="trax-list">
          <div v-for="row in CUSTOMER_MAIL" :key="row.key" class="trax-row">
            <label class="trax-set-label" :for="'set-' + row.key">
              {{ row.label }} <span class="trax-set-hint">{{ row.note }}</span>
            </label>
            <div class="form-check form-switch trax-set-switch">
              <input class="form-check-input" type="checkbox" role="switch"
                     :id="'set-' + row.key" v-model="draft.email[row.key]">
            </div>
          </div>
        </div>

        <div class="trax-list-header">Scheduled (cron.php)</div>
        <div class="trax-list">
          <div v-for="row in CRON_MAIL" :key="row.key" class="trax-row">
            <label class="trax-set-label" :for="'set-' + row.key">
              {{ row.label }} <span class="trax-set-hint">{{ row.note }}</span>
            </label>
            <div class="form-check form-switch trax-set-switch">
              <input class="form-check-input" type="checkbox" role="switch"
                     :id="'set-' + row.key" v-model="draft.email[row.key]">
            </div>
          </div>
        </div>
      </div>

      <!-- Texts ------------------------------------------------------- -->
      <div class="col-12">
        <div class="trax-list-header">Mail texts</div>
        <div class="row g-3">
          <div class="col-12 col-xl-3">
            <div class="trax-list">
              <button v-for="key in templateKeys" :key="key" type="button"
                      class="trax-row is-tappable trax-set-pick" :class="{ 'is-active': key === templateKey }"
                      :aria-pressed="key === templateKey ? 'true' : 'false'"
                      @click="templateKey = key">
                <span class="trax-set-label text-truncate">{{ mailTemplates[key].label }}</span>
                <i v-if="templateError(key, 'subject') || templateError(key, 'body')"
                   class="bi bi-exclamation-triangle-fill text-danger"></i>
                <span v-else-if="isCustomised(key)" class="trax-kind-chip">edited</span>
              </button>
              <div v-if="!templateKeys.length" class="trax-row">
                <span class="trax-set-label text-secondary">Reload to load the templates.</span>
              </div>
            </div>
          </div>

          <div v-if="templateSpec" class="col-12 col-md-7 col-xl-5">
            <div class="trax-list">
              <div class="trax-row trax-set-stack">
                <label class="trax-set-label" for="set-tpl-subject">Subject</label>
                <input id="set-tpl-subject" class="form-control form-control-sm"
                       :class="{ 'is-invalid': templateError(templateKey, 'subject') }"
                       :maxlength="subjectMax" :placeholder="templateSpec.subject"
                       v-model="draft.email.templates[templateKey].subject"
                       @input="clearTemplateError(templateKey, 'subject')">
                <div v-if="templateError(templateKey, 'subject')" class="invalid-feedback d-block mt-0">
                  {{ templateError(templateKey, 'subject') }}
                </div>
              </div>
              <div class="trax-row trax-set-stack">
                <label class="trax-set-label d-flex" for="set-tpl-body">
                  <span class="flex-grow-1">Body</span>
                  <span class="fw-normal">{{ templateEntry(templateKey).body.length }} / {{ bodyMax }}</span>
                </label>
                <textarea id="set-tpl-body" rows="12"
                          class="form-control form-control-sm font-monospace"
                          :class="{ 'is-invalid': templateError(templateKey, 'body') }"
                          :maxlength="bodyMax" :placeholder="templateSpec.body"
                          v-model="draft.email.templates[templateKey].body"
                          @input="clearTemplateError(templateKey, 'body')"></textarea>
                <div v-if="templateError(templateKey, 'body')" class="invalid-feedback d-block mt-0">
                  {{ templateError(templateKey, 'body') }}
                </div>
              </div>
            </div>
            <p class="trax-set-foot">
              {{ templateSpec.note }} Empty uses the built-in text.
            </p>

            <div class="d-flex flex-wrap gap-2 mt-2">
              <button class="btn btn-sm btn-outline-secondary" :disabled="busy"
                      @click="loadDefault(templateKey)">
                <i class="bi bi-clipboard-plus"></i> Start from default
              </button>
              <button class="btn btn-sm btn-outline-danger" :disabled="busy || !isCustomised(templateKey)"
                      @click="resetTemplate(templateKey)">
                <i class="bi bi-arrow-counterclockwise"></i> Reset
              </button>
            </div>

            <div class="trax-list-header">Tokens</div>
            <div class="trax-list">
              <div v-for="token in templateTokens" :key="token.name" class="trax-kv">
                <span>
                  <code>{{ token.token }}</code>
                  <span v-if="token.required" class="trax-kind-chip ms-1">required</span>
                  <span class="trax-set-hint">{{ token.note }}</span>
                </span>
              </div>
            </div>
          </div>

          <div v-if="templateSpec" class="col-12 col-md-5 col-xl-4">
            <div class="trax-list">
              <div class="trax-row trax-set-stack">
                <span class="trax-set-label">Preview · subject</span>
                <strong>{{ previewSubject }}</strong>
              </div>
              <div class="trax-row trax-set-stack">
                <span class="trax-set-label">Body</span>
                <pre class="small mb-0" style="white-space:pre-wrap; word-break:break-word">{{ previewBody }}</pre>
              </div>
            </div>
            <p class="trax-set-foot">With sample values. Unknown tokens stay as typed, so saving them is refused.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Branding ------------------------------------------------------- -->
    <div v-else-if="section === 'branding'" class="trax-set-col">
      <div class="trax-brand-preview" :style="{ background: draft.branding.brandColor }"
           title="Brand colour on labels and customer pages">
        {{ draft.branding.orgName || 'Your organisation' }}
      </div>

      <div class="trax-list-header">Identity</div>
      <div class="trax-list">
        <div class="trax-row">
          <label class="trax-set-label" for="set-appname">
            App name <span class="trax-set-hint">Tab, sidebar, PDFs · required</span>
          </label>
          <input id="set-appname" class="form-control form-control-sm trax-set-ctl is-wide"
                 v-model="draft.branding.appName" maxlength="60">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-org">
            Organisation <span class="trax-set-hint">On labels · app name if empty</span>
          </label>
          <input id="set-org" class="form-control form-control-sm trax-set-ctl is-wide"
                 v-model="draft.branding.orgName">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-color">Brand colour</label>
          <div class="d-flex gap-2 trax-set-ctl is-wide">
            <input id="set-color" type="color" class="form-control form-control-color form-control-sm flex-shrink-0"
                   v-model="draft.branding.brandColor">
            <input class="form-control form-control-sm font-monospace" v-model="draft.branding.brandColor"
                   aria-label="Brand colour hex" placeholder="#1F2937" maxlength="7">
          </div>
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-labelheading">
            Label heading <span class="trax-set-hint">Above the logo on labels</span>
          </label>
          <input id="set-labelheading" class="form-control form-control-sm trax-set-ctl is-wide"
                 v-model="draft.branding.labelHeading" maxlength="40" placeholder="PROPERTY OF">
        </div>
      </div>

      <div class="trax-list-header">Public page</div>
      <div class="trax-list">
        <div class="trax-row">
          <label class="trax-set-label" for="set-whatsapp">
            WhatsApp <span class="trax-set-hint">With country code · empty hides it</span>
          </label>
          <input id="set-whatsapp" class="form-control form-control-sm trax-set-ctl is-wide"
                 v-model="draft.branding.whatsapp"
                 inputmode="tel" placeholder="+1 555 0100" maxlength="40">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-public">
            Public path <span class="trax-set-hint">Base of customer links</span>
          </label>
          <input id="set-public" class="form-control form-control-sm trax-set-ctl is-wide font-monospace"
                 v-model="draft.branding.publicPath" placeholder="/assets/">
        </div>
      </div>

      <div class="trax-list-header">Images</div>
      <div class="trax-list">
        <div class="trax-row">
          <label class="trax-set-label" for="set-logo"
                 title="Labels are drawn on the server and need a local file; a URL prints the organisation name instead. PDFs load either, if the host allows CORS.">
            Logo <span class="trax-set-hint">PNG/JPEG file or https URL</span>
          </label>
          <input id="set-logo" class="form-control form-control-sm trax-set-ctl is-wide font-monospace"
                 v-model="draft.branding.logoFile" placeholder="logo.png">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-favicon">
            Favicon <span class="trax-set-hint">PNG in the project root</span>
          </label>
          <input id="set-favicon" class="form-control form-control-sm trax-set-ctl is-wide font-monospace"
                 v-model="draft.branding.faviconFile" placeholder="favicon.png">
        </div>
      </div>
      <p class="trax-set-foot">Labels need a logo file on the server; a URL prints the name as text.</p>
    </div>

    <!-- Labels ------------------------------------------------------------ -->
    <!-- Not part of the settings draft: nothing here is saved through the
         save bar. It shows what the label endpoints render now, ticks labels
         off as they go on the gear (label.mark), and packs a ZIP. -->
    <div v-else-if="section === 'labels'">
      <div class="trax-list">
        <div class="trax-row flex-wrap">
          <span class="trax-set-label">Format</span>
          <div class="btn-group btn-group-sm" role="group" aria-label="Label format">
            <button v-for="option in LABEL_FORMATS" :key="option.id" type="button"
                    class="btn btn-outline-secondary" :class="{ active: labelFormat === option.id }"
                    :aria-pressed="labelFormat === option.id ? 'true' : 'false'"
                    @click="labelFormat = option.id">
              {{ option.label }}
            </button>
          </div>
        </div>
        <div class="trax-row flex-wrap">
          <span class="trax-set-label">Show</span>
          <div class="btn-group btn-group-sm" role="group" aria-label="Labeled or not">
            <button v-for="option in LABEL_STATES" :key="option.id" type="button"
                    class="btn btn-outline-secondary" :class="{ active: labelState === option.id }"
                    :aria-pressed="labelState === option.id ? 'true' : 'false'"
                    @click="labelState = option.id">
              {{ option.label }} <span class="text-secondary">{{ labelCounts[option.id] }}</span>
            </button>
          </div>
        </div>
        <!-- Saved on change: this tab has no save bar, and the preview
             below re-renders from the saved value. -->
        <div class="trax-row">
          <label class="trax-set-label" for="set-cable-gap"
                 title="The blank middle of the cable flag, the part that goes round the cable">
            Cable gap <span class="trax-set-hint">Blank middle of the cable flag</span>
          </label>
          <div class="input-group input-group-sm flex-nowrap trax-cable-gap">
            <input id="set-cable-gap" type="number" class="form-control" inputmode="numeric"
                   :min="CABLE_GAP.min" :max="CABLE_GAP.max" step="1"
                   :value="cableGapMm" :disabled="cableGapBusy" @change="saveCableGap($event)">
            <span class="input-group-text">mm</span>
          </div>
        </div>
        <div class="trax-row">
          <span class="trax-set-label">
            Download <span class="trax-set-hint">{{ labelFileCount }} PNG file(s) as ZIP</span>
          </span>
          <button class="btn btn-sm btn-outline-secondary"
                  :disabled="!!labelZip || !labelFileCount" @click="downloadAllLabels()">
            <span v-if="labelZip" class="spinner-border spinner-border-sm me-1"></span>
            <i v-else class="bi bi-file-earmark-zip"></i>
            {{ labelZip ? 'Labels ' + labelZip.done + ' / ' + labelZip.total
              : 'Download ZIP (' + labelFileCount + ')' }}
          </button>
        </div>
      </div>

      <!-- Batch printing: tick tiles below, print them as one half-cut strip. -->
      <section v-if="printerEnabled" class="trax-batch mt-3">
        <div class="trax-list-header">
          <span><i class="bi bi-printer"></i> Batch print</span>
          <span class="fw-normal">
            {{ batchItems.length }} selected<span v-if="batchHidden"> · {{ batchHidden }} hidden</span>
          </span>
          <span class="flex-grow-1"></span>
          <button type="button" class="btn btn-sm btn-link px-1 py-0"
                  :disabled="!labelPreviews.length || !!batchBusy" @click="pickAllShown()">
            Select all
          </button>
          <button type="button" class="btn btn-sm btn-link px-1 py-0"
                  :disabled="!batchItems.length || !!batchBusy" @click="clearPicked()">
            Clear
          </button>
        </div>
        <div class="trax-list">
          <div class="trax-row">
            <label class="trax-set-label" for="batch-format">Format</label>
            <select id="batch-format" class="form-select form-select-sm trax-set-ctl is-wide" v-model="batchFormat"
                    :disabled="!!batchBusy">
              <option v-for="option in PRINTER_FORMATS" :key="option.id" :value="option.id">{{ option.label }}</option>
            </select>
          </div>
          <div class="trax-row flex-wrap">
            <span class="trax-set-label">Orientation</span>
            <div class="btn-group btn-group-sm" role="group" aria-label="Orientation on the tape">
              <button type="button" class="btn btn-outline-secondary text-nowrap" :disabled="!!batchBusy"
                      :class="{ active: batchOrientation === 'along' }"
                      :aria-pressed="batchOrientation === 'along' ? 'true' : 'false'"
                      title="Long side along the tape: as large as the tape allows"
                      @click="batchOrientation = 'along'">
                <i class="bi bi-arrows"></i> Along tape
              </button>
              <button type="button" class="btn btn-outline-secondary text-nowrap" :disabled="!!batchBusy"
                      :class="{ active: batchOrientation === 'across' }"
                      :aria-pressed="batchOrientation === 'across' ? 'true' : 'false'"
                      title="Turned 90°: long side across the tape – smaller label, shorter strip"
                      @click="batchOrientation = 'across'">
                <i class="bi bi-arrow-clockwise"></i> Rotated 90°
              </button>
            </div>
          </div>
          <div class="trax-row">
            <label class="trax-set-label" for="batch-cut">Cutting</label>
            <select id="batch-cut" class="form-select form-select-sm trax-set-ctl is-wide" v-model="batchCut"
                    :disabled="!!batchBusy">
              <option value="half">Half cut · one strip</option>
              <option value="each">Cut every label</option>
              <option value="none">No cuts between</option>
            </select>
          </div>
          <div class="trax-row">
            <label class="trax-set-label" for="batch-copies">Copies</label>
            <input id="batch-copies" type="number" min="1" max="20"
                   class="form-control form-control-sm trax-set-ctl is-narrow"
                   v-model.number="batchCopies" :disabled="!!batchBusy">
          </div>
          <div class="trax-row flex-wrap">
            <span class="trax-set-label small text-secondary">
              <template v-if="batchEstimate">
                {{ batchEstimate.tape === 4 ? '3.5' : batchEstimate.tape }} mm tape · each
                ≈ {{ batchEstimate.length }} × {{ batchEstimate.height }} mm
                <span :class="{ 'text-warning-emphasis': batchEstimate.pct < 100 }">({{ batchEstimate.pct }} %)</span>
                <span v-if="batchItems.length"> · strip ≈ {{ batchEstimate.strip }} cm</span>
              </template>
              <template v-else>
                Tick labels below. Set the expected tape under Printer for a size estimate.
              </template>
            </span>
            <div class="d-flex gap-2 ms-auto">
              <button type="button" class="btn btn-sm btn-outline-secondary text-nowrap"
                      :disabled="!batchItems.length || (batchBusy && batchBusy.phase !== 'upload')"
                      @click="runBatch(true)">
                <i class="bi bi-eye"></i> Preview
              </button>
              <button type="button" class="btn btn-sm text-nowrap"
                      :class="batchBusy?.phase === 'upload' ? 'btn-outline-danger' : 'btn-primary'"
                      :disabled="!batchItems.length || (batchBusy && batchBusy.phase !== 'upload')"
                      @click="runBatch(false)">
                <template v-if="batchBusy?.phase === 'upload'">
                  <span class="spinner-border spinner-border-sm me-1"></span>
                  {{ batchBusy.stop ? 'Stopping…' : 'Stop · ' + batchBusy.done + ' / ' + batchBusy.total }}
                </template>
                <template v-else-if="batchBusy">
                  <span class="spinner-border spinner-border-sm me-1"></span>
                  {{ batchBusy.phase === 'preview' ? 'Rendering…' : 'Printing…' }}
                </template>
                <template v-else>
                  <i class="bi bi-printer"></i> Print {{ batchItems.length }} label{{ batchItems.length === 1 ? '' : 's' }}
                </template>
              </button>
            </div>
          </div>
        </div>

        <div v-if="batchPreview" class="trax-batch-preview mt-2">
          <img :src="batchPreview.src" alt="Preview of the printed strip">
          <div class="small text-secondary mt-1">
            {{ batchPreview.job.labels }} labels on {{ batchPreview.job.tapeLabel }} tape ·
            strip {{ (batchPreview.job.stripMm / 10).toFixed(1) }} cm ·
            dashed red = cut<span v-if="batchPreview.job.warnings?.length"> ·
            <span class="text-warning-emphasis">{{ batchPreview.job.warnings[0] }}</span></span>
          </div>
        </div>

        <div v-if="batchPrinted.length" class="alert alert-success d-flex align-items-center flex-wrap gap-2 py-2 px-3 small mt-2 mb-0">
          <i class="bi bi-check-circle"></i>
          <span class="flex-grow-1">{{ batchPrinted.length }} labels sent.</span>
          <button type="button" class="btn btn-sm btn-outline-secondary" @click="markPrintedLabeled()">
            Mark as labeled
          </button>
          <button type="button" class="btn btn-sm btn-link px-1" @click="batchPrinted = []">Dismiss</button>
        </div>
      </section>

      <div class="trax-list-header">
        Labels <span class="fw-normal">{{ labelPreviews.length }}</span>
      </div>
      <div v-if="labelPreviews.length" class="trax-card trax-card-pad">
        <div class="trax-label-grid" :class="'trax-label-grid-' + labelFormat">
          <figure v-for="label in labelPreviews" :key="label.key" class="trax-label-tile"
                  :class="{ 'trax-label-done': label.labeled, 'trax-label-picked': printerEnabled && isPicked(label) }">
            <div v-if="label.portrait || label.wide" class="trax-label-pair">
              <a v-if="label.portrait" :href="label.portrait" target="_blank" rel="noopener"
                 :aria-label="'Portrait label ' + label.code">
                <img class="trax-label-portrait" :src="label.portrait" alt="" loading="lazy">
              </a>
              <a v-if="label.wide" :href="label.wide" target="_blank" rel="noopener"
                 :aria-label="'Wide label ' + label.code">
                <img class="trax-label-wide" :src="label.wide" alt="" loading="lazy">
              </a>
            </div>
            <a v-if="label.cable" :href="label.cable" target="_blank" rel="noopener"
               :aria-label="'Cable flag ' + label.code">
              <img class="trax-label-cable" :src="label.cable" alt="" loading="lazy"
                   :style="{ aspectRatio: (60 + cableGapMm) + ' / 14' }">
            </a>
            <figcaption class="d-flex align-items-center gap-2 small">
              <input v-if="printerEnabled" class="form-check-input mt-0 flex-shrink-0" type="checkbox"
                     :checked="isPicked(label)" :disabled="!!batchBusy"
                     :aria-label="'Select ' + label.code + ' for batch printing'" @change="togglePick(label)">
              <span class="text-truncate flex-grow-1" :title="label.title">
                <span class="font-monospace">{{ label.code }}</span>
                <span class="text-secondary"> · {{ label.title }}</span>
              </span>
              <span class="form-check form-switch mb-0" :title="'Label ' + label.code + ' is on the gear'">
                <input class="form-check-input" type="checkbox" role="switch"
                       :id="'labeled-' + label.key" :checked="label.labeled"
                       @change="toggleLabeled(label, $event)">
                <label class="form-check-label text-secondary" :for="'labeled-' + label.key">
                  Labeled
                </label>
              </span>
            </figcaption>
          </figure>
        </div>
      </div>
      <div v-else class="trax-empty">
        <i class="bi bi-qr-code"></i>
        {{ state.assets.length ? 'No labels match this filter.' : 'No assets to label yet.' }}
      </div>
    </div>

    <!-- Label printer ------------------------------------------------------ -->
    <!-- Part of the settings draft: saved through the save bar like Branding.
         "Test connection" asks the bridge with the SAVED values. -->
    <div v-else-if="section === 'printer'" class="trax-set-col">
      <div class="trax-list">
        <div class="trax-row">
          <label class="trax-set-label" for="set-printer-enabled">
            Label printer
            <span class="trax-set-hint">Brother PT-P750W via the print bridge</span>
          </label>
          <div class="form-check form-switch trax-set-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="set-printer-enabled"
                   v-model="draft.printer.enabled">
          </div>
        </div>
      </div>
      <p class="trax-set-foot">Adds “Send to printer” to the label sheet and batch printing to Labels.</p>

      <div class="trax-list-header">Bridge</div>
      <div class="trax-list">
        <div class="trax-row trax-set-stack">
          <label class="trax-set-label" for="set-printer-url">URL</label>
          <input id="set-printer-url" class="form-control form-control-sm font-monospace"
                 type="url" maxlength="300" placeholder="https://print.example.com"
                 autocomplete="off" v-model.trim="draft.printer.bridgeUrl">
        </div>
        <div class="trax-row trax-set-stack">
          <label class="trax-set-label" for="set-printer-token">Token</label>
          <div class="input-group input-group-sm">
            <input id="set-printer-token" class="form-control font-monospace"
                   :type="showPrinterSecrets ? 'text' : 'password'" maxlength="300"
                   autocomplete="new-password" spellcheck="false"
                   placeholder="PTB_TOKEN from the bridge's .env"
                   v-model.trim="draft.printer.token">
            <button class="btn btn-outline-secondary" type="button"
                    :title="showPrinterSecrets ? 'Hide' : 'Show'"
                    :aria-label="showPrinterSecrets ? 'Hide secrets' : 'Show secrets'"
                    @click="showPrinterSecrets = !showPrinterSecrets">
              <i class="bi" :class="showPrinterSecrets ? 'bi-eye-slash' : 'bi-eye'"></i>
            </button>
          </div>
        </div>
        <div class="trax-row">
          <span class="trax-set-label">
            Connection
            <span v-if="printerDirty" class="trax-set-hint">Save first — the test uses saved values.</span>
            <span v-else-if="!state.settings.printer.bridgeUrl" class="trax-set-hint">No bridge URL saved yet.</span>
          </span>
          <button class="btn btn-sm btn-outline-secondary"
                  :disabled="printerDirty || !state.settings.printer.bridgeUrl || printerTest?.busy"
                  @click="testPrinter()">
            <span v-if="printerTest?.busy" class="spinner-border spinner-border-sm me-1"></span>
            <i v-else class="bi bi-plug"></i> Test
          </button>
        </div>
      </div>
      <p class="trax-set-foot">The bridge (pt750w-print-trax) runs next to the printer, e.g. behind a Cloudflare Tunnel.</p>

      <div v-if="printerTest?.error" class="alert alert-danger py-2 px-3 small mt-2 mb-0">
        <i class="bi bi-x-circle"></i> {{ printerTest.error }}
      </div>
      <div v-else-if="printerTest?.data" class="mt-2">
        <div v-if="printerTestStatus?.errors?.length" class="alert alert-warning py-2 px-3 small mb-2">
          <i class="bi bi-exclamation-triangle"></i>
          Printer reports: {{ printerTestStatus.errors.join(', ') }}
        </div>
        <div v-else class="alert alert-success py-2 px-3 small mb-2">
          <i class="bi bi-check-circle"></i>
          Bridge {{ printerTest.data.bridge?.version }} answers<span v-if="printerTestStatus">,
          {{ printerTestStatus.model }} is ready</span><span v-else>, printer is reachable</span>.
        </div>
        <div v-if="printerTestStatus" class="trax-list">
          <div class="trax-kv">
            <span>Tape</span>
            <span class="text-end">
              <strong>{{ printerTestStatus.tapeLabel }}</strong> · {{ printerTestStatus.mediaLabel }}
              <span v-if="draft.printer.tapeMm && printerTestStatus.tapeMm !== draft.printer.tapeMm"
                    class="text-warning-emphasis d-block">
                <i class="bi bi-exclamation-triangle"></i> Not the expected tape — jobs will be refused.
              </span>
            </span>
          </div>
          <div class="trax-kv">
            <span>Colours</span>
            <span>{{ printerTestStatus.textColor }} on {{ printerTestStatus.tapeColor }}</span>
          </div>
          <div class="trax-kv">
            <span>Print height</span>
            <span class="text-end">
              {{ printerTestStatus.printablePins ? (printerTestStatus.printablePins * 25.4 / 180).toFixed(1) + ' mm' : '—' }}
              <span v-if="printerTestStatus.printablePins && printerTestStatus.printablePins < 99"
                    class="text-secondary d-block small">14 mm labels print scaled down</span>
            </span>
          </div>
        </div>
        <p v-else class="trax-set-foot">
          No status over the network: the bridge prints for its default tape
          (<code>PTB_DEFAULT_TAPE_MM</code>, {{ printerTest.data.bridge?.defaults?.tapeMm }} mm).
        </p>
      </div>

      <div class="trax-list-header">Cloudflare Access <span class="fw-normal">optional</span></div>
      <div class="trax-list">
        <div class="trax-row trax-set-stack">
          <label class="trax-set-label" for="set-printer-cfid">Client ID</label>
          <input id="set-printer-cfid" class="form-control form-control-sm font-monospace"
                 maxlength="300" autocomplete="off" spellcheck="false" placeholder="….access"
                 v-model.trim="draft.printer.accessClientId">
        </div>
        <div class="trax-row trax-set-stack">
          <label class="trax-set-label" for="set-printer-cfsecret">Client secret</label>
          <input id="set-printer-cfsecret" class="form-control form-control-sm font-monospace"
                 :type="showPrinterSecrets ? 'text' : 'password'" maxlength="300"
                 autocomplete="new-password" spellcheck="false"
                 v-model.trim="draft.printer.accessClientSecret">
        </div>
      </div>
      <p class="trax-set-foot">A service token, for an Access policy with the action <em>Service Auth</em>.</p>

      <div class="trax-list-header">Print defaults</div>
      <div class="trax-list">
        <div class="trax-row">
          <label class="trax-set-label" for="set-printer-format">Batch format</label>
          <select id="set-printer-format" class="form-select form-select-sm trax-set-ctl is-wide"
                  v-model="draft.printer.format">
            <option v-for="option in PRINTER_FORMATS" :key="option.id" :value="option.id">{{ option.label }}</option>
          </select>
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-printer-copies">Copies</label>
          <input id="set-printer-copies" type="number" min="1" max="20"
                 class="form-control form-control-sm trax-set-ctl is-narrow" v-model.number="draft.printer.copies">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-printer-margin">Margin (mm)</label>
          <input id="set-printer-margin" type="number" min="0" max="30" step="0.5"
                 class="form-control form-control-sm trax-set-ctl is-narrow" v-model.number="draft.printer.marginMm">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-printer-tape">
            Expected tape <span class="trax-set-hint">Other tape → job refused</span>
          </label>
          <select id="set-printer-tape" class="form-select form-select-sm trax-set-ctl"
                  v-model.number="draft.printer.tapeMm">
            <option v-for="option in PRINTER_TAPES" :key="option.mm" :value="option.mm">{{ option.label }}</option>
          </select>
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-printer-fit">
            Size <span class="trax-set-hint">True size shrinks only on narrow tape</span>
          </label>
          <select id="set-printer-fit" class="form-select form-select-sm trax-set-ctl" v-model="draft.printer.fit">
            <option value="exact">True size</option>
            <option value="fill">Fill tape height</option>
          </select>
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-printer-highres">
            High resolution <span class="trax-set-hint">180 × 360 dpi · crisper, a bit slower</span>
          </label>
          <div class="form-check form-switch trax-set-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="set-printer-highres"
                   v-model="draft.printer.highRes">
          </div>
        </div>
      </div>
      <p class="trax-set-foot">14 mm labels print true size on 18/24 mm tape, about 70 % on 12 mm.</p>

      <div class="trax-list-header">Strips</div>
      <div class="trax-list">
        <div class="trax-row">
          <label class="trax-set-label" for="set-printer-batchmode"
                 title="How several labels or copies become one strip. Cutting and orientation are set under Labels → Batch print.">
            Strip mode <span class="trax-set-hint">Labels come out one by one? Try the next.</span>
          </label>
          <select id="set-printer-batchmode" class="form-select form-select-sm trax-set-ctl is-wide"
                  v-model="draft.printer.batchMode">
            <option value="">Bridge default</option>
            <option value="perpage">Chain until last (recommended)</option>
            <option value="chain">Chain all, cut at job end</option>
            <option value="once">Settings once at start</option>
            <option value="noautocut">Half cuts only</option>
            <option value="legacy">Each label alone (old)</option>
          </select>
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-printer-shift"
                 title="Negative moves the print towards the end that comes out first, positive towards the later cut.">
            Strip offset (mm) <span class="trax-set-hint">Centres the print between cuts</span>
          </label>
          <input id="set-printer-shift" type="number" min="-5" max="5" step="0.1"
                 class="form-control form-control-sm trax-set-ctl is-narrow" v-model.number="draft.printer.shiftMm">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-printer-chain">
            Chain printing <span class="trax-set-hint">No final feed and cut · saves tape</span>
          </label>
          <div class="form-check form-switch trax-set-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="set-printer-chain"
                   v-model="draft.printer.chain">
          </div>
        </div>
      </div>
    </div>

    <!-- Terms & conditions ---------------------------------------------- -->
    <div v-else-if="section === 'terms'" class="row g-4">
      <div class="col-12 col-xl-6">
        <div class="trax-list">
          <div class="trax-row">
            <template v-if="state.terms.active">
              <i class="bi bi-check-circle-fill text-success"></i>
              <span class="trax-set-label">
                Version {{ state.terms.version }} in force
                <span class="trax-set-hint">
                  {{ formatDateTime(state.terms.at) }}<span v-if="state.terms.actor"> · {{ state.terms.actor }}</span>
                </span>
              </span>
              <a class="btn btn-sm btn-outline-secondary" :href="termsUrl()" target="_blank"
                 rel="noopener noreferrer">
                <i class="bi bi-box-arrow-up-right"></i> Open
              </a>
            </template>
            <template v-else>
              <i class="bi bi-dash-circle text-secondary"></i>
              <span class="trax-set-label">
                Not published
                <span class="trax-set-hint">No footer link, tick box or line on the sheet.</span>
              </span>
            </template>
          </div>
        </div>
        <p class="trax-set-foot">Customers accept them when signing for a hand-over.</p>

        <div class="trax-list-header">
          <label for="set-terms" class="mb-0">Text (Markdown)</label>
          <span class="flex-grow-1"></span>
          <span class="fw-normal">{{ termsDraft.length }} / {{ termsMax }}</span>
        </div>
        <div class="trax-list">
          <div class="trax-row trax-set-stack">
            <textarea id="set-terms" class="form-control form-control-sm font-monospace" rows="18"
                      spellcheck="true" :maxlength="termsMax" v-model="termsDraft"
                      placeholder="# Terms &amp; conditions&#10;&#10;## 1. Scope&#10;These terms apply to every hire …"></textarea>
          </div>
        </div>
        <p class="trax-set-foot">
          <code># Heading</code> · <code>**bold**</code> · <code>*italic*</code> · <code>- list</code> · <code>[label](https://…)</code>
          <br>Each save publishes a new version; signed versions stay readable.
        </p>

        <template v-if="termsVersions.length">
          <div class="trax-list-header">Versions</div>
          <div class="trax-list">
            <div v-for="entry in termsVersions" :key="entry.version" class="trax-row">
              <span class="trax-set-label">
                <a v-if="!entry.empty" :href="termsUrl(entry.version)" target="_blank"
                   rel="noopener noreferrer">Version {{ entry.version }}</a>
                <span v-else class="text-secondary">Version {{ entry.version }} (withdrawn)</span>
                <span class="trax-set-hint">
                  {{ formatDateTime(entry.at) }}<span v-if="entry.actor"> · {{ entry.actor }}</span>
                </span>
              </span>
              <span v-if="entry.version === state.terms.version && state.terms.active"
                    class="trax-kind-chip">in force</span>
            </div>
          </div>
        </template>
      </div>

      <div class="col-12 col-xl-6">
        <div class="trax-list-header">Preview</div>
        <div class="trax-card trax-card-pad">
          <div v-if="termsPreviewError" class="alert alert-danger py-2 px-3 small" role="alert">
            <i class="bi bi-x-circle"></i> {{ termsPreviewError }}
          </div>
          <div v-if="termsHtml" class="trax-terms-preview" v-html="termsHtml"></div>
          <p v-else class="small text-secondary mb-0">Nothing to preview.</p>
        </div>
      </div>
    </div>

    <!-- Account --------------------------------------------------------- -->
    <div v-else-if="section === 'account'" class="trax-set-col">
      <div v-if="authInfo && authInfo.effectiveMode === 'external'" class="alert alert-warning small mb-3">
        <i class="bi bi-info-circle"></i>
        External sign-in is active. This password is only the fallback.
      </div>

      <div class="trax-list-header">Change password</div>
      <div class="trax-list">
        <div v-if="authInfo && authInfo.effectiveMode === 'external'" class="trax-row">
          <label class="trax-set-label" for="set-pw-user">
            Username <span class="trax-set-hint">Built-in account to change</span>
          </label>
          <input id="set-pw-user" type="text" autocomplete="username"
                 class="form-control form-control-sm trax-set-ctl is-wide" v-model="account.username">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-pw-current">Current</label>
          <input id="set-pw-current" type="password" autocomplete="current-password"
                 class="form-control form-control-sm trax-set-ctl is-wide" v-model="account.current">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-pw-new">
            New <span class="trax-set-hint">At least 10 characters</span>
          </label>
          <input id="set-pw-new" type="password" autocomplete="new-password"
                 class="form-control form-control-sm trax-set-ctl is-wide" v-model="account.next">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-pw-confirm">Repeat</label>
          <input id="set-pw-confirm" type="password" autocomplete="new-password"
                 class="form-control form-control-sm trax-set-ctl is-wide" v-model="account.confirm">
        </div>
      </div>

      <div v-if="accountError" class="alert alert-danger py-2 px-3 small mt-3 mb-0" role="alert">
        <i class="bi bi-x-circle"></i> {{ accountError }}
      </div>

      <div class="d-flex justify-content-end mt-3">
        <button class="btn btn-primary" :disabled="accountBusy" @click="changePassword()">
          <span v-if="accountBusy" class="spinner-border spinner-border-sm me-1"></span>
          Change password
        </button>
      </div>
    </div>

    <!-- Authentication --------------------------------------------------- -->
    <div v-else-if="section === 'authentication'" class="trax-set-col">
      <template v-if="authInfo">
        <div class="trax-list">
          <div class="trax-kv">
            <span>In force now</span>
            <strong>{{ authInfo.effectiveMode === 'external' ? 'External include' : 'Built-in login' }}</strong>
          </div>
          <div class="trax-kv">
            <span>Built-in accounts</span>
            <strong>{{ authInfo.hasBuiltinUsers }}</strong>
          </div>
          <div v-if="authInfo.includeStatus && auth.mode === 'external'" class="trax-kv">
            <span>Include</span>
            <span class="text-end">{{ authInfo.includeStatus.message }}</span>
          </div>
        </div>
        <div v-if="auth.mode === 'external' && authInfo.effectiveMode === 'builtin'"
             class="alert alert-danger py-2 px-3 small mt-2 mb-0">
          <i class="bi bi-exclamation-triangle"></i>
          The include is not usable, so the built-in login is standing in.
        </div>
      </template>

      <div class="trax-list-header">Sign-in method</div>
      <div class="trax-list">
        <div v-for="option in AUTH_MODES" :key="option.value" class="trax-row">
          <label class="trax-set-label" :for="'set-auth-' + option.value">
            {{ option.label }} <span class="trax-set-hint">{{ option.note }}</span>
          </label>
          <input class="form-check-input flex-shrink-0 m-0" type="radio" :value="option.value"
                 :id="'set-auth-' + option.value" v-model="auth.mode">
        </div>
      </div>
      <p class="trax-set-foot">Saved to lib/config.local.php; applies from the next request.</p>

      <template v-if="auth.mode === 'external'">
        <div class="trax-list-header">External include</div>
        <div class="trax-list">
          <div class="trax-row trax-set-stack">
            <label class="trax-set-label" for="set-auth-include">Path to the include</label>
            <div class="input-group input-group-sm">
              <input id="set-auth-include" type="text" class="form-control form-control-sm font-monospace"
                     placeholder="/var/www/example.com/auth/check_auth.php"
                     v-model="auth.include" @input="authTest = null">
              <button class="btn btn-outline-secondary" :disabled="authBusy"
                      @click="testAuthInclude()">Test path</button>
            </div>
            <div v-if="authTest" class="small"
                 :class="authTest.ok ? 'text-success' : 'text-danger'">
              {{ authTest.message }}
            </div>
          </div>
          <div class="trax-row trax-set-stack">
            <label class="trax-set-label" for="set-auth-logout">Sign-out URL (optional)</label>
            <input id="set-auth-logout" type="text" class="form-control form-control-sm"
                   placeholder="https://example.com/logout" v-model="auth.logoutUrl">
          </div>
        </div>
        <p class="trax-set-foot">
          Absolute path. It must stop anonymous requests and set <code>$_SESSION['trax_user']</code>.
          Without a sign-out URL, Sign out returns to the app.
        </p>
      </template>

      <div v-if="authError" class="alert alert-danger py-2 px-3 small mt-3 mb-0" role="alert">
        <i class="bi bi-x-circle"></i> {{ authError }}
      </div>

      <div class="d-flex justify-content-end mt-3">
        <button class="btn btn-primary" :disabled="authBusy" @click="saveAuthConfig()">
          <span v-if="authBusy" class="spinner-border spinner-border-sm me-1"></span>
          Save authentication
        </button>
      </div>
    </div>

    <!-- General: appearance, defaults & automation -------------------- -->
    <div v-else class="trax-set-col">
      <div class="trax-list-header">Appearance</div>
      <div class="trax-list">
        <div class="trax-row flex-wrap">
          <span class="trax-set-label">Theme <span class="trax-set-hint">This device only</span></span>
          <div class="btn-group btn-group-sm" role="group" aria-label="Appearance">
            <button v-for="option in THEME_OPTIONS" :key="option.id" type="button"
                    class="btn btn-outline-secondary" :class="{ active: theme.pref === option.id }"
                    :aria-pressed="theme.pref === option.id ? 'true' : 'false'"
                    @click="setThemePref(option.id)">
              <i class="bi" :class="option.icon"></i> {{ option.label }}
            </button>
          </div>
        </div>
      </div>

      <div class="trax-list-header">Checkouts &amp; reservations</div>
      <div class="trax-list">
        <div class="trax-row">
          <label class="trax-set-label" for="set-loan">Loan days</label>
          <input id="set-loan" type="number" min="1" max="365"
                 class="form-control form-control-sm trax-set-ctl is-narrow" v-model.number="draft.defaults.loanDays">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-grace">Overdue grace days</label>
          <input id="set-grace" type="number" min="0" max="90"
                 class="form-control form-control-sm trax-set-ctl is-narrow" v-model.number="draft.defaults.overdueGraceDays">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-due-hour">Due hour</label>
          <select id="set-due-hour" class="form-select form-select-sm trax-set-ctl is-narrow"
                  v-model.number="draft.defaults.dueHour">
            <option v-for="hour in HOURS" :key="hour" :value="hour">{{ hour }}:00</option>
          </select>
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-start-hour">Reservation start hour</label>
          <select id="set-start-hour" class="form-select form-select-sm trax-set-ctl is-narrow"
                  v-model.number="draft.defaults.reservationStartHour">
            <option v-for="hour in HOURS" :key="hour" :value="hour">{{ hour }}:00</option>
          </select>
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-partial">
            Partial fulfilment <span class="trax-set-hint">Hand out what is free</span>
          </label>
          <div class="form-check form-switch trax-set-switch">
            <input class="form-check-input" type="checkbox" role="switch" id="set-partial"
                   v-model="draft.defaults.allowPartialDefault">
          </div>
        </div>
      </div>

      <div class="trax-list-header">Formats</div>
      <div class="trax-list">
        <div class="trax-row">
          <label class="trax-set-label" for="set-warranty-months">
            Warranty (months) <span class="trax-set-hint">From the purchase date · 0 = off</span>
          </label>
          <input id="set-warranty-months" type="number" min="0" max="120"
                 class="form-control form-control-sm trax-set-ctl is-narrow" v-model.number="draft.defaults.warrantyMonths">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-currency">Currency</label>
          <input id="set-currency" class="form-control form-control-sm trax-set-ctl is-narrow" maxlength="8"
                 v-model="draft.defaults.currency">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-locale" title="A BCP 47 tag, e.g. pt-BR. Formats money in the admin.">
            Locale <span class="trax-set-hint">For money, e.g. de-DE</span>
          </label>
          <input id="set-locale" class="form-control form-control-sm trax-set-ctl" list="set-locale-options"
                 maxlength="35" v-model="draft.defaults.locale">
          <datalist id="set-locale-options">
            <option v-for="tag in LOCALES" :key="tag" :value="tag"></option>
          </datalist>
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-dateformat"
                 title="Y-m-d H:i → 2026-08-28 17:00 · d.m.Y H:i → 28.08.2026 17:00 · m/d/Y g:ia → 08/28/2026 5:00pm">
            Date format <span class="trax-set-hint">PHP date(), e.g. d.m.Y H:i</span>
          </label>
          <input id="set-dateformat" class="form-control form-control-sm trax-set-ctl font-monospace" maxlength="40"
                 v-model="draft.defaults.dateFormat">
        </div>
      </div>
      <p class="trax-set-foot">Dates apply to labels, mails and the public page.</p>

      <div class="trax-list-header">Scheduled run</div>
      <div class="trax-list">
        <div class="trax-row">
          <label class="trax-set-label" for="set-duesoon">Due-soon window (hours)</label>
          <input id="set-duesoon" type="number" min="1" max="168"
                 class="form-control form-control-sm trax-set-ctl is-narrow" v-model.number="draft.cron.dueSoonHours">
        </div>
        <div class="trax-row">
          <label class="trax-set-label" for="set-repeat">Overdue repeat (days)</label>
          <input id="set-repeat" type="number" min="1" max="90"
                 class="form-control form-control-sm trax-set-ctl is-narrow" v-model.number="draft.cron.overdueRepeatDays">
        </div>
        <div class="trax-row trax-set-stack">
          <label class="trax-set-label" for="set-secret">Shared secret</label>
          <div class="d-flex gap-2">
            <input id="set-secret" class="form-control form-control-sm font-monospace" v-model="draft.cron.secret"
                   placeholder="Not set">
            <button class="btn btn-sm btn-outline-secondary text-nowrap" @click="generateSecret()">
              <i class="bi bi-shuffle"></i> Generate
            </button>
          </div>
        </div>
        <div v-if="cronUrl" class="trax-row trax-set-stack">
          <label class="trax-set-label" for="set-cron-url">Cron URL</label>
          <div class="d-flex gap-2">
            <input id="set-cron-url" class="form-control form-control-sm font-monospace"
                   :value="cronUrl" readonly>
            <button class="btn btn-sm btn-outline-secondary trax-set-act" @click="copyCronUrl()"
                    title="Copy the cron URL" aria-label="Copy the cron URL">
              <i class="bi bi-clipboard"></i>
            </button>
          </div>
        </div>
      </div>
      <div v-if="!cronUrl" class="alert alert-warning py-2 px-3 small mt-2 mb-0">
        <i class="bi bi-exclamation-triangle"></i>
        No secret saved: <code>cron.php</code> refuses HTTP calls. Generate one and save.
        CLI runs don't need it.
      </div>
      <p v-else class="trax-set-foot">
        Hourly is plenty. Add <code>&amp;dry=1</code> for a dry run.
      </p>
    </div>

    <!-- Save bar -------------------------------------------------------- -->
    <!-- Account and Authentication are not part of the settings draft: they
         write users.json and lib/config.local.php, and each saves itself.
         Terms neither: a save there publishes a version, so it has its own bar. -->
    <div v-if="section === 'terms'" class="trax-selection-bar">
      <span v-if="termsWithdraw" class="small text-warning-emphasis">
        An empty text withdraws the terms.
      </span>
      <span v-else-if="termsDirty" class="small">
        Publishes <strong>version {{ state.terms.version + 1 }}</strong>
      </span>
      <span v-else class="text-secondary small">No changes</span>
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
    <div v-else-if="section !== 'taxonomy' && section !== 'account' && section !== 'authentication'
                    && section !== 'labels'"
         class="trax-selection-bar">
      <span v-if="dirty" class="small"><strong>{{ Object.keys(patch).length }}</strong> section(s) changed</span>
      <span v-else class="text-secondary small">No changes</span>
      <span class="flex-grow-1"></span>
      <button class="btn btn-sm btn-outline-secondary" :disabled="!dirty || busy" @click="revert()">
        Discard
      </button>
      <button class="btn btn-sm btn-primary" :disabled="!dirty || busy" @click="save()">
        <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
        Save
      </button>
    </div>
    </div>
    </div>

    <ConfirmDialog v-if="pending" :title="pending.title" :message="pending.message"
                   :confirm-label="pending.confirmLabel" danger
                   @confirm="runPending()" @cancel="pending = null" />
  `,
};
