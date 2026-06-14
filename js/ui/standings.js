import S from '../state.js';
import { $, fmtOmw } from '../utils.js';
import { getTopCut } from '../services/storage.js';

export { getTopCut };

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
  const rows = (S.standings[S.viewRound] || []).slice().sort((a, b) => a.rank - b.rank);

  if (rows.length === 0) {
    $('s-empty').textContent = 'No standings for this round yet';
    $('s-empty').style.display = '';
    $('s-table').style.display = 'none';
    return;
  }

  $('s-empty').style.display = 'none';
  $('s-table').style.display = '';

  const cut = getTopCut();
  let html = '';

  for (const p of rows) {
    const ues    = p.user_event_status;
    const handle = ues.best_identifier || p.player.best_identifier;
    const active = ues.registration_status === 'COMPLETE';
    const sel    = p.id === S.activeId;
    const inCut  = cut != null && p.rank <= cut;

    const omw = p.opponent_match_win_percentage;
    const gw  = p.game_win_percentage;
    const ogw = p.opponent_game_win_percentage;

    html += `
      <tr class="p-row${inCut ? ' in-cut' : ''}${sel ? ' active' : ''}" data-id="${p.id}"
          data-omw="${omw ?? ''}" data-gw="${gw ?? ''}" data-ogw="${ogw ?? ''}">
        <td class="rank-num">${p.rank}</td>
        <td><span class="handle">${handle}</span><span class="real-name">${p.player.best_identifier}</span></td>
        <td class="rec-cell">${p.record}</td>
        <td class="pts-cell">${p.points}</td>
        <td class="omw-cell">${fmtOmw(omw)}</td>
        <td class="tb-cell"><span class="sdot ${active ? 'ok' : 'out'}"></span></td>
      </tr>`;

    if (cut != null && p.rank === cut) {
      html += `<tr class="cut-line"><td colspan="6"><div class="cut-line-inner">Top ${cut}</div></td></tr>`;
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
  });
}
