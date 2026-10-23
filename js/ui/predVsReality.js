// ── PREDICTION VS REALITY TAB ────────────────────
// Its own board tab (after Standings): how the cut line projection held up
// in this event, from js/ui/accuracy.js. Locked until Swiss is over — there
// is no reality to compare with before that — with a tooltip saying so.

import S from '../state.js';
import { $ } from '../utils.js';
import { getTopCut } from '../services/storage.js';
import { swissRounds, futureSwissRounds, eventTotals } from '../engine/adapter.js';
import { finishedReplayBases, replayCutLine } from './cutReplay.js';
import { finalSwissRows, buildMoments, compareHtml, wireCompare } from './accuracy.js';
import { switchBoardTab, currentBoardMode } from './boardTabs.js';

export const PVR_LOCKED_TIP = 'Unlocks when the Swiss rounds are over: it compares every projection made during the event with how Swiss actually ended.';

let _token = 0;

// Every Swiss round played and nothing left to pair.
export function swissOver() {
  const swiss = swissRounds();
  const done = swiss.filter(r => r.standings_status === 'GENERATED');
  return done.length > 0 && done.length >= eventTotals().totalRounds && futureSwissRounds(done.at(-1).id).length === 0;
}

const _locked = () => !S.event || !swissOver();

// Lock / unlock the tab for the loaded event; leaves the tab if it's open
// and no longer available (e.g. a different event was loaded).
export function syncPvrTab() {
  const btn = $('btab-pvr');
  if (!btn) return;
  const locked = _locked();
  btn.classList.toggle('locked', locked);
  btn.setAttribute('aria-disabled', locked ? 'true' : 'false');
  if (locked) btn.setAttribute('aria-label', `Prediction vs reality — ${PVR_LOCKED_TIP}`);
  else btn.removeAttribute('aria-label');
  if (locked && currentBoardMode() === 'pvr') switchBoardTab('overview');
}

// ── LOCKED TOOLTIP ───────────────────────────────
// Positioned in JS (shared #tb-tooltip) so it stays on screen wherever the
// tab wraps to. Hover on desktop; a tap shows it for a few seconds.
let _tipTimer = null;

function _showTip(btn) {
  const tip = $('tb-tooltip');
  if (!tip) return;
  tip.textContent = PVR_LOCKED_TIP;
  tip.classList.add('note');
  tip.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  const w = tip.offsetWidth;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
  tip.style.left = `${left}px`;
  tip.style.top = `${r.bottom + 8}px`;
}

function _hideTip() {
  const tip = $('tb-tooltip');
  if (!tip) return;
  tip.classList.add('hidden');
  tip.classList.remove('note');
}

// Click handler for the tab: open it, or explain why it's locked.
export function onPvrTabClick() {
  const btn = $('btab-pvr');
  if (_locked()) {
    _showTip(btn);
    clearTimeout(_tipTimer);
    _tipTimer = setTimeout(_hideTip, 3500);
    return;
  }
  switchBoardTab('pvr');
  renderPredVsReality();
}

export function wirePvrTab() {
  const btn = $('btab-pvr');
  btn.addEventListener('click', onPvrTabClick);
  btn.addEventListener('mouseenter', () => { if (_locked()) _showTip(btn); });
  btn.addEventListener('mouseleave', () => { clearTimeout(_tipTimer); _hideTip(); });
}

// ── RENDER ───────────────────────────────────────
export function renderPredVsReality() {
  const root = $('pvr-root');
  if (!root) return;
  const token = ++_token;

  if (_locked()) {
    root.innerHTML = `<div class="ov-panel"><div class="ov-empty">${PVR_LOCKED_TIP}</div></div>`;
    return;
  }
  const cut = getTopCut();
  if (cut == null) {
    root.innerHTML = `<div class="ov-panel"><div class="ov-empty">Set a top cut to compare the projections with the result.</div></div>`;
    return;
  }

  root.innerHTML = `
    <div class="ov-panel">
      <div class="ov-panel-title">Prediction vs reality — Top ${cut}</div>
      <div id="pvr-body"><div class="ov-empty">Replaying the projections made during the event…</div></div>
    </div>`;

  const finalRows = finalSwissRows();
  replayCutLine(finishedReplayBases(), cut)
    .then(steps => {
      if (token !== _token) return; // re-rendered since
      const body = $('pvr-body');
      if (!body) return;
      body.innerHTML = compareHtml(buildMoments(steps, finalRows, cut), cut);
      wireCompare(body);
    })
    .catch(err => {
      console.error(err);
      if (token === _token && $('pvr-body')) $('pvr-body').innerHTML = `<div class="ov-empty">Couldn't replay the projections.</div>`;
    });
}
