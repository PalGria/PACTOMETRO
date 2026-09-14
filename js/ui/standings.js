import S from '../state.js';
import { $, fmtOmw } from '../utils.js';
import { getTopCut, getFollowed, toggleFollowed } from '../services/storage.js';
import { projectRound } from '../engine/adapter.js';
import { renderOverview } from './overview.js';

export { getTopCut };

// ── SEARCH ────────────────────────────────────────
let _query = '';

export function setSearchQuery(q) {
  _query = (q || '').trim().toLowerCase();
  renderStandings();
}

export function resetSearch() { _query = ''; }

function _matchesQuery(p) {
  if (!_query) return true;
  const handle = p.user_event_status?.best_identifier || p.player?.best_identifier || '';
  const real   = p.player?.best_identifier || '';
  return handle.toLowerCase().includes(_query) || real.toLowerCase().includes(_query);
}

// ── FIXED TOOLTIP ────────────────────────────────
const _tip = document.getElementById('tb-tooltip');

function _showTip(tr, omw, gw, ogw) {
  _tip.innerHTML = `
    <div class="tb-row"><span class="tb-lbl">OMW%</span><span class="tb-val">${fmtOmw(omw)}</span></div>
    <div class="tb-row"><span class="tb-lbl">GW%</span><span class="tb-val">${fmtOmw(gw)}</span></div>
    <div class="tb-row"><span class="tb-lbl">OGW%</span><span class="tb-val">${fmtOmw(ogw)}</span></div>`;
  _tip.classList.remove('hidden');
  const rect = tr.getBoundingClientRect();
  const tipW = _tip.offsetWidth;
  const tipH = _tip.offsetHeight;
  let left = rect.right + 8;
  if (left + tipW > window.innerWidth - 8) left = rect.left - tipW - 8;
  const top = rect.top + rect.height / 2 - tipH / 2;
  _tip.style.left = left + 'px';
  _tip.style.top  = Math.max(8, top) + 'px';
}

function _hideTip() { _tip.classList.add('hidden'); }

// ── RENDER: ROUND TABS ───────────────────────────
export function renderRoundTabs() {
  const el = $('round-tabs');
  el.innerHTML = '';
  S.rounds.forEach(r => {
    const btn = document.createElement('button');
    btn.className = 'rtab' +
      (r.id === S.viewRound ? ' on' : '') +
      (r.status === 'IN_PROGRESS' ? ' live' : '');
    btn.textContent = r.round_number;
    btn.title = `${r.phase_name} — Round ${r.round_number} (${r.status})`;
    btn.onclick = () => { S.viewRound = r.id; renderRoundTabs(); renderStandings(); };
    el.appendChild(btn);
  });
}

// ── RENDER: STANDINGS ────────────────────────────
export function renderStandings() {
  const round = S.rounds.find(r => r.id === S.viewRound);
  const canProject = round?.status === 'IN_PROGRESS'
    && round?.standings_status !== 'GENERATED'
    && round?.pairings_status === 'GENERATED';

  const rows = canProject ? projectRound(S.viewRound, {}) : (S.standings[S.viewRound] || []).slice();
  rows.sort((a, b) => canProject ? a.projRank - b.projRank : a.rank - b.rank);

  const liveNote = $('s-live-note');
  if (liveNote) liveNote.style.display = canProject ? '' : 'none';

  if (rows.length === 0) {
    $('s-empty').textContent = 'No standings for this round yet';
    $('s-empty').style.display = '';
    $('s-table').style.display = 'none';
    return;
  }

  const filtered = _query ? rows.filter(_matchesQuery) : rows;

  if (filtered.length === 0) {
    $('s-empty').textContent = `No players match "${_query}"`;
    $('s-empty').style.display = '';
    $('s-table').style.display = 'none';
    return;
  }

  $('s-empty').style.display = 'none';
  $('s-table').style.display = '';

  const cut = getTopCut();
  const followed = new Set(getFollowed(S.event?.id));
  let html = '';

  for (const p of filtered) {
    const ues    = p.user_event_status;
    const handle = ues.best_identifier || p.player.best_identifier;
    const active = ues.registration_status === 'COMPLETE';
    const sel    = p.id === S.activeId;

    const rank = canProject ? p.projRank : p.rank;
    const pts  = canProject ? p.projPts  : p.points;
    const omw  = canProject ? p.omw : p.opponent_match_win_percentage;
    const gw   = canProject ? p.gw  : p.game_win_percentage;
    const ogw  = canProject ? p.ogw : p.opponent_game_win_percentage;
    const inCut   = cut != null && rank <= cut;
    const rankStr = canProject && p.unknown ? `~${rank}?` : `${rank}`;
    const isFollowed = followed.has(p.id);

    html += `
      <tr class="p-row${inCut ? ' in-cut' : ''}${sel ? ' active' : ''}" data-id="${p.id}"
          data-omw="${omw ?? ''}" data-gw="${gw ?? ''}" data-ogw="${ogw ?? ''}">
        <td class="star-cell${isFollowed ? ' followed' : ''}" data-star title="${isFollowed ? 'Unfollow' : 'Follow'}">${isFollowed ? '★' : '☆'}</td>
        <td class="rank-num">${rankStr}</td>
        <td><span class="handle">${handle}</span><span class="real-name">${p.player.best_identifier}</span></td>
        <td class="rec-cell">${p.record}</td>
        <td class="pts-cell">${pts}</td>
        <td class="omw-cell">${fmtOmw(omw)}</td>
        <td class="tb-cell"><span class="sdot ${active ? 'ok' : 'out'}"></span></td>
      </tr>`;

    if (cut != null && rank === cut) {
      html += `<tr class="cut-line"><td colspan="7"><div class="cut-line-inner">Top ${cut}</div></td></tr>`;
    }
  }

  $('s-body').innerHTML = html;
  $('s-body').querySelectorAll('.p-row').forEach(tr => {
    tr.onclick = () => {
      document.dispatchEvent(new CustomEvent('pm:select-player', { detail: { pid: parseInt(tr.dataset.id) }, bubbles: true }));
    };
    tr.addEventListener('mouseenter', () => {
      const omw = tr.dataset.omw !== '' ? parseFloat(tr.dataset.omw) : null;
      const gw  = tr.dataset.gw  !== '' ? parseFloat(tr.dataset.gw)  : null;
      const ogw = tr.dataset.ogw !== '' ? parseFloat(tr.dataset.ogw) : null;
      _showTip(tr, omw, gw, ogw);
    });
    tr.addEventListener('mouseleave', _hideTip);
    tr.querySelector('[data-star]').addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = parseInt(tr.dataset.id);
      const on  = toggleFollowed(S.event.id, pid);
      e.currentTarget.textContent = on ? '★' : '☆';
      e.currentTarget.title = on ? 'Unfollow' : 'Follow';
      e.currentTarget.classList.toggle('followed', on);
      if (!S.activeId) renderOverview();
    });
  });
}
