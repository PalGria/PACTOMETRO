// ── MONTE CARLO CUT PROJECTION ───────────────────
// Given the confirmed state of a Swiss tournament, a player, and a forced
// result for that player's next match, samples the remaining rounds and
// recomputes the full standings (exact tiebreakers) for every sample.
//
// futureRounds: one entry per Swiss round still to be played, index 0 being
// the round the scenario applies to. Each entry is either
//   { pairs: [[a, b], ...], byeId, locked: { 'a:b': 'W1'|'W2'|'D' } }
//   (pairings published; `locked` holds results already reported), or
//   null (pairings unknown → simulated with pairSwiss).
//
// Outcome model (documented in SIMULATION_MATH.md §3):
//   • wins are 50/50; game score 2-0 or 2-1 with equal probability
//   • an unintentional draw happens with probability pDraw
//   • in the final round, two paired players who would both be locked into
//     the cut with a draw take the intentional draw with probability pIdraw

import { cloneState, applyMatch, points, computeTiebreaks, compareRows, rankPlayers } from './swiss.js';
import { pairSwiss, makeRng } from './pairing.js';

export const DEFAULTS = { samples: 2000, seed: 20240613, pDraw: 0.04, pIdraw: 0.9 };

const pairKey = (a, b) => `${a}:${b}`;

// ── DETERMINISTIC BOUNDS ─────────────────────────
// best: rank if I win everything and every possible tie goes my way.
// absoluteWorst: rank if every other player does as well as the schedule
// allows and every tie goes against me. On the final round with published
// pairings this respects that a table yields at most one +3 (exact, up to
// tiebreakers). Earlier, every player is assumed to win out (loose bound).
export function deterministicBounds({ state, me, activeIds, futureRounds, scenario, cut, basePts }) {
  const delta = scenario === 'W' ? 3 : scenario === 'D' ? 1 : 0;
  const myPts = basePts != null ? basePts : points(state[me]);
  const projPts = myPts + delta;
  const R = futureRounds.length;
  const myRemaining = Math.max(0, R - 1);
  const active = new Set(activeIds);
  const myCeiling = projPts + 3 * myRemaining;

  let defAbove = 0;
  for (const k in state) {
    const id = Number(k);
    if (id === me) continue;
    if (points(state[k]) > myCeiling) defAbove++;
  }

  let absAbove = 0;
  const next = futureRounds[0];
  if (R === 1 && next && next.pairs) {
    // Final round, pairings known: sum per-table maxima.
    const reach = p => (p >= projPts ? 1 : 0);
    const seen = new Set();
    for (const [a, b] of next.pairs) {
      seen.add(a); seen.add(b);
      const pa = points(state[a]), pb = points(state[b]);
      if (a === me || b === me) {
        const opp = a === me ? b : a;
        const oppPts = a === me ? pb : pa;
        const gain = scenario === 'W' ? 0 : scenario === 'D' ? 1 : 3;
        absAbove += reach(oppPts + gain);
        continue;
      }
      const locked = next.locked?.[pairKey(a, b)];
      if (locked === 'W1')      absAbove += reach(pa + 3) + reach(pb);
      else if (locked === 'W2') absAbove += reach(pa) + reach(pb + 3);
      else if (locked === 'D')  absAbove += reach(pa + 1) + reach(pb + 1);
      else absAbove += Math.max(reach(pa + 3) + reach(pb), reach(pa) + reach(pb + 3), reach(pa + 1) + reach(pb + 1));
    }
    if (next.byeId != null && next.byeId !== me) { seen.add(next.byeId); absAbove += reach(points(state[next.byeId]) + 3); }
    for (const k in state) {
      const id = Number(k);
      if (id === me || seen.has(id)) continue;
      absAbove += reach(points(state[k])); // not paired: dropped, keeps points
    }
  } else {
    for (const k in state) {
      const id = Number(k);
      if (id === me) continue;
      const gain = active.has(id) ? 3 * R : 0;
      if (points(state[k]) + gain >= projPts) absAbove++;
    }
  }

  const best = defAbove + 1, absoluteWorst = absAbove + 1;
  return {
    projPts, best, absoluteWorst,
    out:    cut != null && best > cut,
    locked: cut != null && absoluteWorst <= cut,
  };
}

