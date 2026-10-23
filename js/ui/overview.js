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
//   3. Cut line — Monte Carlo of every remaining Swiss round for the whole
//      field: where the last spot in the cut is likely to land (points) and
//      P(make it) for each final points total, tiebreakers included; plus the
//      followed players' odds, what each points group still needs, the OMW
//      tiebreaker bubble and how the projection moved round by round. Filled
//      in asynchronously — see _fillCutLine / _fillCutHistory.
//   4. Top N — a live snapshot of the current top `cut` (or 8) standings.
//   5. Followed players — live rank, current-round matchup and tiebreakers
//      for whoever's been starred in the roster.

import S from '../state.js';
import { $, fmtOmw } from '../utils.js';
import { getTopCut, getFollowed } from '../services/storage.js';
import {
  defaultViewRound, projectRound, swissRounds, eventTotals,
  stateAfterRound, stateBeforeRound, futureSwissRounds, activeIdsAfter, swissEntryGates, pointsGate, provenFacts,
} from '../engine/adapter.js';
import { staticCutTable, pactWindow, pactSet, DEFAULTS } from '../engine/montecarlo.js';
import { verdictHtml } from './verdict.js';
import { renderBracketHtml } from './bracket.js';
import { getScenarioResults } from './simulation.js';
import { runCutLineSimulation } from '../services/simWorker.js';
import { CUT_SAFE, CUT_COULD, pinTier as _pinTier, fmtPct as _fmtPct, fmtChance, cutSummary as _cutSummary } from './cutStats.js';
import { cutSamples as _cutSamples, finishedReplayBases, replayCutLine } from './cutReplay.js';
import { finalSwissRows } from './accuracy.js';

// Which sub-tab of the Top cut panel is showing. Module-level so it
// survives a re-render (cut changes, live updates) but resets on a fresh
// page load — nobody expects a UI tab choice to be persisted forever.
let _cutTab = 'calculator';

// Guards the async rank-number coloring below (Monte Carlo results come
// back after the panel may have already re-rendered for something else).
let _followedToken = 0;

// Same idea for the cut line panel, plus a results cache: the simulation is
// seeded, so identical inputs (same confirmed results, same cut) give the
// same answer and a re-render can skip the rerun.
let _cutLineToken = 0;
const _cutLineCache = new Map();

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

// ── PANEL: CUT LINE ───────────────────────────────
// Base = last Swiss round with official standings; everything after it
// (including a live round, with its already-reported tables locked) is
// simulated. No standings yet → simulate the whole Swiss phase from zero.
function _cutLineInputs() {
  const swiss = swissRounds();
  if (!swiss.length) return null;
  const base = swiss.filter(r => r.standings_status === 'GENERATED').at(-1) || null;
  return {
    base,
    future:    futureSwissRounds(base?.id ?? null),
    gates:     swissEntryGates(base?.id ?? null),
    state:     base ? stateAfterRound(base.id) : stateBeforeRound(swiss[0].id),
    activeIds: activeIdsAfter(base?.id ?? null),
  };
}

function _cutLineKey(baseId, cut) {
  let confirmed = 0;
  for (const r of swissRounds()) for (const m of S.matches[r.id] || []) if (m.winning_player != null || m.match_is_bye || m.match_is_intentional_draw || m.match_is_unintentional_draw) confirmed++;
  return `${S.event?.id}|${baseId}|${cut}|${confirmed}|${pointsGate()?.pts ?? ''}`;
}

// Most common final record for a points total over `R` Swiss rounds (wins
// first, then draws) — only a label, a draw-heavy line can reach the same pts.
function _recordFor(pts, R) {
  const w = Math.floor(pts / 3), d = pts % 3, l = R - w - d;
  if (!R || l < 0) return '';
  return d ? `${w}-${l}-${d}` : `${w}-${l}`;
}

// "Projected cut line" while Swiss runs, "Cut line" once it's over (how the
// projections did lives in its own tab: js/ui/predVsReality.js).
function _cutLineTitle(cut) {
  const inputs = cut != null ? _cutLineInputs() : null;
  const over = inputs && !inputs.future.length && inputs.base;
  return `<div class="ov-panel-title">${over ? 'Cut line' : 'Projected cut line'}</div>`;
}

