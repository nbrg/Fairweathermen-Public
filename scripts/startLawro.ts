// Set up the "Lawro" Prediction League group and seed its first players.
//
// Lawro is the Prediction League game (predict the score of every Premier League
// match, one gameweek at a time; 3 pts for an exact score, 1 pt for the right
// result). It's a per-group game — a group with enabledGames including
// "predictions" gets the Lawro tab and its own group-scoped leaderboard.
//
// This script creates a dedicated, predictions-only group so Lawro can be run
// with a fresh set of people who don't see the other games. By default it adds
// Alex, Blake and Harper. More people are best added afterwards from the
// admin players page (/admin/players), which mints their personal login codes.
//
// Because login codes identify a *person* (not a group), adding someone who
// already exists in another group — e.g. Blake from City — reuses their
// existing code: they keep one code, and switch into Lawro from the group
// dropdown. Brand-new people (e.g. Harper) get a fresh code.
//
// Usage (run with tsx):
//   tsx scripts/startLawro.ts                              # dry run (default)
//   tsx scripts/startLawro.ts --confirm                    # create group + add default players
//   tsx scripts/startLawro.ts --players "Alex,Blake" --confirm
//   tsx scripts/startLawro.ts --slug lawro --name Lawro --confirm
//
// Idempotent: re-running never duplicates the group or a player row, and never
// overwrites an existing login code. Safe to run again to add more players.

import { db } from "../server/db";
import { groups, users } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { codeForUsername, resolveLoginCodeForUsername } from "../server/loginCodes";

const CONFIRM = process.argv.includes("--confirm");
function argVal(flag: string, fallback: string) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SLUG = argVal("--slug", "lawro");
const NAME = argVal("--name", "Lawro");
const PLAYERS = argVal("--players", "Alex,Blake,Harper")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  console.log(
    `[lawro] group slug "${SLUG}" (${NAME}), games: ["predictions"]. ` +
      `Players to ensure: ${PLAYERS.join(", ") || "(none)"}.`,
  );

  if (!CONFIRM) {
    const existing = (await db.select().from(groups).where(eq(groups.slug, SLUG)))[0];
    console.log(
      existing
        ? `[lawro] group already exists (id ${existing.id}). Would ensure players above.`
        : `[lawro] group does not exist yet. Would create it and add the players above.`,
    );
    // Per-player preview: does this exact username already exist somewhere? If
    // so their existing code is reused (they're an existing person, e.g. Blake
    // from City); if not, they're treated as brand new and get a fresh code.
    // Use this to catch spelling mismatches (e.g. "Blake" vs "Devon") BEFORE
    // applying — a mismatch would create a new person instead of reusing.
    for (const username of PLAYERS) {
      const code = await codeForUsername(username);
      console.log(
        code
          ? `[lawro]   - ${username}: existing person (code ${code} reused).`
          : `[lawro]   - ${username}: NOT found anywhere — will be added as a NEW person with a fresh code. ` +
              `If they should be an existing player, check the spelling.`,
      );
    }
    console.log(`[lawro] DRY RUN — nothing written. Re-run with --confirm to apply.`);
    return;
  }

  // 1. Ensure the group exists with predictions enabled.
  let group = (await db.select().from(groups).where(eq(groups.slug, SLUG)))[0];
  if (!group) {
    [group] = await db
      .insert(groups)
      .values({ slug: SLUG, name: NAME, enabledGames: ["predictions"] })
      .returning();
    console.log(`[lawro] created group ${group.id} (${SLUG} / ${NAME}).`);
  } else {
    // Make sure predictions is enabled even if the group pre-existed.
    if (!group.enabledGames.includes("predictions")) {
      const next = [...group.enabledGames, "predictions"];
      await db.update(groups).set({ enabledGames: next }).where(eq(groups.id, group.id));
      console.log(`[lawro] enabled predictions on existing group ${group.id}.`);
    } else {
      console.log(`[lawro] group ${group.id} already exists with predictions enabled.`);
    }
  }

  // 2. Ensure each player has a row in the group, reusing their personal code.
  for (const username of PLAYERS) {
    const existing = (
      await db
        .select({ id: users.id, loginCode: users.loginCode })
        .from(users)
        .where(and(eq(users.username, username), eq(users.groupId, group.id)))
    )[0];
    if (existing) {
      console.log(
        `[lawro] ${username} already in ${NAME} (user ${existing.id}, code ${existing.loginCode ?? "—"}).`,
      );
      continue;
    }
    const loginCode = await resolveLoginCodeForUsername(username);
    const [row] = await db
      .insert(users)
      .values({ username, password: "password", groupId: group.id, loginCode })
      .returning({ id: users.id, loginCode: users.loginCode });
    console.log(`[lawro] added ${username} to ${NAME} (user ${row.id}, code ${row.loginCode}).`);
  }

  console.log(
    `[lawro] done. Share each player's code so they can sign in. ` +
      `Add more players anytime from /admin/players.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[lawro] failed:", err);
    process.exit(1);
  });
