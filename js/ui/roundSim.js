import S from '../state.js';
import { $ } from '../utils.js';
import { getTopCut } from '../services/storage.js';

let _picks    = {};        // { [matchId]: 'W1' | 'D' | 'W2' | null }
let _locked   = new Set(); // matchIds with confirmed server results
let _simRound = null;

export function resetRoundSim() {
  _picks    = {};
  _locked   = new Set();
  _simRound = null;
}

// ── ENTRY POINT ──────────────────────────────────
export function renderRoundSim() {
  const leftEl  = $('rsim-left');
  const rightEl = $('rsim-right');
  if (!leftEl || !rightEl) return;

  const eligible = S.rounds.filter(r => r.pairings_status === 'GENERATED');
  if (!eligible.length) {
    leftEl.innerHTML  = `<div class="s-empty">No pairings available yet</div>`;
    rightEl.innerHTML = '';
    return;
  }

  const live      = eligible.find(r => r.status === 'IN_PROGRESS');
  const prevRound = _simRound;

  if (!_simRound || !eligible.find(r => r.id === _simRound)) {
    _simRound = (live ?? eligible.at(-1)).id;
  }

  if (_simRound !== prevRound) {
    _locked = new Set(); // clear locks when switching rounds
    _autoPickFromResults(_simRound);
  }

  _renderPairings(_simRound, leftEl);
  _renderProjected(_simRound, rightEl);
}

// ── SEED PICKS FROM API — server results are locked ──
function _autoPickFromResults(roundId) {
  const matches = S.matches[roundId] || [];
  for (const match of matches) {
    const isBye  = match.match_is_bye;
    const isDraw = match.match_is_intentional_draw || match.match_is_unintentional_draw;
    const hasWin = match.winning_player != null;

    if (isBye || isDraw || hasWin) {
      // Authoritative result — always apply and lock
      if (isBye)       _picks[match.id] = 'W1';
      else if (isDraw) _picks[match.id] = 'D';
      else             _picks[match.id] = (match.players?.[0] === match.winning_player) ? 'W1' : 'W2';
      _locked.add(match.id);
    } else {
      // Pending — preserve any existing user pick
      if (_picks[match.id] === undefined) _picks[match.id] = null;
    }
  }
}

// ── BASE STANDINGS (nearest completed round ≤ roundId) ──
function _findBaseStandings(roundId) {
  const idx = S.rounds.findIndex(r => r.id === roundId);
  for (let i = idx; i >= 0; i--) {
    if (S.rounds[i].standings_status === 'GENERATED') {
      return S.standings[S.rounds[i].id] || [];
    }
  }
  return [];
}

// ── COMPUTE PROJECTED STANDINGS ───────────────────
function _computeProjected(roundId) {
  const base    = _findBaseStandings(roundId);
  const matches = S.matches[roundId] || [];

  const ptMap  = {};
  const omwMap = {};
  for (const p of base) {
    ptMap[p.id]  = p.points;
    omwMap[p.id] = p.opponent_match_win_percentage ?? 0;
  }

  const unpicked = new Set();
  for (const match of matches) {
    const [p1, p2] = match.players || [];
    const pick = _picks[match.id];
    if (!pick) {
      if (p1 != null) unpicked.add(p1);
      if (p2 != null) unpicked.add(p2);
    } else if (pick === 'W1') {
      if (p1 in ptMap) ptMap[p1] += 3;
    } else if (pick === 'W2') {
      if (p2 in ptMap) ptMap[p2] += 3;
    } else if (pick === 'D') {
      if (p1 in ptMap) ptMap[p1] += 1;
      if (p2 in ptMap) ptMap[p2] += 1;
    }
  }

  const sorted = base
    .map(p => ({
      ...p,
      projPts: ptMap[p.id] ?? p.points,
      unknown: unpicked.has(p.id),
    }))
    .sort((a, b) =>
      b.projPts - a.projPts ||
      (omwMap[b.id] ?? 0) - (omwMap[a.id] ?? 0)
    );

  return sorted.map((p, i) => ({ ...p, projRank: i + 1 }));
}

