import S from '../state.js';
import { $, extractEventId } from '../utils.js';
import { getEventBundle, appBase } from '../services/api.js';
import { saveUrl, savePlayer, saveCache, loadCache } from '../services/storage.js';
import { startLive, stopLive, refreshNow, checkNow } from '../services/live.js';
import { loader } from '../ui/loader.js';
import { showWelcome, hideWelcome } from '../ui/welcome.js';
import { renderBanner } from '../ui/banner.js';
import { renderRoundTabs, renderStandings, resetSearch } from '../ui/standings.js';
import { renderDetail, clearDetail } from '../ui/detail.js';
import { openRoster, closeRoster } from './rosterController.js';
import { resetTracker } from '../ui/tracker.js';
import { resetRoundSim, syncRoundSim, renderRoundSim } from '../ui/roundSim.js';
import { resetOppPool, renderOppPool } from '../ui/oppPool.js';
import { renderAllRounds } from '../ui/allRounds.js';
import { renderOverview } from '../ui/overview.js';
import { validateLoadedEvent, defaultViewRound } from '../engine/adapter.js';
import { switchBoardTab } from '../ui/boardTabs.js';

// ── BUNDLE → STATE ───────────────────────────────
const _latestSwiss = () => {
  const withStandings = S.rounds.filter(r => r.standings_status === 'GENERATED');
  return (withStandings.filter(r => r.phase_type === 'SWISS').at(-1) ?? withStandings.at(-1))?.id ?? null;
};

export function applyBundle(b) {
  S.event     = b.event;
  S.rounds    = b.rounds;
  S.standings = b.standings;
  S.matches   = b.matches;
  S.version   = b.version ?? null;
  S.updatedAt = b.updated_at ?? null;
  S.finished  = !!b.finished;

  // Fixed OMW axis across all players & rounds
  let gMin = 1, gMax = 0;
  for (const rows of Object.values(S.standings)) {
    for (const p of rows) {
      const v = p.opponent_match_win_percentage;
      if (v != null) { gMin = Math.min(gMin, v); gMax = Math.max(gMax, v); }
    }
  }
  S.omwRange = { min: Math.max(0, gMin - 0.02), max: Math.min(1, gMax + 0.02) };

  // Default the top-cut box from the event when the user never set one
  if (b.event?.top_cut_size && !localStorage.getItem('pm_top_cut')) {
    $('top-cut-input').value = b.event.top_cut_size;
  }
}

function _renderAll() {
  $('board-tabs').style.display = '';
  renderBanner();
  renderRoundTabs();
  renderStandings();
  const board = document.getElementById('board');
  if (board?.classList.contains('round-mode'))     renderRoundSim();
  if (board?.classList.contains('pool-mode'))      renderOppPool();
  if (board?.classList.contains('standings-mode')) renderAllRounds();
  if (board?.classList.contains('overview-mode'))  renderOverview();
}

// Keeps the visible URL a valid, re-shareable link to this event — copying
// the address bar always works, regardless of how the event was loaded.
function _syncAddressBar(eid) {
  try { history.replaceState(null, '', `${appBase}evento?e=${eid}`); } catch(e) {}
}

function _highlightActive() {
  document.querySelectorAll('.p-row').forEach(tr =>
    tr.classList.toggle('active', parseInt(tr.dataset.id) === S.activeId)
  );
}

// Called by the live poller / refresh button when the server has a new version.
function _applyUpdate(bundle) {
  const wasLatest      = S.viewRound === defaultViewRound();
  const wasLatestSwiss = S.simRound  === _latestSwiss();

  applyBundle(bundle);

  const exists = id => S.rounds.some(r => r.id === id);
  if (wasLatest || !exists(S.viewRound))     S.viewRound = defaultViewRound();
  if (wasLatestSwiss || !exists(S.simRound)) S.simRound  = _latestSwiss();

  validateLoadedEvent();
  saveCache(S.event.id);
  syncRoundSim();          // lock newly reported results, keep user picks
  _renderAll();
  if (S.activeId) {
    const stillThere = Object.values(S.standings).some(rows => rows.some(p => p.id === S.activeId));
    if (stillThere) { renderDetail(S.activeId); _highlightActive(); }
    else clearDetail();
  }
}

