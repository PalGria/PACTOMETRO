import { restoreTopCut, saveTopCut } from './services/storage.js';
import { loadEvent, exitEvent, selectPlayer } from './controllers/eventController.js';
import { openRoster, closeRoster } from './controllers/rosterController.js';
import { renderStandings } from './ui/standings.js';
import { renderSimulation } from './ui/simulation.js';
import { renderRoundSim } from './ui/roundSim.js';
import { renderOppPool } from './ui/oppPool.js';
import S from './state.js';
import { $ } from './utils.js';

const _board = () => document.getElementById('board');

// ── THEME ─────────────────────────────────────────
function _applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : '';
  $('theme-btn').textContent = theme === 'light' ? '◑' : '☀';
  try { localStorage.setItem('pm_theme', theme); } catch(e) {}
}
_applyTheme(localStorage.getItem('pm_theme') || 'dark');
// defer until DOM ready
document.addEventListener('DOMContentLoaded', () => {
  $('theme-btn').addEventListener('click', () => {
    _applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
});

function switchBoardTab(mode) {
  $('btab-analysis').classList.toggle('on', mode === 'analysis');
  $('btab-round').classList.toggle('on',    mode === 'round');
  $('btab-pool').classList.toggle('on',     mode === 'pool');
  const board = _board();
  if (board) {
    board.classList.toggle('round-mode', mode === 'round');
    board.classList.toggle('pool-mode',  mode === 'pool');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  restoreTopCut();
  const savedUrl    = localStorage.getItem('pm_url');
  const savedPlayer = localStorage.getItem('pm_player');
  if (savedUrl) {
    $('url-input').value        = savedUrl;
    $('roster-url-input').value = savedUrl;
    import('./ui/welcome.js').then(m => m.hideWelcome());
    loadEvent(savedUrl, savedPlayer ? parseInt(savedPlayer) : null, { fromCache: true });
  } else {
    if (window.innerWidth <= 760) openRoster();
    else import('./ui/welcome.js').then(m => m.showWelcome());
  }
});

// pm:select-player events (from standings, history + tracker row clicks)
document.addEventListener('pm:select-player', e => selectPlayer(e.detail.pid));

// Header form
$('form').addEventListener('submit', e => { e.preventDefault(); const url = $('url-input').value.trim(); if (url) loadEvent(url); });
$('refresh-btn').addEventListener('click', () => { const url = $('url-input').value.trim(); if (url) loadEvent(url, S.activeId); });
$('exit-btn').addEventListener('click', exitEvent);

// Roster drawer
$('menu-btn').addEventListener('click', openRoster);
$('close-drawer-btn').addEventListener('click', closeRoster);
$('drawer-overlay').addEventListener('click', closeRoster);

// Roster form (mobile)
$('roster-load-btn').addEventListener('click', () => { const url = $('roster-url-input').value.trim(); if (!url) return; $('url-input').value = url; closeRoster(); loadEvent(url); });
$('roster-refresh-btn').addEventListener('click', () => { closeRoster(); const url = $('url-input').value || localStorage.getItem('pm_url') || ''; if (url) loadEvent(url, S.activeId); });
$('roster-exit-btn').addEventListener('click', () => { closeRoster(); exitEvent(); });

// Welcome form
$('wc-form').addEventListener('submit', e => { e.preventDefault(); const url = $('wc-input').value.trim(); if (!url) return; $('url-input').value = url; loadEvent(url); });

// Board tabs
$('btab-analysis').addEventListener('click', () => switchBoardTab('analysis'));
$('btab-round').addEventListener('click', () => { switchBoardTab('round'); renderRoundSim(); });
$('btab-pool').addEventListener('click', () => { switchBoardTab('pool'); renderOppPool(); });

// Top cut controls
$('no-cut-cb').addEventListener('change', () => { $('top-cut-input').disabled = $('no-cut-cb').checked; saveTopCut(); renderStandings(); if (S.activeId) renderSimulation(S.activeId); });
$('top-cut-input').addEventListener('input', () => { saveTopCut(); renderStandings(); if (S.activeId) renderSimulation(S.activeId); });
