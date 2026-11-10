import { test, expect } from "@playwright/test";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { reseed } from "./seed";

// football-data often keeps a match IN_PLAY for minutes after the final
// whistle, so LMS picks took ~5 minutes to turn green/red. Once football-data's
// live minute reaches 90, the live sync also asks the FPL API whether the match
// is over (finished_provisional), and marks it finished with football-data's
// score when the two scores agree. These tests run the real syncGameweek
// against a mock football-data + FPL server.

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/fairweathermen_test";
const MOCK_PORT = 5099;
const KICKOFF_LONDON = "2026-11-08 15:00"; // GMT, so London = UTC
const KICKOFF_UTC = "2026-11-08T15:00:00Z";

async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    return (await pool.query(text, params)).rows as T[];
  } finally {
    await pool.end();
  }
}

// What the mock feeds return; each test sets these.
let fd: { status: string; minute: number | string | null; home: number; away: number };
let fpl: { finishedProvisional: boolean; finished: boolean; home: number; away: number };
let fplHits = 0;
let server: http.Server;

function fdMatch() {
  return {
    id: 1,
    utcDate: KICKOFF_UTC,
    status: fd.status,
    matchday: 2,
    minute: fd.minute,
    // Ids outside TEAM_ID_MAP, so the sync resolves them by TLA.
    homeTeam: { id: 9001, tla: "LIV", name: "Liverpool FC" },
    awayTeam: { id: 9002, tla: "MCI", name: "Manchester City FC" },
    score: { fullTime: { home: fd.home, away: fd.away }, halfTime: { home: 0, away: 0 } },
  };
}

function fplFixture() {
  return {
    id: 77, event: 11, team_h: 12, team_a: 13, kickoff_time: KICKOFF_UTC,
    started: true, finished: fpl.finished, finished_provisional: fpl.finishedProvisional,
    minutes: 90, team_h_score: fpl.home, team_a_score: fpl.away,
  };
}

// Another fixture at the same kickoff, so the lookup has to match on teams.
const otherFixture = {
  id: 78, event: 11, team_h: 1, team_a: 14, kickoff_time: KICKOFF_UTC,
  started: true, finished: true, finished_provisional: true, minutes: 90, team_h_score: 0, team_a_score: 0,
};

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    let body: unknown = null;
    if (url.startsWith("/fd/competitions/PL/matches")) body = { matches: [fdMatch()] };
    else if (url.startsWith("/fpl/bootstrap-static/")) {
      body = { teams: [
        { id: 1, short_name: "ARS", name: "Arsenal" },
        { id: 12, short_name: "LIV", name: "Liverpool" },
        { id: 13, short_name: "MCI", name: "Man City" },
        { id: 14, short_name: "CHE", name: "Chelsea" },
      ] };
    } else if (url.startsWith("/fpl/fixtures/")) {
      fplHits += 1;
      body = [otherFixture, fplFixture()];
    }
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "not found" }));
  });
  await new Promise<void>((r) => server.listen(MOCK_PORT, r));
});
test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

let matchId: number;
let selectionId: number;
test.beforeEach(async () => {
  reseed();
  const [m] = await sql<{ id: number }>(
    `SELECT m.id FROM matches m JOIN teams h ON h.id = m.home_team_id WHERE m.gameweek = 2 AND h.short_name = 'LIV'`,
  );
  matchId = m.id;
  await sql(`UPDATE matches SET status = 'in_progress', home_score = 2, away_score = 1, minute = 80, match_time = $2 WHERE id = $1`, [
    matchId,
    KICKOFF_LONDON,
  ]);
  // Blake picked Liverpool in GW2.
  const [p] = await sql<{ id: number }>(
    `SELECT p.id FROM lms_participants p JOIN users u ON u.id = p.user_id WHERE u.username = 'Blake' LIMIT 1`,
  );
  const [liv] = await sql<{ id: number }>(`SELECT id FROM teams WHERE short_name = 'LIV'`);
  const [s] = await sql<{ id: number }>(
    `INSERT INTO lms_selections (participant_id, team_id, gameweek, match_id) VALUES ($1, $2, 2, $3) RETURNING id`,
    [p.id, liv.id, matchId],
  );
  selectionId = s.id;
  fplHits = 0;
  fd = { status: "IN_PLAY", minute: 92, home: 2, away: 1 };
  fpl = { finishedProvisional: true, finished: false, home: 2, away: 1 };
});

// Run one live-sync pass of GW2 in its own process, against the mock feeds.
// Asynchronous on purpose: the mock server lives in this process, so a
// blocking exec would deadlock it.
async function syncOnce() {
  const script =
    "import('./server/footballDataApi.ts').then(m => m.syncGameweek(2, { updateTimes: false, updateScores: true }))" +
    ".then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })";
  await promisify(execFile)("npx", ["tsx", "-e", script], {
    cwd: process.cwd(),
    timeout: 60_000,
    env: {
      ...process.env,
      DATABASE_DRIVER: "pg",
      DATABASE_URL,
      FOOTBALL_DATA_API_KEY: "test-key",
      FOOTBALL_DATA_API_BASE: `http://localhost:${MOCK_PORT}/fd`,
      FPL_API_BASE: `http://localhost:${MOCK_PORT}/fpl`,
    },
  });
}

async function state() {
  const [m] = await sql(`SELECT status, home_score, away_score, minute FROM matches WHERE id = $1`, [matchId]);
  const [s] = await sql(`SELECT result FROM lms_selections WHERE id = $1`, [selectionId]);
  return { status: m.status, score: `${m.home_score}-${m.away_score}`, minute: m.minute, result: s.result };
}

test("at 90+ a match FPL calls finished is marked finished and LMS picks are settled", async () => {
  await syncOnce();
  expect(await state()).toEqual({ status: "finished", score: "2-1", minute: null, result: "w" });
});

test("stoppage time written as 90+3 counts as 90+", async () => {
  fd.minute = "90+3";
  await syncOnce();
  expect((await state()).status).toBe("finished");
});

test("before the 90th minute FPL isn't asked at all", async () => {
  fd.minute = 85;
  await syncOnce();
  expect(fplHits).toBe(0);
  expect(await state()).toEqual({ status: "in_progress", score: "2-1", minute: 85, result: null });
});

test("FPL not finished yet: the match stays live", async () => {
  fpl.finishedProvisional = false;
  await syncOnce();
  expect(fplHits).toBeGreaterThan(0);
  expect((await state()).status).toBe("in_progress");
});

test("if FPL's score disagrees with football-data the match stays live", async () => {
  fpl.home = 1;
  fpl.away = 1;
  await syncOnce();
  expect(await state()).toMatchObject({ status: "in_progress", result: null });
});

test("a match finished early isn't put back to live when football-data still says IN_PLAY", async () => {
  await syncOnce();
  fpl.finishedProvisional = false; // FPL isn't asked again, but make sure it can't matter
  await syncOnce();
  expect(await state()).toEqual({ status: "finished", score: "2-1", minute: null, result: "w" });
});

test("football-data's own FINISHED still works without FPL", async () => {
  fd = { status: "FINISHED", minute: null, home: 3, away: 1 };
  fpl.finishedProvisional = false;
  await syncOnce();
  expect(fplHits).toBe(0);
  expect(await state()).toEqual({ status: "finished", score: "3-1", minute: null, result: "w" });
});
