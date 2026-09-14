// ── API ──────────────────────────────────────────
// Derive base from current URL so the app works under any subpath (e.g. /pactometro/)
const _base = (() => {
  const p = window.location.pathname;
  return p.endsWith('/') ? p : p.slice(0, p.lastIndexOf('/') + 1);
})();

// Exposed so other modules can build subpath-aware URLs the same way (e.g.
// the shareable-link address bar update in eventController.js).
export const appBase = _base;

export const api = (path, params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return fetch(`${_base}api${path}${qs ? '?' + qs : ''}`)
    .then(r => { if (!r.ok) throw new Error(`${r.status} ${path}`); return r.json(); });
};

// ── SERVER-CACHED EVENT BUNDLES ──────────────────
// The server keeps every opened event, polls upstream on its own schedule and
// hands the app one compact bundle: { event, rounds, standings, matches,
// version, updated_at, fetched_at, finished, error }.
export const getEventBundle  = eid => api(`/event/${eid}`);
export const getEventVersion = eid => api(`/event/${eid}/version`);

// Ask the server to fetch upstream now. Returns { version, refreshed,
// retry_after, refresh_min, ... }. A 429 means "too soon" and is not an error.
export async function postRefresh(eid) {
  const r = await fetch(`${_base}api/event/${eid}/refresh`, { method: 'POST' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 429) throw new Error(d.error || `${r.status} refresh`);
  return d;
}
