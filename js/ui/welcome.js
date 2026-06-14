import { $ } from '../utils.js';

// ── WELCOME OVERLAY ──────────────────────────────
export function showWelcome() { $('welcome').classList.remove('hidden'); }
export function hideWelcome() { $('welcome').classList.add('hidden'); }
