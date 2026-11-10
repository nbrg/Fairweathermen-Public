import { 
  User, Team, Match, Prediction, InsertUser, InsertTeam, 
  InsertMatch, InsertPrediction, MatchWithTeams, PredictionWithMatch,
  UserWithPredictions, LmsCompetition, LmsParticipant, LmsSelection,
  InsertLmsCompetition, InsertLmsParticipant, InsertLmsSelection,
  LmsSelectionLog, InsertLmsSelectionLog, ActivityLog, InsertActivityLog,
  users, teams, matches, predictions, lmsCompetitions, lmsParticipants, lmsSelections,
  lmsSelectionLogs, activityLogs,
} from "@shared/schema";
import { londonStringToUtcMs } from "@shared/time";
import { db } from "./db";
import { and, eq, desc, inArray, isNull } from "drizzle-orm";

type PredictionSaveInput = {
  userId: number; matchId: number; homeScore: number | null; awayScore: number | null;
  isAutoPick?: boolean; isJoker?: boolean;
};

export interface IStorage {
  // User methods
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getAllUsers(): Promise<User[]>;
  
  // Team methods
  getTeam(id: number): Promise<Team | undefined>;
  getTeamByName(name: string): Promise<Team | undefined>;
  createTeam(team: InsertTeam): Promise<Team>;
  getAllTeams(): Promise<Team[]>;
  
  // Match methods
  getMatch(id: number): Promise<Match | undefined>;
  getMatchWithTeams(id: number): Promise<MatchWithTeams | undefined>;
  createMatch(match: InsertMatch): Promise<Match>;
  updateMatch(id: number, match: Partial<Match>): Promise<Match | undefined>;
  getAllMatches(): Promise<Match[]>;
  getAllMatchesWithTeams(allSeasons?: boolean): Promise<MatchWithTeams[]>;
  getMatchesByGameweek(gameweek: number): Promise<MatchWithTeams[]>;
  getGameweekDeadline(gameweek: number): Promise<Date | null>;
  deleteMatchesBySeason(season: string): Promise<number>;
  backfillNullSeasons(season: string): Promise<number>;
  
  // Prediction methods
  getPrediction(id: number): Promise<Prediction | undefined>;
  getUserPredictions(userId: number): Promise<Prediction[]>;
  createPrediction(prediction: InsertPrediction): Promise<Prediction>;
  savePrediction(input: PredictionSaveInput, validate: (existing: Prediction | undefined) => Promise<{ isLatePick: boolean }>): Promise<{ prediction: Prediction | null; previous: Prediction | undefined; changed: boolean }>;
  updatePrediction(id: number, homeScore: number, awayScore: number): Promise<Prediction | undefined>;
  deletePrediction(id: number): Promise<boolean>;
  setPredictionJoker(userId: number, predictionId: number, joker: boolean, gameweekMatchIds: number[]): Promise<void>;
  getAllPredictions(): Promise<Prediction[]>;
  getPredictionByUserAndMatch(userId: number, matchId: number): Promise<Prediction | undefined>;
  // Complex methods
  getUserPredictionsWithMatches(userId: number): Promise<PredictionWithMatch[]>;

  // Last Man Standing methods
  getLmsCompetition(id: number): Promise<LmsCompetition | undefined>;
  getCurrentLmsCompetition(groupId?: number): Promise<LmsCompetition | undefined>;
  getActiveLmsCompetitions(): Promise<LmsCompetition[]>;
  createLmsCompetition(competition: InsertLmsCompetition): Promise<LmsCompetition>;
  updateLmsCompetition(id: number, data: Partial<LmsCompetition>): Promise<LmsCompetition | undefined>;
  getAllLmsCompetitions(groupId?: number): Promise<LmsCompetition[]>;
  
  getLmsParticipant(id: number): Promise<LmsParticipant | undefined>;
  createLmsParticipant(participant: InsertLmsParticipant): Promise<LmsParticipant>;
  updateLmsParticipant(id: number, data: Partial<LmsParticipant>): Promise<LmsParticipant | undefined>;
  getLmsParticipantsByCompetition(competitionId: number): Promise<LmsParticipant[]>;
  
