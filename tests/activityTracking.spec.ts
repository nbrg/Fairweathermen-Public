import { test, expect, type APIRequestContext } from "@playwright/test";
import { CODES, loginViaUi } from "./helpers";
import { reseed } from "./seed";

// Finer activity tracking: settings changes and feature usage on /admin/audit,
// logged-out /create visits, and the per-session timeline on
// /admin/activity (tabs, background/foreground, wheel/fixtures/charts,
// reminders).

test.beforeAll(reseed);

const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "test-admin-key";
const unique = (p: string) => `${p} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

type AuditRow = { type: string; username: string; summary: string; groupName: string | null };
const audit = async (request: APIRequestContext): Promise<AuditRow[]> =>
  (await request.get("/api/admin/audit", { headers: { "x-api-key": ADMIN_KEY } })).json();

test.describe("audit: settings and usage", () => {
  test("a rule change is audited with who made it and the before/after values", async ({ request }) => {
    const admin = unique("Rule Setter");
    const created = await request.post("/api/group/create", {
      data: { groupName: unique("Audit Rules"), adminName: admin, games: ["predictions", "lms"] },
    });
    expect(created.ok()).toBeTruthy();
    const put = await request.put("/api/group/rules", { data: { lawro: { exactScorePoints: 5 } } });
    expect(put.ok()).toBeTruthy();

    const row = (await audit(request)).find((r) => r.type === "settings_rules" && r.username === admin);
    expect(row, "rule change should be on /admin/audit").toBeTruthy();
    expect(row!.summary).toMatch(/Lawro .*3 → 5/);
  });

  test("renaming a player and resetting the invite link are audited", async ({ request, playwright, baseURL }) => {
    const admin = unique("Tidy Admin");
    const created = await (
      await request.post("/api/group/create", {
        data: { groupName: unique("Audit Players"), adminName: admin, games: ["predictions"] },
      })
    ).json();
    const joiner = await playwright.request.newContext({ baseURL });
    const original = unique("Joiner");
    expect((await joiner.post(`/api/group/join/${created.inviteToken}`, { data: { name: original } })).ok()).toBeTruthy();
    const players: { players: Array<{ id: number; username: string }> } = await (await request.get("/api/group/players")).json();
    const id = players.players.find((p) => p.username === original)!.id;
    const renamed = unique("Renamed");
    expect((await request.patch(`/api/group/players/${id}`, { data: { username: renamed } })).ok()).toBeTruthy();
    expect((await request.post("/api/group/invite/reset")).ok()).toBeTruthy();

    const rows = (await audit(request)).filter((r) => r.username === admin);
    expect(rows.find((r) => r.type === "player_renamed")?.summary).toBe(`Renamed ${original} to ${renamed}`);
    expect(rows.some((r) => r.type === "invite_reset")).toBeTruthy();
    await joiner.dispose();
  });

  test("client events are whitelisted and show on /admin/audit", async ({ request }) => {
    const admin = unique("Clicker");
    await request.post("/api/group/create", {
      data: { groupName: unique("Audit Usage"), adminName: admin, games: ["predictions", "lms"] },
    });
    expect((await request.post("/api/track/event", { data: { event: "drop_tables", detail: {} } })).status()).toBe(400);
    for (const [event, detail] of [
      ["wheel_view", { gameweek: 11, wheelOf: "Blake", own: false, phase: "spinning" }],
      ["fixture_select", { team: "ARS", opponent: "CHE", home: true, gameweek: 12, on: true }],
      ["chart_interaction", { chart: "Predicting style", action: "toggle", value: "Clean sheet" }],
      ["setting_changed", { setting: "theme", from: "Auto", to: "Dark" }],
    ] as const) {
      expect((await request.post("/api/track/event", { data: { event, path: "/x", detail } })).ok()).toBeTruthy();
    }
    const rows = (await audit(request)).filter((r) => r.username === admin);
    const summary = (type: string) => rows.find((r) => r.type === type)?.summary;
    expect(summary("wheel_view")).toBe("LMS GW11: watched Blake's wheel (spinning)");
    expect(summary("fixture_select")).toBe("Fixtures: highlighted ARS v CHE (GW12)");
    expect(summary("chart_interaction")).toBe('Tendencies: "Predicting style" → Clean sheet');
    expect(summary("setting_changed")).toBe("Changed theme from Auto to Dark");
  });

  test("the Fixtures tab and Tendencies toggles record what was used", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/track/event") && r.method() === "POST") events.push(r.postDataJSON());
    });

    await page.goto("/last-man-standing");
    await page.getByRole("tab", { name: "Fixtures" }).click();
    await page.locator("table button[aria-pressed]").first().click();
    await expect.poll(() => events.find((e) => e.event === "fixture_select")?.detail.on).toBe(true);

    await page.goto("/lawro");
    await page.getByRole("tab", { name: /Tendencies/i }).click();
    await page.getByRole("button", { name: "Current", exact: true }).click();
    await expect
      .poll(() => events.find((e) => e.event === "chart_interaction")?.detail)
      .toMatchObject({ chart: "Drought", action: "toggle", value: "Current" });
  });

  test("opening the site from a push link is recorded and the marker removed", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    const opened = page.waitForRequest(
      (r) => r.url().endsWith("/api/track/event") && r.postDataJSON()?.event === "push_opened",
    );
    await page.goto("/lawro?via=push&n=lawro-gw3");
    expect((await opened).postDataJSON().detail).toEqual({ tag: "lawro-gw3" });
    await expect(page).toHaveURL(/\/lawro$/);
  });
});

test.describe("activity: logged-out sign-up page visits", () => {
  test("a logged-out visitor's /create navigation is recorded", async ({ request }) => {
    // The public page is used logged out, but the client's visit record used to
    // be refused (401: no group) so only a direct page load ever got in.
    const res = await request.post("/api/track/page-visit", {
      data: { path: "/create", trigger: "navigation", visible: true, userAgent: "pw" },
    });
    expect(res.status()).toBe(200);
  });

  test("logged-out /create sessions are shown on /admin/activity", async ({ page, playwright, baseURL }) => {
    const visitor = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { "User-Agent": `Mozilla/5.0 SignupVisitor/${Date.now()}` },
    });
    expect((await visitor.get("/create")).ok()).toBeTruthy();
    await visitor.dispose();

    await page.addInitScript((k) => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    await page.goto("/admin/activity");
    const card = page.getByTestId("activity-session").filter({ hasText: "Not logged in" }).filter({ hasText: "Create a group" });
    await expect(card.first()).toBeVisible();
  });
});

test.describe("activity: session timeline", () => {
  test("shows the flow with times, background/foreground and active time", async ({ page, request }) => {
    const name = unique("Timeline Tess");
    await request.post("/api/group/create", {
      data: { groupName: unique("Timeline"), adminName: name, games: ["predictions", "lms"] },
    });
    // Player activity goes through `request` (its own cookie jar).
    expect((await request.get("/last-man-standing")).ok()).toBeTruthy();
    await request.post("/api/track", { data: { path: "/last-man-standing", subPath: "fixtures", label: "LMS: fixtures" } });
    await request.post("/api/track/event", {
      data: { event: "fixture_select", path: "/last-man-standing", detail: { team: "ARS", opponent: "CHE", gameweek: 12, on: true } },
    });
    await request.post("/api/track/event", { data: { event: "app_hidden", path: "/last-man-standing" } });
    await request.post("/api/track/event", {
      data: { event: "app_visible", path: "/last-man-standing", detail: { awayMs: 120000 } },
    });
    await request.post("/api/track/event", {
      data: { event: "wheel_view", path: "/last-man-standing", detail: { gameweek: 11, own: true, phase: "result" } },
    });

    await page.addInitScript((k) => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    await page.goto("/admin/activity");
    await page.getByPlaceholder("Filter by player…").fill(name);
    const card = page.getByTestId("activity-session").filter({ hasText: name }).first();
    await expect(card).toBeVisible();
    await expect(card.getByTestId("activity-usage-chip")).toHaveText(["📅 Fixtures", "🎡 Wheel"]);
    await card.getByText(/^Timeline \(/).click();
    const timeline = card.getByTestId("activity-timeline");
    await expect(timeline).toContainText("Opened Last Man Standing");
    await expect(timeline).toContainText("Tab: Last Man Standing → Fixtures");
    await expect(timeline).toContainText("Fixtures: highlighted ARS v CHE (GW12)");
    await expect(timeline).toContainText("Put the app in the background");
    await expect(timeline).toContainText("Came back to the app (away 2m 0s)");
    await expect(timeline).toContainText("LMS GW11: watched their own wheel (result)");
    // Each line starts with a HH:MM:SS time.
    await expect(timeline.locator("li").first()).toContainText(/\d\d:\d\d:\d\d/);
  });
});
