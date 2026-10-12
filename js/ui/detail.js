import S from '../state.js';
import { $, fmtOmw, playerColor } from '../utils.js';
import { buildHistory } from '../tournament.js';
import { renderSimRoundTabs, renderSimulation } from './simulation.js';
import { renderChart } from './chart.js';
import { renderHistory } from './history.js';
import { renderOpponentTracker } from './tracker.js';
import { projectRound } from '../engine/adapter.js';

// ── RENDER: DETAIL ───────────────────────────────
export function renderDetail(pid) {
  // Get latest data for this player
  const withData = S.rounds.filter(r => r.standings_status === 'GENERATED');
  const lastRound = withData.at(-1);
  if (!lastRound) return;
  const latest = (S.standings[lastRound.id] || []).find(p => p.id === pid);
  if (!latest) return;

  const ues = latest.user_event_status;
  const handle = ues.best_identifier || latest.player.best_identifier;
  const color  = playerColor(pid);
  const active = ues.registration_status === 'COMPLETE';

  $('d-placeholder').style.display = 'none';
  $('d-content').style.display     = '';
  $('llm-fallback').style.display  = 'none';

  // Avatar (initials)
  $('d-avatar').textContent = handle.slice(0, 2).toUpperCase();
  $('d-avatar').style.background = color + '18';
  $('d-avatar').style.color = color;
  $('d-avatar').style.border = `1px solid ${color}40`;

  const liveRound   = S.rounds.find(r => r.status === 'IN_PROGRESS' && r.pairings_status === 'GENERATED');
  const shownRound  = liveRound ?? lastRound;
  const totalSwiss  = S.rounds.filter(r => r.phase_type === 'SWISS').length;
  const roundEl     = $('d-round');
  roundEl.textContent = `R${shownRound.round_number}${totalSwiss ? '/' + totalSwiss : ''}`;
  roundEl.title       = `${shownRound.phase_name} — Round ${shownRound.round_number}${liveRound ? ' (LIVE)' : ''}`;

  const proj = liveRound ? projectRound(liveRound.id, {}).find(p => p.id === pid) : null;

  $('d-handle').textContent = handle;
  $('d-real').textContent   = latest.player.best_identifier;
  $('d-rank').textContent   = '#' + (proj ? proj.projRank : latest.rank) + (proj?.unknown ? '?' : '');
  $('d-rec').textContent    = proj ? proj.record : latest.record;
  $('d-pts').textContent    = (proj ? proj.projPts : latest.points) + ' pts';
  $('d-omw').textContent    = fmtOmw(proj ? proj.omw : latest.opponent_match_win_percentage);
  $('d-gw').textContent     = fmtOmw(proj ? proj.gw  : latest.game_win_percentage);

  const statusEl = $('d-status');
  statusEl.textContent = active ? 'ACTIVE' : 'ELIMINATED';
  statusEl.className   = 'stat-val ' + (active ? 'green' : 'red');

  const history = buildHistory(pid);
  renderSimRoundTabs();
  renderSimulation(pid);
  renderChart(history);
  renderHistory(history);
  renderOpponentTracker(pid);
}

// Drops the selected player and shows the Analysis tab's placeholder. The
// Overview dashboard is a separate board tab now (see js/ui/boardTabs.js) —
// this no longer renders it.
export function clearDetail() {
  S.activeId = null;
  $('d-content').style.display = 'none';
  $('d-placeholder').style.display = '';
  document.querySelectorAll('.p-row.active').forEach(tr => tr.classList.remove('active'));
}
