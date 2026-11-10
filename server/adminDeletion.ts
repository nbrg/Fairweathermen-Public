// Permanent ("hard") deletion of a whole group or a player, for the site admin
// on /admin/players. Everything runs in one DB transaction, so a failure part
// way through leaves nothing half-deleted.
//
// Each delete has a matching preview that counts exactly what the delete would
// remove; the admin page shows those counts in its "are you sure" dialog. The
// preview and the delete share the same row-selection code (collect*), so the
// numbers shown are the rows that go.
//
// What goes, and what deliberately stays:
//  - A player's own rows go: Lawro predictions (incl. Jokers), LMS entries,
//    picks and pick-change logs, push devices, reminder log, and their activity log rows (page visits, logins,
//    growth events). Logs are deleted rather than anonymised: "permanently"
//    means no trace of them is left.
//  - Rows that only point at them are kept but unlinked: LMS competitions they
//    won keep running/stand with no winner recorded, a group they were admin of
//    is left with no admin, rule changes they made stay in the group's history
//    without a name.
//  - Deleting a group also deletes its LMS
//    competitions, its rule-change history and all its players' rows in that
//    group. People who are also in other groups keep those other groups.
//  - Shared data (matches, teams) is never touched.

import { and, eq, inArray, ne, notInArray, or, type SQL } from "drizzle-orm";
import {
  activityLogs,
  groupRuleChanges,
  groups,
  lmsCompetitions,
  lmsParticipants,
  lmsSelectionLogs,
  lmsSelections,
  predictions,
  pushSubscriptions,
  reminderSends,
  users,
} from "@shared/schema";
import { isCityGroup, isRoversGroup, normaliseGroupName } from "@shared/originalGroups";
import { db } from "./db";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;

// inArray() with an empty list is either invalid SQL or a no-op depending on
// the Drizzle version, so callers skip the query instead.
function idsIn(ids: readonly unknown[]): boolean {
  return ids.length > 0;
}

export type PlayerDeleteScope = "group" | "everywhere";

export interface DeletionCounts {
  predictions: number;
  jokers: number;
  lmsEntries: number;
  lmsPicks: number;
  lmsPickChanges: number;
  lmsCompetitions: number;
  lmsWinsUnlinked: number;
  pushDevices: number;
  reminderSends: number;
  activityLogs: number;
  ruleChanges: number;
  ruleChangesUnlinked: number;
}

export interface PlayerDeletionPreview {
  kind: "player";
  player: { id: number; username: string; groupId: number; groupName: string };
  scope: PlayerDeleteScope;
  // The groups whose player row is deleted under this scope.
  deletedFrom: { userId: number; groupId: number; groupName: string }[];
  // The person's other groups that are kept (scope "group" only).
  keptIn: { groupId: number; groupName: string }[];
  // Groups they're the admin of (among the deleted rows): left with no admin.
  adminOf: { groupId: number; groupName: string }[];
  counts: DeletionCounts;
}

export interface GroupDeletionPreview {
  kind: "group";
  group: { id: number; name: string; slug: string; enabledGames: string[]; createdAt: string };
  isOriginal: boolean;
  players: number;
  // Players who are also in other groups — they keep those.
  playersInOtherGroups: { username: string; otherGroups: string[] }[];
  counts: DeletionCounts;
}

interface Selection {
  userIds: number[];
  groupId: number | null; // set for a group deletion
  participantIds: number[];
  competitionIds: number[]; // deleted (group only)
}

async function participantIdsFor(ex: Exec, userIds: number[], competitionIds: number[]): Promise<number[]> {
  const conds: SQL[] = [];
  if (idsIn(userIds)) conds.push(inArray(lmsParticipants.userId, userIds));
  if (idsIn(competitionIds)) conds.push(inArray(lmsParticipants.competitionId, competitionIds));
  if (conds.length === 0) return [];
  const rows = await ex.select({ id: lmsParticipants.id }).from(lmsParticipants).where(or(...conds));
  return rows.map((r) => r.id);
}

