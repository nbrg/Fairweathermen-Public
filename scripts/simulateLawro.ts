// Dev-only: put the current season's Gameweek 1 matches into a chosen state so
// you can eyeball the Lawro (Prediction League) views. Run against your DEV
// database (uses DATABASE_URL).
//
//   npx tsx scripts/simulateLawro.ts first-inprogress   # only the 1st match live
//   npx tsx scripts/simulateLawro.ts all-live           # all 10 played or in-progress
//   npx tsx scripts/simulateLawro.ts all-complete       # all 10 finished
//   npx tsx scripts/simulateLawro.ts reset              # restore the real fixtures
//
// The FIRST time you run any scenario it snapshots GW1's real rows to
// scripts/.sim-backup-gw1.json; `reset` restores from that and deletes it, so
// you always get the true fixtures back. NOTE: if your dev server is running,
// its live-score sync can overwrite these once GW1 is "live/imminent" — view
// promptly, or stop the server while testing.
import fs from "fs";
import path from "path";
import { db } from "../server/db";
import { matches } from "@shared/schema";
import { eq } from "drizzle-orm";
import { utcToLondonString, londonStringToUtcMs } from "@shared/time";

const BACKUP = path.resolve(import.meta.dirname, ".sim-backup-gw1.json");
const londonAt = (msFromNow: number) =>
  utcToLondonString(new Date(Date.now() + msFromNow).toISOString());
const MIN = 60 * 1000;

// A few plausible scorelines to spread across the fixtures.
const SCORES: [number, number][] = [
  [2, 1], [0, 0], [1, 1], [3, 0], [1, 2],
  [2, 2], [0, 1], [1, 0], [2, 0], [3, 3],
];

async function gw1() {
  const all = await db.select().from(matches);
  const seasons = all.map((m) => m.season).filter((s): s is string => !!s);
  const current = seasons.length ? seasons.sort()[seasons.length - 1] : null;
  return all
    .filter((m) => m.gameweek === 1 && (current == null || m.season === current))
    .sort(
      (a, b) =>
        (londonStringToUtcMs(a.matchTime) || 0) - (londonStringToUtcMs(b.matchTime) || 0) ||
        a.id - b.id,
    );
}

async function snapshotIfNeeded(rows: Awaited<ReturnType<typeof gw1>>) {
  if (fs.existsSync(BACKUP)) return;
  const snap = rows.map((r) => ({
    id: r.id,
    status: r.status,
    homeScore: r.homeScore,
    awayScore: r.awayScore,
    matchTime: r.matchTime,
  }));
  fs.writeFileSync(BACKUP, JSON.stringify(snap, null, 2));
  console.log(`Snapshotted ${snap.length} GW1 rows → ${path.basename(BACKUP)}`);
}

async function setMatch(id: number, patch: Partial<typeof matches.$inferInsert>) {
  await db.update(matches).set(patch).where(eq(matches.id, id));
}

async function reset() {
  if (!fs.existsSync(BACKUP)) {
    console.log("No backup found — nothing to reset.");
    return;
  }
  const snap: { id: number; status: string; homeScore: number | null; awayScore: number | null; matchTime: string }[] =
    JSON.parse(fs.readFileSync(BACKUP, "utf8"));
  for (const r of snap) {
    await setMatch(r.id, {
      status: r.status,
      homeScore: r.homeScore,
      awayScore: r.awayScore,
      matchTime: r.matchTime,
    });
  }
  fs.unlinkSync(BACKUP);
  console.log(`Restored ${snap.length} GW1 rows and removed the backup.`);
}

async function main() {
  const scenario = process.argv[2];
  if (!scenario) {
    console.log("Usage: npx tsx scripts/simulateLawro.ts <first-inprogress|all-live|all-complete|reset>");
    process.exit(1);
  }
  if (scenario === "reset") {
    await reset();
    process.exit(0);
  }

  const rows = await gw1();
  if (rows.length === 0) {
    console.log("No current-season Gameweek 1 matches found.");
    process.exit(1);
  }
  await snapshotIfNeeded(rows);

  if (scenario === "first-inprogress") {
    // First match kicked off (deadline passed → picks revealed) and is live.
    // The rest are pushed into the future and not-started, so ordering stays
    // correct (the live game sits at the top) regardless of the stored times.
    await setMatch(rows[0].id, {
      status: "in_progress",
      homeScore: 1,
      awayScore: 0,
      matchTime: londonAt(-35 * MIN),
    });
    for (let i = 1; i < rows.length; i++) {
      await setMatch(rows[i].id, {
        status: "not_started",
        homeScore: null,
        awayScore: null,
        matchTime: londonAt((60 + i * 30) * MIN),
      });
    }
  } else if (scenario === "all-live") {
    // Every match has kicked off; a mix of finished and still-in-progress.
    for (let i = 0; i < rows.length; i++) {
      const [h, a] = SCORES[i % SCORES.length];
      await setMatch(rows[i].id, {
        status: i % 2 === 0 ? "finished" : "in_progress",
        homeScore: h,
        awayScore: a,
        matchTime: londonAt(-(120 - i * 8) * MIN),
      });
    }
  } else if (scenario === "all-complete") {
    // Every match finished — GW1 fully scored (Stats/Table tabs populate).
    for (let i = 0; i < rows.length; i++) {
      const [h, a] = SCORES[i % SCORES.length];
      await setMatch(rows[i].id, {
        status: "finished",
        homeScore: h,
        awayScore: a,
        matchTime: londonAt(-(180 - i * 8) * MIN),
      });
    }
  } else {
    console.log(`Unknown scenario "${scenario}".`);
    process.exit(1);
  }

  console.log(`Applied "${scenario}" to ${rows.length} GW1 matches. Reset with: npx tsx scripts/simulateLawro.ts reset`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
