import { test, expect } from "@playwright/test";
import { CODES, loginViaApi, loginViaUi } from "./helpers";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// The Prediction League ("Lawro"): the interesting rule is that other players'
// scorelines stay hidden until a gameweek's deadline (its first kickoff), then
// everyone's are revealed and finished matches score 3 (exact) / 1 (result).
// The seed gives GW1 a past deadline (finished 2-1) and GW2 a future one.

test.describe("Lawro predictions", () => {
  test("a pre-deadline pick by another player is redacted", async ({ request }) => {
    await loginViaApi(request, CODES.alex);
    const res = await request.get("/api/predictions");
    expect(res.ok()).toBeTruthy();
    const preds = await res.json();

    // GW2 hasn't kicked off; the only GW2 pick belongs to Blake, so Alex must
    // see it hidden — present (so the grid shows "submitted") but with no score.
    const gw2 = preds.filter((p: any) => p.match?.gameweek === 2);
    expect(gw2.length).toBeGreaterThan(0);
    for (const p of gw2) {
      expect(p.hidden).toBe(true);
      expect(p.homeScore).toBeUndefined();
      expect(p.awayScore).toBeUndefined();
    }
  });

  test("your own pick is always returned in full", async ({ request }) => {
    const me = await loginViaApi(request, CODES.alex);
    const res = await request.get("/api/predictions");
    const preds = await res.json();
    const mine = preds.find(
      (p: any) => p.userId === me.user.id && p.match?.gameweek === 1,
    );
    expect(mine).toBeTruthy();
    expect(mine.homeScore).toBe(2);
    expect(mine.awayScore).toBe(1);
  });

  test("picks are revealed once the deadline has passed", async ({ request }) => {
    const me = await loginViaApi(request, CODES.alex);
    const res = await request.get("/api/predictions");
    const preds = await res.json();
    // GW1's deadline is in the past, so another player's GW1 pick is visible.
    const others = preds.filter(
      (p: any) => p.match?.gameweek === 1 && p.userId !== me.user.id,
    );
    expect(others.length).toBeGreaterThan(0);
    for (const p of others) {
      expect(p.hidden).toBeUndefined();
      expect(typeof p.homeScore).toBe("number");
    }
  });

  test("the leaderboard scores exact / result / miss correctly", async ({ request }) => {
    await loginViaApi(request, CODES.alex);
    const res = await request.get("/api/leaderboard");
    expect(res.ok()).toBeTruthy();
    const board: any[] = await res.json();
    const points = Object.fromEntries(board.map((r) => [r.username, r.totalPoints]));
    expect(points.Alex).toBe(3); // 2-1 vs actual 2-1 → exact
    expect(points.Blake).toBe(1); // 1-0 → right result (home win)
    expect(points.Casey).toBe(0); // 0-2 → wrong

    // Sorted highest first, with the exact-score tiebreak behind it.
    expect(board[0].username).toBe("Alex");
    expect(board.map((r) => r.username)).toEqual(["Alex", "Blake", "Casey"]);
  });

  test("the Lawro page renders after login", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/lawro");
    await expect(page.getByText(/GW\d+ Predictions/)).toBeVisible();
    await expect(page.getByRole("tab", { name: /Leaderboard/i })).toBeVisible();
  });

  test("the leaderboard tab ranks players by points", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/lawro");
    await page.getByRole("tab", { name: /Leaderboard/i }).click();
    // All three seeded players appear on the board. Scope to the leaderboard
    // panel so we don't match the (hidden) player columns on the predictions tab.
    const board = page.getByRole("tabpanel", { name: "Leaderboard" });
    for (const name of ["Alex", "Blake", "Casey"]) {
      await expect(board.getByText(name).first()).toBeVisible();
    }
  });

  test("the tendencies (charts) tab renders", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/lawro");
    // The charts tab is "Tendencies"; it appears once a gameweek has been
    // revealed (GW1 in the seed), and selecting it makes it the active tab.
    await page.getByRole("tab", { name: /Tendencies/i }).click();
    await expect(page.getByRole("tab", { name: /Tendencies/i })).toHaveAttribute(
      "data-state",
      "active",
    );
    // Blake and Casey missed the GW1 exact score, so the drought chart shows,
    // with a toggle between the longest run and the current one.
    await expect(page.getByRole("heading", { name: "Longest drought" })).toBeVisible();
    await page.getByRole("button", { name: "Current", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Current drought" })).toBeVisible();
    // Alex was the only one with GW1's exact score (Blake also had the result),
    // so the lone-call chart shows.
    await expect(page.getByRole("heading", { name: "Only One Who Saw It" })).toBeVisible();
  });

  test("you can submit a prediction for an open gameweek", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/lawro");

    // The page opens on the current (open) gameweek — GW2 in the seed — where
    // your own column is an editable cell.
    const input = page.locator('[data-testid^="pred-input-"]');
    await expect(input.first()).toBeVisible();

    // The save fires as soon as a complete "X-Y" exists. Wait for that request
    // to come back before reloading: a fixed sleep raced it on slower browsers
    // (WebKit in CI), so the reload sometimes beat the save.
    const saved = page.waitForResponse(
      (r) =>
        /^\/api\/predictions(\/\d+)?$/.test(new URL(r.url()).pathname) &&
        ["POST", "PATCH", "PUT"].includes(r.request().method()),
    );
    await input.first().fill("3-0");
    await input.first().blur();
    expect((await saved).ok()).toBeTruthy();
    await page.reload();
    const reloaded = page.locator('[data-testid^="pred-input-"]');
    await expect(reloaded.first()).toHaveValue("3-0");
  });

  test("the predicted-table tab renders", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/lawro");
    await page.getByRole("tab", { name: "Table" }).click();
    await expect(page.getByRole("tab", { name: "Table" })).toHaveAttribute("data-state", "active");
  });

  test("you can step back to a past gameweek", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/lawro");
    // Opens on GW2; GW1 is the previous (and locked) gameweek.
    await expect(page.getByText(/GW2 Predictions/)).toBeVisible();
    await page.getByRole("button", { name: "Previous gameweek" }).click();
    await expect(page.getByText(/GW1 Predictions/)).toBeVisible();
  });

  test("before the deadline, other players' picks are hidden in the grid", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/lawro");
    // GW2 is open: Blake has submitted (shown as a lock), Casey hasn't (a dash),
    // and Alex's own cell is editable.
    await expect(page.getByLabel("Pick submitted (hidden until the deadline)").first()).toBeVisible();
    await expect(page.getByLabel("No pick yet").first()).toBeVisible();
    await expect(page.locator('[data-testid^="pred-input-"]').first()).toBeVisible();
  });

  test("after the deadline, everyone's scores are revealed", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/lawro");
    await page.getByRole("button", { name: "Previous gameweek" }).click(); // GW1, locked
    await expect(page.getByText(/GW1 Predictions/)).toBeVisible();
    // Finished gameweek: the editable input is gone and scores show as badges.
    await expect(page.locator('[data-testid^="pred-input-"]')).toHaveCount(0);
    await expect(page.getByText("2-1").first()).toBeVisible(); // Alex's revealed pick
  });

  // Once a round is live (deadline passed, nobody can still predict), the grid
  // flips so each match is a column and each player a row: everyone's pick for
  // one game reads down a single column. Before the deadline it stays one row
  // per match with a column per player, so you fill in your own column.
  test("the grid is one row per match while picks are open", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/lawro");
    await expect(page.getByText(/GW2 Predictions/)).toBeVisible();
    const grid = page.getByTestId("lawro-grid");
    await expect(grid).toHaveAttribute("data-layout", "matches-as-rows");
    const header = grid.locator("thead th");
    await expect(header.first()).toHaveText("Match");
    await expect(grid.locator("thead")).toContainText("Blake");
    await expect(grid.locator("tbody tr").first().locator("td").first()).toContainText("vs");
  });

  test("once the round is live, each match is a column and each player a row", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/lawro");
    await page.getByRole("button", { name: "Previous gameweek" }).click(); // GW1, locked
    await expect(page.getByText(/GW1 Predictions/)).toBeVisible();
    const grid = page.getByTestId("lawro-grid");
    await expect(grid).toHaveAttribute("data-layout", "matches-as-columns");
    await expect(grid.locator("thead th").first()).toHaveText("Player");
    const rows = grid.locator("tbody tr");
    await expect(rows).toHaveCount(3);
    // Your own row first, then everyone else alphabetically.
    await expect(rows.nth(0).locator("th")).toContainText("Alex");
    await expect(rows.nth(1).locator("th")).toContainText("Blake");
    await expect(rows.nth(2).locator("th")).toContainText("Casey");
    // The match is a column header, with its result; picks sit under it.
    await expect(grid.locator("thead")).toContainText("2 - 1");
    await expect(rows.nth(0).locator("td").first()).toHaveText("2-1");
    await expect(rows.nth(1).locator("td").first()).toHaveText("1-0");
    await expect(rows.nth(2).locator("td").first()).toHaveText("0-2");
  });
});
