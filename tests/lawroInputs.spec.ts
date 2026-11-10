import { test, expect, type Page, type Route } from "@playwright/test";
import { reseed } from "./seed";
import { loginViaApi, CODES } from "./helpers";
import { utcToLondonString } from "@shared/time";

// Every case owns a fresh disposable fixture; no production URL/database.
test.beforeEach(reseed);

async function fixture(page: Page, count = 1) {
  const me = await loginViaApi(page.request, CODES.alex);
  const matches = await (await page.request.get("/api/matches")).json();
  const first = matches.find((m: any) => m.gameweek === 2);
  const ids = [first.id];
  for (let n = 1; n < count; n++) {
    const response = await page.request.post("/api/matches", {
      headers: { "x-api-key": process.env.ADMIN_API_KEY ?? "test-admin-key" },
      data: { homeTeamId: first.homeTeamId, awayTeamId: first.awayTeamId,
        status: "not_started", matchTime: first.matchTime, matchDay: "2",
        matchDate: first.matchTime.slice(0, 10), gameweek: 2, season: "2025/2026" },
    });
    expect(response.ok()).toBeTruthy();
    ids.push((await response.json()).id);
  }
  return { userId: me.user.id as number, ids };
}
async function picks(page: Page, userId: number, matchId: number) {
  const response = await page.request.get("/api/predictions");
  expect(response.ok()).toBeTruthy();
  return (await response.json()).filter((p: any) => p.userId === userId && p.matchId === matchId);
}
async function write(page: Page, userId: number, matchId: number, score: string | null) {
  const [homeScore, awayScore] = score === null ? [null, null] : score.split("-").map(Number);
  return page.request.put("/api/predictions", { data: { userId, matchId, homeScore, awayScore } });
}
const input = (page: Page, id: number) => page.getByTestId(`pred-input-${id}`);
const status = (page: Page, id: number) => input(page, id);
async function saved(page: Page, userId: number, id: number, score: string) {
  await expect(input(page, id)).toHaveValue(score);
  await expect(status(page, id)).toHaveAttribute("data-save-state", "saved");
  await expect.poll(async () => (await picks(page, userId, id)).map((p: any) => `${p.homeScore}-${p.awayScore}`)).toEqual(score ? [score] : []);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function holdFirst(page: Page) {
  const gate = deferred();
  const started = deferred();
  const writes: any[] = [];
  await page.route("**/api/predictions", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) { started.resolve(); await gate.promise; }
    await route.continue();
  });
  return { writes, started: started.promise, release: gate.resolve };
}

test("ten predictions save with natural keyboard entry, Tab and zero scores", async ({ page }) => {
  const { userId, ids } = await fixture(page, 10);
  await page.goto("/lawro");
  for (const [n, id] of ids.entries()) {
    await input(page, id).click();
    await input(page, id).pressSequentially(n % 2 ? "00" : "21");
    await input(page, id).press("Tab");
  }
  for (const [n, id] of ids.entries()) await saved(page, userId, id, n % 2 ? "0-0" : "2-1");
  await page.reload();
  for (const [n, id] of ids.entries()) await expect(input(page, id)).toHaveValue(n % 2 ? "0-0" : "2-1");
});

test("a failed first save recovers while the other nine scores are entered", async ({ page }) => {
  const { userId, ids } = await fixture(page, 10);
  let firstAttempts = 0;
  await page.route("**/api/predictions", async route => {
    if (route.request().method() === "PUT" && route.request().postDataJSON().matchId === ids[0] && ++firstAttempts === 1) {
      return route.fulfill({ status: 500, json: { error: "Transient database failure" } });
    }
    await route.continue();
  });
  await page.goto("/lawro");
  for (const id of ids) await input(page, id).fill("2-1");
  for (const id of ids) await saved(page, userId, id, "2-1");
  expect(firstAttempts).toBe(2);
  await page.reload();
  for (const id of ids) await expect(input(page, id)).toHaveValue("2-1");
});

