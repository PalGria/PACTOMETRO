#!/usr/bin/env node
// Headless smoke test of the app-side wiring (adapter + simulation panel)
// using the fixture event. Stubs the handful of DOM calls the modules need.
//
//   node scripts/smoke-ui.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir  = join(root, 'test', 'fixtures', 'event-515727');
const event     = JSON.parse(readFileSync(join(dir, 'event.json'), 'utf8'));
const standings = JSON.parse(readFileSync(join(dir, 'standings.json'), 'utf8'));
const matches   = JSON.parse(readFileSync(join(dir, 'matches.json'), 'utf8'));

// ── minimal DOM stub ──
const els = {};
const mk = id => ({
  id, innerHTML: '', textContent: '', style: {}, checked: false, value: '', children: [],
  appendChild(c) { this.children.push(c); },
  classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
  // Row-wiring loops (standings.js/overview.js) call these on the container
  // element; returning nothing to iterate is fine — these checks read the
  // rendered HTML string instead of querying a real DOM.
  querySelectorAll: () => [],
  querySelector: () => null,
});
globalThis.document = {
  getElementById: id => (els[id] ||= mk(id)),
  createElement: () => mk('el'),
  querySelectorAll: () => [],
};
globalThis.window = { location: { pathname: '/' }, innerWidth: 1400 };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
els['top-cut-input'] = mk('top-cut-input'); els['top-cut-input'].value = '8';
els['no-cut-cb'] = mk('no-cut-cb');

const { default: S } = await import('../js/state.js');
const { projectRound, validateLoadedEvent, futureSwissRounds, activeIdsAfter, stateAfterRound, defaultViewRound } = await import('../js/engine/adapter.js');
const { tierBounds, deterministicBounds, pactWindow, pactBound, pactSet, simulatePendingRound } = await import('../js/engine/montecarlo.js');
const { renderSimulation, getScenarioResults } = await import('../js/ui/simulation.js');
const { renderStandings, setSearchQuery } = await import('../js/ui/standings.js');

S.event = event;
S.rounds = event.tournament_phases.flatMap(ph => ph.rounds.map(r => ({ ...r, phase_name: ph.phase_name, phase_type: ph.round_type })));
S.standings = standings;
S.matches = matches;

let failed = false;
const check = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) failed = true; };

// 1. self-check at load
check(validateLoadedEvent().ok, 'validateLoadedEvent reproduces API standings');

// 2. exact projection of a completed round equals the API standings of that round
const swiss = S.rounds.filter(r => r.phase_type === 'SWISS');
for (const r of swiss) {
  const proj = projectRound(r.id, {});
  const api = standings[r.id];
  const bad = proj.filter(p => { const a = api.find(x => x.id === p.id); return !a || a.points !== p.projPts || Math.abs(a.opponent_match_win_percentage - p.omw) > 1e-4; });
  // rank differences are acceptable only between rows with identical keys (API orders exact ties arbitrarily)
  const key = p => `${p.projPts}|${p.omw.toFixed(8)}|${p.gw.toFixed(8)}|${p.ogw.toFixed(8)}`;
  const byRank = Object.fromEntries(proj.map(p => [p.projRank, p]));
  const rankBad = proj.filter(p => { const apiRank = api.find(x => x.id === p.id).rank; return apiRank !== p.projRank && key(byRank[apiRank]) !== key(p); }).length;
  check(bad.length === 0 && rankBad === 0 && proj.every(p => !p.unknown), `projectRound R${r.round_number}: pts/OMW/rank match API (${proj.length} rows)`);
}

// 3. partial picks: pretend R5 is live with no results, pick two tables
const r5 = swiss.at(-1);
const savedR5 = S.matches[r5.id];
S.matches[r5.id] = savedR5.map(m => ({ ...m, winning_player: null, match_is_intentional_draw: false, match_is_unintentional_draw: false, status: 'IN_PROGRESS' }));
const r5round = S.rounds.find(r => r.id === r5.id);
r5round.standings_status = 'NOT_GENERATED';
r5round.status = 'IN_PROGRESS';
const picks = { [savedR5[0].id]: 'W1', [savedR5[1].id]: 'D' };
const partial = projectRound(r5.id, picks);
const t0 = savedR5[0], t1 = savedR5[1];
const row = id => partial.find(p => p.id === id);
check(row(t0.players[0]).projPts === row(t0.players[0]).points + 3 && !row(t0.players[0]).unknown, 'pick W1 adds 3 pts and clears unknown');
check(row(t1.players[0]).projPts === row(t1.players[0]).points + 1 && row(t1.players[1]).projPts === row(t1.players[1]).points + 1, 'pick D adds 1 pt to both');
const pend = savedR5.find(m => !m.match_is_bye && !(m.id in picks));
check(row(pend.players[0]).unknown && row(pend.players[0]).projPts === row(pend.players[0]).points, 'unpicked table stays unknown with base points');
check(partial.every(p => p.rank != null), 'base rank present for every row (previous standings)');

