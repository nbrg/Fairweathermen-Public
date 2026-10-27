# Fairweathermen

A web app for running season-long Premier League games with a group of mates.
One install hosts two separate games, each with its own pages and tables:

- **Prediction League ("Lawro").** Predict the exact scoreline of every Premier
  League match, a gameweek at a time. You get 3 points for the exact score and 1
  for the right result. Your picks stay private until the gameweek kicks off,
  then everyone's are shown. There's a leaderboard, per-season and per-gameweek
  views, a live countdown to the deadline, and a stats tab.
- **Last Man Standing.** Each gameweek you pick one team to win. Get it wrong and
  you're out; last person standing takes the pot. Competitions can run across
  several seasons, and every pick change is logged.

Live scores and fixtures come from [football-data.org](https://www.football-data.org/).
Eliminations, leaderboards and reminders all happen on their own in the
background.

The live site at **[fairweathermen.com](https://fairweathermen.com)** runs from a
private repo that I built and maintain for my own groups. **This is a slightly
simplified, open version of that codebase** — the same app, with a couple of the
games taken out (the private version also runs a golf tracker and a World Cup
predictor) and every token, credential and third-party integration stripped out.
Nothing here points at the live deployment.

I keep it public for two reasons: so a friend can spin up their own league, and
so anyone curious about the code can read a real, running full-stack app rather
than a toy. To run it yourself, see
[running your own copy](#running-your-own-copy).

## Stack

TypeScript everywhere. React 18 + Vite on the front end (Wouter for routing,
TanStack Query for data, Tailwind and shadcn/ui for styling, Recharts for the
charts). Express on the back end, serving both the API and the client from one
process. Postgres through Drizzle ORM — Neon's serverless driver in production,
plain `pg` anywhere else. Web push for reminders, via a service worker, so it
installs as a PWA. Playwright for the end-to-end tests, running in CI.

## How it fits together

```
client/          React app (Vite)
  src/pages/        one page per game, plus the admin pages
  src/components/   shared UI and shadcn/ui primitives
  src/contexts/     GroupContext — the active group and the ones you can switch to
server/           Express API and the background jobs
  routes.ts         the HTTP endpoints
  storage.ts        the query layer most reads and writes go through
  db.ts             the Drizzle/Postgres connection
  groupAuth.ts      the login cookie and the per-group access checks
  footballDataApi.ts     the live-data client
  autoLmsProcessor.ts    the background processing
  reminderProcessor.ts   the push reminder scheduler
shared/schema.ts  the Drizzle schema — the one source of truth for the tables
scripts/          one-off and setup utilities, run with tsx
tests/            the Playwright suite
```

A few things I'd point at if you're reading the code:

- **Picks are sealed until kickoff by the server, not the UI.** The predictions
  endpoint strips other players' scorelines out of the response until the
  gameweek deadline passes. It still tells you *that* someone has picked, so the
  grid can show who's in, but not what they chose. Weekly results are also saved
  as hash-chained JSON snapshots so it's checkable that a season wasn't edited
  after the fact.
- **The live-data pipeline is rate-aware.** The background job polls
  football-data.org often while matches are in play and sits idle otherwise, to
  stay inside the API's rate limit. When a match finishes it works out the Last
  Man Standing result straight away and the eliminations follow from that.
- **One person, many groups.** You log in with a private code, not a username and
  password. If you're in more than one group you have one code and switch between
  them. Every write that touches another user's data checks you're actually in
  that group first.
- **Anyone can start their own group.** From the public pages you can create a
  group (`/create`), name it, pick its games, and become its admin; you get your
  login code and an invite link (`/join/<token>`) that hands each new player their
  own code. As the admin you tune the group's rules at `/group-settings` — Lawro
  points, both games' deadline, the missed-pick policy, and LMS lives, buy-in
  and what happens when everyone goes out together. Every rule defaults
  to the original behaviour, so existing groups are unchanged until you edit one.

There's a fuller tour of the architecture, the conventions, and a few mistakes
worth not repeating in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Running your own copy

You'll need Node 20 or newer, a Postgres database, and (if you want live scores)
a [football-data.org](https://www.football-data.org/) API key.

**1. Fork and clone.** If you want your own league to run and tweak, fork the
repo on GitHub first (the **Fork** button, top right) — that gives you your own
copy to push to. Then clone it, replacing `<your-username>` with your GitHub
name:

```bash
git clone https://github.com/<your-username>/Fairweathermen-Public.git
cd Fairweathermen-Public
```

If you only want to run it as-is, clone this repo directly instead:

```bash
git clone https://github.com/nbrg/Fairweathermen-Public.git
cd Fairweathermen-Public
```

**2. Install the dependencies.**

```bash
npm install
```

**3. Set up your environment.** Copy the example file and fill in your own
values:

```bash
cp .env.example .env
```

```
DATABASE_URL          your Postgres connection string
ADMIN_API_KEY         any secret; it guards the admin pages
GROUP_COOKIE_SECRET   a long random string (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
FOOTBALL_DATA_API_KEY optional; without it, live scores are just skipped
VAPID_*               optional; run `npx tsx scripts/generateVapidKeys.ts` for a key pair
```

**4. Create the tables, and a first group to log in with.**

```bash
npm run db:push                           # apply the schema to your database
npx tsx scripts/startLawro.ts --confirm   # make a group and add some players
```

`startLawro.ts` prints each player's login code when it runs — those are what
people type on the landing page. (You can also skip it and create your group
from the running app at `/create`.)

**5. Start it.**

```bash
npm run dev                               # http://localhost:5000
```

For a production build instead, run `npm run build` then `npm run start` (see
[Commands](#commands) below).

### Commands

```bash
npm run dev      # dev server (Express + Vite) on port 5000
npm run check    # TypeScript type-check
npm run build    # build the client and bundle the server into dist/
npm run start    # run the production build
npm run db:push  # apply shared/schema.ts to the database
npm test         # run the Playwright tests
```

### Database

Production runs on Neon serverless Postgres, which talks over a WebSocket.
Locally the connection layer notices a plain `postgres://` URL and uses an
ordinary `pg` pool instead, so any normal Postgres (local, Docker, Supabase,
RDS) works for development and the tests. You can force either with
`DATABASE_DRIVER=neon` or `DATABASE_DRIVER=pg`.

## Tests

The Playwright suite in [`tests/`](./tests) drives the real app against a
throwaway Postgres database — no mocks. It covers login and the group model,
the Lawro deadline-redaction rule and scoring, the Last Man Standing pick rules,
navigation and the help page, multi-group
switching, self-service group creation, the admin pages, and a set of checks
that no login code or password ever leaks through the API. Every spec runs
across five browser profiles — desktop Chrome, Firefox and Safari plus mobile
Chrome and Safari — and the whole matrix runs on every push via GitHub Actions.
Setup and the full list are in [tests/README.md](./tests/README.md).

```bash
npx playwright install   # first time only; downloads the browsers
npm test
npx playwright show-report
```

## Credits

Built and maintained by [nbrg](https://github.com/nbrg).

## License

[MIT](./LICENSE).
