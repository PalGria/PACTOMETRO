import S from '../state.js';
import { $, extractEventId } from '../utils.js';
import { api } from '../services/api.js';
import { saveUrl, savePlayer, saveCache, loadCache, applyCache } from '../services/storage.js';
import { loader } from '../ui/loader.js';
import { showWelcome, hideWelcome } from '../ui/welcome.js';
import { renderBanner } from '../ui/banner.js';
import { renderRoundTabs, renderStandings } from '../ui/standings.js';
import { renderDetail, clearDetail } from '../ui/detail.js';
import { openRoster, closeRoster } from './rosterController.js';
import { resetTracker } from '../ui/tracker.js';
import { resetRoundSim } from '../ui/roundSim.js';
import { resetOppPool, renderOppPool } from '../ui/oppPool.js';

// ── LOAD EVENT ───────────────────────────────────
export async function loadEvent(url, restorePlayerId = null, { fromCache = false } = {}) {
  const eid = extractEventId(url);
  if (!eid) { alert('Could not find event ID in URL'); return; }

  // Try cache first when restoring session (not when user explicitly clicks Load)
  if (fromCache) {
    const cached = loadCache(eid);
    if (cached) {
      applyCache(cached);
      const withStandings = S.rounds.filter(r => r.standings_status === 'GENERATED');
      S.viewRound = withStandings.at(-1)?.id ?? S.rounds.at(-1)?.id;
      saveUrl(url);
      $('board-tabs').style.display = '';
      renderBanner();
      renderRoundTabs();
      renderStandings();
      if (restorePlayerId) {
        selectPlayer(restorePlayerId);
      } else {
        clearDetail();
        if (window.innerWidth <= 760) openRoster();
      }
      return;
    }
  }

  hideWelcome();
  loader(true);
  S.standings = {}; S.matches = {}; S.rounds = []; S.activeId = null;
  resetTracker();

  try {
    const ev = await api(`/events/${eid}/`);
    S.event = ev;

    S.rounds = ev.tournament_phases.flatMap(phase =>
      phase.rounds.map(r => ({ ...r, phase_name: phase.phase_name, phase_type: phase.round_type }))
    );

    // Fetch all standings + matches in parallel
    await Promise.all([
      Promise.all(
        S.rounds.filter(r => r.standings_status === 'GENERATED').map(r =>
          api(`/tournament-rounds/${r.id}/standings/paginated/`, { page: 1, page_size: 200 })
            .then(d => { S.standings[r.id] = d.results; })
            .catch(() => { S.standings[r.id] = []; })
        )
      ),
      Promise.all(
        S.rounds.filter(r => r.pairings_status === 'GENERATED').map(r =>
          api(`/tournament-rounds/${r.id}/matches/paginated/`, { page: 1, page_size: 200 })
            .then(d => { S.matches[r.id] = d.results || []; })
            .catch(() => { S.matches[r.id] = []; })
        )
      ),
    ]);

    const withStandings = S.rounds.filter(r => r.standings_status === 'GENERATED');
    S.viewRound = withStandings.at(-1)?.id ?? S.rounds.at(-1)?.id;

    // Default sim to last Swiss round with data (not Top 8)
    const swissWithData = withStandings.filter(r => r.phase_type === 'SWISS');
    S.simRound = (swissWithData.at(-1) ?? withStandings.at(-1))?.id;

    // Fixed OMW axis across all players & rounds
    let gMin = 1, gMax = 0;
    for (const rows of Object.values(S.standings)) {
      for (const p of rows) {
        const v = p.opponent_match_win_percentage;
        if (v != null) { gMin = Math.min(gMin, v); gMax = Math.max(gMax, v); }
      }
    }
    S.omwRange = { min: Math.max(0, gMin - 0.02), max: Math.min(1, gMax + 0.02) };

    saveUrl(url);
    saveCache(eid);
    resetRoundSim();
    $('board-tabs').style.display = '';
    renderBanner();
    renderRoundTabs();
    renderStandings();

    if (restorePlayerId) {
      selectPlayer(restorePlayerId);
    } else {
      clearDetail();
      if (window.innerWidth <= 760) openRoster();
    }
  } catch(e) {
    alert('Failed to load: ' + e.message);
    console.error(e);
    if (!S.event) { if (window.innerWidth <= 760) openRoster(); else showWelcome(); }
  } finally {
    loader(false);
  }
}

// ── SELECT PLAYER ────────────────────────────────
export function selectPlayer(pid) {
  S.activeId = pid;
  savePlayer(pid);
  document.querySelectorAll('.p-row').forEach(tr =>
    tr.classList.toggle('active', parseInt(tr.dataset.id) === pid)
  );
  renderDetail(pid);
  if (document.getElementById('board')?.classList.contains('pool-mode')) {
    renderOppPool();
  }
  closeRoster();
}

// ── EXIT EVENT ───────────────────────────────────
export function exitEvent() {
  localStorage.removeItem('pm_url');
  localStorage.removeItem('pm_player');
  S.event = null; S.rounds = []; S.standings = {}; S.matches = {};
  S.viewRound = null; S.simRound = null; S.activeId = null;
  resetTracker();
  resetRoundSim();
  resetOppPool();
  $('board-tabs').style.display = 'none';
  const board = document.getElementById('board');
  board?.classList.remove('round-mode');
  board?.classList.remove('pool-mode');
  $('btab-analysis')?.classList.add('on');
  $('btab-round')?.classList.remove('on');
  $('btab-pool')?.classList.remove('on');
  $('url-input').value        = '';
  $('roster-url-input').value = '';
  $('banner').classList.remove('on');
  $('refresh-btn').style.display    = 'none';
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
