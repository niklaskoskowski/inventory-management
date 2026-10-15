/**
 * The admin UI's accent colour, per theme (settings.branding.accentLight/Dark).
 *
 * admin.php renders the first <style id="trax-accent"> server-side so nothing
 * flashes blue; this rewrites it when Settings saves a new colour. Same
 * derivation as trax_accent_css() in lib/store.php — keep the two in step.
 */

const HEX = /^#[0-9A-Fa-f]{6}$/;

function mix(rgb, to, t) {
  return '#' + rgb.map((v) => Math.round(v + (to - v) * t).toString(16).padStart(2, '0')).join('');
}

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

export function accentCss(light, dark) {
  let css = '';
  for (const [themeName, hex] of [['light', light], ['dark', dark]]) {
    if (!HEX.test(hex || '')) continue;
    const rgb = hexRgb(hex);
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    const isDark = themeName === 'dark';
    css += `[data-bs-theme='${themeName}']{`
      + `--trax-accent:${hex.toLowerCase()};`
      + `--trax-accent-hover:${mix(rgb, isDark ? 255 : 0, isDark ? 0.15 : 0.12)};`
      + `--trax-accent-soft:rgba(${rgb.join(',')},${isDark ? '0.18' : '0.11'});`
      + `--trax-accent-text:${isDark ? mix(rgb, 255, 0.3) : mix(rgb, 0, 0.12)};`
      + `--trax-on-accent:${lum > 0.6 ? '#000000' : '#ffffff'};`
      + `--bs-primary-rgb:${rgb.join(',')};`
      + `--bs-focus-ring-color:rgba(${rgb.join(',')},${isDark ? '0.45' : '0.35'});`
      + `--bs-link-color-rgb:${hexRgb(isDark ? mix(rgb, 255, 0.3) : mix(rgb, 0, 0.12)).join(',')};`
      + '}';
  }
  return css;
}

/** Writes the accent for the given branding block into the page. */
export function applyAccent(branding) {
  let style = document.getElementById('trax-accent');
  if (!style) {
    style = document.createElement('style');
    style.id = 'trax-accent';
    document.head.appendChild(style);
  }
  const css = accentCss(branding?.accentLight || '', branding?.accentDark || '');
  if (style.textContent !== css) style.textContent = css;
}
