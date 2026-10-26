import { test, expect, type APIRequestContext } from "@playwright/test";
import { reseed } from "./seed";

// Every rule change the admin makes pops up for the other players until they
// acknowledge it (RuleChangesDialog, fed by the session's `ruleChanges`). These
// cover that contract end to end: who sees a change, what it says, that the
// person who made it doesn't see their own, that acknowledging clears it, and
// that someone who joins afterwards starts clean.

test.beforeAll(reseed);

const uniqueName = () => `Rules ${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

// Create an owner's group and return the owner context + invite token.
async function createGroup(request: APIRequestContext, playwright: any, baseURL: string | undefined) {
  const owner = await playwright.request.newContext({ baseURL });
  const created = await (
    await owner.post("/api/group/create", {
      data: { groupName: uniqueName(), adminName: "Owner", games: ["lms", "predictions"] },
    })
  ).json();
  return { owner, inviteToken: created.inviteToken as string };
}

async function join(playwright: any, baseURL: string | undefined, token: string, name: string) {
  const ctx = await playwright.request.newContext({ baseURL });
  const res = await ctx.post(`/api/group/join/${token}`, { data: { name } });
  expect(res.ok(), `join failed: ${res.status()}`).toBeTruthy();
  return ctx;
}

test.describe("rule-change pop-up", () => {
  test("a change pops up for other players, naming who made it and what changed", async ({ request, playwright, baseURL }) => {
    const { owner, inviteToken } = await createGroup(request, playwright, baseURL);
    const member = await join(playwright, baseURL, inviteToken, "Alex");

    // Nothing to acknowledge before any change is made.
    expect((await (await member.get("/api/group/me")).json()).ruleChanges ?? []).toHaveLength(0);

    const put = await owner.put("/api/group/rules", {
      data: { lawro: { exactScorePoints: 5 }, lms: { lives: 3 } },
    });
    expect(put.ok()).toBeTruthy();

    // The member now has an unacknowledged change in their session.
    const changes = (await (await member.get("/api/group/me")).json()).ruleChanges;
    expect(changes).toHaveLength(1);
    expect(changes[0].changedByName).toBe("Owner");
    const keys = changes[0].changes.map((c: any) => c.key);
    expect(keys).toContain("exactScorePoints");
    expect(keys).toContain("lives");
    const exact = changes[0].changes.find((c: any) => c.key === "exactScorePoints");
    expect(exact.from).toBe("3");
    expect(exact.to).toBe("5");
    // A Lawro change records the gameweek it takes effect from (never retroactive).
    expect(changes[0].lawroEffectiveGameweek).not.toBeNull();

    // The person who made the change never sees their own in the pop-up.
    expect((await (await owner.get("/api/group/me")).json()).ruleChanges ?? []).toHaveLength(0);

    // Acknowledging up to that id clears it, and it stays cleared.
    const seen = await member.post("/api/group/rule-changes/seen", { data: { upToId: changes[0].id } });
    expect(seen.ok()).toBeTruthy();
    expect((await (await member.get("/api/group/me")).json()).ruleChanges ?? []).toHaveLength(0);

    await owner.dispose();
    await member.dispose();
  });

  test("a player who joins after a change doesn't see it", async ({ request, playwright, baseURL }) => {
    const { owner, inviteToken } = await createGroup(request, playwright, baseURL);

    const put = await owner.put("/api/group/rules", { data: { lms: { lives: 4 } } });
    expect(put.ok()).toBeTruthy();

    // A fresh joiner starts at the group's latest change, so the pre-existing
    // change isn't shown to them.
    const latecomer = await join(playwright, baseURL, inviteToken, "Noah");
    expect((await (await latecomer.get("/api/group/me")).json()).ruleChanges ?? []).toHaveLength(0);

    await owner.dispose();
    await latecomer.dispose();
  });
});
