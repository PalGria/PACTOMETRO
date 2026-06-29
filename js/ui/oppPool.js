import S from '../state.js';
import { fmtOmw } from '../utils.js';
import { buildHistory } from '../tournament.js';

let _poolTab = 'last'; // 'last' | 'current'

export function resetOppPool() {
  const el = document.getElementById('d-pool-content');
  if (el) el.innerHTML = '';
  _poolTab = 'last';
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

  const completedRounds = S.rounds.filter(r => r.standings_status === 'GENERATED');
  const lastRound = completedRounds.at(-1);
  if (!lastRound) {
    el.innerHTML = `<div class="pool-placeholder"><p>No standings data yet</p></div>`;
    return;
  }

  const liveRound = S.rounds.find(
    r => r.status === 'IN_PROGRESS' &&
         r.pairings_status === 'GENERATED' &&
         r.standings_status !== 'GENERATED'
  );
  const hasLive = !!liveRound;

  // Resolve standings based on active tab
  const useProjected = hasLive && _poolTab === 'current';
  const standings = useProjected
    ? _computeProjected(liveRound.id, completedRounds)
    : S.standings[lastRound.id] || [];

  const me = standings.find(p => p.id === S.activeId);
  if (!me) {
    el.innerHTML = `<div class="pool-placeholder"><p>Player not found in standings</p></div>`;
    return;
  }

  const playedIds = new Set(
    buildHistory(S.activeId).filter(h => h.opponentId).map(h => h.opponentId)
  );
  playedIds.add(S.activeId);

  const candidates = standings.filter(p =>
    !playedIds.has(p.id) &&
    p.user_event_status?.registration_status === 'COMPLETE'
  );

  const same = [], ahead = [], behind = [], far = [];
  for (const p of candidates) {
    const diff = p.points - me.points;
    if (diff === 0)               same.push(p);
    else if (diff > 0 && diff <= 6)   ahead.push(p);
    else if (diff < 0 && diff >= -6)  behind.push(p);
    else                               far.push(p);
  }

  const handle = me.user_event_status?.best_identifier || me.player?.best_identifier || '?';

  // Tab bar (only rendered when a live round exists)
  const tabBar = hasLive ? `
    <div class="pool-tab-bar">
      <button class="pool-tab${_poolTab === 'last'    ? ' on' : ''}" data-tab="last">Last standings</button>
      <button class="pool-tab${_poolTab === 'current' ? ' on' : ''}" data-tab="current">Current <span class="pool-tab-live">LIVE</span></button>
    </div>` : '';

  const metaNote = useProjected
    ? `#${me.rank} · ${me.record} · ${me.points} pts · projected`
    : `#${me.rank} · ${me.record} · ${me.points} pts · OMW ${fmtOmw(me.opponent_match_win_percentage)}`;

  let html = `
    ${tabBar}
    <div class="pool-header">
      <div class="pool-player-name">${handle}</div>
      <div class="pool-player-meta">${metaNote}</div>
    </div>`;

  if (candidates.length === 0) {
    html += `<div class="pool-placeholder"><p>No unplayed active opponents found</p></div>`;
    el.innerHTML = html;
    _wireTabButtons(el, liveRound);
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
                <td class="pool-omw">${fmtOmw(p.opponent_match_win_percentage)}</td>
                <td class="pool-delta ${diffCls}" style="text-align:right">${diffStr}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  el.innerHTML = html;
  _wireTabButtons(el, liveRound);

  el.querySelectorAll('.pool-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const pid = parseInt(tr.dataset.pid);
      if (pid) document.dispatchEvent(new CustomEvent('pm:select-player', { detail: { pid }, bubbles: true }));
    });
  });
}

// ── WIRE TAB CLICKS ───────────────────────────────
function _wireTabButtons(el, liveRound) {
  if (!liveRound) return;
  el.querySelectorAll('.pool-tab[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      _poolTab = btn.dataset.tab;
      renderOppPool();
    });
  });
}

// ── PROJECTED STANDINGS FROM LOCKED API RESULTS ───
function _computeProjected(roundId, completedRounds) {
  const base = S.standings[completedRounds.at(-1)?.id] || [];

  const ptMap  = {};
  const omwMap = {};
  const recMap = {};
  const metaMap = {};
  for (const p of base) {
    ptMap[p.id]   = p.points;
    omwMap[p.id]  = p.opponent_match_win_percentage ?? 0;
    recMap[p.id]  = p.record;
    metaMap[p.id] = p;
  }

  const matches = S.matches[roundId] || [];
  for (const match of matches) {
    const [p1, p2] = match.players || [];
    const isBye  = match.match_is_bye;
    const isDraw = match.match_is_intentional_draw || match.match_is_unintentional_draw;
    const hasWin = match.winning_player != null;

    if (isBye || isDraw || hasWin) {
      if (isBye) {
        if (p1 != null && p1 in ptMap) ptMap[p1] += 3;
      } else if (isDraw) {
        if (p1 != null && p1 in ptMap) ptMap[p1] += 1;
        if (p2 != null && p2 in ptMap) ptMap[p2] += 1;
      } else {
        const winner = match.players?.[0] === match.winning_player ? p1 : p2;
        if (winner != null && winner in ptMap) ptMap[winner] += 3;
      }
    }
  }

  return base
    .map(p => ({ ...metaMap[p.id], points: ptMap[p.id] ?? p.points }))
    .sort((a, b) => b.points - a.points || (omwMap[b.id] ?? 0) - (omwMap[a.id] ?? 0))
    .map((p, i) => ({ ...p, rank: i + 1 }));
}
