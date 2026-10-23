// ── PREDICTION VS REALITY ────────────────────────
// Once Swiss is over: what the cut line projection said before round 1 and
// after each round (js/ui/cutReplay.js), next to what actually happened.
// Used by the Overview's cut line panel and by the accuracy page
// (accuracy.html). Comparisons are plain data so the accuracy page can cache
// them; the HTML below renders them.
//
// Three kinds of check:
//   cut line   — likely / safe / could vs the real cut, per points group;
//   surprises  — players whose outcome we gave little chance (−log2 of the
//                chance we gave what happened: 1 bit = a coin flip);
//   integrity  — our odds against what was already *proven* at that moment
//                (adapter.provenFacts): a chance given to the impossible, 0% shown
//                for the possible, 100% shown for the unproven.

import S from '../state.js';
import { swissRounds, provenFacts } from '../engine/adapter.js';
import { cutSummary, fmtPct, fmtChance, pinTier, CUT_SAFE, CUT_COULD } from './cutStats.js';

// Per-player odds table only for fields this small; bigger events list the
// biggest surprises instead.
export const PLAYER_TABLE_MAX = 50;
const LIST_MAX = 8;          // names listed per surprise / integrity bucket
const SURPRISE_BITS = 3;     // ≥ 3 bits: what happened had ≤ 12.5% by our odds

const _handle = p => p?.user_event_status?.best_identifier || p?.player?.best_identifier || `#${p?.id}`;

// Final Swiss standings, best first.
export function finalSwissRows() {
  const last = swissRounds().filter(r => r.standings_status === 'GENERATED').at(-1);
  return last ? [...(S.standings[last.id] || [])].sort((a, b) => a.rank - b.rank) : [];
}

