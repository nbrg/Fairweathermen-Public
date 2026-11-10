import { pgTable, text, serial, integer, json, timestamp, date, boolean, unique, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Group = one closed circle of friends with their own players, leaderboard,
// history etc. The slug is an internal key, unique and never shown or edited;
// code that names a specific original group goes through
// shared/originalGroups.ts. Names are unique too (checked on /create).
export const groups = pgTable("groups", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  // Which games this group plays — restricts the visible nav tabs.
  // Allowed values: "lms", "predictions" (the Prediction League,
  // aka "Lawro" — predict the score of every PL match, one gameweek at a time).
  enabledGames: json("enabled_games").$type<string[]>().notNull().default([]),
  // The user row (id) of the person who created this group via the public
  // "Create a group" flow. That person is the group's *admin*: only they may
  // edit the group's rules (see `rules` below). NULL for the original,
  // hand-seeded groups (city, rovers, …) which have no self-service owner — those
  // stay owner-less and fall back to the global ADMIN_API_KEY for management.
  ownerUserId: integer("owner_user_id"),
  // Secret token embedded in a group's invite link (/join/<token>). Anyone with
  // the link can join the group and is handed their personal login code. NULL
  // for groups created before self-service (they had no invite link); minted
  // for every self-service group at creation. Unique so a token maps to exactly
  // one group.
  inviteToken: text("invite_token").unique(),
  // Per-group rule overrides for LMS / Lawro, set by the group's admin. NULL
  // means "use the built-in defaults" (see DEFAULT_GROUP_RULES) — so every
  // existing group keeps today's exact behaviour until an admin changes
  // something. Always read through resolveGroupRules() so a partial/legacy blob
  // is merged onto the defaults rather than used raw.
  rules: json("rules").$type<Partial<GroupRules>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// A log of every change a group's admin makes to its rules. Each row keeps the
// rules before and after, plus a readable list of what changed, so (a) every
// player gets a pop-up about changes they haven't seen (users.
// last_seen_rule_change_id) and (b) Lawro rule changes are never retroactive:
// a change applies from `lawroEffectiveSeason`/`lawroEffectiveGameweek` (the
// first gameweek whose deadline hadn't passed when it was made), and earlier
// gameweeks keep the rules in this row's `before` — see lawroRulesAt().
export const groupRuleChanges = pgTable("group_rule_changes", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull(),
  changedByUserId: integer("changed_by_user_id"),
  changedAt: timestamp("changed_at").notNull().defaultNow(),
  before: json("before").$type<GroupRules>().notNull(),
  after: json("after").$type<GroupRules>().notNull(),
  changes: json("changes").$type<RuleChangeItem[]>().notNull(),
  // Set only when the change touched Lawro rules.
  lawroEffectiveSeason: text("lawro_effective_season"),
  lawroEffectiveGameweek: integer("lawro_effective_gameweek"),
});

export type GroupRuleChange = typeof groupRuleChanges.$inferSelect;

// One changed setting, already worded for players ("Exact score points", 3 → 5).
export type RuleChangeItem = {
  game: "lawro" | "lms";
  key: string;
  label: string;
  from: string;
  to: string;
};

// Per-group, admin-tunable rules for the two games a self-service group can
// run. Stored (possibly partially) on `groups.rules`; always read back through
// resolveGroupRules() so missing keys fall back to DEFAULT_GROUP_RULES. Keeping
// the shape + defaults here (shared) means the server logic and the client
// settings UI agree on exactly one source of truth.
//
// Every default below reproduces the app's current hard-coded behaviour, so a
// group with no overrides (and every pre-existing group) plays exactly as before
// until its admin changes something.

// What happens to a Lawro player who has no pick when the gameweek deadline
// passes.
//  - "blank": they simply score nothing that gameweek (current behaviour).
//  - "random": a random scoreline is filled in for them.
//  - "open_until_kickoff": the gameweek deadline doesn't lock everything at
//    once — a player who missed it can still enter a prediction for any match
//    in the gameweek that hasn't kicked off yet (each match locks at its own
//    kick-off). Matches they never predict simply score nothing.
export type LawroMissedPolicy = "blank" | "random" | "open_until_kickoff";

// What happens to an LMS player who hasn't picked when the deadline passes.
//  - "random": a random eligible team is assigned (current behaviour).
//  - "eliminate": missing a pick counts as a losing pick — it costs a life, and
//    only knocks the player out if it was their last one.
export type LmsMissedPolicy = "random" | "eliminate";

// What happens when every remaining LMS player is knocked out in the same
// gameweek. Whichever applies, a new competition always opens straight after
// for the same roster.
//  - "rollover": no winner; everyone is back in for the next competition and
//    the pot carries over into it (current behaviour).
//  - "co_winners": the players who went out in that final gameweek share the
//    pot (recorded as joint winners); nobody else does.
// There used to be a third option, "no_winner" (the pot doesn't carry over).
// It was removed as redundant; a group that still has it stored reads as
// "rollover" because resolveGroupRules() falls back to the default for any
// value not in LMS_ALL_OUT_POLICIES.
export type LmsAllOutPolicy = "rollover" | "co_winners";

export type GroupRules = {
  lawro: {
    // Points for nailing the exact scoreline (default 3).
    exactScorePoints: number;
    // Points for getting only the result right — win/draw/loss (default 1).
    correctResultPoints: number;
    // Minutes before the gameweek's first kick-off that picks lock (default 0 —
    // locks exactly at the first kick-off).
    deadlineMinutesBeforeKickoff: number;
    // What happens to a player with no pick when the deadline passes.
    missedPickPolicy: LawroMissedPolicy;
    // The Joker: each player may mark one of their predictions per gameweek as
    // their Joker, and whatever points it scores are doubled (default off).
    jokerEnabled: boolean;
  };
  lms: {
    // The buy-in / prize pot for a Last Man Standing competition (default 10).
    buyIn: number;
    // How many lives a player has — i.e. how many losing picks it takes to knock
    // them out (default 1: one loss and you're gone).
    lives: number;
    // Minutes before the gameweek's first kick-off that selections lock
    // (default 0 — locks exactly at the first kick-off).
    deadlineMinutesBeforeKickoff: number;
    // What happens to a player with no pick when the deadline passes.
    missedPickPolicy: LmsMissedPolicy;
    // What happens when everyone still in goes out together.
    allOutPolicy: LmsAllOutPolicy;
  };
};

export const DEFAULT_GROUP_RULES: GroupRules = {
  lawro: {
    exactScorePoints: 3,
    correctResultPoints: 1,
    deadlineMinutesBeforeKickoff: 0,
    missedPickPolicy: "blank",
    jokerEnabled: false,
  },
  lms: {
    buyIn: 10,
    lives: 1,
    deadlineMinutesBeforeKickoff: 0,
    missedPickPolicy: "random",
    allOutPolicy: "rollover",
  },
};

export const LAWRO_MISSED_POLICIES: readonly LawroMissedPolicy[] = [
  "blank",
  "random",
  "open_until_kickoff",
];
export const LMS_MISSED_POLICIES: readonly LmsMissedPolicy[] = ["random", "eliminate"];
export const LMS_ALL_OUT_POLICIES: readonly LmsAllOutPolicy[] = ["rollover", "co_winners"];

// Merge a stored (partial / null / legacy) rules blob onto the defaults so
// callers always get a complete, safe GroupRules. Numbers are coerced and
// clamped to sane bounds; unknown enum values fall back to the default; unknown
// keys are ignored.
export function resolveGroupRules(stored: Partial<GroupRules> | null | undefined): GroupRules {
  const clampInt = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  const d = DEFAULT_GROUP_RULES;
  return {
    lawro: {
      exactScorePoints: clampInt(stored?.lawro?.exactScorePoints, d.lawro.exactScorePoints, 0, 100),
      correctResultPoints: clampInt(stored?.lawro?.correctResultPoints, d.lawro.correctResultPoints, 0, 100),
      deadlineMinutesBeforeKickoff: clampInt(
        stored?.lawro?.deadlineMinutesBeforeKickoff,
        d.lawro.deadlineMinutesBeforeKickoff,
        0,
        10080, // up to a week
      ),
      missedPickPolicy: oneOf(stored?.lawro?.missedPickPolicy, LAWRO_MISSED_POLICIES, d.lawro.missedPickPolicy),
      jokerEnabled: typeof stored?.lawro?.jokerEnabled === "boolean" ? stored.lawro.jokerEnabled : d.lawro.jokerEnabled,
    },
    lms: {
      buyIn: clampInt(stored?.lms?.buyIn, d.lms.buyIn, 0, 100000),
      lives: clampInt(stored?.lms?.lives, d.lms.lives, 1, 10),
      deadlineMinutesBeforeKickoff: clampInt(
        stored?.lms?.deadlineMinutesBeforeKickoff,
        d.lms.deadlineMinutesBeforeKickoff,
        0,
        10080,
      ),
      missedPickPolicy: oneOf(stored?.lms?.missedPickPolicy, LMS_MISSED_POLICIES, d.lms.missedPickPolicy),
      allOutPolicy: oneOf(stored?.lms?.allOutPolicy, LMS_ALL_OUT_POLICIES, d.lms.allOutPolicy),
    },
  };
}

// The Lawro rules that govern one gameweek, given the group's current rules and
// its rule-change log. A gameweek before a change's effective gameweek keeps
// that change's `before` rules, so editing the rules never rescores (or
// re-locks) a gameweek whose deadline had already passed. Seasons compare as
// strings ("2025/2026" < "2026/2027"); a null season counts as the current one.
export function lawroRulesAt(
  current: GroupRules["lawro"],
  changes: Pick<GroupRuleChange, "id" | "before" | "lawroEffectiveSeason" | "lawroEffectiveGameweek">[],
  season: string | null | undefined,
  gameweek: number | null | undefined,
): GroupRules["lawro"] {
  if (gameweek == null) return current;
  let rules = current;
  // Newest first: each change older than the target gameweek's rules unwinds.
  const ordered = changes
    .filter((c) => c.lawroEffectiveGameweek != null)
    .sort((a, b) => b.id - a.id);
  for (const c of ordered) {
    const effSeason = c.lawroEffectiveSeason ?? "";
    const s = season ?? effSeason;
    const before = s < effSeason || (s === effSeason && gameweek < c.lawroEffectiveGameweek!);
    if (!before) break;
    rules = resolveGroupRules(c.before).lawro;
  }
  return rules;
}

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    // Username is unique *within a group* (so "Alex" can exist in another group
    // AND in lastman as two different rows), not globally.
    username: text("username").notNull(),
    password: text("password").notNull(),
    groupId: integer("group_id").notNull().default(1),
    // Private access code entered on the landing page. It identifies a
    // *person*: someone who belongs to several groups (e.g. Morgan, Alex) has
    // one row per group, and all of those rows share the same login_code, so a
    // single code signs them in and lets them switch between their groups.
    // Therefore NOT unique at the DB level — it's unique per person, enforced
    // in server/loginCodes.ts (a fresh code never collides with another
    // person's, and a person's rows reuse their existing code). Nullable so
    // existing rows can be backfilled on boot; new users get one at creation.
    loginCode: text("login_code"),
    // Per-person game visibility override. NULL means "inherit the group's
    // enabledGames" (the default). When set, it narrows the group's games for this
    // one person: it's intersected with the group's enabledGames, so a player
    // can be hidden from a game the group runs (e.g. a Rovers member who only
    // plays LMS and shouldn't see the Lawro tab) but never shown a game the
    // group doesn't offer. Managed per-player from /admin/players.
    enabledGames: json("enabled_games").$type<string[]>(),
    // The newest group_rule_changes id this player has acknowledged. Any rule
    // change in their group with a higher id (made by someone else) pops up for
    // them once, so an admin can't change the rules unnoticed. 0 = none seen;
    // players who join a group start at its latest change.
    lastSeenRuleChangeId: integer("last_seen_rule_change_id").notNull().default(0),
  },
  (table) => ({
    groupUsernameUnique: unique("users_group_id_username_unique").on(
      table.groupId,
      table.username,
    ),
  }),
);

