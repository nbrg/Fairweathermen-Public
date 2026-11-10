import { test, expect, type Page } from "@playwright/test";
import { CODES, loginViaApi, loginViaUi } from "./helpers";
import { reseed } from "./seed";

// The phone bottom nav (BottomNav.tsx) and the Settings page it leads to.
// Each test reseeds, since some of them make picks.
test.beforeEach(reseed);

// Phone width, whatever the project's device — the bar is phone-only.
test.use({ viewport: { width: 390, height: 844 } });

const bar = (page: Page) => page.getByTestId("bottom-nav");
const barLabels = (page: Page) => bar(page).locator("[data-nav-label]").allInnerTexts();

test.describe("bottom nav", () => {
  test("shows each game plus Settings, and the header drops its game tabs", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await expect(bar(page)).toBeVisible();
    const labels = await barLabels(page);
    expect(labels).toEqual(["LMS", "Lawro", "Settings"]);
    await expect(page.getByRole("navigation", { name: "Games" })).toBeHidden();

    await bar(page).getByRole("link", { name: "Lawro" }).click();
    await expect(page).toHaveURL(/\/lawro$/);
    await expect(bar(page).getByRole("link", { name: "Lawro" })).toHaveAttribute("aria-current", "page");
  });

  test("someone with one game gets that game plus Settings", async ({ page }) => {
    const res = await page.request.post("/api/group/create", {
      data: { groupName: `Solo ${Date.now()}`, adminName: "Solo", games: ["predictions"] },
    });
    expect(res.ok()).toBeTruthy();
    await page.goto("/");
    const labels = await barLabels(page);
    expect(labels).toEqual(["Lawro", "Settings"]);
  });

  test("is not shown on desktop, where the header keeps the game tabs", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginViaUi(page, CODES.alex);
    await expect(page.getByRole("navigation", { name: "Games" })).toBeVisible();
    await expect(bar(page)).toBeHidden();
    await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  });

  test("hides while typing a score, so it can't cover the keyboard", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/lawro");
    const score = page.locator("input[data-score-input]").first();
    await expect(score).toBeVisible();
    await expect(bar(page)).toBeVisible();
    await score.focus();
    await expect(bar(page)).toBeHidden();
    await score.blur();
    await expect(bar(page)).toBeVisible();
  });

  test("marks games with picks still to make, until they're made", async ({ page }) => {
    const me = await loginViaApi(page.request, CODES.alex);
    // Seed: Alex hasn't picked LMS or Lawro for GW2 in Demo League. (He's in
    // Rovers too, which has no LMS running but plays Lawro.)
    const before = await (await page.request.get("/api/group/picks-due")).json();
    expect(before.groups[me.id]).toEqual({ lms: true, predictions: true });
    await page.goto("/last-man-standing");
    await expect(bar(page).getByTestId("picks-due-lms")).toBeVisible();
    await expect(bar(page).getByTestId("picks-due-predictions")).toBeVisible();

    // Make both picks over the API, then move page: the dots go.
    const comp = await (await page.request.get("/api/lms/current-competition")).json();
    const mine = comp.participants.find((p: any) => p.userId === me.user.id);
    const teams: any[] = await (await page.request.get("/api/lms/available-teams")).json();
    const liverpool = teams.find((t) => t.name === "Liverpool");
    expect((await page.request.post("/api/lms/select-team", {
      data: { teamId: liverpool.id, participantId: mine.id, gameweek: 2 },
    })).ok()).toBeTruthy();
    const matches: any[] = await (await page.request.get("/api/matches")).json();
    for (const m of matches.filter((x) => x.gameweek === 2)) {
      expect((await page.request.put("/api/predictions", {
        data: { userId: me.user.id, matchId: m.id, homeScore: 1, awayScore: 0 },
      })).ok()).toBeTruthy();
    }
    const after = await (await page.request.get("/api/group/picks-due")).json();
    expect(after.groups[me.id]).toEqual({ lms: false, predictions: false });
    // Rovers' Lawro picks are still to make; its tab isn't the one shown.
    expect(after.predictions).toBe(true);
    await bar(page).getByRole("link", { name: "Lawro" }).click();
    await expect(bar(page).getByTestId("picks-due-lms")).toHaveCount(0);
    await expect(bar(page).getByTestId("picks-due-predictions")).toHaveCount(0);
  });

  test("picks-due needs a session", async ({ request }) => {
    expect((await request.get("/api/group/picks-due")).status()).toBe(401);
  });
});

test.describe("Settings", () => {
  test("switches between light, dark and auto, and remembers it", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await bar(page).getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    const html = page.locator("html");

    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(html).toHaveClass(/\bdark\b/);
    await page.reload();
    await expect(html).toHaveClass(/\bdark\b/);
    await expect(page.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");

    await page.getByRole("radio", { name: "Light" }).click();
    await expect(html).not.toHaveClass(/\bdark\b/);

    // Auto follows the device.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByRole("radio", { name: "Auto" }).click();
    await expect(html).toHaveClass(/\bdark\b/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(html).not.toHaveClass(/\bdark\b/);
  });

  test("a player sees no group admin section and no login code", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("Kickoff reminders")).toBeVisible();
    await expect(page.locator("#group-admin")).toHaveCount(0);
    await expect(page.getByText(CODES.alex)).toHaveCount(0);
  });

  test("log out returns to the code screen", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page.getByPlaceholder("Your code")).toBeVisible();
  });

  test("the group owner edits the group's rules from Settings", async ({ page }) => {
    const res = await page.request.post("/api/group/create", {
      data: { groupName: `Owners ${Date.now()}`, adminName: "Owner", games: ["lms", "predictions"] },
    });
    expect(res.ok()).toBeTruthy();
    // The old /group-settings link opens Settings at the admin section.
    await page.goto("/group-settings");
    await expect(page.locator("#group-admin")).toBeVisible();
    await expect(page.getByText("Invite players")).toBeVisible();
    // The save bar only appears once something has changed, above the nav.
    await expect(page.getByTestId("rules-save-bar")).toHaveCount(0);
    await page.locator("#lawro-joker").click();
    const save = page.getByTestId("rules-save-bar");
    await expect(save).toBeVisible();
    const saveBox = (await save.boundingBox())!;
    const barBox = (await bar(page).boundingBox())!;
    expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(barBox.y + 1);
    await save.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByText("Rules saved").first()).toBeVisible();
    await expect(page.getByTestId("rules-save-bar")).toHaveCount(0);
  });
});
