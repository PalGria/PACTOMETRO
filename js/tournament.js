import S from './state.js';

// ── BUILD HISTORY ────────────────────────────────
export function buildHistory(pid) {
  const history = [];

  for (const r of S.rounds) {
    const hasStandings = r.standings_status === 'GENERATED';
    const isLive       = r.pairings_status  === 'GENERATED' && !hasStandings;
    if (!hasStandings && !isLive) continue;

    const st = hasStandings ? (S.standings[r.id] || []).find(p => p.id === pid) : null;
    if (hasStandings && !st) continue;

    // Find match for this player in this round
    const roundMatches = S.matches[r.id] || [];
    const match = roundMatches.find(m => m.players && m.players.includes(pid));

    let result = null, score = null, opponent = null, opponentId = null, isBye = false;

    if (match) {
      isBye = match.match_is_bye;

      if (isBye) {
        result = 'W';
        score  = 'BYE';
      } else if (match.match_is_intentional_draw || match.match_is_unintentional_draw) {
        result = 'D';
        score  = `${match.games_drawn ?? 1}-${match.games_drawn ?? 1}`;
      } else if (match.winning_player != null) {
        result = match.winning_player === pid ? 'W' : 'L';
        const myGames  = match.winning_player === pid ? match.games_won_by_winner : match.games_won_by_loser;
        const oppGames = match.winning_player === pid ? match.games_won_by_loser  : match.games_won_by_winner;
        score = `${myGames}-${oppGames}`;
      }

      // Opponent from player_match_relationships
      const oppRel = (match.player_match_relationships || []).find(rel => rel.player.id !== pid);
      if (oppRel) {
        opponent = oppRel.user_event_status?.best_identifier || oppRel.player?.best_identifier || null;
        opponentId = oppRel.player.id;
      }
    }

    history.push({
      round_number: r.round_number,
      phase_name:   r.phase_name,
      result, score, opponent, opponentId, isBye,
      live:   isLive,
      rank:   st?.rank   ?? null,
      record: st?.record ?? null,
      points: st?.points ?? null,
      omw:    st?.opponent_match_win_percentage ?? null,
      gw:     st?.game_win_percentage           ?? null,
    });
  }
  return history;
}

// ── PROJECT RANK ─────────────────────────────────
export function projectRank(pid, projPts, myOMW, allStandings, myRemaining, othersRemaining) {
  const myCeiling = projPts + myRemaining * 3;
  let defAbove = 0, mayAbove = 0, absAbove = 0;
  for (const p of allStandings) {
    if (p.id === pid) continue;
    const P   = p.points;
    const omw = p.opponent_match_win_percentage ?? 0;
    if (P > myCeiling)                                              defAbove++;
    if (P > projPts || (P === projPts && omw > myOMW))             mayAbove++;
    // >= not >: a player who ends tied with me in pts could rank above via tiebreakers
    if (P + othersRemaining * 3 >= projPts)                        absAbove++;
  }
  return { best: defAbove + 1, worst: mayAbove + 1, absoluteWorst: absAbove + 1 };
}
