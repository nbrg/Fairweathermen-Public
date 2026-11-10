import { test, expect, type APIRequestContext } from "@playwright/test";
import { execSync } from "node:child_process";
import { reseed } from "./seed";

// Adding a player from /admin/players (and joining through an invite link).
// Regression cases: a player added for one game only was dropped into an LMS
// competition that was two weeks in, and what /admin/players said he could see
// didn't match what he saw when he logged in.

const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "test-admin-key";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/fairweathermen_test";
const admin = { "x-api-key": ADMIN_KEY };

async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    return (await pool.query(text, params)).rows as T[];
  } finally {
    await pool.end();
  }
}

type RosterPlayer = {
  id: number;
  username: string;
  loginCode: string | null;
  enabledGames: string[] | null;
  inLms: boolean;
  lmsNext: boolean;
};
type RosterGroup = { id: number; slug: string; name: string; players: RosterPlayer[] };

async function roster(request: APIRequestContext, slug = "demo"): Promise<RosterGroup> {
  const res = await request.get("/api/admin/groups-players", { headers: admin });
  expect(res.ok()).toBeTruthy();
  const groups = (await res.json()) as RosterGroup[];
  return groups.find((g) => g.slug === slug)!;
}

async function addPlayer(
  request: APIRequestContext,
  username: string,
  extra: Record<string, unknown> = {},
  slug = "demo",
) {
  const group = await roster(request, slug);
  return request.post("/api/admin/players", {
    headers: admin,
    data: { groupId: group.id, username, ...extra },
  });
}

// Open the seeded Demo Cup to new players: start it at GW2, which is a week out.
async function openDemoCup() {
  await sql("UPDATE lms_competitions SET start_gameweek = 2 WHERE name = 'Demo Cup'");
}

