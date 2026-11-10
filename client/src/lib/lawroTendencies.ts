// Pure counting helpers for the Lawro Tendencies charts, kept out of the page
// so the rules can be tested directly (tests/lawroTendencies.spec.ts).

export type FinishedScore = { matchId: number; homeScore: number; awayScore: number };
export type Pick = { userId: number; matchId: number; homeScore: number | null; awayScore: number | null; hidden?: boolean };

const sign = (h: number, a: number) => Math.sign(h - a);

// "One off": exactly one of the two scores is right and the other misses by a
// single goal. Predicting 1-1 is one off from 1-0, 0-1, 2-1 or 1-2; 1-0 against
// 0-1 is not (both numbers are wrong), and an exact score is not a miss.
export function isOneOff(predH: number, predA: number, realH: number, realA: number): boolean {
  const dh = Math.abs(predH - realH);
  const da = Math.abs(predA - realA);
  return (dh === 0 && da === 1) || (dh === 1 && da === 0);
}

export function countOneOffs(picks: Pick[], finished: FinishedScore[]): Map<number, number> {
  const byMatch = new Map(finished.map((f) => [f.matchId, f]));
  const out = new Map<number, number>();
  for (const p of picks) {
    if (p.hidden || p.homeScore == null || p.awayScore == null) continue;
    const m = byMatch.get(p.matchId);
    if (!m) continue;
    if (isOneOff(p.homeScore, p.awayScore, m.homeScore, m.awayScore)) {
      out.set(p.userId, (out.get(p.userId) ?? 0) + 1);
    }
  }
  return out;
}

// Matches a player was the only one to call. Per finished match with at least
// two picks: if exactly one player scored any points (right result), they get
// it; otherwise, if exactly one player had the exact score, they get it. Each
// match counts once, as "exact" if their pick was the exact score, else "result".
export type LoneCalls = { exact: number; result: number; total: number };

export function countLoneCalls(picks: Pick[], finished: FinishedScore[]): Map<number, LoneCalls> {
  const byMatch = new Map<number, Pick[]>();
  for (const p of picks) {
    if (p.hidden || p.homeScore == null || p.awayScore == null) continue;
    const a = byMatch.get(p.matchId) ?? [];
    a.push(p);
    byMatch.set(p.matchId, a);
  }
  const out = new Map<number, LoneCalls>();
  for (const m of finished) {
    const ps = byMatch.get(m.matchId);
    if (!ps || ps.length < 2) continue;
    const realSign = sign(m.homeScore, m.awayScore);
    const exact = ps.filter((p) => p.homeScore === m.homeScore && p.awayScore === m.awayScore);
    const result = ps.filter((p) => sign(p.homeScore!, p.awayScore!) === realSign);
    const solo = result.length === 1 ? result[0] : exact.length === 1 ? exact[0] : null;
    if (!solo) continue;
    const isExact = solo.homeScore === m.homeScore && solo.awayScore === m.awayScore;
    const s = out.get(solo.userId) ?? { exact: 0, result: 0, total: 0 };
    if (isExact) s.exact += 1; else s.result += 1;
    s.total += 1;
    out.set(solo.userId, s);
  }
  return out;
}
