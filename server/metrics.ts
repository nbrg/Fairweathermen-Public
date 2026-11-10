import { and, asc, gte, lt, min } from "drizzle-orm";
import { db } from "./db";
import { activityLogs, users, lmsParticipants } from "@shared/schema";
import { isStaticAssetPath } from "@shared/staticAssets";
import { isBotUserAgent } from "./groupAuth";

const DAY = 86400000;
const gameNames = ["Lawro", "Last Man Standing"] as const;
function actionGame(type: string): typeof gameNames[number] | null {
  if (["prediction_set", "prediction_change", "prediction_delete", "prediction_joker"].includes(type)) return "Lawro";
  if (["lms_selection_new", "lms_selection_change", "lms_selection_removed"].includes(type)) return "Last Man Standing";
  return null;
}
const isActivity = (e: Event) => e.type === "page_visit" || e.type === "tab_view" || actionGame(e.type) != null;
const isNewMembership = (e: Event) => e.type === "group_created" || (e.type === "group_joined" && details(e).rejoin !== true);
type Event = typeof activityLogs.$inferSelect;
function details(event: Event): Record<string, unknown> {
  try {
    const value = JSON.parse(event.details || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function bucket(time: number, interval: "day" | "week" | "month") {
  const date = new Date(time);
  date.setUTCHours(0, 0, 0, 0);
  if (interval === "week") date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  if (interval === "month") date.setUTCDate(1);
  return date.toISOString().slice(0, 10);
}

// No row cap: incomplete feeds must never silently become dashboard totals.
// Only aggregate counts leave the server; codes and visitor identifiers stay here.
export async function getMetrics(days: number, interval: "day" | "week" | "month", now = new Date()) {
  const end = now.getTime();
  const start = end - days * DAY;
  const previousStart = start - days * DAY;
  const [rawEvents, people, coverage, participants] = await Promise.all([
    db.select().from(activityLogs).where(and(gte(activityLogs.createdAt, new Date(previousStart - 30 * 60000)), lt(activityLogs.createdAt, now))).orderBy(asc(activityLogs.createdAt), asc(activityLogs.id)),
    db.select({ id: users.id, loginCode: users.loginCode, groupId: users.groupId }).from(users),
    db.select({ type: activityLogs.type, firstEvent: min(activityLogs.createdAt) }).from(activityLogs).groupBy(activityLogs.type),
    db.select({ id: lmsParticipants.id, userId: lmsParticipants.userId }).from(lmsParticipants),
  ]);
  // Legacy LMS activity rows omitted userId/groupId; resolve their participant.
  const participantUsers = new Map(participants.map(p => [p.id, p.userId]));
  const userGroups = new Map(people.map(p => [p.id, p.groupId]));
  const events = rawEvents.map(e => {
    const d = details(e);
    if (actionGame(e.type) && d.actorRecorded === true) {
      const actor = typeof d.actorUserId === "number" && Number.isInteger(d.actorUserId) ? d.actorUserId : null;
      return { ...e, userId: actor != null && userGroups.has(actor) ? actor : null };
    }
    // Legacy Lawro audit userId is the subject of the edit, not its actor.
    // Keep the action volume, but never infer that the subject visited/played.
    if (e.type.startsWith("prediction_")) return { ...e, userId: null };
    if (!e.type.startsWith("lms_selection_") || e.userId != null) return e;
    const userId = participantUsers.get(Number(details(e).participantId)) ?? null;
    return { ...e, userId, groupId: userId == null ? e.groupId : userGroups.get(userId) ?? e.groupId };
  });
  // A person has one roster row per group. Their shared code unifies those rows.
  const identities = new Map(people.map(p => [p.id, p.loginCode ? `person:${p.loginCode}` : `user:${p.id}`]));
  const person = (e: Event) => e.userId == null ? null : identities.get(e.userId) ?? `user:${e.userId}`;
  const browser = (e: Event) => {
    const vid = details(e).vid;
    return typeof vid === "string" && vid ? `browser:${vid}` : `legacy:${e.ipAddress}:${e.userAgent}`;
  };
  let excluded = 0;
  const clean = events.filter(e => {
    const d = details(e);
    const path = (e.path ?? "").split("?")[0];
    const isView = e.type === "page_visit" || e.type === "tab_view";
    const valid = !(e.userAgent && isBotUserAgent(e.userAgent)) && !d.speculative && d.visible !== false &&
      d.trigger !== "foreground" && !path.startsWith("/admin") && !["/audit", "/activity"].includes(path) &&
      !isStaticAssetPath(path) && !path.includes("/@") && (!isView || !path.startsWith("/api/")) &&
      (e.type !== "page_visit" || d.method == null || ["GET", "CLIENT_NAVIGATION"].includes(String(d.method)));
    if (!valid && e.createdAt.getTime() >= start) excluded++;
    return valid;
  });
  // Server document GET + SPA initial navigation are one view. Match the same
  // browser/path within 30s, consuming each GET once; repeated SPA views survive.
  const pending = new Map<string, Event[]>();
  const paired = new Set<number>();
  for (const e of clean) {
    if (e.type !== "page_visit") continue;
    const key = `${e.ipAddress}|${e.userAgent}|${e.userId}|${e.path}`;
    const list = (pending.get(key) ?? []).filter(x => e.createdAt.getTime() - x.createdAt.getTime() <= 30000);
    const method = details(e).method;
    const counterpart = list.find(x => {
      const xd = details(x);
      const d = details(e);
      const oppositeSource = (xd.method === "GET" && method === "CLIENT_NAVIGATION") || (xd.method === "CLIENT_NAVIGATION" && method === "GET");
      // Different cookies are different browsers, even behind the same IP/UA.
      return oppositeSource && !(xd.vid && d.vid && xd.vid !== d.vid);
    });
    if (counterpart) {
      const kept = method === "CLIENT_NAVIGATION" ? e : counterpart;
      const removed = kept === e ? counterpart : e;
      if (!details(kept).vid && details(removed).vid) kept.details = JSON.stringify({ ...details(kept), vid: details(removed).vid });
      paired.add(removed.id);
      list.splice(list.indexOf(counterpart), 1);
    } else list.push(e);
    pending.set(key, list);
  }
  const filtered = clean.filter(e => !paired.has(e.id));
  // Attribute a session to its actual start, including 30 minutes of lookback
  // before the comparison window. Bucket totals now add up across midnight.
  const sessionStarts = new Set<number>();
  const lastActivity = new Map<string, number>();
  for (const e of filtered) {
    if (!isActivity(e) || (actionGame(e.type) && !person(e))) continue;
    const key = person(e) ?? browser(e);
    const time = e.createdAt.getTime();
    if (!lastActivity.has(key) || time - lastActivity.get(key)! > 30 * 60000) sessionStarts.add(e.id);
    lastActivity.set(key, time);
  }
  const summarize = (from: number, to: number, source = filtered) => {
    const rows = source.filter(e => e.createdAt.getTime() >= from && e.createdAt.getTime() < to);
    const views = rows.filter(e => e.type === "page_visit");
    const activity = rows.filter(isActivity);
    const activePlayers = new Set(activity.map(person).filter((p): p is string => p !== null));
    const contributors = new Set(activity.filter(e => actionGame(e.type) != null).map(person).filter((p): p is string => p !== null));
    const anonymousBrowsers = new Set(views.filter(e => e.userId == null).map(browser));
    const activeGroups = new Set(activity.filter(e => e.userId != null && e.groupId != null).map(e => e.groupId));
    const sessions = activity.filter(e => sessionStarts.has(e.id)).length;
    const count = (type: string) => rows.filter(e => e.type === type).length;
    return { pageViews: views.length, loggedInViews: views.filter(e => e.userId != null).length,
      anonymousViews: views.filter(e => e.userId == null).length, activePlayers: activePlayers.size,
      activeGroups: activeGroups.size, contributors: contributors.size, sessions,
      anonymousBrowsers: anonymousBrowsers.size, newBrowsers: new Set(rows.filter(e => e.type === "new_visitor").map(browser)).size,
      groupsCreated: count("group_created"),
      playersJoined: rows.filter(e => e.type === "group_joined" && details(e).rejoin !== true).length,
      playerMemberships: rows.filter(isNewMembership).length,
      rejoins: rows.filter(e => e.type === "group_joined" && details(e).rejoin === true).length,
      logins: count("login"), failedLogins: count("login_failed"), gameActions: rows.filter(e => actionGame(e.type) != null).length,
      activeIdentities: activePlayers };
  };
  const current = summarize(start, end);
  const previous = summarize(previousStart, start);
  const returningPlayers = Array.from(current.activeIdentities).filter(p => previous.activeIdentities.has(p)).length;
  const { activeIdentities: _current, ...totals } = current;
  const { activeIdentities: _previous, ...previousTotals } = previous;
  const keys = Array.from(new Set(Array.from({ length: days + 1 }, (_, i) => bucket(Math.min(start + i * DAY, end - 1), interval))));
  const bucketEvents = new Map<string, Event[]>();
  for (const event of filtered) {
    const time = event.createdAt.getTime();
    if (time < start || time >= end) continue;
    const key = bucket(time, interval);
    const rows = bucketEvents.get(key) ?? [];
    rows.push(event);
    bucketEvents.set(key, rows);
  }
  const series = keys.map((date, i) => {
    const from = Math.max(start, Date.parse(date));
    const to = i + 1 < keys.length ? Date.parse(keys[i + 1]) : end;
    const { activeIdentities, ...values } = summarize(from, to, bucketEvents.get(date) ?? []);
    const next = new Date(date);
    if (interval === "month") next.setUTCMonth(next.getUTCMonth() + 1);
    else next.setUTCDate(next.getUTCDate() + (interval === "week" ? 7 : 1));
    return { date, partial: from > Date.parse(date) || to < next.getTime(), ...values };
  });
  // Every eligible visitor gets exactly seven days of follow-up. Recent
  // cohorts remain pending, even if they have already joined, avoiding bias.
  const newVisitors = new Map<string, number>();
  const converted = new Set<string>();
  for (const e of filtered) {
    const time = e.createdAt.getTime();
    if (time < start || time >= end) continue;
    const vid = details(e).vid;
    if (typeof vid !== "string" || !vid) continue;
    if (e.type === "new_visitor" && !newVisitors.has(vid)) newVisitors.set(vid, time);
    const firstVisit = newVisitors.get(vid);
    if (isNewMembership(e) && firstVisit != null && firstVisit <= end - 7 * DAY &&
        time >= firstVisit && time <= firstVisit + 7 * DAY) converted.add(vid);
  }
  const matureVisitors = Array.from(newVisitors.values()).filter(time => time <= end - 7 * DAY).length;
  const firstRecorded = (types: (type: string) => boolean) => {
    const times = coverage.filter(row => types(row.type) && row.firstEvent != null).map(row => new Date(row.firstEvent!).getTime());
    return times.length ? new Date(Math.min(...times)).toISOString() : null;
  };
  const activitySince = firstRecorded(type => ["page_visit", "tab_view"].includes(type) || actionGame(type) != null);
  const growthSince = firstRecorded(type => ["new_visitor", "group_created", "group_joined", "login", "login_failed"].includes(type));
  const comparison = {
    activity: activitySince != null && Date.parse(activitySince) <= previousStart,
    growth: growthSince != null && Date.parse(growthSince) <= previousStart,
  };
  const currentRows = filtered.filter(e => e.createdAt.getTime() >= start);
  const unattributedGameActions = currentRows.filter(e => actionGame(e.type) && person(e) == null).length;
  const previousUnattributedGameActions = filtered.filter(e => e.createdAt.getTime() >= previousStart && e.createdAt.getTime() < start && actionGame(e.type) && person(e) == null).length;
  const games = gameNames.map(game => {
    const rows = currentRows.filter(e => actionGame(e.type) === game);
    return { game, actions: rows.length,
      players: new Set(rows.map(person).filter((id): id is string => id != null)).size,
      groups: new Set(rows.filter(e => e.groupId != null).map(e => e.groupId)).size };
  });
  return { days, interval, start: new Date(start).toISOString(), end: now.toISOString(),
    previousStart: new Date(previousStart).toISOString(), firstRecordedEvent: firstRecorded(() => true),
    history: { activitySince, growthSince, comparison }, games,
    totals, previous: previousTotals, returningPlayers,
    retentionRate: comparison.activity && unattributedGameActions === 0 && previousUnattributedGameActions === 0 && previous.activePlayers ? returningPlayers / previous.activePlayers : null,
    activationRate: current.activePlayers ? current.contributors / current.activePlayers : null,
    conversion: { eligibleBrowsers: matureVisitors, convertedBrowsers: converted.size,
      pendingBrowsers: newVisitors.size - matureVisitors, windowDays: 7,
      rate: matureVisitors ? converted.size / matureVisitors : null },
    quality: {
      previousUnattributedGameActions, unattributedGameActions,
      unknownAgentEvents: currentRows.filter(e => !e.userAgent).length,
      excludedEvents: excluded, duplicateViews: clean.filter(e => paired.has(e.id) && e.createdAt.getTime() >= start).length,
      legacyAnonymousViews: filtered.filter(e => e.type === "page_visit" && e.userId == null && e.createdAt.getTime() >= start && !details(e).vid).length },
    series: series.map((row, i) => {
      const until = i + 1 < series.length ? Date.parse(series[i + 1].date) : end;
      const activityObserved = activitySince != null && Date.parse(activitySince) < until;
      const growthObserved = growthSince != null && Date.parse(growthSince) < until;
      return { ...row, activityObserved, growthObserved,
        loggedInViews: activityObserved ? row.loggedInViews : null,
        anonymousViews: activityObserved ? row.anonymousViews : null,
        activePlayers: activityObserved ? row.activePlayers : null,
        contributors: activityObserved ? row.contributors : null,
        anonymousBrowsers: activityObserved ? row.anonymousBrowsers : null,
        newBrowsers: growthObserved ? row.newBrowsers : null,
        groupsCreated: growthObserved ? row.groupsCreated : null,
        playersJoined: growthObserved ? row.playersJoined : null,
      };
    }) };
}

export type Metrics = Awaited<ReturnType<typeof getMetrics>>;