// Hidden until _fillCutLine has something for it.
function _cutSidePanel(key, title, order) {
  return `
      <div class="ov-panel" id="ov-clp-${key}" data-o="${order}" hidden>
        <div class="ov-panel-title">${title}</div>
        <div id="ov-cl-${key}"></div>
      </div>`;
}

function _renderCutLineShell(cut) {
  if (!cut) return `<div class="ov-empty">Set a top cut to project the cut line.</div>`;
  return `<div id="ov-cutline-body"><div class="ov-empty">Simulating the rest of the event…</div></div>`;
}

// P(in) for someone on `start` points who finishes on `final`: the
// start-specific estimate when enough runs back it, else the field-wide one.
function _pInFrom(res, start, final) {
  const cell = res.byStart?.[start]?.[final];
  if (cell && cell[0] >= 30) return cell[1] / cell[0];
  const row = res.byPts.find(r => r.pts === final);
  return row ? row.pIn : null;
}

// Cheapest way to earn `g` points in `R` rounds (most wins, fewest draws),
// or null when it can't be done.
function _outcomeLabel(g, R) {
  const w = Math.floor(g / 3), d = g % 3;
  if (w + d > R) return null;
  if (g === 0) return R ? 'Any result' : 'Already there';
  if (w === R) return 'Win out';
  return [w ? `${w}W` : '', d ? `${d}D` : ''].filter(Boolean).join(' ');
}

// Fewest points still to earn from `start` for P(in) ≥ min. With `own`
// (one player's finalById entry) only totals that player actually reached
// in the runs count — a live-round result already reported can rule some
// out — and their own odds are used once enough runs back them.
function _need(res, start, R, min, own = null) {
  for (let g = 0; g <= 3 * R; g++) {
    const label = _outcomeLabel(g, R);
    if (label == null) continue;
    const mine = own?.[start + g];
    if (own && !mine) continue;
    const p = mine && mine[0] >= 30 ? mine[1] / mine[0] : _pInFrom(res, start, start + g);
    if (p != null && p >= min) return { g, p, label };
  }
  return null;
}

function _needCell(n, cls) {
  return n
    ? `<span class="ov-cl-need ${cls}">${n.label}</span><small class="ov-cl-need-p">${_fmtPct(n.p)}</small>`
    : `<span class="ov-cl-need none">Out of reach</span>`;
}