for (const initial of [null, "1-0"] as const) {
  test(`latest correction wins with a pending ${initial ? "update" : "create"}`, async ({ page }) => {
    const { userId, ids: [id] } = await fixture(page);
    if (initial) expect((await write(page, userId, id, initial)).ok()).toBeTruthy();
    await page.goto("/lawro");
    const pending = await holdFirst(page);
    await input(page, id).fill("2-1");
    await pending.started;
    await input(page, id).fill("3-0");
    await input(page, id).blur();
    expect(pending.writes).toHaveLength(1);
    pending.release();
    await saved(page, userId, id, "3-0");
    expect(pending.writes).toHaveLength(2);
    await page.reload();
    await expect(input(page, id)).toHaveValue("3-0");
  });
}

test("clearing a pending creation stays cleared", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await page.goto("/lawro");
  const pending = await holdFirst(page);
  await input(page, id).fill("2-1");
  await pending.started;
  await input(page, id).fill("");
  pending.release();
  await saved(page, userId, id, "");
  expect(pending.writes.map(p => p.homeScore)).toEqual([2, null]);
  await page.reload();
  await expect(input(page, id)).toHaveValue("");
});

test("re-entering during a pending clear survives the delete", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await write(page, userId, id, "2-1");
  await page.goto("/lawro");
  const pending = await holdFirst(page);
  await input(page, id).fill("");
  await pending.started;
  await input(page, id).fill("2-1");
  pending.release();
  await saved(page, userId, id, "2-1");
  expect(pending.writes.map(p => p.homeScore)).toEqual([null, 2]);
});

test("changing back to the original value still queues behind a pending edit", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await write(page, userId, id, "1-0");
  await page.goto("/lawro");
  const pending = await holdFirst(page);
  await input(page, id).fill("2-1");
  await pending.started;
  await input(page, id).fill("1-0");
  pending.release();
  await saved(page, userId, id, "1-0");
  expect(pending.writes).toHaveLength(2);
});

test("rapid repeated corrections coalesce to the latest complete score", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await page.goto("/lawro");
  const pending = await holdFirst(page);
  await input(page, id).fill("1-0");
  await pending.started;
  for (const score of ["2-0", "2-2", "", "0-0", "9-9"]) await input(page, id).fill(score);
  pending.release();
  await saved(page, userId, id, "9-9");
  expect(pending.writes.map(p => `${p.homeScore}-${p.awayScore}`)).toEqual(["1-0", "9-9"]);
});

test("a pending save continues across tab unmount and remount", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await page.goto("/lawro");
  const pending = await holdFirst(page);
  await input(page, id).fill("2-1");
  await pending.started;
  await page.getByRole("tab", { name: "Leaderboard", exact: true }).click();
  await page.getByRole("tab", { name: "Predictions", exact: true }).click();
  await input(page, id).fill("3-0");
  pending.release();
  await saved(page, userId, id, "3-0");
  expect(pending.writes).toHaveLength(2);
});

test("a pending save continues across gameweek navigation", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await page.goto("/lawro");
  const pending = await holdFirst(page);
  await input(page, id).fill("2-1");
  await pending.started;
  await page.getByRole("button", { name: "Previous gameweek" }).click();
  pending.release();
  await expect.poll(async () => (await picks(page, userId, id)).length).toBe(1);
  await page.getByRole("button", { name: "Next gameweek" }).click();
  await saved(page, userId, id, "2-1");
});

test("a lost response after commit is retried without duplicate predictions", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  let attempts = 0;
  await page.route("**/api/predictions", async route => {
    if (route.request().method() === "PUT" && ++attempts === 1) {
      expect((await route.fetch()).ok()).toBeTruthy();
      return route.abort("connectionreset");
    }
    await route.continue();
  });
  await page.goto("/lawro");
  await input(page, id).fill("2-1");
  await saved(page, userId, id, "2-1");
  expect(attempts).toBe(2);
  const audit = await page.request.get("/api/admin/audit", { headers: { "x-api-key": "test-admin-key" } });
  const logs = await audit.json();
  expect(logs.filter((r: any) => r.type === "prediction_set" && r.username === "Alex" && r.summary.includes("2-1"))).toHaveLength(1);
});

