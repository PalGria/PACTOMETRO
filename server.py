#!/usr/bin/env python3
"""PACTOMETRO server.

Serves the static app and keeps a local copy of every tournament anyone has
opened. A background thread re-fetches live events from the Ravensburger Play
API on a fixed interval, so the upstream API sees one poll per event no matter
how many browsers are open. Completed rounds are fetched once and kept.

Deliberately light on both ends: nobody is polled unless someone has actually
looked at the event recently (PM_ACTIVE_WINDOW), fetches use few concurrent
connections, and bundles are trimmed to the fields the app needs. Built to run
on a small VPS and to go easy on the upstream API.

Run:  python3 server.py [port]

Environment:
  PM_DATA_DIR        where bundles are stored (default: ./data next to this file)
  PM_POLL_INTERVAL   seconds between automatic polls of a live event (default 300)
  PM_REFRESH_MIN     minimum seconds between fetches of one event, applies to
                     the users' refresh button, shared by every viewer (default 60)
  PM_ACTIVE_WINDOW   seconds since an event was last requested by any client
                     during which it keeps being polled automatically; beyond
                     that it goes quiet until someone looks at it again (default 900)
  PM_DORMANT_AFTER   seconds without changes after which a non-finished event
                     is polled hourly instead (default 21600 = 6 h)
  PM_FETCH_WORKERS   max concurrent upstream requests per fetch (default 3)

Endpoints:
  GET  /api/event/<id>           full bundle (event, rounds, standings, matches)
  GET  /api/event/<id>/version   {version, updated_at, ...} cheap poll for clients
  POST /api/event/<id>/refresh   fetch now if allowed by PM_REFRESH_MIN
  GET  /api/<upstream path>      transparent proxy (legacy / debugging)
"""

import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

API_BASE = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2"
HERE = os.path.dirname(os.path.abspath(__file__)) or "."

DATA_DIR      = os.environ.get("PM_DATA_DIR", os.path.join(HERE, "data"))
POLL_INTERVAL = int(os.environ.get("PM_POLL_INTERVAL", "300"))
REFRESH_MIN   = int(os.environ.get("PM_REFRESH_MIN", "60"))
ACTIVE_WINDOW = int(os.environ.get("PM_ACTIVE_WINDOW", "900"))
DORMANT_AFTER = int(os.environ.get("PM_DORMANT_AFTER", str(6 * 3600)))
DORMANT_POLL  = 3600
FETCH_WORKERS = int(os.environ.get("PM_FETCH_WORKERS", "3"))
PAGE_SIZE     = 1000          # upstream caps page_size at 1000
FINISHED_STATUSES = {"EVENT_FINISHED", "EVENT_CANCELLED", "EVENT_CANCELED"}


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ── UPSTREAM ─────────────────────────────────────
class UpstreamError(Exception):
    def __init__(self, status, body=b""):
        super().__init__(f"upstream {status}")
        self.status = status
        self.body = body


def upstream_get(path, params=None):
    url = API_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (pactometro)"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise UpstreamError(e.code, e.read())


def fetch_all_pages(path):
    """Follow the paginated envelope until `next` is null."""
    results, page = [], 1
    while True:
        d = upstream_get(path, {"page": page, "page_size": PAGE_SIZE})
        results.extend(d.get("results") or [])
        nxt = d.get("next_page_number") or d.get("next")
        if not nxt or nxt == page:
            break
        page = nxt
    return results


# ── SLIMMING: keep only what the app uses ─────────
def slim_event(ev):
    store = ev.get("store") or {}
    return {
        "id": ev["id"],
        "name": ev.get("name"),
        "start_datetime": ev.get("start_datetime"),
        "end_datetime": ev.get("end_datetime"),
        "starting_player_count": ev.get("starting_player_count"),
        "registered_user_count": ev.get("registered_user_count"),
        "event_format": ev.get("event_format"),
        "top_cut_size": ev.get("top_cut_size"),
        "number_of_rounds": ev.get("number_of_rounds"),
        "settings": {"event_lifecycle_status": (ev.get("settings") or {}).get("event_lifecycle_status")},
        "gameplay_format": {"name": (ev.get("gameplay_format") or {}).get("name")} if ev.get("gameplay_format") else None,
        "store": {
            "name": store.get("name"),
            "administrative_area_level_1_short": store.get("administrative_area_level_1_short"),
            "country": store.get("country"),
        } if store else None,
        "tiebreakers": ev.get("tiebreakers"),
        "tournament_phases": [
            {
                "id": ph.get("id"),
                "phase_name": ph.get("phase_name"),
                "status": ph.get("status"),
                "order_in_phases": ph.get("order_in_phases"),
                "number_of_rounds": ph.get("number_of_rounds"),
                "round_type": ph.get("round_type"),
                "rank_required_to_enter_phase": ph.get("rank_required_to_enter_phase"),
                "rounds": [
                    {
                        "id": r["id"],
                        "round_number": r.get("round_number"),
                        "status": r.get("status"),
                        "pairings_status": r.get("pairings_status"),
                        "standings_status": r.get("standings_status"),
                        "round_type": r.get("round_type"),
                        "final_round_in_event": r.get("final_round_in_event"),
                    }
                    for r in ph.get("rounds") or []
                ],
            }
            for ph in ev.get("tournament_phases") or []
        ],
    }


