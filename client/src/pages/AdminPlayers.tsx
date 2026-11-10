import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, EyeOff, MessageCircle, Trash2, X } from "lucide-react";
import { NAV_HIDDEN_GAMES } from "@shared/navGames";
import { SITE_URL, welcomeMessage } from "@shared/welcomeMessage";
import type { GroupRules } from "@shared/schema";

import { AdminLayout, AdminPageTitle } from "@/components/AdminNav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { AdminDeleteDialog, type DeleteTarget } from "@/components/AdminDeleteDialog";

type Player = {
  id: number;
  username: string;
  groupId: number;
  inLms: boolean;
  // Added after the running LMS competition started: joins the next one.
  lmsNext: boolean;
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
  rules: GroupRules;
  hasActiveLms: boolean;
  // The running LMS competition; `open` = its first deadline hasn't passed,
  // so new players still go straight into it.
  lms: { name: string; startGameweek: number; currentGameweek: number; open: boolean } | null;
  players: Player[];
};

// The player just added, shown with their code until dismissed.
type AddedPlayer = { groupId: number; username: string; loginCode: string | null; message: string };

// The same key every admin page reads, so it only has to be entered once per
// device. "wc_admin_key" is where this page used to keep it.
const ADMIN_KEY_STORAGE = "adminApiKey";
const LEGACY_KEY_STORAGE = "wc_admin_key";

