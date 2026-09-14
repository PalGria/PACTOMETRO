import S from '../state.js';
import { $, fmtDate } from '../utils.js';

// ── RENDER: BANNER ───────────────────────────────
export function renderBanner() {
  const ev = S.event;
  $('banner').classList.add('on');
  $('refresh-btn').style.display = '';
  $('share-btn').style.display   = '';
  $('exit-btn').style.display    = '';
  $('menu-btn').classList.add('has-event');
  $('roster-action-row').style.display = '';
  if (S.event) $('roster-url-input').value = `https://tcg.ravensburgerplay.com/events/${S.event.id}`;
  $('b-name').textContent = ev.name;

  const items = [
    ev.store ? `${ev.store.name} · ${ev.store.administrative_area_level_1_short || ''}, ${ev.store.country}` : null,
    fmtDate(ev.start_datetime),
    `${ev.starting_player_count} players`,
    ev.gameplay_format?.name || ev.event_format,
  ].filter(Boolean);

  $('b-meta').innerHTML = items.map(t =>
    `<div class="banner-meta-item">${t}</div>`
  ).join('');

  const live = $('b-live');
  if (live) {
    const t = S.updatedAt ? new Date(S.updatedAt * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
    live.classList.remove('warn');
    live.textContent = S.finished
      ? `Event finished${t ? ` · data from ${t}` : ''}`
      : `${t ? `Updated ${t}` : 'Live'} · auto-refresh every 5 min`;
  }

  $('b-phases').innerHTML = ev.tournament_phases.map(ph => {
    const cls = ph.status === 'COMPLETE' ? 'done' : ph.status === 'IN_PROGRESS' ? 'active' : 'wait';
    return `<span class="pill ${cls}">${ph.phase_name} · ${ph.rounds.length}R</span>`;
  }).join('');
}
