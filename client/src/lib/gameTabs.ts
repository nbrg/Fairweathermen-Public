import { useLocation } from "wouter";
import { useGroup } from "@/contexts/GroupContext";
import { NAV_HIDDEN_GAMES } from "@shared/navGames";

// The game tabs shared by the header (desktop) and the bottom nav (phones):
// LMS, then Lawro. Each game shows if ANY of the person's groups offers
// it to them (their per-group games), not just
// the active group, so e.g. someone in a Lawro-only group as well sees a
// Lawro tab. Opening a game hosted by another of their groups switches them
// into that group first.
export type GameTab = { key: string; label: string; short?: string; route: string; aliases?: string[] };
export const GAME_TABS: GameTab[] = [
  { key: "lms", label: "Last Man Standing", short: "LMS", route: "/last-man-standing", aliases: ["/lms"] },
  { key: "predictions", label: "Lawro", route: "/lawro", aliases: ["/predictions"] },
];

export function useGameTabs() {
  const [location, navigate] = useLocation();
  const { group, availableGroups, switchGroup } = useGroup();

  const activeGamesList = group?.enabledGames ?? ["lms", "predictions"];
  const activeGames = new Set(activeGamesList);

  // Which group hosts each game: prefer the active group for games it offers
  // (shared games stay in the current group), then the person's other groups.
  const gameToGroupId = new Map<string, number>();
  if (group) for (const g of activeGamesList) gameToGroupId.set(g, group.id);
  for (const ag of availableGroups) {
    for (const g of ag.enabledGames ?? []) {
      if (!gameToGroupId.has(g)) gameToGroupId.set(g, ag.id);
    }
  }

  // "/" renders the active group's primary game (App.tsx DefaultGame), in the
  // order LMS → Lawro; highlight that tab there.
  const rootIsLms = activeGames.has("lms");
  const rootIsPredictions = !rootIsLms && activeGames.has("predictions");

  const isActiveTab = (key: string): boolean => {
    switch (key) {
      case "lms":
        return location === "/last-man-standing" || location === "/lms" || (location === "/" && rootIsLms);
      case "predictions":
        return location === "/lawro" || location === "/predictions" || (location === "/" && rootIsPredictions);
      default:
        return false;
    }
  };

  const visibleTabs = GAME_TABS.filter(
    (t) => gameToGroupId.has(t.key) && !NAV_HIDDEN_GAMES.includes(t.key),
  );

  const isSameGroup = (key: string) => group != null && gameToGroupId.get(key) === group.id;

  // Open a game: if another of the person's groups hosts it, switch there first
  // (which reloads all group-scoped data), then navigate to its route.
  async function openGame(key: string, route: string) {
    const hostId = gameToGroupId.get(key);
    if (hostId != null && group && hostId !== group.id) {
      const res = await switchGroup(hostId);
      if (!res.ok) return;
    }
    navigate(route);
  }

  return { visibleTabs, gameToGroupId, isActiveTab, isSameGroup, openGame };
}