def _slim_player(p):
    p = p or {}
    return {"id": p.get("id"), "best_identifier": p.get("best_identifier")}


def _slim_ues(u):
    u = u or {}
    return {
        "best_identifier": u.get("best_identifier"),
        "registration_status": u.get("registration_status"),
        "matches_won": u.get("matches_won"),
        "matches_drawn": u.get("matches_drawn"),
        "matches_lost": u.get("matches_lost"),
    }


def slim_standing(s):
    return {
        "id": s["id"],
        "rank": s.get("rank"),
        "record": s.get("record"),
        "points": s.get("points"),
        "round_number": s.get("round_number"),
        "opponent_match_win_percentage": s.get("opponent_match_win_percentage"),
        "game_win_percentage": s.get("game_win_percentage"),
        "opponent_game_win_percentage": s.get("opponent_game_win_percentage"),
        "player": _slim_player(s.get("player")),
        "user_event_status": _slim_ues(s.get("user_event_status")),
    }


def slim_match(m):
    return {
        "id": m["id"],
        "table_number": m.get("table_number"),
        "status": m.get("status"),
        "winning_player": m.get("winning_player"),
        "players": m.get("players"),
        "match_is_bye": m.get("match_is_bye"),
        "match_is_intentional_draw": m.get("match_is_intentional_draw"),
        "match_is_unintentional_draw": m.get("match_is_unintentional_draw"),
        "games_won_by_winner": m.get("games_won_by_winner"),
        "games_won_by_loser": m.get("games_won_by_loser"),
        "games_drawn": m.get("games_drawn"),
        "player_match_relationships": [
            {
                "player_order": rel.get("player_order"),
                "player": _slim_player(rel.get("player")),
                "user_event_status": _slim_ues(rel.get("user_event_status")),
            }
            for rel in m.get("player_match_relationships") or []
        ],
    }


def flatten_rounds(event):
    return [
        {**r, "phase_name": ph.get("phase_name"), "phase_type": ph.get("round_type")}
        for ph in event.get("tournament_phases") or []
        for r in ph.get("rounds") or []
    ]


def round_is_frozen(r):
    """A completed round with both artifacts published never changes again."""
    return (
        r.get("status") == "COMPLETE"
        and r.get("standings_status") == "GENERATED"
        and r.get("pairings_status") == "GENERATED"
    )


