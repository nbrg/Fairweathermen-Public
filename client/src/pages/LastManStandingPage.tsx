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
import { CheckCircle, XCircle, Crown, Trophy, Calendar, HelpCircle, Lock, Check, X, Asterisk } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import Header from "@/components/Header";
import { useGroup } from "@/contexts/GroupContext";
import { trackEvent, trackUiEvent } from "@/lib/track";
import { TeamPickerDialog } from "@/components/lms/TeamPickerDialog";
import { TeamCrest } from "@/components/TeamCrest";
import type {
  LmsCompetition,
  LmsParticipant,
  LmsSelection,
  Team,
  User,
  Match,
  GroupRules,
  LmsMissedPolicy,
  LmsAllOutPolicy,
} from "@shared/schema";
import { resolveGroupRules } from "@shared/schema";
import { londonStringToUtcMs } from "@shared/time";
import { isCityGroup, isRoversGroup } from "@shared/originalGroups";

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
//  - hidden:  pick made but redacted until kickoff → a lock; a random pick
//             whose randomiser wheel hasn't landed yet → a wheel
//  - missed:  no pick by the deadline under the "eliminate" rule (a row with no
//             team that counts as a loss) → a red "Missed" cell
//  - pick:    the crest badge
// One look for every LMS grid (selections, history, fixtures, P/L, stats):
// a rounded frame, a muted header row with small uppercase labels, light row
// dividers, and a frozen first column (see .table-sticky-first in index.css).
// border-separate keeps the frozen column's edge attached when it scrolls.
const GRID_WRAP = "table-sticky-first overflow-x-auto rounded-xl border border-border";
const GRID_TABLE =
  "w-full border-separate border-spacing-0 text-xs sm:text-sm [&_tbody_tr:last-child>td]:border-b-0";
const GRID_TH =
  "h-9 whitespace-nowrap border-b border-border bg-muted px-2 text-center text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground";
const GRID_TH_FIRST = `${GRID_TH} !text-left pl-3`;
const GRID_TD = "border-b border-border/70 px-2 py-2 text-center";
const GRID_TD_FIRST = "border-b border-border/70 py-2 pl-3 pr-2 text-left font-medium whitespace-nowrap";

// Ref for the Team selections grid and History's final table: open them scrolled
// fully right so the latest gameweeks show without scrolling. A module-level function keeps the ref
// stable, so it runs once on mount and never fights the player's own scrolling.
function scrollGridToLatest(el: HTMLDivElement | null) {
  if (el) el.scrollLeft = el.scrollWidth;
}

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
  const td = "border-b border-border/70 px-1 py-1 text-center align-middle";
  // Every state is a same-sized tile, so the grid stays even. Crest and fixture
  // sit side by side in a short tile, so the grid stays compact enough to
  // screenshot into a group chat.
  const tile = "mx-auto flex h-8 w-20 items-center justify-center gap-1 rounded-lg px-1.5";

  // Knocked out before this week — an empty, greyed cell, so it's obvious they're gone.
  if (isOut) {
    return <td className={`${td} bg-muted/50`} aria-label="Out of the competition" />;
  }

  if (!selection) {
    return (
      <td className={td}>
        <div className={`${tile} text-muted-foreground/60`}>–</div>
      </td>
    );
  }

  if (isHidden && (selection as any).wheel === true) {
    return (
      <td className={td}>
        <div className={`${tile} bg-amber-100 text-lg`} title="Missed the deadline: the randomiser wheel picks this team">
          <span role="img" aria-label="Missed the deadline: the wheel picks this team">🎡</span>
        </div>
      </td>
    );
  }

  if (isHidden) {
    return (
      <td className={td}>
        <div className={`${tile} bg-muted`} title="Pick made — hidden until kickoff">
          <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="Pick made, hidden until kickoff" />
        </div>
      </td>
    );
  }

  if (selection.teamId == null) {
    return (
      <td className={td}>
        <div
          className={`${tile} bg-rose-100 text-[10px] font-semibold uppercase tracking-wide text-rose-800 ring-2 ring-inset ring-rose-500`}
          title="No pick by the deadline — counted as a lost life"
        >
          Missed
        </div>
      </td>
    );
  }

  const teamShortName = team?.shortName || "Unknown";
  const randomFlag = (selection as any).isRandomlyAssigned ?? (selection as any).is_randomly_assigned;
  const isRandom = randomFlag === true || randomFlag === "true";
  const won = selection.result === "w";
  const lost = selection.result === "l";
  // Won / lost show as a green / red tile with a strong outline and a solid
  // corner tick or cross, so who went through and who went out reads at a
  // glance; a pick still to be played is a plain tile.
  const tone = won
    ? "bg-emerald-100 ring-2 ring-emerald-500"
    : lost
    ? "bg-rose-100 ring-2 ring-rose-500"
    : "bg-card ring-1 ring-border";
  const fixtureText = won
    ? "text-emerald-800"
    : lost
    ? "text-rose-800"
    : "text-muted-foreground";

  return (
    <td className={td}>
      <div className={`${tile} relative ring-inset ${tone}`}>
        {won && (
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-600 text-white shadow-sm" aria-label="Won">
            <Check className="h-3 w-3" strokeWidth={3} />
          </span>
        )}
        {lost && (
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rose-600 text-white shadow-sm" aria-label="Lost">
            <X className="h-3 w-3" strokeWidth={3} />
          </span>
        )}
        {isRandom && (
          // A solid amber corner badge (mirroring the won/lost badge on the
          // other corner) so a random pick stands out on mobile as well.
          <span
            className="absolute -left-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-white shadow-sm ring-1 ring-white"
            title="Randomly assigned after the deadline"
            aria-label="Random pick"
            data-testid="lms-random-pick-badge"
          >
            <Asterisk className="h-3 w-3" strokeWidth={3.5} />
          </span>
        )}

        {/* The crest alone identifies the team (its monogram fallback carries the
            abbreviation when a real crest isn't available). */}
        <span className="flex shrink-0" title={team?.name ?? teamShortName}>
          {team ? (
            <TeamCrest team={team} size={20} transparent />
          ) : (
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[8px] font-bold text-muted-foreground">
              {teamShortName.slice(0, 3)}
            </span>
          )}
        </span>

        {opponent && (
          <div className={`whitespace-nowrap text-[10px] font-medium leading-none ${fixtureText}`}>
            {opponent.short} ({opponent.isHome ? "H" : "A"})
          </div>
        )}
      </div>
    </td>
  );
}