function _cutLineHtml(res, cut, totalRounds) {
  const { modePts, modeShare, safe, could } = _cutSummary(res);
  const rows = res.byPts;

  // Keep the rows that matter: anything the line can land on, anything not
  // already a sure thing either way, plus one row of context on each side.
  const relevant = rows.map(r => (res.lineCounts[r.pts] || 0) > 0 || (r.pIn > 0.005 && r.pIn < 0.995));
  const first = relevant.indexOf(true), last = relevant.lastIndexOf(true);
  const shown = first < 0 ? [] : rows.slice(Math.max(0, first - 1), last + 2);

  const body = shown.map(r => {
    const line = (res.lineCounts[r.pts] || 0) / res.samples;
    const tags = [
      r.pts === modePts ? '<span class="ov-cl-tag mode">likely cut</span>' : '',
      r === safe ? '<span class="ov-cl-tag in">safe</span>' : '',
      r === could && r !== safe ? '<span class="ov-cl-tag maybe">min</span>' : '',
    ].join('');
    return `
      <div class="ov-cl-row${r.pts === modePts ? ' mode' : ''} tier-${_pinTier(r.pIn)}">
        <div class="ov-tier-label">${r.pts}</div>
        <div class="ov-tier-rank">${_recordFor(r.pts, totalRounds)}</div>
        <div class="ov-cl-linecell">
          <div class="ov-cl-bar"><span style="width:${(line * 100).toFixed(1)}%"></span></div>
          <em>${line ? _fmtPct(line) : ''}</em>${tags}
        </div>
        <div class="ov-cl-pin"><span class="ov-cl-pill ${_pinTier(r.pIn)}">${_fmtPct(r.pIn)}</span></div>
        <div class="ov-tier-count">~${r.players.toFixed(1)}</div>
      </div>`;
  }).join('');

  const stat = (cls, icon, label, r) => `
    <div class="ov-cl-stat ${cls}">
      <div class="ov-cl-stat-label"><span class="ov-cl-stat-icon">${icon}</span>${label}</div>
      <div class="ov-cl-stat-val">${r ? `${r.pts}<small>pts</small>` : '—'}</div>
      <div class="ov-cl-stat-sub">${r ? `<span class="ov-cl-rec">${_recordFor(r.pts, totalRounds)}</span> ${_fmtPct(r.pIn)} make it` : 'Not reachable'}</div>
      <div class="ov-cl-meter"><span style="width:${r ? (r.pIn * 100).toFixed(1) : 0}%"></span></div>
    </div>`;

  return `
    <div class="ov-cl-stats">
      ${stat('in', '✓', 'Safe with', safe)}
      ${stat('maybe', '?', 'Could make it with', could)}
    </div>
    <div class="ov-cl-facts">
      <div class="ov-cl-fact"><span>Likely cut</span><strong>${modePts} pts</strong><em>${_fmtPct(modeShare)} of runs</em></div>
      <div class="ov-cl-fact"><span>Last spot on tiebreakers</span><strong>${_fmtPct(res.tieBubble)}</strong><em>of runs</em></div>
    </div>
    <div class="ov-cl-row ov-cl-header">
      <div>Pts</div><div>Record</div><div>Cut lands here</div><div>Make it</div><div>~Players</div>
    </div>
    ${body}
    <div class="ov-tier-note">
      ${res.samples} simulations of every remaining Swiss round for the whole field (50/50 matches,
      ${Math.round(DEFAULTS.pDraw * 100)}% draws, rational IDs in the last round), ranked with exact tiebreakers.
      "Make it" = share of players finishing on those points who end inside the Top ${cut}.
      "Safe with" = fewest points that make it ≥${CUT_SAFE * 100}% of the time; "Could make it with" = fewest
      points that make it ≥${CUT_COULD * 100}% of the time.
    </div>`;
}

// Followed players against the line: P(make it) and what they still need.
function _followedNeedHtml(res, ctx) {
  if (!ctx.followed.length) return '';
  const items = ctx.followed.map(f => {
    if (!f.active) {
      return `
        <div class="ov-cl-fp tier-out">
          <div class="ov-cl-fp-head"><span class="ov-cl-fp-name">${f.handle}</span></div>
          <div class="ov-cl-fp-meta">${f.record} · dropped</div>
        </div>`;
    }
    const p = res.pInById?.[f.id] ?? 0;
    const own = res.finalById?.[f.id] || null;
    const safe = _needFromNow(res, f.start, ctx.R, CUT_SAFE, own, f.banked);
    const shot = _needFromNow(res, f.start, ctx.R, CUT_COULD, own, f.banked);
    return `
      <div class="ov-cl-fp tier-${_pinTier(p)}">
        <div class="ov-cl-fp-head">
          <span class="ov-cl-fp-name">${f.handle}</span>
          <span class="ov-cl-pill ${_pinTier(p)}">${fmtChance(p, ctx.facts?.get(f.id))}</span>
        </div>
        <div class="ov-cl-fp-meta">${f.record} · ${f.start} pts${f.banked != null ? ` · +${f.banked} this round` : ''}</div>
        <div class="ov-cl-fp-need">
          <span>Safe</span><div>${_needCell(safe, 'in')}</div>
          <span>Shot</span><div>${_needCell(shot, 'maybe')}</div>
        </div>
      </div>`;
  }).join('');
  return `<div class="ov-cl-fps">${items}</div>`;
}

