import S from '../state.js';
import { $ } from '../utils.js';
import { pointsGate } from '../engine/adapter.js';

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

// Day 2 entry points, per event — only shown for events with a later Swiss
// phase entered by points (see adapter.pointsGate). The box shows the
// points in use; a value equal to the default (or an empty box) clears the
// override, so a later change of default still applies.
export function restoreGate() {
  const wrap = $('gate-wrap');
  S.gatePts = null;
  const eid = S.event?.id;
  const saved = eid != null ? parseInt(localStorage.getItem(`pm_gate_${eid}`)) : NaN;
  if (!Number.isNaN(saved)) S.gatePts = saved;
  const g = pointsGate();
  if (!wrap) return;
  wrap.hidden = !g;
  if (!g) return;
  $('gate-input').value = g.pts;
  wrap.title = `Points needed after round ${g.afterRound} to play ${g.phaseName}. The API does not publish it` +
    (g.isChallenge ? `; Challenges have asked for ${g.defaultPts}.` : `; default ${g.defaultPts} (at most two losses).`);
}

export function saveGate() {
  const eid = S.event?.id;
  const g = pointsGate();
  if (eid == null || !g) return;
  const v = parseInt($('gate-input').value);
  S.gatePts = Number.isNaN(v) || v === g.defaultPts ? null : v;
  try {
    if (S.gatePts == null) localStorage.removeItem(`pm_gate_${eid}`);
    else localStorage.setItem(`pm_gate_${eid}`, String(S.gatePts));
  } catch(e) {}
}

// The cache holds the last server bundle so a reopened tab paints instantly;
// the live poller then fetches only if the server has a newer version.
export function saveCache(eventId) {
  try {
    localStorage.setItem(`pm_cache_${eventId}`, JSON.stringify({
      event:      S.event,
      rounds:     S.rounds,
      standings:  S.standings,
      matches:    S.matches,
      version:    S.version,
      updated_at: S.updatedAt,
      finished:   S.finished,
      savedAt:    Date.now(),
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

// ── FOLLOWED PLAYERS (per event) ─────────────────
export function getFollowed(eventId) {
  try { return JSON.parse(localStorage.getItem(`pm_followed_${eventId}`) || '[]'); }
  catch(e) { return []; }
}

export function toggleFollowed(eventId, playerId) {
  const set = new Set(getFollowed(eventId));
  set.has(playerId) ? set.delete(playerId) : set.add(playerId);
  try { localStorage.setItem(`pm_followed_${eventId}`, JSON.stringify([...set])); } catch(e) {}
  return set.has(playerId);
}
