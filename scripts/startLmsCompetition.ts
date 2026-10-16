// Start a new Last Man Standing competition (season rollover).
//
// The Live tab / selection flow keys off the *current* (active, latest) LMS
// competition. After importing a new season's fixtures you still need a
// competition pointing at GW1 for people to make picks — that's what this does.
//
// Usage:
//   tsx scripts/startLmsCompetition.ts                         # dry run
//   tsx scripts/startLmsCompetition.ts --confirm               # apply
//   tsx scripts/startLmsCompetition.ts --season 2026/2027 --start-gameweek 1 --confirm
//
// On --confirm it:
//   1. Marks any currently-active competition in the group as "completed"
//      (rollover — declared winners are untouched).
//   2. Creates a new active competition for --season at --start-gameweek
//      (currentGameweek = startGameweek) so the Live tab opens that gameweek.
//   3. Enrolls the same players as the most recent prior competition, all
//      active with no selections, so they can immediately pick.
//
// Idempotent: refuses to create a second competition for the same season.

import { storage } from "../server/storage";

const CONFIRM = process.argv.includes("--confirm");
function argVal(flag: string, fallback: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const GROUP_ID = Number(argVal("--group", "1"));
const SEASON = argVal("--season", "2026/2027");
const START_GW = Number(argVal("--start-gameweek", "1"));
const NAME = argVal("--name", `${SEASON} Last Man Standing`);

async function main() {
  const comps = await storage.getAllLmsCompetitions(GROUP_ID);

  // Idempotency: never create a duplicate competition for this season.
  const existing = comps.find((c: any) => (c.season || "") === SEASON);
  if (existing) {
    console.log(
      `[start] A "${SEASON}" competition already exists (id ${existing.id}, ` +
        `status ${existing.status}). Nothing to do.`,
    );
    return;
  }

  // Carry the roster over from the most recent prior competition.
  const prior = [...comps].sort((a: any, b: any) => b.id - a.id)[0];
  const roster: { userId: number; name: string }[] = [];
  if (prior) {
    const participants = await storage.getLmsParticipantsByCompetition(prior.id);
    const seen = new Set<number>();
    for (const p of participants) {
      if (seen.has(p.userId)) continue;
      seen.add(p.userId);
      const user = await storage.getUser(p.userId);
      roster.push({ userId: p.userId, name: user?.username || `user#${p.userId}` });
    }
  }

  const activeToClose = comps.filter((c: any) => c.status === "active");

  console.log(
    `[start] group ${GROUP_ID}: new competition "${NAME}" (${SEASON}) at GW${START_GW}.`,
  );
  console.log(
    `[start] roster carried from ${prior ? `competition ${prior.id}` : "none"}: ${roster.length} players`,
  );
  roster.forEach((r) => console.log(`   - ${r.name} (user ${r.userId})`));
  if (activeToClose.length) {
    console.log(
      `[start] will mark ${activeToClose.length} active competition(s) completed: ` +
        activeToClose.map((c: any) => `#${c.id}`).join(", "),
    );
  }

  if (!CONFIRM) {
    console.log(`[start] DRY RUN — nothing written. Re-run with --confirm to apply.`);
    return;
  }

  for (const c of activeToClose) {
    await storage.updateLmsCompetition(c.id, { status: "completed" } as any);
    console.log(`[start] marked competition ${c.id} completed.`);
  }

  const comp = await storage.createLmsCompetition({
    groupId: GROUP_ID,
    season: SEASON,
    name: NAME,
    startGameweek: START_GW,
    currentGameweek: START_GW,
    status: "active",
  } as any);
  console.log(`[start] created competition ${comp.id} (${SEASON}, GW${START_GW}, active).`);

  let enrolled = 0;
  for (const r of roster) {
    await storage.createLmsParticipant({
      competitionId: comp.id,
      userId: r.userId,
      isActive: "true",
    } as any);
    enrolled += 1;
  }
  console.log(
    `[start] enrolled ${enrolled} players. The Live tab now opens GW${START_GW} for selections.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[start] failed:", err);
    process.exit(1);
  });
