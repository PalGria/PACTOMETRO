// ── STATE ────────────────────────────────────────
const S = {
  event:      null,
  rounds:     [],   // [{id, round_number, phase_name, status, pairings_status, standings_status}]
  standings:  {},   // round_id → results[]
  matches:    {},   // round_id → match[]
  viewRound:  null,
  simRound:   null, // round_id used for the simulation panel
  activeId:   null,
  omwRange:   null,
  version:    null, // server bundle version (content hash)
  updatedAt:  null, // epoch seconds of the last upstream change
  finished:   false,
  gatePts:    null, // Day 2 entry points set by the user for this event (null = default)
};

export default S;
