import cron from "node-cron";
import { db } from "./db";
import { storage } from "./storage";
import {
  groups,
  users,
  predictions,
  reminderSends,
  pushSubscriptions,
  matches as matchesTable,
  REMINDER_LEAD_PRESETS_MINUTES,
} from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { londonStringToUtcMs } from "@shared/time";
import { sendToUser, isPushConfigured, type PushPayload } from "./push";
import { plDeadlineWithin } from "./scheduleGate";

const MIN_MS = 60 * 1000;
// Widest lead anyone can pick — bounds how far ahead we look.
const MAX_LEAD_MINUTES = Math.max(...REMINDER_LEAD_PRESETS_MINUTES);

function effectiveGames(groupGames: string[], userGames: string[] | null): string[] {
  if (!userGames) return groupGames;
  const allowed = new Set(groupGames);
  return userGames.filter((g) => allowed.has(g));
}

// Stable key for the *person* behind a user row (their shared login code, or a
// per-row fallback). Subscriptions and lead prefs belong to the person.
function personKey(loginCode: string | null, userId: number): string {
  return loginCode ? `c:${loginCode}` : `u:${userId}`;
}

// Keep only the latest season's matches (mirrors storage.filterToCurrentSeason).
// Without this the deadline for e.g. "gameweek 1" is taken from LAST season's
// GW1 — months in the past — so every gameweek looks already-passed and no
// reminder ever fires. Falls back to all rows if none are season-tagged.
function filterToCurrentSeason<T extends { season: string | null }>(rows: T[]): T[] {
  const seasons = rows.map((r) => r.season).filter((s): s is string => !!s);
  if (seasons.length === 0) return rows;
  const current = seasons.sort()[seasons.length - 1];
  return rows.filter((r) => r.season === current);
}

function gameweekDeadlineMs(gwMatches: { matchTime: string }[]): number | null {
  const times = gwMatches
    .map((m) => londonStringToUtcMs(m.matchTime))
    .filter((t) => !Number.isNaN(t));
  return times.length ? Math.min(...times) : null;
}

// Record that this specific reminder (person/game/gameweek/lead) was sent,
// returning true only if this call inserted the row — so each lead fires once.
async function claimReminder(
  userId: number,
  groupId: number,
  game: string,
  gameweek: number,
  leadMinutes: number,
): Promise<boolean> {
  const inserted = await db
    .insert(reminderSends)
    .values({ userId, groupId, game, gameweek, leadMinutes })
    .onConflictDoNothing({
      target: [
        reminderSends.userId,
        reminderSends.game,
        reminderSends.gameweek,
        reminderSends.leadMinutes,
      ],
    })
    .returning({ id: reminderSends.id });
  return inserted.length > 0;
}

async function sendReminder(
  userId: number,
  groupId: number,
  game: string,
  gameweek: number,
  leadMinutes: number,
  payload: PushPayload,
): Promise<void> {
  if (!(await claimReminder(userId, groupId, game, gameweek, leadMinutes))) return;
  const sent = await sendToUser(userId, payload);
  console.log(
    `[reminders] ${game} GW${gameweek} @${leadMinutes}m → user ${userId}: ${sent} device(s)`,
  );
}

