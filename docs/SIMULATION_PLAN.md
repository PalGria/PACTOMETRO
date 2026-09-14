# Simulation accuracy plan

Status as of 2026-09-13. Phases 1–3 implemented; 4–6 pending.
Run `npm test` (alias of `node scripts/validate-engine.mjs`) after touching anything in `js/engine/`. Add `--mc` to print the Monte Carlo table, `--bench` to time it.

## 1. Diagnosis of the old model

The old `projectRank` (git history: `js/tournament.js` before this plan) produced verdicts from the current standings snapshot only. Measured on the real event 515727 (29 players, 5 Swiss rounds, Top 8) against a Monte Carlo with exact tiebreakers:

| Problem | Effect |
|---|---|
| `mayAbove` compared **my projected** points (after my next result) with everyone else's **current** points. | "SAFE" meant "I make the cut if every other player loses next round". After R3, 14 of the top 16 got SAFE for a draw; the real probability was ~48 %. LOSS was SAFE for players at 3–11 %. |
| `absAbove` assumed every rival gains +3 per remaining round, ignoring known pairings (one +3 per table). | On the final round the four 9-point players saw DRAW = RISKY (#1–10) with a real 99–100 % chance. The exact question "can I pact?" was unanswered. |
| DRAW OMW% fudge `R(R+2)/(R+1)² × 0.985`. | Arbitrary. OMW% can be recomputed exactly from the match graph. |
| Rank range `#best–#absoluteWorst`. | Typically #1–25: uninformative. |
| Tiebreak in `mayAbove` used only OMW%. Dropped players counted as able to gain points. | Wrong ordering inside a points tier. |
| Round simulator sorted by base OMW%. | Wrong order inside tiers even with every match picked. It also used the round's own standings as base for completed rounds, double counting results. |

## 2. Verified tiebreaker rules

Reproduced from `matches` for 5 rounds × 29 players, 0 mismatches (`scripts/validate-engine.mjs`). See `SIMULATION_MATH.md` §1 for the formulas. Key facts: bye counts as a win in the player's own MWP but is not an opponent; per-opponent floor 0.33 (not 1/3); intentional draws are stored as 3 drawn games; the API rounds tiebreakers to 8 decimals before ordering.

## 3. Phases

### Phase 1 — exact engine ✅
`js/engine/swiss.js`: state per player, `applyMatch`, `computeTiebreaks`, `rankPlayers`, `validateAgainstStandings`.
`js/engine/adapter.js`: builds engine input from `S`, `projectRound(roundId, picks)` for exact projected tables, `validateLoadedEvent()` runs after every load and warns in the console if the API disagrees.
Used by the round simulator, the live standings projection and the opponent pool.

### Phase 2 — Monte Carlo player simulation ✅
`js/engine/pairing.js`: Swiss pairing approximation (points brackets, random inside a bracket, no rematches, bye to the lowest player without one).
`js/engine/montecarlo.js`: `simulateScenario` forces my next result (W/D/L), samples every other table and every later round, recomputes the full standings per sample. Outputs P(cut), p5/p50/p95 rank, min/max. Known pairings and already-reported results are used when the next round is published.
Outcome model: 50/50 wins, 4 % unintentional draws, rational intentional draws in the final round (both players locked with a draw → 90 % ID). Seeded RNG so numbers are stable between renders.

### Phase 3 — deterministic bounds ✅
`deterministicBounds`: OUT (cannot reach the cut even winning out) and LOCKED (cut guaranteed with ties counted against me). On the final round with published pairings the LOCKED bound is pairing-aware: each table contributes at most one +3, or +1 to both. Earlier rounds keep the loose "everyone wins out" bound.

### Phase 4 — UI ✅
- Player simulation rows show P(cut) and the p5–p95 rank band, cached per (round, player, cut, confirmed-match-count, model knobs) in `js/ui/simulation.js`.
- Monte Carlo runs in a module Worker (`js/engine/worker.js` / `js/services/simWorker.js`) with a spinner on the pending cells, instead of blocking the main thread. Falls back to a synchronous call when `Worker` is unavailable (Node test harness) or if the worker errors.
- Round simulator shows a P(cut) column once at least one table is unpicked, via `simulatePendingRound` (`js/engine/montecarlo.js`) — samples only the still-pending tables of that one round (no pairing algorithm, no rounds beyond it), cached per (round, decided tables, cut, draw-rate knob) in `js/ui/roundSim.js`.
- Model knobs (unintentional draw rate, final-round rational intentional-draw rate) are exposed in a settings popover (gear icon next to the top-cut bar), persisted in `localStorage` via `getModelKnobs`/`saveModelKnobs` (`js/services/storage.js`), and invalidate both simulation caches on change.

### Phase 5 — strength model (pending, optional)
Replace 50/50 with a strength estimate (e.g. logistic on MWP difference, or Elo from match history across events). Swiss pairs similar records so the gain is small; measure before adopting.

### Phase 6 — validation corpus (pending)
Add more fixtures (larger fields, 6–9 rounds, byes late, drops) to `test/fixtures/`. Back-test verdict calibration: for every player-round, compare the predicted P(cut) with the observed outcome (Brier score). Keep `npm test` green.

## 4. Accuracy limits that remain
- Pairings for rounds beyond the next one are simulated, not known. The real algorithm may differ (top/bottom half pairing, tiebreak-ordered brackets).
- Intentional-draw behaviour is modelled as strictly rational. Real players also draw when merely "very likely" in, or refuse to draw.
- Drops between rounds are only known once the next pairings are published.