  getLmsSelection(id: number): Promise<LmsSelection | undefined>;
  createLmsSelection(selection: InsertLmsSelection): Promise<LmsSelection>;
  updateLmsSelection(id: number, data: Partial<LmsSelection>): Promise<LmsSelection | undefined>;
  deleteLmsSelection(id: number): Promise<void>;
  getLmsSelectionsByParticipant(participantId: number): Promise<LmsSelection[]>;
  
  // LMS Selection Logging methods
  createLmsSelectionLog(log: InsertLmsSelectionLog): Promise<LmsSelectionLog>;

  // Activity Logs
  createActivityLog(log: InsertActivityLog): Promise<ActivityLog>;
  getActivityLogs(limit?: number): Promise<ActivityLog[]>;

}

// We keep every season's fixtures in the `matches` table (for history), but the
// live game + Fixtures tab should only ever see the current season. Treat the
// latest season string present as current; if none are tagged yet (legacy data
// before the season column was populated), return everything unchanged.
function filterToCurrentSeason<T extends { season: string | null }>(rows: T[]): T[] {
  const seasons = rows.map((r) => r.season).filter((s): s is string => !!s);
  if (seasons.length === 0) return rows;
  const current = seasons.sort()[seasons.length - 1];
  return rows.filter((r) => r.season === current);
}