test("an aborted request retries automatically", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  let attempts = 0;
  await page.route("**/api/predictions", async route => {
    if (route.request().method() === "PUT" && ++attempts === 1) return route.abort("connectionreset");
    await route.continue();
  });
  await page.goto("/lawro");
  await input(page, id).fill("0-0");
  await saved(page, userId, id, "0-0");
  expect(attempts).toBe(2);
});

test("exhausted retries show a retry icon and manual retry saves", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  let attempts = 0;
  const fail = async (route: Route) => {
    if (route.request().method() !== "PUT") return route.continue();
    attempts++;
    await route.fulfill({ status: 500, json: { error: "Temporary failure" } });
  };
  await page.route("**/api/predictions", fail);
  await page.goto("/lawro");
  await input(page, id).fill("2-1");
  await expect(page.getByTestId(`pred-retry-${id}`)).toBeVisible({ timeout: 10000 });
  expect(attempts).toBe(4);
  expect(await picks(page, userId, id)).toHaveLength(0);
  await expect(input(page, id)).toHaveAttribute("aria-invalid", "true");
  await page.unroute("**/api/predictions", fail);
  await page.getByTestId(`pred-retry-${id}`).click();
  await saved(page, userId, id, "2-1");
});

test("an unsaved draft survives reload and is replayed", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await page.route("**/api/predictions", async route => {
    if (route.request().method() === "PUT") return route.fulfill({ status: 500, json: { error: "Temporary failure" } });
    await route.continue();
  });
  await page.goto("/lawro");
  await input(page, id).fill("3-0");
  await expect(status(page, id)).toHaveAttribute("data-save-state", "error", { timeout: 10000 });
  await page.unroute("**/api/predictions");
  await page.reload();
  await saved(page, userId, id, "3-0");
});

test("offline input recovers automatically when connectivity returns", async ({ page, context }) => {
  const { userId, ids: [id] } = await fixture(page);
  await page.goto("/lawro");
  await expect(input(page, id)).toBeVisible();
  await context.setOffline(true);
  await input(page, id).fill("2-1");
  await input(page, id).blur();
  await expect(status(page, id)).toHaveAttribute("data-save-state", "error", { timeout: 10000 });
  await context.setOffline(false);
  await saved(page, userId, id, "2-1");
});

test("partial input stays invalid, survives reload, and does not overwrite a saved score", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await write(page, userId, id, "2-1");
  await page.goto("/lawro");
  await input(page, id).fill("2-");
  await input(page, id).blur();
  await expect(status(page, id)).toHaveAttribute("data-save-state", "incomplete");
  expect((await picks(page, userId, id))[0].awayScore).toBe(1);
  await page.reload();
  await expect(input(page, id)).toHaveValue("2-");
  await input(page, id).press("End");
  await input(page, id).pressSequentially("0");
  await saved(page, userId, id, "2-0");
});

test("a partial draft is not overwritten when an earlier save completes", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await page.goto("/lawro");
  const pending = await holdFirst(page);
  await input(page, id).fill("2-1");
  await pending.started;
  await input(page, id).fill("3-");
  pending.release();
  await expect.poll(async () => (await picks(page, userId, id)).length).toBe(1);
  await expect(status(page, id)).toHaveAttribute("data-save-state", "incomplete");
  await expect(input(page, id)).toHaveValue("3-");
  await input(page, id).press("End");
  await input(page, id).pressSequentially("0");
  await saved(page, userId, id, "3-0");
});

test("paste normalization, invalid text, selected replacement, backspace and Enter", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await page.goto("/lawro");
  await input(page, id).fill(" 2 – 1 ");
  await saved(page, userId, id, "2-1");
  for (const invalid of ["abc", "10-1", "-1-0", "2.5-1", "22"]) {
    await input(page, id).fill(invalid);
    await expect(input(page, id)).toHaveValue("2-1");
  }
  await input(page, id).fill("3");
  await expect(input(page, id)).toHaveValue("3-");
  await input(page, id).press("End");
  await input(page, id).pressSequentially("0");
  await input(page, id).press("Enter");
  await saved(page, userId, id, "3-0");
  await input(page, id).fill("4-");
  await input(page, id).press("End");
  await input(page, id).press("Backspace");
  await saved(page, userId, id, "");
});

