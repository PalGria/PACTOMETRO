// ── LLM SUMMARY ───────────────────────────────────
// Plain-text briefing about one player's tournament, meant to be pasted into
// an external chat (ChatGPT/Claude/etc) — see the "Copy for LLM" button
// wired in main.js. It hands the model everything it needs to reason about
// the cut the way a strong player would: the rules that decide it, where
// everyone in contention stands and how they got there, the tables that
// matter right now, the Monte Carlo projections, and a precise question.
//
// Pure and synchronous: `scenario` is the already-resolved
// getScenarioResults(pid, roundId, cut) result and `cutLine` the resolved
// getCutLineProjection(cut) ({ res, R } or null), so this never touches the
// network/Worker itself and stays directly testable.

import S from '../state.js';
import { fmtOmw } from '../utils.js';
import { buildHistory } from '../tournament.js';
import { eventTotals, swissRounds, activeIdsAfter, futureSwissRounds } from '../engine/adapter.js';
import { DEFAULTS } from '../engine/montecarlo.js';
import { getTopCut } from '../services/storage.js';
import { verdictText, pctText } from './verdict.js';
import { cutLineSummary, cutLineNeed, bankedLivePts, CUT_SAFE, CUT_COULD } from './overview.js';

const RESULT_WORD = { W: 'WIN', L: 'LOSS', D: 'DRAW' };

// Most rows the standings block lists — enough for any realistic bubble,
// short enough that the paste stays readable.
const MAX_CONTENDERS = 40;

const _handle = p => p?.user_event_status?.best_identifier || p?.player?.best_identifier || '?';
// `record` on a standings row is the player's whole-event record as of the
// latest fetch; `match_record` is the record as of that round.
const _rec = p => p?.match_record || p?.record || '?';
const _pct = p => (p >= 0.995 && p < 1 ? '>99%' : p > 0 && p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`);

// How often the whole field has drawn so far — a 3-1-1 record means
// something very different in a draw-heavy tournament (everyone's points
// are inflated, the cut line rises with them) than in one with zero draws.
// Byes aren't real matches and don't count either way.
function _fieldStats() {
  let played = 0, draws = 0, ids = 0, byes = 0;
  for (const r of swissRounds()) {
    for (const m of S.matches[r.id] || []) {
      if (m.match_is_bye) { byes++; continue; }
      const isDraw = m.match_is_intentional_draw || m.match_is_unintentional_draw;
      if (!isDraw && m.winning_player == null) continue; // not yet reported
      played++;
      if (isDraw) draws++;
      if (m.match_is_intentional_draw) ids++;
    }
  }
  return { played, draws, ids, byes };
}

function _historyLine(h, labelOf) {
  let what;
  if (h.dropped) what = 'DROPPED';
  else if (h.live && !h.result) what = h.opponent ? `pending vs ${labelOf(h.opponentId, h.opponent)}` : 'pending';
  else if (h.isBye) what = 'BYE';
  else if (h.result) what = `${RESULT_WORD[h.result]} ${h.score} vs ${labelOf(h.opponentId, h.opponent)}`;
  else what = 'no result recorded';
  const tail = h.rank != null ? ` — after it: #${h.rank}, ${h.points} pts` : '';
  return `R${h.round_number}: ${what}${tail}`;
}

// One player's result in one match, from their side: "W 2-1", "ID", "BYE"…
function _resultCode(m, pid) {
  if (m.match_is_bye) return 'BYE';
  if (m.match_is_intentional_draw) return 'ID';
  if (m.match_is_unintentional_draw) return 'D';
  if (m.winning_player == null) return 'pending';
  const won = m.winning_player === pid;
  return `${won ? 'W' : 'L'} ${won ? m.games_won_by_winner : m.games_won_by_loser}-${won ? m.games_won_by_loser : m.games_won_by_winner}`;
}

const _matchOf = (roundId, pid) => (S.matches[roundId] || []).find(m => m.players?.includes(pid));

// "R1 W 2-0 vs Bob (#4) · R2 ID vs Ann (#2) · …" over the Swiss rounds.
function _path(pid, labelOf) {
  const parts = [];
  for (const r of swissRounds()) {
    const m = _matchOf(r.id, pid);
    if (!m) continue;
    const code = _resultCode(m, pid);
    if (code === 'BYE') { parts.push(`R${r.round_number} BYE`); continue; }
    const opp = m.players.find(x => x !== pid);
    parts.push(`R${r.round_number} ${code} vs ${labelOf(opp)}`);
  }
  return parts.join(' · ');
}

