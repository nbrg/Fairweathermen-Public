// Dev-only: drive a gameweek's fixtures through the match-progress states this
// PR visualises on the Lawro page — finished (green dot · "FT"), in progress
// (pulsing red dot · live minute) and not started (grey dot · kickoff time) —
// including the new matches.minute column. Run against your DEV database.
//
//   npx tsx scripts/simulateLiveMatchProgress.ts mix                 # full mix on the current GW
//   npx tsx scripts/simulateLiveMatchProgress.ts mix --gameweek 2    # ...on a specific GW
//   npx tsx scripts/simulateLiveMatchProgress.ts tick                # live loop: minutes tick up every 10s
//   npx tsx scripts/simulateLiveMatchProgress.ts tick --interval 5   # ...faster, for impatient eyeballing
//   npx tsx scripts/simulateLiveMatchProgress.ts reset               # restore the real fixtures
//
// The first run of `mix`/`tick` snapshots the gameweek's real rows to
// scripts/.sim-progress-backup-gw<N>.json (including status/score/minute/time);
// `reset` restores from it and deletes it. So you always get the true fixtures
// back — as long as you reset before switching gameweeks.
//
// Requires the matches.minute column, i.e. this PR applied with `npm run db:push`.
// NOTE: if your dev server is running, its live-score sync can overwrite these
// rows once the gameweek is "live/imminent" — `tick` keeps re-asserting them, but
// for `mix` view promptly or stop the server while testing.

import fs from "fs";
import path from "path";
import { db } from "../server/db";
import { matches } from "@shared/schema";
import { eq } from "drizzle-orm";
import { utcToLondonString, londonStringToUtcMs } from "@shared/time";

const MIN = 60 * 1000;
const londonAt = (msFromNow: number) =>
  utcToLondonString(new Date(Date.now() + msFromNow).toISOString());

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// A few plausible scorelines to spread across the fixtures.
const SCORES: [number, number][] = [
  [2, 1], [0, 0], [1, 1], [3, 0], [1, 2],
  [2, 2], [0, 1], [1, 0], [2, 0], [3, 3],
];

type Row = typeof matches.$inferSelect;

function currentSeason(all: Row[]): string | null {
  const seasons = all.map((m) => m.season).filter((s): s is string => !!s);
  return seasons.length ? seasons.sort()[seasons.length - 1] : null;
}

// The gameweek to simulate: --gameweek N, else the earliest GW that still has an
// unfinished match (what the app treats as "current"), else the lowest GW.
function resolveGameweek(seasonRows: Row[]): number | null {
  const arg = argVal("--gameweek");
  if (arg != null) return Number(arg);
  const gws = Array.from(
    new Set(seasonRows.map((m) => m.gameweek).filter((g): g is number => typeof g === "number")),
  ).sort((a, b) => a - b);
  for (const gw of gws) {
    const gwm = seasonRows.filter((m) => m.gameweek === gw);
    if (gwm.some((m) => m.status !== "finished" && m.status !== "completed")) return gw;
  }
  return gws[0] ?? null;
}

async function gameweekRows(gameweek: number): Promise<Row[]> {
  const all = await db.select().from(matches);
  const season = currentSeason(all);
  return all
    .filter((m) => m.gameweek === gameweek && (season == null || m.season === season))
    .sort(
      (a, b) =>
        (londonStringToUtcMs(a.matchTime) || 0) - (londonStringToUtcMs(b.matchTime) || 0) ||
        a.id - b.id,
    );
}

const backupPath = (gw: number) =>
  path.resolve(import.meta.dirname, `.sim-progress-backup-gw${gw}.json`);

async function snapshotIfNeeded(gw: number, rows: Row[]) {
  const file = backupPath(gw);
  if (fs.existsSync(file)) return;
  const snap = rows.map((r) => ({
    id: r.id,
    status: r.status,
    homeScore: r.homeScore,
    awayScore: r.awayScore,
    minute: r.minute,
    matchTime: r.matchTime,
  }));
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  console.log(`Snapshotted ${snap.length} GW${gw} rows → ${path.basename(file)}`);
}

