import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useGroup } from "@/contexts/GroupContext";

const GAME_NAMES: Record<string, string> = { lawro: "Lawro", lms: "Last Man Standing" };

// Tells every player when their group's admin has changed the rules, so a
// change can never go unnoticed. Shows each unacknowledged change once; "Got
// it" (or closing it) records it as seen on the server.
export default function RuleChangesDialog() {
  const { group, dismissRuleChanges } = useGroup();
  const pending = group?.ruleChanges ?? [];
  if (!group || pending.length === 0) return null;

  const latestId = pending[pending.length - 1].id;
  const acknowledge = () => dismissRuleChanges(latestId);
  const names = Array.from(new Set(pending.map((c) => c.changedByName).filter((n): n is string => !!n)));
  const who = names.length > 0 ? names.join(" and ") : `${group.name}'s admin`;

  return (
    <Dialog open onOpenChange={(open) => !open && acknowledge()}>
      <DialogContent className="max-w-md">
        <DialogHeader className="text-left">
          <span className="eyebrow">Rule change</span>
          <DialogTitle className="font-display text-[26px] font-bold leading-tight">
            {who} has changed the rules
          </DialogTitle>
          <DialogDescription>Here's what's different in {group.name}.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          {pending.map((change) => (
            <div key={change.id} className="space-y-2">
              <p className="eyebrow">
                {new Date(change.changedAt).toLocaleString("en-GB", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
              {(["lawro", "lms"] as const).map((game) => {
                const items = change.changes.filter((c) => c.game === game);
                if (items.length === 0) return null;
                const from =
                  game === "lawro" && change.lawroEffectiveGameweek != null
                    ? change.lawroEffectiveGameweek >= 99
                      ? " (from next season)"
                      : ` (from gameweek ${change.lawroEffectiveGameweek})`
                    : "";
                return (
                  <div key={game} className="overflow-hidden rounded-xl border border-border">
                    <p className="bg-muted px-3 py-2 text-sm font-semibold">
                      {GAME_NAMES[game]}
                      {from}
                    </p>
                    <ul className="divide-y divide-border text-sm">
                      {items.map((item) => (
                        <li key={item.key} className="px-3 py-2.5">
                          <div className="text-muted-foreground">{item.label}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2">
                            <span className="text-gray-400 line-through">{item.from}</span>
                            <span aria-hidden className="text-gray-400">→</span>
                            <span className="font-semibold">{item.to}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={acknowledge} className="h-11 w-full rounded-xl sm:w-auto sm:px-6">Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
