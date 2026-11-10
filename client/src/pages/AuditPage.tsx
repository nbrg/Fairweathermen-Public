import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isOwnUsername } from "@/lib/utils";
import { GroupMultiSelect } from "@/components/GroupMultiSelect";
import { AdminGate } from "@/components/AdminGate";
import { describeLocation, LOCATION_HINT } from "@shared/ipLocation";
import { AdminLayout } from "@/components/AdminNav";
import { auditCategory } from "@shared/activityEvents";

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

// Quick-and-dirty User-Agent parser. We can't get an exact model out of a
// modern UA string ("iPhone 17 Pro" isn't in there — Apple deliberately
// stopped including it), so we surface the OS, browser, and device class
// which is what's actually useful for "is this Alex on his phone or some
// other device?"
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
  // Order matters — Edge/Chrome both include "Chrome" in their UA.
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

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

const TYPE_LABEL: Record<string, string> = {
  lms_selection: "LMS",
  prediction_set: "Lawro",
  prediction_change: "Lawro",
  prediction_delete: "Lawro (cleared)",
  rule_change_acknowledged: "Rules",
  // Settings, reminders and feature usage (server/auditExtras.ts).
  settings_rules: "Rules changed",
  player_renamed: "Players",
  player_removed: "Players",
  invite_reset: "Invite link",
  login_code_reset: "Players",
  lms_player_added: "Players",
  lms_player_sat_out: "Players",
  push_enabled: "Reminders on",
  push_disabled: "Reminders off",
  push_lead_changed: "Reminder times",
  setting_changed: "Device setting",
  push_sent: "Reminder sent",
  push_opened: "Reminder opened",
  push_dismissed: "Reminder dismissed",
  wheel_view: "LMS wheel",
  fixture_select: "Fixtures",
  chart_interaction: "Tendencies",
};

// Colour by category for the newer row types.
const CATEGORY_COLOR: Record<string, string> = {
  settings: "bg-sky-100 text-sky-800",
  reminders: "bg-rose-100 text-rose-800",
  usage: "bg-teal-100 text-teal-800",
};

const TYPE_COLOR: Record<string, string> = {
  lms_selection: "bg-blue-100 text-blue-800",
  prediction_set: "bg-amber-100 text-amber-800",
  prediction_change: "bg-amber-100 text-amber-800",
  prediction_delete: "bg-gray-100 text-gray-600",
  rule_change_acknowledged: "bg-indigo-100 text-indigo-800",
};

// The game filter: which event types each option shows.
const GAME_FILTERS: { value: string; label: string; match: (type: string) => boolean }[] = [
  { value: "all", label: "All events", match: () => true },
  { value: "lms", label: "LMS", match: (t) => t === "lms_selection" },
  { value: "lawro", label: "Lawro", match: (t) => t.startsWith("prediction_") },
  { value: "rules", label: "Rules", match: (t) => t === "rule_change_acknowledged" || t === "settings_rules" },
  { value: "settings", label: "Settings", match: (t) => auditCategory(t) === "settings" },
  { value: "reminders", label: "Reminders", match: (t) => auditCategory(t) === "reminders" },
  { value: "usage", label: "Wheel / Fixtures / Charts", match: (t) => auditCategory(t) === "usage" },
];

