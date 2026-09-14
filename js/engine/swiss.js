// ── SWISS ENGINE ─────────────────────────────────
// Pure functions (no DOM, no app state). Recomputes points and the three
// Lorcana tiebreakers (OMW%, GW%, OGW%) from the full match graph.
//
// Rules verified against the Ravensburger Play API on event 515727
// (5 Swiss rounds × 29 players, 0 mismatches). See SIMULATION_MATH.md §1.
//
//   MWP(p)  = (3·W + D) / (3·matches)   — a BYE counts as a won match here
//   OMW%(p) = mean of MWP over real opponents (byes are not opponents)
//             each opponent MWP floored at 0.33; no opponents → 0.33
//   GW%(p)  = (3·gamesWon + gamesDrawn) / (3·gamesPlayed), a BYE adds 2-0
//             floored at 0.33
//   OGW%(p) = mean of GW% over real opponents, no opponents → 0.33
//   rank    = pts desc, OMW desc, GW desc, OGW desc (API rounds to 8 dp)

export const FLOOR = 0.33;

// ── STATE ────────────────────────────────────────
export function createState(playerIds) {
  const s = {};
  for (const id of playerIds) s[id] = newRecord();
  return s;
}

export function newRecord() {
  return { w: 0, l: 0, d: 0, bye: 0, gw: 0, gl: 0, gd: 0, opps: [] };
}

export function cloneState(s) {
  const c = {};
  for (const k in s) {
    const r = s[k];
    c[k] = { w: r.w, l: r.l, d: r.d, bye: r.bye, gw: r.gw, gl: r.gl, gd: r.gd, opps: r.opps.slice() };
  }
  return c;
}

function ensure(s, id) {
  if (id == null) return null;
  return s[id] || (s[id] = newRecord());
}

// ── APPLY RESULTS ────────────────────────────────
// res: 'W1' (a wins) | 'W2' (b wins) | 'D' | 'BYE' (a gets the bye, b ignored)
// games: { gww, gwl, gd } games won by winner / by loser / drawn.
//   For a draw, gww/gwl are the games each side won (symmetric); an
//   intentional draw is recorded by the API as gd=3, gww=gwl=0.
export function applyMatch(s, a, b, res, games) {
  if (res === 'BYE') {
    const ra = ensure(s, a);
    if (ra) { ra.w++; ra.bye++; }
    return;
  }
  const ra = ensure(s, a), rb = ensure(s, b);
  if (!ra || !rb) return;
  ra.opps.push(b);
  rb.opps.push(a);

  if (res === 'D') {
    const gd = games?.gd ?? 3;
    ra.d++; rb.d++;
    ra.gd += gd; rb.gd += gd;
    ra.gw += games?.gww ?? 0; ra.gl += games?.gwl ?? 0;
    rb.gw += games?.gwl ?? 0; rb.gl += games?.gww ?? 0;
    return;
  }

  const rw = res === 'W1' ? ra : rb;
  const rl = res === 'W1' ? rb : ra;
  const gww = games?.gww ?? 2, gwl = games?.gwl ?? 0, gd = games?.gd ?? 0;
  rw.w++; rl.l++;
  rw.gw += gww; rw.gl += gwl; rw.gd += gd;
  rl.gw += gwl; rl.gl += gww; rl.gd += gd;
}

// Classify an API match object. Returns null while the match is pending.
export function matchResult(m) {
  if (m.match_is_bye) return 'BYE';
  if (m.match_is_intentional_draw || m.match_is_unintentional_draw) return 'D';
  if (m.winning_player != null) return m.players?.[0] === m.winning_player ? 'W1' : 'W2';
  return null;
}

export function matchGames(m) {
  return { gww: m.games_won_by_winner ?? 0, gwl: m.games_won_by_loser ?? 0, gd: m.games_drawn ?? 0 };
}

// Apply a confirmed API result. Returns false if the match is still pending.
export function applyApiMatch(s, m) {
  const res = matchResult(m);
  if (!res) return false;
  const [a, b] = m.players || [];
  if (res === 'BYE') applyMatch(s, a, null, 'BYE');
  else applyMatch(s, a, b, res, matchGames(m));
  return true;
}

