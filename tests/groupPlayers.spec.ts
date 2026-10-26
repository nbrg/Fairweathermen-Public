import { test, expect, type APIRequestContext } from "@playwright/test";
import { reseed } from "./seed";
import { CODES } from "./helpers";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// The group admin's player tools on /group-settings: listing players, sitting
// someone out of the next LMS competition, resetting a lost code, renaming,
// removing and making a new invite link. The server enforces who may do what.

const uniqueName = () => `Admin Tools ${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

async function createGroup(request: APIRequestContext, adminName = "Owner") {
  const res = await request.post("/api/group/create", {
    data: { groupName: uniqueName(), adminName, games: ["lms", "predictions"] },
  });
  expect(res.ok(), `create failed: ${res.status()}`).toBeTruthy();
  return res.json() as Promise<{ code: string; inviteToken: string }>;
}

test.describe("group admin player tools", () => {
  test("only the admin can see or manage players", async ({ playwright, baseURL }) => {
    const member = await playwright.request.newContext({ baseURL });
    await member.post("/api/group/login", { data: { code: CODES.blake } });
    expect((await member.get("/api/group/players")).status()).toBe(403);
    expect((await member.post("/api/group/invite/reset")).status()).toBe(403);
    await member.dispose();
  });

  test("a player can sit out the next LMS competition and be added back", async ({ request, playwright, baseURL }) => {
    const created = await createGroup(request);
    const joiner = await playwright.request.newContext({ baseURL });
    await joiner.post(`/api/group/join/${created.inviteToken}`, { data: { name: "Sam" } });
    await joiner.dispose();

    // The group's first LMS competition auto-starts at the next gameweek that
    // hasn't kicked off, so it's open and everyone's in it.
    const list = await (await request.get("/api/group/players")).json();
    expect(list.lms?.open).toBe(true);
    const samRow = list.players.find((p: any) => p.username === "Sam");
    expect(samRow.inLms).toBe(true);

    expect((await request.put(`/api/group/players/${samRow.id}/lms`, { data: { inLms: false } })).ok()).toBeTruthy();
    let after = await (await request.get("/api/group/players")).json();
    expect(after.players.find((p: any) => p.id === samRow.id).inLms).toBe(false);

    expect((await request.put(`/api/group/players/${samRow.id}/lms`, { data: { inLms: true } })).ok()).toBeTruthy();
    after = await (await request.get("/api/group/players")).json();
    expect(after.players.find((p: any) => p.id === samRow.id).inLms).toBe(true);
  });

  test("resetting a code retires the old one", async ({ request, playwright, baseURL }) => {
    const created = await createGroup(request);
    const joiner = await playwright.request.newContext({ baseURL });
    const oldCode = (await (await joiner.post(`/api/group/join/${created.inviteToken}`, { data: { name: "Sam" } })).json()).code;
    await joiner.dispose();

    const list = await (await request.get("/api/group/players")).json();
    const samRow = list.players.find((p: any) => p.username === "Sam");
    const reset = await request.post(`/api/group/players/${samRow.id}/reset-code`);
    expect(reset.ok()).toBeTruthy();
    const { code } = await reset.json();
    expect(code).toBeTruthy();
    expect(code).not.toBe(oldCode);

    const check = await playwright.request.newContext({ baseURL });
    expect((await check.post("/api/group/login", { data: { code: oldCode } })).status()).toBe(404);
    expect((await check.post("/api/group/login", { data: { code } })).ok()).toBeTruthy();
    await check.dispose();
  });

  test("a code shared with a group the admin doesn't run can't be reset", async ({ request, playwright, baseURL }) => {
    const created = await createGroup(request);
    // Alex is signed in, so joining links this row to Alex's existing code,
    // which also covers the seeded groups this admin doesn't run.
    const alex = await playwright.request.newContext({ baseURL });
    await alex.post("/api/group/login", { data: { code: CODES.alex } });
    await alex.post(`/api/group/join/${created.inviteToken}`, { data: { name: "Alex" } });
    await alex.dispose();

    const list = await (await request.get("/api/group/players")).json();
    const alexRow = list.players.find((p: any) => p.username === "Alex");
    expect((await request.post(`/api/group/players/${alexRow.id}/reset-code`)).status()).toBe(409);
  });

  test("rename, remove, and a new invite link", async ({ request, playwright, baseURL }) => {
    const created = await createGroup(request);
    const joiner = await playwright.request.newContext({ baseURL });
    await joiner.post(`/api/group/join/${created.inviteToken}`, { data: { name: "Typo Name" } });
    await joiner.dispose();

    let list = await (await request.get("/api/group/players")).json();
    expect(list.canRename).toBe(true);
    const row = list.players.find((p: any) => p.username === "Typo Name");
    const owner = list.players.find((p: any) => p.isOwner);
    expect(row.canRemove).toBe(true);
    expect(owner.canRemove).toBe(false);

    expect((await request.patch(`/api/group/players/${row.id}`, { data: { username: "Owner" } })).status()).toBe(409);
    expect((await request.patch(`/api/group/players/${row.id}`, { data: { username: "Fixed Name" } })).ok()).toBeTruthy();
    expect((await request.delete(`/api/group/players/${owner.id}`)).status()).toBe(409);
    expect((await request.delete(`/api/group/players/${row.id}`)).ok()).toBeTruthy();
    list = await (await request.get("/api/group/players")).json();
    expect(list.players.map((p: any) => p.username)).not.toContain("Fixed Name");

    const reset = await request.post("/api/group/invite/reset");
    expect(reset.ok()).toBeTruthy();
    const { inviteToken } = await reset.json();
    expect(inviteToken).not.toBe(created.inviteToken);
    expect((await request.get(`/api/group/invite/${created.inviteToken}`)).status()).toBe(404);
    expect((await request.get(`/api/group/invite/${inviteToken}`)).ok()).toBeTruthy();
  });

  test("the players card shows on the settings page", async ({ page }) => {
    await page.goto("/create");
    const res = await page.request.post("/api/group/create", {
      data: { groupName: uniqueName(), adminName: "Owner", games: ["lms"] },
    });
    expect(res.ok()).toBeTruthy();
    await page.goto("/group-settings");
    await expect(page.getByText("Players", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Manage Owner" })).toBeVisible();
  });
});
