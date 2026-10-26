import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";

import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { AdminNav } from "@/components/AdminNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type Player = {
  id: number;
  username: string;
  groupId: number;
  inLms: boolean;
  loginCode: string | null;
  // Per-person game-visibility override. null = inherit the group's games.
  enabledGames: string[] | null;
};

// Human labels for the game keys stored in enabledGames.
const GAME_LABELS: Record<string, string> = {
  lms: "LMS",
  predictions: "Lawro",
};
type GroupWithPlayers = {
  id: number;
  slug: string;
  name: string;
  enabledGames: string[];
  buyIn: number;
  lmsAllOutRule: string;
  hasActiveLms: boolean;
  players: Player[];
};

const ALL_GAMES = ["lms", "predictions"] as const;

const ALL_OUT_RULES: { value: string; label: string }[] = [
  { value: "rollover", label: "Rollover — no winner, a fresh competition starts" },
  { value: "revive", label: "Revive — everyone gets another life, play continues" },
];

// Remembered per device so the admin key only has to be entered once.
const ADMIN_KEY_STORAGE = "fwm_admin_key";

function useAdminKey(): [string, (k: string) => void] {
  const [key, setKey] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(ADMIN_KEY_STORAGE) ?? "";
  });
  useEffect(() => {
    if (!key) window.localStorage.removeItem(ADMIN_KEY_STORAGE);
    else window.localStorage.setItem(ADMIN_KEY_STORAGE, key);
  }, [key]);
  return [key, setKey];
}

