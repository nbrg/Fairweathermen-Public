import { test, expect, type APIRequestContext } from "@playwright/test";
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
    // The code comes back as `code` (the /api scrub middleware strips a
    // `loginCode` key), so this is what create/join expose it under.
    expect(body.code).toBeTruthy();
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
    // A new group's LMS buy-in defaults to £10.
    expect(meBody.rules?.lms?.buyIn).toBe(10);
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

    // Only LMS and Lawro can be chosen, so a request for an unknown game
    // has no valid games and is rejected.
    const unknownOnly = await request.post("/api/group/create", {
      data: { groupName: uniqueName(), adminName: "Pat", games: ["chess"] },
    });
    expect(unknownOnly.status()).toBe(400);
  });

  test("a group name that's already taken is refused, ignoring case and spaces", async ({ request }) => {
    // An existing group from the seed fixture.
    const seeded = await request.post("/api/group/create", {
      data: { groupName: "  demo   LEAGUE ", adminName: "Pat", games: ["lms"] },
    });
    expect(seeded.status()).toBe(409);

    const name = uniqueName();
    const first = await request.post("/api/group/create", {
      data: { groupName: name, adminName: "Pat", games: ["lms"] },
    });
    expect(first.ok()).toBeTruthy();
    const again = await request.post("/api/group/create", {
      data: { groupName: name.toUpperCase(), adminName: "Morgan", games: ["lms"] },
    });
    expect(again.status()).toBe(409);
    expect((await again.json()).error).toMatch(/already taken/);
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
      data: { name: "Morgan" },
    });
    expect(joinRes.ok(), `join failed: ${joinRes.status()}`).toBeTruthy();
    const joinBody = await joinRes.json();
    expect(joinBody.code).toBeTruthy();

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
      data: { groupName: uniqueName(), adminName: "Clamp", games: ["lms", "predictions"] },
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

    // The settings page is the admin's alone: a member can't even read it.
    const rules = await member.get("/api/group/rules");
    expect(rules.status()).toBe(403);

    const put = await member.put("/api/group/rules", { data: { lms: { lives: 5 } } });
    expect(put.status()).toBe(403);
    await member.dispose();
  });
});

test.describe("rules in the app", () => {
  test("turning the Joker on shows its picker on Lawro without a reload", async ({ page }) => {
    await page.goto("/create");
    const res = await page.request.post("/api/group/create", {
      data: { groupName: uniqueName(), adminName: "Owner", games: ["lms", "predictions"] },
    });
    expect(res.ok()).toBeTruthy();
    await page.goto("/group-settings");
    await page.locator("#lawro-joker").click();
    await page.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByText("Rules saved").first()).toBeVisible();

    // Navigate in-app (no reload): the session must already carry the new rule.
    await page.getByRole("link", { name: "Lawro" }).first().click();
    await expect(page.getByText("Your Joker", { exact: true })).toBeVisible();
  });
});

