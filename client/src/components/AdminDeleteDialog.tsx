import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

// "Are you sure" dialog for permanently deleting a player or a whole group from
// /admin/players. It loads a preview from the server (the exact row counts the
// delete will remove, worked out by server/adminDeletion.ts) and lists them as
// plain-English consequences before anything is deleted.

type Counts = {
  predictions: number;
  jokers: number;
  lmsEntries: number;
  lmsPicks: number;
  lmsPickChanges: number;
  lmsCompetitions: number;
  lmsWinsUnlinked: number;
  pushDevices: number;
  reminderSends: number;
  activityLogs: number;
  ruleChanges: number;
  ruleChangesUnlinked: number;
};

type PlayerPreview = {
  kind: "player";
  player: { id: number; username: string; groupId: number; groupName: string };
  scope: "group" | "everywhere";
  deletedFrom: { userId: number; groupId: number; groupName: string }[];
  keptIn: { groupId: number; groupName: string }[];
  adminOf: { groupId: number; groupName: string }[];
  counts: Counts;
};

type GroupPreview = {
  kind: "group";
  group: { id: number; name: string; slug: string; enabledGames: string[]; createdAt: string };
  isOriginal: boolean;
  players: number;
  playersInOtherGroups: { username: string; otherGroups: string[] }[];
  counts: Counts;
};

export type DeleteTarget =
  | { kind: "player"; id: number; username: string; groupName: string }
  | { kind: "group"; id: number; name: string };

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// What gets deleted, one line per kind of data, leaving out anything at zero.
function deletedLines(c: Counts): string[] {
  const lines: string[] = [];
  if (c.predictions)
    lines.push(
      `${plural(c.predictions, "Lawro prediction")}${c.jokers ? ` (incl. ${plural(c.jokers, "Joker")})` : ""}`,
    );
  if (c.lmsCompetitions) lines.push(plural(c.lmsCompetitions, "LMS competition"));
  if (c.lmsEntries || c.lmsPicks)
    lines.push(
      `${plural(c.lmsEntries, "LMS competition entry", "LMS competition entries")} with ${plural(c.lmsPicks, "pick")}` +
        (c.lmsPickChanges ? ` and ${plural(c.lmsPickChanges, "pick-change log")}` : ""),
    );
  if (c.ruleChanges) lines.push(plural(c.ruleChanges, "rule change", "rule changes") + " from the group's history");
  if (c.pushDevices) lines.push(`${plural(c.pushDevices, "device")} signed up for reminders (they stop)`);
  if (c.activityLogs) lines.push(`${plural(c.activityLogs, "activity log row")} (visits, logins, growth events)`);
  return lines;
}