test.describe("adding a player", () => {
  test.beforeEach(reseed);

  test("someone added once the LMS competition is under way isn't put into it", async ({ request }) => {
    // The seeded Demo Cup started at GW1, which has been played.
    const res = await addPlayer(request, "Jamie");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.message).toContain("next");
    const jamie = (await roster(request)).players.find((p) => p.username === "Jamie")!;
    expect(jamie.inLms).toBe(false);
    expect(jamie.lmsNext).toBe(true);
  });

  test("…and is in the next competition when it opens", async ({ request }) => {
    expect((await addPlayer(request, "Jamie")).ok()).toBeTruthy();
    // Demo Cup finishes; the sweep opens the next one at GW2 with its roster.
    await sql("UPDATE lms_competitions SET status = 'completed' WHERE name = 'Demo Cup'");
    execSync(
      `npx tsx -e "import('./server/lmsAutoStart').then((m) => m.ensureLmsCompetitionForGroup(1)).then((c) => { console.log(c ? 'started' : 'none'); process.exit(0); })"`,
      { env: { ...process.env, DATABASE_DRIVER: "pg", DATABASE_URL }, stdio: "pipe" },
    );
    const group = await roster(request);
    const names = group.players.filter((p) => p.inLms).map((p) => p.username).sort();
    expect(names).toEqual(["Alex", "Blake", "Casey", "Jamie"]);
    expect(group.players.find((p) => p.username === "Jamie")!.lmsNext).toBe(false);
  });

  test("someone added before the first deadline joins the competition straight away", async ({ request }) => {
    await openDemoCup();
    const res = await addPlayer(request, "Kim");
    expect(res.ok()).toBeTruthy();
    const kim = (await roster(request)).players.find((p) => p.username === "Kim")!;
    expect(kim.inLms).toBe(true);
    expect(kim.lmsNext).toBe(false);
  });

  test("the games picked when adding are exactly what the player sees", async ({ request, page }) => {
    await openDemoCup();
    const res = await addPlayer(request, "Jamie", { enabledGames: ["predictions"] });
    expect(res.ok()).toBeTruthy();
    const { player } = await res.json();
    const jamie = (await roster(request)).players.find((p) => p.username === "Jamie")!;
    expect(jamie.enabledGames).toEqual(["predictions"]);
    // LMS wasn't picked, so he isn't in it, even though it's still open.
    expect(jamie.inLms).toBe(false);
    expect(jamie.lmsNext).toBe(false);

    const login = await page.request.post("/api/group/login", { data: { code: player.loginCode } });
    expect(login.ok()).toBeTruthy();
    expect((await login.json()).enabledGames).toEqual(["predictions"]);
    await page.goto("/");
    await expect(page).toHaveURL(/\/$|\/lawro$/);
    await expect(page.getByRole("link", { name: "Last Man Standing" })).toHaveCount(0);
  });

  test("hiding LMS takes them out of a competition that hasn't started; showing it puts them back", async ({ request }) => {
    await openDemoCup();
    const blake = (await roster(request)).players.find((p) => p.username === "Blake")!;
    expect(blake.inLms).toBe(true);
    let res = await request.patch(`/api/admin/players/${blake.id}/games`, {
      headers: admin,
      data: { enabledGames: ["predictions"] },
    });
    expect(res.ok()).toBeTruthy();
    let after = (await roster(request)).players.find((p) => p.id === blake.id)!;
    expect(after.inLms).toBe(false);

    res = await request.patch(`/api/admin/players/${blake.id}/games`, {
      headers: admin,
      data: { enabledGames: ["predictions", "lms"] },
    });
    expect(res.ok()).toBeTruthy();
    after = (await roster(request)).players.find((p) => p.id === blake.id)!;
    expect(after.inLms).toBe(true);
  });

  test("hiding LMS once it's under way leaves them in it and says so", async ({ request }) => {
    const blake = (await roster(request)).players.find((p) => p.username === "Blake")!;
    const res = await request.patch(`/api/admin/players/${blake.id}/games`, {
      headers: admin,
      data: { enabledGames: ["predictions"] },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).message).toContain("still in Demo Cup");
    expect((await roster(request)).players.find((p) => p.id === blake.id)!.inLms).toBe(true);
  });

  test("a name that's already in the group is refused, whatever its case", async ({ request }) => {
    const before = (await roster(request)).players.length;
    const res = await addPlayer(request, "blake");
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toContain("already");
    expect((await roster(request)).players.length).toBe(before);
  });

  test("joining by invite link after the first deadline waits for the next competition", async ({ request, playwright, baseURL }) => {
    // A self-service group: its competition opens at GW2, still open.
    const owner = await playwright.request.newContext({ baseURL });
    const created = await owner.post("/api/group/create", {
      data: { groupName: "Late Joiners", adminName: "Ola", games: ["lms"] },
    });
    expect(created.ok()).toBeTruthy();
    const [{ id: groupId, invite_token: token }] = await sql<{ id: number; invite_token: string }>(
      "SELECT id, invite_token FROM groups WHERE name = 'Late Joiners'",
    );
    // Pretend that competition has started (GW1 has been played).
    await sql("UPDATE lms_competitions SET start_gameweek = 1 WHERE group_id = $1", [groupId]);

    const joiner = await playwright.request.newContext({ baseURL });
    const joined = await joiner.post(`/api/group/join/${token}`, { data: { name: "Pia" } });
    expect(joined.ok()).toBeTruthy();
    const players = await sql<{ username: string }>(
      `SELECT u.username FROM lms_participants p
         JOIN users u ON u.id = p.user_id
         JOIN lms_competitions c ON c.id = p.competition_id
        WHERE c.group_id = $1`,
      [groupId],
    );
    expect(players.map((p) => p.username)).toEqual(["Ola"]);
    await owner.dispose();
    await joiner.dispose();
  });

  test("the add form picks games, says where LMS stands and hands over the code", async ({ page }) => {
    await page.goto("/admin/players");
    await page.getByPlaceholder("paste key…").fill(ADMIN_KEY);
    const form = page.getByTestId("add-player-1");
    await form.getByPlaceholder("New player name…").fill("Jamie");
    // Demo Cup started in GW1, so a new LMS player waits for the next one.
    await expect(form.getByText("Demo Cup is under way")).toBeVisible();
    await form.getByRole("button", { name: "LMS" }).click();
    await expect(form.getByText("Demo Cup is under way")).toHaveCount(0);
    // A name already in the group can't be added.
    await form.getByPlaceholder("New player name…").fill("casey");
    await expect(form.getByText("Casey is already in Demo League.")).toBeVisible();
    await expect(form.getByRole("button", { name: "Add" })).toBeDisabled();
    await form.getByPlaceholder("New player name…").fill("Jamie");
    await form.getByRole("button", { name: "Add" }).click();

    const added = page.getByTestId("added-player");
    await expect(added).toContainText('Added "Jamie" to Demo League.');
    await expect(added.getByRole("button", { name: /Copy code/ })).toBeVisible();
    await expect(added.getByRole("button", { name: "Copy WhatsApp message" })).toBeVisible();
    // Jamie's row: only Lawro is on, and he has no LMS badge.
    const jamie = (await roster(page.request)).players.find((p) => p.username === "Jamie")!;
    await expect(page.getByTestId(`game-badge-${jamie.id}-predictions`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId(`game-badge-${jamie.id}-lms`)).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId(`lms-badge-${jamie.id}`)).toHaveCount(0);
  });

  test("the WhatsApp welcome message explains the login and the player's own games", async ({ page, context, browserName }) => {
    test.skip(browserName !== "chromium", "reading the clipboard needs Chromium's permission");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openDemoCup();
    // Kim plays LMS and Lawro only; Demo Cup hasn't started, so she's in it.
    const res = await addPlayer(page.request, "Kim", { enabledGames: ["lms", "predictions"] });
    const { player } = await res.json();
    await page.goto("/admin/players");
    await page.getByPlaceholder("paste key…").fill(ADMIN_KEY);
    await page.getByTestId(`copy-welcome-${player.id}`).click();
    await expect(page.getByText("Copied a WhatsApp welcome message for Kim.")).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain("Hi *Kim*! You've been added to *Demo League*");
    expect(text).toContain(`*Your login code:* ${player.loginCode}`);
    expect(text).toContain("🏆 *Last Man Standing*");
    expect(text).toContain("*£5 buy-in*");
    expect(text).toContain("You're in *Demo Cup*, which starts in gameweek 2.");
    expect(text).toContain("*3 pts* for the exact score, *1 pt* for the right result.");
    expect(text).toContain("1. Open https://fairweathermen.com/");
    expect(text).toContain("You'll only need to enter it once.");
  });
});
