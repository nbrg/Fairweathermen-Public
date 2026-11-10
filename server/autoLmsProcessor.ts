import cron from 'node-cron';
import { randomInt } from 'crypto';
import { storage } from './storage';
import { lmsProcessor } from './lmsProcessor';
import { getGroupRules } from './groupRules';
import { syncGameweek, getLiveOrImminentGameweeks } from './footballDataApi';
import { plLiveWindowActive, invalidatePlSchedule } from './scheduleGate';
import { londonStringToUtcMs } from '@shared/time';
import type { LmsCompetition, Match } from '@shared/schema';

// Helper function to check if a gameweek is locked (deadline has passed).
// Selections lock `lockMinutesBeforeKickoff` minutes before the first match
// (0 = at kickoff), matching the offset the routes use.
async function isGameweekLocked(gameweek: number, lockMinutesBeforeKickoff = 0): Promise<boolean> {
  const matches = await storage.getAllMatches();
  const gameweekMatches = matches.filter(m => m.gameweek === gameweek);

  if (gameweekMatches.length === 0) return false;

  // Find the earliest match time for this gameweek
  const earliestMatch = gameweekMatches.reduce((earliest, current) => {
    const currentTime = new Date(current.matchTime).getTime();
    const earliestTime = new Date(earliest.matchTime).getTime();
    return currentTime < earliestTime ? current : earliest;
  });

  // Get current time in London timezone
  const nowLondon = new Date().toLocaleString("en-US", { timeZone: "Europe/London" });
  const now = new Date(nowLondon);

  // Treat database time as London time; lock the configured minutes before kickoff.
  const matchTimeLondon = new Date(earliestMatch.matchTime).getTime();
  const lockAt = matchTimeLondon - lockMinutesBeforeKickoff * 60 * 1000;
  return now.getTime() >= lockAt;
}

// The teams playing a given gameweek in the current season, each mapped to its
// fixture. Built from season-scoped matches (storage.getAllMatches), so teams
// with no current-season fixture — e.g. relegated clubs still present in the
// teams table — are naturally excluded, and every eligible team has a real
// match that can be scored.
export function eligibleTeamsForGameweek(matches: Match[], gameweek: number): Map<number, Match> {
  const map = new Map<number, Match>();
  for (const m of matches) {
    if (m.gameweek !== gameweek) continue;
    if (m.homeTeamId != null) map.set(m.homeTeamId, m);
    if (m.awayTeamId != null) map.set(m.awayTeamId, m);
  }
  return map;
}

// Randomly assign teams to participants without selections. The competition is
// passed in explicitly so this works for every group's competition, not just
// the single newest active one. Exported so routes.ts shares this exact logic
// rather than keeping a divergent copy. A team a player has already used is
// never eligible again — reusing teams is not allowed.
export async function assignRandomTeams(
  competition: LmsCompetition,
  gameweek: number,
): Promise<void> {
  // Don't assign teams for gameweeks before the competition started
  if (gameweek < competition.startGameweek) return;

  // The pool of valid picks is the teams actually playing THIS gameweek in the
  // current season — not getAllTeams(), which still contains relegated clubs
  // from prior seasons. getAllMatches() is season-scoped, so this excludes
  // relegated teams and guarantees the pick maps to a real match that can be
  // scored (rather than a null matchId that would never resolve).
  const eligible = eligibleTeamsForGameweek(await storage.getAllMatches(), gameweek);
  if (eligible.size === 0) {
    console.warn(`[Auto] No current-season fixtures for GW${gameweek}; skipping random assignment.`);
    return;
  }
  const teamNames = new Map((await storage.getAllTeams()).map(t => [t.id, t.name]));

  const participants = await storage.getLmsParticipantsByCompetition(competition.id);
  const activeParticipants = participants.filter(p => p.isActive === 'true');

  for (const participant of activeParticipants) {
    const selections = await storage.getLmsSelectionsByParticipant(participant.id);
    const hasSelectionForGameweek = selections.some(s => s.gameweek === gameweek);
    if (hasSelectionForGameweek) continue;

    // Teams this participant has already used are ineligible — team reuse is
    // never allowed.
    const usedTeamIds = new Set(selections.map(s => s.teamId));
    const availableTeamIds = Array.from(eligible.keys()).filter(id => !usedTeamIds.has(id));
    if (availableTeamIds.length === 0) continue;

    const randomTeamId = availableTeamIds[randomInt(availableTeamIds.length)];
    const relevantMatch = eligible.get(randomTeamId)!;

    await storage.createLmsSelection({
      participantId: participant.id,
      gameweek: gameweek,
      teamId: randomTeamId,
      matchId: relevantMatch.id,
      result: null,
      isRandomlyAssigned: 'true'
    });

    console.log(`[Auto] Randomly assigned ${teamNames.get(randomTeamId) ?? `team ${randomTeamId}`} to participant ${participant.id} for gameweek ${gameweek}`);
  }
}

