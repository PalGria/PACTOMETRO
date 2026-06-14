import { $ } from '../utils.js';

// ── LOADER ───────────────────────────────────────
export function loader(on) {
  $('loader').classList.toggle('on', on);
  $('load-btn').disabled = on;
  $('roster-load-btn').disabled = on;
  $('load-screen').classList.toggle('hidden', !on);
}
