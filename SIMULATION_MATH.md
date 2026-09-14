# Simulation Math

Pactometro has two simulation features: the **Player Simulation** (per-player cut projection) and the **Round Simulator** (full-field projected standings). Both run on the exact Swiss engine in `js/engine/`. Everything below is verified against real API data by `npm test` (`scripts/validate-engine.mjs`, fixture `test/fixtures/event-515727`).

---

## 1. Points and tiebreakers (verified)

| Result | Points |
|--------|--------|
| Win    | 3      |
| Draw   | 1      |
| Loss   | 0      |
| Bye    | 3 (counts as a 2-0 win) |

Tiebreakers in order: **OMW%**, **GW%**, **OGW%**. The API rounds each to 8 decimals before comparing; exact ties are ordered arbitrarily.

```
MWP(p)  = (3·W + D) / (3·M)              W includes byes, M = matches incl. byes
OMW%(p) = mean over real opponents of max(0.33, MWP(opp))
          byes are not opponents; no opponents → 0.33
GW%(p)  = max(0.33, (3·GW + GD) / (3·G))  a bye adds GW += 2, G += 2
OGW%(p) = mean over real opponents of GW%(opp); no opponents → 0.33
```

Notes learned from the data:
- The floor is `0.33`, not `1/3`. A player at 0-0-1 has MWP 0.3333 (above the floor), a player at 0-1 has 0.33.
- An intentional draw is stored as `games_drawn = 3`, an unintentional draw as `games_drawn = 1` (plus any games actually won). Both count 1 match point.
- `registration_status` reflects the *current* status, so a finished event shows everyone as `ELIMINATED`. Active players for future rounds are taken from the next published pairings when available.

Implementation: `computeTiebreaks`, `rankPlayers`, `compareRows` in `js/engine/swiss.js`.

---

## 2. Round Simulator and live projections

`projectRound(roundId, picks)` in `js/engine/adapter.js`:

1. Build the engine state from every confirmed Swiss result of rounds **before** `roundId`.
2. Apply the API results of `roundId` (locked) and the user's picks for pending tables.
3. Recompute all four keys and sort.

With every table decided the projected table is exact, including tiebreakers, because the whole opponent graph is known. Players with an undecided table are flagged `unknown`. The `Δ` column compares the projected rank with the rank in the latest generated standings before the round.

---

## 3. Player Simulation

For the selected standings round R and each scenario for my next match (WIN / DRAW / LOSE), the app reports:

- **P(cut)** — probability of finishing the Swiss inside the top cut, from a Monte Carlo of the remaining rounds (`js/engine/montecarlo.js`).
- **Rank band** — 5th to 95th percentile of my final Swiss rank across samples.
- **Deterministic verdicts** — LOCKED / OUT are proven, not sampled.

### 3.1 Sampling one future

For each sample:

1. Start from the confirmed state after round R.
2. For the next round: if its pairings are published, use them and the results already reported; otherwise simulate Swiss pairings (`js/engine/pairing.js`: sort by points, random order within a bracket, pair top-down avoiding rematches, bye to the lowest player without one).
3. Force my result according to the scenario. Draw is recorded as an intentional draw (3 drawn games); a win as 2-0 or 2-1.
4. Every other table: intentional draw with probability `pIdraw = 0.9` if **both players are locked into the cut with a draw** (final round only, see 3.3); otherwise unintentional draw with probability `pDraw = 0.04`, else a 50/50 win.
5. Later rounds: simulated pairings, same outcome model.
6. Recompute the full standings and record my rank.

Default 2000 samples with a fixed seed, so re-rendering does not change the numbers. Standard error at P = 0.5 is about ±1.1 points.

### 3.2 Deterministic bounds

```
projPts   = myPts + delta                 delta = 3 / 1 / 0
myCeiling = projPts + 3 · roundsAfterNext
best      = 1 + #{others with pts > myCeiling}
OUT       = best > cut
```

`absoluteWorst` counts players who can finish with **≥ projPts** (ties against me):

- Final round with published pairings: per table, the maximum over {A wins, B wins, draw} of players reaching projPts; my opponent gets 0 / 1 / 3 depending on the scenario; the bye player +3; unpaired (dropped) players keep their points. Exact up to tiebreakers.
- Otherwise: every active player is assumed to gain 3 per remaining round (loose bound).