async function collectForUsers(ex: Exec, userIds: number[]): Promise<Selection> {
  return { userIds, groupId: null, participantIds: await participantIdsFor(ex, userIds, []), competitionIds: [] };
}

async function collectForGroup(ex: Exec, groupId: number): Promise<Selection> {
  const members = await ex.select({ id: users.id }).from(users).where(eq(users.groupId, groupId));
  const userIds = members.map((m) => m.id);
  const comps = await ex.select({ id: lmsCompetitions.id }).from(lmsCompetitions).where(eq(lmsCompetitions.groupId, groupId));
  const competitionIds = comps.map((c) => c.id);
  return {
    userIds,
    groupId,
    participantIds: await participantIdsFor(ex, userIds, competitionIds),
    competitionIds,
  };
}

// WHERE clauses for each table, shared by the counts and the deletes.
function where(sel: Selection) {
  const { userIds, groupId, participantIds, competitionIds } = sel;
  const byUser = (col: Parameters<typeof inArray>[0]): SQL | undefined =>
    idsIn(userIds) ? inArray(col, userIds) : undefined;
  const either = (...c: (SQL | undefined)[]): SQL | undefined => {
    const present = c.filter((x): x is SQL => !!x);
    return present.length === 0 ? undefined : present.length === 1 ? present[0] : or(...present);
  };
  const winner = idsIn(userIds)
    ? or(inArray(lmsCompetitions.winnerId, userIds), inArray(lmsCompetitions.coWinnerId, userIds))
    : undefined;
  return {
    predictions: byUser(predictions.userId),
    lmsSelections: idsIn(participantIds) ? inArray(lmsSelections.participantId, participantIds) : undefined,
    lmsSelectionLogs: idsIn(participantIds) ? inArray(lmsSelectionLogs.participantId, participantIds) : undefined,
    lmsParticipants: idsIn(participantIds) ? inArray(lmsParticipants.id, participantIds) : undefined,
    lmsCompetitions: idsIn(competitionIds) ? inArray(lmsCompetitions.id, competitionIds) : undefined,
    // Competitions that survive but name a deleted player as (co-)winner.
    lmsWinsUnlinked: winner
      ? idsIn(competitionIds)
        ? and(winner, notInArray(lmsCompetitions.id, competitionIds))
        : winner
      : undefined,
    pushSubscriptions: either(byUser(pushSubscriptions.userId), groupId != null ? eq(pushSubscriptions.groupId, groupId) : undefined),
    reminderSends: either(byUser(reminderSends.userId), groupId != null ? eq(reminderSends.groupId, groupId) : undefined),
    activityLogs: either(byUser(activityLogs.userId), groupId != null ? eq(activityLogs.groupId, groupId) : undefined),
    ruleChanges: groupId != null ? eq(groupRuleChanges.groupId, groupId) : undefined,
    // Rule changes in other groups made by a deleted player: kept, unnamed.
    ruleChangesUnlinked: idsIn(userIds)
      ? groupId != null
        ? and(inArray(groupRuleChanges.changedByUserId, userIds), ne(groupRuleChanges.groupId, groupId))
        : inArray(groupRuleChanges.changedByUserId, userIds)
      : undefined,
    ownedGroups: idsIn(userIds)
      ? groupId != null
        ? and(inArray(groups.ownerUserId, userIds), ne(groups.id, groupId))
        : inArray(groups.ownerUserId, userIds)
      : undefined,
  };
}


async function countRows(ex: Exec, table: any, cond: SQL | undefined): Promise<number> {
  if (!cond) return 0;
  const rows = await ex.select({ id: table.id }).from(table).where(cond);
  return rows.length;
}

