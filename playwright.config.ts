import { defineConfig, devices } from "@playwright/test";

// The app serves its API and client from one Express server on port 5000.
// Tests run against a throwaway Postgres database (plain node-postgres driver),
// which global-setup creates the schema for; each spec file reseeds it (see
// tests/seed.ts) so the suite is order-independent and safe to re-run across
// every browser project.
const PORT = Number(process.env.PORT ?? 5000);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/fairweathermen_test";

// Env the app boots with during tests. No football-data key, so the live-score
// jobs stay idle and the suite is fully self-contained.
const serverEnv = {
  ...process.env,
  NODE_ENV: "development",
  PORT: String(PORT),
  DATABASE_URL: TEST_DATABASE_URL,
  DATABASE_DRIVER: "pg",
  ADMIN_API_KEY: process.env.ADMIN_API_KEY ?? "test-admin-key",
  GROUP_COOKIE_SECRET: process.env.GROUP_COOKIE_SECRET ?? "test-cookie-secret",
};

// Which browser projects to run. By default the whole matrix runs (Chrome,
// Firefox, Safari/WebKit, and mobile Chrome + Safari). Set PLAYWRIGHT_PROJECTS
// to a comma-separated list to run a subset, e.g. in an environment that can
// only install Chromium: PLAYWRIGHT_PROJECTS="chromium,Mobile Chrome".
const allProjects = [
  { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  { name: "webkit", use: { ...devices["Desktop Safari"] } },
  { name: "Mobile Chrome", use: { ...devices["Pixel 5"] } },
  { name: "Mobile Safari", use: { ...devices["iPhone 13"] } },
];
const wanted = process.env.PLAYWRIGHT_PROJECTS?.split(",").map((s) => s.trim());
const projects = wanted
  ? allProjects.filter((p) => wanted.includes(p.name))
  : allProjects;

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.ts",
  // One shared database, so tests run serially rather than in parallel.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects,
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: serverEnv,
  },
});
