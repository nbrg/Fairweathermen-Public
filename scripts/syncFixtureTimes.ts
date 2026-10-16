// Pull authentic kickoff times for the current season's fixtures from
// football-data.org and write them to the matches table. Use this to correct
// fixtures that were imported/seeded with placeholder times (e.g. a whole
// gameweek showing 15:00). Times only — scores/results are left untouched.
//
// IMPORTANT: the Premier League only confirms exact kick-off times a few
// gameweeks ahead. Beyond that, football-data serves a whole round at one
// provisional time (e.g. every match 15:00, or 20:00 for a midweek round), with
// status SCHEDULED rather than TIMED. Syncing those just copies the placeholder,
// so prefer syncing only the near, confirmed weeks (say the next ~8) and let the
// hourly background job pick up later weeks as their times firm up. Use --debug
// first to see what football-data actually has for a gameweek.
//
//   npx tsx scripts/syncFixtureTimes.ts --from 2 --to 2 --debug    # inspect only
//   npx tsx scripts/syncFixtureTimes.ts --from 2 --to 8 --confirm  # apply a range
//   npx tsx scripts/syncFixtureTimes.ts --from 2 --to 6            # dry run
//
// Idempotent: syncGameweek only writes a row when the fetched time differs.
// Rate-limited to stay within the football-data budget.

import { syncGameweek, fetchMatchesByGameweek } from "../server/footballDataApi";
import { storage } from "../server/storage";
import { utcToLondonString } from "@shared/time";

const CONFIRM = process.argv.includes("--confirm");
const DEBUG = process.argv.includes("--debug");
function intArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? parseInt(process.argv[i + 1] ?? "", 10) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

const FROM = intArg("--from", 1);
const TO = intArg("--to", 38);

async function debugGameweek(gw: number) {
  const teams = await storage.getAllTeams();
  const name = new Map(teams.map((t) => [t.id, t.shortName]));
  const local = (await storage.getAllMatches()).filter((m) => m.gameweek === gw);
  const fd = await fetchMatchesByGameweek(gw);

  console.log(`\n=== GW${gw} — football-data (${fd.length} fixtures) ===`);
  for (const m of fd) {
    console.log(`   ${(m.homeTeam.tla ?? "?").padEnd(4)} v ${(m.awayTeam.tla ?? "?").padEnd(4)}  ${utcToLondonString(m.utcDate)}  [${m.status}]`);
  }
  const timesSet = new Set(fd.map((m) => utcToLondonString(m.utcDate).slice(11)));
  const statuses = new Set(fd.map((m) => m.status));
  console.log(`   → distinct kickoff times: ${[...timesSet].join(", ") || "none"}`);
  console.log(`   → statuses: ${[...statuses].join(", ")}  ${statuses.has("SCHEDULED") && timesSet.size <= 1 ? "(provisional — exact times not confirmed yet)" : ""}`);

  console.log(`=== GW${gw} — stored locally (${local.length} fixtures) ===`);
  for (const m of local) {
    console.log(`   ${(name.get(m.homeTeamId!) ?? m.homeTeamId).toString().padEnd(4)} v ${(name.get(m.awayTeamId!) ?? m.awayTeamId).toString().padEnd(4)}  ${m.matchTime}  [${m.status}]`);
  }
}

async function main() {
  if (DEBUG) {
    for (let gw = FROM; gw <= TO; gw++) {
      await debugGameweek(gw);
      await new Promise((res) => setTimeout(res, 4000));
    }
    return;
  }

  console.log(`[sync-times] Gameweeks ${FROM}–${TO}, times only.${CONFIRM ? "" : " DRY RUN — pass --confirm to apply."}`);
  let totalUpdated = 0;
  for (let gw = FROM; gw <= TO; gw++) {
    if (!CONFIRM) {
      console.log(`   GW${gw}: would sync kickoff times`);
      continue;
    }
    try {
      const r = await syncGameweek(gw, { updateTimes: true, updateScores: false });
      totalUpdated += r.matchesUpdated;
      console.log(`   GW${gw}: ${r.matchesUpdated} fixture time(s) updated`);
    } catch (e: any) {
      console.error(`   GW${gw}: failed — ${e?.message || e}`);
    }
    // Stay under ~20 calls/min.
    await new Promise((res) => setTimeout(res, 4000));
  }
  if (CONFIRM) console.log(`[sync-times] Done — ${totalUpdated} fixture time(s) updated.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[sync-times] failed:", err);
    process.exit(1);
  });
