// ── ENGINE ↔ APP STATE ADAPTER ───────────────────
// The only engine module that knows about the app state (S). Everything
// here builds engine inputs from S.rounds / S.matches / S.standings.

import S from '../state.js';
import { createState, applyApiRound, matchResult, matchGames, applyMatch, rankPlayers, validateAgainstStandings } from './swiss.js';

export const isSwiss = r => r.phase_type === 'SWISS';

export function swissRounds() {
  return S.rounds.filter(isSwiss);
}

// The event's declared Swiss round count and starting field size — fixed
// metadata, known before a single match is played and unchanged for the
// life of the event. Falls back to what's actually been seen so far if the
// API didn't send the field (observed null on some events).
export function eventTotals() {
  const swissPhase = S.event?.tournament_phases?.find(p => p.round_type === 'SWISS');
  const totalRounds  = swissPhase?.number_of_rounds || swissRounds().length;
  const totalPlayers = S.event?.starting_player_count || allPlayerIds().length;
  return { totalRounds, totalPlayers };
}

// Every player id seen in any standings or pairing.
export function allPlayerIds() {
  const ids = new Set();
  for (const rows of Object.values(S.standings)) for (const p of rows) ids.add(p.id);
  for (const ms of Object.values(S.matches)) for (const m of ms) for (const id of m.players || []) if (id != null) ids.add(id);
  return [...ids];
}

// Engine state with every confirmed Swiss result of rounds strictly before
// `roundId` (or of all Swiss rounds when roundId is null).
export function stateBeforeRound(roundId) {
  const s = createState(allPlayerIds());
  for (const r of S.rounds) {
    if (r.id === roundId) break;
    if (isSwiss(r)) applyApiRound(s, S.matches[r.id]);
  }
  return s;
}

// Engine state including confirmed results of `roundId` itself.
export function stateAfterRound(roundId) {
  const s = createState(allPlayerIds());
  for (const r of S.rounds) {
    if (isSwiss(r)) applyApiRound(s, S.matches[r.id]);
    if (r.id === roundId) break;
  }
  return s;
}

// Nearest round with generated standings strictly before `roundId`.
export function baseStandingsBefore(roundId) {
  const idx = S.rounds.findIndex(r => r.id === roundId);
  for (let i = idx - 1; i >= 0; i--) {
    if (S.rounds[i].standings_status === 'GENERATED') return S.standings[S.rounds[i].id] || [];
  }
  return [];
}

// Pairings of a round in engine form, with results already reported locked.
export function knownRound(roundId) {
  const matches = S.matches[roundId];
  if (!matches || !matches.length) return null;
  const pairs = [], locked = {};
  let byeId = null;
  for (const m of matches) {
    const res = matchResult(m);
    const [a, b] = m.players || [];
    if (m.match_is_bye) { byeId = a; continue; }
    if (a == null || b == null) continue;
    pairs.push([a, b]);
    if (res) locked[`${a}:${b}`] = res;
  }
  return { pairs, byeId, locked };
}

// Swiss rounds after `baseRoundId`, as Monte Carlo input.
export function futureSwissRounds(baseRoundId) {
  const swiss = swissRounds();
  const idx = swiss.findIndex(r => r.id === baseRoundId);
  return swiss.slice(idx + 1).map(r => (r.pairings_status === 'GENERATED' ? knownRound(r.id) : null));
}

// Players still in the event after `baseRoundId`: those paired in the next
// round when its pairings exist, otherwise everyone whose registration is
// still COMPLETE in the latest standings.
export function activeIdsAfter(baseRoundId) {
  const swiss = swissRounds();
  const idx = swiss.findIndex(r => r.id === baseRoundId);
  const next = swiss[idx + 1];
  if (next && next.pairings_status === 'GENERATED' && (S.matches[next.id] || []).length) {
    const ids = new Set();
    for (const m of S.matches[next.id]) for (const id of m.players || []) if (id != null) ids.add(id);
    return [...ids];
  }
  const rows = S.standings[baseRoundId] || [];
  const active = rows.filter(p => p.user_event_status?.registration_status === 'COMPLETE').map(p => p.id);
  return active.length ? active : rows.map(p => p.id);
}