export class DatabaseStorage implements IStorage {
  /**
   * Helper function to sort matches chronologically
   */
  private sortMatchesChronologically(matches: Match[]): Match[] {
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

  // User methods
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }
  
  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users);
  }

  // Team methods
  async getTeam(id: number): Promise<Team | undefined> {
    const [team] = await db.select().from(teams).where(eq(teams.id, id));
    return team || undefined;
  }

  async getTeamByName(name: string): Promise<Team | undefined> {
    const [team] = await db.select().from(teams).where(eq(teams.name, name));
    return team || undefined;
  }

  async createTeam(insertTeam: InsertTeam): Promise<Team> {
    const [team] = await db.insert(teams).values(insertTeam).returning();
    return team;
  }
  
  async getAllTeams(): Promise<Team[]> {
    return await db.select().from(teams);
  }

  // Match methods
  async getMatch(id: number): Promise<Match | undefined> {
    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    return match || undefined;
  }

  async getMatchWithTeams(id: number): Promise<MatchWithTeams | undefined> {
    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return undefined;
    
    const homeTeam = await this.getTeam(match.homeTeamId);
    const awayTeam = await this.getTeam(match.awayTeamId);
    
    if (!homeTeam || !awayTeam) return undefined;
    
    return {
      ...match,
      homeTeam,
      awayTeam
    };
  }

  async createMatch(insertMatch: InsertMatch): Promise<Match> {
    const [match] = await db.insert(matches).values({
      ...insertMatch,
      status: insertMatch.status || 'not_started',
      homeScore: insertMatch.homeScore ?? null,
      awayScore: insertMatch.awayScore ?? null
    }).returning();
    
    return match;
  }

  async updateMatch(id: number, matchUpdate: Partial<Match>): Promise<Match | undefined> {
    const [updatedMatch] = await db.update(matches)
      .set(matchUpdate)
      .where(eq(matches.id, id))
      .returning();
      
    return updatedMatch || undefined;
  }
  
  async getAllMatches(): Promise<Match[]> {
    return filterToCurrentSeason(await db.select().from(matches));
  }

  async getAllMatchesWithTeams(allSeasons = false): Promise<MatchWithTeams[]> {
    // Get all matches and teams in a single query each for better performance.
    // `allSeasons` returns every season's fixtures (used to resolve historical
    // LMS opponents by matchId, incl. teams since relegated); the default keeps
    // to the current season.
    const rows = await db.select().from(matches);
    const allMatchesRaw = allSeasons ? rows : filterToCurrentSeason(rows);
    const allMatches = this.sortMatchesChronologically(allMatchesRaw);
    const allTeams = await db.select().from(teams);
    
    // Create a map of team IDs to team objects for faster lookup
    const teamMap = new Map();
    for (const team of allTeams) {
      teamMap.set(team.id, team);
    }
    
    // Join the data in memory (much faster than multiple database queries)
    const matchesWithTeams: MatchWithTeams[] = [];
    for (const match of allMatches) {
      const homeTeam = teamMap.get(match.homeTeamId);
      const awayTeam = teamMap.get(match.awayTeamId);
      
      if (homeTeam && awayTeam) {
        matchesWithTeams.push({
          ...match,
          homeTeam,
          awayTeam
        });
      }
    }
    
    return matchesWithTeams;
  }

  async getMatchesByGameweek(gameweek: number): Promise<MatchWithTeams[]> {
    // Get matches for specific gameweek and teams in a single query each for better performance
    const gameweekMatchesRaw = filterToCurrentSeason(
      await db.select().from(matches).where(eq(matches.gameweek, gameweek)),
    );
    const gameweekMatches = this.sortMatchesChronologically(gameweekMatchesRaw);
    const allTeams = await db.select().from(teams);
    
    // Create a map of team IDs to team objects for faster lookup
    const teamMap = new Map();
    for (const team of allTeams) {
      teamMap.set(team.id, team);
    }
    
    // Join the data in memory (much faster than multiple database queries)
    const matchesWithTeams: MatchWithTeams[] = [];
    for (const match of gameweekMatches) {
      const homeTeam = teamMap.get(match.homeTeamId);
      const awayTeam = teamMap.get(match.awayTeamId);
      
      if (homeTeam && awayTeam) {
        matchesWithTeams.push({
          ...match,
          homeTeam,
          awayTeam
        });
      }
    }
    
    return matchesWithTeams;
  }

  // The Prediction League ("Lawro") deadline for a gameweek: the earliest
  // kickoff among that gameweek's matches (current season). Picks lock from this
  // moment. Returns null if the gameweek has no fixtures. matchTime is a naive
  // London-local "YYYY-MM-DD HH:MM:SS" string, so convert via londonStringToUtcMs
  // rather than a naive Date parse (which would be off by the UK offset).
  async getGameweekDeadline(gameweek: number): Promise<Date | null> {
    const gwMatches = await this.getMatchesByGameweek(gameweek);
    const times = gwMatches
      .map((m) => londonStringToUtcMs(m.matchTime))
      .filter((t) => !Number.isNaN(t));
    if (times.length === 0) return null;
    return new Date(Math.min(...times));
  }

  // Prediction methods
  async getPrediction(id: number): Promise<Prediction | undefined> {
    const [prediction] = await db.select().from(predictions).where(eq(predictions.id, id));
    return prediction || undefined;
  }

  async getUserPredictions(userId: number): Promise<Prediction[]> {
    return await db.select()
      .from(predictions)
      .where(eq(predictions.userId, userId));
  }

  async createPrediction(insertPrediction: InsertPrediction): Promise<Prediction> {
    // All creators (including missed-pick filling and older clients) share the
    // same row lock, so simultaneous creates cannot insert duplicate picks.
    const result = await this.savePrediction(insertPrediction, async existing => ({
      isLatePick: existing?.isLatePick ?? insertPrediction.isLatePick ?? false,
    }));
    return result.prediction!;
  }

  async savePrediction(
    input: PredictionSaveInput,
    validate: (existing: Prediction | undefined) => Promise<{ isLatePick: boolean }>,
  ): Promise<{ prediction: Prediction | null; previous: Prediction | undefined; changed: boolean }> {
    return db.transaction(async tx => {
      // The user row exists even before their first prediction. Locking it
      // serializes check/insert across processes without a schema migration.
      const [owner] = await tx.select({ id: users.id }).from(users)
        .where(eq(users.id, input.userId)).for("update");
      if (!owner) throw new Error("Prediction owner not found");
      const identity = and(eq(predictions.userId, input.userId), eq(predictions.matchId, input.matchId));
      const [previous] = await tx.select().from(predictions).where(identity);
      const flags = await validate(previous);
      if (input.homeScore === null || input.awayScore === null) {
        if (previous) await tx.delete(predictions).where(identity);
        return { prediction: null, previous, changed: !!previous };
      }
      if (previous) {
        if (previous.homeScore === input.homeScore && previous.awayScore === input.awayScore) {
          return { prediction: previous, previous, changed: false };
        }
        const [prediction] = await tx.update(predictions)
          .set({ homeScore: input.homeScore, awayScore: input.awayScore })
          .where(identity).returning();
        return { prediction, previous, changed: true };
      }
      const [prediction] = await tx.insert(predictions).values({
        ...input, homeScore: input.homeScore, awayScore: input.awayScore,
        isAutoPick: input.isAutoPick ?? false, isJoker: input.isJoker ?? false, isLatePick: flags.isLatePick,
      }).returning();
      return { prediction, previous, changed: true };
    });
  }
  
  async updatePrediction(id: number, homeScore: number, awayScore: number): Promise<Prediction | undefined> {
    const [updated] = await db.update(predictions)
      .set({ homeScore, awayScore })
      .where(eq(predictions.id, id))
      .returning();
    return updated || undefined;
  }

  async deletePrediction(id: number): Promise<boolean> {
    const result = await db.delete(predictions)
      .where(eq(predictions.id, id))
      .returning();
    return result.length > 0;
  }

  // Make one of a player's predictions their gameweek Joker (or take it off).
  // Setting it clears the flag from their other picks in the same gameweek, so
  // they only ever have one.
  async setPredictionJoker(
    userId: number,
    predictionId: number,
    joker: boolean,
    gameweekMatchIds: number[],
  ): Promise<void> {
    if (joker && gameweekMatchIds.length > 0) {
      await db.update(predictions)
        .set({ isJoker: false })
        .where(and(
          eq(predictions.userId, userId),
          inArray(predictions.matchId, gameweekMatchIds),
          eq(predictions.isJoker, true),
        ));
    }
    await db.update(predictions)
      .set({ isJoker: joker })
      .where(and(eq(predictions.id, predictionId), eq(predictions.userId, userId)));
  }

  async getAllPredictions(): Promise<Prediction[]> {
    return await db.select().from(predictions);
  }
  
  async getPredictionByUserAndMatch(userId: number, matchId: number): Promise<Prediction | undefined> {
    const [prediction] = await db.select()
      .from(predictions)
      .where(and(
        eq(predictions.userId, userId),
        eq(predictions.matchId, matchId)
      ));
      
    return prediction || undefined;
  }
  
  // Helper to calculate points for a prediction
  private calculatePoints(prediction: Prediction, match: Match): { points: number, status: string } {
    // If match hasn't started or doesn't have scores yet
    if (match.status === "not_started" || match.homeScore === null || match.awayScore === null) {
      return { points: 0, status: "not_started" };
    }
    
    // Exact score (3 points)
    if (prediction.homeScore === match.homeScore && prediction.awayScore === match.awayScore) {
      return { points: 3, status: "exact_score" };
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
      return { points: 1, status: "correct_result" };
    }
    
    // Incorrect result (0 points)
    return { points: 0, status: "incorrect" };
  }

  // Complex methods
  async getUserPredictionsWithMatches(userId: number): Promise<PredictionWithMatch[]> {
    const predictions = await this.getUserPredictions(userId);
    const predictionWithMatches: PredictionWithMatch[] = [];
    
    for (const prediction of predictions) {
      const matchWithTeams = await this.getMatchWithTeams(prediction.matchId);
      
      if (matchWithTeams) {
        const { points, status } = this.calculatePoints(prediction, matchWithTeams);
        
        predictionWithMatches.push({
          ...prediction,
          match: matchWithTeams,
          points,
          status: status as any
        });
      }
    }
    
    return predictionWithMatches;
  }

  // Last Man Standing methods - using proper Drizzle syntax
  async getLmsCompetition(id: number): Promise<LmsCompetition | undefined> {
    const [row] = await db.select().from(lmsCompetitions).where(eq(lmsCompetitions.id, id));
    return row || undefined;
  }

  async getCurrentLmsCompetition(groupId?: number): Promise<LmsCompetition | undefined> {
    if (groupId !== undefined) {
      const results = await db.select().from(lmsCompetitions)
        .where(and(eq(lmsCompetitions.status, 'active'), eq(lmsCompetitions.groupId, groupId)))
        .orderBy(desc(lmsCompetitions.id))
        .limit(1);
      return results[0] || undefined;
    } else {
      const results = await db.select().from(lmsCompetitions)
        .where(eq(lmsCompetitions.status, 'active'))
        .orderBy(desc(lmsCompetitions.id))
        .limit(1);
      return results[0] || undefined;
    }
  }

  // Every active competition across ALL groups. The background processor is a
  // global cron, so it must consider each group's competition — not just the
  // single newest one (getCurrentLmsCompetition with no group arg returns only
  // that, which silently starved other groups' randomiser/result processing).
  async getActiveLmsCompetitions(): Promise<LmsCompetition[]> {
    return await db.select().from(lmsCompetitions)
      .where(eq(lmsCompetitions.status, 'active'))
      .orderBy(desc(lmsCompetitions.id));
  }

  async createLmsCompetition(competition: InsertLmsCompetition): Promise<LmsCompetition> {
    console.log(`Creating new LMS competition:`, competition);
    
    const result = await db.insert(lmsCompetitions).values({
      groupId: competition.groupId || 1,
      // Persist the season when provided so a new season's competition is
      // grouped correctly (otherwise it silently inherits the column default
      // "2025/2026" and is mistaken for last season).
      ...(competition.season ? { season: competition.season } : {}),
      name: competition.name,
      startGameweek: competition.startGameweek,
      currentGameweek: competition.currentGameweek,
      status: competition.status || 'active',
      winnerId: competition.winnerId || null,
      // Persist the buy-in when given (a group's configured LMS buy-in);
      // otherwise the column default applies.
      ...(competition.prizeAmount != null ? { prizeAmount: competition.prizeAmount } : {}),
      ...(competition.stakeGbp != null ? { stakeGbp: competition.stakeGbp } : {}),
    }).returning();
    
    console.log(`Created competition ${result[0].id} for group ${competition.groupId || 1} successfully`);
    return result[0];
  }

  async updateLmsCompetition(id: number, data: Partial<LmsCompetition>): Promise<LmsCompetition | undefined> {
    if (Object.keys(data).length === 0) {
      return this.getLmsCompetition(id);
    }

    // Use Drizzle ORM instead of raw SQL to avoid parameter issues
    try {
      const updateData: any = {};
      
      if (data.currentGameweek !== undefined) {
        console.log(`Updating competition ${id} to gameweek ${data.currentGameweek}`);
        updateData.currentGameweek = data.currentGameweek;
      }
      
      if (data.status !== undefined) {
        console.log(`Updating competition ${id} status to ${data.status}`);
        updateData.status = data.status;
      }
      
      if (data.winnerId !== undefined) {
        console.log(`Updating competition ${id} winner to ${data.winnerId}`);
        updateData.winnerId = data.winnerId;
      }

      if (data.prizeAmount !== undefined) updateData.prizeAmount = data.prizeAmount;
      if (data.stakeGbp !== undefined) updateData.stakeGbp = data.stakeGbp;

      const result = await db.update(lmsCompetitions)
        .set(updateData)
        .where(eq(lmsCompetitions.id, id))
        .returning();
      
      console.log(`Update successful for competition ${id}`);
      return result[0] || undefined;
    } catch (error) {
      console.error(`Error updating LMS competition ${id}:`, error);
      throw error;
    }
  }

  async getAllLmsCompetitions(groupId?: number): Promise<LmsCompetition[]> {
    if (groupId !== undefined) {
      return await db.select().from(lmsCompetitions)
        .where(eq(lmsCompetitions.groupId, groupId))
        .orderBy(desc(lmsCompetitions.createdAt));
    } else {
      return await db.select().from(lmsCompetitions)
        .orderBy(desc(lmsCompetitions.createdAt));
    }
  }

  async getLmsParticipant(id: number): Promise<LmsParticipant | undefined> {
    const result = await db.select().from(lmsParticipants).where(eq(lmsParticipants.id, id));
    return result[0] || undefined;
  }

  async createLmsParticipant(participant: InsertLmsParticipant): Promise<LmsParticipant> {
    const result = await db.insert(lmsParticipants).values({
      competitionId: participant.competitionId,
      userId: participant.userId,
      isActive: participant.isActive || 'true',
      eliminatedInRound: participant.eliminatedInRound || null
    }).returning();
    return result[0];
  }

  async updateLmsParticipant(id: number, data: Partial<LmsParticipant>): Promise<LmsParticipant | undefined> {
    const result = await db.update(lmsParticipants).set(data).where(eq(lmsParticipants.id, id)).returning();
    return result[0] || undefined;
  }

  async getLmsParticipantsByCompetition(competitionId: number): Promise<LmsParticipant[]> {
    return await db.select().from(lmsParticipants).where(eq(lmsParticipants.competitionId, competitionId));
  }

  async getLmsSelection(id: number): Promise<LmsSelection | undefined> {
    const [row] = await db.select().from(lmsSelections).where(eq(lmsSelections.id, id));
    return row || undefined;
  }

  async createLmsSelection(selection: InsertLmsSelection): Promise<LmsSelection> {
    const result = await db.insert(lmsSelections).values({
      participantId: selection.participantId,
      gameweek: selection.gameweek,
      teamId: selection.teamId,
      matchId: selection.matchId || null,
      result: selection.result || null,
      isRandomlyAssigned: selection.isRandomlyAssigned || 'false'
    }).returning();
    return result[0];
  }

  async updateLmsSelection(id: number, data: Partial<LmsSelection>): Promise<LmsSelection | undefined> {
    const result = await db.update(lmsSelections).set(data).where(eq(lmsSelections.id, id)).returning();
    return result[0] || undefined;
  }

  async deleteLmsSelection(id: number): Promise<void> {
    await db.delete(lmsSelections).where(eq(lmsSelections.id, id));
  }

  async getLmsSelectionsByParticipant(participantId: number): Promise<LmsSelection[]> {
    return await db.select().from(lmsSelections).where(eq(lmsSelections.participantId, participantId)).orderBy(lmsSelections.gameweek);
  }

  async createLmsSelectionLog(log: InsertLmsSelectionLog): Promise<LmsSelectionLog> {
    const result = await db.insert(lmsSelectionLogs).values({
      participantId: log.participantId,
      gameweek: log.gameweek,
      originalTeamId: log.originalTeamId || null,
      newTeamId: log.newTeamId,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent || null, // was dropped here — Device showed "?" in /audit
      city: log.city || null,
      country: log.country || null
    }).returning();
    return result[0];
  }

  async createActivityLog(log: InsertActivityLog): Promise<ActivityLog> {
    const result = await db.insert(activityLogs).values({
      type: log.type,
      userId: log.userId || null,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent || null,
      city: log.city || null,
      country: log.country || null,
      path: log.path || null,
      details: log.details || null,
      groupId: (log as any).groupId ?? null,
    }).returning();
    return result[0];
  }

  async getActivityLogs(limit: number = 100): Promise<ActivityLog[]> {
    return await db.select().from(activityLogs)
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit);
  }

  // Additional methods needed for Excel import
  // Delete only one season's fixtures (used to re-import a season idempotently
  // without touching other seasons' history).
  async deleteMatchesBySeason(season: string): Promise<number> {
    const deleted = await db.delete(matches).where(eq(matches.season, season)).returning();
    return deleted.length;
  }

  // One-time tagging of legacy fixtures that predate the season column.
  async backfillNullSeasons(season: string): Promise<number> {
    const updated = await db
      .update(matches)
      .set({ season })
      .where(isNull(matches.season))
      .returning();
    return updated.length;
  }
}

// Use the database storage implementation
export const storage = new DatabaseStorage();
