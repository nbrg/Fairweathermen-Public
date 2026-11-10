import { useEffect, useState } from "react";
import {
  getPushState,
  enablePush,
  disablePush,
  getPreferences,
  setLeads as saveLeads,
  type PushState,
} from "@/lib/push";
import { useGroup } from "@/contexts/GroupContext";
import { REMINDER_LEAD_PRESETS_MINUTES } from "@shared/schema";

// "15 minutes" / "1 hour" / "3 hours" / "24 hours" for a minutes value.
function leadLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const h = minutes / 60;
  return h === 1 ? "1 hour" : `${h} hours`;
}

// Kickoff reminders for this device, shown inline on the Settings page (it
// used to be the bell in the header): turn them on/off and choose how long
// before kickoff. Reminders fire only if the player is still incomplete
// (Lawro) or hasn't picked (LMS). On iPhone they need the Home Screen app
// first — the Settings page's "Add to Home Screen" row explains how.
export function ReminderSettings() {
  const { group, availableGroups } = useGroup();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leads, setLeads] = useState<number[]>([60]);

  // Describe only the games they actually play, across all their groups.
  const games = new Set<string>(group?.enabledGames ?? []);
  for (const g of availableGroups) for (const key of g.enabledGames ?? []) games.add(key);
  const hasLawro = games.has("predictions");
  const hasLms = games.has("lms");
  const reminderBlurb =
    hasLawro && hasLms
      ? "if you still haven't made your Lawro predictions or picked your Last Man Standing team"
      : hasLawro
        ? "if you still haven't made your Lawro predictions"
        : hasLms
          ? "if you still haven't picked your Last Man Standing team"
          : "if you still have picks to make";

  useEffect(() => {
    getPushState().then(setState).catch(() => setState("unsupported"));
    getPreferences().then((p) => setLeads(p.leads.length ? p.leads : [60])).catch(() => {});
  }, []);

  // Toggle one preset on/off (keeping at least one selected).
  const toggleLead = async (minutes: number) => {
    const next = leads.includes(minutes)
      ? leads.filter((m) => m !== minutes)
      : [...leads, minutes].sort((a, b) => a - b);
    if (next.length === 0) return;
    setLeads(next);
    if (state === "enabled") {
      try {
        await saveLeads(next);
      } catch {
        /* non-fatal — will still apply on next enable */
      }
    }
  };

  const enabled = state === "enabled";
  const handleToggle = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(enabled ? await disablePush() : await enablePush(leads));
    } catch (err: any) {
      setError(err?.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="reminder-settings">
      <p className="text-sm text-muted-foreground">
        Get a notification before first kick-off {reminderBlurb}.
      </p>
      {state === null ? null : state === "unsupported" ? (
        <p className="text-sm text-muted-foreground">This browser can't show notifications.</p>
      ) : state === "needs-install" ? (
        <p className="text-sm text-foreground">
          On iPhone, reminders only work in the Home Screen app. Add Fairweathermen to your Home
          Screen (below), open it from there, then turn reminders on here.
        </p>
      ) : state === "denied" ? (
        <p className="text-sm text-foreground">
          Notifications are blocked for this site. To use reminders, allow notifications for
          Fairweathermen in your browser or phone settings, then come back.
        </p>
      ) : (
        <>
          <div className="space-y-1">
            <span className="text-sm font-medium text-foreground">Remind me (pick any)</span>
            <div className="divide-y rounded-lg border">
              {REMINDER_LEAD_PRESETS_MINUTES.map((m) => (
                <label
                  key={m}
                  className={`flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm ${busy ? "opacity-60" : ""}`}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={leads.includes(m)}
                    disabled={busy}
                    onChange={() => toggleLead(m)}
                  />
                  <span className="font-medium text-foreground">{leadLabel(m)} before</span>
                </label>
              ))}
            </div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={handleToggle}
            className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-60 ${
              enabled
                ? "border border-input bg-card text-foreground hover:bg-muted"
                : "bg-primary text-white hover:bg-primary/90"
            }`}
          >
            {busy ? "…" : enabled ? "Turn off reminders on this device" : "Turn on reminders"}
          </button>
          {enabled && (
            <p className="text-center text-xs text-muted-foreground">
              Reminders on — {leads.map((m) => leadLabel(m)).join(", ")} before kickoff.
            </p>
          )}
        </>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

export default ReminderSettings;
