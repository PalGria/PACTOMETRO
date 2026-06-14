import { $ } from '../utils.js';

// ── ROSTER DRAWER (mobile) ────────────────────────
export function openRoster() {
  $('standings-panel').classList.add('open');
  $('drawer-overlay').classList.add('on');
}

export function closeRoster() {
  $('standings-panel').classList.remove('open');
  $('drawer-overlay').classList.remove('on');
}