async function countAll(ex: Exec, sel: Selection): Promise<DeletionCounts> {
  const w = where(sel);
  const jokers = w.predictions
    ? (await ex.select({ id: predictions.id }).from(predictions).where(and(w.predictions, eq(predictions.isJoker, true)))).length
    : 0;
  return {
    predictions: await countRows(ex, predictions, w.predictions),
    jokers,
    lmsEntries: sel.participantIds.length,
    lmsPicks: await countRows(ex, lmsSelections, w.lmsSelections),
    lmsPickChanges: await countRows(ex, lmsSelectionLogs, w.lmsSelectionLogs),
    lmsCompetitions: sel.competitionIds.length,
    lmsWinsUnlinked: await countRows(ex, lmsCompetitions, w.lmsWinsUnlinked),
    pushDevices: await countRows(ex, pushSubscriptions, w.pushSubscriptions),
    reminderSends: await countRows(ex, reminderSends, w.reminderSends),
    activityLogs: await countRows(ex, activityLogs, w.activityLogs),
    ruleChanges: await countRows(ex, groupRuleChanges, w.ruleChanges),
    ruleChangesUnlinked: await countRows(ex, groupRuleChanges, w.ruleChangesUnlinked),
  };
}

// Deletes everything the selection covers, children before parents. Must run
// inside a transaction.
async function deleteAll(tx: Tx, sel: Selection): Promise<void> {
  const w = where(sel);
  if (w.lmsSelections) await tx.delete(lmsSelections).where(w.lmsSelections);
  if (w.lmsSelectionLogs) await tx.delete(lmsSelectionLogs).where(w.lmsSelectionLogs);
  if (w.lmsParticipants) await tx.delete(lmsParticipants).where(w.lmsParticipants);
  if (w.lmsWinsUnlinked) {
    // Clear just the deleted player's slot (winner or co-winner).
    await tx.update(lmsCompetitions).set({ winnerId: null }).where(and(w.lmsWinsUnlinked, inArray(lmsCompetitions.winnerId, sel.userIds)));
    await tx.update(lmsCompetitions).set({ coWinnerId: null }).where(and(w.lmsWinsUnlinked, inArray(lmsCompetitions.coWinnerId, sel.userIds)));
  }
  if (w.lmsCompetitions) await tx.delete(lmsCompetitions).where(w.lmsCompetitions);
  if (w.predictions) await tx.delete(predictions).where(w.predictions);
  if (w.pushSubscriptions) await tx.delete(pushSubscriptions).where(w.pushSubscriptions);
  if (w.reminderSends) await tx.delete(reminderSends).where(w.reminderSends);
  // activity_logs.user_id is a real FK to users, so these must go before users.
  if (w.activityLogs) await tx.delete(activityLogs).where(w.activityLogs);
  if (w.ruleChanges) await tx.delete(groupRuleChanges).where(w.ruleChanges);
  if (w.ruleChangesUnlinked) await tx.update(groupRuleChanges).set({ changedByUserId: null }).where(w.ruleChangesUnlinked);
  if (w.ownedGroups) await tx.update(groups).set({ ownerUserId: null }).where(w.ownedGroups);
  if (idsIn(sel.userIds)) await tx.delete(users).where(inArray(users.id, sel.userIds));
  if (sel.groupId != null) await tx.delete(groups).where(eq(groups.id, sel.groupId));
}

export function isOriginalGroup(group: { slug: string; inviteToken?: string | null }): boolean {
  return isCityGroup(group) || isRoversGroup(group);
}

// ---------- players ----------

async function playerRows(ex: Exec, userId: number, scope: PlayerDeleteScope) {
  const [user] = await ex.select().from(users).where(eq(users.id, userId));
  if (!user) return null;
  // Everyone sharing the login code is the same person (one row per group).
  const personRows = user.loginCode
    ? await ex.select().from(users).where(eq(users.loginCode, user.loginCode))
    : [user];
  const targets = scope === "everywhere" ? personRows : [user];
  return { user, personRows, targets };
}

