import { test, expect, type APIRequestContext } from "@playwright/test";
import { reseed } from "./seed";
import { CODES } from "./helpers";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// Login codes are the only credential, so a name must never be enough to get
// one: creating or joining a group under someone else's name has to give the
// caller a NEW code, not theirs.

const uniqueName = () => `Name Check ${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

async function createGroup(request: APIRequestContext, adminName = "Owner") {
  const res = await request.post("/api/group/create", {
    data: { groupName: uniqueName(), adminName, games: ["lms", "predictions"] },
  });
  expect(res.ok(), `create failed: ${res.status()}`).toBeTruthy();
  return res.json() as Promise<{ code: string; inviteToken: string }>;
}

test.describe("names never hand out login codes", () => {
  test("creating a group under an existing player's name gets a fresh code", async ({ request }) => {
    const created = await createGroup(request, "Alex");
    expect(created.code).not.toBe(CODES.alex);
    // …and the new session only reaches the new group, not Alex's real ones.
    const me = await (await request.get("/api/group/me")).json();
    expect(me.availableGroups).toHaveLength(1);
  });

  test("joining under a name already in the group is refused", async ({ request, playwright, baseURL }) => {
    const created = await createGroup(request, "Owner");
    const stranger = await playwright.request.newContext({ baseURL });
    const res = await stranger.post(`/api/group/join/${created.inviteToken}`, { data: { name: "owner" } });
    expect(res.status()).toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain(created.code);
    await stranger.dispose();
  });

  test("a signed-in player who joins another group keeps their one code", async ({ request, playwright, baseURL }) => {
    const created = await createGroup(request, "Owner");
    const alex = await playwright.request.newContext({ baseURL });
    expect((await alex.post("/api/group/login", { data: { code: CODES.alex } })).ok()).toBeTruthy();
    const joined = await (await alex.post(`/api/group/join/${created.inviteToken}`, { data: { name: "Alex" } })).json();
    expect(joined.code).toBe(CODES.alex);
    expect(joined.linked).toBe(true);
    await alex.dispose();
  });
});