test("refetch adopts changes from another session without overwriting dirty drafts", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await write(page, userId, id, "2-1");
  await page.goto("/lawro");
  await expect(input(page, id)).toHaveValue("2-1");
  await write(page, userId, id, "3-0");
  // The dynamic URL is a Vite-served module; avoid a test-runner module import.
  await page.evaluate(async () => {
    const path = "/src/lib/queryClient.ts";
    const { queryClient } = await import(/* @vite-ignore */ path);
    await queryClient.invalidateQueries({ queryKey: ["/api/predictions"] });
  });
  await expect(input(page, id)).toHaveValue("3-0");
  await input(page, id).fill("4-");
  await write(page, userId, id, "5-0");
  await page.evaluate(async () => {
    const path = "/src/lib/queryClient.ts";
    const { queryClient } = await import(/* @vite-ignore */ path);
    await queryClient.invalidateQueries({ queryKey: ["/api/predictions"] });
  });
  await expect(input(page, id)).toHaveValue("4-");
});

test("save still works when browser draft storage is unavailable", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, "sessionStorage", { value: {
      setItem() { throw new Error("Storage disabled"); },
      getItem() { throw new Error("Storage disabled"); },
      removeItem() { throw new Error("Storage disabled"); },
    } });
  });
  await page.goto("/lawro");
  await input(page, id).fill("2-1");
  await saved(page, userId, id, "2-1");
});

test("permanent deadline rejection stays accessible and is not retried automatically", async ({ page }) => {
  const { ids: [id] } = await fixture(page);
  let attempts = 0;
  await page.route("**/api/predictions", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    attempts++;
    await route.fulfill({ status: 403, json: { error: "Predictions are locked - the gameweek deadline has passed" } });
  });
  await page.goto("/lawro");
  await input(page, id).fill("2-1");
  await expect(status(page, id)).toHaveAttribute("aria-description", /deadline has passed/);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  expect(attempts).toBe(1);
});

test("idempotent concurrent saves create one pick and clearing twice succeeds", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  const responses = await Promise.all(Array.from({ length: 12 }, () => write(page, userId, id, "2-1")));
  expect(responses.every(r => r.ok())).toBeTruthy();
  expect(await picks(page, userId, id)).toHaveLength(1);
  expect((await write(page, userId, id, null)).ok()).toBeTruthy();
  expect((await write(page, userId, id, null)).ok()).toBeTruthy();
  expect(await picks(page, userId, id)).toHaveLength(0);
});

test("API validates scores and protects ownership, disabled games and locked gameweeks", async ({ page, playwright, baseURL }) => {
  const { userId, ids: [id] } = await fixture(page);
  const invalid = [
    { homeScore: -1, awayScore: 0 }, { homeScore: 10, awayScore: 0 },
    { homeScore: 1.5, awayScore: 0 }, { homeScore: "2", awayScore: 0 },
    { homeScore: null, awayScore: 0 }, { homeScore: 2 },
    { homeScore: 2, awayScore: 1, isLatePick: true },
  ];
  for (const scores of invalid) {
    const response = await page.request.put("/api/predictions", { data: { userId, matchId: id, ...scores } });
    expect(response.status()).toBe(400);
  }
  const forged = await page.request.put("/api/predictions", { data: { userId: userId + 1, matchId: id, homeScore: 2, awayScore: 1 } });
  expect(forged.status()).toBe(403);
  const pastMatches = await (await page.request.get("/api/matches")).json();
  const past = pastMatches.find((m: any) => m.gameweek === 1);
  expect((await write(page, userId, past.id, "9-9")).status()).toBe(403);
  expect((await write(page, userId, past.id, null)).status()).toBe(403);
  const unauth = await playwright.request.newContext({ baseURL });
  expect((await unauth.put("/api/predictions", { data: { userId, matchId: id, homeScore: 2, awayScore: 1 } })).ok()).toBeFalsy();
  await unauth.dispose();
  const dana = await loginViaApi(page.request, CODES.dana);
  expect((await write(page, dana.user.id, id, "2-1")).status()).toBe(403);
});

