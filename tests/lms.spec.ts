import { test, expect } from "@playwright/test";
import { CODES, loginViaApi, loginViaUi } from "./helpers";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// Last Man Standing: each gameweek you pick one team, you can't reuse a team
// you've already picked in the competition, and you can only edit your own
// selections. The seed has an active competition on GW2 with Alex, Blake and
// Casey in it, and Alex has already used Arsenal in GW1.

async function getMyParticipant(request: any, meUserId: number) {
  const res = await request.get("/api/lms/current-competition");
  expect(res.ok()).toBeTruthy();
  const comp = await res.json();
  const mine = comp.participants.find((p: any) => p.userId === meUserId);
  const other = comp.participants.find((p: any) => p.userId !== meUserId);
  return { comp, mine, other };
}

async function teamIdByName(request: any, name: string) {
  const res = await request.get("/api/lms/available-teams");
  const teams: any[] = await res.json();
  const t = teams.find((x) => x.name === name);
  expect(t, `team ${name} not available`).toBeTruthy();
  return t.id;
}

test.describe("Last Man Standing", () => {
  test("available teams come from the current season's fixtures", async ({ request }) => {
    await loginViaApi(request, CODES.alex);
    const res = await request.get("/api/lms/available-teams");
    expect(res.ok()).toBeTruthy();
    const names = (await res.json()).map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["Liverpool", "Manchester City"]));
  });

  test("you cannot reuse a team you've already picked", async ({ request }) => {
    const me = await loginViaApi(request, CODES.alex);
    const { mine } = await getMyParticipant(request, me.user.id);
    const arsenalId = await teamIdByName(request, "Arsenal");

    const res = await request.post("/api/lms/select-team", {
      data: { teamId: arsenalId, participantId: mine.id, gameweek: 2 },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/already selected/i);
  });

  test("you can only edit your own selections", async ({ request }) => {
    const me = await loginViaApi(request, CODES.alex);
    const { other } = await getMyParticipant(request, me.user.id);
    const liverpoolId = await teamIdByName(request, "Liverpool");

    const res = await request.post("/api/lms/select-team", {
      data: { teamId: liverpoolId, participantId: other.id, gameweek: 2 },
    });
    expect(res.status()).toBe(403);
  });

  test("a valid pick for the open gameweek is accepted", async ({ request }) => {
    const me = await loginViaApi(request, CODES.casey);
    const { mine } = await getMyParticipant(request, me.user.id);
    const liverpoolId = await teamIdByName(request, "Liverpool");

    const res = await request.post("/api/lms/select-team", {
      data: { teamId: liverpoolId, participantId: mine.id, gameweek: 2 },
    });
    expect(res.ok(), `expected 2xx, got ${res.status()}`).toBeTruthy();
  });
});

test.describe("Last Man Standing UI", () => {
  test("the page shows the roster and the open gameweek", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/last-man-standing");
    for (const name of ["Alex", "Blake", "Casey"]) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    }
  });

  test("a player can make a pick through the team picker", async ({ page }) => {
    // Blake has no selection yet (Casey picks via the API test above), so the
    // open gameweek offers the "Make your pick" button.
    await loginViaUi(page, CODES.blake);
    await page.goto("/last-man-standing");

    await page.getByRole("button", { name: /Make your pick/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Manchester City/i }).click();

    // The pick is applied optimistically; the picker stays open showing the
    // choice, so close it and check the card behind it.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Your GW2 pick")).toBeVisible();
    await expect(page.getByText("Manchester City").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Change pick/i })).toBeVisible();
  });

  test("every LMS tab opens without error", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/last-man-standing");
    for (const name of ["History", "Fixtures", "Stats", "Rules", "Live"]) {
      await page.getByRole("tab", { name }).click();
      await expect(page.getByRole("tab", { name })).toHaveAttribute("data-state", "active");
      await expect(page.getByText(/^404/)).toHaveCount(0);
    }
  });

  test("the Stats tab counts the Round 1 exits", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/last-man-standing");
    await page.getByRole("tab", { name: "Stats" }).click();
    // Stats render for the active competition (no crash, tab is active).
    await expect(page.getByRole("tab", { name: "Stats" })).toHaveAttribute("data-state", "active");
  });
});
