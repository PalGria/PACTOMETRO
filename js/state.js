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
};

export default S;