// Exact rank bounds for a hypothetical player with `basePts` points today and
// no real pairing anywhere — used for cut-threshold tiers ("would an X-3
// make it?") that nobody currently holds, where there is no real next match
// to force and no real player id to exclude from the opponent counts. Unlike
// deterministicBounds this never runs a Monte Carlo on top: a synthetic
// player has no real match history, so its tiebreakers can't be estimated
// without fabricating one — the bound alone is reported instead.
export function tierBounds({ state, activeIds, futureRounds, basePts, cut }) {
  const R = futureRounds.length;
  const active  = new Set(activeIds);
  const ceiling = basePts + 3 * R;
  let best = 1, absoluteWorst = 1;
  for (const k in state) {
    if (points(state[k]) > ceiling) best++;
    const gain = active.has(Number(k)) ? 3 * R : 0;
    if (points(state[k]) + gain >= basePts) absoluteWorst++;
  }
  return {
    basePts, best, absoluteWorst,
    out:    cut != null && best > cut,
    locked: cut != null && absoluteWorst <= cut,
  };
}

// n-choose-k, iterative (no factorials — R is small, stays exact in float
// range for any realistic Swiss event).
function _binom(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let c = 1;
  for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1);
  return c;
}

// Reference table of every reachable final record over a whole Swiss phase
// (`totalRounds` rounds, `totalPlayers` players, no draws, no drops) and its
// rank bound for `cut`. Depends only on those three numbers — never on any
// actual result — so unlike tierBounds/deterministicBounds anchored at a
// specific round, this is the same answer on round 1 as on the last round.
// Mirrors a classic "top cut calculator": https://sixprizes.com/top-cut-calculator/
//
// Modelling: Swiss pairs same-record players together, so each round is
// close to a fair coin flip within a player's own bracket — after R rounds
// a player's win count is ~Binomial(R, 0.5), and the expected number of
// players finishing at exactly `w` wins is N·C(R,w)/2^R (sixprizes' own
// tool uses the same estimate, hence its "expect X or Y players" decimals).
// `best`/`absoluteWorst` come from the expected count of players who
// finished with strictly more wins (best case: you're ranked above every
// tie at your own record; worst: below all of them).
export function staticCutTable({ totalRounds, totalPlayers, cut }) {
  const R = totalRounds, N = totalPlayers;
  if (!R || !N) return [];
  const denom = 2 ** R;
  const rows = [];
  let cumAbove = 0; // expected players with strictly more wins than this tier
  for (let w = R; w >= 0; w--) {
    const count = N * _binom(R, w) / denom;
    const best  = Math.floor(cumAbove) + 1;
    const absoluteWorst = Math.ceil(cumAbove + count);
    const out    = cut != null && best > cut;
    const locked = cut != null && absoluteWorst <= cut;
    rows.push({ wins: w, losses: R - w, count, best, absoluteWorst, out, locked });
    cumAbove += count;
    if (out) break; // every worse (fewer-win) record is out too
  }
  return rows;
}

// ── PACTS ("pactar": drawing out the rest of the event) ──────────────
// deterministicBounds/tierBounds are exact regardless of how the tournament
// pairs people (their "absoluteWorst" assumes every rival could win out).
// That's a real guarantee, but pessimistic: Swiss pairing puts same-record
// players against each other, so within any group tied on points, at most
// half of them can actually win a given round — the "PACTO SEGURO" bound
// below uses that. It's exact only if the event pairs by record the normal
// way (true for standard Swiss software, not a mathematical certainty like
// the plain bound above); see SIMULATION_MATH.md.

// How many final Swiss rounds count as "pact territory" — short events
// never reach a point where drawing out is a meaningful, provable plan.
export function pactWindow(totalSwissRounds) {
  if (totalSwissRounds < 4) return 0;
  return totalSwissRounds >= 8 ? 3 : 2;
}

