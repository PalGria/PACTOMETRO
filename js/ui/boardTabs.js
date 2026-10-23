// ── BOARD TAB SWITCHING ───────────────────────────
// Shared between main.js (tab click handlers) and eventController.js
// (picking the default tab when an event loads / resets).
import { $ } from '../utils.js';

const _board = () => document.getElementById('board');

export function switchBoardTab(mode) {
  $('btab-overview').classList.toggle('on',  mode === 'overview');
  $('btab-analysis').classList.toggle('on',  mode === 'analysis');
  $('btab-round').classList.toggle('on',     mode === 'round');
  $('btab-pool').classList.toggle('on',      mode === 'pool');
  $('btab-standings').classList.toggle('on', mode === 'standings');
  $('btab-pvr').classList.toggle('on',       mode === 'pvr');
  const board = _board();
  if (board) {
    board.classList.toggle('overview-mode',  mode === 'overview');
    board.classList.toggle('round-mode',     mode === 'round');
    board.classList.toggle('pool-mode',      mode === 'pool');
    board.classList.toggle('standings-mode', mode === 'standings');
    board.classList.toggle('pvr-mode',       mode === 'pvr');
  }
}

export function currentBoardMode() {
  const board = _board();
  if (board?.classList.contains('overview-mode'))  return 'overview';
  if (board?.classList.contains('round-mode'))     return 'round';
  if (board?.classList.contains('pool-mode'))      return 'pool';
  if (board?.classList.contains('standings-mode')) return 'standings';
  if (board?.classList.contains('pvr-mode'))       return 'pvr';
  return 'analysis';
}
