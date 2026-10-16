import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GroupMultiSelect } from "@/components/GroupMultiSelect";
import { AdminGate } from "@/components/AdminGate";
import { AdminNav } from "@/components/AdminNav";

type Device = { userAgent: string | null; leads: number[]; createdAt: string };
type Row = {
  name: string;
  userIds: number[];
  groups: { id: number; name: string }[];
  remindersOn: boolean;
  deviceCount: number;
  leads: number[];
  devices: Device[];
  usedPwa: boolean;
  pwaLastAt: string | null;
  lastEnabledAt: string | null;
  lastAttempt: { type: string; at: string } | null;
};

type StatKey = "on" | "pwa" | "tried";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
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

const ATTEMPT_LABEL: Record<string, string> = {
  push_denied: "Blocked notifications",
  push_blocked: "Blocked notifications",
  push_error: "Errored",
  push_needs_install: "Needs to install (iOS)",
  push_unsupported: "Unsupported browser",
};

const matchesStat = (r: Row, s: StatKey): boolean =>
  s === "on" ? r.remindersOn : s === "pwa" ? r.usedPwa : !r.remindersOn && !!r.lastAttempt;

export default function AdminNotifications() {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("adminApiKey") || "");
  const [authed, setAuthed] = useState(() => !!localStorage.getItem("adminApiKey"));
  const [keyError, setKeyError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number | null> | null>(null);
  const [statFilter, setStatFilter] = useState<StatKey | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const { data: rows, error } = useQuery<Row[]>({
    queryKey: ["/api/admin/notifications", apiKey],
    enabled: authed,
    queryFn: async () => {
      const res = await fetch("/api/admin/notifications", { headers: { "x-api-key": apiKey } });
      if (res.status === 401) {
        setKeyError("Invalid admin password");
        setAuthed(false);
        throw new Error("Invalid admin key");
      }
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const groupOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of rows ?? []) for (const g of r.groups) m.set(g.id, g.name);
    return Array.from(m.entries())
      .map(([id, name]) => ({ id: id as number | null, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);
  const effectiveSelected = selected ?? new Set(groupOptions.map((o) => o.id));

  const shownPeople = useMemo(
    () => (rows ?? []).filter((r) => r.groups.some((g) => effectiveSelected.has(g.id))),
    [rows, effectiveSelected],
  );
  const total = shownPeople.length;
  const counts = {
    on: shownPeople.filter((r) => matchesStat(r, "on")).length,
    pwa: shownPeople.filter((r) => matchesStat(r, "pwa")).length,
    tried: shownPeople.filter((r) => matchesStat(r, "tried")).length,
  };

  const sections = useMemo(
    () =>
      groupOptions
        .filter((o) => effectiveSelected.has(o.id))
        .map((o) => ({
          group: o,
          members: (rows ?? [])
            .filter((r) => r.groups.some((g) => g.id === o.id))
            .filter((r) => !statFilter || matchesStat(r, statFilter))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .filter((s) => s.members.length > 0 || !statFilter),
    [rows, groupOptions, effectiveSelected, statFilter],
  );

  const sendTest = async (r: Row) => {
    setNote(null);
    const res = await fetch("/api/admin/test-push", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ userId: r.userIds[0] }),
    });
    const data = await res.json().catch(() => ({}));
    setNote(
      res.ok
        ? `Sent test to ${r.name} (${data.sent ?? 0} device${data.sent === 1 ? "" : "s"}).`
        : `Failed to send test to ${r.name}.`,
    );
  };

  const resetPerson = async (r: Row) => {
    if (!confirm(`Clear ${r.name}'s reminder subscriptions and push/PWA history? This is for wiping test data.`)) return;
    await fetch("/api/admin/notifications/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ userId: r.userIds[0] }),
    }).catch(() => {});
    setNote(`Cleared ${r.name}'s reminder data.`);
    queryClient.invalidateQueries({ queryKey: ["/api/admin/notifications", apiKey] });
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
        title="Reminders & PWA"
        error={keyError}
      />
    );
  }

  const STAT_META: { key: StatKey; label: string; n: number }[] = [
    { key: "on", label: "Reminders on", n: counts.on },
    { key: "pwa", label: "Installed PWA", n: counts.pwa },
    { key: "tried", label: "Tried, not set up", n: counts.tried },
  ];

  return (
    <div className="min-h-screen bg-gray-100">
      <main className="container mx-auto max-w-4xl px-4 py-6">
        <AdminNav />
        <h1 className="text-2xl font-bold text-primary">Reminders &amp; PWA</h1>
        <p className="mt-1 text-sm text-gray-600">
          Who has turned on kickoff reminders, who's installed the app, and who
          tried but didn't get set up. Tap a number to filter.
        </p>

        {error && !rows && <p className="mt-2 text-sm text-red-600">{(error as Error).message}</p>}

        <div className="mt-4 flex items-center justify-between gap-2">
          <p className="text-xs text-gray-500">{total} people</p>
          <GroupMultiSelect options={groupOptions} selected={effectiveSelected} onChange={setSelected} />
        </div>

        <div className="mt-2 grid grid-cols-3 gap-3">
          {STAT_META.map(({ key, label, n }) => {
            const active = statFilter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setStatFilter(active ? null : key)}
                className={`rounded-lg border p-3 text-center transition-colors ${
                  active ? "border-primary bg-primary/5 ring-1 ring-primary" : "bg-white hover:bg-gray-50"
                }`}
              >
                <div className="text-2xl font-bold text-primary">
                  {n}
                  <span className="text-base font-medium text-gray-400">/{total}</span>
                </div>
                <div className="text-xs text-gray-500">{label}</div>
              </button>
            );
          })}
        </div>
        {statFilter && (
          <button
            type="button"
            onClick={() => setStatFilter(null)}
            className="mt-2 text-xs font-medium text-primary underline"
          >
            Clear filter
          </button>
        )}

        {note && <p className="mt-3 rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-700">{note}</p>}

        <div className="mt-4 space-y-5">
          {sections.map(({ group, members }) => {
            const on = members.filter((m) => m.remindersOn).length;
            return (
              <div key={String(group.id)}>
                <div className="mb-1.5 flex items-baseline justify-between border-b pb-1">
                  <h2 className="text-sm font-bold text-gray-800">{group.name}</h2>
                  <span className="text-xs text-gray-500">
                    {on}/{members.length} reminders on
                  </span>
                </div>
                <div className="space-y-2">
                  {members.map((r) => (
                    <PersonCard
                      key={`${group.id}:${r.name}`}
                      r={r}
                      onTest={() => sendTest(r)}
                      onReset={() => resetPerson(r)}
                    />
                  ))}
                  {members.length === 0 && (
                    <p className="text-xs text-gray-400">No one here matches the filter.</p>
                  )}
                </div>
              </div>
            );
          })}
          {sections.length === 0 && (
            <div className="rounded-lg border bg-white p-6 text-sm text-gray-500">
              No players match.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function PersonCard({ r, onTest, onReset }: { r: Row; onTest: () => void; onReset: () => void }) {
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold text-gray-900">{r.name}</div>
        <div className="flex items-center gap-2 text-xs">
          {r.remindersOn ? (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
              Reminders on · {leadText(r.leads)}
            </span>
          ) : r.lastAttempt ? (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
              {ATTEMPT_LABEL[r.lastAttempt.type] ?? "Tried"}
            </span>
          ) : (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 font-medium text-gray-500">
              Not set up
            </span>
          )}
          {r.usedPwa && (
            <span className="rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700">PWA</span>
          )}
        </div>
      </div>
      {r.deviceCount > 0 && (
        <div className="mt-1 text-xs text-gray-500">
          {r.devices.map((d) => deviceLabel(d.userAgent)).join(", ")}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-gray-400">
        {r.lastEnabledAt && <span>Enabled {fmt(r.lastEnabledAt)}</span>}
        {r.usedPwa && <span>PWA seen {fmt(r.pwaLastAt)}</span>}
        {r.lastAttempt && <span>Last try {fmt(r.lastAttempt.at)}</span>}
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onTest}
          disabled={!r.remindersOn}
          title={r.remindersOn ? "Send a test notification" : "No device subscribed"}
          className="rounded-md border px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
        >
          Send test
        </button>
        <button
          type="button"
          onClick={onReset}
          className="rounded-md border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
        >
          Clear data
        </button>
      </div>
    </div>
  );
}

function leadText(leads: number[]): string {
  if (!leads || leads.length === 0) return "1h before";
  const f = (m: number) => (m < 60 ? `${m}m` : `${m / 60}h`);
  return leads.map(f).join(", ") + " before";
}
