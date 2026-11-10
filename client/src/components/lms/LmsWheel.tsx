import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { trackUiEvent } from "@/lib/track";
import { crestFallback, crestFill, useCrestUrl } from "@/components/TeamCrest";
import { useGroup } from "@/contexts/GroupContext";
import { resolveGroupRules } from "@shared/schema";
import { londonStringToUtcMs } from "@shared/time";
import {
  WHEEL_REVEAL_LEAD_MS,
  joinNames,
  wheelRotation,
  type WheelSpinView,
  type WheelView,
} from "@shared/lmsWheel";

// Live randomiser wheel for players who missed the LMS deadline. The server
// has already drawn each pick and keeps it hidden; this counts down to the
// first spin, then spins each missed player's wheel in turn, in sync for every
// viewer (the angle is a function of the server clock, so someone arriving
// mid-spin joins at the right point). Once the last wheel's result has been
// shown it disappears, and anyone arriving later just sees the picks.

type WheelResponse = WheelView | { serverNow: number; spins: [] };

// "Claret & Cream": claret and cream segments with gold dividers, a dark rim
// with gold studs, and each club's crest on a round badge near the rim.
const CLARET = "#6d1a2e";
const CREAM = "#f3ead8";
const GOLD = "#b8935a";
const STUD = "#e9c77b";
const RIM = "#2a2226";

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function possessive(spin: WheelSpinView): string {
  return spin.isMe ? "Your" : `${spin.name}'s`;
}

// One club's crest on a white badge, centred on (cx, cy). Circular crests fill
// more of the badge so every club reads the same size (see crestFill).
function CrestBadge({ team, cx, cy, r }: { team: { name: string; shortName: string }; cx: number; cy: number; r: number }) {
  const url = useCrestUrl(team);
  const fallback = crestFallback(team);
  const size = 2 * r * crestFill(team) * 0.86;
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="#ffffff" stroke={GOLD} strokeWidth={0.8} />
      {url ? (
        <image href={url} x={cx - size / 2} y={cy - size / 2} width={size} height={size} preserveAspectRatio="xMidYMid meet" />
      ) : (
        <>
          <circle cx={cx} cy={cy} r={r * 0.86} fill={fallback.bg} />
          <text x={cx} y={cy} fill={fallback.fg} fontSize={r * 0.62} fontWeight={700} textAnchor="middle" dominantBaseline="central">
            {fallback.initials}
          </text>
        </>
      )}
    </g>
  );
}

