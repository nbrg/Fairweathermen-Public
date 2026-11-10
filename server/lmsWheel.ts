import cron from "node-cron";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { getGroupRules } from "./groupRules";
import { eligibleTeamsForGameweek } from "./autoLmsProcessor";
import { plGameweekFirstKickoffs } from "./scheduleGate";
import { sendToUser, isPushConfigured } from "./push";
import { groups, reminderSends, users, type LmsCompetition, type LmsSelection } from "@shared/schema";
import { londonStringToUtcMs } from "@shared/time";
import {
  WHEEL_PUSH_DELAY_MS,
  WHEEL_REVEAL_LEAD_MS,
  WHEEL_SPIN_DELAY_MS,
  spinsIn,
  wheelPushMessage,
  wheelTimes,
  type WheelSpinView,
  type WheelView,
} from "@shared/lmsWheel";

// Last Man Standing randomiser wheel (see shared/lmsWheel.ts for the timings).
// Nothing here picks a team: assignRandomTeams still draws the pick at the
// deadline. This module works out who the wheel is spinning for, keeps those
// picks hidden until each wheel lands, and sends the "watch live" push.

const MIN_MS = 60 * 1000;
// Past this point after the deadline a wheel can't still be spinning (the
// delay plus a slot for a large group), so there's nothing to hide or show.
const WHEEL_WINDOW_MS = WHEEL_SPIN_DELAY_MS + 30 * MIN_MS;

type WheelEntry = {
  participantId: number;
  userId: number;
  name: string;
  selection: LmsSelection | null; // null until the deadline job has drawn it
  pool: { teamId: number; name: string; shortName: string }[];
  spinStartMs: number;
  landMs: number;
  hideMs: number;
};

export type WheelState = {
  competition: LmsCompetition;
  gameweek: number;
  deadlineMs: number;
  entries: WheelEntry[];
};

// The deadline (UTC ms) of `gameweek` for a group whose LMS deadline is
// `offsetMinutes` before the first kickoff. null if it has no fixtures.
async function gameweekDeadlineMs(gameweek: number, offsetMinutes: number): Promise<number | null> {
  const matches = (await storage.getAllMatches()).filter((m) => m.gameweek === gameweek);
  const times = matches.map((m) => londonStringToUtcMs(m.matchTime)).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return null;
  return Math.min(...times) - offsetMinutes * MIN_MS;
}

