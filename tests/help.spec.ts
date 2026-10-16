import { test, expect } from "@playwright/test";
import { CODES, loginViaUi } from "./helpers";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// The help page documents the routes. It should list the live games and no
// longer mention the removed World Cup.
test.describe("help page", () => {
  test("lists the games and their routes", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/help");
    await expect(page.getByText("Last Man Standing").first()).toBeVisible();
    await expect(page.getByText("Lawro").first()).toBeVisible();
    await expect(page.getByText("Golf").first()).toBeVisible();
  });

  test("no longer mentions World Cup", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/help");
    await expect(page.getByText(/World Cup/i)).toHaveCount(0);
  });
});
