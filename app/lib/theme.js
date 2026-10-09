import { reactive } from 'vue';

/**
 * Light, dark or whatever the system says. The choice is per device
 * (localStorage), like the system setting it overrides; admin.php applies it
 * before the first paint with the same rules, so there is no flash.
 */

const KEY = 'traxTheme';
const PREFS = ['auto', 'light', 'dark'];
const media = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

function readPref() {
  try {
    const value = localStorage.getItem(KEY);
    return PREFS.includes(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export const theme = reactive({ pref: readPref(), dark: false });

/** Sets data-bs-theme (Bootstrap and app.css both key off it) and the bar colour. */
export function applyTheme() {
  const dark = theme.pref === 'dark' || (theme.pref === 'auto' && Boolean(media?.matches));
  theme.dark = dark;
  const root = document.documentElement;
  // Ease the switch instead of flashing every surface at once.
  root.classList.add('trax-theme-switching');
  root.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
  setTimeout(() => root.classList.remove('trax-theme-switching'), 300);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#000000' : '#f2f2f7');
}

export function setThemePref(pref) {
  theme.pref = PREFS.includes(pref) ? pref : 'auto';
  try {
    localStorage.setItem(KEY, theme.pref);
  } catch { /* private mode: applies to this visit only */ }
  applyTheme();
}

media?.addEventListener?.('change', () => {
  if (theme.pref === 'auto') applyTheme();
});

export const THEME_OPTIONS = [
  { id: 'auto', label: 'Auto', icon: 'bi-circle-half' },
  { id: 'light', label: 'Light', icon: 'bi-sun' },
  { id: 'dark', label: 'Dark', icon: 'bi-moon-stars' },
];