test.describe("rule-change acknowledgement audit", () => {
  const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "test-admin-key";
  type RuleEvent = { type: string; username: string; groupId: number; groupName: string; summary: string; createdAt: string; ipAddress: string; userAgent: string };
  async function acknowledgements(request: APIRequestContext, groupId: number): Promise<RuleEvent[]> {
    const res = await request.get("/api/admin/audit", { headers: { "x-api-key": ADMIN_KEY } });
    expect(res.ok()).toBeTruthy();
    return (await res.json()).filter((r: RuleEvent) => r.type === "rule_change_acknowledged" && r.groupId === groupId);
  }

  for (const dismissal of ["Got it", "Close"]) {
    test(`${dismissal} records the player's acknowledgement and shows it under Rules on /audit`, async ({ request, page }) => {
      const groupName = uniqueName();
      const created = await (await request.post("/api/group/create", {
        data: { groupName, adminName: "Owner", games: ["lms", "predictions"] },
      })).json();
      expect((await page.request.post(`/api/group/join/${created.inviteToken}`, { data: { name: "Reader" } })).ok()).toBeTruthy();
      expect((await request.put("/api/group/rules", {
        data: { lawro: { exactScorePoints: 5 }, lms: { buyIn: 20, allOutPolicy: "co_winners" } },
      })).ok()).toBeTruthy();
      expect((await request.put("/api/group/rules", {
        data: { lawro: { correctResultPoints: 2 } },
      })).ok()).toBeTruthy();
      const me = await (await page.request.get("/api/group/me")).json();
      expect(me.ruleChanges).toHaveLength(2);

      await page.goto("/lawro");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("Owner has changed the rules");
      // Merely opening the pop-up must not log an acknowledgement.
      expect(await acknowledgements(request, me.id)).toEqual([]);
      const saved = page.waitForResponse((r) => r.url().endsWith("/api/group/rule-changes/seen") && r.request().method() === "POST");
      await dialog.getByRole("button", { name: dismissal, exact: true }).click();
      expect((await saved).ok()).toBeTruthy();
      await expect(dialog).toHaveCount(0);

      const rows = await acknowledgements(request, me.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ username: "Reader", groupName });
      expect(rows[0].createdAt).toBeTruthy();
      expect(rows[0].ipAddress).toBeTruthy();
      expect(rows[0].userAgent).toBeTruthy();
      for (const c of me.ruleChanges) expect(rows[0].summary).toContain(`#${c.id}`);
      expect(rows[0].summary).toContain("Lawro — Points for an exact score: 5");
      expect(rows[0].summary).toContain("LMS — Buy-in: £20");
      expect(rows[0].summary).toContain("Lawro — Points for the correct result: 2");
      expect(rows[0].summary).toContain("LMS — If everyone goes out together: The players who went out last split the pot");
      expect(rows[0].summary).not.toContain("the pot rolls over");
      expect(rows[0].summary).not.toContain("→");
      await page.reload();
      expect((await (await page.request.get("/api/group/me")).json()).ruleChanges).toEqual([]);
      await expect(page.getByRole("dialog")).toHaveCount(0);

      await page.evaluate((key) => localStorage.setItem("adminApiKey", key), ADMIN_KEY);
      await page.goto("/admin/audit");
      await page.getByRole("combobox", { name: "Filter by game" }).selectOption("rules");
      await page.getByPlaceholder("Filter by player…").fill("Reader");
      const row = page.getByRole("row").filter({ hasText: rows[0].summary });
      await expect(row).toContainText(groupName);
      await expect(row.getByRole("cell", { name: "Rules", exact: true })).toBeVisible();
      await expect(row).not.toContainText("the pot rolls over");

      // The activity page consumes the audit feed for its pick counts; a rule
      // acknowledgement must not become an "Other: 1 pick" chip.
      await page.goto("/admin/activity");
      await page.getByPlaceholder("Filter by player…").fill("Reader");
      await expect(page.getByTestId("activity-pick-count")).toHaveCount(0);
    });
  }

  test("concurrent retries don't duplicate rows, and newer changes remain pending", async ({ request, page }) => {
    const created = await (await request.post("/api/group/create", {
      data: { groupName: uniqueName(), adminName: "Owner", games: ["predictions"] },
    })).json();
    expect((await page.request.post(`/api/group/join/${created.inviteToken}`, { data: { name: "Reader" } })).ok()).toBeTruthy();
    expect((await request.put("/api/group/rules", { data: { lawro: { exactScorePoints: 5 } } })).ok()).toBeTruthy();
    const opened = await (await page.request.get("/api/group/me")).json();
    const firstId = opened.ruleChanges[0].id;
    // Another edit lands while the player has the first pop-up open.
    expect((await request.put("/api/group/rules", { data: { lawro: { correctResultPoints: 2 } } })).ok()).toBeTruthy();
    const pending = await (await page.request.get("/api/group/me")).json();
    const secondId = pending.ruleChanges[1].id;
    const seen = (upToId: number) => page.request.post("/api/group/rule-changes/seen", { data: { upToId } });
    const replies = await Promise.all([seen(firstId), seen(firstId)]);
    for (const res of replies) expect(res.ok()).toBeTruthy();
    let rows = await acknowledgements(request, opened.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toContain(`change #${firstId}:`);
    expect(rows[0].summary).not.toContain(`#${secondId}`);
    expect((await (await page.request.get("/api/group/me")).json()).ruleChanges.map((c: { id: number }) => c.id)).toEqual([secondId]);

    // Old/zero markers are no-ops; an excessive marker is capped to this group.
    expect((await seen(0)).ok()).toBeTruthy();
    expect((await seen(firstId)).ok()).toBeTruthy();
    expect((await seen(Number.MAX_SAFE_INTEGER)).ok()).toBeTruthy();
    expect((await seen(secondId)).ok()).toBeTruthy();
    rows = await acknowledgements(request, opened.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.summary.includes(`change #${secondId}:`))).toHaveLength(1);
    expect((await request.put("/api/group/rules", { data: { lawro: { exactScorePoints: 6 } } })).ok()).toBeTruthy();
    expect((await (await page.request.get("/api/group/me")).json()).ruleChanges).toHaveLength(1);
  });

  test("own edits, pre-join changes and other groups don't create acknowledgements", async ({ request, page }) => {
    expect((await page.request.post("/api/group/rule-changes/seen", { data: { upToId: 1 } })).status()).toBe(401);
    const created = await (await request.post("/api/group/create", {
      data: { groupName: uniqueName(), adminName: "Owner", games: ["predictions"] },
    })).json();
    expect((await request.put("/api/group/rules", { data: { lawro: { exactScorePoints: 5 } } })).ok()).toBeTruthy();
    const owner = await (await request.get("/api/group/me")).json();
    expect((await request.post("/api/group/rule-changes/seen", { data: { upToId: Number.MAX_SAFE_INTEGER } })).ok()).toBeTruthy();
    expect(await acknowledgements(request, owner.id)).toEqual([]);

    // Joiners start at the current marker and haven't seen a rule-change pop-up.
    expect((await page.request.post(`/api/group/join/${created.inviteToken}`, { data: { name: "Newcomer" } })).ok()).toBeTruthy();
    expect((await (await page.request.get("/api/group/me")).json()).ruleChanges).toEqual([]);
    for (const upToId of [-1, 1.5, "bad"]) {
      expect((await page.request.post("/api/group/rule-changes/seen", { data: { upToId } })).status()).toBe(400);
    }
    await request.post("/api/group/create", {
      data: { groupName: uniqueName(), adminName: "Other Owner", games: ["predictions"] },
    });
    expect((await request.put("/api/group/rules", { data: { lawro: { exactScorePoints: 7 } } })).ok()).toBeTruthy();
    expect((await page.request.post("/api/group/rule-changes/seen", { data: { upToId: Number.MAX_SAFE_INTEGER } })).ok()).toBeTruthy();
    expect(await acknowledgements(request, owner.id)).toEqual([]);
  });
});