// Worst-case rank for a player who draws every one of the `k` remaining
// rounds, assuming standard Swiss pairing (same-points groups play each
// other; the group's odd player pairs down). Exact when only the very next
// round's pairings are known and it's the only round left (k === 1); a safe
// upper bound otherwise — see _relaxRounds. `me` may be a real player id
// (uses their current points) or omitted in favor of `basePts`, matching
// tierBounds's convention for a hypothetical record.
export function pactBound({ state, me = null, activeIds, futureRounds, cut, basePts = null }) {
  const k = futureRounds.length;
  if (k === 0) return null;
  const myPts = basePts != null ? basePts : points(state[me]);
  const T = myPts + k; // draws out: +1 per remaining round
  const active = new Set(activeIds);
  const canReach = (p, roundsLeft) => p + 3 * roundsLeft >= T;

  let pool = [];
  let roundsLeft = k;
  const next = futureRounds[0];

  if (next && next.pairs) {
    const seen = new Set(me != null ? [me] : []);
    for (const [a, b] of next.pairs) {
      seen.add(a); seen.add(b);
      if (a === me || b === me) {
        const opp = a === me ? b : a;
        const v = points(state[opp]) + 1; // my opponent draws with me too
        if (canReach(v, k - 1)) pool.push(v);
        continue;
      }
      const pa = points(state[a]), pb = points(state[b]);
      const locked = next.locked?.[pairKey(a, b)];
      const outcomes = locked ? [locked] : ['W1', 'W2', 'D'];
      // Per table, keep whichever outcome feeds the most danger forward — a
      // safe, slightly loose bound (see tierBounds/deterministicBounds for
      // the same "loose but sound" convention elsewhere in this file).
      let bestVals = [];
      for (const o of outcomes) {
        const [ga, gb] = o === 'W1' ? [3, 0] : o === 'W2' ? [0, 3] : [1, 1];
        const vals = [pa + ga, pb + gb].filter(v => canReach(v, k - 1));
        if (vals.length > bestVals.length) bestVals = vals;
      }
      pool.push(...bestVals);
    }
    if (next.byeId != null && next.byeId !== me) {
      seen.add(next.byeId);
      const v = points(state[next.byeId]) + 3;
      if (canReach(v, k - 1)) pool.push(v);
    }
    for (const key in state) {
      const id = Number(key);
      if (seen.has(id) || !active.has(id)) continue;
      const v = points(state[key]);
      if (canReach(v, k - 1)) pool.push(v);
    }
    roundsLeft = k - 1;
  } else {
    for (const key in state) {
      const id = Number(key);
      if (id === me || !active.has(id)) continue;
      const v = points(state[key]);
      if (canReach(v, k)) pool.push(v);
    }
  }

  let above = _relaxRounds(pool, roundsLeft, T);
  for (const key in state) { // dropped players keep their points forever
    const id = Number(key);
    if (id === me || active.has(id)) continue;
    if (points(state[key]) >= T) above++;
  }

  const rank = above + 1;
  return { k, finalPts: T, rank, pactLocked: cut != null && rank <= cut };
}

// Splits each points-tied group of `rounds` unknown Swiss rounds: ceil(m/2)
// of a group of size m win (+3), the rest draw or lose (+1, the safer
// over-assumption) — then repeats for the next round. Returns how many end
// up at or above `T`.
function _relaxRounds(pool, rounds, T) {
  let cur = pool;
  for (let r = rounds; r >= 1; r--) {
    const groups = new Map();
    for (const p of cur) groups.set(p, (groups.get(p) || 0) + 1);
    const nxt = [];
    for (const [p, m] of groups) {
      const winners = Math.ceil(m / 2), losers = m - winners;
      for (let i = 0; i < winners; i++) if (p + 3 + 3 * (r - 1) >= T) nxt.push(p + 3);
      for (let i = 0; i < losers;  i++) if (p + 1 + 3 * (r - 1) >= T) nxt.push(p + 1);
    }
    cur = nxt;
  }
  return cur.filter(p => p >= T).length;
}

// Every player currently near the top (top `limit` by points) who is locked
// into the cut simply by drawing out — the "these N people are pacting"
// list for the overview dashboard.
export function pactSet({ state, activeIds, futureRounds, cut, limit = 24 }) {
  const out = new Set();
  if (cut == null) return out;
  const ids = activeIds.slice().sort((a, b) => points(state[b]) - points(state[a])).slice(0, limit);
  for (const id of ids) {
    const b = pactBound({ state, me: id, activeIds, futureRounds, cut });
    if (b && b.pactLocked) out.add(id);
  }
  return out;
}

