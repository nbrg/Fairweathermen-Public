import { db } from "./db";
import { groups, matches, predictions, teams, users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { Match, MatchWithTeams, Prediction, PredictionWithMatch, Team, User, UserWithPredictions } from "@shared/schema";
import { DEFAULT_GROUP_RULES, resolveGroupRules } from "@shared/schema";
import { performance } from "perf_hooks";

// Lawro points for a group, resolved from its rules (falls back to the built-in
// 3/1 defaults when no group is given or it has no overrides). Centralises the
// one place the point values come from so the scoring + leaderboard agree.
async function lawroPointsForGroup(
  groupId?: number,
): Promise<{ exact: number; result: number }> {
  if (groupId == null) {
    return {
      exact: DEFAULT_GROUP_RULES.lawro.exactScorePoints,
      result: DEFAULT_GROUP_RULES.lawro.correctResultPoints,
    };
  }
  const [group] = await db.select({ rules: groups.rules }).from(groups).where(eq(groups.id, groupId));
  const rules = resolveGroupRules(group?.rules);
  return { exact: rules.lawro.exactScorePoints, result: rules.lawro.correctResultPoints };
}

// Keep only the latest season's rows (mirrors storage.filterToCurrentSeason).
// Falls back to all rows if none are season-tagged (legacy data).
function filterToCurrentSeason<T extends { season: string | null }>(rows: T[]): T[] {
  const seasons = rows.map((r) => r.season).filter((s): s is string => !!s);
  if (seasons.length === 0) return rows;
  const current = seasons.sort()[seasons.length - 1];
  return rows.filter((r) => r.season === current);
}

/**
 * Helper function to sort matches chronologically
 */
function sortMatchesChronologically(matches: Match[]): Match[] {
  const dayOrder = ['Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu'];
  
  return matches.sort((a, b) => {
    // Extract day from match_day (e.g., "Fri 15 Aug" -> "Fri")
    const dayA = a.matchDay?.split(' ')[0] || '';
    const dayB = b.matchDay?.split(' ')[0] || '';
    
    const dayIndexA = dayOrder.indexOf(dayA);
    const dayIndexB = dayOrder.indexOf(dayB);
    
    // First sort by day
    if (dayIndexA !== dayIndexB) {
      return dayIndexA - dayIndexB;
    }
    
    // Then sort by time (assuming format "HH:MM")
    const timeA = a.matchTime || '';
    const timeB = b.matchTime || '';
    
    return timeA.localeCompare(timeB);
  });
}

/**
 * Optimized version of the predictions with matches query
 * This version avoids the N+1 query problem by:
 * 1. Getting all predictions in a single query
 * 2. Getting all matches and teams in single queries
 * 3. Joining the data in memory with O(1) lookups using Maps
 */
export async function getOptimizedPredictionsWithMatches(groupId?: number): Promise<PredictionWithMatch[]> {
  const startTime = performance.now();
  console.log("Starting optimized predictions query");

  try {
    // Step 1: Get all predictions in a single query. When a groupId is given,
    // scope to just that group's players — the Prediction League ("Lawro") is a
    // per-group game, so a group only ever sees its own members' predictions.
    const allPredictionsRaw = await db.select().from(predictions);
    let allPredictions = allPredictionsRaw;
    if (groupId != null) {
      const groupUsers = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.groupId, groupId));
      const groupUserIds = new Set(groupUsers.map((u) => u.id));
      allPredictions = allPredictionsRaw.filter((p) => groupUserIds.has(p.userId));
    }
    console.log(`Got ${allPredictions.length} predictions in ${Math.round(performance.now() - startTime)}ms`);
    
    // Step 2: Get matches, scoped to the current season, and sort
    // chronologically. Scoping here keeps the leaderboard/predictions to this
    // season only — otherwise a group's totals would accumulate across every
    // season of fixtures (the grid is already current-season via
    // getAllMatchesWithTeams, so this keeps them in step and resets each season).
    const allMatchesRaw = filterToCurrentSeason(await db.select().from(matches));
    const allMatches = sortMatchesChronologically(allMatchesRaw);
    console.log(`Got ${allMatches.length} matches in ${Math.round(performance.now() - startTime)}ms`);
    
    // Step 3: Get all teams in a single query
    const allTeams = await db.select().from(teams);
    console.log(`Got ${allTeams.length} teams in ${Math.round(performance.now() - startTime)}ms`);

    // This group's configurable Lawro point values (defaults 3/1).
    const points = await lawroPointsForGroup(groupId);
    
    // Step 4: Create lookup maps for O(1) access
    const teamsMap = new Map<number, Team>();
    for (const team of allTeams) {
      teamsMap.set(team.id, team);
    }
    
    // Step 5: Create matches with teams map
    const matchesMap = new Map<number, MatchWithTeams>();
    for (const match of allMatches) {
      const homeTeam = teamsMap.get(match.homeTeamId);
      const awayTeam = teamsMap.get(match.awayTeamId);
      
      if (homeTeam && awayTeam) {
        matchesMap.set(match.id, {
          ...match,
          homeTeam,
          awayTeam
        });
      }
    }
    
    // Step 6: Calculate prediction results maintaining chronological match order
    const result: PredictionWithMatch[] = [];
    
    // Process predictions in chronological match order
    for (const match of allMatches) {
      const matchPredictions = allPredictions.filter(p => p.matchId === match.id);
      
      for (const prediction of matchPredictions) {
        const { points: predPoints, status } = calculatePoints(prediction, match, points);

        result.push({
          ...prediction,
          match: {
            ...match,
            homeTeam: teamsMap.get(match.homeTeamId)!,
            awayTeam: teamsMap.get(match.awayTeamId)!
          },
          points: predPoints,
          status: status as any
        });
      }
    }
    
    const endTime = performance.now();
    console.log(`Optimized predictions query completed in ${Math.round(endTime - startTime)}ms`);
    
    return result;
  } catch (error) {
    console.error("Error in optimized predictions query:", error);
    throw error;
  }
}

