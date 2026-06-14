import S from '../state.js';
import { $, fmtOmw, playerColor } from '../utils.js';
import { buildHistory } from '../tournament.js';
import { renderSimRoundTabs, renderSimulation } from './simulation.js';
import { renderChart } from './chart.js';
import { renderHistory } from './history.js';
import { renderOpponentTracker } from './tracker.js';

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

  // Avatar (initials)
  $('d-avatar').textContent = handle.slice(0, 2).toUpperCase();
  $('d-avatar').style.background = color + '18';
  $('d-avatar').style.color = color;
  $('d-avatar').style.border = `1px solid ${color}40`;

  $('d-handle').textContent = handle;
  $('d-real').textContent   = latest.player.best_identifier;
  $('d-rank').textContent   = '#' + latest.rank;
  $('d-rec').textContent    = latest.record;
  $('d-pts').textContent    = latest.points + ' pts';
  $('d-omw').textContent    = fmtOmw(latest.opponent_match_win_percentage);
  $('d-gw').textContent     = fmtOmw(latest.game_win_percentage);

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

export function clearDetail() {
  S.activeId = null;
  $('d-placeholder').style.display = '';
  $('d-content').style.display     = 'none';
}
