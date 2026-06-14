// ── HELPERS ──────────────────────────────────────
export const $ = id => document.getElementById(id);

export const fmtDate = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export const fmtOmw = v => v != null ? (v * 100).toFixed(1) + '%' : '—';

export function playerColor(id) {
  const palette = ['#38bdf8', '#4ade80', '#f87171', '#fbbf24', '#a78bfa', '#fb923c', '#e879f9', '#34d399', '#f472b6', '#60a5fa'];
  return palette[Math.abs(id) % palette.length];
}

export function extractEventId(raw) {
  const m = raw.match(/events\/(\d+)/);
  return m ? m[1] : null;
}
