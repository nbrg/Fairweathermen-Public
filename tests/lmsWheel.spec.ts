import { test, expect, type APIRequestContext } from "@playwright/test";
import { CODES, loginViaApi, loginViaUi } from "./helpers";
import { reseed } from "./seed";
import { utcToLondonString } from "@shared/time";
import { WHEEL_SLOT_MS, WHEEL_SPIN_DELAY_MS, spinsIn, wheelPushMessage } from "@shared/lmsWheel";

// LMS randomiser wheel. When players miss the deadline the server draws each a
// random team straight away (as before), but keeps it hidden from everyone
// until that player's wheel has spun: the wheels spin one at a time from 3
// minutes after the deadline, using only the teams each player has left. The
// seed has Demo League's competition on GW2 (Liverpool v Man City) with Alex,
// Blake and Casey in it and no GW2 picks, and LMS's default missed-pick rule is
// "random", so moving GW2's kickoff into the past makes all three miss it.

test.beforeEach(reseed);

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/fairweathermen_test";
process.env.DATABASE_DRIVER = "pg";

const ADMIN = { "x-api-key": process.env.ADMIN_API_KEY ?? "test-admin-key" };

// Move GW2's (only) kickoff so the LMS deadline was `msAgo` ago.
async function deadlineAgo(request: APIRequestContext, msAgo: number) {
  const matches = await (await request.get("/api/matches")).json();
  const gw2 = matches.find((m: any) => m.gameweek === 2);
  const res = await request.patch(`/api/matches/${gw2.id}`, {
    headers: ADMIN,
    data: { matchTime: utcToLondonString(new Date(Date.now() - msAgo).toISOString()) },
  });
  expect(res.ok()).toBeTruthy();
}

// What the LMS page's polling does once the deadline passes: draws the misses.
async function drawMissedPicks(request: APIRequestContext) {
  const res = await request.get("/api/lms/gameweek-status/2");
  expect((await res.json()).isLocked).toBe(true);
}

async function gw2Picks(request: APIRequestContext) {
  const comp = await (await request.get("/api/lms/current-competition")).json();
  return Object.fromEntries(
    comp.participants.map((p: any) => [p.user.username, p.selections.find((s: any) => s.gameweek === 2)]),
  );
}

test("a missed player's wheel holds only the teams they have left, and every pick stays hidden until it spins", async ({ request }) => {
  // Blake already used Liverpool, so Man City is the only team left for them.
  const { db } = await import("../server/db");
  const { lmsParticipants, lmsSelections, users } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  await loginViaApi(request, CODES.alex);
  const [blake] = await db.select().from(users).where(eq(users.loginCode, CODES.blake));
  const [blakeP] = await db.select().from(lmsParticipants).where(eq(lmsParticipants.userId, blake.id));
  const teams = await (await request.get("/api/teams")).json();
  const id = (name: string) => teams.find((t: any) => t.name === name).id;
  await db.insert(lmsSelections).values({ participantId: blakeP.id, gameweek: 1, teamId: id("Liverpool"), result: "w" });

  await deadlineAgo(request, 20_000);
  await drawMissedPicks(request);

  const wheel = await (await request.get("/api/lms/wheel")).json();
  expect(wheel.spins.map((s: any) => s.name)).toEqual(["Alex", "Blake", "Casey"]);
  const pools = Object.fromEntries(wheel.spins.map((s: any) => [s.name, s.pool.map((t: any) => t.name)]));
  expect(pools).toEqual({
    Alex: ["Liverpool", "Manchester City"],
    Blake: ["Manchester City"],
    Casey: ["Liverpool", "Manchester City"],
  });
  // One at a time, the first 3 minutes after the deadline.
  const [a, b, c] = wheel.spins;
  expect(a.spinStartMs - wheel.deadlineMs).toBe(WHEEL_SPIN_DELAY_MS);
  expect(b.spinStartMs - a.spinStartMs).toBe(WHEEL_SLOT_MS);
  expect(c.spinStartMs - b.spinStartMs).toBe(WHEEL_SLOT_MS);
  expect(a.isMe).toBe(true);
  // Nobody learns the drawn team before the wheel spins.
  expect(wheel.spins.every((s: any) => s.teamId === null)).toBe(true);

  // The picks exist, but are hidden from everyone, their owner included.
  const picks = await gw2Picks(request);
  for (const name of ["Alex", "Blake", "Casey"]) {
    expect(picks[name], `${name} has a drawn pick`).toBeTruthy();
    expect(picks[name].teamId).toBeNull();
    expect(picks[name].wheel).toBe(true);
  }
  // Blake's draw came from the teams they had left.
  const gw2 = (await db.select().from(lmsSelections).where(eq(lmsSelections.participantId, blakeP.id))).find(
    (s) => s.gameweek === 2,
  );
  expect(gw2?.teamId).toBe(id("Manchester City"));
});

test("the wheel is only shown in the group where the deadline was missed", async ({ request }) => {
  const me = await loginViaApi(request, CODES.alex);
  await deadlineAgo(request, 20_000);
  await drawMissedPicks(request);
  expect((await (await request.get("/api/lms/wheel")).json()).spins).toHaveLength(3);

  const rovers = me.availableGroups.find((g: any) => g.name === "Rovers");
  const switched = await request.post("/api/group/switch", { data: { groupId: rovers.id } });
  expect(switched.ok()).toBeTruthy();
  expect((await (await request.get("/api/lms/wheel")).json()).spins).toHaveLength(0);
});

