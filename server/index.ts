import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { visitorTrackingMiddleware } from "./visitorTracker";

// Ignore SIGHUP to prevent server from terminating when terminal closes
process.on('SIGHUP', () => { /* ignore */ });

const app = express();

// Trust proxy headers so req.ip is the real client IP when running behind a
// reverse proxy / load balancer (nginx, a platform edge, etc.).
app.set('trust proxy', true);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Never let the browser or any intermediary proxy/CDN cache API responses —
// they're dynamic and often credentialed, and a stale cache here was making
// live scores/minutes lag by up to a minute.
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Defence in depth: strip secrets out of every API response, whatever the
// handler happens to put there. A login code is a person's private sign-in
// credential and a password hash is a secret, so neither should ever reach a
// client. Passwords are removed for everyone; login codes are removed for
// everyone *except* an admin-authenticated request (the admin roster screen
// deliberately shows codes so the owner can hand them out, and those requests
// carry the admin key). This runs regardless of what any individual endpoint
// returns, so a new query that accidentally selects a whole user row can't
// leak these fields.
app.use("/api", (req, res, next) => {
  const adminAuthed =
    !!process.env.ADMIN_API_KEY && req.headers["x-api-key"] === process.env.ADMIN_API_KEY;
  const stripKeys = adminAuthed
    ? new Set(["password"])
    : new Set(["password", "loginCode", "login_code"]);
  const scrub = (value: any, seen = new Set<any>()): any => {
    if (Array.isArray(value)) return value.map((v) => scrub(v, seen));
    if (value && typeof value === "object") {
      if (seen.has(value)) return value;
      seen.add(value);
      for (const key of Object.keys(value)) {
        if (stripKeys.has(key)) delete value[key];
        else value[key] = scrub(value[key], seen);
      }
    }
    return value;
  };
  const originalJson = res.json.bind(res);
  res.json = (body: any) => originalJson(scrub(body));
  next();
});

// Add visitor tracking middleware
app.use(visitorTrackingMiddleware);

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  try {
    // Ensure every user has a private login code (the per-user access code
    // entered on the landing page). Idempotent — only touches rows missing a
    // code.
    const { backfillLoginCodes, unifyLoginCodesAcrossGroups } = await import('./loginCodes');
    await backfillLoginCodes();
    // Reconcile any person whose group rows drifted onto different codes so they
    // share one code (their Fairweathermen/home code) again — needed for the
    // group switcher. Idempotent; run after the backfill.
    await unifyLoginCodesAcrossGroups();

    // One-time data migration: convert legacy 'win'/'lose_draw' to 'w'/'l'.
    // Idempotent — runs on every boot but updates 0 rows once complete.
    try {
      const { pool } = await import('./db');
      const r1 = await pool.query("UPDATE lms_selections SET result = 'w' WHERE result = 'win'");
      const r2 = await pool.query("UPDATE lms_selections SET result = 'l' WHERE result = 'lose_draw'");
      if ((r1.rowCount || 0) + (r2.rowCount || 0) > 0) {
        console.log(`[Migration] Converted ${r1.rowCount} 'win'→'w', ${r2.rowCount} 'lose_draw'→'l' in lms_selections`);
      }
    } catch (err) {
      console.error('[Migration] Failed to migrate lms_selections result codes:', err);
    }

    // Self-healing cleanup: clear bogus match scores (>20) and reset status
    // appropriately. Idempotent — no-op once clean. Past matches are then
    // backfilled from football-data.org by the live sync window or manual sync.
    try {
      const { pool } = await import('./db');
      const r = await pool.query(`
        UPDATE matches
        SET home_score = NULL,
            away_score = NULL,
            status = CASE WHEN match_time::timestamp > NOW() THEN 'not_started' ELSE 'finished' END
        WHERE home_score > 20 OR away_score > 20
      `);
      if ((r.rowCount || 0) > 0) {
        console.log(`[Migration] Cleared ${r.rowCount} matches with bogus scores`);
      }
    } catch (err) {
      console.error('[Migration] Failed to clean bogus match scores:', err);
    }

    // NOTE: a previous boot-time cleanup deleted every match with id >= 2636 to
    // remove a one-off junk import. That junk is long gone, and the rule had
    // become an active landmine: newly imported seasons (e.g. the 2026/27 PL
    // fixtures) get ids above 2635 and were being wiped on every restart, which
    // collapsed season-scoping back to the old season and auto-randomised LMS
    // picks. The cleanup has been removed — never reinstate an id-range delete
    // of matches; scope deletions by season instead (see deleteMatchesBySeason).

    // NOTE: The previous fallback to generateCompleteFixtures() has been
    // permanently disabled. That helper inserts 380 *fictional* round-robin
    // matches with synthetic dates (base 2025-08-15 + (gw-1)*7d @ 15:00) and
    // performs no existence check, so every restart silently doubled the
    // matches table and corrupted gameweek deadlines. The authentic 2025-26
    // Premier League fixtures are the source of truth — never auto-regenerate.
  } catch (error) {
    console.error("Error initializing database:", error);
  }

  const server = await registerRoutes(app);

  // Start automatic LMS results processor
  const { autoLmsProcessor } = await import('./autoLmsProcessor');
  autoLmsProcessor.start();

  // Start kickoff-reminder push scheduler (no-op unless VAPID keys are set)
  const { reminderProcessor } = await import('./reminderProcessor');
  reminderProcessor.start();

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error("Express error:", err);
    res.status(status).json({ message });
  });

  process.on('uncaughtException', (err) => {
    console.error('[CRASH] Uncaught exception:', err);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRASH] Unhandled rejection at:', promise, 'reason:', reason);
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Use PORT environment variable in production, fallback to 5000 for development
  // this serves both the API and the client
  // Use the PORT environment variable in deployment, or fallback to 5000 for development
  const port = process.env.PORT || 5000;
  server.listen(Number(port), "0.0.0.0", () => {
    log(`serving on port ${port}`);
  });
})();
