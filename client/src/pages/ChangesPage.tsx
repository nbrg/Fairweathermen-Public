import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AdminGate } from "@/components/AdminGate";
import { AdminLayout, AdminPageTitle } from "@/components/AdminNav";
import { changelogDate, type ChangelogEntry } from "@shared/changelog";

const PAGE = 30;

function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

// PR text keeps its `code` spans; show them as code, everything else as text.
function Rich({ text }: { text: string }) {
  const parts: ReactNode[] = text.split(/(`[^`]+`)/).map((p, i) =>
    p.length > 2 && p.startsWith("`") && p.endsWith("`") ? (
      <code key={i} className="rounded bg-muted px-1 py-0.5 text-[0.85em] [overflow-wrap:anywhere]">
        {p.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={i}>{p}</Fragment>
    ),
  );
  return <>{parts}</>;
}

export default function ChangesPage() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("adminApiKey") || "");
  const [authed, setAuthed] = useState(() => !!localStorage.getItem("adminApiKey"));
  const [keyError, setKeyError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  const { data, isLoading, error } = useQuery<{ entries: ChangelogEntry[] }>({
    queryKey: ["/api/admin/changelog", apiKey],
    enabled: authed,
    queryFn: async () => {
      const res = await fetch("/api/admin/changelog", { headers: { "x-api-key": apiKey } });
      if (res.status === 401) {
        setKeyError("Invalid admin password");
        setAuthed(false);
        throw new Error("Invalid admin key");
      }
      if (!res.ok) throw new Error("Failed to load changes");
      return res.json();
    },
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = data?.entries ?? [];
    if (!q) return all;
    return all.filter((e) =>
      [e.number != null ? `#${e.number}` : "", e.title, e.summary ?? "", ...e.bullets].some((t) => t.toLowerCase().includes(q)),
    );
  }, [data, query]);

  // Group the visible entries by UK calendar day, keeping newest-first order.
  const days = useMemo(() => {
    const out: { day: string; entries: ChangelogEntry[] }[] = [];
    for (const e of filtered.slice(0, shown)) {
      const day = dayLabel(changelogDate(e));
      const last = out[out.length - 1];
      if (last && last.day === day) last.entries.push(e);
      else out.push({ day, entries: [e] });
    }
    return out;
  }, [filtered, shown]);

  if (!authed) {
    return (
      <AdminGate
        apiKey={apiKey}
        setApiKey={setApiKey}
        onSubmit={() => {
          setKeyError(null);
          setAuthed(true);
        }}
        title="Changes"
        error={keyError}
      />
    );
  }

  return (
    <AdminLayout>
      <AdminPageTitle title="Changes">
        <p>
          Changes included in this version of the app, newest first.
        </p>
        <p>
          Each change includes its changelog in the same pull request and appears here after publishing.
          Dates show when entries were recorded; older entries show their merge date.
        </p>
      </AdminPageTitle>

      <input
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setShown(PAGE);
        }}
        placeholder="Search changes (e.g. Lawro, LMS, #12)"
        data-testid="changes-search"
        className="mt-4 w-full rounded-lg border bg-card px-3 py-2 text-sm"
      />

      {isLoading && <p className="mt-6 text-sm text-muted-foreground">Loading…</p>}
      {error && !isLoading && authed && (
        <p className="mt-6 text-sm text-red-600">Couldn't load the changes.</p>
      )}
      {data && filtered.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">No changes match “{query}”.</p>
      )}

      <div className="mt-4 space-y-6" data-testid="changes-list">
        {days.map(({ day, entries }) => (
          <section key={day}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {day}
            </h2>
            <div className="space-y-3">
              {entries.map((e) => (
                <article
                  key={e.id ?? e.number}
                  data-testid="change-entry"
                  className="rounded-xl border bg-card p-4 shadow-[0_1px_3px_rgba(23,18,31,0.06)]"
                >
                  <div className="flex items-baseline gap-2">
                    {e.number != null && (
                      <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
                        #{e.number}
                      </span>
                    )}
                    <h3 className="min-w-0 flex-1 font-semibold leading-snug text-foreground">{e.title}</h3>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={e.mergedAt ? "Merged" : "Recorded"}>
                      {timeLabel(changelogDate(e))}
                    </span>
                  </div>
                  {e.summary && (
                    <p className="mt-2 text-sm text-muted-foreground">
                      <Rich text={e.summary} />
                    </p>
                  )}
                  {e.bullets.length > 0 && (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground/90">
                      {e.bullets.map((b, i) => (
                        <li key={i}>
                          <Rich text={b} />
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>

      {filtered.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          className="mt-6 w-full rounded-lg border bg-card py-2 text-sm font-medium text-foreground hover:bg-muted"
        >
          Show older changes ({filtered.length - shown} more)
        </button>
      )}
    </AdminLayout>
  );
}