export const teams = pgTable("teams", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  shortName: text("short_name").notNull(),
});

export const matches = pgTable("matches", {
  id: serial("id").primaryKey(),
  homeTeamId: integer("home_team_id").notNull(),
  awayTeamId: integer("away_team_id").notNull(),
  homeScore: integer("home_score"),
  awayScore: integer("away_score"),
  status: text("status").notNull().default("not_started"),
  // Live match minute from football-data (e.g. 34 → "34'"), set only while the
  // match is in progress and cleared back to null once it finishes / isn't live.
  // Used purely for the UI's match-progress indicator; not part of scoring.
  minute: integer("minute"),
  matchTime: text("match_time").notNull(),
  matchDay: text("match_day").notNull(),
  matchDate: date("match_date"), // Stored as date in DB; Drizzle returns as ISO string
  gameweek: integer("gameweek"), // Added for gameweek tracking
  // Which PL season this fixture belongs to, e.g. "2026/2027". Lets us keep old
  // seasons' fixtures for history rather than wiping them each rollover; the
  // "list all matches" readers scope to the latest season so the live game and
  // Fixtures tab only ever see the current season.
  season: text("season"),
});

export const predictions = pgTable("predictions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  matchId: integer("match_id").notNull(),
  homeScore: integer("home_score").notNull(),
  awayScore: integer("away_score").notNull(),
  // Legacy: once flagged auto-randomised picks for players who missed the
  // deadline. That randomiser was removed (missed picks are now left blank), so
  // this is always false. Kept to avoid a destructive column drop; safe to
  // remove in a future schema change.
  isAutoPick: boolean("is_auto_pick").notNull().default(false),
  // True for a pick entered after the gameweek deadline under the Lawro
  // "open_until_kickoff" missed-deadline rule. Such a late pick can still be
  // adjusted until its own match kicks off; picks made before the deadline lock
  // at the deadline as usual. Always set by the server, never by the client.
  isLatePick: boolean("is_late_pick").notNull().default(false),
  // The player's Joker for this gameweek under the Lawro Joker rule: its points
  // are doubled. At most one per player per gameweek; set only through
  // PUT /api/predictions/:id/joker, never from the create payload. Ignored when
  // the rule is off for the gameweek (see lawroRulesAt).
  isJoker: boolean("is_joker").notNull().default(false),
}, (table) => ({
  // One pick per player per match. A manual fix-up that was run twice once
  // doubled a player's gameweek points; the database now refuses the copy.
  // Before pushing this to a database that may hold duplicates, remove them
  // first (keep the newest row per user_id + match_id).
  userMatchUnique: unique("predictions_user_id_match_id_unique").on(table.userId, table.matchId),
}));

