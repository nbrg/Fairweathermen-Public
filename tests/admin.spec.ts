import { test, expect, type APIRequestContext } from "@playwright/test";
import { CODES, loginViaUi } from "./helpers";
import { reseed } from "./seed";
import { changelogDate, type ChangelogEntry } from "../shared/changelog";

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

  test("game badges show the games the player can toggle", async ({ page }) => {
    await page.goto("/admin/players");
    await page.getByPlaceholder("paste key…").fill(ADMIN_KEY);
    const lawro = page.locator('button[data-testid$="-predictions"]').first();
    await expect(lawro).toBeVisible();
    await expect(lawro).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("admin dashboards", () => {
  for (const path of ["/api/admin/audit", "/api/admin/activity", "/api/admin/changelog", "/api/admin/metrics"]) {
    test(`${path} needs the admin key`, async ({ request }) => {
      expect((await request.get(path)).status()).toBe(401);
      const ok = await request.get(path, { headers: { "x-api-key": ADMIN_KEY } });
      expect(ok.ok()).toBeTruthy();
    });
  }

  test("the audit page loads with the key", async ({ page }) => {
    // Check audit data while signed in; admin routes also work without a group.
    await page.addInitScript((k) => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    await loginViaUi(page, CODES.alex);
    await page.goto("/admin/audit");
    // The seeded LMS pick + Lawro predictions produce audit rows.
    await expect(page.getByText(/Audit/i).first()).toBeVisible();
    await expect(page.getByText(/404/)).toHaveCount(0);
  });

  test("the activity page loads with the key", async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    await loginViaUi(page, CODES.alex);
    await page.goto("/admin/activity");
    await expect(page.getByText(/404/)).toHaveCount(0);
    await expect(page.getByText(/Activity/i).first()).toBeVisible();
  });
});

test.describe("changes page", () => {
  test("lists shipped changes newest first with their bullet points", async ({ page, request }) => {
    const res = await request.get("/api/admin/changelog", { headers: { "x-api-key": ADMIN_KEY } });
    const { entries } = (await res.json()) as {
      entries: ChangelogEntry[];
    };
    expect(entries.length).toBeGreaterThan(0);
    const times = entries.map(changelogDate);
    expect([...times].sort().reverse()).toEqual(times);

    await page.addInitScript((k) => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    await page.goto("/admin/changes");
    const first = page.getByTestId("change-entry").first();
    if (entries[0].number != null) await expect(first).toContainText(`#${entries[0].number}`);
    await expect(first).toContainText(entries[0].title);
    const withBullets = entries.findIndex((e) => e.bullets.length > 0);
    if (withBullets >= 0 && withBullets < 30) {
      await expect(page.getByTestId("change-entry").nth(withBullets).locator("li")).toHaveCount(
        entries[withBullets].bullets.length,
      );
    }

    // Search narrows the list to matching PRs.
    await page.getByTestId("changes-search").fill(entries[0].title);
    await expect(page.getByTestId("change-entry").first()).toContainText(entries[0].title);

    // New entries have a recorded date; historical entries still show their
    // merge date and can be found by PR number.
    const recorded = entries.find((e) => e.recordedAt);
    expect(recorded).toBeTruthy();
    await page.getByTestId("changes-search").fill(recorded!.title);
    await expect(page.getByTestId("change-entry").first().locator('[title="Recorded"]')).toBeVisible();
    await expect(page.getByText("#undefined", { exact: true })).toHaveCount(0);
    const historical = entries.find((e) => e.mergedAt && e.number != null)!;
    await page.getByTestId("changes-search").fill(`#${historical.number}`);
    await expect(page.getByTestId("change-entry").first()).toContainText(historical.title);
    await expect(page.getByTestId("change-entry").first().locator('[title="Merged"]')).toBeVisible();
  });
});

test.describe("admin nav", () => {
  // Every admin page carries the same nav, which links to all of them.
  const PAGES: [string, string][] = [
    ["/admin/metrics", "Metrics"],
    ["/admin/activity", "Activity"],
    ["/admin/growth", "Growth"],
    ["/admin/audit", "Audit"],
    ["/admin/notifications", "Reminders"],
    ["/admin/players", "Players"],
    ["/admin/visitors", "Visitors"],
    ["/admin/changes", "Changes"],
  ];

  test("shows every admin page on each of them", async ({ page, isMobile }) => {
    await page.addInitScript((k) => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    // Include the regular game header while exercising the shared admin nav.
    await loginViaUi(page, CODES.alex);
    for (const [path, label] of PAGES) {
      await page.goto(path);
      const nav = page.getByTestId("admin-nav");
      await expect(nav).toBeVisible();
      for (const [href] of PAGES) {
        await expect(nav.locator(`a[href="${href}"]`)).toHaveCount(1);
      }
      await expect(nav.locator('a[aria-current="page"]')).toHaveText(label);
      const labels = await nav.getByRole("link").allTextContents();
      expect(labels.slice(labels.indexOf("Growth"), labels.indexOf("Growth") + 3)).toEqual(["Growth", "Metrics", "Visitors"]);
      // Every admin page carries the regular game tabs (the bottom nav on phones).
      await expect(page.getByRole("navigation", { name: isMobile ? "Main" : "Games" })).toBeVisible();
    }
  });

  test("the nav never makes the page scroll sideways", async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    await page.goto("/admin/players");
    await expect(page.getByTestId("admin-nav")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
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

  test("a Lawro-only group's landing page is labelled Lawro, and its picks show in the session", async ({
    page,
  }) => {
    // In a predictions-only group "/" renders the Lawro page, so it must not be
    // labelled "Home" — and the picks made in that visit appear on its card.
    const name = `Lawro Fan ${Date.now().toString(36)}`;
    const groupName = `Lawro Only ${Date.now().toString(36)}`;
    const created = await page.request.post("/api/group/create", {
      data: { groupName, adminName: name, games: ["predictions"] },
    });
    expect(created.ok(), `create failed: ${created.status()}`).toBeTruthy();
    const me = await (await page.request.get("/api/group/me")).json();
    expect((await page.request.get("/")).ok()).toBeTruthy();

    const matches: Array<{ id: number; gameweek: number }> = await (await page.request.get("/api/matches")).json();
    const gw2 = matches.find((m) => m.gameweek === 2);
    expect(gw2).toBeTruthy();
    const saved = await page.request.post("/api/predictions", {
      data: { userId: me.user.id, matchId: gw2!.id, homeScore: 3, awayScore: 1 },
    });
    expect(saved.ok(), `prediction failed: ${saved.status()}`).toBeTruthy();

    const res = await page.request.get("/api/admin/activity", { headers: { "x-api-key": ADMIN_KEY } });
    const rows: Array<{ path: string; username: string | null; landingGame: string | null }> = await res.json();
    const landing = rows.find((r) => r.username === name && r.path === "/");
    expect(landing?.landingGame).toBe("predictions");

    await page.addInitScript((k) => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    await page.goto("/admin/activity");
    await page.getByPlaceholder("Filter by player…").fill(name);
    const card = page.getByTestId("activity-session").filter({ hasText: name }).first();
    await expect(card.getByText("Lawro", { exact: true }).first()).toBeVisible();
    await expect(card.getByText("Home", { exact: true })).toHaveCount(0);
    await expect(card.getByTestId("activity-pick-count")).toHaveText(/Lawro: 1 pick/);
    await card.getByText("Show pick").click();
    await expect(card.getByTestId("activity-pick-list")).toContainText("predicted 3-1");
    await expect(card.getByTestId("activity-pick-list")).toContainText(`[${groupName}] `);
  });

  test("hiding landing-only sessions also hides a Lawro-only group's /lawro visits", async ({
    page,
    request,
  }) => {
    // In a Lawro-only group, opening /lawro (PWA reopen, push link) is the same
    // as opening "/": the landing-page filter must hide it too. The player acts
    // through `request` (its own cookie jar), so the admin's /activity visit
    // isn't logged into the player's session.
    const name = `Lawro Opener ${Date.now().toString(36)}`;
    const created = await request.post("/api/group/create", {
      data: { groupName: `Lawro Land ${Date.now().toString(36)}`, adminName: name, games: ["predictions"] },
    });
    expect(created.ok(), `create failed: ${created.status()}`).toBeTruthy();
    expect((await request.get("/lawro")).ok()).toBeTruthy();

    await page.addInitScript((k) => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    await loginViaUi(page, CODES.alex);
    await page.goto("/admin/activity");
    await page.getByPlaceholder("Filter by player…").fill(name);
    const card = page.getByTestId("activity-session").filter({ hasText: name });
    const hideLanding = page.getByLabel("Hide sessions that only opened the landing page (no picks)");
    // The filter is on by default; untick it to see the session, then re-tick.
    await expect(hideLanding).toBeChecked();
    await expect(card).toHaveCount(0);
    await hideLanding.uncheck();
    await expect(card.first()).toBeVisible();
    await hideLanding.check();
    await expect(card).toHaveCount(0);
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

test.describe("permanent deletion from /admin/players", () => {
  type Roster = Array<{ id: number; name: string; players: Array<{ id: number; username: string }> }>;
  const roster = async (request: APIRequestContext): Promise<Roster> =>
    (await request.get("/api/admin/groups-players", { headers: { "x-api-key": ADMIN_KEY } })).json();

  // A throwaway group with an owner (who makes a Lawro pick) and a second player.
  async function makeGroup(request: APIRequestContext, playwright: any, baseURL: string | undefined) {
    const groupName = `Delete Me ${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
    const created = await (
      await request.post("/api/group/create", {
        data: { groupName, adminName: "Owner", games: ["lms", "predictions"] },
      })
    ).json();
    const me = await (await request.get("/api/group/me")).json();
    const matches: Array<{ id: number; gameweek: number }> = await (await request.get("/api/matches")).json();
    const gw2 = matches.find((m) => m.gameweek === 2)!;
    const saved = await request.post("/api/predictions", {
      data: { userId: me.user.id, matchId: gw2.id, homeScore: 2, awayScore: 0 },
    });
    expect(saved.ok()).toBeTruthy();
    const friend = await playwright.request.newContext({ baseURL });
    expect((await friend.post(`/api/group/join/${created.inviteToken}`, { data: { name: "Friend" } })).ok()).toBeTruthy();
    const group = (await roster(request)).find((g) => g.name === groupName)!;
    return { groupName, group, friend };
  }

  test("the delete endpoints need the admin key", async ({ request }) => {
    expect((await request.get("/api/admin/groups/1/deletion-preview")).status()).toBe(401);
    expect((await request.delete("/api/admin/groups/1", { data: { confirmName: "Demo League" } })).status()).toBe(401);
    expect((await request.get("/api/admin/players/1/deletion-preview")).status()).toBe(401);
    expect((await request.delete("/api/admin/players/1/permanent")).status()).toBe(401);
  });

  test("a player's preview counts their picks and the other groups they're in", async ({ request }) => {
    const demo = (await roster(request)).find((g) => g.name === "Demo League")!;
    const alex = demo.players.find((p) => p.username === "Alex")!;
    const here = await (
      await request.get(`/api/admin/players/${alex.id}/deletion-preview?scope=group`, { headers: { "x-api-key": ADMIN_KEY } })
    ).json();
    expect(here.deletedFrom.map((d: any) => d.groupName)).toEqual(["Demo League"]);
    expect(here.keptIn.length).toBeGreaterThan(0);
    expect(here.counts.predictions).toBeGreaterThan(0);
    const everywhere = await (
      await request.get(`/api/admin/players/${alex.id}/deletion-preview?scope=everywhere`, { headers: { "x-api-key": ADMIN_KEY } })
    ).json();
    expect(everywhere.deletedFrom.length).toBe(here.deletedFrom.length + here.keptIn.length);
    expect(everywhere.keptIn).toEqual([]);
  });

  test("deleting a player removes them and their picks, and signs them out", async ({ request, playwright, baseURL }) => {
    const { group, friend } = await makeGroup(request, playwright, baseURL);
    const owner = group.players.find((p) => p.username === "Owner")!;
    const preview = await (
      await request.get(`/api/admin/players/${owner.id}/deletion-preview`, { headers: { "x-api-key": ADMIN_KEY } })
    ).json();
    expect(preview.counts.predictions).toBe(1);
    expect(preview.adminOf.map((a: any) => a.groupId)).toEqual([group.id]);

    const res = await request.delete(`/api/admin/players/${owner.id}/permanent`, {
      headers: { "x-api-key": ADMIN_KEY },
      data: { scope: "group" },
    });
    expect(res.ok(), `delete failed: ${res.status()}`).toBeTruthy();
    const after = (await roster(request)).find((g) => g.id === group.id)!;
    expect(after.players.map((p) => p.username)).toEqual(["Friend"]);
    expect((await request.get("/api/group/me")).status()).toBe(401);
    // The friend is untouched.
    expect((await friend.get("/api/group/me")).ok()).toBeTruthy();
    await friend.dispose();
  });

  test("a group can only be deleted with its name typed back, and then it's gone", async ({ request, playwright, baseURL }) => {
    const { groupName, group, friend } = await makeGroup(request, playwright, baseURL);
    const preview = await (
      await request.get(`/api/admin/groups/${group.id}/deletion-preview`, { headers: { "x-api-key": ADMIN_KEY } })
    ).json();
    expect(preview.players).toBe(2);
    expect(preview.isOriginal).toBe(false);
    expect(preview.counts.predictions).toBe(1);
    expect(preview.counts.lmsCompetitions).toBeGreaterThan(0);

    const wrong = await request.delete(`/api/admin/groups/${group.id}`, {
      headers: { "x-api-key": ADMIN_KEY },
      data: { confirmName: "something else" },
    });
    expect(wrong.status()).toBe(400);
    expect((await roster(request)).some((g) => g.id === group.id)).toBeTruthy();

    const ok = await request.delete(`/api/admin/groups/${group.id}`, {
      headers: { "x-api-key": ADMIN_KEY },
      data: { confirmName: `  ${groupName.toUpperCase()} ` },
    });
    expect(ok.ok(), `delete failed: ${ok.status()}`).toBeTruthy();
    expect((await roster(request)).some((g) => g.id === group.id)).toBeFalsy();
    expect((await request.get(`/api/admin/groups/${group.id}/deletion-preview`, { headers: { "x-api-key": ADMIN_KEY } })).status()).toBe(404);
    expect((await request.get("/api/group/me")).status()).toBe(401);
    expect((await friend.get("/api/group/me")).status()).toBe(401);
    await friend.dispose();
  });

  test("the confirm dialog lists the implications and needs the group name", async ({ page, playwright, baseURL }) => {
    const { groupName, group, friend } = await makeGroup(page.request, playwright, baseURL);
    await friend.dispose();
    await page.addInitScript((k) => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    await page.goto("/admin/players");
    await page.getByTestId(`delete-group-${group.id}`).click();
    const dialog = page.getByTestId("admin-delete-dialog");
    await expect(dialog.getByTestId("delete-implications")).toContainText("2 players");
    await expect(dialog).toContainText("1 Lawro prediction");
    const del = dialog.getByRole("button", { name: "Delete permanently" });
    await expect(del).toBeDisabled();
    await dialog.getByLabel(/to confirm/).fill(groupName);
    await expect(del).toBeEnabled();
    await del.click();
    await expect(page.getByText(`Deleted the group "${groupName}" permanently.`)).toBeVisible();
    await expect(page.getByTestId(`delete-group-${group.id}`)).toHaveCount(0);
  });
});


test.describe("metrics dashboard", () => {
  test("new admin routes work without a group cookie and metrics reject a bad key", async ({ page, request }) => {
    for (const [path, title] of [["/admin/metrics", "Metrics"], ["/admin/audit", "Audit log"], ["/admin/activity", "Activity log"]]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(page.getByPlaceholder("Admin password")).toBeVisible();
    }
    for (const [from, to] of [["/admin", "/admin/visitors"], ["/audit", "/admin/audit"], ["/activity", "/admin/activity"]]) {
      const redirect = await request.get(from, { maxRedirects: 0 });
      expect(redirect.status()).toBe(308);
      expect(redirect.headers().location).toBe(to);
    }
    expect((await request.get("/api/admin/metrics", { headers: { "x-api-key": "wrong" } })).status()).toBe(401);
    for (const query of ["days=366", "days=2.5", "interval=year", "days=oops"]) {
      expect((await request.get(`/api/admin/metrics?${query}`, { headers: { "x-api-key": ADMIN_KEY } })).status()).toBe(400);
    }
  });

  test("renders graphs, changes time buckets and fits a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(k => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    await page.goto("/admin/metrics");
    await expect(page.getByText("Active players", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("img", { name: "Activity by audience", exact: true })).toBeVisible();
    await page.getByLabel("Group by", { exact: true }).selectOption("week");
    await page.getByLabel("Date range", { exact: true }).selectOption("90");
    await expect(page.getByText(/Compared with the preceding 90 days/)).toBeVisible();
    await page.getByText("View chart data", { exact: true }).click();
    await expect(page.getByRole("table", { name: "Metrics per UTC bucket" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });

  test("deduplicates views, unifies people, splits audiences and matches conversion cohorts", async ({ request }) => {
    reseed();
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/fairweathermen_test" });
    try {
      await pool.query("DELETE FROM activity_logs");
      const { rows: [extra] } = await pool.query("SELECT id FROM users WHERE group_id=2 AND login_code='demo-alex'");
      const base = Date.now() - 10 * 86400000;
      const insert = async (type: string, offset: number, userId: number | null, data: object, path = "/lawro", ua = "Mozilla/5.0 Safari/605.1.15") => {
        await pool.query("INSERT INTO activity_logs (type,user_id,group_id,ip_address,user_agent,path,details,created_at) VALUES ($1,$2,$3,'192.0.2.10',$4,$5,$6,$7)", [type,userId,userId ? (userId === extra.id ? 2 : 1) : null,ua,path,JSON.stringify(data),new Date(base + offset)]);
      };
      await insert("page_visit", -60 * 86400000, 1, { method: "GET" });
      await insert("page_visit", -30 * 86400000, 1, { method: "GET" });
      await insert("new_visitor", 0, null, { vid: "test-browser" }, "/");
      await insert("page_visit", 1, null, { vid: "test-browser", method: "GET" }, "/");
      await insert("page_visit", 1000, null, { vid: "test-browser", method: "CLIENT_NAVIGATION" }, "/");
      await insert("group_joined", 2000, 1, { vid: "test-browser" });
      await insert("page_visit", 3000, 1, { method: "GET" });
      await insert("page_visit", 4000, 1, { method: "CLIENT_NAVIGATION" });
      await insert("page_visit", 5000, extra.id, { method: "CLIENT_NAVIGATION" });
      await insert("prediction_set", 6000, 1, { actorRecorded: true, actorUserId: 1 }, "/api/predictions");
      const { rows: [participant] } = await pool.query("SELECT id FROM lms_participants WHERE user_id=1 LIMIT 1");
      await insert("lms_selection_new", 6500, null, { participantId: participant.id }, "/api/lms/selections");
      await insert("page_visit", 7000, 1, { speculative: true });
      await insert("page_visit", 8000, null, {}, "/", "Googlebot");
      await insert("page_visit", 9000, 1, {}, "/admin/metrics");
      await insert("page_visit", 10000, 1, {}, "/icons/logo.webp");
      const res = await request.get("/api/admin/metrics?days=28&interval=day", { headers: { "x-api-key": ADMIN_KEY } });
      expect(res.ok()).toBeTruthy();
      const data = await res.json();
      expect(data.totals).toMatchObject({ pageViews: 3, loggedInViews: 2, anonymousViews: 1, activePlayers: 1, activeGroups: 2, contributors: 1, newBrowsers: 1, playersJoined: 1, gameActions: 2 });
      expect(data.previous.activePlayers).toBe(1);
      expect(data.retentionRate).toBe(1);
      expect(data.activationRate).toBe(1);
      expect(data.conversion).toMatchObject({ eligibleBrowsers: 1, convertedBrowsers: 1, pendingBrowsers: 0, windowDays: 7, rate: 1 });
      expect(data.quality.duplicateViews).toBe(2);
      expect(data.quality.excludedEvents).toBe(4);
      expect(data.series.reduce((n: number, r: { pageViews: number }) => n + r.pageViews, 0)).toBe(3);
      expect(JSON.stringify(data)).not.toContain("demo-alex");
      expect(JSON.stringify(data)).not.toContain("192.0.2.10");
      const weekly = await (await request.get("/api/admin/metrics?days=28&interval=week", { headers: { "x-api-key": ADMIN_KEY } })).json();
      expect(weekly.series.every((r: { date: string }) => new Date(r.date).getUTCDay() === 1)).toBeTruthy();
      expect(weekly.totals).toEqual(data.totals);
      const monthly = await (await request.get("/api/admin/metrics?days=28&interval=month", { headers: { "x-api-key": ADMIN_KEY } })).json();
      expect(monthly.series.every((r: { date: string }) => r.date.endsWith("-01"))).toBeTruthy();
      expect(monthly.totals).toEqual(data.totals);
      await pool.query("DELETE FROM activity_logs");
      const empty = await (await request.get("/api/admin/metrics", { headers: { "x-api-key": ADMIN_KEY } })).json();
      expect(empty.totals.pageViews).toBe(0);
      expect(empty.retentionRate).toBeNull();
      expect(empty.conversion.rate).toBeNull();
    } finally { await pool.end(); reseed(); }
  });
});


test.describe("metrics data quality", () => {
  test("uses mature cohorts, known actors, browser identities and additive sessions", async ({ request, page }) => {
    reseed();
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/fairweathermen_test" });
    const day = 86400000;
    const now = Date.now();
    const base = now - 14 * day;
    const ua = "Mozilla/5.0 Safari/605.1.15";
    const add = async (type: string, time: number, userId: number | null, d: unknown, path = "/lawro", agent: string | null = ua) => {
      await pool.query("INSERT INTO activity_logs (type,user_id,group_id,ip_address,user_agent,path,details,created_at) VALUES ($1,$2,1,'192.0.2.25',$3,$4,$5,$6)", [type,userId,agent,path,typeof d === "string" ? d : JSON.stringify(d),new Date(time)]);
    };
    const fetchMetrics = async (interval = "day", days = 28) => {
      const response = await request.get(`/api/admin/metrics?days=${days}&interval=${interval}`, { headers: { "x-api-key": ADMIN_KEY } });
      expect(response.ok()).toBeTruthy();
      return response.json();
    };
    try {
      await pool.query("DELETE FROM activity_logs");
      await add("page_visit", now - 70 * day, 1, { method: "GET" });
      // Three mature cohorts: converted within 7d, converted too late, rejoin only.
      for (const vid of ["mature", "late", "repeat"]) await add("new_visitor", base, null, { vid }, "/");
      await add("group_created", base + day, 1, { vid: "mature" }, "/api/group/create");
      await add("group_joined", base + 8 * day, 1, { vid: "late", rejoin: false }, "/api/group/join/token");
      await add("group_joined", base + day, 1, { vid: "repeat", rejoin: true }, "/api/group/join/token");
      // A recent cohort stays pending even if they already joined successfully.
      await add("new_visitor", now - day, null, { vid: "pending" }, "/");
      await add("group_joined", now - day + 1000, 1, { vid: "pending", rejoin: false }, "/api/group/join/token");
      // Same IP/UA, different visitor cookies: both navigations must survive.
      await add("page_visit", base, null, { vid: "browser-a", method: "GET" });
      await add("page_visit", base + 1000, null, { vid: "browser-b", method: "CLIENT_NAVIGATION" });
      // Old target-only edit must not count Blake as an active player. New edit
      // is about Blake but attributed to Alex, the signed-in actor.
      await add("prediction_set", base, 2, {}, "/api/predictions");
      await add("prediction_change", base + 1000, 2, { actorRecorded: true, actorUserId: 1 }, "/api/predictions");
      // Missing UA and malformed metadata are retained without crashing.
      await add("page_visit", base + 2000, 1, "null", "/lawro", null);
      // One player session spans UTC midnight, but starts only once.
      const midnight = new Date(now - 2 * day); midnight.setUTCHours(0, 0, 0, 0);
      await add("page_visit", midnight.getTime() - 60000, 1, { method: "CLIENT_NAVIGATION" });
      await add("page_visit", midnight.getTime() + 60000, 1, { method: "CLIENT_NAVIGATION" });
      const daily = await fetchMetrics();
      expect(daily.conversion).toMatchObject({ eligibleBrowsers: 3, convertedBrowsers: 1, pendingBrowsers: 1, windowDays: 7 });
      expect(daily.conversion.rate).toBeCloseTo(1 / 3);
      expect(daily.totals).toMatchObject({ activePlayers: 1, contributors: 1, pageViews: 5, anonymousViews: 2, playerMemberships: 3, playersJoined: 2, rejoins: 1 });
      expect(daily.quality).toMatchObject({ duplicateViews: 0, unattributedGameActions: 1, unknownAgentEvents: 1 });
      expect(daily.retentionRate).toBeNull();
      expect(daily.games.find((game: { game: string }) => game.game === "Lawro")).toMatchObject({ players: 1, actions: 2 });
      const sessionSum = (data: typeof daily) => data.series.reduce((n: number, row: { sessions: number }) => n + row.sessions, 0);
      expect(sessionSum(daily)).toBe(daily.totals.sessions);
      const monthly = await fetchMetrics("month");
      expect(sessionSum(monthly)).toBe(daily.totals.sessions);
      expect(monthly.totals).toEqual(daily.totals);
      expect(daily.series[0].partial).toBeTruthy();
      expect(daily.series[daily.series.length - 1].partial).toBeTruthy();
      const short = await fetchMetrics("day", 7);
      expect(short.conversion).toMatchObject({ eligibleBrowsers: 0, convertedBrowsers: 0, pendingBrowsers: 1, rate: null });
      // History from unrelated event types must not justify comparisons.
      await pool.query("DELETE FROM activity_logs");
      await add("admin_access", now - 100 * day, null, {}, "/api/admin/check");
      await add("page_visit", base, 1, {});
      const partial = await fetchMetrics();
      expect(partial.history.comparison.activity).toBe(false);
      expect(partial.retentionRate).toBeNull();
      expect(partial.series[0].loggedInViews).toBeNull();
      await page.addInitScript(k => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
      await page.goto("/admin/metrics");
      // A solitary observed day surrounded by missing history must still draw.
      const audience = page.getByRole("img", { name: "Activity by audience", exact: true });
      await expect(audience.locator(".recharts-bar-rectangle path").first()).toBeVisible();
      // A session already underway at the selected-window boundary is not new.
      await pool.query("DELETE FROM activity_logs");
      await add("page_visit", now - 28 * day - 60000, 1, { method: "CLIENT_NAVIGATION" });
      await add("page_visit", now - 28 * day + 60000, 1, { method: "CLIENT_NAVIGATION" });
      const boundary = await fetchMetrics();
      expect(boundary.totals.sessions).toBe(0);
      expect(boundary.totals.pageViews).toBe(1);
    } finally { await pool.end(); reseed(); }
  });
});


test("game audit records the signed-in actor for engagement metrics", async ({ request }) => {
  reseed();
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/fairweathermen_test" });
  try {
    const login = await request.post("/api/group/login", { data: { code: CODES.alex } });
    expect(login.ok()).toBeTruthy();
    const { user } = await login.json();
    const { rows: [match] } = await pool.query("SELECT id FROM matches WHERE gameweek=2 ORDER BY id LIMIT 1");
    const pick = await request.post("/api/predictions", { data: { userId: user.id, matchId: match.id, homeScore: 2, awayScore: 0 } });
    expect(pick.status()).toBe(201);
    const { rows: [audit] } = await pool.query("SELECT user_id,details FROM activity_logs WHERE type='prediction_set' ORDER BY id DESC LIMIT 1");
    expect(audit.user_id).toBe(user.id);
    expect(JSON.parse(audit.details)).toMatchObject({ actorRecorded: true, actorUserId: user.id });
    expect(JSON.parse(audit.details)).not.toHaveProperty("vid");
    const metrics = await request.get("/api/admin/metrics", { headers: { "x-api-key": ADMIN_KEY } });
    const data = await metrics.json();
    expect(data.totals.contributors).toBe(1);
    expect(data.quality.unattributedGameActions).toBe(0);
  } finally { await pool.end(); reseed(); }
});

test("audit locations are labelled as estimates, with relays and 172.x handled", async ({ page, request }) => {
  reseed();
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/fairweathermen_test" });
  try {
    const login = await request.post("/api/group/login", { data: { code: CODES.alex } });
    const { user } = await login.json();
    const { rows: [match] } = await pool.query("SELECT id FROM matches WHERE gameweek=2 ORDER BY id LIMIT 1");
    // The app trusts X-Forwarded-For (it sits behind a reverse proxy), so this
    // stands in for a phone on iCloud Private Relay (Cloudflare egress; the IP
    // database calls it Edinburgh) and for a public 172.x address.
    for (const [ip, home] of [["104.28.89.57", 1], ["172.217.16.46", 2]] as const) {
      const pick = await request.put("/api/predictions", {
        headers: { "X-Forwarded-For": ip },
        data: { userId: user.id, matchId: match.id, homeScore: home, awayScore: 1 },
      });
      expect(pick.ok()).toBeTruthy();
    }
    const { rows } = await pool.query("SELECT ip_address, city, country FROM activity_logs WHERE ip_address IN ('104.28.89.57','172.217.16.46')");
    expect(rows).toHaveLength(2);
    const google = rows.find((r) => r.ip_address === "172.217.16.46");
    // Only 172.16.0.0/12 is private; 172.217.x is a public address.
    expect(google?.country).not.toBe("Local");

    await page.addInitScript((k) => localStorage.setItem("adminApiKey", k), ADMIN_KEY);
    await page.goto("/admin/audit");
    const relayRow = page.locator("tr", { hasText: "104.28.89.57" }).first();
    await expect(relayRow).toContainText("Private relay / VPN, GB");
    await expect(relayRow).not.toContainText("Edinburgh");
    // geoip-lite only knows the country for this one.
    await expect(page.locator("tr", { hasText: "172.217.16.46" }).first()).toContainText("US");
    await expect(page.getByText(/Local network/)).toHaveCount(0);
  } finally { await pool.end(); reseed(); }
});
