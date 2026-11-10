// Dev-only: simulate players missing a Last Man Standing deadline, so you can
// watch the randomiser wheel pop up (countdown, the 90-second push, then each
// missed player's wheel spinning in turn) on your dev server.
//
//   npx tsx scripts/simulateLmsWheel.ts start --players 1          # one player per group misses
//   npx tsx scripts/simulateLmsWheel.ts start --players 2          # two players per group miss
//   npx tsx scripts/simulateLmsWheel.ts start --players 1 --group rovers --deadline-in 45
//   npx tsx scripts/simulateLmsWheel.ts status                     # what's set up right now
//   npx tsx scripts/simulateLmsWheel.ts reset                      # put everything back
//
// Fixtures are shared by every group, so moving a gameweek's deadline moves it
// for every group playing LMS on that gameweek. `start` therefore sets up every
// group whose running competition is on the gameweek (or just --group's):
//   - the first N active players with a team left lose their pick, so they miss;
//   - every other active player without a pick gets a temporary one, so only
//     those N get a wheel;
//   - the group's missed-pick rule is switched to "random" if it isn't already;
// then moves the gameweek's kick-offs so the LMS deadline is --deadline-in
// seconds away (default 30), with its matches back to not started, and tells
// the running dev server to re-read its cached kick-off schedule.
//
// Keep the app open as anyone in one of those groups: when the deadline passes
// the wheel pops up over the page with a countdown, the push goes out 90
// seconds later (if VAPID keys are set and you've turned notifications on), the
// wheels spin from 3 minutes after the deadline, one at a time, and the pop-up
// closes itself once the last one has landed.
//
// Everything it changes is snapshotted to scripts/.sim-lms-wheel.json; `reset`
// restores the matches, picks and rules, deletes the random picks the
// simulation produced (in any group), and removes the file. DEV database only
// (DATABASE_URL); it refuses to run in production. If the dev server has a
// football-data key, its live-score sync can overwrite the matches once the
// gameweek looks live, so run the server without FOOTBALL_DATA_API_KEY.

import fs from "fs";
import path from "path";
import { db } from "../server/db";
import {
  groups,
  lmsCompetitions,
  lmsParticipants,
  lmsSelections,
  matches,
  reminderSends,
  users,
  resolveGroupRules,
  type LmsSelection,
} from "@shared/schema";
import { and, eq, gte, inArray } from "drizzle-orm";
import { utcToLondonString, londonStringToUtcMs } from "@shared/time";
import { WHEEL_PUSH_DELAY_MS, WHEEL_SPIN_DELAY_MS, WHEEL_SLOT_MS, ukClock } from "@shared/lmsWheel";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run in production: this script rewrites match times and LMS picks.");
  process.exit(1);
}

// Resolved from the working directory (run it from the repo root, as above).
const BACKUP = path.resolve(process.cwd(), "scripts", ".sim-lms-wheel.json");
const argVal = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

type MatchRow = typeof matches.$inferSelect;
type GroupBackup = {
  groupId: number;
  groupName: string;
  competitionId: number;
  rules: unknown;
  rulesChanged: boolean;
  missedParticipantIds: number[];
  removedSelections: LmsSelection[];
  tempSelectionIds: number[];
};
type Backup = {
  startedAt: string;
  gameweek: number;
  matches: Pick<MatchRow, "id" | "status" | "homeScore" | "awayScore" | "minute" | "matchTime">[];
  groups: GroupBackup[];
};

async function refreshServer() {
  const port = process.env.PORT || 5000;
  const key = process.env.ADMIN_API_KEY;
  try {
    const res = await fetch(`http://localhost:${port}/api/admin/schedule/refresh`, {
      method: "POST",
      headers: key ? { "x-api-key": key } : {},
    });
    if (res.ok) {
      console.log("✓ Dev server re-read its kick-off schedule.");
      return;
    }
    console.warn(`! Couldn't refresh the dev server's schedule (HTTP ${res.status}; is ADMIN_API_KEY set in this shell?).`);
  } catch {
    console.warn(`! Couldn't reach a dev server on port ${port}.`);
  }
  console.warn("  The wheel still appears for anyone with the app open, but restart the dev server so the");
  console.warn("  background jobs (missed-pick draw without the page open, and the push) see the new times.");
}

