// Dev/admin: backfill win/loss results for a Last Man Standing competition's
// CURRENT gameweek from fixtures that are already `finished`, then run the
// processor so the competition advances (or completes).
//
// Why this exists: an LMS competition only rolls to the next gameweek once every
// active player's pick for the current gameweek has a `result` (w/l). Those
// results are normally written by the live-score sync at the moment a match
// transitions to `finished` (server/footballDataApi.ts → updateLmsSelectionsForMatch).
// If a competition is created/randomised on a gameweek whose matches are ALREADY
// finished (e.g. a late-created comp, or a database restore), that transition
// never fires for it, the selections keep result=null, and the competition is
// stuck forever. This recomputes those results from the finished matches — same
// rule as the live sync (a draw counts as a loss) — and hands off to the normal
// processor to eliminate/advance/complete.
//
//   npx tsx scripts/backfillLmsResults.ts --group 1            # dry run (group 1)
//   npx tsx scripts/backfillLmsResults.ts --group 1 --confirm  # apply + process
//   npx tsx scripts/backfillLmsResults.ts --competition 31 --confirm
//
// Only fills results that are still null on ACTIVE participants; already-scored
// selections and unfinished/postponed fixtures are left untouched.

import { storage } from "../server/storage";
import { lmsProcessor } from "../server/lmsProcessor";
import type { LmsCompetition } from "@shared/schema";

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const GROUP = argVal("--group");
const COMP_ARG = argVal("--competition");
const CONFIRM = process.argv.includes("--confirm");

async function resolveCompetition(): Promise<LmsCompetition | undefined> {
  if (COMP_ARG) {
    const id = Number(COMP_ARG);
    return (await storage.getActiveLmsCompetitions()).find((c) => c.id === id);
  }
  return storage.getCurrentLmsCompetition(Number(GROUP ?? "1"));
}

async function main() {
  const comp = await resolveCompetition();
  if (!comp) {
    console.error(
      `No active LMS competition found for ${COMP_ARG ? `competition ${COMP_ARG}` : `group ${GROUP ?? 1}`}.`,
    );
    process.exit(1);
  }

  const gameweek = comp.currentGameweek ?? (comp as any).current_gameweek;
  console.log(
    `\nCompetition ${comp.id} (group ${comp.groupId}, season ${comp.season}) — current GW${gameweek}, status ${comp.status}\n`,
  );

  // Current-season fixtures for this gameweek, so we can score each pick.
  const seasonMatches = (await storage.getAllMatchesWithTeams(true)).filter(
    (m) => m.season === comp.season && m.gameweek === gameweek,
  );
  const isFinished = (m: (typeof seasonMatches)[number]) =>
    (m.status === "finished" || m.status === "completed") && m.homeScore != null && m.awayScore != null;

  const participants = (await storage.getLmsParticipantsByCompetition(comp.id)).filter(
    (p) => p.isActive === "true",
  );

  const updates: { selId: number; who: string; team: string; fixture: string; result: "w" | "l" }[] = [];
  const skipped: string[] = [];

  for (const p of participants) {
    const user = await storage.getUser(p.userId);
    const who = user?.username ?? `user#${p.userId}`;
    const sel = (await storage.getLmsSelectionsByParticipant(p.id)).find((s) => s.gameweek === gameweek);

    if (!sel) {
      skipped.push(`${who}: no GW${gameweek} pick`);
      continue;
    }
    if (sel.result != null) {
      skipped.push(`${who}: already ${sel.result}`);
      continue;
    }

    // Prefer the pick's own matchId; fall back to the team's fixture this GW.
    const match =
      (sel.matchId != null && seasonMatches.find((m) => m.id === sel.matchId)) ||
      seasonMatches.find((m) => m.homeTeamId === sel.teamId || m.awayTeamId === sel.teamId);

    if (!match) {
      skipped.push(`${who}: no fixture found for team ${sel.teamId}`);
      continue;
    }
    if (!isFinished(match)) {
      skipped.push(`${who}: ${match.homeTeam.name} v ${match.awayTeam.name} not finished (${match.status})`);
      continue;
    }

    const isHome = match.homeTeamId === sel.teamId;
    const gf = (isHome ? match.homeScore : match.awayScore) as number;
    const ga = (isHome ? match.awayScore : match.homeScore) as number;
    const result: "w" | "l" = gf > ga ? "w" : "l"; // draw counts as a loss (same as the live sync)
    const team = isHome ? match.homeTeam.name : match.awayTeam.name;

    updates.push({
      selId: sel.id,
      who,
      team,
      fixture: `${match.homeTeam.name} ${match.homeScore}-${match.awayScore} ${match.awayTeam.name}`,
      result,
    });
  }

  console.log(`Results to backfill for GW${gameweek}:`);
  if (updates.length === 0) console.log("  (none)");
  for (const u of updates) {
    console.log(`  ${u.who.padEnd(12)} picked ${u.team.padEnd(18)} → ${u.result.toUpperCase()}   [${u.fixture}]`);
  }
  if (skipped.length) {
    console.log(`\nSkipped:`);
    for (const s of skipped) console.log(`  ${s}`);
  }

  if (!CONFIRM) {
    console.log(`\nDry run — re-run with --confirm to write these results and process the competition.\n`);
    process.exit(0);
  }

  for (const u of updates) await storage.updateLmsSelection(u.selId, { result: u.result });
  console.log(`\nWrote ${updates.length} result(s). Running the processor...`);

  await lmsProcessor.processLmsResults(comp);

  // Report the resulting state (the processor may have advanced or completed it,
  // and started the next competition).
  const after = await storage.getCurrentLmsCompetition(comp.groupId);
  if (after) {
    console.log(
      `\nDone. Group ${comp.groupId} active competition is now id=${after.id}, GW${after.currentGameweek}, status ${after.status}.\n`,
    );
  } else {
    console.log(`\nDone. No active competition for group ${comp.groupId} now (it may have completed).\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfillLmsResults] failed:", err);
    process.exit(1);
  });
