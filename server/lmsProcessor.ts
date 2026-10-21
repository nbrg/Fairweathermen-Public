import { storage } from './storage';
import { getGroupRules } from './groupRules';
import type { LmsSelection, LmsParticipant, LmsCompetition, LmsAllOutPolicy } from '@shared/schema';

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

    // The group's LMS rules decide how many lives a player has and what happens
    // when everyone goes out together.
    const rules = await getGroupRules(currentCompetition.groupId);

    // Count winners and losers
    const winners = selectionsWithResults.filter(s => s.result === 'w');
    const losers = selectionsWithResults.filter(s => s.result === 'l');

    console.log(`Winners: ${winners.length}, Losers: ${losers.length}, lives: ${rules.lms.lives}`);

    if (losers.length > 0) {
      // Eliminate players who have now used up all their lives.
      await this.eliminateParticipants(currentCompetition, losers, currentGameweek, rules.lms.lives);
    }

    // Check remaining active participants after eliminations
    const remainingParticipants = await storage.getLmsParticipantsByCompetition(currentCompetition.id);
    const stillActive = remainingParticipants.filter(p => p.isActive === 'true');

    if (stillActive.length === 0) {
      // Everyone still in was knocked out in the same gameweek — resolve per the
      // group's "all out together" rule.
      console.log(`All participants eliminated in GW${currentGameweek} - applying "${rules.lms.allOutPolicy}" rule`);
      await this.handleAllOut(currentCompetition, currentGameweek, rules.lms.allOutPolicy);
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
   * Resolve a gameweek where every remaining player went out together, per the
   * group's rule:
   *  - "revive": everyone is given another life and play continues in the same
   *    competition (the public repo's long-standing alternative).
   *  - "rollover": no winner; a fresh competition opens for the same roster
   *    (the default — the pot carries over).
   *  - "co_winners": the players who went out this gameweek share the win
   *    (recorded in winnerId / coWinnerId); the competition simply ends.
   *  - "no_winner": no winner recorded and no new competition.
   */
  private async handleAllOut(
    competition: LmsCompetition,
    gameweek: number,
    policy: LmsAllOutPolicy,
  ): Promise<void> {
    if (policy === 'revive') {
      // Give everyone another life and carry on in the same competition.
      console.log('All participants eliminated - reviving the roster (revive rule)');
      const participants = await storage.getLmsParticipantsByCompetition(competition.id);
      for (const p of participants) {
        await storage.updateLmsParticipant(p.id, { isActive: 'true', eliminatedInRound: null });
      }
      await this.advanceToNextGameweek(competition);
      return;
    }

    if (policy === 'co_winners') {
      // The co-winners are the players knocked out in this final gameweek.
      const participants = await storage.getLmsParticipantsByCompetition(competition.id);
      const finalists = participants.filter(p => p.eliminatedInRound === gameweek);
      const winnerId = finalists[0]?.userId ?? null;
      const coWinnerId = finalists[1]?.userId ?? null;
      await storage.updateLmsCompetition(competition.id, {
        status: 'completed',
        winnerId,
        coWinnerId,
      });
      if (finalists.length > 2) {
        console.warn(
          `[LMS] ${finalists.length} co-winners in competition ${competition.id}; only two winner slots exist, recorded the first two.`,
        );
      }
      return;
    }

    // "rollover" and "no_winner" both complete with no winner; only rollover
    // opens a fresh competition for the same roster.
    await storage.updateLmsCompetition(competition.id, { status: 'completed' });
    if (policy === 'rollover') {
      await this.startNextCompetition(competition);
    }
  }

  /**
   * Eliminate participants who have run out of lives. A player is knocked out
   * once their cumulative number of losing picks reaches the group's `lives`
   * setting (default 1 — one loss and you're out). Counting actual losing
   * selections (rather than decrementing a counter) keeps this idempotent: it's
   * safe to run more than once for the same gameweek.
   */
  private async eliminateParticipants(
    competition: LmsCompetition,
    losingSelections: LmsSelection[],
    gameweek: number,
    lives: number,
  ): Promise<void> {
    const losingIds = new Set(losingSelections.map(s => s.id));
    const allParticipants = await storage.getLmsParticipantsByCompetition(competition.id);

    for (const participant of allParticipants) {
      const participantSelections = await storage.getLmsSelectionsByParticipant(participant.id);
      // Only act on participants who lost in THIS gameweek.
      if (!participantSelections.some(s => losingIds.has(s.id))) continue;
      // Count all of this player's losing picks so far.
      const lossesUsed = participantSelections.filter(s => s.result === 'l').length;
      if (lossesUsed >= lives) {
        console.log(`Eliminating participant ${participant.id} in gameweek ${gameweek} (${lossesUsed}/${lives} lives used)`);
        await storage.updateLmsParticipant(participant.id, {
          isActive: 'false',
          eliminatedInRound: gameweek,
        });
      } else {
        console.log(`Participant ${participant.id} lost GW${gameweek} but survives (${lossesUsed}/${lives} lives used)`);
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

    // Carry the group's configured buy-in into the new competition's pot.
    const rules = await getGroupRules(groupId);

    const newCompetition = await storage.createLmsCompetition({
      groupId,
      season,
      name,
      startGameweek: nextStartGameweek,
      currentGameweek: nextStartGameweek,
      status: 'active',
      prizeAmount: rules.lms.buyIn,
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