async function ownerWithRules(page: Page, lawro: Record<string, unknown>) {
  const created = await page.request.post("/api/group/create", { data: {
    groupName: `Score QA ${Date.now()}`, adminName: "Owner", games: ["predictions"],
  } });
  expect(created.ok()).toBeTruthy();
  const rules = await page.request.put("/api/group/rules", { data: { lawro } });
  expect(rules.ok()).toBeTruthy();
  return (await (await page.request.get("/api/group/me")).json()).user.id as number;
}
async function lockGameweek(page: Page, firstId: number) {
  const res = await page.request.patch(`/api/matches/${firstId}`, {
    headers: { "x-api-key": "test-admin-key" },
    data: { matchTime: utcToLondonString(new Date(Date.now() - 60000).toISOString()) },
  });
  expect(res.ok()).toBeTruthy();
}

test("Joker is preserved on edits and safely removed when a pick is cleared", async ({ page }) => {
  const { ids: [id] } = await fixture(page);
  const userId = await ownerWithRules(page, { jokerEnabled: true });
  const first = await write(page, userId, id, "2-1");
  const original = (await first.json()).prediction;
  const joker = await page.request.put(`/api/predictions/${original.id}/joker`, { data: { joker: true } });
  expect(joker.ok()).toBeTruthy();
  await page.goto("/lawro");
  await input(page, id).fill("3-0");
  await saved(page, userId, id, "3-0");
  const [edited] = await picks(page, userId, id);
  expect(edited.id).toBe(original.id);
  expect(edited.isJoker).toBe(true);
  await input(page, id).fill("");
  await saved(page, userId, id, "");
  await input(page, id).fill("1-1");
  await saved(page, userId, id, "1-1");
  expect((await picks(page, userId, id))[0].isJoker).toBe(false);
});

test("late-entry rule permits missing future picks, edits and clears but rejects a kicked-off match", async ({ page }) => {
  const { ids: [first, future] } = await fixture(page, 2);
  const userId = await ownerWithRules(page, { missedPickPolicy: "open_until_kickoff" });
  await lockGameweek(page, first);
  expect((await write(page, userId, first, "2-1")).status()).toBe(403);
  expect((await write(page, userId, future, "2-1")).ok()).toBeTruthy();
  expect((await picks(page, userId, future))[0].isLatePick).toBe(true);
  expect((await write(page, userId, future, "3-0")).ok()).toBeTruthy();
  expect((await write(page, userId, future, null)).ok()).toBeTruthy();
  expect(await picks(page, userId, future)).toHaveLength(0);
});

test("late-entry rule cannot unlock a prediction submitted before the deadline", async ({ page }) => {
  const { ids: [first, future] } = await fixture(page, 2);
  const userId = await ownerWithRules(page, { missedPickPolicy: "open_until_kickoff" });
  expect((await write(page, userId, future, "2-1")).ok()).toBeTruthy();
  await lockGameweek(page, first);
  expect((await write(page, userId, future, "3-0")).status()).toBe(403);
  expect((await write(page, userId, future, null)).status()).toBe(403);
  // A response-lost retry of exactly the committed pick changes nothing.
  expect((await write(page, userId, future, "2-1")).ok()).toBeTruthy();
  expect((await picks(page, userId, future))[0].isLatePick).toBe(false);
});

test("saved picks remain hidden from another player before the deadline", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await write(page, userId, id, "3-0");
  await loginViaApi(page.request, CODES.blake);
  const [hidden] = await picks(page, userId, id);
  expect(hidden.hidden).toBe(true);
  expect(hidden.homeScore).toBeUndefined();
  expect(hidden.awayScore).toBeUndefined();
});

