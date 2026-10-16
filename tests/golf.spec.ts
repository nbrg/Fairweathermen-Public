import { test, expect } from "@playwright/test";
import { CODES, loginViaApi, loginViaUi } from "./helpers";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// Golf is a stableford scorecard tracker. The demo group has it enabled, so the
// tab shows and the page opens on the leaderboard with a course picker up top.
// The course catalogue and player roster live in the page itself, so it renders
// without any database rows.
test.describe("golf", () => {
  test("the golf tab is in the nav", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await expect(page.getByRole("link", { name: "Golf" })).toBeVisible();
  });

  test("the page opens on the stableford leaderboard", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/golf");
    // A course picker (native <select>) and the default scoring view.
    await expect(page.locator("select").first()).toBeVisible();
    await expect(page.getByText(/stableford/i).first()).toBeVisible();
  });

  test("the Day 1 view shows a hole-by-hole card with par", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/golf");
    await page.getByRole("button", { name: "Day 1" }).click();
    // The scorecard has a "Par" column header.
    await expect(page.getByText("Par", { exact: true }).first()).toBeVisible();
  });

  test("switching the course keeps the page working", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/golf");
    const select = page.locator("select").first();
    await select.selectOption("velvet-jacket-oxfordshire");
    await expect(select).toHaveValue("velvet-jacket-oxfordshire");
    // Still a working page, no crash to a 404.
    await expect(page.getByText(/404/)).toHaveCount(0);
  });
});

// The scorecard persists per-hole scores through the API. These cover the
// create-tournament / save-score / read-back round trip and the upsert rule.
test.describe("golf scores API", () => {
  // These endpoints are group-scoped, so sign in first (as a Demo League member).
  async function newTournament(request: any) {
    await loginViaApi(request, CODES.alex);
    const res = await request.post("/api/golf/tournaments", {
      data: { name: "Test Open", courseId: "velvet-jacket-oxfordshire" },
    });
    expect(res.status()).toBe(201);
    return res.json();
  }

  test("a tournament can be created and read back", async ({ request }) => {
    const t = await newTournament(request);
    expect(t.name).toBe("Test Open");
    const list = await (await request.get("/api/golf/tournaments")).json();
    expect(list.some((x: any) => x.id === t.id)).toBeTruthy();
  });

  test("a hole score saves and reads back", async ({ request }) => {
    const t = await newTournament(request);
    const save = await request.post("/api/golf/scores", {
      data: { tournamentId: t.id, playerName: "Alex", hole: 1, day: 1, score: 4 },
    });
    expect(save.status()).toBe(201);
    const scores = await (await request.get(`/api/golf/tournaments/${t.id}/scores`)).json();
    const mine = scores.find((s: any) => s.playerName === "Alex" && s.hole === 1 && s.day === 1);
    expect(mine?.score).toBe(4);
  });

  test("saving the same hole again updates rather than duplicates", async ({ request }) => {
    const t = await newTournament(request);
    const body = { tournamentId: t.id, playerName: "Alex", hole: 2, day: 1, score: 5 };
    await request.post("/api/golf/scores", { data: body });
    await request.post("/api/golf/scores", { data: { ...body, score: 3 } });
    const scores = await (await request.get(`/api/golf/tournaments/${t.id}/scores`)).json();
    const forHole = scores.filter((s: any) => s.hole === 2 && s.day === 1 && s.playerName === "Alex");
    expect(forHole).toHaveLength(1);
    expect(forHole[0].score).toBe(3);
  });
});

// The scorecard has Day 1 / Day 2 / Leaderboard / P/L views; each should render
// for the default tournament without crashing.
test.describe("golf views", () => {
  test("the P/L view renders", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/golf");
    await page.getByRole("button", { name: "P/L" }).click();
    await expect(page.getByText(/404/)).toHaveCount(0);
    await expect(page.locator("select").first()).toBeVisible();
  });

  test("the Day 2 view renders a hole card", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.goto("/golf");
    await page.getByRole("button", { name: "Day 2" }).click();
    await expect(page.getByText("Par", { exact: true }).first()).toBeVisible();
  });
});