function Wheel({ spin, rotation }: { spin: WheelSpinView; rotation: number }) {
  const n = spin.pool.length;
  const r = 100;
  const rimW = 9;
  const seg = (2 * Math.PI) / n;
  // Badges shrink to fit their segment on a full 20-club wheel.
  const badgeR = n === 1 ? 26 : Math.min(14, 0.42 * seg * 76);
  const codeSize = n > 16 ? 9 : 11;
  const colourFor = (i: number) => (n > 1 && n % 2 === 1 && i === n - 1 ? GOLD : i % 2 === 0 ? CLARET : CREAM);
  const textFor = (fill: string) => (fill === CLARET ? CREAM : CLARET);
  const studs = Math.max(8, Math.min(n, 20));
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[300px]">
      <svg viewBox="-118 -118 236 236" className="h-full w-full" role="img"
        aria-label={`${possessive(spin)} wheel: ${spin.pool.map((t) => t.shortName).join(", ")}`}>
        <g transform={`rotate(${rotation})`}>
          {spin.pool.map((t, i) => {
            // Segment i spans [i, i+1) * seg clockwise from the top.
            const a0 = i * seg - Math.PI / 2;
            const a1 = (i + 1) * seg - Math.PI / 2;
            const mid = (a0 + a1) / 2;
            const fill = colourFor(i);
            const path =
              n === 1
                ? `M ${-r} 0 A ${r} ${r} 0 1 1 ${r} 0 A ${r} ${r} 0 1 1 ${-r} 0 Z`
                : `M 0 0 L ${r * Math.cos(a0)} ${r * Math.sin(a0)} A ${r} ${r} 0 ${seg > Math.PI ? 1 : 0} 1 ${r * Math.cos(a1)} ${r * Math.sin(a1)} Z`;
            // Badge near the rim, code nearer the hub; both read upright when
            // the segment stops under the pointer.
            const deg = (mid * 180) / Math.PI + 90;
            const bx = n === 1 ? 0 : 76 * Math.cos(mid), by = n === 1 ? -30 : 76 * Math.sin(mid);
            const lx = n === 1 ? 0 : 50 * Math.cos(mid), ly = n === 1 ? 30 : 50 * Math.sin(mid);
            return (
              <g key={t.teamId}>
                <path d={path} fill={fill} stroke={GOLD} strokeWidth={1} />
                <g transform={n === 1 ? undefined : `rotate(${deg} ${bx} ${by})`}>
                  <CrestBadge team={t} cx={bx} cy={by} r={badgeR} />
                </g>
                <text x={lx} y={ly} fill={textFor(fill)} fontSize={codeSize} fontWeight={700} letterSpacing={0.6}
                  textAnchor="middle" dominantBaseline="central" className="font-display"
                  transform={n === 1 ? undefined : `rotate(${deg} ${lx} ${ly})`}>
                  {t.shortName}
                </text>
              </g>
            );
          })}
        </g>
        {/* Rim with studs, hub and pointer stay still while the wheel turns. */}
        <circle r={r + rimW / 2} fill="none" stroke={RIM} strokeWidth={rimW} />
        {Array.from({ length: studs }, (_, i) => {
          const a = (i / studs) * 2 * Math.PI - Math.PI / 2 + Math.PI / studs;
          return <circle key={i} cx={(r + rimW / 2) * Math.cos(a)} cy={(r + rimW / 2) * Math.sin(a)} r={2} fill={STUD} />;
        })}
        <circle r={17} fill={RIM} />
        <circle r={7} fill={STUD} />
        <path d={`M -11 ${-r - rimW - 8} L 11 ${-r - rimW - 8} L 0 ${-r + 12} Z`} fill={RIM} stroke="#ffffff" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function LmsWheel() {
  const queryClient = useQueryClient();
  const { data, dataUpdatedAt, refetch } = useQuery<WheelResponse>({
    queryKey: ["/api/lms/wheel"],
    queryFn: async () => {
      const res = await fetch("/api/lms/wheel");
      if (!res.ok) throw new Error("Failed to fetch wheel");
      return res.json();
    },
    // Quiet until a wheel is scheduled; then often enough to pick up each
    // drawn team before its spin (an exact refetch is also scheduled below).
    refetchInterval: (q) => ((q.state.data?.spins?.length ?? 0) > 0 ? 4000 : 15000),
    staleTime: 2000,
  });

  // Check again the moment the next LMS deadline passes, rather than waiting up
  // to a poll interval, so the pop-up opens as the deadline ticks over.
  const { group } = useGroup();
  const { data: fixtures } = useQuery<{ gameweek: number | null; matchTime: string | null }[]>({
    queryKey: ["/api/matches"],
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    enabled: (group as any)?.enabledGames?.includes?.("lms") ?? true,
  });
  const lmsOffsetMin = resolveGroupRules((group as any)?.rules).lms.deadlineMinutesBeforeKickoff;
  const nextDeadline = useMemo(() => {
    const first = new Map<number, number>();
    for (const m of fixtures ?? []) {
      if (m.gameweek == null || !m.matchTime) continue;
      const t = londonStringToUtcMs(m.matchTime);
      if (Number.isNaN(t)) continue;
      if (!first.has(m.gameweek) || t < first.get(m.gameweek)!) first.set(m.gameweek, t);
    }
    const upcoming = Array.from(first.values())
      .map((k) => k - lmsOffsetMin * 60_000)
      .filter((d) => d > Date.now())
      .sort((a, b) => a - b);
    return upcoming[0] ?? null;
  }, [fixtures, lmsOffsetMin]);
  useEffect(() => {
    if (nextDeadline == null) return;
    const wait = nextDeadline - Date.now();
    if (wait > 2 ** 31 - 1) return; // setTimeout can't wait longer than ~24 days
    const timers = [1_000, 5_000, 15_000].map((after) => setTimeout(() => refetch(), Math.max(0, wait + after)));
    return () => timers.forEach(clearTimeout);
  }, [nextDeadline, refetch]);

  // Server clock minus ours, so every screen spins on the same timeline.
  const offset = useMemo(
    () => (data && dataUpdatedAt ? data.serverNow - dataUpdatedAt : 0),
    [data, dataUpdatedAt],
  );
  const [now, setNow] = useState(() => Date.now() + offset);
  const frame = useRef<number>();

  const spins = data?.spins ?? [];
  const active = spins.find((s) => now < s.hideMs);
  const spinning = !!active && now >= active.spinStartMs && now < active.landMs;

  // Tick: every animation frame while a wheel turns, once a second otherwise.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (cancelled) return;
      setNow(Date.now() + offset);
      if (spinning) frame.current = requestAnimationFrame(tick);
      else timer = setTimeout(tick, 250);
    };
    tick();
    return () => {
      cancelled = true;
      if (frame.current) cancelAnimationFrame(frame.current);
      if (timer) clearTimeout(timer);
    };
  }, [active?.participantId, spinning, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the drawn team just before each spin, rather than waiting on the poll.
  useEffect(() => {
    if (!active || active.teamId != null) return;
    const due = active.spinStartMs - WHEEL_REVEAL_LEAD_MS + 300 - (Date.now() + offset);
    const t = setTimeout(() => refetch(), Math.max(0, due));
    return () => clearTimeout(t);
  }, [active?.participantId, active?.teamId, offset, refetch]); // eslint-disable-line react-hooks/exhaustive-deps

  // When a wheel lands, reload the picks so the grid shows the drawn team.
  const landedKey = spins.filter((s) => now >= s.landMs).map((s) => s.participantId).join(",");
  useEffect(() => {
    if (!landedKey) return;
    queryClient.invalidateQueries({ queryKey: ["/api/lms/current-competition"] });
  }, [landedKey, queryClient]);

  // Refresh what the page shows when the wheel opens (the deadline has passed,
  // so picks lock) and when it closes (every drawn team is now revealed).
  const open = !!active;
  useEffect(() => {
    for (const key of [["/api/lms/current-competition"], ["/api/lms/available-teams"], ["/api/matches"]]) {
      queryClient.invalidateQueries({ queryKey: key });
    }
    queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/lms/gameweek-status") });
  }, [open, queryClient]);

  // Nothing behind the pop-up scrolls while it's up.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);
  // Record who watched which wheel and how far they got (countdown → spinning
  // → result), once per wheel and stage, for /admin/activity and /admin/audit.
  // Only while the page is actually on screen.
  const phase = !active
    ? null
    : now >= active.landMs
      ? "result"
      : spinning
        ? "spinning"
        : "countdown";
  const logged = useRef(new Set<string>());
  const gameweek = data && "gameweek" in data ? data.gameweek : null;
  useEffect(() => {
    if (!active || !phase) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const key = `${active.participantId}:${phase}`;
    if (logged.current.has(key)) return;
    logged.current.add(key);
    trackUiEvent("wheel_view", {
      gameweek,
      wheelOf: active.isMe ? null : active.name,
      own: active.isMe,
      phase,
    });
  }, [active?.participantId, phase, gameweek]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active) return null;

  const first = spins[0];
  const beforeFirst = now < first.spinStartMs;
  const queue = spins.filter((s) => s.spinStartMs > active.spinStartMs);
  const landed = now >= active.landMs;
  const targetIndex = active.teamId != null ? active.pool.findIndex((t) => t.teamId === active.teamId) : -1;
  const rotation =
    targetIndex >= 0 ? wheelRotation(now, active, active.pool.length, targetIndex) : spinning ? ((now - active.spinStartMs) / 2) % 360 : 0;
  const drawn = targetIndex >= 0 ? active.pool[targetIndex] : null;
  const missedNames = spins.map((s) => (s.isMe ? "You" : s.name));

  // A pop-up over the whole site that can't be dismissed: it opens as the
  // deadline passes and closes itself once the last wheel's result has shown.
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lms-wheel-heading"
      data-testid="lms-wheel"
    >
      <div className="max-h-full w-full max-w-sm overflow-y-auto rounded-2xl bg-card p-5 text-card-foreground shadow-2xl">
        <div className="text-center">
          <p className="eyebrow text-muted-foreground">
            Randomiser wheel · Gameweek {data && "gameweek" in data ? data.gameweek : ""}
          </p>
          {beforeFirst ? (
            <>
              <h2 id="lms-wheel-heading" className="font-display mt-1 text-2xl font-bold uppercase leading-tight">
                {joinNames(missedNames)} missed the deadline
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {spins.length === 1 ? "The wheel spins live in" : "The wheels spin live, one at a time, in"}
              </p>
              <p className="font-display mt-1 text-5xl font-bold tabular-nums" data-testid="lms-wheel-countdown" aria-live="off">
                {formatCountdown(first.spinStartMs - now)}
              </p>
            </>
          ) : (
            <h2 id="lms-wheel-heading" className="font-display mt-1 text-2xl font-bold uppercase" data-testid="lms-wheel-title">
              {possessive(active)} wheel
            </h2>
          )}
        </div>

        <div className="mt-4">
          <Wheel spin={active} rotation={rotation} />
        </div>

        <div className="mt-4 min-h-[3rem] text-center" aria-live="polite">
          {landed && drawn ? (
            <p className="text-base font-semibold" data-testid="lms-wheel-result">
              {active.isMe ? "You get" : `${active.name} gets`} {drawn.name}
              {active.opponent && (
                <span className="font-normal text-muted-foreground">
                  {" "}({active.opponent.isHome ? "H" : "A"} v {active.opponent.shortName})
                </span>
              )}
            </p>
          ) : spinning ? (
            <p className="text-sm text-muted-foreground">Spinning…</p>
          ) : !beforeFirst ? (
            <p className="text-sm text-muted-foreground">Spins in {formatCountdown(active.spinStartMs - now)}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {possessive(active)} wheel: the {active.pool.length} team{active.pool.length === 1 ? "" : "s"} left to pick from
            </p>
          )}
          {queue.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Up next: {queue.map((s) => (s.isMe ? "you" : s.name)).join(", then ")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
