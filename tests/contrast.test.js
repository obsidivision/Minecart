// Text contrast in both themes (WCAG 2): 4.5:1 for text, 3:1 for large headings and UI marks.
const { src, check, done } = require('./load');
const css = src('site.css');
function block(start) { const a = css.indexOf(start), b = css.indexOf('}', a); return css.slice(a, b); }
function vars(text) { const o = {}; text.replace(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\b/g, (m, k, v) => { o[k] = v; }); return o; }
const light = vars(block(':root {')), dark = Object.assign({}, light, vars(block(':root[data-theme="dark"] {')));
function lum(hex) {
  hex = hex.replace('#', ''); if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
  const c = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
// [text, background, minimum]
const PAIRS = [['--fg', '--bg', 4.5], ['--fg-2', '--bg', 4.5], ['--fg-3', '--bg', 4.5], ['--fg', '--card', 4.5], ['--fg-2', '--card', 4.5], ['--fg-3', '--card', 4.5],
  ['--fg-3', '--bg-3', 4.5], ['--fg-2', '--field', 4.5], ['--brand-fg', '--brand', 4.5], ['--brand-text', '--bg', 4.5], ['--brand-text', '--card', 4.5],
  ['--good-text', '--card', 4.5], ['--serious-text', '--card', 4.5], ['--bg', '--fg', 4.5], ['--line-2', '--card', 3]];
for (const [name, T] of [['light', light], ['dark', dark]]) {
  const bad = PAIRS.filter(p => T[p[0]] && T[p[1]] && ratio(T[p[0]], T[p[1]]) < p[2]).map(p => p[0] + ' on ' + p[1] + ' ' + ratio(T[p[0]], T[p[1]]).toFixed(2));
  check(name + ' theme: text contrast', bad.length === 0, bad.join(', '));
}
done();
