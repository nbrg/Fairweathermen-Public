import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Check, Lock } from "lucide-react";
import { londonStringToUtcMs } from "@shared/time";
import { TeamCrest } from "@/components/TeamCrest";
import type { Match, Team } from "@shared/schema";

type GwMatch = Match & { homeTeam: Team; awayTeam: Team };

// "FRI 21 AUG · 20:00" from a naive London-local match_time string.
function formatKickoff(matchTime: string): string {
  const ms = londonStringToUtcMs(matchTime);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${day} · ${time}`.toUpperCase();
}

// One team option. Defined at module scope (NOT inside TeamPickerDialog) so its
// component identity is stable across renders — a nested component definition
// gets a fresh identity every render, which makes React unmount/remount every
// button (and every crest inside) on each re-render, blinking the whole grid.
function TeamButton({
  team,
  isCurrent,
  isUsed,
  disabled,
  onPick,
  onClear,
}: {
  team: Team;
  isCurrent: boolean;
  isUsed: boolean;
  disabled: boolean;
  onPick: (teamId: number) => void;
  onClear: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={isCurrent}
      onClick={() => (isCurrent ? onClear() : onPick(team.id))}
      className={`group relative flex h-[76px] flex-col items-center justify-center gap-1.5 rounded-xl border px-2 text-center transition-all ${
        isCurrent
          ? "border-primary bg-primary text-white shadow-sm shadow-primary/30"
          : isUsed
            ? "border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed"
            : "border-gray-200 bg-white text-gray-900 hover:-translate-y-0.5 hover:border-primary hover:shadow-md active:translate-y-0 disabled:opacity-50"
      }`}
    >
      {isCurrent && (
        <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-white text-primary">
          <Check className="h-3 w-3" strokeWidth={3} />
        </span>
      )}
      <span className={isUsed ? "opacity-40 grayscale" : ""}>
        <TeamCrest team={team} size={30} />
      </span>
      <span className="text-[13px] font-semibold leading-tight">{team.name}</span>
      {isUsed && <span className="text-[9px] font-semibold uppercase tracking-wide">Used</span>}
      {isCurrent && (
        <span className="text-[9px] font-medium uppercase tracking-wide opacity-90">
          Tap to clear
        </span>
      )}
    </button>
  );
}

// A visual, matchup-based team picker for Last Man Standing. Shows the
// gameweek's fixtures as cards (kickoff + the two teams), and you tap the team
// you think will win. Teams you've already used earlier in this competition are
// greyed out and unselectable; your current pick is highlighted.
export function TeamPickerDialog({
  open,
  onOpenChange,
  gameweek,
  matches,
  usedTeamIds,
  currentTeamId,
  locked,
  busy,
  onPick,
  onClear,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  gameweek: number;
  matches: GwMatch[];
  usedTeamIds: Set<number>;
  currentTeamId: number | undefined;
  locked: boolean;
  busy: boolean;
  onPick: (teamId: number) => void;
  onClear: () => void;
}) {
  const sorted = [...matches].sort(
    (a, b) =>
      (londonStringToUtcMs(a.matchTime) || 0) - (londonStringToUtcMs(b.matchTime) || 0) ||
      a.id - b.id,
  );
  const deadlineLabel = sorted.length ? formatKickoff(sorted[0].matchTime) : "";

  const renderTeam = (team: Team) => {
    const isCurrent = team.id === currentTeamId;
    const isUsed = usedTeamIds.has(team.id) && !isCurrent;
    return (
      <TeamButton
        team={team}
        isCurrent={isCurrent}
        isUsed={isUsed}
        disabled={locked || busy || isUsed}
        onPick={onPick}
        onClear={onClear}
      />
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-md [&>button]:z-20">
        <DialogHeader className="sticky top-0 z-10 border-b bg-gradient-to-b from-primary/10 to-background p-4 pr-12 text-left">
          <DialogTitle className="text-lg font-extrabold uppercase tracking-wide">
            Gameweek {gameweek}
          </DialogTitle>
          {deadlineLabel && (
            <p className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-500">
              <Lock className="h-3 w-3" />
              Locks {deadlineLabel}
            </p>
          )}
        </DialogHeader>

        <div className="space-y-2.5 bg-gray-50/60 p-3">
          {locked && (
            <p className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              <Lock className="h-4 w-4 shrink-0" />
              Selections are locked — the gameweek has started.
            </p>
          )}

          {!locked && sorted.length > 0 && (
            <p className="px-0.5 text-center text-xs text-gray-500">
              Tap the team you think will win.
            </p>
          )}

          {sorted.length === 0 ? (
            <p className="text-sm text-gray-500">No fixtures for this gameweek yet.</p>
          ) : (
            sorted.map((m) => (
              <div
                key={m.id}
                className="rounded-2xl border border-gray-200 bg-white p-2.5 shadow-sm"
              >
                <div className="mb-1.5 text-center text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {formatKickoff(m.matchTime)}
                </div>
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                  {renderTeam(m.homeTeam)}
                  <span className="text-[10px] font-bold uppercase text-gray-300">v</span>
                  {renderTeam(m.awayTeam)}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
