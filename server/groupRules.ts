import { db } from "./db";
import { groups, resolveGroupRules, type GroupRules } from "@shared/schema";
import { eq } from "drizzle-orm";

type GroupRow = typeof groups.$inferSelect;

// Bridge the legacy per-column rules (buyIn, lmsAllOutRule — still written by
// the admin "Groups" screen) into the richer rules blob before resolving. A
// value set in the `rules` blob (via the owner settings page) wins; otherwise
// the legacy column supplies it. This keeps groups configured either way
// behaving correctly, and lets getGroupRules be the single source every caller
// reads.
export function resolveGroupRulesForGroup(
  group: Pick<GroupRow, "rules" | "buyIn" | "lmsAllOutRule"> | null | undefined,
): GroupRules {
  if (!group) return resolveGroupRules(null);
  const stored = (group.rules ?? {}) as Partial<GroupRules>;
  const bridged: Partial<GroupRules> = {
    ...stored,
    lms: {
      ...stored.lms,
      buyIn: stored.lms?.buyIn ?? group.buyIn,
      allOutPolicy:
        stored.lms?.allOutPolicy ?? (group.lmsAllOutRule as GroupRules["lms"]["allOutPolicy"]),
    } as GroupRules["lms"],
  };
  return resolveGroupRules(bridged);
}

// The resolved (defaults-merged, column-bridged) rules for a group. Falls back
// to the built-in defaults when no group id is given, so every caller gets a
// complete GroupRules and groups without overrides behave exactly as the app
// always has. Shared by the routes, the LMS processors and the Lawro scoring so
// there's one place the rules come from.
export async function getGroupRules(groupId?: number | null): Promise<GroupRules> {
  if (groupId == null) return resolveGroupRules(null);
  const [group] = await db
    .select({ rules: groups.rules, buyIn: groups.buyIn, lmsAllOutRule: groups.lmsAllOutRule })
    .from(groups)
    .where(eq(groups.id, groupId));
  return resolveGroupRulesForGroup(group);
}
