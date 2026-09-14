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
  const ids = activeIds.slice();
  const key = {};
  for (const id of ids) key[id] = points(state[id]) + rng() * 0.5; // random inside bracket
  ids.sort((a, b) => key[b] - key[a]);

  const played = {};
  for (const id of ids) played[id] = new Set(state[id].opps);

  const used = new Set();
  let byeId = null;
  if (ids.length % 2 === 1) {
    for (let i = ids.length - 1; i >= 0; i--) {
      if (state[ids[i]].bye === 0) { byeId = ids[i]; break; }
    }
    if (byeId == null) byeId = ids[ids.length - 1];
    used.add(byeId);
  }

  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    const a = ids[i];
    if (used.has(a)) continue;
    let found = null;
    for (let j = i + 1; j < ids.length; j++) {
      const b = ids[j];
      if (used.has(b) || played[a].has(b)) continue;
      found = b; break;
    }
    if (found == null) {
      for (let j = i + 1; j < ids.length; j++) {
        if (!used.has(ids[j])) { found = ids[j]; break; }
      }
    }
    if (found == null) continue;
    used.add(a); used.add(found);
    pairs.push([a, found]);
  }
  return { pairs, byeId };
}
