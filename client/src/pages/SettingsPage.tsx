import { useEffect } from "react";
import { useLocation } from "wouter";
import { Monitor, Moon, Share, Sun } from "lucide-react";
import Header from "@/components/Header";
import ReminderSettings from "@/components/ReminderSettings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useGroup } from "@/contexts/GroupContext";
import { useThemeChoice, type ThemeChoice } from "@/lib/theme";
import { isIos, isStandalone } from "@/lib/push";
import { GroupAdminSettings } from "@/pages/GroupSettings";

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Auto", icon: Monitor },
];

function ThemePicker() {
  const [choice, setChoice] = useThemeChoice();
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
      {THEMES.map(({ value, label, icon: Icon }) => {
        const on = choice === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setChoice(value)}
            className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-sm transition-colors ${
              on ? "bg-card font-semibold text-foreground shadow-sm" : "font-medium text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="p-4 pb-3 sm:p-6 sm:pb-4">
        <CardTitle className="text-base sm:text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">{children}</CardContent>
    </Card>
  );
}

// Settings (/settings — the bottom nav's Settings tab on phones, the header
// cog on desktop): theme, kickoff reminders, adding the app to the Home
// Screen and logging out for everyone; plus, for the group's owner, all of
// the group admin settings (invite link, players, Lawro and LMS rules).
// /group-settings opens this page too, scrolled to the admin part.
export default function SettingsPage({ focusAdmin = false }: { focusAdmin?: boolean }) {
  const { group, logout } = useGroup();
  const [, navigate] = useLocation();
  const installed = isStandalone();

  useEffect(() => {
    if (!focusAdmin || !group?.isOwner) return;
    // The admin section appears once its rules have loaded; wait for it.
    let tries = 0;
    const t = setInterval(() => {
      const el = document.getElementById("group-admin");
      if (el || ++tries > 30) {
        clearInterval(t);
        el?.scrollIntoView();
      }
    }, 100);
    return () => clearInterval(t);
  }, [focusAdmin, group?.isOwner]);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="px-3 pb-6 pt-4 sm:px-4 sm:pt-6">
        <div className="mx-auto max-w-lg space-y-4 sm:space-y-6">
          <h1 className="px-1 text-xl font-bold leading-tight sm:text-2xl">Settings</h1>

          <Section title="Appearance">
            <ThemePicker />
            <p className="mt-2 text-xs text-muted-foreground">Auto follows your phone's light or dark setting.</p>
          </Section>

          <Section title="Kickoff reminders">
            <ReminderSettings />
          </Section>

          {!installed && (
            <Section title="Add to Home Screen">
              <div className="space-y-2 text-sm text-foreground" data-testid="install-help">
                <p>Open Fairweathermen like an app, full screen, from your Home Screen.</p>
                {isIos() ? (
                  <ol className="list-decimal space-y-1 pl-5">
                    <li>
                      In Safari, tap the Share button <Share className="inline h-4 w-4 align-text-bottom" aria-label="Share" />
                    </li>
                    <li>Choose <span className="font-medium">Add to Home Screen</span></li>
                    <li>Open Fairweathermen from your Home Screen</li>
                  </ol>
                ) : (
                  <p className="text-muted-foreground">
                    In Chrome, open the ⋮ menu and choose <span className="font-medium text-foreground">Add to Home screen</span> (or{" "}
                    <span className="font-medium text-foreground">Install app</span>).
                  </p>
                )}
              </div>
            </Section>
          )}

          <Section title="Account">
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 text-sm text-muted-foreground">
                Signed in as <span className="font-medium text-foreground">{group?.user?.username}</span>
              </p>
              <Button
                variant="outline"
                className="shrink-0"
                onClick={async () => {
                  await logout();
                  navigate("/");
                }}
              >
                Log out
              </Button>
            </div>
          </Section>

          {group?.isOwner && <GroupAdminSettings />}
        </div>
      </div>
    </div>
  );
}
