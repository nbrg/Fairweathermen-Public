import { test, expect } from "@playwright/test";
import { reseed } from "./seed";

// The growth/onboarding dashboard (/admin/growth, GET /api/admin/growth):
// across all groups it logs new visitors, invites opened, groups created,
// players joining, and code logins (plus failed ones). Admin-key gated.

test.beforeAll(reseed);

const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "test-admin-key";
const uniqueName = () => `Growth ${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

test.describe("growth dashboard", () => {
  test("GET /api/admin/growth needs the admin key", async ({ request }) => {
    expect((await request.get("/api/admin/growth")).status()).toBe(401);
    const ok = await request.get("/api/admin/growth", { headers: { "x-api-key": ADMIN_KEY } });
    expect(ok.ok()).toBeTruthy();
    const body = await ok.json();
    expect(Array.isArray(body.events)).toBe(true);
    expect(Array.isArray(body.groups)).toBe(true);
  });

  test("creating a group and a failed login show up in the feed", async ({ request, playwright, baseURL }) => {
    const name = uniqueName();

    // A fresh (cookieless) context creates a group — logs a group_created event.
    const creator = await playwright.request.newContext({ baseURL });
    const created = await (
      await creator.post("/api/group/create", {
        data: { groupName: name, adminName: "Pat", games: ["lms", "predictions"] },
      })
    ).json();
    expect(created.code).toBeTruthy();
    await creator.dispose();

    // A bad login code logs a login_failed event.
    const bad = await request.post("/api/group/login", { data: { code: "definitely-not-a-code" } });
    expect(bad.status()).toBe(404);

    const body = await (
      await request.get("/api/admin/growth", { headers: { "x-api-key": ADMIN_KEY } })
    ).json();

    const createdEvent = body.events.find(
      (e: any) => e.type === "group_created" && e.groupName === name,
    );
    expect(createdEvent, "group_created event for the new group").toBeTruthy();

    expect(body.events.some((e: any) => e.type === "login_failed")).toBe(true);

    // The new group is listed with its admin and player count.
    const groupRow = body.groups.find((g: any) => g.name === name);
    expect(groupRow).toBeTruthy();
    expect(groupRow.admin).toBe("Pat");
    expect(groupRow.players).toBeGreaterThanOrEqual(1);
  });

  test("the growth page loads with the admin key", async ({ page }) => {
    await page.goto("/admin/growth");
    await page.getByPlaceholder("Admin password").fill(ADMIN_KEY);
    await page.getByRole("button", { name: "View" }).click();
    await expect(page.getByRole("heading", { name: "Growth" })).toBeVisible();
    await expect(page.getByText(/New visitors/i).first()).toBeVisible();
  });
});