// ── COMPARISON ───────────────────────────────────
// One projection against the final standings. `facts` from provenFacts at
// the same moment.
export function comparePrediction(res, finalRows, cut, facts = new Map()) {
  const c = Math.min(cut, finalRows.length);
  const actualPts = finalRows[c - 1].points;
  const tied = finalRows[c]?.points === actualPts;
  const inIds = new Set(finalRows.slice(0, c).map(p => p.id));
  const byId = new Map(finalRows.map(p => [p.id, p]));
  const s = cutSummary(res);

  // Points groups: how many finished there and how many got in, predicted
  // (mean over the runs) and real — from one below the lowest line in play.
  const real = new Map();
  finalRows.forEach((p, i) => {
    const g = real.get(p.points) || { n: 0, in: 0 };
    g.n++;
    if (i < c) g.in++;
    real.set(p.points, g);
  });
  const pred = new Map(res.byPts.map(r => [r.pts, r]));
  const lo = Math.min(actualPts, s.could?.pts ?? actualPts) - 1;
  const groups = [...new Set([...real.keys(), ...pred.keys()])]
    .filter(pts => pts >= lo)
    .sort((a, b) => b - a)
    .map(pts => {
      const r = pred.get(pts), a = real.get(pts) || { n: 0, in: 0 };
      return { pts, predPlayers: r ? r.players : 0, predIn: r ? r.players * r.pIn : 0, realPlayers: a.n, realIn: a.in };
    })
    .filter(g => g.predPlayers >= 0.05 || g.realPlayers);

  // Every player's P(make it) against what happened. The Brier score is
  // compared with a no-information forecast (everyone gets cut / field), so
  // skill 1 = perfect, 0 = no better than that, below 0 = worse. Surprise
  // (log loss) clamps a 0% / 100% to half a run so a single miss can't make
  // it infinite — those cases are reported on their own below.
  const eps = 0.5 / res.samples;
  let brier = 0, bits = 0, n = 0, safeN = 0, safeIn = 0, longN = 0, longIn = 0, right = 0;
  const who = (id, p, made) => ({ id, name: _handle(byId.get(id)), rank: byId.get(id)?.rank ?? null, p, made, fact: facts.get(id) || null });
  const likelyMissed = [], unlikelyMade = [];
  const integ = { proven: 0, gaveImpossible: [], zeroPossible: 0, zeroMade: [], certainUnproven: 0, certainMissed: [], doubtedLocked: [], boundBroken: [] };

  for (const [k, p] of Object.entries(res.pInById)) {
    const id = Number(k), y = inIds.has(id) ? 1 : 0, fact = facts.get(id);
    brier += (p - y) ** 2; n++;
    bits += -Math.log2(Math.min(1 - eps, Math.max(eps, y ? p : 1 - p)));
    if ((p >= 0.5) === !!y) right++;
    if (p >= CUT_SAFE) { safeN++; safeIn += y; }
    if (p < CUT_COULD) { longN++; longIn += y; }
    if (p >= 0.5 && !y) likelyMissed.push(who(id, p, y));
    if (p < 0.5 && y) unlikelyMade.push(who(id, p, y));

    if (fact) integ.proven++;
    if (fact === 'out' && p > 0) integ.gaveImpossible.push(who(id, p, y));
    if (fact === 'locked' && p < 1) integ.doubtedLocked.push(who(id, p, y));
    if ((fact === 'out' && y) || (fact === 'locked' && !y)) integ.boundBroken.push(who(id, p, y));
    if (p === 0 && fact !== 'out') { integ.zeroPossible++; if (y) integ.zeroMade.push(who(id, p, y)); }
    if (p === 1 && fact !== 'locked') { integ.certainUnproven++; if (!y) integ.certainMissed.push(who(id, p, y)); }
  }
  brier = n ? brier / n : null;
  const base = n ? c / n : 0, brier0 = base * (1 - base);
  const top = (arr, by) => ({ n: arr.length, list: arr.sort(by).slice(0, LIST_MAX) });

  return {
    cut: c,
    real: { pts: actualPts, tied },
    pred: {
      mode: s.modePts, modeShare: s.modeShare,
      safe: s.safe?.pts ?? null, could: s.could?.pts ?? null,
      pReal: (res.lineCounts[actualPts] || 0) / res.samples,
      tieShare: res.tieBubble,
    },
    samples: res.samples,
    groups,
    players: {
      n, brier, skill: brier != null && brier0 ? 1 - brier / brier0 : null,
      bits: n ? bits / n : null, right,
      safeN, safeIn, longN, longIn,
    },
    surprises: {
      likelyMissed: top(likelyMissed, (a, b) => b.p - a.p),
      unlikelyMade: top(unlikelyMade, (a, b) => a.p - b.p),
    },
    integrity: {
      proven: integ.proven,
      gaveImpossible: top(integ.gaveImpossible, (a, b) => b.p - a.p),
      doubtedLocked: top(integ.doubtedLocked, (a, b) => a.p - b.p),
      boundBroken: top(integ.boundBroken, (a, b) => a.rank - b.rank),
      zeroPossible: integ.zeroPossible,
      zeroMade: top(integ.zeroMade, (a, b) => a.rank - b.rank),
      certainUnproven: integ.certainUnproven,
      certainMissed: top(integ.certainMissed, (a, b) => a.rank - b.rank),
    },
  };
}

// Replay steps → { moments: [{ label, left, cmp }], players }. `players`
// (fields of PLAYER_TABLE_MAX or fewer, else null) is every player's odds at
// each moment with what was proven then: [{ id, name, rank, made, cells:
// [{ p, fact } | null] }], in final standings order.
export function buildMoments(steps, finalRows, cut) {
  const swiss = swissRounds();
  const c = Math.min(cut, finalRows.length);
  const factsAt = steps.map(st => (st.res ? provenFacts(st.base?.id ?? null, cut) : null));
  const moments = steps.map(({ base, label, res }, i) => {
    const played = base ? swiss.findIndex(r => r.id === base.id) + 1 : 0;
    return { label, left: swiss.length - played, cmp: res ? comparePrediction(res, finalRows, cut, factsAt[i]) : null };
  });
  const players = finalRows.length > PLAYER_TABLE_MAX ? null : finalRows.map((p, i) => ({
    id: p.id, name: _handle(p), rank: p.rank, made: i < c,
    cells: steps.map((st, k) => (st.res ? { p: st.res.pInById[p.id] ?? 0, fact: factsAt[k].get(p.id) || null } : null)),
  }));
  return { moments, players };
}