test("drafts stay with their owner across logout and another player's login", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await page.route("**/api/predictions", async route => {
    if (route.request().method() === "PUT") return route.fulfill({ status: 403, json: { error: "Test rejection" } });
    await route.continue();
  });
  await page.goto("/lawro");
  await input(page, id).fill("3-0");
  await expect(status(page, id)).toHaveAttribute("aria-description", /Test rejection/);
  await page.request.post("/api/group/logout");
  const blake = await loginViaApi(page.request, CODES.blake);
  const [blakePick] = await picks(page, blake.user.id, id);
  await page.reload();
  await expect(input(page, id)).toHaveValue(`${blakePick.homeScore}-${blakePick.awayScore}`);
  await page.unroute("**/api/predictions");
  await loginViaApi(page.request, CODES.alex);
  await page.reload();
  await saved(page, userId, id, "3-0");
});

test("editing after a permanent failure saves the new score without retrying the old value", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  const writes: any[] = [];
  await page.route("**/api/predictions", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) return route.fulfill({ status: 400, json: { error: "Test validation error" } });
    await route.continue();
  });
  await page.goto("/lawro");
  await input(page, id).fill("2-1");
  await expect(status(page, id)).toHaveAttribute("aria-description", /Test validation error/);
  await input(page, id).fill("4-0");
  await saved(page, userId, id, "4-0");
  expect(writes.map(p => p.homeScore)).toEqual([2, 4]);
});

test("rate-limited saves retry, and confirmed drafts are removed from session storage", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  let attempts = 0;
  await page.route("**/api/predictions", async route => {
    if (route.request().method() === "PUT" && ++attempts === 1) return route.fulfill({ status: 429, json: { error: "Please retry" } });
    await route.continue();
  });
  await page.goto("/lawro");
  await input(page, id).fill("2-1");
  await saved(page, userId, id, "2-1");
  expect(attempts).toBe(2);
  expect(await page.evaluate(k => sessionStorage.getItem(k), `lawro-draft:${userId}:${id}`)).toBeNull();
});

test("legacy creators and retryable saves cannot create duplicate rows", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  const results = await Promise.all(Array.from({ length: 12 }, (_, n) => n % 2
    ? write(page, userId, id, "2-1")
    : page.request.post("/api/predictions", { data: { userId, matchId: id, homeScore: 2, awayScore: 1 } })));
  expect(results.every(r => r.ok() || r.status() === 400)).toBeTruthy();
  expect(await picks(page, userId, id)).toHaveLength(1);
});

test("many concurrent corrections complete without exhausting the database pool", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await write(page, userId, id, "0-0");
  const results = await Promise.all(Array.from({ length: 32 }, (_, n) => write(page, userId, id, `${n % 10}-${Math.floor(n / 10)}`)));
  expect(results.every(r => r.ok())).toBeTruthy();
  expect(await picks(page, userId, id)).toHaveLength(1);
});

test("random missed-pick filling keeps automatic flags and existing manual scores", async ({ page }) => {
  const { ids: [first, future] } = await fixture(page, 2);
  const userId = await ownerWithRules(page, { missedPickPolicy: "random" });
  await write(page, userId, future, "9-9");
  await lockGameweek(page, first);
  const { fillMissedLawroPicks } = await import("../server/lawroMissedPicks");
  await fillMissedLawroPicks();
  const [automatic] = await picks(page, userId, first);
  expect(automatic.isAutoPick).toBe(true);
  const [manual] = await picks(page, userId, future);
  expect(manual.homeScore).toBe(9);
  expect(manual.awayScore).toBe(9);
  expect(manual.isAutoPick).toBe(false);
  await fillMissedLawroPicks();
  expect(await picks(page, userId, first)).toHaveLength(1);
});

test("starting the first score immediately prevents delayed layout corrections from stealing focus", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await page.goto("/lawro");
  await input(page, id).click();
  await input(page, id).pressSequentially("2");
  await expect(input(page, id)).toHaveValue("2-");
  // Exercise the existing one-second keyboard/layout-settling window.
  await page.waitForTimeout(1100);
  await expect(input(page, id)).toBeFocused();
  await input(page, id).pressSequentially("1");
  await saved(page, userId, id, "2-1");
});