// 4. Monte Carlo inputs from the live state (R4 standings, R5 pairings known, no results)
const r4 = swiss.at(-2);
const fut = futureSwissRounds(r4.id);
check(fut.length === 1 && fut[0] && fut[0].pairs.length === 12 && Object.keys(fut[0].locked).length === 0, 'futureSwissRounds: R5 known pairings, nothing locked');
check(activeIdsAfter(r4.id).length === 24, 'activeIdsAfter: 24 players paired in R5');

// 5. simulation panel renders and resolves
S.simRound = r4.id;
const me = standings[r4.id].find(p => p.rank === 5); // 9-pt player
S.activeId = me.id;
renderSimulation(me.id);
check(els['sim-rows'].innerHTML.includes('sim-spinner'), 'placeholder rows rendered synchronously');
await new Promise(res => setTimeout(res, 10));
const html = els['sim-rows'].innerHTML;
check(html.includes('sim-verdict lock') && html.includes('100%'), 'WIN row is LOCKED at 100%');
check(/DRAW[\s\S]*?sim-prob">(100|9\d|>99)%/.test(html), 'DRAW row shows a high probability for a 9-pt player');
check(!html.includes('sim-spinner'), 'no placeholders left');
check(els['sim-note'].textContent.includes('samples'), 'note reports sample count');
console.log('\n' + html.replace(/\s+/g, ' ').slice(0, 900));

// 5b. Reviewing an OLD round of an event that has since moved on: a later
// round whose pairings are published but has no result yet is genuinely
// simulated (no hindsight); a later round where MY result is already
// recorded gets replayed, not sampled — the banner must flag only that one.
// (R5's result was wiped by check 3 above and isn't restored until the end
// of this script, so at this point only R4 — not R5 — actually qualifies.)
{
  const r2 = swiss.at(-4); // R2 — R3 is the hypothetical, R4 already has a real result
  S.simRound = r2.id;
  const me2 = standings[r2.id][0];
  S.activeId = me2.id;
  renderSimulation(me2.id);
  await new Promise(res => setTimeout(res, 10));
  const html2 = els['sim-rows'].innerHTML;
  check(html2.includes('sim-hindsight'), 'renderSimulation(): hindsight banner shown when a later round already has my real result');
  check(html2.includes('R4') && html2.includes('R3'),
    'renderSimulation(): hindsight banner names the already-played round (R4) and the actual hypothetical (R3)');
  check(!/R4,\s*R5|R5.*already/.test(html2),
    'renderSimulation(): R5 is NOT flagged as hindsight — its result is still genuinely unknown at this point');
  check(els['sim-note'].textContent.includes('already played'),
    'renderSimulation(): note no longer claims a fully-known future round is just "simulated"');
}

// 6. defaultViewRound() picks the live round (R5, still live from check 3)
check(defaultViewRound() === r5.id, 'defaultViewRound() picks the live round when one exists');

// 7. renderStandings() falls back to a live projection for the selected round
S.viewRound = r5.id;
renderStandings();
const standingsHtml = els['s-body'].innerHTML;
check(els['s-live-note'].style.display === '', '#s-live-note shown during a live projection');
check(/~\d+\?/.test(standingsHtml), 'renderStandings() marks an undecided player with ~rank?');
check(standingsHtml.includes(`data-id="${pend.players[0]}"`), 'roster still lists a player from the live round');
S.viewRound = r4.id;
renderStandings();
check(els['s-live-note'].style.display === 'none', '#s-live-note hidden for a completed round');

// 7b. player search filters the roster by handle
setSearchQuery('Mr.B');
check(els['s-body'].innerHTML.includes('Mr.B') && !els['s-body'].innerHTML.includes('data-id="' + standings[r4.id].find(p => p.user_event_status?.best_identifier !== 'Mr.B').id + '"'),
  'setSearchQuery(): roster narrows to the matching handle');
setSearchQuery('this player does not exist');
check(els['s-table'].style.display === 'none' && els['s-empty'].textContent.includes('No players match'),
  'setSearchQuery(): no-match state shown for an unknown query');
setSearchQuery('');
check(els['s-table'].style.display === '', 'setSearchQuery(\'\'): clearing the query restores the full roster');

// 8. tierBounds: absoluteWorst never improves as basePts drops (more losses = never easier)
{
  const state2     = stateAfterRound(r4.id);
  const activeIds2 = activeIdsAfter(r4.id);
  const future2    = futureSwissRounds(r4.id);
  let prevWorst = 0, monotone = true;
  for (let losses = 0; losses <= 4; losses++) {
    const basePts = 3 * (4 - losses);
    const b = tierBounds({ state: state2, activeIds: activeIds2, futureRounds: future2, basePts, cut: 8 });
    if (b.absoluteWorst < prevWorst) monotone = false;
    prevWorst = b.absoluteWorst;
  }
  check(monotone, 'tierBounds: absoluteWorst is monotonically non-decreasing as losses increase');
  // 10 pts + winning R5 (13) is LOCKED for Top 8 — matches the real per-player
  // Monte Carlo result for the round's top scorer (see simulation.js's own
  // WIN-scenario check above, same 10-pt player, same LOCK verdict).
  const highTier = tierBounds({ state: state2, activeIds: activeIds2, futureRounds: future2, basePts: 13, cut: 8 });
  check(highTier.locked === true, 'tierBounds: 13 pts with R5 known pairings is LOCKED for Top 8');
  const lowTier = tierBounds({ state: state2, activeIds: activeIds2, futureRounds: future2, basePts: 0, cut: 8 });
  check(lowTier.locked === false && lowTier.absoluteWorst > 8, 'tierBounds: 0 pts is nowhere near locked for Top 8');
}

// 9. pactWindow: the flexible per-length rule
check(pactWindow(3) === 0 && pactWindow(4) === 2 && pactWindow(7) === 2 && pactWindow(8) === 3 && pactWindow(9) === 3,
  'pactWindow: 0 below 4 rounds, 2 up to 7, 3 from 8 up');

// 10. pactBound at the final round (k=1, known pairings) must exactly match
// deterministicBounds('D') — both model "I draw this one remaining round",
// just via two independently-written code paths. Cross-checking a few real
// players catches a regression in either one.
{
  const state4     = stateAfterRound(r4.id);
  const activeIds4 = activeIdsAfter(r4.id);
  const future4    = futureSwissRounds(r4.id);
  const sample = [...standings[r4.id]].sort((a, b) => a.rank - b.rank).slice(0, 12);
  let allMatch = true;
  for (const p of sample) {
    const pb = pactBound({ state: state4, me: p.id, activeIds: activeIds4, futureRounds: future4, cut: 8 });
    const db = deterministicBounds({ state: state4, me: p.id, activeIds: activeIds4, futureRounds: future4, scenario: 'D', cut: 8 });
    // pactBound's `rank` and deterministicBounds's `absoluteWorst` are the
    // same quantity (1 + count of players who could still catch me) — both
    // already include the "+1", so they're compared directly, not offset.
    if (pb.rank !== db.absoluteWorst || pb.pactLocked !== db.locked) allMatch = false;
  }
  check(allMatch, 'pactBound at k=1 matches deterministicBounds(D) exactly (same math, two code paths)');
}

// 11. pactBound/pactSet two rounds out (R3): the two 9-pt co-leaders are
// pact-locked for Top 8 — matches what actually happened (they finished
// #1 and #2 after drawing out).
{
  const r3 = swiss.at(-3);
  const state3     = stateAfterRound(r3.id);
  const activeIds3 = activeIdsAfter(r3.id);
  const future3    = futureSwissRounds(r3.id);
  check(future3.length === 2, 'two Swiss rounds remain after R3 in this fixture');
  const leaders = standings[r3.id].filter(p => p.points === 9).map(p => p.id);
  check(leaders.length === 2, 'exactly two players are tied for the lead after R3');
  for (const id of leaders) {
    const pb = pactBound({ state: state3, me: id, activeIds: activeIds3, futureRounds: future3, cut: 8 });
    check(pb.pactLocked === true, `pactBound: R3 co-leader ${id} is pact-locked for Top 8 with 2 rounds left`);
  }
  const locked = pactSet({ state: state3, activeIds: activeIds3, futureRounds: future3, cut: 8 });
  check(leaders.every(id => locked.has(id)) && locked.size === 2, 'pactSet finds exactly the two pact-locked leaders');
  const midPack = standings[r3.id].find(p => p.points === 7);
  const pbMid = pactBound({ state: state3, me: midPack.id, activeIds: activeIds3, futureRounds: future3, cut: 8 });
  check(pbMid.pactLocked === false, 'pactBound: a 7-pt player after R3 is not pact-locked for Top 8');
}

// 12. simulatePendingRound: one-round-only Monte Carlo over pending tables —
// the primitive behind the round simulator's P(cut) column. Every sample
// puts exactly `cut` players in the cut, so probabilities across the whole
// field must sum to `cut` regardless of the fixture (no sampling noise).
{
  const state5 = stateAfterRound(r4.id); // == stateBeforeRound(r5.id)
  const known5 = futureSwissRounds(r4.id)[0]; // R5 pairings, nothing locked
  const field5 = [...new Set([...standings[r4.id].map(p => p.id), ...activeIdsAfter(r4.id)])];
  const pcut = simulatePendingRound({
    state: state5, pairs: known5.pairs, byeId: known5.byeId, locked: known5.locked,
    field: field5, cut: 8, samples: 4000,
  });
  const total = field5.reduce((sum, id) => sum + (pcut[id] || 0), 0);
  check(Math.abs(total - 8) < 1e-9, 'simulatePendingRound: probabilities across the field sum exactly to the cut size');
  check(field5.every(id => pcut[id] >= 0 && pcut[id] <= 1), 'simulatePendingRound: every probability is in [0,1]');
  const sorted = [...standings[r4.id]].sort((a, b) => a.rank - b.rank);
  const leader = sorted[0], last = sorted.at(-1);
  check(pcut[leader.id] > pcut[last.id], 'simulatePendingRound: the R4 leader outranks R4 last place in R5 cut odds');
}

// restore
S.matches[r5.id] = savedR5;

// 12b. R4 -> R5 simulation once R5's real results are back (the exact case
// a user spotted: reviewing the final Swiss round of an event that already
// finished shows flat 0%/100% verdicts with no caveat, because everyone
// else's R5 result is already real — only the forced pick is hypothetical).
{
  const state5b     = stateAfterRound(r4.id);
  const activeIds5b = activeIdsAfter(r4.id);
  const future5b     = futureSwissRounds(r4.id);
  check(future5b.length === 1 && Object.keys(future5b[0].locked).length > 0,
    'futureSwissRounds: R5 has real locked results again after the restore');

  S.simRound = r4.id;
  const me5b = standings[r4.id].find(p => p.rank === 5);
  S.activeId = me5b.id;
  renderSimulation(me5b.id);
  await new Promise(res => setTimeout(res, 10));
  const html5b = els['sim-rows'].innerHTML;
  check(html5b.includes('sim-hindsight') && html5b.includes('already been played for everyone else'),
    'renderSimulation(): forcing the final Swiss round flags that the rest of the field is already decided');
}

// 13. renderOverview(): the Overview tab's dashboard — static cut
// calculator, Top-N snapshot, and the followed-players panel — renders
// without crashing and shows the expected pieces.
{
  const { renderOverview, followedColorClass } = await import('../js/ui/overview.js');
  renderOverview();
  const ovHtml = els['ov-root'].innerHTML;
  check(ovHtml.includes('Top cut') && ovHtml.includes('Calculator') && ovHtml.includes('Bracket'),
    'renderOverview(): Top cut panel present with Calculator/Bracket sub-tabs (event has an elimination phase)');
  check(ovHtml.includes('~Players'), 'renderOverview(): static cut table (default sub-tab) has the expected-count column');
  check(/Top \d+/.test(ovHtml), 'renderOverview(): top-N panel title shows a cut size');
  check(ovHtml.includes('Followed players'), 'renderOverview(): followed players panel present');

  // followedColorClass: the gold/green/red tiers for the Followed Players
  // rank number, against three real R4 records (Top 8 cut, R5 the only
  // round left) — a pact-locked leader, a player only safe by winning, and
  // one already mathematically out.
  const r4sorted = [...standings[r4.id]].sort((a, b) => a.rank - b.rank);
  const leader = r4sorted[0], midpack = r4sorted[4], last = r4sorted.at(-1);
  const [leaderRes, midRes, lastRes] = await Promise.all(
    [leader, midpack, last].map(p => getScenarioResults(p.id, r4.id, 8)));
  check(followedColorClass(leaderRes) === 'ov-rank-locked', 'followedColorClass(): pact-locked leader (drawing out is enough) is gold');
  check(followedColorClass(midRes) === 'ov-rank-safe', 'followedColorClass(): safe-only-by-winning mid-pack player is green');
  check(followedColorClass(lastRes) === 'ov-rank-out', 'followedColorClass(): mathematically-out last place is red');
  check(followedColorClass(null) === '', 'followedColorClass(): no simulation (e.g. Swiss over) leaves the default color');
}

// 14. buildBracket(): the fixture actually ran a Top 8 (quarterfinals →
// semifinals → final) — the bracket must assemble from those real
// pairings/results, not fall back to predicted seeding.
{
  const { buildBracket } = await import('../js/ui/bracket.js');
  const bracket = buildBracket();
  check(bracket && bracket.size === 8, 'buildBracket(): bracket size read from rank_required_to_enter_phase');
  check(bracket.rounds.length === 3, 'buildBracket(): 3 rounds for a field of 8 (QF/SF/F)');
  check(bracket.rounds.map(r => r.label).join(',') === 'Quarterfinals,Semifinals,Final',
    'buildBracket(): round labels are Quarterfinals/Semifinals/Final');
  check(bracket.rounds[0].matches.length === 4 && bracket.rounds[2].matches.length === 1,
    'buildBracket(): 4 quarterfinal matches narrowing down to 1 final');
  check(bracket.rounds[0].matches.every(m => m.status !== 'tbd' && m.status !== 'predicted'),
    'buildBracket(): quarterfinals use the event\'s real pairings, not a placeholder');
  // The fixture's real final has no recorded winner (both finalists share
  // an identical record — co-champions) — a genuine "completed but no
  // winner" case the bracket must distinguish from "not paired yet".
  const final = bracket.rounds[2].matches[0];
  check(final.status === 'split' && final.winner == null, 'buildBracket(): a completed match with no recorded winner reads as split, not pending');
  const semis = bracket.rounds[1].matches;
  check(semis.every(m => m.status === 'decided' && m.winner != null), 'buildBracket(): both semifinals have real, decided winners from the API');
}

// 15. buildLlmSummary(): plain-text recap for the detail panel's copy button.
{
  const { buildLlmSummary } = await import('../js/ui/llmSummary.js');

  const scenario4 = await getScenarioResults(me.id, r4.id, 8);
  const summary = buildLlmSummary(me.id, r4.id, scenario4);
  check(typeof summary === 'string' && summary.length > 0, 'buildLlmSummary(): returns non-empty text');
  check(!/<[a-z]+[^>]*>/i.test(summary), 'buildLlmSummary(): plain text, no HTML markup');
  check(summary.includes(S.event.name), 'buildLlmSummary(): includes event name');
  check(['R1', 'R2', 'R3', 'R4'].every(r => summary.includes(r)), 'buildLlmSummary(): lists round-by-round history');
  check(['WIN', 'DRAW', 'LOSE'].every(w => summary.includes(w)), 'buildLlmSummary(): includes all three projected scenarios when a future round exists');
  // This fixture's elimination-phase rounds (R6-R8) also have generated
  // standings (the event is complete) — "Round: X of 5" must stay anchored
  // to the last SWISS round, not whichever round (any phase) happens to
  // have standings, or it reads as nonsense like "Round: 8 of 5".
  check(/Round: [1-5] of 5 \(Swiss\)/.test(summary), 'buildLlmSummary(): "Round: X of Y" uses the Swiss total, not an elimination-round number');

  // Swiss complete: no future rounds after the last Swiss round.
  const rLast = swiss.at(-1);
  const scenarioDone = await getScenarioResults(me.id, rLast.id, 8);
  check(scenarioDone === null, 'sanity: no scenario projected once Swiss is over');
  const summaryDone = buildLlmSummary(me.id, rLast.id, scenarioDone);
  check(/complete/i.test(summaryDone), 'buildLlmSummary(): Swiss-complete case omits the projection block without crashing');

  // No cut configured.
  els['no-cut-cb'].checked = true;
  const summaryNoCut = buildLlmSummary(me.id, r4.id, scenario4);
  check(/no cut configured/i.test(summaryNoCut), 'buildLlmSummary(): notes when no cut is configured');
  els['no-cut-cb'].checked = false;
}

if (failed) { console.error('\nSMOKE TEST FAILED'); process.exit(1); }
console.log('\nsmoke OK');
