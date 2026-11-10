// Fine-grained client events recorded for /admin/activity and /admin/audit:
// what people actually do while the app is open (backgrounding it, watching
// the LMS wheel, highlighting fixtures, playing with Tendencies charts,
// opening a reminder…). The client posts { event, path, detail } to
// POST /api/track/event; the server stores one activity_logs row of type
// `ui_event` with { event, ...detail } in `details`. No schema change.

export const CLIENT_EVENTS = [
  // The tab/app went to the background (switched app, locked phone, closed tab).
  "app_hidden",
  // The tab/app came back to the foreground. detail.awayMs = time away.
  "app_visible",
  // Someone had the LMS randomiser wheel on screen. detail: { gameweek, wheelOf, own, phase }.
  "wheel_view",
  // Fixtures tab: a fixture cell highlighted/unhighlighted, or a team row hidden.
  // detail: { team, gameweek, opponent, on } or { team, hidden: true }.
  "fixture_select",
  // Lawro Tendencies: a chart's toggle/dropdown changed, or a chart tapped.
  // detail: { chart, action: "toggle" | "tap", value? }.
  "chart_interaction",
  // The site was opened by tapping a push notification. detail: { tag }.
  "push_opened",
  // A push notification was swiped away without opening it. detail: { tag }.
  "push_dismissed",
  // A device-only setting changed (e.g. Light/Dark/Auto). detail: { setting, from, to }.
  "setting_changed",
] as const;

export type ClientEvent = (typeof CLIENT_EVENTS)[number];

export function isClientEvent(v: unknown): v is ClientEvent {
  return typeof v === "string" && (CLIENT_EVENTS as readonly string[]).includes(v);
}

// Keep stored details small and flat: only primitive values, short strings,
// at most 12 keys. Anything else is dropped.
export function sanitizeEventDetail(raw: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 12)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(k)) continue;
    if (v === null || typeof v === "boolean") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 120);
  }
  return out;
}

// Push links carry ?via=push&n=<tag> so the visit they lead to can be tied to
// the notification (see server/push.ts and usePageTracking).
export const PUSH_VIA_PARAM = "via";
export const PUSH_VIA_VALUE = "push";
export const PUSH_TAG_PARAM = "n";

export function withPushMarker(url: string, tag?: string): string {
  const [base, hash] = url.split("#");
  const sep = base.includes("?") ? "&" : "?";
  const tagPart = tag ? `&${PUSH_TAG_PARAM}=${encodeURIComponent(tag)}` : "";
  return `${base}${sep}${PUSH_VIA_PARAM}=${PUSH_VIA_VALUE}${tagPart}${hash ? `#${hash}` : ""}`;
}

// Reminder/notification tags → readable names ("lawro-gw12" → "Lawro GW12").
export function describePushTag(tag: string | null | undefined): string {
  if (!tag) return "notification";
  let m = tag.match(/^lawro-gw(\d+)$/);
  if (m) return `Lawro GW${m[1]} reminder`;
  m = tag.match(/^lms-gw(\d+)$/);
  if (m) return `LMS GW${m[1]} reminder`;
  m = tag.match(/^lms-wheel-\d+-(\d+)$/);
  if (m) return `LMS GW${m[1]} wheel alert`;
  return tag;
}

function fmtAway(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// One readable line per client event, shared by the activity timeline and the
// audit feed so both say the same thing.
export function describeClientEvent(event: string, d: Record<string, any>): string {
  switch (event) {
    case "app_hidden":
      return "Put the app in the background";
    case "app_visible":
      return typeof d.awayMs === "number" ? `Came back to the app (away ${fmtAway(d.awayMs)})` : "Came back to the app";
    case "wheel_view": {
      const whose = d.own ? "their own wheel" : d.wheelOf ? `${d.wheelOf}'s wheel` : "the randomiser wheel";
      const phase =
        d.phase === "countdown" ? " (countdown)" : d.phase === "spinning" ? " (spinning)" : d.phase === "result" ? " (result)" : "";
      return `LMS${d.gameweek ? ` GW${d.gameweek}` : ""}: watched ${whose}${phase}`;
    }
    case "fixture_select":
      if (d.hidden != null) return `Fixtures: ${d.hidden ? "hid" : "showed"} ${d.team ?? "a team"}'s row`;
      return `Fixtures: ${d.on === false ? "unhighlighted" : "highlighted"} ${d.team ?? "?"}${d.opponent ? ` v ${d.opponent}` : ""}${d.gameweek ? ` (GW${d.gameweek})` : ""}`;
    case "chart_interaction":
      return d.action === "tap"
        ? `Tendencies: tapped "${d.chart ?? "a chart"}"`
        : `Tendencies: "${d.chart ?? "a chart"}" → ${d.value ?? "?"}`;
    case "push_opened":
      return `Opened the site from a ${describePushTag(d.tag)}`;
    case "push_dismissed":
      return `Dismissed a ${describePushTag(d.tag)}`;
    case "setting_changed":
      return `Changed ${d.setting ?? "a setting"}${d.from ? ` from ${d.from}` : ""} to ${d.to ?? "?"}`;
    default:
      return event;
  }
}

// How /admin/audit groups its rows. Picks are the original game entries;
// the rest are the settings/reminder/usage rows from server/auditExtras.ts.
export type AuditCategory = "pick" | "settings" | "reminders" | "usage" | "rules";

const SETTINGS_AUDIT_TYPES = new Set([
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
  "setting_changed",
]);
const REMINDER_AUDIT_TYPES = new Set(["push_sent", "push_opened", "push_dismissed"]);
const USAGE_AUDIT_TYPES = new Set(["wheel_view", "fixture_select", "chart_interaction"]);

export function auditCategory(type: string): AuditCategory {
  if (type === "rule_change_acknowledged") return "rules";
  if (SETTINGS_AUDIT_TYPES.has(type)) return "settings";
  if (REMINDER_AUDIT_TYPES.has(type)) return "reminders";
  if (USAGE_AUDIT_TYPES.has(type)) return "usage";
  return "pick";
}

// Audit rows that come from client events or push sends: /admin/activity
// already gets these straight from its own feed, so it mustn't fold them in twice.
export function isActivityFeedAuditType(type: string): boolean {
  return REMINDER_AUDIT_TYPES.has(type) || USAGE_AUDIT_TYPES.has(type) || type === "setting_changed";
}
