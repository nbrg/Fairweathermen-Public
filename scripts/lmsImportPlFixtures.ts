// Import a full Premier League season's fixtures from football-data into the
// `matches` table (the LMS Fixtures tab reads these).
//
// Non-destructive: each fixture is tagged with its `season` (e.g. "2026/2027").
// On --confirm it tags any untagged legacy fixtures as the previous season (kept
// as history), replaces ONLY the season being imported, and inserts the new one.
// Old seasons stay in the DB; the storage readers scope to the latest season, so
// the live game + Fixtures tab only ever see the current one.
//
// matchTime is stored as a London-local "YYYY-MM-DD HH:MM:SS" string to match
// the existing convention (see londonStringToUtcMs / routes.ts).
//
// Usage (run on a dev DB first and check the Fixtures tab):
//   tsx scripts/lmsImportPlFixtures.ts                            # dry run, no DB writes
//   tsx scripts/lmsImportPlFixtures.ts --confirm                 # import 2026/27 (season 2026)
//   tsx scripts/lmsImportPlFixtures.ts --confirm --season 2025   # a different season
//   tsx scripts/lmsImportPlFixtures.ts --confirm --previous-season 2025/2026

import { storage } from "../server/storage";
import { db } from "../server/db";
import { sql } from "drizzle-orm";

// Some rows were seeded with explicit ids historically, leaving the id sequence
// behind max(id); the next serial insert then collides (duplicate key). Realign
// the sequence to max(id) so fresh inserts get unused ids.
async function resyncIdSequence(table: "teams" | "matches") {
  await db.execute(sql`
    SELECT setval(
      pg_get_serial_sequence(${table}, 'id'),
      (SELECT COALESCE(MAX(id), 1) FROM ${sql.identifier(table)}),
      (SELECT COUNT(*) > 0 FROM ${sql.identifier(table)})
    )
  `);
}

const API_BASE = "https://api.football-data.org/v4";
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const CONFIRM = process.argv.includes("--confirm");
const SEASON = (() => {
  const i = process.argv.indexOf("--season");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "2026";
})();
// Season label stored on each fixture, e.g. 2026 → "2026/2027".
const SEASON_LABEL = `${SEASON}/${Number(SEASON) + 1}`;
// Legacy fixtures with no season set are tagged with this (the season they're
// from) so they're kept as history but excluded from the current season.
const PREVIOUS_SEASON = (() => {
  const i = process.argv.indexOf("--previous-season");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "2025/2026";
})();

// Loose match on team name (ignoring "FC"/punctuation) as a fallback to the tla.
function normalize(s: string): string {
  return s.toLowerCase().replace(/\bfc\b/g, "").replace(/[^a-z0-9]/g, "");
}
function cleanName(fdName: string): string {
  return fdName.replace(/\s+(?:FC|AFC)$/i, "").trim();
}
// UTC ISO → London-local { date: "YYYY-MM-DD", dateTime: "YYYY-MM-DD HH:MM:SS" }.
function toLondon(iso: string): { date: string; dateTime: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  let hh = g("hour");
  if (hh === "24") hh = "00"; // en-GB renders midnight as 24
  const date = `${g("year")}-${g("month")}-${g("day")}`;
  return { date, dateTime: `${date} ${hh}:${g("minute")}:${g("second")}` };
}

