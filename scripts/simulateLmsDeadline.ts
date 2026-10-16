// Dev-only: make the current season's Gameweek 1 deadline (first kick-off) fall
// in the past, so the Last Man Standing view shows GW1 as locked and everyone's
// picks revealed. Run against your DEV database (uses DATABASE_URL).
//
//   npx tsx scripts/simulateLmsDeadline.ts          # push GW1's deadline into the past
//   npx tsx scripts/simulateLmsDeadline.ts reset    # restore the real fixtures
//
// It only moves the earliest GW1 kick-off (that's what the deadline/lock keys
// off) and leaves the matches not-started, so nothing gets scored/eliminated —
// you just see the post-deadline, pre-results state. Shares the GW1 snapshot
// with simulateLawro.ts, so `reset` from either restores the true fixtures.
// NOTE: a running dev server's live sync may re-fetch real times once GW1 looks
// "imminent" — view promptly or stop the server while testing.
import fs from "fs";
import path from "path";
import { db } from "../server/db";
import { matches } from "@shared/schema";
import { eq } from "drizzle-orm";
import { utcToLondonString, londonStringToUtcMs } from "@shared/time";

const BACKUP = path.resolve(import.meta.dirname, ".sim-backup-gw1.json");

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

async function reset() {
  if (!fs.existsSync(BACKUP)) {
    console.log("No backup found — nothing to reset.");
    return;
  }
  const snap: { id: number; status: string; homeScore: number | null; awayScore: number | null; matchTime: string }[] =
    JSON.parse(fs.readFileSync(BACKUP, "utf8"));
  for (const r of snap) {
    await db
      .update(matches)
      .set({ status: r.status, homeScore: r.homeScore, awayScore: r.awayScore, matchTime: r.matchTime })
      .where(eq(matches.id, r.id));
  }
  fs.unlinkSync(BACKUP);
  console.log(`Restored ${snap.length} GW1 rows and removed the backup.`);
}

async function main() {
  if (process.argv[2] === "reset") {
    await reset();
    process.exit(0);
  }

  const rows = await gw1();
  if (rows.length === 0) {
    console.log("No current-season Gameweek 1 matches found.");
    process.exit(1);
  }

  if (!fs.existsSync(BACKUP)) {
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

  // Move the earliest kick-off ~10 minutes into the past → deadline passed.
  const earliest = rows[0];
  await db
    .update(matches)
    .set({ matchTime: utcToLondonString(new Date(Date.now() - 10 * 60 * 1000).toISOString()) })
    .where(eq(matches.id, earliest.id));

  console.log(
    `GW1 deadline now in the past (moved match #${earliest.id}). LMS should show locked + picks revealed.\n` +
      `Reset with: npx tsx scripts/simulateLmsDeadline.ts reset`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
