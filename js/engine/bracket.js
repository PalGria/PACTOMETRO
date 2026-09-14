// ── SINGLE-ELIMINATION BRACKET SEEDING ───────────
// Standard seeded bracket: round 1 pairs seed i vs seed (size+1-i) for
// i = 1..size/2 — 1v8, 2v7, 3v6, 4v5 for a cut of 8. Verified against a real
// event's actual quarterfinal/semifinal/final pairings in
// scripts/validate-engine.mjs (table order in the API matches this exactly).
//
// Every later round is decided by real results, not predictable from
// seeding alone (who wins each match determines who advances) — so this
// module only predicts round 1. Rounds 2+ are read from the API's own
// pairings once they exist (js/ui/bracket.js).
export function seedPairs(size) {
  const pairs = [];
  for (let i = 1; i <= size / 2; i++) pairs.push([i, size + 1 - i]);
  return pairs;
}

// Structural "who could reach this slot" labels per round, purely from
// bracket `size` — independent of any real results, so it's knowable
// before the event has published a single elimination pairing. Level 0 is
// the round-1 seed pairs formatted as "1v8". Level k>0 compounds the two
// level-(k-1) matches at index j and (m-1-j) that feed round k+1's match j
// — the same (j, m-1-j) merge that keeps seed 1 grouped with 4/5/8 and away
// from seed 2 (grouped with 3/6/7) until the final. Verified against a real
// event's actual bracket in scripts/validate-engine.mjs.
//
// levels[0] = ["1v8", "2v7", "3v6", "4v5"]
// levels[1] = ["1v8 / 4v5", "2v7 / 3v6"]        (who fills each semifinal)
// levels[2] = ["1v8 / 4v5 / 2v7 / 3v6"]         (who fills the final)
export function seedLabelLevels(size) {
  let labels = seedPairs(size).map(([a, b]) => `${a}v${b}`);
  const levels = [labels];
  while (labels.length > 1) {
    const m = labels.length;
    const next = [];
    for (let j = 0; j < m / 2; j++) next.push(`${labels[j]} / ${labels[m - 1 - j]}`);
    labels = next;
    levels.push(labels);
  }
  return levels;
}
