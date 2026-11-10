import { test, expect } from "@playwright/test";
import { CODES, loginViaUi } from "./helpers";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// The nav shows a tab for every game the person's groups offer. The demo group
// plays Lawro and LMS, so both tabs should be there and reachable.
test.describe("navigation", () => {
  test("shows the games the group plays", async ({ page, isMobile }) => {
    await loginViaUi(page, CODES.alex);
    // Games hosted by the active group are client-side nav links.
    await expect(page.getByRole("link", { name: "Lawro" })).toBeVisible();
    // The compact nav labels Last Man Standing "LMS".
    await expect(page.getByRole("link", { name: /^(LMS|Last Man Standing)$/ })).toBeVisible();
    // Phones get the games in the bottom nav; wider screens in the header.
    await expect(page.getByRole("navigation", { name: isMobile ? "Main" : "Games" })).toBeVisible();
  });

  test("someone with only one game gets no game switcher", async ({ page, isMobile }) => {
    // Creating a group signs the caller in; page.request shares the page's cookies.
    const res = await page.request.post("/api/group/create", {
      data: { groupName: `Solo ${Date.now()}`, adminName: "Solo", games: ["lms"] },
    });
    expect(res.ok(), `create failed: ${res.status()}`).toBeTruthy();
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Games" })).toHaveCount(0);
    // On a phone the bottom nav still shows their one game next to Settings.
    await expect(page.getByRole("link", { name: /^(LMS|Last Man Standing)$/ })).toHaveCount(isMobile ? 1 : 0);
  });

  test("the LMS page loads the current competition's players", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/last-man-standing");
    await expect(page.getByText("Blake").first()).toBeVisible();
  });

  test("each game route renders rather than 404ing", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    for (const route of ["/lawro", "/last-man-standing"]) {
      await page.goto(route);
      await expect(page.getByText(/404/)).toHaveCount(0);
    }
  });

  test("an unknown route shows the 404 page", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/no-such-page");
    await expect(page.getByText(/404/)).toBeVisible();
  });

  test("the removed World Cup page 404s", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/world-cup");
    await expect(page.getByText(/404/)).toBeVisible();
  });

  test("the removed Golf page 404s", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/golf");
    await expect(page.getByText(/404/)).toBeVisible();
  });
});
