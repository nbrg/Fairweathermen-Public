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
