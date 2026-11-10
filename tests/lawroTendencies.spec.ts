import { test, expect } from "@playwright/test";
import { isOneOff, countOneOffs, countLoneCalls } from "../client/src/lib/lawroTendencies";

// Pure rules behind the Lawro Tendencies "Most one-offs" and lone-call charts.
test.describe("Lawro tendencies counting", () => {
  test("one-off means one score right and the other off by one", () => {
    // Alex's examples: 1-1 is one off from 1-0, 0-1, 2-1 and 1-2.
    for (const [h, a] of [[1, 0], [0, 1], [2, 1], [1, 2]]) expect(isOneOff(1, 1, h, a)).toBe(true);
    // 1-0 against 0-1: both scores wrong, so not one off.
    expect(isOneOff(1, 0, 0, 1)).toBe(false);
    expect(isOneOff(2, 1, 2, 1)).toBe(false); // exact isn't a miss
    expect(isOneOff(2, 1, 2, 3)).toBe(false); // off by two
    expect(isOneOff(1, 0, 2, 1)).toBe(false); // both off by one
    const counts = countOneOffs(
      [
        { userId: 1, matchId: 10, homeScore: 1, awayScore: 1 },
        { userId: 1, matchId: 11, homeScore: 2, awayScore: 0 },
        { userId: 2, matchId: 10, homeScore: 0, awayScore: 1 },
        { userId: 2, matchId: 12, homeScore: 1, awayScore: 0 }, // unfinished match
        { userId: 3, matchId: 10, homeScore: null, awayScore: null, hidden: true },
      ],
      [{ matchId: 10, homeScore: 1, awayScore: 0 }, { matchId: 11, homeScore: 3, awayScore: 0 }],
    );
    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBeUndefined();
    expect(counts.get(3)).toBeUndefined();
  });

  test("a lone call is the only right result, or else the only exact score", () => {
    const finished = [
      { matchId: 1, homeScore: 2, awayScore: 1 }, // only A has the result (exact)
      { matchId: 2, homeScore: 0, awayScore: 0 }, // only B has the result (not exact)
      { matchId: 3, homeScore: 1, awayScore: 0 }, // both have the result, only B exact
      { matchId: 4, homeScore: 3, awayScore: 0 }, // A and B both right, nobody exact
      { matchId: 5, homeScore: 1, awayScore: 1 }, // only one pick: doesn't count
    ];
    const picks = [
      { userId: 1, matchId: 1, homeScore: 2, awayScore: 1 },
      { userId: 2, matchId: 1, homeScore: 0, awayScore: 1 },
      { userId: 1, matchId: 2, homeScore: 2, awayScore: 0 },
      { userId: 2, matchId: 2, homeScore: 1, awayScore: 1 },
      { userId: 1, matchId: 3, homeScore: 2, awayScore: 0 },
      { userId: 2, matchId: 3, homeScore: 1, awayScore: 0 },
      { userId: 1, matchId: 4, homeScore: 1, awayScore: 0 },
      { userId: 2, matchId: 4, homeScore: 2, awayScore: 0 },
      { userId: 1, matchId: 5, homeScore: 1, awayScore: 1 },
    ];
    const c = countLoneCalls(picks, finished);
    expect(c.get(1)).toEqual({ exact: 1, result: 0, total: 1 });
    expect(c.get(2)).toEqual({ exact: 1, result: 1, total: 2 });
  });
});
