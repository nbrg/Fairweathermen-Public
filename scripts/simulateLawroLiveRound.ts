// Dev-only: make a Lawro gameweek "live" so you can see the post-deadline grid
// (one column per match, one row per player) with real-looking data.
//
//   npx tsx scripts/simulateLawroLiveRound.ts live                       # current GW, every Lawro group
//   npx tsx scripts/simulateLawroLiveRound.ts live --gameweek 12         # a specific GW
//   npx tsx scripts/simulateLawroLiveRound.ts live --group fairweathermen # only one group's players
//   npx tsx scripts/simulateLawroLiveRound.ts open                       # deadline back in the future (pre-deadline layout)
//   npx tsx scripts/simulateLawroLiveRound.ts reset                      # put everything back
//
// `live` moves the gameweek's kick-offs so the deadline has passed: the first
// third finished with scores, the next third in progress (with a live minute),
// the rest still to kick off. Every player in the chosen group(s) who has no
// pick for a match gets a random one, so the grid is full. `open` moves every
// kick-off into the future instead, so you can compare the pre-deadline layout.
//
// The first run snapshots the gameweek's real match rows to
// scripts/.sim-live-round-gw<N>.json, together with the ids of every pick it
// inserted; `reset` restores the matches, deletes exactly those picks and
// removes the file. Run it against your DEV database only (DATABASE_URL); it
// refuses to run in production. If your dev server has a football-data key,
// its live-score sync can overwrite the matches once the gameweek looks live,
// so view promptly or run the server without FOOTBALL_DATA_API_KEY.

import fs from "fs";
import path from "path";
import { db } from "../server/db";
import { groups, matches, predictions, users } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { utcToLondonString, londonStringToUtcMs } from "@shared/time";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run in production: this script rewrites match times and inserts picks.");
  process.exit(1);
}

const MIN = 60 * 1000;
const londonAt = (msFromNow: number) => utcToLondonString(new Date(Date.now() + msFromNow).toISOString());
const argVal = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const SCORES: [number, number][] = [
  [2, 1], [0, 0], [1, 1], [3, 0], [1, 2], [2, 2], [0, 1], [1, 0], [2, 0], [3, 3],
];
const LIVE_MINUTES = [12, 37, 63, 88];

type Row = typeof matches.$inferSelect;
type Backup = {
  gameweek: number;
  matches: Pick<Row, "id" | "status" | "homeScore" | "awayScore" | "minute" | "matchTime">[];
  insertedPredictionIds: number[];
};

const backupPath = (gw: number) => path.resolve(import.meta.dirname, `.sim-live-round-gw${gw}.json`);

async function seasonRows(): Promise<Row[]> {
  const all = await db.select().from(matches);
  const seasons = all.map((m) => m.season).filter((s): s is string => !!s).sort();
  const season = seasons[seasons.length - 1];
  return all.filter((m) => season == null || m.season === season);
}

// --gameweek N, else the earliest gameweek with an unfinished match.
function resolveGameweek(rows: Row[]): number | null {
  const arg = argVal("--gameweek");
  if (arg != null) return Number(arg);
  const gws = Array.from(new Set(rows.map((m) => m.gameweek).filter((g): g is number => g != null))).sort((a, b) => a - b);
  return gws.find((gw) => rows.some((m) => m.gameweek === gw && m.status !== "finished" && m.status !== "completed")) ?? gws[0] ?? null;
}

const byKickoff = (a: Row, b: Row) =>
  (londonStringToUtcMs(a.matchTime) || 0) - (londonStringToUtcMs(b.matchTime) || 0) || a.id - b.id;