export default function AdminPlayers() {
  const [adminKey, setAdminKey] = useAdminKey();
  const [newNames, setNewNames] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  // New-group form.
  const [newGroup, setNewGroup] = useState<{
    name: string;
    slug: string;
    games: string[];
    buyIn: string;
    lmsAllOutRule: string;
  }>({ name: "", slug: "", games: ["lms"], buyIn: "0", lmsAllOutRule: "rollover" });
  // Per-group unsaved rule edits, keyed by group id.
  const [ruleDrafts, setRuleDrafts] = useState<
    Record<number, { buyIn: string; lmsAllOutRule: string }>
  >({});
  const queryClient = useQueryClient();

  const {
    data: groups = [],
    isLoading,
    error,
    refetch,
  } = useQuery<GroupWithPlayers[]>({
    queryKey: ["/api/admin/groups-players", adminKey],
    queryFn: async () => {
      const res = await fetch("/api/admin/groups-players", {
        headers: { "x-api-key": adminKey },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Request failed: ${res.status}`);
      }
      return res.json();
    },
    enabled: !!adminKey,
  });

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["/api/admin/groups-players"] });
    await refetch();
  }

  async function addPlayer(groupId: number) {
    const username = (newNames[groupId] ?? "").trim();
    if (!username) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/players", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": adminKey },
        body: JSON.stringify({ groupId, username }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      setNewNames((prev) => ({ ...prev, [groupId]: "" }));
      setStatus({ ok: true, message: data?.message || `Added "${username}".` });
      await refresh();
    } catch (err: any) {
      setStatus({ ok: false, message: err?.message || "Add failed" });
    } finally {
      setBusy(false);
    }
  }

  async function removePlayer(player: Player, group: GroupWithPlayers) {
    const groupHasLms = group.enabledGames.includes("lms");
    const message = groupHasLms
      ? `Remove "${player.username}" from ${group.name}'s current Last Man Standing competition? ` +
        `They'll stay in past LMS competitions.`
      : `Remove "${player.username}" from ${group.name}? This deletes their picks and takes ` +
        `their name out of the game. Any other groups they're in are unchanged.`;
    if (!window.confirm(message)) {
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/admin/players/${player.id}`, {
        method: "DELETE",
        headers: { "x-api-key": adminKey },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      setStatus({ ok: true, message: data?.message || `Removed "${player.username}".` });
      await refresh();
    } catch (err: any) {
      setStatus({ ok: false, message: err?.message || "Remove failed" });
    } finally {
      setBusy(false);
    }
  }

  async function createGroup() {
    const name = newGroup.name.trim();
    const slug = newGroup.slug.trim().toLowerCase();
    if (!name || !slug) {
      setStatus({ ok: false, message: "Group needs a name and a slug." });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": adminKey },
        body: JSON.stringify({
          name,
          slug,
          enabledGames: newGroup.games,
          buyIn: Number(newGroup.buyIn) || 0,
          lmsAllOutRule: newGroup.lmsAllOutRule,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      setStatus({ ok: true, message: `Created group "${name}". Add players below.` });
      setNewGroup({ name: "", slug: "", games: ["lms"], buyIn: "0", lmsAllOutRule: "rollover" });
      await refresh();
    } catch (err: any) {
      setStatus({ ok: false, message: err?.message || "Create failed" });
    } finally {
      setBusy(false);
    }
  }

  async function saveGroupRules(group: GroupWithPlayers) {
    const draft = ruleDrafts[group.id] ?? {
      buyIn: String(group.buyIn),
      lmsAllOutRule: group.lmsAllOutRule,
    };
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/admin/groups/${group.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-api-key": adminKey },
        body: JSON.stringify({
          buyIn: Number(draft.buyIn) || 0,
          lmsAllOutRule: draft.lmsAllOutRule,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      setStatus({ ok: true, message: `Saved ${group.name}'s rules.` });
      setRuleDrafts((prev) => {
        const next = { ...prev };
        delete next[group.id];
        return next;
      });
      await refresh();
    } catch (err: any) {
      setStatus({ ok: false, message: err?.message || "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  // The games a player can currently see: their override, or (when null) all of
  // the group's games.
  function effectivePlayerGames(player: Player, group: GroupWithPlayers): string[] {
    return player.enabledGames ?? group.enabledGames;
  }

  // Toggle one game on/off for a player and persist the new set. Updates the
  // cached roster optimistically so the pill flips immediately, then confirms
  // (or rolls back) against the server.
  async function togglePlayerGame(
    player: Player,
    group: GroupWithPlayers,
    game: string,
  ) {
    const current = new Set(effectivePlayerGames(player, group));
    if (current.has(game)) current.delete(game);
    else current.add(game);
    // Keep the group's ordering.
    const next = group.enabledGames.filter((g) => current.has(g));
    // Store null (= inherit) when every game is on, else the explicit list —
    // mirrors what the server persists, so the optimistic state matches.
    const override = next.length === group.enabledGames.length ? null : next;

    const queryKey = ["/api/admin/groups-players", adminKey];
    queryClient.setQueryData<GroupWithPlayers[]>(queryKey, (old) =>
      old?.map((g) =>
        g.id !== group.id
          ? g
          : {
              ...g,
              players: g.players.map((p) =>
                p.id !== player.id ? p : { ...p, enabledGames: override },
              ),
            },
      ),
    );

    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/admin/players/${player.id}/games`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-api-key": adminKey },
        body: JSON.stringify({ enabledGames: next }),
      });
      // Read the body as text first so a non-JSON error (e.g. a 404 HTML page
      // when the server is running an older build without this route) still
      // produces a clear message instead of a silent JSON-parse failure.
      const raw = await res.text();
      let data: any = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        // non-JSON response
      }
      if (!res.ok) {
        throw new Error(
          data?.error ||
            (res.status === 404
              ? "Save endpoint not found (404) — the API server may be running an old build; restart it."
              : `Request failed: ${res.status}`),
        );
      }
      const games = (data?.effectiveGames as string[] | undefined)?.join(", ") || "none";
      setStatus({ ok: true, message: `${player.username} now sees: ${games}.` });
      await refresh();
    } catch (err: any) {
      setStatus({ ok: false, message: err?.message || "Update failed" });
      // Roll the optimistic change back to the server's real state.
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      <main className="container mx-auto px-4 py-6 flex-grow space-y-6">
        <AdminNav />
        <div>
          <h1 className="text-2xl font-bold text-primary">Manage Players</h1>
          <p className="text-sm text-gray-600">
            Add or remove players for each group.
            <strong> Add</strong> creates the player's login if they're new and,
            for a group that runs Last Man Standing, enrols them in the current
            LMS competition. For a predictions-only group (Lawro) it just adds the
            player and their code — that's all they need to sign in and play.
            <strong> Remove</strong> takes them out of the current LMS competition
            only — their past LMS competitions and predictions records are
            kept, and their account is not deleted.
          </p>
          <p className="text-sm text-gray-600 mt-2">
            Each player has a <strong>personal login code</strong> shown next to
            their name — share it with them privately. Entering it on the
            landing page signs them into their group and enabled games (valid
            for a year), and lets them edit only their own picks.
          </p>
          <p className="text-sm text-gray-600 mt-2">
            For groups that run more than one game, the <strong>Sees</strong>{" "}
            toggles under each player control which game tabs that person sees.
            All on by default — e.g. turn off Lawro for a player who only
            plays Last Man Standing.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Admin key</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Label htmlFor="admin-key" className="text-xs text-gray-600">
              Your admin API key (saved to localStorage on this device)
            </Label>
            <Input
              id="admin-key"
              type="password"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              placeholder="paste key…"
              className="font-mono text-sm"
              autoComplete="off"
            />
          </CardContent>
        </Card>

        {status && (
          <div
            className={`text-sm rounded-md px-3 py-2 ${
              status.ok ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
            }`}
          >
            {status.message}
          </div>
        )}

        {adminKey && (
          <Card>
            <CardHeader>
              <CardTitle>Create a group</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-gray-600">
                A group is its own circle of friends with its own players, games,
                leaderboard and rules. Give it a name and a short slug, pick its
                games, and set the rules. Add players to it below once it exists.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="ng-name" className="text-xs text-gray-600">Name</Label>
                  <Input
                    id="ng-name"
                    value={newGroup.name}
                    onChange={(e) => setNewGroup((g) => ({ ...g, name: e.target.value }))}
                    placeholder="e.g. Sunday League"
                    disabled={busy}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ng-slug" className="text-xs text-gray-600">
                    Slug (lowercase, no spaces)
                  </Label>
                  <Input
                    id="ng-slug"
                    value={newGroup.slug}
                    onChange={(e) => setNewGroup((g) => ({ ...g, slug: e.target.value }))}
                    placeholder="e.g. sunday-league"
                    className="font-mono text-sm"
                    disabled={busy}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-gray-600">Games</span>
                <div className="flex flex-wrap gap-2">
                  {ALL_GAMES.map((gameKey) => {
                    const on = newGroup.games.includes(gameKey);
                    return (
                      <button
                        key={gameKey}
                        type="button"
                        disabled={busy}
                        aria-pressed={on}
                        onClick={() =>
                          setNewGroup((g) => ({
                            ...g,
                            games: on
                              ? g.games.filter((x) => x !== gameKey)
                              : [...g.games, gameKey],
                          }))
                        }
                        className={`text-xs font-medium px-2.5 py-1 rounded-full border transition-colors ${
                          on
                            ? "bg-green-600 text-white border-green-600"
                            : "bg-white text-gray-500 border-gray-300"
                        }`}
                      >
                        {GAME_LABELS[gameKey] ?? gameKey}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="ng-buyin" className="text-xs text-gray-600">
                    Buy-in per player
                  </Label>
                  <Input
                    id="ng-buyin"
                    type="number"
                    min={0}
                    value={newGroup.buyIn}
                    onChange={(e) => setNewGroup((g) => ({ ...g, buyIn: e.target.value }))}
                    disabled={busy}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ng-rule" className="text-xs text-gray-600">
                    Last Man Standing: when everyone's out
                  </Label>
                  <select
                    id="ng-rule"
                    value={newGroup.lmsAllOutRule}
                    onChange={(e) =>
                      setNewGroup((g) => ({ ...g, lmsAllOutRule: e.target.value }))
                    }
                    disabled={busy}
                    className="w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm"
                  >
                    {ALL_OUT_RULES.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <Button
                onClick={createGroup}
                disabled={busy || !newGroup.name.trim() || !newGroup.slug.trim()}
              >
                Create group
              </Button>
            </CardContent>
          </Card>
        )}

        {!adminKey ? (
          <p className="text-sm text-gray-500">Enter your admin key to load groups.</p>
        ) : isLoading ? (
          <p className="text-sm text-gray-500">Loading groups…</p>
        ) : error ? (
          <p className="text-sm text-red-700">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        ) : (
          groups.map((group) => (
            <Card key={group.id} data-testid={`group-card-${group.slug}`}>
              <CardHeader>
                <CardTitle className="flex items-baseline justify-between gap-2">
                  <span>{group.name}</span>
                  <span className="text-xs font-normal text-gray-500">
                    {group.slug} · {group.enabledGames.join(", ") || "no games"}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {(() => {
                  const draft = ruleDrafts[group.id] ?? {
                    buyIn: String(group.buyIn),
                    lmsAllOutRule: group.lmsAllOutRule,
                  };
                  const dirty =
                    draft.buyIn !== String(group.buyIn) ||
                    draft.lmsAllOutRule !== group.lmsAllOutRule;
                  const setDraft = (patch: Partial<typeof draft>) =>
                    setRuleDrafts((prev) => ({ ...prev, [group.id]: { ...draft, ...patch } }));
                  return (
                    <div className="rounded-md bg-gray-50 p-3 space-y-2">
                      <span className="text-[10px] uppercase tracking-wide text-gray-400">
                        Rules
                      </span>
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs text-gray-600">Buy-in</Label>
                          <Input
                            type="number"
                            min={0}
                            value={draft.buyIn}
                            onChange={(e) => setDraft({ buyIn: e.target.value })}
                            className="w-24 text-sm"
                            disabled={busy}
                          />
                        </div>
                        <div className="space-y-1 min-w-[16rem] flex-1">
                          <Label className="text-xs text-gray-600">
                            LMS: when everyone's out
                          </Label>
                          <select
                            value={draft.lmsAllOutRule}
                            onChange={(e) => setDraft({ lmsAllOutRule: e.target.value })}
                            disabled={busy}
                            className="w-full rounded-md border border-gray-300 bg-white px-2 py-2 text-sm"
                          >
                            {ALL_OUT_RULES.map((r) => (
                              <option key={r.value} value={r.value}>{r.label}</option>
                            ))}
                          </select>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || !dirty}
                          onClick={() => saveGroupRules(group)}
                        >
                          Save rules
                        </Button>
                      </div>
                    </div>
                  );
                })()}
                {group.enabledGames.includes("lms") && !group.hasActiveLms && (
                  <p className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">
                    No active LMS competition — start one to enrol players.
                  </p>
                )}
                {group.players.length === 0 ? (
                  <p className="text-sm text-gray-500">No players yet.</p>
                ) : (
                  <ul className="divide-y">
                    {group.players.map((player) => (
                      <li key={player.id} className="py-1.5">
                       <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm truncate">{player.username}</span>
                          {player.loginCode && (
                            <button
                              type="button"
                              title="Click to copy this player's personal login code"
                              onClick={() => {
                                navigator.clipboard
                                  ?.writeText(player.loginCode as string)
                                  .then(() =>
                                    setStatus({
                                      ok: true,
                                      message: `Copied ${player.username}'s code.`,
                                    }),
                                  )
                                  .catch(() => {});
                              }}
                              className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 hover:bg-gray-200 whitespace-nowrap"
                            >
                              {player.loginCode}
                            </button>
                          )}
                          {group.enabledGames.includes("lms") && group.hasActiveLms && (
                            <span
                              className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                                player.inLms
                                  ? "bg-green-100 text-green-700"
                                  : "bg-gray-100 text-gray-500"
                              }`}
                            >
                              {player.inLms ? "In LMS" : "Not in LMS"}
                            </span>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => removePlayer(player, group)}
                        >
                          Remove
                        </Button>
                       </div>
                       {group.enabledGames.length > 1 && (
                         <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                           <span className="text-[10px] uppercase tracking-wide text-gray-400">
                             Sees
                           </span>
                           {group.enabledGames.map((gameKey) => {
                             const on = effectivePlayerGames(player, group).includes(gameKey);
                             const label = GAME_LABELS[gameKey] ?? gameKey;
                             return (
                               <button
                                 key={gameKey}
                                 type="button"
                                 disabled={busy}
                                 onClick={() => togglePlayerGame(player, group, gameKey)}
                                 aria-pressed={on}
                                 title={`${on ? "Hide" : "Show"} ${label} for ${player.username}`}
                                 className={`inline-flex items-center gap-1 text-[10px] font-medium pl-1 pr-2 py-0.5 rounded-full border transition-colors disabled:opacity-60 ${
                                   on
                                     ? "bg-green-600 text-white border-green-600 hover:bg-green-700"
                                     : "bg-white text-gray-400 border-gray-300 line-through hover:border-gray-400"
                                 }`}
                               >
                                 {on ? (
                                   <Check className="h-3 w-3 shrink-0" />
                                 ) : (
                                   <X className="h-3 w-3 shrink-0" />
                                 )}
                                 {label}
                               </button>
                             );
                           })}
                         </div>
                       )}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex gap-2 pt-1">
                  <Input
                    value={newNames[group.id] ?? ""}
                    onChange={(e) =>
                      setNewNames((prev) => ({ ...prev, [group.id]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addPlayer(group.id);
                    }}
                    placeholder="New player name…"
                    className="text-sm"
                    disabled={busy}
                  />
                  <Button
                    onClick={() => addPlayer(group.id)}
                    disabled={busy || !(newNames[group.id] ?? "").trim()}
                  >
                    Add
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </main>
      <Footer minimal />
    </div>
  );
}
