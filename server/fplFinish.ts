// A faster "full time" signal from the official Fantasy Premier League API.
//
// football-data.org (our source for fixtures, scores and the live minute) often
// keeps a match IN_PLAY for several minutes after the final whistle, so LMS
// picks took ~5 minutes to turn green/red. FPL flips `finished_provisional` on
// a fixture within moments of the whistle.
//
// FPL is used for ONE thing only: deciding that a match football-data still
// calls live is over. It's asked only once football-data's own live minute has
// reached 90, and the match is only marked finished when FPL's score agrees
// with football-data's. Scores, minutes and everything else still come from
// football-data, and any FPL failure just leaves the match to football-data.
//
// The FPL API is unofficial (no key, no SLA), so every call is guarded and
// cached:
//   - teams (bootstrap-static, ~1 MB) once a day, for FPL team id → short name;
//   - the season's fixture list every 6 hours, only to find a match's FPL event;
//   - that event's fixtures (/fixtures/?event=N, ~10 rows) at most every 10s.

import { londonStringToUtcMs } from '@shared/time';

const FPL_BASE = process.env.FPL_API_BASE ?? 'https://fantasy.premierleague.com/api';

export const FPL_CHECK_FROM_MINUTE = 90;

export interface FplFixture {
  id: number;
  event: number | null;
  team_h: number;
  team_a: number;
  kickoff_time: string | null;
  finished: boolean;
  finished_provisional: boolean;
  team_h_score: number | null;
  team_a_score: number | null;
}

// football-data and FPL disagree on a few three-letter codes. Our teams table
// uses football-data's (see lmsImportPlFixtures). Both directions map to one
// canonical code.
const TLA_ALIASES: Record<string, string> = { NFO: 'NOT' };
function canonicalTla(tla: string): string {
  const t = tla.trim().toUpperCase();
  return TLA_ALIASES[t] ?? t;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KICKOFF_TOLERANCE_MS = 10 * 60 * 1000;

let teamCache: { at: number; byId: Map<number, string> } | null = null;
let seasonCache: { at: number; fixtures: FplFixture[] } | null = null;
const eventCache = new Map<number, { at: number; fixtures: FplFixture[] }>();

async function fplFetch(path: string): Promise<any> {
  const res = await fetch(`${FPL_BASE}${path}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; fixtures-check)' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`FPL ${path} → ${res.status}`);
  return res.json();
}

async function fplTeams(): Promise<Map<number, string>> {
  if (teamCache && Date.now() - teamCache.at < DAY_MS) return teamCache.byId;
  const data = await fplFetch('/bootstrap-static/');
  const byId = new Map<number, string>();
  for (const t of data?.teams ?? []) byId.set(Number(t.id), canonicalTla(String(t.short_name ?? '')));
  teamCache = { at: Date.now(), byId };
  return byId;
}

async function fplSeasonFixtures(): Promise<FplFixture[]> {
  if (seasonCache && Date.now() - seasonCache.at < 6 * 60 * 60 * 1000) return seasonCache.fixtures;
  const fixtures = (await fplFetch('/fixtures/')) as FplFixture[];
  seasonCache = { at: Date.now(), fixtures };
  return fixtures;
}

async function fplEventFixtures(event: number): Promise<FplFixture[]> {
  const hit = eventCache.get(event);
  if (hit && Date.now() - hit.at < 10_000) return hit.fixtures;
  const fixtures = (await fplFetch(`/fixtures/?event=${event}`)) as FplFixture[];
  eventCache.set(event, { at: Date.now(), fixtures });
  return fixtures;
}

// The FPL fixture for one of our matches: same kickoff (±10 min) and the same
// home and away teams. Pure, so it can be tested on its own.
export function findFplFixture(
  fixtures: FplFixture[],
  teamTlaById: Map<number, string>,
  match: { kickoffUtcMs: number; homeTla: string; awayTla: string },
): FplFixture | undefined {
  const home = canonicalTla(match.homeTla);
  const away = canonicalTla(match.awayTla);
  return fixtures.find((f) => {
    if (!f.kickoff_time) return false;
    if (Math.abs(Date.parse(f.kickoff_time) - match.kickoffUtcMs) > KICKOFF_TOLERANCE_MS) return false;
    return teamTlaById.get(f.team_h) === home && teamTlaById.get(f.team_a) === away;
  });
}

// Should football-data's live score be taken as final? Only from minute 90,
// only when FPL says the match is over, and only when FPL's score is the same.
export function fplConfirmsFullTime(
  fixture: FplFixture | undefined,
  score: { home: number; away: number },
): boolean {
  if (!fixture) return false;
  if (!fixture.finished_provisional && !fixture.finished) return false;
  return fixture.team_h_score === score.home && fixture.team_a_score === score.away;
}

// Ask FPL whether a match football-data still has as live (at minute 90+) is
// over. Never throws: any FPL problem returns false and football-data carries on.
export async function fplSaysFinished(match: {
  matchTime: string | null;
  homeTla: string;
  awayTla: string;
  homeScore: number;
  awayScore: number;
}): Promise<boolean> {
  try {
    if (!match.matchTime) return false;
    const kickoffUtcMs = londonStringToUtcMs(match.matchTime);
    if (!Number.isFinite(kickoffUtcMs)) return false;
    const teams = await fplTeams();
    const lookup = { kickoffUtcMs, homeTla: match.homeTla, awayTla: match.awayTla };
    const seasonFixture = findFplFixture(await fplSeasonFixtures(), teams, lookup);
    if (!seasonFixture?.event) return false;
    // The season list is cached for hours, so re-read just this event for the
    // live flag.
    const live = findFplFixture(await fplEventFixtures(seasonFixture.event), teams, lookup);
    return fplConfirmsFullTime(live, { home: match.homeScore, away: match.awayScore });
  } catch (err: any) {
    console.warn(`[FPL] full-time check failed for ${match.homeTla} v ${match.awayTla}: ${err?.message ?? err}`);
    return false;
  }
}
