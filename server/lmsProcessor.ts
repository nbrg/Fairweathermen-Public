import { storage } from './storage';
import { db } from './db';
import { groups, type LmsSelection, type LmsParticipant, type LmsCompetition } from '@shared/schema';
import { eq } from 'drizzle-orm';

// The group rule for "everyone knocked out in the same gameweek". Defaults to
// "rollover" for any group that hasn't set one.
async function allOutRuleForGroup(groupId: number): Promise<string> {
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
  return group?.lmsAllOutRule ?? 'rollover';
}

// The last gameweek of a Premier League season — a new competition never starts
// past this (there are no more fixtures to pick from).
const FINAL_GAMEWEEK = 38;

export class LmsProcessor {
  
  /**
   * Process LMS results and handle gameweek progression/competition completion.
   *
   * Pass a competition to process just that one; with no argument, every active
   * competition across all groups is processed (the background cron path). The
   * old no-arg behaviour processed only the single newest active competition,
   * which silently skipped other groups' competitions.
   */
  async processLmsResults(competition?: LmsCompetition): Promise<void> {
    if (competition) {
      await this.processCompetition(competition);
      return;
    }
    const active = await storage.getActiveLmsCompetitions();
    for (const comp of active) {
      await this.processCompetition(comp);
    }
  }

  private async processCompetition(currentCompetition: LmsCompetition): Promise<void> {
    console.log(`Processing LMS results for competition ${currentCompetition.id} (group ${currentCompetition.groupId})...`);

    const participants = await storage.getLmsParticipantsByCompetition(currentCompetition.id);
    const activeParticipants = participants.filter(p => p.isActive === 'true');
    
    if (activeParticipants.length === 0) {
      console.log('No active participants found');
      return;
    }

    // Get current gameweek (handling both camelCase and snake_case)
    const currentGameweek = currentCompetition.currentGameweek || (currentCompetition as any).current_gameweek;
    console.log(`Processing gameweek ${currentGameweek}`);

    // Get all selections for current gameweek
    const allSelections = await Promise.all(
      activeParticipants.map(async (participant) => {
        const selections = await storage.getLmsSelectionsByParticipant(participant.id);
        return selections.find(s => s.gameweek === currentGameweek);
      })
    );

    const currentGameweekSelections = allSelections.filter(Boolean) as LmsSelection[];
    
    if (currentGameweekSelections.length === 0) {
      console.log('No selections found for current gameweek');
      return;
    }

    // Check if all selections have results
    const selectionsWithResults = currentGameweekSelections.filter(s => s.result !== null);
    if (selectionsWithResults.length < currentGameweekSelections.length) {
      console.log('Not all selections have results yet');
      return;
    }

    // Count winners and losers
    const winners = selectionsWithResults.filter(s => s.result === 'w');
    const losers = selectionsWithResults.filter(s => s.result === 'l');

    console.log(`Winners: ${winners.length}, Losers: ${losers.length}`);

    if (losers.length > 0) {
      // Eliminate players who lost/drew
      await this.eliminateParticipants(currentCompetition, losers, currentGameweek);
    }

    // Check remaining active participants after eliminations
    const remainingParticipants = await storage.getLmsParticipantsByCompetition(currentCompetition.id);
    const stillActive = remainingParticipants.filter(p => p.isActive === 'true');

    if (stillActive.length === 0) {
      // Everyone was knocked out in the same gameweek. What happens next is a
      // per-group rule (see groups.lmsAllOutRule).
      const rule = await allOutRuleForGroup(currentCompetition.groupId);
      if (rule === 'revive') {
        // Give everyone another life and carry on in the same competition.
        console.log('All participants eliminated - reviving the roster (revive rule)');
        for (const p of remainingParticipants) {
          await storage.updateLmsParticipant(p.id, { isActive: 'true', eliminatedInRound: null });
        }
        await this.advanceToNextGameweek(currentCompetition);
      } else {
        // "rollover" (default): the competition ends with no winner and a fresh
        // one opens for the same roster, so the pot carries over.
        console.log('All participants eliminated - completing competition with no winner (rollover rule)');
        await storage.updateLmsCompetition(currentCompetition.id, { status: 'completed' });
        await this.startNextCompetition(currentCompetition);
      }
    } else if (stillActive.length === 1) {
      // Single winner - complete this competition and roll into the next one.
      console.log('Single winner found - completing competition');
      await this.completeCompetition(currentCompetition, stillActive[0]);
      await this.startNextCompetition(currentCompetition);
    } else if (winners.length > 1) {
      // Multiple winners - advance to next gameweek
      console.log('Multiple winners - advancing to next gameweek');
      await this.advanceToNextGameweek(currentCompetition);
    }
  }

