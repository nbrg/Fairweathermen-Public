import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { apiRequest } from '@/lib/queryClient';

const teamA = { name: "The Ringers", fullName: "The Ringers", players: ['Noah', 'Alex', 'Jordan'] };
const teamB = { name: "2½ Golfers", fullName: "2½ Golfers", players: ['Casey', 'Blake', 'Morgan'] };

const handicaps: Record<string, number> = { Casey: 13, Noah: 13, Blake: 13, Morgan: 29, Alex: 27, Jordan: 29 };

function getScoreDisplay(score: number | null, par: number): { display: string; className: string } {
  if (score == null) return { display: '', className: 'w-8 h-8 flex items-center justify-center' };
  const diff = score - par;
  if (diff <= -2) return { display: score.toString(), className: 'w-7 h-7 border-2 border-red-700 rounded-full flex items-center justify-center eagle-double-circle text-xs' };
  if (diff === -1) return { display: score.toString(), className: 'w-8 h-8 border-2 border-green-600 rounded-full bg-green-200 dark:bg-green-800 flex items-center justify-center' };
  if (diff === 0) return { display: score.toString(), className: 'w-8 h-8 flex items-center justify-center' };
  if (diff === 1) return { display: score.toString(), className: 'w-8 h-8 border-2 border-orange-500 bg-yellow-200 dark:bg-yellow-800 flex items-center justify-center' };
  return { display: score.toString(), className: 'w-7 h-7 border-2 border-orange-500 bg-orange-200 dark:bg-orange-800 flex items-center justify-center double-bogey-double-square text-xs' };
}

const blueHoles = [
  { number: 1, par: 4, yardage: 346, strokeIndex: 8 },
  { number: 2, par: 3, yardage: 186, strokeIndex: 3 },
  { number: 3, par: 4, yardage: 328, strokeIndex: 5 },
  { number: 4, par: 5, yardage: 454, strokeIndex: 2 },
  { number: 5, par: 4, yardage: 398, strokeIndex: 1 },
  { number: 6, par: 4, yardage: 350, strokeIndex: 4 },
  { number: 7, par: 5, yardage: 509, strokeIndex: 6 },
  { number: 8, par: 3, yardage: 140, strokeIndex: 9 },
  { number: 9, par: 4, yardage: 353, strokeIndex: 7 },
];

const yellowHoles = [
  { number: 1, par: 5, yardage: 509, strokeIndex: 2 },
  { number: 2, par: 3, yardage: 191, strokeIndex: 3 },
  { number: 3, par: 5, yardage: 457, strokeIndex: 1 },
  { number: 4, par: 3, yardage: 138, strokeIndex: 8 },
  { number: 5, par: 5, yardage: 465, strokeIndex: 4 },
  { number: 6, par: 3, yardage: 116, strokeIndex: 9 },
  { number: 7, par: 4, yardage: 337, strokeIndex: 7 },
  { number: 8, par: 4, yardage: 322, strokeIndex: 5 },
  { number: 9, par: 4, yardage: 350, strokeIndex: 6 },
];

const greenHoles = [
  { number: 1, par: 4, yardage: 334, strokeIndex: 7 },
  { number: 2, par: 3, yardage: 155, strokeIndex: 6 },
  { number: 3, par: 5, yardage: 498, strokeIndex: 5 },
  { number: 4, par: 4, yardage: 303, strokeIndex: 9 },
  { number: 5, par: 4, yardage: 367, strokeIndex: 4 },
  { number: 6, par: 3, yardage: 132, strokeIndex: 8 },
  { number: 7, par: 4, yardage: 398, strokeIndex: 2 },
  { number: 8, par: 5, yardage: 521, strokeIndex: 3 },
  { number: 9, par: 4, yardage: 442, strokeIndex: 1 },
];

const matchConfig = {
  match1: { holes: blueHoles, courseName: 'Blue', points: 2, format: 'Scramble (Stroke Play)' },
  match2: { holes: yellowHoles, courseName: 'Yellow', points: 4, format: 'Split Singles' },
  match3: { holes: blueHoles, courseName: 'Blue', points: 3, format: 'Pairs Match Play' },
  match4: { holes: yellowHoles, courseName: 'Yellow', points: 1, format: 'Singles Match Play' },
};

type ScoreMap = Record<string, Record<number, number>>;

interface FairweathermanCupProps {
  tournament: { id: number; name: string; courseId: string; status: string } | null;
}


function getHandicapStrokesForHole(handicap: number, lowestHandicap: number, strokeIndex: number): number {
  const diff = handicap - lowestHandicap;
  if (diff <= 0) return 0;
  const halfDiff = Math.round(diff / 2);
  if (halfDiff >= strokeIndex) {
    return 1 + Math.floor((halfDiff - strokeIndex) / 9);
  }
  return 0;
}

function renderHandicapDots(handicap: number, lowestHandicap: number, strokeIndex: number): JSX.Element {
  const strokes = getHandicapStrokesForHole(handicap, lowestHandicap, strokeIndex);
  if (strokes === 0) return <div className="h-2"></div>;
  return (
    <div className="flex justify-center gap-0.5 h-2">
      {Array.from({ length: strokes }, (_, i) => (
        <div key={i} className="w-1 h-1 bg-black dark:bg-white rounded-full"></div>
      ))}
    </div>
  );
}