// ── RATIONAL INTENTIONAL DRAWS ───────────────────
// For a final round with known pairs, returns the set of players who make
// the cut with a draw no matter what happens at the other tables (ties
// counted against them). `forcedTable` describes my table when the scenario
// fixes its result: { idx, me, gainMe, gainOpp }.
function lockedWithDraw(state, pairs, byeId, cut, forcedTable) {
  const out = new Set();
  if (cut == null) return out;
  const tables = pairs.map(([a, b]) => [points(state[a]), points(state[b])]);
  const paired = new Set(pairs.flat());
  if (byeId != null) paired.add(byeId);
  const byePts = byeId != null ? points(state[byeId]) + 3 : null;
  const others = [];
  for (const k in state) if (!paired.has(Number(k))) others.push(points(state[k]));

  for (let t = 0; t < pairs.length; t++) {
    if (forcedTable && t === forcedTable.idx) continue; // my table cannot ID (scenario is fixed)
    for (const side of [0, 1]) {
      const target = tables[t][side] + 1;
      const reach = p => (p >= target ? 1 : 0);
      let above = reach(tables[t][1 - side] + 1); // partner also gets +1
      for (let u = 0; u < pairs.length && above < cut; u++) {
        if (u === t) continue;
        const [pa, pb] = tables[u];
        if (forcedTable && u === forcedTable.idx) {
          const meIsA = pairs[u][0] === forcedTable.me;
          const mePts = meIsA ? pa : pb, oppPts = meIsA ? pb : pa;
          above += reach(mePts + forcedTable.gainMe) + reach(oppPts + forcedTable.gainOpp);
          continue;
        }
        above += Math.max(reach(pa + 3) + reach(pb), reach(pa) + reach(pb + 3), reach(pa + 1) + reach(pb + 1));
      }
      if (byePts != null && above < cut) above += reach(byePts);
      for (const p of others) { if (above >= cut) break; above += reach(p); }
      if (above < cut) out.add(pairs[t][side]);
    }
  }
  return out;
}

// ── SAMPLING ─────────────────────────────────────
function sampleGames(rng) {
  return rng() < 0.5 ? { gww: 2, gwl: 0, gd: 0 } : { gww: 2, gwl: 1, gd: 0 };
}

function forced(scenario, meIsA) {
  if (scenario === 'D') return 'D';
  return (scenario === 'W') === meIsA ? 'W1' : 'W2';
}

