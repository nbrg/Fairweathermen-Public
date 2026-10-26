import { test, expect } from "@playwright/test";
import { CODES, loginViaApi, loginViaUi } from "./helpers";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// Alex belongs to two groups under one login code (Demo League, which plays
// LMS + Lawro, and Rovers, which plays LMS only), so they can switch between
// them; Blake belongs only to Demo League. Switching re-points the session at
// the other group and changes the enabled games.
test.describe("multi-group switching", () => {
  test("a multi-group login lists every group", async ({ request }) => {
    const body = await loginViaApi(request, CODES.alex);
    const names = body.availableGroups.map((g: any) => g.name);
    expect(names).toEqual(expect.arrayContaining(["Demo League", "Rovers"]));
  });

  test("a single-group login lists just the one", async ({ request }) => {
    const body = await loginViaApi(request, CODES.blake);
    expect(body.availableGroups).toHaveLength(1);
    expect(body.availableGroups[0].name).toBe("Demo League");
  });

  test("switching re-points the session and swaps the games", async ({ request }) => {
    await loginViaApi(request, CODES.alex);
    const rovers = (await (await request.get("/api/group/me")).json()).availableGroups.find(
      (g: any) => g.slug === "rovers",
    );
    const res = await request.post("/api/group/switch", { data: { groupId: rovers.id } });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.slug).toBe("rovers");
    // Rovers plays LMS only, not Lawro.
    expect(body.enabledGames).toEqual(expect.arrayContaining(["lms"]));
    expect(body.enabledGames).not.toContain("predictions");
  });

  test("you cannot switch into a group you don't belong to", async ({ request }) => {
    await loginViaApi(request, CODES.blake); // only Demo League
    // Rovers exists but Blake has no row in it.
    const me = await (await request.get("/api/group/me")).json();
    const otherId = (me.availableGroups[0].id as number) + 999; // definitely not theirs
    const res = await request.post("/api/group/switch", { data: { groupId: otherId } });
    expect([403, 404]).toContain(res.status());
  });

  test("the switcher changes the active group in the UI", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    // Demo League hosts Lawro, so while it's active the Lawro tab is a
    // same-group nav link.
    const switcher = page.getByTestId("group-switcher");
    await expect(switcher).toContainText("Demo League");
    await expect(page.getByRole("link", { name: "Lawro" })).toBeVisible();

    await switcher.click();
    await page.getByRole("option", { name: "Rovers" }).click();

    // The active group is now Rovers, which doesn't host Lawro — the tab stays
    // in the nav (Alex still plays Lawro in Demo) but becomes a cross-group
    // switch button rather than a link.
    await expect(switcher).toContainText("Rovers");
    await expect(page.getByRole("link", { name: "Lawro" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Lawro" })).toBeVisible();
  });

  test("switching keeps you on the same game tab when the new group offers it", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    // Both Demo League and Rovers play LMS, so switching from the LMS page
    // should leave you on LMS rather than bouncing to the landing route.
    await page.goto("/last-man-standing");
    await page.getByTestId("group-switcher").click();
    await page.getByRole("option", { name: "Rovers" }).click();
    await expect(page).toHaveURL(/\/last-man-standing$/);
  });

  test("switching leaves a game the new group lacks and lands on its primary game", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    // Lawro is Demo-only; switching to Rovers (no Lawro) from the Lawro page
    // must send you to the landing route, not keep you on a page Rovers lacks.
    await page.goto("/lawro");
    await page.getByTestId("group-switcher").click();
    await page.getByRole("option", { name: "Rovers" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("link", { name: "Lawro" })).toBeHidden();
  });
});
