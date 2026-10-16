import { useState, useEffect, memo, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle, XCircle, Crown, Trophy, Calendar, HelpCircle, Lock } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import Header from "@/components/Header";
import { useGroup } from "@/contexts/GroupContext";
import { trackEvent } from "@/lib/track";
import { TeamPickerDialog } from "@/components/lms/TeamPickerDialog";
import { TeamCrest } from "@/components/TeamCrest";
import type { LmsCompetition, LmsParticipant, LmsSelection, Team, User, Match } from "@shared/schema";

type MatchWithTeams = Match & { homeTeam: Team; awayTeam: Team };

type Venue = { isHome: boolean; short: string };

function venueFromMatch(m: MatchWithTeams, teamId: number): Venue {
  const isHome = m.homeTeam?.id === teamId;
  return { isHome, short: (isHome ? m.awayTeam?.shortName : m.homeTeam?.shortName) || "?" };
}

// The opponent + venue for a team in a given gameweek, from the season's
// fixtures. Works for any gameweek (not just the live one), so past picks can
// show who they were up against too. Returns null if we don't have the fixture.
function opponentFor(
  matches: MatchWithTeams[] | undefined,
  teamId: number,
  gameweek: number,
): Venue | null {
  const m = matches?.find(
    (mm) => mm.gameweek === gameweek && (mm.homeTeam?.id === teamId || mm.awayTeam?.id === teamId),
  );
  return m ? venueFromMatch(m, teamId) : null;
}

// Resolve opponent + venue from the selection's actual matchId. This is exact
// and season-correct — the season-scoped gameweek lookup above shows the wrong
// season's fixture for historical competitions and nothing at all for a team
// since relegated. Needs an all-seasons match map (see the byMatchId query).
function opponentForMatchId(
  byMatchId: Map<number, MatchWithTeams> | undefined,
  matchId: number | null | undefined,
  teamId: number,
): Venue | null {
  if (matchId == null || !byMatchId) return null;
  const m = byMatchId.get(matchId);
  return m ? venueFromMatch(m, teamId) : null;
}

// Season-correct opponent lookup for a historical pick with no stored matchId:
// find the fixture in that competition's own season, not the current one.
function opponentForSeason(
  matches: MatchWithTeams[] | undefined,
  season: string | undefined,
  teamId: number,
  gameweek: number,
): Venue | null {
  const m = matches?.find(
    (mm) =>
      (mm as any).season === season &&
      mm.gameweek === gameweek &&
      (mm.homeTeam?.id === teamId || mm.awayTeam?.id === teamId),
  );
  return m ? venueFromMatch(m, teamId) : null;
}

// A single Team Selections cell, shared by the live and historical tables so
// both read identically: crest + short name, with an H/A v OPP venue line, a
// corner ✓/✗ result marker, and a light result tint. States:
//  - out:     player was knocked out before this gameweek → blank cell
//  - empty:   no pick (and still in) → a muted dash
//  - hidden:  pick made but redacted until kickoff → a lock
//  - pick:    the crest badge
function LmsSelectionCell({
  team,
  selection,
  opponent,
  isHidden,
  isOut,
}: {
  team?: Team;
  selection?: (LmsSelection & { hidden?: boolean }) | undefined;
  opponent?: { isHome: boolean; short: string } | null;
  isHidden?: boolean;
  isOut?: boolean;
}) {
  // Knocked out before this week — render nothing, so it's obvious they're gone.
  if (isOut) {
    return (
      <td
        className="border border-gray-300 p-0 bg-gray-100/60 dark:bg-gray-800/40"
        aria-label="Out of the competition"
      />
    );
  }

  if (!selection) {
    return (
      <td className="border border-gray-300 p-0">
        <div className="w-full h-full flex items-center justify-center py-1 text-xs text-gray-400">–</div>
      </td>
    );
  }

  if (isHidden) {
    return (
      <td className="border border-gray-300 p-0">
        <div className="w-full h-full flex items-center justify-center py-1" title="Pick made — hidden until kickoff">
          <Lock className="h-3.5 w-3.5 text-gray-400" aria-label="Pick made, hidden until kickoff" />
        </div>
      </td>
    );
  }

  const teamShortName = team?.shortName || "Unknown";
  const isRandom = (selection as any).isRandomlyAssigned === true || (selection as any).isRandomlyAssigned === "true";
  const won = selection.result === "w";
  const lost = selection.result === "l";
  // Green/red fill plus a corner ✓/✗ for the win/loss result — no left accent bar.
  const bg = won
    ? "bg-emerald-200 dark:bg-emerald-800/60"
    : lost
    ? "bg-rose-200 dark:bg-rose-800/60"
    : "";

  return (
    <td className={`border border-gray-300 p-0 ${bg}`}>
      <div className="relative w-full h-full flex flex-col items-center justify-center gap-0.5 py-0.5 px-0.5">
        {won && <CheckCircle className="absolute top-0.5 right-0.5 h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400" aria-label="Won" />}
        {lost && <XCircle className="absolute top-0.5 right-0.5 h-2.5 w-2.5 text-rose-600 dark:text-rose-400" aria-label="Lost" />}
        {isRandom && (
          <span className="absolute top-0 left-1 text-amber-500 text-xs font-bold leading-none" title="Randomly assigned after the deadline">*</span>
        )}

        {/* The crest alone identifies the team (its monogram fallback carries the
            abbreviation when a real crest isn't available). */}
        <span title={team?.name ?? teamShortName}>
          {team ? (
            <TeamCrest team={team} size={26} transparent />
          ) : (
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-700 text-[9px] font-bold text-gray-600 dark:text-gray-300">
              {teamShortName.slice(0, 3)}
            </span>
          )}
        </span>

        {opponent && (
          <div className="text-[8px] sm:text-[9px] font-medium opacity-75 leading-none text-center">
            {opponent.isHome ? "Home" : "Away"} vs {opponent.short}
          </div>
        )}
      </div>
    </td>
  );
}

// Whether a participant is out of the competition before a given gameweek — so
// their cells from the round *after* elimination onward render the same "out"
// state in every view. Primarily driven by an earlier losing pick (present in
// both live and historical data), so the live and history tables agree; the
// eliminatedInRound flag is a fallback.
function isOutBeforeGameweek(
  participant: { isActive?: string; eliminatedInRound?: number | null; selections?: { gameweek: number; result?: string | null }[] },
  gameweek: number,
): boolean {
  const lostEarlier = (participant.selections ?? []).some((s) => s.result === "l" && s.gameweek < gameweek);
  if (lostEarlier) return true;
  const round = participant.eliminatedInRound ?? (participant as any).eliminated_in_round ?? null;
  return participant.isActive !== "true" && round != null && gameweek > round;
}

// Per-group LMS rule variants. Source of truth for both the rendered Rules
// tab text AND the prize-distribution logic that runs when a competition
// ends. Defaulting to the united shape keeps the page sensible for any
// group not explicitly configured here.
type LmsRuleSet = {
  entryFeeGbp: number;
  // Hours before the first match's kickoff at which team selection locks.
  lockHoursBeforeKickoff: number;
  // When every remaining player is eliminated in the same gameweek, do we
  // split the pot among the final round survivors or roll it over to the
  // next competition? LMS is always winner-takes-all for a single survivor;
  // the all-out case is the only structural difference between groups.
  allOutBehaviour: "split_final_round" | "rollover";
};

// Fairweathermen (the original group, groupId 1) is the only group that plays a
// £5 stake; every other group plays £10.
const FAIRWEATHERMEN_LMS_RULES: LmsRuleSet = {
  entryFeeGbp: 5,
  lockHoursBeforeKickoff: 0,
  allOutBehaviour: "rollover",
};

// Every group other than Fairweathermen: £10 stake, rollover on an all-out.
const DEFAULT_LMS_RULES: LmsRuleSet = {
  entryFeeGbp: 10,
  lockHoursBeforeKickoff: 0,
  allOutBehaviour: "rollover",
};

// Per-group overrides keyed by slug, for groups that differ from the £10
// default in something other than the stake.
const LMS_RULES_BY_GROUP: Record<string, LmsRuleSet> = {
  // Rovers: £10 entry, and if all remaining players go out in the same gameweek
  // they're joint winners and split the pot (no rollover).
  rovers: {
    entryFeeGbp: 10,
    lockHoursBeforeKickoff: 0,
    allOutBehaviour: "split_final_round",
  },
};

type GroupLike = { id?: number; slug?: string; name?: string } | null | undefined;

// Identify the Fairweathermen group robustly (id/slug/name) so a mislabelled
// slug can never silently charge them the wrong stake. groupId 1 is Fairweathermen
// by the schema's documented invariant.
function isFairweathermen(group: GroupLike): boolean {
  if (!group) return false;
  if (group.id === 1) return true;
  const slug = group.slug?.toLowerCase();
  if (slug === "fairweathermen" || slug === "united") return true;
  return (group.name?.toLowerCase() ?? "").includes("fairweathermen");
}

function rulesForGroup(group: GroupLike): LmsRuleSet {
  if (isFairweathermen(group)) return FAIRWEATHERMEN_LMS_RULES;
  const slug = group?.slug;
  return (slug && LMS_RULES_BY_GROUP[slug]) || DEFAULT_LMS_RULES;
}

// The stake can change from one season to the next. Fairweathermen played £10
// per competition in 2024/2025 then dropped to £5; every other group is a flat
// £10. Both are covered by using £10 for 2024/2025 and the group's current
// stake for anything after.
function entryFeeForSeason(season: string | null | undefined, currentEntryFee: number): number {
  return (season || "2025/2026") === "2024/2025" ? 10 : currentEntryFee;
}

type CompPrize = { entryFee: number; prizePool: number; numWinners: number; winnerShare: number };