// Whether a participant is out of the competition before a given gameweek — so
// their cells from the round *after* elimination onward render the same "out"
// state in every view. Primarily driven by earlier losing picks (present in both
// live and historical data), so the live and history tables agree: a player is
// out once they've lost as many times as the group's lives (1 by default — one
// loss and you're gone). The eliminatedInRound flag is a fallback.
function isOutBeforeGameweek(
  participant: { isActive?: string; eliminatedInRound?: number | null; selections?: { gameweek: number; result?: string | null }[] },
  gameweek: number,
  lives = 1,
): boolean {
  const lossesBefore = (participant.selections ?? []).filter((s) => s.result === "l" && s.gameweek < gameweek).length;
  if (lossesBefore >= Math.max(1, lives)) return true;
  const round = participant.eliminatedInRound ?? (participant as any).eliminated_in_round ?? null;
  return participant.isActive !== "true" && round != null && gameweek > round;
}

// The LMS rules a group plays by, in the shape this page needs for the Rules tab
// text and the prize / P&L maths. Built from the group's configured rules
// (group.rules, set by its admin at /group-settings) — see lmsRulesForGroup.
type LmsRuleSet = {
  // The buy-in: what each player pays per competition.
  entryFeeGbp: number;
  // How many losing picks it takes to knock a player out.
  lives: number;
  // Minutes before the gameweek's first kick-off that picks lock.
  deadlineMinutesBeforeKickoff: number;
  missedPickPolicy: LmsMissedPolicy;
  allOutPolicy: LmsAllOutPolicy;
  // Rovers' long-standing all-out rule: when everyone left goes out together the
  // players knocked out in the final round split the pot. Those competitions
  // never recorded winner ids, so the joint winners are derived from the final
  // elimination round instead.
  legacySplitFinalRound: boolean;
  // What the original groups' older competitions (which recorded no stake of
  // their own) cost — see entryFeeForSeason.
  legacyEntryFeeGbp: number;
};

type GroupLike =
  | { id?: number; slug?: string; name?: string; rules?: GroupRules; selfService?: boolean }
  | null
  | undefined;

// Fairweathermen is matched by slug only (shared/originalGroups.ts), never by
// name, which anyone creating a group can copy.
function isFairweathermen(group: GroupLike): boolean {
  return isCityGroup(group);
}

// Groups with an admin set their LMS rules (buy-in included) at
// /group-settings — every self-service group, plus the original groups Alex
// was made admin of (the session's `selfService` flag). The other original
// groups have no admin and keep their long-standing stakes below.
function isSelfServiceGroup(group: GroupLike): boolean {
  return !!group?.selfService;
}

// The original groups' stakes predate per-group rules: Fairweathermen plays £5,
// everyone else £10, and Rovers splits the pot on an all-out. Their older
// competitions never recorded a stake, so these keep that P/L exactly as it
// always read; competitions opened since record their own (stakeGbp).

// Rovers' legacy split-on-all-out only covers competitions from before per-group
// rules, which never recorded a stake; newer ones follow the saved all-out rule.
function isLegacySplitCompetition(comp: any, rules: LmsRuleSet): boolean {
  const stake = comp?.stakeGbp ?? comp?.stake_gbp;
  return rules.legacySplitFinalRound && (stake === null || stake === undefined);
}

function lmsRulesForGroup(group: GroupLike): LmsRuleSet {
  const lms = resolveGroupRules(group?.rules).lms;
  const split = isRoversGroup(group);
  const legacyStake = isFairweathermen(group) ? 5 : 10;
  return {
    lives: lms.lives,
    deadlineMinutesBeforeKickoff: lms.deadlineMinutesBeforeKickoff,
    missedPickPolicy: lms.missedPickPolicy,
    entryFeeGbp: isSelfServiceGroup(group) ? lms.buyIn : legacyStake,
    // A group with an admin plays exactly what its saved rules say (Rovers included:
    // its old split-on-all-out only applies to its legacy competitions, below).
    allOutPolicy: isSelfServiceGroup(group) ? lms.allOutPolicy : split ? "co_winners" : "rollover",
    legacySplitFinalRound: split,
    legacyEntryFeeGbp: legacyStake,
  };
}

// The stake can change from one season to the next. Fairweathermen played £10
// per competition in 2024/2025 then dropped to £5; every other original group
// is a flat £10. Both are covered by using £10 for 2024/2025 and the group's
// legacy stake for anything after.
function entryFeeForSeason(season: string | null | undefined, legacyEntryFee: number): number {
  return (season || "2025/2026") === "2024/2025" ? 10 : legacyEntryFee;
}

