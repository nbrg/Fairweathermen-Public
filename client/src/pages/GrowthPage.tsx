import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isOwnUsername } from "@/lib/utils";
import { AdminGate } from "@/components/AdminGate";
import { AdminNav } from "@/components/AdminNav";

type GrowthEvent = {
  id: number;
  type: string;
  userId: number | null;
  username: string | null;
  ipAddress: string;
  userAgent: string | null;
  city: string | null;
  country: string | null;
  path: string | null;
  details: string | null;
  groupId: number | null;
  groupName: string | null;
  createdAt: string;
};

type GroupRow = {
  id: number;
  name: string;
  createdAt: string;
  enabledGames: string[];
  admin: string | null;
  players: number;
};

type GrowthData = { days: number; events: GrowthEvent[]; groups: GroupRow[] };

type Details = {
  vid?: string | null;
  landingPath?: string;
  referrer?: string | null;
  utm?: Record<string, string>;
  groupName?: string;
  adminName?: string;
  name?: string;
  games?: string[];
  rejoin?: boolean;
  groupCount?: number;
};

function parseDetails(e: GrowthEvent): Details {
  if (!e.details) return {};
  try {
    return JSON.parse(e.details) ?? {};
  } catch {
    return {};
  }
}

const RANGES = [7, 30, 90] as const;

const TYPE_META: Record<string, { label: string; emoji: string; tone: string }> = {
  new_visitor: { label: "New visitor", emoji: "👋", tone: "bg-sky-100 text-sky-800" },
  invite_opened: { label: "Opened invite", emoji: "✉️", tone: "bg-violet-100 text-violet-800" },
  group_created: { label: "Created group", emoji: "🎉", tone: "bg-emerald-100 text-emerald-800" },
  group_joined: { label: "Joined group", emoji: "➕", tone: "bg-emerald-50 text-emerald-700" },
  login: { label: "Logged in", emoji: "🔑", tone: "bg-gray-100 text-gray-700" },
  login_failed: { label: "Failed login", emoji: "⚠️", tone: "bg-amber-100 text-amber-800" },
};

const GAME_LABEL: Record<string, string> = {
  lms: "LMS",
  predictions: "Lawro",
};

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

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  let os = "";
  if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Linux/.test(ua)) os = "Linux";
  let browser = "";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua)) browser = "Opera";
  else if (/Chrome\//.test(ua) && !/Edg/.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari/.test(ua)) browser = "Safari";
  return [os, browser].filter(Boolean).join(" · ") || "Device";
}

// "https://www.google.com/search?q=…" → "google.com"; same-site referrers are
// internal navigations, not a source.
function referrerLabel(ref: string | null | undefined): string {
  if (!ref) return "Direct / unknown";
  try {
    const host = new URL(ref).hostname.replace(/^www\./, "");
    if (host === window.location.hostname.replace(/^www\./, "")) return "Direct / unknown";
    return host;
  } catch {
    return ref;
  }
}

// One-line description of what happened, e.g. "Frank created Sunday League".
function describe(e: GrowthEvent, d: Details): string {
  const who = e.username ?? d.name ?? d.adminName ?? "Someone";
  const group = e.groupName ?? d.groupName ?? "a group";
  switch (e.type) {
    case "new_visitor": {
      const landing = d.landingPath ?? e.path ?? "/";
      const src = referrerLabel(d.referrer);
      const utm = d.utm?.utm_source ? ` (utm: ${d.utm.utm_source})` : "";
      return `Landed on ${landing} from ${src}${utm}`;
    }
    case "invite_opened":
      return e.username ? `${e.username} opened the invite to ${group}` : `Invite to ${group} opened`;
    case "group_created": {
      const games = (d.games ?? []).map((g) => GAME_LABEL[g] ?? g).join(" + ");
      return `${who} created ${group}${games ? ` (${games})` : ""}`;
    }
    case "group_joined":
      return d.rejoin ? `${who} re-opened their ${group} invite` : `${who} joined ${group}`;
    case "login":
      return `${who} logged in${e.groupName ? ` to ${e.groupName}` : ""}`;
    case "login_failed":
      return "Wrong login code entered";
    default:
      return e.type;
  }
}