// ── RENDER ───────────────────────────────────────
const _sign = d => (d > 0 ? `+${d}` : `${d}`);
const _offCls = d => (d === 0 ? 'hit' : Math.abs(d) === 1 ? 'near' : 'miss');
const _skill = v => (v == null ? '—' : v.toFixed(2));
const _num = v => (v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1));
const _esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function _momentName(m) {
  return m.label === 'Start' ? 'Before round 1' : `After ${m.label}`;
}

function _whoList(bucket, empty) {
  if (!bucket.n) return `<div class="acc-who none">${empty}</div>`;
  const items = bucket.list.map(w => `
    <div class="acc-who">
      <span class="acc-who-name">${_esc(w.name)}</span>
      <span class="acc-who-rank">#${w.rank}</span>
      <span class="ov-cl-pill ${pinTier(w.p)}">${fmtChance(w.p, w.fact)}</span>
    </div>`).join('');
  const more = bucket.n > bucket.list.length ? `<div class="acc-who none">and ${bucket.n - bucket.list.length} more</div>` : '';
  return items + more;
}

// Integrity pill: green when nothing to report, red when it matters.
function _integrityPill(label, n, total, sub, bad = true) {
  const cls = n === 0 ? 'in' : bad ? 'out' : '';
  return `<div class="ov-cl-fact ${cls}"><span>${label}</span><strong>${n}${total != null ? `/${total}` : ''}</strong><em>${sub}</em></div>`;
}

