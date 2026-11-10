import crypto from "crypto";
import { test, expect } from "@playwright/test";
import { CODES, loginViaApi } from "./helpers";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

// No API response should ever hand a client a login code or a password. Login
// codes are a person's private sign-in credential; the one exception is the
// admin roster screen, which shows codes only to a request carrying the admin
// key. These tests lock that down so a future change can't quietly leak them.

const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "test-admin-key";

// Recursively collect every object key in a response body.
function allKeys(value: any, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") {
    for (const k of Object.keys(value)) {
      out.add(k);
      allKeys(value[k], out);
    }
  }
  return out;
}

test.describe("no credential leaks", () => {
  test("the leaderboard never includes a code or password", async ({ request }) => {
    await loginViaApi(request, CODES.alex);
    const res = await request.get("/api/leaderboard");
    const keys = allKeys(await res.json());
    expect(keys.has("loginCode")).toBe(false);
    expect(keys.has("login_code")).toBe(false);
    expect(keys.has("password")).toBe(false);
  });

  test("the current LMS competition never includes a code or password", async ({ request }) => {
    await loginViaApi(request, CODES.alex);
    const res = await request.get("/api/lms/current-competition");
    const keys = allKeys(await res.json());
    expect(keys.has("loginCode")).toBe(false);
    expect(keys.has("password")).toBe(false);
  });

  test("the session endpoint never includes a code or password", async ({ request }) => {
    const me = await loginViaApi(request, CODES.alex);
    const keys = allKeys(me);
    expect(keys.has("loginCode")).toBe(false);
    expect(keys.has("password")).toBe(false);
  });

  test("the admin roster is unreachable without the admin key", async ({ request }) => {
    const res = await request.get("/api/admin/groups-players");
    expect(res.status()).toBe(401);
  });

  test("the admin roster shows codes only with the admin key", async ({ request }) => {
    const res = await request.get("/api/admin/groups-players", {
      headers: { "x-api-key": ADMIN_KEY },
    });
    expect(res.ok()).toBeTruthy();
    const keys = allKeys(await res.json());
    // Codes are intentionally visible to the admin, but passwords never are.
    expect(keys.has("loginCode")).toBe(true);
    expect(keys.has("password")).toBe(false);
  });
});