export default function GrowthPage() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("adminApiKey") || "");
  const [authed, setAuthed] = useState(() => !!localStorage.getItem("adminApiKey"));
  const [keyError, setKeyError] = useState<string | null>(null);
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  // Logins dominate the feed, so they're off unless asked for.
  const [showLogins, setShowLogins] = useState(false);

  // Always fetch the widest window; the range buttons filter client-side.
  const { data, isLoading, error } = useQuery<GrowthData>({
    queryKey: ["/api/admin/growth", apiKey],
    enabled: authed,
    queryFn: async () => {
      const res = await fetch("/api/admin/growth?days=90", { headers: { "x-api-key": apiKey } });
      if (res.status === 401) {
        setKeyError("Invalid admin password");
        setAuthed(false);
        throw new Error("Invalid admin key");
      }
      if (!res.ok) throw new Error("Failed to load growth data");
      return res.json();
    },
    refetchInterval: 60_000,
    staleTime: 15_000,
  });

  // Events in the chosen window, minus your own logins and invite opens (you'd
  // otherwise dominate those counts). Groups created/joined under your name are
  // always kept, so one made by someone else typing your name still shows.
  const inRange = useMemo(() => {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    return (data?.events ?? []).filter(
      (e) =>
        new Date(e.createdAt).getTime() >= since &&
        !(isOwnUsername(e.username) && (e.type === "login" || e.type === "invite_opened")),
    );
  }, [data, days]);

  const stats = useMemo(() => {
    const uniq = (xs: (string | number | null | undefined)[]) =>
      new Set(xs.filter((x) => x != null && x !== "")).size;
    const of = (t: string) => inRange.filter((e) => e.type === t);
    const visitors = of("new_visitor");
    const invites = of("invite_opened");
    const joins = of("group_joined").filter((e) => !parseDetails(e).rejoin);
    const created = of("group_created");
    const logins = of("login");
    // How many of the window's new visitors went on to create or join a group.
    const newVids = new Set(visitors.map((e) => parseDetails(e).vid).filter(Boolean));
    const convertedVids = new Set(
      [...created, ...joins].map((e) => parseDetails(e).vid).filter((v) => v && newVids.has(v)),
    );
    return {
      new_visitor: visitors.length,
      invite_opened: uniq(invites.map((e) => parseDetails(e).vid ?? e.ipAddress)),
      group_created: created.length,
      group_joined: joins.length,
      login: uniq(logins.map((e) => e.username)),
      login_failed: of("login_failed").length,
      converted: convertedVids.size,
    };
  }, [inRange]);

  const feed = useMemo(
    () =>
      inRange.filter((e) =>
        typeFilter ? e.type === typeFilter : showLogins || e.type !== "login",
      ),
    [inRange, typeFilter, showLogins],
  );

  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const newGroups = (data?.groups ?? []).filter((g) => new Date(g.createdAt).getTime() >= sinceMs);

  if (!authed) {
    return (
      <AdminGate
        apiKey={apiKey}
        setApiKey={setApiKey}
        onSubmit={() => {
          setKeyError(null);
          setAuthed(true);
        }}
        title="Growth"
        error={keyError}
      />
    );
  }

  const STAT_META: { key: string; label: string; n: number }[] = [
    { key: "new_visitor", label: "New visitors", n: stats.new_visitor },
    { key: "invite_opened", label: "Invites opened", n: stats.invite_opened },
    { key: "group_created", label: "Groups created", n: stats.group_created },
    { key: "group_joined", label: "Players joined", n: stats.group_joined },
    { key: "login", label: "People logged in", n: stats.login },
    { key: "login_failed", label: "Failed logins", n: stats.login_failed },
  ];

  return (
    <div className="min-h-screen bg-gray-100">
      <main className="container mx-auto max-w-4xl px-4 py-6">
        <AdminNav />
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold text-primary">Growth</h1>
            <p className="mt-1 text-sm text-gray-600">
              New people arriving, invite links opened, groups created and players
              joining, across all groups. Your own logins are left out.
            </p>
          </div>
          <div className="inline-flex gap-1 rounded-lg border bg-white p-1">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setDays(r)}
                className={`rounded-md px-3 py-1 text-sm font-medium ${
                  days === r ? "bg-primary text-white" : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                {r}d
              </button>
            ))}
          </div>
        </div>

        {isLoading && (
          <div className="mt-4 rounded-md border bg-white p-6 text-sm text-gray-500">Loading…</div>
        )}
        {error && !data && (
          <div className="mt-4 rounded-md border border-red-200 bg-white p-6 text-sm text-red-700">
            {(error as Error).message}
          </div>
        )}

        {data && (
          <>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {STAT_META.map(({ key, label, n }) => {
                const active = typeFilter === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTypeFilter(active ? null : key)}
                    className={`rounded-lg border p-3 text-center transition-colors ${
                      active ? "border-primary bg-primary/5 ring-1 ring-primary" : "bg-white hover:bg-gray-50"
                    }`}
                  >
                    <div className="text-2xl font-bold text-primary">{n}</div>
                    <div className="text-xs text-gray-500">{label}</div>
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-gray-500">
              {stats.new_visitor > 0
                ? `${stats.converted} of ${stats.new_visitor} new ${stats.new_visitor === 1 ? "visitor" : "visitors"} went on to create or join a group. `
                : ""}
              Tap a number to filter the feed. A "new visitor" is a browser we've never seen before
              that wasn't already logged in; link previews and bots aren't counted.
            </p>

            <section className="mt-6">
              <div className="mb-1.5 flex items-baseline justify-between border-b pb-1">
                <h2 className="text-sm font-bold text-gray-800">Groups</h2>
                <span className="text-xs text-gray-500">
                  {newGroups.length} new in the last {days} days · {data.groups.length} in total
                </span>
              </div>
              <div className="overflow-x-auto rounded-lg border bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs text-gray-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Group</th>
                      <th className="px-3 py-2 font-medium">Created</th>
                      <th className="hidden px-3 py-2 font-medium sm:table-cell">Admin</th>
                      <th className="px-3 py-2 text-right font-medium">Players</th>
                      <th className="hidden px-3 py-2 font-medium sm:table-cell">Games</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.groups.map((g) => {
                      const isNew = new Date(g.createdAt).getTime() >= sinceMs;
                      return (
                        <tr key={g.id} className="border-t">
                          <td className="px-3 py-2 font-medium text-gray-800">
                            {g.name}
                            {isNew && (
                              <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800">
                                new
                              </span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-gray-600">{formatDate(g.createdAt)}</td>
                          <td className="hidden px-3 py-2 text-gray-600 sm:table-cell">{g.admin ?? "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-800">{g.players}</td>
                          <td className="hidden px-3 py-2 text-gray-600 sm:table-cell">
                            {g.enabledGames.map((x) => GAME_LABEL[x] ?? x).join(", ") || "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mt-6">
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 border-b pb-1">
                <h2 className="text-sm font-bold text-gray-800">
                  {typeFilter ? `${TYPE_META[typeFilter]?.label ?? typeFilter} events` : "Recent events"}
                </h2>
                {typeFilter ? (
                  <button
                    type="button"
                    onClick={() => setTypeFilter(null)}
                    className="text-xs font-medium text-primary underline"
                  >
                    Show all
                  </button>
                ) : (
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-gray-500">
                    <input
                      type="checkbox"
                      checked={showLogins}
                      onChange={(e) => setShowLogins(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-gray-300"
                    />
                    Include logins
                  </label>
                )}
              </div>
              {feed.length === 0 ? (
                <div className="rounded-lg border bg-white p-6 text-sm text-gray-500">
                  Nothing in the last {days} days yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {feed.slice(0, 500).map((e) => {
                    const d = parseDetails(e);
                    const meta = TYPE_META[e.type] ?? { label: e.type, emoji: "•", tone: "bg-gray-100 text-gray-700" };
                    const place = [e.city, e.country].filter(Boolean).join(", ");
                    return (
                      <div key={e.id} className="rounded-md border bg-white p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${meta.tone}`}>
                            {meta.emoji} {meta.label}
                          </span>
                          <span className="text-sm text-gray-800">{describe(e, d)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-gray-500">
                          <span className="font-medium text-gray-700">{formatTime(e.createdAt)}</span>
                          <span>{place || "Unknown location"}</span>
                          <span>{deviceLabel(e.userAgent)}</span>
                          <span className="text-gray-400">{e.ipAddress}</span>
                        </div>
                      </div>
                    );
                  })}
                  {feed.length > 500 && (
                    <p className="text-xs text-gray-400">Showing the latest 500 of {feed.length}.</p>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
