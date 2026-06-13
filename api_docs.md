# Ravensburger Play Network API

Base: `https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/`

No authentication required. Standard curl/fetch works (no special headers needed).

---

## 1. Event page (web UI)

```
GET https://tcg.ravensburgerplay.com/events/{event_id}
```

**Example:** `https://tcg.ravensburgerplay.com/events/515727`

This is a Next.js frontend page, not a data endpoint. Useful for discovering:
- Event name, date, location, format
- Total player count
- Current round number
- The `tournament_round_id` used to query standings/pairings APIs

Note: `event_id` (e.g. `515727`) and `tournament_round_id` (e.g. `937420`) are **different IDs**.

---

## 2. Event detail (API)

```
GET https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/events/{event_id}/
```

**Example:** `.../events/515727/`

Returns the full event object including all phases and round IDs. This is the **entry point** to discover round IDs for use in standings/pairings endpoints.

### Key fields

| Field | Notes |
|---|---|
| `id` | Event ID |
| `name` | Event name |
| `start_datetime` / `end_datetime` | ISO 8601, UTC |
| `settings.event_lifecycle_status` | e.g. `"EVENT_IN_PROGRESS"` |
| `starting_player_count` | Total players who started |
| `tournament_phases[]` | Ordered list of phases (Swiss, Top Cut, etc.) |
| `store` | Venue info (name, address, country, coordinates) |
| `gameplay_format.name` | e.g. `"Core Constructed"` |
| `tiebreakers[]` | Ordered list: OMW%, GW%, OGW% |

### `tournament_phases[]` structure

Each phase contains a `rounds[]` array with the round IDs needed for other endpoints:

```json
{
  "id": 416493,
  "phase_name": "Swiss Rounds",
  "status": "COMPLETE",
  "order_in_phases": 1,
  "number_of_rounds": 5,
  "round_type": "SWISS",
  "rank_required_to_enter_phase": null,
  "rounds": [
    {
      "id": 935334,
      "round_number": 1,
      "status": "COMPLETE",
      "pairings_status": "GENERATED",
      "standings_status": "GENERATED",
      "round_type": "PLAY_VS_OPPONENT",
      "final_round_in_event": false
    }
  ]
}
```

**Round statuses:** `COMPLETE` | `IN_PROGRESS` | `NOT_STARTED`
**Standings/pairings statuses:** `GENERATED` | `NOT_GENERATED`

### Example round IDs for event 515727

| Round ID | Round # | Phase | Status |
|---|---|---|---|
| 935334 | 1 | Swiss | COMPLETE |
| 935335 | 2 | Swiss | COMPLETE |
| 935336 | 3 | Swiss | COMPLETE |
| 935337 | 4 | Swiss | COMPLETE |
| 935338 | 5 | Swiss | COMPLETE |
| 937419 | 6 | Top 8 | COMPLETE |
| 937420 | 7 | Top 8 | COMPLETE |
| 937421 | 8 | Top 8 | IN_PROGRESS |

---

## 3. Standings (paginated)

```
GET https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{round_id}/standings/paginated/
```

**Query params:**

| Param | Type | Description |
|---|---|---|
| `page` | int | Page number (1-based) |
| `page_size` | int | Results per page (max unknown; 29 works for full roster) |

**Example:** `.../tournament-rounds/937420/standings/paginated/?page=1&page_size=29`

### Response envelope

```json
{
  "page_size": 10,
  "count": 29,
  "total": 29,
  "current_page_number": 1,
  "next_page_number": 2,
  "next": 2,
  "previous": null,
  "previous_page_number": null,
  "results": [...]
}
```

### Per-player object (`results[]`)

```json
{
  "id": 42175,
  "rank": 1,
  "record": "5-0-2",
  "match_record": "5-0-2",
  "match_points": 17,
  "points": 17,
  "round_number": 7,
  "opponent_match_win_percentage": 0.74084656,
  "game_win_percentage": 0.66666667,
  "opponent_game_win_percentage": 0.66963777,
  "player": {
    "id": 42175,
    "best_identifier": "Jose Francisco M"
  },
  "user_event_status": {
    "id": 3728572,
    "matches_won": 5,
    "matches_drawn": 2,
    "matches_lost": 0,
    "total_match_points": 17,
    "registration_status": "COMPLETE",
    "best_identifier": "LD_Milanés",
    "deck_defining_card": null,
    "full_profile_picture_url": "https://storage.googleapis.com/spicerack_media/...",
    "user": {
      "id": 42175,
      "pronouns": null,
      "country_code": null
    }
  }
}
```

### Field notes

| Field | Notes |
|---|---|
| `player.best_identifier` | Partial real name: first name + last initial (e.g. `"Jose Francisco M"`) |
| `user_event_status.best_identifier` | Display handle/username (e.g. `"LD_Milanés"`) |
| `registration_status` | `"COMPLETE"` = still active; `"ELIMINATED"` = knocked out |
| `round_number` | The round these standings were calculated after |
| `record` / `match_record` | Same value; format is `"W-L-D"` |
| `match_points` / `points` | Same value; win=3pts, draw=1pt, loss=0pt |
| `opponent_match_win_percentage` | Tiebreaker 1 (OMW%) |
| `game_win_percentage` | Tiebreaker 2 (GW%) |
| `opponent_game_win_percentage` | Tiebreaker 3 (OGW%) |
| `deck_defining_card` | `null` for Core Constructed events |
| `full_profile_picture_url` | Signed Google Cloud Storage URL, expires after 24h |
| `user.country_code` / `user.pronouns` | Not populated in observed responses |

---

## 4. Matches (paginated)

```
GET https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{round_id}/matches/paginated/
```

**Query params:** `page`, `page_size` (same as standings)

Also available non-paginated (returns full round object with `matches[]` array):
```
GET .../tournament-rounds/{round_id}/matches/
```

> Note: `/pairings/` and `/pairings/paginated/` return 404 — matches is the correct endpoint.

### Per-match object (`results[]`)

```json
{
  "id": 5455351,
  "table_number": 1,
  "status": "COMPLETE",
  "winning_player": 42175,
  "players": [42175, 11614],
  "match_is_bye": false,
  "match_is_intentional_draw": false,
  "match_is_unintentional_draw": false,
  "games_won_by_winner": 2,
  "games_won_by_loser": 0,
  "games_drawn": 0,
  "player_match_relationships": [
    {
      "player_order": 1,
      "player": { "id": 42175, "best_identifier": "Jose Francisco M" },
      "user_event_status": { "best_identifier": "LD_Milanés", "registration_status": "COMPLETE" }
    },
    {
      "player_order": 2,
      "player": { "id": 11614, "best_identifier": "José Ángel L" },
      "user_event_status": { "best_identifier": "LD_JoseAngel991", "registration_status": "ELIMINATED" }
    }
  ]
}
```

### Result determination logic

| Condition | Result |
|---|---|
| `match_is_bye === true` | WIN (bye) |
| `match_is_intentional_draw \|\| match_is_unintentional_draw` | DRAW |
| `winning_player === playerId` | WIN |
| `winning_player !== null && !== playerId` | LOSS |
| `winning_player === null` | In progress |

### Known event mappings

| event_id | Event |
|---|---|
| 515727 | DRAGONCT Set Championship, Cartagena ES — 2026-06-13 (8 rounds, 29 players) |
