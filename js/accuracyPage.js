// ── ACCURACY PAGE ────────────────────────────────
// accuracy.html: every event the server has stored, and for the finished
// ones how the cut line projection held up — replayed in the browser with
// the same engine and worker as the app (js/ui/cutReplay.js), compared by
// js/ui/accuracy.js. Results are cached per event, data version, cut and
// model version, so a revisit only recomputes what changed.

import S from './state.js';
import { api } from './services/api.js';
import { MODEL_VERSION } from './engine/montecarlo.js';
import { finishedReplayBases, replayCutLine } from './ui/cutReplay.js';
import { finalSwissRows, buildMoments, compareHtml, wireCompare } from './ui/accuracy.js';
import { fmtPct, CUT_SAFE } from './ui/cutStats.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── THEME (same switch as the app) ───────────────
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : '';
  $('theme-btn').textContent = theme === 'light' ? '◑' : '☀';
  try { localStorage.setItem('pm_theme', theme); } catch (e) {}
}
applyTheme((() => { try { return localStorage.getItem('pm_theme'); } catch (e) { return null; } })() || 'dark');
$('theme-btn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

// ── EVENT → CUT ──────────────────────────────────
// The event's real top cut: the first elimination phase's entry rank, else
// its bracket size, else what the event declares, else Top 8.
function eventCut(ev) {
  const elim = (ev.tournament_phases || [])
    .filter(p => p.round_type !== 'SWISS')
    .sort((a, b) => (a.order_in_phases ?? 0) - (b.order_in_phases ?? 0))[0];
  if (elim?.rank_required_to_enter_phase) return elim.rank_required_to_enter_phase;
  const n = elim?.number_of_rounds || (elim?.rounds || []).length;
  if (n) return 2 ** n;
  return ev.top_cut_size || 8;
}

// ── CACHE ────────────────────────────────────────
// Bump ACC_FORMAT when the shape of a cached comparison changes.
const ACC_FORMAT = 2;
const cacheSuffix = `_m${MODEL_VERSION}_f${ACC_FORMAT}`;
const cacheKey = (e, cut) => `pm_acc_${e.id}_${e.version}_${cut}${cacheSuffix}`;
function readCache(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function storedKeys() {
  const keys = [];
  try { for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); } catch (e) {}
  return keys;
}
function writeCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota — just recompute next time */ }
}

// ── EVALUATION ───────────────────────────────────
// Loads one stored event into the app state and replays its projections.
async function evaluate(e, onStep) {
  const b = await api(`/event/${e.id}`);
  Object.assign(S, { event: b.event, rounds: b.rounds, standings: b.standings, matches: b.matches, gatePts: null });
  const cut = eventCut(b.event);
  const finalRows = finalSwissRows();
  if (finalRows.length <= cut) return { cut, moments: [], tooSmall: true };
  const steps = await replayCutLine(finishedReplayBases(), cut, onStep);
  return { cut, ...buildMoments(steps, finalRows, cut) };
}

// ── RENDER ───────────────────────────────────────
const results = new Map(); // event id → { cut, moments, tooSmall } once evaluated

const lastMoment = r => r.moments.filter(m => m.cmp).at(-1) || null;
const offOf = m => m.cmp.real.pts - m.cmp.pred.mode;

function rowSummary(e, r) {
  if (!r) return `<span class="acc-tag">waiting</span>`;
  if (r.error) return `<span class="acc-tag">couldn't evaluate</span>`;
  if (r.tooSmall) return `<span class="acc-tag">field ≤ Top ${r.cut}</span>`;
  const m = lastMoment(r);
  if (!m) return `<span class="acc-tag">nothing to compare</span>`;
  const off = offOf(m);
  const cls = off === 0 ? 'hit' : Math.abs(off) === 1 ? 'near' : 'miss';
  return `Top ${r.cut} · ${esc(m.label)}: predicted <strong>${m.cmp.pred.mode}</strong> → real <strong>${m.cmp.real.pts}</strong>
    <span class="acc-off ${cls}">${off === 0 ? '✓' : off > 0 ? `+${off}` : off}</span>`;
}

