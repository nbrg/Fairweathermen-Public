import { useEffect, useState } from "react";
import { Bell, BellRing, Share } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getPushState,
  enablePush,
  disablePush,
  getPreferences,
  setLeads as saveLeads,
  reportPwaLaunchOnce,
  isIos,
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

// Bell in the header that lets a player turn kickoff reminders on/off for this
// device and choose how long before kickoff to be reminded. Reminders fire only
// if they're still incomplete (Lawro) or haven't picked (LMS).
export function NotificationBell() {
  const { group, availableGroups } = useGroup();
  const [state, setState] = useState<PushState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leads, setLeads] = useState<number[]>([60]);

  // If we're running as an installed PWA, record it once so the owner can see
  // who's actually installed the app.
  useEffect(() => {
    reportPwaLaunchOnce();
  }, []);

  // Reminders span every group the person is in, so describe only the games
  // they actually play. Union the games across the active group + all their
  // groups.
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

  const refresh = () => {
    getPushState().then(setState).catch(() => setState("unsupported"));
    getPreferences().then((p) => setLeads(p.leads.length ? p.leads : [60])).catch(() => {});
  };
  useEffect(() => {
    refresh();
  }, []);

  // Toggle one preset on/off (keeping at least one selected).
  const toggleLead = async (minutes: number) => {
    const next = leads.includes(minutes)
      ? leads.filter((m) => m !== minutes)
      : [...leads, minutes].sort((a, b) => a - b);
    if (next.length === 0) return; // never leave zero selected
    setLeads(next);
    if (state === "enabled") {
      try {
        await saveLeads(next);
      } catch {
        /* non-fatal — will still apply on next enable */
      }
    }
  };

  // Hide the bell entirely where push can't work at all (e.g. desktop browsers
  // without push). On iOS-not-installed we still show it, to explain install.
  if (state === null || state === "unsupported") return null;

  const enabled = state === "enabled";

  const handleToggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = enabled ? await disablePush() : await enablePush(leads);
      setState(next);
    } catch (err: any) {
      setError(err?.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          refresh();
          setOpen(true);
        }}
        aria-label="Reminders"
        className="relative flex h-10 w-10 items-center justify-center rounded-full text-white/90 hover:bg-white/10 hover:text-white"
      >
        {enabled ? <BellRing className="h-5 w-5" /> : <Bell className="h-5 w-5" />}
        {enabled && (
          <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-secondary ring-2 ring-primary" />
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Kickoff reminders</DialogTitle>
            <DialogDescription>
              Get a notification before first kick-off {reminderBlurb}.
            </DialogDescription>
          </DialogHeader>

          {state === "needs-install" ? (
            <div className="space-y-3 text-sm text-gray-700">
              <p className="font-medium">Add Fairweathermen to your Home Screen first</p>
              <p>
                On iPhone, notifications only work once the site is installed.
                {isIos() ? " In Safari:" : ""}
              </p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  Tap the Share button <Share className="inline h-4 w-4 align-text-bottom" />
                </li>
                <li>Choose <span className="font-medium">Add to Home Screen</span></li>
                <li>Open Fairweathermen from your Home Screen, then turn reminders on here</li>
              </ol>
            </div>
          ) : state === "denied" ? (
            <div className="space-y-2 text-sm text-gray-700">
              <p>
                Notifications are blocked for this site. To use reminders, enable
                notifications for Fairweathermen in your browser or phone
                settings, then come back.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <span className="text-sm font-medium text-gray-700">Remind me (pick any)</span>
                <div className="divide-y rounded-lg border">
                  {REMINDER_LEAD_PRESETS_MINUTES.map((m) => {
                    const on = leads.includes(m);
                    return (
                      <label
                        key={m}
                        className={`flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm ${
                          busy ? "opacity-60" : ""
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={on}
                          disabled={busy}
                          onChange={() => toggleLead(m)}
                        />
                        <span className="font-medium text-gray-800">{leadLabel(m)} before</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={handleToggle}
                className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-60 ${
                  enabled
                    ? "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50"
                    : "bg-primary text-white hover:bg-primary/90"
                }`}
              >
                {busy
                  ? "…"
                  : enabled
                    ? "Turn off reminders on this device"
                    : "Turn on reminders"}
              </button>
              {enabled && (
                <p className="text-center text-xs text-gray-500">
                  Reminders on — {leads.map((m) => leadLabel(m)).join(", ")} before kickoff.
                </p>
              )}
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}