async function main() {
  if (!API_KEY) {
    console.error("[import] FOOTBALL_DATA_API_KEY not set");
    process.exit(1);
  }

  const res = await fetch(`${API_BASE}/competitions/PL/matches?season=${SEASON}`, {
    headers: { "X-Auth-Token": API_KEY },
  });
  if (!res.ok) {
    console.error(`[import] football-data ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data: any = await res.json();
  const fdMatches: any[] = data.matches ?? [];
  console.log(
    `[import] PL season ${SEASON}: ${fdMatches.length} fixtures ` +
      `(${data.resultSet?.first} → ${data.resultSet?.last})`,
  );
  if (fdMatches.length === 0) {
    console.error("[import] No fixtures returned — aborting.");
    process.exit(1);
  }

  // Local team lookup by tla and by normalised name.
  const localTeams = await storage.getAllTeams();
  const byTla = new Map<string, number>();
  const byNorm = new Map<string, number>();
  for (const t of localTeams) {
    byTla.set(t.shortName.toUpperCase(), t.id);
    byNorm.set(normalize(t.name), t.id);
  }

  // Distinct teams featuring in this season.
  const fdTeams = new Map<number, { name: string; tla: string }>();
  for (const m of fdMatches) {
    for (const side of [m.homeTeam, m.awayTeam]) {
      if (side?.id) fdTeams.set(side.id, { name: side.name ?? "", tla: side.tla ?? "" });
    }
  }

  // Resolve each FD team to a local id, creating any that are missing (promoted).
  if (CONFIRM) await resyncIdSequence("teams");
  const localIdByFd = new Map<number, number>();
  const created: string[] = [];
  for (const [fdId, t] of Array.from(fdTeams.entries())) {
    const tla = t.tla.toUpperCase();
    let localId = (tla && byTla.get(tla)) || byNorm.get(normalize(t.name));
    if (!localId) {
      created.push(`${cleanName(t.name)} (${tla || "?"})`);
      if (CONFIRM) {
        const team = await storage.createTeam({
          name: cleanName(t.name),
          shortName: tla || cleanName(t.name).slice(0, 3).toUpperCase(),
        });
        localId = team.id;
        if (tla) byTla.set(tla, localId);
        byNorm.set(normalize(t.name), localId);
      } else {
        localId = -1; // placeholder for dry run
      }
    }
    localIdByFd.set(fdId, localId);
  }
  console.log(
    `[import] teams: ${fdTeams.size} in season; ${created.length} new → ${created.join(", ") || "none"}`,
  );

  if (!CONFIRM) {
    console.log(
      `[import] DRY RUN — nothing written. Re-run with --confirm to import as season "${SEASON_LABEL}".`,
    );
    console.log(
      `[import] On --confirm: tag any untagged fixtures as "${PREVIOUS_SEASON}" (kept as history), ` +
        `replace only "${SEASON_LABEL}", and insert ${fdMatches.length}.`,
    );
    for (const m of fdMatches.slice(0, 4)) {
      console.log(
        `   GW${m.matchday}: ${m.homeTeam?.tla} v ${m.awayTeam?.tla} @ ${toLondon(m.utcDate).dateTime}`,
      );
    }
    process.exit(0);
  }

  // Preserve old fixtures: tag any untagged ones with the previous season so
  // they survive as history (the readers exclude non-current seasons).
  const tagged = await storage.backfillNullSeasons(PREVIOUS_SEASON);
  console.log(`[import] tagged ${tagged} untagged fixtures as "${PREVIOUS_SEASON}" (history).`);

  // Replace only this season's fixtures (idempotent re-import); other seasons untouched.
  const removed = await storage.deleteMatchesBySeason(SEASON_LABEL);
  console.log(`[import] removed ${removed} existing "${SEASON_LABEL}" fixtures.`);

  await resyncIdSequence("matches");
  let inserted = 0;
  let skipped = 0;
  for (const m of fdMatches) {
    const homeFd = m.homeTeam?.id;
    const awayFd = m.awayTeam?.id;
    const gw = m.matchday;
    const homeId = homeFd ? localIdByFd.get(homeFd) : undefined;
    const awayId = awayFd ? localIdByFd.get(awayFd) : undefined;
    if (!homeId || !awayId || homeId < 0 || awayId < 0 || !gw) {
      skipped += 1;
      continue;
    }
    const { date, dateTime } = toLondon(m.utcDate);
    await storage.createMatch({
      homeTeamId: homeId,
      awayTeamId: awayId,
      matchTime: dateTime,
      matchDay: String(gw),
      matchDate: date,
      gameweek: gw,
      status: "not_started",
      season: SEASON_LABEL,
    });
    inserted += 1;
  }
  console.log(
    `[import] done: inserted ${inserted} "${SEASON_LABEL}" fixtures, skipped ${skipped}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[import] failed:", err);
    process.exit(1);
  });
