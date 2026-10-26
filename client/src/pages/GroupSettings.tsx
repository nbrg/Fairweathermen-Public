import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  isOwner: boolean;
  inviteToken: string | null;
};

// A labelled whole-number field.
function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  suffix,
  disabled,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  suffix?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-28"
        />
        {suffix && <span className="text-sm text-gray-500">{suffix}</span>}
      </div>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

// A labelled dropdown over a small set of options. NOTE: explicit JSX generic
// syntax (<SelectField<T> …>) type-checks and bundles under Rollup but Vite's
// dev transform (esbuild) rejects it — so this stays a plain generic function
// and callers pin the value type via the onChange param annotation.
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
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className="block h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

// Owner-only page (/group-settings) to tune a group's LMS / Lawro rules and
// grab the invite link. Members who aren't the admin see a read-only notice.
export default function GroupSettings() {
  const { group } = useGroup();
  const { toast } = useToast();
  const [data, setData] = useState<RulesResponse | null>(null);
  const [rules, setRules] = useState<GroupRules | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/group/rules", { credentials: "include" });
        if (!res.ok) return;
        const body = (await res.json()) as RulesResponse;
        if (cancelled) return;
        setData(body);
        setRules(body.rules);
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
    if (!rules) return;
    setSaving(true);
    try {
      const res = await fetch("/api/group/rules", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rules),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Couldn't save", description: body?.error || "Please try again.", variant: "destructive" });
        return;
      }
      setRules(body.rules);
      toast({ title: "Rules saved", description: "Your group's rules have been updated." });
    } finally {
      setSaving(false);
    }
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

  // Mint a fresh invite link; the old one stops working at once.
  async function resetInvite() {
    if (!window.confirm("Make a new invite link? The current one will stop working.")) return;
    setResetting(true);
    try {
      const res = await fetch("/api/group/invite/reset", { method: "POST", credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: "Couldn't reset the link", description: body?.error || "Please try again.", variant: "destructive" });
        return;
      }
      setData((d) => (d ? { ...d, inviteToken: body.inviteToken } : d));
      toast({ title: "New invite link ready", description: "The old link no longer works." });
    } finally {
      setResetting(false);
    }
  }

  if (loading || !rules || !data) {
    return <div className="min-h-screen bg-gray-100" />;
  }

  const games = new Set(data.enabledGames);
  const canEdit = data.isOwner;
  const inviteUrl = data.inviteToken ? `${window.location.origin}/join/${data.inviteToken}` : null;

  return (
    <div className="min-h-screen bg-gray-100 px-4 py-6">
      <div className="mx-auto max-w-lg space-y-6">
        <div>
          <h1 className="text-2xl font-bold">{group?.name} settings</h1>
          <p className="text-sm text-gray-500">
            {canEdit
              ? "Tune your group's rules. Changes apply going forward."
              : "Only the group admin can change these rules."}
          </p>
        </div>

        {inviteUrl && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Invite players</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Input readOnly value={inviteUrl} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" onClick={copyInvite}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Anyone who opens this link can join and get their own login code.
              </p>
              {canEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2 px-0 text-xs text-gray-500 hover:text-gray-700"
                  onClick={resetInvite}
                  disabled={resetting}
                >
                  {resetting ? "Making a new link…" : "Reset invite link"}
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {canEdit && <GroupPlayersCard groupId={group?.id} />}

        {games.has("predictions") && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Lawro (score predictions)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <NumberField
                label="Points for an exact score"
                value={rules.lawro.exactScorePoints}
                onChange={(n) => setLawro("exactScorePoints", n)}
                min={0}
                max={100}
                suffix="pts"
                disabled={!canEdit}
              />
              <NumberField
                label="Points for the correct result"
                value={rules.lawro.correctResultPoints}
                onChange={(n) => setLawro("correctResultPoints", n)}
                min={0}
                max={100}
                suffix="pts"
                disabled={!canEdit}
              />
              <NumberField
                label="Deadline before first kick-off"
                hint="How long before the gameweek's first match picks lock. 0 = at kick-off."
                value={rules.lawro.deadlineMinutesBeforeKickoff}
                onChange={(n) => setLawro("deadlineMinutesBeforeKickoff", n)}
                min={0}
                max={10080}
                suffix="minutes"
                disabled={!canEdit}
              />
              <SelectField
                label="If a player misses the deadline"
                value={rules.lawro.missedPickPolicy}
                onChange={(v: LawroMissedPolicy) => setLawro("missedPickPolicy", v)}
                disabled={!canEdit}
                options={[
                  { value: "blank", label: "Score nothing that week" },
                  { value: "random", label: "Fill a random scoreline" },
                ]}
              />
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label>Joker</Label>
                  <p className="text-xs text-gray-500">Each player picks one of their predictions every gameweek as their Joker, and whatever it scores counts double.</p>
                </div>
                <Switch
                  checked={rules.lawro.jokerEnabled}
                  onCheckedChange={(v) => setLawro("jokerEnabled", v)}
                  disabled={!canEdit}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {games.has("lms") && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Last Man Standing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <NumberField
                label="Buy-in / prize pot"
                hint="Applied to new competitions."
                value={rules.lms.buyIn}
                onChange={(n) => setLms("buyIn", n)}
                min={0}
                max={100000}
                disabled={!canEdit}
              />
              <NumberField
                label="Lives"
                hint="How many losing picks a player survives before being knocked out."
                value={rules.lms.lives}
                onChange={(n) => setLms("lives", n)}
                min={1}
                max={10}
                disabled={!canEdit}
              />
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label>Allow reusing teams</Label>
                  <p className="text-xs text-gray-500">Let players pick the same team in more than one week.</p>
                </div>
                <Switch
                  checked={rules.lms.allowTeamReuse}
                  onCheckedChange={(v) => setLms("allowTeamReuse", v)}
                  disabled={!canEdit}
                />
              </div>
              <NumberField
                label="Deadline before first kick-off"
                hint="How long before the gameweek's first match selections lock. 0 = at kick-off."
                value={rules.lms.deadlineMinutesBeforeKickoff}
                onChange={(n) => setLms("deadlineMinutesBeforeKickoff", n)}
                min={0}
                max={10080}
                suffix="minutes"
                disabled={!canEdit}
              />
              <SelectField
                label="If a player misses the deadline"
                value={rules.lms.missedPickPolicy}
                onChange={(v: LmsMissedPolicy) => setLms("missedPickPolicy", v)}
                disabled={!canEdit}
                options={[
                  { value: "random", label: "Assign a random team" },
                  { value: "eliminate", label: "Knock them out" },
                  { value: "skip", label: "Let them sit the week out" },
                ]}
              />
              <SelectField
                label="If everyone goes out together"
                value={rules.lms.allOutPolicy}
                onChange={(v: LmsAllOutPolicy) => setLms("allOutPolicy", v)}
                disabled={!canEdit}
                options={[
                  { value: "rollover", label: "No winner; pot rolls into a new competition" },
                  { value: "revive", label: "Revive everyone; carry on the same competition" },
                  { value: "co_winners", label: "They share the win" },
                  { value: "no_winner", label: "No winner; competition just ends" },
                ]}
              />
            </CardContent>
          </Card>
        )}

        {canEdit && (
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save rules"}
            </Button>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setRules(DEFAULT_GROUP_RULES)}
            >
              Reset to defaults
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