// The current season's fixtures for a gameweek, earliest first.
async function seasonGameweek(gameweek: number): Promise<MatchRow[]> {
  const all = await db.select().from(matches);
  const seasons = all.map((m) => m.season).filter((s): s is string => !!s).sort();
  const season = seasons[seasons.length - 1];
  return all
    .filter((m) => m.gameweek === gameweek && (!season || m.season === season))
    .sort((a, b) => londonStringToUtcMs(a.matchTime) - londonStringToUtcMs(b.matchTime) || a.id - b.id);
}

async function start() {
  if (fs.existsSync(BACKUP)) {
    console.error(`A simulation is already set up (${BACKUP}). Run "reset" first.`);
    process.exit(1);
  }
  const wanted = Math.max(1, Number(argVal("--players") ?? 1) || 1);
  const deadlineInSec = Math.max(5, Number(argVal("--deadline-in") ?? 30) || 30);
  const slug = argVal("--group");

  // Every group's running competition (or just --group's).
  const allGroups = await db.select().from(groups);
  const chosen = slug ? allGroups.filter((g) => g.slug === slug) : allGroups;
  if (slug && chosen.length === 0) {
    throw new Error(`No group with slug "${slug}". Slugs: ${allGroups.map((g) => g.slug).join(", ")}`);
  }
  const running = [];
  for (const g of chosen) {
    if (!((g.enabledGames as string[] | null) ?? []).includes("lms")) continue;
    const comps = await db
      .select()
      .from(lmsCompetitions)
      .where(and(eq(lmsCompetitions.groupId, g.id), eq(lmsCompetitions.status, "active")));
    const c = comps.sort((a, b) => b.id - a.id)[0];
    if (c) running.push({ group: g, competition: c });
  }
  if (running.length === 0) throw new Error("No group with a running LMS competition found.");

  // The gameweek to simulate: the one most of those competitions are on.
  const counts = new Map<number, number>();
  for (const r of running) counts.set(r.competition.currentGameweek, (counts.get(r.competition.currentGameweek) ?? 0) + 1);
  const gameweek = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const onGw = running.filter((r) => r.competition.currentGameweek === gameweek);
  const gwMatches = await seasonGameweek(gameweek);
  if (gwMatches.length === 0) throw new Error(`No current-season fixtures for GW${gameweek}.`);
  const playing = new Set<number>();
  for (const m of gwMatches) {
    if (m.homeTeamId != null) playing.add(m.homeTeamId);
    if (m.awayTeamId != null) playing.add(m.awayTeamId);
  }

  const backup: Backup = {
    startedAt: new Date().toISOString(),
    gameweek,
    matches: gwMatches.map((m) => ({
      id: m.id,
      status: m.status,
      homeScore: m.homeScore,
      awayScore: m.awayScore,
      minute: m.minute,
      matchTime: m.matchTime,
    })),
    groups: [],
  };
  // Snapshot first, so a failure part-way through can still be reset.
  fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 2));

  const lines: string[] = [];
  for (const { group, competition } of onGw) {
    const participants = (
      await db.select().from(lmsParticipants).where(eq(lmsParticipants.competitionId, competition.id))
    )
      .filter((p) => p.isActive === "true")
      .sort((a, b) => a.id - b.id);
    const names = new Map(
      (await db.select().from(users).where(eq(users.groupId, group.id))).map((u) => [u.id, u.username]),
    );
    const info = [];
    for (const p of participants) {
      const sels = await db.select().from(lmsSelections).where(eq(lmsSelections.participantId, p.id));
      const used = new Set(sels.filter((s) => s.gameweek !== gameweek && s.teamId != null).map((s) => s.teamId));
      const left = Array.from(playing).filter((t) => !used.has(t));
      info.push({ p, current: sels.filter((s) => s.gameweek === gameweek), left });
    }
    const missed = info.filter((i) => i.left.length > 0).slice(0, wanted);
    if (missed.length === 0) {
      lines.push(`  ${group.name}: skipped (no active player with a team left)`);
      continue;
    }
    const gb: GroupBackup = {
      groupId: group.id,
      groupName: group.name,
      competitionId: competition.id,
      rules: group.rules,
      rulesChanged: false,
      missedParticipantIds: missed.map((i) => i.p.id),
      removedSelections: missed.flatMap((i) => i.current),
      tempSelectionIds: [],
    };
    backup.groups.push(gb);
    fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 2));

    // The chosen players miss the deadline.
    const removeIds = gb.removedSelections.map((s) => s.id);
    if (removeIds.length) await db.delete(lmsSelections).where(inArray(lmsSelections.id, removeIds));

    // Everyone else has a pick, so only the chosen players get a wheel.
    for (const o of info) {
      if (missed.includes(o) || o.current.length > 0 || o.left.length === 0) continue;
      const teamId = o.left[0];
      const match = gwMatches.find((m) => m.homeTeamId === teamId || m.awayTeamId === teamId)!;
      const [row] = await db
        .insert(lmsSelections)
        .values({ participantId: o.p.id, gameweek, teamId, matchId: match.id, result: null, isRandomlyAssigned: "false" })
        .returning({ id: lmsSelections.id });
      gb.tempSelectionIds.push(row.id);
    }

    // Missed picks are drawn at random (the wheel only exists for that rule).
    if (resolveGroupRules(group.rules as any).lms.missedPickPolicy !== "random") {
      const stored = (group.rules as any) ?? {};
      await db
        .update(groups)
        .set({ rules: { ...stored, lms: { ...(stored.lms ?? {}), missedPickPolicy: "random" } } as any })
        .where(eq(groups.id, group.id));
      gb.rulesChanged = true;
    }
    // Let the push fire again if this gameweek was simulated before.
    await db
      .delete(reminderSends)
      .where(and(eq(reminderSends.game, `lms-wheel-c${competition.id}`), eq(reminderSends.gameweek, gameweek)));
    fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 2));

    const who = missed.map((i) => names.get(i.p.userId) ?? `participant ${i.p.id}`);
    lines.push(`  ${group.name}: ${who.join(" and ")} miss${who.length === 1 ? "es" : ""} it` +
      (gb.rulesChanged ? ` (missed-pick rule switched to "random" for now)` : ""));
  }
  for (const r of running.filter((r) => r.competition.currentGameweek !== gameweek)) {
    lines.push(`  ${r.group.name}: not affected (its competition is on GW${r.competition.currentGameweek})`);
  }

  // The deadline is the first kick-off minus each group's offset; use the
  // largest offset so every group's deadline lands at or after "now + N".
  const offsetMin = Math.max(
    0,
    ...onGw.map((r) => resolveGroupRules(r.group.rules as any).lms.deadlineMinutesBeforeKickoff),
  );
  const deadlineMs = Date.now() + deadlineInSec * 1000;
  const firstKickoff = londonStringToUtcMs(gwMatches[0].matchTime);
  for (const m of gwMatches) {
    const shifted = deadlineMs + offsetMin * 60_000 + (londonStringToUtcMs(m.matchTime) - firstKickoff);
    await db
      .update(matches)
      .set({
        matchTime: utcToLondonString(new Date(shifted).toISOString()),
        status: "not_started",
        homeScore: null,
        awayScore: null,
        minute: null,
      })
      .where(eq(matches.id, m.id));
  }
  // Read it back, so a silent failure can't masquerade as success.
  const [check] = await db.select().from(matches).where(eq(matches.id, gwMatches[0].id));
  console.log(`✓ GW${gameweek}'s first kick-off is now ${check.matchTime} (UK time).`);
  await refreshServer();

  console.log(
    [
      ``,
      `GW${gameweek}:`,
      ...lines,
      ``,
      `  Deadline       ${ukClock(deadlineMs)} (in ${deadlineInSec}s)` +
        (offsetMin ? ` for groups with a ${offsetMin}-minute deadline; a little later for the rest` : ""),
      `  Push           ~${ukClock(deadlineMs + WHEEL_PUSH_DELAY_MS)} (needs VAPID keys + notifications on)`,
      `  Wheels spin    ${ukClock(deadlineMs + WHEEL_SPIN_DELAY_MS)}, one at a time, done by ~${ukClock(deadlineMs + WHEEL_SPIN_DELAY_MS + wanted * WHEEL_SLOT_MS)}`,
      ``,
      `Keep the app open as someone in one of those groups. Undo with: npx tsx scripts/simulateLmsWheel.ts reset`,
    ].join("\n"),
  );
}

