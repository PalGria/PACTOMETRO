import S from '../state.js';
import { $ } from '../utils.js';

// ── OPPONENT TRACKER STATE ───────────────────────
let _trackerRound = null;

export function resetTracker() { _trackerRound = null; }

// ── RENDER: OPPONENT TRACKER ─────────────────────
export function renderOpponentTracker(pid) {
  const tabsEl   = $('opp-tabs');
  const hdrEl    = $('opp-hdr-row');
  const rowsEl   = $('opp-rows');
  if (!tabsEl || !hdrEl || !rowsEl) return;

  // Build map: round_number → { opponentId, opponentName } for this player's matches
  const myOpponents = {}; // round_number → opp info
  for (const r of S.rounds) {
    if (r.pairings_status !== 'GENERATED') continue;
    const match = (S.matches[r.id] || []).find(m => m.players?.includes(pid));
    if (!match || match.match_is_bye) continue;
    const oppRel = (match.player_match_relationships || []).find(rel => rel.player.id !== pid);
    if (oppRel) {
      myOpponents[r.round_number] = {
        opponentId:   oppRel.player.id,
        opponentName: oppRel.user_event_status?.best_identifier || oppRel.player?.best_identifier || '?',
      };
    }
  }

  // Rounds with any data
  const dataRounds = S.rounds.filter(r =>
    r.standings_status === 'GENERATED' || r.pairings_status === 'GENERATED'
  );
  if (!dataRounds.length) { tabsEl.innerHTML = ''; hdrEl.innerHTML = ''; rowsEl.innerHTML = ''; return; }

  // Default to live round, else latest
  if (!_trackerRound || !dataRounds.find(r => r.id === _trackerRound)) {
    const live = dataRounds.find(r => r.status === 'IN_PROGRESS');
    _trackerRound = (live ?? dataRounds.at(-1)).id;
  }

  // Tabs
  tabsEl.innerHTML = '';
  dataRounds.forEach(r => {
    const btn = document.createElement('button');
    btn.className = 'rtab' +
      (r.id === _trackerRound ? ' on' : '') +
      (r.status === 'IN_PROGRESS' ? ' live' : '');
    btn.textContent = r.round_number;
    btn.title = `${r.phase_name} – Round ${r.round_number}`;
    btn.onclick = () => { _trackerRound = r.id; renderOpponentTracker(pid); };
    tabsEl.appendChild(btn);
  });

  const selRound = S.rounds.find(r => r.id === _trackerRound);
  if (!selRound) return;

  // Prior opponents: faced in rounds BEFORE the selected round
  const priorOpps = Object.entries(myOpponents)
    .map(([rn, opp]) => ({ roundNum: parseInt(rn), ...opp }))
    .filter(o => o.roundNum < selRound.round_number)
    .sort((a, b) => a.roundNum - b.roundNum);

  hdrEl.innerHTML = `
    <div class="opp-hdr">
      <div>Faced</div><div>Opponent</div>
      <div>R${selRound.round_number}</div>
      <div>vs</div>
      <div style="text-align:right">Record</div>
      <div style="text-align:right">MWP</div>
    </div>`;

  if (!priorOpps.length) {
    rowsEl.innerHTML = `<div class="s-empty" style="padding:1.25rem 1rem">No prior opponents — select a later round</div>`;
    return;
  }

  const selMatches   = S.matches[_trackerRound] || [];
  const selStandings = S.standings[_trackerRound] || [];

  rowsEl.innerHTML = priorOpps.map(opp => {
    const match = selMatches.find(m => m.players?.includes(opp.opponentId));
    let result = null, vsName = '—', vsId = null;

    if (match) {
      if (match.match_is_bye) {
        result = 'BYE';
      } else if (match.match_is_intentional_draw || match.match_is_unintentional_draw) {
        result = 'D';
      } else if (match.winning_player === opp.opponentId) {
        result = 'W';
      } else if (match.winning_player !== null) {
        result = 'L';
      }
      // null = still in progress
      const rel = (match.player_match_relationships || []).find(r => r.player.id !== opp.opponentId);
      if (rel) {
        vsName = rel.user_event_status?.best_identifier || rel.player?.best_identifier || '—';
        vsId   = rel.player.id;
      } else if (!match.match_is_bye && match.players) {
        // Fallback: derive vs player from match.players + standings when relationships are absent
        vsId = match.players.find(p => p !== opp.opponentId) ?? null;
        if (vsId) {
          const vsStanding = selStandings.find(p => p.id === vsId);
          vsName = vsStanding?.user_event_status?.best_identifier
                ?? vsStanding?.player?.best_identifier
                ?? '—';
        }
      }
    }

    const standing = selStandings.find(p => p.id === opp.opponentId);
    const record   = standing?.record ?? '—';
    const rawMWP   = standing ? standing.points / (selRound.round_number * 3) : null;
    const mwp      = rawMWP != null ? Math.max(1/3, rawMWP) : null; // floor at 33.3%
    const mwpStr   = mwp != null ? (mwp * 100).toFixed(1) + '%' : '—';
    const mwpColor = rawMWP != null
      ? (rawMWP >= 0.5 ? 'var(--green)' : rawMWP >= 1/3 ? 'var(--yellow)' : 'var(--red)')
      : 'var(--t3)';

    const rc  = result === 'W' || result === 'BYE' ? 'win'
              : result === 'L'                      ? 'loss'
              : result === 'D'                      ? 'draw'
              : result === null && match            ? 'pending'
              : '';
    const lbl = result === 'W'   ? 'WIN'
              : result === 'L'   ? 'LOSS'
              : result === 'D'   ? 'DRAW'
              : result === 'BYE' ? 'BYE'
              : match            ? '…'
              : '—';

    const vsHtml = vsId
      ? `<span class="rh-opp link" data-pid="${vsId}">${vsName}</span>`
      : `<span style="color:var(--t3);font-size:.72rem">${vsName}</span>`;

    return `
      <div class="opp-row ${rc}">
        <div class="rh-num">R${opp.roundNum}</div>
        <span class="rh-opp link handle" data-pid="${opp.opponentId}" style="font-size:.78rem">${opp.opponentName}</span>
        <div><span class="badge ${rc === 'pending' ? 'none' : (rc || 'none')}">${lbl}</span></div>
        ${vsHtml}
        <div class="rh-rec" style="text-align:right">${record}</div>
        <div class="rh-omw" style="color:${mwpColor};text-align:right">${mwpStr}</div>
      </div>`;
  }).join('');

  // Clicking an opponent in the vs column emits event — main.js listens and calls selectPlayer
  rowsEl.querySelectorAll('.rh-opp.link[data-pid]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const oppPid = parseInt(el.dataset.pid);
      if (oppPid) document.dispatchEvent(new CustomEvent('pm:select-player', { detail: { pid: oppPid }, bubbles: true }));
    });
  });
}
