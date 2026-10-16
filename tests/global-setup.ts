import { execSync } from "node:child_process";
import pg from "pg";

// Runs once before the suite:
//   1. reset the test database to an empty schema,
//   2. apply the Drizzle schema to it,
//   3. seed the deterministic dataset.
// Resetting first means `drizzle-kit push` always builds from scratch, so it
// never stops to ask about dropping/truncating existing data.
export default async function globalSetup() {
  const DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/fairweathermen_test";

  const env = { ...process.env, DATABASE_URL, DATABASE_DRIVER: "pg" };

  console.log("[global-setup] resetting test schema…");
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await pool.end();
  }

  console.log("[global-setup] applying schema (drizzle-kit push)…");
  execSync("npx drizzle-kit push --force", { stdio: "inherit", env });

  console.log("[global-setup] seeding test data…");
  execSync("npx tsx scripts/seedTestData.ts", { stdio: "inherit", env });
}
