import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { useMatches, useLeaderboard, useAllPredictions } from "@/hooks/useScores";
import { getStatusColor } from "@/lib/utils";
import { Match, LeaderboardEntry, Prediction, Team } from "@/lib/types";
import { TeamCrest } from "@/components/TeamCrest";
import { ArrowUp, ArrowDown, Minus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGroup } from "@/contexts/GroupContext";
import { trackEvent } from "@/lib/track";
import { londonStringToUtcMs } from "@shared/time";
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

// Smart single-input score cell: type "2" → auto-inserts "2-", then type "1" → "2-1".
// Everyone can see everyone's predictions; only the logged-in player's own cells
// are editable, and only until the gameweek deadline.
function PredictionCell({
  userId,
  matchId,
  existingPrediction,
  isLocked,
  own,
}: {
  userId: number;
  matchId: number;
  existingPrediction: { id: number; homeScore?: number; awayScore?: number; status?: string; isAutoPick?: boolean; isJoker?: boolean; hidden?: boolean } | undefined;
  isLocked: boolean;
  own: boolean;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const predIdRef = useRef<number | undefined>(existingPrediction?.id);

  // A redacted (hidden) pick has no scoreline, so only build a value when both
  // scores are present.
  const hasScore =
    !!existingPrediction &&
    typeof existingPrediction.homeScore === "number" &&
    typeof existingPrediction.awayScore === "number";
  const initialValue = hasScore
    ? `${existingPrediction!.homeScore}-${existingPrediction!.awayScore}`
    : "";

  const [value, setValue] = useState(initialValue);
  const valueRef = useRef(value);
  valueRef.current = value;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>(initialValue);
  // Surface save status so a failed save is never silent (the old debounced
  // save could drop a pick if a blur didn't fire — e.g. tapping straight to the
  // next cell on mobile). "error" shows a red border and forces a retry.
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");

  const prevPredRef = useRef(existingPrediction);
  useEffect(() => {
    const prev = prevPredRef.current;
    prevPredRef.current = existingPrediction;
    if (!prev && hasScore) {
      setValue(`${existingPrediction!.homeScore}-${existingPrediction!.awayScore}`);
      predIdRef.current = existingPrediction!.id;
    }
    if (existingPrediction) predIdRef.current = existingPrediction.id;
  }, [existingPrediction]);

  const save = useCallback(async () => {
    const v = valueRef.current;
    if (v === lastSavedRef.current) return;

    // Sentinel that never equals a real cell value ("" or "X-Y"). Parking
    // lastSavedRef here after a failure guarantees the next blur/edit retries.
    const RETRY = "￿";

    if (v === "") {
      const prevId = predIdRef.current;
      if (!prevId) {
        lastSavedRef.current = "";
        setSaveState("idle");
        return;
      }
      lastSavedRef.current = "";
      setSaveState("saving");
      try {
        const res = await fetch(`/api/predictions/${prevId}`, {
          method: "DELETE",
          credentials: "include",
        });
        if (res.ok) {
          predIdRef.current = undefined;
          setSaveState("idle");
        } else {
          lastSavedRef.current = RETRY;
          setSaveState("error");
        }
        queryClient.invalidateQueries({ queryKey: ["/api/predictions"] });
        queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      } catch (e) {
        lastSavedRef.current = RETRY;
        setSaveState("error");
      }
      return;
    }

    const parts = v.split("-");
    if (parts.length !== 2) return;
    const h = parseInt(parts[0]);
    const a = parseInt(parts[1]);
    if (isNaN(h) || isNaN(a)) return;

    lastSavedRef.current = v;
    setSaveState("saving");
    try {
      const prevId = predIdRef.current;
      let ok = false;
      if (prevId) {
        const res = await fetch(`/api/predictions/${prevId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ homeScore: h, awayScore: a }),
        });
        ok = res.ok;
      } else {
        const res = await fetch("/api/predictions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ userId, matchId, homeScore: h, awayScore: a }),
        });
        ok = res.ok;
        if (res.ok) {
          const data = await res.json();
          predIdRef.current = data.id;
        }
      }
      if (ok) {
        setSaveState("idle");
      } else {
        lastSavedRef.current = RETRY;
        setSaveState("error");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/predictions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
    } catch (e) {
      lastSavedRef.current = RETRY;
      setSaveState("error");
    }
  }, [userId, matchId, queryClient]);

  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    save();
  }, [save]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Flush the save when the app is backgrounded or the page is being hidden —
  // on mobile these don't reliably fire a blur, so a last edit could otherwise
  // be lost. Only the editable (own, unlocked) cells need this. flushSave is a
  // no-op when there's nothing new to save.
  useEffect(() => {
    if (!own || isLocked) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushSave();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flushSave);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flushSave);
    };
  }, [own, isLocked, flushSave]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    const prevVal = valueRef.current;

    if (/^\d$/.test(newVal) && prevVal === "") {
      const withHyphen = newVal + "-";
      setValue(withHyphen);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.setSelectionRange(withHyphen.length, withHyphen.length);
        }
      });
      return;
    }

    if (prevVal.includes("-") && !newVal.includes("-")) {
      setValue("");
      valueRef.current = "";
      flushSave();
      return;
    }

    if (/^\d-\d?$/.test(newVal) || newVal === "") {
      setValue(newVal);
      valueRef.current = newVal;
      // Save the moment a complete "X-Y" (or a cleared cell) exists — no debounce
      // and no reliance on blur/enter, so a pick can't be lost by tapping away.
      if (/^\d-\d$/.test(newVal) || newVal === "") {
        flushSave();
      }
    }
  };

  // Before the deadline, other players' scorelines are secret. The API still
  // tells us whether a pick exists, so show a (filled) lock for "submitted" and
  // a dash for "not yet" — you can see who's in without seeing their scores.
  // Your own column stays visible/editable; after the deadline everyone's
  // scores are shown.
  if (!isLocked && !own) {
    return (
      <td className="px-2 py-2 border text-center">
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
    if (!existingPrediction) {
      return (
        <td className="px-2 py-2 border text-center">
          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-800">-</span>
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
        data-testid={`pred-input-${matchId}`}
        value={value}
        onChange={handleChange}
        onBlur={flushSave}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            inputRef.current?.blur(); // dismiss keyboard + flush the save
          }
        }}
        title={saveState === "error" ? "Not saved — tap the cell and re-enter" : undefined}
        className={`w-12 h-7 text-center rounded text-xs font-bold focus:outline-none bg-white border ${
          saveState === "error"
            ? "border-red-500 border-2"
            : saveState === "saving"
              ? "border-amber-400"
              : "border-gray-300 focus:border-primary"
        }`}
      />
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
// while the gameweek is still open (the server enforces the same); after the
// deadline it just says which pick is your Joker.
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
        className={`h-10 w-full rounded-lg border bg-white px-3 text-base sm:w-72 sm:text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-60 ${
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
  jokerEnabled = false,
}: {
  matches: Match[];
  predictions: Prediction[];
  players: Player[];
  availableGameweeks: number[];
  currentGameweek: number;
  userId: number | undefined;
  // The group's Joker rule: each player doubles the points of one pick a week.
  jokerEnabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedGw, setSelectedGw] = useState<number | null>(null);
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
    return new Date(Math.min(...times));
  }, [gwMatches]);

  const isLocked = deadline ? new Date() >= deadline : false;

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
    <section className="bg-white rounded-lg shadow-md overflow-hidden">
      <div className="bg-primary text-white p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xl font-bold">GW{gameweek} Predictions{isLocked ? " 🔒" : ""}</h2>
          {nav}
        </div>
        <div className="mt-1">
          <DeadlineCountdown deadline={deadline} />
        </div>
      </div>

      {gwMatches.length > 0 && userId != null && (
        <JokerPicker
          key={gameweek}
          enabled={jokerEnabled}
          picks={matchPredictions.flatMap(({ match, userPredictions }) => {
            const pred = userPredictions.get(userId);
            if (!pred || typeof pred.homeScore !== "number" || typeof pred.awayScore !== "number") return [];
            return [{ match, pred, locked: isLocked }];
          })}
          canStillPredict={!isLocked}
        />
      )}

      {gwMatches.length === 0 ? (
        <p className="p-4 text-sm text-gray-500">No fixtures for this gameweek yet.</p>
      ) : (
        <div className="overflow-x-auto p-2 md:p-4">
          <table className="w-full border">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 border text-left text-xs font-medium text-gray-500 uppercase tracking-wider sticky left-0 bg-gray-50 z-20">Match</th>
                <th className="px-3 py-2 border text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Score</th>
                {orderedPlayers.map((p) => (
                  // Fixed width + truncation so every player's column is the same
                  // width regardless of how long their name is.
                  <th key={p.id} className="w-16 px-2 py-2 border text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <span className="flex items-center justify-center gap-0.5">
                      <span className="min-w-0 truncate" title={p.username}>{p.username}</span>
                      {p.id === userId && <span className="shrink-0 text-primary" title="Your column (editable)">•</span>}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {matchPredictions.map((md, i) => {
                const match = md.match;
                return (
                  <tr key={match.id} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                    <td className={`px-3 py-2 border text-xs font-medium whitespace-nowrap sticky left-0 z-10 ${i % 2 === 0 ? "bg-white" : "bg-gray-50"}`}>
                      {match.homeTeam?.shortName || match.homeTeam?.name} vs {match.awayTeam?.shortName || match.awayTeam?.name}
                    </td>
                    <td className="px-3 py-2 border text-center">
                      <div className="flex flex-col items-center gap-0.5">
                        {match.status !== "not_started" && match.homeScore != null && match.awayScore != null && (
                          <span className="text-sm font-bold">{match.homeScore} - {match.awayScore}</span>
                        )}
                        <MatchProgress match={match} />
                      </div>
                    </td>
                    {orderedPlayers.map((player) => (
                      <PredictionCell
                        key={player.id}
                        userId={player.id}
                        matchId={match.id}
                        existingPrediction={md.userPredictions.get(player.id)}
                        isLocked={isLocked}
                        own={player.id === userId}
                      />
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// A group's configurable Lawro point values. Mirrors the server's
// GroupRules.lawro; the default 3/1 reproduces the original hard-coded scoring.
export type LawroPoints = { exact: number; result: number };
const DEFAULT_LAWRO_POINTS: LawroPoints = { exact: 3, result: 1 };

// Points a single prediction scored. Prefer the server-sent value (`points`),
// which already reflects the gameweek's rules and any Joker doubling; fall back
// to the status + the group's points only when the server didn't send a number.
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

// ---------- Leaderboard tab: one section, Season total (default) or a gameweek ----------
function LeaderboardTab({
  players,
  predictions,
  matches,
  availableGameweeks,
  currentGameweek,
  seasonStandings,
  userId,
  points = DEFAULT_LAWRO_POINTS,
}: {
  players: Player[];
  predictions: Prediction[];
  matches: Match[];
  availableGameweeks: number[];
  currentGameweek: number;
  seasonStandings: LeaderboardEntry[];
  userId: number | undefined;
  points?: LawroPoints;
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

  return (
    <div className="space-y-6">
    <section className="bg-white rounded-lg shadow-md overflow-hidden">
      <div className="bg-primary text-white p-4 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold">Leaderboard</h2>
          <p className="text-sm text-white/80">
            {scope === "season" ? "Total points across the season." : `Gameweek ${scope} only.`}
          </p>
        </div>
        <select
          value={String(scope)}
          onChange={(e) => setScope(e.target.value === "season" ? "season" : Number(e.target.value))}
          className="h-8 rounded-md bg-white/10 border border-white/20 text-white text-sm font-medium px-2 focus:outline-none"
        >
          <option className="text-gray-900" value="season">Season total</option>
          {selectableGameweeks.map((gw) => (
            <option className="text-gray-900" key={gw} value={gw}>GW{gw}</option>
          ))}
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">#</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
              <th className="px-2 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider"><div>Exact</div><div>Score</div></th>
              <th className="px-2 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider"><div>Correct</div><div>Result</div></th>
              <th className="px-2 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider"><div>Total</div><div>Points</div></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
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
                  className={`${isMe ? "bg-primary/5 ring-1 ring-inset ring-primary/20" : i % 2 === 0 ? "bg-white" : "bg-gray-50"}`}
                >
                  <td className="px-3 py-3 whitespace-nowrap text-sm text-gray-500 font-medium">{i + 1}</td>
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
                  <td className="px-2 py-3 whitespace-nowrap text-sm text-center font-bold text-primary">{player.totalPoints}</td>
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
    <section className="bg-white rounded-lg shadow-md overflow-hidden">
      <div className="bg-primary text-white p-4">
        <h2 className="text-xl font-bold">Scoring Guide</h2>
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

// ---------- Stats tab: season stats per player (only after GW1 finishes) ----------
function StatsTab({
  players,
  predictions,
  matches,
  availableGameweeks,
  points = DEFAULT_LAWRO_POINTS,
}: {
  players: Player[];
  predictions: Prediction[];
  matches: Match[];
  availableGameweeks: number[];
  points?: LawroPoints;
}) {
  // Gameweeks whose every fixture is finished — the basis for "per week" stats.
  const completedGameweeks = useMemo(
    () =>
      availableGameweeks.filter((gw) => {
        const gwm = matches.filter((m) => m.gameweek === gw);
        return gwm.length > 0 && gwm.every(isFinishedMatch);
      }),
    [availableGameweeks, matches],
  );
  const completedSet = useMemo(() => new Set(completedGameweeks), [completedGameweeks]);

  // matchId → gameweek, for finished matches only.
  const gwOfMatch = useMemo(() => {
    const map = new Map<number, number>();
    for (const m of matches) if (m.gameweek != null && isFinishedMatch(m)) map.set(m.id, m.gameweek);
    return map;
  }, [matches]);

  const rows = useMemo(() => {
    // Total matches played so far — the denominator for pick (participation) rate.
    const totalFinished = gwOfMatch.size;
    const byUser = new Map<number, {
      finished: number; exact: number; correct: number; points: number;
      perGw: Map<number, number>; perGwExact: Map<number, number>;
    }>();
    for (const p of players) byUser.set(p.id, { finished: 0, exact: 0, correct: 0, points: 0, perGw: new Map(), perGwExact: new Map() });

    for (const pred of predictions) {
      const gw = gwOfMatch.get(pred.matchId);
      if (gw == null) continue; // only finished matches count
      const s = byUser.get(pred.userId);
      if (!s) continue;
      s.finished += 1;
      let pts = 0;
      let gotExact = false;
      if (pred.status === "exact_score") { s.exact += 1; pts = predictionPoints(pred, points); gotExact = true; }
      else if (pred.status === "correct_result") { s.correct += 1; pts = predictionPoints(pred, points); }
      s.points += pts;
      if (completedSet.has(gw)) {
        s.perGw.set(gw, (s.perGw.get(gw) ?? 0) + pts);
        if (gotExact) s.perGwExact.set(gw, (s.perGwExact.get(gw) ?? 0) + 1);
      }
    }

    const weeks = completedGameweeks.length;
    return players.map((p) => {
      const s = byUser.get(p.id)!;
      let completedPoints = 0;
      let bestWeekPoints = 0, bestWeekGw: number | null = null;
      let worstWeekPoints: number | null = null, worstWeekGw: number | null = null;
      let mostExactWeek = 0, mostExactWeekGw: number | null = null;
      // Every completed gameweek counts — a week with no picks is a 0, which is a
      // legitimate (and telling) "worst week".
      for (const gw of completedGameweeks) {
        const v = s.perGw.get(gw) ?? 0;
        completedPoints += v;
        if (bestWeekGw == null || v > bestWeekPoints) { bestWeekPoints = v; bestWeekGw = gw; }
        if (worstWeekGw == null || v < (worstWeekPoints as number)) { worstWeekPoints = v; worstWeekGw = gw; }
        const e = s.perGwExact.get(gw) ?? 0;
        if (mostExactWeekGw == null || e > mostExactWeek) { mostExactWeek = e; mostExactWeekGw = gw; }
      }
      return {
        id: p.id,
        username: p.username,
        points: s.points,
        exact: s.exact,
        correct: s.correct,
        // Participation: share of played matches the player entered a pick for.
        pickRate: totalFinished ? s.finished / totalFinished : null,
        avgPerWeek: weeks ? completedPoints / weeks : 0,
        bestWeekPoints, bestWeekGw,
        worstWeekPoints, worstWeekGw,
        mostExactWeek, mostExactWeekGw,
      };
    });
  }, [players, predictions, gwOfMatch, completedSet, completedGameweeks, points]);

  type Row = (typeof rows)[number];
  type SortKey = "points" | "exact" | "correct" | "avgPerWeek" | "bestWeekPoints" | "worstWeekPoints" | "mostExactWeek" | "pickRate";
  const [sortKey, setSortKey] = useState<SortKey>("points");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sortValue = (r: Row, k: SortKey): number => {
    switch (k) {
      case "pickRate": return r.pickRate ?? -1;
      case "worstWeekPoints": return r.worstWeekPoints ?? 0;
      default: return (r[k] as number) ?? 0;
    }
  };
  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const d = sortValue(a, sortKey) - sortValue(b, sortKey);
      // Stable, alphabetical tiebreak so equal rows don't jump around.
      const primary = sortDir === "desc" ? -d : d;
      return primary !== 0 ? primary : a.username.localeCompare(b.username);
    });
  }, [rows, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(k); setSortDir("desc"); }
  };

  const pct = (v: number | null) => (v == null ? "–" : `${Math.round(v * 100)}%`);

  const SortTh = ({ k, label, sub, title }: { k: SortKey; label: string; sub?: string; title?: string }) => (
    <th className="px-2 py-2 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
      <button
        type="button"
        onClick={() => toggleSort(k)}
        title={title ?? "Tap to sort"}
        className={`inline-flex items-center justify-center gap-0.5 leading-tight hover:text-gray-800 ${sortKey === k ? "text-primary" : ""}`}
      >
        <span>
          <span className="block">{label}</span>
          {sub && <span className="block">{sub}</span>}
        </span>
        {sortKey === k && (sortDir === "desc" ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </th>
  );

  const gwTag = (gw: number | null) => gw != null && <span className="block text-[10px] text-gray-400">GW{gw}</span>;

  return (
    <section className="bg-white rounded-lg shadow-md overflow-hidden">
      <div className="bg-primary text-white p-4">
        <h2 className="text-xl font-bold">Stats</h2>
        <p className="text-sm text-white/80">
          Season to date across {completedGameweeks.length} completed gameweek{completedGameweeks.length === 1 ? "" : "s"}. Tap any column to sort.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
              <SortTh k="points" label="Pts" title="Total points" />
              <SortTh k="exact" label="Exact" title="Total correct scorelines (3 pts each)" />
              <SortTh k="correct" label="Result" title="Total correct results (1 pt each)" />
              <SortTh k="avgPerWeek" label="Avg" sub="/Wk" title="Average points per completed gameweek" />
              <SortTh k="bestWeekPoints" label="Best" sub="Wk" title="Most points in a single gameweek" />
              <SortTh k="worstWeekPoints" label="Worst" sub="Wk" title="Fewest points in a single gameweek" />
              <SortTh k="mostExactWeek" label="Most" sub="Exact/Wk" title="Most correct scorelines in a single gameweek" />
              <SortTh k="pickRate" label="Pick" sub="%" title="Share of played matches this player entered a prediction for" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {sorted.map((s, i) => (
              <tr key={s.id} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                <td className="px-3 py-3 whitespace-nowrap text-sm font-medium">{s.username}</td>
                <td className="px-2 py-3 whitespace-nowrap text-sm text-center font-bold text-primary">{s.points}</td>
                <td className="px-2 py-3 whitespace-nowrap text-sm text-center text-gray-600">{s.exact}</td>
                <td className="px-2 py-3 whitespace-nowrap text-sm text-center text-gray-600">{s.correct}</td>
                <td className="px-2 py-3 whitespace-nowrap text-sm text-center text-gray-600">{s.avgPerWeek.toFixed(1)}</td>
                <td className="px-2 py-3 whitespace-nowrap text-sm text-center text-gray-600">{s.bestWeekPoints}{gwTag(s.bestWeekGw)}</td>
                <td className="px-2 py-3 whitespace-nowrap text-sm text-center text-gray-600">{s.worstWeekPoints ?? "–"}{gwTag(s.worstWeekGw)}</td>
                <td className="px-2 py-3 whitespace-nowrap text-sm text-center text-gray-600">{s.mostExactWeek}{gwTag(s.mostExactWeekGw)}</td>
                <td className="px-2 py-3 whitespace-nowrap text-sm text-center text-gray-600">{pct(s.pickRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

// On-brand chart colours (see index.css tokens).
const TC = {
  purple: "hsl(var(--primary))",
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
  points = DEFAULT_LAWRO_POINTS,
}: {
  players: Player[];
  predictions: Prediction[];
  matches: Match[];
  points?: LawroPoints;
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

  const pctTip = (v: any) => `${v}%`;

  // Compact tooltip so tapping a bar/line doesn't cover half the chart.
  const tt = {
    contentStyle: { padding: "4px 8px", fontSize: 11, lineHeight: 1.3, borderRadius: 6 },
    labelStyle: { fontSize: 11, fontWeight: 600, marginBottom: 2 },
    itemStyle: { padding: 0, margin: 0 },
  } as const;

  return (
    <section className="bg-white rounded-lg shadow-md overflow-hidden">
      <div className="bg-primary text-white p-4">
        <h2 className="text-xl font-bold">Tendencies</h2>
      </div>

      {rows.length === 0 ? (
        <p className="p-4 text-sm text-gray-500">No revealed predictions yet — tendencies appear once a gameweek's deadline has passed.</p>
      ) : (
        <>
          <div className="space-y-8 p-4">
            {/* Outcome lean */}
            <div>
              <h3 className="mb-2 text-sm font-semibold text-gray-700">Outcome lean (Home / Draw / Away %)</h3>
              <ResponsiveContainer width="100%" height={Math.max(180, outcomeData.length * 34)}>
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
                        fill={props.payload.value === ACTUAL_LABEL ? "#111827" : "#666"}
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
              <div>
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
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-gray-700">Predicting style — {styleMetricMeta[styleMetric].label.toLowerCase()} (% of picks)</h3>
                <div className="flex gap-1">
                  {(["over", "clean", "big"] as const).map((m) => (
                    <Button
                      key={m}
                      size="sm"
                      variant={styleMetric === m ? "default" : "outline"}
                      className="h-7 px-2.5 text-xs"
                      onClick={() => setStyleMetric(m)}
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
                      stroke="#374151"
                      strokeDasharray="5 4"
                      strokeWidth={2}
                      ifOverflow="extendDomain"
                      label={{ value: `Actual ${Math.round(realStyle[styleMetric])}%`, position: "right", fontSize: 10, fill: "#374151" }}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Most common predictions — everyone by default, or one player */}
            {scorelineData.length > 0 && (
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-gray-700">Most common predictions</h3>
                  <Select value={scorelineView} onValueChange={setScorelineView}>
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
            <div>
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
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-gray-700">Weekly points</h3>
                  <div className="flex gap-1">
                    {(["avg", "best", "worst"] as const).map((m) => (
                      <Button
                        key={m}
                        size="sm"
                        variant={weeklyMetric === m ? "default" : "outline"}
                        className="h-7 px-2.5 text-xs"
                        onClick={() => setWeeklyMetric(m)}
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

  // This group's configurable Lawro points (defaults 3/1), fed to the tabs so
  // the client tallies match the group's own scoring rules.
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

  // The Stats tab only appears once gameweek 1 is fully finished.
  // The Stats tab is still a work in progress — kept in the code but hidden for
  // now. Flip this to re-enable it (it also needs at least one finished match).
  const SHOW_STATS_TAB = false;
  const statsAvailable = useMemo(() => matches.some(isFinishedMatch), [matches]);

  // Tendencies needs at least one revealed prediction (a gameweek whose deadline
  // has passed) to have any scorelines to aggregate.
  const tendenciesAvailable = useMemo(
    () => predictions.some((p) => !p.hidden && p.homeScore != null && p.awayScore != null),
    [predictions],
  );

  return (
    <div className="min-h-screen flex flex-col bg-gray-100">
      <Header />
      <main className="container mx-auto px-4 py-6 flex-grow">
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
              {SHOW_STATS_TAB && statsAvailable && (
                <TabsTrigger value="stats" className="text-xs sm:text-sm">Stats</TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="predictions" className="mt-6">
              <PredictionsTab
                matches={matches}
                predictions={predictions as Prediction[]}
                players={players}
                availableGameweeks={availableGameweeks}
                currentGameweek={currentGameweek}
                userId={user?.id}
                jokerEnabled={group?.rules?.lawro.jokerEnabled ?? false}
              />
            </TabsContent>

            <TabsContent value="leaderboard" className="mt-6">
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

            <TabsContent value="table" className="mt-6">
              <PredictedTableTab
                players={players}
                predictions={predictions as Prediction[]}
                matches={matches}
                userId={user?.id}
              />
            </TabsContent>

            {tendenciesAvailable && (
              <TabsContent value="tendencies" className="mt-6">
                <TendenciesTab
                  players={players}
                  predictions={predictions as Prediction[]}
                  matches={matches}
                  points={lawroPoints}
                />
              </TabsContent>
            )}

            {SHOW_STATS_TAB && statsAvailable && (
              <TabsContent value="stats" className="mt-6">
                <StatsTab
                  players={players}
                  predictions={predictions as Prediction[]}
                  matches={matches}
                  availableGameweeks={availableGameweeks}
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
      <section className="bg-white rounded-lg shadow-md overflow-hidden">
        <div className="bg-primary text-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-xl font-bold">Predicted table</h2>
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
    <section className="bg-white rounded-lg shadow-md overflow-hidden">
      <div className="bg-primary text-white p-4"><h2 className="text-xl font-bold">Loading…</h2></div>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-gray-50 border-b">
            <tr>
              {["Name", "Exact", "Correct", "Points"].map((h) => (
                <th key={h} className="px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
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