// Apply every confirmed result of an array of API matches.
export function applyApiRound(s, matches) {
  for (const m of matches || []) applyApiMatch(s, m);
}

// ── TIEBREAKERS ──────────────────────────────────
export const points = r => 3 * r.w + r.d;

export function matchWinPct(r) {
  const n = r.w + r.l + r.d;
  return n ? Math.max(FLOOR, points(r) / (3 * n)) : FLOOR;
}

export function gameWinPct(r) {
  const tot = r.gw + r.gl + r.gd + 2 * r.bye;
  return tot ? Math.max(FLOOR, (3 * (r.gw + 2 * r.bye) + r.gd) / (3 * tot)) : FLOOR;
}

// Returns { [id]: { pts, mwp, omw, gw, ogw } }
export function computeTiebreaks(s) {
  const mw = {}, gwp = {};
  for (const k in s) { mw[k] = matchWinPct(s[k]); gwp[k] = gameWinPct(s[k]); }
  const out = {};
  for (const k in s) {
    const r = s[k], n = r.opps.length;
    let omw = FLOOR, ogw = FLOOR;
    if (n) {
      let so = 0, sg = 0;
      for (const o of r.opps) { so += mw[o] ?? FLOOR; sg += gwp[o] ?? FLOOR; }
      omw = so / n; ogw = sg / n;
    }
    out[k] = { pts: points(r), mwp: mw[k], omw, gw: gwp[k], ogw };
  }
  return out;
}

// The API rounds tiebreakers to 8 decimals before comparing.
const r8 = x => Math.round(x * 1e8) / 1e8;

export function compareRows(a, b) {
  return b.pts - a.pts
    || r8(b.omw) - r8(a.omw)
    || r8(b.gw)  - r8(a.gw)
    || r8(b.ogw) - r8(a.ogw);
}

// Sorted rows [{ id, pts, mwp, omw, gw, ogw, rank }].
// `ids` optionally restricts the ranking to a subset (e.g. active players).
export function rankPlayers(s, ids) {
  const tb = computeTiebreaks(s);
  const keys = ids ? ids : Object.keys(s).map(Number);
  const rows = keys.map(id => ({ id: Number(id), ...tb[id] }));
  rows.sort(compareRows);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

// Rank position of one player without building the row objects for everyone.
export function rankOf(s, pid, ids) {
  const tb = computeTiebreaks(s);
  const me = tb[pid];
  if (!me) return null;
  let above = 0;
  const keys = ids ? ids : Object.keys(s);
  for (const k of keys) {
    if (Number(k) === pid) continue;
    if (compareRows(tb[k], me) < 0) above++;
  }
  return above + 1;
}

// ── VALIDATION ───────────────────────────────────
// Compare engine output against an API standings array. Rank differences
// between rows whose four keys are identical are reported as `ties`, not
// mismatches: the API orders exact ties arbitrarily.
export function validateAgainstStandings(s, apiStandings, eps = 1e-4) {
  const tb = computeTiebreaks(s);
  const rows = rankPlayers(s, apiStandings.map(p => p.id));
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  const mismatches = [];
  let ties = 0;
  for (const p of apiStandings) {
    const c = tb[p.id];
    if (!c) { mismatches.push({ id: p.id, field: 'missing' }); continue; }
    const checks = [
      ['pts', p.points, c.pts, 0],
      ['omw', p.opponent_match_win_percentage, c.omw, eps],
      ['gw',  p.game_win_percentage,           c.gw,  eps],
      ['ogw', p.opponent_game_win_percentage,  c.ogw, eps],
    ];
    for (const [field, api, calc, tol] of checks) {
      if (api == null) continue;
      if (Math.abs(api - calc) > tol) mismatches.push({ id: p.id, field, api, calc });
    }
    const mine = byId[p.id];
    if (mine.rank !== p.rank) {
      const other = rows[p.rank - 1];
      const tie = other && compareRows(other, mine) === 0;
      if (tie) ties++;
      else mismatches.push({ id: p.id, field: 'rank', api: p.rank, calc: mine.rank });
    }
  }
  return { mismatches, ties };
}
