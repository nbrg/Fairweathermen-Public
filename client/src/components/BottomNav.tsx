import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Settings, Shield, Flag } from "lucide-react";
import { useGroup } from "@/contexts/GroupContext";
import { useGameTabs } from "@/lib/gameTabs";

// A football (pentagon panel + seams), for Lawro. lucide has no soccer ball.
function FootballIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 7l4.2 3-1.6 5h-5.2L7.8 10z" />
      <path d="M12 2v5M16.2 10l5.3-1.7M14.6 15l3.2 4.4M9.4 15l-3.2 4.4M7.8 10L2.5 8.3" />
    </svg>
  );
}

const ICONS: Record<string, (p: { className?: string }) => ReactNode> = {
  lms: Shield,
  predictions: FootballIcon,
};

// Pages that render without the app chrome (public sign-up pages).
const HIDDEN_ON = [/^\/create$/i, /^\/join\//i];

// True while a text field has focus: the on-screen keyboard is up, and iOS
// would push a fixed bar up over it (and over the Lawro score boxes).
function useTypingFocus(): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const isField = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"])') ||
        el.matches("textarea, select, [contenteditable='true']"));
    const onIn = (e: FocusEvent) => setTyping(isField(e.target));
    const onOut = (e: FocusEvent) => {
      if (!isField(e.relatedTarget)) setTyping(false);
    };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, []);
  return typing;
}

// Phone-only bottom navigation: one tab per game the person plays (any of
// their groups, same rules as the desktop header tabs) plus Settings. Shown
// even with a single game, so Settings is always in the same place. A red
// dot marks a game where they still owe picks this gameweek
// (GET /api/group/picks-due). From md up the header carries the game tabs and
// a Settings cog instead.
export function BottomNav() {
  const [location] = useLocation();
  const { group } = useGroup();
  const { visibleTabs, gameToGroupId, isActiveTab, isSameGroup, openGame } = useGameTabs();
  const typing = useTypingFocus();

  type GamesDue = { lms: boolean; predictions: boolean };
  const { data: due, refetch } = useQuery<GamesDue & { groups: Record<number, GamesDue> }>({
    queryKey: ["/api/group/picks-due"],
    enabled: !!group,
    refetchInterval: 60_000,
    retry: false,
  });
  // Re-check when moving between pages (e.g. straight after making a pick).
  useEffect(() => {
    if (group) void refetch();
  }, [location, group, refetch]);

  if (!group || HIDDEN_ON.some((re) => re.test(location))) return null;

  const settingsActive = location === "/settings" || location === "/group-settings";
  const itemClass = (active: boolean) =>
    `relative flex min-w-0 flex-1 flex-col items-center gap-0.5 pt-1.5 text-[11px] font-semibold transition-colors ${
      active ? "text-primary" : "text-muted-foreground hover:text-foreground"
    }`;
  const pill = (active: boolean) =>
    `flex h-8 w-14 items-center justify-center rounded-full transition-colors ${active ? "bg-primary/10" : ""}`;

  return (
    <>
      {/* Keeps the end of the page clear of the fixed bar. */}
      <div aria-hidden className="h-16 md:hidden" />
      <nav
        aria-label="Main"
        data-testid="bottom-nav"
        className={`fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur md:hidden ${
          typing ? "hidden" : "flex"
        }`}
        style={{ paddingBottom: "calc(0.375rem + env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto flex w-full max-w-md px-2">
          {visibleTabs.map((tab) => {
            const Icon = ICONS[tab.key] ?? Shield;
            const active = isActiveTab(tab.key);
            // Owed in the group this tab opens (see GET /api/group/picks-due).
            const hostDue = due?.groups?.[gameToGroupId.get(tab.key) ?? -1];
            const owes = tab.key === "lms" ? hostDue?.lms : tab.key === "predictions" ? hostDue?.predictions : false;
            const content = (
              <>
                <span className={pill(active)}>
                  <Icon className="h-[22px] w-[22px]" />
                </span>
                <span className="truncate" data-nav-label>{tab.short ?? tab.label}</span>
                {owes && (
                  <span
                    aria-hidden
                    data-testid={`picks-due-${tab.key}`}
                    className="absolute top-1 left-1/2 ml-2.5 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-card"
                  />
                )}
              </>
            );
            return isSameGroup(tab.key) ? (
              <Link key={tab.key} href={tab.route} className={itemClass(active)} aria-current={active ? "page" : undefined} title={owes ? "Picks still to make" : undefined}>
                {content}
              </Link>
            ) : (
              <button key={tab.key} type="button" onClick={() => openGame(tab.key, tab.route)} className={itemClass(active)} title={owes ? "Picks still to make" : undefined}>
                {content}
              </button>
            );
          })}
          <Link href="/settings" className={itemClass(settingsActive)} aria-current={settingsActive ? "page" : undefined}>
            <span className={pill(settingsActive)}>
              <Settings className="h-[22px] w-[22px]" />
            </span>
            <span data-nav-label>Settings</span>
          </Link>
        </div>
      </nav>
    </>
  );
}

export default BottomNav;
