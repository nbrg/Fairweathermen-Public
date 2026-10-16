// Seed a small, deterministic dataset for the end-to-end tests (and for a quick
// local poke-around). It wipes the tables it owns and rebuilds them so every
// run starts from the same state — point DATABASE_URL at a throwaway database,
// never a real one.
//
//   npm run db:seed:test      # or: npx tsx scripts/seedTestData.ts
//
// What it creates:
//   - one group, "Demo League" (slug "demo"), playing Lawro + LMS
//   - three players with fixed login codes (printed at the end)
//   - six teams, and two gameweeks of fixtures:
//       GW1 — kicked off two days ago, finished 2-1 (so it scores)
//       GW2 — kicks off in a week (so it's still open, and other players'
//             picks stay hidden until the deadline)
//   - Lawro predictions that make GW1's leaderboard come out Alex 3, Blake 1,
//     Casey 0, plus a hidden GW2 pick to exercise the redaction rule
//   - an active LMS competition on GW2 with all three players in it

import { db, pool } from "../server/db";
import {
  groups, users, teams, matches, predictions,
  lmsCompetitions, lmsParticipants, lmsSelections,
} from "@shared/schema";
import { utcToLondonString } from "@shared/time";

const SEASON = "2025/2026";

function londonAt(offsetDays: number, hour = 15): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(hour, 0, 0, 0);
  return utcToLondonString(d.toISOString());
}

async function reset() {
  // Wipe every table and reset identity sequences so the seed always produces
  // the same ids (group 1, users 1-3, …). TRUNCATE ... CASCADE is FK-safe and
  // clears tables the tests themselves create rows in (extra groups, golf
  // scores, activity logs), so the suite is order-independent and safe to
  // re-run across every browser project.
  const { rows } = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  if (rows.length === 0) return;
  const names = rows.map((r) => `"${r.tablename}"`).join(", ");
  await pool.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
}

async function main() {
  await reset();

  const [group] = await db
    .insert(groups)
    .values({
      slug: "demo",
      name: "Demo League",
      enabledGames: ["predictions", "lms", "golf"],
      buyIn: 5,
      lmsAllOutRule: "rollover",
    })
    .returning();

  const codes = { alex: "demo-alex", blake: "demo-blake", casey: "demo-casey" };
  const [alex, blake, casey] = await db
    .insert(users)
    .values([
      { username: "Alex", password: "x", groupId: group.id, loginCode: codes.alex },
      { username: "Blake", password: "x", groupId: group.id, loginCode: codes.blake },
      { username: "Casey", password: "x", groupId: group.id, loginCode: codes.casey },
    ])
    .returning();

  const [arsenal, chelsea, liverpool, mancity, spurs, everton] = await db
    .insert(teams)
    .values([
      { name: "Arsenal", shortName: "ARS" },
      { name: "Chelsea", shortName: "CHE" },
      { name: "Liverpool", shortName: "LIV" },
      { name: "Manchester City", shortName: "MCI" },
      { name: "Tottenham", shortName: "TOT" },
      { name: "Everton", shortName: "EVE" },
    ])
    .returning();

  // GW1: already played and finished. GW2: a week out, still open.
  const gw1Time = londonAt(-2);
  const gw2Time = londonAt(7);
  const [gw1Match] = await db
    .insert(matches)
    .values({
      homeTeamId: arsenal.id, awayTeamId: chelsea.id,
      homeScore: 2, awayScore: 1, status: "finished",
      matchTime: gw1Time, matchDay: "1", matchDate: gw1Time.slice(0, 10),
      gameweek: 1, season: SEASON,
    })
    .returning();
  const [gw2Match] = await db
    .insert(matches)
    .values({
      homeTeamId: liverpool.id, awayTeamId: mancity.id,
      status: "not_started",
      matchTime: gw2Time, matchDay: "2", matchDate: gw2Time.slice(0, 10),
      gameweek: 2, season: SEASON,
    })
    .returning();

  // Lawro picks. GW1 is finished, so these score: Alex exact (3), Blake right
  // result (1), Casey wrong (0). Blake's GW2 pick is pre-deadline, so it must
  // be hidden from the others.
  await db.insert(predictions).values([
    { userId: alex.id, matchId: gw1Match.id, homeScore: 2, awayScore: 1 },
    { userId: blake.id, matchId: gw1Match.id, homeScore: 1, awayScore: 0 },
    { userId: casey.id, matchId: gw1Match.id, homeScore: 0, awayScore: 2 },
    { userId: blake.id, matchId: gw2Match.id, homeScore: 3, awayScore: 1 },
  ]);

  // LMS: active competition on GW2, all three players in. Alex already used
  // Arsenal in GW1, so re-picking Arsenal must be rejected.
  const [comp] = await db
    .insert(lmsCompetitions)
    .values({
      groupId: group.id, season: SEASON, name: "Demo Cup",
      startGameweek: 1, currentGameweek: 2, status: "active", prizeAmount: 35,
    })
    .returning();
  const [alexP, blakeP, caseyP] = await db
    .insert(lmsParticipants)
    .values([
      { competitionId: comp.id, userId: alex.id, isActive: "true" },
      { competitionId: comp.id, userId: blake.id, isActive: "true" },
      { competitionId: comp.id, userId: casey.id, isActive: "true" },
    ])
    .returning();
  await db.insert(lmsSelections).values({
    participantId: alexP.id, teamId: arsenal.id, gameweek: 1, result: "w",
  });

  // A second group Alex also belongs to, under the same personal login code, so
  // the multi-group switcher and cross-group game tabs can be exercised. Rovers
  // plays LMS + Lawro (no golf), so switching changes the visible games.
  const [rovers] = await db
    .insert(groups)
    .values({
      slug: "rovers",
      name: "Rovers",
      enabledGames: ["lms", "predictions"],
      buyIn: 10,
      lmsAllOutRule: "revive",
    })
    .returning();
  await db.insert(users).values({
    username: "Alex", password: "x", groupId: rovers.id, loginCode: codes.alex,
  });

  console.log("Seeded Demo League + Rovers. Login codes:");
  for (const [name, code] of Object.entries(codes)) {
    console.log(`  ${name.padEnd(6)} ${code}`);
  }
  void blakeP; void caseyP; void spurs; void everton;
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
