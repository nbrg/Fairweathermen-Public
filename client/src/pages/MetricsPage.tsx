import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AdminGate } from "@/components/AdminGate";
import { AdminLayout, AdminPageTitle } from "@/components/AdminNav";
import type { Metrics } from "../../../server/metrics";

const number = (n: number) => n.toLocaleString();
const percent = (n: number | null) => n == null ? "—" : `${(n * 100).toFixed(1)}%`;
function Card({ title, value, note, previous, comparable = true }: { title: string; value: string; note: string; previous?: number; comparable?: boolean }) {
  return <div className="rounded-xl border bg-card p-4"><p className="text-sm text-muted-foreground">{title}</p><p className="mt-2 text-3xl font-bold tabular-nums">{value}</p><p className="mt-2 text-xs text-muted-foreground">{note}</p>{previous != null && <p className="mt-1 text-xs text-muted-foreground">{comparable ? `Previous period: ${number(previous)}` : "Previous period unavailable: incomplete history or attribution"}</p>}</div>;
}
function Plot({ title, caption, children }: { title: string; caption: string; children: ReactNode }) {
  return <section className="min-w-0 rounded-xl border bg-card p-4"><h2 className="font-semibold">{title}</h2><p className="mb-4 text-xs text-muted-foreground">{caption}</p><div className="h-72 w-full" role="img" aria-label={title}>{children}</div></section>;
}

