import { db } from "./db";
import { activityLogs, groups, users } from "@shared/schema";
import { and, eq, gte, inArray, like, or } from "drizzle-orm";
import { describeClientEvent, describePushTag } from "@shared/activityEvents";

// The non-pick rows of /admin/audit: settings changes, reminders (sent,
// opened, dismissed) and feature usage (LMS wheel watched, Fixtures
// highlighted, Tendencies charts used). All of them live in activity_logs.

// Settings written by the server. For the player-tool rows the row's userId
// is the player affected and the admin who did it is details.actorUserId.
export const SETTINGS_TYPES = [
  "settings_rules",
  "player_renamed",
  "player_removed",
  "invite_reset",
  "login_code_reset",
  "lms_player_added",
  "lms_player_sat_out",
  "push_enabled",
  "push_disabled",
  "push_lead_changed",
] as const;

// Client events (type ui_event) that belong on the audit page. Background /
// foreground switches are only shown on the activity timeline.
const AUDIT_UI_EVENTS = [
  "wheel_view",
  "fixture_select",
  "chart_interaction",
  "push_opened",
  "push_dismissed",
  "setting_changed",
] as const;

// Usage and reminder rows can be numerous, so only recent ones are sent.
const RECENT_DAYS = 90;

export type ExtraAuditEvent = {
  id: string;
  type: string;
  createdAt: Date;
  username: string;
  groupId: number | null;
  groupName: string | null;
  summary: string;
  ipAddress: string;
  city: string | null;
  country: string | null;
  userAgent: string | null;
};

function parse(raw: string | null): Record<string, any> {
  try {
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const leadLabel = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`);
const leadsLabel = (v: unknown) =>
  Array.isArray(v) && v.length ? v.map((m) => leadLabel(Number(m))).join(", ") : "none";

export async function extraAuditEvents(): Promise<ExtraAuditEvent[]> {
  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: activityLogs.id,
      type: activityLogs.type,
      userId: activityLogs.userId,
      createdAt: activityLogs.createdAt,
      details: activityLogs.details,
      groupId: activityLogs.groupId,
      groupName: groups.name,
      ipAddress: activityLogs.ipAddress,
      city: activityLogs.city,
      country: activityLogs.country,
      userAgent: activityLogs.userAgent,
    })
    .from(activityLogs)
    .leftJoin(groups, eq(activityLogs.groupId, groups.id))
    .where(
      or(
        inArray(activityLogs.type, [...SETTINGS_TYPES]),
        and(eq(activityLogs.type, "push_sent"), gte(activityLogs.createdAt, since)),
        and(
          eq(activityLogs.type, "ui_event"),
          gte(activityLogs.createdAt, since),
          or(...AUDIT_UI_EVENTS.map((e) => like(activityLogs.details, `%"event":"${e}"%`))),
        ),
      ),
    );

  const allUsers = await db.select({ id: users.id, username: users.username }).from(users);
  const nameOf = new Map(allUsers.map((u) => [u.id, u.username]));
  const name = (id: unknown) => (typeof id === "number" ? nameOf.get(id) ?? `#${id}` : null);

  const out: ExtraAuditEvent[] = [];
  for (const r of rows) {
    const d = parse(r.details);
    // Whose action it was: the actor for admin player tools, else the row's user.
    let actorId: number | null = r.userId;
    let type = r.type;
    let summary = r.type;
    switch (r.type) {
      case "settings_rules": {
        const changes = Array.isArray(d.changes) ? d.changes : [];
        summary = `Changed the rules: ${changes
          .map((c: any) => `${c.game === "lawro" ? "Lawro" : "LMS"} ${c.label} ${c.from} → ${c.to}`)
          .join("; ") || "no details"}`;
        break;
      }
      case "player_renamed":
        actorId = d.actorUserId ?? null;
        summary = `Renamed ${d.from ?? "a player"} to ${d.to ?? "?"}`;
        break;
      case "player_removed":
        summary = `Removed ${d.name ?? "a player"} from the group`;
        break;
      case "invite_reset":
        summary = "Made a new invite link (the old one stopped working)";
        break;
      case "login_code_reset":
        actorId = d.actorUserId ?? d.by ?? null;
        summary = `Reset ${name(r.userId) ?? "a player"}'s login code`;
        break;
      case "lms_player_added":
        actorId = d.actorUserId ?? d.by ?? null;
        summary = `Added ${name(r.userId) ?? "a player"} back into LMS`;
        break;
      case "lms_player_sat_out":
        actorId = d.actorUserId ?? d.by ?? null;
        summary = `Took ${name(r.userId) ?? "a player"} out of LMS (sitting out)`;
        break;
      case "push_enabled":
        summary = `Turned reminders on (${leadsLabel(d.leads)} before the deadline)`;
        break;
      case "push_disabled":
        summary = "Turned reminders off on a device";
        break;
      case "push_lead_changed":
        summary = d.from
          ? `Changed reminder times from ${leadsLabel(d.from)} to ${leadsLabel(d.leads)}`
          : `Set reminder times to ${leadsLabel(d.leads)}`;
        break;
      case "push_sent":
        summary = `Sent ${describePushTag(d.tag)}${typeof d.sent === "number" ? ` (${d.sent} of ${d.devices ?? d.sent} device${(d.devices ?? d.sent) === 1 ? "" : "s"})` : ""}${d.body ? `: "${d.body}"` : ""}`;
        break;
      case "ui_event":
        type = String(d.event ?? "ui_event");
        summary = describeClientEvent(type, d);
        break;
    }
    const username = name(actorId);
    if (!username) continue; // logged-out or deleted: nobody to attribute it to
    out.push({
      id: `extra:${r.id}`,
      type,
      createdAt: r.createdAt,
      username,
      groupId: r.groupId,
      groupName: r.groupName,
      summary,
      ipAddress: r.ipAddress,
      city: r.city,
      country: r.country,
      userAgent: r.type === "push_sent" ? null : r.userAgent,
    });
  }
  return out;
}