export async function previewPlayerDeletion(userId: number, scope: PlayerDeleteScope): Promise<PlayerDeletionPreview | null> {
  const rows = await playerRows(db, userId, scope);
  if (!rows) return null;
  const { user, personRows, targets } = rows;
  const allGroups = await db.select({ id: groups.id, name: groups.name, ownerUserId: groups.ownerUserId }).from(groups);
  const groupName = (id: number) => allGroups.find((g) => g.id === id)?.name ?? `group ${id}`;
  const targetIds = targets.map((t) => t.id);
  const sel = await collectForUsers(db, targetIds);

  return {
    kind: "player",
    player: { id: user.id, username: user.username, groupId: user.groupId, groupName: groupName(user.groupId) },
    scope,
    deletedFrom: targets.map((t) => ({ userId: t.id, groupId: t.groupId, groupName: groupName(t.groupId) })),
    keptIn: personRows
      .filter((r) => !targetIds.includes(r.id))
      .map((r) => ({ groupId: r.groupId, groupName: groupName(r.groupId) })),
    adminOf: allGroups
      .filter((g) => g.ownerUserId != null && targetIds.includes(g.ownerUserId))
      .map((g) => ({ groupId: g.id, groupName: g.name })),
    counts: await countAll(db, sel),
  };
}

export async function deletePlayerPermanently(userId: number, scope: PlayerDeleteScope): Promise<PlayerDeletionPreview | null> {
  const preview = await previewPlayerDeletion(userId, scope);
  if (!preview) return null;
  await db.transaction(async (tx) => {
    // Re-select inside the transaction so rows added since the preview go too.
    const rows = await playerRows(tx, userId, scope);
    if (!rows) return;
    await deleteAll(tx, await collectForUsers(tx, rows.targets.map((t) => t.id)));
  });
  return preview;
}

// ---------- groups ----------

export async function previewGroupDeletion(groupId: number): Promise<GroupDeletionPreview | null> {
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!group) return null;
  const sel = await collectForGroup(db, groupId);
  const members = await db.select().from(users).where(eq(users.groupId, groupId));
  const codes = members.map((m) => m.loginCode).filter((c): c is string => !!c);
  const elsewhere = idsIn(codes)
    ? await db
        .select({ loginCode: users.loginCode, groupName: groups.name })
        .from(users)
        .innerJoin(groups, eq(users.groupId, groups.id))
        .where(and(inArray(users.loginCode, codes), ne(users.groupId, groupId)))
    : [];
  const playersInOtherGroups = members
    .map((m) => ({
      username: m.username,
      otherGroups: Array.from(new Set(elsewhere.filter((e) => m.loginCode && e.loginCode === m.loginCode).map((e) => e.groupName))),
    }))
    .filter((p) => p.otherGroups.length > 0);
  return {
    kind: "group",
    group: {
      id: group.id,
      name: group.name,
      slug: group.slug,
      enabledGames: group.enabledGames,
      createdAt: group.createdAt.toISOString(),
    },
    isOriginal: isOriginalGroup(group),
    players: members.length,
    playersInOtherGroups,
    counts: await countAll(db, sel),
  };
}

export type GroupDeleteRefusal = { status: number; error: string };

// The typed name must match the group's name (ignoring case and spacing), and
// an original group (the two seeded demo groups) also needs confirmOriginal.
export function checkGroupConfirmation(
  group: { name: string; slug: string },
  body: { confirmName?: unknown; confirmOriginal?: unknown },
): GroupDeleteRefusal | null {
  const typed = typeof body.confirmName === "string" ? body.confirmName : "";
  if (normaliseGroupName(typed) !== normaliseGroupName(group.name)) {
    return { status: 400, error: `Type the group's name ("${group.name}") to confirm.` };
  }
  if (isOriginalGroup(group) && body.confirmOriginal !== true) {
    return { status: 400, error: `${group.name} is one of the original groups. Tick the extra confirmation to delete it.` };
  }
  return null;
}

export async function deleteGroupPermanently(groupId: number): Promise<GroupDeletionPreview | null> {
  const preview = await previewGroupDeletion(groupId);
  if (!preview) return null;
  await db.transaction(async (tx) => {
    await deleteAll(tx, await collectForGroup(tx, groupId));
  });
  return preview;
}