test("interleaved edits across ten matches survive delayed responses and mixed transient failures", async ({ page }) => {
  const { userId, ids } = await fixture(page, 10);
  const attempts = new Map<number, number>();
  await page.route("**/api/predictions", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    const id = route.request().postDataJSON().matchId;
    const attempt = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, attempt);
    const index = ids.indexOf(id);
    if (attempt === 1 && index % 3 === 0) return route.fulfill({ status: 500, json: { error: "Transient failure" } });
    const response = await route.fetch();
    if (attempt === 1 && index % 3 === 1) return route.abort("connectionreset");
    // Deliberately reorder completions between matches, while the player keeps editing.
    await new Promise(resolve => setTimeout(resolve, (index * 17 + attempt * 13) % 90));
    await route.fulfill({ response });
  });
  await page.goto("/lawro");
  const expected = new Map<number, string>();
  for (let n = 0; n < 80; n++) {
    const id = ids[(n * 7) % ids.length];
    const score = n % 11 === 0 ? "" : `${n % 10}-${Math.floor(n / 10) % 10}`;
    expected.set(id, score);
    await input(page, id).fill(score);
  }
  for (const [id, score] of expected) await saved(page, userId, id, score);
  await page.reload();
  for (const [id, score] of expected) await expect(input(page, id)).toHaveValue(score);
});

test("an unconfirmed clear survives reload even though its draft is an empty string", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await write(page, userId, id, "2-1");
  await page.route("**/api/predictions", async route => {
    if (route.request().method() === "PUT") return route.fulfill({ status: 500, json: { error: "Transient failure" } });
    await route.continue();
  });
  await page.goto("/lawro");
  await input(page, id).fill("");
  await expect(status(page, id)).toHaveAttribute("data-save-state", "error", { timeout: 10000 });
  expect(await picks(page, userId, id)).toHaveLength(1);
  await page.unroute("**/api/predictions");
  await page.reload();
  await saved(page, userId, id, "");
});

test("an open score cell becomes read-only at its deadline without waiting for new match data", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await write(page, userId, id, "2-1");
  const nearKickoff = utcToLondonString(new Date(Date.now() + 60000).toISOString());
  const changed = await page.request.patch(`/api/matches/${id}`, {
    headers: { "x-api-key": "test-admin-key" }, data: { matchTime: nearKickoff },
  });
  expect(changed.ok()).toBeTruthy();
  await page.clock.install();
  await page.goto("/lawro");
  await expect(input(page, id)).toBeVisible();
  await page.clock.fastForward(61000);
  await expect(page.getByText("Picks locked", { exact: true })).toBeVisible();
  await expect(input(page, id)).toHaveCount(0);
  expect((await picks(page, userId, id))[0].homeScore).toBe(2);
});

test("a late-entry cell becomes read-only at its own kick-off", async ({ page }) => {
  const { ids: [first, future] } = await fixture(page, 2);
  const userId = await ownerWithRules(page, { missedPickPolicy: "open_until_kickoff" });
  await lockGameweek(page, first);
  await page.request.patch(`/api/matches/${future}`, {
    headers: { "x-api-key": "test-admin-key" },
    data: { matchTime: utcToLondonString(new Date(Date.now() + 60000).toISOString()) },
  });
  expect((await write(page, userId, future, "2-1")).ok()).toBeTruthy();
  await page.clock.install();
  await page.goto("/lawro");
  await expect(input(page, future)).toBeVisible();
  await page.clock.fastForward(61000);
  await expect(input(page, future)).toHaveCount(0);
});

test("the grid flips at the deadline even while a late-entry cell is still open", async ({ page }) => {
  const { ids: [first, future] } = await fixture(page, 2);
  await ownerWithRules(page, { missedPickPolicy: "open_until_kickoff" });
  await lockGameweek(page, first);
  await page.goto("/lawro");
  await expect(page.getByTestId("lawro-grid")).toHaveAttribute("data-layout", "matches-as-columns");
  await expect(input(page, future)).toBeVisible();
  await expect(input(page, first)).toHaveCount(0);
});