export default function FairweathermanCup({ tournament }: FairweathermanCupProps) {
  const [currentTab, setCurrentTab] = useState<'match1' | 'match2' | 'match3' | 'match4' | 'leaderboard' | 'pl'>('leaderboard');
  const queryClient = useQueryClient();

  const { data: dbScores } = useQuery({
    queryKey: ['/api/golf/tournaments', tournament?.id, 'scores'],
    queryFn: async () => {
      const response = await fetch(`/api/golf/tournaments/${tournament?.id}/scores`);
      return response.json();
    },
    enabled: !!tournament?.id,
  });

  const saveScoreMutation = useMutation({
    mutationFn: async ({ tournamentId, playerName, hole, day, score }: {
      tournamentId: number; playerName: string; hole: number; day: number; score: number;
    }) => {
      const response = await apiRequest('POST', '/api/golf/scores', { tournamentId, playerName, hole, day, score });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/golf/tournaments', tournament?.id, 'scores'] });
    },
  });

  const deleteScoreMutation = useMutation({
    mutationFn: async ({ tournamentId, playerName, hole, day }: {
      tournamentId: number; playerName: string; hole: number; day: string;
    }) => {
      const response = await apiRequest('DELETE', '/api/golf/scores', { tournamentId, playerName, hole, day });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/golf/tournaments', tournament?.id, 'scores'] });
    },
  });

  const { data: dbPrizeWinners } = useQuery({
    queryKey: ['/api/golf/tournaments', tournament?.id, 'prize-winners'],
    queryFn: async () => {
      const response = await fetch(`/api/golf/tournaments/${tournament?.id}/prize-winners`);
      return response.json();
    },
    enabled: !!tournament?.id,
  });

  const prizeWinners: Record<string, string> = React.useMemo(() => {
    const winners: Record<string, string> = {};
    if (dbPrizeWinners) {
      dbPrizeWinners.forEach((w: any) => { winners[w.prizeKey] = w.winnerName; });
    }
    return winners;
  }, [dbPrizeWinners]);

  const savePrizeWinnerMutation = useMutation({
    mutationFn: async ({ tournamentId, prizeKey, winnerName }: { tournamentId: number; prizeKey: string; winnerName: string }) => {
      const response = await apiRequest('POST', '/api/golf/prize-winners', { tournamentId, prizeKey, winnerName });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/golf/tournaments', tournament?.id, 'prize-winners'] });
    },
  });

  const allCupPlayers = ['Casey', 'Noah', 'Blake', 'Alex', 'Morgan', 'Jordan'];

  const getScore = (playerName: string, hole: number, matchDay: number): number | null => {
    if (!dbScores) return null;
    const score = dbScores.find((s: any) => s.playerName === playerName && s.hole === hole && s.day === matchDay);
    return score ? score.score : null;
  };

  const handleScoreChange = (playerName: string, hole: number, matchDay: number, value: string) => {
    if (!tournament) return;
    if (value === '' || value === '0') {
      if (getScore(playerName, hole, matchDay) !== null) {
        deleteScoreMutation.mutate({ tournamentId: tournament.id, playerName, hole, day: String(matchDay) });
      }
      return;
    }
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue) && numValue > 0 && numValue <= 20) {
      saveScoreMutation.mutate({ tournamentId: tournament.id, playerName, hole, day: matchDay, score: numValue });
    }
  };

  const handleScoreKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, playerName: string, hole: number, matchDay: number) => {
    if (!tournament) return;
    const input = e.currentTarget;
    if ((e.key === 'Backspace' || e.key === 'Delete') && (input.value === '' || input.value.length <= 1)) {
      if (getScore(playerName, hole, matchDay) !== null) {
        deleteScoreMutation.mutate({ tournamentId: tournament.id, playerName, hole, day: String(matchDay) });
      }
    }
  };

  const getMatchScores = (matchDay: number): ScoreMap => {
    const result: ScoreMap = {};
    if (!dbScores) return result;
    dbScores.forEach((s: any) => {
      if (s.day === matchDay) {
        if (!result[s.playerName]) result[s.playerName] = {};
        result[s.playerName][s.hole] = s.score;
      }
    });
    return result;
  };

  const scrambleHandicapShots = 2;

  const getScrambleShotsOnHole = (strokeIndex: number): number => {
    if (scrambleHandicapShots >= strokeIndex) {
      return 1 + Math.floor((scrambleHandicapShots - strokeIndex) / 9);
    }
    return 0;
  };

  const calculateMatch1Result = () => {
    const scores = getMatchScores(1);
    const holes = matchConfig.match1.holes;
    const teamAScores = scores[teamA.name] || {};
    const teamBScores = scores[teamB.name] || {};
    let totalA = 0, totalB = 0;
    let netTotalA = 0, netTotalB = 0;
    let countA = 0, countB = 0;
    for (const hole of holes) {
      const h = hole.number;
      if (teamAScores[h]) {
        totalA += teamAScores[h];
        netTotalA += teamAScores[h] - getScrambleShotsOnHole(hole.strokeIndex);
        countA++;
      }
      if (teamBScores[h]) {
        totalB += teamBScores[h];
        netTotalB += teamBScores[h];
        countB++;
      }
    }
    if (countA === 0 && countB === 0) return null;
    return { totalA, totalB, netTotalA, netTotalB, countA, countB };
  };

  const calculateMatchPlayStatus = (
    playersA: string[], playersB: string[], matchDay: number,
    holes: typeof blueHoles, useBetterBall: boolean,
    handicapOverrides?: Record<string, number>
  ) => {
    const scores = getMatchScores(matchDay);
    const getHcap = (p: string) => handicapOverrides?.[p] ?? handicaps[p] ?? 0;
    const lowestHandicap = Math.min(...[...playersA, ...playersB].map(p => getHcap(p)));
    let statusA = 0;
    let holesPlayed = 0;
    const holeResults: { hole: number; netA: number | null; netB: number | null; result: string }[] = [];

    for (const hole of holes) {
      let bestNetA: number | null = null;
      let bestNetB: number | null = null;

      for (const player of playersA) {
        const gross = scores[player]?.[hole.number];
        if (gross != null) {
          const shot = getHandicapStrokesForHole(getHcap(player), lowestHandicap, hole.strokeIndex);
          const net = gross - shot;
          if (bestNetA === null || net < bestNetA) bestNetA = net;
        }
      }
      for (const player of playersB) {
        const gross = scores[player]?.[hole.number];
        if (gross != null) {
          const shot = getHandicapStrokesForHole(getHcap(player), lowestHandicap, hole.strokeIndex);
          const net = gross - shot;
          if (bestNetB === null || net < bestNetB) bestNetB = net;
        }
      }

      if (bestNetA !== null && bestNetB !== null) {
        holesPlayed++;
        if (bestNetA < bestNetB) {
          statusA++;
          holeResults.push({ hole: hole.number, netA: bestNetA, netB: bestNetB, result: 'A' });
        } else if (bestNetB < bestNetA) {
          statusA--;
          holeResults.push({ hole: hole.number, netA: bestNetA, netB: bestNetB, result: 'B' });
        } else {
          holeResults.push({ hole: hole.number, netA: bestNetA, netB: bestNetB, result: 'halved' });
        }
      } else {
        holeResults.push({ hole: hole.number, netA: bestNetA, netB: bestNetB, result: 'pending' });
      }
    }

    const holesRemaining = 9 - holesPlayed;
    let matchOver = false;
    let resultText = 'A/S';

    if (holesPlayed === 9) {
      matchOver = true;
      if (statusA > 0) resultText = `${teamA.name} win`;
      else if (statusA < 0) resultText = `${teamB.name} win`;
      else resultText = 'Halved';
    } else if (Math.abs(statusA) > holesRemaining && holesPlayed > 0) {
      matchOver = true;
      const lead = Math.abs(statusA);
      const winner = statusA > 0 ? teamA.name : teamB.name;
      resultText = `${winner} win ${lead}&${holesRemaining}`;
    } else {
      if (statusA > 0) resultText = `${teamA.name} ${statusA}UP`;
      else if (statusA < 0) resultText = `${teamB.name} ${Math.abs(statusA)}UP`;
      else resultText = 'A/S';
    }

    return { statusA, holesPlayed, holesRemaining, matchOver, resultText, holeResults };
  };

  const calculateMatch4Singles = () => {
    const holes = matchConfig.match4.holes;
    const match1 = calculateMatchPlayStatus(['Alex'], ['Blake'], 4, holes, false);
    const match2 = calculateMatchPlayStatus(['Noah'], ['Casey'], 4, holes, false);
    return { match1, match2 };
  };

  const calculateLeaderboardPoints = () => {
    let teamAPoints = 0;
    let teamBPoints = 0;
    const results: { match: string; matchSub?: string; format: string; points: number; winner: string | null; detail: string }[] = [];

    const m1 = calculateMatch1Result();
    if (m1 && m1.countA === 9 && m1.countB === 9) {
      if (m1.netTotalA < m1.netTotalB) {
        teamAPoints += 2;
        results.push({ match: 'Match 1', format: 'Scramble', points: 2, winner: 'A', detail: `${teamA.name} wins (${m1.netTotalA} vs ${m1.netTotalB})` });
      } else if (m1.netTotalB < m1.netTotalA) {
        teamBPoints += 2;
        results.push({ match: 'Match 1', format: 'Scramble', points: 2, winner: 'B', detail: `${teamB.name} wins (${m1.netTotalA} vs ${m1.netTotalB})` });
      } else {
        teamAPoints += 1; teamBPoints += 1;
        results.push({ match: 'Match 1', format: 'Scramble', points: 2, winner: 'tied', detail: `Halved (${m1.netTotalA} vs ${m1.netTotalB})` });
      }
    } else {
      results.push({ match: 'Match 1', format: 'Scramble', points: 2, winner: null, detail: 'In progress' });
    }

    const m2matches = [
      { label: 'Match 2a', sub: 'Noah vs Morgan', a: 'Noah', b: 'Morgan', aTeam: 'A' },
      { label: 'Match 2b', sub: 'Noah vs Blake', a: 'Noah', b: 'Blake', aTeam: 'A' },
      { label: 'Match 2c', sub: 'Alex vs Casey', a: 'Alex', b: 'Casey', aTeam: 'A' },
      { label: 'Match 2d', sub: 'Jordan vs Casey', a: 'Jordan', b: 'Casey', aTeam: 'A' },
    ];
    for (const mm of m2matches) {
      const mResult = calculateSinglesMatchPlay(mm.a, mm.b, 2, matchConfig.match2.holes);
      const teamAIsA = teamA.players.includes(mm.a);
      if (mResult.matchOver) {
        if ((mResult.statusA > 0 && teamAIsA) || (mResult.statusA < 0 && !teamAIsA)) {
          teamAPoints += 1;
          results.push({ match: mm.label, matchSub: mm.sub, format: 'Split Singles', points: 1, winner: 'A', detail: mResult.resultText });
        } else if ((mResult.statusA < 0 && teamAIsA) || (mResult.statusA > 0 && !teamAIsA)) {
          teamBPoints += 1;
          results.push({ match: mm.label, matchSub: mm.sub, format: 'Split Singles', points: 1, winner: 'B', detail: mResult.resultText });
        } else {
          teamAPoints += 0.5; teamBPoints += 0.5;
          results.push({ match: mm.label, matchSub: mm.sub, format: 'Split Singles', points: 1, winner: 'tied', detail: 'Halved' });
        }
      } else {
        results.push({ match: mm.label, matchSub: mm.sub, format: 'Split Singles', points: 1, winner: null, detail: mResult.holesPlayed > 0 ? mResult.resultText : 'Not started' });
      }
    }

    const match3Handicaps = { Alex: 12, Noah: 0, Casey: 0, Blake: 0 };
    const m3 = calculateMatchPlayStatus(['Alex', 'Noah'], ['Casey', 'Blake'], 3, matchConfig.match3.holes, true, match3Handicaps);
    if (m3.matchOver) {
      if (m3.statusA > 0) {
        teamAPoints += 3;
        results.push({ match: 'Match 3', format: 'Pairs MP', points: 3, winner: 'A', detail: m3.resultText });
      } else if (m3.statusA < 0) {
        teamBPoints += 3;
        results.push({ match: 'Match 3', format: 'Pairs MP', points: 3, winner: 'B', detail: m3.resultText });
      } else {
        teamAPoints += 1.5; teamBPoints += 1.5;
        results.push({ match: 'Match 3', format: 'Pairs MP', points: 3, winner: 'tied', detail: 'Halved' });
      }
    } else {
      results.push({ match: 'Match 3', format: 'Pairs MP', points: 3, winner: null, detail: m3.holesPlayed > 0 ? m3.resultText : 'Not started' });
    }

    results.push({ match: 'Match 4a', matchSub: 'Alex vs Blake', format: 'Singles MP', points: 1, winner: null, detail: 'Not played' });
    results.push({ match: 'Match 4b', matchSub: 'Noah vs Casey', format: 'Singles MP', points: 1, winner: null, detail: 'Not played' });

    teamAPoints += 1;
    results.push({ match: 'Match 5', matchSub: 'Padel', format: 'Best of 3', points: 1, winner: 'A', detail: `${teamA.name} wins` });

    return { teamAPoints, teamBPoints, results };
  };

  const tabs = [
    { key: 'match1' as const, label: 'Match 1' },
    { key: 'match2' as const, label: 'Match 2' },
    { key: 'match3' as const, label: 'Match 3' },
    { key: 'match4' as const, label: 'Match 4' },
    { key: 'leaderboard' as const, label: 'Leaderboard' },
    { key: 'pl' as const, label: 'P/L' },
  ];

  const renderScrambleScorecard = () => {
    const holes = matchConfig.match1.holes;
    const totalPar = holes.reduce((sum, h) => sum + h.par, 0);
    const m1 = calculateMatch1Result();

    return (
      <div>
        <div className="text-center mb-3">
          <span className="text-xs text-gray-500 dark:text-gray-400">3-Man Scramble • Stroke Play • 2 Points • Blue Course</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs sm:text-sm">
            <thead>
              <tr className="bg-gray-100 dark:bg-gray-700">
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8">Hole</th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8 bg-yellow-100 dark:bg-yellow-900">Yds</th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8">Par</th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-6">SI</th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-semibold bg-blue-50 dark:bg-blue-900/30 text-[11px] sm:text-sm">
                  {teamA.name}
                </th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-semibold bg-red-50 dark:bg-red-900/30 text-[11px] sm:text-sm">
                  {teamB.name}
                </th>
              </tr>
            </thead>
            <tbody>
              {holes.map(hole => {
                const scoreA = getScore(teamA.name, hole.number, 1);
                const scoreB = getScore(teamB.name, hole.number, 1);
                const shotsOnHole = getScrambleShotsOnHole(hole.strokeIndex);
                return (
                  <tr key={hole.number} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center font-bold">{hole.number}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center text-gray-500 bg-yellow-50 dark:bg-yellow-900/20">{hole.yardage}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center font-medium">{hole.par}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center text-gray-500 text-[10px]">{hole.strokeIndex}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-blue-50/50 dark:bg-blue-900/10">
                      <div>
                        <div className="flex items-center justify-center">
                          <div className={getScoreDisplay(scoreA, hole.par).className}>
                            <span className="text-sm font-medium text-gray-900 dark:text-white">
                              {scoreA ?? ''}
                            </span>
                          </div>
                        </div>
                        <div className="flex justify-center mt-0.5">
                          {shotsOnHole > 0 ? (
                            <div className="flex justify-center gap-0.5 h-2">
                              {Array.from({ length: shotsOnHole }, (_, i) => (
                                <div key={i} className="w-1 h-1 bg-black dark:bg-white rounded-full"></div>
                              ))}
                            </div>
                          ) : <div className="h-2"></div>}
                        </div>
                      </div>
                    </td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-red-50/50 dark:bg-red-900/10">
                      <div className="flex items-center justify-center">
                        <div className={getScoreDisplay(scoreB, hole.par).className}>
                          <span className="text-sm font-medium text-gray-900 dark:text-white">
                            {scoreB ?? ''}
                          </span>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-gray-200 dark:bg-gray-600 font-bold">
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">Tot</td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-yellow-200 dark:bg-yellow-700">{holes.reduce((s, h) => s + h.yardage, 0)}</td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">{totalPar}</td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center"></td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-blue-100 dark:bg-blue-900/40">
                  {m1 && m1.countA > 0 ? (
                    <div>
                      <div>{m1.totalA}</div>
                      <div className="text-[10px] text-gray-500">(Net: {m1.netTotalA})</div>
                    </div>
                  ) : '-'}
                </td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-red-100 dark:bg-red-900/40">
                  {m1 && m1.countB > 0 ? m1.totalB : '-'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {m1 && m1.countA === 9 && m1.countB === 9 && (
          <div className="mt-3 text-center">
            <div className={`inline-block px-4 py-2 rounded-lg font-bold ${
              m1.netTotalA < m1.netTotalB ? 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200' :
              m1.netTotalB < m1.netTotalA ? 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200' :
              'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200'
            }`}>
              {m1.netTotalA < m1.netTotalB ? `${teamA.fullName} win (+2 pts)` :
               m1.netTotalB < m1.netTotalA ? `${teamB.fullName} win (+2 pts)` :
               'Tied - 1 point each'}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderMatchPlayScorecard = (
    playersA: string[], playersB: string[], matchDay: number,
    holes: typeof blueHoles, title: string, pointsAvailable: number,
    handicapOverrides?: Record<string, number>
  ) => {
    const allPlayers = [...playersA, ...playersB];
    const getHcap = (p: string) => handicapOverrides?.[p] ?? handicaps[p] ?? 0;
    const lowestHandicap = Math.min(...allPlayers.map(p => getHcap(p)));
    const status = calculateMatchPlayStatus(playersA, playersB, matchDay, holes, playersA.length > 1, handicapOverrides);
    const totalPar = holes.reduce((sum, h) => sum + h.par, 0);

    return (
      <div>
        <div className="text-center mb-3">
          <span className="text-xs text-gray-500 dark:text-gray-400">{title}</span>
        </div>
        {status.holesPlayed > 0 && (
          <div className="text-center mb-3">
            <div className={`inline-block px-4 py-2 rounded-lg font-bold text-sm ${
              status.matchOver
                ? status.statusA > 0 ? 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200'
                : status.statusA < 0 ? 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200'
                : 'bg-gray-100 dark:bg-gray-700'
                : 'bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200'
            }`}>
              {status.resultText}
              {status.matchOver && (status.statusA === 0
                ? ` (${pointsAvailable / 2} pts each)`
                : ` (+${pointsAvailable} pts)`)}
            </div>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs sm:text-sm">
            <thead>
              <tr className="bg-gray-100 dark:bg-gray-700">
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8">Hole</th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8 bg-yellow-100 dark:bg-yellow-900">Yds</th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8">Par</th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-6">SI</th>
                {allPlayers.map(p => (
                  <th key={p} className={`border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold ${
                    playersA.includes(p) ? 'bg-blue-50 dark:bg-blue-900/30' : 'bg-red-50 dark:bg-red-900/30'
                  }`}>
                    {p}
                  </th>
                ))}
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-10">Status</th>
              </tr>
            </thead>
            <tbody>
              {holes.map((hole, idx) => {
                const hr = status.holeResults[idx];
                let runningStatus = 0;
                for (let i = 0; i <= idx; i++) {
                  const r = status.holeResults[i];
                  if (r.result === 'A') runningStatus++;
                  else if (r.result === 'B') runningStatus--;
                }

                return (
                  <tr key={hole.number} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center font-bold">{hole.number}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center text-gray-500 bg-yellow-50 dark:bg-yellow-900/20">{hole.yardage}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center font-medium">{hole.par}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center text-gray-500 text-[10px]">{hole.strokeIndex}</td>
                    {allPlayers.map(p => {
                      const gross = getScore(p, hole.number, matchDay);
                      return (
                        <td key={p} className={`border border-gray-300 dark:border-gray-600 p-1 text-center ${
                          playersA.includes(p) ? 'bg-blue-50/50 dark:bg-blue-900/10' : 'bg-red-50/50 dark:bg-red-900/10'
                        }`}>
                          <div>
                            <div className="flex items-center justify-center">
                              <div className={getScoreDisplay(gross, hole.par).className}>
                                <span className="text-xs font-medium text-gray-900 dark:text-white">
                                  {gross ?? ''}
                                </span>
                              </div>
                            </div>
                            <div className="flex justify-center mt-0.5">
                              {renderHandicapDots(getHcap(p), lowestHandicap, hole.strokeIndex)}
                            </div>
                          </div>
                        </td>
                      );
                    })}
                    <td className={`border border-gray-300 dark:border-gray-600 p-1 text-center font-bold text-xs ${
                      hr?.result === 'pending' ? '' :
                      hr?.result === 'A' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' :
                      hr?.result === 'B' ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' :
                      'bg-gray-100 dark:bg-gray-700'
                    }`}>
                      {hr?.result === 'pending' ? '-' :
                       runningStatus > 0 ? `${runningStatus}↑` :
                       runningStatus < 0 ? `${Math.abs(runningStatus)}↓` : 'A/S'}
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-gray-200 dark:bg-gray-600 font-bold">
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">Tot</td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-yellow-200 dark:bg-yellow-700">{holes.reduce((s, h) => s + h.yardage, 0)}</td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">{totalPar}</td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center"></td>
                {allPlayers.map(p => {
                  const scores = getMatchScores(matchDay);
                  const playerScores = scores[p] || {};
                  const total = Object.values(playerScores).reduce((s, v) => s + v, 0);
                  return (
                    <td key={p} className="border border-gray-300 dark:border-gray-600 p-1 text-center">
                      {total > 0 ? total : '-'}
                    </td>
                  );
                })}
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">
                  {status.resultText}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const calculateSinglesMatchPlay = (playerA: string, playerB: string, matchDay: number, holes: typeof blueHoles) => {
    const scores = getMatchScores(matchDay);
    const lowestHandicap = Math.min(handicaps[playerA], handicaps[playerB]);
    let statusA = 0;
    let holesPlayed = 0;
    const holeResults: { hole: number; result: string }[] = [];

    for (const hole of holes) {
      const grossA = scores[playerA]?.[hole.number];
      const grossB = scores[playerB]?.[hole.number];
      if (grossA != null && grossB != null) {
        const netA = grossA - getHandicapStrokesForHole(handicaps[playerA], lowestHandicap, hole.strokeIndex);
        const netB = grossB - getHandicapStrokesForHole(handicaps[playerB], lowestHandicap, hole.strokeIndex);
        holesPlayed++;
        if (netA < netB) { statusA++; holeResults.push({ hole: hole.number, result: 'A' }); }
        else if (netB < netA) { statusA--; holeResults.push({ hole: hole.number, result: 'B' }); }
        else { holeResults.push({ hole: hole.number, result: 'halved' }); }
      } else {
        holeResults.push({ hole: hole.number, result: 'pending' });
      }
    }

    const holesRemaining = 9 - holesPlayed;
    let matchOver = false;
    let resultText = 'A/S';

    if (holesPlayed === 9) {
      matchOver = true;
      if (statusA > 0) resultText = `${playerA} wins`;
      else if (statusA < 0) resultText = `${playerB} wins`;
      else resultText = 'Halved';
    } else if (Math.abs(statusA) > holesRemaining && holesPlayed > 0) {
      matchOver = true;
      const lead = Math.abs(statusA);
      const winner = statusA > 0 ? playerA : playerB;
      resultText = `${winner} wins ${lead}&${holesRemaining}`;
    } else {
      if (statusA > 0) resultText = `${playerA} ${statusA}UP`;
      else if (statusA < 0) resultText = `${playerB} ${Math.abs(statusA)}UP`;
      else resultText = 'A/S';
    }

    return { statusA, holesPlayed, holesRemaining, matchOver, resultText, holeResults };
  };

  const renderSplitSinglesScorecard = (
    soloPlayer: string, opponents: [string, string], matchDay: number,
    holes: typeof blueHoles, groupLabel: string
  ) => {
    const allPlayers = [soloPlayer, ...opponents];
    const soloTeam = teamA.players.includes(soloPlayer) ? 'A' : 'B';
    const match1 = calculateSinglesMatchPlay(soloPlayer, opponents[0], matchDay, holes);
    const match2 = calculateSinglesMatchPlay(soloPlayer, opponents[1], matchDay, holes);
    const totalPar = holes.reduce((sum, h) => sum + h.par, 0);

    return (
      <div>
        <div className="text-center mb-2">
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">{groupLabel}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs sm:text-sm">
            <thead>
              <tr className="bg-gray-100 dark:bg-gray-700">
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8">Hole</th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8 bg-yellow-100 dark:bg-yellow-900">Yds</th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8">Par</th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-6">SI</th>
                {allPlayers.map(p => (
                  <th key={p} className={`border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold ${
                    teamA.players.includes(p) ? 'bg-blue-50 dark:bg-blue-900/30' : 'bg-red-50 dark:bg-red-900/30'
                  }`}>
                    {p}
                  </th>
                ))}
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-10 text-[10px]">
                  vs {opponents[0]}
                </th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-10 text-[10px]">
                  vs {opponents[1]}
                </th>
              </tr>
            </thead>
            <tbody>
              {holes.map((hole, idx) => {
                let running1 = 0, running2 = 0;
                for (let i = 0; i <= idx; i++) {
                  const r1 = match1.holeResults[i];
                  const r2 = match2.holeResults[i];
                  if (r1.result === 'A') running1++; else if (r1.result === 'B') running1--;
                  if (r2.result === 'A') running2++; else if (r2.result === 'B') running2--;
                }
                const hr1 = match1.holeResults[idx];
                const hr2 = match2.holeResults[idx];

                return (
                  <tr key={hole.number} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center font-bold">{hole.number}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center text-gray-500 bg-yellow-50 dark:bg-yellow-900/20">{hole.yardage}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center font-medium">{hole.par}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center text-gray-500 text-[10px]">{hole.strokeIndex}</td>
                    {allPlayers.map(p => {
                      const gross = getScore(p, hole.number, matchDay);
                      const lowestInGroup = Math.min(...allPlayers.map(pl => handicaps[pl]));
                      return (
                        <td key={p} className={`border border-gray-300 dark:border-gray-600 p-1 text-center ${
                          teamA.players.includes(p) ? 'bg-blue-50/50 dark:bg-blue-900/10' : 'bg-red-50/50 dark:bg-red-900/10'
                        }`}>
                          <div>
                            <div className="flex items-center justify-center">
                              <div className={getScoreDisplay(gross, hole.par).className}>
                                <span className="text-xs font-medium text-gray-900 dark:text-white">
                                  {gross ?? ''}
                                </span>
                              </div>
                            </div>
                            <div className="flex justify-center mt-0.5">
                              {renderHandicapDots(handicaps[p], lowestInGroup, hole.strokeIndex)}
                            </div>
                          </div>
                        </td>
                      );
                    })}
                    {[{ hr: hr1, running: running1, opponent: opponents[0] }, { hr: hr2, running: running2, opponent: opponents[1] }].map(({ hr, running, opponent }, mi) => (
                      <td key={mi} className={`border border-gray-300 dark:border-gray-600 p-1 text-center font-bold text-xs ${
                        hr?.result === 'pending' ? '' :
                        hr?.result === 'A' ? (soloTeam === 'A' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' : 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300') :
                        hr?.result === 'B' ? (soloTeam === 'A' ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300' : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300') :
                        'bg-gray-100 dark:bg-gray-700'
                      }`}>
                        {hr?.result === 'pending' ? '-' :
                         running > 0 ? `${soloPlayer} ${running}↑` :
                         running < 0 ? `${opponent} ${Math.abs(running)}↑` : 'A/S'}
                      </td>
                    ))}
                  </tr>
                );
              })}
              <tr className="bg-gray-200 dark:bg-gray-600 font-bold">
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">Tot</td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-yellow-200 dark:bg-yellow-700">{holes.reduce((s, h) => s + h.yardage, 0)}</td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">{totalPar}</td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center"></td>
                {allPlayers.map(p => {
                  const scores = getMatchScores(matchDay);
                  const playerScores = scores[p] || {};
                  const total = Object.values(playerScores).reduce((s, v) => s + v, 0);
                  return (
                    <td key={p} className="border border-gray-300 dark:border-gray-600 p-1 text-center">
                      {total > 0 ? total : '-'}
                    </td>
                  );
                })}
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center text-[10px]">
                  {match1.resultText}
                </td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center text-[10px]">
                  {match2.resultText}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderMatch2 = () => {
    const holes = matchConfig.match2.holes;
    return (
      <div className="space-y-6">
        <div className="text-center mb-1">
          <span className="text-xs text-gray-500 dark:text-gray-400">Split Singles MP • 1 Point Per Match • Yellow Course</span>
        </div>
        {renderSplitSinglesScorecard('Noah', ['Morgan', 'Blake'], 2, holes, 'Group 1: Noah, Morgan, Blake')}
        <div className="border-t-4 border-gray-400 dark:border-gray-500 my-4"></div>
        {renderSplitSinglesScorecard('Casey', ['Jordan', 'Alex'], 2, holes, 'Group 2: Casey, Jordan, Alex')}
      </div>
    );
  };

  const renderMatch4 = () => {
    const holes = matchConfig.match4.holes;
    const scrambleScores = [5, 4, 5, 2, 4, 3, 4, 3, 4];
    const scrambleTotal = scrambleScores.reduce((a, b) => a + b, 0);
    const parTotal = holes.reduce((a, h) => a + h.par, 0);
    const relToPar = scrambleTotal - parTotal;

    return (
      <div className="space-y-4">
        <div className="text-center mb-1">
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
            <span className="line-through">Singles Match Play • 1 Point Per Match</span>
          </div>
          <div className="text-xs font-semibold text-green-700 dark:text-green-400">
            4-Man Scramble • Yellow Course (Cup already decided)
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-gray-100 dark:bg-gray-700">
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-6">Hole</th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-6">Par</th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-6">SI</th>
                <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold bg-green-50 dark:bg-green-900/30">Score</th>
              </tr>
            </thead>
            <tbody>
              {holes.map((hole, i) => {
                const score = scrambleScores[i];
                const diff = score - hole.par;
                return (
                  <tr key={hole.number}>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center font-medium">{hole.number}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">{hole.par}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center text-gray-500">{hole.strokeIndex}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-green-50/50 dark:bg-green-900/10">
                      <div className="flex items-center justify-center">
                        <div className={getScoreDisplay(score, hole.par).className}>
                          <span className="text-sm font-medium text-gray-900 dark:text-white">{score}</span>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-gray-200 dark:bg-gray-600 font-bold">
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center" colSpan={2}>Total</td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">{parTotal}</td>
                <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-green-100 dark:bg-green-900/30">
                  {scrambleTotal} ({relToPar > 0 ? '+' : ''}{relToPar})
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderLeaderboard = () => {
    const { teamAPoints, teamBPoints, results } = calculateLeaderboardPoints();
    const totalPoints = 12;
    const pointsToWin = 7;
    const teamAWon = teamAPoints >= pointsToWin;
    const teamBWon = teamBPoints >= pointsToWin;
    const hasWinner = teamAWon || teamBWon;
    const winnerName = teamAWon ? teamA.fullName : teamBWon ? teamB.fullName : '';

    return (
      <div className="space-y-4">
        {hasWinner && (
          <div className="text-center py-3 px-4 bg-gradient-to-r from-yellow-100 via-yellow-50 to-yellow-100 dark:from-yellow-900/40 dark:via-yellow-800/20 dark:to-yellow-900/40 rounded-lg border border-yellow-300 dark:border-yellow-700">
            <div className="text-xl font-black text-yellow-700 dark:text-yellow-300">
              🏆 {winnerName} win the Fairweathermen Cup! 🏆
            </div>
          </div>
        )}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className={`text-center p-4 rounded-lg ${teamAWon ? 'bg-blue-100 dark:bg-blue-900 ring-2 ring-blue-500' : teamAPoints > teamBPoints ? 'bg-blue-100 dark:bg-blue-900 ring-2 ring-blue-500' : 'bg-blue-50 dark:bg-blue-900/30'}`}>
            <div className="text-lg font-bold text-blue-800 dark:text-blue-200">{teamA.fullName}</div>
            <div className="text-3xl font-black text-blue-700 dark:text-blue-100 mt-1">{teamAPoints}</div>
            {teamAWon && <div className="text-sm font-bold text-blue-600 dark:text-blue-300 mt-1">WINNERS</div>}
          </div>
          <div className="text-center p-4 flex flex-col items-center justify-center">
            <div className="text-sm text-gray-500 dark:text-gray-400">vs</div>
            <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              {hasWinner ? `${winnerName} win!` : `${pointsToWin} points needed to win`}
            </div>
          </div>
          <div className={`text-center p-4 rounded-lg ${teamBWon ? 'bg-red-100 dark:bg-red-900 ring-2 ring-red-500' : teamBPoints > teamAPoints ? 'bg-red-100 dark:bg-red-900 ring-2 ring-red-500' : 'bg-red-50 dark:bg-red-900/30'}`}>
            <div className="text-lg font-bold text-red-800 dark:text-red-200">{teamB.fullName}</div>
            <div className="text-3xl font-black text-red-700 dark:text-red-100 mt-1">{teamBPoints}</div>
            {teamBWon && <div className="text-sm font-bold text-red-600 dark:text-red-300 mt-1">WINNERS</div>}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-gray-100 dark:bg-gray-700">
                <th className="border border-gray-300 dark:border-gray-600 p-2 text-left font-semibold">Match</th>
                <th className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold">Format</th>
                <th className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold">Pts</th>
                <th className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold">Result</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="border border-gray-300 dark:border-gray-600 p-2 font-medium">
                    {r.match}
                    {r.matchSub && <div className="text-[10px] text-gray-400 font-normal">{r.matchSub}</div>}
                  </td>
                  <td className="border border-gray-300 dark:border-gray-600 p-2 text-center text-xs text-gray-500">
                    {r.format}
                  </td>
                  <td className="border border-gray-300 dark:border-gray-600 p-2 text-center font-bold">{r.points}</td>
                  <td className={`border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold ${
                    r.winner === 'A' ? 'text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/20' :
                    r.winner === 'B' ? 'text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20' :
                    r.winner === 'tied' ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400'
                  }`}>
                    {r.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-8">
          <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-white">Prizes</h3>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-green-100 dark:bg-green-900">
                  <th className="border border-gray-300 dark:border-gray-600 p-3 text-left font-semibold">Prize</th>
                  <th className="border border-gray-300 dark:border-gray-600 p-3 text-center font-semibold">Winner</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { key: 'nearest-pin-1', label: 'Nearest Pin #1' },
                  { key: 'longest-drive-1', label: 'Longest Drive #1' },
                ].map(prize => (
                  <tr key={prize.key} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                    <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">{prize.label}</td>
                    <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                      <div className="text-center font-medium">
                        {prizeWinners[prize.key] || '-'}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  const renderPL = () => {
    const cupPrizes = [
      { key: 'nearest-pin-1', label: 'NTP #1' },
      { key: 'longest-drive-1', label: 'LD #1' },
    ];
    const prizeCost = 2.50;
    const numPlayers = allCupPlayers.length;

    const playerPL: Record<string, number> = {};
    allCupPlayers.forEach(p => { playerPL[p] = 0; });

    cupPrizes.forEach(prize => {
      const winner = prizeWinners[prize.key];
      if (winner && winner !== '') {
        playerPL[winner] += (numPlayers - 1) * prizeCost;
        allCupPlayers.forEach(p => {
          if (p !== winner) playerPL[p] -= prizeCost;
        });
      }
    });

    return (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-green-100 dark:bg-green-900">
              <th className="border border-gray-300 dark:border-gray-600 p-2 text-left font-semibold"></th>
              {allCupPlayers.map(p => (
                <th key={p} className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold">{p}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { key: 'nearest-pin-1', label: 'NTP #1' },
              { key: 'longest-drive-1', label: 'LD #1' },
            ].map((row, idx) => {
              const prize = row;
              return (
                <tr key={prize.key} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                  <td className="border border-gray-300 dark:border-gray-600 p-2 font-medium">{prize.label}</td>
                  {allCupPlayers.map(p => {
                    const winner = prizeWinners[prize.key];
                    if (!winner || winner === '') return <td key={p} className="border border-gray-300 dark:border-gray-600 p-2 text-center">-</td>;
                    const isWinner = winner === p;
                    const amount = isWinner ? (numPlayers - 1) * prizeCost : -prizeCost;
                    return (
                      <td key={p} className={`border border-gray-300 dark:border-gray-600 p-2 text-center font-medium ${amount > 0 ? 'text-green-600' : amount < 0 ? 'text-red-600' : ''}`}>
                        {amount > 0 ? `+£${amount.toFixed(2)}` : `-£${Math.abs(amount).toFixed(2)}`}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr className="bg-blue-100 dark:bg-blue-900 font-bold text-xs">
              <td className="border border-gray-300 dark:border-gray-600 p-2 font-bold">TOTAL</td>
              {allCupPlayers.map(p => {
                const total = playerPL[p];
                return (
                  <td key={p} className={`border border-gray-300 dark:border-gray-600 p-2 text-center font-bold ${total > 0 ? 'text-green-600' : total < 0 ? 'text-red-600' : ''}`}>
                    {total > 0 ? `+£${total.toFixed(2)}` : total < 0 ? `-£${Math.abs(total).toFixed(2)}` : '£0.00'}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <Card className="bg-white dark:bg-gray-800 shadow-lg">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5 gap-0.5">
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setCurrentTab(tab.key)}
                className={`px-2 sm:px-3 py-1.5 rounded-md text-[11px] sm:text-sm font-medium transition-colors whitespace-nowrap ${
                  currentTab === tab.key
                    ? 'bg-blue-500 text-white'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        {currentTab === 'match1' && renderScrambleScorecard()}
        {currentTab === 'match2' && renderMatch2()}
        {currentTab === 'match3' && renderMatchPlayScorecard(
          ['Alex', 'Noah'], ['Casey', 'Blake'], 3,
          matchConfig.match3.holes, 'Pairs Better Ball Match Play • 3 Points • Blue Course', 3,
          { Alex: 12, Noah: 0, Casey: 0, Blake: 0 }
        )}
        {currentTab === 'match4' && renderMatch4()}
        {currentTab === 'leaderboard' && renderLeaderboard()}
        {currentTab === 'pl' && renderPL()}
      </CardContent>
    </Card>
  );
}