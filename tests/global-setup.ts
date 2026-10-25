import { execSync } from "node:child_process";

// Runs once before the suite, after the web server has started. The web-server
// command (see playwright.config.ts) applies the Drizzle schema with
// `drizzle-kit push` before booting, so the tables already exist here. All this
// does is seed the deterministic dataset; `scripts/seedTestData.ts` truncates
// every table (RESTART IDENTITY CASCADE) before inserting, so the suite is
// order-independent and safe to re-run.
export default async function globalSetup() {
  const DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/fairweathermen_test";

  const env = { ...process.env, DATABASE_URL, DATABASE_DRIVER: "pg" };

  console.log("[global-setup] seeding test data…");
  execSync("npx tsx scripts/seedTestData.ts", { stdio: "inherit", env });
}
