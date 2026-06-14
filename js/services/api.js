// ── API ──────────────────────────────────────────
// Derive base from current URL so the app works under any subpath (e.g. /pactometro/)
const _base = (() => {
  const p = window.location.pathname;
  return p.endsWith('/') ? p : p.slice(0, p.lastIndexOf('/') + 1);
})();

export const api = (path, params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return fetch(`${_base}api${path}${qs ? '?' + qs : ''}`)
    .then(r => { if (!r.ok) throw new Error(`${r.status} ${path}`); return r.json(); });
};
