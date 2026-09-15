// ── OVERVIEW: the "Overview" board tab ───────────
// Home dashboard, rendered inside #d-overview (own tab now — see
// js/ui/boardTabs.js) whenever an event is loaded. Panels:
//
//   1. Pact watch — dynamic, tied to the current round: who's already
//      guaranteed in purely by drawing out every remaining round.
//   2. Top cut — two sub-tabs sharing one panel:
//        - Calculator: static reference table, like
//          https://sixprizes.com/top-cut-calculator/, for every reachable
//          final Swiss record. Built from the event's declared round/player
//          counts only, so it never changes as results come in (see
//          js/engine/montecarlo.js's staticCutTable).
//        - Bracket: the elimination bracket (quarterfinals, semifinals,
//          final...) once the event has a Top N phase — see js/ui/bracket.js.
//      Only shown once the event actually has an elimination phase.
//   3. Top N — a live snapshot of the current top `cut` (or 8) standings.
//   4. Followed players — live rank, current-round matchup and tiebreakers
//      for whoever's been starred in the roster.

import S from '../state.js';
import { $, fmtOmw } from '../utils.js';
import { getTopCut, getFollowed } from '../services/storage.js';
import {
  defaultViewRound, projectRound, swissRounds, eventTotals,
  stateAfterRound, futureSwissRounds, activeIdsAfter,
} from '../engine/adapter.js';
import { staticCutTable, pactWindow, pactSet } from '../engine/montecarlo.js';
import { verdictHtml } from './verdict.js';
import { renderBracketHtml } from './bracket.js';
import { getScenarioResults } from './simulation.js';

// Which sub-tab of the Top cut panel is showing. Module-level so it
// survives a re-render (cut changes, live updates) but resets on a fresh
// page load — nobody expects a UI tab choice to be persisted forever.
let _cutTab = 'calculator';

// Guards the async rank-number coloring below (Monte Carlo results come
// back after the panel may have already re-rendered for something else).
let _followedToken = 0;

// Rounds still to play (from `roundId` on) that count as "pact territory" —
// see js/engine/montecarlo.js's pactWindow. Returns { future, inWindow }.
function _pactContext(roundId) {
  const swiss  = swissRounds();
  const future = futureSwissRounds(roundId);
  const inWindow = future.length > 0 && future.length <= pactWindow(swiss.length);
  return { future, inWindow };
}

// Rows for the current default round, live-projected when one is in
// progress — the exact same source the main roster list uses, so the two
// views can never disagree.
function _currentRows() {
  const roundId = defaultViewRound();
  if (!roundId) return { rows: [], canProject: false, roundId: null };
  const round = S.rounds.find(r => r.id === roundId);
  const canProject = round?.status === 'IN_PROGRESS'
    && round?.standings_status !== 'GENERATED'
    && round?.pairings_status === 'GENERATED';
  const rows = canProject ? projectRound(roundId, {}) : (S.standings[roundId] || []);
  return { rows, canProject, roundId };
}

function _rankOf(p, canProject)  { return canProject ? p.projRank : p.rank; }
function _ptsOf(p, canProject)   { return canProject ? p.projPts  : p.points; }
function _omwOf(p, canProject)   { return canProject ? p.omw : p.opponent_match_win_percentage; }
function _gwOf(p, canProject)    { return canProject ? p.gw  : p.game_win_percentage; }
function _ogwOf(p, canProject)   { return canProject ? p.ogw : p.opponent_game_win_percentage; }
function _handleOf(p)            { return p.user_event_status?.best_identifier || p.player?.best_identifier || '?'; }

// This round's match for `pid`: opponent + a compact status.
function _matchupFor(pid, roundId) {
  const m = (S.matches[roundId] || []).find(mt => (mt.players || []).includes(pid));
  if (!m) return null;
  if (m.match_is_bye) return { bye: true };
  const [a, b] = m.players;
  const oppId = a === pid ? b : a;
  if (oppId == null) return null;
  const rel = (m.player_match_relationships || []).find(r => r.player.id === oppId);
  const oppName = rel ? (rel.user_event_status?.best_identifier || rel.player?.best_identifier || '?') : '?';
  if (m.match_is_intentional_draw || m.match_is_unintentional_draw) return { oppId, oppName, status: 'draw' };
  if (m.winning_player != null) return { oppId, oppName, status: 'decided', won: m.winning_player === pid };
  return { oppId, oppName, status: 'pending' };
}

function _matchupHtml(matchup) {
  if (!matchup) return '<span class="ov-mu-none">—</span>';
  if (matchup.bye) return `<span class="ov-mu bye">BYE</span>`;
  const cls   = matchup.status === 'decided' ? (matchup.won ? 'win' : 'loss') : matchup.status;
  const label = matchup.status === 'decided' ? (matchup.won ? 'W' : 'L') : matchup.status === 'draw' ? 'D' : '⋯';
  return `<span class="ov-mu ${cls}">${label}</span><span class="ov-mu-opp">${matchup.oppName}</span>`;
}

