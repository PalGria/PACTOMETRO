// ── MONTE CARLO: OFF-MAIN-THREAD RUNNER ──────────
// js/engine/montecarlo.js's simulateAll takes a few hundred ms for a small
// field and a few seconds for 128+ players — too long to run on the main
// thread without freezing scrolling/clicks. This wraps it in a module
// Worker (js/engine/worker.js) and exposes a promise per call.
//
// Falls back to a synchronous call when Workers aren't available (the Node
// smoke test) or if the worker itself fails to start.

import { simulateAll, simulatePendingRound, simulateCutLine } from '../engine/montecarlo.js';

let worker = null;
let nextId = 1;
const pending = new Map();

function ensureWorker() {
  if (worker || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('../engine/worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, results, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(results);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(e.error || new Error('simulation worker error'));
      pending.clear();
      worker.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

function dispatch(kind, opts, fallback) {
  const w = ensureWorker();
  if (!w) return Promise.resolve(fallback(opts));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, kind, opts });
  });
}

// opts must be structured-clone-safe (state/activeIds/futureRounds/scenario
// are plain objects/arrays/numbers already).
export function runSimulation(opts) {
  return dispatch('scenario', opts, simulateAll);
}

// One-round P(cut) sweep over still-pending tables — see
// js/engine/montecarlo.js's simulatePendingRound.
export function runPendingRoundSimulation(opts) {
  return dispatch('pendingRound', opts, simulatePendingRound);
}

// Field-wide cut line projection for the Overview — see
// js/engine/montecarlo.js's simulateCutLine.
export function runCutLineSimulation(opts) {
  return dispatch('cutLine', opts, simulateCutLine);
}
