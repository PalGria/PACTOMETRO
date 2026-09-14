// ── LIVE UPDATES ─────────────────────────────────
// Polls the server for the event version every POLL_MS and pulls the bundle
// when it changed. The server re-fetches upstream on its own schedule and
// enforces a minimum interval between fetches of one event, shared by every
// user. The refresh button just asks it to fetch now and is always silent:
// whether the server actually hit upstream, served cached data because it
// was too soon, or failed to reach it, the user sees no message either way.

import S from '../state.js';
import { $ } from '../utils.js';
import { getEventVersion, getEventBundle, postRefresh } from './api.js';

const POLL_MS = 30000;

let _eid      = null;
let _onUpdate = null;
let _timer    = null;
let _busy     = false;

export function startLive(eid, onUpdate) {
  stopLive();
  _eid = eid;
  _onUpdate = onUpdate;
  _timer = setInterval(_tick, POLL_MS);
  document.addEventListener('visibilitychange', _onVisible);
}

export function stopLive() {
  if (_timer) clearInterval(_timer);
  _timer = null; _eid = null; _onUpdate = null;
  document.removeEventListener('visibilitychange', _onVisible);
}

// Compare versions with the server right now (no upstream fetch forced).
export function checkNow() { return _tick(); }

function _onVisible() {
  if (!document.hidden) _tick();
}

async function _tick() {
  if (!_eid || document.hidden || _busy) return;
  try {
    const v = await getEventVersion(_eid);
    if (v.version && v.version !== S.version) await _pull();
  } catch (e) {
    // server unreachable: keep showing what we have, try again next tick
  }
}

async function _pull() {
  const b = await getEventBundle(_eid);
  if (b.version !== S.version && _onUpdate) _onUpdate(b);
}

// Manual refresh (header + roster buttons). Fire-and-forget: apply new data
// if the server had any, otherwise do nothing visible. The server-side
// minimum interval is shared by every viewer of the event, so most clicks
// simply confirm "you're already up to date" without saying so.
export async function refreshNow() {
  if (!_eid || _busy) return;
  _busy = true;
  try {
    const r = await postRefresh(_eid);
    if (r.version && r.version !== S.version) await _pull();
  } catch (e) {
    // network hiccup — nothing to show, the poller will catch up
  } finally {
    _busy = false;
  }
}