// ── PANEL: STATIC TOP CUT CALCULATOR ─────────────
function _renderCutTable(cut) {
  if (!cut) return `<div class="ov-empty">Set a top cut to see the calculator.</div>`;
  const { totalRounds, totalPlayers } = eventTotals();
  if (!totalRounds || !totalPlayers) return `<div class="ov-empty">Waiting for round and player data…</div>`;

  const rows = staticCutTable({ totalRounds, totalPlayers, cut });
  const rowsHtml = rows.map(r => `
    <div class="ov-tier-row">
      <div class="ov-tier-label">${r.wins}-${r.losses}</div>
      <div class="ov-tier-rank">${r.best === r.absoluteWorst ? `#${r.best}` : `#${r.best}–${r.absoluteWorst}`}</div>
      <div>${verdictHtml(r, cut)}</div>
      <div class="ov-tier-count">~${r.count.toFixed(1)}</div>
    </div>`).join('');

  return `
    <div class="ov-tier-header">
      <div>Record</div><div>Rank range</div><div>Verdict</div><div>~Players</div>
    </div>
    ${rowsHtml}
    <div class="ov-tier-note">
      Expected final record over ${totalRounds} Swiss round${totalRounds > 1 ? 's' : ''}, ${totalPlayers} players, Top ${cut} —
      built from the event's round/player counts alone (binomial estimate of Swiss brackets, no draws or
      drops), so this doesn't change as the event progresses. For a specific player's exact,
      live odds as results come in, use the Analysis tab's simulator instead.
    </div>`;
}

// The event only gets a Bracket sub-tab once it actually has an elimination
// phase (a Top N cut) defined at all — most events do, even before it
// starts, but some formats never cut to single elimination.
function _hasElimPhase() {
  return !!S.event?.tournament_phases?.some(p => p.round_type !== 'SWISS');
}

// Panel wrapper for the two Top cut sub-tabs (Calculator / Bracket). Plain
// Calculator (no tab switcher) when the event has no elimination phase.
function _renderCutPanel(cut) {
  if (!_hasElimPhase()) {
    return `
      <div class="ov-panel-title">Top cut calculator</div>
      ${_renderCutTable(cut)}`;
  }
  const tabs = `
    <div class="ov-subtabs" id="ov-cut-subtabs">
      <button class="ov-subtab${_cutTab === 'calculator' ? ' on' : ''}" data-tab="calculator">Calculator</button>
      <button class="ov-subtab${_cutTab === 'bracket' ? ' on' : ''}" data-tab="bracket">Bracket</button>
    </div>`;
  const body = _cutTab === 'bracket' ? renderBracketHtml() : _renderCutTable(cut);
  return `
    <div class="ov-panel-title-row">
      <div class="ov-panel-title">Top cut</div>
      ${tabs}
    </div>
    ${body}`;
}

// ── PANEL: PACT WATCH ─────────────────────────────
function _renderPactPanel(cut) {
  const roundId = defaultViewRound();
  if (!roundId || !cut) return '';
  const { future, inWindow } = _pactContext(roundId);
  if (!inWindow) return '';

  const state     = stateAfterRound(roundId);
  const activeIds = activeIdsAfter(roundId);
  const locked    = pactSet({ state, activeIds, futureRounds: future, cut });

  const { rows } = _currentRows();
  const byId = new Map(rows.map(p => [p.id, p]));
  const names = [...locked].map(id => byId.has(id) ? _handleOf(byId.get(id)) : '?');

  const body = names.length
    ? `<div class="ov-pact-names">${names.map(n => `<span class="ov-pact-name">${n}</span>`).join('')}</div>`
    : `<div class="ov-empty">Nobody is guaranteed in purely by drawing out yet.</div>`;

  return `
    <div class="ov-panel full">
      <div class="ov-panel-title">Pact watch — ${future.length} round${future.length > 1 ? 's' : ''} left</div>
      <div class="ov-empty" style="margin-bottom:.5rem">
        These players make the cut even if they draw out every remaining round,
        assuming the event keeps pairing players with matching records —
        <strong>not</strong> a guarantee under every possible pairing, only under normal Swiss.
      </div>
      ${body}
    </div>`;
}

// ── PANEL: TOP N ───────────────────────────────────
function _renderTopN(cut) {
  const { rows, canProject } = _currentRows();
  if (!rows.length) return `<div class="ov-empty">No standings yet.</div>`;

  const n = cut || 8;
  const top = [...rows].sort((a, b) => _rankOf(a, canProject) - _rankOf(b, canProject)).slice(0, n);

  const body = top.map(p => {
    const rank = _rankOf(p, canProject);
    const rankStr = canProject && p.unknown ? `~${rank}?` : `#${rank}`;
    return `
      <tr class="p-row" data-id="${p.id}">
        <td class="rank-num">${rankStr}</td>
        <td><span class="handle">${_handleOf(p)}</span></td>
        <td class="rec-cell">${p.record}</td>
        <td class="pts-cell">${_ptsOf(p, canProject)}</td>
        <td class="omw-cell">${fmtOmw(_omwOf(p, canProject))}</td>
      </tr>`;
  }).join('');

  return `<table class="ov-followed-table"><tbody>${body}</tbody></table>`;
}

