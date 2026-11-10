import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { useMatches, useLeaderboard, useAllPredictions } from "@/hooks/useScores";
import { getStatusColor } from "@/lib/utils";
import { Match, LeaderboardEntry, Prediction, Team } from "@/lib/types";
import { TeamCrest } from "@/components/TeamCrest";
import { ArrowUp, ArrowDown, Minus, RotateCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useMemo, useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGroup } from "@/contexts/GroupContext";
import { usePredictionSave } from "@/hooks/usePredictionSave";
import { trackEvent, trackUiEvent } from "@/lib/track";
import { londonStringToUtcMs } from "@shared/time";
import { countOneOffs, countLoneCalls, type FinishedScore } from "@/lib/lawroTendencies";
import { ChevronLeft, ChevronRight, Clock, Lock } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, Legend, ScatterChart, Scatter, LabelList, ReferenceLine,
} from "recharts";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// A match counts as played/finished for scoring and stats once the result is in.
function isFinishedMatch(m: Match): boolean {
  return m.status === "finished" || m.status === "completed";
}

// A compact "Sat 15:00" kickoff label (London time) for fixtures that haven't
// started yet. Includes the weekday on purpose: a PL gameweek runs Fri–Mon, so
// a bare "15:00" can't tell a Saturday kickoff from a Monday one. Falls back to
// the raw time if the stored match_time can't be parsed.
function kickoffLabel(matchTime: string): string {
  const ms = matchTime ? londonStringToUtcMs(matchTime) : NaN;
  if (Number.isNaN(ms)) return matchTime?.split(" ")[1]?.slice(0, 5) ?? "";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/London",
  })
    .format(new Date(ms))
    .replace(",", "");
}

// The progress badge shown under the score: the live minute while in progress
// ("34'", or "LIVE" if the feed hasn't sent a minute yet), "FT" once finished,
// or the kickoff time for fixtures still to play.
function MatchProgress({ match }: { match: Match }) {
  if (match.status === "in_progress") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none text-red-600">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-600" />
        </span>
        {match.minute != null ? `${match.minute}'` : "Live"}
      </span>
    );
  }
  if (isFinishedMatch(match)) {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-emerald-700">
        FT
      </span>
    );
  }
  const kickoff = kickoffLabel(match.matchTime);
  if (!kickoff) return null;
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-[10px] font-medium leading-none text-gray-400">
      <Clock className="h-2.5 w-2.5 shrink-0" />
      {kickoff}
    </span>
  );
}

// Corner badge on a Joker pick (its points are doubled).
function JokerMark() {
  return (
    <span
      className="pointer-events-none absolute right-0.5 top-0.5 rounded-sm bg-amber-400 px-0.5 text-[8px] font-extrabold leading-[10px] text-amber-950"
      title="Joker: points doubled"
      aria-label="Joker"
    >
      2×
    </span>
  );
}

// Move focus to the next editable score box (DOM order = match order), selecting
// its score so typing replaces it. Runs inside the keystroke, so the phone
// keyboard stays open. The last box keeps focus.
function focusNextScoreInput(current: HTMLInputElement | null) {
  if (!current) return;
  const boxes = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-score-input]"));
  const next = boxes[boxes.indexOf(current) + 1];
  if (!next) return;
  next.focus();
  next.select();
}