// Returns { pCut, samples, min, max, p5, p50, p95, rankCounts, ptsCut }
export function simulateScenario(opts) {
  const { state, me, activeIds, futureRounds, scenario, cut } = opts;
  const samples = opts.samples ?? DEFAULTS.samples;
  const pDraw   = opts.pDraw   ?? DEFAULTS.pDraw;
  const pIdraw  = opts.pIdraw  ?? DEFAULTS.pIdraw;
  const rng     = makeRng(opts.seed ?? DEFAULTS.seed);
  const R = futureRounds.length;
  const rankIds = Object.keys(state).map(Number);

  const rankCounts = {};
  let inCut = 0, min = Infinity, max = 0;
  const cutPts = [];

  for (let n = 0; n < samples; n++) {
    const s = cloneState(state);
    let active = activeIds;

    for (let k = 0; k < R; k++) {
      const known = futureRounds[k];
      let pairs, byeId, locked;
      if (known && known.pairs) { pairs = known.pairs; byeId = known.byeId ?? null; locked = known.locked || {}; }
      else { ({ pairs, byeId } = pairSwiss(s, active, rng)); locked = {}; }

      const isFinal = k === R - 1;
      let idSet = null;
      if (isFinal && cut != null) {
        let forcedTable = null;
        if (k === 0) {
          const idx = pairs.findIndex(([a, b]) => a === me || b === me);
          if (idx >= 0) forcedTable = {
            idx, me,
            gainMe:  scenario === 'W' ? 3 : scenario === 'D' ? 1 : 0,
            gainOpp: scenario === 'W' ? 0 : scenario === 'D' ? 1 : 3,
          };
        }
        idSet = lockedWithDraw(s, pairs, byeId, cut, forcedTable);
      }

      if (byeId != null) applyMatch(s, byeId, null, 'BYE');
      for (const [a, b] of pairs) {
        let res, games;
        const mine = a === me || b === me;
        if (k === 0 && mine) {
          res = forced(scenario, a === me);
          games = res === 'D' ? { gww: 0, gwl: 0, gd: 3 } : sampleGames(rng);
        } else if (locked[pairKey(a, b)]) {
          res = locked[pairKey(a, b)];
          games = res === 'D' ? { gww: 0, gwl: 0, gd: 3 } : sampleGames(rng);
        } else if (idSet && idSet.has(a) && idSet.has(b) && rng() < pIdraw) {
          res = 'D'; games = { gww: 0, gwl: 0, gd: 3 };
        } else {
          const u = rng();
          if (u < pDraw) { res = 'D'; games = { gww: 1, gwl: 1, gd: 1 }; }
          else { res = rng() < 0.5 ? 'W1' : 'W2'; games = sampleGames(rng); }
        }
        applyMatch(s, a, b, res, games);
      }
    }

    const tb = computeTiebreaks(s);
    const mine = tb[me];
    let above = 0;
    for (const id of rankIds) { if (id !== me && compareRows(tb[id], mine) < 0) above++; }
    const rank = above + 1;
    rankCounts[rank] = (rankCounts[rank] || 0) + 1;
    if (rank < min) min = rank;
    if (rank > max) max = rank;
    if (cut != null && rank <= cut) inCut++;
    if (cut != null) {
      // points of the last player inside the cut (for the "pts needed" hint)
      const sorted = rankIds.map(id => tb[id].pts).sort((a, b) => b - a);
      cutPts.push(sorted[Math.min(cut, sorted.length) - 1]);
    }
  }

  const pct = q => {
    let acc = 0; const target = q * samples;
    for (const r of Object.keys(rankCounts).map(Number).sort((a, b) => a - b)) { acc += rankCounts[r]; if (acc >= target) return r; }
    return max;
  };
  cutPts.sort((a, b) => a - b);

  return {
    samples, rankCounts, min, max,
    p5: pct(0.05), p50: pct(0.5), p95: pct(0.95),
    pCut: cut != null ? inCut / samples : null,
    cutPtsMedian: cutPts.length ? cutPts[Math.floor(cutPts.length / 2)] : null,
  };
}

// Runs the three scenarios with bounds. Returns { W, D, L } → result objects.
export function simulateAll(opts) {
  const out = {};
  for (const scenario of ['W', 'D', 'L']) {
    const bounds = deterministicBounds({ ...opts, scenario });
    const mc = simulateScenario({ ...opts, scenario });
    out[scenario] = { scenario, ...bounds, ...mc };
  }
  return out;
}

// ── ROUND SIMULATOR: P(cut) FOR PENDING TABLES ───
// One round, pairings already fixed. Some tables are already decided
// (server-confirmed or picked by hand in the round simulator); this samples
// only the ones that aren't — no pairing algorithm, no rounds beyond this
// one — and returns each player's share of samples landing inside `cut`.
// Cheap enough to rerun after every pick. `locked` uses the same
// `"a:b": 'W1'|'W2'|'D'` shape as futureSwissRounds' known rounds.
export function simulatePendingRound({ state, pairs, byeId = null, locked = {}, field, cut, samples = 3000, seed = DEFAULTS.seed, pDraw = DEFAULTS.pDraw }) {
  const out = {};
  for (const id of field) out[id] = 0;
  if (cut == null) return out;
  const rng = makeRng(seed);

  for (let n = 0; n < samples; n++) {
    const s = cloneState(state);
    if (byeId != null) applyMatch(s, byeId, null, 'BYE');
    for (const [a, b] of pairs) {
      let res = locked[pairKey(a, b)];
      let games;
      if (res) {
        games = res === 'D' ? { gww: 0, gwl: 0, gd: 3 } : { gww: 2, gwl: 0, gd: 0 };
      } else {
        const u = rng();
        if (u < pDraw) { res = 'D'; games = { gww: 1, gwl: 1, gd: 1 }; }
        else { res = rng() < 0.5 ? 'W1' : 'W2'; games = sampleGames(rng); }
      }
      applyMatch(s, a, b, res, games);
    }
    const ranked = rankPlayers(s, field);
    for (const r of ranked) if (r.rank <= cut) out[r.id]++;
  }

  for (const id of field) out[id] /= samples;
  return out;
}
