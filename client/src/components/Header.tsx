import { Link, useLocation } from "wouter";
import { useGroup } from "@/contexts/GroupContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NotificationBell } from "@/components/NotificationBell";

// Lets a person who belongs to more than one group switch which one they're
// currently viewing. Hidden for everyone in a single group. Switching clears
// the cached game data (in GroupContext) so all pages reload for the new group.
function GroupSwitcher() {
  const { group, availableGroups, switchGroup } = useGroup();
  const [, navigate] = useLocation();
  if (availableGroups.length <= 1 || !group) return null;

  return (
    <Select
      value={String(group.id)}
      onValueChange={async (v) => {
        const id = Number(v);
        if (id === group.id) return;
        const res = await switchGroup(id);
        // Send them to the landing route so the newly-active group's primary
        // game renders. Without this the current route stays put and you'd see
        // the previous group's page (e.g. LMS) under the new group.
        if (res.ok) navigate("/");
      }}
    >
      <SelectTrigger data-testid="group-switcher" className="h-8 w-auto min-w-[8rem] bg-white/10 border-white/20 text-white text-sm font-medium">
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

// Ordered game tabs — LMS, Lawro, Golf. Each game is shown if ANY of the
// person's groups offers it (not just the active one), so e.g. a City member
// who also plays Lawro sees a Lawro tab without opening the group dropdown.
// Clicking a tab that belongs to a different group switches them into that
// group first, then navigates.
const GAME_TABS: { key: string; label: string; route: string }[] = [
  { key: "lms", label: "Last Man Standing", route: "/last-man-standing" },
  { key: "predictions", label: "Lawro", route: "/lawro" },
  { key: "golf", label: "Golf", route: "/golf" },
];

export function Header() {
  const [location, navigate] = useLocation();
  const { group, availableGroups, switchGroup } = useGroup();

  const activeGamesList = group?.enabledGames ?? ["lms", "golf", "predictions"];
  const activeGames = new Set(activeGamesList);

  // Which group hosts each game: prefer the active group for games it offers, so
  // shared games (e.g. LMS in both City and Rovers) stay in the current group;
  // then let the person's other groups fill in games the active one doesn't
  // have (e.g. Lawro from a predictions-only group).
  const gameToGroupId = new Map<string, number>();
  if (group) for (const g of activeGamesList) gameToGroupId.set(g, group.id);
  for (const ag of availableGroups) {
    for (const g of ag.enabledGames ?? []) {
      if (!gameToGroupId.has(g)) gameToGroupId.set(g, ag.id);
    }
  }

  // Landing-route ("/") highlighting for the ACTIVE group's primary game, in
  // priority order LMS → Lawro. Keep in step with DefaultGame in App.tsx.
  // Cross-group tabs are never the active landing game, so they only highlight
  // once you're actually in their group.
  const rootIsLms = activeGames.has("lms");
  const rootIsPredictions = !rootIsLms && activeGames.has("predictions");

  const isActiveTab = (key: string): boolean => {
    switch (key) {
      case "lms":
        return (
          location === "/last-man-standing" ||
          location === "/lms" ||
          (location === "/" && rootIsLms)
        );
      case "golf":
        return location === "/golf";
      case "predictions":
        return location === "/lawro" || location === "/predictions" || (location === "/" && rootIsPredictions);
      default:
        return false;
    }
  };

  // A game tab shows when any of the person's groups offers it.
  const visibleTabs = GAME_TABS.filter((t) => gameToGroupId.has(t.key));

  const showGameNav = visibleTabs.length > 0;

  // Decide whether to show the group switcher. The game tabs alone can't always
  // get a multi-group person where they want, so show the dropdown when:
  //
  //  1. A game is offered by MORE THAN ONE of their groups (a "shared" game).
  //     Its tab only routes to one group's copy, so the dropdown is the only way
  //     to reach the other. This is Morgan/Alex: LMS runs in both Fairweathermen
  //     and Rovers, so whichever one is active, they need the dropdown to switch to
  //     the other group's LMS (the LMS tab always stays on the active group).
  //  2. A group isn't reachable by any visible tab at all.
  //  3. Games aren't known yet (stale session) — fall back to showing it.
  //
  // When every game is unique to one group (e.g. Blake: City's games + Lawro),
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

  // Open a game: if it's hosted by another of the person's groups, switch there
  // first (which reloads all group-scoped data), then navigate to its route.
  async function openGame(key: string, route: string) {
    const hostId = gameToGroupId.get(key);
    if (hostId != null && group && hostId !== group.id) {
      const res = await switchGroup(hostId);
      if (!res.ok) return;
    }
    navigate(route);
  }

  return (
    // pt includes the top safe-area inset so the header clears the notch /
    // Dynamic Island when installed as a PWA (viewport-fit=cover). Without it
    // the status bar overlaps the controls and they can't be tapped.
    <header className="bg-primary text-white pb-4 pt-[calc(0.5rem+env(safe-area-inset-top))] shadow-lg">
      <div className="container mx-auto px-4">
        {/* Two rows: the group switcher + reminders bell get their own row
            above the game nav. Keeping them off the nav row means the tabs
            never have to share horizontal space with the controls (which
            overflowed once both the switcher and the bell were present). */}
        <div className="flex flex-col gap-2">
          {(showSwitcher || group) && (
            <div className="flex items-center justify-end gap-2">
              {showSwitcher && <GroupSwitcher />}
              {group && <NotificationBell />}
            </div>
          )}
          {showGameNav && (
            <nav className="flex max-w-full space-x-1 self-center overflow-x-auto rounded-lg bg-white/10 p-1">
              {visibleTabs.map((tab) => {
                const hostId = gameToGroupId.get(tab.key)!;
                const sameGroup = group != null && hostId === group.id;
                const className = `px-4 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
                  isActiveTab(tab.key)
                    ? "bg-secondary text-primary"
                    : "text-white hover:bg-white/20"
                }`;
                // Same-group games use client-side routing; cross-group games
                // switch the active group first (openGame), then navigate.
                return sameGroup ? (
                  <Link key={tab.key} href={tab.route} className={className}>
                    {tab.label}
                  </Link>
                ) : (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => openGame(tab.key, tab.route)}
                    className={className}
                  >
                    {tab.label}
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
