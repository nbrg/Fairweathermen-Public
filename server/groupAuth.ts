import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

// HMAC signing secret. In production, set GROUP_COOKIE_SECRET in env. Falls
// back to ADMIN_API_KEY (already set for admin endpoints) so existing
// deployments don't need a new env var to start working. Last-resort dev
// constant is announced loudly so it's hard to miss in logs.
const SECRET =
  process.env.GROUP_COOKIE_SECRET ||
  process.env.ADMIN_API_KEY ||
  (() => {
    console.warn(
      "[groupAuth] No GROUP_COOKIE_SECRET / ADMIN_API_KEY set — using insecure dev default",
    );
    return "fwm-dev-fallback-set-GROUP_COOKIE_SECRET-in-prod";
  })();

// Cookie name bumped from the old group-only "fwm_group" to "fwm_user" now
// that the payload identifies a specific user (not just a group). Old
// "fwm_group" cookies are simply ignored — those users re-enter their new
// personal code once, which then stays valid for a year.
const COOKIE_NAME = "fwm_user";
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

function sign(value: string): string {
  const sig = crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
  return `${value}.${sig}`;
}

function verify(signed: string): string | null {
  const lastDot = signed.lastIndexOf(".");
  if (lastDot === -1) return null;
  const value = signed.slice(0, lastDot);
  const sig = signed.slice(lastDot + 1);
  const expected = crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
  // Constant-time compare to avoid leaking signature info via timing.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return value;
}

// Sets the signed session cookie identifying the logged-in user. The payload
// carries both the user id and their group id ("<userId>:<groupId>") so every
// request can populate req.userId and req.groupId without a DB lookup.
export function setUserCookie(res: Response, userId: number, groupId: number) {
  const signed = sign(`${userId}:${groupId}`);
  res.cookie(COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: MAX_AGE_MS,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

export function clearUserCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

function readUserCookie(req: Request): { userId: number; groupId: number } | null {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const name = trimmed.slice(0, eqIdx);
    if (name !== COOKIE_NAME) continue;
    const value = decodeURIComponent(trimmed.slice(eqIdx + 1));
    const verified = verify(value);
    if (!verified) return null;
    const [userStr, groupStr] = verified.split(":");
    const userId = Number(userStr);
    const groupId = Number(groupStr);
    if (!Number.isFinite(userId) || !Number.isFinite(groupId)) return null;
    return { userId, groupId };
  }
  return null;
}

// Express request augmentation so TypeScript knows about req.groupId / req.userId.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      groupId?: number;
      userId?: number;
    }
  }
}

// Always run as middleware: populates req.userId and req.groupId from the
// cookie if present. Does NOT gate the request — that's requireGroup's job.
export function groupContext(req: Request, _res: Response, next: NextFunction) {
  const session = readUserCookie(req);
  req.userId = session?.userId;
  req.groupId = session?.groupId;
  next();
}

// Rejects requests that don't have a verified group cookie.
export function requireGroup(req: Request, res: Response, next: NextFunction) {
  if (!req.groupId) return res.status(401).json({ error: "No group selected" });
  next();
}

// Writes an entry to activity_logs with the caller's IP, geolocation and
// user agent. Used to record every pick/change for the /audit view.
// userId here is the user whose pick was changed (NOT the caller — the
// caller is the cookie-bearer, but actions are honour-system so we just
// record whose pick was touched).
export async function logAuditEvent(
  req: Request,
  options: {
    type: string;
    userId: number | null;
    details: Record<string, any>;
  },
) {
  try {
    const { storage } = await import("./storage");
    const { getRealIP, getLocationFromIP } = await import("./geolocation");
    const realIP = getRealIP(req);
    const location = getLocationFromIP(realIP);
    await storage.createActivityLog({
      type: options.type,
      userId: options.userId,
      ipAddress: realIP,
      userAgent: req.get("User-Agent") || null,
      city: location.city,
      country: location.country,
      path: req.path,
      details: JSON.stringify(options.details),
      groupId: req.groupId ?? null,
    } as any);
  } catch (err) {
    // Audit failures must never block the action that triggered them.
    console.error("[logAuditEvent] failed to record:", err);
  }
}

// True if the given userId belongs to the given group. Used by per-user
// mutation endpoints to ensure picks/predictions can only be made for users
// in the caller's group (so e.g. someone in lastman can't write picks as
// Alex-united by guessing his userId).
export async function userInGroup(userId: number, groupId: number): Promise<boolean> {
  const { db } = await import("./db");
  const { users } = await import("@shared/schema");
  const { eq, and } = await import("drizzle-orm");
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.groupId, groupId)));
  return !!row;
}

// True if the given game (e.g. "predictions", "lms") is effectively enabled for
// this user in this group. Mirrors the client's `effectiveGames`: the group's
// enabledGames narrowed by the user's per-person override (a null override
// inherits the group's list). Used to reject writes for a game the caller's
// active group doesn't offer — e.g. a multi-group user whose /lawro page is
// still mounted after switching into a group that has no Prediction League
// would otherwise silently save predictions into that group.
export async function userGameEnabled(
  userId: number,
  groupId: number,
  game: string,
): Promise<boolean> {
  const { db } = await import("./db");
  const { users, groups } = await import("@shared/schema");
  const { eq, and } = await import("drizzle-orm");
  const [group] = await db
    .select({ enabledGames: groups.enabledGames })
    .from(groups)
    .where(eq(groups.id, groupId));
  if (!group) return false;
  const groupGames = (group.enabledGames as string[]) ?? [];
  if (!groupGames.includes(game)) return false;
  const [user] = await db
    .select({ enabledGames: users.enabledGames })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.groupId, groupId)));
  if (!user) return false;
  const override = user.enabledGames as string[] | null;
  // A null override inherits the group's games; otherwise it can only narrow.
  return override ? override.includes(game) : true;
}