// Anyone can make their own group and get signed in, so "signed in" is not
// enough to touch shared data. Real match scores drive LMS eliminations and
// Lawro points for every group, so only the admin key may change them.
test.describe("shared data is admin-only", () => {
  // A stranger who has just created their own group.
  async function stranger(request: any) {
    const res = await request.post("/api/group/create", {
      data: {
        groupName: `Strangers ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        adminName: "Mallory",
        games: ["lms", "predictions"],
      },
    });
    expect(res.ok(), `create failed: ${res.status()}`).toBeTruthy();
  }

  test("a signed-in player can't edit match scores, matches or teams", async ({ request }) => {
    await loginViaApi(request, CODES.alex);
    const writes = [
      request.post("/api/matches/1/score", { data: { homeScore: 9, awayScore: 0 } }),
      request.patch("/api/matches/1", { data: { homeScore: 9, status: "finished" } }),
      request.post("/api/matches", { data: {} }),
      request.post("/api/teams", { data: { name: "Fake FC", shortName: "FAK" } }),
      request.post("/api/football-data/sync-fixtures", { data: { startGameweek: 1, endGameweek: 1 } }),
    ];
    for (const res of await Promise.all(writes)) expect(res.status()).toBe(401);
  });

  test("the admin key can still edit a match score", async ({ request }) => {
    const matches = await (
      await request.get("/api/matches", { headers: { "x-api-key": ADMIN_KEY } })
    ).json();
    // The GW2 fixture, left not started so nothing downstream changes.
    const m = matches.find((x: any) => x.gameweek === 2);
    const res = await request.post(`/api/matches/${m.id}/score`, {
      headers: { "x-api-key": ADMIN_KEY },
      data: { homeScore: 0, awayScore: 0, status: "not_started" },
    });
    expect(res.ok(), `admin score edit failed: ${res.status()}`).toBeTruthy();
  });

  test("the activity log needs the admin key", async ({ request }) => {
    expect((await request.get("/api/admin/activity-logs")).status()).toBe(401);
    const ok = await request.get("/api/admin/activity-logs", {
      headers: { "x-api-key": ADMIN_KEY },
    });
    expect(ok.ok()).toBeTruthy();
  });
});

// Other players' Lawro scorelines stay hidden until the deadline on every
// endpoint, not just the main grid.
test.describe("lawro picks stay hidden", () => {
  test("a groupmate's per-player predictions are redacted before the deadline", async ({ request }) => {
    await loginViaApi(request, CODES.alex);
    const users = await (await request.get("/api/users")).json();
    const blake = users.find((u: any) => u.username === "Blake");
    const res = await request.get(`/api/users/${blake.id}/predictions`);
    expect(res.ok()).toBeTruthy();
    const preds = await res.json();
    const gw2 = preds.find((p: any) => p.match?.gameweek === 2);
    expect(gw2?.hidden).toBe(true);
    expect(gw2?.homeScore).toBeUndefined();
    // GW1 has kicked off, so that one is revealed.
    const gw1 = preds.find((p: any) => p.match?.gameweek === 1);
    expect(gw1?.homeScore).toBe(1);
  });
});

// Changing the cookie-signing key must never sign anyone out: a cookie signed
// with an older key (the admin key used to be the fallback) still works and is
// quietly re-signed with the current key. A cookie signed with any other key
// is ignored.
test.describe("cookie key changes keep people signed in", () => {
  const signWith = (value: string, key: string) =>
    `${value}.${crypto.createHmac("sha256", key).update(value).digest("base64url")}`;

  async function sessionValue(request: any): Promise<string> {
    await loginViaApi(request, CODES.alex);
    const state = await request.storageState();
    const cookie = state.cookies.find((c: any) => c.name === "fwm_user");
    return decodeURIComponent(cookie.value).split(".")[0];
  }

  test("a cookie signed with the old admin-key fallback still works and is re-signed", async ({ playwright, baseURL }) => {
    const first = await playwright.request.newContext({ baseURL });
    const value = await sessionValue(first);
    await first.dispose();

    const old = signWith(value, ADMIN_KEY);
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { cookie: `fwm_user=${encodeURIComponent(old)}` },
    });
    const res = await ctx.get("/api/group/me");
    expect(res.ok()).toBeTruthy();
    const me = await res.json();
    expect(me.user.username).toBe("Alex");
    const setCookie = res.headers()["set-cookie"] ?? "";
    expect(setCookie).toContain("fwm_user=");
    expect(setCookie).not.toContain(encodeURIComponent(old));
    await ctx.dispose();
  });

  test("a cookie signed with any other key is ignored", async ({ playwright, baseURL }) => {
    const first = await playwright.request.newContext({ baseURL });
    const value = await sessionValue(first);
    await first.dispose();

    const forged = signWith(value, "not-the-key");
    const ctx = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { cookie: `fwm_user=${encodeURIComponent(forged)}` },
    });
    expect((await ctx.get("/api/leaderboard")).status()).toBe(401);
    await ctx.dispose();
  });
});

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/fairweathermen_test";
async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    return (await pool.query(text, params)).rows as T[];
  } finally {
    await pool.end();
  }
}

// A player has at most one Lawro pick per match. A manual fix-up run twice
// once doubled a player's gameweek points, so the database itself refuses it.
test.describe("one lawro pick per player per match", () => {
  test("the database refuses a second pick for the same match", async () => {
    const [existing] = await sql<{ user_id: number; match_id: number }>(
      "SELECT user_id, match_id FROM predictions ORDER BY id LIMIT 1",
    );
    let error: any = null;
    try {
      await sql("INSERT INTO predictions (user_id, match_id, home_score, away_score) VALUES ($1, $2, 9, 9)", [
        existing.user_id,
        existing.match_id,
      ]);
    } catch (e) {
      error = e;
    }
    expect(error?.code, "duplicate pick was accepted").toBe("23505");
    const rows = await sql("SELECT id FROM predictions WHERE user_id = $1 AND match_id = $2", [
      existing.user_id,
      existing.match_id,
    ]);
    expect(rows).toHaveLength(1);
  });
});

// A new visitor's location comes from the offline geoip-lite database, never a
// third-party lookup in the request path (slow first loads, and it sent the
// visitor's IP to ipinfo.io).
test.describe("visitor locations are looked up offline", () => {
  test("a new visitor's location matches the offline database", async ({ request }) => {
    const ip = "81.2.69.142"; // geoip-lite's own UK test address
    const { default: geoip } = await import("geoip-lite");
    const geo = geoip.lookup(ip)!;
    const res = await request.get("/", { headers: { "x-forwarded-for": ip, "user-agent": `offline-geo-${Date.now()}` } });
    expect(res.ok()).toBeTruthy();
    const stats = await (await request.get("/api/admin/visitors", { headers: { "x-api-key": ADMIN_KEY } })).json();
    const row = stats.rawData.find((v: any) => v.ipAddress === ip);
    expect(row?.location).toBe(`${geo.city}, ${geo.region}, ${geo.country}`);
  });
});
