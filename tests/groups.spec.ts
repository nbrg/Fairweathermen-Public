import { test, expect } from "@playwright/test";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// Self-service groups: an admin can create a group, set its rules, and add
// players, all from the admin screen. These cover the API contract and then the
// UI flow end to end.

const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "test-admin-key";
const admin = { "x-api-key": ADMIN_KEY, "Content-Type": "application/json" };

// A unique slug per run so repeated local runs don't collide.
const uniqueSlug = () => `t-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

test.describe("group management API", () => {
  test("create a group, then add a player to it", async ({ request }) => {
    const slug = uniqueSlug();
    const create = await request.post("/api/admin/groups", {
      headers: admin,
      data: { name: "API Test League", slug, enabledGames: ["lms", "predictions"], buyIn: 20, lmsAllOutRule: "revive" },
    });
    expect(create.status()).toBe(201);
    const { group } = await create.json();
    expect(group.slug).toBe(slug);
    expect(group.buyIn).toBe(20);
    expect(group.lmsAllOutRule).toBe("revive");

    const addPlayer = await request.post("/api/admin/players", {
      headers: admin,
      data: { groupId: group.id, username: "Tester" },
    });
    expect(addPlayer.ok()).toBeTruthy();
    const added = await addPlayer.json();
    expect(added.player.username).toBe("Tester");
    expect(added.player.loginCode).toBeTruthy();
  });

  test("a duplicate slug is rejected", async ({ request }) => {
    const slug = uniqueSlug();
    const first = await request.post("/api/admin/groups", {
      headers: admin,
      data: { name: "First", slug },
    });
    expect(first.status()).toBe(201);
    const dup = await request.post("/api/admin/groups", {
      headers: admin,
      data: { name: "Second", slug },
    });
    expect(dup.status()).toBe(409);
  });

  test("an invalid all-out rule is rejected", async ({ request }) => {
    const create = await request.post("/api/admin/groups", {
      headers: admin,
      data: { name: "Bad Rule", slug: uniqueSlug(), lmsAllOutRule: "nonsense" },
    });
    // Unknown rule falls back to the default rather than erroring on create…
    expect(create.status()).toBe(201);
    const { group } = await create.json();
    expect(group.lmsAllOutRule).toBe("rollover");

    // …but a PATCH with an explicit bad value is rejected.
    const patch = await request.patch(`/api/admin/groups/${group.id}`, {
      headers: admin,
      data: { lmsAllOutRule: "nonsense" },
    });
    expect(patch.status()).toBe(400);
  });

  test("updating a group's rules persists", async ({ request }) => {
    const create = await request.post("/api/admin/groups", {
      headers: admin,
      data: { name: "Editable", slug: uniqueSlug(), buyIn: 5 },
    });
    const { group } = await create.json();
    const patch = await request.patch(`/api/admin/groups/${group.id}`, {
      headers: admin,
      data: { buyIn: 50, lmsAllOutRule: "revive" },
    });
    expect(patch.ok()).toBeTruthy();
    const updated = (await patch.json()).group;
    expect(updated.buyIn).toBe(50);
    expect(updated.lmsAllOutRule).toBe("revive");
  });

  test("creating a group needs the admin key", async ({ request }) => {
    const res = await request.post("/api/admin/groups", {
      headers: { "Content-Type": "application/json" },
      data: { name: "Nope", slug: uniqueSlug() },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe("group management UI", () => {
  test("an admin can create a group and add a player from the screen", async ({ page }) => {
    const slug = uniqueSlug();
    await page.goto("/admin/players");

    // Enter the admin key (saved to localStorage, unlocks the screen).
    await page.getByPlaceholder("paste key…").fill(ADMIN_KEY);

    // Fill in the create-group form.
    await page.getByLabel("Name").fill("UI League");
    await page.getByLabel("Slug (lowercase, no spaces)").fill(slug);
    await page.getByRole("button", { name: "Create group" }).click();

    // The new group's card appears; scope the rest to it so other groups on the
    // screen can't be mistaken for it.
    const card = page.getByTestId(`group-card-${slug}`);
    await expect(card).toBeVisible();
    await expect(card.getByText("UI League")).toBeVisible();

    // Add a player to it; their name shows up in that card.
    await card.getByPlaceholder("New player name…").fill("Robin");
    await card.getByRole("button", { name: "Add", exact: true }).click();
    await expect(card.getByText("Robin")).toBeVisible();
  });
});
