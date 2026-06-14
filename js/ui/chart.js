import S from '../state.js';
import { $ } from '../utils.js';

// ── RENDER: OMW CHART (SVG) ──────────────────────
export function renderChart(history) {
  const svg = $('omw-svg');
  svg.innerHTML = '';

  const pts = history.filter(h => h.omw != null);
  if (pts.length < 1) return;

  const W = 800, H = 130;
  const PAD = { top: 12, right: 24, bottom: 22, left: 38 };
  const iW = W - PAD.left - PAD.right;
  const iH = H - PAD.top  - PAD.bottom;

  const minV = S.omwRange?.min ?? 0.25;
  const maxV = S.omwRange?.max ?? 0.85;

  const xS = i => PAD.left + (i / Math.max(pts.length - 1, 1)) * iW;
  const yS = v => PAD.top  + (1 - (v - minV) / (maxV - minV)) * iH;

  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const node = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  };

  // Defs: gradient
  const defs = el('defs', {});
  const grad = el('linearGradient', { id: 'og', x1: '0', y1: '0', x2: '0', y2: '1' });
  const s1 = el('stop', { offset: '0%',   'stop-color': '#a78bfa', 'stop-opacity': '.25' });
  const s2 = el('stop', { offset: '100%', 'stop-color': '#a78bfa', 'stop-opacity': '0' });
  grad.append(s1, s2); defs.append(grad); svg.append(defs);

  // Grid lines
  [.33, .5, .67, .75].forEach(v => {
    if (v < minV || v > maxV) return;
    const y = yS(v);
    svg.append(el('line', { x1: PAD.left, x2: W - PAD.right, y1: y, y2: y,
      stroke: 'rgba(148,163,184,.08)', 'stroke-width': '1', 'stroke-dasharray': '4 4' }));
    const t = el('text', { x: PAD.left - 5, y: y + 4,
      'text-anchor': 'end', fill: 'rgba(148,163,184,.35)',
      'font-size': '9', 'font-family': 'JetBrains Mono, monospace' });
    t.textContent = Math.round(v * 100) + '%';
    svg.append(t);
  });

  if (pts.length >= 2) {
    const pointsStr = pts.map((h, i) => `${xS(i)},${yS(h.omw)}`).join(' ');
    const firstX = xS(0), lastX = xS(pts.length - 1), bottom = PAD.top + iH;

    // Area
    svg.append(el('path', {
      d: `M ${firstX} ${yS(pts[0].omw)} ` +
         pts.slice(1).map((h, i) => `L ${xS(i+1)} ${yS(h.omw)}`).join(' ') +
         ` L ${lastX} ${bottom} L ${firstX} ${bottom} Z`,
      fill: 'url(#og)',
    }));

    // Line
    svg.append(el('polyline', {
      points: pointsStr,
      fill: 'none', stroke: '#a78bfa', 'stroke-width': '2', 'stroke-linejoin': 'round',
    }));
  }

  // Dots + labels
  pts.forEach((h, i) => {
    const cx = xS(i), cy = yS(h.omw);
    const dotColor = h.result === 'W' ? '#4ade80' : h.result === 'L' ? '#f87171' : h.result === 'D' ? '#fbbf24' : '#a78bfa';

    svg.append(el('circle', { cx, cy, r: '4.5', fill: dotColor, stroke: '#0b0e16', 'stroke-width': '1.5' }));

    const label = el('text', { x: cx, y: PAD.top + iH + 16,
      'text-anchor': 'middle', fill: 'rgba(148,163,184,.45)',
      'font-size': '9', 'font-family': 'JetBrains Mono, monospace' });
    label.textContent = 'R' + h.round_number;
    svg.append(label);
  });
}