// Smart single-input score cell: type "2" → auto-inserts "2-", then type "1" → "2-1".
// A complete score jumps to the next match's box, and typing a digit into a full
// score starts a new one, so a pick can be changed without deleting it first.
// Everyone can see everyone's predictions; only the logged-in player's own cells
// are editable, and only until the gameweek deadline.
function PredictionCell({
  userId,
  matchId,
  matchLabel,
  existingPrediction,
  isLocked,
  own,
}: {
  userId: number;
  matchId: number;
  matchLabel: string;
  existingPrediction:
    | { id: number; homeScore?: number; awayScore?: number; status?: string; isAutoPick?: boolean; isLatePick?: boolean; isJoker?: boolean; hidden?: boolean }
    | undefined;
  isLocked: boolean;
  own: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const serverValue = typeof existingPrediction?.homeScore === "number" && typeof existingPrediction?.awayScore === "number"
    ? `${existingPrediction.homeScore}-${existingPrediction.awayScore}` : "";
  const { value, state: saveState, message, change, retry } = usePredictionSave(userId, matchId, serverValue, own);
  const retryButton = own && saveState === "error" ? (
    <button type="button" onClick={retry} className="inline-flex align-middle ml-1 text-red-600"
      data-testid={`pred-retry-${matchId}`} aria-label={`Retry ${matchLabel} prediction`}>
      <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  ) : null;
  const startScore = (digit: string) => {
    change(digit + "-");
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(2, 2));
  };
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value.replace(/[–—]/g, "-").replace(/\s/g, "");
    const native = e.nativeEvent as InputEvent;
    const deleting = native.inputType?.startsWith("delete");
    const typedDigit = !deleting && typeof native.data === "string" && /^\d$/.test(native.data) ? native.data : null;
    if (next === "" || (deleting && value.includes("-") && !next.includes("-"))) {
      change("");
    } else if (/^\d$/.test(next)) {
      startScore(next);
    } else if (/^(\d-\d?)?$/.test(next)) {
      change(next);
      // A finished score moves straight on to the next match's box.
      if (typedDigit && /^\d-\d$/.test(next)) focusNextScoreInput(inputRef.current);
    } else if (typedDigit && /^\d-\d$/.test(value)) {
      // Typing into a full score (caret anywhere) starts a new one.
      startScore(typedDigit);
    }
  };

  // Before the deadline, other players' scorelines are secret. The API still
  // tells us whether a pick exists, so show a (filled) lock for "submitted" and
  // a dash for "not yet" — you can see who's in without seeing their scores.
  // Your own column stays visible/editable; after the deadline everyone's
  // scores are shown.
  if (!isLocked && !own) {
    return (
      <td className="px-2 py-2 border border-border text-center">
        {existingPrediction ? (
          <Lock className="h-3.5 w-3.5 mx-auto text-emerald-500" aria-label="Pick submitted (hidden until the deadline)" />
        ) : (
          <span className="text-gray-300 text-xs" aria-label="No pick yet">–</span>
        )}
      </td>
    );
  }

  const isJoker = !!existingPrediction?.isJoker;
  const jokerCell = isJoker ? "relative bg-amber-50" : "";

  // Read-only badge once the deadline has passed (your own and everyone else's).
  if (isLocked) {
    // Under the "predict until kick-off" rule another player's pick for a match
    // that hasn't kicked off stays hidden past the deadline.
    if (!own && existingPrediction?.hidden) {
      return (
        <td className="px-2 py-2 border border-border text-center">
          <Lock className="h-3.5 w-3.5 mx-auto text-emerald-500" aria-label="Pick submitted (hidden until kick-off)" />
        </td>
      );
    }
    if (!existingPrediction) {
      return (
        <td className="px-2 py-2 border border-border text-center">
          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-800">-</span>
          {retryButton}
        </td>
      );
    }
    const status = existingPrediction.status || "not_started";
    return (
      <td className={`px-2 py-2 border text-center ${jokerCell}`}>
        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${getStatusColor(status)}`}>
          {existingPrediction.homeScore}-{existingPrediction.awayScore}
        </span>
        {isJoker && <JokerMark />}
        {retryButton}
      </td>
    );
  }

  // Your own cell before the deadline: editable.
  return (
    <td className={`px-1 py-1.5 border text-center ${jokerCell}`}>
      {isJoker && <JokerMark />}
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        data-score-input
        data-testid={`pred-input-${matchId}`}
        value={value}
        onChange={handleChange}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            inputRef.current?.blur(); // complete scores already save immediately
          }
        }}
        aria-label={`${matchLabel} prediction`}
        data-save-state={saveState}
        aria-busy={saveState === "saving"}
        aria-description={saveState === "error" ? message : undefined}
        aria-invalid={saveState === "error" || saveState === "incomplete"}
        className={`w-14 h-8 text-center rounded-lg text-sm font-bold tabular-nums focus:outline-none bg-background border ${
          saveState === "error"
            ? "border-red-500 border-2"
            : saveState === "saving"
              ? "border-amber-400"
              : "border-input focus:border-primary focus:ring-2 focus:ring-primary/15"
        }`}
      />
      {retryButton}
    </td>
  );
}

// Live countdown to the gameweek deadline (its first kickoff). Once passed, it
// flips to a locked state and picks lock. Anyone without a pick is simply blank
// for that gameweek.
function DeadlineCountdown({ deadline }: { deadline: Date | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!deadline) return null;
  const diff = deadline.getTime() - now;

  if (diff <= 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-white/90">
        <Lock className="h-3.5 w-3.5" /> Picks locked
      </span>
    );
  }

  const totalSec = Math.floor(diff / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pretty =
    days > 0
      ? `${days}d ${hours}h ${mins}m`
      : hours > 0
        ? `${hours}h ${mins}m ${secs}s`
        : `${mins}m ${secs}s`;

  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-white/90">
      <Clock className="h-3.5 w-3.5" /> Deadline in {pretty}
    </span>
  );
}

type Player = { id: number; username: string };

type JokerPick = { match: Match; pred: Prediction; locked: boolean };

function matchLabel(m: Match): string {
  return `${m.homeTeam?.shortName || m.homeTeam?.name} vs ${m.awayTeam?.shortName || m.awayTeam?.name}`;
}

// The Joker strip above the fixtures grid: one dropdown of the player's own
// predictions this gameweek, and the chosen one scores double. You can move it
// while both the old and new pick are still editable (the server enforces the
// same); after that it just says which pick is your Joker.
function JokerPicker({
  enabled,
  picks,
  canStillPredict,
}: {
  enabled: boolean;
  picks: JokerPick[];
  canStillPredict: boolean;
}) {
  const queryClient = useQueryClient();
  const current = picks.find((p) => p.pred.isJoker);
  const [pending, setPending] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  // Gameweeks played without the rule have no Joker to show.
  if (!enabled && !current) return null;

  const options = picks.filter((p) => !p.locked);
  const canChange = enabled && (!current || !current.locked) && options.length > 0;
  const selectedId = pending !== undefined ? pending : current?.pred.id ?? null;

  async function choose(value: string) {
    const nextId = value === "" ? null : Number(value);
    const targetId = nextId ?? current?.pred.id;
    if (targetId == null || nextId === (current?.pred.id ?? null)) return;
    setPending(nextId);
    setError(null);
    try {
      const res = await fetch(`/api/predictions/${targetId}/joker`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ joker: nextId != null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error || "Couldn't save your Joker. Try again.");
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/predictions"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] }),
      ]);
    } catch {
      setError("Couldn't save your Joker. Try again.");
    } finally {
      setPending(undefined);
    }
  }

  const describe = (p: JokerPick) => `${matchLabel(p.match)} (${p.pred.homeScore}-${p.pred.awayScore})`;

  let body: JSX.Element;
  if (canChange) {
    body = (
      <select
        aria-label="Choose your Joker"
        value={selectedId == null ? "" : String(selectedId)}
        onChange={(e) => choose(e.target.value)}
        disabled={pending !== undefined}
        className={`h-10 w-full rounded-lg border border-input bg-card px-3 text-base sm:w-72 sm:text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-60 ${
          selectedId == null ? "border-amber-400" : "border-gray-300"
        }`}
      >
        <option value="">{current ? "No Joker" : "Choose a match…"}</option>
        {options.map((p) => (
          <option key={p.pred.id} value={p.pred.id}>
            {describe(p)}
          </option>
        ))}
      </select>
    );
  } else if (current) {
    body = <span className="text-sm font-semibold text-gray-800">{describe(current)}</span>;
  } else if (enabled && canStillPredict) {
    body = <span className="text-sm text-gray-600">Make a prediction, then pick one as your Joker.</span>;
  } else {
    body = <span className="text-sm text-gray-500">No Joker this week.</span>;
  }

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <span className="rounded bg-amber-400 px-1.5 py-0.5 text-xs font-extrabold text-amber-950">2×</span>
          <div>
            <p className="text-sm font-semibold text-gray-900">Your Joker</p>
            <p className="text-xs text-gray-600">
              {canChange && !current ? "Pick one prediction to score double this week." : "Its points count double."}
            </p>
          </div>
        </div>
        {body}
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

// ---------- Predictions tab: the fixtures grid + gameweek nav + countdown ----------
function PredictionsTab({
  matches,
  predictions,
  players,
  availableGameweeks,
  currentGameweek,
  userId,
  deadlineMinutesBeforeKickoff = 0,
  lateEntry = false,
  jokerEnabled = false,
}: {
  matches: Match[];
  predictions: Prediction[];
  players: Player[];
  availableGameweeks: number[];
  currentGameweek: number;
  userId: number | undefined;
  // The group's Lawro deadline: this many minutes before the first kick-off.
  deadlineMinutesBeforeKickoff?: number;
  // The group's "predict until kick-off" missed-deadline rule: after the
  // deadline you can still add (and adjust) picks for matches you hadn't
  // predicted, until each one kicks off.
  lateEntry?: boolean;
  // The group's Joker rule: each player doubles the points of one pick a week.
  jokerEnabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedGw, setSelectedGw] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const gameweek = selectedGw ?? currentGameweek;

  const gwIndex = availableGameweeks.indexOf(gameweek);
  const canPrev = gwIndex > 0;
  const canNext = gwIndex >= 0 && gwIndex < availableGameweeks.length - 1;
  const goPrev = () => canPrev && setSelectedGw(availableGameweeks[gwIndex - 1]);
  const goNext = () => canNext && setSelectedGw(availableGameweeks[gwIndex + 1]);

  // Column order: your own column first, then everyone else alphabetically.
  const orderedPlayers = useMemo(() => {
    const mine = players.filter((p) => p.id === userId);
    const others = players
      .filter((p) => p.id !== userId)
      .sort((a, b) => a.username.localeCompare(b.username));
    return [...mine, ...others];
  }, [players, userId]);

  const gwMatches = useMemo(
    () => matches.filter((m) => m.gameweek === gameweek),
    [matches, gameweek],
  );

  const deadline = useMemo(() => {
    if (gwMatches.length === 0) return null;
    // matchTime is a naive London-local string; convert to a real UTC instant so
    // the deadline/countdown is correct regardless of the viewer's timezone.
    const times = gwMatches
      .map((m) => (m.matchTime ? londonStringToUtcMs(m.matchTime) : NaN))
      .filter((t) => !isNaN(t));
    if (times.length === 0) return null;
    // The group may lock picks some minutes before the first kick-off.
    return new Date(Math.min(...times) - deadlineMinutesBeforeKickoff * 60 * 1000);
  }, [gwMatches, deadlineMinutesBeforeKickoff]);

  // The countdown renders independently. Re-evaluate the grid at deadline and
  // kick-off boundaries too, even if polling returns unchanged match data.
  useEffect(() => {
    const boundaries = [deadline?.getTime(), ...gwMatches.map(m => londonStringToUtcMs(m.matchTime))]
      .filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t > now);
    if (!boundaries.length) return;
    const delay = Math.max(1, Math.min(2147483647, Math.min(...boundaries) - Date.now() + 5));
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [deadline, gwMatches, now]);
  const isLocked = deadline ? now >= deadline.getTime() : false;

  // With the "predict until kick-off" rule, your own cell for a match that
  // hasn't kicked off stays open after the deadline if you had no pick for it
  // (or your pick for it was itself made late). The server enforces the same.
  const ownCellLocked = (match: Match, existing: { isLatePick?: boolean } | undefined) => {
    if (!isLocked) return false;
    if (!lateEntry) return true;
    const kickoff = match.matchTime ? londonStringToUtcMs(match.matchTime) : NaN;
    if (Number.isNaN(kickoff) || now >= kickoff) return true;
    return !!existing && !existing.isLatePick;
  };
  const lateEntryAvailable =
    lateEntry &&
    isLocked &&
    gwMatches.some((m) => {
      const kickoff = m.matchTime ? londonStringToUtcMs(m.matchTime) : NaN;
      return !Number.isNaN(kickoff) && now < kickoff;
    });

  const hasLive = useMemo(() => gwMatches.some((m) => m.status === "in_progress"), [gwMatches]);
  useEffect(() => {
    if (!hasLive) return;
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/predictions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
    }, 10000);
    return () => clearInterval(interval);
  }, [hasLive, queryClient]);

  const matchPredictions = useMemo(() => {
    const grouped = new Map<number, { match: Match; userPredictions: Map<number, any> }>();
    for (const match of gwMatches) grouped.set(match.id, { match, userPredictions: new Map() });
    for (const pred of predictions) {
      if (grouped.has(pred.matchId)) grouped.get(pred.matchId)!.userPredictions.set(pred.userId, pred);
    }
    return Array.from(grouped.values()).sort((a, b) => {
      const ta = a.match.matchTime ? londonStringToUtcMs(a.match.matchTime) : 0;
      const tb = b.match.matchTime ? londonStringToUtcMs(b.match.matchTime) : 0;
      return (ta || 0) - (tb || 0) || a.match.id - b.match.id;
    });
  }, [gwMatches, predictions]);

  // Your own pick for a match this gameweek, if any.
  const md = (matchId: number) =>
    userId == null ? undefined : matchPredictions.find((x) => x.match.id === matchId)?.userPredictions.get(userId);

  // Once the deadline has passed, flip the grid so each match is a column:
  // easier to compare everyone's pick for one game. Late-entry cells under
  // "predict until kick-off" stay editable inside the flipped grid.
  const matchesAsColumns = isLocked;

  const nav = (
    <div className="flex items-center gap-2">
      <button type="button" onClick={goPrev} disabled={!canPrev} aria-label="Previous gameweek"
        className="p-1 rounded hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-transparent">
        <ChevronLeft className="h-5 w-5" />
      </button>
      <span className="text-sm font-medium w-14 text-center">GW{gameweek}</span>
      <button type="button" onClick={goNext} disabled={!canNext} aria-label="Next gameweek"
        className="p-1 rounded hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-transparent">
        <ChevronRight className="h-5 w-5" />
      </button>
    </div>
  );

  return (
    <section className="bg-card rounded-2xl border border-border/80 shadow-card overflow-hidden">
      <div className="bg-primary text-white px-4 py-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display flex items-center gap-1.5 text-[26px] font-bold leading-tight">GW{gameweek} Predictions{isLocked && <Lock className="h-5 w-5 opacity-80" aria-label="Locked" />}</h2>
          {nav}
        </div>
        <div className="mt-1">
          <DeadlineCountdown deadline={deadline} />
          {lateEntryAvailable && (
            <p className="mt-1 text-xs text-white/90">
              Missed the deadline? You can still predict any match that hasn't kicked off.
            </p>
          )}
        </div>
      </div>

      {gwMatches.length > 0 && userId != null && (
        <JokerPicker
          key={gameweek}
          enabled={jokerEnabled}
          picks={matchPredictions.flatMap(({ match, userPredictions }) => {
            const pred = userPredictions.get(userId);
            if (!pred || typeof pred.homeScore !== "number" || typeof pred.awayScore !== "number") return [];
            return [{ match, pred, locked: ownCellLocked(match, pred) }];
          })}
          canStillPredict={gwMatches.some((m) => !ownCellLocked(m, md(m.id)))}
        />
      )}

      {gwMatches.length === 0 ? (
        <p className="p-4 text-sm text-gray-500">No fixtures for this gameweek yet.</p>
      ) : (
        // Side padding sits outside the scroller: padding on the scroller itself
        // would leave a strip left of the sticky first column where scrolled
        // cells peek through.
        <div className="px-2 md:px-4">
        <div className="overflow-x-auto py-2 md:py-4">
          {matchesAsColumns ? (
            // The round is live: one column per match, one row per player, so
            // everyone's pick for a game reads down a single column.
            <table data-testid="lawro-grid" data-layout="matches-as-columns" className="w-full border border-border">
              <thead className="bg-muted/60">
                <tr>
                  <th className="px-3 py-2 border border-border text-left text-xs font-medium text-muted-foreground uppercase tracking-wider sticky left-0 bg-muted z-20 w-24">Player</th>
                  {matchPredictions.map(({ match }) => (
                    <th key={match.id} scope="col" className="w-16 px-1.5 py-1.5 border border-border text-center align-top"
                      title={`${match.homeTeam?.name ?? "Home"} vs ${match.awayTeam?.name ?? "Away"}`}>
                      <div className="flex flex-col items-center gap-0.5">
                        <span className="text-[11px] font-semibold leading-tight text-foreground">{match.homeTeam?.shortName || match.homeTeam?.name}</span>
                        <span className="text-[11px] font-semibold leading-tight text-foreground">{match.awayTeam?.shortName || match.awayTeam?.name}</span>
                        {match.status !== "not_started" && match.homeScore != null && match.awayScore != null && (
                          <span className="text-sm font-bold text-foreground">{match.homeScore} - {match.awayScore}</span>
                        )}
                        <MatchProgress match={match} />
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {orderedPlayers.map((player, i) => (
                  <tr key={player.id} className={i % 2 === 0 ? "bg-card" : "bg-muted/40"}>
                    <th scope="row" className={`px-3 py-2 border border-border text-left text-xs font-medium whitespace-nowrap sticky left-0 z-10 bg-card ${i % 2 === 0 ? "" : "bg-[linear-gradient(hsl(var(--muted)/0.4),hsl(var(--muted)/0.4))]"}`}>
                      <span className="flex items-center gap-0.5">
                        <span className="max-w-[7rem] truncate" title={player.username}>{player.username}</span>
                        {player.id === userId && <span className="shrink-0 text-primary" title="You">•</span>}
                      </span>
                    </th>
                    {matchPredictions.map(({ match, userPredictions }) => {
                      const existing = userPredictions.get(player.id);
                      const own = player.id === userId;
                      return (
                        <PredictionCell
                          key={match.id}
                          userId={player.id}
                          matchId={match.id}
                          matchLabel={`${match.homeTeam?.name ?? "Home"} vs ${match.awayTeam?.name ?? "Away"}`}
                          existingPrediction={existing}
                          isLocked={own ? ownCellLocked(match, existing) : isLocked}
                          own={own}
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
          <table data-testid="lawro-grid" data-layout="matches-as-rows" className="w-full border border-border">
            <thead className="bg-muted/60">
              <tr>
                <th className="px-3 py-2 border border-border text-left text-xs font-medium text-muted-foreground uppercase tracking-wider sticky left-0 bg-muted z-20">Match</th>
                <th className="px-3 py-2 border border-border text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">Score</th>
                {orderedPlayers.map((p) => (
                  // Fixed width + truncation so every player's column is the same
                  // width regardless of how long their name is.
                  <th key={p.id} className="w-16 px-2 py-2 border text-center text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    <span className="flex items-center justify-center gap-0.5">
                      <span className="min-w-0 truncate" title={p.username}>{p.username}</span>
                      {p.id === userId && <span className="shrink-0 text-primary" title="Your column (editable)">•</span>}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {matchPredictions.map((md, i) => {
                const match = md.match;
                return (
                  <tr key={match.id} className={i % 2 === 0 ? "bg-card" : "bg-muted/40"}>
                    <td className={`px-3 py-2 border border-border text-xs font-medium whitespace-nowrap sticky left-0 z-10 bg-card ${i % 2 === 0 ? "" : "bg-[linear-gradient(hsl(var(--muted)/0.4),hsl(var(--muted)/0.4))]"}`}>
                      {match.homeTeam?.shortName || match.homeTeam?.name} vs {match.awayTeam?.shortName || match.awayTeam?.name}
                    </td>
                    <td className="px-3 py-2 border border-border text-center">
                      <div className="flex flex-col items-center gap-0.5">
                        {match.status !== "not_started" && match.homeScore != null && match.awayScore != null && (
                          <span className="text-sm font-bold">{match.homeScore} - {match.awayScore}</span>
                        )}
                        <MatchProgress match={match} />
                      </div>
                    </td>
                    {orderedPlayers.map((player) => {
                      const existing = md.userPredictions.get(player.id);
                      const own = player.id === userId;
                      return (
                        <PredictionCell
                          key={player.id}
                          userId={player.id}
                          matchId={match.id}
                          matchLabel={`${match.homeTeam?.name ?? "Home"} vs ${match.awayTeam?.name ?? "Away"}`}
                          existingPrediction={existing}
                          isLocked={own ? ownCellLocked(match, existing) : isLocked}
                          own={own}
                        />
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          )}
        </div>
        </div>
      )}
    </section>
  );
}

// A group's Lawro point values. Defaults to the classic 3 (exact) / 1 (result).
export type LawroPoints = { exact: number; result: number };
const DEFAULT_LAWRO_POINTS: LawroPoints = { exact: 3, result: 1 };

// Points one prediction scored. The server works these out with the rules of
// the prediction's own gameweek (an admin's edit only applies from the next
// open gameweek), so prefer its figure; the group's current values are only a
// fallback for a prediction that arrived without one.
function predictionPoints(p: Prediction, points: LawroPoints = DEFAULT_LAWRO_POINTS): number {
  if (p.status !== "exact_score" && p.status !== "correct_result") return 0;
  if (typeof p.points === "number") return p.points;
  return p.status === "exact_score" ? points.exact : points.result;
}

// Points a player scored on a set of predictions (already filtered to a scope).
function tallyPoints(preds: Prediction[], points: LawroPoints = DEFAULT_LAWRO_POINTS) {
  let exactScores = 0;
  let correctResults = 0;
  let totalPoints = 0;
  for (const p of preds) {
    if (p.status === "exact_score") exactScores += 1;
    else if (p.status === "correct_result") correctResults += 1;
    totalPoints += predictionPoints(p, points);
  }
  return { exactScores, correctResults, totalPoints };
}

// Leaderboard tiebreak order: total points, then exact scores, then correct
// results (all highest first), then username alphabetically. Kept in one place
// so the season and per-gameweek tables rank identically to the server.
function compareStandings(
  a: { totalPoints: number; exactScores: number; correctResults: number; username: string },
  b: { totalPoints: number; exactScores: number; correctResults: number; username: string },
): number {
  return (
    b.totalPoints - a.totalPoints ||
    b.exactScores - a.exactScores ||
    b.correctResults - a.correctResults ||
    (a.username || "").localeCompare(b.username || "")
  );
}

// Some players have money riding on the season; the rest play for bragging
// rights. Matched case-insensitively on username (trimmed) so the leaderboard
// can flag who's playing for cash.
const MONEY_PLAYERS = new Set(["alex", "blake", "devon m", "casey", "drew", "sawyer"]);
const isMoneyPlayer = (username: string) =>
  MONEY_PLAYERS.has((username || "").trim().toLowerCase());

// Places gained (green ▲) or lost (red ▼) this week on the season leaderboard;
// a grey dash when unchanged. Renders nothing when there's no comparison.
function PlaceMovement({ change }: { change: number | undefined }) {
  if (change == null) return null;
  if (change === 0) {
    return (
      <span className="inline-flex w-7 items-center text-gray-400" title="No change this week" aria-label="No change this week">
        <Minus className="h-3 w-3" />
      </span>
    );
  }
  const up = change > 0;
  const label = `${up ? "Up" : "Down"} ${Math.abs(change)} this week`;
  return (
    <span
      className={`inline-flex w-7 items-center gap-0.5 text-xs font-semibold tabular-nums ${up ? "text-green-600" : "text-red-600"}`}
      title={label}
      aria-label={label}
    >
      {up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      {Math.abs(change)}
    </span>
  );
}

// ---------- Leaderboard tab: one section, Season total (default) or a gameweek ----------
function LeaderboardTab({
  players,
  predictions,
  matches,
  availableGameweeks,
  currentGameweek,
  seasonStandings,
  userId,
  points,
}: {
  players: Player[];
  predictions: Prediction[];
  matches: Match[];
  availableGameweeks: number[];
  currentGameweek: number;
  seasonStandings: LeaderboardEntry[];
  userId: number | undefined;
  points: LawroPoints;
}) {
  // "season" (default) or a specific gameweek number.
  const [scope, setScope] = useState<"season" | number>("season");

  // Only offer gameweeks that have already happened or are the active one —
  // never future gameweeks. currentGameweek is the active week, so gw <= it.
  const selectableGameweeks = useMemo(
    () => availableGameweeks.filter((gw) => gw <= currentGameweek),
    [availableGameweeks, currentGameweek],
  );

  const rows: LeaderboardEntry[] = useMemo(() => {
    if (scope === "season") return seasonStandings;
    const matchIds = new Set(matches.filter((m) => m.gameweek === scope).map((m) => m.id));
    const byUser = new Map<number, Prediction[]>();
    for (const pred of predictions) {
      if (!matchIds.has(pred.matchId)) continue;
      const list = byUser.get(pred.userId) ?? [];
      list.push(pred);
      byUser.set(pred.userId, list);
    }
    return players
      .map((p) => {
        const t = tallyPoints(byUser.get(p.id) ?? [], points);
        return { id: p.id, username: p.username, predictions: [], ...t };
      })
      .sort(compareStandings);
  }, [scope, seasonStandings, players, predictions, matches, points]);

  // Season places gained/lost in the latest gameweek that has a result in:
  // each player's place before that gameweek vs. after it. Both are tallied
  // here with the same tiebreaks so they compare like for like. Empty (no
  // arrows) for a single gameweek or before a second gameweek has been played.
  const movement = useMemo(() => {
    const moves = new Map<number, number>();
    if (scope !== "season") return moves;
    const playedGameweeks = matches.filter(isFinishedMatch).map((m) => m.gameweek);
    if (playedGameweeks.length === 0) return moves;
    const latest = Math.max(...playedGameweeks);
    if (!playedGameweeks.some((gw) => gw < latest)) return moves;
    const gameweekOf = new Map(matches.map((m) => [m.id, m.gameweek]));
    const placesUpTo = (lastGameweek: number) => {
      const byUser = new Map<number, Prediction[]>();
      for (const pred of predictions) {
        const gw = gameweekOf.get(pred.matchId);
        if (gw == null || gw > lastGameweek) continue;
        const list = byUser.get(pred.userId) ?? [];
        list.push(pred);
        byUser.set(pred.userId, list);
      }
      const order = players
        .map((p) => ({ id: p.id, username: p.username, ...tallyPoints(byUser.get(p.id) ?? [], points) }))
        .sort(compareStandings);
      return new Map(order.map((r, i) => [r.id, i]));
    };
    const before = placesUpTo(latest - 1);
    const after = placesUpTo(latest);
    for (const [id, place] of Array.from(after)) {
      const prev = before.get(id);
      if (prev != null) moves.set(id, prev - place);
    }
    return moves;
  }, [scope, players, predictions, matches, points]);

  return (
    <div className="space-y-6">
    <section className="bg-card rounded-2xl border border-border/80 shadow-card overflow-hidden">
      <div className="bg-primary text-white px-4 py-4 flex items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-[26px] font-bold leading-tight">Leaderboard</h2>
          <p className="text-sm text-white/80">
            {scope === "season" ? "Total points across the season." : `Gameweek ${scope} only.`}
          </p>
        </div>
        <select
          value={String(scope)}
          onChange={(e) => setScope(e.target.value === "season" ? "season" : Number(e.target.value))}
          className="h-9 rounded-full bg-white/10 border border-white/20 text-white text-sm font-medium px-3 focus:outline-none"
        >
          <option className="text-gray-900" value="season">Season total</option>
          {selectableGameweeks.map((gw) => (
            <option className="text-gray-900" key={gw} value={gw}>GW{gw}</option>
          ))}
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-muted/60 border-b">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">#</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
              <th className="px-2 py-2 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider"><div>Exact</div><div>Score</div></th>
              <th className="px-2 py-2 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider"><div>Correct</div><div>Result</div></th>
              <th className="px-2 py-2 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider"><div>Total</div><div>Points</div></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-card">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-sm text-gray-500 text-center">
                  No players yet — add them from the admin players page.
                </td>
              </tr>
            ) : (
              rows.map((player, i) => {
                const isMe = player.id === userId;
                return (
                <tr
                  key={player.id}
                  className={`${isMe ? "bg-primary/[0.06]" : "bg-card"}`}
                >
                  <td className="px-3 py-3 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span className="w-5 font-display text-lg font-bold text-muted-foreground tabular-nums">{i + 1}</span>
                      <PlaceMovement change={movement.get(player.id)} />
                    </div>
                  </td>
                  <td className={`px-3 py-3 whitespace-nowrap text-sm font-medium ${isMe ? "text-primary" : ""}`}>
                    <span className="inline-flex items-center gap-1.5">
                      {player.username}
                      {isMoneyPlayer(player.username) && (
                        <span
                          className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-green-100 text-[11px] font-bold leading-none text-green-700"
                          title="Playing for money"
                          aria-label="Playing for money"
                        >
                          £
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-2 py-3 whitespace-nowrap text-sm text-center text-gray-500">{player.exactScores}</td>
                  <td className="px-2 py-3 whitespace-nowrap text-sm text-center text-gray-500">{player.correctResults}</td>
                  <td className="px-2 py-3 whitespace-nowrap font-display text-xl text-center font-bold text-primary tabular-nums">{player.totalPoints}</td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="border-t bg-gray-50 px-3 py-2 text-xs text-gray-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-green-100 text-[11px] font-bold leading-none text-green-700">
            £
          </span>
          Playing for money
        </span>
      </div>
    </section>
    <ScoringGuide />
    </div>
  );
}

// Scoring explanation, shown under the leaderboard.
function ScoringGuide() {
  return (
    <section className="bg-card rounded-2xl border border-border/80 shadow-card overflow-hidden">
      <div className="bg-primary text-white px-4 py-4">
        <h2 className="font-display text-[26px] font-bold leading-tight">Scoring Guide</h2>
      </div>
      <div className="p-4 flex flex-col md:flex-row md:space-x-10">
        <div className="flex items-start mb-4 md:mb-0">
          <svg width="40" height="40" viewBox="0 0 40 40" className="mr-3 flex-shrink-0">
            <circle cx="20" cy="20" r="20" fill="#22c55e" />
            <text x="20" y="25" fill="white" textAnchor="middle" fontFamily="system-ui" fontSize="18" fontWeight="bold">3</text>
          </svg>
          <div>
            <h3 className="font-semibold text-lg">Exact Score</h3>
            <p className="text-gray-600 text-sm">Predicted the exact final score</p>
          </div>
        </div>
        <div className="flex items-start mb-4 md:mb-0">
          <svg width="40" height="40" viewBox="0 0 40 40" className="mr-3 flex-shrink-0">
            <circle cx="20" cy="20" r="20" fill="#f97316" />
            <text x="20" y="25" fill="white" textAnchor="middle" fontFamily="system-ui" fontSize="18" fontWeight="bold">1</text>
          </svg>
          <div>
            <h3 className="font-semibold text-lg">Correct Result</h3>
            <p className="text-gray-600 text-sm">Correct outcome but not exact score</p>
          </div>
        </div>
        <div className="flex items-start">
          <svg width="40" height="40" viewBox="0 0 40 40" className="mr-3 flex-shrink-0">
            <circle cx="20" cy="20" r="20" fill="#ef4444" />
            <text x="20" y="25" fill="white" textAnchor="middle" fontFamily="system-ui" fontSize="18" fontWeight="bold">0</text>
          </svg>
          <div>
            <h3 className="font-semibold text-lg">Incorrect Result</h3>
            <p className="text-gray-600 text-sm">Wrong outcome predicted</p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- Tendencies tab: how each player tends to predict ----------
// Charts-only view over each player's REVEALED predictions (own picks always,
// others only after their gameweek deadline — redacted `hidden` picks carry no
// scoreline and are skipped).
type TendencyRow = {
  id: number;
  username: string;
  n: number; // revealed picks
  homePct: number;
  drawPct: number;
  awayPct: number;
  avgGoals: number;
  over25Pct: number;
  cleanSheetPct: number;
  bigWinPct: number;
  // Averages over the subset of the player's picks whose match has finished.
  nFinished: number;
  predAvgGoalsF: number | null;
  actualAvgGoalsF: number | null;
  homePredF: number | null;
  homeRealF: number | null;
  awayPredF: number | null;
  awayRealF: number | null;
};

// Round three shares (summing to 1) to whole percentages that sum to exactly
// 100, using largest-remainder rounding, so stacked 100% bars all line up.
function splitTo100(parts: [number, number, number]): [number, number, number] {
  const raw = parts.map((p) => p * 100);
  const out = raw.map(Math.floor);
  const total = raw.reduce((a, b) => a + b, 0);
  if (total === 0) return [0, 0, 0];
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k].i] += 1;
  return [out[0], out[1], out[2]];
}

const ACTUAL_LABEL = "Actual";

// Title of the chart counting matches a player was the only one to call.
const LONE_CALLS_TITLE = "Only One Who Saw It";

// On-brand chart colours (see index.css tokens).
const TC = {
  purple: "hsl(var(--chart-1))", // brand purple; lifts to violet in dark mode
  lightPurple: "hsl(var(--chart-3))",
  green: "hsl(var(--secondary))",
  lightGreen: "#86efac",
  gray: "#9ca3af",
  amber: "#f59e0b",
};

function TendenciesTab({
  players,
  predictions,
  matches,
  points,
}: {
  players: Player[];
  predictions: Prediction[];
  matches: Match[];
  points: LawroPoints;
}) {
  const matchById = useMemo(() => {
    const m = new Map<number, Match>();
    for (const mm of matches) m.set(mm.id, mm);
    return m;
  }, [matches]);

  const rows = useMemo<TendencyRow[]>(() => {
    const byUser = new Map<number, {
      n: number; home: number; draw: number; away: number; goals: number;
      over: number; clean: number; big: number;
      fN: number; fPredGoals: number; fActGoals: number;
      fHomePred: number; fHomeReal: number; fAwayPred: number; fAwayReal: number;
    }>();
    for (const p of players) {
      byUser.set(p.id, { n: 0, home: 0, draw: 0, away: 0, goals: 0, over: 0, clean: 0, big: 0, fN: 0, fPredGoals: 0, fActGoals: 0, fHomePred: 0, fHomeReal: 0, fAwayPred: 0, fAwayReal: 0 });
    }
    for (const pred of predictions) {
      if (pred.hidden) continue; // another player's pre-deadline pick — no scoreline
      const H = pred.homeScore, A = pred.awayScore;
      if (H == null || A == null) continue;
      const s = byUser.get(pred.userId);
      if (!s) continue;
      s.n += 1;
      if (H > A) s.home += 1; else if (H < A) s.away += 1; else s.draw += 1;
      s.goals += H + A;
      if (H + A >= 3) s.over += 1;
      if (H === 0 || A === 0) s.clean += 1;
      if (Math.abs(H - A) >= 3) s.big += 1;
      const m = matchById.get(pred.matchId);
      if (m && isFinishedMatch(m) && m.homeScore != null && m.awayScore != null) {
        s.fN += 1;
        s.fPredGoals += H + A;
        s.fActGoals += m.homeScore + m.awayScore;
        s.fHomePred += H; s.fHomeReal += m.homeScore;
        s.fAwayPred += A; s.fAwayReal += m.awayScore;
      }
    }
    return players
      .map((p) => {
        const s = byUser.get(p.id)!;
        const n = s.n;
        const div = (x: number) => (n ? x / n : 0);
        const favg = (x: number) => (s.fN ? x / s.fN : null);
        return {
          id: p.id, username: p.username, n,
          homePct: div(s.home), drawPct: div(s.draw), awayPct: div(s.away),
          avgGoals: n ? s.goals / n : 0,
          over25Pct: div(s.over), cleanSheetPct: div(s.clean), bigWinPct: div(s.big),
          nFinished: s.fN,
          predAvgGoalsF: favg(s.fPredGoals),
          actualAvgGoalsF: favg(s.fActGoals),
          homePredF: favg(s.fHomePred),
          homeRealF: favg(s.fHomeReal),
          awayPredF: favg(s.fAwayPred),
          awayRealF: favg(s.fAwayReal),
        };
      })
      .filter((r) => r.n > 0);
  }, [players, predictions, matchById]);

  // Per-gameweek points (best / avg / worst) — only fully-completed gameweeks,
  // computed from the server-set `status` like the Stats tab.
  const weekly = useMemo(() => {
    const byGw = new Map<number, Match[]>();
    for (const m of matches) {
      if (m.gameweek == null) continue;
      const a = byGw.get(m.gameweek) ?? [];
      a.push(m);
      byGw.set(m.gameweek, a);
    }
    const completed = Array.from(byGw.entries())
      .filter(([, ms]) => ms.length > 0 && ms.every(isFinishedMatch))
      .map(([gw]) => gw);
    const completedSet = new Set(completed);
    const matchGw = new Map<number, number>();
    for (const m of matches) if (m.gameweek != null && isFinishedMatch(m)) matchGw.set(m.id, m.gameweek);

    const perUser = new Map<number, Map<number, number>>();
    for (const p of players) perUser.set(p.id, new Map());
    for (const pred of predictions) {
      const gw = matchGw.get(pred.matchId);
      if (gw == null || !completedSet.has(gw)) continue;
      const pts = predictionPoints(pred, points);
      const um = perUser.get(pred.userId);
      if (!um) continue;
      um.set(gw, (um.get(gw) ?? 0) + pts);
    }
    const active = new Set(rows.map((r) => r.id));
    const data = players
      .filter((p) => active.has(p.id))
      .map((p) => {
        const um = perUser.get(p.id)!;
        let total = 0, best = 0, worst: number | null = null;
        for (const gw of completed) {
          const v = um.get(gw) ?? 0;
          total += v;
          if (v > best) best = v;
          if (worst == null || v < worst) worst = v;
        }
        return { name: p.username, avg: completed.length ? Number((total / completed.length).toFixed(1)) : 0, best, worst: worst ?? 0 };
      });
    return { weeks: completed.length, data };
  }, [players, predictions, matches, rows, points]);

  // Droughts: per player, the longest run of consecutive predictions (finished
  // matches only, in kickoff order) without an exact score, plus the run they're
  // on now. Matches a player didn't predict are skipped rather than breaking or
  // extending the run, so it counts their own picks only.
  const droughts = useMemo(() => {
    const order = (m: Match) => {
      const t = m.matchTime ? londonStringToUtcMs(m.matchTime) : NaN;
      return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
    };
    const finished = matches
      .filter((m) => isFinishedMatch(m))
      .sort((a, b) => (a.gameweek ?? 0) - (b.gameweek ?? 0) || order(a) - order(b) || a.id - b.id);
    const picksByUser = new Map<number, Map<number, Prediction>>();
    for (const pred of predictions) {
      let um = picksByUser.get(pred.userId);
      if (!um) { um = new Map(); picksByUser.set(pred.userId, um); }
      um.set(pred.matchId, pred);
    }
    const active = new Set(rows.map((r) => r.id));
    const data = players
      .filter((p) => active.has(p.id))
      .map((p) => {
        const um = picksByUser.get(p.id);
        let run = 0, runStart: number | null = null;
        let longest = 0, longestFrom: number | null = null, longestTo: number | null = null;
        let lastGw: number | null = null;
        for (const m of finished) {
          const pred = um?.get(m.id);
          if (!pred) continue;
          if (pred.status === "exact_score") { run = 0; runStart = null; continue; }
          if (run === 0) runStart = m.gameweek ?? null;
          run += 1;
          lastGw = m.gameweek ?? null;
          if (run > longest) { longest = run; longestFrom = runStart; longestTo = lastGw; }
        }
        return { name: p.username, longest, current: run, longestFrom, longestTo, currentFrom: run > 0 ? runStart : null };
      })
      .filter((d) => d.longest > 0 || d.current > 0);
    return data;
  }, [players, predictions, matches, rows]);

  // One-offs and lone calls are counted over finished matches with a result.
  const finishedScores = useMemo<FinishedScore[]>(
    () => matches
      .filter((m) => isFinishedMatch(m) && m.homeScore != null && m.awayScore != null)
      .map((m) => ({ matchId: m.id, homeScore: m.homeScore!, awayScore: m.awayScore! })),
    [matches],
  );

  // One-offs: picks where one score was right and the other missed by one goal.
  const oneOffData = useMemo(() => {
    const counts = countOneOffs(predictions, finishedScores);
    const active = new Set(rows.map((r) => r.id));
    const data = players
      .filter((p) => active.has(p.id))
      .map((p) => ({ name: p.username, oneOffs: counts.get(p.id) ?? 0 }))
      .sort((a, b) => b.oneOffs - a.oneOffs || a.name.localeCompare(b.name));
    return data.some((d) => d.oneOffs > 0) ? data : [];
  }, [players, predictions, finishedScores, rows]);

  // Lone calls: matches where a player was the only one with the right result,
  // or the only one with the exact score.
  const loneData = useMemo(() => {
    const counts = countLoneCalls(predictions, finishedScores);
    const active = new Set(rows.map((r) => r.id));
    const data = players
      .filter((p) => active.has(p.id))
      .map((p) => {
        const c = counts.get(p.id);
        return { name: p.username, exact: c?.exact ?? 0, result: c?.result ?? 0, total: c?.total ?? 0 };
      })
      .sort((a, b) => b.total - a.total || b.exact - a.exact || a.name.localeCompare(b.name));
    return data.some((d) => d.total > 0) ? data : [];
  }, [players, predictions, finishedScores, rows]);

  // Group-wide most-common predicted scorelines (top 10), split into exactly-right
  // (status "exact_score") vs the rest so the bars can carry a green correct fill.
  const scorelineData = useMemo(() => {
    const counts = new Map<string, { total: number; correct: number }>();
    for (const p of predictions) {
      if (p.hidden || p.homeScore == null || p.awayScore == null) continue;
      const key = `${p.homeScore}-${p.awayScore}`;
      const s = counts.get(key) ?? { total: 0, correct: 0 };
      s.total += 1;
      if (p.status === "exact_score") s.correct += 1;
      counts.set(key, s);
    }
    return Array.from(counts.entries())
      .map(([scoreline, s]) => ({ scoreline, count: s.total, correct: s.correct, incorrect: s.total - s.correct }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [predictions]);

  // Actual home/away goal averages across every finished match — a single fixed
  // benchmark drawn as horizontal reference lines on the goals chart (instead of
  // duplicating the same "real" bars for every player).
  const realAvg = useMemo(() => {
    let n = 0, home = 0, away = 0;
    for (const m of matches) {
      if (isFinishedMatch(m) && m.homeScore != null && m.awayScore != null) {
        n += 1;
        home += m.homeScore;
        away += m.awayScore;
      }
    }
    return n ? { home: home / n, away: away / n } : null;
  }, [matches]);

  // Actual home win / draw / away win split across finished matches — shown as
  // an "Actual" row atop the outcome-lean chart so every player's bar can be
  // read against reality.
  const realOutcome = useMemo(() => {
    let n = 0, home = 0, draw = 0, away = 0;
    for (const m of matches) {
      if (isFinishedMatch(m) && m.homeScore != null && m.awayScore != null) {
        n += 1;
        if (m.homeScore > m.awayScore) home += 1;
        else if (m.homeScore < m.awayScore) away += 1;
        else draw += 1;
      }
    }
    if (!n) return null;
    const [Home, Draw, Away] = splitTo100([home / n, draw / n, away / n]);
    return { Home, Draw, Away, n };
  }, [matches]);

  // Actual rate of each predicting-style stat across finished matches (as a % of
  // matches), drawn as a horizontal reference line on the predicting-style chart
  // so each player's prediction rate can be read against reality. Definitions
  // mirror the per-player stats: over 2.5 = 3+ total goals, clean sheet = either
  // side kept out, big win = 3+ goal margin.
  const realStyle = useMemo(() => {
    let n = 0, over = 0, clean = 0, big = 0;
    for (const m of matches) {
      if (isFinishedMatch(m) && m.homeScore != null && m.awayScore != null) {
        n += 1;
        if (m.homeScore + m.awayScore >= 3) over += 1;
        if (m.homeScore === 0 || m.awayScore === 0) clean += 1;
        if (Math.abs(m.homeScore - m.awayScore) >= 3) big += 1;
      }
    }
    return n ? { over: (over / n) * 100, clean: (clean / n) * 100, big: (big / n) * 100 } : null;
  }, [matches]);

  // Per-player predicted-scoreline counts (top 10 each) for the player-selectable
  // scoreline chart. Each scoreline tracks total picks and how many were exactly
  // right (status "exact_score", set once the match finishes) so the bar can be
  // split into a correct (green) and remaining (navy) portion.
  const scorelinesByPlayer = useMemo(() => {
    const byUser = new Map<number, Map<string, { total: number; correct: number }>>();
    for (const p of predictions) {
      if (p.hidden || p.homeScore == null || p.awayScore == null) continue;
      let m = byUser.get(p.userId);
      if (!m) { m = new Map(); byUser.set(p.userId, m); }
      const key = `${p.homeScore}-${p.awayScore}`;
      const s = m.get(key) ?? { total: 0, correct: 0 };
      s.total += 1;
      if (p.status === "exact_score") s.correct += 1;
      m.set(key, s);
    }
    const out = new Map<number, { scoreline: string; count: number; correct: number; incorrect: number }[]>();
    for (const [uid, m] of Array.from(byUser.entries())) {
      out.set(uid, Array.from(m.entries())
        .map(([scoreline, s]) => ({ scoreline, count: s.total, correct: s.correct, incorrect: s.total - s.correct }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10));
    }
    return out;
  }, [predictions]);

  // One entry per player (alphabetical) — consistent x-order across the charts.
  const perPlayer = useMemo(
    () => rows.map((r) => ({
      name: r.username,
      ...(() => {
        const [Home, Draw, Away] = splitTo100([r.homePct, r.drawPct, r.awayPct]);
        return { Home, Draw, Away };
      })(),
      over: Math.round(r.over25Pct * 100),
      clean: Math.round(r.cleanSheetPct * 100),
      big: Math.round(r.bigWinPct * 100),
      avg: Number(r.avgGoals.toFixed(2)),
      drawRate: Math.round(r.drawPct * 100),
    })),
    [rows],
  );

  // Outcome-lean rows: the actual split (when any game has finished) on top.
  const outcomeData = useMemo(
    () => (realOutcome
      ? [{ name: ACTUAL_LABEL, Home: realOutcome.Home, Draw: realOutcome.Draw, Away: realOutcome.Away }, ...perPlayer]
      : perPlayer),
    [realOutcome, perPlayer],
  );

  const goalsData = useMemo(
    () => rows
      .filter((r) => r.homePredF != null)
      .map((r) => ({
        name: r.username,
        homePred: Number(r.homePredF!.toFixed(2)),
        awayPred: Number(r.awayPredF!.toFixed(2)),
      })),
    [rows],
  );

  // Combined scorelines chart: "everyone" (group-wide) by default, or a specific
  // player selected from the dropdown.
  const [scorelineView, setScorelineView] = useState<string>("everyone");
  const activeScorelineData = scorelineView === "everyone"
    ? scorelineData
    : (scorelinesByPlayer.get(Number(scorelineView)) ?? []);

  // Predicting-style chart: one stat at a time, defaulting to Over 2.5.
  const [styleMetric, setStyleMetric] = useState<"over" | "clean" | "big">("over");
  const styleMetricMeta: Record<typeof styleMetric, { label: string; color: string }> = {
    over: { label: "Over 2.5", color: TC.purple },
    clean: { label: "Clean sheet", color: TC.amber },
    big: { label: "Big win (3+)", color: TC.green },
  };

  // Weekly points chart: one metric at a time, defaulting to each player's average.
  const [weeklyMetric, setWeeklyMetric] = useState<"avg" | "best" | "worst">("avg");
  const weeklyMetricMeta: Record<typeof weeklyMetric, { label: string; color: string }> = {
    avg: { label: "Average", color: TC.purple },
    best: { label: "Best", color: TC.green },
    worst: { label: "Worst", color: TC.gray },
  };

  // Drought chart: longest ever (default) or the run each player is on now.
  const [droughtMetric, setDroughtMetric] = useState<"longest" | "current">("longest");
  const droughtMetricMeta: Record<typeof droughtMetric, { label: string; color: string }> = {
    longest: { label: "Longest", color: TC.amber },
    current: { label: "Current", color: TC.gray },
  };
  const droughtData = useMemo(
    () => [...droughts].sort((a, b) => b[droughtMetric] - a[droughtMetric] || a.name.localeCompare(b.name)),
    [droughts, droughtMetric],
  );
  const gwRange = (from: number | null, to: number | null) =>
    from == null ? "" : to == null || to === from ? ` (GW${from})` : ` (GW${from}–${to})`;

  const pctTip = (v: any) => `${v}%`;

  // Compact tooltip so tapping a bar/line doesn't cover half the chart.
  const tt = {
    contentStyle: { padding: "4px 8px", fontSize: 11, lineHeight: 1.3, borderRadius: 6 },
    labelStyle: { fontSize: 11, fontWeight: 600, marginBottom: 2 },
    itemStyle: { padding: 0, margin: 0 },
  } as const;

  // Usage tracking for /admin/activity: every toggle/dropdown change, and taps
  // on a chart itself (at most once per chart every 30s, so scrubbing through
  // tooltips doesn't flood the log).
  const logChartToggle = (chart: string, value: string) =>
    trackUiEvent("chart_interaction", { chart, action: "toggle", value });
  const lastChartTap = useRef(new Map<string, number>());
  const onChartPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button,[role=combobox],[role=option],select")) return;
    const chart = target.closest<HTMLElement>("[data-chart]")?.dataset.chart;
    if (!chart) return;
    const now = Date.now();
    if (now - (lastChartTap.current.get(chart) ?? 0) < 30_000) return;
    lastChartTap.current.set(chart, now);
    trackUiEvent("chart_interaction", { chart, action: "tap" });
  };

  return (
    <section className="bg-card rounded-2xl border border-border/80 shadow-card overflow-hidden" onPointerDown={onChartPointerDown}>
      <div className="bg-primary text-white px-4 py-4">
        <h2 className="font-display text-[26px] font-bold leading-tight">Tendencies</h2>
      </div>

      {rows.length === 0 ? (
        <p className="p-4 text-sm text-gray-500">No revealed predictions yet — tendencies appear once a gameweek's deadline has passed.</p>
      ) : (
        <>
          <div className="space-y-8 p-4">
            {/* Outcome lean */}
            <div data-chart="Outcome lean">
              <h3 className="mb-2 text-sm font-semibold text-gray-700">Outcome lean (Home / Draw / Away %)</h3>
              <ResponsiveContainer width="100%" height={Math.max(180, (outcomeData.length) * 34)}>
                <BarChart layout="vertical" data={outcomeData} margin={{ left: 8, right: 16 }}>
                  <XAxis type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} allowDataOverflow tickFormatter={(v: any) => `${v}%`} tick={{ fontSize: 11 }} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={64}
                    tick={(props: any) => (
                      <text
                        x={props.x}
                        y={props.y}
                        dy={4}
                        textAnchor="end"
                        fontSize={11}
                        fontWeight={props.payload.value === ACTUAL_LABEL ? 700 : 400}
                        fill={props.payload.value === ACTUAL_LABEL ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))"}
                      >
                        {props.payload.value}
                      </text>
                    )}
                  />
                  <RTooltip {...tt} formatter={pctTip} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Home" stackId="a" fill={TC.purple} />
                  <Bar dataKey="Draw" stackId="a" fill={TC.gray} />
                  <Bar dataKey="Away" stackId="a" fill={TC.green} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Home & away goals: each player's predicted average, with the actual
                averages as horizontal reference lines (finished games) */}
            {goalsData.length > 0 && (
              <div data-chart="Avg home & away goals">
                <h3 className="mb-2 text-sm font-semibold text-gray-700">Avg home &amp; away goals</h3>
                <p className="mb-1 text-xs text-gray-500">Dashed lines show the actual home/away averages across finished games.</p>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={goalsData} margin={{ left: 0, right: 96, bottom: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={50} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <RTooltip {...tt} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="homePred" name="Home" fill={TC.purple} />
                    <Bar dataKey="awayPred" name="Away" fill={TC.green} />
                    {realAvg && (
                      <ReferenceLine
                        y={Number(realAvg.home.toFixed(2))}
                        stroke={TC.purple}
                        strokeDasharray="5 4"
                        strokeWidth={2}
                        ifOverflow="extendDomain"
                        label={{ value: `Home actual ${realAvg.home.toFixed(2)}`, position: "right", fontSize: 10, fill: TC.purple }}
                      />
                    )}
                    {realAvg && (
                      <ReferenceLine
                        y={Number(realAvg.away.toFixed(2))}
                        stroke={TC.green}
                        strokeDasharray="5 4"
                        strokeWidth={2}
                        ifOverflow="extendDomain"
                        label={{ value: `Away actual ${realAvg.away.toFixed(2)}`, position: "right", fontSize: 10, fill: TC.green }}
                      />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Predicting style: one stat at a time (over 2.5 by default) */}
            <div data-chart="Predicting style">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-gray-700">Predicting style — {styleMetricMeta[styleMetric].label.toLowerCase()} (% of picks)</h3>
                <div className="flex gap-1">
                  {(["over", "clean", "big"] as const).map((m) => (
                    <Button
                      key={m}
                      size="sm"
                      variant={styleMetric === m ? "default" : "outline"}
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        setStyleMetric(m);
                        logChartToggle("Predicting style", styleMetricMeta[m].label);
                      }}
                    >
                      {styleMetricMeta[m].label}
                    </Button>
                  ))}
                </div>
              </div>
              <p className="mb-1 text-xs text-gray-500">Dashed line shows the actual rate across finished games.</p>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={perPlayer} margin={{ left: 0, right: 64, bottom: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={50} />
                  <YAxis tick={{ fontSize: 11 }} unit="%" />
                  <RTooltip {...tt} formatter={pctTip} />
                  <Bar dataKey={styleMetric} name={styleMetricMeta[styleMetric].label} fill={styleMetricMeta[styleMetric].color} />
                  {realStyle && (
                    <ReferenceLine
                      y={Number(realStyle[styleMetric].toFixed(1))}
                      stroke="hsl(var(--muted-foreground))"
                      strokeDasharray="5 4"
                      strokeWidth={2}
                      ifOverflow="extendDomain"
                      label={{ value: `Actual ${Math.round(realStyle[styleMetric])}%`, position: "right", fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Most common predictions — everyone by default, or one player */}
            {scorelineData.length > 0 && (
              <div data-chart="Most common predictions">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-gray-700">Most common predictions</h3>
                  <Select
                    value={scorelineView}
                    onValueChange={(v) => {
                      setScorelineView(v);
                      logChartToggle(
                        "Most common predictions",
                        v === "everyone" ? "Everyone" : rows.find((r) => String(r.id) === v)?.username ?? v,
                      );
                    }}
                  >
                    <SelectTrigger className="h-8 w-40 text-xs">
                      <SelectValue placeholder="Everyone" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="everyone">Everyone</SelectItem>
                      {rows.map((r) => (
                        <SelectItem key={r.id} value={String(r.id)}>{r.username}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {activeScorelineData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={activeScorelineData} margin={{ left: 0, right: 8, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="scoreline" tick={{ fontSize: 11 }} interval={0} />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <RTooltip {...tt} />
                      <Bar dataKey="correct" name="Correct (exact)" stackId="s" fill={TC.green} />
                      <Bar dataKey="incorrect" name="Not correct" stackId="s" fill={TC.purple} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="py-8 text-center text-sm text-gray-500">No revealed picks for this player yet.</p>
                )}
              </div>
            )}

            {/* Predictor map */}
            <div data-chart="Avg goals vs draw rate">
              <h3 className="mb-2 text-sm font-semibold text-gray-700">Avg goals vs draw rate</h3>
              <ResponsiveContainer width="100%" height={280}>
                <ScatterChart margin={{ top: 12, right: 48, bottom: 28, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" dataKey="avg" name="Avg goals" domain={[1.5, (dataMax: number) => Math.round((dataMax + 0.3) * 10) / 10]} allowDataOverflow tick={{ fontSize: 11 }} label={{ value: "Avg goals", position: "bottom", fontSize: 11 }} />
                  <YAxis type="number" dataKey="drawRate" name="Draw %" unit="%" tick={{ fontSize: 11 }} />
                  <RTooltip {...tt} cursor={{ strokeDasharray: "3 3" }} />
                  <Scatter data={perPlayer} fill={TC.purple}>
                    <LabelList dataKey="name" position="top" style={{ fontSize: 10 }} />
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>

            {/* Weekly points: one metric at a time (average by default) */}
            {weekly.weeks > 0 && (
              <div data-chart="Weekly points">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-gray-700">Weekly points</h3>
                  <div className="flex gap-1">
                    {(["avg", "best", "worst"] as const).map((m) => (
                      <Button
                        key={m}
                        size="sm"
                        variant={weeklyMetric === m ? "default" : "outline"}
                        className="h-7 px-2.5 text-xs"
                        onClick={() => {
                          setWeeklyMetric(m);
                          logChartToggle("Weekly points", weeklyMetricMeta[m].label);
                        }}
                      >
                        {weeklyMetricMeta[m].label}
                      </Button>
                    ))}
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={weekly.data} margin={{ left: 0, right: 8, bottom: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={50} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <RTooltip {...tt} />
                    <Bar dataKey={weeklyMetric} name={weeklyMetricMeta[weeklyMetric].label} fill={weeklyMetricMeta[weeklyMetric].color} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Droughts: longest run of predictions without an exact score */}
            {droughtData.length > 0 && (
              <div data-chart="Drought">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-gray-700">{droughtMetric === "longest" ? "Longest drought" : "Current drought"}</h3>
                  <div className="flex gap-1">
                    {(["longest", "current"] as const).map((m) => (
                      <Button
                        key={m}
                        size="sm"
                        variant={droughtMetric === m ? "default" : "outline"}
                        className="h-7 px-2.5 text-xs"
                        onClick={() => {
                          setDroughtMetric(m);
                          logChartToggle("Drought", droughtMetricMeta[m].label);
                        }}
                      >
                        {droughtMetricMeta[m].label}
                      </Button>
                    ))}
                  </div>
                </div>
                <p className="mb-1 text-xs text-gray-500">
                  {droughtMetric === "longest"
                    ? "Most predictions in a row without an exact score."
                    : "Predictions since each player's last exact score."}
                </p>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={droughtData} margin={{ left: 0, right: 8, bottom: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={50} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <RTooltip
                      {...tt}
                      formatter={(v: any, _n: any, item: any) => {
                        const d = item?.payload as (typeof droughtData)[number] | undefined;
                        const suffix = !d ? "" : droughtMetric === "longest"
                          ? gwRange(d.longestFrom, d.longestTo)
                          : d.currentFrom != null ? ` (since GW${d.currentFrom})` : "";
                        return [`${v} game${v === 1 ? "" : "s"}${suffix}`, droughtMetricMeta[droughtMetric].label];
                      }}
                    />
                    <Bar dataKey={droughtMetric} name={droughtMetricMeta[droughtMetric].label} fill={droughtMetricMeta[droughtMetric].color} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* One-offs: one score right, the other missed by a single goal */}
            {oneOffData.length > 0 && (
              <div data-chart="Most one-offs">
                <h3 className="mb-2 text-sm font-semibold text-gray-700">Most one-offs</h3>
                <p className="mb-1 text-xs text-gray-500">
                  Predictions that were one goal away from the exact score: one score right, the other off by one.
                </p>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={oneOffData} margin={{ left: 0, right: 8, bottom: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={50} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <RTooltip {...tt} />
                    <Bar dataKey="oneOffs" name="One-offs" fill={TC.purple} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Lone calls: the only player to get a match right */}
            {loneData.length > 0 && (
              <div data-chart={LONE_CALLS_TITLE}>
                <h3 className="mb-2 text-sm font-semibold text-gray-700">{LONE_CALLS_TITLE}</h3>
                <p className="mb-1 text-xs text-gray-500">
                  Matches where a player was the only one with the right result, or the only one with the exact score.
                </p>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={loneData} margin={{ left: 0, right: 8, bottom: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={50} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <RTooltip {...tt} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="exact" name="Exact score" stackId="l" fill={TC.green} />
                    <Bar dataKey="result" name="Result only" stackId="l" fill={TC.purple} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function PredictionsPage() {
  const { matches, isLoading: matchesLoading } = useMatches();
  const { leaderboard: seasonLeaderboard, isLoading: leaderboardLoading } = useLeaderboard();
  const { predictions, isLoading: predictionsLoading } = useAllPredictions();
  const { user, group } = useGroup();

  // The group's configured Lawro points (falls back to 3/1). Used by the
  // client-side tallies (per-gameweek leaderboard, stats, tendencies); the
  // season leaderboard is already scored with these on the server.
  const lawroPoints: LawroPoints = useMemo(
    () => ({
      exact: group?.rules?.lawro.exactScorePoints ?? DEFAULT_LAWRO_POINTS.exact,
      result: group?.rules?.lawro.correctResultPoints ?? DEFAULT_LAWRO_POINTS.result,
    }),
    [group?.rules?.lawro.exactScorePoints, group?.rules?.lawro.correctResultPoints],
  );

  const isLoading = matchesLoading || leaderboardLoading || predictionsLoading;

  const [activeTab, setActiveTab] = useState("predictions");

  // Player columns come from the group's real roster (the season leaderboard
  // returns every user in the caller's group), ordered alphabetically.
  const players = useMemo(
    () =>
      [...seasonLeaderboard]
        .map((u: LeaderboardEntry) => ({ id: u.id, username: u.username }))
        .sort((a, b) => a.username.localeCompare(b.username)),
    [seasonLeaderboard],
  );

  const seasonStandings = useMemo(
    () => [...seasonLeaderboard].sort(compareStandings),
    [seasonLeaderboard],
  );

  const availableGameweeks = useMemo(() => {
    const gws = Array.from(
      new Set(matches.map((m) => m.gameweek).filter((g): g is number => typeof g === "number")),
    );
    gws.sort((a, b) => a - b);
    return gws;
  }, [matches]);

  const currentGameweek = useMemo(() => {
    if (availableGameweeks.length === 0) return 1;
    for (const gw of availableGameweeks) {
      const gwm = matches.filter((m) => m.gameweek === gw);
      if (gwm.some((m) => !isFinishedMatch(m))) return gw;
    }
    return availableGameweeks[availableGameweeks.length - 1];
  }, [availableGameweeks, matches]);


  // Tendencies needs at least one revealed prediction (a gameweek whose deadline
  // has passed) to have any scorelines to aggregate.
  const tendenciesAvailable = useMemo(
    () => predictions.some((p) => !p.hidden && p.homeScore != null && p.awayScore != null),
    [predictions],
  );

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      <main className="container mx-auto max-w-5xl px-4 py-4 sm:py-6 flex-grow">
        {isLoading ? (
          <div className="space-y-8">
            <LeaderboardLoading />
          </div>
        ) : (
          <Tabs
            value={activeTab}
            onValueChange={(v) => {
              setActiveTab(v);
              trackEvent({ path: "/lawro", subPath: v, label: `Lawro: ${v}` });
            }}
            className="w-full"
          >
            <TabsList className="flex w-full justify-around">
              <TabsTrigger value="predictions" className="text-xs sm:text-sm">Predictions</TabsTrigger>
              <TabsTrigger value="leaderboard" className="text-xs sm:text-sm">Leaderboard</TabsTrigger>
              <TabsTrigger value="table" className="text-xs sm:text-sm">Table</TabsTrigger>
              {tendenciesAvailable && (
                <TabsTrigger value="tendencies" className="text-xs sm:text-sm">Tendencies</TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="predictions" className="mt-4">
              <PredictionsTab
                matches={matches}
                predictions={predictions as Prediction[]}
                players={players}
                availableGameweeks={availableGameweeks}
                currentGameweek={currentGameweek}
                userId={user?.id}
                deadlineMinutesBeforeKickoff={group?.rules?.lawro.deadlineMinutesBeforeKickoff ?? 0}
                lateEntry={group?.rules?.lawro.missedPickPolicy === "open_until_kickoff"}
                jokerEnabled={group?.rules?.lawro.jokerEnabled ?? false}
              />
            </TabsContent>

            <TabsContent value="leaderboard" className="mt-4">
              <LeaderboardTab
                players={players}
                predictions={predictions as Prediction[]}
                matches={matches}
                availableGameweeks={availableGameweeks}
                currentGameweek={currentGameweek}
                seasonStandings={seasonStandings}
                userId={user?.id}
                points={lawroPoints}
              />
            </TabsContent>

            <TabsContent value="table" className="mt-4">
              <PredictedTableTab
                players={players}
                predictions={predictions as Prediction[]}
                matches={matches}
                userId={user?.id}
              />
            </TabsContent>

            {tendenciesAvailable && (
              <TabsContent value="tendencies" className="mt-4">
                <TendenciesTab
                  players={players}
                  predictions={predictions as Prediction[]}
                  matches={matches}
                  points={lawroPoints}
                />
              </TabsContent>
            )}
          </Tabs>
        )}
      </main>
      <Footer />
    </div>
  );
}

export default function HomePage() {
  return <PredictionsPage />;
}

// ---------- Predicted League Table tab ----------
// Build the Premier League table a selected player's score predictions would
// produce, and compare each team's position against the real table.

type TableRow = {
  teamId: number;
  team: Team | undefined;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
};

type ScoredGame = { home: number; away: number; hs: number; as: number };

function emptyRow(teamId: number, team: Team | undefined): TableRow {
  return { teamId, team, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0 };
}

// Accumulate a set of games into a standings map keyed by team id. Every team in
// teamIds appears, even with zero games played.
function buildStandings(
  teamIds: number[],
  teamById: Map<number, Team>,
  games: ScoredGame[],
): TableRow[] {
  const rows = new Map<number, TableRow>();
  for (const id of teamIds) rows.set(id, emptyRow(id, teamById.get(id)));
  const apply = (id: number, gf: number, ga: number) => {
    const r = rows.get(id);
    if (!r) return;
    r.played += 1;
    r.gf += gf;
    r.ga += ga;
    if (gf > ga) {
      r.won += 1;
      r.points += 3;
    } else if (gf === ga) {
      r.drawn += 1;
      r.points += 1;
    } else {
      r.lost += 1;
    }
  };
  for (const g of games) {
    apply(g.home, g.hs, g.as);
    apply(g.away, g.as, g.hs);
  }
  for (const r of Array.from(rows.values())) r.gd = r.gf - r.ga;
  return Array.from(rows.values());
}

// PL ordering: points, then goal difference, then goals for, then name.
function rankTable(rows: TableRow[]): TableRow[] {
  return [...rows].sort(
    (a, b) =>
      b.points - a.points ||
      b.gd - a.gd ||
      b.gf - a.gf ||
      (a.team?.name ?? "").localeCompare(b.team?.name ?? ""),
  );
}

function PredictedTableTab({
  players,
  predictions,
  matches,
  userId,
}: {
  players: Player[];
  predictions: Prediction[];
  matches: Match[];
  userId: number | undefined;
}) {
  const [selectedId, setSelectedId] = useState<number | undefined>(
    userId ?? players[0]?.id,
  );

  // Every team that appears in the fixture list.
  const teamById = useMemo(() => {
    const m = new Map<number, Team>();
    for (const match of matches) {
      if (match.homeTeam) m.set(match.homeTeamId, match.homeTeam);
      if (match.awayTeam) m.set(match.awayTeamId, match.awayTeam);
    }
    return m;
  }, [matches]);
  const teamIds = useMemo(() => Array.from(teamById.keys()), [teamById]);

  const finished = useMemo(
    () =>
      matches.filter(
        (m) => isFinishedMatch(m) && m.homeScore != null && m.awayScore != null,
      ),
    [matches],
  );

  // Actual table: real results for every finished match.
  const actualRanked = useMemo(() => {
    const games: ScoredGame[] = finished.map((m) => ({
      home: m.homeTeamId,
      away: m.awayTeamId,
      hs: m.homeScore as number,
      as: m.awayScore as number,
    }));
    return rankTable(buildStandings(teamIds, teamById, games));
  }, [finished, teamIds, teamById]);

  const actualPos = useMemo(() => {
    const m = new Map<number, number>();
    actualRanked.forEach((r, i) => m.set(r.teamId, i + 1));
    return m;
  }, [actualRanked]);

  // Predicted table: the selected player's predicted scores for the finished
  // matches they actually predicted (finished picks are always un-redacted).
  const predByMatch = useMemo(() => {
    const m = new Map<number, Prediction>();
    for (const p of predictions) {
      if (p.userId !== selectedId) continue;
      if (p.hidden || p.homeScore == null || p.awayScore == null) continue;
      m.set(p.matchId, p);
    }
    return m;
  }, [predictions, selectedId]);

  const predictedRanked = useMemo(() => {
    const games: ScoredGame[] = [];
    for (const match of finished) {
      const pred = predByMatch.get(match.id);
      if (!pred) continue;
      games.push({
        home: match.homeTeamId,
        away: match.awayTeamId,
        hs: pred.homeScore,
        as: pred.awayScore,
      });
    }
    return rankTable(buildStandings(teamIds, teamById, games));
  }, [finished, predByMatch, teamIds, teamById]);

  const selectedName = players.find((p) => p.id === selectedId)?.username ?? "";
  const predictedCount = finished.filter((m) => predByMatch.has(m.id)).length;

  return (
    <div className="space-y-4">
      <section className="bg-card rounded-2xl border border-border/80 shadow-card overflow-hidden">
        <div className="bg-primary text-white px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-[26px] font-bold leading-tight">Predicted table</h2>
              <p className="text-xs text-white/80">
                The Premier League table if every one of {selectedName || "this player"}'s
                predictions came true, next to where each team actually sits.
              </p>
            </div>
            <select
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(Number(e.target.value))}
              className="rounded-md bg-white/15 px-3 py-1.5 text-sm font-medium text-white outline-none ring-1 ring-white/30 [&>option]:text-gray-900"
            >
              {players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.username}
                </option>
              ))}
            </select>
          </div>
        </div>

        {finished.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">
            No matches have finished yet — this table will fill in as the season
            plays out.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 border-b text-xs uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className="px-2 py-2 text-center w-8">#</th>
                    <th className="px-2 py-2 text-center w-10" title="Places vs the actual table">
                      +/-
                    </th>
                    <th className="px-2 py-2 text-left">Team</th>
                    <th className="px-2 py-2 text-center">P</th>
                    <th className="px-2 py-2 text-center hidden sm:table-cell">W</th>
                    <th className="px-2 py-2 text-center hidden sm:table-cell">D</th>
                    <th className="px-2 py-2 text-center hidden sm:table-cell">L</th>
                    <th className="px-2 py-2 text-center hidden md:table-cell">GF</th>
                    <th className="px-2 py-2 text-center hidden md:table-cell">GA</th>
                    <th className="px-2 py-2 text-center">GD</th>
                    <th className="px-2 py-2 text-center font-bold">Pts</th>
                  </tr>
                </thead>
                <tbody>
                  {predictedRanked.map((r, i) => {
                    const predPos = i + 1;
                    const realPos = actualPos.get(r.teamId) ?? predPos;
                    const delta = realPos - predPos; // >0 => higher in predicted
                    return (
                      <tr key={r.teamId} className="border-b last:border-0">
                        <td className="px-2 py-2 text-center text-gray-500">{predPos}</td>
                        <td className="px-2 py-2 text-center">
                          {delta > 0 ? (
                            <span className="inline-flex items-center text-green-600 font-medium">
                              <ArrowUp className="h-3.5 w-3.5" />
                              {delta}
                            </span>
                          ) : delta < 0 ? (
                            <span className="inline-flex items-center text-red-600 font-medium">
                              <ArrowDown className="h-3.5 w-3.5" />
                              {-delta}
                            </span>
                          ) : (
                            <Minus className="mx-auto h-3.5 w-3.5 text-gray-300" />
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-2">
                            {r.team && <TeamCrest team={r.team as any} size={22} />}
                            <span className="font-medium text-gray-900">
                              {r.team?.name ?? `#${r.teamId}`}
                            </span>
                          </div>
                        </td>
                        <td className="px-2 py-2 text-center text-gray-600">{r.played}</td>
                        <td className="px-2 py-2 text-center text-gray-600 hidden sm:table-cell">{r.won}</td>
                        <td className="px-2 py-2 text-center text-gray-600 hidden sm:table-cell">{r.drawn}</td>
                        <td className="px-2 py-2 text-center text-gray-600 hidden sm:table-cell">{r.lost}</td>
                        <td className="px-2 py-2 text-center text-gray-600 hidden md:table-cell">{r.gf}</td>
                        <td className="px-2 py-2 text-center text-gray-600 hidden md:table-cell">{r.ga}</td>
                        <td className="px-2 py-2 text-center text-gray-600">
                          {r.gd > 0 ? `+${r.gd}` : r.gd}
                        </td>
                        <td className="px-2 py-2 text-center font-bold text-primary">{r.points}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-3 text-xs text-gray-500">
              <span className="inline-flex items-center gap-1">
                <ArrowUp className="h-3.5 w-3.5 text-green-600" /> higher than the real table
              </span>
              <span className="inline-flex items-center gap-1">
                <ArrowDown className="h-3.5 w-3.5 text-red-600" /> lower than the real table
              </span>
              <span>Based on {predictedCount} predicted result{predictedCount === 1 ? "" : "s"}.</span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function LeaderboardLoading() {
  return (
    <section className="bg-card rounded-2xl border border-border/80 shadow-card overflow-hidden">
      <div className="bg-primary text-white px-4 py-4"><h2 className="font-display text-[26px] font-bold leading-tight">Loading…</h2></div>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-muted/60 border-b">
            <tr>
              {["Name", "Exact", "Correct", "Points"].map((h) => (
                <th key={h} className="px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-card">
            {[1, 2, 3, 4, 5].map((i) => (
              <tr key={i}>
                {[1, 2, 3, 4].map((j) => <td key={j} className="px-4 py-4"><Skeleton className="h-5 w-16" /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