// ── RENDER: PAIRINGS LEFT PANE ───────────────────
function _renderPairings(roundId, leftEl) {
  const eligible = S.rounds.filter(r => r.pairings_status === 'GENERATED');
  const matches  = S.matches[roundId] || [];
  const base     = _findBaseStandings(roundId);
  const stMap    = Object.fromEntries(base.map(p => [p.id, p]));

  const resolveName = (pid, rels) => {
    const rel = (rels || []).find(r => r.player.id === pid);
    if (rel) return rel.user_event_status?.best_identifier || rel.player?.best_identifier || '?';
    const st = stMap[pid];
    return st ? (st.user_event_status?.best_identifier || st.player?.best_identifier || '?') : '?';
  };

  const resolveMeta = pid => {
    const st = stMap[pid];
    return st ? `#${st.rank} · ${st.points}pts` : '';
  };

  const tabsHtml = eligible.map(r => `
    <button class="rtab${r.id === roundId ? ' on' : ''}${r.status === 'IN_PROGRESS' ? ' live' : ''}"
            data-rid="${r.id}">${r.round_number}</button>`
  ).join('');

  leftEl.innerHTML = `
    <div class="rsim-panel-bar">
      <span class="rsim-label">Pairings</span>
      <div class="round-tabs">${tabsHtml}</div>
    </div>
    <div id="pairing-list"></div>`;

  leftEl.querySelectorAll('.rtab[data-rid]').forEach(btn => {
    btn.addEventListener('click', () => {
      const newId = parseInt(btn.dataset.rid);
      if (newId !== _simRound) {
        _simRound = newId;
        _locked   = new Set();
        _autoPickFromResults(_simRound);
      }
      _renderPairings(_simRound, leftEl);
      _renderProjected(_simRound, $('rsim-right'));
    });
  });

  const listEl = leftEl.querySelector('#pairing-list');
  if (!matches.length) {
    listEl.innerHTML = `<div class="s-empty">No pairings loaded</div>`;
    return;
  }

  listEl.innerHTML = matches.map(match => {
    const [p1id, p2id] = match.players || [];
    const isBye  = match.match_is_bye;
    const locked = _locked.has(match.id);
    const pick   = _picks[match.id];
    const pickCls = pick === 'W1' ? 'pick-w1' : pick === 'W2' ? 'pick-w2' : pick === 'D' ? 'pick-d' : '';
    const rels   = match.player_match_relationships || [];

    const p1name = p1id != null ? resolveName(p1id, rels) : '?';
    const p2name = isBye ? '—' : (p2id != null ? resolveName(p2id, rels) : '?');
    const p1meta = p1id != null ? resolveMeta(p1id) : '';
    const p2meta = (!isBye && p2id != null) ? resolveMeta(p2id) : '';

    // ── LOCKED card (server result) ──
    if (locked) {
      let b1html, centerHtml, b2html;
      if (isBye) {
        b1html     = `<div class="lock-badge bye" style="grid-column:2/5">BYE</div>`;
        centerHtml = '';
        b2html     = '';
      } else if (pick === 'D') {
        b1html     = `<div class="lock-badge draw">DRAW</div>`;
        centerHtml = `<div class="lock-center">🔒</div>`;
        b2html     = `<div class="lock-badge draw">DRAW</div>`;
      } else {
        const leftWon  = pick === 'W1';
        b1html     = `<div class="lock-badge ${leftWon  ? 'won' : 'lost'}">${leftWon  ? 'WON' : 'LOST'}</div>`;
        centerHtml = `<div class="lock-center">🔒</div>`;
        b2html     = `<div class="lock-badge ${!leftWon ? 'won' : 'lost'}">${!leftWon ? 'WON' : 'LOST'}</div>`;
      }

      return `
        <div class="pairing-card locked ${pickCls}${isBye ? ' bye' : ''}" data-mid="${match.id}">
          <div class="pairing-player">
            <span class="pairing-handle">${p1name}</span>
            <span class="pairing-meta">${p1meta}</span>
          </div>
          ${b1html}
          ${centerHtml}
          ${b2html}
          <div class="pairing-player right">
            <span class="pairing-handle">${p2name}</span>
            <span class="pairing-meta">${p2meta}</span>
          </div>
        </div>`;
    }

    // ── PENDING card (user picks) ──
    return `
      <div class="pairing-card ${pickCls}" data-mid="${match.id}">
        <div class="pairing-player">
          <span class="pairing-handle">${p1name}</span>
          <span class="pairing-meta">${p1meta}</span>
        </div>
        <button class="win-btn${pick === 'W1' ? ' active' : ''}" data-pick="W1">WIN</button>
        <button class="draw-btn${pick === 'D'  ? ' active' : ''}" data-pick="D">DRAW</button>
        <button class="win-btn${pick === 'W2' ? ' active' : ''}" data-pick="W2">WIN</button>
        <div class="pairing-player right">
          <span class="pairing-handle">${p2name}</span>
          <span class="pairing-meta">${p2meta}</span>
        </div>
      </div>`;
  }).join('');

  // Wire pick buttons on pending cards only
  listEl.querySelectorAll('.pairing-card:not(.locked)').forEach(card => {
    const mid = parseInt(card.dataset.mid);
    card.querySelectorAll('.win-btn, .draw-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.pick;
        _picks[mid] = (_picks[mid] === p) ? null : p;
        _renderPairings(_simRound, leftEl);
        _renderProjected(_simRound, $('rsim-right'));
      });
    });
  });
}