export default function MetricsPage() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("adminApiKey") || "");
  const [authed, setAuthed] = useState(() => !!localStorage.getItem("adminApiKey"));
  const [keyError, setKeyError] = useState<string | null>(null);
  const [days, setDays] = useState(28);
  const [interval, setInterval] = useState<"day" | "week" | "month">("day");
  const { data, isLoading, error, refetch, isFetching } = useQuery<Metrics>({
    queryKey: ["/api/admin/metrics", apiKey, days, interval], enabled: authed, retry: false,
    queryFn: async () => {
      const response = await fetch(`/api/admin/metrics?days=${days}&interval=${interval}`, { headers: { "x-api-key": apiKey } });
      if (response.status === 401) { setKeyError("Invalid admin password"); setAuthed(false); throw new Error("Invalid admin password"); }
      if (!response.ok) throw new Error("Could not load metrics. Please retry.");
      return response.json();
    },
  });
  if (!authed) return <AdminGate title="Metrics" apiKey={apiKey} setApiKey={setApiKey} error={keyError} onSubmit={() => { setKeyError(null); setAuthed(true); }} />;
  const t = data?.totals;
  const p = data?.previous;
  const axis = <><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={24} /><YAxis allowDecimals={false} width={36} tick={{ fontSize: 11 }} /><Tooltip labelFormatter={date => `${date}${data?.series.find(row => row.date === date)?.partial ? " · partial period" : ""}`} /><Legend wrapperStyle={{ fontSize: 12 }} /></>;
  return <AdminLayout><div className="space-y-5">
    <AdminPageTitle title="Metrics"><p>Track whether people return, play and bring new groups into the app. All groups combined. Player counts describe known actors, not the subject of someone else’s edit. All dates and calendar buckets use UTC; weeks start Monday. The selected window ends now, so the first and last buckets can be partial.</p></AdminPageTitle>
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">Date range<select aria-label="Date range" value={days} onChange={e => setDays(Number(e.target.value))} className="mt-1 block rounded-md border bg-background p-2">{[7, 28, 90, 365].map(d => <option value={d} key={d}>Last {d} days</option>)}</select></label>
      <label className="text-sm">Group by<select aria-label="Group by" value={interval} onChange={e => setInterval(e.target.value as typeof interval)} className="mt-1 block rounded-md border bg-background p-2">{["day", "week", "month"].map(i => <option key={i} value={i}>{i[0].toUpperCase() + i.slice(1)}</option>)}</select></label>
      <button className="rounded-md border px-3 py-2 text-sm disabled:opacity-50" disabled={isFetching} onClick={() => refetch()}>Refresh</button>
    </div>
    {isLoading && <p role="status">Loading metrics…</p>}
    {error && <p role="alert" className="text-red-600">{error.message}</p>}
    {data && t && p && <>
      <p className="text-xs text-muted-foreground">{data.start.slice(0, 10)} – {data.end.slice(0, 10)} UTC · Compared with the preceding {days} days · Updated {new Date(data.end).toLocaleTimeString([], { timeZone: "UTC" })} UTC</p>
      {(!data.history.comparison.activity || !data.history.comparison.growth) && <p className="rounded-lg bg-muted p-3 text-sm">Recorded history does not reach the start of the comparison window for {!data.history.comparison.activity && "activity"}{!data.history.comparison.activity && !data.history.comparison.growth && " and "}{!data.history.comparison.growth && "growth"}. Affected comparisons are unavailable. Buckets before recorded history appear as gaps.</p>}
      <p className="text-xs text-muted-foreground">The first and last chart buckets may cover only part of a day, week or month. Hover or view the data table to identify partial periods; compare complete buckets when assessing trends.</p>
      {t.pageViews === 0 && t.gameActions === 0 && <p role="status" className="rounded-lg border p-3 text-sm">No recorded activity in this window. Try a longer date range.</p>}
      {(data.quality.unattributedGameActions > 0 || data.quality.previousUnattributedGameActions > 0) && <p role="status" className="rounded-lg bg-muted p-3 text-sm">{number(data.quality.unattributedGameActions)} game actions in this period and {number(data.quality.previousUnattributedGameActions)} in the preceding period have no recorded actor. Playing-player counts are minimum observed counts; participation rates may be incomplete.</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card title="Active players" value={number(t.activePlayers)} previous={p.activePlayers} comparable={data.history.comparison.activity} note="Distinct people with a view, tab change or game action." />
        <Card title="Active groups" value={number(t.activeGroups)} previous={p.activeGroups} comparable={data.history.comparison.activity} note="Groups with logged-in activity." />
        <Card title="Playing players" value={number(t.contributors)} previous={p.contributors} comparable={data.history.comparison.activity && data.quality.unattributedGameActions === 0 && data.quality.previousUnattributedGameActions === 0} note={`${percent(data.activationRate)} of active players made a game action.`} />
        <Card title="Returning-player rate" value={percent(data.retentionRate)} note={!data.history.comparison.activity ? "Needs a full previous period of recorded activity." : data.quality.unattributedGameActions || data.quality.previousUnattributedGameActions ? "Unavailable: some game actors were not recorded." : `${data.returningPlayers} of ${p.activePlayers} previous-period players returned.`} />
        <Card title="Page views" value={number(t.pageViews)} previous={p.pageViews} comparable={data.history.comparison.activity} note="Deduplicated navigations; excludes passive loads." />
        <Card title="Estimated sessions started" value={number(t.sessions)} previous={p.sessions} comparable={data.history.comparison.activity} note="Starts after 30 minutes without activity; counted in its start period." />
        <Card title="New browsers" value={number(t.newBrowsers)} previous={p.newBrowsers} comparable={data.history.comparison.growth} note="First recorded anonymous browser visit." />
        <Card title="7-day visitor conversion" value={percent(data.conversion.rate)} note={`${data.conversion.convertedBrowsers} of ${data.conversion.eligibleBrowsers} mature new browsers joined/created within 7 days. ${data.conversion.pendingBrowsers} still pending.`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Plot title="Activity by audience" caption="Page views split by authentication at the time of the visit."><ResponsiveContainer width="100%" height="100%"><BarChart data={data.series}>{axis}<Bar isAnimationActive={false} dataKey="loggedInViews" name="Logged in" stackId="views" fill="#7c3aed" /><Bar isAnimationActive={false} dataKey="anonymousViews" name="Not logged in" stackId="views" fill="#0284c7" /></BarChart></ResponsiveContainer></Plot>
        <Plot title="Player engagement" caption="Distinct active and playing people per bucket; do not add uniques across buckets."><ResponsiveContainer width="100%" height="100%"><BarChart data={data.series}>{axis}<Bar isAnimationActive={false} dataKey="activePlayers" name="Active players" fill="#7c3aed" /><Bar isAnimationActive={false} dataKey="contributors" name="Playing players" fill="#059669" /></BarChart></ResponsiveContainer></Plot>
        <Plot title="Growth" caption="New browsers, groups created and first-time membership joins; these are event counts, not a sequential funnel."><ResponsiveContainer width="100%" height="100%"><BarChart data={data.series}>{axis}<Bar isAnimationActive={false} dataKey="newBrowsers" name="New browsers" fill="#0284c7" /><Bar isAnimationActive={false} dataKey="groupsCreated" name="Groups created" fill="#7c3aed" /><Bar isAnimationActive={false} dataKey="playersJoined" name="Player joins" fill="#059669" /></BarChart></ResponsiveContainer></Plot>
        <Plot title="Anonymous audience" caption="Estimated distinct anonymous browsers and first-time browsers per bucket."><ResponsiveContainer width="100%" height="100%"><BarChart data={data.series}>{axis}<Bar isAnimationActive={false} dataKey="anonymousBrowsers" name="Anonymous browsers" fill="#0284c7" /><Bar isAnimationActive={false} dataKey="newBrowsers" name="New browsers" fill="#d97706" /></BarChart></ResponsiveContainer></Plot>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card title="Groups created" value={number(t.groupsCreated)} previous={p.groupsCreated} comparable={data.history.comparison.growth} note="Self-service group creation events." />
        <Card title="Player joins" value={number(t.playersJoined)} previous={p.playersJoined} comparable={data.history.comparison.growth} note={`${number(t.rejoins)} repeat joins excluded; founders appear under groups created.`} />
        <Card title="Game actions" value={number(t.gameActions)} previous={p.gameActions} comparable={data.history.comparison.activity} note="Recorded picks, edits and removals." />
        <Card title="Failed-login rate" value={percent(t.logins + t.failedLogins ? t.failedLogins / (t.logins + t.failedLogins) : null)} note={`${number(t.failedLogins)} failed / ${number(t.logins + t.failedLogins)} code-login attempts.`} />
      </div>
      <section className="rounded-xl border bg-card p-4">
        <h2 className="font-semibold">Participation by game</h2>
        <p className="mt-1 text-xs text-muted-foreground">Known people who made game actions. One person can appear in several games; scoring edits count as actions, not completed submissions.</p>
        <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["Game", "Playing people", "Actions", "Groups"].map(h => <th className="p-2" key={h} scope="col">{h}</th>)}</tr></thead><tbody>{data.games.map(game => <tr key={game.game} className="border-t"><th className="p-2 font-medium" scope="row">{game.game}</th><td className="p-2">{number(game.players)}</td><td className="p-2">{number(game.actions)}</td><td className="p-2">{number(game.groups)}</td></tr>)}</tbody></table></div>
      </section>
      <div className="rounded-lg bg-muted p-3 text-sm">{number(t.playerMemberships)} new self-service memberships (founders + first-time joins). These are group memberships, so an existing person joining another group is not counted as a newly acquired person.</div>
      <details className="rounded-xl border bg-card p-4 text-sm"><summary className="cursor-pointer font-semibold">Definitions & data quality</summary><div className="mt-3 space-y-2 text-muted-foreground">
        <p>Active players are unified across groups using their shared person identity. Anonymous browsers use the visitor cookie; older views fall back to IP + browser and are estimates. Logging in can split an anonymous session from a player session. Sessions use a 30-minute inactivity gap and are attributed to their start time. Daily session counts sum to the selected-window total.</p>
        <p>New browsers are not necessarily new people: cookie deletion and a new device can count again. Logged-out visitors may be existing players. 7-day conversion uses new browsers first seen in the selected window that have had a full seven days of observation. A conversion is a subsequent create or first-time join on the same cookie within seven days. All younger browsers remain pending, even if they have joined already. Repeat joins and existing-player logins are excluded. The last-seven-days view therefore has no mature cohort.</p>
        <p>Returning-player rate uses the previous equal-length period as its denominator. Playing players made at least one recorded game action attributed to the signed-in actor, including edits or deletions; this measures participation, not completed submissions. Game-action counts reflect audit events,. Older Lawro records identify the subject of an edit but not its actor; those contribute action volume only, never player engagement. Older LMS actors can be resolved from their participant records.</p>
        <p>Excludes admin pages, static assets, known bots, prefetches, hidden loads and foreground re-fires. Server/client navigation pairs within 30 seconds count once. Distinct visitor cookies are never deduplicated together. Historical bot detection is best effort; missing user agents are retained and reported rather than silently discarded.</p>
        <p>{number(data.quality.unattributedGameActions)} game actions without a known actor · {number(data.quality.unknownAgentEvents)} events without a user agent · {number(data.quality.excludedEvents)} excluded events · {number(data.quality.duplicateViews)} duplicate views removed · {number(data.quality.legacyAnonymousViews)} anonymous views using the older identity estimate. Activity history begins {data.history.activitySince?.slice(0, 10) ?? "unknown"}; growth history begins {data.history.growthSince?.slice(0, 10) ?? "unknown"}. Recorded history does not prove continuous tracking; deletions and tracking outages cannot be reconstructed.</p>
      </div></details>
      <details className="rounded-xl border bg-card p-4"><summary className="cursor-pointer text-sm font-semibold">View chart data</summary><div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><caption className="sr-only">Metrics per UTC bucket</caption><thead><tr>{["Bucket", "Coverage", "Logged-in views", "Anonymous views", "Active players", "Playing players", "New browsers", "Groups created", "Player joins"].map(h => <th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{data.series.map(row => <tr key={row.date} className="border-t">{[row.date, (row.partial ? "Partial" : "Full") + (!row.activityObserved || !row.growthObserved ? " · limited history" : ""), row.loggedInViews, row.anonymousViews, row.activePlayers, row.contributors, row.newBrowsers, row.groupsCreated, row.playersJoined].map((v, i) => <td key={i} className="p-2">{v ?? "—"}</td>)}</tr>)}</tbody></table></div></details>
    </>}
  </div></AdminLayout>;
}