async function setMatch(id: number, patch: Partial<typeof matches.$inferInsert>) {
  await db.update(matches).set(patch).where(eq(matches.id, id));
}

// Mirror of the client's MatchProgress/MatchStatusDot so the printed table shows
// exactly what the Lawro page renders — the script is a textual test on its own.
function uiLabel(m: { status: string; minute: number | null; matchTime: string }): string {
  if (m.status === "in_progress") return `🔴 ${m.minute != null ? `${m.minute}'` : "Live"}`;
  if (m.status === "finished" || m.status === "completed") return "🟢 FT";
  const kickoff = m.matchTime?.split(" ")[1]?.slice(0, 5) ?? "";
  return `⚪ ${kickoff}`;
}

// Split the gameweek into finished / in-progress / not-started thirds.
function buckets<T>(rows: T[]) {
  const n = rows.length;
  const third = Math.max(1, Math.floor(n / 3));
  return {
    finished: rows.slice(0, third),
    inProgress: rows.slice(third, 2 * third),
    notStarted: rows.slice(2 * third),
  };
}

// Live minutes spread across the in-progress fixtures so you see a range.
const LIVE_MINUTES = [12, 37, 63, 88];

async function applyMix(gw: number, rows: Row[]) {
  const { finished, inProgress, notStarted } = buckets(rows);
  let s = 0;

  // Finished first (earliest kickoffs), fully scored.
  for (let i = 0; i < finished.length; i++) {
    const [h, a] = SCORES[s++ % SCORES.length];
    await setMatch(finished[i].id, {
      status: "finished",
      homeScore: h,
      awayScore: a,
      minute: null,
      matchTime: londonAt(-(240 - i * 8) * MIN),
    });
  }

  // In progress: a live minute + a score, kicked off roughly `minute` ago.
  for (let i = 0; i < inProgress.length; i++) {
    const [h, a] = SCORES[s++ % SCORES.length];
    const minute = LIVE_MINUTES[i % LIVE_MINUTES.length];
    await setMatch(inProgress[i].id, {
      status: "in_progress",
      homeScore: h,
      awayScore: a,
      minute,
      matchTime: londonAt(-(minute + 2) * MIN),
    });
  }

  // Not started: future kickoffs, no score/minute.
  for (let i = 0; i < notStarted.length; i++) {
    await setMatch(notStarted[i].id, {
      status: "not_started",
      homeScore: null,
      awayScore: null,
      minute: null,
      matchTime: londonAt((30 + i * 30) * MIN),
    });
  }

  await printState(gw);
  console.log(
    `\nApplied a finished/in-progress/not-started mix to GW${gw}. Open /lawro (Predictions tab).` +
      `\nReset with: npx tsx scripts/simulateLiveMatchProgress.ts reset --gameweek ${gw}`,
  );
}

async function printState(gw: number) {
  const rows = await gameweekRows(gw);
  console.log(`\nGW${gw} — ${rows.length} matches (status · score · minute · UI badge):`);
  for (const m of rows) {
    const score = m.homeScore != null && m.awayScore != null ? `${m.homeScore}-${m.awayScore}` : "–";
    console.log(
      `  #${String(m.id).padStart(4)}  ${m.status.padEnd(12)} ${score.padStart(4)}  ` +
        `min=${String(m.minute ?? "–").padStart(3)}   ${uiLabel(m)}`,
    );
  }
}

async function resetFromFile(file: string) {
  const snap: {
    id: number;
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    minute: number | null;
    matchTime: string;
  }[] = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const r of snap) {
    await setMatch(r.id, {
      status: r.status,
      homeScore: r.homeScore,
      awayScore: r.awayScore,
      minute: r.minute,
      matchTime: r.matchTime,
    });
  }
  fs.unlinkSync(file);
  console.log(`Restored ${snap.length} rows from ${path.basename(file)} and removed the backup.`);
}

