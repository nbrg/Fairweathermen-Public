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
