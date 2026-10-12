import { restoreTopCut, saveTopCut, getTopCut } from './services/storage.js';
import { loadEvent, exitEvent, selectPlayer, refreshEvent } from './controllers/eventController.js';
import { openRoster, closeRoster } from './controllers/rosterController.js';
import { renderStandings, setSearchQuery } from './ui/standings.js';
import { renderSimulation, getScenarioResults } from './ui/simulation.js';
import { renderRoundSim } from './ui/roundSim.js';
import { renderOppPool } from './ui/oppPool.js';
import { renderAllRounds } from './ui/allRounds.js';
import S from './state.js';
import { $, extractEventId } from './utils.js';
import { renderOverview } from './ui/overview.js';
import { switchBoardTab } from './ui/boardTabs.js';
import { buildLlmSummary } from './ui/llmSummary.js';

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

document.addEventListener('DOMContentLoaded', () => {
  restoreTopCut();
  const eidFromLink = extractEventId(new URLSearchParams(location.search).get('e') || '');
  const savedUrl     = localStorage.getItem('pm_url');
  const savedPlayer  = localStorage.getItem('pm_player');
  if (eidFromLink) {
    $('url-input').value        = eidFromLink;
    $('roster-url-input').value = eidFromLink;
    import('./ui/welcome.js').then(m => m.hideWelcome());
    loadEvent(eidFromLink, null, { fromCache: false });
    return;
  }
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

// pm:select-player events (from standings, history + tracker row clicks, and
// the Overview dashboard's player links). Overview is its own tab now — a
// player link there needs to jump to Analysis to actually show the detail.
document.addEventListener('pm:select-player', e => {
  const board = _board();
  if (board && board.classList.contains('overview-mode')) switchBoardTab('analysis');
  selectPlayer(e.detail.pid);
});

// Header form
$('form').addEventListener('submit', e => { e.preventDefault(); const url = $('url-input').value.trim(); if (url) loadEvent(url); });
$('refresh-btn').addEventListener('click', () => { if (S.event) refreshEvent(); else { const url = $('url-input').value.trim(); if (url) loadEvent(url); } });
$('exit-btn').addEventListener('click', exitEvent);

// Copy shareable link
function _copyLink(btn) {
  if (!navigator.clipboard) return;
  navigator.clipboard.writeText(location.href).then(() => {
    const prev = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = prev; }, 1200);
  }).catch(() => {});
}
$('share-btn').addEventListener('click', () => _copyLink($('share-btn')));
$('roster-share-btn').addEventListener('click', () => _copyLink($('roster-share-btn')));

// Copy LLM summary
function _showLlmFallback(text) {
  const box = $('llm-fallback');
  const area = $('llm-fallback-text');
  area.value = text;
  box.style.display = 'block';
  area.focus();
  area.select();
}

async function _copyLlmSummary(btn) {
  if (!S.activeId) return;
  const cut = getTopCut();
  const scenario = S.simRound ? await getScenarioResults(S.activeId, S.simRound, cut) : null;
  const text = buildLlmSummary(S.activeId, S.simRound, scenario);

  // NOTE: the clipboard write happens after the `await` above, so by the time
  // we get here the click's user-activation window may have expired — Safari
  // and Firefox then reject with NotAllowedError. Always fall back to a
  // manual-copy box instead of swallowing that failure.
  if (!navigator.clipboard) {
    _showLlmFallback(text);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    const prev = btn.textContent;
    btn.textContent = '✓ Copied';
    btn.classList.add('copied');
    $('llm-fallback').style.display = 'none';
    setTimeout(() => { btn.textContent = prev; btn.classList.remove('copied'); }, 1400);
  } catch {
    _showLlmFallback(text);
  }
}
$('llm-copy-btn').addEventListener('click', () => _copyLlmSummary($('llm-copy-btn')));

// Roster drawer
$('menu-btn').addEventListener('click', openRoster);
$('close-drawer-btn').addEventListener('click', closeRoster);
$('drawer-overlay').addEventListener('click', closeRoster);

// Roster form (mobile)
$('roster-load-btn').addEventListener('click', () => { const url = $('roster-url-input').value.trim(); if (!url) return; $('url-input').value = url; closeRoster(); loadEvent(url); });
$('roster-refresh-btn').addEventListener('click', () => { closeRoster(); if (S.event) refreshEvent(); else { const url = $('url-input').value || localStorage.getItem('pm_url') || ''; if (url) loadEvent(url); } });
$('roster-exit-btn').addEventListener('click', () => { closeRoster(); exitEvent(); });

// Welcome form
$('wc-form').addEventListener('submit', e => { e.preventDefault(); const url = $('wc-input').value.trim(); if (!url) return; $('url-input').value = url; loadEvent(url); });

// Board tabs
$('btab-overview').addEventListener('click', () => { switchBoardTab('overview'); renderOverview(); });
$('btab-analysis').addEventListener('click', () => switchBoardTab('analysis'));
$('d-back-btn').addEventListener('click', () => { switchBoardTab('overview'); renderOverview(); });
$('btab-round').addEventListener('click', () => { switchBoardTab('round'); renderRoundSim(); });
$('btab-pool').addEventListener('click', () => { switchBoardTab('pool'); renderOppPool(); });
$('btab-standings').addEventListener('click', () => { switchBoardTab('standings'); renderAllRounds(); });

// Top cut controls — keep both the simulator (if a player's shown) and the
// overview dashboard (if it's the visible tab) in sync.
$('no-cut-cb').addEventListener('change', () => { $('top-cut-input').disabled = $('no-cut-cb').checked; saveTopCut(); renderStandings(); if (S.activeId) renderSimulation(S.activeId); renderOverview(); });
$('top-cut-input').addEventListener('input', () => { saveTopCut(); renderStandings(); if (S.activeId) renderSimulation(S.activeId); renderOverview(); });

// Player search — the magnifying glass toggles a search row below the top
// cut bar; closing it clears the filter too, so the roster never stays
// silently filtered with no visible reason why.
function _closeSearch() {
  $('search-btn').classList.remove('on');
  $('search-bar').hidden = true;
  $('search-input').value = '';
  $('search-clear-btn').hidden = true;
  setSearchQuery('');
}
$('search-btn').addEventListener('click', () => {
  const opening = $('search-bar').hidden;
  if (opening) {
    $('search-btn').classList.add('on');
    $('search-bar').hidden = false;
    $('search-input').focus();
  } else {
    _closeSearch();
  }
});
$('search-input').addEventListener('input', () => {
  $('search-clear-btn').hidden = $('search-input').value === '';
  setSearchQuery($('search-input').value);
});
$('search-input').addEventListener('keydown', e => { if (e.key === 'Escape') _closeSearch(); });
$('search-clear-btn').addEventListener('click', () => {
  $('search-input').value = '';
  $('search-clear-btn').hidden = true;
  setSearchQuery('');
  $('search-input').focus();
});
