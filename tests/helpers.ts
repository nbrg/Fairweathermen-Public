import { type Page, type APIRequestContext, expect } from "@playwright/test";

// Login codes created by scripts/seedTestData.ts.
export const CODES = {
  alex: "demo-alex",
  blake: "demo-blake",
  casey: "demo-casey",
} as const;

// Log in through the landing-page form and wait for the app to render.
export async function loginViaUi(page: Page, code: string) {
  await page.goto("/");
  await page.getByPlaceholder("Your code").fill(code);
  await page.getByRole("button", { name: "Enter" }).click();
  // The landing form is gone once the session cookie is set and the app loads.
  await expect(page.getByPlaceholder("Your code")).toBeHidden();
}

// Log in over the API; the returned context keeps the session cookie for
// subsequent requests in the same test.
export async function loginViaApi(request: APIRequestContext, code: string) {
  const res = await request.post("/api/group/login", { data: { code } });
  expect(res.ok(), `login failed for ${code}: ${res.status()}`).toBeTruthy();
  return res.json();
}