// Apply a group's "missed pick" rule to everyone with no selection for a locked
// gameweek. Default is "random" (assign a team), which reproduces the app's
// long-standing behaviour. "eliminate" treats the missed pick as a losing pick
// — it costs the player one life, and only knocks them out if it was their
// last one (so a group playing with multiple lives doesn't lose a no-show
// outright).
// One missed-pick run per competition at a time. The per-minute job and the
// gameweek-status endpoint (polled by every open LMS page) both call this once
// the deadline passes; run concurrently, each could see "no pick yet" and draw
// a team, giving a player two random picks.
const missedPickRuns = new Map<number, Promise<void>>();

export function processMissedLmsPicks(
  competition: LmsCompetition,
  gameweek: number,
): Promise<void> {
  const previous = missedPickRuns.get(competition.id) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => processMissedLmsPicksNow(competition, gameweek));
  missedPickRuns.set(competition.id, run);
  run.finally(() => {
    if (missedPickRuns.get(competition.id) === run) missedPickRuns.delete(competition.id);
  }).catch(() => {});
  return run;
}

async function processMissedLmsPicksNow(
  competition: LmsCompetition,
  gameweek: number,
): Promise<void> {
  if (gameweek < competition.startGameweek) return;
  const rules = await getGroupRules(competition.groupId);
  const policy = rules.lms.missedPickPolicy;

  if (policy === "random") {
    await assignRandomTeams(competition, gameweek);
    return;
  }

  // "eliminate": record the miss as a losing pick (teamId null) so the normal
  // cumulative-loss elimination in lmsProcessor counts it as one spent life and
  // only knocks the player out once they've used them all. Recording a row
  // (rather than flipping isActive here) keeps lives consistent between a losing
  // team pick and a no-show, and keeps this idempotent — a second run sees the
  // marker already there and does nothing.
  const participants = await storage.getLmsParticipantsByCompetition(competition.id);
  const activeParticipants = participants.filter(p => p.isActive === 'true');
  for (const participant of activeParticipants) {
    const selections = await storage.getLmsSelectionsByParticipant(participant.id);
    if (selections.some(s => s.gameweek === gameweek)) continue;
    await storage.createLmsSelection({
      participantId: participant.id,
      gameweek,
      teamId: null,
      matchId: null,
      result: 'l',
      isRandomlyAssigned: 'false',
    });
    console.log(`[Auto] Recorded missed pick (lost life) for participant ${participant.id} in GW${gameweek} (group rule: eliminate)`);
  }
}

/**
 * Automatically process LMS results when all selections have results
 * Also handles immediate random team assignment when deadlines pass
 */
class AutoLmsProcessor {
  private isProcessing = false;

  /**
   * Check if all selections for the competition's current gameweek have results
   */
  private async shouldProcessCompetition(competition: LmsCompetition): Promise<boolean> {
    try {
      const participants = await storage.getLmsParticipantsByCompetition(competition.id);
      const activeParticipants = participants.filter(p => p.isActive === 'true');

      if (activeParticipants.length === 0) {
        return false;
      }

      const currentGameweek = competition.currentGameweek || (competition as any).current_gameweek;

      // Get all selections for current gameweek
      const allSelections = await Promise.all(
        activeParticipants.map(async (participant) => {
          const selections = await storage.getLmsSelectionsByParticipant(participant.id);
          return selections.find(s => s.gameweek === currentGameweek);
        })
      );

      const currentGameweekSelections = allSelections.filter(Boolean);

      if (currentGameweekSelections.length === 0) {
        return false;
      }

      // Check if ALL selections have results
      const allHaveResults = currentGameweekSelections.every(s => s && s.result !== null);

      if (allHaveResults) {
        console.log(`[Auto] All GW${currentGameweek} selections have results - ready to process`);
      }

      return allHaveResults;
    } catch (error) {
      console.error(`[Auto] Error checking competition:`, error);
      return false;
    }
  }

