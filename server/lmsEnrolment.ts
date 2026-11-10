import { db } from "./db";
import { activityLogs, groups, users, type LmsCompetition } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { storage } from "./storage";
import { getGroupRules } from "./groupRules";

// Who plays which Last Man Standing competition when a player joins a group
// part-way through.
//
// A competition's players are fixed once its first deadline has passed: nobody
// joins a competition that's already under way (a player was once dropped
// into one two weeks in). Someone who arrives later — added on /admin/players,
// joining through an invite link, or having LMS switched on for them — waits
// for the group's next competition instead. Competitions copy the previous
// one's players (lmsProcessor.startNextCompetition, lmsAutoStart), so the
// waiting list is added on top of that roster by nextLmsRoster().
//
// The waiting list needs no schema change: each entry is an activity_logs row
// of type LMS_WAITING_EVENT, for the player, naming the competition they're
// waiting behind (the admin dashboards don't list this type). A player stops
// waiting when they join a competition, LMS is hidden for them, or they're
// removed.

export const LMS_WAITING_EVENT = "lms_waiting_for_next";

// Whether a gameweek's picks have locked: its first kick-off, less the group's
// LMS deadline offset, has passed. Database times are London wall-clock times.
// A gameweek with no fixtures counts as open.
export async function isGameweekLocked(gameweek: number, lockMinutesBeforeKickoff = 0): Promise<boolean> {
  const matches = await storage.getAllMatches();
  const gameweekMatches = matches.filter((m) => m.gameweek === gameweek);
  if (gameweekMatches.length === 0) return false;
  const earliestMatch = gameweekMatches.reduce((earliest, current) =>
    new Date(current.matchTime).getTime() < new Date(earliest.matchTime).getTime() ? current : earliest,
  );
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/London" }));
  const lockAt = new Date(earliestMatch.matchTime).getTime() - lockMinutesBeforeKickoff * 60 * 1000;
  return now.getTime() >= lockAt;
}

// The group's current competition, and whether new players can still join it
// (its first deadline hasn't passed).
export async function lmsRosterWindow(
  groupId: number,
): Promise<{ competition: LmsCompetition | undefined; open: boolean }> {
  const competition = await storage.getCurrentLmsCompetition(groupId);
  if (!competition) return { competition: undefined, open: false };
  const rules = await getGroupRules(groupId);
  const locked = await isGameweekLocked(competition.startGameweek, rules.lms.deadlineMinutesBeforeKickoff);
  return { competition, open: !locked };
}

// A player's games here include LMS: their override, or the group's games when
// they have none.
export function seesLms(override: string[] | null | undefined): boolean {
  return override ? override.includes("lms") : true;
}

export type LmsPlacement =
  // In the current competition (just added, or already there).
  | { status: "joined"; competition: LmsCompetition; already: boolean }
  // Waiting for the competition after `after` (null: none running right now).
  | { status: "waiting"; after: LmsCompetition | null }
  // The group doesn't play LMS, or has never run a competition (its first one
  // takes every member who can see LMS, so there's nothing to wait for).
  | { status: "none" };