async function runReminderCheck(): Promise<void> {
  if (!isPushConfigured()) return;
  const now = Date.now();

  // Skip the whole check — no DB reads — unless a gameweek deadline is within
  // the widest reminder lead, i.e. a reminder could actually be due. This gate
  // reads an in-memory schedule snapshot, so on the ~5 days a week with no
  // deadline in the next 24h the per-minute cron never touches the DB.
  if (!(await plDeadlineWithin(MAX_LEAD_MINUTES * MIN_MS, now))) return;

  const allUsers = await db.select().from(users);
  const userById = new Map(allUsers.map((u) => [u.id, u]));

  // Per-person lead times (minutes), unioned across all their devices.
  const subs = await db.select().from(pushSubscriptions);
  if (subs.length === 0) return;
  const personLeads = new Map<string, Set<number>>();
  for (const s of subs) {
    const u = userById.get(s.userId);
    const key = personKey(u?.loginCode ?? null, s.userId);
    const set = personLeads.get(key) ?? new Set<number>();
    for (const m of s.reminderLeadsMinutes ?? []) set.add(m);
    personLeads.set(key, set);
  }
  const leadsForUser = (userId: number): number[] | null => {
    const u = userById.get(userId);
    const set = personLeads.get(personKey(u?.loginCode ?? null, userId));
    return set ? Array.from(set) : null;
  };

  // Scope to the current season — otherwise old seasons' identically-numbered
  // gameweeks poison each deadline with a past date and nothing ever fires.
  const allMatches = filterToCurrentSeason(await db.select().from(matchesTable));
  const byGameweek = new Map<number, typeof allMatches>();
  for (const m of allMatches) {
    if (m.gameweek == null) continue;
    const arr = byGameweek.get(m.gameweek) ?? [];
    arr.push(m);
    byGameweek.set(m.gameweek, arr);
  }
  const deadlineByGw = new Map<number, number>();
  for (const [gw, gwMatches] of Array.from(byGameweek.entries())) {
    const dl = gameweekDeadlineMs(gwMatches);
    if (dl != null) deadlineByGw.set(gw, dl);
  }
  const lookAhead = MAX_LEAD_MINUTES * MIN_MS;
  const dueGameweeks = Array.from(deadlineByGw.entries())
    .filter(([, dl]) => now < dl && now >= dl - lookAhead)
    .map(([gw]) => gw);
  if (dueGameweeks.length === 0) return;

  // Lead times (for this person) whose window [deadline - lead, deadline) is
  // currently open.
  const firingLeads = (deadlineMs: number, leads: number[]): number[] =>
    leads.filter((m) => now >= deadlineMs - m * MIN_MS && now < deadlineMs);

  const allGroups = await db.select().from(groups);
  const usersByGroup = new Map<number, typeof allUsers>();
  for (const u of allUsers) {
    const arr = usersByGroup.get(u.groupId) ?? [];
    arr.push(u);
    usersByGroup.set(u.groupId, arr);
  }

  for (const group of allGroups) {
    const groupGames = (group.enabledGames as string[]) ?? [];
    const groupUsers = usersByGroup.get(group.id) ?? [];

    // ---- Lawro (Prediction League) ----
    if (groupGames.includes("predictions")) {
      const eligible = groupUsers.filter(
        (u) =>
          effectiveGames(groupGames, u.enabledGames as string[] | null).includes("predictions") &&
          leadsForUser(u.id) != null,
      );
      for (const gw of dueGameweeks) {
        const deadlineMs = deadlineByGw.get(gw)!;
        const gwMatches = byGameweek.get(gw) ?? [];
        const matchIds = gwMatches.map((m) => m.id);
        // Only players who have a lead time currently firing.
        const candidates = eligible.filter((u) => firingLeads(deadlineMs, leadsForUser(u.id)!).length);
        if (matchIds.length === 0 || candidates.length === 0) continue;

        const userIds = candidates.map((u) => u.id);
        const preds = await db
          .select({ userId: predictions.userId, matchId: predictions.matchId })
          .from(predictions)
          .where(and(inArray(predictions.userId, userIds), inArray(predictions.matchId, matchIds)));
        const countByUser = new Map<number, number>();
        for (const p of preds) countByUser.set(p.userId, (countByUser.get(p.userId) ?? 0) + 1);

        for (const u of candidates) {
          const made = countByUser.get(u.id) ?? 0;
          if (made >= matchIds.length) continue; // fully predicted — no nudge
          for (const lead of firingLeads(deadlineMs, leadsForUser(u.id)!)) {
            await sendReminder(u.id, group.id, "lawro", gw, lead, {
              title: `Lawro — Gameweek ${gw}`,
              body:
                made === 0
                  ? "You haven't made your predictions yet — don't miss the deadline."
                  : "Some predictions are still missing — don't miss the deadline.",
              url: "/lawro",
              tag: `lawro-gw${gw}`,
            });
          }
        }
      }
    }

    // ---- Last Man Standing ----
    if (groupGames.includes("lms")) {
      const competition = await storage.getCurrentLmsCompetition(group.id);
      if (!competition || competition.status !== "active") continue;
      const gw = competition.currentGameweek;
      const deadlineMs = deadlineByGw.get(gw);
      if (deadlineMs == null) continue;

      const participants = await storage.getLmsParticipantsByCompetition(competition.id);
      for (const p of participants) {
        if (p.isActive !== "true") continue;
        const leads = leadsForUser(p.userId);
        if (!leads) continue;
        const firing = firingLeads(deadlineMs, leads);
        if (firing.length === 0) continue;
        const selections = await storage.getLmsSelectionsByParticipant(p.id);
        if (selections.some((s) => s.gameweek === gw)) continue; // already picked
        for (const lead of firing) {
          await sendReminder(p.userId, group.id, "lms", gw, lead, {
            title: `Last Man Standing — Gameweek ${gw}`,
            body: "You haven't picked a team yet — don't miss the deadline.",
            url: "/last-man-standing",
            tag: `lms-gw${gw}`,
          });
        }
      }
    }
  }
}

export const reminderProcessor = {
  start() {
    if (!isPushConfigured()) {
      console.log("[reminders] push not configured — reminder scheduler not started.");
      return;
    }
    cron.schedule("* * * * *", () => {
      runReminderCheck().catch((err) => console.error("[reminders] check failed:", err));
    });
    console.log("[reminders] kickoff reminder scheduler started.");
  },
};
