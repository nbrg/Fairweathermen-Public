import { pgTable, text, serial, integer, json, timestamp, date, boolean, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Group = one closed circle of friends with their own players, leaderboard,
// history etc. Identified by a slug ("united", "lastman") that doubles as
// the access code on the landing page.
export const groups = pgTable("groups", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  // Which games this group plays — restricts the visible nav tabs.
  // Allowed values: "lms", "golf", "predictions" (the Prediction League,
  // aka "Lawro" — predict the score of every PL match, one gameweek at a time).
  enabledGames: json("enabled_games").$type<string[]>().notNull().default([]),
  // Per-group rules, configurable from the admin "Groups" screen.
  // buyIn: the stake each player puts in per competition, in whole currency
  // units (0 = just for bragging rights). Surfaced to the UI as the group's pot.
  buyIn: integer("buy_in").notNull().default(0),
  // lmsAllOutRule: what happens in Last Man Standing when every remaining
  // player is knocked out in the same gameweek:
  //   "rollover" — the competition ends with no winner and a fresh one starts
  //                 for the same roster (the pot carries over). The default.
  //   "revive"   — everyone is given another life and play continues in the
  //                 same competition.
  lmsAllOutRule: text("lms_all_out_rule").notNull().default("rollover"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Valid values for groups.lmsAllOutRule.
export const LMS_ALL_OUT_RULES = ["rollover", "revive"] as const;
export type LmsAllOutRule = (typeof LMS_ALL_OUT_RULES)[number];

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    // Username is unique *within a group* (so "Alex" can exist in united
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
    // enabledGames" (the default — so e.g. everyone in City sees Golf whether or
    // not they've played it). When set, it narrows the group's games for this
    // one person: it's intersected with the group's enabledGames, so a player
    // can be hidden from a game the group runs (e.g. a Rovers member who only
    // plays LMS and shouldn't see the Golf tab) but never shown a game the
    // group doesn't offer. Managed per-player from /admin/players.
    enabledGames: json("enabled_games").$type<string[]>(),
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
  teamId: integer("team_id").notNull(),
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

// Golf tables
export const golfTournaments = pgTable("golf_tournaments", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().default(1),
  name: text("name").notNull(),
  courseId: text("course_id").notNull(), // e.g. "velvet-jacket-oxfordshire"
  status: text("status").notNull().default("active"), // "active", "completed"
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const golfScores = pgTable("golf_scores", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull(),
  playerName: text("player_name").notNull(),
  hole: integer("hole").notNull(), // 1-18
  day: integer("day").notNull(), // 1 or 2
  score: integer("score"), // strokes for this hole
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const golfHandicaps = pgTable("golf_handicaps", {
  id: serial("id").primaryKey(),
  tournamentSlug: text("tournament_slug").notNull(),
  playerName: text("player_name").notNull(),
  handicap: integer("handicap").notNull(),
  lastUpdated: timestamp("last_updated").notNull().defaultNow(),
});

export const golfPrizeWinners = pgTable("golf_prize_winners", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull(),
  prizeKey: text("prize_key").notNull(), // e.g. "nearest-pin-1", "longest-drive-1", etc.
  winnerName: text("winner_name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
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
export type GolfTournament = typeof golfTournaments.$inferSelect;
export type GolfScore = typeof golfScores.$inferSelect;
export type GolfHandicap = typeof golfHandicaps.$inferSelect;
export type GolfPrizeWinner = typeof golfPrizeWinners.$inferSelect;
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

export const insertGolfTournamentSchema = createInsertSchema(golfTournaments).omit({
  id: true,
  createdAt: true,
});

export const insertGolfScoreSchema = createInsertSchema(golfScores).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertGolfHandicapSchema = createInsertSchema(golfHandicaps).omit({
  id: true,
  lastUpdated: true,
});

export const insertGolfPrizeWinnerSchema = createInsertSchema(golfPrizeWinners).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
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
export type InsertGolfTournament = z.infer<typeof insertGolfTournamentSchema>;
export type InsertGolfScore = z.infer<typeof insertGolfScoreSchema>;
export type InsertGolfHandicap = z.infer<typeof insertGolfHandicapSchema>;
export type InsertGolfPrizeWinner = z.infer<typeof insertGolfPrizeWinnerSchema>;

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

// Flashscore scraper types
export type ScrapedMatch = {
  homeTeam: string;
  awayTeam: string;
  homeScore?: number;
  awayScore?: number;
  status: string;
  time: string;
};