// Who the wheel spins for in a competition's current gameweek, in spin order,
// or null when there's no wheel: the group doesn't use random picks, the
// deadline hasn't passed, or it passed too long ago for a wheel to be showing.
// Covers both players the deadline job has already given a random team and
// active players it is about to (so the countdown can start straight away).
export async function getWheelState(
  competition: LmsCompetition,
  now: number = Date.now(),
): Promise<WheelState | null> {
  if (competition.status !== "active") return null;
  const gameweek = competition.currentGameweek;
  if (gameweek < competition.startGameweek) return null;
  const rules = await getGroupRules(competition.groupId);
  if (rules.lms.missedPickPolicy !== "random") return null;
  const deadlineMs = await gameweekDeadlineMs(gameweek, rules.lms.deadlineMinutesBeforeKickoff);
  if (deadlineMs == null || now < deadlineMs || now > deadlineMs + WHEEL_WINDOW_MS) return null;

  const allMatches = await storage.getAllMatches();
  const eligible = eligibleTeamsForGameweek(allMatches, gameweek);
  const teams = new Map((await storage.getAllTeams()).map((t) => [t.id, t]));
  const participants = (await storage.getLmsParticipantsByCompetition(competition.id))
    .slice()
    .sort((a, b) => a.id - b.id);

  const entries: Omit<WheelEntry, "spinStartMs" | "landMs" | "hideMs">[] = [];
  for (const p of participants) {
    const selections = await storage.getLmsSelectionsByParticipant(p.id);
    const current = selections.find((s) => s.gameweek === gameweek) ?? null;
    // Random picks are only ever drawn once the deadline has passed, so any
    // random pick for this gameweek is one the wheel is revealing.
    const drawnAtDeadline = current != null && String(current.isRandomlyAssigned) === "true";
    const awaitingDraw = current == null && p.isActive === "true";
    if (!drawnAtDeadline && !awaitingDraw) continue;

    // Only the teams they had left: playing this gameweek and never used before.
    const used = new Set(
      selections.filter((s) => s.gameweek !== gameweek && s.teamId != null).map((s) => s.teamId as number),
    );
    const pool = Array.from(eligible.keys())
      .filter((id) => !used.has(id))
      .map((id) => ({ teamId: id, name: teams.get(id)?.name ?? "?", shortName: teams.get(id)?.shortName ?? "?" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (pool.length === 0) continue;

    const user = await storage.getUser(p.userId);
    entries.push({
      participantId: p.id,
      userId: p.userId,
      name: user?.username ?? "Player",
      selection: drawnAtDeadline ? current : null,
      pool,
    });
  }

  return {
    competition,
    gameweek,
    deadlineMs,
    entries: entries.map((e, i) => ({ ...e, ...wheelTimes(deadlineMs, i) })),
  };
}

// Selection ids whose wheel hasn't landed yet, for a group's competitions.
// These picks are hidden from everyone — their owner included — until then.
export async function wheelHiddenSelectionIds(
  competitions: LmsCompetition[],
  now: number = Date.now(),
): Promise<Set<number>> {
  const hidden = new Set<number>();
  for (const c of competitions) {
    if (c.status !== "active") continue;
    const state = await getWheelState(c, now);
    for (const e of state?.entries ?? []) {
      if (e.selection && now < e.landMs) hidden.add(e.selection.id);
    }
  }
  return hidden;
}

// The client's view: only wheels that haven't finished showing, with each
// drawn team revealed once its wheel starts spinning.
export async function wheelViewFor(
  competition: LmsCompetition,
  viewerUserId: number | undefined,
  now: number = Date.now(),
): Promise<WheelView | null> {
  let state = await getWheelState(competition, now);
  if (!state) return null;
  // The deadline has passed but a missed pick hasn't been drawn yet (the
  // background job runs once a minute): draw it now, so the wheel always has a
  // result to land on. processMissedLmsPicks is idempotent and serialised.
  if (state.entries.some((e) => e.selection == null)) {
    const { processMissedLmsPicks } = await import("./autoLmsProcessor");
    await processMissedLmsPicks(competition, state.gameweek);
    state = (await getWheelState(competition, now)) ?? state;
  }
  const spins: WheelSpinView[] = [];
  for (const e of state.entries) {
    if (now >= e.hideMs) continue;
    const revealed = e.selection != null && now >= e.spinStartMs - WHEEL_REVEAL_LEAD_MS;
    let opponent: WheelSpinView["opponent"] = null;
    if (revealed && e.selection!.matchId != null) {
      const m = (await storage.getAllMatches()).find((x) => x.id === e.selection!.matchId);
      if (m) {
        const isHome = m.homeTeamId === e.selection!.teamId;
        const oppId = isHome ? m.awayTeamId : m.homeTeamId;
        const opp = oppId != null ? (await storage.getTeam(oppId)) : undefined;
        if (opp) opponent = { shortName: opp.shortName, isHome };
      }
    }
    spins.push({
      participantId: e.participantId,
      userId: e.userId,
      name: e.name,
      isMe: e.userId === viewerUserId,
      pool: e.pool,
      spinStartMs: e.spinStartMs,
      landMs: e.landMs,
      hideMs: e.hideMs,
      teamId: revealed ? e.selection!.teamId : null,
      opponent,
    });
  }
  if (spins.length === 0) return null;
  return { serverNow: now, gameweek: state.gameweek, deadlineMs: state.deadlineMs, spins };
}

// ---------------------------------------------------------------------------
// Deadline gate. The LMS processor and the wheel push only need to run around
// a deadline, but each group sets its own deadline offset, so the plain
// kickoff-based live window can open too late (it used to mean a group with a
// 60-minute deadline got its random picks a minute before kickoff). The
// distinct offsets are cached and re-read at most every 6 hours, or when an
// admin saves the rules.

let offsetsCache: { offsets: number[]; at: number } | null = null;
const OFFSETS_TTL_MS = 6 * 60 * MIN_MS;

export function invalidateLmsDeadlineOffsets(): void {
  offsetsCache = null;
}

async function lmsDeadlineOffsets(now: number): Promise<number[]> {
  if (offsetsCache && now - offsetsCache.at < OFFSETS_TTL_MS) return offsetsCache.offsets;
  const { resolveGroupRules } = await import("@shared/schema");
  const rows = await db.select({ rules: groups.rules, enabledGames: groups.enabledGames }).from(groups);
  const set = new Set<number>([0]);
  for (const r of rows) {
    if (!((r.enabledGames as string[] | null) ?? []).includes("lms")) continue;
    set.add(resolveGroupRules(r.rules as any).lms.deadlineMinutesBeforeKickoff);
  }
  offsetsCache = { offsets: Array.from(set), at: now };
  return offsetsCache.offsets;
}

// True from a minute before any group's LMS deadline until the last wheel
// could have finished. Reads only the in-memory schedule (plus the offsets).
export async function lmsDeadlineWindowActive(now: number = Date.now()): Promise<boolean> {
  const kickoffs = await plGameweekFirstKickoffs(now);
  if (kickoffs.length === 0) return false;
  // Cheapest check first: no kickoff within a week ahead means no deadline is near.
  const soonest = kickoffs.filter((k) => k >= now - WHEEL_WINDOW_MS && k - now <= 7 * 24 * 60 * MIN_MS);
  if (soonest.length === 0) return false;
  const offsets = await lmsDeadlineOffsets(now);
  return soonest.some((k) =>
    offsets.some((o) => {
      const deadline = k - o * MIN_MS;
      return now >= deadline - MIN_MS && now <= deadline + WHEEL_WINDOW_MS;
    }),
  );
}

// ---------------------------------------------------------------------------
// "Watch live" push, WHEEL_PUSH_DELAY_MS after the deadline, to everyone in the
// group who plays LMS (no-op for anyone without notifications set up). Sent at
// most once per person per competition gameweek: the claim reuses the
// reminder_sends dedupe table, keyed by competition.

async function claimWheelPush(userId: number, groupId: number, competitionId: number, gameweek: number) {
  const inserted = await db
    .insert(reminderSends)
    .values({ userId, groupId, game: `lms-wheel-c${competitionId}`, gameweek, leadMinutes: 0 })
    .onConflictDoNothing({
      target: [reminderSends.userId, reminderSends.game, reminderSends.gameweek, reminderSends.leadMinutes],
    })
    .returning({ id: reminderSends.id });
  return inserted.length > 0;
}

async function lmsPlayersInGroup(groupId: number) {
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!group || !((group.enabledGames as string[] | null) ?? []).includes("lms")) return [];
  const rows = await db.select().from(users).where(eq(users.groupId, groupId));
  return rows.filter((u) => {
    const override = u.enabledGames as string[] | null;
    return override ? override.includes("lms") : true;
  });
}

export async function sendWheelPushes(now: number = Date.now()): Promise<number> {
  let sent = 0;
  for (const competition of await storage.getActiveLmsCompetitions()) {
    const state = await getWheelState(competition, now);
    if (!state || state.entries.length === 0) continue;
    const first = state.entries[0];
    // Due 90s after the deadline, and pointless once the first wheel has spun.
    if (now < state.deadlineMs + WHEEL_PUSH_DELAY_MS || now >= first.spinStartMs) continue;
    const missed = state.entries.map((e) => e.name);
    const when = spinsIn(first.spinStartMs - now);
    for (const u of await lmsPlayersInGroup(competition.groupId)) {
      if (!(await claimWheelPush(u.id, competition.groupId, competition.id, state.gameweek))) continue;
      const msg = wheelPushMessage(missed, u.username, state.gameweek, when);
      const devices = await sendToUser(u.id, {
        ...msg,
        url: "/last-man-standing",
        tag: `lms-wheel-${competition.id}-${state.gameweek}`,
      });
      sent += devices;
      console.log(`[wheel] GW${state.gameweek} push → ${u.username}: ${devices} device(s)`);
    }
  }
  return sent;
}

export const lmsWheelProcessor = {
  start() {
    if (!isPushConfigured()) {
      console.log("[wheel] push not configured — wheel notifications not started.");
      return;
    }
    // Every 15s so the push lands close to 90s after the deadline; the gate
    // keeps this off the database except around a deadline.
    cron.schedule("*/15 * * * * *", async () => {
      try {
        if (!(await lmsDeadlineWindowActive())) return;
        await sendWheelPushes();
      } catch (err) {
        console.error("[wheel] push check failed:", err);
      }
    });
    console.log("[wheel] wheel notification scheduler started.");
  },
};