function eventHtml(e) {
  const date = e.start_datetime ? String(e.start_datetime).slice(0, 10) : '';
  const meta = [date, e.store, e.format, `${e.players} players`, `${e.swiss_done}/${e.swiss_rounds} Swiss rounds`].filter(Boolean).map(esc).join(' · ');
  const res = e.finished ? rowSummary(e, results.get(e.id)) : `<span class="acc-tag">in progress</span>`;
  return `
    <div class="acc-ev" id="acc-ev-${e.id}">
      <button class="acc-ev-row" type="button" data-id="${e.id}"${e.finished ? '' : ' disabled'}>
        <div><div class="acc-ev-name">${esc(e.name)}</div><div class="acc-ev-meta">${meta}</div></div>
        <div class="acc-ev-res">${res}${e.finished ? '<span class="chev">›</span>' : ''}</div>
      </button>
      <div class="acc-ev-links">
        <a href="evento?e=${encodeURIComponent(e.id)}">Open in Pactometro</a>
        <a href="https://tcg.ravensburgerplay.com/events/${encodeURIComponent(e.id)}" target="_blank" rel="noopener">Ravensburger Play ↗</a>
      </div>
      <div class="acc-ev-body" hidden></div>
    </div>`;
}

function setRowSummary(e, html) {
  const el = document.querySelector(`#acc-ev-${e.id} .acc-ev-res`);
  if (el) el.innerHTML = `${html}<span class="chev">›</span>`;
}

function tile(label, val, sub, cls = '') {
  return `<div class="acc-tile ${cls}"><div class="acc-tile-label">${label}</div><div class="acc-tile-val">${val}</div><div class="acc-tile-sub">${sub}</div></div>`;
}

// Every evaluated event together.
function renderSummary(events) {
  const done = events.filter(e => e.finished).map(e => results.get(e.id)).filter(r => r && !r.error && !r.tooSmall);
  const lasts = done.map(lastMoment).filter(Boolean);
  if (!lasts.length) { $('acc-summary').innerHTML = ''; return; }
  const all = done.flatMap(r => r.moments.filter(m => m.cmp));

  const hits = lasts.filter(m => offOf(m) === 0).length;
  const meanAbs = ms => ms.reduce((s, m) => s + Math.abs(offOf(m)), 0) / ms.length;
  const byLeft = [[1, m => m.left === 1], [2, m => m.left === 2], ['3+', m => m.left >= 3]]
    .map(([k, f]) => [k, all.filter(f)]).filter(([, ms]) => ms.length)
    .map(([k, ms]) => `${k} left: ${meanAbs(ms).toFixed(1)}`).join(' · ');
  const safeN = all.reduce((s, m) => s + m.cmp.players.safeN, 0);
  const safeMiss = all.reduce((s, m) => s + m.cmp.players.safeN - m.cmp.players.safeIn, 0);
  const skills = all.map(m => m.cmp.players.skill).filter(v => v != null);
  const skill = skills.length ? skills.reduce((a, b) => a + b, 0) / skills.length : null;
  const missRate = safeN ? safeMiss / safeN : 0;
  const sum = f => all.reduce((s, m) => s + f(m.cmp), 0);
  const right = sum(c => c.players.right), judged = sum(c => c.players.n);
  const bits = sum(c => c.players.bits * c.players.n) / (judged || 1);
  const zeroMade = sum(c => c.integrity.zeroMade.n), certainMissed = sum(c => c.integrity.certainMissed.n);
  const gaveImpossible = sum(c => c.integrity.gaveImpossible.n), broken = sum(c => c.integrity.boundBroken.n);
  const finished = events.filter(e => e.finished).length;

  $('acc-summary').innerHTML = [
    tile('Events evaluated', `${done.length}<small>/ ${finished}</small>`, `finished events with a cut to compare · ${events.length - finished} still running`),
    tile('Cut called exactly', `${hits}<small>/ ${lasts.length}</small>`, 'likely cut before the final Swiss round vs the real one', hits === lasts.length ? 'good' : ''),
    tile('Average miss', `${meanAbs(lasts).toFixed(1)}<small>pts</small>`, `before the final round · by rounds left — ${byLeft}`, meanAbs(lasts) <= 1 ? 'good' : 'warn'),
    tile(`Sure bets that failed`, `${safeMiss}<small>/ ${safeN}</small>`, `players given ≥${CUT_SAFE * 100}% who missed — ${fmtPct(missRate)}, should stay under 5%`, missRate <= 0.05 ? 'good' : 'bad'),
    tile('Called the right side', fmtPct(judged ? right / judged : 0), `players on the right side of 50%, every projection · average surprise ${bits.toFixed(2)} bits`),
    tile('Every run wrong', `${zeroMade + certainMissed}`, `${zeroMade} that no run had in made it · ${certainMissed} that every run had in missed — should be 0`, zeroMade + certainMissed ? 'bad' : 'good'),
    tile('Chance given to the impossible', `${gaveImpossible}`, `players already proven out but shown above 0%${broken ? ` · ${broken} proven results contradicted (bug)` : ''}`, gaveImpossible || broken ? 'bad' : 'good'),
    tile('Average score', skill == null ? '—' : skill.toFixed(2), 'Brier skill of every player\'s chance, averaged over every projection (early ones score low by nature): 1 perfect, 0 no skill', skill != null && skill >= 0.5 ? 'good' : 'warn'),
  ].join('');
}

