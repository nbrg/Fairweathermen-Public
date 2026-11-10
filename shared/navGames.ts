// Games whose tab is hidden from the nav for everyone, whatever the group
// offers. Nothing is hidden in this edition; kept so the nav and the admin
// players screen read the same list.
export const NAV_HIDDEN_GAMES: readonly string[] = [];

// The game the landing route "/" renders for someone with these games, in the
// same precedence as App.tsx's DefaultGame: Last Man Standing (the year-round
// game), then the Prediction League ("Lawro"). Shared so /admin/activity can
// say which page "/" really was: for a Lawro-only group, "/" *is* the Lawro page.
export type LandingGame = "lms" | "predictions";
export function landingGame(enabledGames: readonly string[] | null | undefined): LandingGame {
  const enabled = new Set(enabledGames ?? ["lms", "predictions"]);
  if (enabled.has("lms")) return "lms";
  if (enabled.has("predictions")) return "predictions";
  return "lms";
}
