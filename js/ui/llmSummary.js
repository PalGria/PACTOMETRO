// ── LLM SUMMARY ───────────────────────────────────
// Plain-text recap of one player's tournament, meant to be pasted into an
// external chat (ChatGPT/Claude/etc) — see the "Copy for LLM" button wired
// in main.js. Pure and synchronous: `scenario` is the already-resolved
// getScenarioResults(pid, roundId, cut) result (or null when there's
// nothing to project), so this never touches the network/Worker itself and
// stays directly testable.

import S from '../state.js';
import { fmtOmw } from '../utils.js';
import { buildHistory } from '../tournament.js';
import { eventTotals, swissRounds } from '../engine/adapter.js';
import { getTopCut } from '../services/storage.js';
import { verdictText, pctText } from './verdict.js';

const RESULT_WORD = { W: 'WIN', L: 'LOSS', D: 'DRAW' };

function _historyLine(h) {
  let what;
  if (h.dropped) what = 'DROPPED';
  else if (h.live && !h.result) what = h.opponent ? `pending vs ${h.opponent}` : 'pending';
  else if (h.isBye) what = 'BYE';
  else if (h.result) what = `${RESULT_WORD[h.result]} ${h.score} vs ${h.opponent}`;
  else what = 'no result recorded';
  const tail = h.rank != null ? ` — rank #${h.rank}, ${h.record}, ${h.points} pts` : '';
  return `R${h.round_number}: ${what}${tail}`;
}

export function buildLlmSummary(pid, roundId, scenario) {
  // Swiss-only, not "any phase with standings" — the WIN/DRAW/LOSE
  // projection below is a Swiss mechanic (best-of-1 single elimination has
  // no draw), so "current standing" and "round X of Y" should describe the
  // Swiss picture consistently with it, not an elimination-bracket round
  // that happens to share the same standings_status.
  const lastRound = S.rounds.filter(r => r.phase_type === 'SWISS' && r.standings_status === 'GENERATED').at(-1);
  const latest = lastRound ? (S.standings[lastRound.id] || []).find(p => p.id === pid) : null;
  if (!latest) return '';

  const ues    = latest.user_event_status;
  const handle = ues.best_identifier || latest.player.best_identifier;
  const real   = latest.player.best_identifier;
  const active = ues.registration_status === 'COMPLETE';

  const ev  = S.event;
  const cut = getTopCut();
  const { totalRounds, totalPlayers } = eventTotals();
  const liveRound = S.rounds.find(r => r.status === 'IN_PROGRESS' && r.pairings_status === 'GENERATED');

  const lines = [];
  lines.push(`PACTOMETRO — Tournament summary for ${handle}${real !== handle ? ` (${real})` : ''}`);
  lines.push('');
  lines.push(`Event: ${ev.name}`);
  lines.push(`Format: ${ev.gameplay_format?.name || ev.event_format}${ev.store ? ` · ${ev.store.name}` : ''}`);
  lines.push(`Field: ${totalPlayers} players · ${cut ? `Top ${cut} cut` : 'no cut configured'}`);
  lines.push(`Round: ${lastRound.round_number} of ${totalRounds} (Swiss)${liveRound ? ` — R${liveRound.round_number} in progress` : ''}`);
  lines.push('');
  lines.push('CURRENT STANDING');
  lines.push(`Rank #${latest.rank} · Record ${latest.record} · ${latest.points} pts · OMW ${fmtOmw(latest.opponent_match_win_percentage)} · GW ${fmtOmw(latest.game_win_percentage)} · ${active ? 'ACTIVE' : 'ELIMINATED'}`);
  lines.push('');
  lines.push('ROUND-BY-ROUND');
  for (const h of buildHistory(pid)) lines.push(_historyLine(h));
  lines.push('');

  if (scenario) {
    const round = S.rounds.find(r => r.id === roundId);
    const swiss = swissRounds();
    const nextRoundNum = swiss[swiss.findIndex(r => r.id === roundId) + 1]?.round_number ?? (round?.round_number ?? 0) + 1;
    lines.push(`NEXT ROUND (R${nextRoundNum}) PROJECTION — if I...`);
    for (const [key, label] of [['W', 'WIN'], ['D', 'DRAW'], ['L', 'LOSE']]) {
      const res  = scenario[key];
      const rank = res.p5 === res.p95 ? `#${res.p5}` : `#${res.p5}–${res.p95}`;
      lines.push(`  ${label} → ${res.projPts} pts · rank ${rank} · ${verdictText(res, cut)}${cut ? ` (${pctText(res, cut)} into Top ${cut})` : ''}`);
    }
  } else {
    const inCut = cut != null && latest.rank <= cut;
    lines.push(cut
      ? `Swiss rounds are complete — final rank #${latest.rank}, ${inCut ? 'made' : 'missed'} the Top ${cut} cut.`
      : `Swiss rounds are complete — final rank #${latest.rank}. No cut was configured.`);
  }

  lines.push('');
  lines.push('---');
  lines.push('Based on this, what should I be aiming for in my next round — play for the win, or is a draw good enough to feel safe? Any other advice given how the rest of the standings look?');

  return lines.join('\n');
}