export function AdminDeleteDialog({
  target,
  adminKey,
  onClose,
  onDeleted,
}: {
  target: DeleteTarget | null;
  adminKey: string;
  onClose: () => void;
  onDeleted: (message: string) => void;
}) {
  const [scope, setScope] = useState<"group" | "everywhere">("group");
  const [preview, setPreview] = useState<PlayerPreview | GroupPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typedName, setTypedName] = useState("");
  const [originalAck, setOriginalAck] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reset whenever a new target opens.
  useEffect(() => {
    setScope("group");
    setTypedName("");
    setOriginalAck(false);
    setError(null);
    setPreview(null);
  }, [target?.kind, target?.id]);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url =
      target.kind === "player"
        ? `/api/admin/players/${target.id}/deletion-preview?scope=${scope}`
        : `/api/admin/groups/${target.id}/deletion-preview`;
    fetch(url, { headers: { "x-api-key": adminKey } })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
        if (!cancelled) setPreview(data);
      })
      .catch((err) => !cancelled && setError(err?.message || "Couldn't load what would be deleted"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [target?.kind, target?.id, scope, adminKey]);

  const groupPreview = preview?.kind === "group" ? preview : null;
  const playerPreview = preview?.kind === "player" ? preview : null;
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const nameOk = !groupPreview || norm(typedName) === norm(groupPreview.group.name);
  const originalOk = !groupPreview?.isOriginal || originalAck;
  const canDelete = !!preview && !loading && !deleting && nameOk && originalOk;

  async function confirmDelete() {
    if (!target || !canDelete) return;
    setDeleting(true);
    setError(null);
    try {
      const res =
        target.kind === "player"
          ? await fetch(`/api/admin/players/${target.id}/permanent`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json", "x-api-key": adminKey },
              body: JSON.stringify({ scope }),
            })
          : await fetch(`/api/admin/groups/${target.id}`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json", "x-api-key": adminKey },
              body: JSON.stringify({ confirmName: typedName, confirmOriginal: originalAck }),
            });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      onDeleted(data?.message || "Deleted.");
    } catch (err: any) {
      setError(err?.message || "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  const title =
    target?.kind === "group"
      ? `Delete the group "${target.name}" permanently?`
      : target
        ? `Delete ${target.username} permanently?`
        : "";

  const lines = preview ? deletedLines(preview.counts) : [];

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && !deleting && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" data-testid="admin-delete-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2 text-red-700">
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
            <span>{title}</span>
          </DialogTitle>
          <DialogDescription>
            This removes it from the database for good. It can't be undone, and there's no backup in
            the app to restore it from.
          </DialogDescription>
        </DialogHeader>

        {target?.kind === "player" && (playerPreview?.keptIn.length || scope === "everywhere") ? (
          <div className="space-y-1.5 text-sm">
            <p className="font-medium">Delete them from</p>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="delete-scope"
                checked={scope === "group"}
                onChange={() => setScope("group")}
              />
              Only {target.groupName}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="delete-scope"
                checked={scope === "everywhere"}
                onChange={() => setScope("everywhere")}
                data-testid="delete-scope-everywhere"
              />
              Every group they're in
            </label>
          </div>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Working out what would be deleted…
          </p>
        ) : preview ? (
          <div className="space-y-3 text-sm" data-testid="delete-implications">
            {groupPreview && (
              <>
                {groupPreview.isOriginal && (
                  <p className="rounded-md bg-red-100 text-red-800 px-3 py-2 font-medium">
                    {groupPreview.group.name} is one of the original groups, with years of history.
                    Make sure this is really what you want.
                  </p>
                )}
                <p>
                  Deletes the group, its invite link and settings, and all{" "}
                  <strong>{plural(groupPreview.players, "player")}</strong> in it. Anyone logged in to it
                  is signed out of it.
                </p>
              </>
            )}
            {playerPreview && (
              <p>
                Deletes <strong>{playerPreview.player.username}</strong> from{" "}
                <strong>{list(playerPreview.deletedFrom.map((d) => d.groupName))}</strong>
                {playerPreview.deletedFrom.length > 1 ? ` (${playerPreview.deletedFrom.length} groups)` : ""}.
                Their login code stops working there and they're signed out.
              </p>
            )}

            <div>
              <p className="font-medium">Also deleted:</p>
              {lines.length ? (
                <ul className="list-disc pl-5 space-y-0.5">
                  {lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-gray-500">No picks, results or logs.</p>
              )}
            </div>

            {(() => {
              const notes: string[] = [];
              if (groupPreview?.playersInOtherGroups.length) {
                notes.push(
                  `${list(groupPreview.playersInOtherGroups.map((p) => `${p.username} (${list(p.otherGroups)})`))} ` +
                    `${groupPreview.playersInOtherGroups.length === 1 ? "is" : "are"} also in other groups and stay there.`,
                );
              }
              if (playerPreview?.keptIn.length) {
                notes.push(`They stay in ${list(playerPreview.keptIn.map((k) => k.groupName))}.`);
              }
              if (playerPreview?.adminOf.length) {
                notes.push(
                  `They're the admin of ${list(playerPreview.adminOf.map((a) => a.groupName))}, which will be left with no admin.`,
                );
              }
              if (preview.counts.lmsWinsUnlinked) {
                notes.push(
                  `${plural(preview.counts.lmsWinsUnlinked, "LMS competition")} they won will show no winner.`,
                );
              }
              if (preview.counts.ruleChangesUnlinked) {
                notes.push(`${plural(preview.counts.ruleChangesUnlinked, "rule change")} they made stay, without their name.`);
              }
              if (!notes.length) return null;
              return (
                <div>
                  <p className="font-medium">Not deleted:</p>
                  <ul className="list-disc pl-5 space-y-0.5 text-gray-600">
                    {notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </div>
              );
            })()}

            {groupPreview && (
              <div className="space-y-1.5">
                <Label htmlFor="confirm-group-name">
                  Type <strong>{groupPreview.group.name}</strong> to confirm
                </Label>
                <Input
                  id="confirm-group-name"
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  autoComplete="off"
                  disabled={deleting}
                />
              </div>
            )}
            {groupPreview?.isOriginal && (
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={originalAck}
                  onCheckedChange={(v) => setOriginalAck(v === true)}
                  disabled={deleting}
                  data-testid="confirm-original-group"
                />
                <span>
                  I understand this deletes {groupPreview.group.name}'s entire history and can't be undone.
                </span>
              </label>
            )}
          </div>
        ) : null}

        {error && <p className="text-sm rounded-md px-3 py-2 bg-red-100 text-red-800">{error}</p>}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirmDelete} disabled={!canDelete}>
            {deleting ? "Deleting…" : "Delete permanently"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