test("an unconfirmed or malformed success response is retried before being marked saved", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  let attempts = 0;
  await page.route("**/api/predictions", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    attempts++;
    const response = await route.fetch();
    if (attempts === 1) return route.fulfill({ status: 200, json: { prediction: null } });
    return route.fulfill({ response });
  });
  await page.goto("/lawro");
  await input(page, id).fill("2-1");
  await saved(page, userId, id, "2-1");
  expect(attempts).toBe(2);
});

test("programmatically focusing a score protects clearing during the initial layout window", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await write(page, userId, id, "2-1");
  await page.clock.install();
  await page.goto("/lawro");
  await input(page, id).focus();
  await page.clock.fastForward(1100);
  await expect(input(page, id)).toBeFocused();
  await input(page, id).fill("");
  await saved(page, userId, id, "");
});

test("score cells have no helper text while incomplete, saving, saved or failed", async ({ page }) => {
  const { userId, ids: [id] } = await fixture(page);
  await page.goto("/lawro");
  const field = input(page, id);
  const cell = field.locator("..");
  await expect(field).toBeVisible();
  await expect(cell).toHaveText("");
  await field.pressSequentially("1");
  await expect(field).toHaveValue("1-");
  await expect(cell).toHaveText("");
  const pending = await holdFirst(page);
  await field.pressSequentially("2");
  await pending.started;
  await expect(field).toHaveAttribute("aria-busy", "true");
  await expect(cell).toHaveText("");
  pending.release();
  await saved(page, userId, id, "1-2");
  await expect(cell).toHaveText("");
  const fail = async (route: Route) => {
    if (route.request().method() === "PUT") return route.fulfill({ status: 403, json: { error: "Test rejection" } });
    await route.continue();
  };
  await page.route("**/api/predictions", fail);
  await field.fill("3-0");
  await expect(page.getByTestId(`pred-retry-${id}`)).toBeVisible();
  await expect(cell).toHaveText("");
  await expect(field).not.toHaveAttribute("title");
  await page.unroute("**/api/predictions", fail);
  await page.getByTestId(`pred-retry-${id}`).click();
  await saved(page, userId, id, "3-0");
  await expect(cell).toHaveText("");
});

test("a complete score moves straight on to the next match's box", async ({ page }) => {
  const { userId, ids } = await fixture(page, 3);
  await page.goto("/lawro");
  await input(page, ids[0]).click();
  await page.keyboard.type("21");
  await expect(input(page, ids[1])).toBeFocused();
  await page.keyboard.type("00");
  await expect(input(page, ids[2])).toBeFocused();
  await page.keyboard.type("13");
  await saved(page, userId, ids[0], "2-1");
  await saved(page, userId, ids[1], "0-0");
  await saved(page, userId, ids[2], "1-3");
  // A partial score or a correction by deletion does not jump away.
  await input(page, ids[1]).click();
  await input(page, ids[1]).press("End");
  await input(page, ids[1]).press("Backspace");
  await expect(input(page, ids[1])).toBeFocused();
});

test("typing over a saved score replaces it wherever the caret is", async ({ page }) => {
  const { userId, ids } = await fixture(page, 2);
  await write(page, userId, ids[0], "2-1");
  await write(page, userId, ids[1], "1-1");
  await page.goto("/lawro");
  await input(page, ids[0]).click();
  await input(page, ids[0]).press("End");
  await page.keyboard.type("3");
  await expect(input(page, ids[0])).toHaveValue("3-");
  await page.keyboard.type("0");
  await saved(page, userId, ids[0], "3-0");
  // Auto-advance lands on the next saved score; typing replaces it too.
  await expect(input(page, ids[1])).toBeFocused();
  await page.keyboard.type("42");
  await saved(page, userId, ids[1], "4-2");
});
