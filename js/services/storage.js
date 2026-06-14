import S from '../state.js';
import { $ } from '../utils.js';

// ── PERSISTENCE ──────────────────────────────────
export function saveUrl(url)  { localStorage.setItem('pm_url', url); }
export function savePlayer(id){ localStorage.setItem('pm_player', String(id)); }
export function clearPlayer() { localStorage.removeItem('pm_player'); }

export function getTopCut() {
  if ($('no-cut-cb').checked) return null;
  return parseInt($('top-cut-input').value) || null;
}

export function saveTopCut() {
  localStorage.setItem('pm_top_cut',    $('top-cut-input').value);
  localStorage.setItem('pm_no_top_cut', $('no-cut-cb').checked ? '1' : '0');
}

export function restoreTopCut() {
  const val   = localStorage.getItem('pm_top_cut');
  const noCut = localStorage.getItem('pm_no_top_cut') === '1';
  if (val) $('top-cut-input').value = val;
  $('no-cut-cb').checked      = noCut;
  $('top-cut-input').disabled = noCut;
}

export function saveCache(eventId) {
  try {
    localStorage.setItem(`pm_cache_${eventId}`, JSON.stringify({
      event:     S.event,
      rounds:    S.rounds,
      standings: S.standings,
      matches:   S.matches,
      savedAt:   Date.now(),
    }));
  } catch(e) {
    // localStorage quota exceeded — skip silently
    console.warn('Cache write failed:', e.message);
  }
}

export function loadCache(eventId) {
  try {
    const raw = localStorage.getItem(`pm_cache_${eventId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch(e) {
    return null;
  }
}

export function applyCache(cached) {
  S.event     = cached.event;
  S.rounds    = cached.rounds;
  S.standings = cached.standings;
  S.matches   = cached.matches;
}
