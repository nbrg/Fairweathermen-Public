import type { Express } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { storage } from "./storage";
import { runScraper } from "./scraper";
import { insertTeamSchema, insertMatchSchema, insertPredictionSchema, REMINDER_LEAD_PRESETS_MINUTES } from "@shared/schema";
import { getVisitorStats, updateScreenResolution } from "./visitorTracker";
import { getGroupRules } from "./groupRules";
import { getLocationFromIP, getRealIP } from "./geolocation";
import { z } from "zod";
import * as cron from "node-cron";
import { isStaticAssetPath } from "@shared/staticAssets";


// Selections lock `lockMinutesBeforeKickoff` minutes before the gameweek's
// first match. 0 = locks exactly at kickoff (the previous behaviour for every
// group). The offset comes from the group's LMS rules.
async function isGameweekLocked(
  gameweek: number,
  lockMinutesBeforeKickoff = 0,
): Promise<boolean> {
  const matches = await storage.getAllMatches();
  const gameweekMatches = matches.filter(m => m.gameweek === gameweek);

  if (gameweekMatches.length === 0) return false;

  // Find the earliest match time for this gameweek
  const earliestMatch = gameweekMatches.reduce((earliest, current) => {
    const currentTime = new Date(current.matchTime).getTime();
    const earliestTime = new Date(earliest.matchTime).getTime();
    return currentTime < earliestTime ? current : earliest;
  });

  // Get current time in London timezone
  const nowLondon = new Date().toLocaleString("en-US", {timeZone: "Europe/London"});
  const now = new Date(nowLondon);

  // Treat database time as London time; selections lock the configured number
  // of minutes before the first match.
  const matchTimeLondon = new Date(earliestMatch.matchTime).getTime();
  const lockAt = matchTimeLondon - lockMinutesBeforeKickoff * 60 * 1000;
  return now.getTime() >= lockAt;
}


