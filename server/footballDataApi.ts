import { storage } from './storage';
import { utcToLondonString, londonStringToUtcMs } from '@shared/time';
import { nextLiveMinute } from './liveMinute';

const API_BASE = 'https://api.football-data.org/v4';
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const COMPETITION_CODE = 'PL';

const TEAM_ID_MAP: Record<number, number> = {
  57: 1,
  58: 13,
  61: 6,
  62: 7,
  63: 8,
  64: 43,
  65: 2,
  66: 3,
  67: 4,
  71: 29,
  73: 15,
  76: 24,
  328: 20,
  341: 28,
  351: 14,
  354: 42,
  397: 10,
  402: 5,
  563: 17,
  1044: 9,
};

interface FdTeam {
  id: number;
  tla: string | null;
  name?: string | null;
  shortName?: string | null;
}

interface FdMatch {
  id: number;
  utcDate: string;
  status: string;
  matchday: number;
  // Current minute while the match is live (football-data sends it as a number
  // or occasionally a string; absent when the match isn't in play).
  minute?: number | string | null;
  homeTeam: FdTeam;
  awayTeam: FdTeam;
  score: {
    fullTime: { home: number | null; away: number | null };
    halfTime: { home: number | null; away: number | null };
  };
}

// Mirror of the fixture importer's name normalisation so live sync resolves
// teams the same way the importer created them.
function normalizeTeamName(s: string): string {
  return s.toLowerCase().replace(/\bfc\b/g, '').replace(/[^a-z0-9]/g, '');
}

// Resolve a football-data team to a local team id. The hardcoded TEAM_ID_MAP is
// the fast path for the long-standing clubs, but it isn't updated when teams are
// promoted each season — so fall back to matching by TLA and then normalised
// name against the local teams table (exactly how lmsImportPlFixtures creates
// them). Without this, any match involving a newly promoted team was skipped and
// its score never synced.
function resolveLocalTeamId(fd: FdTeam, localTeams: { id: number; name: string; shortName: string }[]): number | undefined {
  const mapped = TEAM_ID_MAP[fd.id];
  if (mapped) return mapped;
  const tla = (fd.tla || '').toUpperCase();
  if (tla) {
    const byTla = localTeams.find((t) => t.shortName.toUpperCase() === tla);
    if (byTla) return byTla.id;
  }
  const norm = normalizeTeamName(fd.name || '');
  if (norm) {
    const byName = localTeams.find((t) => normalizeTeamName(t.name) === norm);
    if (byName) return byName.id;
  }
  return undefined;
}

function mapStatus(fdStatus: string): string {
  switch (fdStatus) {
    case 'FINISHED':
    case 'AWARDED':
      return 'finished';
    case 'IN_PLAY':
    case 'PAUSED':
    case 'LIVE':
      return 'in_progress';
    case 'POSTPONED':
    case 'SUSPENDED':
    case 'CANCELLED':
      return 'not_started';
    case 'TIMED':
    case 'SCHEDULED':
    default:
      return 'not_started';
  }
}

async function fdFetch(path: string): Promise<any> {
  if (!API_KEY) throw new Error('FOOTBALL_DATA_API_KEY not set');
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'X-Auth-Token': API_KEY },
    });
    if (!res.ok) {
      throw new Error(`football-data API ${res.status}: ${await res.text()}`);
    }
    return res.json();
  } catch (err: any) {
    // Surface the underlying network cause — undici's bare "fetch failed"
    // hides the real reason (DNS, TLS, header, etc.) in err.cause.
    const cause = err?.cause;
    const causeMsg = cause ? `${cause.code || cause.name || ''} ${cause.message || cause}`.trim() : '';
    const detail = causeMsg ? ` (cause: ${causeMsg})` : '';
    console.error(`[FootballData] fdFetch ${path} failed: ${err.message}${detail}`);
    throw new Error(`${err.message}${detail}`);
  }
}

export async function fetchMatchesByGameweek(gameweek: number): Promise<FdMatch[]> {
  const data = await fdFetch(`/competitions/${COMPETITION_CODE}/matches?matchday=${gameweek}`);
  return data.matches || [];
}

function findLocalMatch(localMatches: any[], homeLocalId: number, awayLocalId: number, gameweek: number) {
  return localMatches.find(
    (m) => m.homeTeamId === homeLocalId && m.awayTeamId === awayLocalId && m.gameweek === gameweek,
  );
}

async function updateLmsSelectionsForMatch(
  matchId: number,
  homeTeamId: number,
  awayTeamId: number,
  homeScore: number,
  awayScore: number,
): Promise<number> {
  const allParticipants = await storage.getAllLmsCompetitions();
  let updatedCount = 0;
  for (const comp of allParticipants) {
    const participants = await storage.getLmsParticipantsByCompetition(comp.id);
    for (const p of participants) {
      const selections = await storage.getLmsSelectionsByParticipant(p.id);
      for (const sel of selections) {
        if (sel.matchId !== matchId) continue;
        if (sel.result !== null) continue;
        let result: 'w' | 'l' | null = null;
        if (sel.teamId === homeTeamId) {
          result = homeScore > awayScore ? 'w' : 'l';
        } else if (sel.teamId === awayTeamId) {
          result = awayScore > homeScore ? 'w' : 'l';
        }
        if (result) {
          await storage.updateLmsSelection(sel.id, { result });
          updatedCount += 1;
          console.log(
            `[FootballData] LMS selection ${sel.id} (participant ${p.id}, team ${sel.teamId}) → ${result} (${homeScore}-${awayScore})`,
          );
        }
      }
    }
  }
  return updatedCount;
}