function toggle(e, events) {
  const wrap = $(`acc-ev-${e.id}`);
  const body = wrap.querySelector('.acc-ev-body');
  const open = body.hidden;
  wrap.classList.toggle('open', open);
  body.hidden = !open;
  if (!open) return;
  const r = results.get(e.id);
  if (!r) { body.innerHTML = `<div class="ov-empty">Still evaluating…</div>`; return; }
  if (r.error) { body.innerHTML = `<div class="ov-empty">Couldn't evaluate this event: ${esc(r.error)}</div>`; return; }
  if (r.tooSmall) { body.innerHTML = `<div class="ov-empty">The whole field fits in the Top ${r.cut}: no cut to predict.</div>`; return; }
  body.innerHTML = compareHtml(r, r.cut);
  wireCompare(body);
}

async function main() {
  $('acc-model').textContent = `Model version ${MODEL_VERSION}. Every projection is recomputed with the current model, so scores can change when the model does; the events themselves are never re-downloaded.`;
  let events;
  try {
    events = (await api('/events')).events || [];
  } catch (err) {
    $('acc-events').innerHTML = `<div class="ov-empty">Couldn't load the stored events.</div>`;
    return;
  }
  if (!events.length) { $('acc-events').innerHTML = `<div class="ov-empty">No events stored yet.</div>`; return; }

  // Finished first, smallest first within them: quick results show up early.
  events.sort((a, b) => (b.finished - a.finished) || (a.finished ? a.players - b.players : 0));
  $('acc-events').innerHTML = events.map(eventHtml).join('');
  document.querySelectorAll('.acc-ev-row[data-id]').forEach(btn => {
    const e = events.find(x => String(x.id) === btn.dataset.id);
    if (e?.finished) btn.addEventListener('click', () => toggle(e, events));
  });

  // Cached results first, then evaluate the rest one at a time.
  const keys = storedKeys();
  for (const e of events.filter(x => x.finished)) {
    // The cut only depends on the event, but it's needed for the key before
    // the bundle is loaded: try the cached entry for any cut.
    const hit = keys.find(k => k.startsWith(`pm_acc_${e.id}_${e.version}_`) && k.endsWith(cacheSuffix));
    const cached = hit ? readCache(hit) : null;
    if (cached) { results.set(e.id, cached); setRowSummary(e, rowSummary(e, cached)); }
  }
  renderSummary(events);

  for (const e of events.filter(x => x.finished && !results.has(x.id))) {
    setRowSummary(e, `<span class="acc-tag">evaluating…</span>`);
    try {
      const r = await evaluate(e, (i, n) => setRowSummary(e, `<span class="acc-tag">evaluating ${i}/${n}</span>`));
      results.set(e.id, r);
      writeCache(cacheKey(e, r.cut), r);
    } catch (err) {
      console.error(err);
      results.set(e.id, { error: err.message });
    }
    setRowSummary(e, rowSummary(e, results.get(e.id)));
    const body = document.querySelector(`#acc-ev-${e.id} .acc-ev-body`);
    if (body && !body.hidden) { body.hidden = true; toggle(e, events); }
    renderSummary(events);
  }
}

main();