// One competition's stake: the buy-in it recorded when it opened (so a later
// rule change never rewrites a finished competition), or for the original
// groups' older competitions, which recorded none, their per-season stake.
function entryFeeForCompetition(comp: any, rules: LmsRuleSet): number {
  const stored = comp?.stakeGbp ?? comp?.stake_gbp;
  if (typeof stored === "number") return stored;
  return entryFeeForSeason(comp?.season, rules.legacyEntryFeeGbp);
}

type CompPrize = { entryFee: number; prizePool: number; numWinners: number; winnerShare: number };

// The user ids of everyone who won a competition. A single winner is stored in
// winnerId. A shared win (the "co_winners" all-out rule) stores two of the
// players in winnerId + coWinnerId, but it belongs to everyone knocked out in
// that same final gameweek, however many there were (e.g. 10 of 100 going out
// together all split it), so the full list is read back from the participants.
// Stored ids are user ids; some old rows hold participant ids, so both match.
function competitionWinnerUserIds(comp: any): number[] {
  const winnerId = comp?.winner_id ?? comp?.winnerId ?? null;
  const coWinnerId = comp?.co_winner_id ?? comp?.coWinnerId ?? null;
  const participants: any[] = comp?.participants ?? [];
  const resolve = (id: number) =>
    participants.find((p) => p.userId === id) ?? participants.find((p) => p.id === id);
  const toUserId = (id: number) => resolve(id)?.userId ?? id;
  if (!winnerId) return [];
  if (!coWinnerId) return [toUserId(winnerId)];
  const ids = new Set<number>([toUserId(winnerId), toUserId(coWinnerId)]);
  const elimRound = (p: any) => p?.eliminatedInRound ?? p?.eliminated_in_round ?? null;
  const finalRound = elimRound(resolve(winnerId));
  if (finalRound != null) {
    for (const p of participants) if (elimRound(p) === finalRound) ids.add(p.userId);
  }
  return Array.from(ids);
}

