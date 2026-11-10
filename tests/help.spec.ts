import { test, expect } from "@playwright/test";
import { CODES, loginViaUi } from "./helpers";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// The help page documents the routes and should list the live games.
test.describe("help page", () => {
  test("lists the games and their routes", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/help");
    await expect(page.getByText("Last Man Standing").first()).toBeVisible();
    await expect(page.getByText("Lawro").first()).toBeVisible();
  });

});
