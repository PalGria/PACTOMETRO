#!/usr/bin/env node
// Validates js/engine against real API data stored in test/fixtures.
//
//   node scripts/validate-engine.mjs          → engine vs API standings (exit 1 on mismatch)
//   node scripts/validate-engine.mjs --mc     → also print Monte Carlo cut probabilities
//   node scripts/validate-engine.mjs --bench  → time the Monte Carlo

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createState, applyApiRound, validateAgainstStandings, matchResult, points } from '../js/engine/swiss.js';
import { simulateAll, staticCutTable } from '../js/engine/montecarlo.js';
import { seedPairs, seedLabelLevels } from '../js/engine/bracket.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

function loadFixture(name) {
  const dir = join(root, 'test', 'fixtures', name);
  const event     = JSON.parse(readFileSync(join(dir, 'event.json'), 'utf8'));
  const standings = JSON.parse(readFileSync(join(dir, 'standings.json'), 'utf8'));
  const matches   = JSON.parse(readFileSync(join(dir, 'matches.json'), 'utf8'));
  const rounds = event.tournament_phases.flatMap(ph => ph.rounds.map(r => ({ ...r, phase_type: ph.round_type })));
  return { event, rounds, standings, matches };
}

let failed = false;

for (const name of ['event-515727']) {
  const { event, rounds, standings, matches } = loadFixture(name);
  const swiss = rounds.filter(r => r.phase_type === 'SWISS');
  const ids = new Set();
  for (const rid in standings) for (const p of standings[rid]) ids.add(p.id);
  console.log(`\n${event.name} — ${ids.size} players, ${swiss.length} Swiss rounds`);

  const state = createState([...ids]);
  for (const r of swiss) {
    applyApiRound(state, matches[r.id]);
    const api = standings[r.id];
    if (!api) continue;
    const { mismatches, ties } = validateAgainstStandings(state, api);
    const ok = mismatches.length === 0;
    if (!ok) failed = true;
    console.log(`  R${r.round_number}: ${ok ? 'OK ' : 'FAIL'}  ${api.length} rows, ${ties} exact ties${mismatches.length ? ', ' + mismatches.length + ' mismatches' : ''}`);
    for (const m of mismatches.slice(0, 10)) console.log('     ', JSON.stringify(m));
  }

  if (args.has('--mc') || args.has('--bench')) {
    const cut = event.tournament_phases.find(p => p.rank_required_to_enter_phase)?.rank_required_to_enter_phase ?? 8;
    const nm = {};
    for (const p of standings[swiss[0].id]) nm[p.id] = p.user_event_status?.best_identifier || p.player?.best_identifier;
    const finalRank = Object.fromEntries(standings[swiss.at(-1).id].map(p => [p.id, p.rank]));

    const knownRound = r => {
      const pairs = [], locked = {};
      let byeId = null;
      for (const m of matches[r.id] || []) {
        const res = matchResult(m);
        if (res === 'BYE') { byeId = m.players[0]; continue; }
        const [a, b] = m.players;
        pairs.push([a, b]);
      }
      return { pairs, byeId, locked }; // results deliberately not locked: we test prediction
    };

    for (const baseIdx of args.has('--bench') ? [swiss.length - 3] : [swiss.length - 3, swiss.length - 2]) {
      const baseRound = swiss[baseIdx];
      const st = createState([...ids]);
      for (let i = 0; i <= baseIdx; i++) applyApiRound(st, matches[swiss[i].id]);
      const activeIds = (matches[swiss[baseIdx + 1].id] || []).flatMap(m => m.players.filter(x => x != null));
      const future = swiss.slice(baseIdx + 1).map((r, i) => (i === 0 ? knownRound(r) : null));

      console.log(`\n  Standings after R${baseRound.round_number} → next round pairings known, ${future.length} round(s) left, Top ${cut}`);
      console.log('  ' + 'player'.padEnd(20) + ' pts | WIN            | DRAW           | LOSS           | final');
      const rows = [...standings[baseRound.id]].sort((a, b) => a.rank - b.rank).slice(0, args.has('--bench') ? 3 : 14);
      const t0 = Date.now();
      for (const p of rows) {
        const res = simulateAll({ state: st, me: p.id, activeIds, futureRounds: future, cut, samples: 1500 });
        const fmt = r => `${(r.pCut * 100).toFixed(0).padStart(3)}% #${r.p5}-${r.p95}${r.locked ? ' LOCK' : r.out ? ' OUT' : ''}`.padEnd(14);
        console.log('  ' + nm[p.id].padEnd(20) + String(points(st[p.id])).padStart(4) + ` | ${fmt(res.W)} | ${fmt(res.D)} | ${fmt(res.L)} | #${finalRank[p.id]}`);
      }
      if (args.has('--bench')) console.log(`  ${rows.length * 3 * 1500} samples in ${Date.now() - t0} ms`);
    }
  }

  // ── seedPairs vs the real elimination bracket ──
  // event-515727 actually ran quarterfinals/semifinals/final — cross-check
  // that the seeding formula reproduces the real round-1 pairings (1v8,
  // 2v7, 3v6, 4v5), the concrete answer to "how does round 1 work".
  {
    const elim = rounds.filter(r => r.phase_type !== 'SWISS').sort((a, b) => a.round_number - b.round_number);
    const phase = event.tournament_phases.find(p => p.round_type !== 'SWISS');
    if (elim.length && phase?.rank_required_to_enter_phase) {
      const size = phase.rank_required_to_enter_phase;
      const swissLast = swiss.at(-1);
      const seedRank = new Map((standings[swissLast.id] || []).map(p => [p.rank, p.id]));

      const r1Matches = [...(matches[elim[0].id] || [])].sort((a, b) => a.order - b.order);
      const predicted = seedPairs(size);
      let seedOk = r1Matches.length === predicted.length;
      for (let i = 0; seedOk && i < predicted.length; i++) {
        const [sa, sb] = predicted[i];
        const [pa, pb] = r1Matches[i].players;
        const want = new Set([seedRank.get(sa), seedRank.get(sb)]);
        seedOk = want.has(pa) && want.has(pb);
      }
      if (!seedOk) failed = true;
      console.log(`  seedPairs: ${seedOk ? 'OK ' : 'FAIL'}  round-1 bracket pairings (seed i vs seed size+1-i) match the real event`);
    }
  }
}