// ── PANEL: FOLLOWED PLAYERS ───────────────────────
function _renderFollowed(cut) {
  if (!S.event) return '';
  const ids = getFollowed(S.event.id);
  if (!ids.length) {
    return `<div class="ov-empty">Star a player in the roster to follow them here.</div>`;
  }

  const { rows, canProject, roundId } = _currentRows();
  const byId = new Map(rows.map(p => [p.id, p]));

  let body = '';
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue;
    const rank    = _rankOf(p, canProject);
    const rankStr = canProject && p.unknown ? `~${rank}?` : `#${rank}`;
    const inCut   = cut != null && rank <= cut;
    const omw = _omwOf(p, canProject), gw = _gwOf(p, canProject), ogw = _ogwOf(p, canProject);
    const matchup = roundId ? _matchupFor(id, roundId) : null;

    body += `
      <tr class="p-row" data-id="${p.id}">
        <td class="rank-num">${rankStr}</td>
        <td><span class="handle">${_handleOf(p)}</span></td>
        <td class="ov-mu-cell">${_matchupHtml(matchup)}</td>
        <td class="rec-cell">${p.record}</td>
        <td class="pts-cell">${_ptsOf(p, canProject)}</td>
        <td class="omw-cell">${fmtOmw(omw)}</td>
        <td class="omw-cell">${fmtOmw(gw)}</td>
        <td class="omw-cell">${fmtOmw(ogw)}</td>
        <td class="tb-cell">${cut != null ? `<span class="ov-cut-badge ${inCut ? 'in' : 'out'}">${inCut ? 'IN' : 'OUT'}</span>` : ''}</td>
      </tr>`;
  }

  if (!body) return `<div class="ov-empty">Followed players aren't in this round's field.</div>`;

  return `
    <table class="ov-followed-table">
      <thead>
        <tr>
          <th></th><th>Player</th><th>This round</th><th>Record</th><th>Pts</th><th>OMW%</th><th>GW%</th><th>OGW%</th><th>Cut</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>`;
}

// Rank-number color from the same per-player simulation the Analysis tab
// shows: gold — drawing out already locks the cut; green — a win makes it
// safe (P(cut) ≥ 95% or exactly locked); red — out even with a win. Neither
// tier reached (winning only helps, doesn't secure it) leaves the default
// color, same as "no cut configured" or nothing left to project. Exported
// for direct testing — see scripts/smoke-ui.mjs.
export function followedColorClass(results) {
  if (!results) return '';
  if (results.D.locked) return 'ov-rank-locked';
  if (results.W.locked || results.W.pCut >= 0.95) return 'ov-rank-safe';
  if (results.W.out) return 'ov-rank-out';
  return '';
}

// Fires the Monte Carlo for each followed player and colors its rank cell
// once results land — async, so it runs after the synchronous render above
// rather than blocking it.
function _colorFollowedRanks(root, cut) {
  const token = ++_followedToken;
  if (cut == null || !S.event) return;
  const roundId = defaultViewRound();
  if (!roundId) return;

  for (const id of getFollowed(S.event.id)) {
    getScenarioResults(id, roundId, cut).then(results => {
      if (token !== _followedToken) return; // panel re-rendered since — stale
      const cls = followedColorClass(results);
      if (!cls) return;
      const cell = root.querySelector(`.ov-followed-list tr[data-id="${id}"] .rank-num`);
      if (cell) cell.classList.add(cls);
    });
  }
}

export function renderOverview() {
  const root = $('ov-root');
  if (!root) return;

  if (!S.event) {
    root.innerHTML = `
      <div class="detail-placeholder-icon">◎</div>
      <p>Load an event to see the overview</p>`;
    return;
  }

  const cut = getTopCut();
  const pactPanel = _renderPactPanel(cut);
  const cutN = cut || 8;

  // The bracket needs the room a half-width panel doesn't have.
  const cutPanelFull = _cutTab === 'bracket' && _hasElimPhase();

  root.innerHTML = `
    <div class="ov-dashboard">
      ${pactPanel}
      <div class="ov-panel${cutPanelFull ? ' full' : ''}">
        ${_renderCutPanel(cut)}
      </div>
      <div class="ov-panel">
        <div class="ov-panel-title">Top ${cutN}</div>
        ${_renderTopN(cut)}
      </div>
      <div class="ov-panel full">
        <div class="ov-panel-title">Followed players</div>
        <div class="ov-followed-list">${_renderFollowed(cut)}</div>
      </div>
    </div>`;

  root.querySelectorAll('#ov-cut-subtabs .ov-subtab').forEach(btn => {
    btn.addEventListener('click', () => { _cutTab = btn.dataset.tab; renderOverview(); });
  });

  root.querySelectorAll('.p-row, .bracket-slot[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('pm:select-player', { detail: { pid: parseInt(el.dataset.id) }, bubbles: true }));
    });
  });

  _colorFollowedRanks(root, cut);
}