function loadBackup(gw: number): Backup | null {
  const file = backupPath(gw);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function saveBackup(b: Backup) {
  fs.writeFileSync(backupPath(b.gameweek), JSON.stringify(b, null, 2));
}

async function ensureBackup(gw: number, rows: Row[]): Promise<Backup> {
  const existing = loadBackup(gw);
  if (existing) return existing;
  const b: Backup = {
    gameweek: gw,
    matches: rows.map(({ id, status, homeScore, awayScore, minute, matchTime }) => ({ id, status, homeScore, awayScore, minute, matchTime })),
    insertedPredictionIds: [],
  };
  saveBackup(b);
  console.log(`Snapshotted ${rows.length} GW${gw} matches → ${path.basename(backupPath(gw))}`);
  return b;
}

async function setMatch(id: number, patch: Partial<typeof matches.$inferInsert>) {
  await db.update(matches).set(patch).where(eq(matches.id, id));
}

// Players whose picks to fill: one group's (--group slug), else every group playing Lawro.
async function lawroPlayers(): Promise<{ id: number; username: string }[]> {
  const slug = argVal("--group");
  const allGroups = await db.select().from(groups);
  const chosen = slug
    ? allGroups.filter((g) => g.slug === slug)
    : allGroups.filter((g) => (g.enabledGames ?? []).includes("predictions"));
  if (slug && chosen.length === 0) throw new Error(`No group with slug "${slug}"`);
  if (chosen.length === 0) return [];
  return db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(inArray(users.groupId, chosen.map((g) => g.id)));
}

async function fillPicks(backup: Backup, rows: Row[]) {
  const players = await lawroPlayers();
  if (players.length === 0 || rows.length === 0) return;
  const existing = await db
    .select({ userId: predictions.userId, matchId: predictions.matchId })
    .from(predictions)
    .where(and(inArray(predictions.matchId, rows.map((m) => m.id)), inArray(predictions.userId, players.map((p) => p.id))));
  const have = new Set(existing.map((p) => `${p.userId}:${p.matchId}`));
  const values = players.flatMap((p) =>
    rows
      .filter((m) => !have.has(`${p.id}:${m.id}`))
      .map((m) => ({ userId: p.id, matchId: m.id, homeScore: Math.floor(Math.random() * 4), awayScore: Math.floor(Math.random() * 3) })),
  );
  if (values.length === 0) return;
  const inserted = await db.insert(predictions).values(values).returning({ id: predictions.id });
  backup.insertedPredictionIds.push(...inserted.map((r) => r.id));
  saveBackup(backup);
  console.log(`Added ${inserted.length} random picks for ${players.length} players (removed again on reset).`);
}

async function live(gw: number, rows: Row[]) {
  const backup = await ensureBackup(gw, rows);
  const third = Math.max(1, Math.floor(rows.length / 3));
  for (let i = 0; i < rows.length; i++) {
    const [h, a] = SCORES[i % SCORES.length];
    if (i < third) {
      await setMatch(rows[i].id, { status: "finished", homeScore: h, awayScore: a, minute: null, matchTime: londonAt(-(240 - i * 8) * MIN) });
    } else if (i < 2 * third) {
      const minute = LIVE_MINUTES[(i - third) % LIVE_MINUTES.length];
      await setMatch(rows[i].id, { status: "in_progress", homeScore: h, awayScore: a, minute, matchTime: londonAt(-(minute + 2) * MIN) });
    } else {
      await setMatch(rows[i].id, { status: "not_started", homeScore: null, awayScore: null, minute: null, matchTime: londonAt((30 + (i - 2 * third) * 30) * MIN) });
    }
  }
  await fillPicks(backup, rows);
  console.log(`\nGW${gw} is now live (deadline passed). Open /lawro → Predictions: matches are columns, players rows.`);
  console.log(`Back to the pre-deadline layout: npx tsx scripts/simulateLawroLiveRound.ts open --gameweek ${gw}`);
  console.log(`Undo everything:                npx tsx scripts/simulateLawroLiveRound.ts reset --gameweek ${gw}`);
}

async function open(gw: number, rows: Row[]) {
  await ensureBackup(gw, rows);
  for (let i = 0; i < rows.length; i++) {
    await setMatch(rows[i].id, { status: "not_started", homeScore: null, awayScore: null, minute: null, matchTime: londonAt((24 * 60 + i * 30) * MIN) });
  }
  console.log(`GW${gw} kicks off tomorrow (picks open). Open /lawro → Predictions: one row per match.`);
}

async function reset(gwArg: string | undefined) {
  const dir = path.resolve(import.meta.dirname);
  const files = gwArg != null
    ? [backupPath(Number(gwArg))].filter((f) => fs.existsSync(f))
    : fs.readdirSync(dir).filter((f) => /^\.sim-live-round-gw\d+\.json$/.test(f)).map((f) => path.join(dir, f));
  if (files.length === 0) {
    console.log("No simulation backups found, nothing to reset.");
    return;
  }
  for (const file of files) {
    const b: Backup = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const m of b.matches) {
      await setMatch(m.id, { status: m.status, homeScore: m.homeScore, awayScore: m.awayScore, minute: m.minute, matchTime: m.matchTime });
    }
    if (b.insertedPredictionIds.length) {
      await db.delete(predictions).where(inArray(predictions.id, b.insertedPredictionIds));
    }
    fs.unlinkSync(file);
    console.log(`GW${b.gameweek}: restored ${b.matches.length} matches, removed ${b.insertedPredictionIds.length} simulated picks.`);
  }
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "reset") return reset(argVal("--gameweek"));
  if (cmd !== "live" && cmd !== "open") {
    console.log("Usage: npx tsx scripts/simulateLawroLiveRound.ts live|open|reset [--gameweek N] [--group slug]");
    return;
  }
  const all = await seasonRows();
  const gw = resolveGameweek(all);
  if (gw == null) throw new Error("No gameweeks found in the matches table.");
  const rows = all.filter((m) => m.gameweek === gw).sort(byKickoff);
  if (rows.length === 0) throw new Error(`No matches for GW${gw}.`);
  return cmd === "live" ? live(gw, rows) : open(gw, rows);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
