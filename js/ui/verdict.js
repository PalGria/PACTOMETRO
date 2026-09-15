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

// Plain-text companions to verdictHtml/pctHtml, for contexts that can't use
// markup (e.g. the "copy for LLM" summary in js/ui/llmSummary.js). Kept as
// separate functions rather than a shared refactor of the HTML versions
// above, so their exact HTML output — asserted on directly in
// scripts/smoke-ui.mjs — can't regress.
export function verdictText(res, cut) {
  if (!cut) return '—';
  if (res.out)    return 'OUT';
  if (res.locked) return 'LOCKED';
  if (res.pCut == null) return 'bound only';
  const p = res.pCut;
  if (p >= 0.95) return 'SAFE';
  if (p >= 0.60) return 'LIKELY';
  if (p >= 0.20) return 'RISKY';
  return 'UNLIKELY';
}

export function pctText(res, cut) {
  return pctHtml(res, cut);
}
