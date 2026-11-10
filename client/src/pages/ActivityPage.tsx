import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { isOwnUsername } from "@/lib/utils";
import { GroupMultiSelect } from "@/components/GroupMultiSelect";
import { AdminGate } from "@/components/AdminGate";
import { describeLocation, LOCATION_HINT } from "@shared/ipLocation";
import { AdminLayout, AdminPageTitle } from "@/components/AdminNav";
import { isStaticAssetPath } from "@shared/staticAssets";
import { auditCategory, describeClientEvent, describePushTag, isActivityFeedAuditType } from "@shared/activityEvents";

type ActivityEvent = {
  id: number;
  type: string;
  userId: number | null;
  username: string | null;
  createdAt: string;
  ipAddress: string;
  userAgent: string | null;
  city: string | null;
  country: string | null;
  path: string;
  details: string | null;
  groupId: number | null;
  groupName: string | null;
  // Which game the landing route "/" showed this person in this group (server
  // works it out from the group's/person's games). null = unknown.
  landingGame?: "lms" | "predictions" | null;
  // A logged-out row whose browser was logged in as this person elsewhere in
  // the window (matched by the anonymous visitor cookie).
  likelyUsername?: string | null;
};

function parseDetails(e: { details: string | null }): Record<string, any> {
  try {
    const v = e.details ? JSON.parse(e.details) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Visits/tab changes make up sessions; ui_event / push_sent rows are the finer
// timeline (backgrounding, wheel, fixtures, charts, reminders).
const isVisit = (e: ActivityEvent) => e.type === "page_visit" || e.type === "tab_view";
const uiEventName = (e: ActivityEvent): string | null => (e.type === "ui_event" ? parseDetails(e).event ?? null : null);
// Rows that happen to someone rather than something they did: they're placed
// into a session but never start one.
const isAttachOnly = (e: ActivityEvent) => e.type === "push_sent" || uiEventName(e) === "push_dismissed";

// A pick/change from /api/admin/audit (Lawro, LMS). Shown inside the
// session it happened in, so a visit where someone made picks says so.
type AuditEvent = {
  id: string;
  type: string;
  createdAt: string;
  username: string;
  groupId: number | null;
  groupName: string | null;
  summary: string;
  ipAddress: string;
  city: string | null;
  country: string | null;
  userAgent: string | null;
};

// Which game an audit action belongs to, for the "Lawro: 10 picks" chips.
function actionGame(a: AuditEvent): string {
  if (auditCategory(a.type) === "settings") return "Settings";
  if (a.type === "lms_selection") return "LMS";
  if (a.type.startsWith("prediction_")) return "Lawro";
  return "Other";
}

const LANDING_LABELS: Record<string, string> = {
  lms: "Last Man Standing",
  predictions: "Lawro",
};

// "/" renders the group's primary game, so label it as that game when known.
function visitLabel(e: ActivityEvent): string {
  let subPath: string | null = null;
  try {
    subPath = e.details ? JSON.parse(e.details)?.subPath ?? null : null;
  } catch {
    subPath = null;
  }
  const root = (e.landingGame && LANDING_LABELS[e.landingGame]) || "Home";
  return prettifyPath(e.path, subPath, root);
}

// A speculative/passive visit is one the person didn't actively make — a browser
// prefetch/prerender, or the app's tab being brought back to the foreground — the
// server tags these in the visit `details`. They're hidden from the feed by
// default (see the "Show passive visits" toggle).
function isSpeculativeEvent(e: ActivityEvent): boolean {
  if (!e.details) return false;
  try {
    return JSON.parse(e.details)?.speculative === true;
  } catch {
    return false;
  }
}

// Same shape as AuditPage's UA parser. Kept inline to keep the page
// self-contained.
function parseUserAgent(ua: string | null): {
  device: string;
  os: string;
  browser: string;
} {
  if (!ua) return { device: "?", os: "?", browser: "?" };
  let device = "Desktop";
  if (/Mobi|Android|iPhone|iPod/.test(ua)) device = "Mobile";
  else if (/iPad|Tablet/.test(ua)) device = "Tablet";
  let os = "Unknown OS";
  if (/iPhone OS (\d+)_(\d+)/.test(ua)) {
    const m = ua.match(/iPhone OS (\d+)_(\d+)/);
    os = `iOS ${m?.[1]}.${m?.[2]}`;
  } else if (/iPad; CPU OS (\d+)_(\d+)/.test(ua)) {
    const m = ua.match(/CPU OS (\d+)_(\d+)/);
    os = `iPadOS ${m?.[1]}.${m?.[2]}`;
  } else if (/Android (\d+(\.\d+)?)/.test(ua)) {
    os = `Android ${ua.match(/Android (\d+(\.\d+)?)/)?.[1]}`;
  } else if (/Mac OS X (\d+)[._](\d+)/.test(ua)) {
    const m = ua.match(/Mac OS X (\d+)[._](\d+)/);
    os = `macOS ${m?.[1]}.${m?.[2]}`;
  } else if (/Windows NT (\d+\.\d+)/.test(ua)) {
    const ver = ua.match(/Windows NT (\d+\.\d+)/)?.[1] ?? "?";
    const map: Record<string, string> = {
      "10.0": "Windows 10/11",
      "6.3": "Windows 8.1",
      "6.2": "Windows 8",
      "6.1": "Windows 7",
    };
    os = map[ver] ?? `Windows NT ${ver}`;
  } else if (/Linux/.test(ua)) {
    os = "Linux";
  }
  let browser = "Unknown";
  if (/Edg\//.test(ua)) browser = `Edge ${ua.match(/Edg\/(\d+)/)?.[1]}`;
  else if (/OPR\//.test(ua)) browser = `Opera ${ua.match(/OPR\/(\d+)/)?.[1]}`;
  else if (/Chrome\/(\d+)/.test(ua) && !/Edg/.test(ua))
    browser = `Chrome ${ua.match(/Chrome\/(\d+)/)?.[1]}`;
  else if (/Firefox\/(\d+)/.test(ua))
    browser = `Firefox ${ua.match(/Firefox\/(\d+)/)?.[1]}`;
  else if (/Version\/(\d+).*Safari/.test(ua))
    browser = `Safari ${ua.match(/Version\/(\d+)/)?.[1]}`;
  return { device, os, browser };
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Best-effort summary of a path + subPath. "/lms" + "history" reads
// nicer as "Last Man Standing → History". The bare landing route "/" renders whichever
// game is primary for this group, so its label is passed in (rootLabel).
function prettifyPath(
  path: string,
  subPath: string | null | undefined,
  rootLabel: string,
): string {
  const root = (() => {
    switch (path) {
      case "/":
        return rootLabel;
      case "/last-man-standing":
      case "/lms":
        return "Last Man Standing";
      case "/lawro":
      case "/predictions":
        return "Lawro";
      case "/audit":
      case "/admin/audit":
        return "Audit log";
      case "/activity":
      case "/admin/activity":
        return "Activity log";
      case "/switch":
        return "Switch group";
      case "/create":
        return "Create a group";
      case "/group-settings":
        return "Group settings";
      default:
        return path;
    }
  })();
  if (!subPath) return root;
  const subPretty =
    {
      predictions: "Predictions",
      leaderboard: "Leaderboard",
      history: "History",
      rules: "Rules",
      stats: "Stats",
      "stats-results": "Stats: Results",
      "stats-tendencies": "Stats: Tendencies",
      tendencies: "Tendencies",
      table: "Table",
      "stats-random": "Stats: Random",
      "stats-outrights": "Stats: Outrights",
      current: "Live",
      fixtures: "Fixtures",
      pl: "Stats",
    }[subPath] ?? subPath;
  return `${root} → ${subPretty}`;
}

type Session = {
  ipAddress: string;
  userAgent: string | null;
  username: string | null;
  start: Date;
  end: Date;
  city: string | null;
  country: string | null;
  events: ActivityEvent[];
  actions: AuditEvent[];
  // Fine-grained events (ui_event / push_sent) in this session.
  extras: ActivityEvent[];
  // Some rows were logged out but matched to this person by browser.
  inferred: boolean;
};

// Group visits (and picks from the audit log) into sessions: consecutive
// activity from the same user (or, pre-login, the same device) within 30 minutes
// counts as one session. Every visit records the logged-in userId, so sessions
// are keyed by username first and fall back to IP+UA only for anonymous
// (pre-login) visits. Picks are folded in by username, so a session where
// someone made Lawro/LMS picks lists them — even if, say, the page view itself
// was hidden as passive.
type FeedItem = { t: number; visit?: ActivityEvent; action?: AuditEvent; extra?: ActivityEvent };

const sessionName = (e: ActivityEvent): string | null => e.username ?? e.likelyUsername ?? null;

function groupIntoSessions(allEvents: ActivityEvent[], actions: AuditEvent[] = []): Session[] {
  const GAP_MS = 30 * 60 * 1000;
  const events = allEvents.filter((e) => !isAttachOnly(e));
  const attachOnly = allEvents.filter(isAttachOnly);
  const byKey = new Map<string, FeedItem[]>();
  const add = (key: string, item: FeedItem) => {
    const arr = byKey.get(key) ?? [];
    arr.push(item);
    byKey.set(key, arr);
  };
  for (const e of events) {
    const name = sessionName(e);
    const key = name ? `u:${name}` : `anon:${e.ipAddress}|${e.userAgent ?? ""}`;
    const t = new Date(e.createdAt).getTime();
    add(key, isVisit(e) ? { t, visit: e } : { t, extra: e });
  }
  for (const a of actions) {
    add(`u:${a.username}`, { t: new Date(a.createdAt).getTime(), action: a });
  }

  const sessions: Session[] = [];
  for (const arr of Array.from(byKey.values())) {
    // Ascending by time inside the key for the gap walk.
    arr.sort((a, b) => a.t - b.t);
    let current: Session | null = null;
    for (const item of arr) {
      const src = (item.visit ?? item.extra ?? item.action)!;
      if (!current || item.t - current.end.getTime() > GAP_MS) {
        if (current) sessions.push(current);
        current = {
          ipAddress: src.ipAddress,
          userAgent: src.userAgent,
          username: item.action ? item.action.username : sessionName((item.visit ?? item.extra)!),
          city: src.city,
          country: src.country,
          start: new Date(item.t),
          end: new Date(item.t),
          events: [],
          actions: [],
          extras: [],
          inferred: false,
        };
      } else {
        current.end = new Date(item.t);
      }
      const row = item.visit ?? item.extra;
      if (row && !row.username && row.likelyUsername) current.inferred = true;
      if (item.visit) current.events.push(item.visit);
      else if (item.extra) current.extras.push(item.extra);
      else if (item.action) current.actions.push(item.action);
    }
    if (current) sessions.push(current);
  }

  // A reminder sent (or swiped away) belongs to the session it led to: the one
  // starting within 30 minutes after it, or running at the time.
  for (const e of attachOnly) {
    const name = sessionName(e);
    if (!name) continue;
    const t = new Date(e.createdAt).getTime();
    const match = sessions.find(
      (s) => s.username === name && t >= s.start.getTime() - GAP_MS && t <= s.end.getTime(),
    );
    if (match) match.extras.push(e);
  }

  // Newest sessions first.
  sessions.sort((a, b) => b.end.getTime() - a.end.getTime());
  return sessions;
}

// The routes that render the same page "/" shows when that game is the
// group's landing game (e.g. in a Lawro-only group, "/" and "/lawro" are both
// just "opened the app").
const LANDING_GAME_PATHS: Record<string, string[]> = {
  predictions: ["/lawro", "/predictions"],
  lms: ["/lms", "/last-man-standing"],
};

// A visit that only opened the landing page: the bare "/" route, or the
// landing game's own route (the PWA reopens on whichever route it was left on,
// and push links go to /lawro) — with no sub-tab such as Leaderboard/Stats.
function isLandingVisit(e: ActivityEvent): boolean {
  let subPath: string | null = null;
  try {
    subPath = e.details ? JSON.parse(e.details)?.subPath ?? null : null;
  } catch {
    subPath = null;
  }
  if (subPath) return false;
  const path = e.path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (path === "/") return true;
  return !!e.landingGame && (LANDING_GAME_PATHS[e.landingGame] ?? []).includes(path);
}

// A session that only ever opened the landing page (no other page, no picks) —
// the "only opened the landing page" filter.
function isLandingOnly(s: Session): boolean {
  // Using the wheel, fixtures or a chart counts as doing something.
  const interacted = s.extras.some((e) => {
    const ev = uiEventName(e);
    return ev === "wheel_view" || ev === "fixture_select" || ev === "chart_interaction";
  });
  return !interacted && s.actions.length === 0 && s.events.length > 0 && s.events.every(isLandingVisit);
}

// The public sign-up page (/create) is visited logged out; those sessions are
// shown even though other logged-out visits aren't.
const isPublicPageVisit = (e: ActivityEvent) => /^\/create\/?$/i.test(e.path?.split(/[?#]/)[0] ?? "");

// Time spent with the app in the background during a session.
function awayMs(s: Session): number {
  return s.extras.reduce((sum, e) => {
    if (uiEventName(e) !== "app_visible") return sum;
    const ms = Number(parseDetails(e).awayMs);
    return Number.isFinite(ms) && ms > 0 ? sum + ms : sum;
  }, 0);
}

function formatClock(iso: string | Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

type TimelineRow = { t: number; icon: string; text: string; tone?: "muted" | "pick" | "alert" };

// The session's exact flow, oldest first: pages and tabs, background /
// foreground switches, wheel/fixtures/chart use, reminders, picks/settings.
function buildTimeline(s: Session): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let lastVisit: { label: string; t: number } | null = null;
  const visits = s.events.slice().sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  for (const e of visits) {
    const t = new Date(e.createdAt).getTime();
    const d = parseDetails(e);
    const label = visitLabel(e);
    const loggedOut = !e.username && e.likelyUsername ? " (logged out)" : "";
    // The server's page load and the client's navigation record land within a
    // second or two of each other — show one.
    if (lastVisit && lastVisit.label === label && t - lastVisit.t < 5000) continue;
    lastVisit = { label, t };
    if (e.type === "tab_view") {
      rows.push({ t, icon: "→", text: `Tab: ${label}${loggedOut}` });
    } else if (d.trigger === "foreground") {
      rows.push({ t, icon: "↩", text: `Re-opened on ${label}${loggedOut}`, tone: "muted" });
    } else if (d.speculative) {
      rows.push({ t, icon: "·", text: `Browser preloaded ${label}${loggedOut}`, tone: "muted" });
    } else {
      rows.push({ t, icon: "▸", text: `Opened ${label}${loggedOut}` });
    }
  }
  for (const e of s.extras) {
    const t = new Date(e.createdAt).getTime();
    const d = parseDetails(e);
    if (e.type === "push_sent") {
      rows.push({ t, icon: "🔔", text: `Was sent a ${describePushTag(d.tag)}`, tone: "alert" });
      continue;
    }
    const ev = String(d.event ?? "");
    const icon =
      ev === "app_hidden" ? "⏸" : ev === "app_visible" ? "▶" : ev === "wheel_view" ? "🎡" : ev === "fixture_select" ? "📅"
        : ev === "chart_interaction" ? "📊" : ev === "push_opened" || ev === "push_dismissed" ? "🔔" : ev === "setting_changed" ? "⚙" : "•";
    rows.push({
      t,
      icon,
      text: describeClientEvent(ev, d),
      tone: ev === "app_hidden" || ev === "app_visible" ? "muted" : ev.startsWith("push_") ? "alert" : undefined,
    });
  }
  for (const a of s.actions) {
    rows.push({
      t: new Date(a.createdAt).getTime(),
      icon: auditCategory(a.type) === "settings" ? "⚙" : "✎",
      text: `${a.groupName ? `[${a.groupName}] ` : ""}${a.summary}`,
      tone: "pick",
    });
  }
  return rows.sort((a, b) => a.t - b.t);
}

export default function ActivityPage() {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("adminApiKey") || "");
  // If a key is already stored, skip the gate — the server still enforces it.
  const [authed, setAuthed] = useState(() => !!localStorage.getItem("adminApiKey"));
  const [keyError, setKeyError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number | null> | null>(null);
  const [playerQuery, setPlayerQuery] = useState("");
  // Both tickboxes start ticked: passive visits shown, and
  // sessions that only opened the landing page hidden.
  const [showPrefetch, setShowPrefetch] = useState(true);
  const [hideHomeOnly, setHideHomeOnly] = useState(true);

  const { data: events, isLoading, error } = useQuery<ActivityEvent[]>({
    queryKey: ["/api/admin/activity", apiKey],
    enabled: authed,
    queryFn: async () => {
      const res = await fetch("/api/admin/activity", { headers: { "x-api-key": apiKey } });
      if (res.status === 401) {
        setKeyError("Invalid admin password");
        setAuthed(false);
        throw new Error("Invalid admin key");
      }
      if (!res.ok) throw new Error("Failed to load activity");
      return res.json();
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  // Picks/changes (Lawro, LMS) — folded into the session they happened in.
  // Best-effort: if this fails the feed still shows visits.
  const { data: auditEvents } = useQuery<AuditEvent[]>({
    queryKey: ["/api/admin/audit", apiKey],
    enabled: authed,
    queryFn: async () => {
      const res = await fetch("/api/admin/audit", { headers: { "x-api-key": apiKey } });
      if (!res.ok) throw new Error("Failed to load picks");
      return res.json();
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  // Group filter options, derived from the loaded events (null = no group).
  const groupOptions = useMemo(() => {
    const m = new Map<number | null, string>();
    for (const e of events ?? []) m.set(e.groupId, e.groupName ?? "No group");
    for (const a of auditEvents ?? []) if (!m.has(a.groupId)) m.set(a.groupId, a.groupName ?? "No group");
    return Array.from(m.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [events, auditEvents]);
  const effectiveSelected = selected ?? new Set(groupOptions.map((o) => o.id));

  // Distinct players (logged-in usernames) for the search datalist.
  const playerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of events ?? []) if (e.username) set.add(e.username);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [events]);

  const filteredEvents = useMemo(
    // Static-file rows (e.g. /icons/logo.webp) were logged as visits before the
    // server learned to skip them; never show them.
    () => (events ?? []).filter((e) => effectiveSelected.has(e.groupId) && !(e.path && isStaticAssetPath(e.path))),
    [events, effectiveSelected],
  );

  const query = playerQuery.trim().toLowerCase();

  // How many speculative (prefetch/prerender) visits are being hidden right now,
  // counting only ones that would otherwise be visible (a logged-in player who
  // isn't you, or whoever matches the search) — so the toggle shows a real number.
  const hiddenPrefetchCount = useMemo(() => {
    if (showPrefetch) return 0;
    return filteredEvents.filter((e) => {
      if (!isSpeculativeEvent(e)) return false;
      if (e.username == null) return false;
      return query ? e.username.toLowerCase().includes(query) : !isOwnUsername(e.username);
    }).length;
  }, [filteredEvents, query, showPrefetch]);

  // Feed events: drop speculative visits unless the toggle is on.
  const displayEvents = useMemo(
    () => (showPrefetch ? filteredEvents : filteredEvents.filter((e) => !isSpeculativeEvent(e))),
    [filteredEvents, showPrefetch],
  );

  // Picks from the same window the visits cover (the server sends 14 days).
  // Rule acknowledgements belong on /audit and aren't picks.
  const filteredActions = useMemo(() => {
    const since = Date.now() - 14 * 24 * 60 * 60 * 1000;
    return (auditEvents ?? []).filter(
      (a) => a.type !== "rule_change_acknowledged" &&
        // Reminders and wheel/fixtures/chart use come straight from the activity feed.
        !isActivityFeedAuditType(a.type) &&
        effectiveSelected.has(a.groupId) && new Date(a.createdAt).getTime() >= since,
    );
  }, [auditEvents, effectiveSelected]);

  const sessions = useMemo(
    () => groupIntoSessions(displayEvents, filteredActions),
    [displayEvents, filteredActions],
  );
  // Not-logged-in visits are always hidden. Your own activity is hidden by
  // default; searching a player name (e.g. "Alex") shows whoever matches,
  // which is how you surface your own activity again.
  const visibleSessions = useMemo(
    () =>
      sessions.filter((s) => {
        // Logged-out visitors are only shown for the public sign-up page.
        if (s.username == null) return !query && s.events.some(isPublicPageVisit);
        const nameOk = query ? s.username.toLowerCase().includes(query) : !isOwnUsername(s.username);
        if (!nameOk) return false;
        // Optional: drop sessions that only opened the landing page.
        if (hideHomeOnly && isLandingOnly(s)) return false;
        return true;
      }),
    [sessions, query, hideHomeOnly],
  );

  const deleteEntries = async (ids: number[]) => {
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} ${ids.length === 1 ? "entry" : "entries"}?`)) return;
    await fetch("/api/admin/activity/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ ids }),
    }).catch(() => {});
    queryClient.invalidateQueries({ queryKey: ["/api/admin/activity", apiKey] });
  };

  if (!authed) {
    return (
      <AdminGate
        apiKey={apiKey}
        setApiKey={setApiKey}
        onSubmit={() => {
          setKeyError(null);
          setAuthed(true);
        }}
        title="Activity log"
        error={keyError}
      />
    );
  }

  return (
    <AdminLayout>
        <div className="mb-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <AdminPageTitle title="Activity log">
              <p>
                Every visit and pick across all groups. One row per session (consecutive
                activity from the same person within 30 mins), attributed to
                whoever was logged in. Most recently active first (the leading
                time is the session's last activity).
              </p>
              <p>{LOCATION_HINT}</p>
              <p>
                Your own activity and not-logged-in visits are hidden by default — search a player (e.g. Alex) to show theirs.
                Logged-out visits to the public PL predictions page are always shown, under the person whose browser it was when we can tell.
              </p>
              <p>
                Open a session's timeline to see its exact flow: every page and tab with the time, when the app was put in the
                background and brought back, wheel/fixtures/chart use, reminders sent or opened, and picks or settings changed.
                "Active" is the session's length minus time in the background.
              </p>
              </AdminPageTitle>
            </div>
            <GroupMultiSelect options={groupOptions} selected={effectiveSelected} onChange={setSelected} />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input
              type="search"
              list="activity-players"
              value={playerQuery}
              onChange={(e) => setPlayerQuery(e.target.value)}
              placeholder="Filter by player…"
              className="w-full sm:w-64 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <datalist id="activity-players">
              {playerOptions.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            {playerQuery && (
              <button
                type="button"
                onClick={() => setPlayerQuery("")}
                className="text-sm text-gray-500 hover:text-gray-800"
              >
                Clear
              </button>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={showPrefetch}
                onChange={(e) => setShowPrefetch(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-gray-300"
              />
              Show passive visits (prefetch / app re-opened in background)
            </label>
            {!showPrefetch && hiddenPrefetchCount > 0 && (
              <span className="text-gray-400">
                ({hiddenPrefetchCount} passive {hiddenPrefetchCount === 1 ? "visit" : "visits"} hidden — browser prefetches and tabs brought back to the foreground, not visits the person actively made)
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={hideHomeOnly}
                onChange={(e) => setHideHomeOnly(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-gray-300"
              />
              Hide sessions that only opened the landing page (no picks)
            </label>
          </div>
        </div>

        {isLoading && (
          <div className="bg-card rounded-md border p-6 text-sm text-gray-500">
            Loading…
          </div>
        )}
        {error && (
          <div className="bg-card rounded-md border border-red-200 p-6 text-sm text-red-700">
            {(error as Error).message}
          </div>
        )}
        {events && events.length === 0 && (
          <div className="bg-card rounded-md border p-6 text-sm text-gray-500">
            No visits recorded yet.
          </div>
        )}
        {events && events.length > 0 && visibleSessions.length === 0 && (
          <div className="bg-card rounded-md border p-6 text-sm text-gray-500">
            {query ? `No visits from a player matching "${playerQuery.trim()}".` : "No visits from anyone else (your own activity is hidden)."}
          </div>
        )}
        {visibleSessions.length > 0 && (
          <div className="space-y-3">
            {visibleSessions.map((s, i) => {
              const ua = parseUserAgent(s.userAgent);
              const duration = s.end.getTime() - s.start.getTime();
              const away = Math.min(awayMs(s), duration);
              const timeline = buildTimeline(s);
              const extraCounts = new Map<string, number>();
              for (const e of s.extras) {
                const ev = uiEventName(e);
                const chip =
                  ev === "wheel_view" ? "🎡 Wheel" : ev === "fixture_select" ? "📅 Fixtures" : ev === "chart_interaction" ? "📊 Charts"
                    : ev === "push_opened" ? "🔔 Opened from reminder" : null;
                if (chip) extraCounts.set(chip, (extraCounts.get(chip) ?? 0) + 1);
              }
              const uniquePages = Array.from(new Set(s.events.slice().reverse().map(visitLabel)));
              // "Lawro: 10 picks", "LMS: 1 pick" — newest-first list underneath.
              const actionCounts = new Map<string, number>();
              for (const a of s.actions) actionCounts.set(actionGame(a), (actionCounts.get(actionGame(a)) ?? 0) + 1);
              const actionsNewestFirst = s.actions.slice().reverse();
              const groupNames = Array.from(
                new Set([...s.events.map((e) => e.groupName), ...s.actions.map((a) => a.groupName)].filter(Boolean)),
              );
              return (
                <div
                  key={`${s.username ?? s.ipAddress}-${s.start.getTime()}-${i}`}
                  className="bg-card rounded-md border p-3"
                  data-testid="activity-session"
                >
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {s.username ? (
                        <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-sm font-semibold text-primary">
                          👤 {s.username}
                        </span>
                      ) : (
                        <span
                          title="No one was logged in for this session"
                          className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-sm font-medium text-gray-500"
                        >
                          👤 Not logged in
                        </span>
                      )}
                      {s.inferred && (
                        <span
                          title="Some of this session was logged out; it's matched to this person because the same browser was logged in as them"
                          className="rounded bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500"
                        >
                          logged out
                        </span>
                      )}
                      {groupNames.map((g) => (
                        <span key={g as string} className="rounded bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                          {g}
                        </span>
                      ))}
                      {showPrefetch && s.events.length > 0 && s.actions.length === 0 && s.events.every(isSpeculativeEvent) && (
                        <span
                          title="Passive visit — a browser prefetch or the tab brought back to the foreground, not a visit the person actively made"
                          className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700"
                        >
                          passive
                        </span>
                      )}
                    </div>
                    {s.events.length + s.extras.length > 0 && (
                    <button
                      type="button"
                      onClick={() => deleteEntries([...s.events, ...s.extras].map((e) => e.id))}
                      aria-label="Delete these entries"
                      title="Delete these entries"
                      className="shrink-0 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-gray-500">
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {/* Lead with the last-activity time so the row matches the
                          feed's most-recently-active-first ordering. */}
                      <span className="font-medium text-gray-800">
                        {formatTime(s.end.toISOString())}
                      </span>
                      {formatTime(s.start.toISOString()) !== formatTime(s.end.toISOString()) && (
                        <span>· started {formatTime(s.start.toISOString())}</span>
                      )}
                      {duration > 0 && <span>· {formatDuration(duration)}</span>}
                      {duration > 0 && away > 0 && (
                        <span data-testid="activity-active-time">· active {formatDuration(duration - away)}</span>
                      )}
                      {s.events.length > 0 && (
                        <span>· {s.events.length} {s.events.length === 1 ? "view" : "views"}</span>
                      )}
                    </div>
                    <div className="text-right">
                      <span className="text-gray-700">
                        {describeLocation(s.ipAddress, s.city, s.country)}
                      </span>
                      <span className="text-gray-400 ml-2">{s.ipAddress}</span>
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] text-gray-500 flex flex-wrap gap-x-3">
                    <span>{ua.device}</span>
                    <span>· {ua.os}</span>
                    <span>· {ua.browser}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {uniquePages.map((p, j) => (
                      <span
                        key={`${p}-${j}`}
                        className="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700"
                      >
                        {p}
                      </span>
                    ))}
                    {Array.from(actionCounts.entries()).map(([game, n]) => (
                      <span
                        key={`act-${game}`}
                        data-testid="activity-pick-count"
                        className="inline-flex items-center rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800"
                      >
                        {game === "Settings" ? `⚙ Settings: ${n} ${n === 1 ? "change" : "changes"}` : `✎ ${game}: ${n} ${n === 1 ? "pick" : "picks"}`}
                      </span>
                    ))}
                    {Array.from(extraCounts.entries()).map(([chip, n]) => (
                      <span
                        key={`extra-${chip}`}
                        data-testid="activity-usage-chip"
                        className="inline-flex items-center rounded bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-800"
                      >
                        {chip}{n > 1 ? ` ×${n}` : ""}
                      </span>
                    ))}
                  </div>
                  {actionsNewestFirst.length > 0 && (
                    <details className="mt-2 text-[11px] text-gray-600">
                      <summary className="cursor-pointer select-none text-gray-500 hover:text-gray-800">
                        Show {actionsNewestFirst.length === 1 ? "pick" : "picks"}
                      </summary>
                      <ul className="mt-1 space-y-0.5" data-testid="activity-pick-list">
                        {actionsNewestFirst.map((a) => (
                          <li key={a.id} className="flex gap-2">
                            <span className="shrink-0 tabular-nums text-gray-400">
                              {new Intl.DateTimeFormat("en-GB", {
                                timeZone: "Europe/London",
                                hour: "2-digit",
                                minute: "2-digit",
                                hour12: false,
                              }).format(new Date(a.createdAt))}
                            </span>
                            <span>
                              {/* Name the group the pick was made in ("[Rovers] LMS GW10: picked BHA"). */}
                              {a.groupName && <span className="font-medium text-gray-800">[{a.groupName}] </span>}
                              {a.summary}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {timeline.length > 1 && (
                    <details className="mt-2 text-[11px] text-gray-600">
                      <summary className="cursor-pointer select-none text-gray-500 hover:text-gray-800">
                        Timeline ({timeline.length} {timeline.length === 1 ? "event" : "events"})
                      </summary>
                      <ol className="mt-1 space-y-0.5 border-l border-border pl-2" data-testid="activity-timeline">
                        {timeline.map((r, j) => (
                          <li key={j} className="flex gap-2">
                            <span className="shrink-0 tabular-nums text-gray-400">{formatClock(new Date(r.t))}</span>
                            <span className="w-4 shrink-0 text-center" aria-hidden>{r.icon}</span>
                            <span
                              className={
                                r.tone === "muted"
                                  ? "text-gray-400"
                                  : r.tone === "pick"
                                    ? "font-medium text-emerald-800"
                                    : r.tone === "alert"
                                      ? "text-rose-700"
                                      : "text-gray-700"
                              }
                            >
                              {r.text}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
    </AdminLayout>
  );
}
