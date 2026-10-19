import { test, expect } from "@playwright/test";
import { reseed } from "./seed";
import { CODES } from "./helpers";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// Self-service groups: anyone can create their own group from the public pages
// (no admin key), invite players with a link, and — as the group's admin — tune
// its per-group rules. These cover the API contract end to end.

const uniqueName = () => `Self Serve ${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

test.describe("self-service group creation + invites", () => {
  test("create a group → login code, invite link, and an owner session", async ({ request }) => {
    const name = uniqueName();
    const res = await request.post("/api/group/create", {
      data: { groupName: name, adminName: "Pat", games: ["lms", "predictions"] },
    });
    expect(res.ok(), `create failed: ${res.status()}`).toBeTruthy();
    const body = await res.json();
    expect(body.loginCode).toBeTruthy();
    expect(body.inviteToken).toBeTruthy();
    expect(body.inviteUrl).toContain(`/join/${body.inviteToken}`);
    expect(body.group?.name).toBe(name);
    expect(body.group?.isOwner).toBe(true);

    // The create call leaves the caller signed in as the group's owner.
    const me = await request.get("/api/group/me");
    expect(me.ok()).toBeTruthy();
    const meBody = await me.json();
    expect(meBody.isOwner).toBe(true);
    expect(meBody.rules?.lms).toBeTruthy();
    expect(meBody.rules?.lawro).toBeTruthy();
  });

  test("create requires a name and a self-serve game", async ({ request }) => {
    const noName = await request.post("/api/group/create", {
      data: { groupName: "", adminName: "Pat", games: ["lms"] },
    });
    expect(noName.status()).toBe(400);

    const noGame = await request.post("/api/group/create", {
      data: { groupName: uniqueName(), adminName: "Pat", games: [] },
    });
    expect(noGame.status()).toBe(400);

    // Golf isn't a self-serve game (needs seeded data), so a golf-only request
    // has no valid games and is rejected.
    const golfOnly = await request.post("/api/group/create", {
      data: { groupName: uniqueName(), adminName: "Pat", games: ["golf"] },
    });
    expect(golfOnly.status()).toBe(400);
  });

  test("invite link describes the group, and a player can join for a code", async ({ request, playwright, baseURL }) => {
    const name = uniqueName();
    const created = await (
      await request.post("/api/group/create", {
        data: { groupName: name, adminName: "Owner", games: ["lms"] },
      })
    ).json();

    const invite = await request.get(`/api/group/invite/${created.inviteToken}`);
    expect(invite.ok()).toBeTruthy();
    expect((await invite.json()).name).toBe(name);

    // Join from a fresh context so it's not the owner's session.
    const joiner = await playwright.request.newContext({ baseURL });
    const joinRes = await joiner.post(`/api/group/join/${created.inviteToken}`, {
      data: { name: "Sam" },
    });
    expect(joinRes.ok(), `join failed: ${joinRes.status()}`).toBeTruthy();
    const joinBody = await joinRes.json();
    expect(joinBody.loginCode).toBeTruthy();

    // The joiner is now in the group but isn't its owner.
    const joinerMe = await joiner.get("/api/group/me");
    expect((await joinerMe.json()).isOwner).toBe(false);
    await joiner.dispose();
  });

  test("an unknown invite token 404s", async ({ request }) => {
    const res = await request.get("/api/group/invite/nope-not-a-real-token");
    expect(res.status()).toBe(404);
  });
});

test.describe("per-group rules API", () => {
  test("the owner can read and update their group's rules", async ({ request }) => {
    const created = await (
      await request.post("/api/group/create", {
        data: { groupName: uniqueName(), adminName: "Ruler", games: ["lms", "predictions"] },
      })
    ).json();

    const get = await request.get("/api/group/rules");
    expect(get.ok()).toBeTruthy();
    const getBody = await get.json();
    expect(getBody.isOwner).toBe(true);
    expect(getBody.inviteToken).toBe(created.inviteToken);

    const put = await request.put("/api/group/rules", {
      data: {
        lawro: { exactScorePoints: 5, correctResultPoints: 2 },
        lms: { lives: 3, buyIn: 25, allOutPolicy: "co_winners" },
      },
    });
    expect(put.ok()).toBeTruthy();
    const saved = (await put.json()).rules;
    expect(saved.lawro.exactScorePoints).toBe(5);
    expect(saved.lms.lives).toBe(3);
    expect(saved.lms.buyIn).toBe(25);
    expect(saved.lms.allOutPolicy).toBe("co_winners");

    // Persisted: a fresh read returns the saved values (including the richer
    // all-out option the legacy column can't hold).
    const reread = await (await request.get("/api/group/rules")).json();
    expect(reread.rules.lms.allOutPolicy).toBe("co_winners");
    expect(reread.rules.lawro.exactScorePoints).toBe(5);
  });

  test("out-of-range rule values are clamped", async ({ request }) => {
    await request.post("/api/group/create", {
      data: { groupName: uniqueName(), adminName: "Clamp", games: ["predictions"] },
    });
    const put = await request.put("/api/group/rules", {
      data: { lawro: { exactScorePoints: -5 }, lms: { lives: 999 } },
    });
    expect(put.ok()).toBeTruthy();
    const saved = (await put.json()).rules;
    expect(saved.lawro.exactScorePoints).toBe(0); // clamped to min 0
    expect(saved.lms.lives).toBe(10); // clamped to max 10
  });

  test("a non-owner member cannot edit the rules", async ({ request, playwright, baseURL }) => {
    // A seeded demo player belongs to an admin-created group (no self-service
    // owner), so they are never its owner.
    const member = await playwright.request.newContext({ baseURL });
    const login = await member.post("/api/group/login", { data: { code: CODES.alex } });
    expect(login.ok()).toBeTruthy();

    const rules = await member.get("/api/group/rules");
    expect(rules.ok()).toBeTruthy();
    expect((await rules.json()).isOwner).toBe(false);

    const put = await member.put("/api/group/rules", { data: { lms: { lives: 5 } } });
    expect(put.status()).toBe(403);
    await member.dispose();
  });
});