// ── staticCutTable: the overview's "never changes" top cut calculator ──
// Pure combinatorics (no fixture data needed), but exercised against a real
// event's shape (5 rounds, 29 players) as a stable regression anchor.
{
  const full = staticCutTable({ totalRounds: 5, totalPlayers: 29, cut: null });
  const totalCount = full.reduce((s, r) => s + r.count, 0);
  const ok1 = Math.abs(totalCount - 29) < 1e-9;
  if (!ok1) failed = true;
  console.log(`  staticCutTable: ${ok1 ? 'OK ' : 'FAIL'}  expected counts across every record sum to the field size`);

  let prevBest = 0, prevWorst = 0, monotone = true;
  for (const r of full) {
    if (r.best < prevBest || r.absoluteWorst < prevWorst) monotone = false;
    prevBest = r.best; prevWorst = r.absoluteWorst;
  }
  if (!monotone) failed = true;
  console.log(`  staticCutTable: ${monotone ? 'OK ' : 'FAIL'}  bounds never improve for a worse (fewer-win) record`);

  const ok2 = full[0].wins === 5 && full[0].best === 1; // nobody can out-win a perfect record
  if (!ok2) failed = true;
  console.log(`  staticCutTable: ${ok2 ? 'OK ' : 'FAIL'}  a perfect record is always rank-1 best-case`);

  const cut8 = staticCutTable({ totalRounds: 5, totalPlayers: 29, cut: 8 });
  const byRecord = Object.fromEntries(cut8.map(r => [`${r.wins}-${r.losses}`, r]));
  const ok3 = byRecord['4-1']?.locked === true && byRecord['2-3']?.out === true;
  if (!ok3) failed = true;
  console.log(`  staticCutTable: ${ok3 ? 'OK ' : 'FAIL'}  Top 8 of 29 over 5 rounds: 4-1 locked, 2-3 out`);
}

// ── seedLabelLevels: the bracket "shape" answer ──
// Pure combinatorics, no fixture needed. For a Top 8: seed 1 is grouped
// with 4/5/8 in the top half and never meets seed 2 (grouped with 3/6/7)
// before the final — this is the concrete answer to "so seed 1 never plays
// seed 2 until the final, right?".
{
  const levels = seedLabelLevels(8);
  const ok1 = JSON.stringify(levels[0]) === JSON.stringify(['1v8', '2v7', '3v6', '4v5']);
  const ok2 = JSON.stringify(levels[1]) === JSON.stringify(['1v8 / 4v5', '2v7 / 3v6']);
  const ok3 = levels[2][0] === '1v8 / 4v5 / 2v7 / 3v6';
  const ok = ok1 && ok2 && ok3;
  if (!ok) failed = true;
  console.log(`  seedLabelLevels: ${ok ? 'OK ' : 'FAIL'}  seed 1 (with 4/5/8) stays clear of seed 2 (with 3/6/7) until the final`);
}

if (failed) { console.error('\nENGINE VALIDATION FAILED'); process.exit(1); }
console.log('\nengine OK');
