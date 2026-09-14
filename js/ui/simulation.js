import S from '../state.js';
import { $ } from '../utils.js';
import { getTopCut } from '../services/storage.js';
import { stateAfterRound, futureSwissRounds, activeIdsAfter, swissRounds } from '../engine/adapter.js';
import { pactWindow, pactBound } from '../engine/montecarlo.js';
import { runSimulation } from '../services/simWorker.js';
import { verdictHtml, pctHtml } from './verdict.js';

// Results cache: the Monte Carlo is deterministic (seeded), so a re-render
// with the same inputs can reuse the previous numbers.
const _cache = new Map();

function _cacheKey(pid, roundId, cut) {
  let confirmed = 0;
  for (const r of swissRounds()) for (const m of S.matches[r.id] || []) if (m.winning_player != null || m.match_is_bye || m.match_is_intentional_draw || m.match_is_unintentional_draw) confirmed++;
  return `${S.event?.id}|${roundId}|${pid}|${cut}|${confirmed}`;
}

function _samplesFor(players) {
  return Math.max(600, Math.min(2000, Math.round(60000 / Math.max(1, players))));
}

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

  const cut    = getTopCut();
  const isElim = round.phase_type !== 'SWISS';

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

  const swiss    = swissRounds();
  const swissPos = swiss.findIndex(r => r.id === round.id);
  const future   = futureSwissRounds(round.id);

  // Swiss already complete — nothing left to simulate.
  if (future.length === 0) {
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

  const nextSwiss    = swiss[swissPos + 1];
  const simRoundNum  = nextSwiss ? nextSwiss.round_number : round.round_number + 1;
  const nextKnown    = !!future[0];
  const myRemaining  = future.length - 1;

  // pactBound is cheap (no sampling) — computed up front, not deferred.
  const state       = stateAfterRound(round.id);
  const activeIds   = activeIdsAfter(round.id);
  const inPactWindow = future.length <= pactWindow(swiss.length);
  const pact = inPactWindow ? pactBound({ state, me: pid, activeIds, futureRounds: future, cut }) : null;

  const pactBanner = pact
    ? `<div class="sim-pact${pact.pactLocked ? ' locked' : ''}">
        ${pact.pactLocked
          ? `✦ Drawing out from here is enough — normal Swiss pairing keeps you at #${pact.rank} worst case.`
          : `Drawing out from here is not provably enough yet (worst case #${pact.rank} under normal Swiss pairing).`}
      </div>`
    : '';

  // How much of the "future" below has actually already happened? Two
  // independent signals:
  //  - forcedOthersDecided: every OTHER match in R${simRoundNum} itself (the
  //    round being forced to W/D/L) already has a real result — only YOUR
  //    pick there is open, so the percentages below are exact against the
  //    real final field, not a forecast. This is why they land on flat
  //    0%/100% instead of something in between: there's no real randomness
  //    left to sample.
  //  - hindsightRounds: any round AFTER that one where your OWN result is
  //    already recorded too (reviewing an old round of an event that's
  //    since moved on) — those get replayed with reality instead of
  //    sampled. A later round with published pairings but no result yet is
  //    NOT hindsight — it's still genuinely simulated.
  const pairKey = (a, b) => `${a}:${b}`;
  const forced = future[0];
  const forcedOthersDecided = !!forced && forced.pairs.length > 0 &&
    forced.pairs.filter(([a, b]) => a !== pid && b !== pid).every(([a, b]) => forced.locked[pairKey(a, b)]);

  const hindsightRounds = [];
  for (let i = 1; i < future.length; i++) {
    const known = future[i];
    const myResultLocked = known && Object.keys(known.locked).some(key => {
      const [a, b] = key.split(':').map(Number);
      return a === pid || b === pid;
    });
    if (myResultLocked) hindsightRounds.push(swiss[swissPos + 1 + i].round_number);
  }

  let hindsightBanner = '';
  if (hindsightRounds.length) {
    hindsightBanner = `<div class="sim-hindsight">
        ⏱ R${hindsightRounds.join(', R')} ${hindsightRounds.length > 1 ? 'have' : 'has'} already been played.
        These numbers reuse your <strong>real</strong> result${hindsightRounds.length > 1 ? 's' : ''} in
        ${hindsightRounds.length > 1 ? 'those rounds' : 'that round'}${forcedOthersDecided ? `, and everyone else's R${simRoundNum} result is real too` : ''} —
        only R${simRoundNum} below is the actual hypothetical being tested. This isn't a live forecast of what could
        still happen.
      </div>`;
  } else if (forcedOthersDecided) {
    hindsightBanner = `<div class="sim-hindsight">
        ⏱ R${simRoundNum} has already been played for everyone else. Only your own pick here is hypothetical,
        so these percentages are exact against the real final field — not a forecast of what could still happen.
      </div>`;
  }

  // Placeholder rows while the Monte Carlo runs (it is synchronous; let the UI paint first).
  const scenarios = [
    { key: 'W', label: 'WIN',  delta: 3, cls: 'win'  },
    { key: 'D', label: 'DRAW', delta: 1, cls: 'draw' },
    { key: 'L', label: 'LOSE', delta: 0, cls: 'loss' },
  ];
  const spinner = `<span class="sim-spinner"></span>`;
  const rowHtml = (sc, res) => `
    <div class="sim-row ${sc.cls}">
      <div class="sim-lbl">${sc.label}<span class="sim-rnum">R${simRoundNum}</span></div>
      <div class="sim-delta">+${sc.delta}</div>
      <div class="sim-pts">${me.points + sc.delta}</div>
      <div class="sim-prob">${res ? pctHtml(res, cut) : spinner}</div>
      <div class="sim-rank">${res ? (res.p5 === res.p95 ? `#${res.p5}` : `#${res.p5}–${res.p95}`) : ''}</div>
      <div>${res ? verdictHtml(res, cut) : ''}</div>
    </div>`;

  $('sim-rows').innerHTML = hindsightBanner + pactBanner + scenarios.map(sc => rowHtml(sc, null)).join('');

  const cutLine  = cut ? ` · Top ${cut} cut` : ' · No cut configured';
  const pairLine = nextKnown ? ` · R${simRoundNum} pairings known` : ` · R${simRoundNum} pairings simulated`;
  const unknownAfter = myRemaining - hindsightRounds.length;
  const roundsCtx = myRemaining > 0
    ? (hindsightRounds.length
        ? ` · ${myRemaining} round${myRemaining > 1 ? 's' : ''} after R${simRoundNum}: R${hindsightRounds.join(',')} already played, ${unknownAfter} simulated`
        : ` · ${myRemaining} round${myRemaining > 1 ? 's' : ''} after R${simRoundNum} simulated`)
    : ` · final Swiss round`;
  $('sim-note').textContent = `R${round.round_number} standings · ${standings.length} players${cutLine}${pairLine}${roundsCtx} · computing…`;

  const stillCurrent = () => S.activeId === pid && S.simRound === round.id && getTopCut() === cut;

  const renderResults = results => {
    $('sim-rows').innerHTML = hindsightBanner + pactBanner + scenarios.map(sc => rowHtml(sc, results[sc.key])).join('');
    const n = results.W.samples;
    const cutPts = cut && results.D.cutPtsMedian != null ? ` · typical cut line ${results.D.cutPtsMedian} pts` : '';
    const pactCaveat = pact ? ` · DRAW's % doesn't yet model everyone else pacting too — the pact banner above is the exact answer` : '';
    $('sim-note').textContent =
      `R${round.round_number} standings · ${standings.length} players${cutLine}${pairLine}${roundsCtx} · ${n} samples · rank = 5th–95th percentile${cutPts}${pactCaveat}`;
  };

  const key = _cacheKey(pid, round.id, cut);
  const cached = _cache.get(key);
  if (cached) { renderResults(cached); return; }

  const run = () => {
    if (!stillCurrent()) return; // the user moved on while we waited for the paint
    runSimulation({ state, me: pid, activeIds, futureRounds: future, cut, samples: _samplesFor(standings.length) })
      .then(results => {
        _cache.set(key, results);
        if (stillCurrent()) renderResults(results);
      })
      .catch(err => {
        if (stillCurrent()) $('sim-note').textContent = `Simulation failed: ${err.message}`;
      });
  };

  setTimeout(run, 0);
}