async function status() {
  if (!fs.existsSync(BACKUP)) {
    console.log("No simulation is set up.");
    return;
  }
  const b: Backup = JSON.parse(fs.readFileSync(BACKUP, "utf8"));
  const rows = await seasonGameweek(b.gameweek);
  console.log(`Simulating GW${b.gameweek} since ${b.startedAt}; first kick-off now ${rows[0]?.matchTime} (UK).`);
  for (const g of b.groups) {
    const sels = await db
      .select()
      .from(lmsSelections)
      .where(and(inArray(lmsSelections.participantId, g.missedParticipantIds), eq(lmsSelections.gameweek, b.gameweek)));
    console.log(`  ${g.groupName}: ${sels.length}/${g.missedParticipantIds.length} missed pick(s) drawn so far`);
  }
}

async function reset() {
  if (!fs.existsSync(BACKUP)) {
    console.log("No simulation to reset.");
    return;
  }
  const raw = JSON.parse(fs.readFileSync(BACKUP, "utf8"));
  // Snapshots from the first version of this script held a single group.
  const b: Backup = raw.groups
    ? raw
    : {
        startedAt: new Date(fs.statSync(BACKUP).mtimeMs - 60_000).toISOString(),
        gameweek: raw.gameweek,
        matches: raw.matches,
        groups: [{ ...raw, groupName: `group ${raw.groupId}` }],
      };
  for (const m of b.matches) {
    await db
      .update(matches)
      .set({ status: m.status, homeScore: m.homeScore, awayScore: m.awayScore, minute: m.minute, matchTime: m.matchTime })
      .where(eq(matches.id, m.id));
  }
  // Random picks the simulation's deadline produced, in any group (moving the
  // fixtures moved every group's deadline).
  const drawn = await db
    .delete(lmsSelections)
    .where(
      and(
        eq(lmsSelections.gameweek, b.gameweek),
        eq(lmsSelections.isRandomlyAssigned, "true"),
        gte(lmsSelections.createdAt, new Date(b.startedAt)),
      ),
    )
    .returning({ id: lmsSelections.id });
  for (const g of b.groups) {
    if (g.missedParticipantIds.length) {
      await db
        .delete(lmsSelections)
        .where(and(inArray(lmsSelections.participantId, g.missedParticipantIds), eq(lmsSelections.gameweek, b.gameweek)));
    }
    if (g.tempSelectionIds.length) await db.delete(lmsSelections).where(inArray(lmsSelections.id, g.tempSelectionIds));
    for (const s of g.removedSelections) {
      await db.insert(lmsSelections).values({ ...s, createdAt: new Date(s.createdAt) });
    }
    if (g.rulesChanged) await db.update(groups).set({ rules: g.rules as any }).where(eq(groups.id, g.groupId));
    await db
      .delete(reminderSends)
      .where(and(eq(reminderSends.game, `lms-wheel-c${g.competitionId}`), eq(reminderSends.gameweek, b.gameweek)));
  }
  fs.unlinkSync(BACKUP);
  await refreshServer();
  console.log(
    `✓ Restored GW${b.gameweek}'s matches and LMS picks (${b.groups.length} group(s), ${drawn.length} random draw(s) removed).`,
  );
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "start") await start();
  else if (cmd === "status") await status();
  else if (cmd === "reset") await reset();
  else {
    console.log("Usage: npx tsx scripts/simulateLmsWheel.ts start [--players 1|2] [--group slug] [--deadline-in seconds] | status | reset");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ Simulation failed:", err instanceof Error ? err.message : err);
  console.error('  If it got part-way, run "npx tsx scripts/simulateLmsWheel.ts reset" to undo it.');
  process.exit(1);
});