/**
 * Optimized version of the leaderboard query
 * This builds on the optimized predictions query and efficiently calculates the leaderboard
 */
export async function getOptimizedLeaderboard(groupId?: number): Promise<UserWithPredictions[]> {
  const startTime = performance.now();
  console.log("Starting optimized leaderboard query");

  try {
    // Step 1: Get the users in a single query. Scope to the group when given so
    // the Prediction League leaderboard only lists that group's players.
    const allUsers = groupId != null
      ? await db.select().from(users).where(eq(users.groupId, groupId))
      : await db.select().from(users);
    console.log(`Got ${allUsers.length} users in ${Math.round(performance.now() - startTime)}ms`);

    // Step: 2: Get optimized predictions with matches (same group scope)
    const allPredictionsWithMatches = await getOptimizedPredictionsWithMatches(groupId);

    // This group's configurable Lawro point values (defaults 3/1), so the
    // leaderboard tally matches the per-prediction scoring above.
    const points = await lawroPointsForGroup(groupId);
    
    // Step 3: Group predictions by user ID
    const predictionsByUser = new Map<number, PredictionWithMatch[]>();
    for (const prediction of allPredictionsWithMatches) {
      const userId = prediction.userId;
      if (!predictionsByUser.has(userId)) {
        predictionsByUser.set(userId, []);
      }
      predictionsByUser.get(userId)!.push(prediction);
    }
    
    // Step 4: Calculate leaderboard in a single pass
    const leaderboard: UserWithPredictions[] = [];
    
    for (const user of allUsers) {
      const userPredictions = predictionsByUser.get(user.id) || [];
      
      let exactScores = 0;
      let correctResults = 0;
      let totalPoints = 0;
      
      for (const prediction of userPredictions) {
        if (prediction.status === "exact_score") {
          exactScores++;
          totalPoints += points.exact;
        } else if (prediction.status === "correct_result") {
          correctResults++;
          totalPoints += points.result;
        }
      }
      
      leaderboard.push({
        ...user,
        predictions: userPredictions,
        exactScores,
        correctResults,
        totalPoints
      });
    }
    
    // Step 5: Sort by the tiebreak chain — total points, then exact scores,
    // then correct results, all descending, and finally username alphabetically.
    leaderboard.sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      if (b.exactScores !== a.exactScores) return b.exactScores - a.exactScores;
      if (b.correctResults !== a.correctResults) return b.correctResults - a.correctResults;
      return (a.username || "").localeCompare(b.username || "");
    });
    
    const endTime = performance.now();
    console.log(`Optimized leaderboard query completed in ${Math.round(endTime - startTime)}ms`);
    
    return leaderboard;
  } catch (error) {
    console.error("Error in optimized leaderboard query:", error);
    throw error;
  }
}

/**
 * Helper function to calculate points for a prediction
 */
function calculatePoints(
  prediction: Prediction,
  match: Match,
  points: { exact: number; result: number } = {
    exact: DEFAULT_GROUP_RULES.lawro.exactScorePoints,
    result: DEFAULT_GROUP_RULES.lawro.correctResultPoints,
  },
): { points: number, status: string } {
  // If match hasn't started or doesn't have scores yet
  if (match.status === "not_started" || match.homeScore === null || match.awayScore === null) {
    return { points: 0, status: "not_started" };
  }

  // Exact score (configurable; default 3 points)
  if (prediction.homeScore === match.homeScore && prediction.awayScore === match.awayScore) {
    return { points: points.exact, status: "exact_score" };
  }
  
  // Correct result type: win, lose, or draw (1 point)
  const predictionResult = prediction.homeScore > prediction.awayScore 
    ? "home_win" 
    : prediction.homeScore < prediction.awayScore 
      ? "away_win" 
      : "draw";
  
  const matchResult = match.homeScore > match.awayScore 
    ? "home_win" 
    : match.homeScore < match.awayScore 
      ? "away_win" 
      : "draw";
  
  if (predictionResult === matchResult) {
    return { points: points.result, status: "correct_result" };
  }
  
  // Incorrect result (0 points)
  return { points: 0, status: "incorrect" };
}