test("once the last wheel has spun there's no wheel, and the picks are revealed", async ({ request }) => {
  await loginViaApi(request, CODES.alex);
  await deadlineAgo(request, 20_000);
  await drawMissedPicks(request);
  // Jump past the third wheel's slot.
  await deadlineAgo(request, WHEEL_SPIN_DELAY_MS + 3 * WHEEL_SLOT_MS + 5_000);
  expect((await (await request.get("/api/lms/wheel")).json()).spins).toHaveLength(0);
  const picks = await gw2Picks(request);
  for (const name of ["Alex", "Blake", "Casey"]) {
    expect(picks[name].teamId).not.toBeNull();
    expect(picks[name].wheel).toBeUndefined();
    expect(String(picks[name].isRandomlyAssigned)).toBe("true");
  }
});

test("spectators see a countdown, then each wheel spins live in turn", async ({ page }) => {
  test.setTimeout(60_000);
  await loginViaUi(page, CODES.alex);
  // The first wheel spins 8 seconds from now.
  await deadlineAgo(page.request, WHEEL_SPIN_DELAY_MS - 8_000);
  await drawMissedPicks(page.request);
  await page.goto("/last-man-standing");

  const wheel = page.getByTestId("lms-wheel");
  await expect(wheel).toContainText("You, Blake and Casey missed the deadline");
  await expect(page.getByTestId("lms-wheel-countdown")).toHaveText(/^0:0\d$/);
  // The grid shows a wheel where the drawn picks will appear.
  await expect(page.getByRole("img", { name: /the wheel picks this team/i }).first()).toBeVisible();

  // Alex's wheel spins first and lands on one of their two teams.
  await expect(page.getByTestId("lms-wheel-title")).toHaveText("Your wheel", { timeout: 15_000 });
  await expect(wheel).toContainText("Up next: Blake, then Casey");
  await expect(page.getByTestId("lms-wheel-result")).toHaveText(/^You get (Liverpool|Manchester City) \((H|A) v (LIV|MCI)\)$/, {
    timeout: 15_000,
  });
  // Then Blake's.
  await expect(page.getByTestId("lms-wheel-title")).toHaveText("Blake's wheel", { timeout: 15_000 });
});

test("the wheel pops up over any page as the deadline passes, can't be closed, and closes itself once it has spun", async ({ page }) => {
  test.setTimeout(150_000);
  // Only Alex misses: Blake and Casey pick before the deadline.
  for (const code of [CODES.blake, CODES.casey]) {
    const me = await loginViaApi(page.request, code);
    const comp = await (await page.request.get("/api/lms/current-competition")).json();
    const mine = comp.participants.find((p: any) => p.userId === me.user.id);
    const teams = await (await page.request.get("/api/lms/available-teams")).json();
    const liv = teams.find((t: any) => t.name === "Liverpool").id;
    const res = await page.request.post("/api/lms/select-team", { data: { teamId: liv, participantId: mine.id, gameweek: 2 } });
    expect(res.ok()).toBeTruthy();
  }
  await page.context().clearCookies();
  await loginViaUi(page, CODES.alex);
  await page.goto("/lawro");
  const wheel = page.getByTestId("lms-wheel");
  await expect(wheel).toBeHidden();

  // The deadline passes while Alex is on the Lawro page: the pop-up opens on
  // its own (no reload), counting down to the spin.
  await deadlineAgo(page.request, WHEEL_SPIN_DELAY_MS - 30_000);
  await expect(wheel).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("dialog")).toContainText("You missed the deadline");
  // Nothing closes it.
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await expect(wheel).toBeVisible();

  await expect(page.getByTestId("lms-wheel-result")).toHaveText(/^You get (Liverpool|Manchester City)/, { timeout: 30_000 });
  // Gone once the result has shown, and the pick is in the table.
  await expect(wheel).toBeHidden({ timeout: 15_000 });
  await page.goto("/last-man-standing");
  await expect(page.getByText(/Your GW2 pick/i)).toBeVisible();
  await expect(page.getByText("Down to the wheel")).toHaveCount(0);
  await expect(wheel).toBeHidden();
});

test("the push names who missed and says how long until the wheel spins", () => {
  // Sent 90s before the spin: rounded down to 1 minute.
  expect(spinsIn(90_000)).toBe("in 1 minute");
  expect(spinsIn(150_000)).toBe("in 2 minutes");
  expect(spinsIn(30_000)).toBe("in under a minute");
  expect(wheelPushMessage(["Devon"], "Alex", 12, spinsIn(90_000))).toEqual({
    title: "🎡 Devon missed the LMS deadline",
    body: "Watch the wheel pick Devon's Gameweek 12 team live in 1 minute",
  });
  expect(wheelPushMessage(["Devon"], "Devon", 12, "in 1 minute")).toEqual({
    title: "🎡 You missed the LMS deadline",
    body: "The wheel picks your Gameweek 12 team live in 1 minute. Tap to watch.",
  });
  expect(wheelPushMessage(["Devon", "Jamie"], "Alex", 12, "in 1 minute").title).toBe("🎡 Devon and Jamie missed the LMS deadline");
  expect(wheelPushMessage(["Devon", "Jamie"], "Jamie", 12, "in 1 minute").body).toBe(
    "The wheel picks your Gameweek 12 team live in 1 minute, along with Devon's. Tap to watch.",
  );
});
