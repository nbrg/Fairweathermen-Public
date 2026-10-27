import { db } from "./db";
import {
  groupRuleChanges,
  groups,
  users,
  lawroRulesAt,
  resolveGroupRules,
  type GroupRules,
  type RuleChangeItem,
} from "@shared/schema";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";

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

export type LawroRulesFor = (season: string | null | undefined, gameweek: number | null | undefined) => GroupRules["lawro"];

// A lookup for the Lawro rules in force for any gameweek of a group. Admin
// edits only apply from the first gameweek whose deadline hadn't passed when
// they were made (see lawroRulesAt), so scoring must ask per gameweek rather
// than reading the group's current rules.
export async function getLawroRulesResolver(groupId?: number | null): Promise<LawroRulesFor> {
  const current = (await getGroupRules(groupId)).lawro;
  if (groupId == null) return () => current;
  const changes = await db
    .select({
      id: groupRuleChanges.id,
      before: groupRuleChanges.before,
      lawroEffectiveSeason: groupRuleChanges.lawroEffectiveSeason,
      lawroEffectiveGameweek: groupRuleChanges.lawroEffectiveGameweek,
    })
    .from(groupRuleChanges)
    .where(eq(groupRuleChanges.groupId, groupId))
    .orderBy(asc(groupRuleChanges.id));
  if (!changes.some((c) => c.lawroEffectiveGameweek != null)) return () => current;
  return (season, gameweek) => lawroRulesAt(current, changes, season, gameweek);
}

const LAWRO_MISSED_LABELS: Record<string, string> = {
  blank: "Score nothing that week",
  random: "Fill a random scoreline",
};
const LMS_MISSED_LABELS: Record<string, string> = {
  random: "Assign a random team",
  eliminate: "Knock them out",
};
const LMS_ALL_OUT_LABELS: Record<string, string> = {
  rollover: "No winner; the pot rolls into a new competition",
  revive: "Revive everyone; carry on the same competition",
  co_winners: "They share the win",
  no_winner: "No winner; competition just ends",
};

function minutesLabel(m: number): string {
  if (m === 0) return "At first kick-off";
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? "" : "s"} before first kick-off`;
  return `${m} minutes before first kick-off`;
}

// The settings that differ between two rule sets, worded for the pop-up every
// player sees (labels match the settings page).
export function describeRuleChanges(before: GroupRules, after: GroupRules): RuleChangeItem[] {
  const items: RuleChangeItem[] = [];
  const add = (game: RuleChangeItem["game"], key: string, label: string, from: string, to: string) => {
    if (from !== to) items.push({ game, key, label, from, to });
  };
  const b = before.lawro;
  const a = after.lawro;
  add("lawro", "exactScorePoints", "Points for an exact score", String(b.exactScorePoints), String(a.exactScorePoints));
  add("lawro", "correctResultPoints", "Points for the correct result", String(b.correctResultPoints), String(a.correctResultPoints));
  add("lawro", "deadlineMinutesBeforeKickoff", "Deadline", minutesLabel(b.deadlineMinutesBeforeKickoff), minutesLabel(a.deadlineMinutesBeforeKickoff));
  add("lawro", "missedPickPolicy", "If a player misses the deadline", LAWRO_MISSED_LABELS[b.missedPickPolicy] ?? b.missedPickPolicy, LAWRO_MISSED_LABELS[a.missedPickPolicy] ?? a.missedPickPolicy);
  add("lawro", "jokerEnabled", "Joker (one pick a week scores double)", b.jokerEnabled ? "On" : "Off", a.jokerEnabled ? "On" : "Off");
  const bl = before.lms;
  const al = after.lms;
  add("lms", "buyIn", "Buy-in", `£${bl.buyIn}`, `£${al.buyIn}`);
  add("lms", "lives", "Lives", String(bl.lives), String(al.lives));
  add("lms", "deadlineMinutesBeforeKickoff", "Deadline", minutesLabel(bl.deadlineMinutesBeforeKickoff), minutesLabel(al.deadlineMinutesBeforeKickoff));
  add("lms", "missedPickPolicy", "If a player misses the deadline", LMS_MISSED_LABELS[bl.missedPickPolicy] ?? bl.missedPickPolicy, LMS_MISSED_LABELS[al.missedPickPolicy] ?? al.missedPickPolicy);
  add("lms", "allOutPolicy", "If everyone goes out together", LMS_ALL_OUT_LABELS[bl.allOutPolicy] ?? bl.allOutPolicy, LMS_ALL_OUT_LABELS[al.allOutPolicy] ?? al.allOutPolicy);
  return items;
}

// Rule changes in a group that this player hasn't acknowledged yet, oldest
// first, leaving out changes they made themselves. Feeds the pop-up.
export async function unseenRuleChanges(groupId: number, userId: number, lastSeenId: number) {
  const rows = await db
    .select()
    .from(groupRuleChanges)
    .where(and(eq(groupRuleChanges.groupId, groupId), gt(groupRuleChanges.id, lastSeenId)))
    .orderBy(asc(groupRuleChanges.id));
  const unseen = rows.filter((r) => r.changedByUserId !== userId);
  // Name whoever made each change, so the pop-up can say "Alex has changed the
  // rules" rather than an anonymous "the admin".
  const changerIds = Array.from(new Set(unseen.map((r) => r.changedByUserId).filter((id): id is number => id != null)));
  const changers = changerIds.length
    ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, changerIds))
    : [];
  const nameById = new Map(changers.map((u) => [u.id, u.username]));
  return unseen.map((r) => ({
    id: r.id,
    changedAt: r.changedAt,
    changedByName: r.changedByUserId != null ? nameById.get(r.changedByUserId) ?? null : null,
    changes: r.changes,
    lawroEffectiveGameweek: r.lawroEffectiveGameweek,
  }));
}

// The newest rule-change id in a group (0 if none) — new joiners start here so
// they aren't shown changes made before they arrived.
export async function latestRuleChangeId(groupId: number): Promise<number> {
  const [row] = await db
    .select({ id: groupRuleChanges.id })
    .from(groupRuleChanges)
    .where(eq(groupRuleChanges.groupId, groupId))
    .orderBy(desc(groupRuleChanges.id))
    .limit(1);
  return row?.id ?? 0;
}
