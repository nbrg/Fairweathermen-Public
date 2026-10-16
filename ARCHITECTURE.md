# Architecture

A tour of how the app is put together: the structure, the conventions, and a few
data-integrity rules that are easy to get wrong. If you change how something works, keep
this up to date.

## Overview

Fairweathermen is a full-stack TypeScript app for Premier League predictions among closed
groups of friends. It hosts three games, each with its own pages/routes/tables:

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
- **Last Man Standing (LMS)** — each gameweek a player picks one team to win; a wrong pick
  eliminates them, last player standing wins. Runs as competitions that span multiple seasons and
  groups. (tables: `lms_competitions`, `lms_participants`, `lms_selections`, `lms_selection_logs`)
- **Golf** — track per-hole tournament scores with handicaps and record prize winners (e.g.
  nearest-pin, longest-drive). (tables: `golf_*`)


## Commands

```bash
npm run dev      # Dev server (Express + Vite middleware) on port 5000
npm run check    # TypeScript type-check (tsc --noEmit) — the ONLY automated gate
npm run build    # Build client (Vite) + bundle server (esbuild) into dist/
npm run start    # Run the production bundle (NODE_ENV=production)
npm run db:push  # Apply shared/schema.ts to the database (drizzle-kit push)
```

There is **no test runner, ESLint, or Prettier**. `npm run check` is the only verification
gate — run it after every change. Otherwise verify behavior by running `npm run dev` and
exercising the affected page/endpoint.

## Architecture

- **Single Express server serves both the API and the client.** In dev, Vite runs as Express
  middleware (`server/vite.ts` → `setupVite`); in prod it serves the static build
  (`serveStatic`). There is no separate frontend dev server.
- Port is `process.env.PORT || 5000`.
- **Database is Neon serverless Postgres over a WebSocket** (`@neondatabase/serverless` + `ws`,
  via Drizzle's `neon-serverless` adapter — see `server/db.ts`). `DATABASE_URL` must point at a
  Neon-compatible endpoint; a plain local `postgres://` will not work without adaptation.
- All `/api/*` responses are sent `Cache-Control: no-store` on purpose (live scores must not be
  cached) — don't reintroduce caching there.
- Background jobs are started at boot in `server/index.ts`: `autoLmsProcessor` (deadline +
  live-score polling against football-data.org, plus an hourly refresh of the next few
  upcoming gameweeks' kickoff times — fixtures import with placeholder times and the live
  sync runs `updateTimes:false`, so this keeps upcoming times accurate), and
  `reminderProcessor` (per-minute web-push scheduler that reminds players before a gameweek's
  first kickoff — each person picks one or more lead times from presets, stored on
  `push_subscriptions.reminder_leads_minutes` (a json int[] of minutes), and each fires once
  per gameweek (deduped by `reminder_sends`, keyed incl. `lead_minutes`) — if they're still
  incomplete for Lawro / haven't picked for LMS; fires at the kickoff's absolute UTC instant
  minus the lead, so it's timezone-correct; no-op unless the VAPID keys are set). The
  `/activity` and `/audit` pages are admin-password gated (x-api-key = ADMIN_API_KEY) and show
  all groups with a group filter. The owner can review who has
  reminders/PWA set up (or tried) at `/admin/notifications`.

## Project layout

- `client/` — React 18 frontend (Vite). `src/pages/`, `src/components/` (incl. `ui/` shadcn),
  `src/hooks/`, `src/lib/`, `src/contexts/` (`GroupContext.tsx`).
  `src/App.tsx` defines routes (Wouter).
- `server/` — Express API. Key files: `routes.ts` (all endpoints), `storage.ts` (DB query layer —
  most reads/writes go through here), `db.ts`, `groupAuth.ts`
  (group cookie + auth helpers), `footballDataApi.ts` (live data),
  `autoLmsProcessor.ts` (background processing), `scraper.ts` (Flashscore
  fallback).
- `shared/schema.ts` — Drizzle ORM schema; the single source of truth for tables and inferred types.
- `scripts/` — standalone DB/admin utilities run with `tsx` (`npx tsx scripts/<name>.ts`). Most are
  throwaway one-offs (per-person data fixes, prod hotfixes — `add-*`, `update-*`, `fix-prod-*`);
  don't treat them as a maintained API. The durable, reusable ones worth knowing:
  `startLmsCompetition.ts` (start an LMS season), `lmsImportPlFixtures.ts` / `importFixtures.ts`
  (import PL fixtures), `syncFixtureTimes.ts` (pull authentic kickoff times from football-data
  for a gameweek range — corrects placeholder times).
  List the directory for the rest.
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

- **Core/shared:** `groups`, `users` (group-scoped), `teams`, `matches`
- **Prediction League:** `predictions`
- **LMS:** `lms_competitions`, `lms_participants`, `lms_selections`, `lms_selection_logs`
- **Golf:** `golf_tournaments`, `golf_scores`, `golf_handicaps`, `golf_prize_winners`
- **Tracking/audit:** `activity_logs`, `visitors`
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
`groupId`. Pick changes should be recorded with `logAuditEvent` for the `/audit` view.

## Environment variables

- `DATABASE_URL` — Neon Postgres connection string (required; server refuses to boot without it).
- `FOOTBALL_DATA_API_KEY` — football-data.org v4 key for live PL fixtures and scores
  (premium plan, ~20 calls/min — polling is rate-aware; respect the budget).
- `GROUP_COOKIE_SECRET` — HMAC secret for the group cookie (falls back to `ADMIN_API_KEY`, then an
  insecure dev default that logs a warning). Set a real value in any shared environment.
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

## Critical landmines (do not relearn these the hard way)

`server/index.ts` runs idempotent, self-healing data fixes on every boot and carries explicit
warnings. Respect them:

- **Never delete matches by id range.** A past boot-time `id >= N` delete wiped newly imported
  seasons on every restart (collapsing season-scoping and auto-randomising LMS picks). Scope all
  match deletions by season — use `deleteMatchesBySeason`.
- **Never auto-regenerate fixtures.** `generateCompleteFixtures()` inserts 380 *fictional*
  round-robin matches with synthetic dates and no existence check; it silently doubled/corrupted
  the matches table. The authentic Premier League fixtures are the source of truth and must not be
  regenerated.
- Boot-time `UPDATE`s in `server/index.ts` (legacy result-code conversion, bogus-score cleanup,
  kickoff-time backfill) are intentionally idempotent — keep any new ones idempotent too.
- Live scores and game state are advanced by the background processors; changing their timing or
  result logic affects eliminations and leaderboards — tread carefully.
