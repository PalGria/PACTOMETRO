// ── TOP CUT BRACKET ───────────────────────────────
// Builds and renders the single-elimination bracket (quarterfinals,
// semifinals, final, ...) for the overview's "Bracket" tab.
//
// Round 1 is predicted from the last Swiss round's standings via
// js/engine/bracket.js's seedPairs (1v8, 2v7, 3v6, 4v5 — verified against a
// real event in scripts/validate-engine.mjs) whenever the API hasn't
// generated its own pairings for that round yet. Every later round is read
// straight from the API's real pairings/results once they exist — who wins
// each match determines who advances, so it isn't something to predict.
// A round that isn't paired yet still shows the bracket's SHAPE though: a
// semifinal slot reads "Winner of 1v8", not a bare "TBD" — the shape (seed 1
// grouped with 4/5/8, away from seed 2 until the final) is fixed by the
// seeding itself, only the actual winners are unknown. See
// js/engine/bracket.js's seedLabelLevels.

import S from '../state.js';
import { swissRounds } from '../engine/adapter.js';
import { seedPairs, seedLabelLevels } from '../engine/bracket.js';

function _elimPhase() {
  return S.event?.tournament_phases?.find(p => p.round_type !== 'SWISS') || null;
}

function _elimRounds() {
  return S.rounds.filter(r => r.phase_type !== 'SWISS').sort((a, b) => a.round_number - b.round_number);
}

// Swiss final rank -> that round's standings row, for the round-1 prediction.
function _seedField() {
  const last = swissRounds().at(-1);
  if (!last || !S.standings[last.id]) return null;
  return new Map(S.standings[last.id].map(p => [p.rank, p]));
}

const _handleOf = p => p?.user_event_status?.best_identifier || p?.player?.best_identifier || '?';

function _relHandle(rels, pid) {
  const rel = (rels || []).find(r => r.player.id === pid);
  return rel ? _handleOf(rel) : '?';
}

function _matchFromApi(m) {
  const [a, b] = m.players || [];
  const rels = m.player_match_relationships || [];
  const playerA = a != null ? { id: a, name: _relHandle(rels, a) } : null;
  const playerB = b != null ? { id: b, name: _relHandle(rels, b) } : null;
  let status = 'pending', winner = null;
  if (m.match_is_bye) status = 'bye';
  else if (m.match_is_intentional_draw || m.match_is_unintentional_draw) status = 'draw';
  else if (m.winning_player != null) { status = 'decided'; winner = m.winning_player; }
  // A completed match can still have no recorded winner — e.g. co-champions
  // when a final isn't played out. Real data (see scripts/smoke-ui.mjs).
  else if (m.status === 'COMPLETE') status = 'split';
  return { playerA, playerB, winner, status };
}

// A round-1 slot: the real player once Swiss finished (name known), else
// just the bare seed number (Swiss still in progress).
function _seedSlot(seeds, seedNum) {
  const row = seeds?.get(seedNum);
  return { id: row?.id ?? null, name: row ? _handleOf(row) : null, seed: seedNum };
}

function _roundLabel(playersIn) {
  if (playersIn === 2) return 'Final';
  if (playersIn === 4) return 'Semifinals';
  if (playersIn === 8) return 'Quarterfinals';
  return `Round of ${playersIn}`;
}

// { size, rounds: [{ label, roundNumber, matches: [{playerA, playerB, winner, status}] }] }
// or null if the event has no elimination phase at all.
export function buildBracket() {
  const phase = _elimPhase();
  if (!phase) return null;

  const elimRounds = _elimRounds();
  const bracketSize = phase.rank_required_to_enter_phase || (elimRounds.length ? 2 ** elimRounds.length : null);
  if (!bracketSize) return null;

  const totalRounds = Math.round(Math.log2(bracketSize));
  const seeds = _seedField();
  const labelLevels = seedLabelLevels(bracketSize); // structural, no real data needed
  const rounds = [];

  for (let k = 0; k < totalRounds; k++) {
    const playersIn = bracketSize / 2 ** k;
    const roundMeta = elimRounds[k];
    let matches;
    if (roundMeta) {
      matches = [...(S.matches[roundMeta.id] || [])]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(_matchFromApi);
    } else if (k === 0) {
      matches = seedPairs(bracketSize).map(([sa, sb]) => ({
        playerA: _seedSlot(seeds, sa), playerB: _seedSlot(seeds, sb), winner: null, status: 'predicted',
      }));
    } else {
      // Not paired yet — the shape is still fully known (see
      // seedLabelLevels): match j is fed by round (k-1)'s matches j and
      // (prevCount-1-j), the same merge the real bracket itself follows.
      const prevLabels = labelLevels[k - 1];
      const prevCount = prevLabels.length;
      matches = Array.from({ length: playersIn / 2 }, (_, j) => ({
        playerA: { id: null, name: null, tbdLabel: prevLabels[j] },
        playerB: { id: null, name: null, tbdLabel: prevLabels[prevCount - 1 - j] },
        winner: null, status: 'tbd',
      }));
    }
    rounds.push({ label: _roundLabel(playersIn), roundNumber: roundMeta?.round_number ?? null, matches });
  }

  return { size: bracketSize, rounds };
}

function _slotHtml(player, winner, status) {
  if (!player) return `<div class="bracket-slot tbd">TBD</div>`;
  if (player.name == null && player.tbdLabel) {
    return `<div class="bracket-slot tbd">Winner of ${player.tbdLabel}</div>`;
  }
  const isWinner = winner != null && player.id === winner;
  const isLoser  = winner != null && player.id !== winner;
  const seedStr  = player.seed != null ? `<span class="bracket-seed">${player.seed}</span>` : '';
  const name     = player.name ?? (player.seed != null ? `Seed ${player.seed}` : '?');
  const cls = isWinner ? 'winner' : isLoser ? 'loser' : '';
  return `<div class="bracket-slot ${cls}" ${player.id != null ? `data-id="${player.id}"` : ''}>${seedStr}<span class="bracket-name">${name}</span></div>`;
}

export function renderBracketHtml() {
  const bracket = buildBracket();
  if (!bracket) return `<div class="ov-empty">This event has no elimination phase.</div>`;

  const cols = bracket.rounds.map(round => `
    <div class="bracket-col">
      <div class="bracket-col-title">${round.label}</div>
      <div class="bracket-col-matches">
        ${round.matches.map(m => `
          <div class="bracket-match${m.status === 'predicted' ? ' predicted' : ''}">
            ${_slotHtml(m.playerA, m.winner, m.status)}
            ${_slotHtml(m.playerB, m.winner, m.status)}
            ${m.status === 'split' ? '<div class="bracket-split-note">Co-champions — no result recorded</div>' : ''}
          </div>`).join('')}
      </div>
    </div>`).join('');

  const hasPrediction = bracket.rounds[0]?.matches.some(m => m.status === 'predicted');
  const note = hasPrediction
    ? `Round 1 pairings not published yet — shown as predicted from the current Swiss standings (seed 1 vs seed ${bracket.size}, 2 vs ${bracket.size - 1}, ...). Later rounds depend on who wins and will fill in as they're paired.`
    : `Live from the event's own bracket pairings.`;

  return `<div class="bracket">${cols}</div><div class="ov-tier-note">${note}</div>`;
}