// ── RENDER: PROJECTED STANDINGS RIGHT PANE ───────
function _renderProjected(roundId, rightEl) {
  const projected = _computeProjected(roundId);
  const cut       = getTopCut();
  const round     = S.rounds.find(r => r.id === roundId);

  let html = `
    <div class="rsim-panel-bar" style="position:sticky;top:0">
      <span class="rsim-label">Projected Standings</span>
    </div>
    <table class="proj-table">
      <thead>
        <tr>
          <th style="width:28px">#</th>
          <th>Player</th>
          <th>Pts</th>
          <th style="text-align:right">Δ</th>
        </tr>
      </thead>
      <tbody>`;

  let cutInserted = false;
  for (const p of projected) {
    if (!cutInserted && cut != null && p.projRank > cut) {
      html += `<tr class="proj-cut-line"><td colspan="4">
        <div class="cut-line-inner">Top ${cut}</div></td></tr>`;
      cutInserted = true;
    }

    const inCut    = cut != null && p.projRank <= cut;
    const wasInCut = cut != null && p.rank     <= cut;
    const promoted  = inCut  && !wasInCut;
    const relegated = wasInCut && !inCut;

    let deltaCls = 'same', deltaStr = '—';
    if (p.unknown) {
      deltaStr = '?';
    } else {
      const d = p.rank - p.projRank;
      if (d > 0)      { deltaCls = 'up';   deltaStr = `↑${d}`; }
      else if (d < 0) { deltaCls = 'down'; deltaStr = `↓${Math.abs(d)}`; }
    }

    const handle = p.user_event_status?.best_identifier || p.player?.best_identifier || '?';
    const ptsStr = p.points === p.projPts
      ? `${p.projPts}`
      : `${p.points}→${p.projPts}`;

    html += `
      <tr class="proj-row${promoted ? ' promoted' : ''}${relegated ? ' relegated' : ''}${inCut ? ' in-cut' : ''}">
        <td class="proj-rank">${p.projRank}</td>
        <td><span class="handle">${handle}</span></td>
        <td class="proj-pts">${ptsStr}</td>
        <td class="proj-delta ${deltaCls}">${deltaStr}</td>
      </tr>`;
  }

  html += `</tbody></table>`;

  if (round) {
    const pendingCount = (S.matches[roundId] || []).filter(m => !_locked.has(m.id) && _picks[m.id] === null).length;
    const note = pendingCount > 0
      ? `${pendingCount} match${pendingCount > 1 ? 'es' : ''} unpicked · results estimated`
      : `All matches picked · OMW tiebreaker estimated`;
    html += `<div class="s-empty" style="font-size:.6rem;padding:.65rem 1rem">${note}</div>`;
  }

  rightEl.innerHTML = html;
}