// Work out each completed competition's actual prize, accounting for stakes
// that rolled over from earlier all-out (winnerless) competitions. When a
// competition ends with no winner the pot isn't lost — it carries forward, so a
// later winner collects everything banked since the last payout (this is how
// Sam took the 4× pot after C3–C5 all rolled over). Rollovers never cross a
// season boundary, and the stake is resolved per season. Returns a map keyed by
// competition id; callers pass every completed competition so the running total
// is correct regardless of which one they're rendering.
function computeCompetitionPrizes(
  completedComps: { id: number; season?: string | null; participants: any[] }[],
  currentEntryFee: number,
): Map<number, CompPrize> {
  const result = new Map<number, CompPrize>();
  const ordered = [...completedComps].sort((a, b) => a.id - b.id);
  let rolloverPot = 0;
  let rolloverSeason: string | null = null;
  for (const comp of ordered) {
    const season = (comp as any).season || "2025/2026";
    if (season !== rolloverSeason) {
      rolloverPot = 0;
      rolloverSeason = season;
    }
    const entryFee = entryFeeForSeason(season, currentEntryFee);
    const compPot = entryFee * comp.participants.length;
    const winnerId = (comp as any)?.winner_id || (comp as any)?.winnerId;
    const coWinnerId = (comp as any)?.co_winner_id || (comp as any)?.coWinnerId;
    const numWinners = (winnerId ? 1 : 0) + (coWinnerId ? 1 : 0);
    const prizePool = compPot + rolloverPot;
    const winnerShare = numWinners > 0 ? prizePool / numWinners : 0;
    rolloverPot = numWinners > 0 ? 0 : rolloverPot + compPot;
    result.set(comp.id, { entryFee, prizePool, numWinners, winnerShare });
  }
  return result;
}

// Human label for a competition: "Competition N" by its chronological position
// within its season (first competition of the season = 1, next = 2, …). This is
// stable regardless of how the row was named when it was created (e.g. the
// season-rollover script names the first one "<season> Last Man Standing").
function labelForCompetition(
  competition: { id: number; name: string; season?: string | null },
  allComps: { id: number; season?: string | null }[],
): string {
  const season = (competition as any).season || "2025/2026";
  const ordered = (allComps || [])
    .filter((c) => ((c as any).season || "2025/2026") === season)
    .sort((a, b) => a.id - b.id);
  const idx = ordered.findIndex((c) => c.id === competition.id);
  return idx >= 0 ? `Competition ${idx + 1}` : competition.name;
}

type CompetitionWithDetails = LmsCompetition & {
  participants: (LmsParticipant & { user: User; selections: LmsSelection[] })[];
  currentRound: number;
  activeParticipants: number;
  current_gameweek?: number;
};

type AvailableTeam = Team & {
  match?: Match & { homeTeam: Team; awayTeam: Team };
  isUsed: boolean;
};

// Banner that shows the next LMS selection deadline for the current gameweek.
// Hidden after the final gameweek of the season (no fixtures scheduled).
const FINAL_GAMEWEEK = 38;

