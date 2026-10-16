import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { drizzle as neonDrizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import pg from "pg";
import { drizzle as pgDrizzle } from "drizzle-orm/node-postgres";
import ws from "ws";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Copy .env.example to .env and point it at a Postgres database.",
  );
}

const connectionString = process.env.DATABASE_URL;

// Two ways to talk to Postgres:
//
//  - Neon serverless (production) speaks over a WebSocket, which is what lets
//    it run on serverless/edge platforms. Used for neon.tech URLs, or set
//    DATABASE_DRIVER=neon to force it.
//  - A plain node-postgres pool for any ordinary Postgres host (local Docker,
//    a CI service container, Supabase, RDS, …) — what local dev and the test
//    suite use. Set DATABASE_DRIVER=pg to force it.
//
// Both drivers expose the same Drizzle query API and a pool with a `.query`
// method, so nothing downstream cares which one is live.
const useNeon =
  process.env.DATABASE_DRIVER === "neon" ||
  (process.env.DATABASE_DRIVER !== "pg" && /neon\.(tech|build)|\.neon\./i.test(connectionString));

let pool: NeonPool;
let db: NeonDatabase<typeof schema>;

if (useNeon) {
  neonConfig.webSocketConstructor = ws;
  pool = new NeonPool({ connectionString });
  db = neonDrizzle({ client: pool, schema });
} else {
  const pgPool = new pg.Pool({ connectionString });
  // node-postgres and neon-serverless expose the same runtime surface we use
  // (pool.query, and an identical Drizzle query builder); the cast just lets
  // the rest of the app keep one static type regardless of which is live.
  pool = pgPool as unknown as NeonPool;
  db = pgDrizzle(pgPool, { schema }) as unknown as NeonDatabase<typeof schema>;
}

export { pool, db };

// The Neon serverless driver talks to the DB over a WebSocket. When a pooled
// connection has been idle long enough for Neon to close the socket, the *next*
// query on it can fail with a transient connection error (e.g. "Connection
// terminated", "socket hang up", ECONNRESET) before the pool transparently
// reconnects. That's why an action can 500 once and then succeed on retry.
// withDbRetry re-runs a DB operation a couple of times when it hits one of
// these transient errors, so a stale socket doesn't surface as a user error.
// Only use it for idempotent operations (reads, or upserts keyed by identity).
const TRANSIENT_DB_ERROR_PATTERNS = [
  "connection terminated",
  "connection closed",
  "socket hang up",
  "econnreset",
  "connection reset",
  "terminating connection",
  "server closed the connection",
  "fetch failed",
];

function isTransientDbError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return TRANSIENT_DB_ERROR_PATTERNS.some((p) => msg.includes(p));
}

export async function withDbRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || attempt === attempts - 1) throw err;
      console.warn(
        `[db] transient error, retrying (attempt ${attempt + 1}/${attempts - 1}):`,
        err instanceof Error ? err.message : err,
      );
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
  throw lastErr;
}
