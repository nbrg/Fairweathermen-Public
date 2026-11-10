# Architecture

A tour of how the app is put together: the structure, the conventions, and a few
data-integrity rules that are easy to get wrong. If you change how something works, keep
this up to date.

## Overview

Fairweathermen is a full-stack TypeScript app for Premier League predictions among closed
groups of friends. It hosts two games, each with its own pages/routes/tables:

- **Prediction League** ("Lawro") — users predict the scoreline of each PL match, one gameweek at
  a time; 3 pts for an exact score, 1 pt for the right result, shown on a group-scoped leaderboard.
  Enabled per group/person via the `"predictions"` key in `enabledGames` (shows the "Lawro" nav
  tab at `/lawro`, with `/predictions` kept as a legacy alias); each person edits only their own
  column, and only until the gameweek
  deadline (the first kickoff of the gameweek). Other players' scorelines stay hidden — the API
  redacts them, revealing only *that* a pick exists (so you can see who has/hasn't submitted) — until
  that deadline, then everyone's scores are revealed. Anyone
  without a pick is simply left blank for that gameweek (no auto-fill). The page is tabbed
  (Predictions · Leaderboard · Stats) with a season/gameweek leaderboard and a live deadline
  countdown. (tables: `predictions`, over `matches`/`teams`)
  **Score entry:** `usePredictionSave.ts` owns a per-user/match queue outside the mounted
  cell, persists unconfirmed drafts in sessionStorage, and retries transient failures with
  bounded backoff plus reconnect/manual recovery. Complete scores and clears use idempotent
  `PUT /api/predictions` (both scores null means clear); legacy POST/PATCH/DELETE remain for
  phones running a cached older client (to be removed in Q1 2027).
  A complete score moves focus to the next score box (`focusNextScoreInput`), and typing a
  digit into a full score starts a new one.
  Score cells have no inline helper/status text or tooltips. Keep accessible busy/invalid
  states and an icon-only retry control; saving starts immediately, without a debounce.
  `storage.savePrediction` serializes writes using the existing user row's transaction lock,
  shared with legacy creators and random missed-pick filling; no schema migration is needed.
  The route resolves deadline/rule metadata before the transaction to avoid pool starvation,
  checks the existing pick under the lock, and preserves late/auto/Joker flags on edits.
  Only committed changes create audit entries; failures log a request ID, user and match.
  `GatedShell` stops delayed focus/scroll corrections on user interaction so the first score's
  keyboard is not dismissed. Regression cases live in `tests/lawroInputs.spec.ts`.
  **Grid layout:** before the deadline the grid is one row per match, one column per player.
  Once the deadline has passed it flips to one row per player, one column per match (late-entry
  cells under `open_until_kickoff` stay editable in the flipped grid) (`data-layout` on `data-testid="lawro-grid"`). Preview it on a dev DB with
  `npx tsx scripts/simulateLawroLiveRound.ts live|open|reset [--gameweek N] [--group slug]`.
  The prediction grid schedules its own deadline/kick-off transitions, so editable
  cells lock even when polling returns identical match data.
- **Last Man Standing (LMS)** — each gameweek a player picks one team to win; a wrong pick
  eliminates them, last player standing wins. Runs as competitions that span multiple seasons and
  groups. (tables: `lms_competitions`, `lms_participants`, `lms_selections`, `lms_selection_logs`)
  **Randomiser wheel** (`server/lmsWheel.ts`, `shared/lmsWheel.ts`, `client/src/components/lms/LmsWheel.tsx`):
  missed picks (rule "random") are still drawn at the deadline, but each stays hidden from everyone,
  owner included (`hideForWheel` in routes, `wheel: true`), until its wheel lands. Wheels spin one
  at a time from deadline + 3:00 (`GET /api/lms/wheel`, group-scoped, pool = teams playing that GW the
  player hasn't used); the angle is a function of server time, so screens stay in sync and late
  arrivals see no wheel. It's a site-wide, undismissable pop-up (mounted in `App.tsx`) from the deadline until the last wheel's hold ends; `GET /api/lms/wheel` also draws any missed pick still undrawn. A push goes to the group's LMS players at deadline + 90s (deduped in
  `reminder_sends` as `lms-wheel-c<competitionId>`). `lmsDeadlineWindowActive` opens the LMS
  processor around each group's deadline offset, not just kickoff. Dev:
  `scripts/simulateLmsWheel.ts start --players 1|2` / `status` / `reset` (all groups on that gameweek).
## Commands

```bash
npm run dev      # Dev server (Express + Vite middleware) on port 5000
npm run check    # tsc + lesson checks (see below) — the ONLY automated gate besides tests
npm run build    # Build client (Vite) + bundle server (esbuild) into dist/
npm run start    # Run the production bundle (NODE_ENV=production)
npm run db:push  # Apply shared/schema.ts to the database (drizzle-kit push)
npm test         # Playwright end-to-end suite (needs a throwaway Postgres — see tests/README.md)
```

There is no ESLint or Prettier. `npm run check` is `tsc` plus three small scripts that encode past
mistakes: `scripts/checks/noGenericJsx.mjs` (fails on an explicit type argument on a JSX tag such
as `<SelectField<T> …>` — tsc and the build accept it but the Vite dev server's esbuild can
break), `scripts/checks/changelogNumbers.mjs` (fails if a `shared/changelog.json` entry has
no PR `number`) and `node tests/affected.mjs --check` (fails if any file isn't classified in the CI area
map, or a spec isn't listed under an area). Run `npm run check` after every change, and `npm test` for
anything behavioural. **When you add a source file or spec, add it to the map in
`tests/affected.mjs`** (an AREA, CORE or IGNORED; `npm run check`, and so CI, fails until you do). CI
(`.github/workflows/ci.yml`) runs the check plus the affected specs on each PR.
Locally, `npm run test:affected` runs just what your branch touches vs `origin/main`, and
`PLAYWRIGHT_PROJECTS=chromium npm test` runs just Chrome. The suite
seeds its own fixture (`scripts/seedTestData.ts` — it TRUNCATES every table, so never point it at
a real database) and boots the app with `DATABASE_DRIVER=pg` (plain node-postgres instead of
Neon's WebSocket driver; see `server/db.ts`). Add a spec under `tests/` when you add an endpoint
or flow.

## Architecture

- **Single Express server serves both the API and the client.** In dev, Vite runs as Express
  middleware (`server/vite.ts` → `setupVite`); in prod it serves the static build
  (`serveStatic`). There is no separate frontend dev server.
- Port is `process.env.PORT || 5000`.
- **Database is Neon serverless Postgres over a WebSocket** (`@neondatabase/serverless` + `ws`,
  via Drizzle's `neon-serverless` adapter — see `server/db.ts`). A plain Postgres works too with
  `DATABASE_DRIVER=pg` (what the test suite uses); Neon URLs pick the Neon driver automatically.
- **Anyone can get signed in** (by creating a group), so a group cookie is not authorisation for
  shared data. Global writes (match scores, matches, teams, fixture syncs) and every
  `/api/admin/*` route need `requireAdmin` (x-api-key). Any
  endpoint returning Lawro predictions must pass them through `redactUnrevealedPredictions`.
- **Rate limits can't trust the client IP.** `req.ip` comes from `X-Forwarded-For`, which a client
  can fake, so per-IP limiters (`server/rateLimits.ts`) are backed by site-wide ones
  (`loginGlobalLimiter`, `adminGlobalLimiter`: 200 failures/day each); admin-key guesses are throttled on any `/api`
  request carrying `x-api-key`, not just `/api/admin`. Basic security headers are set in
  `server/index.ts` (frame-blocking/HSTS in production only, since some dev previews are iframes).
- Pick payloads are validated as integers (zod) before any `===` comparison against DB values — a
  string gameweek once slipped past the LMS deadline lock. Other players' LMS picks for any
  unlocked gameweek are redacted (team *and* match) via `lmsPickRedactor` on every LMS endpoint.
- **Navigation & theme.** On phones (below `md`) the games live in a fixed bottom nav
  (`client/src/components/BottomNav.tsx`): one tab per game the person plays in any of their
  groups (`useGameTabs()` in `client/src/lib/gameTabs.ts`, shared with the desktop header tabs),
  plus Settings — shown even with a single game. It hides while a text field has focus (iOS
  keyboard). A red dot marks a game whose picks are still owed in the group that tab opens
  (`GET /api/group/picks-due`, `server/navDue.ts`). `/settings` (`SettingsPage.tsx`) holds the
  Light/Dark/Auto theme, kickoff reminders (`ReminderSettings.tsx`), Add to Home Screen help and
  log out; the group owner also gets everything that was on `/group-settings`
  (`GroupAdminSettings`), which now opens Settings at that section. Its save bar shows only with
  unsaved changes, above the bottom nav. **Dark mode** (`client/src/lib/theme.tsx`, next-themes,
  `class="dark"`): every Tailwind colour scale (gray, blue, red, green…) reads a CSS variable
  from `client/src/lib/themePalette.ts` and flips in dark mode, so don't add `dark:` variants
  or raw `bg-white` (use `bg-card`); the header uses `bg-header`.
- All `/api/*` responses are sent `Cache-Control: no-store` on purpose (live scores must not be
  cached) — don't reintroduce caching there.
- Background jobs are started at boot in `server/index.ts`: `autoLmsProcessor` (deadline +
  live-score polling against football-data.org — once football-data's live minute reaches 90,
  `server/fplFinish.ts` also asks the FPL API whether the match is over (`finished_provisional`) and
  marks it finished with football-data's score if FPL's score agrees; FPL is used for nothing else,
  and a finished match is never put back to live (spec: `tests/fplFinish.spec.ts`, mock feeds via
  `FOOTBALL_DATA_API_BASE` / `FPL_API_BASE`) — plus an hourly refresh of the next few
  upcoming gameweeks' kickoff times — fixtures import with placeholder times and the live
  sync runs `updateTimes:false`, so this keeps upcoming times accurate), and
  `reminderProcessor` (per-minute web-push scheduler that reminds players before a gameweek's
  first kickoff — each person picks one or more lead times from presets, stored on
  `push_subscriptions.reminder_leads_minutes` (a json int[] of minutes), and each fires once
  per gameweek (deduped by `reminder_sends`, keyed incl. `lead_minutes`) — if they're still
  incomplete for Lawro / haven't picked for LMS; fires at the kickoff's absolute UTC instant
  minus the lead, so it's timezone-correct; no-op unless the VAPID keys are set). The
  `/admin/activity` and `/admin/audit` pages are admin-password gated (x-api-key = ADMIN_API_KEY) and show
  all groups with a group filter. `/admin/activity` folds each player's picks from `/api/admin/audit` into the session they happened in, and labels a `/` visit by the game it actually rendered (`landingGame()` in `shared/navGames.ts`, shared with App.tsx's `DefaultGame` — in a Lawro-only group `/` is the Lawro page). The owner can review who has
  reminders/PWA set up (or tried) at `/admin/notifications`. Every admin page (`/admin/activity`, `/admin/growth`, `/admin/audit`,
  `/admin/notifications`, `/admin/players`, `/admin/visitors`) renders inside
  `AdminLayout` (`client/src/components/AdminNav.tsx`: the site header with game tabs, the
  game pages' `max-w-5xl` column, then `AdminNav`; the password gate uses it too, minus the tabs); page titles use
  `AdminPageTitle`, which keeps any explanation behind an (i) button and reads the one `adminApiKey` localStorage
  key; add new admin pages to `ADMIN_LINKS` there. `/admin/changes` lists deployed changes
  from the committed `shared/changelog.json`, served by `GET /api/admin/changelog`.
  New entries use
  a stable `id`, `recordedAt` (ISO UTC), a title and bullets, plus `number` (the PR number: open the PR first, then add it; `npm run check` fails without it); The API sorts newest
  first via `shared/changelog.ts`. Growth/onboarding (new visitors, invite
  links opened, groups created, players joining, code logins and failed ones) is at
  `/admin/growth` (`GET /api/admin/growth`): those are `activity_logs` rows written by
  `logGrowthEvent()` in `server/groupAuth.ts`, and a "new visitor" is the first non-bot,
  non-prefetch page load from a browser without the anonymous `fwm_vid` cookie (players
  already logged in get the cookie silently, so they aren't counted).
  **Adding players / late LMS joiners** (`server/lmsEnrolment.ts`): a player added on `/admin/players`
  (`POST /api/admin/players` with the chosen `enabledGames`), joining by invite, or having LMS switched on
  goes into the current LMS competition only before its first deadline; otherwise they're put on a
  waiting list (activity_logs rows of type `lms_waiting_for_next`, no schema) that `nextLmsRoster()` adds
  to the next competition's carried-over roster (`lmsProcessor`, `lmsAutoStart`). Hiding LMS for a
  player removes them from a competition that hasn't started and takes them off the list. Adding a
  name already in the group (any case) is a 409.
  `/admin/players` can also **permanently delete** a player (this group's row, or every group the
  person is in) or a whole group: `server/adminDeletion.ts` does it in one transaction and serves
  the counts for the confirm dialog (`AdminDeleteDialog`) from the same row selection, so add any
  new user- or group-scoped table there. Logs (activity, LMS pick changes) are deleted, not
  anonymised; won LMS competitions, other groups' ownership and rule-change authorship are just
  unlinked. Deleting a group needs its name typed back, plus `confirmOriginal` for the original
  (hand-seeded) groups.

## Project layout

- `client/` — React 18 frontend (Vite). `src/pages/`, `src/components/` (incl. `ui/` shadcn), `src/hooks/`, `src/lib/`, `src/contexts/` (`GroupContext.tsx`).
  `src/App.tsx` defines routes (Wouter).
- `server/` — Express API. Key files: `routes.ts` (all endpoints), `storage.ts` (DB query layer —
  most reads/writes go through here), `db.ts`, `groupAuth.ts`
  (group cookie + auth helpers), `footballDataApi.ts` (live data),
  `autoLmsProcessor.ts` (background processing).
- `shared/schema.ts` — Drizzle ORM schema; the single source of truth for tables and inferred types.
- `scripts/` — standalone DB/admin utilities run with `tsx` (`npx tsx scripts/<name>.ts`). Spent
  one-offs are deleted once used, so what's left is reusable: dev
  simulators (`simulate*.ts`), diagnostics (`diagnoseLive.ts`, `snapshotLawro.ts`,
  `backfillLmsResults.ts`) and:
  `startLmsCompetition.ts` (manually start an LMS competition — normally unnecessary now that
  competitions auto-start, see `server/lmsAutoStart.ts`), `lmsImportPlFixtures.ts`
  (import PL fixtures), `syncFixtureTimes.ts` (pull authentic kickoff times from football-data
  for a gameweek range — corrects placeholder times). List the directory for the rest.
- `migrations/` — Drizzle artifacts; **not the change workflow** (see Database below).

## Conventions

- TypeScript strict mode; everything is typed. React function components + hooks only.
- Styling via Tailwind utility classes (no per-component CSS); shadcn/ui ("new-york" style).
- **All database access goes through Drizzle ORM** — no raw SQL in feature code. Prefer adding/
  reusing methods on `server/storage.ts` rather than querying `db` directly in routes. Validate
  payloads with Zod / drizzle-zod (`createInsertSchema`).
- Path aliases: `@/*` → `client/src`, `@shared/*` → `shared`.
- Naming: PascalCase for components and types, camelCase for variables/functions.

## Database & schema workflow

`shared/schema.ts` is the source of truth. To change the schema: edit it, then run
`npm run db:push` to apply it directly (this project uses `drizzle-kit push`, **not**
generate/migrate — do not hand-write migration files). Apply the same push against your
production database when you deploy. Use `$inferSelect` / drizzle-zod for typed rows and validation.

### Table directory

All tables are defined in `shared/schema.ts` (the authoritative reference for columns). Grouped
by area:

- **Core/shared:** `groups`, `users` (group-scoped), `teams`, `matches`, `group_rule_changes`
  (rule-change log: drives the pop-up and per-gameweek Lawro rules)
- **Prediction League:** `predictions` (unique per `user_id` + `match_id`; any manual
  insert must still guard with `WHERE NOT EXISTS`)
- **LMS:** `lms_competitions`, `lms_participants`, `lms_selections`, `lms_selection_logs`
- **Tracking/audit:** `activity_logs`, `visitors`
- **Server secrets:** `app_secrets` (generated cookie-signing key; never sent to clients)
- **Push reminders:** `push_subscriptions` (one row per opted-in device), `reminder_sends`
  (dedupe log so each person/game/gameweek reminder sends once)

Most rows are `groupId`-scoped (see Multi-group model). `matches` are season-scoped — see the
landmine about never deleting them by id range.

## Multi-group model (read before touching user/competition data)

The app isolates groups by `groupId`. Login is **per-person**: each person has a private
`login_code` that they enter on the landing page. Someone in several groups has one `users` row
per group (all sharing the same `login_code`), so a single code signs them in and lets them
switch groups via the header dropdown (`POST /api/group/switch`) — the code is therefore unique
*per person*, not at the DB level (uniqueness is enforced in `server/loginCodes.ts`, which reuses
a person's existing code across their rows and never mints one another person already has). The
HMAC-signed `fwm_user` cookie stores `<userId>:<groupId>` (the active group's row); `groupContext`
middleware populates both `req.userId` and `req.groupId` from it (no DB lookup); `requireGroup`
gates endpoints that need a group. Codes are generated/backfilled by `server/loginCodes.ts`
(idempotent boot backfill in `server/index.ts`, unified per person), and surfaced per-player in
the admin players page so the owner can distribute them. `/api/group/login`, `/me` and `/switch`
all return the person's `availableGroups` list (each entry carries that group's effective
`enabledGames` for this person) that drives the switcher **and** the header's cross-group game
tabs: the nav shows every game any of the person's groups offers, and clicking a game hosted by
another group switches them into that group first (`switchGroup`), then routes to it. LMS
mutations enforce `participant.userId === req.userId` so a player can only edit their own picks.
**Mutations that write data for a specific user must verify `userInGroup(userId,
req.groupId)`** (see `server/groupAuth.ts`) so a caller in one group can't write picks as a user
in another. Any new query that reads user/competition rows should filter by the relevant
`groupId`. Pick changes should be recorded with `logAuditEvent` for the `/admin/audit` view.

### Self-service groups & per-group rules

Anyone can create their own group from the public pages (no admin key needed):

- `POST /api/group/create` ({ groupName, adminName, games }) — makes the group, makes the caller
  its first player **and** its admin (`groups.ownerUserId`), mints an invite token, logs them in,
  and returns their login code. `GET /api/group/invite/:token` describes a group for the join
  page; `POST /api/group/join/:token` ({ name }) creates the joiner's player row + login code and
  signs them in. Self-service groups run `lms` and/or `predictions`. Client pages: `/create`, `/join/:token` (both public — see `GatedShell`).
- These return the user's own code as **`code`**, not `loginCode`, on purpose — the global `/api`
  redaction middleware strips any `loginCode` key, so don't rename it back.
- **A name must never hand out a login code.** Create/join give a fresh code
  (`codeForNewSelfServiceRow` in `server/loginCodes.ts`), or the caller's own code if they're
  already signed in (that's how one person gets several groups). Joining under a name already in
  the group is refused (409). Matching people by username (`codeForUsername`, the boot
  `unifyLoginCodesAcrossGroups`) only happens inside the original groups (no invite token), where
  names really are people. Login, join and create are rate-limited (`server/rateLimits.ts`; tests
  set `DISABLE_RATE_LIMITS=1`, which is ignored in production).
- **Group admin player tools** (owner only, on `/group-settings` via `GroupPlayersCard`):
  `GET /api/group/players`, `PUT /api/group/players/:id/lms` (sit out / add back to the current LMS
  competition, only before its first deadline — the next competition copies its roster, so sitting
  out lasts until they're added back), `POST /api/group/players/:id/reset-code` (refused if that
  person's code also covers a group the admin doesn't run), `PATCH /api/group/players/:id` (rename,
  self-service groups only), `DELETE` (only players
  with no picks/results, never the admin) and `POST /api/group/invite/reset` (new invite link).
- **Per-group rules** live on `groups.rules` (a partial `GroupRules`; NULL = defaults). Always read
  through `resolveGroupRules()` / `server/groupRules.ts`'s `getGroupRules(groupId)` so partial blobs
  merge onto `DEFAULT_GROUP_RULES` — every default reproduces the old hard-coded behaviour, so
  existing groups are unchanged until their admin edits something. LMS stakes: each new
  competition records `lms_competitions.stake_gbp` from the buy-in (groups with an admin only);
  NULL means an original group's older competition and the LMS page uses its legacy per-season
  table. The admin (owner only — both
  `GET` and `PUT /api/group/rules` 403 anyone else) edits them at `/group-settings`, which shows only
  the games the group plays. **LMS rules freeze once the running competition's first deadline has
  passed** (`gamesLive()` in `routes.ts`; `PUT` returns 409). **Lawro rules never freeze, but are
  never retroactive:** each save is logged in `group_rule_changes` (before/after + readable diff),
  and a Lawro change applies from the first gameweek whose deadline hadn't passed
  (`lawroEffectiveGameweek`); earlier gameweeks keep their old rules. So anything Lawro-rule
  dependent (points, deadline offset, missed-pick policy) must be read per gameweek via
  `getLawroRulesResolver()` (`server/groupRules.ts`, built on `lawroRulesAt()` in the schema), not
  from the current rules. The client takes per-prediction `points` from the server for the same
  reason. **Every rule change pops up for every other player** (`RuleChangesDialog`, fed by the
  session's `ruleChanges`, each naming who made it ("Alex has changed the rules"); dismissing it
  goes through `GroupContext.dismissRuleChanges`, which drops them from the session and calls
  `POST /api/group/rule-changes/seen`, tracked on
  `users.last_seen_rule_change_id`; joiners start at the latest change). Acknowledgements are
  saved atomically with that marker in `activity_logs` (`rule_change_acknowledged`), including
  the change IDs and readable diffs, and shown on `/admin/audit` under Rules with only the
  accepted values in each summary (including existing entries). Repeated/concurrent
  dismissals don't duplicate entries; a player's own edits aren't acknowledgements. These
  events are excluded from `/admin/activity`'s pick counts. Covered knobs: Lawro
  points (exact/result, threaded through `optimizedQueries.ts` scoring + `HomePage.tsx` tallies),
  Lawro/LMS deadline offset (minutes before first kickoff), Lawro missed-pick policy
  (blank/random/open_until_kickoff — random is filled by `server/lawroMissedPicks.ts` off the
  per-minute LMS cron; open_until_kickoff lets a player who missed the deadline still add picks for
  matches that haven't kicked off, flagged `predictions.is_late_pick`, and reveals each match's picks
  at its own kick-off instead of the deadline), the Lawro Joker (`lawro.jokerEnabled`, default off,
set only in `/group-settings` (after creating a group the admin is sent there): each player flags one prediction per gameweek as their Joker via the picker
above the Lawro grid — `PUT /api/predictions/:id/joker`, stored on `predictions.is_joker` — and its
points are doubled in `optimizedQueries.ts`; it can only move while both picks are still editable), LMS buy-in (default £10), lives (cumulative-loss derivation in
  `lmsProcessor.ts`, idempotent), LMS missed-pick policy (random/eliminate in `autoLmsProcessor.ts`
  — eliminate records a `team_id = NULL`, result `l` selection, so a miss costs one life and only
  knocks out on the last) and all-out policy (rollover/co_winners/no_winner — a new competition
  always follows either way). **Team reuse is never allowed** (there is deliberately no setting).
  Session payload (`/api/group/me`) carries the resolved `rules` + `isOwner`; the LMS page's rules
  text reads them. The client re-reads it (`GroupContext.refreshSession`) after the admin saves rules
  and whenever the app returns to the foreground, so a rule switched on shows without a reload.
- **LMS competitions start themselves** (`server/lmsAutoStart.ts`): a new group with LMS gets one at
  creation for the next gameweek that hasn't kicked off; one ending mid-season rolls into the next
  (`lmsProcessor.startNextCompetition`); after the season, a sweep (boot, every 6h, after results)
  opens next season's GW1 competition once its fixtures are imported. It only ever starts at a
  gameweek that exists in the current season's fixtures and hasn't kicked off — never before a new
  season's fixtures exist. A competition with a single player never crowns them the winner.

## Environment variables

- `DATABASE_URL` — Postgres connection string (required; server refuses to boot without it).
- `FOOTBALL_DATA_API_KEY` — football-data.org v4 key for live PL fixtures and scores
  (premium plan, ~20 calls/min — polling is rate-aware; respect the budget).
- `GROUP_COOKIE_SECRET` — optional HMAC secret for the group cookie. If unset, the server
  generates one on first boot and stores it in `app_secrets` (`initCookieSecret()` in
  `server/groupAuth.ts`). Cookies signed with an older key (the stored secret, `ADMIN_API_KEY` — the
  old fallback — or, outside production only, the dev default) still verify and are re-signed with
  the current key on the next request, so changing the key never signs anyone out.
- `ADMIN_API_KEY` — guards admin endpoints.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — web-push (VAPID) key pair for kickoff-reminder
  notifications. Generate with `npx tsx scripts/generateVapidKeys.ts`. If unset, push is
  disabled and `reminderProcessor` is a no-op (the app still boots). Keep the private key secret.
- `VAPID_SUBJECT` — contact URL for push (e.g. `mailto:admin@example.com`); optional,
  defaults to a mailto.
- `PORT`, `NODE_ENV` — standard.

Push reminders are a PWA feature: the client registers a service worker (`client/public/sw.js`)
and manifest (`client/public/manifest.webmanifest`); on iOS, notifications only work once the
site is installed to the Home Screen. After changing `shared/schema.ts` for the two push tables,
run `npm run db:push` (against your production database too when you deploy).

**Locations** on the admin pages are an offline IP lookup (`geoip-lite`, `server/geolocation.ts`), never
the device's, and never a third-party request. Display them through `describeLocation()` in `shared/ipLocation.ts`: cities show as
"(approx.)", and known relay egress ranges (iCloud Private Relay / Cloudflare WARP) show as
"Private relay / VPN" plus the country. Only 172.16.0.0/12 is private (`isPrivateIP`).

## Critical landmines (do not relearn these the hard way)

`server/index.ts` runs idempotent, self-healing data fixes on every boot and carries explicit
warnings. Respect them:

- **Never delete matches by id range.** A past boot-time `id >= N` delete wiped newly imported
  seasons on every restart (collapsing season-scoping and auto-randomising LMS picks). Scope all
  match deletions by season — use `deleteMatchesBySeason`.
- **Never auto-regenerate fixtures.** A since-deleted `generateCompleteFixtures()` inserted 380
  *fictional* round-robin matches with synthetic dates and no existence check; it silently
  doubled/corrupted the matches table. The authentic Premier League fixtures are the source of truth and must not be
  regenerated.
- Boot-time `UPDATE`s in `server/index.ts` (legacy result-code conversion, bogus-score cleanup,
  kickoff-time backfill) are intentionally idempotent — keep any new ones idempotent too.
- Live scores and game state are advanced by the background processors; changing their timing or
  result logic affects eliminations and leaderboards — tread carefully.

### Finer activity and audit events

`POST /api/track/event` ({ event, path, detail }, whitelisted in `shared/activityEvents.ts`) stores
`ui_event` rows in `activity_logs`: app backgrounded/foregrounded (`usePageTracking`), LMS wheel
watched (`LmsWheel`, once per wheel and stage), Fixtures cells highlighted / rows hidden, Tendencies
toggles and chart taps (throttled 30s per chart), push opened (push links carry `?via=push&n=<tag>`,
added in `server/push.ts`, stripped by the client) and dismissed (`sw.js` `notificationclose`), and
device settings (theme). `sendToUser` logs one `push_sent` row per notification. The track
endpoints accept logged-out visitors and share `trackEventLimiter`. Group
rule saves, player renames/removals and invite resets are audited too. `/admin/audit` gets all of
these from `server/auditExtras.ts` (Settings / Reminders / Usage filters); `/admin/activity` reads
them from its own feed and shows a per-session timeline with an "active" time (minus background),
plus logged-out `/create` sessions, matched to a person via the `fwm_vid` cookie when possible.

### Admin metrics

`/admin/metrics` calls admin-key-protected `GET /api/admin/metrics?days=28&interval=day` (1–365 days; day/week/month). `server/metrics.ts` aggregates a complete time-bounded activity-log query, compares the preceding equal-length window, unifies player rows across groups on the server, filters bots/passive/static/admin traffic and pairs duplicate server/client views. Charts use UTC calendar buckets (Monday weeks); boundary buckets may be partial. Browser-based conversion follows new visitors to create/join within the window; it is not a person-based signup rate. Historical anonymous views without a visitor cookie use IP + UA estimates. Tracking endpoints now retain the visitor id for SPA views and tab changes. No schema change. Visitors live at `/admin/visitors`; Audit and Activity live under `/admin/` and bypass the group gate. Old /admin, /audit and /activity bookmarks redirect to their canonical admin URLs.


Metrics review follow-up: admin navigation places Metrics between Growth and Visitors.
Conversion is a fixed seven-day new-browser cohort metric: only visitors with seven full days
of follow-up enter the denominator; younger cohorts remain pending, even if already converted.
Repeat joins (`details.rejoin`) do not count as new memberships or conversions. Founders +
first-time joins are reported as memberships, never as distinct newly acquired people.
`logAuditEvent` now records `actorRecorded` and `actorUserId` in details while keeping
`activity_logs.userId` as the audit subject. Metrics uses the actor for engagement. Historical
Lawro subject-only actions contribute volume but not people; historical LMS resolves its
validated participant. Show unattributed action counts.
Missing user agents are retained and flagged; different known visitor cookies never pair during
view deduplication. Sessions are counted at their start using 30 minutes of boundary lookback,
so bucket counts add up. History is measured separately for activity and growth; comparisons
are suppressed when history starts too late, and pre-history chart points are null. Partial
calendar buckets are labelled. Earliest recorded dates do not prove uninterrupted tracking.
