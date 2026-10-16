// Dev-only: seed some completed 2025/2026 LMS history into the Rovers group (which
// Jordan belongs to), so the History view can be previewed with real-looking
// data. Uses Rovers's existing players and real 2025/2026 fixtures so crests and
// opponents/venues resolve. Two completed competitions, 5+ players and 5+
// gameweeks each — one with a single winner, one with co-winners.
//
//   npx tsx scripts/seedJordanLmsHistory.ts            # dry run — prints the plan
//   npx tsx scripts/seedJordanLmsHistory.ts --confirm  # apply to the DB (DATABASE_URL)
//
// Idempotent: re-running replaces only the competitions it seeded (matched by
// name prefix) — it never touches Rovers's real competitions. Run against DEV.

import { db } from "../server/db";
import { groups, lmsCompetitions, lmsParticipants, lmsSelections, lmsSelectionLogs } from "@shared/schema";
import { storage } from "../server/storage";
import { and, eq, inArray, like } from "drizzle-orm";

const CONFIRM = process.argv.includes("--confirm");
const SEASON = "2025/2026";
const SEED_PREFIX = "Preview Competition"; // marker so we only ever touch our own seed data

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function findRun(fullGws: number[], len: number, minStart: number): number | null {
  const set = new Set(fullGws);
  for (let s = minStart; s <= 38 - len + 1; s++) {
    if (Array.from({ length: len }, (_, k) => s + k).every((g) => set.has(g))) return s;
  }
  return null;
}

async function resolveFordGroup(): Promise<{ id: number; name: string }> {
  const all = await db.select().from(groups);
  const rovers =
    all.find((g) => g.slug.toLowerCase() === "rovers") ??
    all.find((g) => g.name.toLowerCase() === "rovers") ??
    all.find((g) => g.name.toLowerCase().includes("rovers"));
  if (!rovers) {
    console.error(`[seed] Could not find the Rovers group. Groups: ${all.map((g) => `${g.name} (${g.slug})`).join(", ")}`);
    process.exit(1);
  }
  return { id: rovers.id, name: rovers.name };
}

async function clearExisting(groupId: number) {
  const comps = await db
    .select({ id: lmsCompetitions.id })
    .from(lmsCompetitions)
    .where(and(eq(lmsCompetitions.groupId, groupId), like(lmsCompetitions.name, `${SEED_PREFIX}%`)));
  const ids = comps.map((c) => c.id);
  if (ids.length === 0) return;
  const parts = await db.select({ id: lmsParticipants.id }).from(lmsParticipants).where(inArray(lmsParticipants.competitionId, ids));
  const partIds = parts.map((p) => p.id);
  if (partIds.length) {
    await db.delete(lmsSelections).where(inArray(lmsSelections.participantId, partIds));
    await db.delete(lmsSelectionLogs).where(inArray(lmsSelectionLogs.participantId, partIds));
    await db.delete(lmsParticipants).where(inArray(lmsParticipants.id, partIds));
  }
  await db.delete(lmsCompetitions).where(inArray(lmsCompetitions.id, ids));
  console.log(`[seed] cleared ${ids.length} previously-seeded competition(s)`);
}