export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // Group auth: populate req.groupId from the cookie on every request, and
  // gate all /api routes that aren't part of the login flow or the admin
  // surface (which has its own API key auth).
  const { groupContext, requireGroup, setUserCookie, clearUserCookie, userGameEnabled, initCookieSecret, logGrowthEvent, ensureVisitorId, isBotUserAgent } = await import("./groupAuth");
  const { loginLimiter, adminLimiter } = await import("./rateLimits");
  await initCookieSecret();
  app.use(groupContext);

  // Throttle brute-force attempts against the admin API key across the whole
  // admin surface (all admin endpoints live under /api/admin). The login
  // endpoint gets its own limiter where it's defined below.
  app.use("/api/admin", adminLimiter);

  app.use("/api", (req, res, next) => {
    // Public endpoints — the auth surface itself can't be auth-gated.
    if (
      req.path === "/group/login" ||
      req.path === "/group/logout" ||
      req.path === "/group/me" ||
      req.path === "/group/switch" ||
      req.path === "/push/vapid-public-key" ||
      // Self-service group creation + invites are pre-login by nature.
      req.path === "/group/create" ||
      req.path.startsWith("/group/invite/") ||
      req.path.startsWith("/group/join/")
    ) {
      return next();
    }
    // Admin endpoints have their own API-key auth and don't operate on a
    // single group's data — skip group gating.
    if (req.path.startsWith("/admin/")) return next();
    // The owner's admin-key tools (match/score edits, fixture syncs) don't
    // need a group either.
    if (process.env.ADMIN_API_KEY && req.headers["x-api-key"] === process.env.ADMIN_API_KEY) {
      return next();
    }
    // Everything else requires a verified group cookie.
    if (!req.groupId) return res.status(401).json({ error: "No group selected" });
    next();
  });

  // ---- Group auth endpoints ----

  // The group slug activated by default at login for someone in several
  // groups, before they switch. City (Fairweathermen) is the year-round home
  // group, so multi-group people (e.g. Morgan, Alex) land there rather than on
  // Rovers. Falls back to their lowest-id group if they're not in City.
  const DEFAULT_GROUP_SLUG = "city";

  // A user's effective game visibility: the group's games narrowed by the
  // user's per-person override. A null/undefined override means "inherit the
  // group's games" (the default). An override can only remove games the group
  // offers, never add ones it doesn't — so removing a game from the group hides
  // it for everyone regardless of overrides.
  function effectiveGames(
    groupGames: string[],
    userGames: string[] | null | undefined,
  ): string[] {
    if (!userGames) return groupGames;
    return groupGames.filter((g) => userGames.includes(g));
  }

  // True once a Prediction League ("Lawro") gameweek is past its deadline. The
  // deadline is the gameweek's first kickoff, brought forward by the group's
  // configured `lawro.deadlineMinutesBeforeKickoff` (default 0). At that point
  // the whole gameweek locks for editing; anyone without a pick is left blank.
  // A null gameweek or a gameweek with no fixtures is treated as unlocked.
  async function gameweekLocked(gameweek: number | null, groupId?: number): Promise<boolean> {
    if (gameweek == null) return false;
    const deadline = await storage.getGameweekDeadline(gameweek);
    if (deadline == null) return false;
    const { getGroupRules } = await import("./groupRules");
    const rules = await getGroupRules(groupId);
    const offsetMs = rules.lawro.deadlineMinutesBeforeKickoff * 60 * 1000;
    return Date.now() >= deadline.getTime() - offsetMs;
  }

  // Builds the session response for a person (identified by their login code),
  // making one of their groups the active one. A person who belongs to several
  // groups has one user row per group, all sharing the same code; the returned
  // `availableGroups` list drives the client's group switcher. `preferredGroupId`
  // selects which of the person's groups to activate (defaults to the City group
  // if they're in it, otherwise their lowest-id group). Returns null if the
  // code matches nobody.
  async function buildSession(code: string, preferredGroupId?: number) {
    const { db, withDbRetry } = await import("./db");
    const { groups, users } = await import("@shared/schema");
    const { eq, inArray, asc } = await import("drizzle-orm");
    // Wrap the reads in withDbRetry: these are the first queries a person's
    // session makes, so they're the ones most likely to land on a Neon socket
    // that went idle and was closed — which surfaced as a 500 on the first
    // login attempt that then succeeded on retry. Both are idempotent reads.
    const rows = await withDbRetry(() =>
      db.select().from(users).where(eq(users.loginCode, code)),
    );
    if (rows.length === 0) return null;
    const groupIds = Array.from(new Set(rows.map((r) => r.groupId)));
    const grps = await withDbRetry(() =>
      db
        .select()
        .from(groups)
        .where(inArray(groups.id, groupIds))
        .orderBy(asc(groups.id)),
    );
    if (grps.length === 0) return null;
    // Pick the active row: the person's row in the preferred group if valid,
    // else the default (City) group, else their lowest-id group.
    const sortedRows = [...rows].sort((a, b) => a.groupId - b.groupId);
    const defaultGroup = grps.find((g) => g.slug === DEFAULT_GROUP_SLUG);
    const activeRow =
      (preferredGroupId != null &&
        sortedRows.find((r) => r.groupId === preferredGroupId)) ||
      (defaultGroup && sortedRows.find((r) => r.groupId === defaultGroup.id)) ||
      sortedRows[0];
    const activeGroup = grps.find((g) => g.id === activeRow.groupId)!;
    const { resolveGroupRulesForGroup, unseenRuleChanges } = await import("./groupRules");
    // Rule changes this person hasn't acknowledged yet (excluding ones they made
    // themselves), oldest first — drives the "the rules have changed" pop-up.
    const ruleChanges = await unseenRuleChanges(
      activeGroup.id,
      activeRow.id,
      activeRow.lastSeenRuleChangeId ?? 0,
    );
    return {
      activeRow,
      payload: {
        id: activeGroup.id,
        slug: activeGroup.slug,
        name: activeGroup.name,
        enabledGames: effectiveGames(activeGroup.enabledGames, activeRow.enabledGames),
        // The active group's resolved rules (defaults merged, legacy columns
        // bridged), so the client scores/labels using this group's settings.
        rules: resolveGroupRulesForGroup(activeGroup),
        // True when the logged-in person created this group (is its admin), so
        // the client can show the owner-only group settings. Null ownerUserId
        // (the original hand-seeded groups) means nobody is the self-service
        // admin, so this is false for everyone there.
        isOwner: activeGroup.ownerUserId != null && activeGroup.ownerUserId === activeRow.id,
        user: { id: activeRow.id, username: activeRow.username },
        // Each group the person belongs to, with the games they can see there
        // (their per-group override applied). Drives the header's cross-group
        // game tabs, so a game hosted by another of their groups can be reached
        // in one click (switching them into that group).
        availableGroups: grps.map((g) => {
          const row = sortedRows.find((r) => r.groupId === g.id);
          return {
            id: g.id,
            slug: g.slug,
            name: g.name,
            enabledGames: effectiveGames(g.enabledGames, row?.enabledGames),
          };
        }),
        // Unacknowledged rule changes for the "the rules have changed" pop-up.
        ruleChanges,
      },
    };
  }

  // POST /api/group/login — { code } → looks up the person whose private login
  // code this is, sets the session cookie for one of their groups, and returns
  // that group (which determines the enabled games), their identity, and the
  // list of groups they can switch between. The endpoint path is kept for
  // backwards-compat with the client, but the code is now a per-person code
  // rather than a group slug.
  app.post("/api/group/login", loginLimiter, async (req, res) => {
    try {
      const code = String(req.body?.code ?? "").trim().toLowerCase();
      if (!code) return res.status(400).json({ error: "Code required" });
      const session = await buildSession(code);
      if (!session) {
        // Never record the attempted code — it may be a near-miss of a real one.
        await logGrowthEvent(req, "login_failed");
        return res.status(404).json({ error: "Invalid code" });
      }
      setUserCookie(res, session.activeRow.id, session.activeRow.groupId);
      await logGrowthEvent(req, "login", {
        userId: session.activeRow.id,
        groupId: session.activeRow.groupId,
        details: { groupCount: session.payload.availableGroups.length },
      });
      res.json(session.payload);
    } catch (err: any) {
      console.error("[/api/group/login] error:", err);
      res.status(500).json({ error: err?.message || "Login failed" });
    }
  });

  // POST /api/group/logout — clears the cookie
  app.post("/api/group/logout", (_req, res) => {
    clearUserCookie(res);
    res.json({ ok: true });
  });

  // ---- Self-service group creation / invites ----

  // Games a self-service group may run: Last Man Standing and the Prediction
  // League ("Lawro").
  const SELF_SERVE_GAMES = ["lms", "predictions"] as const;

  function slugifyName(name: string): string {
    const base = name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    return base || "group";
  }

  async function uniqueGroupSlug(name: string): Promise<string> {
    const { db } = await import("./db");
    const { groups } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const base = slugifyName(name);
    for (let attempt = 0; attempt < 25; attempt++) {
      const suffix = crypto.randomBytes(3).toString("hex");
      const slug = `${base}-${suffix}`;
      const [existing] = await db.select({ id: groups.id }).from(groups).where(eq(groups.slug, slug));
      if (!existing) return slug;
    }
    throw new Error("Could not generate a unique group slug");
  }

  function newInviteToken(): string {
    return crypto.randomBytes(16).toString("base64url");
  }

  // True when the logged-in person is the admin (owner) of their active group.
  async function isActiveGroupOwner(req: any): Promise<boolean> {
    if (!req.userId || !req.groupId) return false;
    const { db } = await import("./db");
    const { groups } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [group] = await db
      .select({ ownerUserId: groups.ownerUserId })
      .from(groups)
      .where(eq(groups.id, req.groupId));
    return !!group && group.ownerUserId != null && group.ownerUserId === req.userId;
  }

  // The player row `id` if it belongs to the caller's active group.
  async function playerInActiveGroup(req: any, id: number) {
    if (!Number.isInteger(id)) return undefined;
    const player = await storage.getUser(id);
    return player && player.groupId === req.groupId ? player : undefined;
  }

  // The group's current LMS competition and whether players can still be moved
  // in or out of it: only until its first deadline, so nobody joins or leaves
  // a competition that's already under way.
  async function lmsRosterWindow(groupId: number) {
    const competition = await storage.getCurrentLmsCompetition(groupId);
    if (!competition) return { competition: undefined, open: false };
    const rules = await getGroupRules(groupId);
    const locked = await isGameweekLocked(competition.startGameweek, rules.lms.deadlineMinutesBeforeKickoff);
    return { competition, open: !locked };
  }

  // Whether a player has any game history in this group. Players with history
  // can't be removed (it would rewrite past leaderboards and LMS results).
  async function playerHasHistory(userId: number): Promise<boolean> {
    const { db } = await import("./db");
    const { predictions, lmsParticipants, lmsSelections, lmsCompetitions } = await import("@shared/schema");
    const { and, eq } = await import("drizzle-orm");
    const [pred] = await db.select({ id: predictions.id }).from(predictions).where(eq(predictions.userId, userId)).limit(1);
    if (pred) return true;
    const [lmsPick] = await db
      .select({ id: lmsSelections.id })
      .from(lmsSelections)
      .innerJoin(lmsParticipants, eq(lmsSelections.participantId, lmsParticipants.id))
      .where(eq(lmsParticipants.userId, userId))
      .limit(1);
    if (lmsPick) return true;
    const [pastComp] = await db
      .select({ id: lmsParticipants.id })
      .from(lmsParticipants)
      .innerJoin(lmsCompetitions, eq(lmsParticipants.competitionId, lmsCompetitions.id))
      .where(and(eq(lmsParticipants.userId, userId), eq(lmsCompetitions.status, "completed")))
      .limit(1);
    return !!pastComp;
  }

  // POST /api/group/create — public. Anyone can create a group. Body:
  //   { groupName, adminName, games: string[] }
  // Creates the group, makes the caller its first player AND its admin (owner),
  // mints an invite token, logs the caller in, and returns their login code and
  // the invite link to share.
  app.post("/api/group/create", loginLimiter, async (req, res) => {
    try {
      const groupName = String(req.body?.groupName ?? "").trim();
      const adminName = String(req.body?.adminName ?? "").trim();
      const requestedGames: unknown = req.body?.games;

      if (groupName.length < 2 || groupName.length > 60) {
        return res.status(400).json({ error: "Group name must be 2–60 characters" });
      }
      if (adminName.length < 1 || adminName.length > 40) {
        return res.status(400).json({ error: "Your name must be 1–40 characters" });
      }
      const games = Array.isArray(requestedGames)
        ? SELF_SERVE_GAMES.filter((g) => requestedGames.includes(g))
        : [];
      if (games.length === 0) {
        return res.status(400).json({ error: "Pick at least one game (Last Man Standing or Lawro)" });
      }

      const { db } = await import("./db");
      const { groups, users } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const { codeForNewSelfServiceRow } = await import("./loginCodes");

      const slug = await uniqueGroupSlug(groupName);
      const inviteToken = newInviteToken();

      const [group] = await db
        .insert(groups)
        .values({ slug, name: groupName, enabledGames: games as string[], inviteToken })
        .returning();

      const [adminRow] = await db
        .insert(users)
        .values({
          username: adminName,
          password: "password",
          groupId: group.id,
          // Never looked up by name (that would hand anyone who types an
          // existing player's name that player's login): a signed-in caller
          // keeps their own code, anyone else gets a fresh one.
          loginCode: await codeForNewSelfServiceRow(req.userId),
        })
        .returning();
      await db.update(groups).set({ ownerUserId: adminRow.id }).where(eq(groups.id, group.id));

      // If the group plays LMS, open its first competition now (at the next
      // gameweek that hasn't kicked off). Best-effort: a failure here must not
      // stop the group being created.
      try {
        const { ensureLmsCompetitionForGroup } = await import("./lmsAutoStart");
        await ensureLmsCompetitionForGroup(group.id);
      } catch (err) {
        console.error(`[/api/group/create] couldn't auto-start LMS for group ${group.id}:`, err);
      }

      const session = await buildSession(adminRow.loginCode!, group.id);
      if (session) setUserCookie(res, session.activeRow.id, session.activeRow.groupId);

      await logGrowthEvent(req, "group_created", {
        userId: adminRow.id,
        groupId: group.id,
        details: { groupName, slug, games, adminName },
      });

      const inviteUrl = `${req.protocol}://${req.get("host")}/join/${inviteToken}`;
      res.json({
        ok: true,
        // Return the login code as `code`, not `loginCode`: the global /api
        // scrub middleware (server/index.ts) strips any `loginCode` key from
        // non-admin responses, so this creation flow would otherwise lose it.
        code: adminRow.loginCode,
        inviteToken,
        inviteUrl,
        group: session?.payload ?? null,
      });
    } catch (err: any) {
      console.error("[/api/group/create] error:", err);
      res.status(500).json({ error: err?.message || "Failed to create group" });
    }
  });

  // GET /api/group/invite/:token — public. Describes the group behind an invite
  // link so the join page can greet the player. 404 for an unknown token.
  app.get("/api/group/invite/:token", async (req, res) => {
    try {
      const token = String(req.params.token ?? "");
      if (!token) return res.status(400).json({ error: "Missing token" });
      const { db } = await import("./db");
      const { groups } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const [group] = await db
        .select({ id: groups.id, name: groups.name, enabledGames: groups.enabledGames })
        .from(groups)
        .where(eq(groups.inviteToken, token));
      if (!group) return res.status(404).json({ error: "This invite link is invalid or has expired" });
      if (!isBotUserAgent(req.get("User-Agent"))) {
        await logGrowthEvent(req, "invite_opened", {
          userId: req.userId ?? null,
          groupId: group.id,
          details: { groupName: group.name },
        });
      }
      res.json({ name: group.name, games: group.enabledGames });
    } catch (err: any) {
      console.error("[/api/group/invite GET] error:", err);
      res.status(500).json({ error: err?.message || "Failed to load invite" });
    }
  });

  // POST /api/group/join/:token — public. A player joins a group via its invite
  // link. Body: { name }. Creates their player row + login code, enrols them
  // into any active LMS competition, logs them in, and returns their login code.
  // A name already taken in the group is refused (unless the caller is signed in
  // as that very player): handing back an existing player's code to anyone who
  // types their name would let them sign in as that player. A caller who is
  // already signed in elsewhere keeps their code, so the group joins their
  // switcher.
  app.post("/api/group/join/:token", loginLimiter, async (req, res) => {
    try {
      const token = String(req.params.token ?? "");
      const name = String(req.body?.name ?? "").trim();
      if (!token) return res.status(400).json({ error: "Missing token" });
      if (name.length < 1 || name.length > 40) {
        return res.status(400).json({ error: "Your name must be 1–40 characters" });
      }

      const { db } = await import("./db");
      const { groups, users } = await import("@shared/schema");
      const { and, eq, sql } = await import("drizzle-orm");
      const { codeForNewSelfServiceRow } = await import("./loginCodes");

      const [group] = await db.select().from(groups).where(eq(groups.inviteToken, token));
      if (!group) return res.status(404).json({ error: "This invite link is invalid or has expired" });

      // Names are matched case- and space-insensitively so "dave" can't sit
      // alongside "Dave".
      const [existing] = await db
        .select()
        .from(users)
        .where(and(eq(users.groupId, group.id), sql`lower(trim(${users.username})) = ${name.toLowerCase()}`));
      let player = existing;
      if (player) {
        const me = req.userId != null ? await storage.getUser(req.userId) : undefined;
        const isThem = !!me && !!me.loginCode && me.loginCode === player.loginCode;
        if (!isThem) {
          return res.status(409).json({
            error: `Someone called "${player.username}" is already in ${group.name}. If that's you, sign in with your login code instead. Otherwise, add something to your name (like an initial).`,
          });
        }
      }
      const linked = req.userId != null;
      if (!player) {
        // Start a new joiner at the group's latest rule change so they aren't
        // shown the "rules have changed" pop-up for changes made before they
        // arrived.
        const { latestRuleChangeId } = await import("./groupRules");
        const [row] = await db
          .insert(users)
          .values({
            username: name,
            password: "password",
            groupId: group.id,
            loginCode: await codeForNewSelfServiceRow(req.userId),
            lastSeenRuleChangeId: await latestRuleChangeId(group.id),
          })
          .returning();
        player = row;
      }

      const competition = await storage.getCurrentLmsCompetition(group.id);
      if (competition) {
        const participants = await storage.getLmsParticipantsByCompetition(competition.id);
        if (!participants.some((p) => p.userId === player.id)) {
          await storage.createLmsParticipant({
            competitionId: competition.id,
            userId: player.id,
            isActive: "true",
          } as any);
        }
      }

      await logGrowthEvent(req, "group_joined", {
        userId: player.id,
        groupId: group.id,
        details: { groupName: group.name, name, rejoin: !!existing },
      });

      const session = await buildSession(player.loginCode!, group.id);
      if (session) setUserCookie(res, session.activeRow.id, session.activeRow.groupId);
      // `code`, not `loginCode`: the /api scrub middleware strips `loginCode`.
      res.json({ ok: true, code: player.loginCode, linked, group: session?.payload ?? null });
    } catch (err: any) {
      console.error("[/api/group/join POST] error:", err);
      res.status(500).json({ error: err?.message || "Failed to join group" });
    }
  });

  // GET /api/group/rules — the active group's resolved rules + whether the
  // caller may edit them (is the owner). Any logged-in member can read.
  app.get("/api/group/rules", requireGroup, async (req, res) => {
    try {
      const { db } = await import("./db");
      const { groups } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const { resolveGroupRulesForGroup } = await import("./groupRules");
      const [group] = await db
        .select({
          rules: groups.rules,
          buyIn: groups.buyIn,
          lmsAllOutRule: groups.lmsAllOutRule,
          enabledGames: groups.enabledGames,
          inviteToken: groups.inviteToken,
        })
        .from(groups)
        .where(eq(groups.id, req.groupId!));
      if (!group) return res.status(404).json({ error: "No such group" });
      const isOwner = await isActiveGroupOwner(req);
      res.json({
        rules: resolveGroupRulesForGroup(group),
        enabledGames: group.enabledGames,
        isOwner,
        // Only the admin needs the invite link (to share it).
        inviteToken: isOwner ? group.inviteToken : null,
      });
    } catch (err: any) {
      console.error("[/api/group/rules GET] error:", err);
      res.status(500).json({ error: err?.message || "Failed to load rules" });
    }
  });

  // PUT /api/group/rules — update the active group's rules. Owner only. Body is
  // a (partial) GroupRules; it's merged onto the current rules and clamped to
  // sane bounds by resolveGroupRules before saving. The two legacy columns
  // (buyIn, lmsAllOutRule) are kept in sync so the admin "Groups" screen and
  // the LMS processor (which still reads lmsAllOutRule) stay consistent.
  app.put("/api/group/rules", requireGroup, async (req, res) => {
    try {
      if (!(await isActiveGroupOwner(req))) {
        return res.status(403).json({ error: "Only the group admin can change the rules" });
      }
      const { db } = await import("./db");
      const { groups, resolveGroupRules, LMS_ALL_OUT_RULES } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const { resolveGroupRulesForGroup } = await import("./groupRules");
      const [group] = await db
        .select({ rules: groups.rules, buyIn: groups.buyIn, lmsAllOutRule: groups.lmsAllOutRule })
        .from(groups)
        .where(eq(groups.id, req.groupId!));
      if (!group) return res.status(404).json({ error: "No such group" });

      const current = resolveGroupRulesForGroup(group);
      const body = (req.body ?? {}) as Partial<typeof current>;
      // Merge incoming values onto the current rules, then clamp/normalise.
      const merged = resolveGroupRules({
        lawro: { ...current.lawro, ...(body.lawro ?? {}) },
        lms: { ...current.lms, ...(body.lms ?? {}) },
      });
      // Keep the legacy columns in sync. allOutPolicy may now be one of the
      // richer values (co_winners/no_winner) that the legacy column can't hold;
      // only mirror it back when it's still a value the column understands,
      // otherwise leave the column as-is (the blob is authoritative on read).
      const columnUpdates: { buyIn: number; lmsAllOutRule?: string } = { buyIn: merged.lms.buyIn };
      if ((LMS_ALL_OUT_RULES as readonly string[]).includes(merged.lms.allOutPolicy)) {
        columnUpdates.lmsAllOutRule = merged.lms.allOutPolicy;
      }
      await db
        .update(groups)
        .set({ rules: merged, ...columnUpdates })
        .where(eq(groups.id, req.groupId!));

      // Log any change so it drives everyone's "the rules changed" pop-up and
      // keeps earlier Lawro gameweeks on the rules they were played under.
      const { describeRuleChanges } = await import("./groupRules");
      const items = describeRuleChanges(current, merged);
      if (items.length > 0) {
        const { groupRuleChanges } = await import("@shared/schema");
        const { nextUnstartedGameweek } = await import("./lmsAutoStart");
        const lawroChanged = JSON.stringify(merged.lawro) !== JSON.stringify(current.lawro);
        // A Lawro change applies from the first gameweek still open under the
        // new deadline; with none left this season it starts from a high
        // gameweek (99), so the whole current season keeps its old rules.
        const lawroFrom = lawroChanged
          ? await nextUnstartedGameweek(merged.lawro.deadlineMinutesBeforeKickoff)
          : null;
        const lawroSeason = lawroChanged
          ? lawroFrom?.season ?? (await storage.getAllMatches()).find((m) => m.season)?.season ?? null
          : null;
        await db.insert(groupRuleChanges).values({
          groupId: req.groupId!,
          changedByUserId: req.userId ?? null,
          before: current,
          after: merged,
          changes: items,
          lawroEffectiveSeason: lawroChanged ? lawroSeason : null,
          lawroEffectiveGameweek: lawroChanged ? lawroFrom?.gameweek ?? 99 : null,
        });
      }

      res.json({ ok: true, rules: merged });
    } catch (err: any) {
      console.error("[/api/group/rules PUT] error:", err);
      res.status(500).json({ error: err?.message || "Failed to save rules" });
    }
  });

  // POST /api/group/rule-changes/seen — the player acknowledged the rule-change
  // pop-up. Body { upToId } marks everything up to that change as seen (never
  // moves backwards), so a change made while the pop-up was open still shows.
  app.post("/api/group/rule-changes/seen", requireGroup, async (req, res) => {
    try {
      if (!req.userId) return res.status(401).json({ error: "Not signed in" });
      const upToId = Number(req.body?.upToId);
      if (!Number.isInteger(upToId) || upToId < 0) return res.status(400).json({ error: "Invalid upToId" });
      const { db } = await import("./db");
      const { users } = await import("@shared/schema");
      const { and, eq, lt } = await import("drizzle-orm");
      const { latestRuleChangeId } = await import("./groupRules");
      const capped = Math.min(upToId, await latestRuleChangeId(req.groupId!));
      await db
        .update(users)
        .set({ lastSeenRuleChangeId: capped })
        .where(and(eq(users.id, req.userId!), eq(users.groupId, req.groupId!), lt(users.lastSeenRuleChangeId, capped)));
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[/api/group/rule-changes/seen POST] error:", err);
      res.status(500).json({ error: err?.message || "Failed to save" });
    }
  });

  // ---- Group admin: player management (owner only, on /group-settings) ----

  // GET /api/group/players — the active group's players for the admin.
  app.get("/api/group/players", requireGroup, async (req, res) => {
    try {
      if (!(await isActiveGroupOwner(req))) {
        return res.status(403).json({ error: "Only the group admin can manage players" });
      }
      const { db } = await import("./db");
      const { groups, users } = await import("@shared/schema");
      const { asc, eq } = await import("drizzle-orm");
      const [group] = await db.select().from(groups).where(eq(groups.id, req.groupId!));
      const rows = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(eq(users.groupId, req.groupId!))
        .orderBy(asc(users.username));
      const plays = (game: string) => ((group?.enabledGames as string[]) ?? []).includes(game);
      const { competition, open } = plays("lms")
        ? await lmsRosterWindow(req.groupId!)
        : { competition: undefined, open: false };
      const inLms = new Set<number>();
      if (competition) {
        for (const p of await storage.getLmsParticipantsByCompetition(competition.id)) inLms.add(p.userId);
      }
      const players = await Promise.all(
        rows.map(async (r) => {
          const isOwner = r.id === group?.ownerUserId;
          return {
            id: r.id,
            username: r.username,
            isOwner,
            inLms: inLms.has(r.id),
            canRemove: !isOwner && !(await playerHasHistory(r.id)),
          };
        }),
      );
      res.json({
        players,
        // Names identify people in the original groups (the shared login across
        // groups), so only self-service groups can rename.
        canRename: !!group?.inviteToken,
        lms: competition
          ? { name: competition.name, startGameweek: competition.startGameweek, open }
          : null,
      });
    } catch (err: any) {
      console.error("[/api/group/players GET] error:", err);
      res.status(500).json({ error: err?.message || "Failed to load players" });
    }
  });

  // PATCH /api/group/players/:id — rename a player. Body { username }.
  // Self-service groups only; names stay unique within the group.
  app.patch("/api/group/players/:id", requireGroup, async (req, res) => {
    try {
      if (!(await isActiveGroupOwner(req))) {
        return res.status(403).json({ error: "Only the group admin can manage players" });
      }
      const player = await playerInActiveGroup(req, Number(req.params.id));
      if (!player) return res.status(404).json({ error: "No such player in this group" });
      const username = String(req.body?.username ?? "").trim();
      if (username.length < 1 || username.length > 40) {
        return res.status(400).json({ error: "Names must be 1–40 characters" });
      }
      const { db } = await import("./db");
      const { groups, users } = await import("@shared/schema");
      const { and, eq, ne, sql } = await import("drizzle-orm");
      const [group] = await db.select().from(groups).where(eq(groups.id, req.groupId!));
      if (!group?.inviteToken) {
        return res.status(409).json({ error: "Players in this group can't be renamed here" });
      }
      const [clash] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.groupId, req.groupId!),
            ne(users.id, player.id),
            sql`lower(trim(${users.username})) = ${username.toLowerCase()}`,
          ),
        );
      if (clash) return res.status(409).json({ error: `There's already a "${username}" in this group` });
      await db.update(users).set({ username }).where(eq(users.id, player.id));
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[/api/group/players PATCH] error:", err);
      res.status(500).json({ error: err?.message || "Failed to rename player" });
    }
  });

  // POST /api/group/players/:id/reset-code — give a player a new login code
  // (e.g. they lost theirs, or it leaked) and show it to the admin once. The old
  // code stops working. A person's code covers every group they're in, so the
  // admin can only reset it when all of that person's groups are ones they
  // admin; otherwise resetting it would hand them a login to someone else's
  // group.
  app.post("/api/group/players/:id/reset-code", requireGroup, async (req, res) => {
    try {
      if (!(await isActiveGroupOwner(req))) {
        return res.status(403).json({ error: "Only the group admin can manage players" });
      }
      const player = await playerInActiveGroup(req, Number(req.params.id));
      if (!player) return res.status(404).json({ error: "No such player in this group" });
      const { db } = await import("./db");
      const { groups, users } = await import("@shared/schema");
      const { eq, inArray } = await import("drizzle-orm");
      const me = await storage.getUser(req.userId!);
      const personRows = player.loginCode
        ? await db.select({ id: users.id, groupId: users.groupId }).from(users).where(eq(users.loginCode, player.loginCode))
        : [{ id: player.id, groupId: player.groupId }];
      const groupIds = Array.from(new Set(personRows.map((r) => r.groupId)));
      const personGroups = await db
        .select({ id: groups.id, ownerUserId: groups.ownerUserId })
        .from(groups)
        .where(inArray(groups.id, groupIds));
      const ownerIds = personGroups.map((g) => g.ownerUserId).filter((id): id is number => id != null);
      const owners = ownerIds.length
        ? await db.select({ id: users.id, loginCode: users.loginCode }).from(users).where(inArray(users.id, ownerIds))
        : [];
      const adminsAll = personGroups.every((g) => {
        const owner = owners.find((o) => o.id === g.ownerUserId);
        return !!owner && !!me?.loginCode && owner.loginCode === me.loginCode;
      });
      if (!adminsAll) {
        return res.status(409).json({
          error: `${player.username} is also in a group you don't run, so their code can't be reset here.`,
        });
      }
      const { generateUniqueLoginCode } = await import("./loginCodes");
      const code = await generateUniqueLoginCode();
      await db.update(users).set({ loginCode: code }).where(inArray(users.id, personRows.map((r) => r.id)));
      const { logAuditEvent } = await import("./groupAuth");
      await logAuditEvent(req, { type: "login_code_reset", userId: player.id, details: { by: req.userId } });
      // Returned as `code` (not `loginCode`) so the /api redaction middleware
      // doesn't strip it — the admin needs to pass it on.
      res.json({ ok: true, code });
    } catch (err: any) {
      console.error("[/api/group/players reset-code] error:", err);
      res.status(500).json({ error: err?.message || "Failed to reset code" });
    }
  });

  // PUT /api/group/players/:id/lms — put a player in or take them out of the
  // group's current LMS competition. Body { inLms: boolean }. Only allowed
  // before that competition's first deadline (e.g. someone sitting one out
  // because of the buy-in). The next competition copies this one's players, so
  // someone who sat out is added back the same way when it opens.
  app.put("/api/group/players/:id/lms", requireGroup, async (req, res) => {
    try {
      if (!(await isActiveGroupOwner(req))) {
        return res.status(403).json({ error: "Only the group admin can manage players" });
      }
      const player = await playerInActiveGroup(req, Number(req.params.id));
      if (!player) return res.status(404).json({ error: "No such player in this group" });
      const inLms = req.body?.inLms;
      if (typeof inLms !== "boolean") return res.status(400).json({ error: "inLms must be true or false" });
      const { competition, open } = await lmsRosterWindow(req.groupId!);
      if (!competition) return res.status(409).json({ error: "There's no LMS competition to change" });
      if (!open) {
        return res.status(409).json({
          error: `${competition.name} has already started, so its players are fixed. Make the change when the next one opens.`,
        });
      }
      const participants = await storage.getLmsParticipantsByCompetition(competition.id);
      const mine = participants.filter((p) => p.userId === player.id);
      if (inLms && mine.length === 0) {
        await storage.createLmsParticipant({
          competitionId: competition.id,
          userId: player.id,
          isActive: "true",
          eliminatedInRound: null,
        });
      } else if (!inLms && mine.length > 0) {
        const { db } = await import("./db");
        const { lmsParticipants, lmsSelections, lmsSelectionLogs } = await import("@shared/schema");
        const { inArray } = await import("drizzle-orm");
        const ids = mine.map((p) => p.id);
        await db.delete(lmsSelections).where(inArray(lmsSelections.participantId, ids));
        await db.delete(lmsSelectionLogs).where(inArray(lmsSelectionLogs.participantId, ids));
        await db.delete(lmsParticipants).where(inArray(lmsParticipants.id, ids));
      }
      const { logAuditEvent } = await import("./groupAuth");
      await logAuditEvent(req, {
        type: inLms ? "lms_player_added" : "lms_player_sat_out",
        userId: player.id,
        details: { competitionId: competition.id, by: req.userId },
      });
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[/api/group/players lms PUT] error:", err);
      res.status(500).json({ error: err?.message || "Failed to update LMS players" });
    }
  });

  // DELETE /api/group/players/:id — remove a player who has no game history
  // (e.g. joined twice, or by mistake). Anyone with picks or past results stays,
  // so leaderboards and LMS history never change under people.
  app.delete("/api/group/players/:id", requireGroup, async (req, res) => {
    try {
      if (!(await isActiveGroupOwner(req))) {
        return res.status(403).json({ error: "Only the group admin can manage players" });
      }
      const player = await playerInActiveGroup(req, Number(req.params.id));
      if (!player) return res.status(404).json({ error: "No such player in this group" });
      const { db } = await import("./db");
      const { groups, users, activityLogs, lmsParticipants, pushSubscriptions, reminderSends } =
        await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const [group] = await db.select().from(groups).where(eq(groups.id, req.groupId!));
      if (group?.ownerUserId === player.id) return res.status(409).json({ error: "The admin can't be removed" });
      if (await playerHasHistory(player.id)) {
        return res.status(409).json({
          error: `${player.username} has picks or results here, so they can't be removed. You can take them out of the next LMS competition instead.`,
        });
      }
      await db.delete(lmsParticipants).where(eq(lmsParticipants.userId, player.id));
      await db.delete(reminderSends).where(eq(reminderSends.userId, player.id));
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, player.id));
      // activity_logs.user_id is a real FK → null it rather than block delete.
      await db.update(activityLogs).set({ userId: null }).where(eq(activityLogs.userId, player.id));
      await db.delete(users).where(eq(users.id, player.id));
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[/api/group/players DELETE] error:", err);
      res.status(500).json({ error: err?.message || "Failed to remove player" });
    }
  });

  // POST /api/group/invite/reset — replace the group's invite link (e.g. it was
  // shared too widely). The old link stops working at once; players already in
  // the group are unaffected. Only groups that have an invite link (the
  // self-service ones) can reset it.
  app.post("/api/group/invite/reset", requireGroup, async (req, res) => {
    try {
      if (!(await isActiveGroupOwner(req))) {
        return res.status(403).json({ error: "Only the group admin can reset the invite link" });
      }
      const { db } = await import("./db");
      const { groups } = await import("@shared/schema");
      const { and, eq, isNotNull } = await import("drizzle-orm");
      const inviteToken = newInviteToken();
      const updated = await db
        .update(groups)
        .set({ inviteToken })
        .where(and(eq(groups.id, req.groupId!), isNotNull(groups.inviteToken)))
        .returning({ id: groups.id });
      if (updated.length === 0) return res.status(409).json({ error: "This group has no invite link" });
      res.json({ ok: true, inviteToken });
    } catch (err: any) {
      console.error("[/api/group/invite/reset] error:", err);
      res.status(500).json({ error: err?.message || "Failed to reset the invite link" });
    }
  });

  // ---- Web-push (kickoff reminders) ----

  // GET /api/push/vapid-public-key — the client needs this to subscribe.
  // Public: the key is not a secret, and it's fetched before/around login.
  app.get("/api/push/vapid-public-key", async (_req, res) => {
    const { getVapidPublicKey, isPushConfigured } = await import("./push");
    res.json({ key: isPushConfigured() ? getVapidPublicKey() : null });
  });

  // Clamp a requested set of lead times to the allowed presets (minutes),
  // de-duplicated and sorted. Falls back to [60] if none are valid.
  function normalizeLeads(v: unknown): number[] {
    const allowed = new Set<number>(REMINDER_LEAD_PRESETS_MINUTES as readonly number[]);
    const arr = Array.isArray(v) ? v : [];
    const picked = Array.from(new Set(arr.map(Number).filter((n) => allowed.has(n)))).sort(
      (a, b) => a - b,
    );
    return picked.length ? picked : [60];
  }

  // Lightweight push/PWA event log (subscribed, denied, error, launched as an
  // installed PWA…) so the owner can see who set things up or tried to.
  async function logPushEvent(req: any, type: string, detail?: Record<string, unknown>) {
    try {
      await storage.createActivityLog({
        type,
        userId: req.userId ?? null,
        ipAddress: getRealIP(req),
        userAgent: req.get("User-Agent") || null,
        city: null,
        country: null,
        path: null,
        details: detail ? JSON.stringify(detail) : null,
        groupId: req.groupId ?? null,
      } as any);
    } catch (e) {
      console.error("[push event] log failed:", e);
    }
  }

  // POST /api/push/subscribe — save this device's push subscription for the
  // logged-in person, so kickoff reminders can reach it.
  app.post("/api/push/subscribe", requireGroup, async (req, res) => {
    try {
      const sub = req.body?.subscription ?? req.body;
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
        return res.status(400).json({ error: "Invalid subscription" });
      }
      const leads = normalizeLeads(req.body?.leads);
      const { saveSubscription } = await import("./push");
      await saveSubscription(req.userId!, req.groupId!, sub, req.get("User-Agent") || null, leads);
      await logPushEvent(req, "push_enabled", { leads });
      res.json({ ok: true, leads });
    } catch (err: any) {
      console.error("[/api/push/subscribe] error:", err);
      res.status(500).json({ error: err?.message || "Failed to subscribe" });
    }
  });

  // POST /api/push/unsubscribe — forget a device's subscription (by endpoint).
  app.post("/api/push/unsubscribe", requireGroup, async (req, res) => {
    try {
      const endpoint = String(req.body?.endpoint ?? "");
      if (!endpoint) return res.status(400).json({ error: "endpoint required" });
      const { deleteSubscription } = await import("./push");
      await deleteSubscription(endpoint);
      await logPushEvent(req, "push_disabled");
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[/api/push/unsubscribe] error:", err);
      res.status(500).json({ error: err?.message || "Failed to unsubscribe" });
    }
  });

  // GET /api/push/preferences — this person's current reminder settings.
  app.get("/api/push/preferences", requireGroup, async (req, res) => {
    try {
      const { getPreferencesForUser } = await import("./push");
      res.json(await getPreferencesForUser(req.userId!));
    } catch (err: any) {
      console.error("[/api/push/preferences] error:", err);
      res.status(500).json({ error: err?.message || "Failed to load preferences" });
    }
  });

  // POST /api/push/lead — set which lead times (minutes before kickoff) to
  // remind at, applied to all of this person's devices.
  app.post("/api/push/lead", requireGroup, async (req, res) => {
    try {
      const leads = normalizeLeads(req.body?.leads);
      const { setLeadsForUser } = await import("./push");
      const changed = await setLeadsForUser(req.userId!, leads);
      await logPushEvent(req, "push_lead_changed", { leads });
      res.json({ ok: true, leads, changed });
    } catch (err: any) {
      console.error("[/api/push/lead] error:", err);
      res.status(500).json({ error: err?.message || "Failed to set lead time" });
    }
  });

  // POST /api/push/event — record a push/PWA lifecycle event from the client
  // (permission denied, install needed, error, or PWA launch). Best-effort.
  app.post("/api/push/event", requireGroup, async (req, res) => {
    const allowed = new Set([
      "push_denied",
      "push_blocked",
      "push_error",
      "push_needs_install",
      "push_unsupported",
      "pwa_launch",
    ]);
    const type = String(req.body?.type ?? "");
    if (!allowed.has(type)) return res.status(400).json({ error: "Unknown event type" });
    await logPushEvent(req, type, req.body?.detail);
    res.json({ ok: true });
  });

  // GET /api/admin/notifications — owner view of who's set up reminders / the
  // PWA, and who tried but didn't (denied, needs install, errored). Aggregated
  // per person (login code) since a subscription made in one group covers them
  // everywhere. Admin-key gated.
  app.get("/api/admin/notifications", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { db } = await import("./db");
      const { users, groups, pushSubscriptions, activityLogs } = await import("@shared/schema");
      const { inArray, desc } = await import("drizzle-orm");

      const allUsers = await db.select().from(users);
      const allGroups = await db.select().from(groups);
      const groupName = new Map(allGroups.map((g) => [g.id, g.name]));
      const userById = new Map(allUsers.map((u) => [u.id, u]));
      const personKey = (u: { loginCode: string | null; id: number }) =>
        u.loginCode ? `c:${u.loginCode}` : `u:${u.id}`;

      const subs = await db.select().from(pushSubscriptions);
      const pushTypes = [
        "push_enabled",
        "push_disabled",
        "push_denied",
        "push_blocked",
        "push_error",
        "push_needs_install",
        "push_unsupported",
        "pwa_launch",
        "push_lead_changed",
      ];
      const events = await db
        .select({
          type: activityLogs.type,
          userId: activityLogs.userId,
          createdAt: activityLogs.createdAt,
          userAgent: activityLogs.userAgent,
        })
        .from(activityLogs)
        .where(inArray(activityLogs.type, pushTypes))
        .orderBy(desc(activityLogs.createdAt));

      type Row = {
        person: string;
        userIds: Set<number>;
        names: Set<string>;
        groups: Map<number, string>;
        remindersOn: boolean;
        deviceCount: number;
        leads: Set<number>;
        devices: { userAgent: string | null; leads: number[]; createdAt: Date }[];
        pwaLastAt: Date | null;
        lastAttempt: { type: string; at: Date } | null;
        lastEnabledAt: Date | null;
      };
      const rows = new Map<string, Row>();
      const ensure = (u: { loginCode: string | null; id: number; username: string; groupId: number }) => {
        const key = personKey(u);
        let r = rows.get(key);
        if (!r) {
          r = {
            person: key,
            userIds: new Set(),
            names: new Set(),
            groups: new Map(),
            remindersOn: false,
            deviceCount: 0,
            leads: new Set(),
            devices: [],
            pwaLastAt: null,
            lastAttempt: null,
            lastEnabledAt: null,
          };
          rows.set(key, r);
        }
        r.userIds.add(u.id);
        r.names.add(u.username);
        r.groups.set(u.groupId, groupName.get(u.groupId) ?? `#${u.groupId}`);
        return r;
      };
      for (const u of allUsers) ensure(u);

      for (const s of subs) {
        const u = userById.get(s.userId);
        if (!u) continue;
        const r = ensure(u);
        r.remindersOn = true;
        r.deviceCount += 1;
        const leads = s.reminderLeadsMinutes ?? [];
        for (const m of leads) r.leads.add(m);
        r.devices.push({ userAgent: s.userAgent, leads, createdAt: s.createdAt });
      }

      const attemptTypes = new Set([
        "push_denied",
        "push_blocked",
        "push_error",
        "push_needs_install",
        "push_unsupported",
      ]);
      for (const e of events) {
        if (e.userId == null) continue;
        const u = userById.get(e.userId);
        if (!u) continue;
        const r = ensure(u);
        if (e.type === "pwa_launch") {
          if (!r.pwaLastAt || e.createdAt > r.pwaLastAt) r.pwaLastAt = e.createdAt;
        } else if (e.type === "push_enabled") {
          if (!r.lastEnabledAt || e.createdAt > r.lastEnabledAt) r.lastEnabledAt = e.createdAt;
        } else if (attemptTypes.has(e.type)) {
          if (!r.lastAttempt || e.createdAt > r.lastAttempt.at) {
            r.lastAttempt = { type: e.type, at: e.createdAt };
          }
        }
      }

      const out = Array.from(rows.values())
        .map((r) => ({
          name: Array.from(r.names).sort().join(" / "),
          userIds: Array.from(r.userIds),
          groups: Array.from(r.groups.entries())
            .map(([id, name]) => ({ id, name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
          remindersOn: r.remindersOn,
          deviceCount: r.deviceCount,
          leads: Array.from(r.leads).sort((a, b) => a - b),
          devices: r.devices,
          usedPwa: r.pwaLastAt != null,
          pwaLastAt: r.pwaLastAt,
          lastEnabledAt: r.lastEnabledAt,
          lastAttempt: r.lastAttempt,
        }))
        // Most interesting first: reminders on, then those who tried, then rest.
        .sort((a, b) => {
          const score = (x: typeof a) => (x.remindersOn ? 2 : x.lastAttempt ? 1 : 0);
          return score(b) - score(a) || a.name.localeCompare(b.name);
        });
      res.json(out);
    } catch (err: any) {
      console.error("[/api/admin/notifications] error:", err);
      res.status(500).json({ error: err?.message || "Failed to load notifications" });
    }
  });

  // All user-row ids belonging to the same person as `userId` (shared login code).
  async function siblingIdsOf(userId: number): Promise<number[]> {
    const { db } = await import("./db");
    const { users } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(users).where(eq(users.id, userId));
    if (!row?.loginCode) return [userId];
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.loginCode, row.loginCode));
    return rows.length ? rows.map((r) => r.id) : [userId];
  }

  // POST /api/admin/test-push — send a sample reminder to a person's devices so
  // the owner can preview what a notification looks like. Body: { userId }.
  app.post("/api/admin/test-push", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const userId = Number(req.body?.userId);
      if (!Number.isFinite(userId)) return res.status(400).json({ error: "userId required" });
      const { sendToUser } = await import("./push");
      const sent = await sendToUser(userId, {
        title: "Fairweathermen — test reminder",
        body: "This is a test. Your kickoff reminders are working ⚽",
        url: "/",
        tag: "test-push",
      });
      res.json({ ok: true, sent });
    } catch (err: any) {
      console.error("[/api/admin/test-push] error:", err);
      res.status(500).json({ error: err?.message || "Failed to send test" });
    }
  });

  // POST /api/admin/notifications/reset — wipe a person's push subscriptions and
  // their push/PWA event log (e.g. to clear your own testing). Body: { userId }.
  app.post("/api/admin/notifications/reset", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const userId = Number(req.body?.userId);
      if (!Number.isFinite(userId)) return res.status(400).json({ error: "userId required" });
      const { db } = await import("./db");
      const { pushSubscriptions, activityLogs } = await import("@shared/schema");
      const { and, inArray } = await import("drizzle-orm");
      const ids = await siblingIdsOf(userId);
      const pushEventTypes = [
        "push_enabled",
        "push_disabled",
        "push_denied",
        "push_blocked",
        "push_error",
        "push_needs_install",
        "push_unsupported",
        "pwa_launch",
        "push_lead_changed",
      ];
      await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.userId, ids));
      await db
        .delete(activityLogs)
        .where(and(inArray(activityLogs.userId, ids), inArray(activityLogs.type, pushEventTypes)));
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[/api/admin/notifications/reset] error:", err);
      res.status(500).json({ error: err?.message || "Failed to reset" });
    }
  });

  // POST /api/admin/activity/delete — delete activity-log entries by id (from the
  // /activity page). Body: { ids: number[] }.
  app.post("/api/admin/activity/delete", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map(Number).filter((n: number) => Number.isFinite(n))
        : [];
      if (ids.length === 0) return res.status(400).json({ error: "ids required" });
      const { db } = await import("./db");
      const { activityLogs } = await import("@shared/schema");
      const { inArray } = await import("drizzle-orm");
      await db.delete(activityLogs).where(inArray(activityLogs.id, ids));
      res.json({ ok: true, deleted: ids.length });
    } catch (err: any) {
      console.error("[/api/admin/activity/delete] error:", err);
      res.status(500).json({ error: err?.message || "Failed to delete" });
    }
  });

  // POST /api/group/switch — { groupId } → switches the active group for a
  // logged-in person who belongs to more than one group. Verifies (via their
  // shared login code) that they actually have a row in the target group, then
  // re-points the session cookie at that group's user row.
  app.post("/api/group/switch", async (req, res) => {
    try {
      if (!req.userId) return res.status(401).json({ error: "Not logged in" });
      const targetGroupId = Number(req.body?.groupId);
      if (!Number.isFinite(targetGroupId)) {
        return res.status(400).json({ error: "groupId must be a number" });
      }
      const { db } = await import("./db");
      const { users } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const [current] = await db.select().from(users).where(eq(users.id, req.userId));
      if (!current || !current.loginCode) {
        clearUserCookie(res);
        return res.status(401).json({ error: "Stale cookie" });
      }
      const session = await buildSession(current.loginCode, targetGroupId);
      if (!session) return res.status(404).json({ error: "Unknown session" });
      if (session.activeRow.groupId !== targetGroupId) {
        return res.status(403).json({ error: "You don't belong to that group" });
      }
      setUserCookie(res, session.activeRow.id, session.activeRow.groupId);
      res.json(session.payload);
    } catch (err: any) {
      console.error("[/api/group/switch] error:", err);
      res.status(500).json({ error: err?.message || "Switch failed" });
    }
  });

  // GET /api/group/me — returns the logged-in person + their active group +
  // the groups they can switch between, or 401.
  app.get("/api/group/me", async (req, res) => {
    if (!req.groupId || !req.userId) return res.status(401).json({ error: "Not logged in" });
    const { db } = await import("./db");
    const { users } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await db.select().from(users).where(eq(users.id, req.userId));
    if (!user || !user.loginCode || user.groupId !== req.groupId) {
      clearUserCookie(res);
      return res.status(401).json({ error: "Stale cookie" });
    }
    const session = await buildSession(user.loginCode, req.groupId);
    if (!session) {
      clearUserCookie(res);
      return res.status(401).json({ error: "Stale cookie" });
    }
    res.json(session.payload);
  });

  // Activity logging middleware for all page visits
  app.use(async (req, res, next) => {
    try {
      // Skip logging for API calls and static files (anything with a file
      // extension: scripts, styles, images like /icons/logo.webp, the PWA
      // manifest and service worker). A browser loading or prefetching one of
      // those directly carries the cookie, so it otherwise showed up as a bogus
      // "page visit".
      if (req.path.startsWith('/api/') || isStaticAssetPath(req.path) || req.path.includes('/@')) {
        return next();
      }

      const realIP = getRealIP(req);
      const location = getLocationFromIP(realIP);

      // Browsers speculatively preload/prerender frequently-visited sites — e.g.
      // Safari/Chrome fetching "/" in the background when you open a new tab or
      // type in the address bar. Those requests carry the person's cookie, so
      // they'd otherwise be logged as genuine "Home" visits nobody actually made
      // (this is why /activity fills with phantom Home rows). We detect them from
      // the request's fetch-metadata headers, record the raw values so we can
      // measure how many there are, and tag them `speculative` so the /activity
      // feed can hide them by default.
      const secPurpose = (req.get('Sec-Purpose') || req.get('Purpose') || '').toLowerCase();
      const xPurpose = (req.get('X-Purpose') || req.get('X-Moz') || '').toLowerCase();
      const secFetchMode = req.get('Sec-Fetch-Mode') || null;
      const secFetchDest = req.get('Sec-Fetch-Dest') || null;
      const secFetchSite = req.get('Sec-Fetch-Site') || null;
      const speculative =
        secPurpose.includes('prefetch') ||
        secPurpose.includes('prerender') ||
        xPurpose.includes('prefetch') ||
        xPurpose.includes('preview') ||
        xPurpose.includes('instant');

      // First real page load from this browser → give it a visitor id and log
      // a `new_visitor` (shown on /admin/growth). Existing players who simply
      // predate the cookie are already logged in, so they get an id silently
      // rather than being counted as new. Prefetches and bots are ignored.
      let vid: string | null = null;
      if (req.method === 'GET' && !speculative && !isBotUserAgent(req.get('User-Agent'))) {
        const visitor = ensureVisitorId(req, res);
        vid = visitor.vid;
        if (visitor.isNew && !req.userId) {
          const utm = Object.fromEntries(
            Object.entries(req.query).filter(([k]) => k.startsWith('utm_')),
          );
          await logGrowthEvent(req, 'new_visitor', {
            details: {
              vid,
              landingPath: req.path,
              referrer: req.get('Referer') || null,
              ...(Object.keys(utm).length ? { utm } : {}),
            },
          });
        }
      }

      // Log the activity — groupId is the cookie's group (null pre-login).
      await storage.createActivityLog({
        type: 'page_visit',
        userId: req.userId ?? null, // logged-in user from the group cookie (null pre-login)
        ipAddress: realIP,
        userAgent: req.get('User-Agent') || null,
        city: location.city,
        country: location.country,
        path: req.path,
        details: JSON.stringify({
          method: req.method,
          query: req.query,
          vid,
          speculative,
          secPurpose: secPurpose || null,
          secFetchMode,
          secFetchDest,
          secFetchSite,
        }),
        groupId: req.groupId ?? null,
      } as any);
    } catch (error) {
      console.error('Error logging activity:', error);
    }
    next();
  });
  
  // Initialize teams
  const initTeams = async () => {
    const teams = [
      { name: "Arsenal", shortName: "ARS" },
      { name: "Aston Villa", shortName: "AVL" },
      { name: "Bournemouth", shortName: "BOU" },
      { name: "Brentford", shortName: "BRE" },
      { name: "Brighton", shortName: "BHA" },
      { name: "Burnley", shortName: "BUR" },
      { name: "Chelsea", shortName: "CHE" },
      { name: "Crystal Palace", shortName: "CRY" },
      { name: "Everton", shortName: "EVE" },
      { name: "Fulham", shortName: "FUL" },
      { name: "Leeds", shortName: "LEE" },
      { name: "Liverpool", shortName: "LIV" },
      { name: "Manchester City", shortName: "MCI" },
      { name: "Manchester United", shortName: "MUN" },
      { name: "Newcastle", shortName: "NEW" },
      { name: "Nottingham Forest", shortName: "NFO" },
      { name: "Sunderland", shortName: "SUN" },
      { name: "Tottenham", shortName: "TOT" },
      { name: "West Ham", shortName: "WHU" },
      { name: "Wolves", shortName: "WOL" },
    ];
    
    for (const team of teams) {
      const existingTeam = await storage.getTeamByName(team.name);
      if (!existingTeam) {
        await storage.createTeam(team);
      }
    }
  };

  // Initialize teams on server start
  await initTeams();
  
  // Initialize sample predictions for users to simulate the app
  const initSampleData = async () => {
    // Check if we already have matches
    const existingMatches = await storage.getAllMatches();
    if (existingMatches.length > 0) {
      return;
    }
    
    // Premier League matches for Sunday May 25, 2025
    const matches = [
      {
        homeTeamName: "Bournemouth",
        awayTeamName: "Leicester",
        matchTime: "16:00",
        matchDay: "2025-05-25",
        status: "not_started"
      },
      {
        homeTeamName: "Fulham",
        awayTeamName: "Manchester City",
        matchTime: "16:00",
        matchDay: "2025-05-25",
        status: "not_started"
      },
      {
        homeTeamName: "Ipswich",
        awayTeamName: "West Ham",
        matchTime: "16:00",
        matchDay: "2025-05-25",
        status: "not_started"
      },
      {
        homeTeamName: "Liverpool",
        awayTeamName: "Crystal Palace",
        matchTime: "16:00",
        matchDay: "2025-05-25",
        status: "not_started"
      },
      {
        homeTeamName: "Manchester United",
        awayTeamName: "Aston Villa",
        matchTime: "16:00",
        matchDay: "2025-05-25",
        status: "not_started"
      },
      {
        homeTeamName: "Newcastle",
        awayTeamName: "Everton",
        matchTime: "16:00",
        matchDay: "2025-05-25",
        status: "not_started"
      },
      {
        homeTeamName: "Nottingham Forest",
        awayTeamName: "Chelsea",
        matchTime: "16:00",
        matchDay: "2025-05-25",
        status: "not_started"
      },
      {
        homeTeamName: "Southampton",
        awayTeamName: "Arsenal",
        matchTime: "16:00",
        matchDay: "2025-05-25",
        status: "not_started"
      },
      {
        homeTeamName: "Tottenham",
        awayTeamName: "Brighton",
        matchTime: "16:00",
        matchDay: "2025-05-25",
        status: "not_started"
      },
      {
        homeTeamName: "Wolves",
        awayTeamName: "Brentford",
        matchTime: "16:00",
        matchDay: "2025-05-25",
        status: "not_started"
      },
    ];
    
    // Create matches
    for (const match of matches) {
      const homeTeam = await storage.getTeamByName(match.homeTeamName);
      const awayTeam = await storage.getTeamByName(match.awayTeamName);
      
      if (homeTeam && awayTeam) {
        const newMatch = await storage.createMatch({
          homeTeamId: homeTeam.id,
          awayTeamId: awayTeam.id,
          status: match.status,
          matchTime: match.matchTime,
          matchDay: match.matchDay,
          homeScore: match.status === "in_progress" ? Math.floor(Math.random() * 3) : undefined,
          awayScore: match.status === "in_progress" ? Math.floor(Math.random() * 2) : undefined,
        });
        
        // Create predictions for all users
        const users = await storage.getAllUsers();
        for (const user of users) {
          await storage.createPrediction({
            userId: user.id,
            matchId: newMatch.id,
            homeScore: Math.floor(Math.random() * 4),
            awayScore: Math.floor(Math.random() * 3),
          });
        }
      }
    }
  };
  
  // Initialize sample data
  await initSampleData();
  
  // Manual score updates - you'll provide live scores as matches progress

  // API Routes
  
  // POST /api/matches/:id/score - Update match score manually
  app.post("/api/matches/:id/score", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const matchId = parseInt(req.params.id);
      const updateSchema = z.object({
        homeScore: z.number().min(0),
        awayScore: z.number().min(0),
        status: z.enum(['not_started', 'in_progress', 'completed']).optional()
      });
      
      const { homeScore, awayScore, status } = updateSchema.parse(req.body);
      
      const updatedMatch = await storage.updateMatch(matchId, {
        homeScore,
        awayScore,
        status: status || 'in_progress'
      });
      
      if (!updatedMatch) {
        return res.status(404).json({ error: "Match not found" });
      }
      
      res.json({ success: true, match: updatedMatch });
    } catch (error) {
      res.status(400).json({ error: "Invalid request data" });
    }
  });
  
  // GET /api/teams - Get all teams
  app.get("/api/teams", async (req, res) => {
    try {
      const teams = await storage.getAllTeams();
      res.json(teams);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch teams" });
    }
  });
  
  // GET /api/matches - Get all matches with team details (optionally filtered by gameweek)
  app.get("/api/matches", async (req, res) => {
    try {
      const allSeasons = req.query.all === "1" || req.query.all === "true";
      let allMatches = await storage.getAllMatchesWithTeams(allSeasons);
      if (req.query.gameweek) {
        const gw = parseInt(req.query.gameweek as string);
        allMatches = allMatches.filter(m => m.gameweek === gw);
      }
      res.json(allMatches);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch matches" });
    }
  });
  
  // GET /api/matches/:id - Get a specific match with team details
  app.get("/api/matches/:id", async (req, res) => {
    try {
      const matchId = parseInt(req.params.id);
      const match = await storage.getMatchWithTeams(matchId);
      
      if (!match) {
        return res.status(404).json({ error: "Match not found" });
      }
      
      res.json(match);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch match" });
    }
  });
  
  // GET /api/users - Get users for the caller's group only
  app.get("/api/users", async (req, res) => {
    try {
      const all = await storage.getAllUsers();
      // Always filter by group — req.groupId is set by requireGroup middleware.
      const users = all.filter((u: any) => u.groupId === req.groupId);
      res.json(users);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });
  
  // Keep other players' Lawro picks secret until they're revealed. Shared by
  // every endpoint that returns predictions, so none of them can be used to
  // read a groupmate's scoreline before the deadline.
  //
  // Keep other players' scorelines secret until each gameweek's deadline (its
  // first kickoff) passes — otherwise they could be read straight off the
  // network response. We still reveal *that* a pick exists (so the grid can
  // show who has and hasn't submitted), just not the score: a pre-deadline
  // pick from another player is redacted to { hidden: true } with no
  // homeScore/awayScore. Your own picks are always returned in full; everyone's
  // scorelines appear once the deadline is up. (Finished-match points are
  // unaffected — a match only finishes well after its deadline.)
  async function redactUnrevealedPredictions(
    predictions: any[],
    _groupId: number | undefined,
    viewerId: number | undefined,
  ): Promise<any[]> {
    const { londonStringToUtcMs } = await import("@shared/time");
    const allMatches = await storage.getAllMatchesWithTeams();
    const deadlineByGw = new Map<number, number>();
    for (const m of allMatches) {
      if (m.gameweek == null) continue;
      const ko = londonStringToUtcMs(m.matchTime);
      if (Number.isNaN(ko)) continue;
      const cur = deadlineByGw.get(m.gameweek);
      if (cur == null || ko < cur) deadlineByGw.set(m.gameweek, ko);
    }
    const now = Date.now();
    return predictions.map((p) => {
      if (p.userId === viewerId) return p;
      const gw = p.match?.gameweek;
      const dl = gw != null ? deadlineByGw.get(gw) : undefined;
      if (dl != null && now >= dl) return p;
      // Redacted: keep who/which match (for the submitted/not view), drop the
      // scoreline and any derived fields.
      return { id: p.id, userId: p.userId, matchId: p.matchId, hidden: true, match: p.match } as any;
    });
  }

  // GET /api/users/:id/predictions - Get a user's predictions with match details
  app.get("/api/users/:id/predictions", async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      // Only expose predictions for players in the caller's group.
      const { userInGroup } = await import("./groupAuth");
      if (!req.groupId || !(await userInGroup(userId, req.groupId))) {
        return res.status(403).json({ error: "That player isn't in your group" });
      }
      const predictions = await storage.getUserPredictionsWithMatches(userId);
      res.json(await redactUnrevealedPredictions(predictions, req.groupId, req.userId));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch user predictions" });
    }
  });
  
  // GET /api/predictions - Get the caller's group's predictions with optimized query
  app.get("/api/predictions", requireGroup, async (req, res) => {
    try {
      const startTime = Date.now();
      // Import optimized functions
      const { getOptimizedPredictionsWithMatches } = await import('./optimizedQueries');
      // Scope to the caller's group — the Prediction League ("Lawro") is
      // per-group, so a group only sees its own members' predictions.
      const predictions = await getOptimizedPredictionsWithMatches(req.groupId);

      const result = await redactUnrevealedPredictions(predictions, req.groupId, req.userId);

      const timeElapsed = Date.now() - startTime;
      console.log(`Predictions API response time: ${timeElapsed}ms`);
      res.json(result);
    } catch (error) {
      console.error("Error fetching predictions:", error);
      res.status(500).json({ error: "Failed to fetch predictions" });
    }
  });

  // GET /api/leaderboard - Group-scoped leaderboard with points using optimized query
  app.get("/api/leaderboard", requireGroup, async (req, res) => {
    try {
      const startTime = Date.now();
      // Import optimized functions
      const { getOptimizedLeaderboard } = await import('./optimizedQueries');
      const leaderboard = await getOptimizedLeaderboard(req.groupId);
      const timeElapsed = Date.now() - startTime;
      console.log(`Leaderboard API response time: ${timeElapsed}ms`);
      res.json(leaderboard);
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
      res.status(500).json({ error: "Failed to fetch leaderboard" });
    }
  });
  
  // Admin API - Get visitor statistics
  app.get("/api/admin/visitors", getVisitorStats);
  
  // Delete visitor entry from admin panel
  app.delete("/api/admin/visitors/:id", async (req, res) => {
    try {
      // Check API key
      const apiKey = req.headers['x-api-key'] as string;
      if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'Invalid visitor ID' });
      }
      
      // Import required modules
      const { eq } = await import("drizzle-orm");
      const { db } = await import("./db");
      const { visitors } = await import("@shared/schema");
      
      console.log(`Attempting to delete visitor with ID: ${id}`);
      
      // Execute the delete operation
      const result = await db.delete(visitors).where(eq(visitors.id, id));
      console.log('Delete operation result:', result);
      
      // Success response
      return res.status(200).json({ 
        success: true, 
        message: `Visitor with ID ${id} deleted successfully` 
      });
    } catch (error) {
      console.error('Error deleting visitor:', error);
      return res.status(500).json({ 
        error: 'Failed to delete visitor',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  // Update screen resolution from client
  app.post("/api/track/resolution", updateScreenResolution);
  
  // POST /api/scraper/run - Manually trigger score scraping from Flashscore
  app.post("/api/scraper/run", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      console.log('Manual scraper trigger requested');
      await runScraper(storage);
      res.json({ success: true, message: "Scraper completed successfully" });
    } catch (error) {
      console.error('Manual scraper error:', error);
      res.status(500).json({ error: "Scraper failed", details: error instanceof Error ? error.message : 'Unknown error' });
    }
  });
  
  // POST /api/teams - Create a new team
  app.post("/api/teams", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const teamData = insertTeamSchema.parse(req.body);
      const team = await storage.createTeam(teamData);
      res.status(201).json(team);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to create team" });
    }
  });
  
  // POST /api/matches - Create a new match
  app.post("/api/matches", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const matchData = insertMatchSchema.parse(req.body);
      const match = await storage.createMatch(matchData);
      res.status(201).json(match);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to create match" });
    }
  });
  
  // PATCH /api/matches/:id - Update a match
  app.patch("/api/matches/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const matchId = parseInt(req.params.id);
      const matchUpdate = req.body;
      
      const updatedMatch = await storage.updateMatch(matchId, matchUpdate);
      
      if (!updatedMatch) {
        return res.status(404).json({ error: "Match not found" });
      }
      
      res.json(updatedMatch);
    } catch (error) {
      res.status(500).json({ error: "Failed to update match" });
    }
  });
  
  // POST /api/predictions - Create a new prediction
  app.post("/api/predictions", async (req, res) => {
    try {
      const predictionData = insertPredictionSchema.parse(req.body);

      // A person may only create their own predictions. req.userId is the
      // logged-in person's row in the active group (set from the cookie), so
      // this also confines writes to the caller's group.
      if (predictionData.userId !== req.userId) {
        return res.status(403).json({ error: "You can only edit your own predictions" });
      }

      // The Prediction League must be enabled for the caller in their active
      // group. A multi-group user whose /lawro page is still mounted after
      // switching into a group with no Prediction League would otherwise save
      // predictions into that wrong group (predictions have no groupId of their
      // own — the group is derived from the user's active row).
      if (
        req.userId == null ||
        req.groupId == null ||
        !(await userGameEnabled(req.userId, req.groupId, "predictions"))
      ) {
        return res
          .status(403)
          .json({ error: "The Prediction League is not enabled for your current group" });
      }

      // Check if user already has a prediction for this match
      const existingPrediction = await storage.getPredictionByUserAndMatch(
        predictionData.userId, 
        predictionData.matchId
      );
      
      if (existingPrediction) {
        return res.status(400).json({ error: "User already has a prediction for this match" });
      }
      
      // Get the match so we can check the gameweek deadline.
      const match = await storage.getMatch(predictionData.matchId);

      if (!match) {
        return res.status(404).json({ error: "Match not found" });
      }

      // The whole gameweek locks at its deadline (the first kickoff). After that
      // point missed picks are auto-randomised, so no manual edits are allowed.
      if (await gameweekLocked(match.gameweek, req.groupId)) {
        return res.status(403).json({ error: "Predictions are locked - the gameweek deadline has passed" });
      }

      // Manual picks are never flagged auto, regardless of what the client sent.
      const prediction = await storage.createPrediction({ ...predictionData, isAutoPick: false });
      const { logAuditEvent } = await import("./groupAuth");
      await logAuditEvent(req, {
        type: "prediction_set",
        userId: predictionData.userId,
        details: {
          matchId: predictionData.matchId,
          homeScore: predictionData.homeScore,
          awayScore: predictionData.awayScore,
        },
      });
      res.status(201).json(prediction);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      res.status(500).json({ error: "Failed to create prediction" });
    }
  });

  // PATCH /api/predictions/:id - Update an existing prediction
  app.patch("/api/predictions/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { homeScore, awayScore } = req.body;

      if (typeof homeScore !== 'number' || typeof awayScore !== 'number') {
        return res.status(400).json({ error: "homeScore and awayScore must be numbers" });
      }

      const existing = await storage.getPrediction(id);
      if (!existing) {
        return res.status(404).json({ error: "Prediction not found" });
      }

      // Only the owner may edit their own prediction.
      if (existing.userId !== req.userId) {
        return res.status(403).json({ error: "You can only edit your own predictions" });
      }

      // The Prediction League must be enabled for the caller in their active
      // group (see POST /api/predictions for why).
      if (
        req.userId == null ||
        req.groupId == null ||
        !(await userGameEnabled(req.userId, req.groupId, "predictions"))
      ) {
        return res
          .status(403)
          .json({ error: "The Prediction League is not enabled for your current group" });
      }

      // The gameweek deadline (first kickoff) locks all of its matches.
      const match = await storage.getMatch(existing.matchId);
      if (!match) {
        return res.status(404).json({ error: "Match not found" });
      }

      if (await gameweekLocked(match.gameweek, req.groupId)) {
        return res.status(403).json({ error: "Predictions are locked - the gameweek deadline has passed" });
      }

      const updated = await storage.updatePrediction(id, homeScore, awayScore);
      const { logAuditEvent } = await import("./groupAuth");
      await logAuditEvent(req, {
        type: "prediction_change",
        userId: existing.userId,
        details: { matchId: existing.matchId, homeScore, awayScore },
      });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: "Failed to update prediction" });
    }
  });

  // DELETE /api/predictions/:id - Delete an existing prediction
  app.delete("/api/predictions/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);

      const existing = await storage.getPrediction(id);
      if (!existing) {
        return res.status(404).json({ error: "Prediction not found" });
      }

      // Only the owner may delete their own prediction.
      if (existing.userId !== req.userId) {
        return res.status(403).json({ error: "You can only edit your own predictions" });
      }

      // The Prediction League must be enabled for the caller in their active
      // group (see POST /api/predictions for why).
      if (
        req.userId == null ||
        req.groupId == null ||
        !(await userGameEnabled(req.userId, req.groupId, "predictions"))
      ) {
        return res
          .status(403)
          .json({ error: "The Prediction League is not enabled for your current group" });
      }

      const match = await storage.getMatch(existing.matchId);
      if (!match) {
        return res.status(404).json({ error: "Match not found" });
      }

      if (await gameweekLocked(match.gameweek, req.groupId)) {
        return res.status(403).json({ error: "Predictions are locked - the gameweek deadline has passed" });
      }

      await storage.deletePrediction(id);
      const { logAuditEvent } = await import("./groupAuth");
      await logAuditEvent(req, {
        type: "prediction_delete",
        userId: existing.userId,
        details: { matchId: existing.matchId },
      });
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete prediction" });
    }
  });

  // PUT /api/predictions/:id/joker - Make this prediction the caller's Joker
  // for its gameweek ({ joker: true }), or take the Joker off it ({ joker:
  // false }). Only under the Lawro Joker rule, and only while the gameweek is
  // still open (before the deadline), so the Joker can't be shifted onto a
  // match once the result is being played out.
  app.put("/api/predictions/:id/joker", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const joker = req.body?.joker;
      if (typeof joker !== "boolean") {
        return res.status(400).json({ error: "joker must be true or false" });
      }

      const existing = await storage.getPrediction(id);
      if (!existing) {
        return res.status(404).json({ error: "Prediction not found" });
      }
      if (existing.userId !== req.userId) {
        return res.status(403).json({ error: "You can only edit your own predictions" });
      }
      if (
        req.userId == null ||
        req.groupId == null ||
        !(await userGameEnabled(req.userId, req.groupId, "predictions"))
      ) {
        return res
          .status(403)
          .json({ error: "The Prediction League is not enabled for your current group" });
      }

      const match = await storage.getMatch(existing.matchId);
      if (!match || match.gameweek == null) {
        return res.status(404).json({ error: "Match not found" });
      }
      // The Joker is only available when the rule was on for this gameweek.
      const { getLawroRulesResolver } = await import("./groupRules");
      const rules = (await getLawroRulesResolver(req.groupId))(match.season, match.gameweek);
      if (!rules.jokerEnabled) {
        return res.status(400).json({ error: "The Joker isn't on for this gameweek" });
      }

      // The whole gameweek locks together at its deadline, so once this match is
      // locked the Joker can neither move onto it nor off any pick in the week.
      if (await gameweekLocked(match.gameweek, req.groupId)) {
        return res.status(403).json({ error: "That match is locked, so your Joker can't change" });
      }

      // Setting a new Joker clears any the player already has elsewhere in the
      // gameweek, so pass the gameweek's match ids for the server to scope that.
      const gwMatches = (await storage.getMatchesByGameweek(match.gameweek)).filter(
        (m) => (m.season ?? null) === (match.season ?? null),
      );
      const gwMatchIds = gwMatches.map((m) => m.id);

      await storage.setPredictionJoker(req.userId, id, joker, gwMatchIds);
      const { logAuditEvent } = await import("./groupAuth");
      await logAuditEvent(req, {
        type: "prediction_joker",
        userId: existing.userId,
        details: { matchId: existing.matchId, joker },
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to set the Joker" });
    }
  });

  // Last Man Standing API routes
  
  // GET /api/lms/current-competition - Get current active competition with participants and selections
  app.get("/api/lms/current-competition", async (req, res) => {
    try {
      let competition = await storage.getCurrentLmsCompetition(req.groupId);
      if (!competition) {
        // No active competition — fall back to the most recent comp in the latest season
        const allComps = await storage.getAllLmsCompetitions(req.groupId);
        const latestSeason = allComps
          .map((c: any) => c.season || "2025/2026")
          .sort()
          .reverse()[0];
        const sorted = allComps
          .filter((c: any) => (c.season || "2025/2026") === latestSeason)
          .sort((a: any, b: any) => b.id - a.id);
        competition = sorted[0] || null;
      }
      if (!competition) {
        // Return 200 + null rather than 404 so the client's React Query
        // doesn't bounce in/out of error state every refetch (which caused
        // the LMS tabs to flicker for groups with no LMS data yet).
        return res.json(null);
      }

      const participants = await storage.getLmsParticipantsByCompetition(competition.id);
      console.log(`[LMS DEBUG] Found ${participants.length} participants:`, participants.map(p => `id:${p.id}, userId:${p.userId}`));

      // Sort participants by original order (Alex first, then others by user ID)
      const sortedParticipants = participants.sort((a, b) => {
        // Get user names to determine order
        return a.userId - b.userId; // Keep original insertion order
      });

      // Keep other players' picks for the current gameweek secret until it locks
      // (its first kickoff), the same as Lawro — otherwise they'd be readable off
      // the network response. We still reveal *that* a pick exists (teamId nulled,
      // hidden: true) so the grid can show who's picked. Your own pick is always
      // shown, and every past/locked gameweek is shown for everyone.
      const currentGameweek = competition.currentGameweek;
      const currentRules = await getGroupRules(competition.groupId);
      const currentLocked = await isGameweekLocked(
        currentGameweek,
        currentRules.lms.deadlineMinutesBeforeKickoff,
      );

      const competitionWithDetails = {
        ...competition,
        participants: await Promise.all(sortedParticipants.map(async (participant) => {
          const user = await storage.getUser(participant.userId);
          const selections = await storage.getLmsSelectionsByParticipant(participant.id);
          const isMine = participant.userId === req.userId;
          // Transform database field names to camelCase for frontend
          const transformedSelections = selections.map(selection => {
            const base = {
              ...selection,
              isRandomlyAssigned: selection.isRandomlyAssigned || (selection as any).is_randomly_assigned,
            };
            if (!currentLocked && !isMine && selection.gameweek === currentGameweek) {
              return { ...base, teamId: null, hidden: true };
            }
            return base;
          });
          return {
            ...participant,
            user,
            selections: transformedSelections
          };
        })),
        currentRound: competition.currentGameweek,
        activeParticipants: participants.filter(p => p.isActive === 'true').length
      };
      
      res.json(competitionWithDetails);
    } catch (error) {
      console.error("Error fetching current LMS competition:", error);
      res.status(500).json({ error: "Failed to fetch competition" });
    }
  });
  
  // GET /api/lms/competitions - Get all competitions (for history view)
  app.get("/api/lms/competitions", async (req, res) => {
    try {
      const competitions = await storage.getAllLmsCompetitions(req.groupId);
      const competitionsWithDetails = await Promise.all(competitions.map(async (competition) => {
        const participants = await storage.getLmsParticipantsByCompetition(competition.id);
        return {
          ...competition,
          participants: await Promise.all(participants.map(async (participant) => {
            const user = await storage.getUser(participant.userId);
            const selections = await storage.getLmsSelectionsByParticipant(participant.id);
            return {
              ...participant,
              user,
              selections
            };
          })),
          currentRound: competition.currentGameweek,
          activeParticipants: participants.filter(p => p.isActive === 'true').length
        };
      }));
      
      res.json(competitionsWithDetails);
    } catch (error) {
      console.error("Error fetching LMS competitions:", error);
      res.status(500).json({ error: "Failed to fetch competitions" });
    }
  });
  
  // GET /api/lms/available-teams - Get teams available for selection (not used by current user)
  app.get("/api/lms/available-teams", async (req, res) => {
    try {
      // For demo purposes, using user ID 1. In a real app, this would come from authentication
      const userId = 1;
      let competition = await storage.getCurrentLmsCompetition(req.groupId);
      if (!competition) {
        // Fall back to most recent competition
        const allComps = await storage.getAllLmsCompetitions(req.groupId);
        const sorted = allComps.sort((a: any, b: any) => b.id - a.id);
        competition = sorted[0] || null;
      }
      if (!competition) {
        // No competitions exist at all — return empty list rather than 404 to avoid frontend errors
        return res.json([]);
      }
      // If competition is completed, no teams are available for selection
      if (competition.status === 'completed') {
        return res.json([]);
      }
      
      const allTeams = await storage.getAllTeams();
      // Only get matches for the current gameweek - database uses snake_case
      const currentGameweek = (competition as any).current_gameweek || competition.currentGameweek;
      console.log(`[LMS DEBUG] Competition object:`, JSON.stringify(competition));
      console.log(`[LMS DEBUG] Extracted currentGameweek:`, currentGameweek);
      const matches = await storage.getMatchesByGameweek(currentGameweek);

      // The `teams` table retains relegated clubs (e.g. Burnley) for historical
      // data, so it can't be used directly for the selection dropdown. Restrict
      // to clubs that actually feature in the current season's fixtures —
      // getAllMatches() is already season-scoped (filterToCurrentSeason). If no
      // season fixtures exist yet, fall back to all teams so we never render an
      // empty dropdown.
      const seasonMatches = await storage.getAllMatches();
      const currentSeasonTeamIds = new Set<number>();
      for (const m of seasonMatches) {
        if (m.homeTeamId != null) currentSeasonTeamIds.add(m.homeTeamId);
        if (m.awayTeamId != null) currentSeasonTeamIds.add(m.awayTeamId);
      }
      const teams = currentSeasonTeamIds.size > 0
        ? allTeams.filter((t) => currentSeasonTeamIds.has(t.id))
        : allTeams;
      
      // Get user's participant record (if they're participating)
      const participants = await storage.getLmsParticipantsByCompetition(competition.id);
      const userParticipant = participants.find(p => p.userId === userId);
      
      // Get user's previous selections if they're a participant, otherwise empty
      // set. When the group allows reusing teams, nothing is ever "used up", so
      // leave the set empty and every team stays selectable.
      const availRules = await getGroupRules(competition.groupId);
      let usedTeamIds = new Set<number>();
      if (userParticipant && !availRules.lms.allowTeamReuse) {
        const userSelections = await storage.getLmsSelectionsByParticipant(userParticipant.id);
        usedTeamIds = new Set(userSelections.map(s => s.teamId));
      }
      
      // Add match info and mark teams as used/available
      const availableTeams = teams.map(team => {
        const match = matches.find((m: any) => m.homeTeamId === team.id || m.awayTeamId === team.id);
        return {
          ...team,
          match,
          isUsed: usedTeamIds.has(team.id)
        };
      });
      
      console.log(`[LMS DEBUG] available-teams - gameweek: ${currentGameweek}, matches found: ${matches.length}, first match:`, matches[0]);
      console.log(`[LMS DEBUG] available-teams - first team with match:`, availableTeams.find(t => t.match));
      
      res.json(availableTeams);
    } catch (error) {
      console.error("Error fetching available teams:", error);
      res.status(500).json({ error: "Failed to fetch available teams" });
    }
  });
  
  // POST /api/lms/select-team - Make a team selection for a specific participant and gameweek
  app.post("/api/lms/select-team", async (req, res) => {
    try {
      const { teamId, participantId, gameweek } = req.body;

      const competition = await storage.getCurrentLmsCompetition(req.groupId);
      if (!competition) {
        return res.status(404).json({ error: "No active competition found" });
      }

      const selectRules = await getGroupRules(competition.groupId);

      // Check if gameweek is locked (its deadline — the first match's kickoff,
      // brought forward by the group's configured offset — has passed).
      const isLocked = await isGameweekLocked(gameweek, selectRules.lms.deadlineMinutesBeforeKickoff);
      if (isLocked) {
        return res.status(400).json({ error: "Selection period has ended - the first match of this gameweek has already started" });
      }

      // Get the participant record
      const participant = await storage.getLmsParticipant(participantId);
      if (!participant) {
        return res.status(404).json({ error: "Participant not found" });
      }

      // A player can only edit their own selections. The logged-in user (from
      // the session cookie) must own this participant row.
      if (participant.userId !== req.userId) {
        return res.status(403).json({ error: "You can only edit your own selections" });
      }

      if (participant.isActive !== 'true') {
        return res.status(400).json({ error: "Participant is eliminated from competition" });
      }
      
      // Check if team was already used by this participant — unless the group
      // allows reusing teams, in which case repeats are fine.
      const participantSelections = await storage.getLmsSelectionsByParticipant(participantId);
      const teamAlreadyUsed = participantSelections.some(s => s.teamId === teamId);
      if (teamAlreadyUsed && !selectRules.lms.allowTeamReuse) {
        return res.status(400).json({ error: "Team already selected in previous gameweek" });
      }
      
      // Check if participant already made a selection for this gameweek
      const existingSelection = participantSelections.find(s => s.gameweek === gameweek);
      if (existingSelection) {
        // Log the team selection change with geolocation
        const realIP = getRealIP(req);
        const location = getLocationFromIP(realIP);
        
        await storage.createLmsSelectionLog({
          participantId: participantId,
          gameweek: gameweek,
          originalTeamId: existingSelection.teamId, // Store original team
          newTeamId: teamId,
          ipAddress: realIP,
          userAgent: req.get('User-Agent') || null,
          city: location.city,
          country: location.country
        });

        // Also log in activity table
        await storage.createActivityLog({
          type: 'lms_selection_change',
          userId: null,
          ipAddress: realIP,
          userAgent: req.get('User-Agent') || null,
          city: location.city,
          country: location.country,
          path: req.path,
          details: JSON.stringify({
            participantId,
            gameweek,
            originalTeamId: existingSelection.teamId,
            newTeamId: teamId
          })
        });
        
        // Update existing selection instead of creating new one
        const updatedSelection = await storage.updateLmsSelection(existingSelection.id, {
          teamId: teamId,
          matchId: null, // Will be set below
          result: null
        });
        
        // Find relevant match for the selected team
        const matches = await storage.getAllMatches();
        const relevantMatch = matches.find(m => 
          (m.homeTeamId === teamId || m.awayTeamId === teamId) && m.gameweek === gameweek
        );
        
        if (relevantMatch) {
          await storage.updateLmsSelection(existingSelection.id, {
            teamId: teamId,
            matchId: relevantMatch.id,
            result: null
          });
        }
        
        return res.json({ success: true, selection: updatedSelection });
      }
      
      // Find relevant match for the selected team
      const matches = await storage.getAllMatches();
      const relevantMatch = matches.find(m => 
        (m.homeTeamId === teamId || m.awayTeamId === teamId) && m.gameweek === gameweek
      );
      
      // Log the new team selection (no previous team) with geolocation
      const realIP = getRealIP(req);
      const location = getLocationFromIP(realIP);
      
      await storage.createLmsSelectionLog({
        participantId: participantId,
        gameweek: gameweek,
        originalTeamId: null, // No previous selection
        newTeamId: teamId,
        ipAddress: realIP,
        userAgent: req.get('User-Agent') || null,
        city: location.city,
        country: location.country
      });

      // Also log in activity table
      await storage.createActivityLog({
        type: 'lms_selection_new',
        userId: null,
        ipAddress: realIP,
        userAgent: req.get('User-Agent') || null,
        city: location.city,
        country: location.country,
        path: req.path,
        details: JSON.stringify({
          participantId,
          gameweek,
          newTeamId: teamId
        })
      });
      
      // Create the selection
      const selection = await storage.createLmsSelection({
        participantId: participantId,
        gameweek: gameweek,
        teamId: teamId,
        matchId: relevantMatch?.id || null,
        result: null,
        isRandomlyAssigned: 'false'
      });
      
      res.json({ success: true, selection });
    } catch (error) {
      console.error("Error making LMS selection:", error);
      res.status(500).json({ error: "Failed to make selection" });
    }
  });

  // DELETE /api/lms/remove-selection - Remove a team selection for a specific participant and gameweek
  app.post("/api/lms/remove-selection", async (req, res) => {
    try {
      const { participantId, gameweek } = req.body;

      const competition = await storage.getCurrentLmsCompetition(req.groupId);
      if (!competition) {
        return res.status(404).json({ error: "No active competition found" });
      }

      const removeRules = await getGroupRules(competition.groupId);
      const isLocked = await isGameweekLocked(gameweek, removeRules.lms.deadlineMinutesBeforeKickoff);
      if (isLocked) {
        return res.status(400).json({ error: "Selection period has ended" });
      }

      // A player can only edit their own selections.
      const participant = await storage.getLmsParticipant(participantId);
      if (!participant) {
        return res.status(404).json({ error: "Participant not found" });
      }
      if (participant.userId !== req.userId) {
        return res.status(403).json({ error: "You can only edit your own selections" });
      }

      const participantSelections = await storage.getLmsSelectionsByParticipant(participantId);
      const existingSelection = participantSelections.find(s => s.gameweek === gameweek);
      if (!existingSelection) {
        return res.status(404).json({ error: "No selection found for this gameweek" });
      }

      const realIP = getRealIP(req);
      const location = getLocationFromIP(realIP);

      await storage.createLmsSelectionLog({
        participantId,
        gameweek,
        originalTeamId: existingSelection.teamId,
        newTeamId: 0,
        ipAddress: realIP,
        userAgent: req.get('User-Agent') || null,
        city: location.city,
        country: location.country
      });

      await storage.createActivityLog({
        type: 'lms_selection_removed',
        userId: null,
        ipAddress: realIP,
        userAgent: req.get('User-Agent') || null,
        city: location.city,
        country: location.country,
        path: req.path,
        details: JSON.stringify({ participantId, gameweek, removedTeamId: existingSelection.teamId })
      });

      await storage.deleteLmsSelection(existingSelection.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error removing LMS selection:", error);
      res.status(500).json({ error: "Failed to remove selection" });
    }
  });

  // GET /api/admin/lms-selection-logs - Admin endpoint to view team selection logs with human-readable names
  app.get("/api/admin/lms-selection-logs", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const logs = await storage.getLmsSelectionLogs();
      res.json(logs);
    } catch (error) {
      console.error("Error fetching LMS selection logs:", error);
      res.status(500).json({ error: "Failed to fetch selection logs" });
    }
  });

  // GET /api/admin/activity-logs - Admin endpoint to view all site activity logs
  app.get("/api/admin/activity-logs", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const logs = await storage.getActivityLogs(limit);
      res.json(logs);
    } catch (error) {
      console.error("Error fetching activity logs:", error);
      res.status(500).json({ error: "Failed to fetch activity logs" });
    }
  });

  // GET /api/lms/gameweek-status/:gameweek - Check if a gameweek is locked and process random assignments
  app.get("/api/lms/gameweek-status/:gameweek", async (req, res) => {
    try {
      const gameweek = parseInt(req.params.gameweek);

      if (isNaN(gameweek)) {
        return res.status(400).json({ error: "Invalid gameweek number" });
      }

      // The caller's group rules carry the LMS lock offset (minutes before the
      // gameweek's first kickoff that selections lock; default 0).
      const statusRules = await getGroupRules(req.groupId);
      const lockMinutes = statusRules.lms.deadlineMinutesBeforeKickoff;
      const isLocked = await isGameweekLocked(gameweek, lockMinutes);

      // If the gameweek just became locked, apply the caller's group missed-pick
      // rule to its competition (not the newest one across all groups).
      if (isLocked) {
        const competition = await storage.getCurrentLmsCompetition(req.groupId);
        if (competition) {
          const { processMissedLmsPicks } = await import("./autoLmsProcessor");
          await processMissedLmsPicks(competition, gameweek);
        }
      }

      res.json({
        gameweek,
        isLocked,
        lockMinutesBeforeKickoff: lockMinutes,
        message: isLocked ? "Selection period has ended" : "Selection period is active"
      });
    } catch (error) {
      console.error("Error checking gameweek status:", error);
      res.status(500).json({ error: "Failed to check gameweek status" });
    }
  });

  // Set up automatic score scraping every 5 minutes during match days
  // Runs Friday-Monday between 12:00 and 23:00 (covers typical match times)
  // Temporarily disabled to prevent corrupted score data
  // cron.schedule('*/5 12-23 * * 5-1', async () => {
  //   console.log('Running automatic score scraper...');
  //   try {
  //     await runScraper(storage);
  //   } catch (error) {
  //     console.error('Automatic scraper error:', error);
  //   }
  // });
  
  console.log('Score scraper disabled - manual updates only');


  // Import LMS processor
  const { lmsProcessor } = await import('./lmsProcessor');

  // POST /api/football-data/sync-fixtures - One-time/manual sync of fixture times + scores from football-data.org
  app.post("/api/football-data/sync-fixtures", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { syncGameweek } = await import('./footballDataApi');
      const startGw = req.body?.startGameweek ? parseInt(req.body.startGameweek) : 1;
      const endGw = req.body?.endGameweek ? parseInt(req.body.endGameweek) : 38;
      const updateTimes = req.body?.updateTimes !== false;
      const updateScores = req.body?.updateScores === true;

      const results: any[] = [];
      for (let gw = startGw; gw <= endGw; gw++) {
        try {
          const r = await syncGameweek(gw, { updateTimes, updateScores });
          results.push({ gameweek: gw, ...r });
        } catch (e: any) {
          results.push({ gameweek: gw, error: e.message });
        }
        // Stay under 20 calls/min — wait 4s between requests
        await new Promise((r) => setTimeout(r, 4000));
      }
      res.json({ success: true, results });
    } catch (error: any) {
      console.error('[FootballData] Sync fixtures error:', error);
      res.status(500).json({ error: error.message || 'Sync failed' });
    }
  });

  // Add LMS result processing endpoint
  app.post("/api/lms/process-results", requireGroup, async (req, res) => {
    try {
      // Process the caller's group competition (there can be active LMS
      // competitions in more than one group).
      const competition = await storage.getCurrentLmsCompetition(req.groupId);
      if (!competition) {
        return res.json({ success: true, message: "No active LMS competition for this group" });
      }
      await lmsProcessor.processLmsResults(competition);
      res.json({ success: true, message: "LMS results processed successfully" });
    } catch (error) {
      console.error("Error processing LMS results:", error);
      res.status(500).json({ error: "Failed to process LMS results" });
    }
  });
  
  // POST /api/track/page-visit - Track client-side page visits
  app.post("/api/track/page-visit", async (req, res) => {
    try {
      const { path, timestamp, userAgent, referrer, trigger, visible } = req.body;

      const realIP = getRealIP(req);
      const location = getLocationFromIP(realIP);

      // Distinguish a real navigation from a "passive" visit the person didn't
      // actively make: the app re-records a visit whenever its tab is brought
      // back to the foreground (`trigger: "foreground"`), and on iOS these fire
      // every time someone returns to Safari with the site as the open tab —
      // producing phantom "Home" visits. We also treat a load that happens while
      // the tab is hidden (`visible === false`, e.g. a background/preloaded tab)
      // as passive. Passive visits are flagged `speculative` so /activity hides
      // them by default, exactly like browser prefetches. (The earlier fix only
      // covered the server document-GET path; these client-reported visits were
      // never flagged, which is why the filter missed them.)
      const speculative = trigger === "foreground" || visible === false;

      // Log the client-side page visit. groupId MUST be set here — /api/activity
      // filters strictly by group, so a null groupId means the visit is stored
      // but never shown in the feed. (This was the bug: every SPA navigation was
      // recorded group-less and silently dropped from /activity.)
      await storage.createActivityLog({
        type: 'page_visit',
        userId: req.userId ?? null,
        ipAddress: realIP,
        userAgent: userAgent || req.get('User-Agent') || null,
        city: location.city,
        country: location.country,
        path: path,
        details: JSON.stringify({
          method: 'CLIENT_NAVIGATION',
          referrer: referrer,
          timestamp: timestamp,
          trigger: trigger ?? 'navigation',
          visible: visible !== false,
          speculative,
        }),
        groupId: req.groupId ?? null,
      } as any);


      res.json({ success: true });
    } catch (error) {
      console.error("Error tracking page visit:", error);
      res.status(500).json({ error: "Failed to track page visit" });
    }
  });

  // POST /api/track — lightweight visit-tracking from the client. Used to
  // record tab/section changes inside SPAs that don't otherwise trigger a
  // page navigation (e.g. the Lawro sub-tabs). Body: { path, subPath?, label? }.
  app.post("/api/track", async (req, res) => {
    try {
      const { storage } = await import("./storage");
      const { getRealIP, getLocationFromIP } = await import("./geolocation");
      const realIP = getRealIP(req);
      const location = getLocationFromIP(realIP);
      const path = String(req.body?.path ?? "/");
      const subPath = req.body?.subPath ? String(req.body.subPath) : null;
      const label = req.body?.label ? String(req.body.label) : null;
      await storage.createActivityLog({
        type: "tab_view",
        userId: req.userId ?? null,
        ipAddress: realIP,
        userAgent: req.get("User-Agent") || null,
        city: location.city,
        country: location.country,
        path,
        details: JSON.stringify({ subPath, label }),
        groupId: req.groupId ?? null,
      } as any);
      res.json({ ok: true });
    } catch (err: any) {
      // Tracking failures must not block the user flow.
      console.error("[/api/track] error:", err);
      res.json({ ok: false });
    }
  });

  // GET /api/admin/activity — visit feed across ALL groups (admin-key gated).
  // Combines top-level page navigations (page_visit) and in-app sub-section
  // views (tab_view), attributed to the logged-in user via the recorded userId
  // and tagged with the group name so the client can filter by group.
  app.get("/api/admin/activity", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { db } = await import("./db");
      const { activityLogs, users, groups } = await import("@shared/schema");
      const { eq, inArray, desc, and, gte } = await import("drizzle-orm");
      // Show the last two weeks. Every page view and tab change is logged, so a
      // plain row cap (the old limit(1000)) only reached back a few days.
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const rows = await db
        .select({
          id: activityLogs.id,
          type: activityLogs.type,
          userId: activityLogs.userId,
          username: users.username,
          ipAddress: activityLogs.ipAddress,
          userAgent: activityLogs.userAgent,
          city: activityLogs.city,
          country: activityLogs.country,
          path: activityLogs.path,
          details: activityLogs.details,
          groupId: activityLogs.groupId,
          groupName: groups.name,
          createdAt: activityLogs.createdAt,
        })
        .from(activityLogs)
        .leftJoin(users, eq(activityLogs.userId, users.id))
        .leftJoin(groups, eq(activityLogs.groupId, groups.id))
        .where(and(inArray(activityLogs.type, ["page_visit", "tab_view"]), gte(activityLogs.createdAt, since)))
        .orderBy(desc(activityLogs.createdAt))
        .limit(20000);
      res.json(rows);
    } catch (err: any) {
      console.error("[/api/admin/activity] error:", err);
      res.status(500).json({ error: err?.message || "Failed to load activity" });
    }
  });

  // GET /api/admin/audit — merged audit feed across ALL groups (admin-key
  // gated). Pulls LMS selection logs and Lawro activity-log entries, joins
  // through to usernames, group names, and team/match names, reverse-chron.
  app.get("/api/admin/audit", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { db } = await import("./db");
      const {
        lmsSelectionLogs,
        lmsParticipants,
        users,
        groups,
        teams,
        matches,
        activityLogs,
      } = await import("@shared/schema");
      const { eq, inArray, desc } = await import("drizzle-orm");

      // 1) LMS team-selection changes (all groups).
      const lmsRows = await db
        .select({
          id: lmsSelectionLogs.id,
          createdAt: lmsSelectionLogs.createdAt,
          username: users.username,
          groupId: users.groupId,
          groupName: groups.name,
          gameweek: lmsSelectionLogs.gameweek,
          originalTeamId: lmsSelectionLogs.originalTeamId,
          newTeamId: lmsSelectionLogs.newTeamId,
          ipAddress: lmsSelectionLogs.ipAddress,
          userAgent: lmsSelectionLogs.userAgent,
          city: lmsSelectionLogs.city,
          country: lmsSelectionLogs.country,
        })
        .from(lmsSelectionLogs)
        .innerJoin(lmsParticipants, eq(lmsSelectionLogs.participantId, lmsParticipants.id))
        .innerJoin(users, eq(lmsParticipants.userId, users.id))
        .leftJoin(groups, eq(users.groupId, groups.id))
        .orderBy(desc(lmsSelectionLogs.createdAt));

      // 2) Prediction League ("Lawro") pick changes (all groups).
      const predTypes = ["prediction_set", "prediction_change", "prediction_delete"];
      const predRows = await db
        .select({
          id: activityLogs.id,
          createdAt: activityLogs.createdAt,
          username: users.username,
          groupId: users.groupId,
          groupName: groups.name,
          type: activityLogs.type,
          details: activityLogs.details,
          ipAddress: activityLogs.ipAddress,
          city: activityLogs.city,
          country: activityLogs.country,
          userAgent: activityLogs.userAgent,
        })
        .from(activityLogs)
        .innerJoin(users, eq(activityLogs.userId, users.id))
        .leftJoin(groups, eq(users.groupId, groups.id))
        .where(inArray(activityLogs.type, predTypes))
        .orderBy(desc(activityLogs.createdAt));

      // Lookup maps for nicer summaries — teams (PL) are global so we don't
      // filter by group.
      const allTeams = await db.select().from(teams);
      const teamById = new Map(allTeams.map((t) => [t.id, t]));
      const allPlMatches = await db.select().from(matches);
      const plMatchById = new Map(allPlMatches.map((m) => [m.id, m]));
      const plMatchLabel = (matchId: number | null | undefined): string => {
        if (matchId == null) return "?";
        const m = plMatchById.get(matchId);
        if (!m) return `match #${matchId}`;
        const home = teamById.get(m.homeTeamId)?.shortName ?? `#${m.homeTeamId}`;
        const away = teamById.get(m.awayTeamId)?.shortName ?? `#${m.awayTeamId}`;
        return `${home} vs ${away}`;
      };

      const events: Array<{
        id: string;
        type: string;
        createdAt: Date;
        username: string;
        groupId: number | null;
        groupName: string | null;
        summary: string;
        ipAddress: string;
        city: string | null;
        country: string | null;
        userAgent: string | null;
      }> = [];

      for (const r of lmsRows) {
        const original = r.originalTeamId ? teamById.get(r.originalTeamId)?.shortName : null;
        // remove-selection logs newTeamId = 0 for a cleared pick.
        const cleared = !r.newTeamId;
        const next = teamById.get(r.newTeamId)?.shortName ?? `#${r.newTeamId}`;
        const summary = cleared
          ? `LMS GW${r.gameweek}: cleared pick${original ? ` (was ${original})` : ""}`
          : original
            ? `LMS GW${r.gameweek}: changed pick from ${original} to ${next}`
            : `LMS GW${r.gameweek}: picked ${next}`;
        events.push({
          id: `lms:${r.id}`,
          type: "lms_selection",
          createdAt: r.createdAt,
          username: r.username,
          groupId: r.groupId,
          groupName: r.groupName,
          summary,
          ipAddress: r.ipAddress,
          city: r.city,
          country: r.country,
          userAgent: r.userAgent, // captured since we added the column
        });
      }

      for (const r of predRows) {
        let parsed: any = {};
        try {
          parsed = r.details ? JSON.parse(r.details) : {};
        } catch {
          parsed = {};
        }
        const label = plMatchLabel(parsed.matchId);
        let summary = r.type;
        if (r.type === "prediction_delete") {
          summary = `Lawro ${label}: cleared prediction`;
        } else {
          const score = `${parsed.homeScore}-${parsed.awayScore}`;
          summary =
            r.type === "prediction_change"
              ? `Lawro ${label}: changed prediction to ${score}`
              : `Lawro ${label}: predicted ${score}`;
        }
        events.push({
          id: `pred:${r.id}`,
          type: r.type,
          createdAt: r.createdAt,
          username: r.username,
          groupId: r.groupId,
          groupName: r.groupName,
          summary,
          ipAddress: r.ipAddress,
          city: r.city,
          country: r.country,
          userAgent: r.userAgent,
        });
      }

      events.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      res.json(events);
    } catch (err: any) {
      console.error("[/api/audit] error:", err);
      res.status(500).json({ error: err?.message || "Failed to load audit log" });
    }
  });

  // Shared admin guard: requests must carry x-api-key === ADMIN_API_KEY.
  function requireAdmin(req: any, res: any): boolean {
    const apiKey = req.headers["x-api-key"] as string | undefined;
    if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
      res.status(401).json({ error: "Unauthorized" });
      return false;
    }
    return true;
  }

  // ---------- Admin: group + player management ----------
  // A group is one closed circle of friends with its own players, games and
  // rules. Players are just `users` rows for that group. These endpoints let
  // the admin create groups, set their rules, and manage rosters from one
  // screen. All are gated by the admin API key (x-api-key), same as the other
  // /api/admin routes.

  const ALLOWED_GAMES = ["lms", "predictions"] as const;

  function cleanGames(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return ALLOWED_GAMES.filter((g) => input.includes(g));
  }

  // POST /api/admin/groups — create a new group.
  // Body: { name, slug, enabledGames?, buyIn?, lmsAllOutRule? }
  app.post("/api/admin/groups", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { db } = await import("./db");
      const { groups, LMS_ALL_OUT_RULES } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");

      const name = String(req.body?.name ?? "").trim();
      const slug = String(req.body?.slug ?? "").trim().toLowerCase();
      if (!name) return res.status(400).json({ error: "name is required" });
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return res
          .status(400)
          .json({ error: "slug is required and must be lowercase letters, numbers and dashes" });
      }

      const existing = await db.select().from(groups).where(eq(groups.slug, slug));
      if (existing.length > 0) {
        return res.status(409).json({ error: `A group with slug "${slug}" already exists` });
      }

      const enabledGames = cleanGames(req.body?.enabledGames);
      const buyIn = Math.max(0, Math.floor(Number(req.body?.buyIn ?? 0)) || 0);
      const lmsAllOutRule = (LMS_ALL_OUT_RULES as readonly string[]).includes(req.body?.lmsAllOutRule)
        ? req.body.lmsAllOutRule
        : "rollover";

      const [group] = await db
        .insert(groups)
        .values({ name, slug, enabledGames, buyIn, lmsAllOutRule })
        .returning();
      res.status(201).json({ ok: true, group });
    } catch (err: any) {
      console.error("[admin/groups POST] error:", err);
      res.status(500).json({ error: err?.message || "Failed to create group" });
    }
  });

  // PATCH /api/admin/groups/:id — update a group's name, games or rules.
  // Body: any of { name, enabledGames, buyIn, lmsAllOutRule }
  app.patch("/api/admin/groups/:id", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { db } = await import("./db");
      const { groups, LMS_ALL_OUT_RULES } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");

      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid group id" });

      const updates: Record<string, unknown> = {};
      if (typeof req.body?.name === "string" && req.body.name.trim()) {
        updates.name = req.body.name.trim();
      }
      if (req.body?.enabledGames !== undefined) {
        updates.enabledGames = cleanGames(req.body.enabledGames);
      }
      if (req.body?.buyIn !== undefined) {
        updates.buyIn = Math.max(0, Math.floor(Number(req.body.buyIn)) || 0);
      }
      if (req.body?.lmsAllOutRule !== undefined) {
        if (!(LMS_ALL_OUT_RULES as readonly string[]).includes(req.body.lmsAllOutRule)) {
          return res
            .status(400)
            .json({ error: `lmsAllOutRule must be one of: ${LMS_ALL_OUT_RULES.join(", ")}` });
        }
        updates.lmsAllOutRule = req.body.lmsAllOutRule;
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid fields to update" });
      }

      const [group] = await db.update(groups).set(updates).where(eq(groups.id, id)).returning();
      if (!group) return res.status(404).json({ error: "No such group" });
      res.json({ ok: true, group });
    } catch (err: any) {
      console.error("[admin/groups PATCH] error:", err);
      res.status(500).json({ error: err?.message || "Failed to update group" });
    }
  });

  // GET /api/admin/growth?days=N — onboarding/growth feed across ALL groups
  // (admin-key gated): new visitors, invite links opened, groups created,
  // players joining, code logins (and failed ones) from the last N days (default
  // 90), plus every group with its creation date, admin and player count.
  app.get("/api/admin/growth", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { db } = await import("./db");
      const { activityLogs, users, groups } = await import("@shared/schema");
      const { eq, inArray, desc, and, gte, count } = await import("drizzle-orm");
      const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const growthTypes = [
        "new_visitor",
        "invite_opened",
        "group_created",
        "group_joined",
        "login",
        "login_failed",
      ];
      const events = await db
        .select({
          id: activityLogs.id,
          type: activityLogs.type,
          userId: activityLogs.userId,
          username: users.username,
          ipAddress: activityLogs.ipAddress,
          userAgent: activityLogs.userAgent,
          city: activityLogs.city,
          country: activityLogs.country,
          path: activityLogs.path,
          details: activityLogs.details,
          groupId: activityLogs.groupId,
          groupName: groups.name,
          createdAt: activityLogs.createdAt,
        })
        .from(activityLogs)
        .leftJoin(users, eq(activityLogs.userId, users.id))
        .leftJoin(groups, eq(activityLogs.groupId, groups.id))
        .where(and(inArray(activityLogs.type, growthTypes), gte(activityLogs.createdAt, since)))
        .orderBy(desc(activityLogs.createdAt))
        .limit(20000);

      const playerCounts = await db
        .select({ groupId: users.groupId, players: count() })
        .from(users)
        .groupBy(users.groupId);
      const playersByGroup = new Map(playerCounts.map((r) => [r.groupId, Number(r.players)]));
      const allGroups = await db.select().from(groups).orderBy(desc(groups.createdAt));
      const ownerIds = allGroups.map((g) => g.ownerUserId).filter((id): id is number => id != null);
      const owners = ownerIds.length
        ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ownerIds))
        : [];
      const ownerName = new Map(owners.map((o) => [o.id, o.username]));

      res.json({
        days,
        events,
        groups: allGroups.map((g) => ({
          id: g.id,
          name: g.name,
          createdAt: g.createdAt,
          enabledGames: g.enabledGames,
          admin: g.ownerUserId != null ? ownerName.get(g.ownerUserId) ?? null : null,
          players: playersByGroup.get(g.id) ?? 0,
        })),
      });
    } catch (err: any) {
      console.error("[/api/admin/growth] error:", err);
      res.status(500).json({ error: err?.message || "Failed to load growth data" });
    }
  });

  // GET /api/admin/groups-players — every group with its roster of players.
  app.get("/api/admin/groups-players", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { db } = await import("./db");
      const { groups, users } = await import("@shared/schema");
      const { asc } = await import("drizzle-orm");
      const allGroups = await db.select().from(groups).orderBy(asc(groups.id));
      const allUsers = await db
        .select({
          id: users.id,
          username: users.username,
          groupId: users.groupId,
          loginCode: users.loginCode,
          enabledGames: users.enabledGames,
        })
        .from(users)
        .orderBy(asc(users.username));
      const payload = await Promise.all(
        allGroups.map(async (g) => {
          // Mark which players are in the group's current active LMS
          // competition so the admin UI can show an "in LMS / not in LMS"
          // indicator. hasActiveLms lets the UI distinguish "nobody's in it"
          // from "there's no live competition to be in".
          const competition = await storage.getCurrentLmsCompetition(g.id);
          let lmsUserIds = new Set<number>();
          if (competition) {
            const participants = await storage.getLmsParticipantsByCompetition(competition.id);
            lmsUserIds = new Set(participants.map((p) => p.userId));
          }
          return {
            id: g.id,
            slug: g.slug,
            name: g.name,
            enabledGames: g.enabledGames,
            buyIn: g.buyIn,
            lmsAllOutRule: g.lmsAllOutRule,
            hasActiveLms: !!competition,
            players: allUsers
              .filter((u) => u.groupId === g.id)
              .map((u) => ({ ...u, inLms: lmsUserIds.has(u.id) })),
          };
        }),
      );
      res.json(payload);
    } catch (err: any) {
      console.error("[admin/groups-players GET] error:", err);
      res.status(500).json({ error: err?.message || "Failed to load roster" });
    }
  });

  // POST /api/admin/players — add a player to a group. Body: { groupId, username }
  //
  // Creates the user row (with a personal login code) if they're new, and — when
  // the group runs LMS and has an active competition — enrols them into it so
  // they can immediately make picks. Works for any group's games: for a
  // predictions-only group (e.g. Lawro) it simply creates the player + code,
  // which is all they need to sign in and play. Idempotent and works for players
  // who already exist in the group for other games — adding an existing name is
  // not an error, it just ensures LMS enrolment where applicable.
  app.post("/api/admin/players", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { db } = await import("./db");
      const { groups, users } = await import("@shared/schema");
      const { and, eq } = await import("drizzle-orm");

      const groupId = Number(req.body?.groupId);
      const username = String(req.body?.username ?? "").trim();
      if (!Number.isFinite(groupId)) {
        return res.status(400).json({ error: "groupId must be a number" });
      }
      if (!username) {
        return res.status(400).json({ error: "username is required" });
      }

      const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
      if (!group) return res.status(404).json({ error: "No such group" });

      // Find or create the user row. An existing name is not an error — we fall
      // through to (re)enrolling them in LMS below.
      const existing = await db
        .select({
          id: users.id,
          username: users.username,
          groupId: users.groupId,
          loginCode: users.loginCode,
        })
        .from(users)
        .where(and(eq(users.username, username), eq(users.groupId, groupId)));
      let player = existing[0];
      const createdUser = !player;
      if (!player) {
        const { resolveLoginCodeForUsername, generateUniqueLoginCode } = await import("./loginCodes");
        const [row] = await db
          .insert(users)
          .values({
            username,
            password: "password",
            groupId,
            // In an admin-created group, reuse the person's code if they already
            // belong to another one. A self-service group's names don't identify
            // anyone, so a new player there gets a fresh code.
            loginCode: group.inviteToken
              ? await generateUniqueLoginCode()
              : await resolveLoginCodeForUsername(username),
          })
          .returning({
            id: users.id,
            username: users.username,
            groupId: users.groupId,
            loginCode: users.loginCode,
          });
        player = row;
      }

      // Enrol into the group's current active LMS competition if there is one.
      let enrolledInLms = false;
      let alreadyInLms = false;
      const competition = await storage.getCurrentLmsCompetition(groupId);
      if (competition) {
        const participants = await storage.getLmsParticipantsByCompetition(competition.id);
        if (participants.some((p) => p.userId === player.id)) {
          alreadyInLms = true;
        } else {
          await storage.createLmsParticipant({
            competitionId: competition.id,
            userId: player.id,
            isActive: "true",
          } as any);
          enrolledInLms = true;
        }
      }

      // Their personal login code — shown to the admin so it can be shared.
      const codeSuffix = player.loginCode ? ` Their login code is ${player.loginCode}.` : "";

      if (enrolledInLms) {
        const gw = competition!.currentGameweek;
        const message = createdUser
          ? `Added "${username}" and enrolled them in the current LMS competition (GW${gw}).${codeSuffix}`
          : `Enrolled "${username}" in the current LMS competition (GW${gw}).${codeSuffix}`;
        return res.json({ ok: true, createdUser, enrolledInLms, player, message });
      }

      // No LMS enrolment happened. What that means depends on the group's games.
      const groupHasLms = (group.enabledGames as string[]).includes("lms");

      // A brand-new user: their row (and login code) is created regardless of
      // game, which for a predictions-only group (Lawro) is all they need.
      if (createdUser) {
        const message = groupHasLms
          ? `Added "${username}". There's no active LMS competition to enrol them into yet.${codeSuffix}`
          : `Added "${username}" to ${group.name}.${codeSuffix}`;
        return res.json({ ok: true, createdUser, enrolledInLms: false, player, message });
      }

      // Existing user, nothing to enrol. For a non-LMS group (e.g. Lawro) that's
      // a harmless no-op — they're already a player — so report success rather
      // than an error. For an LMS group it's worth flagging with a 409.
      if (!groupHasLms) {
        return res.json({
          ok: true,
          createdUser: false,
          enrolledInLms: false,
          player,
          message: `"${username}" is already in ${group.name}.${codeSuffix}`,
        });
      }
      const error = alreadyInLms
        ? `"${username}" is already in the current LMS competition.`
        : `"${username}" is already in ${group.name}, and there's no active LMS competition to enrol them into.`;
      return res.status(409).json({ error });
    } catch (err: any) {
      console.error("[admin/players POST] error:", err);
      res.status(500).json({ error: err?.message || "Failed to add player" });
    }
  });

  // DELETE /api/admin/players/:userId — remove a player from a group.
  //
  // Behaviour depends on the group's games:
  //  - LMS group: removes the player from the group's *current* (non-completed)
  //    Last Man Standing competition(s) only. Does NOT delete the user; past LMS
  //    competitions are untouched.
  //  - Non-LMS group (e.g. a predictions-only "Lawro" group): takes the player
  //    out of THIS group entirely — deletes their group-scoped data (their
  //    predictions) and their user row for this group. Because a person has a
  //    separate row per group, their rows and data in OTHER groups are unchanged.
  app.delete("/api/admin/players/:userId", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { db } = await import("./db");
      const {
        users, groups, predictions, activityLogs,
        lmsCompetitions, lmsParticipants, lmsSelections, lmsSelectionLogs,
      } = await import("@shared/schema");
      const { and, eq, inArray, ne } = await import("drizzle-orm");

      const userId = Number(req.params.userId);
      if (!Number.isFinite(userId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user) return res.status(404).json({ error: "No such player" });
      const [group] = await db.select().from(groups).where(eq(groups.id, user.groupId));
      const groupHasLms = ((group?.enabledGames as string[]) ?? []).includes("lms");

      // Non-LMS group: fully remove the player from this group.
      if (!groupHasLms) {
        await db.delete(predictions).where(eq(predictions.userId, userId));
        // activity_logs.user_id is a real FK → null it rather than block delete.
        await db.update(activityLogs).set({ userId: null }).where(eq(activityLogs.userId, userId));
        await db.delete(users).where(eq(users.id, userId));
        return res.json({
          ok: true,
          removedFrom: 1,
          player: { id: user.id, username: user.username },
          message: `Removed "${user.username}" from ${group?.name ?? "the group"}. Their name and picks are gone from this game; any other groups they're in are unchanged.`,
        });
      }

      // Active (non-completed) competitions in this player's group. A player can
      // only be a participant in their own group's competitions, so scoping by
      // groupId keeps this to the group being managed.
      const activeComps = await db
        .select({ id: lmsCompetitions.id })
        .from(lmsCompetitions)
        .where(and(
          eq(lmsCompetitions.groupId, user.groupId),
          ne(lmsCompetitions.status, "completed"),
        ));
      const activeCompIds = activeComps.map((c) => c.id);

      // This player's participant rows in those active competitions. Selections
      // and logs hang off participant ids, so delete them first.
      let removedFrom = 0;
      if (activeCompIds.length > 0) {
        const parts = await db
          .select({ id: lmsParticipants.id })
          .from(lmsParticipants)
          .where(and(
            eq(lmsParticipants.userId, userId),
            inArray(lmsParticipants.competitionId, activeCompIds),
          ));
        const partIds = parts.map((p) => p.id);
        if (partIds.length > 0) {
          await db.delete(lmsSelections).where(inArray(lmsSelections.participantId, partIds));
          await db.delete(lmsSelectionLogs).where(inArray(lmsSelectionLogs.participantId, partIds));
          await db.delete(lmsParticipants).where(inArray(lmsParticipants.id, partIds));
          removedFrom = partIds.length;
        }
      }

      const message = removedFrom > 0
        ? `Removed "${user.username}" from the current LMS competition. Past competitions are unchanged.`
        : `"${user.username}" wasn't in an active LMS competition — nothing to remove. Past competitions are unchanged.`;
      res.json({ ok: true, removedFrom, player: { id: user.id, username: user.username }, message });
    } catch (err: any) {
      console.error("[admin/players DELETE] error:", err);
      res.status(500).json({ error: err?.message || "Failed to remove player" });
    }
  });

  // PATCH /api/admin/players/:userId/games — set which of the group's games this
  // player can see. Body: { enabledGames: string[] } listing the games to show.
  // Values are intersected with the group's games (you can't show a game the
  // group doesn't run). If the result equals the group's full set the override
  // is cleared to NULL ("inherit"), so future games added to the group show for
  // this player automatically.
  app.patch("/api/admin/players/:userId/games", async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { db } = await import("./db");
      const { users, groups } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");

      const userId = Number(req.params.userId);
      if (!Number.isFinite(userId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }
      const requested = req.body?.enabledGames;
      if (!Array.isArray(requested) || requested.some((g) => typeof g !== "string")) {
        return res.status(400).json({ error: "enabledGames must be an array of strings" });
      }

      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user) return res.status(404).json({ error: "No such player" });
      const [group] = await db.select().from(groups).where(eq(groups.id, user.groupId));
      if (!group) return res.status(404).json({ error: "No group for this player" });

      // Keep only games the group actually offers, in the group's own order.
      const groupGames = group.enabledGames;
      const chosen = groupGames.filter((g) => requested.includes(g));
      // Store NULL when the player has every group game (inherit), else the
      // explicit narrowed list.
      const override = chosen.length === groupGames.length ? null : chosen;

      await db.update(users).set({ enabledGames: override }).where(eq(users.id, userId));

      const effective = override ?? groupGames;
      res.json({
        ok: true,
        player: { id: user.id, username: user.username },
        enabledGames: override,
        effectiveGames: effective,
        message: `Updated ${user.username}'s games: ${effective.join(", ") || "none"}.`,
      });
    } catch (err: any) {
      console.error("[admin/players games PATCH] error:", err);
      res.status(500).json({ error: err?.message || "Failed to update games" });
    }
  });

  return httpServer;
}