function _detailHtml(m, i, on) {
  const { cmp } = m;
  const off = cmp.real.pts - cmp.pred.mode;
  const inRange = cmp.pred.could != null && cmp.pred.safe != null
    && cmp.real.pts >= cmp.pred.could && cmp.real.pts <= cmp.pred.safe;
  const p = cmp.players, sp = cmp.surprises, ig = cmp.integrity;
  const rows = cmp.groups.map(g => {
    const line = g.pts === cmp.real.pts;
    return `
      <div class="acc-grow${line ? ' line' : ''}">
        <div class="ov-tier-label">${g.pts}</div>
        <div class="acc-pair"><span>${_num(g.predPlayers)}</span><b>${g.realPlayers}</b></div>
        <div class="acc-pair"><span>${_num(g.predIn)}</span><b>${g.realIn}</b></div>
        <div class="acc-pair"><span>${g.predPlayers ? fmtPct(g.predIn / g.predPlayers) : '—'}</span><b>${g.realPlayers ? fmtPct(g.realIn / g.realPlayers) : '—'}</b></div>
      </div>`;
  }).join('');

  const broken = ig.boundBroken.n
    ? `<div class="acc-alert">Bug: ${ig.boundBroken.n} player${ig.boundBroken.n === 1 ? '' : 's'} proven ${ig.boundBroken.list[0].made ? 'out made it' : 'in missed'} — the exact bounds are wrong somewhere.</div>`
    : '';

  return `
    <div class="acc-detail" data-m="${i}"${on ? '' : ' hidden'}>
      <div class="acc-headline">
        ${_momentName(m)} the likely cut was <strong>${cmp.pred.mode} pts</strong> (${fmtPct(cmp.pred.modeShare)} of runs).
        It landed at <strong>${cmp.real.pts} pts</strong>${cmp.real.tied ? ', decided on tiebreakers' : ''} —
        <span class="acc-off ${_offCls(off)}">${off === 0 ? 'spot on' : `off by ${Math.abs(off)}`}</span>.
      </div>
      ${broken}

      <div class="acc-sub">The cut line</div>
      <div class="ov-cl-facts">
        <div class="ov-cl-fact ${inRange ? 'in' : 'out'}"><span>Could → safe range</span><strong>${cmp.pred.could ?? '—'}–${cmp.pred.safe ?? '—'} pts</strong><em>${inRange ? 'real cut inside' : 'real cut outside'}</em></div>
        <div class="ov-cl-fact"><span>Real cut's chance</span><strong>${fmtPct(cmp.pred.pReal)}</strong><em>of runs landed on ${cmp.real.pts}</em></div>
        <div class="ov-cl-fact"><span>Last spot on tiebreakers</span><strong>${fmtPct(cmp.pred.tieShare)}</strong><em>predicted · ${cmp.real.tied ? 'it was' : 'it was not'}</em></div>
      </div>
      <div class="acc-grow ov-cl-header">
        <div>Pts</div><div>Players <span>pred</span> → <b>real</b></div><div>Made the cut</div><div>Share</div>
      </div>
      ${rows}

      <div class="acc-sub">Players</div>
      <div class="ov-cl-facts">
        <div class="ov-cl-fact"><span>Right side of 50%</span><strong>${p.right}/${p.n}</strong><em>players called correctly</em></div>
        <div class="ov-cl-fact ${p.safeIn === p.safeN ? 'in' : 'out'}"><span>Sure bets (≥${CUT_SAFE * 100}%)</span><strong>${p.safeIn}/${p.safeN}</strong><em>made it</em></div>
        <div class="ov-cl-fact ${p.longIn ? 'out' : 'in'}"><span>Long shots (&lt;${CUT_COULD * 100}%)</span><strong>${p.longIn}/${p.longN}</strong><em>made it</em></div>
        <div class="ov-cl-fact"><span>Average surprise</span><strong>${p.bits == null ? '—' : p.bits.toFixed(2)}</strong><em>bits · lower is better</em></div>
        <div class="ov-cl-fact"><span>Score</span><strong>${_skill(p.skill)}</strong><em>1 = perfect · 0 = no skill</em></div>
      </div>
      <div class="acc-surp">
        <div><div class="acc-surp-title">Said likely, missed</div>${_whoList(sp.likelyMissed, 'Nobody — every favourite made it.')}</div>
        <div><div class="acc-surp-title">Said unlikely, made it</div>${_whoList(sp.unlikelyMade, 'Nobody — no underdog got in.')}</div>
      </div>

      <div class="acc-sub">Against what was already proven</div>
      <div class="ov-cl-facts">
        ${_integrityPill('Chance given to the impossible', ig.gaveImpossible.n, null, 'proven out, shown above 0%')}
        ${_integrityPill('Sure thing doubted', ig.doubtedLocked.n, null, 'proven in, shown below 100%')}
        ${_integrityPill('No run gave them a chance', ig.zeroPossible, null, `not proven out (shown &lt;1%) · ${ig.zeroMade.n} made it`, ig.zeroMade.n > 0)}
        ${_integrityPill('Every run had them in', ig.certainUnproven, null, `not proven in (shown &gt;99%) · ${ig.certainMissed.n} missed`, ig.certainMissed.n > 0)}
      </div>
      ${ig.gaveImpossible.n || ig.zeroMade.n || ig.certainMissed.n || ig.doubtedLocked.n ? `
      <div class="acc-surp">
        ${ig.gaveImpossible.n ? `<div><div class="acc-surp-title">Proven out, given a chance</div>${_whoList(ig.gaveImpossible, '')}</div>` : ''}
        ${ig.doubtedLocked.n ? `<div><div class="acc-surp-title">Proven in, doubted</div>${_whoList(ig.doubtedLocked, '')}</div>` : ''}
        ${ig.zeroMade.n ? `<div><div class="acc-surp-title">No run had them in, made it</div>${_whoList(ig.zeroMade, '')}</div>` : ''}
        ${ig.certainMissed.n ? `<div><div class="acc-surp-title">Every run had them in, missed</div>${_whoList(ig.certainMissed, '')}</div>` : ''}
      </div>` : ''}
    </div>`;
}

