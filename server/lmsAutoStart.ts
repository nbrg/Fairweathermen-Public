import { db } from "./db";
import { groups, users, type LmsCompetition } from "@shared/schema";
import { eq } from "drizzle-orm";
import { storage } from "./storage";
import { getGroupRules } from "./groupRules";
import { londonStringToUtcMs } from "@shared/time";

// LMS competitions start themselves — no script needed:
//  - a newly created group with LMS enabled gets a competition straight away,
//    starting at the next gameweek that hasn't kicked off yet;
//  - when a competition ends mid-season, lmsProcessor.startNextCompetition opens
//    the next one for the following gameweek;
//  - when the season ends there's nothing left to pick, so the group waits; as
//    soon as next season's fixtures are imported this sweep opens a competition
//    at its GW1.
//
// Safety: a competition is only ever opened at a gameweek that exists in the
// current season's fixtures and whose (group-adjusted) deadline is still in the
// future. Opening one against a gameweek that has already started — or before a
// new season's fixtures exist, where "GW1" would resolve to last season's
// long-past GW1 — would make the deadline processor fire the missed-pick rule
// at everyone immediately.

// The earliest current-season gameweek whose first kick-off, less the group's
// LMS deadline offset, is still in the future — i.e. one players can still pick
// for. Null when no such gameweek exists (the off-season, or fixtures not
// imported yet).
export async function nextUnstartedGameweek(
  deadlineMinutesBeforeKickoff = 0,
): Promise<{ gameweek: number; season: string | null } | null> {
  const matches = await storage.getAllMatches(); // current season only
  const firstKickoff = new Map<number, number>();
  const seasonOf = new Map<number, string | null>();
  for (const m of matches) {
    if (m.gameweek == null) continue;
    const t = londonStringToUtcMs(m.matchTime);
    if (Number.isNaN(t)) continue;
    const prev = firstKickoff.get(m.gameweek);
    if (prev === undefined || t < prev) firstKickoff.set(m.gameweek, t);
    seasonOf.set(m.gameweek, m.season ?? null);
  }
  const offsetMs = deadlineMinutesBeforeKickoff * 60 * 1000;
  const now = Date.now();
  const open = Array.from(firstKickoff.entries())
    .filter(([, kickoff]) => kickoff - offsetMs > now)
    .map(([gw]) => gw);
  if (open.length === 0) return null;
  const gameweek = Math.min(...open);
  return { gameweek, season: seasonOf.get(gameweek) ?? null };
}

// Make sure a group that plays LMS has a competition running, opening one at
// the next unstarted gameweek if it has none. Only groups that actually play
// LMS qualify: self-service groups created with LMS on (they have an owner), and
// groups that have run a competition before. Returns the new competition, or
// null when nothing was needed / possible. Idempotent — a group that already has
// an active competition is left alone.
export async function ensureLmsCompetitionForGroup(groupId: number): Promise<LmsCompetition | null> {
  const [group] = await db
    .select({ id: groups.id, enabledGames: groups.enabledGames, ownerUserId: groups.ownerUserId })
    .from(groups)
    .where(eq(groups.id, groupId));
  if (!group) return null;
  if (!((group.enabledGames as string[] | null) ?? []).includes("lms")) return null;
  if (await storage.getCurrentLmsCompetition(groupId)) return null;

  const history = await storage.getAllLmsCompetitions(groupId); // newest first
  if (group.ownerUserId == null && history.length === 0) return null;

  const rules = await getGroupRules(groupId);
  const next = await nextUnstartedGameweek(rules.lms.deadlineMinutesBeforeKickoff);
  if (!next) return null; // off-season — nothing to pick from yet

  // Roster: carry over whoever played the group's last competition (the same
  // rule lmsProcessor uses when rolling over). A brand-new group has no history,
  // so it starts with every member who has LMS enabled; people who join later
  // via the invite link are enrolled into the running competition as they join.
  let roster: number[];
  const latest = history[0];
  if (latest) {
    const prior = await storage.getLmsParticipantsByCompetition(latest.id);
    roster = Array.from(new Set(prior.map((p) => p.userId)));
  } else {
    const members = await db
      .select({ id: users.id, enabledGames: users.enabledGames })
      .from(users)
      .where(eq(users.groupId, groupId));
    roster = members
      .filter((m) => {
        const override = m.enabledGames as string[] | null;
        return override ? override.includes("lms") : true;
      })
      .map((m) => m.id);
  }
  if (roster.length === 0) return null;

  const season = next.season ?? latest?.season ?? "2025/2026";
  const seasonCount = history.filter((c) => (c.season ?? null) === season).length;
  const competition = await storage.createLmsCompetition({
    groupId,
    season,
    name: `Competition ${seasonCount + 1}`,
    startGameweek: next.gameweek,
    currentGameweek: next.gameweek,
    status: "active",
    prizeAmount: rules.lms.buyIn,
  });
  for (const userId of roster) {
    await storage.createLmsParticipant({
      competitionId: competition.id,
      userId,
      isActive: "true",
      eliminatedInRound: null,
    });
  }
  console.log(
    `[LMS] Auto-started competition ${competition.id} for group ${groupId} at GW${next.gameweek}` +
      ` (${season}) with ${roster.length} player(s)`,
  );
  return competition;
}

// Run ensureLmsCompetitionForGroup for every group. Called at boot, on the
// processor's periodic schedule (so a new season's competition opens once its
// fixtures are imported) and after results processing. One group failing never
// blocks the rest.
export async function ensureLmsCompetitions(): Promise<void> {
  const rows = await db.select({ id: groups.id }).from(groups);
  for (const { id } of rows) {
    try {
      await ensureLmsCompetitionForGroup(id);
    } catch (err) {
      console.error(`[LMS] Auto-start check failed for group ${id}:`, err);
    }
  }
}
