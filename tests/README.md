# End-to-end tests

These run the real app — the Express server, the React client, and a Postgres
database — and drive it with Playwright. There are no mocks: a request goes
through the actual API and hits the actual database, which is how the tests can
check things like the deadline-redaction rule or the Last Man Standing team
reuse logic.

## What's covered

- **Auth** — logging in with a personal code (case-insensitive), rejecting a
  bad one, and the group/games the login returns.
- **Lawro** — other players' picks stay hidden until a gameweek's deadline and
  are revealed afterwards, both in the API and in the grid (lock vs. dash vs.
  editable cell); the leaderboard scores 3 for an exact score, 1 for the right
  result, 0 otherwise; the page's tabs (Predictions, Leaderboard, Table,
  Tendencies) render, you can submit a pick for the open gameweek and step back
  to a finished one.
- **Last Man Standing** — you can't reuse a team, you can only edit your own
  pick, a valid pick for the open gameweek is accepted, and every tab
  (Live/History/Fixtures/Stats/Rules) opens.
- **Groups** — self-service group creation with per-group rules, and switching
  the active group both over the API and through the header switcher.
- **Navigation & help** — the right game tabs show up and load, the help page
  lists the live games, and unknown or removed routes (including the old World
  Cup, Golf and season-predictions pages) 404.
- **Admin** — the players, audit and activity screens stay locked without the
  admin key and load with it; the admin API endpoints reject a missing or wrong
  key.
- **Security** — no login code or password ever leaks through any `/api`
  response.
- **Smoke** — the landing page, the PWA manifest/service worker, and the
  `no-store` header on API responses.

Every spec runs across five browser profiles — desktop Chrome, Firefox and
Safari plus mobile Chrome and mobile Safari — so the layouts are exercised at
phone and desktop widths on all three engines.

## Running them

You need Node 20+ and a Postgres you don't mind wiping. Point `DATABASE_URL` at
it (default is a local `fairweathermen_test` database).

```bash
# First time only: grab the browsers Playwright drives
# (all five profiles; use `npx playwright install chromium` for just Chrome)
npx playwright install

# Spin up a throwaway Postgres if you don't have one
docker run --rm -d -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fairweathermen_test \
  --name fwm-test-db postgres:16

npm test            # run everything
npm run test:affected # only the specs your uncommitted change touches
npm run test:headed # watch it in a real browser window
npm run test:ui     # Playwright's interactive UI
```

Before the first test, the suite applies the schema (`drizzle-kit push`) and
seeds a small fixed dataset — see [`global-setup.ts`](./global-setup.ts) and
[`../scripts/seedTestData.ts`](../scripts/seedTestData.ts). The seed prints
three login codes (`demo-alex`, `demo-blake`, `demo-casey`) you can also use to
poke around the app by hand.

After a run, `npx playwright show-report` opens the HTML report.

## On CI

GitHub Actions ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs
the type-check and the five browser profiles as separate jobs in parallel, each
with its own Postgres, and a final `test` job that goes green only if they all
did (that's the one status to require in branch protection).

To keep pull requests quick, a PR only runs the specs its diff actually touches:
[`affected.mjs`](./affected.mjs) maps each source file to the area(s) that
exercise it, and anything core (schema, `routes.ts`, the app shell, the test
harness, build config) or unmapped falls back to the whole suite. Pushes to
`main` and manual runs always run everything. When you add a source file, add it
to an area in `affected.mjs` so PRs touching it stay fast; a new spec is picked
up automatically.
