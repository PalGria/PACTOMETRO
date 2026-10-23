// ── CUT LINE REPLAY ──────────────────────────────
// The cut line projection as it stood before round 1 and after each
// completed Swiss round, using only what was known then: no later pairings
// or results. Feeds the "Cut line by round" chart and the prediction vs
// reality comparison (js/ui/accuracy.js). Past rounds don't change, so each
// projection is cached for the life of the page.

import S from '../state.js';
import {
  swissRounds, eventTotals, stateAfterRound, stateBeforeRound,
  activeIdsAfter, swissEntryGates, pointsGate,
} from '../engine/adapter.js';
import { runCutLineSimulation } from '../services/simWorker.js';

const _cache = new Map();

// Samples for a field of this size: fewer per run on big fields, where every
// run is expensive and the per-points averages are already smooth.
export function cutSamples(state, scale = 1) {
  const n = Object.keys(state).length;
  return Math.round(scale * Math.max(300, Math.min(1500, Math.round(150000 / Math.max(1, n)))));
}

export function replayLabel(base) {
  return base ? `R${swissRounds().findIndex(r => r.id === base.id) + 1}` : 'Start';
}

// Every moment with something left to predict once Swiss is over: before
// round 1, then after each completed round but the last.
export function finishedReplayBases() {
  const done = swissRounds().filter(r => r.standings_status === 'GENERATED');
  return [null, ...done.slice(0, -1)];
}

// The projection as of `base` (a Swiss round, or null for before round 1).
// Resolves to a simulateCutLine result, or null with nothing to project.
export function replayOne(base, cut) {
  const swiss = swissRounds();
  const key = `${S.event?.id}|${base?.id ?? 'start'}|${cut}|${pointsGate()?.pts ?? ''}`;
  const hit = _cache.get(key);
  if (hit) return Promise.resolve(hit);
  const total = Math.max(eventTotals().totalRounds, swiss.length);
  const played = base ? swiss.findIndex(r => r.id === base.id) + 1 : 0;
  const state = base ? stateAfterRound(base.id) : stateBeforeRound(swiss[0].id);
  const activeIds = activeIdsAfter(base?.id ?? null);
  const futureRounds = Array(Math.max(0, total - played)).fill(null);
  if (!futureRounds.length || !activeIds.length) return Promise.resolve(null);
  const gates = swissEntryGates(base?.id ?? null);
  return runCutLineSimulation({ state, activeIds, futureRounds, gates, cut, samples: cutSamples(state, 0.4) })
    .then(res => { _cache.set(key, res); return res; });
}

// One at a time (the worker is single-threaded anyway). Resolves to
// [{ base, label, res }] in order; `onStep(done, total)` reports progress.
export function replayCutLine(bases, cut, onStep = null) {
  return bases.reduce((chain, base, i) => chain.then(acc => replayOne(base, cut).then(res => {
    onStep?.(i + 1, bases.length);
    return [...acc, { base, label: replayLabel(base), res }];
  })), Promise.resolve([]));
}