// What each current points group needs from the rounds left.
function _needTableHtml(res, ctx) {
  if (!ctx.groups.length || !ctx.R) return '';
  const rows = ctx.groups.map(g => {
    const safe = _need(res, g.start, ctx.R, CUT_SAFE), shot = _need(res, g.start, ctx.R, CUT_COULD);
    const stars = g.followed.length ? ` <span class="ov-cl-star" title="${g.followed.join(', ')}">★${g.followed.length}</span>` : '';
    return `
      <div class="ov-cl-nrow">
        <div class="ov-tier-label">${g.start}<small> pts</small></div>
        <div class="ov-tier-count">${g.n}${stars}</div>
        <div>${_needCell(safe, 'in')}</div>
        <div>${_needCell(shot, 'maybe')}</div>
      </div>`;
  }).join('');
  return `
    <div class="ov-cl-nrow ov-cl-header">
      <div>Now</div><div>Players</div><div>To be safe</div><div>For a shot</div>
    </div>
    ${rows}
    <div class="ov-tier-note">${ctx.R} round${ctx.R === 1 ? '' : 's'} left. Fewest results needed to finish inside the cut, counting only
      players who were on the same points going in, so it already reflects who they're likely to face.</div>`;
}

// The tiebreaker bubble: OMW of the last player in vs the first one out,
// over the runs where the cut was tied on points.
function _bubbleHtml(res) {
  const list = Object.entries(res.bubble || {})
    .map(([pts, b]) => ({ pts: Number(pts), ...b }))
    .filter(b => b.n >= 20)
    .sort((a, b) => b.n - a.n)
    .slice(0, 2);
  if (!list.length) return '';

  const items = list.map(b => {
    const lo = Math.max(0, Math.min(b.firstOut[0], b.lastIn[0]) - 0.03);
    const hi = Math.min(1, Math.max(b.firstOut[2], b.lastIn[2]) + 0.03);
    const x = v => ((v - lo) / Math.max(0.01, hi - lo)) * 100;
    const band = (q, cls) => `
      <span class="ov-cl-band ${cls}" style="left:${x(q[0]).toFixed(1)}%;width:${Math.max(1, x(q[2]) - x(q[0])).toFixed(1)}%"></span>
      <span class="ov-cl-tick ${cls}" style="left:${x(q[1]).toFixed(1)}%"></span>`;
    return `
      <div class="ov-cl-bubble">
        <div class="ov-cl-bubble-head">
          Tied at <strong>${b.pts} pts</strong>
          <em>${_fmtPct(b.n / res.samples)} of runs</em>
        </div>
        <div class="ov-cl-range out">${band(b.firstOut, 'out')}</div>
        <div class="ov-cl-range in">${band(b.lastIn, 'in')}</div>
        <div class="ov-cl-range-axis"><span>${fmtOmw(lo)}</span><span>OMW</span><span>${fmtOmw(hi)}</span></div>
        <div class="ov-cl-bubble-legend">
          <span class="in">Last in ~${fmtOmw(b.lastIn[1])}</span>
          <span class="out">First out ~${fmtOmw(b.firstOut[1])}</span>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="ov-cl-bubbles">${items}</div>
    <div class="ov-tier-note">Final OMW of the last player inside the cut and the first one left out, in the runs
      where both finished on the same points. Bar = middle half of runs, tick = median.</div>`;
}

// Cut line by round. points: [{ label, safe, could, mode, now }] (pts or null);
// actual: the real final cut once Swiss is over. Drawn at the container's
// real pixel width (viewBox = px) so text and dots keep their size whether
// the panel is full-width on a desktop or a phone column.
function _historyChartHtml(points, actual, width) {
  const series = [
    { key: 'safe',  name: 'Safe with',     color: 'var(--green)' },
    { key: 'mode',  name: 'Likely cut',    color: 'var(--blue)' },
    { key: 'could', name: 'Could make it', color: 'var(--yellow)' },
  ];
  const vals = points.flatMap(p => series.map(s => p[s.key])).concat(actual ?? []).filter(v => v != null);
  if (!vals.length || points.length < 2) return `<div class="ov-empty">Not enough rounds played yet.</div>`;

  const W = Math.max(280, Math.round(width || 800)), H = W < 600 ? 200 : 260;
  const L = 34, Rp = 18, T = 16, B = 28;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  lo = Math.max(0, lo - 1); hi += 1;
  const xs = i => L + (i * (W - L - Rp)) / (points.length - 1);
  const ys = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  let grid = '';
  const step = hi - lo > 9 ? 3 : 1;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    grid += `<line x1="${L}" x2="${W - Rp}" y1="${ys(v).toFixed(1)}" y2="${ys(v).toFixed(1)}" class="ov-hc-grid"/>
      <text x="${L - 8}" y="${(ys(v) + 4).toFixed(1)}" class="ov-hc-ylab">${v}</text>`;
  }
  const xlabs = points.map((p, i) => `<text x="${xs(i).toFixed(1)}" y="${H - 8}" class="ov-hc-xlab${p.now ? ' now' : ''}">${p.label}</text>`).join('');

  // Series often share a value (likely cut = could make it); a small fixed
  // vertical offset per series keeps every line visible.
  const lines = series.map((s, si) => {
    const off = (si - 1) * 3;
    const pts = points.map((p, i) => (p[s.key] != null ? [xs(i), ys(p[s.key]) - off, p] : null)).filter(Boolean);
    const path = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const dots = pts.map(([x, y, p]) => `
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${s.color}" class="ov-hc-dot"><title>${p.label} · ${s.name}: ${p[s.key]} pts</title></circle>`).join('');
    return `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>${dots}`;
  }).join('');

  const actualLine = actual != null
    ? `<line x1="${L}" x2="${W - Rp}" y1="${ys(actual).toFixed(1)}" y2="${ys(actual).toFixed(1)}" class="ov-hc-actual"/>`
    : '';

  const legend = series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('')
    + (actual != null ? `<span><i class="dash"></i>Final cut (${actual})</span>` : '');

  return `
    <div class="ov-hc-legend">${legend}</div>
    <svg class="ov-hc" viewBox="0 0 ${W} ${H}" role="img" aria-label="Projected cut line after each round">
      ${grid}${actualLine}${lines}${xlabs}
    </svg>
    <div class="ov-tier-note">Projection as it stood after each round (Start = before round 1), using only what
      was known then. Hover a dot for its value.</div>`;
}

// Swiss already over: the line is a fact, not a projection.
function _finalCutLineHtml(baseId, cut) {
  const rows = [...(S.standings[baseId] || [])].sort((a, b) => a.rank - b.rank);
  const last = rows[Math.min(cut, rows.length) - 1];
  if (!last) return `<div class="ov-empty">No standings yet.</div>`;
  const { totalRounds } = eventTotals();
  const firstOut = rows[cut] || null;
  const tied = firstOut?.points === last.points;
  const out = rows.slice(cut);

  // Points groups, top down: how many finished there and how many got in.
  const groups = new Map();
  rows.forEach((p, i) => {
    const g = groups.get(p.points) || { pts: p.points, n: 0, in: 0 };
    g.n++;
    if (i < cut) g.in++;
    groups.set(p.points, g);
  });
  const list = [...groups.values()].sort((a, b) => b.pts - a.pts);
  // "Safe" in hindsight: fewest points with which nobody was left out.
  const maxOut = out.length ? out[0].points : -1;
  const safe = list.filter(g => g.pts > maxOut).at(-1) || null;
  const line = groups.get(last.points);
  const tiedOut = out.filter(p => p.points === last.points).length;

  const omw = p => p?.opponent_match_win_percentage;
  const who = (label, p, cls) => p ? `
    <div class="ov-cl-fact ${cls}"><span>${label}</span><strong>#${p.rank} ${_handleOf(p)}</strong>
      <em>${p.points} pts · OMW ${fmtOmw(omw(p))}</em></div>` : '';
  const margin = tied && omw(last) != null && omw(firstOut) != null
    ? `<div class="ov-cl-fact"><span>OMW gap</span><strong>${((omw(last) - omw(firstOut)) * 100).toFixed(1)} pp</strong><em>last in vs first out</em></div>`
    : '';

  const stat = (cls, icon, label, g, sub, share) => `
    <div class="ov-cl-stat ${cls}">
      <div class="ov-cl-stat-label"><span class="ov-cl-stat-icon">${icon}</span>${label}</div>
      <div class="ov-cl-stat-val">${g ? `${g.pts}<small>pts</small>` : '—'}</div>
      <div class="ov-cl-stat-sub">${g ? `<span class="ov-cl-rec">${_recordFor(g.pts, totalRounds)}</span> ${sub}` : 'Nobody was safe'}</div>
      <div class="ov-cl-meter"><span style="width:${(share * 100).toFixed(1)}%"></span></div>
    </div>`;

  const lowest = list.at(-1)?.pts;
  const shown = list.filter(g => g.pts >= last.points || g.pts === list.find(x => x.pts < last.points)?.pts);
  const body = shown.map(g => {
    const share = g.in / g.n;
    const tier = share === 1 ? 'in' : share >= 0.5 ? 'likely' : share > 0 ? 'maybe' : 'out';
    const tags = [
      g === line ? '<span class="ov-cl-tag mode">cut</span>' : '',
      g === safe ? '<span class="ov-cl-tag in">safe</span>' : '',
    ].join('');
    return `
      <div class="ov-cl-row${g === line ? ' mode' : ''} tier-${tier}">
        <div class="ov-tier-label">${g.pts}</div>
        <div class="ov-tier-rank">${_recordFor(g.pts, totalRounds)}</div>
        <div class="ov-cl-linecell">
          <div class="ov-cl-bar"><span style="width:${(share * 100).toFixed(1)}%"></span></div>
          <em>${g.in}/${g.n}</em>${tags}
        </div>
        <div class="ov-cl-pin"><span class="ov-cl-pill ${tier}">${_fmtPct(share)}</span></div>
        <div class="ov-tier-count">${g.n}</div>
      </div>`;
  }).join('');
  const below = list.filter(g => g.pts < last.points && !shown.includes(g)).reduce((s, g) => s + g.n, 0);

  return `
    <div class="ov-cl-headline">
      Swiss is over — the cut landed at <strong>${last.points} pts</strong>
      (${last.match_record || last.record}${tied ? ', decided on tiebreakers' : ''}).
    </div>
    <div class="ov-cl-stats">
      ${stat('in', '✓', 'Safe with', safe, safe ? `all ${safe.n} made it` : '', safe ? 1 : 0)}
      ${stat('maybe', '?', 'Lowest that got in', line, `${line.in} of ${line.n} made it`, line.in / line.n)}
    </div>
    <div class="ov-cl-facts">
      <div class="ov-cl-fact"><span>Missed the cut</span><strong>${out.length}</strong><em>of ${rows.length} players</em></div>
      ${tiedOut ? `<div class="ov-cl-fact"><span>Out on tiebreakers</span><strong>${tiedOut}</strong><em>with ${last.points} pts</em></div>` : ''}
      ${who('Last in', last, 'in')}
      ${who('First out', firstOut, 'out')}
      ${margin}
    </div>
    <div class="ov-cl-row ov-cl-header">
      <div>Pts</div><div>Record</div><div>Made the cut</div><div>Share</div><div>Players</div>
    </div>
    ${body}
    <div class="ov-tier-note">
      Final standings. "Safe with" = fewest points with which every player made the Top ${cut};
      "Lowest that got in" = points of the #${cut}.${below ? ` ${below} more player${below === 1 ? '' : 's'} finished below ${shown.at(-1).pts} pts${lowest != null ? ` (down to ${lowest})` : ''}.` : ''}
    </div>`;
}

// Names, records and current points feeding "Your players" / "What you need".
// Points a player has already banked in the live round (its result is
// reported, so it's locked in the simulation), or null if still to play.
// `known` is futureSwissRounds(...)[0].
export function bankedLivePts(known, id) {
  if (!known?.pairs) return null;
  if (known.byeId === id) return 3;
  for (const [a, b] of known.pairs) {
    if (a !== id && b !== id) continue;
    const res = known.locked?.[`${a}:${b}`];
    if (!res) return null;
    if (res === 'D') return 1;
    return (res === 'W1') === (a === id) ? 3 : 0;
  }
  return null;
}

// What a player still needs, counted from now: a live-round result already
// reported is banked rather than shown as part of the requirement.
function _needFromNow(res, start, R, min, own, banked) {
  return banked == null ? _need(res, start, R, min, own) : _need(res, start + banked, R - 1, min, own);
}

function _needContext(state, activeIds, R, live = null) {
  const handles = new Map();
  for (const p of _currentRows().rows) handles.set(p.id, _handleOf(p));
  const nameOf = id => handles.get(id) || `#${id}`;
  const active = new Set(activeIds);
  const ptsOf = id => (state[id] ? 3 * state[id].w + state[id].d : 0);
  const recOf = id => {
    const r = state[id];
    if (!r) return '0-0';
    return r.d ? `${r.w}-${r.l}-${r.d}` : `${r.w}-${r.l}`;
  };

  const followedIds = new Set(getFollowed(S.event.id));
  const followed = [...followedIds]
    .map(id => ({ id, handle: nameOf(id), start: ptsOf(id), record: recOf(id), active: active.has(id), banked: bankedLivePts(live, id) }))
    .sort((a, b) => (b.active - a.active) || (b.start - a.start));

  const byStart = new Map();
  for (const id of activeIds) {
    const k = ptsOf(id);
    const g = byStart.get(k) || { start: k, n: 0, followed: [] };
    g.n++;
    if (followedIds.has(id)) g.followed.push(nameOf(id));
    byStart.set(k, g);
  }
  const groups = [...byStart.values()].sort((a, b) => b.start - a.start);
  return { R, followed, groups };
}

function _fillCutLine(root, cut) {
  const token = ++_cutLineToken;
  const el = root.querySelector('#ov-cutline-body');
  if (!el || cut == null) return;

  const inputs = _cutLineInputs();
  if (!inputs || !inputs.activeIds.length) { el.innerHTML = `<div class="ov-empty">Waiting for pairings…</div>`; return; }
  const { base, future, gates, state, activeIds } = inputs;
  const { totalRounds } = eventTotals();

  // Re-query on arrival: the element may have been replaced by a re-render.
  const show = (html, sel = '#ov-cutline-body') => {
    if (token !== _cutLineToken) return false; // panel re-rendered since — stale
    const cur = root.querySelector(sel);
    if (cur) cur.innerHTML = html;
    return true;
  };
  // Side panels (Your players / What you need / Tiebreaker bubble) stay
  // hidden until there is something to put in them.
  const side = (key, html) => {
    if (token !== _cutLineToken) return;
    const panel = root.querySelector(`#ov-clp-${key}`), body = root.querySelector(`#ov-cl-${key}`);
    if (!panel || !body) return;
    body.innerHTML = html || '';
    panel.hidden = !html;
  };

  if (!future.length) {
    const finalRows = finalSwissRows();
    el.innerHTML = _finalCutLineHtml(base.id, cut);
    _fillCutHistory(root, cut, base, null, finalRows[Math.min(cut, finalRows.length) - 1]?.points ?? null, show,
      replayCutLine(finishedReplayBases(), cut));
    return;
  }

  const ctx = _needContext(state, activeIds, future.length, future[0]);
  ctx.facts = provenFacts(base?.id ?? null, cut); // "0%" / "100%" only when proven
  const key = _cutLineKey(base?.id ?? null, cut);
  const showRes = res => {
    if (!res) { show(`<div class="ov-empty">Nothing to simulate.</div>`); return; }
    if (!show(_cutLineHtml(res, cut, totalRounds))) return;
    side('players', _followedNeedHtml(res, ctx));
    side('need', _needTableHtml(res, ctx));
    side('bubble', _bubbleHtml(res));
    _fillCutHistory(root, cut, base, res, null, show);
  };

  const cached = _cutLineCache.get(key);
  if (cached) { showRes(cached); return; }

  runCutLineSimulation({ state, activeIds, futureRounds: future, gates, cut, samples: _cutSamples(state) })
    .then(res => { _cutLineCache.set(key, res); showRes(res); })
    .catch(err => { console.error(err); show(`<div class="ov-empty">Simulation failed.</div>`); });
}

// The same projection the cut line panel shows (same inputs, same cache),
// for the LLM summary. Resolves to { res, R } — R = Swiss rounds still to
// play — or null when there's nothing left to project.
export function getCutLineProjection(cut) {
  if (cut == null) return Promise.resolve(null);
  const inputs = _cutLineInputs();
  if (!inputs || !inputs.activeIds.length || !inputs.future.length) return Promise.resolve(null);
  const { base, future, gates, state, activeIds } = inputs;
  const key = _cutLineKey(base?.id ?? null, cut);
  const hit = _cutLineCache.get(key);
  if (hit) return Promise.resolve({ res: hit, R: future.length });
  return runCutLineSimulation({ state, activeIds, futureRounds: future, gates, cut, samples: _cutSamples(state) })
    .then(res => { _cutLineCache.set(key, res); return res ? { res, R: future.length } : null; });
}

export { _cutSummary as cutLineSummary, _needFromNow as cutLineNeed, CUT_SAFE, CUT_COULD };

// Replays the projection as it stood after every earlier Swiss round — only
// what was known then, no later pairings or results — and appends the
// current one. Past rounds don't change, so each point is cached for good.
function _fillCutHistory(root, cut, base, currentRes, actual, show, replay = null) {
  const done = swissRounds().filter(r => r.standings_status === 'GENERATED');
  // Start (before round 1), then after each completed round. With a live
  // projection the current base is covered by `currentRes`; once Swiss is
  // over the caller passes the replay it already started.
  const bases = base ? [null, ...done.filter(r => r.id !== base.id)] : [];
  const toPoint = (res, lab, now = false) => {
    if (!res) return null;
    const s = _cutSummary(res);
    return { label: lab, safe: s.safe?.pts ?? null, could: s.could?.pts ?? null, mode: s.modePts, now };
  };

  (replay || replayCutLine(bases, cut))
    .then(steps => {
      const points = steps.map(st => toPoint(st.res, st.label));
      if (currentRes) points.push(toPoint(currentRes, base ? `R${swissRounds().findIndex(r => r.id === base.id) + 1} now` : 'Now', true));
      const width = root.querySelector('#ov-cutline-history')?.clientWidth;
      show(_historyChartHtml(points.filter(Boolean), actual, width), '#ov-cutline-history');
    })
    .catch(err => { console.error(err); show(`<div class="ov-empty">Couldn't replay earlier rounds.</div>`, '#ov-cutline-history'); });
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
// fmtOmw with the % in its own span, so the phone layout can drop it (the
// column header already says %) — see css/detail.css's mobile overview block.
function _pctCell(v) {
  return v != null ? `${(v * 100).toFixed(1)}<span class="ov-pct">%</span>` : '—';
}

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
        <td class="omw-cell">${_pctCell(omw)}</td>
        <td class="omw-cell">${_pctCell(gw)}</td>
        <td class="omw-cell">${_pctCell(ogw)}</td>
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

  const hasFollowed = getFollowed(S.event.id).length > 0;

  // Two independent columns, so a tall panel on one side never leaves a gap
  // on the other. On phones the columns dissolve (display: contents) and the
  // data-o order below interleaves them: cut stuff first, reference later.
  const cutPanel = `
      <div class="ov-panel${cutPanelFull ? ' full' : ''}" data-o="1">
        ${_renderCutPanel(cut)}
      </div>`;
  root.innerHTML = `
    <div class="ov-dashboard">
      ${pactPanel}
      ${cutPanelFull ? cutPanel : ''}
      <div class="ov-col">
        ${cutPanelFull ? '' : cutPanel}
        <div class="ov-panel" data-o="4">
          <div class="ov-panel-title">Top ${cutN}</div>
          ${_renderTopN(cut)}
        </div>
        ${cut ? _cutSidePanel('need', 'What you need', 5) : ''}
      </div>
      <div class="ov-col">
        <div class="ov-panel" data-o="2">
          ${_cutLineTitle(cut)}
          ${_renderCutLineShell(cut)}
        </div>
        ${cut && hasFollowed ? _cutSidePanel('players', 'Your players vs the cut', 3) : ''}
        ${cut ? _cutSidePanel('bubble', 'Tiebreaker bubble', 6) : ''}
      </div>
      ${hasFollowed ? `
      <div class="ov-panel full" data-o="7">
        <div class="ov-panel-title">Followed players</div>
        <div class="ov-followed-list">${_renderFollowed(cut)}</div>
      </div>` : ''}
      ${cut ? `
      <div class="ov-panel full" data-o="8">
        <div class="ov-panel-title">Cut line by round</div>
        <div id="ov-cutline-history"><div class="ov-empty">Replaying earlier rounds…</div></div>
      </div>` : ''}
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
  _fillCutLine(root, cut);
}