// Every player's odds at every moment (small fields only): a row per player
// in final standings order, a cell per moment coloured by tier, outlined
// when what happened had ≤ 12.5% by our odds; "in" / "out" once proven.
function _playersHtml(players, labels) {
  if (!players) return `<div class="ov-tier-note">Per-player odds are listed for fields of ${PLAYER_TABLE_MAX} or fewer; above, the biggest surprises of each moment.</div>`;
  const head = labels.map(l => `<th>${l}</th>`).join('');
  const body = players.map(pl => {
    const cells = pl.cells.map(cell => {
      if (!cell) return '<td></td>';
      if (cell.fact) return `<td class="acc-cell proven ${cell.fact}">${cell.fact === 'locked' ? 'in' : 'out'}</td>`;
      const chance = pl.made ? cell.p : 1 - cell.p;
      const surprise = -Math.log2(Math.max(chance, 1e-9)) >= SURPRISE_BITS;
      return `<td class="acc-cell ${pinTier(cell.p)}${surprise ? ' surprise' : ''}" title="${fmtChance(cell.p)} — ${pl.made ? 'made it' : 'missed'}">${fmtChance(cell.p)}</td>`;
    }).join('');
    return `<tr class="${pl.made ? 'made' : ''}"><td class="acc-pl-rank">#${pl.rank}</td><td class="acc-pl-name">${_esc(pl.name)}</td>${cells}<td class="acc-pl-res">${pl.made ? '✓ in' : '✗'}</td></tr>`;
  }).join('');
  return `
    <div class="acc-sub">Every player, every round</div>
    <div class="acc-pl-wrap">
      <table class="acc-pl">
        <thead><tr><th></th><th>Player</th>${head}<th>Final</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <div class="ov-tier-note">Chance of making the cut given at each point. Outlined: what happened had 12.5% or less by
      those odds. "in" / "out": already proven then, whatever the remaining results.</div>`;
}

// Table of every moment (click one for its detail), the detail itself and,
// for small fields, every player's odds. Selected by default: the last
// projection before the final round.
export function compareHtml({ moments, players }, cut) {
  const usable = moments.map((m, i) => [m, i]).filter(([m]) => m.cmp);
  if (!usable.length) return `<div class="ov-empty">Nothing to compare: Swiss had a single round left from the start.</div>`;
  const sel = usable.at(-1)[1];

  const rows = usable.map(([m, i]) => {
    const { cmp } = m, off = cmp.real.pts - cmp.pred.mode;
    const flags = cmp.integrity.zeroMade.n + cmp.integrity.certainMissed.n + cmp.integrity.boundBroken.n;
    return `
      <button class="acc-mrow${i === sel ? ' on' : ''}" data-m="${i}" type="button">
        <span class="acc-when">${m.label}<small>${m.left} left</small></span>
        <span class="acc-num">${cmp.pred.mode}</span>
        <span class="acc-range">${cmp.pred.could ?? '—'}–${cmp.pred.safe ?? '—'}</span>
        <span class="acc-num">${cmp.real.pts}</span>
        <span class="acc-off ${_offCls(off)}">${off === 0 ? '✓' : _sign(off)}</span>
        <span class="acc-num dim">${_skill(cmp.players.skill)}${flags ? ' <span class="acc-flag" title="A player no run had in made it, one every run had in missed, or a broken bound">⚠</span>' : ''}</span>
      </button>`;
  }).join('');

  return `
    <div class="acc-mtable">
      <div class="acc-mrow head">
        <span>Predicted</span><span>Likely</span><span>Could–safe</span><span>Real</span><span>Off</span><span>Score</span>
      </div>
      ${rows}
    </div>
    ${usable.map(([m, i]) => _detailHtml(m, i, i === sel)).join('')}
    ${_playersHtml(players, moments.map(m => m.label))}
    <div class="ov-tier-note">
      Top ${cut}. Each projection uses only what was known at that point (no later pairings or
      results), recomputed with the current model. "Players" and "Made the cut" are the predicted average vs
      the real count. Score = Brier skill of every player's predicted chance: 1 perfect, 0 no better than giving
      everyone the same ${cut}-in-the-field chance. Surprise = −log2 of the chance we gave what happened.
      "Proven" = decided by points alone whatever the remaining results, ties counted against the player.
    </div>`;
}

// Row clicks swap the detail shown below the table.
export function wireCompare(el) {
  if (!el) return;
  el.querySelectorAll('.acc-mrow[data-m]').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.m;
      el.querySelectorAll('.acc-mrow[data-m]').forEach(b => b.classList.toggle('on', b === btn));
      el.querySelectorAll('.acc-detail').forEach(d => { d.hidden = d.dataset.m !== m; });
    });
  });
}