// Put a player in the group's LMS: straight into the current competition if
// it's still open, otherwise onto the waiting list for the next one.
export async function placeInLms(
  groupId: number,
  userId: number,
  log: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<LmsPlacement> {
  const [group] = await db.select({ enabledGames: groups.enabledGames }).from(groups).where(eq(groups.id, groupId));
  if (!group || !((group.enabledGames as string[] | null) ?? []).includes("lms")) return { status: "none" };

  const { competition, open } = await lmsRosterWindow(groupId);
  if (competition) {
    const participants = await storage.getLmsParticipantsByCompetition(competition.id);
    if (participants.some((p) => p.userId === userId)) {
      await stopWaiting([userId]);
      return { status: "joined", competition, already: true };
    }
    if (open) {
      await storage.createLmsParticipant({
        competitionId: competition.id,
        userId,
        isActive: "true",
        eliminatedInRound: null,
      });
      await stopWaiting([userId]);
      return { status: "joined", competition, already: false };
    }
  }

  // Wait behind the running competition, or the group's last one between
  // competitions (the next one copies its roster). No history at all: the
  // group's first competition takes everyone, so no list is needed.
  const after = competition ?? (await storage.getAllLmsCompetitions(groupId))[0];
  if (!after) return { status: "none" };
  if (!(await waitingIds(groupId, after.id)).has(userId)) {
    await stopWaiting([userId]);
    await storage.createActivityLog({
      type: LMS_WAITING_EVENT,
      userId,
      groupId,
      ipAddress: log.ipAddress || "server",
      userAgent: log.userAgent ?? null,
      path: null,
      city: null,
      country: null,
      details: JSON.stringify({ afterCompetitionId: after.id, competitionName: after.name }),
    } as any);
  }
  return { status: "waiting", after: competition ?? null };
}

// Take players off the waiting list.
export async function stopWaiting(userIds: number[]): Promise<void> {
  if (userIds.length === 0) return;
  await db
    .delete(activityLogs)
    .where(and(eq(activityLogs.type, LMS_WAITING_EVENT), inArray(activityLogs.userId, userIds)));
}

// Players waiting to join the competition that follows `afterCompetitionId`.
// Only those still in the group who can still see LMS count.
export async function waitingIds(groupId: number, afterCompetitionId?: number): Promise<Set<number>> {
  const rows = await db
    .select({ userId: activityLogs.userId, details: activityLogs.details })
    .from(activityLogs)
    .where(and(eq(activityLogs.type, LMS_WAITING_EVENT), eq(activityLogs.groupId, groupId)));
  const candidates = new Set<number>();
  for (const r of rows) {
    if (r.userId == null) continue;
    if (afterCompetitionId !== undefined) {
      let after: unknown;
      try {
        after = JSON.parse(r.details ?? "{}").afterCompetitionId;
      } catch {
        continue;
      }
      if (after !== afterCompetitionId) continue;
    }
    candidates.add(r.userId);
  }
  if (candidates.size === 0) return candidates;
  const members = await db
    .select({ id: users.id, enabledGames: users.enabledGames })
    .from(users)
    .where(and(eq(users.groupId, groupId), inArray(users.id, Array.from(candidates))));
  return new Set(members.filter((m) => seesLms(m.enabledGames as string[] | null)).map((m) => m.id));
}

// The players of the competition that follows `previous`: its own players plus
// whoever was waiting for the next one. Once they're in, call stopWaiting(roster).
export async function nextLmsRoster(groupId: number, previous: LmsCompetition): Promise<number[]> {
  const prior = await storage.getLmsParticipantsByCompetition(previous.id);
  const waiting = await waitingIds(groupId, previous.id);
  return Array.from(new Set([...prior.map((p) => p.userId), ...Array.from(waiting)]));
}

// Take a player out of one competition, with their picks and pick log.
export async function removeFromCompetition(competitionId: number, userId: number): Promise<boolean> {
  const { lmsParticipants, lmsSelections, lmsSelectionLogs } = await import("@shared/schema");
  const parts = await db
    .select({ id: lmsParticipants.id })
    .from(lmsParticipants)
    .where(and(eq(lmsParticipants.competitionId, competitionId), eq(lmsParticipants.userId, userId)));
  const ids = parts.map((p) => p.id);
  if (ids.length === 0) return false;
  await db.delete(lmsSelections).where(inArray(lmsSelections.participantId, ids));
  await db.delete(lmsSelectionLogs).where(inArray(lmsSelectionLogs.participantId, ids));
  await db.delete(lmsParticipants).where(inArray(lmsParticipants.id, ids));
  return true;
}

// One line for the admin about where a placement left the player.
export function describePlacement(placement: LmsPlacement): string {
  if (placement.status === "joined") {
    const c = placement.competition;
    return placement.already
      ? `They're already in ${c.name}.`
      : `They're in ${c.name}, which starts in GW${c.startGameweek}.`;
  }
  if (placement.status === "waiting") {
    return placement.after
      ? `${placement.after.name} is already under way (it started in GW${placement.after.startGameweek}), so they'll join the next LMS competition.`
      : `There's no LMS competition running, so they'll join the next one when it opens.`;
  }
  return "";
}
