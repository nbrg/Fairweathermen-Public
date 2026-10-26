import { test, expect } from "@playwright/test";
import { CODES, loginViaUi } from "./helpers";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// The admin/activity/audit endpoints are guarded by the ADMIN_API_KEY, passed
// as an x-api-key header. The test server boots with ADMIN_API_KEY=test-admin-key.
const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "test-admin-key";

test.describe("admin players screen", () => {
  test("stays locked until the admin key is entered", async ({ page }) => {
    await page.goto("/admin/players");
    await expect(page.getByText("Enter your admin key to load groups.")).toBeVisible();
  });

  test("loads the groups once the key is entered", async ({ page }) => {
    await page.goto("/admin/players");
    await page.getByPlaceholder("paste key…").fill(ADMIN_KEY);
    // The seeded demo group shows up.
    await expect(page.getByText("Demo League").first()).toBeVisible();
  });
});

test.describe("admin dashboards", () => {
  for (const path of ["/api/admin/audit", "/api/admin/activity"]) {
    test(`${path} needs the admin key`, async ({ request }) => {
      expect((await request.get(path)).status()).toBe(401);
      const ok = await request.get(path, { headers: { "x-api-key": ADMIN_KEY } });
      expect(ok.ok()).toBeTruthy();
    });
  }

  test("the audit page loads with the key", async ({ page }) => {
    // The /audit route sits behind the group gate, so establish a group session
    // first, then supply the admin key the page reads from localStorage.
    await page.addInitScript((k) => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    await loginViaUi(page, CODES.alex);
    await page.goto("/audit");
    // The seeded LMS pick + Lawro predictions produce audit rows.
    await expect(page.getByText(/Audit/i).first()).toBeVisible();
    await expect(page.getByText(/404/)).toHaveCount(0);
  });

  test("the activity page loads with the key", async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    await loginViaUi(page, CODES.alex);
    await page.goto("/activity");
    await expect(page.getByText(/404/)).toHaveCount(0);
    await expect(page.getByText(/Activity/i).first()).toBeVisible();
  });
});

test.describe("activity log", () => {
  test("static files aren't logged as page visits", async ({ request }) => {
    // A browser fetching an image directly (e.g. the crest logo) used to show
    // up on /activity as a "/icons/logo.webp" visit.
    expect((await request.get("/icons/logo.webp")).ok()).toBeTruthy();
    expect((await request.get("/lawro?asset-test=1")).ok()).toBeTruthy();
    const res = await request.get("/api/admin/activity", { headers: { "x-api-key": ADMIN_KEY } });
    const rows: Array<{ path: string }> = await res.json();
    expect(rows.some((r) => r.path === "/lawro")).toBeTruthy();
    expect(rows.some((r) => r.path === "/icons/logo.webp")).toBeFalsy();
  });
});

test.describe("admin access control", () => {
  test("a protected endpoint rejects a request with no key", async ({ request }) => {
    const res = await request.delete("/api/admin/visitors/1");
    expect(res.status()).toBe(401);
  });

  test("a protected endpoint rejects a wrong key", async ({ request }) => {
    const res = await request.delete("/api/admin/visitors/1", {
      headers: { "x-api-key": "wrong-key" },
    });
    expect(res.status()).toBe(401);
  });

  test("the correct key is accepted", async ({ request }) => {
    // id 999 doesn't exist, but with the right key we get past the auth gate
    // (any non-401 response), which is what we're checking here.
    const res = await request.delete("/api/admin/visitors/999", {
      headers: { "x-api-key": ADMIN_KEY },
    });
    expect(res.status()).not.toBe(401);
  });
});
