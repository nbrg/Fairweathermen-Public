import { db } from "./db";
import { eq } from "drizzle-orm";
import { groups, users, type Match } from "@shared/schema";
import { storage } from "./storage";
import { getGroupRules } from "./groupRules";
import { londonStringToUtcMs } from "@shared/time";

// Pick a plausible random scoreline for an auto-filled Lawro prediction. Low
// scores are the overwhelming norm in football, so bias towards them (0–3).
function randomScore(): number {
  const r = Math.random();
  if (r < 0.3) return 0;
  if (r < 0.65) return 1;
  if (r < 0.88) return 2;
  return 3;
}

// Earliest kickoff (UTC ms) per gameweek for the current season's fixtures.
function earliestKickoffByGameweek(matches: Match[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of matches) {
    if (m.gameweek == null || !m.matchTime) continue;
    const t = londonStringToUtcMs(m.matchTime);
    if (Number.isNaN(t)) continue;
    const cur = out.get(m.gameweek);
    if (cur == null || t < cur) out.set(m.gameweek, t);
  }
  return out;
}

// For every group whose Lawro rule is "random", fill in a random scoreline for
// any player who has no prediction in the most-recently-locked gameweek. This
// is the Prediction League counterpart to the LMS missed-pick handling. The
// default rule is "blank" (score nothing), so this is a no-op for every group
// that hasn't opted into auto-fill, and idempotent for those that have (players
// who already have a pick are skipped).
//
// Only the single most-recently-locked gameweek is filled, so turning the rule
// on never retroactively invents picks for the whole season's history.
export async function fillMissedLawroPicks(): Promise<void> {
  try {
    const allGroups = await db.select().from(groups);
    const eligible: typeof allGroups = [];
    for (const g of allGroups) {
      if (!((g.enabledGames as string[]) ?? []).includes("predictions")) continue;
      const rules = await getGroupRules(g.id);
      if (rules.lawro.missedPickPolicy === "random") eligible.push(g);
    }
    if (eligible.length === 0) return;

    // Season-scoped matches + all predictions, read once.
    const matches = await storage.getAllMatches();
    if (matches.length === 0) return;
    const kickoffs = earliestKickoffByGameweek(matches);
    const now = Date.now();

    for (const group of eligible) {
      const rules = await getGroupRules(group.id);
      const offsetMs = rules.lawro.deadlineMinutesBeforeKickoff * 60 * 1000;

      // The most-recently-locked gameweek: the highest gameweek whose deadline
      // (first kickoff minus the offset) has passed.
      let targetGw: number | null = null;
      for (const [gw, ko] of Array.from(kickoffs.entries())) {
        if (now >= ko - offsetMs && (targetGw == null || gw > targetGw)) targetGw = gw;
      }
      if (targetGw == null) continue;

      const gwMatches = matches.filter((m) => m.gameweek === targetGw);
      if (gwMatches.length === 0) continue;

      const groupUsers = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.groupId, group.id));
      if (groupUsers.length === 0) continue;

      // Which (user, match) predictions already exist, so we only fill gaps.
      const existing = new Set<string>();
      for (const u of groupUsers) {
        const preds = await storage.getUserPredictions(u.id);
        for (const p of preds) existing.add(`${u.id}:${p.matchId}`);
      }

      let filled = 0;
      for (const u of groupUsers) {
        for (const m of gwMatches) {
          if (existing.has(`${u.id}:${m.id}`)) continue;
          await storage.createPrediction({
            userId: u.id,
            matchId: m.id,
            homeScore: randomScore(),
            awayScore: randomScore(),
            isAutoPick: true,
          } as any);
          filled += 1;
        }
      }
      if (filled > 0) {
        console.log(`[Lawro] Auto-filled ${filled} missed prediction(s) for group ${group.id} GW${targetGw}`);
      }
    }
  } catch (err) {
    console.error("[Lawro] Missed-pick auto-fill failed:", err);
  }
}
