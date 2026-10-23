// ── CUT LINE STATS ───────────────────────────────
// Reading a simulateCutLine result: likely cut, "safe with", "could make it
// with". Shared by the Overview panels, the LLM summary and the accuracy
// comparison (js/ui/accuracy.js) — no DOM, no app state.

export const CUT_SAFE = 0.95, CUT_COULD = 0.05;

// Colour tier for a P(make it): sure / likely / long shot / out.
export function pinTier(p) {
  return p >= CUT_SAFE ? 'in' : p >= 0.5 ? 'likely' : p >= CUT_COULD ? 'maybe' : 'out';
}

export function fmtPct(p) {
  if (p >= 0.995 && p < 1) return '>99%';
  if (p > 0 && p < 0.005) return '<1%';
  return `${Math.round(p * 100)}%`;
}

// A player's chance of making the cut. "0%" / "100%" only when it's proven
// (adapter.provenFacts: 'out' / 'locked'); a simulation that never — or
// always — saw it happen reads "<1%" / ">99%", since it is still possible.
export function fmtChance(p, fact = null) {
  if (fact === 'out') return '0%';
  if (fact === 'locked') return '100%';
  if (p <= 0) return '<1%';
  if (p >= 1) return '>99%';
  return fmtPct(p);
}

// Likely cut, "safe with" and "could make it with" for one simulation result.
// Safe = fewest points that still get in ≥95% of the time; "could" = fewest
// points with at least a 5% shot (tiebreakers permitting). Safe walks down
// from the top and stops at the first miss, so sampling noise on a thin row
// below can't make a lower total look safe.
export function cutSummary(res) {
  const lineEntries = Object.entries(res.lineCounts).map(([p, c]) => [Number(p), c]);
  const [modePts, modeCount] = lineEntries.reduce((a, b) => (b[1] > a[1] ? b : a));
  const rows = res.byPts;
  const firstMiss = rows.findIndex(r => r.pIn < CUT_SAFE);
  const safe = firstMiss === 0 ? null : rows[(firstMiss < 0 ? rows.length : firstMiss) - 1];
  const could = rows.filter(r => r.pIn >= CUT_COULD).at(-1) || null;
  return { modePts, modeShare: modeCount / res.samples, safe, could };
}
