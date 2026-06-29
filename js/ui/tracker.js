import S from '../state.js';
import { $ } from '../utils.js';

export function resetTracker() {}

// ── RENDER: OPPONENT TRACKER ─────────────────────
export function renderOpponentTracker(pid) {
  const tabsEl = $('opp-tabs');
  const hdrEl  = $('opp-hdr-row');
  const rowsEl = $('opp-rows');
  if (!tabsEl || !hdrEl || !rowsEl) return;

  tabsEl.innerHTML = '';

  // Collect every non-bye opponent this player has faced
  const faced = [];
  for (const r of S.rounds) {
    if (r.pairings_status !== 'GENERATED') continue;
    const match = (S.matches[r.id] || []).find(m => m.players?.includes(pid));
    if (!match || match.match_is_bye) continue;
    const oppRel = (match.player_match_relationships || []).find(rel => rel.player.id !== pid);
    if (!oppRel) continue;

    let result = null;
    if (match.match_is_intentional_draw || match.match_is_unintentional_draw) result = 'D';
    else if (match.winning_player === pid)   result = 'W';
    else if (match.winning_player !== null)  result = 'L';

    faced.push({
      roundNum:     r.round_number,
      opponentId:   oppRel.player.id,
      opponentName: oppRel.user_event_status?.best_identifier || oppRel.player?.best_identifier || '?',
      result,
    });
  }

  faced.sort((a, b) => a.roundNum - b.roundNum);

  if (!faced.length) {
    hdrEl.innerHTML = '';
    rowsEl.innerHTML = `<div class="s-empty" style="padding:1.25rem 1rem">No opponents tracked yet</div>`;
    return;
  }

  const completedRounds = S.rounds.filter(r => r.standings_status === 'GENERATED');
  const latestRound     = completedRounds.at(-1);
  const latestSt        = latestRound ? S.standings[latestRound.id] || [] : [];

  // Dynamic grid: faced | name | result | R1…Rn | MWP
  const rCols      = completedRounds.map(() => '42px').join(' ');
  const colTpl     = `34px 1fr 56px ${rCols} 52px`;

  const roundHdrs = completedRounds.map(r =>
    `<div class="opp-rnd-hdr" title="${r.phase_name} R${r.round_number}">R${r.round_number}</div>`
  ).join('');

  hdrEl.innerHTML = `
    <div class="opp-hdr" style="grid-template-columns:${colTpl}">
      <div>Faced</div><div>Opponent</div><div>Result</div>
      ${roundHdrs}
      <div style="text-align:right">MWP</div>
    </div>`;

  rowsEl.innerHTML = faced.map(opp => {
    const rc  = opp.result === 'W' ? 'win' : opp.result === 'L' ? 'loss' : opp.result === 'D' ? 'draw' : 'pending';
    const lbl = opp.result === 'W' ? 'WIN'  : opp.result === 'L' ? 'LOSS' : opp.result === 'D' ? 'DRAW' : '…';

    const rankCells = completedRounds.map(r => {
      const st    = (S.standings[r.id] || []).find(p => p.id === opp.opponentId);
      const faced = r.round_number === opp.roundNum;
      if (!st) return `<div class="opp-rnd-cell${faced ? ' opp-faced' : ''} opp-empty">—</div>`;
      return `<div class="opp-rnd-cell${faced ? ' opp-faced' : ''}" title="${r.phase_name} R${r.round_number}: #${st.rank} · ${st.record} · ${st.points}pts">#${st.rank}</div>`;
    }).join('');

    // MWP from latest standings
    const st     = latestSt.find(p => p.id === opp.opponentId);
    const rawMWP = st && latestRound ? st.points / (latestRound.round_number * 3) : null;
    const mwp    = rawMWP != null ? Math.max(1 / 3, rawMWP) : null;
    const mwpStr = mwp != null ? (mwp * 100).toFixed(1) + '%' : '—';
    const mwpColor = rawMWP != null
      ? (rawMWP >= 0.5 ? 'var(--green)' : rawMWP >= 1 / 3 ? 'var(--yellow)' : 'var(--red)')
      : 'var(--t3)';

    return `
      <div class="opp-row ${rc}" style="grid-template-columns:${colTpl}">
        <div class="rh-num">R${opp.roundNum}</div>
        <span class="rh-opp link handle" data-pid="${opp.opponentId}">${opp.opponentName}</span>
        <div><span class="badge ${rc === 'pending' ? 'none' : rc}">${lbl}</span></div>
        ${rankCells}
        <div class="rh-omw" style="color:${mwpColor};text-align:right">${mwpStr}</div>
      </div>`;
  }).join('');

  rowsEl.querySelectorAll('.rh-opp.link[data-pid]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const oppPid = parseInt(el.dataset.pid);
      if (oppPid) document.dispatchEvent(new CustomEvent('pm:select-player', { detail: { pid: oppPid }, bubbles: true }));
    });
  });
}