// ── LOAD EVENT ───────────────────────────────────
export async function loadEvent(url, restorePlayerId = null, { fromCache = false } = {}) {
  const eid = extractEventId(url);
  if (!eid) { alert('Could not find event ID in URL'); return; }

  // Restoring a session: paint the cached bundle first, the live poller then
  // fetches whatever changed since.
  if (fromCache) {
    const cached = loadCache(eid);
    if (cached && cached.version) {
      applyBundle(cached);
      S.viewRound = defaultViewRound();
      S.simRound  = _latestSwiss();
      saveUrl(url);
      _syncAddressBar(eid);
      resetRoundSim();
      switchBoardTab(restorePlayerId ? 'analysis' : 'overview');
      _renderAll();
      if (restorePlayerId) selectPlayer(restorePlayerId);
      else { clearDetail(); if (window.innerWidth <= 760) openRoster(); }
      startLive(eid, _applyUpdate);
      setTimeout(checkNow, 300); // the cache may be stale
      return;
    }
  }

  hideWelcome();
  loader(true);
  S.standings = {}; S.matches = {}; S.rounds = []; S.activeId = null;
  resetTracker();
  resetSearch();
  $('search-bar').hidden = true;
  $('search-input').value = '';
  $('search-btn').classList.remove('on');
  $('search-clear-btn').hidden = true;
  stopLive();

  try {
    const bundle = await getEventBundle(eid);
    applyBundle(bundle);
    S.viewRound = defaultViewRound();
    S.simRound  = _latestSwiss();

    // Self-check: the engine must reproduce the API standings exactly.
    const check = validateLoadedEvent();
    if (!check.ok) console.warn('[engine] tiebreaker recomputation differs from API standings; projections may be off');

    saveUrl(url);
    _syncAddressBar(eid);
    saveCache(eid);
    resetRoundSim();
    switchBoardTab(restorePlayerId ? 'analysis' : 'overview');
    _renderAll();

    if (restorePlayerId) {
      selectPlayer(restorePlayerId);
    } else {
      clearDetail();
      if (window.innerWidth <= 760) openRoster();
    }
    startLive(eid, _applyUpdate);
  } catch(e) {
    alert('Failed to load: ' + e.message);
    console.error(e);
    if (!S.event) { if (window.innerWidth <= 760) openRoster(); else showWelcome(); }
  } finally {
    loader(false);
  }
}

// Manual refresh (buttons). Rate-limited by the server; see services/live.js.
export function refreshEvent() {
  return refreshNow();
}

// ── SELECT PLAYER ────────────────────────────────
export function selectPlayer(pid) {
  S.activeId = pid;
  savePlayer(pid);
  _highlightActive();
  renderDetail(pid);
  if (document.getElementById('board')?.classList.contains('pool-mode')) {
    renderOppPool();
  }
  closeRoster();
}

// ── EXIT EVENT ───────────────────────────────────
export function exitEvent() {
  stopLive();
  localStorage.removeItem('pm_url');
  localStorage.removeItem('pm_player');
  S.event = null; S.rounds = []; S.standings = {}; S.matches = {};
  S.viewRound = null; S.simRound = null; S.activeId = null;
  S.version = null; S.updatedAt = null; S.finished = false;
  resetTracker();
  resetRoundSim();
  resetOppPool();
  resetSearch();
  $('search-bar').hidden = true;
  $('search-input').value = '';
  $('search-btn').classList.remove('on');
  $('search-clear-btn').hidden = true;
  $('board-tabs').style.display = 'none';
  switchBoardTab('overview');
  $('url-input').value        = '';
  $('roster-url-input').value = '';
  $('banner').classList.remove('on');
  $('refresh-btn').style.display    = 'none';
  $('share-btn').style.display      = 'none';
  $('exit-btn').style.display       = 'none';
  $('roster-action-row').style.display = 'none';
  $('menu-btn').classList.remove('has-event');
  $('round-tabs').innerHTML = '';
  $('s-body').innerHTML     = '';
  $('s-table').style.display  = 'none';
  $('s-empty').textContent    = 'Load an event to see standings';
  $('s-empty').style.display  = '';
  clearDetail();
  if (window.innerWidth <= 760) openRoster(); else showWelcome();
}
