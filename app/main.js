/**
 * Admin entry point.
 *
 * No build step: Vue resolves through the importmap in admin.php, and every
 * component is a plain module exporting an options object with a template
 * string. The full esm-browser build is vendored because those templates need
 * the runtime compiler.
 */

import { createApp } from 'vue';
import AppShell from './components/AppShell.js';
import { toast } from './store.js';

/**
 * Prefix on everything this file logs. Deliberately not the app name from
 * settings: these two handlers fire for errors that can happen before the
 * first snapshot has landed, and a console prefix that is sometimes 'Assets'
 * and sometimes the operator's name is harder to grep than a fixed one.
 */
const LOG_PREFIX = '[app]';

const app = createApp(AppShell);

// A component error should surface, not vanish into the console the way the
// old code's silent `console.error` save failures did.
app.config.errorHandler = (error, instance, info) => {
  console.error(LOG_PREFIX, error, info);
  toast(`Something went wrong: ${error?.message || error}`, 'danger', 8000);
};

window.addEventListener('unhandledrejection', (event) => {
  console.error(`${LOG_PREFIX} unhandled rejection`, event.reason);
});

app.mount('#app');
