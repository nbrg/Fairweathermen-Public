import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { isOwnUsername } from "@/lib/utils";
import { GroupMultiSelect } from "@/components/GroupMultiSelect";
import { AdminGate } from "@/components/AdminGate";
import { AdminNav } from "@/components/AdminNav";

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
};

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

function formatLocation(city: string | null, country: string | null): string {
  const parts = [city, country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Unknown location";
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

// Best-effort summary of a path + subPath. "/lawro" + "leaderboard" reads
// nicer as "Lawro → Leaderboard". The bare landing route "/" renders whichever
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
      case "/golf":
        return "Golf";
      case "/lawro":
      case "/predictions":
        return "Lawro";
      case "/audit":
        return "Audit log";
      case "/activity":
        return "Activity log";
      case "/switch":
        return "Switch group";
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
};

// Group a sorted (desc by createdAt) event stream into sessions: consecutive
// events from the same user (or, pre-login, the same device) within 30 minutes
// count as one session. Now that every visit records the logged-in userId, we
// key sessions by username first and fall back to IP+UA only for anonymous
// (pre-login) visits — so the feed attributes activity to the actual person
// rather than guessing from IP/history.
function groupIntoSessions(events: ActivityEvent[]): Session[] {
  const GAP_MS = 30 * 60 * 1000;
  const byKey = new Map<string, ActivityEvent[]>();
  for (const e of events) {
    const key = e.username
      ? `u:${e.username}`
      : `anon:${e.ipAddress}|${e.userAgent ?? ""}`;
    const arr = byKey.get(key) ?? [];
    arr.push(e);
    byKey.set(key, arr);
  }

  const sessions: Session[] = [];
  for (const arr of Array.from(byKey.values())) {
    // Ensure ascending by time inside the key for the gap walk.
    arr.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    let current: Session | null = null;
    for (const e of arr) {
      const t = new Date(e.createdAt);
      if (!current || t.getTime() - current.end.getTime() > GAP_MS) {
        if (current) sessions.push(current);
        current = {
          ipAddress: e.ipAddress,
          userAgent: e.userAgent,
          username: e.username,
          city: e.city,
          country: e.country,
          start: t,
          end: t,
          events: [e],
        };
      } else {
        current.end = t;
        current.events.push(e);
      }
    }
    if (current) sessions.push(current);
  }

  // Newest sessions first.
  sessions.sort((a, b) => b.end.getTime() - a.end.getTime());
  return sessions;
}

const rootLabel = "Home";

// The distinct, human-readable pages seen in a session (e.g. ["Home", "Lawro"]).
function sessionPages(s: Session): string[] {
  const pages = s.events.map((e) => {
    let subPath: string | null = null;
    try {
      subPath = e.details ? JSON.parse(e.details)?.subPath ?? null : null;
    } catch {
      subPath = null;
    }
    return prettifyPath(e.path, subPath, rootLabel);
  });
  return Array.from(new Set(pages));
}

export default function ActivityPage() {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("adminApiKey") || "");
  // If a key is already stored, skip the gate — the server still enforces it.
  const [authed, setAuthed] = useState(() => !!localStorage.getItem("adminApiKey"));
  const [keyError, setKeyError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number | null> | null>(null);
  const [playerQuery, setPlayerQuery] = useState("");
  // Prefetch/prerender visits the browser made on its own are hidden by default.
  const [showPrefetch, setShowPrefetch] = useState(false);
  // Optional belt-and-braces filter: drop any session whose only page is Home.
  const [hideHomeOnly, setHideHomeOnly] = useState(false);

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

  // Group filter options, derived from the loaded events (null = no group).
  const groupOptions = useMemo(() => {
    const m = new Map<number | null, string>();
    for (const e of events ?? []) m.set(e.groupId, e.groupName ?? "No group");
    return Array.from(m.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [events]);
  const effectiveSelected = selected ?? new Set(groupOptions.map((o) => o.id));

  // Distinct players (logged-in usernames) for the search datalist.
  const playerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of events ?? []) if (e.username) set.add(e.username);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [events]);

  const filteredEvents = useMemo(
    () => (events ?? []).filter((e) => effectiveSelected.has(e.groupId)),
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

  const sessions = useMemo(() => groupIntoSessions(displayEvents), [displayEvents]);
  // Not-logged-in visits are always hidden. Your own activity is hidden by
  // default; searching a player name (e.g. "Alex") shows whoever matches,
  // which is how you surface your own activity again.
  const visibleSessions = useMemo(
    () =>
      sessions.filter((s) => {
        if (s.username == null) return false;
        const nameOk = query ? s.username.toLowerCase().includes(query) : !isOwnUsername(s.username);
        if (!nameOk) return false;
        // Optional: drop sessions whose only page is Home.
        if (hideHomeOnly) {
          const pages = sessionPages(s);
          if (pages.length === 1 && pages[0] === rootLabel) return false;
        }
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
    <div className="min-h-screen bg-gray-100">
      <main className="container mx-auto px-4 py-6">
        <AdminNav />
        <div className="mb-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="text-2xl font-bold text-primary">Activity log</h1>
              <p className="text-sm text-gray-600">
                Every visit across all groups. One row per session (consecutive
                activity from the same person within 30 mins), attributed to
                whoever was logged in. Most recently active first (the leading
                time is the session's last activity).
              </p>
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
          <p className="mt-1 text-xs text-gray-500">
            Your own activity and not-logged-in visits are hidden by default — search a player (e.g. Alex) to show theirs.
          </p>
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
              Hide sessions that only visited Home
            </label>
          </div>
        </div>

        {isLoading && (
          <div className="bg-white rounded-md border p-6 text-sm text-gray-500">
            Loading…
          </div>
        )}
        {error && (
          <div className="bg-white rounded-md border border-red-200 p-6 text-sm text-red-700">
            {(error as Error).message}
          </div>
        )}
        {events && events.length === 0 && (
          <div className="bg-white rounded-md border p-6 text-sm text-gray-500">
            No visits recorded yet.
          </div>
        )}
        {events && events.length > 0 && visibleSessions.length === 0 && (
          <div className="bg-white rounded-md border p-6 text-sm text-gray-500">
            {query ? `No visits from a player matching "${playerQuery.trim()}".` : "No visits from anyone else (your own activity is hidden)."}
          </div>
        )}
        {visibleSessions.length > 0 && (
          <div className="space-y-3">
            {visibleSessions.map((s, i) => {
              const ua = parseUserAgent(s.userAgent);
              const duration = s.end.getTime() - s.start.getTime();
              const pages = s.events
                .slice()
                .reverse()
                .map((e) => {
                  let subPath: string | null = null;
                  try {
                    subPath = e.details ? JSON.parse(e.details)?.subPath ?? null : null;
                  } catch {
                    subPath = null;
                  }
                  return prettifyPath(e.path, subPath, rootLabel);
                });
              const uniquePages = Array.from(new Set(pages));
              return (
                <div
                  key={`${s.username ?? s.ipAddress}-${s.start.getTime()}-${i}`}
                  className="bg-white rounded-md border p-3"
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
                      {Array.from(new Set(s.events.map((e) => e.groupName).filter(Boolean))).map((g) => (
                        <span key={g as string} className="rounded bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                          {g}
                        </span>
                      ))}
                      {showPrefetch && s.events.length > 0 && s.events.every(isSpeculativeEvent) && (
                        <span
                          title="Passive visit — a browser prefetch or the tab brought back to the foreground, not a visit the person actively made"
                          className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700"
                        >
                          passive
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => deleteEntries(s.events.map((e) => e.id))}
                      aria-label="Delete these entries"
                      title="Delete these entries"
                      className="shrink-0 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
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
                      <span>· {s.events.length} views</span>
                    </div>
                    <div className="text-right">
                      <span className="text-gray-700">
                        {formatLocation(s.city, s.country)}
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
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
