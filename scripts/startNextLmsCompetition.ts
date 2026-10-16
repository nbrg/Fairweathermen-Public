// Open the NEXT mid-season Last Man Standing competition for a group.
//
// LMS runs as back-to-back competitions within a season: when one ends (a
// single survivor, or everyone knocked out together) the next week's
// competition opens with the same roster. The server now does this
// automatically when results are processed (see server/lmsProcessor.ts →
// startNextCompetition), but a competition that finished *before* that logic
// shipped is left stranded with no successor. Run this once to roll it forward.
//
// Usage:
//   tsx scripts/startNextLmsCompetition.ts                           # list groups
//   tsx scripts/startNextLmsCompetition.ts --group 2                 # dry run
//   tsx scripts/startNextLmsCompetition.ts --group 2 --confirm       # apply
//
// Run it with NO --group first: it prints every group with its id and the state
// of its latest LMS competition, so you can see which id to target (you don't
// need to know it in advance). Then re-run with that --group.
//
// With --group it looks at the most recent competition in the group. If that
// competition is completed, it creates a new active competition starting at the
// next gameweek (currentGameweek + 1) and enrols the same roster, all active
// with no picks.
//
// Guards (mirroring the auto-start logic):
//   - refuses if an active competition already exists for the group;
//   - refuses past the final gameweek of the season (GW38);
//   - stays group-scoped so it never enrols another group's players.

import { db } from "../server/db";
import { groups } from "@shared/schema";
import { asc } from "drizzle-orm";
import { storage } from "../server/storage";

const FINAL_GAMEWEEK = 38;

const CONFIRM = process.argv.includes("--confirm");
function argVal(flag: string, fallback: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const hasGroupFlag = process.argv.includes("--group");
const GROUP_ID = Number(argVal("--group", "1"));

// No --group: list every group and its latest LMS competition so the caller can
// see which id to target. Read-only.
async function listGroups() {
  const allGroups = await db.select().from(groups).orderBy(asc(groups.id));
  console.log(`[next] Groups and their latest LMS competition:\n`);
  for (const g of allGroups) {
    const comps = await storage.getAllLmsCompetitions(g.id);
    const latest = [...comps].sort((a: any, b: any) => b.id - a.id)[0];
    if (!latest) {
      console.log(`  group ${g.id}  (${g.name} / ${g.slug}) — no LMS competitions`);
      continue;
    }
    const gw = (latest as any).current_gameweek ?? latest.currentGameweek ?? "?";
    const rollable =
      latest.status === "completed" && Number(gw) < FINAL_GAMEWEEK
        ? "  → rollable (re-run with --group " + g.id + ")"
        : latest.status === "active"
          ? "  (already has an active competition)"
          : "";
    console.log(
      `  group ${g.id}  (${g.name} / ${g.slug}) — latest "${latest.name}" ` +
        `[${latest.status}, GW${gw}]${rollable}`,
    );
  }
  console.log(
    `\n[next] To open the next competition for a group:\n` +
      `  tsx scripts/startNextLmsCompetition.ts --group <id>            # dry run\n` +
      `  tsx scripts/startNextLmsCompetition.ts --group <id> --confirm  # apply`,
  );
}

async function main() {
  if (!hasGroupFlag) {
    await listGroups();
    return;
  }

  const comps = await storage.getAllLmsCompetitions(GROUP_ID);
  if (comps.length === 0) {
    console.log(`[next] group ${GROUP_ID} has no competitions. Nothing to roll forward.`);
    return;
  }

  // Refuse if the group already has an active competition.
  const active = comps.filter((c: any) => c.status === "active");
  if (active.length > 0) {
    console.log(
      `[next] group ${GROUP_ID} already has an active competition ` +
        `(#${active[0].id}). Nothing to do.`,
    );
    return;
  }

  // Latest competition (highest id) — the one we roll forward from.
  const previous = [...comps].sort((a: any, b: any) => b.id - a.id)[0];
  const prevGw =
    previous.currentGameweek ?? (previous as any).current_gameweek ?? 0;
  const nextStartGameweek = prevGw + 1;
  const season = previous.season || "2025/2026";

  if (nextStartGameweek > FINAL_GAMEWEEK) {
    console.log(
      `[next] group ${GROUP_ID}: previous competition ended at GW${prevGw}; ` +
        `season is over (GW${nextStartGameweek} > ${FINAL_GAMEWEEK}). Nothing to do.`,
    );
    return;
  }

  // Carry the roster over from the previous competition (deduped).
  const priorParticipants = await storage.getLmsParticipantsByCompetition(previous.id);
  const roster: { userId: number; name: string }[] = [];
  const seen = new Set<number>();
  for (const p of priorParticipants) {
    if (seen.has(p.userId)) continue;
    seen.add(p.userId);
    const user = await storage.getUser(p.userId);
    roster.push({ userId: p.userId, name: user?.username || `user#${p.userId}` });
  }

  if (roster.length === 0) {
    console.log(`[next] previous competition #${previous.id} had no participants. Nothing to do.`);
    return;
  }

  const seasonCount = comps.filter((c: any) => (c.season || "2025/2026") === season).length;
  const name = `Competition ${seasonCount + 1}`;

  console.log(
    `[next] group ${GROUP_ID}: rolling from competition #${previous.id} ` +
      `(ended GW${prevGw}) into "${name}" (${season}) at GW${nextStartGameweek}.`,
  );
  console.log(`[next] roster carried over: ${roster.length} players`);
  roster.forEach((r) => console.log(`   - ${r.name} (user ${r.userId})`));

  if (!CONFIRM) {
    console.log(`[next] DRY RUN — nothing written. Re-run with --confirm to apply.`);
    return;
  }

  const comp = await storage.createLmsCompetition({
    groupId: GROUP_ID,
    season,
    name,
    startGameweek: nextStartGameweek,
    currentGameweek: nextStartGameweek,
    status: "active",
  } as any);
  console.log(`[next] created competition ${comp.id} (${season}, GW${nextStartGameweek}, active).`);

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
    `[next] enrolled ${enrolled} players. The Live tab now opens GW${nextStartGameweek} for selections.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[next] failed:", err);
    process.exit(1);
  });
