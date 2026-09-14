import S from '../state.js';
import { $, fmtOmw } from '../utils.js';
import { getTopCut } from '../services/storage.js';
import { projectRound } from '../engine/adapter.js';

let _viewRound = null;

export function renderAllRounds() {
  const el = $('all-rounds');
  if (!el) return;

  if (!S.rounds.length) {
    el.innerHTML = `<div class="s-empty">Load an event to see standings</div>`;
    return;
  }

  // Default to latest round with standings, or last round
  if (!_viewRound || !S.rounds.find(r => r.id === _viewRound)) {
    const withStandings = S.rounds.filter(r => r.standings_status === 'GENERATED');
    _viewRound = withStandings.at(-1)?.id ?? S.rounds.at(-1)?.id;
  }

  _render(el);
}

function _render(el) {
  const cut = getTopCut();

  // Round tabs
  const tabsHtml = S.rounds.map(r => {
    const on   = r.id === _viewRound ? ' on' : '';
    const live = r.status === 'IN_PROGRESS' ? ' live' : '';
    return `<button class="rtab${on}${live}" data-rid="${r.id}" title="${r.phase_name} — Round ${r.round_number} (${r.status})">${r.round_number}</button>`;
  }).join('');

  const round     = S.rounds.find(r => r.id === _viewRound);
  const isLive    = round?.status === 'IN_PROGRESS' && round?.standings_status !== 'GENERATED';
  const hasData   = S.standings[_viewRound]?.length > 0;

  let bodyHtml;
  if (isLive && round?.pairings_status === 'GENERATED') {
    bodyHtml = _renderProjected(_viewRound, cut);
  } else if (hasData) {
    bodyHtml = _renderActual(_viewRound, cut);
  } else {
    bodyHtml = `<div class="s-empty">No standings for this round yet</div>`;
  }

  el.innerHTML = `
    <div class="ar-panel-bar">
      <span class="panel-label">Standings</span>
      <div class="round-tabs">${tabsHtml}</div>
    </div>
    ${isLive ? `<div class="ar-live-note">Projected from locked results · tiebreakers recomputed · pending matches shown as <em>~rank?</em></div>` : ''}
    <div class="ar-scroll">${bodyHtml}</div>`;

  el.querySelectorAll('.rtab[data-rid]').forEach(btn => {
    btn.addEventListener('click', () => {
      _viewRound = parseInt(btn.dataset.rid);
      _render(el);
    });
  });

  el.querySelectorAll('.p-row').forEach(tr => {
    tr.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('pm:select-player', {
        detail: { pid: parseInt(tr.dataset.id) },
        bubbles: true,
      }));
    });
  });
}

function _renderActual(roundId, cut) {
  const rows = (S.standings[roundId] || []).slice().sort((a, b) => a.rank - b.rank);
  let html = `
    <table class="s-table">
      <thead><tr>
        <th style="width:28px">#</th>
        <th>Player</th>
        <th>Rec</th>
        <th>Pts</th>
        <th>OMW%</th>
        <th>GW%</th>
        <th>OGW%</th>
        <th></th>
      </tr></thead>
      <tbody>`;

  for (const p of rows) {
    const handle = p.user_event_status?.best_identifier || p.player?.best_identifier || '?';
    const active = p.user_event_status?.registration_status === 'COMPLETE';
    const sel    = p.id === S.activeId;
    const inCut  = cut != null && p.rank <= cut;

    html += `<tr class="p-row${inCut ? ' in-cut' : ''}${sel ? ' active' : ''}" data-id="${p.id}">
      <td class="rank-num">${p.rank}</td>
      <td><span class="handle">${handle}</span><span class="real-name">${p.player?.best_identifier ?? ''}</span></td>
      <td class="rec-cell">${p.record}</td>
      <td class="pts-cell">${p.points}</td>
      <td class="omw-cell">${fmtOmw(p.opponent_match_win_percentage)}</td>
      <td class="omw-cell">${fmtOmw(p.game_win_percentage)}</td>
      <td class="omw-cell">${fmtOmw(p.opponent_game_win_percentage)}</td>
      <td class="tb-cell"><span class="sdot ${active ? 'ok' : 'out'}"></span></td>
    </tr>`;

    if (cut != null && p.rank === cut) {
      html += `<tr class="cut-line"><td colspan="8"><div class="cut-line-inner">Top ${cut}</div></td></tr>`;
    }
  }

  html += `</tbody></table>`;
  return html;
}

function _renderProjected(roundId, cut) {
  const projected = _computeProjectedFromLocked(roundId);
  let html = `
    <table class="s-table">
      <thead><tr>
        <th style="width:28px">#</th>
        <th>Player</th>
        <th>Pts</th>
        <th>Δ rank</th>
        <th></th>
      </tr></thead>
      <tbody>`;

  let cutInserted = false;
  for (const p of projected) {
    if (!cutInserted && cut != null && p.projRank > cut) {
      html += `<tr class="cut-line"><td colspan="5"><div class="cut-line-inner">Top ${cut}</div></td></tr>`;
      cutInserted = true;
    }

    const handle  = p.user_event_status?.best_identifier || p.player?.best_identifier || '?';
    const sel     = p.id === S.activeId;
    const inCut   = cut != null && p.projRank <= cut;
    const ptsStr  = p.points == null || p.points === p.projPts ? `${p.projPts}` : `${p.points}→${p.projPts}`;

    let deltaCls = '', deltaStr = '—';
    if (p.unknown) {
      deltaStr = '?';
    } else if (p.rank != null) {
      const d = p.rank - p.projRank;
      if (d > 0)      { deltaCls = 'ar-delta-up';   deltaStr = `↑${d}`; }
      else if (d < 0) { deltaCls = 'ar-delta-down'; deltaStr = `↓${Math.abs(d)}`; }
    }

    const rankStr = p.unknown ? `~${p.projRank}?` : `${p.projRank}`;

    html += `<tr class="p-row${inCut ? ' in-cut' : ''}${sel ? ' active' : ''}" data-id="${p.id}">
      <td class="rank-num">${rankStr}</td>
      <td><span class="handle">${handle}</span></td>
      <td class="pts-cell">${ptsStr}</td>
      <td class="rec-cell ${deltaCls}">${deltaStr}</td>
      <td></td>
    </tr>`;
  }

  html += `</tbody></table>`;
  return html;
}

// Exact projection from locked API results (tiebreakers recomputed, see js/engine).
function _computeProjectedFromLocked(roundId) {
  return projectRound(roundId, {});
}
