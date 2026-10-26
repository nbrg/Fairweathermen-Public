import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";

type Player = {
  id: number;
  username: string;
  isOwner: boolean;
  inLms: boolean;
  canRemove: boolean;
};

type PlayersResponse = {
  players: Player[];
  canRename: boolean;
  // The group's current LMS competition; `open` = it hasn't reached its first
  // deadline, so players can still be taken out of it or added to it.
  lms: { name: string; startGameweek: number; open: boolean } | null;
};

// Admin-only card on /group-settings listing the group's players, with a menu
// per player: sit out / rejoin the LMS competition that's about to start, reset
// a lost login code, rename (self-service groups) and remove someone who has no
// picks yet. The server enforces who may do what; this just reflects it.
export default function GroupPlayersCard({ groupId }: { groupId: number | undefined }) {
  const { toast } = useToast();
  const [data, setData] = useState<PlayersResponse | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  // The login code just reset, shown once under that player's row.
  const [newCode, setNewCode] = useState<{ playerId: number; code: string } | null>(null);

  async function load() {
    const res = await fetch("/api/group/players", { credentials: "include" });
    if (res.ok) setData((await res.json()) as PlayersResponse);
  }

  useEffect(() => {
    setData(null);
    setNewCode(null);
    load();
  }, [groupId]);

  async function call(player: Player, url: string, init: RequestInit): Promise<any | null> {
    setBusy(player.id);
    try {
      const res = await fetch(url, {
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Couldn't do that", description: body?.error || "Please try again.", variant: "destructive" });
        return null;
      }
      await load();
      return body;
    } finally {
      setBusy(null);
    }
  }

  async function setInLms(player: Player, inLms: boolean) {
    const ok = await call(player, `/api/group/players/${player.id}/lms`, {
      method: "PUT",
      body: JSON.stringify({ inLms }),
    });
    if (ok && data?.lms) {
      toast({
        title: inLms ? `${player.username} is in` : `${player.username} is sitting out`,
        description: inLms
          ? `They're playing ${data.lms.name}.`
          : `They're not in ${data.lms.name}, or the ones after it, until you add them back.`,
      });
    }
  }

  async function resetCode(player: Player) {
    if (!window.confirm(`Give ${player.username} a new login code? Their current code will stop working.`)) return;
    const body = await call(player, `/api/group/players/${player.id}/reset-code`, { method: "POST" });
    if (body?.code) setNewCode({ playerId: player.id, code: body.code });
  }

  async function rename(player: Player) {
    const username = window.prompt(`Rename ${player.username} to:`, player.username)?.trim();
    if (!username || username === player.username) return;
    await call(player, `/api/group/players/${player.id}`, { method: "PATCH", body: JSON.stringify({ username }) });
  }

  async function remove(player: Player) {
    if (!window.confirm(`Remove ${player.username} from the group?`)) return;
    await call(player, `/api/group/players/${player.id}`, { method: "DELETE" });
  }

  if (!data) return null;
  const lms = data.lms;

  return (
    <Card>
      <CardHeader className="p-4 pb-3 sm:p-6 sm:pb-4">
        <CardTitle className="text-base sm:text-lg">Players</CardTitle>
        {lms && (
          <p className="text-xs leading-relaxed text-gray-500">
            {lms.open
              ? `${lms.name} starts in gameweek ${lms.startGameweek}. Until its deadline you can take players out (to sit it out) or add them back. Whoever's in carries into the next competition.`
              : `${lms.name} is under way, so its players are fixed. You can change who's in when the next one opens.`}
          </p>
        )}
      </CardHeader>
      <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
        <ul className="divide-y divide-gray-100">
          {data.players.map((p) => (
            <li key={p.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {p.username}
                    {p.isOwner && <span className="ml-2 text-xs font-normal text-gray-500">Admin</span>}
                  </div>
                  {lms && (
                    <div className={`text-xs ${p.inLms ? "text-emerald-700" : "text-gray-500"}`}>
                      {p.inLms ? `Playing ${lms.name}` : `Sitting out ${lms.name}`}
                    </div>
                  )}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10 shrink-0"
                      disabled={busy === p.id}
                      aria-label={`Manage ${p.username}`}
                    >
                      <MoreHorizontal className="h-5 w-5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {lms?.open &&
                      (p.inLms ? (
                        <DropdownMenuItem onSelect={() => setInLms(p, false)}>Sit out {lms.name}</DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onSelect={() => setInLms(p, true)}>Add to {lms.name}</DropdownMenuItem>
                      ))}
                    <DropdownMenuItem onSelect={() => resetCode(p)}>Reset login code</DropdownMenuItem>
                    {data.canRename && <DropdownMenuItem onSelect={() => rename(p)}>Rename</DropdownMenuItem>}
                    {p.canRemove && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-red-600 focus:text-red-600" onSelect={() => remove(p)}>
                          Remove from group
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {newCode?.playerId === p.id && (
                <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <div className="text-xs text-emerald-800">New login code — send it to {p.username}:</div>
                  <div className="select-all font-mono text-base font-bold tracking-wide">{newCode.code}</div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
