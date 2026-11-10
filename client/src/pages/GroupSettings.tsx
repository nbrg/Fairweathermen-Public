import { useEffect, useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, ChevronRight, Lock } from "lucide-react";
import { useGroup } from "@/contexts/GroupContext";
import { useToast } from "@/hooks/use-toast";
import GroupPlayersCard from "@/components/GroupPlayersCard";
import {
  DEFAULT_GROUP_RULES,
  type GroupRules,
  type LawroMissedPolicy,
  type LmsMissedPolicy,
  type LmsAllOutPolicy,
} from "@shared/schema";

type RulesResponse = {
  rules: GroupRules;
  enabledGames: string[];
  // LMS rules freeze once the running competition starts. Lawro rules never
  // freeze; a change applies from `lawroEffectiveFrom` (the next gameweek whose
  // deadline hasn't passed), so locked gameweeks keep the rules they had.
  live: { lms: boolean; lawroEffectiveFrom: { season: string | null; gameweek: number } | null };
  isOwner: boolean;
  inviteToken: string | null;
};

// One rule as a tappable row: its name on the left and its current value on the
// right. Tapping opens a small pop-up holding the editor; edits go straight into
// the page's draft rules, and "Save rules" at the bottom still saves them all.
// A frozen (disabled) rule shows its value with a lock and doesn't open.
function RuleRow({
  label,
  value,
  hint,
  disabled,
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="flex min-h-[56px] w-full items-center justify-between gap-3 py-3 text-left disabled:cursor-not-allowed"
      >
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{label}</span>
        <span className="flex min-w-0 max-w-[55%] items-center gap-1.5 text-sm text-muted-foreground">
          <span className="truncate">{value}</span>
          {disabled ? (
            <Lock className="h-3.5 w-3.5 shrink-0" aria-label="Locked" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
          )}
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader className="text-left">
            <DialogTitle className="pr-8 text-lg">{label}</DialogTitle>
            {hint && <DialogDescription className="text-left text-sm leading-relaxed">{hint}</DialogDescription>}
          </DialogHeader>
          {children(() => setOpen(false))}
        </DialogContent>
      </Dialog>
    </>
  );
}

// A whole-number rule. `format` turns the value into the row's summary.
function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  suffix,
  format,
  disabled,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  suffix?: string;
  format?: (n: number) => string;
  disabled?: boolean;
}) {
  const summary = format ? format(value) : suffix ? `${value} ${suffix}` : String(value);
  return (
    <RuleRow label={label} value={summary} hint={hint} disabled={disabled}>
      {(close) => (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <div className="flex items-center gap-2">
            {/* 16px+ text so iOS doesn't zoom into the field. */}
            <Input
              type="number"
              inputMode="numeric"
              min={min}
              max={max}
              value={value}
              autoFocus
              onChange={(e) => onChange(Number(e.target.value))}
              className="h-12 flex-1 rounded-xl text-center font-display text-2xl font-bold tabular-nums"
            />
            {suffix && <span className="w-16 text-sm text-muted-foreground">{suffix}</span>}
          </div>
          <Button type="submit" className="h-11 w-full rounded-xl">
            Done
          </Button>
        </form>
      )}
    </RuleRow>
  );
}

