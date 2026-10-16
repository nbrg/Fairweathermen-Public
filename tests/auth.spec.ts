import { test, expect } from "@playwright/test";
import { CODES, loginViaUi } from "./helpers";
import { reseed } from "./seed";

// Reset to the seed fixture before this file's tests run.
test.beforeAll(reseed);

test.describe("authentication", () => {
  test("a valid code signs you in", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    // Once in, the landing form is replaced by the app shell.
    await expect(page.getByPlaceholder("Your code")).toBeHidden();
  });

  test("an invalid code is rejected", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("Your code").fill("not-a-real-code");
    await page.getByRole("button", { name: "Enter" }).click();
    await expect(page.getByText(/invalid code/i)).toBeVisible();
    await expect(page.getByPlaceholder("Your code")).toBeVisible();
  });

  test("login API returns the person's group and games", async ({ request }) => {
    const res = await request.post("/api/group/login", { data: { code: CODES.alex } });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.user.username).toBe("Alex");
    expect(body.slug).toBe("demo");
    expect(body.enabledGames).toEqual(expect.arrayContaining(["predictions", "lms"]));
  });

  test("the code is matched case-insensitively", async ({ request }) => {
    const res = await request.post("/api/group/login", {
      data: { code: CODES.blake.toUpperCase() },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.user.username).toBe("Blake");
  });

  test("the session survives a reload", async ({ page }) => {
    await loginViaUi(page, CODES.alex);
    await page.reload();
    // Still signed in — no login form after the reload.
    await expect(page.getByPlaceholder("Your code")).toBeHidden();
  });

  test("logging out clears the session", async ({ request }) => {
    await request.post("/api/group/login", { data: { code: CODES.alex } });
    const out = await request.post("/api/group/logout");
    expect(out.ok()).toBeTruthy();
    // With the cookie cleared, a group-scoped endpoint is unauthorized again.
    const after = await request.get("/api/predictions");
    expect(after.status()).toBe(401);
  });
});
