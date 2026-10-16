import { test, expect } from "@playwright/test";
import { CODES, loginViaApi, loginViaUi } from "./helpers";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// Alex belongs to two groups under one login code (Demo League + Rovers), so
// they can switch between them; Blake belongs only to Demo League. Switching
// re-points the session at the other group and changes the enabled games.
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
    // Rovers plays LMS + Lawro but not golf.
    expect(body.enabledGames).toEqual(expect.arrayContaining(["lms", "predictions"]));
    expect(body.enabledGames).not.toContain("golf");
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
    // Golf is a Demo-only game, so its tab is a sign of the active group.
    await expect(page.getByRole("link", { name: "Golf" })).toBeVisible();

    // The group switcher only appears for multi-group people.
    const switcher = page.getByTestId("group-switcher");
    await switcher.click();
    await page.getByRole("option", { name: "Rovers" }).click();

    // Rovers has no golf, so that tab goes away once we're in Rovers.
    await expect(page.getByRole("link", { name: "Golf" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Lawro" })).toBeVisible();
  });
});
