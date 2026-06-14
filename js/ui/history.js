import { $, fmtOmw } from '../utils.js';

// ── RENDER: ROUND HISTORY ────────────────────────
export function renderHistory(history) {
  $('rh-rows').innerHTML = history.map(h => {
    const rc  = h.result === 'W' ? 'win' : h.result === 'L' ? 'loss' : h.result === 'D' ? 'draw' : '';
    const lbl = h.result === 'W' ? 'WIN' : h.result === 'L' ? 'LOSS' : h.result === 'D' ? 'DRAW' : '—';

    let badgeHtml;
    if (h.live && h.dropped) {
      badgeHtml = `<span class="badge dropped-badge">DROPPED</span>`;
    } else if (h.live && !h.result) {
      badgeHtml = `<span class="badge live-badge">LIVE</span>`;
    } else {
      const badgeText = h.score ? `${lbl} ${h.score}` : lbl;
      badgeHtml = `<span class="badge ${rc || 'none'}">${badgeText}</span>`;
    }

    const oppHtml = h.opponent
      ? `<span class="rh-opp link" data-pid="${h.opponentId}">${h.opponent}</span>`
      : `<span class="rh-opp none">—</span>`;

    return `
      <div class="rh-row ${rc}${h.live && !h.dropped ? ' live-row' : ''}">
        <div class="rh-num">R${h.round_number}</div>
        ${oppHtml}
        <div>${badgeHtml}</div>
        <div class="rh-rec">${h.record ?? '—'}</div>
        <div class="rh-omw">${h.omw != null ? fmtOmw(h.omw) : '—'}</div>
        <div class="rh-rank">${h.rank != null ? '#' + h.rank : '—'}</div>
      </div>`;
  }).join('');

  // Clicking opponent name emits event — main.js listens and calls selectPlayer
  $('rh-rows').querySelectorAll('.rh-opp.link').forEach(span => {
    span.addEventListener('click', () => {
      const pid = parseInt(span.dataset.pid);
      if (pid) document.dispatchEvent(new CustomEvent('pm:select-player', { detail: { pid }, bubbles: true }));
    });
  });
}
