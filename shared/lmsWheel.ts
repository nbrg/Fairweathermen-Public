// Last Man Standing randomiser wheel: timing and maths shared by the server
// (which decides the pick at the deadline and keeps it hidden until its wheel
// lands) and the client (which spins every viewer's wheel in sync).
//
// The pick itself is made at the deadline by assignRandomTeams, exactly as
// before. The wheel only reveals it: each missed player gets one wheel, the
// wheels spin one after another starting WHEEL_SPIN_DELAY_MS after the
// deadline, and a pick stays hidden (from everyone, its owner included) until
// its wheel lands. Anyone who opens the site after a wheel has landed and the
// short hold has passed just sees the pick, with no wheel.

export const WHEEL_SPIN_DELAY_MS = 3 * 60 * 1000; // first wheel spins 3:00 after the deadline
export const WHEEL_PUSH_DELAY_MS = 90 * 1000; // push "watch live" 1:30 after the deadline
export const WHEEL_SPIN_MS = 9_000; // one wheel's spin, start to landing
export const WHEEL_HOLD_MS = 6_000; // the result stays on screen this long after landing
export const WHEEL_SLOT_MS = WHEEL_SPIN_MS + WHEEL_HOLD_MS; // next wheel starts when this one's hold ends
// The drawn team is sent to clients this long before its wheel starts, so
// every screen already knows where to land when the spin begins.
export const WHEEL_REVEAL_LEAD_MS = 5_000;
const FULL_TURNS = 6;

export type WheelTimes = { spinStartMs: number; landMs: number; hideMs: number };

// When the i-th missed player's wheel (0-based) spins, lands and disappears.
export function wheelTimes(deadlineMs: number, index: number): WheelTimes {
  const spinStartMs = deadlineMs + WHEEL_SPIN_DELAY_MS + index * WHEEL_SLOT_MS;
  return {
    spinStartMs,
    landMs: spinStartMs + WHEEL_SPIN_MS,
    hideMs: spinStartMs + WHEEL_SLOT_MS,
  };
}

// The wheel's rotation (degrees, clockwise) at `nowMs`. Segment i of n spans
// [i, i+1) * 360/n from the top, and the pointer sits at the top, so landing on
// `targetIndex` means ending with that segment's middle under the pointer. The
// angle depends only on the clock, so everyone watching sees the same frame and
// someone arriving mid-spin joins at the right point.
export function wheelRotation(
  nowMs: number,
  times: Pick<WheelTimes, "spinStartMs" | "landMs">,
  segmentCount: number,
  targetIndex: number,
): number {
  const seg = 360 / Math.max(1, segmentCount);
  const final = FULL_TURNS * 360 + (360 - (targetIndex + 0.5) * seg);
  if (nowMs <= times.spinStartMs) return 0;
  if (nowMs >= times.landMs) return final;
  const t = (nowMs - times.spinStartMs) / (times.landMs - times.spinStartMs);
  // Ease-out quint: fast start, long slow crawl into the result.
  const eased = 1 - Math.pow(1 - t, 5);
  return final * eased;
}

// "Devon", "Devon and Jamie", "Devon, Jamie and Morgan".
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// "in 1 minute", "in 3 minutes": time until the first wheel spins, rounded
// down (so the push at 90s before the spin says 1 minute).
export function spinsIn(msUntilSpin: number): string {
  const mins = Math.floor(Math.max(0, msUntilSpin) / 60_000);
  if (mins < 1) return "in under a minute";
  return `in ${mins} minute${mins === 1 ? "" : "s"}`;
}

// The push sent WHEEL_PUSH_DELAY_MS after the deadline to everyone in the group
// who plays LMS. `missedNames` are the players whose team the wheel will pick;
// `recipientName` is who this copy goes to; `when` is spinsIn(...) for the
// first wheel, e.g. "in 1 minute".
export function wheelPushMessage(
  missedNames: string[],
  recipientName: string,
  gameweek: number,
  when: string,
): { title: string; body: string } {
  const recipientMissed = missedNames.includes(recipientName);
  const others = missedNames.filter((n) => n !== recipientName);
  if (recipientMissed) {
    return {
      title: "🎡 You missed the LMS deadline",
      body:
        others.length === 0
          ? `The wheel picks your Gameweek ${gameweek} team live ${when}. Tap to watch.`
          : `The wheel picks your Gameweek ${gameweek} team live ${when}, along with ${joinNames(others)}'s. Tap to watch.`,
    };
  }
  if (missedNames.length === 1) {
    const [name] = missedNames;
    return {
      title: `🎡 ${name} missed the LMS deadline`,
      body: `Watch the wheel pick ${name}'s Gameweek ${gameweek} team live ${when}`,
    };
  }
  return {
    title: `🎡 ${joinNames(missedNames)} missed the LMS deadline`,
    body: `Watch the wheels pick their Gameweek ${gameweek} teams live ${when}, one at a time`,
  };
}

// HH:MM in UK time.
export function ukClock(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

// What GET /api/lms/wheel returns for one missed player.
export type WheelSpinView = {
  participantId: number;
  userId: number;
  name: string;
  isMe: boolean;
  pool: { teamId: number; name: string; shortName: string }[];
  spinStartMs: number;
  landMs: number;
  hideMs: number;
  // Sent just before the wheel starts spinning (WHEEL_REVEAL_LEAD_MS; it's
  // needed to animate the landing); null before that, or if the deadline job
  // hasn't drawn the team yet.
  teamId: number | null;
  opponent: { shortName: string; isHome: boolean } | null;
};

export type WheelView = {
  serverNow: number;
  gameweek: number;
  deadlineMs: number;
  spins: WheelSpinView[];
};