// Work out each completed competition's actual prize, accounting for stakes
// that rolled over from earlier all-out (winnerless) competitions. When a
// competition ends with no winner the pot isn't lost — it carries forward, so a
// later winner collects everything banked since the last payout (this is how
// Sam took the 4× pot after C3–C5 all rolled over).
// Rollovers never cross a season boundary, and the stake is resolved per
// competition. Returns a map keyed by competition id; callers pass every
// completed competition so the running total is correct regardless of which one
// they're rendering.
function computeCompetitionPrizes(
  completedComps: { id: number; season?: string | null; participants: any[] }[],
  rules: LmsRuleSet,
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
    const entryFee = entryFeeForCompetition(comp, rules);
    const compPot = entryFee * comp.participants.length;
    const numWinners = competitionWinnerUserIds(comp).length;
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

  // Countdown split into tiles. The deadline banner is hidden once it has
  // passed (above), so this only ever counts down.
  const totalMin = Math.floor(diffMs / 60000);
  const tiles = [
    { value: Math.floor(totalMin / (60 * 24)), unit: "days" },
    { value: Math.floor((totalMin % (60 * 24)) / 60), unit: "hours" },
    { value: totalMin % 60, unit: "mins" },
  ];
  const urgent = diffMs < 24 * 60 * 60 * 1000;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-baseline justify-between gap-3">
          <div className={`eyebrow ${urgent ? "text-amber-700" : ""}`}>GW{gameweek} deadline</div>
          <div className="text-[13px] text-muted-foreground tabular-nums">{deadlineLabel}</div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {tiles.map((t) => (
            <div
              key={t.unit}
              className={`rounded-xl py-2.5 text-center ${urgent ? "bg-amber-50" : "bg-muted"}`}
            >
              <div
                className={`font-display text-[30px] font-bold leading-none tabular-nums ${
                  urgent ? "text-amber-700" : ""
                }`}
              >
                {t.unit === "days" ? t.value : String(t.value).padStart(2, "0")}
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">{t.unit}</div>
            </div>
          ))}
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
      const team = teams?.find((t) => t.id === teamId);
      trackUiEvent("fixture_select", { team: team?.shortName ?? team?.name ?? String(teamId), hidden: !hiddenTeams.has(teamId) });
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
          <p className="text-sm text-gray-600 mb-4">
            The {LMS_NEXT_SEASON_LABEL} Premier League fixtures haven't been
            announced yet. The 20 teams in the league are listed below — full
            fixtures will appear here once published.
          </p>
          <div className={GRID_WRAP}>
            <table className={GRID_TABLE}>
              <thead>
                <tr>
                  <th className={GRID_TH_FIRST}>
                    Team
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...LMS_NEXT_SEASON_TEAMS]
                  .sort((a, b) => a.localeCompare(b))
                  .map((name) => (
                    <tr key={name}>
                      <td className={GRID_TD_FIRST}>
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
  // gameweek pointer (which can trail the previous season). And go by kick-off
  // times rather than which matches have results: keying it off results rewound
  // the grid to stale gameweeks whenever some results were missing (e.g. GW4
  // while the season was mid-GW8).
  //
  // The current gameweek is the latest one that has kicked off, while it's still
  // being played — a match of it is in progress, kicked off in the last few
  // hours, or is still to come within a week of its first kick-off (so a
  // postponed match rearranged for months later doesn't hold the grid back).
  // Otherwise it's the next gameweek to start; if the whole season is done, the
  // last gameweek, so the grid isn't empty.
  const HOURS = 60 * 60 * 1000;
  const firstKickoffByGw = new Map<number, number>();
  for (const m of matches) {
    if (m.gameweek == null) continue;
    const ko = londonStringToUtcMs(m.matchTime);
    if (Number.isNaN(ko)) continue;
    const cur = firstKickoffByGw.get(m.gameweek);
    if (cur == null || ko < cur) firstKickoffByGw.set(m.gameweek, ko);
  }
  const allGWs = Array.from(firstKickoffByGw.keys());
  const startedGWs = allGWs.filter((gw) => firstKickoffByGw.get(gw)! <= nowMs);
  const upcomingGWs = allGWs.filter((gw) => firstKickoffByGw.get(gw)! > nowMs);
  const latestStarted = startedGWs.length ? Math.max(...startedGWs) : null;
  const stillBeingPlayed = (gw: number) => {
    const first = firstKickoffByGw.get(gw)!;
    return matches.some((m) => {
      if (m.gameweek !== gw || m.status === "finished") return false;
      if (m.status === "in_progress") return true;
      const ko = londonStringToUtcMs(m.matchTime);
      if (Number.isNaN(ko)) return false;
      return ko > nowMs - 3 * HOURS && ko <= first + 7 * 24 * HOURS;
    });
  };
  const currentGW =
    latestStarted != null && stillBeingPlayed(latestStarted)
      ? latestStarted
      : upcomingGWs.length
        ? Math.min(...upcomingGWs)
        : allGWs.length
          ? Math.max(...allGWs)
          : 1;
  const gameweeksToShow = Array.from({ length: 5 }, (_, i) => currentGW + i).filter(gw => gw <= 38);

  // Group matches by gameweek and team
  const fixturesByTeam: Record<number, Record<number, { opponent: string; opponentTeam?: Team; isHome: boolean }>> = {};
  
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
          opponentTeam: match.awayTeam ?? undefined,
          isHome: true
        };
      }

      if (awayTeamId !== null && fixturesByTeam[awayTeamId]) {
        fixturesByTeam[awayTeamId][gameweek] = {
          opponent: match.homeTeam?.shortName || match.homeTeam?.name.substring(0, 3).toUpperCase() || 'TBD',
          opponentTeam: match.homeTeam ?? undefined,
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
                  <p className="text-sm text-gray-600">
                    Click any fixture cell to highlight it. This helps you plan potential picks. Click again to remove the highlight.
                  </p>
                </div>
                <div className="space-y-2">
                  <h4 className="font-medium text-sm">Tap & Hold to Hide Rows</h4>
                  <p className="text-sm text-gray-600">
                    Tap and hold any team name to hide that team's row. This removes teams you're not interested in for a cleaner view.
                  </p>
                </div>
                <div className="space-y-2">
                  <h4 className="font-medium text-sm">Temporary Changes</h4>
                  <p className="text-sm text-gray-600">
                    These changes are temporary and will reset when you refresh the page.
                  </p>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        <div className={GRID_WRAP}>
          <table className={GRID_TABLE}>
            <thead>
              <tr>
                <th className={GRID_TH_FIRST}>Team</th>
                {gameweeksToShow.map(gw => (
                  <th key={gw} className={`${GRID_TH} min-w-[72px] ${gw === currentGW ? "!text-primary" : ""}`}>
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
                    <td className={GRID_TD_FIRST}>
                      <span
                        className="flex cursor-pointer select-none items-center gap-1.5"
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
                        <TeamCrest team={team} size={18} transparent />
                        <span className="max-w-[72px] truncate sm:max-w-none">{getFixturesTeamName(team.name)}</span>
                      </span>
                    </td>
                    {gameweeksToShow.map(gw => {
                      const fixture = fixturesByTeam[team.id][gw];
                      const cellKey = `${team.id}-${gw}`;
                      const isHighlighted = highlightedCells.has(cellKey);

                      return (
                        <td key={gw} className="border-b border-border/70 p-1 text-center align-middle">
                          {fixture ? (
                            <button
                              type="button"
                              className={`mx-auto flex h-9 w-16 items-center justify-center gap-1 rounded-lg text-[11px] font-semibold ring-1 ring-inset transition-colors ${
                                isHighlighted
                                  ? 'bg-secondary text-primary ring-secondary'
                                  : fixture.isHome
                                  ? 'bg-muted text-foreground ring-transparent hover:ring-border'
                                  : 'bg-card text-muted-foreground ring-border hover:bg-muted/60'
                              }`}
                              onClick={() => {
                                toggleCellHighlight(team.id, gw);
                                trackUiEvent("fixture_select", {
                                  team: team.shortName ?? team.name,
                                  opponent: fixture.opponent,
                                  home: fixture.isHome,
                                  gameweek: gw,
                                  on: !isHighlighted,
                                });
                              }}
                              aria-pressed={isHighlighted}
                              title={`${fixture.isHome ? 'Home' : 'Away'} vs ${fixture.opponentTeam?.name ?? fixture.opponent}`}
                            >
                              {fixture.opponentTeam && <TeamCrest team={fixture.opponentTeam} size={14} transparent />}
                              <span>{fixture.opponent}</span>
                              <span className="text-[9px] font-medium opacity-70">{fixture.isHome ? 'H' : 'A'}</span>
                            </button>
                          ) : (
                            <div className="text-muted-foreground/60">–</div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded bg-muted" /> Home</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded bg-card ring-1 ring-inset ring-border" /> Away</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded bg-secondary" /> Tap to highlight</span>
        </p>
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
  const lmsRules = useMemo(() => lmsRulesForGroup(group), [group]);

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
  // no competition yet. Competitions open themselves (see server/lmsAutoStart),
  // so with no competition we still check back once a minute — slow enough not
  // to churn the page (an unchanged null doesn't re-render), quick enough that a
  // freshly opened competition shows up without a manual refresh.
  const { data: currentCompetition, isLoading: competitionLoading } = useQuery<
    CompetitionWithDetails | null
  >({
    queryKey: ["/api/lms/current-competition"],
    queryFn: async () => {
      const response = await fetch(`/api/lms/current-competition`);
      if (!response.ok) throw new Error("Failed to fetch competition");
      return response.json();
    },
    refetchInterval: (q) => (q.state.data ? 5000 : 60_000),
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
      lmsRules,
    ),
    [historicalCompetitions, lmsRules],
  );

  // Whether the current season still has a match to come. With none, it's the
  // genuine off-season (the next competition waits for next season's GW1).
  const hasUpcomingFixtures = (() => {
    const now = Date.now();
    return (allMatches ?? []).some((m) => {
      const kickoff = m.matchTime ? londonStringToUtcMs(m.matchTime) : NaN;
      return !Number.isNaN(kickoff) && kickoff > now;
    });
  })();

  // An open competition whose gameweek has no fixtures loaded yet — e.g. waiting
  // on a new season's fixture list. Treated as "has fixtures" until the matches
  // have loaded, so the picker doesn't flash away on first render.
  const competitionGameweek =
    (currentCompetition as any)?.current_gameweek || currentCompetition?.currentGameweek || 1;
  const currentGameweekHasFixtures =
    allMatches === undefined || allMatches.some((m) => m.gameweek === competitionGameweek);

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
    // Joint winners (the "co_winners" all-out rule): everyone who went out in
    // the final gameweek gets the co-winner badge.
    const winnerIds = competitionWinnerUserIds(competition);
    if (winnerIds.includes(participant.userId)) {
      return (
        <Badge variant="default" className="bg-yellow-500 text-black">
          {winnerIds.length > 1 ? "Co-winner" : "Winner"}
        </Badge>
      );
    }

    // Split-on-all-out groups (e.g. Rovers): a completed competition with no single
    // winner means everyone remaining went out together — the players eliminated
    // in the final round are joint winners.
    const status = (competition as any)?.status;
    if (status === "completed" && !winnerId && competition && isLegacySplitCompetition(competition, lmsRules)) {
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
        <main className="container mx-auto max-w-5xl px-4 py-4 sm:py-8">
          <div className="space-y-4 sm:space-y-6">
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
      <main className="container mx-auto max-w-5xl px-4 py-4 sm:py-8">
        <div className="space-y-4 sm:space-y-6">

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

            <TabsContent value="current" className="space-y-4">
              {!currentCompetition && (
                <Card>
                  <CardContent className="py-12 text-center">
                    {allMatches === undefined ? (
                      <Skeleton className="mx-auto h-10 w-64" />
                    ) : hasUpcomingFixtures ? (
                      // Competitions open themselves (on group creation, when the
                      // last one ends, and at a new season's GW1), so with fixtures
                      // still to play this is only ever a brief gap.
                      <>
                        <p className="text-base font-medium text-gray-700">
                          Your competition is being set up
                        </p>
                        <p className="mt-2 text-sm text-gray-500">
                          It starts with the next gameweek. Check back shortly.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-base font-medium text-gray-700">
                          Coming soon
                        </p>
                        <p className="mt-2 text-sm text-gray-500">
                          The next Last Man Standing competition starts with GW1 of
                          the new season. Check back in August once the new Premier
                          League season's fixtures are out.
                        </p>
                      </>
                    )}
                  </CardContent>
                </Card>
              )}
              {currentCompetition && currentCompetition.status === "active" && !currentGameweekHasFixtures && (
                <Card>
                  <CardContent className="py-12 text-center">
                    <p className="text-base font-medium text-gray-700">
                      Coming soon
                    </p>
                    <p className="mt-2 text-sm text-gray-500">
                      The next competition starts with GW1 of the new season once
                      the fixtures are out.
                    </p>
                  </CardContent>
                </Card>
              )}
              {currentCompetition && (currentCompetition.status !== "active" || currentGameweekHasFixtures) && (
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
                    // gameweek's pick stays selectable so it can be changed. A
                    // missed-pick row (no team) doesn't use a team up.
                    const usedTeamIds = new Set(
                      myParticipant.selections
                        .filter((s) => s.gameweek !== gameweek)
                        .map((s) => s.teamId)
                        .filter((id): id is number => id != null),
                    );
                    const gwMatches = (allMatches ?? []).filter(
                      (m) => m.gameweek === gameweek && m.matchTime,
                    ) as (Match & { homeTeam: Team; awayTeam: Team })[];
                    const locked = gameweekStatus?.isLocked ?? false;
                    const myTeam = mySelection
                      ? allTeams?.find((t) => t.id === mySelection.teamId)
                      : undefined;
                    // Missed the deadline: the drawn team stays hidden until the
                    // randomiser wheel above lands on it.
                    const myPickOnWheel = (mySelection as any)?.wheel === true;

                    return (
                      <>
                        <div className="rounded-2xl bg-primary p-4 text-white shadow-card">
                          <div className="flex items-center gap-3.5">
                            {myTeam ? (
                              <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full bg-white">
                                <TeamCrest team={myTeam} size={40} />
                              </span>
                            ) : (
                              <span className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full border-2 border-dashed border-white/35 text-xl font-semibold text-white/60">
                                {myPickOnWheel ? <span role="img" aria-hidden>🎡</span> : "?"}
                              </span>
                            )}
                            <div className="min-w-0">
                              <p className="eyebrow text-white/65">Your GW{gameweek} pick</p>
                              <p className="font-display truncate text-[26px] font-bold leading-tight">
                                {myTeam ? myTeam.name : myPickOnWheel ? "Down to the wheel" : locked ? "No pick" : "Not picked yet"}
                              </p>
                            </div>
                          </div>
                          <Button
                            disabled={locked}
                            onClick={() => setPickerOpen(true)}
                            className="mt-4 h-12 w-full sm:w-auto sm:px-10 rounded-xl bg-secondary text-[15px] font-bold text-primary hover:bg-secondary/90 disabled:bg-white/15 disabled:text-white/60 disabled:opacity-100"
                          >
                            {locked ? "Locked" : mySelection ? "Change pick" : "Make your pick"}
                          </Button>
                        </div>
                        <TeamPickerDialog
                          open={pickerOpen}
                          onOpenChange={setPickerOpen}
                          gameweek={gameweek}
                          matches={gwMatches}
                          usedTeamIds={usedTeamIds}
                          currentTeamId={mySelection?.teamId ?? undefined}
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
                      <CardTitle className="text-lg sm:text-xl">Team selections</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div ref={scrollGridToLatest} className={GRID_WRAP} data-testid="lms-selections-grid">
                        <table className={GRID_TABLE}>
                          <thead>
                            <tr>
                              <th className={GRID_TH_FIRST}>
                                Player
                              </th>
                              {(() => {
                                const startGW = (currentCompetition as any).start_gameweek || currentCompetition.startGameweek || 1;
                                const currentGW = (currentCompetition as any).current_gameweek || currentCompetition.currentGameweek || currentCompetition.currentRound || startGW;
                                const numWeeks = currentGW - startGW + 1;

                                return Array.from({ length: numWeeks }, (_, i) => (
                                  <th
                                    key={`gw-${startGW + i}`}
                                    className={`${GRID_TH} min-w-[64px] ${startGW + i === currentGW ? "!text-primary" : ""}`}
                                  >
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
                                <td className={GRID_TD_FIRST}>
                                  <span className="block max-w-[84px] truncate sm:max-w-none">
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
                                    const isOut = isOutBeforeGameweek(participant, gameweek, lmsRules.lives);
                                    const teamId = selection && !isHidden ? selection.teamId : null;
                                    const team = teamId != null ? allTeams?.find(t => t.id === teamId) : undefined;
                                    const opponent = teamId != null ? opponentFor(allMatches, teamId, gameweek) : null;
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
                <div className="space-y-4 sm:space-y-6">
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
                                  const winnerIds = competitionWinnerUserIds(competition);
                                  if (winnerIds.length > 0) {
                                    const names = winnerIds.map((id) => {
                                      const p = competition.participants.find(pp => pp.userId === id);
                                      return p?.user?.username || `Unknown User (${id})`;
                                    });
                                    // Prize is rollover-aware and season-correct (see the shared
                                    // prize map): a win after all-outs takes the accumulated pot,
                                    // not just this competition's stakes.
                                    const prize = prizeByComp.get(competition.id);
                                    const prizePool = prize?.prizePool ?? entryFeeForCompetition(competition, lmsRules) * competition.participants.length;
                                    const share = prize?.winnerShare ?? prizePool / names.length;
                                    const shareLabel = Number.isInteger(share) ? `£${share}` : `£${share.toFixed(2)}`;
                                    return (
                                      <div className="flex items-center gap-2 text-yellow-600">
                                        <Crown className="h-5 w-5" />
                                        <span className="font-medium">
                                          {names.length > 1 ? `${names.join(" & ")} (${shareLabel} each)` : `${names[0]} (${shareLabel})`}
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
                                  <div ref={scrollGridToLatest} className={GRID_WRAP} data-testid="lms-history-grid">
                                    <table className={GRID_TABLE}>
                                      <thead>
                                        <tr>
                                          <th className={GRID_TH_FIRST}>
                                            Player
                                          </th>
                                          {Array.from({ 
                                            length: Math.max(0, ((competition as any).current_gameweek || competition.currentGameweek || 0) - ((competition as any).start_gameweek || competition.startGameweek || 1) + 1) 
                                          }, (_, i) => {
                                            const actualGameweek = ((competition as any).start_gameweek || competition.startGameweek || 1) + i;
                                            return (
                                              <th key={actualGameweek} className={`${GRID_TH} min-w-[64px]`}>
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
                                            <td className={GRID_TD_FIRST}>
                                              <div className="flex items-center gap-1.5">
                                                {participant.user?.username || 'Unknown User'}
                                                {competitionWinnerUserIds(competition).includes(participant.userId) && (
                                                  <Crown className="h-4 w-4 text-yellow-500" />
                                                )}
                                              </div>
                                            </td>
                                            {Array.from({ 
                                              length: Math.max(0, ((competition as any).current_gameweek || competition.currentGameweek || 0) - ((competition as any).start_gameweek || competition.startGameweek || 1) + 1) 
                                            }, (_, gameweekIndex) => {
                                              const gameweek = ((competition as any).start_gameweek || competition.startGameweek || 1) + gameweekIndex;
                                              const selection = participant.selections.find(s => s.gameweek === gameweek);
                                              const teamId = selection?.teamId ?? null;
                                              const team = teamId != null ? allTeams?.find(t => t.id === teamId) : undefined;
                                              // Resolve by the pick's actual matchId (season-correct, and works
                                              // for teams since relegated); fall back to the season-scoped
                                              // gameweek lookup for old picks that never stored a matchId.
                                              // A missed-pick row has no team, so no opponent.
                                              const opponent = teamId != null
                                                ? opponentForMatchId(matchesById, (selection as any).matchId, teamId)
                                                  ?? opponentForSeason(allSeasonMatches, (competition as any).season, teamId, gameweek)
                                                : null;
                                              return (
                                                <LmsSelectionCell
                                                  key={gameweek}
                                                  team={team}
                                                  selection={selection as any}
                                                  opponent={opponent}
                                                  isOut={isOutBeforeGameweek(participant, gameweek, lmsRules.lives)}
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
                    <div className={GRID_WRAP}>
                      {(() => {
                        const seasonFilter = (c: any) => selectedStatsSeason === "combined" || (c.season || "2025/2026") === selectedStatsSeason;
                        const completedComps = (historicalCompetitions?.filter(c => c.status === "completed") || [])
                          .filter(seasonFilter)
                          .sort((a, b) => a.id - b.id);
                        const allPlayers = new Map<number, { username: string; pl: Map<string, number>; total: number }>();

                        completedComps.forEach(comp => {
                          const winnerIds = competitionWinnerUserIds(comp);
                          // Stake and prize (rollover-aware) come from the shared prize map so
                          // the P/L table, the history winner line and the completed banner all
                          // agree. A winner collects this competition's pot plus anything rolled
                          // over from earlier all-out competitions; everyone still pays the stake.
                          const prize = prizeByComp.get(comp.id);
                          const entryFee = prize?.entryFee ?? entryFeeForCompetition(comp, lmsRules);
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
                            if (winnerIds.includes(p.userId)) {
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
                          <table className={GRID_TABLE}>
                            <thead>
                              <tr>
                                <th className={GRID_TH_FIRST}>Competition</th>
                                {playersList.map(([userId, player]) => (
                                  <th key={userId} className={`${GRID_TH} min-w-[64px] normal-case tracking-normal`}>
                                    {player.username}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {(() => {
                                // Build rows. In Combined view, aggregate to one row per season
                                // (rolling the GW38 pot into 2025/2026). Otherwise show per-comp rows.
                                // "Competition 2" -> "C2". A name without a trailing number (e.g. the
                                // rollover script's "<season> Last Man Standing") gets its position
                                // within its season instead, so a season's first competition reads C1.
                                const shortName = (comp: { id: number; name: string; season?: string | null }) => {
                                  const m = comp.name.match(/(\d+)\s*$/);
                                  if (m) return `C${m[1]}`;
                                  const label = labelForCompetition(comp, historicalCompetitions || []);
                                  const n = label.match(/^Competition (\d+)$/);
                                  return n ? `C${n[1]}` : comp.name;
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
                                    label: shortName(comp),
                                    getPl: (p) => p.pl.get(`comp-${comp.id}`),
                                  }));
                                  if (showPot) {
                                    rows.push({ label: POT_LABEL, getPl: (p) => p.pl.get(POT_KEY) });
                                  }
                                }
                                return rows.map((row, i) => (
                                  <tr key={i}>
                                    <td className={GRID_TD_FIRST}>{row.label}</td>
                                    {playersList.map(([userId, player]) => {
                                      const pl = row.getPl(player);
                                      if (pl === undefined) return <td key={userId} className={`${GRID_TD} text-muted-foreground/60`}>–</td>;
                                      return (
                                        <td key={userId} className={`${GRID_TD} ${pl > 0 ? 'text-green-600 font-medium' : pl < 0 ? 'text-red-600' : ''}`}>
                                          {pl > 0 ? '+' : pl < 0 ? '-' : ''}{Math.abs(pl)}
                                        </td>
                                      );
                                    })}
                                  </tr>
                                ));
                              })()}
                            </tbody>
                            <tfoot>
                              <tr className="bg-muted">
                                <td className="border-t border-border py-2 pl-3 pr-2 text-left font-bold">Total</td>
                                {playersList.map(([userId, player]) => (
                                  <td key={userId} className={`border-t border-border px-2 py-2 text-center font-bold whitespace-nowrap ${player.total > 0 ? 'text-green-600' : player.total < 0 ? 'text-red-600' : ''}`}>
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
                    <div className={GRID_WRAP}>
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
                          const winnerIds = competitionWinnerUserIds(comp);
                          const winShare = winnerIds.length > 0 ? 1 / winnerIds.length : 1;
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
                            const isWinner = winnerIds.includes(p.userId);
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
                          <table className={GRID_TABLE}>
                              <thead>
                                <tr>
                                  <th className={GRID_TH_FIRST}>Stat</th>
                                  {playersList.map(([userId, s]) => (
                                    <th key={userId} className={`${GRID_TH} min-w-[64px] normal-case tracking-normal`}>
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
                                      <td className={GRID_TD_FIRST} title={stat.tooltip}>
                                        {stat.label}
                                      </td>
                                      {playersList.map(([userId, s]) => {
                                        const raw = stat.value(s);
                                        const isBest = raw === bestVal && raw >= 0;
                                        return (
                                          <td
                                            key={userId}
                                            className={`${GRID_TD} ${isBest ? 'font-bold text-green-600' : ''}`}
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
  const participants = competition.participants ?? [];
  const winnerNames: string[] = competitionWinnerUserIds(competition)
    .map((id) => participants.find((p: any) => p.userId === id)?.user?.username)
    .filter(Boolean);
  const winnerName = winnerNames[0];
  // The pot is rollover-aware (a win after all-outs takes the accumulated pot)
  // and season-correct — both handled by the shared prize map. Fall back to a
  // plain stake × entrants only when this competition isn't in the map yet.
  const prizeAmount = prize?.prizePool ?? entryFeeForCompetition(competition, rules) * participants.length;

  let body: JSX.Element;
  if (winnerNames.length > 1) {
    // Joint winners (everyone who went out in the final gameweek) — split equally.
    const share = prize?.winnerShare ?? prizeAmount / winnerNames.length;
    body = (
      <div className="text-base text-yellow-800">
        Joint winners: <span className="font-bold">{winnerNames.join(" & ")}</span>{" "}
        ({formatGbp(share)} each)
      </div>
    );
  } else if (winnerName) {
    body = (
      <div className="text-base text-yellow-800">
        Winner: <span className="font-bold">{winnerName}</span> ({formatGbp(prize?.winnerShare ?? prizeAmount)})
      </div>
    );
  } else if (isLegacySplitCompetition(competition, rules)) {
    // No single winner (everyone remaining went out in the same gameweek). For
    // groups that split on an all-out (e.g. Rovers), the joint winners are the
    // players who lasted longest — those eliminated in the final round — and the
    // pot (entry fee × everyone) is shared equally between them.
    const elimRound = (p: any) => p.eliminatedInRound ?? p.eliminated_in_round ?? 0;
    const maxRound = participants.reduce((m: number, p: any) => Math.max(m, elimRound(p)), 0);
    const coWinners = participants.filter((p: any) => elimRound(p) === maxRound);
    const names = coWinners.map((p: any) => p.user?.username).filter(Boolean);
    const pot = prize?.prizePool ?? entryFeeForCompetition(competition, rules) * participants.length;
    const share = names.length ? pot / names.length : pot;
    body =
      names.length > 0 ? (
        <div className="text-base text-yellow-800">
          Joint winners: <span className="font-bold">{names.join(" & ")}</span>{" "}
          ({formatGbp(share)} each)
        </div>
      ) : (
        <div className="text-base text-yellow-800">
          All players eliminated — pot split between the final round's players
        </div>
      );
  } else {
    body = (
      <div className="text-base text-yellow-800">
        No winner — all players eliminated (pot rolls over)
      </div>
    );
  }

  return (
    <Card className="border-2 border-yellow-400 bg-gradient-to-br from-yellow-50 to-amber-50">
      <CardContent className="py-6 text-center space-y-2">
        <div className="text-4xl">🏆</div>
        {body}
      </CardContent>
    </Card>
  );
}

// "90 minutes", "2 hours", "1 day", "1 hour 30 minutes".
function formatLeadTime(minutes: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return plural(minutes, "minute");
  if (minutes % 1440 === 0) return plural(minutes / 1440, "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  return `${plural(Math.floor(minutes / 60), "hour")} ${plural(minutes % 60, "minute")}`;
}

// Rules tab body — every line comes from the group's configured LMS rules.
function LmsRulesTabContent({ rules }: { rules: LmsRuleSet }) {
  const lockText =
    rules.deadlineMinutesBeforeKickoff === 0
      ? "at kick-off of the gameweek's first match"
      : `${formatLeadTime(rules.deadlineMinutesBeforeKickoff)} before kick-off of the gameweek's first match`;
  const oneLife = rules.lives <= 1;

  const allOutText =
    rules.allOutPolicy === "co_winners"
      ? "If all remaining players are eliminated in the same gameweek, the pot is split equally between the players who went out that gameweek (not everyone who entered)"
      : "If all remaining players are eliminated in the same gameweek, nobody wins: everyone is back in for the next competition, and the pot rolls over into it on top of everyone's new buy-in";

  // Worked rollover example in the group's own buy-in, e.g. £10 → £20 per person.
  const fee = rules.entryFeeGbp;
  const examplePlayers = 8;
  const rolloverExample =
    rules.allOutPolicy === "rollover" && fee > 0
      ? `Example: ${examplePlayers} players pay ${formatGbp(fee)} each, so the pot is ${formatGbp(fee * examplePlayers)}. ` +
        `If everyone goes out in the same gameweek, nobody wins. Everyone is back in and pays another ${formatGbp(fee)} for the next competition, ` +
        `so it's worth ${formatGbp(fee * 2 * examplePlayers)}: ${formatGbp(fee * 2)} per person instead of ${formatGbp(fee)}. ` +
        `If that one rolls over too, the next is worth ${formatGbp(fee * 3)} per person. Rollovers don't carry into a new season.`
      : null;

  const items: string[] = [
    `£${rules.entryFeeGbp} entry fee per player, per competition`,
    "Pick one team each gameweek to win their match",
    "If your team wins, you advance to the next round",
    oneLife
      ? "If your team loses or draws, you are eliminated from the competition"
      : `Everyone has ${rules.lives} lives: each time your team loses or draws you lose one, and you're out when they're all gone`,
    "You can never pick the same team twice in the same competition",
    `Team selection automatically locks ${lockText}`,
    rules.missedPickPolicy === "eliminate"
      ? oneLife
        ? "If you don't pick a team before the deadline, it counts as a losing pick, so you're out"
        : "If you don't pick a team before the deadline, it counts as a losing pick and costs you a life"
      : "If you don't pick a team before the deadline, a random team you haven't used yet is picked for you. Everyone can watch it drawn live on a randomiser wheel 3 minutes after the deadline, and the pick then shows with an orange * badge on its corner",
    "The last player standing wins the entire pot",
    allOutText,
    "If the season ends with multiple players remaining, the pot is split equally",
    "A new competition starts automatically as soon as the previous one ends, and a fresh one opens for GW1 of each new season",
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Last Man Standing Rules</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3 text-sm">
          {items.map((text) => (
            <li key={text} className="flex items-start gap-2">
              <span className="text-primary">•</span>
              <span>
                {text}
                {text === allOutText && rolloverExample && (
                  <span className="mt-2 block rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                    {rolloverExample}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}