  /**
   * Eliminate participants who lost/drew
   */
  private async eliminateParticipants(competition: LmsCompetition, losingSelections: LmsSelection[], gameweek: number): Promise<void> {
    for (const selection of losingSelections) {
      // Find participant by going through their selections
      const allParticipants = await storage.getLmsParticipantsByCompetition(competition.id);

      for (const participant of allParticipants) {
        const participantSelections = await storage.getLmsSelectionsByParticipant(participant.id);
        if (participantSelections.some(s => s.id === selection.id)) {
          console.log(`Eliminating participant ${participant.id} in gameweek ${gameweek}`);
          await storage.updateLmsParticipant(participant.id, {
            isActive: 'false',
            eliminatedInRound: gameweek
          });
          break;
        }
      }
    }
  }

  /**
   * Advance competition to next gameweek
   */
  private async advanceToNextGameweek(competition: LmsCompetition): Promise<void> {
    const currentGw = competition.currentGameweek || (competition as any).current_gameweek || 1;
    const nextGameweek = currentGw + 1;
    console.log(`Advancing from gameweek ${currentGw} to gameweek ${nextGameweek}`);
    
    // Ensure nextGameweek is a valid number
    if (isNaN(nextGameweek) || nextGameweek < 1) {
      console.error(`Invalid gameweek calculation: currentGw=${currentGw}, nextGameweek=${nextGameweek}`);
      throw new Error(`Invalid gameweek: ${nextGameweek}`);
    }
    
    console.log(`About to update competition ${competition.id} with gameweek ${nextGameweek}`);
    await storage.updateLmsCompetition(competition.id, {
      currentGameweek: nextGameweek
    });
    console.log(`Successfully advanced to gameweek ${nextGameweek}`);
  }

  /**
   * Complete current competition with a winner
   */
  private async completeCompetition(competition: LmsCompetition, winner: LmsParticipant): Promise<void> {
    console.log(`Competition ${competition.id} completed - winner: participant ${winner.id} (user ${winner.userId})`);
    
    await storage.updateLmsCompetition(competition.id, {
      status: 'completed',
      winnerId: winner.userId
    });
  }

  /**
   * Roll a completed competition into a fresh one for the next gameweek.
   *
   * LMS runs as back-to-back competitions within a season: as soon as one ends
   * (a single survivor, or everyone knocked out together) the next week's
   * competition opens with the same roster so players can pick again.
   *
   * Guards:
   *  - stays group-scoped (uses the finished competition's group, never a
   *    hardcoded groupId), so it won't enrol another group's players;
   *  - never runs past the final gameweek of the season (nothing to pick);
   *  - never opens a second active competition for the group (idempotent
   *    against re-processing).
   */
  private async startNextCompetition(previous: LmsCompetition): Promise<void> {
    const prevGw = previous.currentGameweek || (previous as any).current_gameweek || 0;
    const nextStartGameweek = prevGw + 1;

    if (nextStartGameweek > FINAL_GAMEWEEK) {
      console.log(`Season over (next GW ${nextStartGameweek} > ${FINAL_GAMEWEEK}) - not starting a new competition`);
      return;
    }

    const groupId = previous.groupId ?? (previous as any).group_id ?? 1;
    const season = previous.season || (previous as any).season || '2025/2026';

    // Idempotency: don't open a second active competition for this group.
    const active = await storage.getActiveLmsCompetitions();
    if (active.some((c) => (c.groupId ?? (c as any).group_id ?? 1) === groupId)) {
      console.log(`An active competition already exists for group ${groupId} - skipping auto-start`);
      return;
    }

    // Carry the roster over from the competition that just finished (deduped).
    const priorParticipants = await storage.getLmsParticipantsByCompetition(previous.id);
    const roster = Array.from(new Set(priorParticipants.map((p) => p.userId)));
    if (roster.length === 0) {
      console.log(`Previous competition ${previous.id} had no participants - skipping auto-start`);
      return;
    }

    // Name the new competition "Competition N" within this group + season.
    const groupComps = await storage.getAllLmsCompetitions(groupId);
    const seasonCount = groupComps.filter(
      (c) => (c.season || '2025/2026') === season,
    ).length;
    const name = `Competition ${seasonCount + 1}`;

    const newCompetition = await storage.createLmsCompetition({
      groupId,
      season,
      name,
      startGameweek: nextStartGameweek,
      currentGameweek: nextStartGameweek,
      status: 'active',
    });

    for (const userId of roster) {
      await storage.createLmsParticipant({
        competitionId: newCompetition.id,
        userId,
        isActive: 'true',
        eliminatedInRound: null,
      });
    }

    console.log(
      `Started new competition ${newCompetition.id} "${name}" for group ${groupId} ` +
        `at GW${nextStartGameweek} with ${roster.length} players`,
    );
  }
}

export const lmsProcessor = new LmsProcessor();