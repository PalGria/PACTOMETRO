// ── MONTE CARLO WORKER ───────────────────────────
// Runs simulateAll off the main thread. See js/services/simWorker.js for the
// promise-based wrapper (and the synchronous fallback used where Workers
// aren't available, e.g. the Node test harness).

import { simulateAll, simulatePendingRound, simulateCutLine } from './montecarlo.js';

const handlers = { scenario: simulateAll, pendingRound: simulatePendingRound, cutLine: simulateCutLine };

self.onmessage = (e) => {
  const { id, kind, opts } = e.data;
  try {
    const results = (handlers[kind] || simulateAll)(opts);
    self.postMessage({ id, results });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