// A rule with a small set of options, picked from a list in the pop-up.
function SelectField<T extends string>({
  label,
  hint,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  hint?: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; description?: string }[];
  disabled?: boolean;
}) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <RuleRow label={label} value={current} hint={hint} disabled={disabled}>
      {(close) => (
        <div role="radiogroup" aria-label={label} className="space-y-2">
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  onChange(o.value);
                  close();
                }}
                className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm transition-colors ${
                  selected
                    ? "border-primary bg-primary/[0.06] font-semibold text-foreground"
                    : "border-border hover:bg-muted"
                }`}
              >
                <span>
                  {o.label}
                  {o.description && (
                    <span className="mt-1 block text-xs font-normal text-muted-foreground">{o.description}</span>
                  )}
                </span>
                {selected && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
    </RuleRow>
  );
}

// A labelled on/off rule.
function SwitchField({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor={id} className="text-sm font-medium leading-snug">{label}</Label>
        {hint && <p className="text-xs leading-relaxed text-gray-500">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

// "At kick-off" / "30 min before" summary for a deadline-offset rule.
function deadlineSummary(minutes: number): string {
  return minutes === 0 ? "At kick-off" : `${minutes} min before`;
}

// Shown at the top of a game's card once that game has started.
function FrozenNotice({ children }: { children: string }) {
  return (
    <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
      {children}
    </p>
  );
}

// Explains when a Lawro change takes effect.
function InfoNotice({ children }: { children: string }) {
  return (
    <p className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-800">
      {children}
    </p>
  );
}

// The group admin's part of the Settings page (/settings, which /group-settings
// also opens): the invite link, players, and the LMS / Lawro rules. Only the
// group's owner sees it. Only the games the group plays are shown, and a
// game's rules can only be changed before that game starts. The server
// enforces both the admin-only access and the freeze; this just reflects them.
export function GroupAdminSettings() {
  return <GroupSettingsContent />;
}

function GroupSettingsContent() {
  const { group, refreshSession } = useGroup();
  const { toast } = useToast();
  const [data, setData] = useState<RulesResponse | null>(null);
  const [rules, setRules] = useState<GroupRules | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  // The rules as last loaded/saved, to tell whether there's anything to save.
  const [savedRules, setSavedRules] = useState<GroupRules | null>(null);
  const dirty = rules != null && savedRules != null && JSON.stringify(rules) !== JSON.stringify(savedRules);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setForbidden(false);
      try {
        const res = await fetch("/api/group/rules", { credentials: "include" });
        if (cancelled) return;
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        if (!res.ok) return;
        const body = (await res.json()) as RulesResponse;
        if (cancelled) return;
        setData(body);
        setRules(body.rules);
        setSavedRules(body.rules);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [group?.id]);

  function setLawro<K extends keyof GroupRules["lawro"]>(key: K, value: GroupRules["lawro"][K]) {
    setRules((r) => (r ? { ...r, lawro: { ...r.lawro, [key]: value } } : r));
  }
  function setLms<K extends keyof GroupRules["lms"]>(key: K, value: GroupRules["lms"][K]) {
    setRules((r) => (r ? { ...r, lms: { ...r.lms, [key]: value } } : r));
  }

  async function save() {
    if (!rules || !data) return;
    setSaving(true);
    try {
      // Only send the games that can still change; a started game's rules are
      // frozen (the server would refuse them anyway).
      const payload: Partial<GroupRules> = {};
      payload.lawro = rules.lawro;
      if (!data.live.lms) payload.lms = rules.lms;
      const res = await fetch("/api/group/rules", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Couldn't save", description: body?.error || "Please try again.", variant: "destructive" });
        return;
      }
      setRules(body.rules);
      setSavedRules(body.rules);
      // Update the session too, so the game pages use the new rules right away.
      void refreshSession();
      toast({
        title: "Rules saved",
        description: "Everyone in the group will see a message about what changed.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function resetInvite() {
    if (!window.confirm("Make a new invite link? The current link will stop working. Players already in the group aren't affected.")) return;
    const res = await fetch("/api/group/invite/reset", { method: "POST", credentials: "include" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast({ title: "Couldn't reset the link", description: body?.error || "Please try again.", variant: "destructive" });
      return;
    }
    setData((d) => (d ? { ...d, inviteToken: body.inviteToken } : d));
    toast({ title: "New invite link ready", description: "The old link no longer works." });
  }

  async function copyInvite() {
    if (!data?.inviteToken) return;
    const url = `${window.location.origin}/join/${data.inviteToken}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — link is shown to copy manually */
    }
  }

  if (forbidden) {
    return (
      <div>
        <div>
          <Card>
            <CardContent className="py-10 text-center">
              <p className="text-base font-medium text-gray-700">Group settings are for the admin</p>
              <p className="mt-2 text-sm text-gray-500">
                Only the person who created {group?.name ?? "this group"} can view or change its settings.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (loading || !rules || !data) {
    return null;
  }

  const games = new Set(data.enabledGames);
  const lawroFrom = data.live.lawroEffectiveFrom;
  const lmsFrozen = data.live.lms;
  const shownGames = [games.has("predictions"), games.has("lms") && !lmsFrozen];
  const anyEditable = shownGames.some(Boolean);
  const inviteUrl = data.inviteToken ? `${window.location.origin}/join/${data.inviteToken}` : null;

  return (
    <section id="group-admin" aria-labelledby="group-admin-title" className={`scroll-mt-4 ${dirty ? "pb-20" : ""}`}>
      <div className="space-y-4 sm:space-y-6">
        <div className="px-1 pt-2">
          <h2 id="group-admin-title" className="eyebrow">Group admin · {group?.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Only you see this. Everyone in the group is told whenever the rules change.
          </p>
        </div>

        {inviteUrl && (
          <Card>
            <CardHeader className="p-4 pb-3 sm:p-6 sm:pb-4">
              <CardTitle className="text-base sm:text-lg">Invite players</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={inviteUrl}
                  className="h-10 min-w-0 flex-1 font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" variant="outline" className="h-10 w-20 shrink-0" onClick={copyInvite}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="mt-2 flex items-start justify-between gap-3">
                <p className="text-xs text-gray-500">
                  Anyone who opens this link can join and get their own login code.
                </p>
                <button type="button" className="shrink-0 text-xs font-medium text-gray-700 underline" onClick={resetInvite}>
                  New link
                </button>
              </div>
            </CardContent>
          </Card>
        )}

        <GroupPlayersCard groupId={group?.id} />

        {games.has("predictions") && (
          <Card>
            <CardHeader className="p-4 pb-3 sm:p-6 sm:pb-4">
              <CardTitle className="text-base sm:text-lg">Lawro (score predictions)</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              <InfoNotice>
                {lawroFrom
                  ? `Changes apply from gameweek ${lawroFrom.gameweek}, the next one whose deadline hasn't passed. Gameweeks already locked keep the rules they were played under.`
                  : "Changes apply from next season. Gameweeks already locked keep the rules they were played under."}
              </InfoNotice>
              <div className="divide-y divide-border">
              <NumberField
                label="Points for an exact score"
                value={rules.lawro.exactScorePoints}
                onChange={(n) => setLawro("exactScorePoints", n)}
                min={0}
                max={100}
                suffix="pts"
                format={(n) => `${n} ${n === 1 ? "pt" : "pts"}`}
              />
              <NumberField
                label="Points for the correct result"
                value={rules.lawro.correctResultPoints}
                onChange={(n) => setLawro("correctResultPoints", n)}
                min={0}
                max={100}
                suffix="pts"
                format={(n) => `${n} ${n === 1 ? "pt" : "pts"}`}
              />
              <NumberField
                label="Deadline before first kick-off"
                hint="How long before the gameweek's first match picks lock. 0 = at kick-off."
                value={rules.lawro.deadlineMinutesBeforeKickoff}
                onChange={(n) => setLawro("deadlineMinutesBeforeKickoff", n)}
                min={0}
                max={10080}
                suffix="minutes"
                format={deadlineSummary}
              />
              <SelectField
                label="If a player misses the deadline"
                value={rules.lawro.missedPickPolicy}
                onChange={(v: LawroMissedPolicy) => setLawro("missedPickPolicy", v)}
                hint={
                  rules.lawro.missedPickPolicy === "open_until_kickoff"
                    ? "Late players can add picks for any match that hasn't kicked off. Picks made before the deadline still lock at the deadline, and each match's picks stay hidden until it kicks off."
                    : undefined
                }
                options={[
                  { value: "blank", label: "Score nothing that week" },
                  { value: "random", label: "Fill a random scoreline" },
                  { value: "open_until_kickoff", label: "Let them still predict matches that haven't kicked off" },
                ]}
              />
              <SwitchField
                id="lawro-joker"
                label="Joker"
                hint="Each player picks one of their predictions every gameweek as their Joker, and whatever it scores counts double."
                checked={rules.lawro.jokerEnabled}
                onChange={(v) => setLawro("jokerEnabled", v)}
              />
              </div>
            </CardContent>
          </Card>
        )}

        {games.has("lms") && (
          <Card>
            <CardHeader className="p-4 pb-3 sm:p-6 sm:pb-4">
              <CardTitle className="text-base sm:text-lg">Last Man Standing</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
              {lmsFrozen && (
                <FrozenNotice>
                  The current competition has started, so these rules are locked until the next one opens.
                </FrozenNotice>
              )}
              <div className="divide-y divide-border">
              <NumberField
                label="Buy-in / prize pot"
                hint="Applies to the next competition, and to the current one until it starts."
                value={rules.lms.buyIn}
                onChange={(n) => setLms("buyIn", n)}
                min={0}
                max={100000}
                format={(n) => `£${n}`}
                disabled={lmsFrozen}
              />
              <NumberField
                label="Lives"
                hint="How many losing picks a player survives before being knocked out."
                value={rules.lms.lives}
                onChange={(n) => setLms("lives", n)}
                min={1}
                max={10}
                disabled={lmsFrozen}
              />
              <NumberField
                label="Deadline before first kick-off"
                hint="How long before the gameweek's first match selections lock. 0 = at kick-off."
                value={rules.lms.deadlineMinutesBeforeKickoff}
                onChange={(n) => setLms("deadlineMinutesBeforeKickoff", n)}
                min={0}
                max={10080}
                suffix="minutes"
                format={deadlineSummary}
                disabled={lmsFrozen}
              />
              <SelectField
                label="If a player misses the deadline"
                value={rules.lms.missedPickPolicy}
                onChange={(v: LmsMissedPolicy) => setLms("missedPickPolicy", v)}
                disabled={lmsFrozen}
                hint={
                  rules.lms.missedPickPolicy === "eliminate"
                    ? "A missed pick counts as a losing pick: it costs one life, and knocks them out only if it was their last."
                    : undefined
                }
                options={[
                  { value: "random", label: "Assign a random team" },
                  { value: "eliminate", label: "Knock them out (costs a life)" },
                ]}
              />
              <SelectField
                label="If everyone goes out together"
                value={rules.lms.allOutPolicy}
                onChange={(v: LmsAllOutPolicy) => setLms("allOutPolicy", v)}
                disabled={lmsFrozen}
                hint="A new competition starts straight after either way."
                options={[
                  { value: "rollover", label: "Everyone's back in; the pot rolls over" },
                  { value: "co_winners", label: "The players who went out last split the pot" },
                ]}
              />
              </div>
            </CardContent>
          </Card>
        )}

        {anyEditable && (
          <div className="flex justify-end px-1">
            <button
              type="button"
              className="text-xs font-medium text-muted-foreground underline"
              onClick={() =>
                setRules((r) =>
                  r
                    ? {
                        lawro: DEFAULT_GROUP_RULES.lawro,
                        lms: lmsFrozen ? r.lms : DEFAULT_GROUP_RULES.lms,
                      }
                    : r,
                )
              }
            >
              Reset rules to defaults
            </button>
          </div>
        )}

        {anyEditable && dirty && (
          // Only while there are unsaved changes. On phones it sits just above
          // the bottom nav (4rem + the home-indicator inset); from md up, at
          // the bottom of the window.
          <div
            data-testid="rules-save-bar"
            className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 border-t border-border bg-card/95 px-3 py-3 backdrop-blur sm:px-4 md:bottom-0 md:pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
          >
            <div className="mx-auto flex max-w-lg flex-row-reverse items-center gap-2">
              <Button className="h-11 flex-1 text-base sm:h-10 sm:flex-none sm:text-sm" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save rules"}
              </Button>
              <Button
                variant="ghost"
                className="h-11 sm:h-10"
                disabled={saving}
                onClick={() => setRules(savedRules)}
              >
                Undo changes
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