  /**
   * Check deadlines and assign random teams for a competition's locked gameweek
   */
  async checkDeadlinesAndAssignRandomTeams(competition: LmsCompetition): Promise<void> {
    try {
      const currentGameweek = competition.currentGameweek || (competition as any).current_gameweek;

      // Check if deadline has passed for current gameweek, honouring the group's
      // configured LMS deadline offset.
      const rules = await getGroupRules(competition.groupId);
      const isLocked = await isGameweekLocked(currentGameweek, rules.lms.deadlineMinutesBeforeKickoff);

      if (isLocked) {
        // Apply the group's "missed pick" rule to anyone who hasn't selected.
        await processMissedLmsPicks(competition, currentGameweek);
      }
    } catch (error) {
      console.error('[Auto] Error checking deadlines:', error);
    }
  }

  /**
   * Check and process every active competition (all groups) if ready. This is a
   * global cron, so it must iterate all groups' competitions — not just the
   * single newest active one.
   */
  async checkAndProcess(): Promise<void> {
    if (this.isProcessing) {
      return; // Already processing, skip this cycle
    }

    // Nothing to process outside a real match window — results only change as
    // matches finish, which only happens while we're live. Gate on the cheap
    // in-memory schedule so this doesn't query the DB every minute, 24/7.
    // Also run around each group's LMS deadline (which can be well before
    // kickoff), so missed picks are drawn within a minute of it — the
    // randomiser wheel spins 3 minutes after the deadline.
    if (!(await plLiveWindowActive())) {
      const { lmsDeadlineWindowActive } = await import('./lmsWheel');
      if (!(await lmsDeadlineWindowActive())) return;
    }

    try {
      this.isProcessing = true;

      const active = await storage.getActiveLmsCompetitions();
      let processedAny = false;
      for (const competition of active) {
        // First, check deadlines and assign random teams
        await this.checkDeadlinesAndAssignRandomTeams(competition);

        if (await this.shouldProcessCompetition(competition)) {
          console.log(`[Auto] Processing competition ${competition.id} (group ${competition.groupId}) results...`);
          await lmsProcessor.processLmsResults(competition);
          processedAny = true;
        }
      }
      // A competition may have just ended; make sure every LMS group still has
      // one running (a no-op for groups that already do).
      if (processedAny) {
        const { ensureLmsCompetitions } = await import('./lmsAutoStart');
        await ensureLmsCompetitions();
      }

      // Prediction League counterpart: fill missed Lawro picks for any group
      // whose rule is "random" (a no-op for the default "blank"). Gated by the
      // same live window as above, so it only runs around kickoffs.
      const { fillMissedLawroPicks } = await import('./lawroMissedPicks');
      await fillMissedLawroPicks();
    } catch (error) {
      console.error('[Auto] Error in auto-processing:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Sync match scores from football-data.org for any live or imminent gameweeks.
   * If no live matches, this is essentially a no-op (1 cheap DB query, no API call).
   */
  async syncLiveMatches(): Promise<void> {
    // In-memory gate first: outside a match window this returns without any DB
    // read, so the 15s tick is free when nothing is live. Only inside a window
    // do we do the real (DB-backed) live-gameweek lookup and score sync.
    if (!(await plLiveWindowActive())) return;
    try {
      const liveGameweeks = await getLiveOrImminentGameweeks();
      if (liveGameweeks.length === 0) return;

      for (const gw of liveGameweeks) {
        const result = await syncGameweek(gw, { updateTimes: false, updateScores: true });
        if (result.matchesUpdated > 0 || result.selectionsUpdated > 0) {
          console.log(
            `[Auto] Live sync GW${gw}: matches=${result.matchesUpdated} selections=${result.selectionsUpdated}`,
          );
        }
      }

      // After scores are in, see if any competition is ready to advance/complete
      await this.checkAndProcess();
    } catch (err) {
      console.error('[Auto] Live sync failed:', err);
    }
  }

  /**
   * Refresh kickoff times for upcoming gameweeks from football-data.org.
   *
   * Fixtures are imported/seeded with placeholder times (e.g. 15:00), and the
   * live-score sync deliberately runs with updateTimes:false — so without this,
   * future gameweeks keep their placeholder times until kickoff, showing e.g. a
   * whole GW2 at 15:00. The live-sync window only covers matches within minutes
   * of kickoff, which is far too late for players picking days ahead, so this
   * runs separately over the *next few* upcoming gameweeks. syncGameweek only
   * writes a row when the time actually differs, so it's idempotent and cheap.
   */
  async refreshUpcomingFixtureTimes(maxGameweeks = 6): Promise<void> {
    try {
      const matches = await storage.getAllMatches(); // season-scoped
      const now = Date.now();
      // Earliest kickoff per gameweek, from not-yet-started fixtures.
      const earliest = new Map<number, number>();
      for (const m of matches) {
        if (m.gameweek == null || m.status !== 'not_started' || !m.matchTime) continue;
        const t = londonStringToUtcMs(m.matchTime);
        if (Number.isNaN(t)) continue;
        const cur = earliest.get(m.gameweek);
        if (cur == null || t < cur) earliest.set(m.gameweek, t);
      }
      // Only gameweeks still in the future, soonest first, capped to bound API use.
      const upcoming = Array.from(earliest.entries())
        .filter(([, t]) => t > now)
        .sort((a, b) => a[1] - b[1])
        .slice(0, maxGameweeks)
        .map(([gw]) => gw);

      for (const gw of upcoming) {
        const r = await syncGameweek(gw, { updateTimes: true, updateScores: false });
        if (r.matchesUpdated > 0) {
          console.log(`[Auto] Refreshed GW${gw} kickoff times (${r.matchesUpdated} fixtures)`);
        }
        // Stay well under the football-data rate budget.
        await new Promise((res) => setTimeout(res, 4000));
      }
    } catch (err) {
      console.error('[Auto] Fixture-time refresh failed:', err);
    }
  }

  /**
   * Start the automatic processor.
   * - Every 1 min: deadline checks + LMS processing
   * - Every 10 sec: live score sync from football-data.org (only when matches are live/imminent)
   * - Every 1 hour: refresh upcoming fixture kickoff times
   */
  start(): void {
    console.log('[Auto] Starting automatic LMS processor (deadlines: 1min, live scores: 10sec, fixture times: hourly)');

    cron.schedule('* * * * *', async () => {
      await this.checkAndProcess();
    });

    // Live match polling: every 15 seconds, but only actually hits the DB /
    // football-data while a match is live (see syncLiveMatches' in-memory gate).
    cron.schedule('*/15 * * * * *', async () => {
      await this.syncLiveMatches();
    });

    // Keep upcoming fixture times accurate (they change with TV picks). Every 6h
    // is plenty — kickoff times don't move minute-to-minute — and avoids an
    // hourly all-matches read that would keep the DB awake. Refresh the schedule
    // cache afterwards so any corrected times take effect for the live gates.
    cron.schedule('0 */6 * * *', async () => {
      await this.refreshUpcomingFixtureTimes();
      invalidatePlSchedule();
      await this.ensureLmsCompetitions();
    });

    // Also run immediately on startup
    this.checkAndProcess();
    this.syncLiveMatches();
    this.refreshUpcomingFixtureTimes();
    this.ensureLmsCompetitions();
  }

  // Open a competition for any LMS group that has none running (e.g. a new
  // season whose fixtures have just been imported). Runs outside the live-match
  // gate, since fixtures are imported in the off-season.
  private async ensureLmsCompetitions(): Promise<void> {
    try {
      const { ensureLmsCompetitions } = await import('./lmsAutoStart');
      await ensureLmsCompetitions();
    } catch (error) {
      console.error('[Auto] Error auto-starting LMS competitions:', error);
    }
  }
}

export const autoLmsProcessor = new AutoLmsProcessor();
