// ── SWISS PAIRING SIMULATION ─────────────────────
// Approximates the pairing algorithm for rounds whose pairings are not yet
// published: players are sorted by points, order inside a points bracket is
// random, and each player is paired with the highest available player they
// have not faced yet. The bye goes to the lowest-points player who has not
// had one. A rematch is allowed only when no other option remains.

import { points } from './swiss.js';

// Small deterministic PRNG (mulberry32) so repeated simulations are stable.
export function makeRng(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// state: engine state; activeIds: players still in the event; rng: () => [0,1)
// Returns { pairs: [[a, b], ...], byeId: id | null }
export function pairSwiss(state, activeIds, rng) {
  // Works on positions in the sorted order rather than ids: called once per
  // simulated round, so with thousands of players per-player Sets/objects
  // dominated the whole simulation.
  const n = activeIds.length;
  const key = new Float64Array(n);
  for (let i = 0; i < n; i++) key[i] = points(state[activeIds[i]]) + rng() * 0.5; // random inside bracket
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((x, y) => key[y] - key[x]);
  const ids = order.map(i => activeIds[i]);

  const used = new Uint8Array(n);
  let byeId = null;
  if (n % 2 === 1) {
    let at = n - 1;
    for (let i = n - 1; i >= 0; i--) {
      if (state[ids[i]].bye === 0) { at = i; break; }
    }
    byeId = ids[at];
    used[at] = 1;
  }

  const pairs = [];
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    const a = ids[i];
    const played = state[a].opps; // a handful of ids: includes() beats a Set
    let found = -1;
    for (let j = i + 1; j < n; j++) {
      if (used[j] || played.includes(ids[j])) continue;
      found = j; break;
    }
    if (found < 0) {
      for (let j = i + 1; j < n; j++) {
        if (!used[j]) { found = j; break; }
      }
    }
    if (found < 0) continue;
    used[i] = 1; used[found] = 1;
    pairs.push([a, ids[found]]);
  }
  return { pairs, byeId };
}
