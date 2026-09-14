// ── VERDICT FORMATTING ───────────────────────────
// Shared by the per-player simulation panel and the overview's cut
// calculator, so there is exactly one place to adjust the tiers.
//
// `res` is either a full Monte Carlo result (out/locked/pCut all present,
// from js/engine/montecarlo.js's simulateAll) or a bounds-only result (only
// out/locked, no pCut — e.g. js/engine/montecarlo.js's tierBounds, used for
// a hypothetical record with no real match history to sample from).

export function verdictHtml(res, cut) {
  if (!cut) return `<span class="sim-verdict nocut">—</span>`;
  if (res.out)    return `<span class="sim-verdict out">✗ OUT</span>`;
  if (res.locked) return `<span class="sim-verdict lock">✦ LOCKED</span>`;
  if (res.pCut == null) return `<span class="sim-verdict nocut">? bound only</span>`;
  const p = res.pCut;
  if (p >= 0.95) return `<span class="sim-verdict safe">✓ SAFE</span>`;
  if (p >= 0.60) return `<span class="sim-verdict likely">◔ LIKELY</span>`;
  if (p >= 0.20) return `<span class="sim-verdict risk">⚠ RISKY</span>`;
  return `<span class="sim-verdict unlikely">✗ UNLIKELY</span>`;
}

export function pctHtml(res, cut) {
  if (!cut) return '—';
  if (res.out)    return '0%';
  if (res.locked) return '100%';
  if (res.pCut == null) return '—';
  const p = res.pCut * 100;
  const txt = p >= 99.5 && p < 100 ? '>99%' : p > 0 && p < 0.5 ? '<1%' : `${Math.round(p)}%`;
  return txt;
}