```
LOCKED = absoluteWorst <= cut
```

A row can be 100 % in the Monte Carlo and still not LOCKED: that means the cut depends on tiebreakers going the expected way.

### 3.3 Rational intentional draws

In the final round, a player X paired at table T is "locked with a draw" if, with X at pts+1 and X's partner at pts+1, the number of other players who can reach ≥ pts+1 (per-table maxima as in 3.2) is below the cut. When both players at a table are locked with a draw they ID with probability 0.9. Measured on event 515727: 5 of the 12 final-round matches were draws (3 intentional).

### 3.4 Verdict bands (UI)

| Verdict | Condition |
|---|---|
| OUT | `best > cut` (proven) |
| LOCKED | `absoluteWorst <= cut` (proven) |
| SAFE | P(cut) ≥ 95 % |
| LIKELY | 60 % ≤ P < 95 % |
| RISKY | 20 % ≤ P < 60 % |
| UNLIKELY | P < 20 % |

---

## 4. Pacts ("pactar": drawing out the rest of the event)

Swiss tournaments pair players with matching records against each other. That means, near the end of an event, a group of players tied on points will keep playing *each other*, not the rest of the field — so at most half of any such group can actually pick up a full win in a given round. This is the basis for a second, tighter bound than section 3.2's `absoluteWorst`, which pessimistically assumes *every* rival could win every remaining round.

### 4.1 Pact window

Drawing out is only a meaningful, provable plan near the end of a long-enough event:

```
pactWindow(totalSwissRounds):
  < 4 rounds  → 0 (never)
  4–7 rounds  → 2
  ≥ 8 rounds  → 3
```

### 4.2 Pact bound

`pactBound` computes the worst-case rank for a player (real or hypothetical, via `basePts`) who draws every one of the `k` remaining rounds, under standard Swiss pairing:

```
T = myPts + k                      (draws out: +1 per remaining round)
```

- **Round 0**, if pairings are published: exact per real table. My own table is a forced draw (my opponent gets +1). Every other table's three possible outcomes (W1/W2/draw) are tried and whichever sends the most players toward `T` is kept — the same per-table-maximum idea as section 3.2, just also allowing a draw to push *both* players over the line at once, which a decisive result cannot.
- **Every round after that** (or all `k` rounds, if no pairings are published yet): players tied on points are grouped, and each round `ceil(group size / 2)` of the group is allowed a win while the rest only draw or lose — repeated round by round. This is a safe upper bound, not a simulation: real Swiss software may split a group differently, but never lets more than that many players win out of a fully-tied group.
- Dropped players keep their current points forever.

```
pactLocked = cut != null && rank <= cut
```

`pactLocked` is proven **conditional on the event pairing by record as Swiss tournaments normally do** — unlike `LOCKED` (section 3.2), which holds under *any* pairing whatsoever. The UI labels the two differently for exactly this reason. At `k = 1` (the true final round, pairings known), `pactBound` reduces to exactly the same arithmetic as `deterministicBounds` with `scenario: 'D'` — verified to agree on real data in `scripts/smoke-ui.mjs`.

`pactSet` runs `pactBound` for every player near the top of the field and returns the ones already locked in purely by drawing out — the "pact watch" list shown on the overview dashboard once the event enters the pact window.

Measured on event 515727: after round 3 (2 Swiss rounds left, Top 8), the two players tied for the lead at 9 points were both pact-locked — and both went on to finish #1 and #2 after drawing out the rest of the event.

---

## 5. Known approximations

- Pairings beyond the next round are simulated; the real algorithm may pair differently inside a bracket.
- Win probability is 50/50. Swiss pairs similar records, so player strength changes little; see the plan (`docs/SIMULATION_PLAN.md`, phase 5).
- Intentional draws are modelled only when strictly rational.
- Drops are unknown until the next pairings are published.
- `pactBound`'s group relaxation (rounds beyond the first) is a safe upper bound, not the tightest possible one — it can occasionally say "not yet pact-locked" a round before a sharper analysis would; it never says "locked" incorrectly.
- Pact detection assumes the event pairs by record the normal Swiss way; a tournament that pairs differently (e.g. fully random) could let more players climb than `pactBound` allows for.
