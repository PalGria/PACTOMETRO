import { $, fmtOmw } from '../utils.js';

// ── RENDER: ROUND HISTORY ────────────────────────
export function renderHistory(history) {
  $('rh-rows').innerHTML = history.map(h => {
    const rc  = h.result === 'W' ? 'win' : h.result === 'L' ? 'loss' : h.result === 'D' ? 'draw' : '';
    const lbl = h.result === 'W' ? 'WIN' : h.result === 'L' ? 'LOSS' : h.result === 'D' ? 'DRAW' : '—';
    const badgeText = h.score ? `${lbl} ${h.score}` : lbl;
    const oppHtml = h.opponent
      ? `<span class="rh-opp link" data-pid="${h.opponentId}">${h.opponent}</span>`
      : `<span class="rh-opp none">—</span>`;
    return `
      <div class="rh-row ${rc}">
        <div class="rh-num">R${h.round_number}</div>
        ${oppHtml}
        <div><span class="badge ${rc || 'none'}">${badgeText}</span></div>
        <div class="rh-rec">${h.record}</div>
        <div class="rh-omw">${fmtOmw(h.omw)}</div>
        <div class="rh-rank">#${h.rank}</div>
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
