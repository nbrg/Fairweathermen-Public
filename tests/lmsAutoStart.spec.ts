import { test, expect, type APIRequestContext } from "@playwright/test";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// A group that plays LMS should get its first competition the moment it's
// created — at the next gameweek that hasn't kicked off — so players can pick
// straight away. The seed's GW1 is in the past and GW2 is upcoming, so a new
// group starts at GW2. A group that doesn't play LMS gets nothing.

const uniqueName = () => `Auto Start ${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

async function createGroup(request: APIRequestContext, games: string[]) {
  const res = await request.post("/api/group/create", {
    data: { groupName: uniqueName(), adminName: "Owner", games },
  });
  expect(res.ok(), `create failed: ${res.status()}`).toBeTruthy();
  return res.json() as Promise<{ code: string; inviteToken: string }>;
}

test.describe("LMS competitions auto-start", () => {
  test("a new LMS group gets a running competition with the admin in it", async ({ request }) => {
    await createGroup(request, ["lms", "predictions"]);

    // The endpoint returns the competition object directly (or null when none).
    const current = await (await request.get("/api/lms/current-competition")).json();
    expect(current).toBeTruthy();
    expect(current.status).toBe("active");
    // Seed GW1 kicked off two days ago; GW2 is a week out, so that's the start.
    expect(current.startGameweek).toBe(2);

    const players = await (await request.get("/api/group/players")).json();
    expect(players.lms?.open).toBe(true);
    const owner = players.players.find((p: any) => p.isOwner);
    expect(owner.inLms).toBe(true);
  });

  test("a predictions-only group starts no competition", async ({ request }) => {
    await createGroup(request, ["predictions"]);
    const current = await (await request.get("/api/lms/current-competition")).json();
    expect(current).toBeNull();
    const players = await (await request.get("/api/group/players")).json();
    expect(players.lms).toBeNull();
  });
});
