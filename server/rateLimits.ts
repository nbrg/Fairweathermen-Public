import { rateLimit } from "express-rate-limit";

// Rate limiting for the two credential-checking surfaces. Login is a single
// factor (a private code) and the admin surface is guarded by a single API
// key, so without throttling either could be brute-forced by anyone who finds
// the deployment. These limiters cap how fast an IP can *fail* against them.
//
// Both use `skipSuccessfulRequests`, so a legitimate user (or the owner with
// the right admin key) is never throttled by their own successful requests —
// only failed attempts count toward the limit. Keyed by `req.ip`, which is the
// real client IP because the app sets `trust proxy` (see server/index.ts). We
// disable express-rate-limit's trust-proxy validation warning because that
// permissive setting is intentional for this single-proxy deployment.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// The end-to-end suite drives login and the admin surface from a single IP
// against one shared server, which would exhaust these limiters and make
// unrelated tests flap. Allow turning them off with DISABLE_RATE_LIMITS=1 —
// but never in production, so a stray env var can't silently remove the
// protection from a live deployment.
const limitsDisabled = () =>
  process.env.NODE_ENV !== "production" && process.env.DISABLE_RATE_LIMITS === "1";

// At most 10 failed logins per IP per 15 minutes. A real person fat-fingering
// their code has plenty of headroom; a brute-forcer is stopped after 10 misses.
export const loginLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 10,
  skipSuccessfulRequests: true,
  skip: limitsDisabled,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: "Too many login attempts. Please try again in a little while." },
});

// At most 20 failed admin-key requests per IP per 15 minutes, across the whole
// /api/admin surface — enough to stop key-guessing while never getting in the
// owner's way (their correct-key requests return 2xx and are skipped).
export const adminLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 20,
  skipSuccessfulRequests: true,
  skip: limitsDisabled,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: "Too many requests. Please try again in a little while." },
});

// Group creation is public and a successful create is the thing worth capping
// (each one writes a group, a player and maybe an LMS competition), so unlike
// the limiters above this one counts every request: at most 10 new groups per IP
// per hour, far more than any real person needs.
export const createGroupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  skip: limitsDisabled,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: "Too many new groups from here. Please try again later." },
});

// Site-wide backstops. The per-IP limiters above key on req.ip, which comes
// from the X-Forwarded-For header. Behind a reverse proxy a client can put any
// address it likes at the front of that header, so a bot that rotates fake
// addresses gets a fresh per-IP allowance every time. These limiters share one
// bucket across the whole site, so no amount of address-spoofing gets more
// guesses than this.
//
// Login: 200 failed logins a day site-wide. Against a 6-char
// code (31^6 ≈ 900 million) and ~50 codes in use, that's centuries of
// guessing on average to hit anyone. The trade-off: while a bot is hammering the login,
// signed-out people may briefly see "too many attempts". Anyone already
// signed in is unaffected (their cookie never touches this endpoint).
const DAY_MS = 24 * 60 * 60 * 1000;
export const loginGlobalLimiter = rateLimit({
  windowMs: DAY_MS,
  limit: 200,
  skipSuccessfulRequests: true,
  skip: limitsDisabled,
  keyGenerator: () => "site-wide-login",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: "Too many login attempts. Please try again in a little while." },
});

// Admin key: 200 failed admin-key requests a day site-wide.
export const adminGlobalLimiter = rateLimit({
  windowMs: DAY_MS,
  limit: 200,
  skipSuccessfulRequests: true,
  skip: limitsDisabled,
  keyGenerator: () => "site-wide-admin",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: "Too many requests. Please try again in a little while." },
});

// Client activity events (POST /api/track/event): tab backgrounding, chart
// taps, wheel views… A real session sends a handful a minute; this only stops
// a runaway or hostile client from flooding activity_logs.
export const trackEventLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 600,
  skip: limitsDisabled,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { ok: false },
});
