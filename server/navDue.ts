import { db } from "./db";
import { storage } from "./storage";
import { getGroupRules } from "./groupRules";
import { groups, users, predictions, matches as matchesTable } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { londonStringToUtcMs } from "@shared/time";

// Which games still need a pick from this person for the coming gameweek —
// the red dots on the bottom nav. Worked out for each group the person is in
// (their rows share a login code); the nav reads the group each game tab
// opens, so a dot never points at a group whose picks are already done.
//
//  - Lawro: the next gameweek whose deadline hasn't passed (and is within about a
//    week, so a dot doesn't sit there all through an international break or
//    the summer) has a match they haven't predicted.
//  - LMS: they're still in their group's running competition and haven't
//    picked for its current gameweek, and its deadline hasn't passed.

export type GamesDue = { lms: boolean; predictions: boolean };
// `lms`/`predictions`: owed in any of their groups. `groups`: per group id.
export type PicksDue = GamesDue & { groups: Record<number, GamesDue> };

const DAY_MS = 24 * 60 * 60 * 1000;
const LAWRO_DOT_WINDOW_MS = 8 * DAY_MS;

function effective(groupGames: string[], userGames: string[] | null): string[] {
  return userGames ? groupGames.filter((g) => userGames.includes(g)) : groupGames;
}

export async function picksDueFor(userId: number, now: number = Date.now()): Promise<PicksDue> {
  const due: PicksDue = { lms: false, predictions: false, groups: {} };
  const [me] = await db.select().from(users).where(eq(users.id, userId));
  if (!me) return due;
  const rows = me.loginCode
    ? await db.select().from(users).where(eq(users.loginCode, me.loginCode))
    : [me];
  const groupRows = await db
    .select()
    .from(groups)
    .where(inArray(groups.id, Array.from(new Set(rows.map((r) => r.groupId)))));
  const groupById = new Map(groupRows.map((g) => [g.id, g]));

  const plays = rows
    .map((r) => {
      const g = groupById.get(r.groupId);
      return g ? { row: r, games: effective((g.enabledGames as string[]) ?? [], r.enabledGames as string[] | null) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
  if (!plays.some((p) => p.games.includes("lms") || p.games.includes("predictions"))) return due;

  // Current season's matches, by gameweek, with each gameweek's first kick-off.
  const all = await db.select().from(matchesTable);
  const seasons = all.map((m) => m.season).filter((s): s is string => !!s).sort();
  const season = seasons[seasons.length - 1];
  const current = season ? all.filter((m) => m.season === season) : all;
  const byGw = new Map<number, typeof current>();
  for (const m of current) {
    if (m.gameweek == null) continue;
    byGw.set(m.gameweek, [...(byGw.get(m.gameweek) ?? []), m]);
  }
  const firstKickoff = (gw: number): number | null => {
    const times = (byGw.get(gw) ?? [])
      .map((m) => londonStringToUtcMs(m.matchTime))
      .filter((t) => !Number.isNaN(t));
    return times.length ? Math.min(...times) : null;
  };

  for (const { row, games } of plays) {
    const rules = await getGroupRules(row.groupId);
    const here: GamesDue = { lms: false, predictions: false };
    due.groups[row.groupId] = here;

    if (games.includes("predictions")) {
      const offset = rules.lawro.deadlineMinutesBeforeKickoff * 60_000;
      const open = Array.from(byGw.keys())
        .map((gw) => ({ gw, deadline: (firstKickoff(gw) ?? -Infinity) - offset }))
        .filter((x) => x.deadline > now)
        .sort((a, b) => a.deadline - b.deadline)[0];
      if (open && open.deadline - now <= LAWRO_DOT_WINDOW_MS) {
        const matchIds = (byGw.get(open.gw) ?? []).map((m) => m.id);
        const made = await db
          .select({ id: predictions.id })
          .from(predictions)
          .where(and(eq(predictions.userId, row.id), inArray(predictions.matchId, matchIds)));
        if (made.length < matchIds.length) here.predictions = true;
      }
    }

    if (games.includes("lms")) {
      const comp = await storage.getCurrentLmsCompetition(row.groupId);
      if (comp && comp.status === "active") {
        const kickoff = firstKickoff(comp.currentGameweek);
        const deadline = kickoff == null ? null : kickoff - rules.lms.deadlineMinutesBeforeKickoff * 60_000;
        if (deadline != null && deadline > now) {
          const participants = await storage.getLmsParticipantsByCompetition(comp.id);
          const mine = participants.find((p) => p.userId === row.id && p.isActive === "true");
          if (mine) {
            const picks = await storage.getLmsSelectionsByParticipant(mine.id);
            if (!picks.some((s) => s.gameweek === comp.currentGameweek)) here.lms = true;
          }
        }
      }
    }
    due.lms ||= here.lms;
    due.predictions ||= here.predictions;
  }
  return due;
}
