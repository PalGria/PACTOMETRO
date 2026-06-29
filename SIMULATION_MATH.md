# Simulation Math

Pactometro has two simulation features: the **Player Simulation** (per-player cut projection) and the **Round Simulator** (full-field projected standings). This document explains the math behind both.

---

## 1. Points system

Disney Lorcana Swiss rounds use standard tournament points:

| Result | Points gained |
|--------|--------------|
| Win    | +3           |
| Draw   | +1           |
| Loss   | +0           |

Tiebreakers, in order of priority:
1. **OMW%** — Opponent Match Win percentage
2. **GW%** — Game Win percentage
3. **OGW%** — Opponent Game Win percentage

---

## 2. Player Simulation

Given a player's current standings after round R, the simulation projects how their rank would look after round R+1 for each of the three possible outcomes.

### 2.1 Projected points

```
projPts = currentPts + delta
```

Where `delta` is 3 (win), 1 (draw), or 0 (loss).

### 2.2 Remaining rounds

The simulation is always grounded in the Swiss phase structure, not raw round numbers. This matters when a tournament has multiple phases (e.g. Swiss → Top 8) where round numbering resets.

```
swissPos       = zero-based index of the selected round within the Swiss phase
myRemaining    = totalSwissRounds - swissPos - 2   (rounds I still play after R+1)
othersRemaining = totalSwissRounds - swissPos - 1  (rounds everyone else plays, including R+1)
```

`myRemaining` is what I can still gain after the simulated round.  
`othersRemaining` is what my opponents can still gain — this is the key asymmetry that produces rank bounds.

### 2.3 Rank bounds

For a given projected scenario, `projectRank` scans all other players' current standings and classifies each one into three counters:

```
myCeiling = projPts + myRemaining × 3   (maximum points I can ever reach)

defAbove  = players with P > myCeiling
mayAbove  = players with P > projPts, OR (P == projPts AND their OMW% > mine)
absAbove  = players with P + othersRemaining × 3 >= projPts
```

These produce three rank estimates:

| Bound          | Formula           | Meaning                                                              |
|----------------|-------------------|----------------------------------------------------------------------|
| **Best case**  | `defAbove + 1`    | Players I cannot mathematically catch; I beat everyone else          |
| **Likely worst** | `mayAbove + 1`  | Players currently ahead of me in points or tiebreakers               |
| **Absolute worst** | `absAbove + 1` | Players who could still reach my points by winning every remaining round |

The displayed rank range is `#best – #absoluteWorst`.

> **Why two different "worst"?** `mayAbove` uses the current standings snapshot (no future rounds modelled), so it underestimates how far others can climb — especially on the final Swiss round when everyone still has a match to play. `absAbove` is the true ceiling of how bad things can get.

### 2.4 OMW% adjustment for draws

A draw does not just reduce your points — it also lowers your OMW%. When you draw with an opponent, that opponent's own match win percentage drops slightly (they now have a draw on their record), which pulls down your opponent average.

The formula used:

```
OMW_draw = OMW_current × R(R + 2) / (R + 1)² × 0.985
```

Where R is the current round number.

**Derivation intuition:**  
Before round R+1, your OMW is the average MWP over R opponents. After the draw your OMW becomes an average over R+1 opponents, including your draw partner. The draw partner's MWP drops because of the draw itself. Assuming the partner's MWP is similar to yours:

```
OMW_new ≈ (R × OMW_current + partner_MWP_after_draw) / (R + 1)
```

The factor `R(R+2) / (R+1)²` captures this dilution. It is always less than 1 and approaches 1 as R grows, meaning:

- Early rounds (R=1): draw drops OMW by ~25%
- Mid rounds (R=5): drop is ~2.8%
- Late rounds (R=9): drop is ~1%

The additional `× 0.985` is a calibration constant: in Swiss, late-round opponents are typically high win-rate players (Swiss pairing bias), so the MWP drop from the draw partner hits harder than the symmetric model predicts.

The WIN and LOSS scenarios leave OMW unchanged because a win opponent's record is not affected, and the loss opponent won — their MWP goes up, but that actually helps you, so the model conservatively holds OMW flat.

### 2.5 Verdicts

After computing `best`, `worst`, and `absoluteWorst` against the configured top-cut threshold:

| Verdict    | Condition                            | Meaning                                                    |
|------------|--------------------------------------|------------------------------------------------------------|
| **OUT**    | `best > cut`                         | Even your best-case rank is outside the cut                |
| **LOCKED** | `absoluteWorst <= cut`               | You make cut regardless of all remaining match results     |
| **SAFE**   | `worst <= cut` (not final round)     | You're in under current standings; tiebreakers would need to go against you badly to miss |
| **RISKY**  | everything else                      | On the bubble — cut is achievable but not guaranteed       |

> **SAFE is suppressed on the final Swiss round.** On the last round everyone still plays, so `mayAbove` (which uses current point totals) underestimates how many players can jump above you. Only LOCKED is reliable when `othersRemaining == 1`.

---

## 3. Round Simulator

The Round Simulator lets you assign outcomes to individual matches and immediately see projected standings for the whole field.

### 3.1 Base standings

The simulator needs a starting point. It finds the nearest completed standings round at or before the selected round:

```
base = most recent round where standings_status == 'GENERATED' and round_index <= selected
```

This matters when simulating a live round that has not yet produced official standings — the base is the previous round's final standings.

### 3.2 Points projection

For each match, the simulator applies the picked outcome to the base point totals:

```
Win  → winner.pts += 3
Draw → both.pts   += 1
Loss → no change
```

Matches with locked server results (already reported by the API) are applied automatically and cannot be changed.

### 3.3 Ranking

After applying all picked outcomes, players are sorted by:

1. Projected points (descending)
2. OMW% from the base standings (descending) — as a tiebreaker estimate

OMW% is not recomputed from the simulated results because OMW depends on the full recursive graph of all opponents' records, which cannot be recalculated without fetching every opponent's history. The base OMW% is a reasonable proxy for relative tiebreaker ordering within a points tier.

### 3.4 Rank delta

The displayed `Δ` column compares each player's projected rank to their rank in the base standings:

```
Δ = base_rank - projected_rank   (positive = moved up, negative = moved down)
```

Players with at least one unpicked match show `?` since their result is unknown.

---

## 4. All Rounds Standings (matrix view)

The Standings tab shows every player's rank across all completed rounds as a matrix, plus a projected column for the current live round.

The live-round projection uses the same base-standings + locked-results logic as the Round Simulator (section 3), but without user picks — only API-confirmed match results are applied. Players with pending matches get a `~N?` annotation indicating the rank is an estimate.

Color coding:

- **Green cell** — rank improved compared to the previous round (number went down)
- **Red cell** — rank worsened compared to the previous round
- **Italic cell** — projected, not yet official