// The 20 Premier League teams for the upcoming 2026/27 season. Shown in the
// Fixtures view during the off-season window where the 2025/26 season has
// ended but the 2026/27 fixture list hasn't been published yet. Once real
// fixtures are seeded into matches for next season, the
// view automatically reverts to the regular fixture grid — this list is only
// rendered when there are no future kickoffs in the DB.
const LMS_NEXT_SEASON_LABEL = "2026/27";
const LMS_NEXT_SEASON_TEAMS: string[] = [
  "Arsenal",
  "Aston Villa",
  "Bournemouth",
  "Brentford",
  "Brighton",
  "Chelsea",
  "Coventry",
  "Crystal Palace",
  "Everton",
  "Fulham",
  "Hull",
  "Ipswich",
  "Leeds",
  "Liverpool",
  "Manchester City",
  "Manchester United",
  "Newcastle",
  "Nottingham Forest",
  "Sunderland",
  "Tottenham",
];
function NextDeadlineBanner({
  gameweek,
  matches,
}: {
  gameweek: number;
  matches: (Match & { homeTeam: Team; awayTeam: Team })[];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (gameweek > FINAL_GAMEWEEK) return null;

  const gwMatches = matches.filter((m) => m.gameweek === gameweek && m.matchTime);
  if (gwMatches.length === 0) return null;

  const earliestMs = Math.min(
    ...gwMatches.map((m) => new Date(m.matchTime as string).getTime()),
  );
  if (!isFinite(earliestMs)) return null;

  // Selections lock at kickoff of the gameweek's first match
  const deadlineMs = earliestMs;
  const diffMs = deadlineMs - now;

  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const deadlineLabel = fmt.format(new Date(deadlineMs));

  // Hide the banner once the deadline has passed — gameweek is mid-flight
  if (diffMs <= 0) return null;

  let countdown: string;
  let locked = false;
  if (diffMs <= 0) {
    locked = true;
    countdown = "Selections locked";
  } else {
    const totalMin = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMin / (60 * 24));
    const hours = Math.floor((totalMin % (60 * 24)) / 60);
    const mins = totalMin % 60;
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || days > 0) parts.push(`${hours}h`);
    parts.push(`${mins}m`);
    countdown = `in ${parts.join(" ")}`;
  }

  return (
    <Card
      className={
        locked
          ? "border-l-4 border-l-red-500 bg-red-50 dark:bg-red-950/30"
          : diffMs < 24 * 60 * 60 * 1000
            ? "border-l-4 border-l-amber-500 bg-amber-50 dark:bg-amber-950/30"
            : "border-l-4 border-l-blue-500 bg-blue-50 dark:bg-blue-950/30"
      }
    >
      <CardContent className="py-3 px-4 flex items-center gap-3">
        <Calendar className="h-5 w-5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wide text-gray-600 dark:text-gray-400 font-semibold">
            GW{gameweek} {locked ? "Deadline passed" : "Deadline"}
          </div>
          <div className="text-sm font-medium">
            {deadlineLabel} <span className="text-gray-600 dark:text-gray-400">({countdown})</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Fixtures Grid Component (hoisted to module scope to prevent remounting)
const FixturesGridContent = memo(({
  currentCompetition,
  highlightedCells,
  setHighlightedCells,
  hiddenTeams,
  setHiddenTeams,
  isHelpDialogOpen,
  setIsHelpDialogOpen
}: {
  currentCompetition: CompetitionWithDetails | undefined;
  highlightedCells: Set<string>;
  setHighlightedCells: React.Dispatch<React.SetStateAction<Set<string>>>;
  hiddenTeams: Set<number>;
  setHiddenTeams: React.Dispatch<React.SetStateAction<Set<number>>>;
  isHelpDialogOpen: boolean;
  setIsHelpDialogOpen: (open: boolean) => void;
}) => {
  // Custom team name abbreviations for fixtures view only
  const getFixturesTeamName = (teamName: string) => {
    const abbreviations: Record<string, string> = {
      'Manchester City': 'Man City',
      'Manchester United': 'Man Utd',
      'Bournemouth': "B'mouth",
      'Crystal Palace': 'Palace',
      'Nottingham Forest': 'Nottingham'
    };
    return abbreviations[teamName] || teamName;
  };

  // Fetch teams (no refetch needed - fixtures don't change)
  const { data: teams } = useQuery<Team[]>({
    queryKey: ["/api/teams"],
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
  });

  // Fetch matches (no refetch needed - fixtures don't change)
  const { data: matches } = useQuery<(Match & { homeTeam: Team; awayTeam: Team })[]>({
    queryKey: ["/api/matches"],
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
  });

  // Toggle cell highlighting
  const toggleCellHighlight = (teamId: number, gameweek: number) => {
    const cellKey = `${teamId}-${gameweek}`;
    setHighlightedCells(prev => {
      const newSet = new Set(prev);
      if (newSet.has(cellKey)) {
        newSet.delete(cellKey);
      } else {
        newSet.add(cellKey);
      }
      return newSet;
    });
  };

  // Toggle team row visibility
  const toggleTeamVisibility = (teamId: number) => {
    setHiddenTeams(prev => {
      const newSet = new Set(prev);
      if (newSet.has(teamId)) {
        newSet.delete(teamId);
      } else {
        newSet.add(teamId);
      }
      return newSet;
    });
  };

  // Touch handlers for tap-and-hold
  const [longPressTimer, setLongPressTimer] = useState<NodeJS.Timeout | null>(null);
  
  const handleTouchStart = (teamId: number) => {
    const timer = setTimeout(() => {
      toggleTeamVisibility(teamId);
    }, 800);
    setLongPressTimer(timer);
  };

  const handleTouchEnd = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      setLongPressTimer(null);
    }
  };

  if (!teams || !matches) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Premier League Fixtures</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-96 w-full" />
        </CardContent>
      </Card>
    );
  }

  // Off-season detection: if no match in the DB has a future kickoff, we're
  // between seasons. Show the upcoming season's team list with a TBC message
  // instead of an empty fixture grid. The 2025/26 finished matches are still
  // in the DB but all in the past, so they don't qualify.
  const nowMs = Date.now();
  const hasFutureFixtures = matches.some((m) => {
    if (!m.matchTime) return false;
    const ts = new Date(m.matchTime).getTime();
    return Number.isFinite(ts) && ts > nowMs;
  });

  if (!hasFutureFixtures) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Premier League Fixtures</CardTitle>
          <CardDescription>
            Fixtures TBC for the {LMS_NEXT_SEASON_LABEL} season
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
            The {LMS_NEXT_SEASON_LABEL} Premier League fixtures haven't been
            announced yet. The 20 teams in the league are listed below — full
            fixtures will appear here once published.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse border border-gray-300 text-xs sm:text-sm">
              <thead>
                <tr>
                  <th className="border border-gray-300 bg-gray-100 dark:bg-gray-800 p-2 text-left font-semibold">
                    Team
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...LMS_NEXT_SEASON_TEAMS]
                  .sort((a, b) => a.localeCompare(b))
                  .map((name) => (
                    <tr key={name}>
                      <td className="border border-gray-300 p-2 font-medium">
                        {getFixturesTeamName(name)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Window the preview on the fixtures themselves, not the LMS competition's
  // gameweek pointer — that pointer trails the *previous* season (e.g. GW38)
  // until a new competition is started, which is why this used to show the
  // wrong, already-played gameweek. Start at the earliest gameweek that still
  // has an unplayed match (GW1 for a freshly imported season); if the whole
  // season is done, fall back to the last gameweek so the grid isn't empty.
  const isPlayed = (m: (typeof matches)[number]) =>
    m.status === "finished" || (m.homeScore != null && m.awayScore != null);
  const allGWs = matches
    .map((m) => m.gameweek)
    .filter((gw): gw is number => gw != null);
  const unplayedGWs = matches
    .filter((m) => m.gameweek != null && !isPlayed(m))
    .map((m) => m.gameweek!);
  const currentGW = unplayedGWs.length
    ? Math.min(...unplayedGWs)
    : allGWs.length
      ? Math.max(...allGWs)
      : 1;
  const gameweeksToShow = Array.from({ length: 5 }, (_, i) => currentGW + i).filter(gw => gw <= 38);

  // Group matches by gameweek and team
  const fixturesByTeam: Record<number, Record<number, { opponent: string; isHome: boolean }>> = {};
  
  teams.forEach(team => {
    fixturesByTeam[team.id] = {};
  });

  matches
    .filter(match => match.gameweek !== null && gameweeksToShow.includes(match.gameweek))
    .forEach(match => {
      const homeTeamId = match.homeTeamId;
      const awayTeamId = match.awayTeamId;
      const gameweek = match.gameweek!;

      if (homeTeamId !== null && fixturesByTeam[homeTeamId]) {
        fixturesByTeam[homeTeamId][gameweek] = {
          opponent: match.awayTeam?.shortName || match.awayTeam?.name.substring(0, 3).toUpperCase() || 'TBD',
          isHome: true
        };
      }

      if (awayTeamId !== null && fixturesByTeam[awayTeamId]) {
        fixturesByTeam[awayTeamId][gameweek] = {
          opponent: match.homeTeam?.shortName || match.homeTeam?.name.substring(0, 3).toUpperCase() || 'TBD',
          isHome: false
        };
      }
    });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Premier League Fixtures</CardTitle>
            <CardDescription>Preview of the next 5 gameweeks</CardDescription>
          </div>
          <Button 
            variant="ghost" 
            size="sm" 
            className="h-8 w-8 p-0"
            onClick={() => setIsHelpDialogOpen(true)}
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
          <Dialog open={isHelpDialogOpen} onOpenChange={setIsHelpDialogOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Fixtures Tab Help</DialogTitle>
                <DialogDescription />
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <h4 className="font-medium text-sm">Click to Highlight</h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Click any fixture cell to highlight it. This helps you plan potential picks. Click again to remove the highlight.
                  </p>
                </div>
                <div className="space-y-2">
                  <h4 className="font-medium text-sm">Tap & Hold to Hide Rows</h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Tap and hold any team name to hide that team's row. This removes teams you're not interested in for a cleaner view.
                  </p>
                </div>
                <div className="space-y-2">
                  <h4 className="font-medium text-sm">Temporary Changes</h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    These changes are temporary and will reset when you refresh the page.
                  </p>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse border border-gray-300 text-xs">
            <thead>
              <tr>
                <th className="border border-gray-300 bg-gray-100 dark:bg-gray-800 p-1 text-left font-semibold w-16 sm:w-24 text-xs sm:text-sm">
                  Team
                </th>
                {gameweeksToShow.map(gw => (
                  <th key={gw} className="border border-gray-300 bg-gray-100 dark:bg-gray-800 p-1 text-center font-semibold w-16 sm:w-18 text-xs sm:text-sm">
                    GW{gw}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(() => {
                const currentSeasonTeamIds = new Set<number>();
                matches.forEach(m => {
                  if (m.homeTeamId != null) currentSeasonTeamIds.add(m.homeTeamId);
                  if (m.awayTeamId != null) currentSeasonTeamIds.add(m.awayTeamId);
                });
                return teams
                  .filter(team => currentSeasonTeamIds.has(team.id))
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .filter(team => !hiddenTeams.has(team.id));
              })().map(team => (
                  <tr key={team.id}>
                    <td className="border border-gray-300 p-1 font-medium text-xs">
                      <span 
                        className="block cursor-pointer select-none whitespace-nowrap truncate max-w-[60px] sm:max-w-[80px]"
                        onTouchStart={(e) => {
                          e.preventDefault();
                          handleTouchStart(team.id);
                        }}
                        onTouchEnd={handleTouchEnd}
                        onTouchCancel={handleTouchEnd}
                        onMouseDown={() => handleTouchStart(team.id)}
                        onMouseUp={handleTouchEnd}
                        onMouseLeave={handleTouchEnd}
                        title={`${team.name} - Hold to hide this team row`}
                      >
                        {getFixturesTeamName(team.name)}
                      </span>
                    </td>
                    {gameweeksToShow.map(gw => {
                      const fixture = fixturesByTeam[team.id][gw];
                      const cellKey = `${team.id}-${gw}`;
                      const isHighlighted = highlightedCells.has(cellKey);
                      
                      return (
                        <td key={gw} className="border border-gray-300 p-0.5 text-center">
                          {fixture ? (
                            <div 
                              className={`text-[9px] sm:text-[10px] p-0.5 rounded leading-tight cursor-pointer transition-colors duration-200 whitespace-nowrap ${
                                isHighlighted 
                                  ? 'bg-yellow-300 dark:bg-yellow-600 text-black dark:text-white' 
                                  : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'
                              }`}
                              onClick={() => toggleCellHighlight(team.id, gw)}
                            >
                              {fixture.opponent} ({fixture.isHome ? 'H' : 'A'})
                            </div>
                          ) : (
                            <div className="text-[9px] sm:text-[10px] text-gray-400">-</div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
});

FixturesGridContent.displayName = 'FixturesGridContent';

export default function LastManStandingPage() {
  const [location] = useLocation();
  const [selectedHistoryCompetitionId, setSelectedHistoryCompetitionId] = useState<string>("");
  const [selectedHistorySeason, setSelectedHistorySeason] = useState<string>("");
  const [selectedStatsSeason, setSelectedStatsSeason] = useState<string>("");
  const [highlightedCells, setHighlightedCells] = useState<Set<string>>(new Set()); // Move highlighting state up here
  const [hiddenTeams, setHiddenTeams] = useState<Set<number>>(new Set()); // Track hidden team rows
  const [isHelpDialogOpen, setIsHelpDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const { group, user } = useGroup();
  const lmsRules = rulesForGroup(group);

  // The logged-in user (from their personal login code). Used to restrict
  // editing so each player can only change their own selections.
  const currentUserId = user?.id;

  // Fetch matches (used by the deadline banner; cached so this is cheap)
  const { data: allMatches } = useQuery<(Match & { homeTeam: Team; awayTeam: Team })[]>({
    queryKey: ["/api/matches"],
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
  });

  // All-seasons fixtures, fetched only when viewing history, so past-season
  // opponents (including teams since relegated) resolve by matchId.
  const historySelected = !!selectedHistoryCompetitionId && selectedHistoryCompetitionId !== "none";
  const { data: allSeasonMatches } = useQuery<MatchWithTeams[]>({
    queryKey: ["/api/matches?all=1"],
    enabled: historySelected,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
  });
  const matchesById = useMemo(() => {
    const map = new Map<number, MatchWithTeams>();
    for (const m of allSeasonMatches ?? []) map.set(m.id, m);
    return map;
  }, [allSeasonMatches]);

  // Fetch all predictions so we can compute the GW38 prediction-pot winners
  // for the P/L table once that gameweek has finished.
  const { data: allPredictions } = useQuery<any[]>({
    queryKey: ["/api/predictions"],
    staleTime: 60_000,
  });

  // Fetch current competition. Server returns 200 + null when this group has
  // no competition yet (e.g. a brand-new LMS group like "lastman").
  // Polling is disabled entirely once we know there's no competition — there's
  // nothing live to keep in sync and any refetch was visibly re-rendering the
  // page. New comps in this state need a manual refresh to appear, which is
  // fine for the "waiting until next season" scenario.
  const { data: currentCompetition, isLoading: competitionLoading } = useQuery<
    CompetitionWithDetails | null
  >({
    queryKey: ["/api/lms/current-competition"],
    queryFn: async () => {
      const response = await fetch(`/api/lms/current-competition`);
      if (!response.ok) throw new Error("Failed to fetch competition");
      return response.json();
    },
    refetchInterval: (q) => (q.state.data ? 5000 : false),
    staleTime: 5000,
  });

  // Fetch ALL teams for display purposes
  const { data: allTeams } = useQuery<Team[]>({
    queryKey: ["/api/teams"],
    queryFn: async () => {
      const response = await fetch(`/api/teams`);
      if (!response.ok) throw new Error('Failed to fetch teams');
      return response.json();
    },
  });

  // Fetch available teams for selection
  const { data: availableTeams, isLoading: teamsLoading } = useQuery<AvailableTeam[]>({
    queryKey: ["/api/lms/available-teams"],
    queryFn: async () => {
      const response = await fetch(`/api/lms/available-teams`);
      if (!response.ok) throw new Error('Failed to fetch teams');
      return response.json();
    },
    enabled: !!currentCompetition,
    refetchInterval: 10000,
    staleTime: 10000, // Keep data fresh for 10 seconds to prevent unnecessary re-renders
  });

  // Check gameweek lock status
  const { data: gameweekStatus } = useQuery<{gameweek: number, isLocked: boolean, message: string}>({
    queryKey: [`/api/lms/gameweek-status/${(currentCompetition as any)?.current_gameweek || currentCompetition?.currentGameweek || 1}`],
    queryFn: async () => {
      const gameweek = (currentCompetition as any)?.current_gameweek || currentCompetition?.currentGameweek || 1;
      const response = await fetch(`/api/lms/gameweek-status/${gameweek}`);
      if (!response.ok) throw new Error('Failed to fetch gameweek status');
      return response.json();
    },
    enabled: !!currentCompetition,
    refetchInterval: 10000, // Check every 10 seconds for lock status
    staleTime: 10000, // Keep data fresh for 10 seconds to prevent unnecessary re-renders
  });

  // Fetch historical competitions
  const { data: historicalCompetitions, isLoading: historyLoading } = useQuery<CompetitionWithDetails[]>({
    queryKey: ["/api/lms/competitions"],
    queryFn: async () => {
      const response = await fetch(`/api/lms/competitions`);
      if (!response.ok) throw new Error('Failed to fetch competitions');
      return response.json();
    },
    // Same approach as currentCompetition: don't poll when there's no data
    // (lastman returns []). Avoids re-renders for groups with no LMS history.
    refetchInterval: (q) =>
      (q.state.data && q.state.data.length > 0) ? 10000 : false,
    staleTime: 10000,
  });

  // Prize per completed competition, rollover-aware (see computeCompetitionPrizes).
  // Computed once from every completed competition so any render — the P/L table,
  // the history winner line, the just-completed banner — shows the true pot,
  // including anything that rolled over from earlier all-out competitions.
  const prizeByComp = useMemo(
    () => computeCompetitionPrizes(
      (historicalCompetitions || []).filter(c => c.status === "completed"),
      lmsRules.entryFeeGbp,
    ),
    [historicalCompetitions, lmsRules.entryFeeGbp],
  );

  // Derive available seasons (sorted desc — newest first) from competitions
  const availableSeasons = (() => {
    const set = new Set<string>();
    (historicalCompetitions || []).forEach(c => {
      const season = (c as any).season || "2025/2026";
      set.add(season);
    });
    return Array.from(set).sort().reverse();
  })();
  const latestSeason = availableSeasons[0] || "2025/2026";

  // Default the History/Stats dropdowns to the latest season that actually has
  // a *finished* competition. A brand-new season (fixtures imported and a
  // competition started, but nothing completed yet) has no history or stats to
  // show, so we shouldn't jump to it by default — History would say "no
  // completed competitions" and Stats would be empty. Users can still pick the
  // new season manually from the dropdown.
  const latestCompletedSeason = (() => {
    const completed = (historicalCompetitions || [])
      .filter(c => c.status === "completed")
      .map(c => (c as any).season || "2025/2026");
    return Array.from(new Set(completed)).sort().reverse()[0];
  })();
  const defaultSeason = latestCompletedSeason || latestSeason;

  // Auto-select the default season for history + stats
  useEffect(() => {
    if (availableSeasons.length > 0) {
      if (!selectedHistorySeason) setSelectedHistorySeason(defaultSeason);
      if (!selectedStatsSeason) setSelectedStatsSeason(defaultSeason);
    }
  }, [availableSeasons.length, defaultSeason, selectedHistorySeason, selectedStatsSeason]);

  // Auto-select latest completed competition in the chosen history season
  useEffect(() => {
    if (!historicalCompetitions || !selectedHistorySeason) return;
    const inSeason = historicalCompetitions
      .filter(c => c.status === "completed")
      .filter(c => ((c as any).season || "2025/2026") === selectedHistorySeason);
    // If current selection isn't in this season, pick latest in season
    const currentInSeason = inSeason.some(c => c.id.toString() === selectedHistoryCompetitionId);
    if (!currentInSeason) {
      if (inSeason.length > 0) {
        const latest = inSeason.reduce((prev, current) => (current.id > prev.id) ? current : prev);
        setSelectedHistoryCompetitionId(latest.id.toString());
      } else {
        setSelectedHistoryCompetitionId("none");
      }
    }
  }, [historicalCompetitions, selectedHistorySeason, selectedHistoryCompetitionId]);

  // Make team selection
  const CURRENT_COMP_KEY = ["/api/lms/current-competition"];

  // Patch the cached current-competition so a pick reflects instantly, instead
  // of waiting for the POST + a full refetch (two round trips) before the button
  // turns blue. Returns the previous cache for rollback on error.
  const optimisticallySetSelection = async (
    participantId: number,
    gameweek: number,
    teamId: number | null,
  ) => {
    await queryClient.cancelQueries({ queryKey: CURRENT_COMP_KEY });
    const previous = queryClient.getQueryData<CompetitionWithDetails | null>(CURRENT_COMP_KEY);
    queryClient.setQueryData<CompetitionWithDetails | null>(CURRENT_COMP_KEY, (old) => {
      if (!old) return old;
      return {
        ...old,
        participants: old.participants.map((p) => {
          if (p.id !== participantId) return p;
          const others = p.selections.filter((s) => s.gameweek !== gameweek);
          if (teamId == null) return { ...p, selections: others };
          const existing = p.selections.find((s) => s.gameweek === gameweek);
          const optimistic: LmsSelection = {
            id: existing?.id ?? -1,
            participantId,
            gameweek,
            teamId,
            matchId: existing?.matchId ?? null,
            result: existing?.result ?? null,
            isRandomlyAssigned: "false",
            createdAt: existing?.createdAt ?? new Date(),
          };
          return { ...p, selections: [...others, optimistic] };
        }),
      };
    });
    return previous;
  };

  const invalidateLms = () => {
    queryClient.invalidateQueries({ queryKey: CURRENT_COMP_KEY });
    queryClient.invalidateQueries({ queryKey: ["/api/lms/competitions"] });
    queryClient.invalidateQueries({ queryKey: ["/api/lms/available-teams"] });
    queryClient.invalidateQueries({ queryKey: ["/api/lms"] });
  };

  const selectTeamMutation = useMutation({
    mutationFn: async ({ teamId, participantId, gameweek }: { teamId: number; participantId: number; gameweek: number }) => {
      const response = await fetch("/api/lms/select-team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, participantId, gameweek })
      });
      return response.json();
    },
    onMutate: async ({ teamId, participantId, gameweek }) => {
      const previous = await optimisticallySetSelection(participantId, gameweek, teamId);
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(CURRENT_COMP_KEY, ctx.previous);
      }
    },
    onSettled: () => invalidateLms(),
  });

  // Clear a selection (used by the matchup picker when you tap your own pick).
  const removeSelectionMutation = useMutation({
    mutationFn: async ({ participantId, gameweek }: { participantId: number; gameweek: number }) => {
      const response = await fetch("/api/lms/remove-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantId, gameweek }),
      });
      return response.json();
    },
    onMutate: async ({ participantId, gameweek }) => {
      const previous = await optimisticallySetSelection(participantId, gameweek, null);
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(CURRENT_COMP_KEY, ctx.previous);
      }
    },
    onSettled: () => invalidateLms(),
  });

  // The visual matchup picker (opened from the "your pick" card on the Live tab).
  const [pickerOpen, setPickerOpen] = useState(false);



  const getResultIcon = (result: string) => {
    switch (result) {
      case "win": return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "lose_draw": return <XCircle className="h-4 w-4 text-red-500" />;
      case "postponed": return <Calendar className="h-4 w-4 text-orange-500" />;
      default: return <div className="h-4 w-4 rounded-full bg-gray-300" />;
    }
  };

  const getStatusBadge = (participant: LmsParticipant & { user: User; selections: LmsSelection[] }, competition?: CompetitionWithDetails) => {
    // Check if this participant is the winner of this competition (handle both snake_case and camelCase)
    const winnerId = (competition as any)?.winner_id || competition?.winnerId;

    
    if (winnerId === participant.userId) {
      return <Badge variant="default" className="bg-yellow-500 text-black">Winner</Badge>;
    }

    // Split-on-all-out groups (e.g. Rovers): a completed competition with no single
    // winner means everyone remaining went out together — the players eliminated
    // in the final round are joint winners.
    const status = (competition as any)?.status;
    if (status === "completed" && !winnerId && lmsRules.allOutBehaviour === "split_final_round" && competition) {
      const elimRound = (p: any) => p.eliminatedInRound ?? (p as any).eliminated_in_round ?? 0;
      const parts = (competition as any).participants ?? [];
      const maxRound = parts.reduce((m: number, p: any) => Math.max(m, elimRound(p)), 0);
      if (maxRound > 0 && elimRound(participant) === maxRound) {
        return <Badge variant="default" className="bg-yellow-500 text-black">Co-winner</Badge>;
      }
    }

    if (participant.isActive === "true") {
      return <Badge variant="default" className="bg-green-500">Active</Badge>;
    } else {
      // Calculate the round relative to this competition's start
      const competitionStartGameweek = (competition as any)?.start_gameweek || competition?.startGameweek || 1;
      const relativeRound = Math.max(1, (participant.eliminatedInRound || 0) - competitionStartGameweek + 1);
      return <Badge variant="destructive">Eliminated (Round {relativeRound})</Badge>;
    }
  };

  // Only show the skeleton on the very first load — i.e. when we genuinely
  // have no data yet. React Query's `isLoading` can flicker back to true on
  // some refetch cycles depending on the version, which previously made the
  // whole page re-mount every 5 seconds for groups with no LMS competition
  // (because `currentCompetition` stayed null and isLoading was the trigger).
  // Checking that data is `undefined` only allows the skeleton for the first
  // fetch; subsequent refetches keep the rendered page in place.
  if (currentCompetition === undefined && competitionLoading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="container mx-auto px-4 py-8">
          <div className="space-y-6">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="container mx-auto px-4 py-8">
        <div className="space-y-6">


          {/* Hide History + Stats tabs until at least one gameweek has actually
              been played. For brand-new LMS groups (e.g. lastman before next
              season starts) there's nothing to show and the tabs would just
              load an empty card. */}
          {(() => {
            const anyPastComp = (historicalCompetitions?.length ?? 0) > 0;
            const currentBeyondStart =
              !!currentCompetition &&
              ((currentCompetition as any).current_gameweek ??
                currentCompetition.currentGameweek ??
                0) >
                ((currentCompetition as any).start_gameweek ??
                  currentCompetition.startGameweek ??
                  1);
            const showHistoryAndStats = anyPastComp || currentBeyondStart;
            const tabColsClass = showHistoryAndStats
              ? "grid-cols-5"
              : "grid-cols-3";

          return (
          <Tabs
            defaultValue="current"
            className="w-full"
            onValueChange={(v) =>
              trackEvent({ path: "/last-man-standing", subPath: v, label: `LMS: ${v}` })
            }
          >
            <TabsList className={`grid w-full ${tabColsClass}`}>
              <TabsTrigger value="current" className="text-xs sm:text-sm">
                Live
              </TabsTrigger>
              {showHistoryAndStats && (
                <TabsTrigger value="history" className="text-xs sm:text-sm">History</TabsTrigger>
              )}
              <TabsTrigger value="fixtures" className="text-xs sm:text-sm">Fixtures</TabsTrigger>
              {showHistoryAndStats && (
                <TabsTrigger value="pl" className="text-xs sm:text-sm">
                  Stats
                </TabsTrigger>
              )}
              <TabsTrigger value="rules" className="text-xs sm:text-sm">Rules</TabsTrigger>
            </TabsList>

            <TabsContent value="current" className="space-y-6">
              {!currentCompetition && (
                <Card>
                  <CardContent className="py-12 text-center">
                    <p className="text-base font-medium text-gray-700">
                      Coming soon
                    </p>
                    <p className="mt-2 text-sm text-gray-500">
                      The next Last Man Standing competition hasn't been set up
                      yet. Check back in August once the new Premier League
                      season's fixtures are out.
                    </p>
                  </CardContent>
                </Card>
              )}
              {currentCompetition && (
                <>
                  {currentCompetition.status === "active" && allMatches && (
                    <NextDeadlineBanner
                      gameweek={(currentCompetition as any).current_gameweek || currentCompetition.currentGameweek || 1}
                      matches={allMatches}
                    />
                  )}
                  {currentCompetition.status === "completed" &&
                    renderCompletedBanner(currentCompetition, lmsRules, prizeByComp.get(currentCompetition.id))}

                  {/* Your pick — a visual, matchup-based picker for the logged-in
                      player (only while the competition is active and they're
                      still in it). */}
                  {(() => {
                    if (currentCompetition.status !== "active") return null;
                    const gameweek =
                      (currentCompetition as any).current_gameweek ||
                      currentCompetition.currentGameweek ||
                      1;
                    const myParticipant = currentUserId
                      ? currentCompetition.participants.find((p) => p.userId === currentUserId)
                      : undefined;
                    if (!myParticipant || myParticipant.isActive !== "true") return null;

                    const mySelection = myParticipant.selections.find(
                      (s) => s.gameweek === gameweek,
                    );
                    // Teams used in OTHER gameweeks are unavailable; the current
                    // gameweek's pick stays selectable so it can be changed.
                    const usedTeamIds = new Set(
                      myParticipant.selections
                        .filter((s) => s.gameweek !== gameweek)
                        .map((s) => s.teamId),
                    );
                    const gwMatches = (allMatches ?? []).filter(
                      (m) => m.gameweek === gameweek && m.matchTime,
                    ) as (Match & { homeTeam: Team; awayTeam: Team })[];
                    const locked = gameweekStatus?.isLocked ?? false;
                    const myTeam = mySelection
                      ? allTeams?.find((t) => t.id === mySelection.teamId)
                      : undefined;

                    return (
                      <>
                        <Card>
                          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                            <div className="flex items-center gap-3">
                              {myTeam ? (
                                <TeamCrest team={myTeam} size={44} />
                              ) : (
                                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-gray-300 text-gray-300">
                                  ?
                                </span>
                              )}
                              <div>
                                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                                  Your GW{gameweek} pick
                                </p>
                                <p className="text-lg font-bold">
                                  {myTeam ? myTeam.name : locked ? "No pick" : "Not picked yet"}
                                </p>
                              </div>
                            </div>
                            <Button
                              disabled={locked}
                              onClick={() => setPickerOpen(true)}
                            >
                              {locked ? "Locked" : mySelection ? "Change pick" : "Make your pick"}
                            </Button>
                          </CardContent>
                        </Card>
                        <TeamPickerDialog
                          open={pickerOpen}
                          onOpenChange={setPickerOpen}
                          gameweek={gameweek}
                          matches={gwMatches}
                          usedTeamIds={usedTeamIds}
                          currentTeamId={mySelection?.teamId}
                          locked={locked}
                          busy={selectTeamMutation.isPending || removeSelectionMutation.isPending}
                          onPick={(teamId) =>
                            selectTeamMutation.mutate({
                              teamId,
                              participantId: myParticipant.id,
                              gameweek,
                            })
                          }
                          onClear={() =>
                            removeSelectionMutation.mutate({
                              participantId: myParticipant.id,
                              gameweek,
                            })
                          }
                        />
                      </>
                    );
                  })()}

                  {/* Excel-Style Selection Table */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg sm:text-xl">Team Selections</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse border border-gray-300 text-xs sm:text-sm">
                          <thead>
                            <tr>
                              <th className="border border-gray-300 bg-gray-100 dark:bg-gray-800 p-1 text-left font-semibold w-14 sm:w-20">
                                Player
                              </th>
                              {(() => {
                                const startGW = (currentCompetition as any).start_gameweek || currentCompetition.startGameweek || 1;
                                const currentGW = (currentCompetition as any).current_gameweek || currentCompetition.currentGameweek || currentCompetition.currentRound || startGW;
                                const numWeeks = currentGW - startGW + 1;

                                return Array.from({ length: numWeeks }, (_, i) => (
                                  <th key={`gw-${startGW + i}`} className="border border-gray-300 bg-gray-100 dark:bg-gray-800 p-1 text-center font-semibold w-14 sm:w-20">
                                    GW{startGW + i}
                                  </th>
                                ));
                              })()}
                            </tr>
                          </thead>
                          <tbody>
                            {[...currentCompetition.participants]
                              .sort((a, b) => (a.user?.username || '').localeCompare(b.user?.username || ''))
                              .map((participant) => (
                              <tr key={participant.id}>
                                <td className="border border-gray-300 px-1 py-0.5 font-medium bg-gray-50 dark:bg-gray-900 text-xs sm:text-sm">
                                  <span className="truncate block max-w-[60px] sm:max-w-none">
                                    {participant.user?.username || 'Unknown User'}
                                  </span>
                                </td>
                                {(() => {
                                  const startGW = (currentCompetition as any).start_gameweek || currentCompetition.startGameweek || 1;
                                  const currentGW = (currentCompetition as any).current_gameweek || currentCompetition.currentGameweek || currentCompetition.currentRound || startGW;
                                  const numWeeks = currentGW - startGW + 1;
                                  return Array.from({ length: numWeeks }, (_, gameweekIndex) => {
                                    const gameweek = startGW + gameweekIndex;
                                    const selection = participant.selections.find(s => s.gameweek === gameweek);
                                    // Other players' current-gameweek pick is hidden
                                    // (server-redacted) until the gameweek locks — the
                                    // selection carries hidden:true with no teamId.
                                    const isHidden = !!selection && (selection as any).hidden === true;
                                    const isOut = isOutBeforeGameweek(participant, gameweek);
                                    const team = selection && !isHidden ? allTeams?.find(t => t.id === selection.teamId) : undefined;
                                    const opponent = selection && !isHidden ? opponentFor(allMatches, selection.teamId, gameweek) : null;
                                    return (
                                      <LmsSelectionCell
                                        key={`cell-${gameweek}`}
                                        team={team}
                                        selection={selection as any}
                                        opponent={opponent}
                                        isHidden={isHidden}
                                        isOut={isOut}
                                      />
                                    );
                                });
                                })()}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}
            </TabsContent>
            
            <TabsContent value="history" className="space-y-6">
              {/* Season + Competition Selectors */}
              <Card>
                <CardHeader>
                  <CardTitle>Competition History</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <Select value={selectedHistorySeason} onValueChange={setSelectedHistorySeason}>
                      <SelectTrigger className="w-full sm:w-[180px]">
                        <SelectValue placeholder="Season" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableSeasons.length === 0 ? (
                          <SelectItem value="2025/2026">2025/2026</SelectItem>
                        ) : availableSeasons.map(s => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={selectedHistoryCompetitionId} onValueChange={setSelectedHistoryCompetitionId}>
                      <SelectTrigger className="w-full sm:flex-1 sm:min-w-[200px]">
                        <SelectValue placeholder="Select a competition to view..." />
                      </SelectTrigger>
                      <SelectContent>
                        {(() => {
                          const compsInSeason = (historicalCompetitions || [])
                            .filter(c => c.status === "completed")
                            .filter(c => ((c as any).season || "2025/2026") === selectedHistorySeason)
                            .sort((a, b) => b.id - a.id);
                          if (compsInSeason.length === 0) {
                            return <SelectItem value="none" disabled>No completed competitions in this season</SelectItem>;
                          }
                          return compsInSeason.map(competition => (
                            <SelectItem key={competition.id} value={competition.id.toString()}>
                              {labelForCompetition(competition, historicalCompetitions || [])}
                            </SelectItem>
                          ));
                        })()}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              {/* Competition Details */}
              {selectedHistoryCompetitionId && selectedHistoryCompetitionId !== "none" && (
                <div className="space-y-6">
                  {historyLoading ? (
                    <Skeleton className="h-64 w-full" />
                  ) : (
                    <>
                      {historicalCompetitions
                        ?.filter(comp => comp.id.toString() === selectedHistoryCompetitionId)
                        .map((competition) => (
                          <Card key={competition.id}>
                            <CardHeader>
                              <div className="flex justify-between items-center">
                                <div>
                                  <CardTitle className="text-base leading-tight">
                                    {labelForCompetition(competition, historicalCompetitions || [])}
                                  </CardTitle>
                                  <CardDescription>
                                    Gameweeks {(competition as any).start_gameweek || competition.startGameweek || 1} - {(competition as any).current_gameweek || competition.currentGameweek || 1}
                                  </CardDescription>
                                  {((competition as any).season === '2024/2025' && /7\s*$/.test(competition.name)) && (
                                    <p className="text-xs text-muted-foreground italic mt-1">
                                      Winner settled via GW38 scoring predictions
                                    </p>
                                  )}
                                  {((competition as any).season === '2024/2025' && /6\s*$/.test(competition.name)) && (
                                    <p className="text-xs text-muted-foreground italic mt-1">
                                      Blake eliminated in GW35 for not picking a team
                                    </p>
                                  )}
                                </div>
                                {(() => {
                                  const winnerId = (competition as any)?.winner_id || competition?.winnerId;
                                  const coWinnerId = (competition as any)?.co_winner_id || (competition as any)?.coWinnerId;
                                  if (winnerId) {
                                    const winner = competition.participants.find(p => p.id === winnerId) || competition.participants.find(p => p.userId === winnerId);
                                    const coWinner = coWinnerId ? (competition.participants.find(p => p.id === coWinnerId) || competition.participants.find(p => p.userId === coWinnerId)) : null;
                                    const winnerName = winner ? (winner.user?.username || `Unknown User (${winner.userId})`) : undefined;
                                    const coWinnerName = coWinner ? (coWinner.user?.username || `Unknown User (${coWinner.userId})`) : undefined;
                                    // Prize is rollover-aware and season-correct (see the shared
                                    // prize map): a win after all-outs takes the accumulated pot,
                                    // not just this competition's stakes.
                                    const prize = prizeByComp.get(competition.id);
                                    const prizePool = prize?.prizePool ?? lmsRules.entryFeeGbp * competition.participants.length;
                                    const share = prize?.winnerShare ?? (coWinnerName ? prizePool / 2 : prizePool);
                                    const shareLabel = Number.isInteger(share) ? `£${share}` : `£${share.toFixed(2)}`;
                                    return (
                                      <div className="flex items-center gap-2 text-yellow-600">
                                        <Crown className="h-5 w-5" />
                                        <span className="font-medium">
                                          {coWinnerName ? `${winnerName} & ${coWinnerName} (${shareLabel} each)` : `${winnerName} (${shareLabel})`}
                                        </span>
                                      </div>
                                    );
                                  } else {
                                    return (
                                      <div className="flex items-center gap-1 text-red-600 text-xs">
                                        <XCircle className="h-4 w-4 flex-shrink-0" />
                                        <span className="font-medium whitespace-nowrap">
                                          Rolled over
                                        </span>
                                      </div>
                                    );
                                  }
                                })()}
                              </div>
                            </CardHeader>
                            <CardContent>
                              <div className="space-y-4">
                                <div className="text-sm text-muted-foreground">
                                  {Math.max(0, ((competition as any).current_gameweek || competition.currentGameweek || 0) - ((competition as any).start_gameweek || competition.startGameweek || 1) + 1)} rounds completed
                                </div>
                                
                                {/* Final Table State */}
                                <div className="space-y-4">
                                  <h4 className="font-medium">Final Competition Table</h4>
                                  <div className="overflow-x-auto">
                                    <table className="w-full border-collapse border border-gray-300">
                                      <thead>
                                        <tr>
                                          <th className="border border-gray-300 bg-gray-100 dark:bg-gray-800 p-1 text-left font-semibold w-16 sm:w-20">
                                            Player
                                          </th>
                                          {Array.from({ 
                                            length: Math.max(0, ((competition as any).current_gameweek || competition.currentGameweek || 0) - ((competition as any).start_gameweek || competition.startGameweek || 1) + 1) 
                                          }, (_, i) => {
                                            const actualGameweek = ((competition as any).start_gameweek || competition.startGameweek || 1) + i;
                                            return (
                                              <th key={actualGameweek} className="border border-gray-300 bg-gray-100 dark:bg-gray-800 p-1 text-center font-semibold w-14 sm:w-20">
                                                GW{actualGameweek}
                                              </th>
                                            );
                                          })}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {[...competition.participants]
                                          .sort((a, b) => (a.user?.username || '').localeCompare(b.user?.username || ''))
                                          .map((participant) => (
                                          <tr key={participant.id}>
                                            <td className="border border-gray-300 px-1 py-0.5 font-medium bg-gray-50 dark:bg-gray-900 text-xs sm:text-sm">
                                              <div className="flex items-center gap-2">
                                                {participant.user?.username || 'Unknown User'}
                                                {((((competition as any)?.winner_id || competition?.winnerId) === participant.userId) ||
                                                  (((competition as any)?.co_winner_id || (competition as any)?.coWinnerId) === participant.userId)) && (
                                                  <Crown className="h-4 w-4 text-yellow-500" />
                                                )}
                                              </div>
                                            </td>
                                            {Array.from({ 
                                              length: Math.max(0, ((competition as any).current_gameweek || competition.currentGameweek || 0) - ((competition as any).start_gameweek || competition.startGameweek || 1) + 1) 
                                            }, (_, gameweekIndex) => {
                                              const gameweek = ((competition as any).start_gameweek || competition.startGameweek || 1) + gameweekIndex;
                                              const selection = participant.selections.find(s => s.gameweek === gameweek);
                                              const team = selection ? allTeams?.find(t => t.id === selection.teamId) : undefined;
                                              // Resolve by the pick's actual matchId (season-correct, and works
                                              // for teams since relegated); fall back to the season-scoped
                                              // gameweek lookup for old picks that never stored a matchId.
                                              const opponent = selection
                                                ? opponentForMatchId(matchesById, (selection as any).matchId, selection.teamId)
                                                  ?? opponentForSeason(allSeasonMatches, (competition as any).season, selection.teamId, gameweek)
                                                : null;
                                              return (
                                                <LmsSelectionCell
                                                  key={gameweek}
                                                  team={team}
                                                  selection={selection as any}
                                                  opponent={opponent}
                                                  isOut={isOutBeforeGameweek(participant, gameweek)}
                                                />
                                              );
                                            })}
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                    </>
                  )}
                </div>
              )}
            </TabsContent>
            
            <TabsContent value="fixtures" className="space-y-6">
              <FixturesGridContent
                currentCompetition={currentCompetition ?? undefined}
                highlightedCells={highlightedCells}
                setHighlightedCells={setHighlightedCells}
                hiddenTeams={hiddenTeams}
                setHiddenTeams={setHiddenTeams}
                isHelpDialogOpen={isHelpDialogOpen}
                setIsHelpDialogOpen={setIsHelpDialogOpen}
              />
            </TabsContent>
            
            <TabsContent value="pl" className="space-y-6">
              {/* Season selector for stats */}
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <label className="text-sm font-medium whitespace-nowrap">Season</label>
                    <Select value={selectedStatsSeason} onValueChange={setSelectedStatsSeason}>
                      <SelectTrigger className="w-full sm:w-[200px]">
                        <SelectValue placeholder="Season" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableSeasons.length === 0 ? (
                          <SelectItem value="2025/2026">2025/2026</SelectItem>
                        ) : (
                          <>
                            {availableSeasons.map(s => (
                              <SelectItem key={s} value={s}>{s}</SelectItem>
                            ))}
                            {availableSeasons.length > 1 && (
                              <SelectItem value="combined">Combined</SelectItem>
                            )}
                          </>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                </CardContent>
              </Card>

              {/* Profit / Loss */}
              <Card>
                <CardHeader>
                  <CardTitle>Profit / Loss</CardTitle>
                </CardHeader>
                <CardContent>
                  {historyLoading ? (
                    <Skeleton className="h-64 w-full" />
                  ) : (
                    <div className="overflow-x-auto">
                      {(() => {
                        const seasonFilter = (c: any) => selectedStatsSeason === "combined" || (c.season || "2025/2026") === selectedStatsSeason;
                        const completedComps = (historicalCompetitions?.filter(c => c.status === "completed") || [])
                          .filter(seasonFilter)
                          .sort((a, b) => a.id - b.id);
                        const allPlayers = new Map<number, { username: string; pl: Map<string, number>; total: number }>();

                        completedComps.forEach(comp => {
                          const winnerId = (comp as any)?.winner_id || comp?.winnerId;
                          const coWinnerId = (comp as any)?.co_winner_id || (comp as any)?.coWinnerId;
                          // Stake and prize (rollover-aware) come from the shared prize map so
                          // the P/L table, the history winner line and the completed banner all
                          // agree. A winner collects this competition's pot plus anything rolled
                          // over from earlier all-out competitions; everyone still pays the stake.
                          const prize = prizeByComp.get(comp.id);
                          const entryFee = prize?.entryFee ?? entryFeeForSeason((comp as any).season, lmsRules.entryFeeGbp);
                          const winnerShare = prize?.winnerShare ?? 0;
                          comp.participants.forEach(p => {
                            if (!allPlayers.has(p.userId)) {
                              allPlayers.set(p.userId, {
                                username: p.user?.username || `Unknown User (${p.userId})`,
                                pl: new Map(),
                                total: 0,
                              });
                            }
                            const player = allPlayers.get(p.userId)!;
                            let pl = -entryFee;
                            const isWinner = winnerId === p.id || winnerId === p.userId;
                            const isCoWinner = coWinnerId && (coWinnerId === p.id || coWinnerId === p.userId);
                            if (isWinner || isCoWinner) {
                              pl = winnerShare - entryFee;
                            }
                            player.pl.set(`comp-${comp.id}`, pl);
                            player.total += pl;
                          });
                        });

                        // GW38 prediction pot — only when every GW38 match is finished
                        // and at least one player scored points. £10 entry from all 7
                        // predictions players; winner(s) split the £70 pot.
                        // Only relevant to 2025/2026 season (or Combined view).
                        const showPotForSeason = selectedStatsSeason === "combined" || selectedStatsSeason === "2025/2026";
                        const POT_KEY = 'gw38-pot';
                        const POT_LABEL = 'GW38';
                        let showPot = false;
                        if (showPotForSeason) {
                        const PREDICTION_PLAYERS: { id: number; name: string }[] = [
                          { id: 1, name: 'Casey' },
                          { id: 2, name: 'Alex' },
                          { id: 3, name: 'Taylor' },
                          { id: 4, name: 'Jordan' },
                          { id: 5, name: 'Noah' },
                          { id: 6, name: 'Sam' },
                          { id: 7, name: 'Blake' },
                        ];
                        const POT_ENTRY = 10;
                        const gw38Matches = (allMatches || []).filter((m: any) => m.gameweek === 38);
                        const gw38AllDone = gw38Matches.length > 0 && gw38Matches.every((m: any) => m.status === 'finished');
                        if (gw38AllDone && allPredictions) {
                          const pointsByUser = new Map<number, { points: number; exact: number }>();
                          PREDICTION_PLAYERS.forEach(p => pointsByUser.set(p.id, { points: 0, exact: 0 }));
                          (allPredictions as any[]).forEach(pred => {
                            const match = pred.match;
                            if (!match || match.gameweek !== 38 || match.status !== 'finished') return;
                            if (match.homeScore == null || match.awayScore == null) return;
                            const stats = pointsByUser.get(pred.userId);
                            if (!stats) return;
                            if (pred.homeScore === match.homeScore && pred.awayScore === match.awayScore) {
                              stats.points += 3;
                              stats.exact += 1;
                            } else {
                              const predDiff = Math.sign(pred.homeScore - pred.awayScore);
                              const actualDiff = Math.sign(match.homeScore - match.awayScore);
                              if (predDiff === actualDiff) stats.points += 1;
                            }
                          });
                          const topPoints = Math.max(...Array.from(pointsByUser.values()).map(s => s.points));
                          if (topPoints > 0) {
                            const winnerIds = PREDICTION_PLAYERS
                              .filter(p => pointsByUser.get(p.id)!.points === topPoints)
                              .map(p => p.id);
                            const pot = POT_ENTRY * PREDICTION_PLAYERS.length;
                            // Distribute pot as integers, preserving zero-sum totals.
                            // Base share + 1 extra £ to the first `remainder` winners (sorted by id for determinism).
                            const baseShare = Math.floor(pot / winnerIds.length);
                            const remainder = pot - baseShare * winnerIds.length;
                            const sortedWinners = [...winnerIds].sort((a, b) => a - b);
                            const winnerPayout = new Map<number, number>();
                            sortedWinners.forEach((id, i) => {
                              winnerPayout.set(id, (i < remainder ? baseShare + 1 : baseShare) - POT_ENTRY);
                            });
                            PREDICTION_PLAYERS.forEach(p => {
                              if (!allPlayers.has(p.id)) {
                                allPlayers.set(p.id, { username: p.name, pl: new Map(), total: 0 });
                              }
                              const player = allPlayers.get(p.id)!;
                              const pl = winnerPayout.has(p.id) ? winnerPayout.get(p.id)! : -POT_ENTRY;
                              player.pl.set(POT_KEY, pl);
                              player.total += pl;
                            });
                            showPot = true;
                          }
                        }
                        }

                        const playersList = Array.from(allPlayers.entries())
                          .sort((a, b) => b[1].total - a[1].total);

                        return (
                          <table className="w-full border-collapse border border-gray-300 text-sm">
                            <thead>
                              <tr>
                                <th className="border border-gray-300 bg-gray-100 dark:bg-gray-800 p-2 text-left font-semibold">Competition</th>
                                {playersList.map(([userId, player]) => (
                                  <th key={userId} className="border border-gray-300 bg-gray-100 dark:bg-gray-800 p-2 text-center font-semibold">
                                    {player.username}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {(() => {
                                // Build rows. In Combined view, aggregate to one row per season
                                // (rolling the GW38 pot into 2025/2026). Otherwise show per-comp rows.
                                const shortName = (n: string) => {
                                  const m = n.match(/(\d+)\s*$/);
                                  return m ? `C${m[1]}` : n;
                                };
                                type Row = { label: string; getPl: (p: typeof playersList[0][1]) => number | undefined };
                                let rows: Row[];
                                if (selectedStatsSeason === 'combined') {
                                  const seasons = Array.from(new Set(completedComps.map(c => (c as any).season || '2025/2026'))).sort();
                                  rows = seasons.map(season => ({
                                    label: season,
                                    getPl: (p) => {
                                      let total = 0;
                                      let any = false;
                                      completedComps.filter(c => ((c as any).season || '2025/2026') === season).forEach(c => {
                                        const v = p.pl.get(`comp-${c.id}`);
                                        if (v !== undefined) { total += v; any = true; }
                                      });
                                      if (showPot && season === '2025/2026') {
                                        const v = p.pl.get(POT_KEY);
                                        if (v !== undefined) { total += v; any = true; }
                                      }
                                      return any ? total : undefined;
                                    },
                                  }));
                                } else {
                                  rows = completedComps.map(comp => ({
                                    label: shortName(comp.name),
                                    getPl: (p) => p.pl.get(`comp-${comp.id}`),
                                  }));
                                  if (showPot) {
                                    rows.push({ label: POT_LABEL, getPl: (p) => p.pl.get(POT_KEY) });
                                  }
                                }
                                return rows.map((row, i) => (
                                  <tr key={i}>
                                    <td className="border border-gray-300 p-2 font-medium">{row.label}</td>
                                    {playersList.map(([userId, player]) => {
                                      const pl = row.getPl(player);
                                      if (pl === undefined) return <td key={userId} className="border border-gray-300 p-2 text-center text-gray-400">-</td>;
                                      return (
                                        <td key={userId} className={`border border-gray-300 p-2 text-center ${pl > 0 ? 'text-green-600 font-medium' : pl < 0 ? 'text-red-600' : ''}`}>
                                          {pl > 0 ? '+' : pl < 0 ? '-' : ''}{Math.abs(pl)}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                ));
                              })()}
                            </tbody>
                            <tfoot>
                              <tr className="bg-gray-50 dark:bg-gray-900">
                                <td className="border border-gray-300 p-2 font-bold">Total</td>
                                {playersList.map(([userId, player]) => (
                                  <td key={userId} className={`border border-gray-300 p-2 text-center font-bold whitespace-nowrap ${player.total > 0 ? 'text-green-600' : player.total < 0 ? 'text-red-600' : ''}`}>
                                    {player.total < 0 ? '-' : ''}£{Math.abs(player.total)}
                                  </td>
                                ))}
                              </tr>
                            </tfoot>
                          </table>
                        );
                      })()}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Season Stats */}
              <Card>
                <CardHeader>
                  <CardTitle>Season Stats</CardTitle>
                </CardHeader>
                <CardContent>
                  {historyLoading ? (
                    <Skeleton className="h-64 w-full" />
                  ) : (
                    <div className="overflow-x-auto">
                      {(() => {
                        const seasonFilter = (c: any) => selectedStatsSeason === "combined" || (c.season || "2025/2026") === selectedStatsSeason;
                        const completedComps = (historicalCompetitions?.filter(c => c.status === "completed") || [])
                          .filter(seasonFilter)
                          .sort((a, b) => a.id - b.id);
                        const activeComps = (historicalCompetitions?.filter(c => c.status === "active") || [])
                          .filter(seasonFilter);

                        // Build per-player stats
                        type PlayerStats = {
                          username: string;
                          compsEntered: number;
                          wins: number;
                          totalRoundsSurvived: number;
                          firstRoundExits: number;
                          bestRun: number;
                          crossStreak: number;
                          randomTotal: number;
                          randomWins: number;
                          totalPicks: number;
                          correctPicks: number;
                          placingSum: number;
                          placingCount: number;
                        };

                        const statsMap = new Map<number, PlayerStats>();

                        // Include in-progress competitions so eliminations and picks are
                        // reflected as soon as a result is recorded, not only once a
                        // competition has finished. Active comps have no winner yet, so no
                        // wins are awarded from them until they complete.
                        const allComps = [...completedComps, ...activeComps];

                        allComps.forEach(comp => {
                          const winnerId = (comp as any)?.winner_id || comp?.winnerId;
                          const coWinnerId = (comp as any)?.co_winner_id || (comp as any)?.coWinnerId;
                          const winShare = coWinnerId ? 0.5 : 1;
                          const startGW = (comp as any)?.start_gameweek || comp?.startGameweek || 1;
                          const finalGW = (comp as any)?.current_gameweek ?? comp?.currentGameweek ?? startGW;

                          const isActiveComp = comp.status === "active";
                          const elimRoundOf = (p: any) => p.eliminated_in_round ?? p.eliminatedInRound;
                          const getRounds = (p: any, isWinner: boolean) => {
                            if (isWinner) return finalGW - startGW + 1; // winner survived all rounds incl. the final one
                            const elimRound = elimRoundOf(p);
                            if (elimRound != null) return elimRound - startGW;
                            // Still in the competition — only happens while a comp is in
                            // progress. Count rounds survived so far as winning picks made.
                            return isActiveComp ? ((p.selections as any[]) || []).filter((s) => s.result === "w").length : 0;
                          };

                          // Compute rounds per participant first, then rank by rounds (desc)
                          const withRounds = comp.participants.map(p => {
                            const isWinner = winnerId === (p as any).id || winnerId === p.userId
                              || coWinnerId === (p as any).id || coWinnerId === p.userId;
                            return { p, isWinner, rounds: getRounds(p, isWinner) };
                          }).sort((a, b) => b.rounds - a.rounds);

                          // Assign tied placings: same rounds = same placing
                          let placing = 1;
                          for (let i = 0; i < withRounds.length; i++) {
                            if (i > 0 && withRounds[i].rounds < withRounds[i - 1].rounds) {
                              placing = i + 1;
                            }
                            const { p, isWinner, rounds } = withRounds[i];

                            if (!statsMap.has(p.userId)) {
                              statsMap.set(p.userId, {
                                username: p.user?.username || `Unknown User (${p.userId})`,
                                compsEntered: 0,
                                wins: 0,
                                totalRoundsSurvived: 0,
                                firstRoundExits: 0,
                                bestRun: 0,
                                crossStreak: 0,
                                randomTotal: 0,
                                randomWins: 0,
                                totalPicks: 0,
                                correctPicks: 0,
                                placingSum: 0,
                                placingCount: 0,
                              });
                            }
                            const s = statsMap.get(p.userId)!;
                            s.compsEntered++;
                            if (isWinner) s.wins += winShare;
                            s.totalRoundsSurvived += rounds;
                            // A first-round exit requires actually being eliminated: in an
                            // in-progress comp a still-in player also has 0 rounds so far.
                            const eliminatedThisComp = elimRoundOf(p) != null;
                            if (rounds === 0 && !isWinner && (!isActiveComp || eliminatedThisComp)) s.firstRoundExits++;
                            if (rounds > s.bestRun) s.bestRun = rounds;
                            s.placingSum += placing;
                            s.placingCount++;

                            // picks and random picks
                            const sels = (p as any).selections || [];
                            sels.forEach((sel: any) => {
                              if (sel.result === 'w' || sel.result === 'l') {
                                s.totalPicks++;
                                if (sel.result === 'w') s.correctPicks++;
                                const isRandom = sel.isRandomlyAssigned === true || sel.isRandomlyAssigned === 'true'
                                  || sel.is_randomly_assigned === true || sel.is_randomly_assigned === 'true';
                                if (isRandom) {
                                  s.randomTotal++;
                                  if (sel.result === 'w') s.randomWins++;
                                }
                              }
                            });
                          }
                        });

                        // Cross-competition streak: longest run of consecutive correct picks
                        // across competitions in chronological order (comp id asc, gw asc)
                        const chronoComps = [...completedComps, ...activeComps].sort((a, b) => a.id - b.id);
                        const picksByUser = new Map<number, ('w' | 'l')[]>();
                        chronoComps.forEach(comp => {
                          comp.participants.forEach((p: any) => {
                            if (!statsMap.has(p.userId)) return;
                            const sels = ((p.selections as any[]) || [])
                              .filter(s => s.result === 'w' || s.result === 'l')
                              .sort((a, b) => (a.gameweek ?? 0) - (b.gameweek ?? 0));
                            if (!picksByUser.has(p.userId)) picksByUser.set(p.userId, []);
                            const arr = picksByUser.get(p.userId)!;
                            sels.forEach(s => arr.push(s.result));
                          });
                        });
                        picksByUser.forEach((picks, userId) => {
                          let longest = 0;
                          let current = 0;
                          picks.forEach(r => {
                            if (r === 'w') {
                              current++;
                              if (current > longest) longest = current;
                            } else {
                              current = 0;
                            }
                          });
                          const s = statsMap.get(userId);
                          if (s) s.crossStreak = longest;
                        });

                        // Sort by wins desc, then total rounds survived desc
                        const playersList = Array.from(statsMap.entries())
                          .sort((a, b) => b[1].wins - a[1].wins || b[1].totalRoundsSurvived - a[1].totalRoundsSurvived);

                        const statDefs = [
                          {
                            key: 'wins',
                            label: '🏆 Wins',
                            tooltip: 'Competitions won',
                            value: (s: PlayerStats) => s.wins,
                            format: (v: number) => String(v),
                            best: 'max',
                          },
                          {
                            key: 'winRate',
                            label: '📈 Win Rate',
                            tooltip: 'Wins ÷ comps entered',
                            value: (s: PlayerStats) => s.compsEntered > 0 ? Math.round((s.wins / s.compsEntered) * 100) : 0,
                            format: (v: number) => `${v}%`,
                            best: 'max',
                          },
                          {
                            key: 'correctPicks',
                            label: '✅ Correct Picks',
                            tooltip: 'Correct picks out of total picks made',
                            value: (s: PlayerStats) => s.totalPicks > 0 ? s.correctPicks / s.totalPicks : 0,
                            format: (_v: number, s: PlayerStats) => s.totalPicks === 0 ? '-' : `${s.correctPicks}/${s.totalPicks}`,
                            best: 'max',
                          },
                          {
                            key: 'pickPct',
                            label: '🎯 Pick %',
                            tooltip: 'Percentage of picks that were correct',
                            value: (s: PlayerStats) => s.totalPicks > 0 ? (s.correctPicks / s.totalPicks) * 100 : 0,
                            format: (v: number) => `${v.toFixed(1)}%`,
                            best: 'max',
                          },
                          {
                            key: 'avgPlacing',
                            label: '📊 Avg Placing',
                            tooltip: 'Average finishing position (lower is better)',
                            value: (s: PlayerStats) => s.placingCount > 0 ? s.placingSum / s.placingCount : 99,
                            format: (v: number) => v === 99 ? '-' : v.toFixed(1),
                            best: 'min',
                          },
                          {
                            key: 'avgRounds',
                            label: '📅 Avg Rounds',
                            tooltip: 'Average rounds survived per competition',
                            value: (s: PlayerStats) => s.compsEntered > 0 ? s.totalRoundsSurvived / s.compsEntered : 0,
                            format: (v: number) => v.toFixed(1),
                            best: 'max',
                          },
                          {
                            key: 'bestRun',
                            label: '🔥 Best Run',
                            tooltip: 'Most rounds survived in a single competition',
                            value: (s: PlayerStats) => s.bestRun,
                            format: (v: number) => String(v),
                            best: 'max',
                          },
                          {
                            key: 'crossStreak',
                            label: '⚡ Best Streak',
                            tooltip: 'Longest run of consecutive correct picks across all competitions',
                            value: (s: PlayerStats) => s.crossStreak,
                            format: (v: number) => String(v),
                            best: 'max',
                          },
                          {
                            key: 'firstRound',
                            label: '💀 Round 1 Exits',
                            tooltip: 'Times eliminated in the first round',
                            value: (s: PlayerStats) => s.firstRoundExits,
                            format: (v: number) => String(v),
                            best: 'min',
                          },
                          {
                            key: 'random',
                            label: '🎲 Random Picks',
                            tooltip: 'Randomly assigned picks that won / total random picks',
                            value: (s: PlayerStats) => s.randomTotal > 0 ? s.randomWins / s.randomTotal : -1,
                            format: (_v: number, s: PlayerStats) => s.randomTotal === 0 ? '-' : `${s.randomWins}/${s.randomTotal}`,
                            best: 'max',
                          },
                        ].filter(d => d.key !== 'random' || selectedStatsSeason !== '2024/2025');

                        return (
                          <table className="w-full border-collapse border border-gray-300 text-sm">
                              <thead>
                                <tr>
                                  <th className="border border-gray-300 bg-gray-100 dark:bg-gray-800 p-2 text-left font-semibold whitespace-nowrap">Stat</th>
                                  {playersList.map(([userId, s]) => (
                                    <th key={userId} className="border border-gray-300 bg-gray-100 dark:bg-gray-800 p-2 text-center font-semibold">
                                      {s.username}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {statDefs.map(stat => {
                                  const values = playersList.map(([, s]) => stat.value(s));
                                  const bestVal = stat.best === 'max' ? Math.max(...values) : Math.min(...values.filter(v => v >= 0));
                                  return (
                                    <tr key={stat.key}>
                                      <td className="border border-gray-300 p-2 font-medium whitespace-nowrap text-xs sm:text-sm" title={stat.tooltip}>
                                        {stat.label}
                                      </td>
                                      {playersList.map(([userId, s]) => {
                                        const raw = stat.value(s);
                                        const isBest = raw === bestVal && raw >= 0;
                                        return (
                                          <td
                                            key={userId}
                                            className={`border border-gray-300 p-2 text-center text-sm ${isBest ? 'font-bold text-green-600' : ''}`}
                                          >
                                            {stat.format(raw, s)}
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>

                        );
                      })()}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
            
            <TabsContent value="rules" className="space-y-6">
              <LmsRulesTabContent rules={lmsRules} />
            </TabsContent>
          </Tabs>
          );
          })()}
        </div>
      </main>
    </div>
  );
}

function formatGbp(n: number): string {
  return Number.isInteger(n) ? `£${n}` : `£${n.toFixed(2)}`;
}

function renderCompletedBanner(competition: any, rules: LmsRuleSet, prize?: CompPrize) {
  const winnerId = competition.winner_id ?? competition.winnerId ?? null;
  const coWinnerId = competition.co_winner_id ?? competition.coWinnerId ?? null;
  const participants = competition.participants ?? [];
  const winner = participants.find(
    (p: any) => p.id === winnerId || p.userId === winnerId,
  );
  const coWinner = coWinnerId
    ? participants.find((p: any) => p.id === coWinnerId || p.userId === coWinnerId)
    : null;
  const winnerName = winner?.user?.username;
  const coWinnerName = coWinner?.user?.username;
  // The pot is rollover-aware (a win after all-outs takes the accumulated pot)
  // and season-correct — both handled by the shared prize map. Fall back to a
  // plain stake × entrants only when this competition isn't in the map yet.
  const prizeAmount = prize?.prizePool ?? rules.entryFeeGbp * participants.length;

  let body: JSX.Element;
  if (winnerName && coWinnerName) {
    // Joint winners (both final-round survivors win their match) — split equally.
    const share = prize?.winnerShare ?? prizeAmount / 2;
    body = (
      <div className="text-base text-yellow-800 dark:text-yellow-200">
        Joint winners: <span className="font-bold">{winnerName} & {coWinnerName}</span>{" "}
        ({formatGbp(share)} each)
      </div>
    );
  } else if (winnerName) {
    body = (
      <div className="text-base text-yellow-800 dark:text-yellow-200">
        Winner: <span className="font-bold">{winnerName}</span> ({formatGbp(prize?.winnerShare ?? prizeAmount)})
      </div>
    );
  } else if (rules.allOutBehaviour === "split_final_round") {
    // No single winner (everyone remaining went out in the same gameweek). For
    // groups that split on an all-out (e.g. Rovers), the joint winners are the
    // players who lasted longest — those eliminated in the final round — and the
    // pot (entry fee × everyone) is shared equally between them.
    const elimRound = (p: any) => p.eliminatedInRound ?? p.eliminated_in_round ?? 0;
    const maxRound = participants.reduce((m: number, p: any) => Math.max(m, elimRound(p)), 0);
    const coWinners = participants.filter((p: any) => elimRound(p) === maxRound);
    const names = coWinners.map((p: any) => p.user?.username).filter(Boolean);
    const pot = prize?.prizePool ?? rules.entryFeeGbp * participants.length;
    const share = names.length ? pot / names.length : pot;
    body =
      names.length > 0 ? (
        <div className="text-base text-yellow-800 dark:text-yellow-200">
          Joint winners: <span className="font-bold">{names.join(" & ")}</span>{" "}
          ({formatGbp(share)} each)
        </div>
      ) : (
        <div className="text-base text-yellow-800 dark:text-yellow-200">
          All players eliminated — pot split between the final round's players
        </div>
      );
  } else {
    body = (
      <div className="text-base text-yellow-800 dark:text-yellow-200">
        No winner — all players eliminated (pot rolls over)
      </div>
    );
  }

  return (
    <Card className="border-2 border-yellow-400 bg-gradient-to-br from-yellow-50 to-amber-50 dark:from-yellow-950/40 dark:to-amber-950/40">
      <CardContent className="py-6 text-center space-y-2">
        <div className="text-4xl">🏆</div>
        {body}
      </CardContent>
    </Card>
  );
}

// Rules tab body — content depends on the active group's LMS rule variant.
function LmsRulesTabContent({ rules }: { rules: LmsRuleSet }) {
  const splitFinalRound = rules.allOutBehaviour === "split_final_round";
  const lockHours = rules.lockHoursBeforeKickoff;
  const lockText =
    lockHours === 0
      ? "at kick-off of the gameweek's first match"
      : `${lockHours} ${lockHours === 1 ? "hour" : "hours"} before kick-off of the gameweek's first match`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Last Man Standing Rules</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3 text-sm">
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>£{rules.entryFeeGbp} entry fee per player, per competition</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>Pick one team each gameweek to win their match</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>If your team wins, you advance to the next round</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>If your team loses or draws, you are eliminated from the competition</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>You cannot pick the same team twice in the same competition</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>Team selection automatically locks {lockText}</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>
              Players who don't select a team before the deadline will be randomly assigned one
              (shown with asterisk *)
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>The last player standing wins the entire pot</span>
          </li>
          {/* For Rovers (splitFinalRound) the "all out in the same week → split"
              rule reads first; other groups keep season-ends-with-multiple
              first, then the rollover rule. */}
          {splitFinalRound && (
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span>
                If all remaining players are eliminated in the same gameweek, the
                pot is split equally between them
              </span>
            </li>
          )}
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>
              If the season ends with multiple players remaining, the pot is
              split equally
            </span>
          </li>
          {!splitFinalRound && (
            <li className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span>
                If nobody wins a competition (all remaining players eliminated at
                the same time), the money rolls over to the next competition
              </span>
            </li>
          )}
          <li className="flex items-start gap-2">
            <span className="text-primary">•</span>
            <span>New competitions start automatically when the previous one ends</span>
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}