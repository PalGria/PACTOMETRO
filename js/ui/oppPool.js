import S from '../state.js';
import { fmtOmw } from '../utils.js';
import { buildHistory } from '../tournament.js';

export function resetOppPool() {
  const el = document.getElementById('d-pool-content');
  if (el) el.innerHTML = '';
}

export function renderOppPool() {
  const el = document.getElementById('d-pool-content');
  if (!el) return;

  if (!S.activeId) {
    el.innerHTML = `
      <div class="pool-placeholder">
        <div class="pool-placeholder-icon">◎</div>
        <p>Select a player to see their opponent pool</p>
      </div>`;
    return;
  }

  const withData = S.rounds.filter(r => r.standings_status === 'GENERATED');
  const lastRound = withData.at(-1);
  if (!lastRound) {
    el.innerHTML = `<div class="pool-placeholder"><p>No standings data yet</p></div>`;
    return;
  }

  const allStandings = S.standings[lastRound.id] || [];
  const me = allStandings.find(p => p.id === S.activeId);
  if (!me) {
    el.innerHTML = `<div class="pool-placeholder"><p>Player not found in standings</p></div>`;
    return;
  }

  const history = buildHistory(S.activeId);
  const playedIds = new Set(history.filter(h => h.opponentId).map(h => h.opponentId));
  playedIds.add(S.activeId);

  const candidates = allStandings.filter(p =>
    !playedIds.has(p.id) &&
    p.user_event_status?.registration_status === 'COMPLETE'
  );

  const same = [], ahead = [], behind = [], far = [];
  for (const p of candidates) {
    const diff = p.points - me.points;
    if (diff === 0)              same.push(p);
    else if (diff > 0 && diff <= 6)  ahead.push(p);
    else if (diff < 0 && diff >= -6) behind.push(p);
    else                              far.push(p);
  }

  const handle = me.user_event_status?.best_identifier || me.player?.best_identifier || '?';

  let html = `
    <div class="pool-header">
      <div class="pool-player-name">${handle}</div>
      <div class="pool-player-meta">#${me.rank} · ${me.record} · ${me.points} pts · OMW ${fmtOmw(me.opponent_match_win_percentage)}</div>
    </div>`;

  if (candidates.length === 0) {
    html += `<div class="pool-placeholder"><p>No unplayed active opponents found</p></div>`;
    el.innerHTML = html;
    return;
  }

  const sections = [
    { title: 'Same Points',    color: 'blue',   data: same   },
    { title: '+1–6 Pts Ahead', color: 'green',  data: ahead  },
    { title: '1–6 Pts Behind', color: 'yellow', data: behind },
    { title: 'Far Away',       color: '',        data: far    },
  ];

  for (const sec of sections) {
    if (!sec.data.length) continue;
    sec.data.sort((a, b) => a.rank - b.rank);
    html += `
      <div class="pool-section">
        <div class="pool-section-title${sec.color ? ' ' + sec.color : ''}">${sec.title}
          <span class="pool-count">${sec.data.length}</span>
        </div>
        <table class="pool-table">
          <thead><tr>
            <th>#</th><th>Player</th><th>Rec</th><th>Pts</th><th>OMW%</th><th style="text-align:right">Δ</th>
          </tr></thead>
          <tbody>
            ${sec.data.map(p => {
              const diff    = p.points - me.points;
              const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
              const diffCls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'same';
              const ph = p.user_event_status?.best_identifier || p.player?.best_identifier || '?';
              return `<tr class="pool-row" data-pid="${p.id}">
                <td class="pool-rank">${p.rank}</td>
                <td class="pool-name">${ph}</td>
                <td class="pool-rec">${p.record ?? '—'}</td>
                <td class="pool-pts">${p.points}</td>
                <td class="pool-omw">${p.opponent_match_win_percentage != null ? fmtOmw(p.opponent_match_win_percentage) : '—'}</td>
                <td class="pool-delta ${diffCls}" style="text-align:right">${diffStr}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  el.innerHTML = html;

  el.querySelectorAll('.pool-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const pid = parseInt(tr.dataset.pid);
      if (pid) document.dispatchEvent(new CustomEvent('pm:select-player', { detail: { pid }, bubbles: true }));
    });
  });
}