function useAdminKey(): [string, (k: string) => void] {
  const [key, setKey] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return (
      window.localStorage.getItem(ADMIN_KEY_STORAGE) ??
      window.localStorage.getItem(LEGACY_KEY_STORAGE) ??
      ""
    );
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
  // Games ticked in each group's add form (unset = all of the group's games).
  const [newGames, setNewGames] = useState<Record<number, string[]>>({});
  const [added, setAdded] = useState<AddedPlayer | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  // Player or group whose permanent-delete confirm dialog is open.
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
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

  function chosenGames(group: GroupWithPlayers): string[] {
    return newGames[group.id] ?? group.enabledGames;
  }

  async function addPlayer(group: GroupWithPlayers) {
    const username = (newNames[group.id] ?? "").trim();
    if (!username) return;
    setBusy(true);
    setStatus(null);
    setAdded(null);
    try {
      const res = await fetch("/api/admin/players", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": adminKey },
        body: JSON.stringify({ groupId: group.id, username, enabledGames: chosenGames(group) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      setNewNames((prev) => ({ ...prev, [group.id]: "" }));
      setNewGames((prev) => {
        const next = { ...prev };
        delete next[group.id];
        return next;
      });
      setAdded({
        groupId: group.id,
        username: data?.player?.username ?? username,
        loginCode: data?.player?.loginCode ?? null,
        message: data?.message || `Added "${username}".`,
      });
      await refresh();
    } catch (err: any) {
      setStatus({ ok: false, message: err?.message || "Add failed" });
    } finally {
      setBusy(false);
    }
  }

  // Put a player who isn't in LMS back in: the current competition if it
  // hasn't started, otherwise the next one.
  async function joinLms(player: Player) {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/admin/players/${player.id}/lms`, {
        method: "POST",
        headers: { "x-api-key": adminKey },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      setStatus({ ok: true, message: data?.message || "Done." });
      await refresh();
    } catch (err: any) {
      setStatus({ ok: false, message: err?.message || "Couldn't add them to LMS" });
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string, what: string) {
    navigator.clipboard
      ?.writeText(text)
      .then(() => setStatus({ ok: true, message: `Copied ${what}.` }))
      .catch(() => {});
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

  // The games a player can currently see: their override, or (when null) all of
  // the group's games.
  function effectivePlayerGames(player: Player, group: GroupWithPlayers): string[] {
    return player.enabledGames ?? group.enabledGames;
  }

  // Why a game's tab is hidden for this player regardless of the toggle, or
  // null if the toggle alone decides. Mirrors Header (NAV_HIDDEN_GAMES).
  function autoHiddenReason(gameKey: string, player: Player, group: GroupWithPlayers): string | null {
    if (NAV_HIDDEN_GAMES.includes(gameKey)) {
      return "hidden from the menu for everyone while it's off-season";
    }
    return null;
  }

  // The WhatsApp welcome message for a player: how to log in with their code,
  // and how each game they can see works under this group's rules.
  function playerWelcome(player: Player, group: GroupWithPlayers): string | null {
    if (!player.loginCode) return null;
    return welcomeMessage({
      username: player.username,
      groupName: group.name,
      loginCode: player.loginCode,
      siteUrl: SITE_URL,
      games: effectivePlayerGames(player, group).filter((g) => !autoHiddenReason(g, player, group)),
      rules: group.rules,
      lms: player.inLms
        ? { status: "in", competitionName: group.lms?.name, startGameweek: group.lms?.startGameweek }
        : player.lmsNext
          ? { status: "next", competitionName: group.lms?.name }
          : { status: "none" },
    });
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
      setStatus({ ok: true, message: data?.message || `${player.username} now sees: ${games}.` });
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
    <AdminLayout className="space-y-6">
        <div>
          <AdminPageTitle title="Manage Players">
          <p>
            Add or remove players for each group.
            <strong> Add</strong> creates the player and their login code, with
            only the games you tick. If Last Man Standing is ticked, they go
            into the current competition only while it hasn't started yet. Once
            its first deadline has passed its players are fixed, so they join
            the next competition instead (the badge says <em>Next LMS</em>).
            <strong> Remove</strong> takes them out of the current LMS
            competition only. Their past LMS competitions and
            predictions records are kept, and their account is not deleted.
            The <strong>bin</strong> next to a player, and <strong>Delete group…</strong>{" "}
            under each group, delete them from the database for good, after a
            confirmation that lists everything that goes with them.
          </p>
          <p>
            Each player has a <strong>personal login code</strong> shown next to
            their name — share it with them privately. The speech-bubble button
            next to it copies a WhatsApp welcome message with their code, how to
            log in and how each of their football games works under this group's rules. Entering it on the
            landing page signs them into their group and enabled games (valid
            for a year), and lets them edit only their own picks.
          </p>
          <p>
            For groups that run more than one game, the <strong>Sees</strong>{" "}
            toggles under each player control which game tabs that person sees.
            All on by default — e.g. turn off Lawro for a player who only
            plays Last Man Standing. Turning LMS off also takes them out of a
            competition that hasn't started (one that's under way keeps them,
            and the badge turns amber); turning it on adds them like a new
            player.
          </p>
          </AdminPageTitle>
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
            <Card key={group.id}>
              <CardHeader>
                <CardTitle className="flex items-baseline justify-between gap-2">
                  <span>{group.name}</span>
                  <span className="text-xs font-normal text-gray-500">
                    {group.enabledGames.join(", ") || "no games"}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {group.enabledGames.includes("lms") && !group.lms && (
                  <p className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">
                    No LMS competition running right now. Players with LMS join the next one when it opens.
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
                          {player.loginCode && (
                            <button
                              type="button"
                              title={`Copy a WhatsApp welcome message for ${player.username} (login code + how their games work)`}
                              aria-label={`Copy welcome message for ${player.username}`}
                              data-testid={`copy-welcome-${player.id}`}
                              onClick={() => {
                                const text = playerWelcome(player, group);
                                if (text) copy(text, `a WhatsApp welcome message for ${player.username}`);
                              }}
                              className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                            >
                              <MessageCircle className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <LmsBadge
                            player={player}
                            group={group}
                            seesLms={effectivePlayerGames(player, group).includes("lms")}
                            busy={busy}
                            onJoin={() => joinLms(player)}
                          />
                        </div>
                        <div className="flex items-center shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => removePlayer(player, group)}
                        >
                          Remove
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          title={`Delete ${player.username} permanently`}
                          aria-label={`Delete ${player.username} permanently`}
                          data-testid={`delete-player-${player.id}`}
                          className="px-2 text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() =>
                            setDeleteTarget({
                              kind: "player",
                              id: player.id,
                              username: player.username,
                              groupName: group.name,
                            })
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                        </div>
                       </div>
                       {group.enabledGames.length > 1 && (
                         <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                           <span className="text-[10px] uppercase tracking-wide text-gray-400">
                             Sees
                           </span>
                           {group.enabledGames.map((gameKey) => {
                             const on = effectivePlayerGames(player, group).includes(gameKey);
                             const label = GAME_LABELS[gameKey] ?? gameKey;
                             const hiddenReason = autoHiddenReason(gameKey, player, group);
                             if (hiddenReason) {
                               return (
                                 <span
                                   key={gameKey}
                                   data-testid={`game-badge-${player.id}-${gameKey}`}
                                   title={`${label}: ${hiddenReason}`}
                                   className="inline-flex items-center gap-1 text-[10px] font-medium pl-1 pr-2 py-0.5 rounded-full border border-dashed border-gray-300 bg-gray-50 text-gray-400"
                                 >
                                   <EyeOff className="h-3 w-3 shrink-0" />
                                   {label}
                                 </span>
                               );
                             }
                             return (
                               <button
                                 key={gameKey}
                                 data-testid={`game-badge-${player.id}-${gameKey}`}
                                 type="button"
                                 disabled={busy}
                                 onClick={() => togglePlayerGame(player, group, gameKey)}
                                 aria-pressed={on}
                                 title={`${on ? "Hide" : "Show"} ${label} for ${player.username}`}
                                 className={`inline-flex items-center gap-1 text-[10px] font-medium pl-1 pr-2 py-0.5 rounded-full border transition-colors disabled:opacity-60 ${
                                   on
                                     ? "bg-green-600 text-white border-green-600 hover:bg-green-700"
                                     : "bg-card text-gray-400 border-gray-300 line-through hover:border-gray-400"
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

                <AddPlayerForm
                  group={group}
                  name={newNames[group.id] ?? ""}
                  games={chosenGames(group)}
                  busy={busy}
                  onName={(v) => setNewNames((prev) => ({ ...prev, [group.id]: v }))}
                  onToggleGame={(game) => {
                    const current = chosenGames(group);
                    const next = current.includes(game)
                      ? current.filter((g) => g !== game)
                      : group.enabledGames.filter((g) => g === game || current.includes(g));
                    setNewGames((prev) => ({ ...prev, [group.id]: next }));
                  }}
                  onAdd={() => addPlayer(group)}
                />

                {added?.groupId === group.id && (
                  <div
                    data-testid="added-player"
                    className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p>{added.message}</p>
                      <button
                        type="button"
                        aria-label="Dismiss"
                        className="text-green-700 hover:text-green-900"
                        onClick={() => setAdded(null)}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    {added.loginCode && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="bg-card"
                          onClick={() => copy(added.loginCode as string, `${added.username}'s code`)}
                        >
                          <Copy className="h-3.5 w-3.5 mr-1.5" />
                          Copy code <span className="ml-1 font-mono">{added.loginCode}</span>
                        </Button>
                        {(() => {
                          const row = group.players.find((p) => p.username === added.username);
                          const text = row ? playerWelcome(row, group) : null;
                          return (
                            text && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="bg-card"
                                data-testid="copy-welcome"
                                onClick={() => copy(text, "the WhatsApp welcome message")}
                              >
                                <Copy className="h-3.5 w-3.5 mr-1.5" />
                                Copy WhatsApp message
                              </Button>
                            )
                          );
                        })()}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex justify-end pt-2 border-t">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    data-testid={`delete-group-${group.id}`}
                    className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    onClick={() => setDeleteTarget({ kind: "group", id: group.id, name: group.name })}
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Delete group…
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      <AdminDeleteDialog
        target={deleteTarget}
        adminKey={adminKey}
        onClose={() => setDeleteTarget(null)}
        onDeleted={async (message) => {
          setDeleteTarget(null);
          setStatus({ ok: true, message });
          await refresh();
        }}
      />
    </AdminLayout>
  );
}

// The player's Last Man Standing state in the group's roster row.
function LmsBadge({
  player,
  group,
  seesLms,
  busy,
  onJoin,
}: {
  player: Player;
  group: GroupWithPlayers;
  seesLms: boolean;
  busy: boolean;
  onJoin: () => void;
}) {
  if (!group.enabledGames.includes("lms")) return null;
  const base = "text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap";
  const comp = group.lms?.name ?? "the current competition";
  if (player.inLms && !seesLms) {
    return (
      <span
        data-testid={`lms-badge-${player.id}`}
        title={`In ${comp}, but LMS is hidden for them. The missed-pick rule still applies; use Remove to take them out.`}
        className={`${base} bg-amber-100 text-amber-800`}
      >
        In LMS · hidden
      </span>
    );
  }
  if (player.inLms) {
    return (
      <span data-testid={`lms-badge-${player.id}`} className={`${base} bg-green-100 text-green-700`}>
        In LMS
      </span>
    );
  }
  if (player.lmsNext) {
    return (
      <span
        data-testid={`lms-badge-${player.id}`}
        title={`Joined after ${comp} started, so they're in the next competition.`}
        className={`${base} bg-sky-100 text-sky-800`}
      >
        Next LMS
      </span>
    );
  }
  if (!seesLms || !group.lms) return null;
  return (
    <button
      type="button"
      data-testid={`lms-badge-${player.id}`}
      disabled={busy}
      onClick={onJoin}
      title={
        group.lms.open
          ? `Add ${player.username} to ${comp} (it hasn't started yet)`
          : `${comp} is under way. Add ${player.username} to the next competition`
      }
      className={`${base} bg-gray-100 text-gray-500 hover:bg-gray-200 disabled:opacity-60`}
    >
      Not in LMS · add
    </button>
  );
}

// Name, games and an LMS hint for adding someone to a group.
function AddPlayerForm({
  group,
  name,
  games,
  busy,
  onName,
  onToggleGame,
  onAdd,
}: {
  group: GroupWithPlayers;
  name: string;
  games: string[];
  busy: boolean;
  onName: (v: string) => void;
  onToggleGame: (game: string) => void;
  onAdd: () => void;
}) {
  const trimmed = name.trim();
  const taken = group.players.find((p) => p.username.toLowerCase() === trimmed.toLowerCase());
  const lmsTicked = group.enabledGames.includes("lms") && games.includes("lms");
  let lmsHint: string | null = null;
  if (lmsTicked) {
    if (!group.lms) lmsHint = "No LMS competition is running, so they'll join the next one when it opens.";
    else if (group.lms.open) lmsHint = `They'll go into ${group.lms.name}, which starts in GW${group.lms.startGameweek}.`;
    else
      lmsHint = `${group.lms.name} is under way (started GW${group.lms.startGameweek}), so they'll join the next LMS competition, not this one.`;
  }
  const canAdd = !!trimmed && !taken && games.length > 0 && !busy;
  return (
    <div className="space-y-2 rounded-md border border-dashed border-gray-300 p-3" data-testid={`add-player-${group.id}`}>
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => onName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canAdd) onAdd();
          }}
          placeholder="New player name…"
          aria-label={`New player name for ${group.name}`}
          className="text-sm"
          disabled={busy}
        />
        <Button onClick={onAdd} disabled={!canAdd}>
          Add
        </Button>
      </div>
      {taken && <p className="text-xs text-red-700">{taken.username} is already in {group.name}.</p>}
      {group.enabledGames.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] uppercase tracking-wide text-gray-400">Plays</span>
          {group.enabledGames.map((gameKey) => {
            const on = games.includes(gameKey);
            const label = GAME_LABELS[gameKey] ?? gameKey;
            return (
              <button
                key={gameKey}
                type="button"
                disabled={busy}
                aria-pressed={on}
                onClick={() => onToggleGame(gameKey)}
                className={`inline-flex items-center gap-1 text-[11px] font-medium pl-1 pr-2 py-0.5 rounded-full border transition-colors disabled:opacity-60 ${
                  on
                    ? "bg-green-600 text-white border-green-600 hover:bg-green-700"
                    : "bg-card text-gray-400 border-gray-300 line-through hover:border-gray-400"
                }`}
              >
                {on ? <Check className="h-3 w-3 shrink-0" /> : <X className="h-3 w-3 shrink-0" />}
                {label}
              </button>
            );
          })}
        </div>
      )}
      {games.length === 0 && <p className="text-xs text-red-700">Pick at least one game.</p>}
      {lmsHint && <p className="text-xs text-gray-600">{lmsHint}</p>}
    </div>
  );
}
