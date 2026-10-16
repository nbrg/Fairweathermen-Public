// Read-only diagnostic for "live scores aren't updating" and "the LMS randomiser
// hasn't run". Prints exactly the state the background processor
// (server/autoLmsProcessor.ts) and the live-score sync
// (server/footballDataApi.ts) look at, so we can see WHY they're no-oping.
//
// It writes nothing — safe to run against prod.
//
//   npx tsx scripts/diagnoseLive.ts            # diagnose group 1 (Fairweathermen)
//   npx tsx scripts/diagnoseLive.ts --group 2  # a different group
//
// What to look for in the output is called out inline with «hints».

import { db } from "../server/db";
import { matches } from "@shared/schema";
import { storage } from "../server/storage";
import { getLiveOrImminentGameweeks } from "../server/footballDataApi";
import { londonStringToUtcMs } from "@shared/time";

function argVal(flag: string, fallback: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const GROUP_ID = Number(argVal("--group", "1"));

// Mirror of storage.filterToCurrentSeason (that function isn't exported).
function pickCurrentSeason(seasons: (string | null)[]): string | null {
  const named = seasons.filter((s): s is string => !!s);
  if (named.length === 0) return null;
  return named.sort()[named.length - 1];
}

// Mirror of autoLmsProcessor.isGameweekLocked — including its timezone hack —
// so we see the same true/false the randomiser gate sees. Operates on the
// season-scoped matches (storage.getAllMatches), like the real one.
function isGameweekLockedFromMatches(seasonScoped: any[], gameweek: number): boolean {
  const gwMatches = seasonScoped.filter((m) => m.gameweek === gameweek);
  if (gwMatches.length === 0) return false;
  const earliest = gwMatches.reduce((e, c) =>
    new Date(c.matchTime).getTime() < new Date(e.matchTime).getTime() ? c : e,
  );
  const nowLondon = new Date().toLocaleString("en-US", { timeZone: "Europe/London" });
  const now = new Date(nowLondon);
  return now >= new Date(earliest.matchTime);
}

async function main() {
  const line = () => console.log("─".repeat(72));
  console.log(`\n=== Live/LMS diagnostic — group ${GROUP_ID} — ${new Date().toISOString()} ===`);

  // 1. Season filtering ----------------------------------------------------
  line();
  console.log("[1] SEASON FILTER (drives storage.getAllMatches → both features)");
  const rawMatches = await db.select().from(matches);
  const seasonCounts = new Map<string, number>();
  for (const m of rawMatches) {
    const key = m.season == null ? "<null>" : m.season === "" ? "<empty>" : m.season;
    seasonCounts.set(key, (seasonCounts.get(key) ?? 0) + 1);
  }
  const chosen = pickCurrentSeason(rawMatches.map((m) => m.season));
  console.log(`   total match rows: ${rawMatches.length}`);
  console.log(`   distinct season values (rows):`);
  for (const [s, n] of [...seasonCounts.entries()].sort()) {
    const mark = s === chosen ? "  ← selected as CURRENT" : "";
    console.log(`      ${JSON.stringify(s)}: ${n}${mark}`);
  }
  console.log(`   filterToCurrentSeason picks: ${JSON.stringify(chosen)}`);
  console.log(
    `   «hint» If the current season's fixtures are under a value that ISN'T the one\n` +
    `          selected (e.g. null/empty, or "2026/27" sorts AFTER "2026/2027"),\n` +
    `          getAllMatches() hides them and BOTH features go dark.`,
  );

  // storage.getAllMatches() applies the real filter — this is the source both use.
  const seasonScoped = await storage.getAllMatches();
  console.log(`   storage.getAllMatches() returns ${seasonScoped.length} rows (season-scoped)`);

  // 2. The LMS competition -------------------------------------------------
  line();
  console.log("[2] CURRENT LMS COMPETITION");
  const compForGroup = await storage.getCurrentLmsCompetition(GROUP_ID);
  const compNoArg = await storage.getCurrentLmsCompetition(); // what the processor actually uses
  if (!compForGroup) {
    console.log(`   No active competition for group ${GROUP_ID}.`);
  } else {
    console.log(
      `   group ${GROUP_ID} active comp: id=${compForGroup.id} season=${JSON.stringify(compForGroup.season)} ` +
      `startGW=${compForGroup.startGameweek} currentGW=${compForGroup.currentGameweek} status=${compForGroup.status}`,
    );
  }
  console.log(
    `   getCurrentLmsCompetition() [no group arg, what the processor uses]:\n` +
    `      id=${compNoArg?.id} groupId=${compNoArg?.groupId} currentGW=${compNoArg?.currentGameweek}`,
  );
  if (compNoArg && compForGroup && compNoArg.id !== compForGroup.id) {
    console.log(
      `   «hint» ⚠ The processor's no-arg lookup returns a DIFFERENT competition\n` +
      `          (group ${compNoArg.groupId}), so the randomiser is operating on that\n` +
      `          group, not group ${GROUP_ID}.`,
    );
  }

  // 3. This gameweek's matches --------------------------------------------
  line();
  const comp = compForGroup ?? compNoArg;
  const gw = comp?.currentGameweek;
  console.log(`[3] MATCHES FOR currentGW=${gw} (season-scoped view)`);
  if (gw != null) {
    const gwMatches = seasonScoped
      .filter((m) => m.gameweek === gw)
      .sort((a, b) => (londonStringToUtcMs(a.matchTime) || 0) - (londonStringToUtcMs(b.matchTime) || 0));
    if (gwMatches.length === 0) {
      console.log(`   ⚠ NONE — getAllMatches() has no GW${gw} rows. isGameweekLocked → false,`);
      console.log(`     randomiser never fires, and this GW can't enter the live-sync window.`);
    }
    const nowMs = Date.now();
    for (const m of gwMatches) {
      const kickMs = londonStringToUtcMs(m.matchTime);
      const mins = Number.isNaN(kickMs) ? "NaN" : Math.round((nowMs - kickMs) / 60000);
      console.log(
        `   #${m.id} home=${m.homeTeamId} away=${m.awayTeamId} time=${JSON.stringify(m.matchTime)} ` +
        `status=${m.status} score=${m.homeScore ?? "–"}-${m.awayScore ?? "–"} (kickoff ${mins} min ago)`,
      );
    }
    console.log(`   isGameweekLocked(GW${gw}) → ${isGameweekLockedFromMatches(seasonScoped, gw)}`);
    console.log(`   «hint» Randomiser only runs when this is TRUE. A parseable matchTime and a`);
    console.log(`          kickoff in the past are required.`);
  }

  // 4. Live-sync window ----------------------------------------------------
  line();
  console.log("[4] LIVE-SYNC WINDOW (getLiveOrImminentGameweeks)");
  const liveGWs = await getLiveOrImminentGameweeks();
  console.log(`   returns: [${liveGWs.join(", ") || "<empty>"}]`);
  console.log(
    `   «hint» If empty (or missing GW${gw}), syncGameweek never runs → the match never\n` +
    `          flips to in_progress on the server → the client never starts polling.\n` +
    `          A match is included only if status='not_started' with matchTime in\n` +
    `          [kickoff-15min, kickoff+7d], or status already 'in_progress'.`,
  );
  console.log(`   FOOTBALL_DATA_API_KEY set: ${!!process.env.FOOTBALL_DATA_API_KEY} (needed for scores, not for the randomiser)`);

  // 5. Participants ---------------------------------------------------------
  line();
  console.log("[5] PARTICIPANTS & SELECTIONS for currentGW");
  if (comp) {
    const participants = await storage.getLmsParticipantsByCompetition(comp.id);
    console.log(`   competition ${comp.id}: ${participants.length} participant rows`);
    for (const p of participants) {
      const user = await storage.getUser(p.userId);
      const sels = await storage.getLmsSelectionsByParticipant(p.id);
      const thisGw = sels.find((s) => s.gameweek === gw);
      const pick = thisGw
        ? `team ${thisGw.teamId}${thisGw.isRandomlyAssigned === "true" ? " (random)" : ""}`
        : "— none —";
      console.log(
        `   ${(user?.username ?? `user#${p.userId}`).padEnd(12)} partId=${p.id} ` +
        `isActive=${p.isActive} GW${gw} pick: ${pick}`,
      );
    }
    console.log(`   «hint» The randomiser only assigns to participants with isActive='true' and`);
    console.log(`          no pick for the gameweek. Anyone shown as inactive is skipped.`);
  }

  line();
  console.log("Done. Paste this output back to continue diagnosis.\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[diagnose] failed:", err);
    process.exit(1);
  });