# ── BUNDLE ───────────────────────────────────────
def build_bundle(eid, prev=None):
    """Fetch an event. Rounds frozen in `prev` are reused instead of re-fetched."""
    raw = upstream_get(f"/events/{eid}/")
    event = slim_event(raw)
    rounds = flatten_rounds(event)
    prev_rounds = {r["id"]: r for r in (prev or {}).get("rounds", [])}
    standings, matches = {}, {}
    reused = fetched = 0

    jobs = []  # (kind, rid) pairs to fetch from upstream
    for r in rounds:
        rid = str(r["id"])
        old = prev_rounds.get(r["id"])
        if prev and old and round_is_frozen(old) and round_is_frozen(r) \
                and rid in prev.get("standings", {}) and rid in prev.get("matches", {}):
            standings[rid] = prev["standings"][rid]
            matches[rid] = prev["matches"][rid]
            reused += 1
            continue
        if r.get("standings_status") == "GENERATED":
            jobs.append(("standings", rid))
        if r.get("pairings_status") == "GENERATED":
            jobs.append(("matches", rid))

    def run(job):
        kind, rid = job
        if kind == "standings":
            return kind, rid, [slim_standing(s) for s in fetch_all_pages(f"/tournament-rounds/{rid}/standings/paginated/")]
        return kind, rid, [slim_match(m) for m in fetch_all_pages(f"/tournament-rounds/{rid}/matches/paginated/")]

    if jobs:
        with ThreadPoolExecutor(max_workers=min(FETCH_WORKERS, len(jobs))) as pool:
            for kind, rid, rows in pool.map(run, jobs):
                (standings if kind == "standings" else matches)[rid] = rows
                fetched += 1

    digest = hashlib.sha1(json.dumps(
        {"rounds": rounds, "standings": standings, "matches": matches, "phases": [ph.get("status") for ph in event["tournament_phases"]]},
        sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest()[:12]

    status = (event.get("settings") or {}).get("event_lifecycle_status")
    now = time.time()
    bundle = {
        "event": event,
        "rounds": rounds,
        "standings": standings,
        "matches": matches,
        "version": digest,
        "finished": status in FINISHED_STATUSES,
        "fetched_at": now,
        "updated_at": now if not prev or prev.get("version") != digest else prev.get("updated_at", now),
        "error": None,
    }
    log(f"event {eid}: {len(rounds)} rounds, {fetched} fetched, {reused} reused, v{digest}{' (finished)' if bundle['finished'] else ''}")
    return bundle


# ── STORE ────────────────────────────────────────
class Store:
    def __init__(self, data_dir):
        self.dir = data_dir
        os.makedirs(self.dir, exist_ok=True)
        self.lock = threading.Lock()          # guards self.bundles / self.fetching / self.last_seen
        self.bundles = {}                     # eid -> bundle
        self.fetching = {}                    # eid -> threading.Event while a fetch runs
        self.last_seen = {}                   # eid -> monotonic-ish epoch of last client request (memory only)
        self._load()
        now = time.time()
        for eid in self.bundles:
            self.last_seen[eid] = now         # give freshly loaded events one active window before going quiet

    # persistence
    def _path(self, eid):
        return os.path.join(self.dir, f"event-{eid}.json")

    def _load(self):
        for name in os.listdir(self.dir):
            if name.startswith("event-") and name.endswith(".json"):
                try:
                    with open(os.path.join(self.dir, name), encoding="utf-8") as f:
                        b = json.load(f)
                    self.bundles[str(b["event"]["id"])] = b
                except Exception as e:  # noqa: BLE001
                    log(f"skip {name}: {e}")
        if self.bundles:
            log(f"loaded {len(self.bundles)} event(s) from {self.dir}")

    def _save(self, eid, bundle):
        tmp = self._path(eid) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(bundle, f, separators=(",", ":"))
        os.replace(tmp, self._path(eid))

    # public
    def touch(self, eid):
        """Mark an event as actively watched right now (cheap, memory only)."""
        with self.lock:
            self.last_seen[eid] = time.time()

    def get(self, eid):
        with self.lock:
            return self.bundles.get(eid)

    def get_or_fetch(self, eid):
        b = self.get(eid)
        if b:
            return b
        return self.fetch(eid, force=True)[0]

    def fetch(self, eid, force=False):
        """Fetch `eid` unless fetched less than REFRESH_MIN ago (or force).
        Returns (bundle, refreshed, retry_after). Concurrent callers wait for
        the in-flight fetch instead of hitting upstream again."""
        with self.lock:
            prev = self.bundles.get(eid)
            if prev and not force:
                age = time.time() - prev.get("fetched_at", 0)
                if age < REFRESH_MIN:
                    return prev, False, int(REFRESH_MIN - age) + 1
            inflight = self.fetching.get(eid)
            if inflight is None:
                inflight = self.fetching[eid] = threading.Event()
                owner = True
            else:
                owner = False
        if not owner:
            inflight.wait(120)
            return self.get(eid), False, 0
        try:
            bundle = build_bundle(eid, prev)
        except UpstreamError as e:
            if prev:
                prev["error"] = f"upstream {e.status}"
                prev["fetched_at"] = time.time()
                return prev, False, 0
            raise
        except Exception as e:  # noqa: BLE001
            log(f"event {eid}: fetch failed: {e}")
            if prev:
                prev["error"] = str(e)
                prev["fetched_at"] = time.time()
                return prev, False, 0
            raise
        finally:
            with self.lock:
                self.fetching.pop(eid, None)
            inflight.set()
        with self.lock:
            self.bundles[eid] = bundle
        self._save(eid, bundle)
        return bundle, True, 0

    # polling
    def poll_forever(self):
        while True:
            time.sleep(15)
            now = time.time()
            with self.lock:
                due = [
                    eid for eid, b in self.bundles.items()
                    if not b.get("finished")
                    and now - self.last_seen.get(eid, 0) <= ACTIVE_WINDOW
                    and now - b.get("fetched_at", 0) >= (
                        DORMANT_POLL if now - b.get("updated_at", now) > DORMANT_AFTER else POLL_INTERVAL
                    )
                ]
            for eid in due:
                try:
                    self.fetch(eid, force=True)
                except Exception as e:  # noqa: BLE001
                    log(f"poll {eid} failed: {e}")


STORE = Store(DATA_DIR)


# ── HTTP ─────────────────────────────────────────
class Handler(SimpleHTTPRequestHandler):
    # Static files (index.html, js/, css/) get no explicit Cache-Control from
    # SimpleHTTPRequestHandler, so browsers fall back to heuristic caching —
    # during active development that means a hard refresh doesn't reliably
    # fetch the latest JS/CSS. Force revalidation on every request instead;
    # routes that already set their own Cache-Control (the JSON API) keep it.
    def end_headers(self):
        if not any(h.lower().startswith(b"cache-control:") for h in getattr(self, "_headers_buffer", [])):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, obj, status=200, extra=None):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _route_event(self, method, parts):
        # parts: ['event', '<id>', maybe 'version' | 'refresh']
        eid = parts[1]
        if not eid.isdigit():
            return self._json({"error": "bad event id"}, 400)
        sub = parts[2] if len(parts) > 2 else ""

        if method == "GET" and sub == "":
            STORE.touch(eid)
            try:
                b = STORE.get_or_fetch(eid)
            except UpstreamError as e:
                return self._json({"error": f"upstream {e.status}"}, 404 if e.status == 404 else 502)
            return self._json(b)

        if method == "GET" and sub == "version":
            STORE.touch(eid)
            b = STORE.get(eid)
            if not b:
                return self._json({"error": "unknown event"}, 404)
            age = time.time() - b.get("fetched_at", 0)
            return self._json({
                "version": b["version"], "updated_at": b["updated_at"], "fetched_at": b["fetched_at"],
                "finished": b["finished"], "error": b.get("error"),
                "refreshable_in": max(0, int(REFRESH_MIN - age)),
                "refresh_min": REFRESH_MIN, "poll_interval": POLL_INTERVAL,
            })

        if method == "POST" and sub == "refresh":
            STORE.touch(eid)
            try:
                b, refreshed, retry = STORE.fetch(eid)
            except UpstreamError as e:
                return self._json({"error": f"upstream {e.status}"}, 404 if e.status == 404 else 502)
            return self._json({
                "version": b["version"], "updated_at": b["updated_at"], "fetched_at": b["fetched_at"],
                "refreshed": refreshed, "retry_after": retry, "refresh_min": REFRESH_MIN, "error": b.get("error"),
            }, 200 if refreshed or retry == 0 else 429, {"Retry-After": str(retry)} if retry else None)

        return self._json({"error": "not found"}, 404)

    def _route_proxy(self):
        upstream = API_BASE + self.path[4:]
        try:
            req = urllib.request.Request(upstream, headers={"User-Agent": "Mozilla/5.0 (pactometro)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "public, max-age=30")
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:  # noqa: BLE001
            self._json({"error": str(e)}, 500)

    def _dispatch(self, method):
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/api/event/"):
            parts = [p for p in path[5:].split("/") if p]
            if len(parts) >= 2:
                return self._route_event(method, parts)
            return self._json({"error": "not found"}, 404)
        if path.startswith("/api/"):
            if method != "GET":
                return self._json({"error": "method not allowed"}, 405)
            return self._route_proxy()
        if path == "/evento" and method == "GET":
            # Shareable deep link (?e=<id>) — served client-side, so just
            # hand back the SPA shell for this one exact path.
            self.path = "/index.html"
            return super().do_GET()
        if method != "GET":
            return self._json({"error": "not found"}, 404)
        return super().do_GET()

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def log_message(self, fmt, *args):
        status = str(args[1]) if len(args) > 1 else ""
        color = "\033[32m" if status.startswith("2") else "\033[33m" if status.startswith("3") else "\033[31m"
        print(f"  {color}{self.command}\033[0m {self.path}  {color}{status}\033[0m", flush=True)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    os.chdir(HERE)
    threading.Thread(target=STORE.poll_forever, name="poller", daemon=True).start()
    server = ThreadingHTTPServer(("", port), Handler)
    print(f"\n  PACTOMETRO  ->  http://localhost:{port}   data: {DATA_DIR}   poll: {POLL_INTERVAL}s   refresh min: {REFRESH_MIN}s\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