// ── EXACT ROUND PROJECTION ───────────────────────
// Standings after `roundId` given API results plus user picks
// ({ [matchId]: 'W1' | 'W2' | 'D' | null }). Tiebreakers are recomputed from
// the whole match graph, so with every match decided this is the exact table.
// Rows keep the shape of API standings rows (spread from the base standings)
// plus: projPts, projRank, unknown, omw, gw, ogw. `rank`/`points` are the
// base (previous standings) values, used for deltas.
export function projectRound(roundId, picks = {}) {
  const s = stateBeforeRound(roundId);
  const base = baseStandingsBefore(roundId);
  const baseById = Object.fromEntries(base.map(p => [p.id, p]));
  const matches = S.matches[roundId] || [];

  const unknown = new Set();
  const meta = {};
  for (const m of matches) {
    const [a, b] = m.players || [];
    for (const rel of m.player_match_relationships || []) meta[rel.player.id] = rel;
    const res = matchResult(m) || picks[m.id] || null;
    if (res === 'BYE') { applyMatch(s, a, null, 'BYE'); continue; }
    if (!res) { if (a != null) unknown.add(a); if (b != null) unknown.add(b); continue; }
    const games = matchResult(m) ? matchGames(m) : (res === 'D' ? { gww: 0, gwl: 0, gd: 3 } : { gww: 2, gwl: 0, gd: 0 });
    applyMatch(s, a, b, res, games);
  }

  // Rank the players that are part of this round's field: everyone in the
  // base standings plus anyone paired this round.
  const field = new Set(base.map(p => p.id));
  for (const m of matches) for (const id of m.players || []) if (id != null) field.add(id);

  return rankPlayers(s, [...field]).map(r => {
    const b = baseById[r.id];
    const rel = meta[r.id];
    return {
      ...(b || {
        id: r.id, rank: null, points: null, record: null,
        player: rel?.player, user_event_status: rel?.user_event_status,
      }),
      id: r.id,
      projPts:  r.pts,
      projRank: r.rank,
      omw: r.omw, gw: r.gw, ogw: r.ogw,
      unknown:  unknown.has(r.id),
      // Exact, live-round record — overrides the stale pre-round `record`
      // spread in from the base standings above.
      record: `${s[r.id]?.w ?? 0}-${s[r.id]?.l ?? 0}-${s[r.id]?.d ?? 0}`,
    };
  });
}

// Round to default to: the live round (in progress, pairings published) if
// one exists, otherwise the last round with officially generated standings.
// Used everywhere a board needs "what round am I looking at by default" so
// the app never silently freezes on a stale round while one is in progress.
export function defaultViewRound() {
  const live = S.rounds.find(r => r.status === 'IN_PROGRESS' && r.pairings_status === 'GENERATED');
  if (live) return live.id;
  const withStandings = S.rounds.filter(r => r.standings_status === 'GENERATED');
  return withStandings.at(-1)?.id ?? S.rounds.at(-1)?.id ?? null;
}

// ── SELF-CHECK ───────────────────────────────────
// Recompute every Swiss round with generated standings and compare with the
// API. Logs a warning when the engine disagrees (rules drift, missing data).
export function validateLoadedEvent() {
  const s = createState(allPlayerIds());
  const report = [];
  let ok = true;
  for (const r of S.rounds) {
    if (!isSwiss(r)) continue;
    applyApiRound(s, S.matches[r.id]);
    if (r.standings_status !== 'GENERATED' || !(S.standings[r.id] || []).length) continue;
    const { mismatches, ties } = validateAgainstStandings(s, S.standings[r.id]);
    if (mismatches.length) ok = false;
    report.push({ round: r.round_number, mismatches, ties });
  }
  if (!ok) console.warn('[engine] standings recomputation differs from API', report.filter(x => x.mismatches.length));
  return { ok, report };
}
