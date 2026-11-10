import { Link, useLocation } from "wouter";
import { useGroup } from "@/contexts/GroupContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Settings } from "lucide-react";
import { useEffect } from "react";
import { reportPwaLaunchOnce } from "@/lib/push";
import { GAME_TABS, useGameTabs } from "@/lib/gameTabs";

// Lets a person who belongs to more than one group switch which one they're
// currently viewing. Hidden for everyone in a single group. Switching clears
// the cached game data (in GroupContext) so all pages reload for the new group.
function GroupSwitcher() {
  const { group, availableGroups, switchGroup } = useGroup();
  const [location, navigate] = useLocation();
  if (availableGroups.length <= 1 || !group) return null;

  return (
    <Select
      value={String(group.id)}
      onValueChange={async (v) => {
        const id = Number(v);
        if (id === group.id) return;
        // Stay on the current game tab if the new group offers it to this
        // person (e.g. LMS in Demo League → LMS in Rovers). Otherwise send
        // them to the landing route so the new group's primary game renders,
        // rather than the previous group's page under the new group.
        const currentGame = GAME_TABS.find(
          (t) => location === t.route || t.aliases?.includes(location),
        )?.key;
        const targetGames = availableGroups.find((g) => g.id === id)?.enabledGames ?? [];
        const stay = currentGame != null && targetGames.includes(currentGame);
        const res = await switchGroup(id);
        if (res.ok && !stay) navigate("/");
      }}
    >
      <SelectTrigger data-testid="group-switcher" className="h-9 w-auto min-w-0 max-w-[11rem] gap-1.5 rounded-full border-white/20 bg-white/10 px-3.5 text-[13px] font-medium text-white focus:ring-white/40 focus:ring-offset-0 [&>span]:truncate">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {availableGroups.map((g) => (
          <SelectItem key={g.id} value={String(g.id)}>
            {g.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Header() {
  const [location] = useLocation();
  const { group, availableGroups } = useGroup();
  const { visibleTabs, gameToGroupId, isActiveTab, isSameGroup, openGame } = useGameTabs();

  // If we're running as an installed PWA, record it once so the owner can see
  // who's actually installed the app (used to live in the reminders bell).
  useEffect(() => {
    reportPwaLaunchOnce();
  }, []);

  // A lone tab switches to nothing, so the header nav only shows from two
  // games up. It's desktop-only: on phones the games live in the bottom nav
  // (BottomNav.tsx).
  const showGameNav = visibleTabs.length > 1;

  // Decide whether to show the group switcher. The game tabs alone can't always
  // get a multi-group person where they want, so show the dropdown when:
  //
  //  1. A game is offered by MORE THAN ONE of their groups (a "shared" game).
  //     Its tab only routes to one group's copy, so the dropdown is the only way
  //     to reach the other. E.g. LMS runs in both Demo League
  //     and Rovers, so whichever one is active, they need the dropdown to switch to
  //     the other group's LMS (the LMS tab always stays on the active group).
  //  2. A group isn't reachable by any visible tab at all (its games are all
  //     hidden from the nav).
  //  3. Games aren't known yet (stale session) — fall back to showing it.
  //
  // When every game is unique to one group (e.g. one group's LMS + another's Lawro),
  // the tabs already cover everything, so the dropdown stays hidden.
  const gameGroupCount = new Map<string, number>();
  let gamesKnown = true;
  for (const ag of availableGroups) {
    if (!Array.isArray(ag.enabledGames)) {
      gamesKnown = false;
      continue;
    }
    for (const g of ag.enabledGames) gameGroupCount.set(g, (gameGroupCount.get(g) ?? 0) + 1);
  }
  const hasSharedGame = Array.from(gameGroupCount.values()).some((c) => c >= 2);

  const reachableGroupIds = new Set<number>();
  for (const tab of visibleTabs) {
    const hostId = gameToGroupId.get(tab.key);
    if (hostId != null) reachableGroupIds.add(hostId);
  }
  const anyGroupUnreachable = availableGroups.some((g) => !reachableGroupIds.has(g.id));

  const showSwitcher =
    availableGroups.length > 1 &&
    (!gamesKnown || hasSharedGame || anyGroupUnreachable);
  if (!showGameNav && !showSwitcher && !group) return null;

  return (
    // pt includes the top safe-area inset so the header clears the notch /
    // Dynamic Island when installed as a PWA (viewport-fit=cover). Without it
    // the status bar overlaps the controls and they can't be tapped.
    <header className="bg-header text-white pb-3 pt-[calc(0.5rem+env(safe-area-inset-top))] md:pb-4">
      <div className="container mx-auto max-w-5xl px-4">
        {/* One row: the crest/wordmark, then the group switcher. On phones
            the games and Settings live in the bottom nav (BottomNav.tsx);
            from md up the game nav sits centred in this row and Settings is
            the cog on the right. */}
        <div className="relative flex h-11 items-center justify-between gap-2">
          <Link
            href="/"
            aria-label="Home"
            className="flex min-w-0 items-center gap-2.5 rounded-xl"
          >
            <img
              src="/icons/logo.webp"
              alt=""
              aria-hidden
              width={40}
              height={40}
              className="h-10 w-10 shrink-0"
            />
            {/* On a phone the group switcher needs the room, so the wordmark
                shows only the crest there. */}
            <span
              className={`font-display truncate text-[21px] font-bold leading-none ${
                showSwitcher ? "hidden sm:inline" : ""
              }`}
            >
              Fairweathermen
            </span>
          </Link>
          {(showSwitcher || group) && (
            <div className="flex shrink-0 items-center gap-1">
              {showSwitcher && <GroupSwitcher />}
              {group && (
                <Link
                  href="/settings"
                  aria-label="Settings"
                  title="Settings"
                  className={`hidden h-10 w-10 items-center justify-center rounded-full text-white/90 hover:bg-white/10 md:flex ${
                    location === "/settings" || location === "/group-settings" ? "bg-white/15" : ""
                  }`}
                >
                  <Settings className="h-5 w-5" />
                </Link>
              )}
            </div>
          )}
          {showGameNav && (
            <nav
              aria-label="Games"
              className="absolute left-1/2 top-1/2 hidden w-[26rem] -translate-x-1/2 -translate-y-1/2 gap-1 rounded-2xl bg-white/[0.08] p-1 md:grid"
              style={{ gridTemplateColumns: `repeat(${visibleTabs.length}, minmax(0, 1fr))` }}
            >
              {visibleTabs.map((tab) => {
                const className = `flex h-10 items-center justify-center rounded-xl px-3 text-sm transition-colors whitespace-nowrap ${
                  isActiveTab(tab.key)
                    ? "bg-white font-semibold text-primary shadow-sm"
                    : "font-medium text-white/75 hover:bg-white/10 hover:text-white"
                }`;
                // Same-group games use client-side routing; cross-group games
                // switch the active group first (openGame), then navigate.
                return isSameGroup(tab.key) ? (
                  <Link key={tab.key} href={tab.route} className={className}>
                    {tab.short ?? tab.label}
                  </Link>
                ) : (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => openGame(tab.key, tab.route)}
                    className={className}
                  >
                    {tab.short ?? tab.label}
                  </button>
                );
              })}
            </nav>
          )}
        </div>
      </div>
    </header>
  );
}

export default Header;