export async function syncGameweek(
  gameweek: number,
  options: { updateTimes?: boolean; updateScores?: boolean } = { updateTimes: true, updateScores: true },
): Promise<{ matchesUpdated: number; selectionsUpdated: number }> {
  const fdMatches = await fetchMatchesByGameweek(gameweek);
  const localMatches = await storage.getAllMatches();
  const localTeams = await storage.getAllTeams();

  let matchesUpdated = 0;
  let selectionsUpdated = 0;

  for (const fd of fdMatches) {
    const homeLocalId = resolveLocalTeamId(fd.homeTeam, localTeams);
    const awayLocalId = resolveLocalTeamId(fd.awayTeam, localTeams);
    if (!homeLocalId || !awayLocalId) {
      console.warn(
        `[FootballData] Unmapped team(s): home=${fd.homeTeam.id}/${fd.homeTeam.tla} away=${fd.awayTeam.id}/${fd.awayTeam.tla}`,
      );
      continue;
    }

    const localMatch = findLocalMatch(localMatches, homeLocalId, awayLocalId, gameweek);
    if (!localMatch) {
      console.warn(`[FootballData] No local match for ${fd.homeTeam.tla} vs ${fd.awayTeam.tla} GW${gameweek}`);
      continue;
    }

    const newStatus = mapStatus(fd.status);
    const newTime = utcToLondonString(fd.utcDate);
    const newDate = newTime.split(' ')[0];

    const update: any = {};

    if (options.updateTimes && localMatch.matchTime !== newTime) {
      update.matchTime = newTime;
      update.matchDate = newDate;
    }

    if (options.updateScores) {
      const homeScore = fd.score.fullTime.home;
      const awayScore = fd.score.fullTime.away;
      if (homeScore !== null && awayScore !== null) {
        if (
          localMatch.homeScore !== homeScore ||
          localMatch.awayScore !== awayScore ||
          localMatch.status !== newStatus
        ) {
          update.homeScore = homeScore;
          update.awayScore = awayScore;
          update.status = newStatus;
        }
      } else if (newStatus !== localMatch.status && newStatus === 'in_progress') {
        update.status = newStatus;
      }

      // Track the live minute for the match-progress indicator. Checked
      // independently of the score because the minute ticks over between goals
      // (see nextLiveMinute — only meaningful while in progress, cleared to null
      // otherwise so a finished match doesn't show a stale minute).
      const liveMinute = nextLiveMinute(newStatus, fd.minute, localMatch.minute);
      if (liveMinute.changed) update.minute = liveMinute.minute;
    }

    if (Object.keys(update).length > 0) {
      await storage.updateMatch(localMatch.id, update);
      matchesUpdated += 1;
      console.log(
        `[FootballData] Updated match ${localMatch.id} (${fd.homeTeam.tla} vs ${fd.awayTeam.tla}): ${JSON.stringify(update)}`,
      );

      if (update.status === 'finished' && update.homeScore !== undefined && update.awayScore !== undefined) {
        const sCount = await updateLmsSelectionsForMatch(
          localMatch.id,
          homeLocalId,
          awayLocalId,
          update.homeScore,
          update.awayScore,
        );
        selectionsUpdated += sCount;
      }
    }
  }

  return { matchesUpdated, selectionsUpdated };
}

export async function getCurrentMatchday(): Promise<number | null> {
  try {
    const data = await fdFetch(`/competitions/${COMPETITION_CODE}`);
    return data.currentSeason?.currentMatchday ?? null;
  } catch (err) {
    console.error('[FootballData] Failed to get current matchday:', err);
    return null;
  }
}

export async function getLiveOrImminentGameweeks(): Promise<number[]> {
  const matches = await storage.getAllMatches();
  const now = Date.now();
  const preWindowMs = 15 * 60 * 1000;
  // Keep retrying any not_started match whose kickoff was up to 7 days ago.
  // This catches stragglers when the live-window sync failed (e.g. football-data
  // API outage) so the score is still picked up the next time the API is up,
  // instead of being stuck at not_started forever.
  const stalePostWindowMs = 7 * 24 * 60 * 60 * 1000;
  const gameweeks = new Set<number>();

  for (const m of matches) {
    if (m.gameweek == null) continue;
    if (m.status === 'in_progress') {
      gameweeks.add(m.gameweek);
      continue;
    }
    if (m.status === 'not_started' && m.matchTime) {
      const matchUtcMs = londonStringToUtcMs(m.matchTime);
      if (now >= matchUtcMs - preWindowMs && now <= matchUtcMs + stalePostWindowMs) {
        gameweeks.add(m.gameweek);
      }
    }
  }
  return Array.from(gameweeks).sort((a, b) => a - b);
}
