import S from '../state.js';
import { $ } from '../utils.js';
import { projectRank } from '../tournament.js';
import { getTopCut } from '../services/storage.js';

// ── RENDER: SIM ROUND TABS ───────────────────────
export function renderSimRoundTabs() {
  const el = $('sim-round-tabs');
  if (!el) return;
  el.innerHTML = '';

  // Only show rounds with standings data
  const eligible = S.rounds.filter(r => r.standings_status === 'GENERATED');
  if (eligible.length <= 1) { el.style.display = 'none'; return; }
  el.style.display = '';

  eligible.forEach(r => {
    const isSwiss = r.phase_type === 'SWISS';
    const btn = document.createElement('button');
    btn.className = 'rtab' + (r.id === S.simRound ? ' on' : '') + (!isSwiss ? ' live' : '');
    btn.textContent = r.round_number;
    btn.title = `${r.phase_name} — Round ${r.round_number}${!isSwiss ? ' (elimination)' : ''}`;
    btn.onclick = () => {
      S.simRound = r.id;
      renderSimRoundTabs();
      if (S.activeId) renderSimulation(S.activeId);
    };
    el.appendChild(btn);
  });
}

// ── RENDER: SIMULATION ───────────────────────────
export function renderSimulation(pid) {
  if (!S.simRound) return;

  const round = S.rounds.find(r => r.id === S.simRound);
  if (!round) return;

  const standings = S.standings[S.simRound] || [];
  const me = standings.find(p => p.id === pid);
  if (!me) return;

  const cut        = getTopCut();
  const currentPts = me.points;
  const myOMW      = me.opponent_match_win_percentage ?? 0;
  const isElim     = round.phase_type !== 'SWISS';

  // Figure out label: what round are we projecting INTO?
  const allWithData = S.rounds.filter(r => r.standings_status === 'GENERATED');
  const nextIdx     = allWithData.findIndex(r => r.id === S.simRound) + 1;
  const nextRound   = allWithData[nextIdx];
  const intoLabel   = nextRound ? `R${nextRound.round_number}` : 'Top cut';
  $('sim-title').textContent = `R${round.round_number} → ${intoLabel} Simulation`;

  if (isElim) {
    $('sim-rows').innerHTML = `<div style="color:var(--t3);font-size:.78rem;padding:.5rem 0">
      Simulation is most meaningful for Swiss rounds.<br>
      Select a Swiss round above to project cut scenarios.
    </div>`;
    $('sim-note').textContent = '';
    return;
  }

  // Remaining rounds: derived from position within the Swiss array, not round.round_number,
  // so it works regardless of how the API numbers rounds across phases.
  const swissRounds   = S.rounds.filter(r => r.phase_type === 'SWISS');
  const totalSwiss    = swissRounds.length;
  const swissPos      = swissRounds.findIndex(r => r.id === round.id); // 0-based index in Swiss
  // myRemaining  = Swiss rounds left to play AFTER the simulated next one
  // othersRemaining = Swiss rounds others still play (includes the simulated round itself)
  const myRemaining     = Math.max(0, totalSwiss - swissPos - 2);
  const othersRemaining = Math.max(0, totalSwiss - swissPos - 1);

  // If othersRemaining === 0, Swiss is already complete — there is no next round to simulate.
  // Running win/draw/loss on final standings adds phantom pts and produces nonsense verdicts.
  if (othersRemaining === 0) {
    const inCut       = cut && me.rank <= cut;
    const cutLabel    = cut ? ` · Top ${cut}` : '';
    const statusColor = cut ? (inCut ? 'var(--green)' : 'var(--red)') : 'var(--t3)';
    const statusText  = cut ? (inCut ? '✓ Made top cut' : '✗ Missed top cut') : '—';
    $('sim-rows').innerHTML = `
      <div style="padding:.6rem .5rem;display:flex;flex-direction:column;gap:.5rem">
        <div style="font-size:.72rem;color:var(--t3)">
          Swiss complete — no more rounds to project.
        </div>
        <div style="font-size:.9rem;font-weight:700">
          Final Swiss rank: <span style="color:var(--blue)">#${me.rank}</span>
          &nbsp;·&nbsp;<span style="color:${statusColor}">${statusText}</span>
        </div>
      </div>`;
    $('sim-note').textContent =
      `R${round.round_number} standings · ${standings.length} players${cutLabel} · Tiebreakers determined final rank`;
    return;
  }

  // On the final Swiss round there are no more rounds after — mayAbove (which uses current pts)
  // does not model others gaining pts in this round, so SAFE is unreliable. Only LOCKED is real.
  const isFinalSwiss = myRemaining === 0 && !isElim;

  // DRAW reduces my OMW%: draw opponent also draws, dragging their MWP down.
  // Mechanic drop: currentOMW * R*(R+2)/(R+1)²
  // Extra pessimism: in Swiss, late-round draw partners are high-win-rate opponents
  // whose MWP drop hits your OMW% harder than an average opponent would.
  const R         = round.round_number;
  const myOMW_draw = myOMW * R * (R + 2) / ((R + 1) * (R + 1)) * 0.985;

  // The next Swiss round number — used as the row label so "LOSE R4" is unambiguous.
  const nextSwissRound = swissRounds[swissPos + 1];
  const simRoundNum    = nextSwissRound ? nextSwissRound.round_number : round.round_number + 1;

  const scenarios = [
    { label: 'WIN',  delta: 3, cls: 'win',  scenarioOMW: myOMW      },
    { label: 'DRAW', delta: 1, cls: 'draw', scenarioOMW: myOMW_draw },
    { label: 'LOSE', delta: 0, cls: 'loss', scenarioOMW: myOMW      },
  ];

  $('sim-rows').innerHTML = scenarios.map(({ label, delta, cls, scenarioOMW }) => {
    const projPts                        = currentPts + delta;
    const { best, worst, absoluteWorst } = projectRank(pid, projPts, scenarioOMW, standings, myRemaining, othersRemaining);

    let verdictHtml = '';
    if (cut) {
      if (best > cut)                         verdictHtml = `<span class="sim-verdict out">✗ OUT</span>`;
      else if (absoluteWorst <= cut)          verdictHtml = `<span class="sim-verdict lock">✦ LOCKED</span>`;
      else if (worst <= cut && !isFinalSwiss) verdictHtml = `<span class="sim-verdict safe">✓ SAFE</span>`;
      else                                    verdictHtml = `<span class="sim-verdict risk">⚠ RISKY</span>`;
    } else {
      verdictHtml = `<span class="sim-verdict nocut">—</span>`;
    }

    const rankText = best === absoluteWorst ? `#${best}` : `#${best}–${absoluteWorst}`;

    return `
      <div class="sim-row ${cls}">
        <div class="sim-lbl">${label}<span class="sim-rnum">R${simRoundNum}</span></div>
        <div class="sim-delta">+${delta}</div>
        <div class="sim-pts">${projPts}</div>
        <div class="sim-rank">${rankText}</div>
        <div>${verdictHtml}</div>
      </div>`;
  }).join('');

  const cutLine   = cut ? ` · Top ${cut} cut` : ' · No cut configured';
  const roundsCtx = isFinalSwiss
    ? ' · Final round — only LOCKED is reliable (others also play this round)'
    : myRemaining > 0
      ? ` · ${myRemaining} round${myRemaining > 1 ? 's' : ''} remaining after R${simRoundNum}`
      : '';
  $('sim-note').textContent =
    `R${round.round_number} standings · ${standings.length} players${cutLine}${roundsCtx} · DRAW lowers OMW% estimate`;
}