async function main() {
  const rovers = await resolveFordGroup();

  // Rovers's players, with Jordan first so he's always in (and prominent).
  const fordUsers = (await storage.getAllUsers()).filter((u) => u.groupId === rovers.id);
  const roster = [
    ...fordUsers.filter((u) => u.username.toLowerCase() === "jordan"),
    ...fordUsers.filter((u) => u.username.toLowerCase() !== "jordan"),
  ];
  if (roster.length < 6) {
    console.error(`[seed] Rovers has only ${roster.length} players; need at least 6 for a 5+ week competition.`);
    process.exit(1);
  }

  // 2025/2026 fixtures → team + matchId per gameweek.
  const seasonMatches = (await storage.getAllMatchesWithTeams(true)).filter((m) => (m as any).season === SEASON);
  const byGw = new Map<number, Map<number, number>>(); // gw -> (teamId -> matchId)
  for (const m of seasonMatches) {
    if (m.gameweek == null) continue;
    const tm = byGw.get(m.gameweek) ?? new Map<number, number>();
    if (m.homeTeamId != null && !tm.has(m.homeTeamId)) tm.set(m.homeTeamId, m.id);
    if (m.awayTeamId != null && !tm.has(m.awayTeamId)) tm.set(m.awayTeamId, m.id);
    byGw.set(m.gameweek, tm);
  }
  const fullGws = Array.from(byGw.entries())
    .filter(([, tm]) => tm.size >= 16)
    .map(([gw]) => gw)
    .sort((a, b) => a - b);

  // Comp A: single winner. Comp B: co-winners. One elimination per week (final
  // week takes the last two for co-winners) → weeks = rosterSize - 1, so 5+.
  const rosterA = Math.min(8, roster.length);
  const rosterB = Math.min(6, roster.length);
  const elimsA = Array(rosterA - 1).fill(1); // ends with 1 winner
  const elimsB = [...Array(rosterB - 2).fill(1), 2]; // final week eliminates the last two together

  const startA = findRun(fullGws, elimsA.length, fullGws[0]);
  const startB = findRun(fullGws, elimsB.length, (startA ?? fullGws[0]) + elimsA.length);
  if (startA == null || startB == null) {
    console.error(`[seed] Not enough contiguous 2025/2026 gameweeks. Full weeks: ${fullGws.join(", ")}`);
    process.exit(1);
  }

  const configs = [
    { name: `${SEED_PREFIX} 1`, startGw: startA, elimsByWeek: elimsA, roster: rosterA, coWinners: false },
    { name: `${SEED_PREFIX} 2`, startGw: startB, elimsByWeek: elimsB, roster: rosterB, coWinners: true },
  ];

  console.log(`[seed] group "${rovers.name}" (id ${rovers.id}), season ${SEASON}, ${roster.length} players available`);
  for (const c of configs) {
    console.log(`   - ${c.name}: ${c.roster} players, GW${c.startGw}-${c.startGw + c.elimsByWeek.length - 1}${c.coWinners ? " (co-winners)" : ""}`);
  }
  if (!CONFIRM) {
    console.log("[seed] DRY RUN — re-run with --confirm to apply.");
    return;
  }

  await clearExisting(rovers.id);

  for (const cfg of configs) {
    const weeks = cfg.elimsByWeek.length;
    const comp = await storage.createLmsCompetition({
      groupId: rovers.id,
      season: SEASON,
      name: cfg.name,
      startGameweek: cfg.startGw,
      currentGameweek: cfg.startGw + weeks - 1,
      status: "active",
      prizeAmount: 35,
    } as any);

    const parts = [] as { partId: number; userId: number; username: string; used: Set<number> }[];
    for (const p of roster.slice(0, cfg.roster)) {
      const part = await storage.createLmsParticipant({ competitionId: comp.id, userId: p.id, isActive: "true" } as any);
      parts.push({ partId: part.id, userId: p.id, username: p.username, used: new Set<number>() });
    }

    let active = [...parts];
    let finalLosers: typeof parts = [];
    for (let w = 0; w < weeks; w++) {
      const gw = cfg.startGw + w;
      const teamMatch = byGw.get(gw)!;
      const teamsThisWeek = Array.from(teamMatch.keys());
      const isFinal = w === weeks - 1;
      const keepMin = cfg.coWinners && isFinal ? 0 : 1;
      const elim = Math.min(cfg.elimsByWeek[w], Math.max(0, active.length - keepMin));
      const eliminated = shuffle(active).slice(0, elim);
      const elimSet = new Set(eliminated.map((x) => x.userId));

      for (const a of active) {
        const options = teamsThisWeek.filter((t) => !a.used.has(t));
        const teamId = options[Math.floor(Math.random() * options.length)] ?? teamsThisWeek[0];
        a.used.add(teamId);
        await storage.createLmsSelection({
          participantId: a.partId,
          gameweek: gw,
          teamId,
          matchId: teamMatch.get(teamId) ?? null,
          result: elimSet.has(a.userId) ? "l" : "w",
          isRandomlyAssigned: "false",
        } as any);
      }
      for (const e of eliminated) {
        await storage.updateLmsParticipant(e.partId, { isActive: "false", eliminatedInRound: gw } as any);
      }
      if (isFinal) finalLosers = eliminated;
      active = active.filter((a) => !elimSet.has(a.userId));
    }

    if (cfg.coWinners) {
      const [a, b] = finalLosers;
      await storage.updateLmsCompetition(comp.id, { status: "completed", winnerId: a?.userId ?? null, coWinnerId: b?.userId ?? null } as any);
      console.log(`[seed] ${cfg.name}: co-winners ${a?.username} & ${b?.username}`);
    } else {
      const winner = active[0];
      await storage.updateLmsCompetition(comp.id, { status: "completed", winnerId: winner?.userId ?? null } as any);
      console.log(`[seed] ${cfg.name}: winner ${winner?.username}`);
    }
  }

  const jordan = roster.find((u) => u.username.toLowerCase() === "jordan");
  console.log(`\n[seed] Done. View it in the Rovers group (History tab, season ${SEASON}).`);
  if (jordan?.loginCode) console.log(`[seed] Jordan's login code: ${jordan.loginCode}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  });