export default function AuditPage() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("adminApiKey") || "");
  const [authed, setAuthed] = useState(() => !!localStorage.getItem("adminApiKey"));
  const [keyError, setKeyError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number | null> | null>(null);
  const [playerQuery, setPlayerQuery] = useState("");
  const [game, setGame] = useState("all");

  const { data: events, isLoading, error } = useQuery<AuditEvent[]>({
    queryKey: ["/api/admin/audit", apiKey],
    enabled: authed,
    queryFn: async () => {
      const res = await fetch("/api/admin/audit", { headers: { "x-api-key": apiKey } });
      if (res.status === 401) {
        setKeyError("Invalid admin password");
        setAuthed(false);
        throw new Error("Invalid admin key");
      }
      if (!res.ok) throw new Error("Failed to load audit");
      return res.json();
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const groupOptions = useMemo(() => {
    const m = new Map<number | null, string>();
    for (const e of events ?? []) m.set(e.groupId, e.groupName ?? "No group");
    return Array.from(m.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [events]);
  const effectiveSelected = selected ?? new Set(groupOptions.map((o) => o.id));

  // Distinct players for the search datalist.
  const playerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of events ?? []) if (e.username) set.add(e.username);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [events]);

  const query = playerQuery.trim().toLowerCase();
  // Your own actions are hidden by default; searching a player name (e.g.
  // "Alex") shows whoever matches, which is how you surface your own again.
  const visibleEvents = useMemo(() => {
    const gameFilter = GAME_FILTERS.find((f) => f.value === game) ?? GAME_FILTERS[0];
    let list = (events ?? []).filter((e) => effectiveSelected.has(e.groupId) && gameFilter.match(e.type));
    list = query
      ? list.filter((e) => (e.username ?? "").toLowerCase().includes(query))
      : list.filter((e) => !isOwnUsername(e.username));
    return list;
  }, [events, effectiveSelected, query, game]);

  if (!authed) {
    return (
      <AdminGate
        apiKey={apiKey}
        setApiKey={setApiKey}
        onSubmit={() => {
          setKeyError(null);
          setAuthed(true);
        }}
        title="Audit log"
        error={keyError}
      />
    );
  }

  return (
    <AdminLayout>
        <div className="mb-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h1 className="text-2xl font-bold text-primary">Audit log</h1>
              <p className="text-sm text-gray-600">
                Every pick and change across all groups, plus rule-change acknowledgements, settings changes (rules, reminders, players,
                theme), reminders sent/opened/dismissed, and LMS wheel, Fixtures and Tendencies chart use. Newest first. Refreshes every 30s.
              </p>
              <p className="mt-1 text-xs text-gray-500">{LOCATION_HINT}</p>
            </div>
            <GroupMultiSelect options={groupOptions} selected={effectiveSelected} onChange={setSelected} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              aria-label="Filter by game"
              value={game}
              onChange={(e) => setGame(e.target.value)}
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm bg-card focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {GAME_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <input
              type="search"
              list="audit-players"
              value={playerQuery}
              onChange={(e) => setPlayerQuery(e.target.value)}
              placeholder="Filter by player…"
              className="w-full sm:w-64 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <datalist id="audit-players">
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
            Your own actions are hidden by default — search a player (e.g. Alex) to show theirs.
          </p>
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
            No audit activity recorded yet.
          </div>
        )}
        {events && events.length > 0 && visibleEvents.length === 0 && (
          <div className="bg-card rounded-md border p-6 text-sm text-gray-500">
            {query ? `No activity from a player matching "${playerQuery.trim()}".` : "No activity from anyone else (your own activity is hidden)."}
          </div>
        )}
        {visibleEvents.length > 0 && (
          <div className="bg-card rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <tr>
                  <th className="text-left p-2 font-medium whitespace-nowrap">When</th>
                  <th className="text-left p-2 font-medium">Type</th>
                  <th className="text-left p-2 font-medium">Group</th>
                  <th className="text-left p-2 font-medium">Player</th>
                  <th className="text-left p-2 font-medium">Action</th>
                  <th className="text-left p-2 font-medium whitespace-nowrap">Location</th>
                  <th className="text-left p-2 font-medium whitespace-nowrap">Device</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visibleEvents.map((e) => {
                  const ua = parseUserAgent(e.userAgent);
                  return (
                    <tr key={e.id}>
                      <td className="p-2 text-xs text-gray-700 tabular-nums whitespace-nowrap">
                        {formatDateTime(e.createdAt)}
                      </td>
                      <td className="p-2">
                        <span
                          className={`inline-flex items-center whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-medium ${
                            TYPE_COLOR[e.type] ?? CATEGORY_COLOR[auditCategory(e.type)] ?? "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {TYPE_LABEL[e.type] ?? e.type}
                        </span>
                      </td>
                      <td className="p-2 text-xs text-gray-600 whitespace-nowrap">
                        {e.groupName ?? "—"}
                      </td>
                      <td className="p-2 text-gray-900 font-medium whitespace-nowrap">
                        {e.username}
                      </td>
                      <td className="p-2 text-gray-700">
                        <div>{e.summary}</div>
                      </td>
                      <td className="p-2 text-xs text-gray-600 whitespace-nowrap">
                        <div>{describeLocation(e.ipAddress, e.city, e.country)}</div>
                        <div className="text-gray-400">{e.ipAddress}</div>
                      </td>
                      <td className="p-2 text-xs text-gray-600 whitespace-nowrap">
                        <div>{ua.device}</div>
                        <div className="text-gray-500">{ua.os}</div>
                        <div className="text-gray-400">{ua.browser}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </AdminLayout>
  );
}
