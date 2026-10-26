import { test, expect, type APIRequestContext } from "@playwright/test";
import { reseed } from "./seed";
import { CODES, loginViaApi } from "./helpers";

// The Lawro Joker (an optional per-group rule, default off): each player may
// flag one of their predictions a gameweek as their Joker, and whatever it
// scores is doubled. These cover the endpoint contract — the rule gate, who may
// set it, and that it stays settable only while the gameweek is open.

test.beforeAll(reseed);

const uniqueName = () => `Joker ${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

test.describe("Lawro Joker", () => {
  test("the Joker is refused when the rule is off for the group", async ({ request }) => {
    // The seeded Demo group runs on default rules, so the Joker is off.
    const me = await loginViaApi(request, CODES.alex);
    const preds = await (await request.get("/api/predictions")).json();
    const mine = preds.find((p: any) => p.userId === me.user.id);
    expect(mine).toBeTruthy();

    const res = await request.put(`/api/predictions/${mine.id}/joker`, { data: { joker: true } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/isn't on/i);
  });

  test("you can't set another player's pick as your Joker", async ({ request }) => {
    const me = await loginViaApi(request, CODES.alex);
    const preds = await (await request.get("/api/predictions")).json();
    const theirs = preds.find((p: any) => p.userId !== me.user.id);
    expect(theirs).toBeTruthy();

    const res = await request.put(`/api/predictions/${theirs.id}/joker`, { data: { joker: true } });
    expect(res.status()).toBe(403);
  });

  test("with the rule on, a player sets and clears their Joker on an open gameweek", async ({ request }) => {
    // A self-service group's owner can turn the rule on.
    const created = await (
      await request.post("/api/group/create", {
        data: { groupName: uniqueName(), adminName: "Owner", games: ["predictions"] },
      })
    ).json();
    const me = await (await request.get("/api/group/me")).json();

    const on = await request.put("/api/group/rules", { data: { lawro: { jokerEnabled: true } } });
    expect(on.ok()).toBeTruthy();
    expect((await on.json()).rules.lawro.jokerEnabled).toBe(true);

    // The open gameweek (GW2 in the seed) is still editable, so a pick there can
    // carry the Joker.
    const matches = await (await request.get("/api/matches")).json();
    const openMatch = matches.find((m: any) => m.gameweek === 2 && m.status === "not_started");
    expect(openMatch).toBeTruthy();

    const made = await request.post("/api/predictions", {
      data: { userId: me.user.id, matchId: openMatch.id, homeScore: 2, awayScore: 0 },
    });
    expect(made.ok(), `prediction create failed: ${made.status()}`).toBeTruthy();
    const pred = await made.json();

    // Set it as the Joker.
    const setOn = await request.put(`/api/predictions/${pred.id}/joker`, { data: { joker: true } });
    expect(setOn.ok(), `joker set failed: ${setOn.status()}`).toBeTruthy();
    let preds = await (await request.get("/api/predictions")).json();
    expect(preds.find((p: any) => p.id === pred.id)?.isJoker).toBe(true);

    // Take it off again.
    const setOff = await request.put(`/api/predictions/${pred.id}/joker`, { data: { joker: false } });
    expect(setOff.ok()).toBeTruthy();
    preds = await (await request.get("/api/predictions")).json();
    expect(preds.find((p: any) => p.id === pred.id)?.isJoker).toBe(false);
  });

  test("the Joker flag requires a boolean", async ({ request }) => {
    const me = await loginViaApi(request, CODES.alex);
    const preds = await (await request.get("/api/predictions")).json();
    const mine = preds.find((p: any) => p.userId === me.user.id);
    const res = await request.put(`/api/predictions/${mine.id}/joker`, { data: { joker: "yes" } });
    expect(res.status()).toBe(400);
  });
});