// Server-generated secrets, so they don't have to be set by hand. Holds the
// group-cookie signing key (name "group_cookie_secret") when the
// GROUP_COOKIE_SECRET env var isn't set — see server/groupAuth.ts. Never sent
// to clients, and skipped by the prod → dev sync.
export const appSecrets = pgTable("app_secrets", {
  name: text("name").primaryKey(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const visitors = pgTable("visitors", {
  id: serial("id").primaryKey(),
  ipAddress: text("ip_address").notNull(),
  visitCount: integer("visit_count").notNull().default(1),
  firstVisit: timestamp("first_visit").notNull().defaultNow(),
  lastVisit: timestamp("last_visit").notNull().defaultNow(),
  userAgent: text("user_agent"),
  location: text("location"),
  deviceInfo: text("device_info"),
  referrer: text("referrer"),
  screenResolution: text("screen_resolution"),
});

// Last Man Standing tables
export const lmsCompetitions = pgTable("lms_competitions", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().default(1), // 1 = Fairweathermen, 2 = Second Group
  season: text("season").notNull().default("2025/2026"), // e.g. "2024/2025", "2025/2026"
  name: text("name").notNull(),
  startGameweek: integer("start_gameweek").notNull(),
  currentGameweek: integer("current_gameweek").notNull(),
  status: text("status").notNull().default("active"), // "active", "completed"
  winnerId: integer("winner_id"),
  coWinnerId: integer("co_winner_id"),
  prizeAmount: integer("prize_amount").default(35),
  // The buy-in each player paid for this competition, saved from the group's
  // LMS buy-in when it opens (and kept in step if the admin edits the buy-in
  // before it goes live). NULL for the original hand-seeded groups' older
  // competitions, whose stakes predate per-group rules — the LMS page derives
  // those from its legacy per-season table instead.
  stakeGbp: integer("stake_gbp"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const lmsParticipants = pgTable("lms_participants", {
  id: serial("id").primaryKey(),
  competitionId: integer("competition_id").notNull(),
  userId: integer("user_id").notNull(),
  isActive: text("is_active").notNull().default("true"), // "true", "false"
  eliminatedInRound: integer("eliminated_in_round"),
});

export const lmsSelections = pgTable("lms_selections", {
  id: serial("id").primaryKey(),
  participantId: integer("participant_id").notNull(),
  gameweek: integer("gameweek").notNull(),
  // The team the player picked. NULL marks a "missed pick" row recorded when a
  // player has no selection at the deadline under the LMS "eliminate" rule: it
  // carries result "l" so it counts as one lost life in the normal
  // cumulative-loss elimination, without pretending they picked a real team.
  teamId: integer("team_id"),
  matchId: integer("match_id"),
  result: text("result"), // "w", "l", "postponed", "pending"
  isRandomlyAssigned: text("is_randomly_assigned").default("false"), // "true", "false"
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const lmsSelectionLogs = pgTable("lms_selection_logs", {
  id: serial("id").primaryKey(),
  participantId: integer("participant_id").notNull(),
  gameweek: integer("gameweek").notNull(),
  originalTeamId: integer("original_team_id"), // NULL if no previous selection
  newTeamId: integer("new_team_id").notNull(),
  ipAddress: text("ip_address").notNull(),
  userAgent: text("user_agent"), // captured so the /audit device column resolves
  city: text("city"),
  country: text("country"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Activity logs for all site interactions
export const activityLogs = pgTable("activity_logs", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(), // 'lms_selection', 'page_visit', 'admin_access', etc.
  userId: integer("user_id").references(() => users.id),
  ipAddress: text("ip_address").notNull(),
  userAgent: text("user_agent"),
  city: text("city"),
  country: text("country"),
  path: text("path"),
  details: text("details"), // JSON string for additional data
  // Nullable — pre-login visits (the gate itself) have no group context yet.
  // Set by the activity-logging middleware whenever the request carries a
  // valid group cookie.
  groupId: integer("group_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Types for in-memory storage
export type Group = typeof groups.$inferSelect;
export type User = typeof users.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type Match = typeof matches.$inferSelect & {
  homeTeam?: Team;
  awayTeam?: Team;
};
export type Prediction = typeof predictions.$inferSelect;
export type Visitor = typeof visitors.$inferSelect;
export type LmsCompetition = typeof lmsCompetitions.$inferSelect;
export type LmsParticipant = typeof lmsParticipants.$inferSelect;
export type LmsSelection = typeof lmsSelections.$inferSelect;
export type LmsSelectionLog = typeof lmsSelectionLogs.$inferSelect;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type MatchWithTeams = Match & {
  homeTeam: Team;
  awayTeam: Team;
};
export type PredictionWithMatch = Prediction & {
  match: MatchWithTeams;
  points?: number;
  status?: "exact_score" | "correct_result" | "incorrect" | "not_started";
};
export type UserWithPredictions = User & {
  predictions: PredictionWithMatch[];
  exactScores: number;
  correctResults: number;
  totalPoints: number;
};

// Insert schemas
export const insertGroupSchema = createInsertSchema(groups).omit({
  id: true,
  createdAt: true,
});
export type InsertGroup = z.infer<typeof insertGroupSchema>;

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertTeamSchema = createInsertSchema(teams);

export const insertMatchSchema = createInsertSchema(matches);

export const insertPredictionSchema = createInsertSchema(predictions);
export const insertVisitorSchema = createInsertSchema(visitors).omit({
  id: true,
  firstVisit: true,
  lastVisit: true,
  visitCount: true,
});

export const insertLmsCompetitionSchema = createInsertSchema(lmsCompetitions).omit({
  id: true,
  createdAt: true,
});

export const insertLmsParticipantSchema = createInsertSchema(lmsParticipants).omit({
  id: true,
});

export const insertLmsSelectionSchema = createInsertSchema(lmsSelections).omit({
  id: true,
  createdAt: true,
});

export const insertLmsSelectionLogSchema = createInsertSchema(lmsSelectionLogs).omit({
  id: true,
  createdAt: true,
});

export const insertActivityLogSchema = createInsertSchema(activityLogs).omit({
  id: true,
  createdAt: true,
});







// Insert types
export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertTeam = z.infer<typeof insertTeamSchema>;
export type InsertMatch = z.infer<typeof insertMatchSchema>;
export type InsertPrediction = z.infer<typeof insertPredictionSchema>;
export type InsertVisitor = z.infer<typeof insertVisitorSchema>;
export type InsertLmsCompetition = z.infer<typeof insertLmsCompetitionSchema>;
export type InsertLmsParticipant = z.infer<typeof insertLmsParticipantSchema>;
export type InsertLmsSelection = z.infer<typeof insertLmsSelectionSchema>;
export type InsertLmsSelectionLog = z.infer<typeof insertLmsSelectionLogSchema>;
export type InsertActivityLog = z.infer<typeof insertActivityLogSchema>;

// Web-push subscriptions. One row per browser/device that opted into
// reminders. Tied to the user row that was active when they subscribed; the
// reminder sender fans out to every device belonging to that *person* (all
// user rows sharing a login_code), so a subscription made in one group still
// reaches them for another. endpoint is globally unique (the push service URL).
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  groupId: integer("group_id").notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  // How many minutes before a gameweek's first kickoff to remind this person.
  // A set of presets (see REMINDER_LEAD_PRESETS_MINUTES) — you can pick several,
  // so you might be nudged 24h AND 1h before. The scheduler fires each lead at
  // the kickoff's absolute UTC instant minus that many minutes, so it's correct
  // regardless of the device's timezone.
  reminderLeadsMinutes: json("reminder_leads_minutes").$type<number[]>().notNull().default([60]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Dedupe log for kickoff reminders: one row per (person-in-group, game,
// gameweek, lead time) once that reminder has been sent, so the per-minute
// scheduler never double-sends even across restarts. Because a person can pick
// several lead times, leadMinutes is part of the key — each lead fires once.
// game is "lawro" or "lms".
export const reminderSends = pgTable(
  "reminder_sends",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    groupId: integer("group_id").notNull(),
    game: text("game").notNull(),
    gameweek: integer("gameweek").notNull(),
    leadMinutes: integer("lead_minutes").notNull().default(60),
    sentAt: timestamp("sent_at").notNull().defaultNow(),
  },
  (table) => ({
    uniqueSend: unique("reminder_sends_unique").on(
      table.userId,
      table.game,
      table.gameweek,
      table.leadMinutes,
    ),
  }),
);

// Allowed "minutes before kickoff" reminder lead times, offered as (multi-select)
// presets in the app and validated on the server. 15 min, 1 hour, 3 hours, 24 hours.
export const REMINDER_LEAD_PRESETS_MINUTES = [15, 60, 180, 1440] as const;
export type ReminderLeadMinutes = (typeof REMINDER_LEAD_PRESETS_MINUTES)[number];

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type InsertPushSubscription = typeof pushSubscriptions.$inferInsert;
export type ReminderSend = typeof reminderSends.$inferSelect;

