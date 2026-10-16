import { test, expect } from "@playwright/test";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

test.describe("smoke", () => {
  test("landing page asks for an access code", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Fairweathermen").first()).toBeVisible();
    await expect(page.getByPlaceholder("Your code")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enter" })).toBeVisible();
  });

  test("serves the PWA manifest and service worker", async ({ request }) => {
    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.ok()).toBeTruthy();
    const json = await manifest.json();
    expect(json.name ?? json.short_name).toBeTruthy();

    const sw = await request.get("/sw.js");
    expect(sw.ok()).toBeTruthy();
  });

  test("API responses are marked no-store", async ({ request }) => {
    // Live data must never be cached, so every /api response carries no-store
    // (this holds even for an unauthenticated 401, which is what /api/teams
    // returns without a group cookie).
    const res = await request.get("/api/teams");
    expect(res.headers()["cache-control"]).toContain("no-store");
  });
});
