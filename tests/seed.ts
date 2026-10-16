import { execSync } from "node:child_process";

// Reset the database to the deterministic seed. Each spec file calls this in a
// `beforeAll`, so every file — and every browser project — starts from the same
// known state, regardless of what earlier tests wrote. It shells out to the
// same seed script used for local development, which truncates every table and
// re-inserts the Demo League fixture.
export function reseed(): void {
  execSync("npx tsx scripts/seedTestData.ts", {
    cwd: process.cwd(),
    stdio: "ignore",
    env: {
      ...process.env,
      DATABASE_DRIVER: "pg",
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgres://postgres:postgres@localhost:5432/fairweathermen_test",
    },
  });
}