// reset --gameweek N restores that gameweek; a bare reset restores every backup
// this script has left behind (so you can't strand a modified gameweek).
async function reset(gwArg: string | undefined) {
  if (gwArg != null) {
    const file = backupPath(Number(gwArg));
    if (!fs.existsSync(file)) {
      console.log(`No backup found for GW${gwArg} — nothing to reset.`);
      return;
    }
    await resetFromFile(file);
    return;
  }
  const dir = path.resolve(import.meta.dirname);
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\.sim-progress-backup-gw\d+\.json$/.test(f))
    .map((f) => path.join(dir, f));
  if (files.length === 0) {
    console.log("No simulation backups found — nothing to reset.");
    return;
  }
  for (const file of files) await resetFromFile(file);
}

// Live loop: every `interval` seconds, advance each in-progress match's minute
// (nudging the score now and then, and retiring a match to FT past 90'), so you
// can watch the Lawro page's 10s auto-refresh update the minutes in real time.
async function tick(gw: number, intervalSec: number) {
  console.log(
    `Live tick on GW${gw} every ${intervalSec}s. Watch /lawro update. Press Ctrl-C to stop` +
      ` (then reset: npx tsx scripts/simulateLiveMatchProgress.ts reset --gameweek ${gw}).\n`,
  );
  process.on("SIGINT", () => {
    console.log(
      `\nStopped. Reset with: npx tsx scripts/simulateLiveMatchProgress.ts reset --gameweek ${gw}`,
    );
    process.exit(0);
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await gameweekRows(gw);
    for (const m of rows) {
      if (m.status !== "in_progress") continue;
      const nextMinute = (m.minute ?? 0) + 1;
      if (nextMinute > 90) {
        await setMatch(m.id, { status: "finished", minute: null });
        continue;
      }
      const patch: Partial<typeof matches.$inferInsert> = { minute: nextMinute };
      // Occasional goal so scores move too.
      if (nextMinute % 20 === 0) patch.homeScore = (m.homeScore ?? 0) + 1;
      await setMatch(m.id, patch);
    }
    await printState(gw);
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

async function main() {
  const scenario = process.argv[2];
  if (!scenario || !["mix", "tick", "reset"].includes(scenario)) {
    console.log(
      "Usage: npx tsx scripts/simulateLiveMatchProgress.ts <mix|tick|reset> [--gameweek N] [--interval 10]",
    );
    process.exit(1);
  }

  if (scenario === "reset") {
    await reset(argVal("--gameweek"));
    process.exit(0);
  }

  const all = await db.select().from(matches);
  const season = currentSeason(all);
  const seasonRows = all.filter((m) => season == null || m.season === season);
  const gw = resolveGameweek(seasonRows);
  if (gw == null) {
    console.log("No gameweeks found for the current season.");
    process.exit(1);
  }

  const rows = await gameweekRows(gw);
  if (rows.length === 0) {
    console.log(`No current-season matches found for GW${gw}.`);
    process.exit(1);
  }
  await snapshotIfNeeded(gw, rows);

  if (scenario === "mix") {
    await applyMix(gw, rows);
    process.exit(0);
  }
  if (scenario === "tick") {
    // Seed a mix first (so there's something live to tick), then loop.
    await applyMix(gw, rows);
    const interval = Number(argVal("--interval") ?? "10");
    await tick(gw, Number.isFinite(interval) && interval > 0 ? interval : 10);
  }
}

main().catch((err) => {
  const msg = String(err?.message || err);
  if (/column .*minute.* does not exist/i.test(msg)) {
    console.error(
      "\nThe matches.minute column is missing. Apply this PR's schema first:\n  npm run db:push\n",
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
