// Cheap, in-memory "is there anything to do right now?" gates for the
// background pollers, so they stop hitting the database every few seconds when
// nothing is happening.
//
// Why this exists: the live-score/LMS/reminder crons used to read the DB on
// every tick (every 10s / every minute) purely to *decide* whether there was
// work — e.g. `getLiveOrImminentGameweeks()` read the whole matches table every
// 10 seconds, 24/7. On Neon serverless that keeps the database awake
// continuously (a query resets its idle-to-sleep timer), which is billed per
// compute-hour. Kickoff times are known ahead of time, so we can cache the
// schedule in memory and only touch the DB during real match/kickoff windows.
//
// The snapshot is refreshed from the DB *sparsely* — shortly before the next
// window opens, plus an occasional safety refresh — never on every tick. During
// an actual match window the pollers do their normal per-tick DB work; this
// only changes the idle behaviour. It never caches or delays user writes: those
// go straight through their request handlers, untouched.

import { storage } from "./storage";
import { londonStringToUtcMs } from "@shared/time";

const MIN_MS = 60 * 1000;
// Open the live window this long before kickoff.
const PRE_KICKOFF_MS = 1 * MIN_MS;
// Keep it open this long after kickoff — enough to cover a full match (~2h incl.
// halftime + stoppage).
const POST_KICKOFF_MS = 2 * 60 * MIN_MS;
// Refresh the snapshot this long before a window is due to open, so we're
// working from fresh kickoff times when it matters.
const REFRESH_LEAD_MS = 25 * MIN_MS;
// Safety net: re-read at least this often even when idle, to pick up newly
// imported fixtures or kickoff-time changes. Cheap (a handful of reads/day).
const IDLE_SAFETY_MS = 6 * 60 * MIN_MS;

type Fixture = { gameweek: number | null; status: string; kickoffMs: number };

// Given the fixtures, when should we next re-read the DB? The soonest moment a
// window is about to open, else the idle safety interval. Windows are derived
// purely from kickoff times, so between refreshes the in-memory snapshot is
// enough to decide whether we're live.
function computeNextRefresh(now: number, fixtures: Fixture[]): number {
  let next = now + IDLE_SAFETY_MS;
  for (const f of fixtures) {
    if (Number.isNaN(f.kickoffMs)) continue;
    const refreshAt = f.kickoffMs - PRE_KICKOFF_MS - REFRESH_LEAD_MS;
    if (refreshAt > now && refreshAt < next) next = refreshAt;
  }
  return next;
}

function isWithinWindow(now: number, f: Fixture): boolean {
  if (f.status === "in_progress") return true;
  if (Number.isNaN(f.kickoffMs)) return false;
  return now >= f.kickoffMs - PRE_KICKOFF_MS && now <= f.kickoffMs + POST_KICKOFF_MS;
}

// ---------------- Prediction League / LMS (the `matches` table) ----------------

let plSnapshot: Fixture[] | null = null;
let plNextRefreshAt = 0;

async function refreshPl(now: number): Promise<void> {
  const matches = await storage.getAllMatches(); // current-season only
  plSnapshot = matches.map((m) => ({
    gameweek: m.gameweek ?? null,
    status: m.status,
    kickoffMs: m.matchTime ? londonStringToUtcMs(m.matchTime) : NaN,
  }));
  plNextRefreshAt = computeNextRefresh(now, plSnapshot);
}

async function ensurePl(now: number): Promise<void> {
  if (plSnapshot === null || now >= plNextRefreshAt) await refreshPl(now);
}

// Drop the cached schedule so the next gate call re-reads it — call after a job
// rewrites kickoff times (e.g. the upcoming-fixture-times refresh).
export function invalidatePlSchedule(): void {
  plSnapshot = null;
  plNextRefreshAt = 0;
}

// True while any current-season PL match is live, or within
// [kickoff - 15min, kickoff + 4h]. The live-score sync and LMS processor gate on
// this so they only query the DB during real match windows.
export async function plLiveWindowActive(now: number = Date.now()): Promise<boolean> {
  await ensurePl(now);
  return (plSnapshot ?? []).some((f) => isWithinWindow(now, f));
}

// True if any gameweek's deadline (its first kickoff) is within the next
// `windowMs`. The reminder scheduler gates on this so it doesn't read the DB
// every minute when no gameweek deadline is near.
export async function plDeadlineWithin(windowMs: number, now: number = Date.now()): Promise<boolean> {
  await ensurePl(now);
  const firstByGw = new Map<number, number>();
  for (const f of plSnapshot ?? []) {
    if (f.gameweek == null || Number.isNaN(f.kickoffMs)) continue;
    const cur = firstByGw.get(f.gameweek);
    if (cur == null || f.kickoffMs < cur) firstByGw.set(f.gameweek, f.kickoffMs);
  }
  for (const dl of Array.from(firstByGw.values())) {
    if (now < dl && dl - now <= windowMs) return true;
  }
  return false;
}
