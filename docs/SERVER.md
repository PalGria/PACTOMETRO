# Server: cached event store

`server.py` serves the static app and keeps a local copy of every event anyone opens. The Ravensburger Play API is polled by the server, on its own schedule, so the number of users does not change how often upstream is hit.

## Running

```
python3 server.py [port]        # default 8080
```

No dependencies beyond the Python standard library (3.8+).

| Variable | Default | Meaning |
|---|---|---|
| `PM_DATA_DIR` | `./data` next to `server.py` | Where bundles are stored (one JSON file per event). **On the VPS point this outside the Jenkins workspace**, otherwise a clean checkout wipes the history. |
| `PM_POLL_INTERVAL` | `300` | Seconds between automatic polls of a live event. |
| `PM_REFRESH_MIN` | `60` | Minimum seconds between two fetches of the same event. The refresh button in the app is limited by this. |
| `PM_DORMANT_AFTER` | `21600` (6 h) | A non-finished event whose data has not changed for this long is polled hourly instead. |

On Windows consoles set `PYTHONUTF8=1` (player handles contain emoji).

## How it works

- **First open** of an event fetches everything: the event object, then standings and matches of every published round, in parallel (6 workers), following pagination with `page_size=1000` (the upstream cap). Responses are slimmed to the fields the app uses (~1.4 KB per standings row upstream becomes ~0.2 KB).
- **Later polls** re-fetch the event object and only the rounds that are not frozen. A round is frozen when its status is `COMPLETE` and both pairings and standings are `GENERATED`; those are reused from the stored bundle.
- **Version** is a content hash of rounds + standings + matches. Clients compare it every 30 s and download the bundle only when it changed.
- **Finished events** (`event_lifecycle_status` = `EVENT_FINISHED`) are never polled again automatically. The refresh button still works, rate-limited.
- A fetch that fails keeps the previous bundle and records `error` in it; the app shows the message under the banner.
- Concurrent requests for the same event share a single upstream fetch.

## Endpoints

| Method | Path | Response |
|---|---|---|
| `GET` | `/api/event/<id>` | `{ event, rounds, standings, matches, version, updated_at, fetched_at, finished, error }`. Fetches upstream synchronously if the event is not known yet. |
| `GET` | `/api/event/<id>/version` | `{ version, updated_at, fetched_at, finished, error, refreshable_in, refresh_min, poll_interval }` |
| `POST` | `/api/event/<id>/refresh` | Fetches now if the last fetch is older than `PM_REFRESH_MIN`. `200` with `refreshed: true`, or `429` with `retry_after` seconds. |
| `GET` | `/api/<upstream path>` | Transparent proxy to the Ravensburger API, kept for debugging. |

`rounds` in the bundle is already flattened (`phase_name`, `phase_type` added to each round), which is the shape the app keeps in `S.rounds`.

## Client side

- `js/services/live.js` polls `/version` every 30 s while the tab is visible and on every return to the tab. When the version changes it downloads the bundle and re-renders in place, keeping the selected player, the selected rounds (unless the user was on the latest round, which then follows the new latest) and the picks in the round simulator.
- The refresh buttons call `POST /refresh`. The minimum interval is enforced only on the server and shared by all users; when it refuses, the app shows a short note under the banner and keeps the data it has.
- `localStorage` still caches the last bundle so a reopened tab paints immediately; the first version check then reconciles.

## Jenkins notes

- Run the server as a long-lived process (systemd unit or `nohup`), restarted on deploy. Data survives restarts as long as `PM_DATA_DIR` is outside the workspace.
- Nothing to build. `npm test` runs the engine validation and the UI smoke test with Node; it does not need the server.