const _opponentsOf = pid => {
  const out = new Set();
  for (const r of swissRounds()) {
    const m = _matchOf(r.id, pid);
    for (const id of m?.players || []) if (id != null && id !== pid) out.add(id);
  }
  return out;
};

function _replyLanguage() {
  const tag = (typeof navigator !== 'undefined' && navigator.language) || '';
  const code = tag.split('-')[0];
  if (!code || code === 'en') return null;
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code); } catch { return null; }
}

export function buildLlmSummary(pid, roundId, scenario, cutLine = null) {
  // Swiss-only, not "any phase with standings" — the WIN/DRAW/LOSE
  // projection below is a Swiss mechanic (best-of-1 single elimination has
  // no draw), so "current standing" and "round X of Y" should describe the
  // Swiss picture consistently with it, not an elimination-bracket round
  // that happens to share the same standings_status.
  const swiss = swissRounds();
  const lastRound = swiss.filter(r => r.standings_status === 'GENERATED').at(-1);
  const rows = lastRound ? [...(S.standings[lastRound.id] || [])].sort((a, b) => a.rank - b.rank) : [];
  const latest = rows.find(p => p.id === pid);
  if (!latest) return '';

  const byId   = new Map(rows.map(p => [p.id, p]));
  // Same notion of "still playing" as the simulation: paired in the next
  // round when it exists, else registration still COMPLETE.
  const activeSet = new Set(activeIdsAfter(lastRound.id));
  const _isActive = p => activeSet.has(p.id);
  const handle = _handle(latest);
  const real   = latest.player.best_identifier;
  const active = activeSet.has(pid);

  const ev  = S.event;
  const cut = getTopCut();
  const { totalRounds, totalPlayers } = eventTotals();
  const liveRound = swiss.find(r => r.status === 'IN_PROGRESS' && r.pairings_status === 'GENERATED' && r.standings_status !== 'GENERATED');
  const played = swiss.findIndex(r => r.id === lastRound.id) + 1;
  const left = Math.max(0, Math.max(totalRounds, swiss.length) - played); // incl. a live one
  const res = cutLine?.res || null;
  const sum = res ? cutLineSummary(res) : null;

  // Highest total a player can still finish on: a live-round result already
  // reported counts as banked, every other remaining round as a win.
  const liveMatchOf = id => (liveRound ? _matchOf(liveRound.id, id) : null);
  const maxPts = p => {
    if (!_isActive(p)) return p.points;
    const m = liveMatchOf(p.id);
    const code = m ? _resultCode(m, p.id) : 'pending';
    if (!liveRound || code === 'pending') return p.points + 3 * left;
    const banked = code === 'BYE' || code.startsWith('W') ? 3 : code === 'ID' || code === 'D' ? 1 : 0;
    return p.points + banked + 3 * (left - 1);
  };

  // "Name (#3, 9 pts)" for anyone with standings, so every opponent mention
  // carries how strong they turned out to be.
  const labelOf = (id, fallback) => {
    const p = byId.get(id);
    if (!p) return fallback || `#${id}`;
    return `${_handle(p)} (#${p.rank}, ${p.points} pts)`;
  };

  const L = [];
  const section = title => { L.push(''); L.push(`=== ${title} ===`); };

  L.push(`PACTOMETRO — Tournament briefing for ${handle}${real !== handle ? ` (${real})` : ''}`);
  L.push('I am the player described below. Read the whole briefing, then answer the questions at the end.');

  // ── EVENT ──
  section('EVENT');
  L.push(`Event: ${ev.name}`);
  L.push(`Format: ${ev.gameplay_format?.name || ev.event_format}${ev.store ? ` · ${ev.store.name}` : ''}${ev.start_datetime ? ` · ${String(ev.start_datetime).slice(0, 10)}` : ''}`);
  L.push(`Field: ${totalPlayers} players · ${cut ? `Top ${cut} cut` : 'no cut configured'}`);
  L.push(`Round: ${lastRound.round_number} of ${totalRounds} (Swiss) completed${liveRound ? ` — R${liveRound.round_number} in progress` : ''} · ${left} Swiss round${left === 1 ? '' : 's'} still to play${liveRound ? ' (including the live one)' : ''}`);

  // ── RULES ──
  section('HOW STANDINGS AND THE CUT WORK');
  L.push('Match points: win 3, draw 1 (intentional or not), loss 0. A bye counts as a win (3 pts).');
  L.push('Ranking: points, then OMW% (opponents\' match-win %), then GW% (own game-win %), then OGW% (opponents\' game-win %). Each opponent\'s match-win % is floored at 33%.');
  L.push('Swiss pairing: players are paired against others on the same points (pairing down when a bracket is odd), never the same opponent twice.');
  L.push('Intentional draws (ID) are allowed: both players take 1 pt without playing — typical in the last round(s) when both are safe on the draw.');
  L.push('OMW keeps changing until the end: my opponents\' future results move my tiebreakers.');

  // ── ME ──
  section(`ME — ${handle}`);
  L.push(`Now: rank #${latest.rank} of ${rows.length} · record ${_rec(latest)} · ${latest.points} pts · OMW ${fmtOmw(latest.opponent_match_win_percentage)} · GW ${fmtOmw(latest.game_win_percentage)} · OGW ${fmtOmw(latest.opponent_game_win_percentage)} · ${active ? 'ACTIVE' : 'DROPPED / ELIMINATED'}`);
  const samePts = rows.filter(p => p.points === latest.points);
  if (samePts.length > 1) {
    const pos = samePts.findIndex(p => p.id === pid) + 1;
    L.push(`Tiebreak position: ${pos}${['st', 'nd', 'rd'][pos - 1] || 'th'} of the ${samePts.length} players on ${latest.points} pts.`);
  }
  if (cut != null) {
    const bubble = rows[Math.min(cut, rows.length) - 1];
    if (bubble) L.push(`Gap to the cut right now: #${cut} has ${bubble.points} pts — I am ${latest.points >= bubble.points ? `${latest.points - bubble.points} pts above` : `${bubble.points - latest.points} pts below`} it.`);
  }
  L.push('');
  L.push('My rounds (opponent shown as name, current rank, current pts):');
  for (const h of buildHistory(pid)) L.push(`  ${_historyLine(h, labelOf)}`);

  // ── TOURNAMENT CONTEXT ──
  // A record's strength only means something next to the rest of the field:
  // the same points total can be comfortably in or dangerously out
  // depending on how draw-heavy the tournament has been and where the
  // actual cut line sits right now.
  section('TOURNAMENT CONTEXT');
  const fs = _fieldStats();
  const drawPct = fs.played ? ((fs.draws / fs.played) * 100).toFixed(1) : '0.0';
  L.push(`Draws so far: ${fs.draws} of ${fs.played} matches played (${drawPct}%) — ${fs.ids} intentional. More draws push everyone's points, and the cut line, higher.`);
  const dropped = rows.filter(p => !_isActive(p)).length;
  L.push(`Byes given: ${fs.byes} · Players dropped/eliminated: ${dropped} of ${rows.length}.`);
  if (cut != null) {
    const bubble = rows.find(r => r.rank === cut);
    if (bubble) L.push(`Current cut line: rank #${cut} sits at ${bubble.points} pts right now.`);
    const projected = sum?.modePts ?? scenario?.D?.cutPtsMedian;
    if (projected != null) L.push(`Projected final cut line: ~${projected} pts (accounts for remaining rounds and typical draw rates).`);
  }
  const dist = new Map();
  for (const p of rows) if (_isActive(p)) dist.set(p.points, (dist.get(p.points) || 0) + 1);
  let cum = 0;
  const distTxt = [...dist.entries()].sort((a, b) => b[0] - a[0]).map(([pts, n]) => {
    const from = cum + 1; cum += n;
    return `${pts} pts: ${n} (#${from}${n > 1 ? `–${cum}` : ''})`;
  });
  L.push(`Active players by points: ${distTxt.join(' · ')}`);

  // ── CONTENDERS ──
  // Everyone who can still reach the cut, plus everyone currently inside it.
  if (cut != null) {
    const threshold = sum?.could?.pts ?? rows[Math.min(cut, rows.length) - 1]?.points ?? 0;
    let contenders = rows.filter(p => p.rank <= cut || (_isActive(p) && maxPts(p) >= threshold));
    const total = contenders.length;
    if (contenders.length > MAX_CONTENDERS) {
      contenders = contenders.slice(0, MAX_CONTENDERS);
      if (!contenders.some(p => p.id === pid)) contenders.push(latest);
    }
    section(`CONTENDERS — everyone inside the Top ${cut} now or still able to reach ~${threshold} pts`);
    L.push('Format: rank. name — record, pts | OMW / GW / OGW | max pts reachable | P(make cut) | how they got here');
    for (const p of contenders) {
      const me = p.id === pid ? '  ◀ ME' : '';
      const pIn = res?.pInById?.[p.id];
      const status = _isActive(p) ? '' : ' [DROPPED]';
      L.push(`#${p.rank}. ${_handle(p)}${status} — ${_rec(p)}, ${p.points} pts | ${fmtOmw(p.opponent_match_win_percentage)} / ${fmtOmw(p.game_win_percentage)} / ${fmtOmw(p.opponent_game_win_percentage)} | max ${maxPts(p)} | ${pIn != null ? _pct(pIn) : '—'}${me}`);
      L.push(`     ${_path(p.id, labelOf) || 'no matches'}`);
    }
    if (total > contenders.length) L.push(`(${total - contenders.length} more players with an outside chance not listed.)`);

    const mine = _opponentsOf(pid);
    const faced = contenders.filter(p => mine.has(p.id)).map(p => _handle(p));
    if (faced.length) L.push(`Contenders I've already played (can't face again in Swiss): ${faced.join(', ')}.`);
  }

  // ── LIVE / NEXT ROUND ──
  if (liveRound) {
    section(`ROUND ${liveRound.round_number} — IN PROGRESS`);
    const relevant = id => {
      const p = byId.get(id);
      return p && (cut == null || p.rank <= cut * 2 || maxPts(p) >= (sum?.could?.pts ?? 0));
    };
    const tables = (S.matches[liveRound.id] || [])
      .filter(m => (m.players || []).some(relevant))
      .sort((a, b) => (a.table_number ?? 999) - (b.table_number ?? 999));
    for (const m of tables) {
      const [a, b] = m.players;
      const mark = m.players.includes(pid) ? '  ◀ MY MATCH' : '';
      if (m.match_is_bye) { L.push(`BYE: ${labelOf(a)}${mark}`); continue; }
      let outcome;
      if (m.match_is_intentional_draw) outcome = 'intentional draw';
      else if (m.match_is_unintentional_draw) outcome = 'draw';
      else if (m.winning_player != null) outcome = `${_handle(byId.get(m.winning_player))} won ${m.games_won_by_winner}-${m.games_won_by_loser}`;
      else outcome = 'PENDING';
      L.push(`Table ${m.table_number ?? '?'}: ${labelOf(a)} vs ${labelOf(b)} — ${outcome}${mark}`);
    }
    if (!tables.length) L.push('No tables involving contenders.');
  } else if (left > 0 && active) {
    section('NEXT ROUND — NOT PAIRED YET');
    const mine = _opponentsOf(pid);
    const pool = rows.filter(p => p.id !== pid && _isActive(p) && p.points === latest.points);
    const fresh = pool.filter(p => !mine.has(p.id));
    L.push(`Likely opponents (active, also on ${latest.points} pts, not played yet): ${fresh.length ? fresh.map(p => labelOf(p.id)).join(', ') : 'none — I will probably be paired up or down'}.`);
    if ((pool.length + 1) % 2 === 1) L.push(`The ${latest.points}-pt bracket has an odd number of players (${pool.length + 1}), so someone gets paired up/down.`);
  }

  // ── PROJECTIONS ──
  if (res) {
    section(`CUT LINE PROJECTION — ${res.samples} Monte Carlo runs of every remaining Swiss round`);
    L.push(`Model: every match 50/50, ${Math.round(DEFAULTS.pDraw * 100)}% unintentional draws, rational IDs in the last round, exact tiebreakers. It knows nothing about decks or player skill.`);
    L.push(`Safe with: ${sum.safe ? `${sum.safe.pts} pts (${_pct(sum.safe.pIn)} of players finishing there make it)` : 'no total is ≥95% safe'}.`);
    L.push(`Could still make it with: ${sum.could ? `${sum.could.pts} pts (${_pct(sum.could.pIn)})` : '—'}.`);
    L.push(`Most likely cut line: ${sum.modePts} pts (${_pct(sum.modeShare)} of runs). The last spot is decided on tiebreakers in ${_pct(res.tieBubble)} of runs.`);
    const shown = res.byPts.filter(r => r.pIn > 0.005 && r.pIn < 0.995 || (res.lineCounts[r.pts] || 0) > 0);
    if (shown.length) L.push(`P(make cut | final pts): ${shown.map(r => `${r.pts} pts → ${_pct(r.pIn)} (~${r.players.toFixed(1)} players)`).join(' · ')}`);
    const bub = Object.entries(res.bubble || {}).map(([p, b]) => ({ pts: +p, ...b })).filter(b => b.n >= 20).sort((a, b) => b.n - a.n)[0];
    if (bub) L.push(`Tiebreaker bubble at ${bub.pts} pts: last player in has OMW ~${fmtOmw(bub.lastIn[1])}, first one out ~${fmtOmw(bub.firstOut[1])} (medians).`);
    if (active) {
      const own = res.finalById?.[pid] || null;
      const banked = bankedLivePts(futureSwissRounds(lastRound.id)[0], pid);
      const need = min => cutLineNeed(res, latest.points, cutLine.R, min, own, banked);
      const fmtNeed = n => (n ? `${n.label} (${_pct(n.p)})` : 'out of reach');
      const from = banked != null ? ` from here (my R${liveRound.round_number} result, +${banked} pts, is already in)` : '';
      L.push(`ME: ${_pct(res.pInById?.[pid] ?? 0)} to make the cut overall. Over the rounds still to play${from}: to be ≥${CUT_SAFE * 100}% safe I need ${fmtNeed(need(CUT_SAFE))}; for a ≥${CUT_COULD * 100}% shot, ${fmtNeed(need(CUT_COULD))}.`);
    }
  }

  if (scenario) {
    const round = S.rounds.find(r => r.id === roundId);
    const nextRoundNum = swiss[swiss.findIndex(r => r.id === roundId) + 1]?.round_number ?? (round?.round_number ?? 0) + 1;
    section(`NEXT ROUND (R${nextRoundNum}) — IF I…`);
    const myLive = liveRound && liveRound.round_number === nextRoundNum ? _matchOf(liveRound.id, pid) : null;
    const done = myLive ? _resultCode(myLive, pid) : 'pending';
    if (done !== 'pending') L.push(`(My R${nextRoundNum} result is already in: ${done}. The matching line below is what actually happened; the others are for comparison.)`);
    for (const [key, label] of [['W', 'WIN'], ['D', 'DRAW'], ['L', 'LOSE']]) {
      const r = scenario[key];
      const rank = r.p5 === r.p95 ? `#${r.p5}` : `#${r.p5}–${r.p95}`;
      L.push(`${label} → ${r.projPts} pts · rank ${rank} (5th–95th percentile) · ${verdictText(r, cut)}${cut ? ` (${pctText(r, cut)} into Top ${cut})` : ''}`);
    }
  } else if (!left) {
    const inCut = cut != null && latest.rank <= cut;
    section('RESULT');
    L.push(cut
      ? `Swiss rounds are complete — final rank #${latest.rank}, ${inCut ? 'made' : 'missed'} the Top ${cut} cut.`
      : `Swiss rounds are complete — final rank #${latest.rank}. No cut was configured.`);
  }

  // ── THE ASK ──
  section('WHAT I NEED FROM YOU');
  L.push('Not in this data: decks, matchups, how my opponents play. Ask me if one of those would change your advice.');
  if (left > 0 && active) {
    L.push('1. Verdict first, one line: for my next round, play to win or take/offer an intentional draw? Would an ID actually be accepted by my likely opponent given THEIR situation?');
    L.push('2. What final points total I need, and how much depends on tiebreakers — compare my OMW/GW with the rivals around my points total.');
    L.push('3. Results elsewhere: which pending or upcoming matches help or hurt me (who to root for), including how my past opponents\' results move my OMW.');
    L.push('4. Worst case and best case from here, with rough odds — use the projections above, adjusting them with your own reasoning where the 50/50 model is too simple.');
    L.push('5. Anything else worth knowing (pairing-down risk, odd brackets, players likely to ID or drop).');
  } else {
    L.push('Review my tournament: what decided my result, the key rounds and tiebreaker moments, and what I could do differently next time.');
  }
  L.push('Be concrete and use the numbers above; say where you are uncertain. Keep it tight — short sections, no generic advice.');
  const lang = _replyLanguage();
  if (lang) L.push(`Reply in ${lang}.`);

  return L.join('\n');
}
