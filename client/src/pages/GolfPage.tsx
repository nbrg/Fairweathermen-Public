import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import Header from '@/components/Header';
import { apiRequest } from '@/lib/queryClient';
import { HelpCircle } from 'lucide-react';
import FairweathermanCup from './FairweathermanCup';

// Player data with handicaps (default)
const players = [
  { name: 'Alex', handicap: 24 },
  { name: 'Blake', handicap: 14 },
  { name: 'Noah', handicap: 14 },
  { name: 'Morgan', handicap: 32 }
];

// Tournament-specific player configs
const tournamentPlayers: { [key: string]: { name: string; handicap: number }[] } = {
  'velvet-jacket-islantilla': [
    { name: 'Casey', handicap: 13 },
    { name: 'Noah', handicap: 13 },
    { name: 'Blake', handicap: 13 },
    { name: 'Alex', handicap: 27 },
    { name: 'Morgan', handicap: 29 },
    { name: 'Jordan', handicap: 30 }
  ],
  'fairweathermen-cup-islantilla': [
    { name: 'Casey', handicap: 13 },
    { name: 'Noah', handicap: 13 },
    { name: 'Blake', handicap: 13 },
    { name: 'Morgan', handicap: 29 },
    { name: 'Alex', handicap: 27 },
    { name: 'Jordan', handicap: 29 }
  ]
};


// Teams for 2v2 scramble (Alex & Morgan vs Noah & Blake)
const teams = {
  'Team 1': ['Alex', 'Morgan'], // Combined handicap: 57, Team handicap: (57 * 0.9) / 2 = 25.7 ≈ 26
  'Team 2': ['Noah', 'Blake']   // Combined handicap: 26, Team handicap: (26 * 0.9) / 2 = 11.7 ≈ 12
};

// Course data
const courses = {
  'velvet-jacket-oxfordshire': {
    name: '21/09/25 - Oxfordshire (Velvet Jacket)',
    holes: [
      { number: 1, par: 4, yardage: 394, strokeIndex: 10 }, { number: 2, par: 3, yardage: 128, strokeIndex: 16 }, 
      { number: 3, par: 4, yardage: 409, strokeIndex: 2 }, { number: 4, par: 5, yardage: 526, strokeIndex: 6 },
      { number: 5, par: 3, yardage: 150, strokeIndex: 12 }, { number: 6, par: 4, yardage: 289, strokeIndex: 14 },
      { number: 7, par: 5, yardage: 446, strokeIndex: 18 }, { number: 8, par: 4, yardage: 313, strokeIndex: 8 },
      { number: 9, par: 4, yardage: 382, strokeIndex: 4 }, { number: 10, par: 4, yardage: 384, strokeIndex: 17 },
      { number: 11, par: 5, yardage: 502, strokeIndex: 13 }, { number: 12, par: 4, yardage: 415, strokeIndex: 3 },
      { number: 13, par: 3, yardage: 144, strokeIndex: 7 }, { number: 14, par: 4, yardage: 306, strokeIndex: 9 },
      { number: 15, par: 3, yardage: 165, strokeIndex: 15 }, { number: 16, par: 4, yardage: 414, strokeIndex: 1 },
      { number: 17, par: 5, yardage: 505, strokeIndex: 5 }, { number: 18, par: 4, yardage: 398, strokeIndex: 11 }
    ]
  },
  'wycombe-heights-2v2-scramble': {
    name: '18/08/25 - Wycombe Heights (2v2 Scramble)',
    holes: [
      { number: 1, par: 4, yardage: 364, strokeIndex: 7 }, 
      { number: 2, par: 3, yardage: 169, strokeIndex: 15 }, 
      { number: 3, par: 4, yardage: 367, strokeIndex: 5 }, 
      { number: 4, par: 4, yardage: 381, strokeIndex: 11 },
      { number: 5, par: 5, yardage: 499, strokeIndex: 9 }, 
      { number: 6, par: 3, yardage: 154, strokeIndex: 13 },
      { number: 7, par: 4, yardage: 447, strokeIndex: 1 }, 
      { number: 8, par: 3, yardage: 126, strokeIndex: 17 },
      { number: 9, par: 4, yardage: 404, strokeIndex: 3 }, 
      { number: 10, par: 3, yardage: 149, strokeIndex: 18 },
      { number: 11, par: 4, yardage: 292, strokeIndex: 14 }, 
      { number: 12, par: 4, yardage: 339, strokeIndex: 6 },
      { number: 13, par: 4, yardage: 425, strokeIndex: 2 }, 
      { number: 14, par: 4, yardage: 352, strokeIndex: 12 },
      { number: 15, par: 4, yardage: 304, strokeIndex: 4 }, 
      { number: 16, par: 3, yardage: 172, strokeIndex: 10 },
      { number: 17, par: 5, yardage: 487, strokeIndex: 8 }, 
      { number: 18, par: 4, yardage: 339, strokeIndex: 16 }
    ]
  },
  'velvet-jacket-islantilla': {
    name: '21/03/26 - Islantilla (Velvet Jacket)',
    day1CourseName: 'Yellow + Green',
    day2CourseName: 'Yellow + Green',
    holes: [
      { number: 1, par: 5, yardage: 509, strokeIndex: 3 }, { number: 2, par: 3, yardage: 191, strokeIndex: 5 },
      { number: 3, par: 5, yardage: 457, strokeIndex: 1 }, { number: 4, par: 3, yardage: 138, strokeIndex: 15 },
      { number: 5, par: 5, yardage: 465, strokeIndex: 7 }, { number: 6, par: 3, yardage: 116, strokeIndex: 17 },
      { number: 7, par: 4, yardage: 337, strokeIndex: 13 }, { number: 8, par: 4, yardage: 322, strokeIndex: 9 },
      { number: 9, par: 4, yardage: 350, strokeIndex: 11 }, { number: 10, par: 4, yardage: 334, strokeIndex: 14 },
      { number: 11, par: 3, yardage: 155, strokeIndex: 12 }, { number: 12, par: 5, yardage: 498, strokeIndex: 10 },
      { number: 13, par: 4, yardage: 303, strokeIndex: 18 }, { number: 14, par: 4, yardage: 367, strokeIndex: 8 },
      { number: 15, par: 3, yardage: 132, strokeIndex: 16 }, { number: 16, par: 4, yardage: 398, strokeIndex: 4 },
      { number: 17, par: 5, yardage: 521, strokeIndex: 6 }, { number: 18, par: 4, yardage: 442, strokeIndex: 2 }
    ],
    day1Holes: [
      { number: 1, par: 5, yardage: 509, strokeIndex: 3 }, { number: 2, par: 3, yardage: 191, strokeIndex: 5 },
      { number: 3, par: 5, yardage: 457, strokeIndex: 1 }, { number: 4, par: 3, yardage: 138, strokeIndex: 15 },
      { number: 5, par: 5, yardage: 465, strokeIndex: 7 }, { number: 6, par: 3, yardage: 116, strokeIndex: 17 },
      { number: 7, par: 4, yardage: 337, strokeIndex: 13 }, { number: 8, par: 4, yardage: 322, strokeIndex: 9 },
      { number: 9, par: 4, yardage: 350, strokeIndex: 11 }, { number: 10, par: 4, yardage: 334, strokeIndex: 14 },
      { number: 11, par: 3, yardage: 155, strokeIndex: 12 }, { number: 12, par: 5, yardage: 498, strokeIndex: 10 },
      { number: 13, par: 4, yardage: 303, strokeIndex: 18 }, { number: 14, par: 4, yardage: 367, strokeIndex: 8 },
      { number: 15, par: 3, yardage: 132, strokeIndex: 16 }, { number: 16, par: 4, yardage: 398, strokeIndex: 4 },
      { number: 17, par: 5, yardage: 521, strokeIndex: 6 }, { number: 18, par: 4, yardage: 442, strokeIndex: 2 }
    ],
    day2Holes: [
      { number: 1, par: 5, yardage: 509, strokeIndex: 3 }, { number: 2, par: 3, yardage: 191, strokeIndex: 5 },
      { number: 3, par: 5, yardage: 457, strokeIndex: 1 }, { number: 4, par: 3, yardage: 138, strokeIndex: 15 },
      { number: 5, par: 5, yardage: 465, strokeIndex: 7 }, { number: 6, par: 3, yardage: 116, strokeIndex: 17 },
      { number: 7, par: 4, yardage: 337, strokeIndex: 13 }, { number: 8, par: 4, yardage: 322, strokeIndex: 9 },
      { number: 9, par: 4, yardage: 350, strokeIndex: 11 }, { number: 10, par: 4, yardage: 334, strokeIndex: 14 },
      { number: 11, par: 3, yardage: 155, strokeIndex: 12 }, { number: 12, par: 5, yardage: 498, strokeIndex: 10 },
      { number: 13, par: 4, yardage: 303, strokeIndex: 18 }, { number: 14, par: 4, yardage: 367, strokeIndex: 8 },
      { number: 15, par: 3, yardage: 132, strokeIndex: 16 }, { number: 16, par: 4, yardage: 398, strokeIndex: 4 },
      { number: 17, par: 5, yardage: 521, strokeIndex: 6 }, { number: 18, par: 4, yardage: 442, strokeIndex: 2 }
    ]
  },
  'fairweathermen-cup-islantilla': {
    name: '20/03/26 - Islantilla (Fairweathermen Cup)',
    holes: [
      { number: 1, par: 4, yardage: 346, strokeIndex: 8 }, { number: 2, par: 3, yardage: 186, strokeIndex: 3 },
      { number: 3, par: 4, yardage: 328, strokeIndex: 5 }, { number: 4, par: 5, yardage: 454, strokeIndex: 2 },
      { number: 5, par: 4, yardage: 398, strokeIndex: 1 }, { number: 6, par: 4, yardage: 350, strokeIndex: 4 },
      { number: 7, par: 5, yardage: 509, strokeIndex: 6 }, { number: 8, par: 3, yardage: 140, strokeIndex: 9 },
      { number: 9, par: 4, yardage: 353, strokeIndex: 7 }
    ]
  }
};

type ScoreData = {
  [playerName: string]: {
    [hole: number]: {
      day1?: number;
      day2?: number;
    };
  };
};

const tournamentDates: Record<string, Date> = {
  'wycombe-heights-2v2-scramble': new Date('2025-08-18'),
  'velvet-jacket-oxfordshire': new Date('2025-09-21'),
  'fairweathermen-cup-islantilla': new Date('2026-03-20'),
  'velvet-jacket-islantilla': new Date('2026-03-21'),
};

function getDefaultTournament(): string {
  return 'velvet-jacket-islantilla';
}

export default function GolfPage() {
  const [selectedCourse, setSelectedCourse] = useState(getDefaultTournament());
  const [scores, setScores] = useState<ScoreData>({});
  const [day1Holes, setDay1Holes] = useState<'front' | 'back'>('front');
  const [day2Holes, setDay2Holes] = useState<'front' | 'back'>('front');
  const [currentDay, setCurrentDay] = useState<'day1' | 'day2'>('day1');
  const getDefaultTab = (): 'day1' | 'day2' | 'leaderboard' | 'pl' => {
    return 'leaderboard';
  };
  const [currentTab, setCurrentTab] = useState<'day1' | 'day2' | 'leaderboard' | 'pl'>(getDefaultTab());
  const [showGoldenDrainInfo, setShowGoldenDrainInfo] = useState(false);
  const [showMrBlobbyInfo, setShowMrBlobbyInfo] = useState(false);
  const [showDetailedLeaderboard, setShowDetailedLeaderboard] = useState(false);
  const [showPoints, setShowPoints] = useState(false);
  const queryClient = useQueryClient();
  
  const currentCourse = courses[selectedCourse as keyof typeof courses];
  const isScramble = selectedCourse === 'wycombe-heights-2v2-scramble';
  const isIslantilla = selectedCourse === 'velvet-jacket-islantilla';
  const isFairweathermanCup = selectedCourse === 'fairweathermen-cup-islantilla';
  const isEventEnded = isIslantilla || isFairweathermanCup;

  const getHolesForDay = (day: 'day1' | 'day2') => {
    const course = currentCourse as any;
    if (course.day1Holes && course.day2Holes) {
      return day === 'day1' ? course.day1Holes : course.day2Holes;
    }
    return currentCourse.holes;
  };

  // Get player handicap based on day (different handicaps for Day 2 of Velvet Jacket)
  const getPlayerHandicap = (playerName: string, day: 'day1' | 'day2') => {
    // For Islantilla: base handicap from DB, with Day 2 adjustments
    if (isIslantilla) {
      const dbPlayer = dbHandicaps?.find(d => d.playerName === playerName);
      const baseHandicap = dbPlayer?.handicap || tournamentPlayers[selectedCourse]?.find(p => p.name === playerName)?.handicap || 0;
      
      if (day === 'day2') {
        const islantillaPlayers = tournamentPlayers[selectedCourse] || [];
        const day1Holes = (currentCourse as any).day1Holes || currentCourse.holes;
        
        const day1Scores = islantillaPlayers.map(p => {
          const pHandicap = dbHandicaps?.find(d => d.playerName === p.name)?.handicap || p.handicap;
          let totalPoints = 0;
          let hasAnyScore = false;
          day1Holes.forEach((hole: any) => {
            const grossScore = getScore(p.name, hole.number, 'day1');
            if (grossScore) {
              hasAnyScore = true;
              const shotsReceived = getHandicapStrokesForHole(pHandicap, hole.strokeIndex);
              const netVsPar = (grossScore - shotsReceived) - hole.par;
              if (netVsPar <= -4) totalPoints += 6;
              else if (netVsPar === -3) totalPoints += 5;
              else if (netVsPar === -2) totalPoints += 4;
              else if (netVsPar === -1) totalPoints += 3;
              else if (netVsPar === 0) totalPoints += 2;
              else if (netVsPar === 1) totalPoints += 1;
            }
          });
          return { name: p.name, points: totalPoints, hasAnyScore };
        }).filter(s => s.hasAnyScore);

        if (day1Scores.length > 0) {
          const maxPoints = Math.max(...day1Scores.map(s => s.points));
          const minPoints = Math.min(...day1Scores.map(s => s.points));
          
          if (maxPoints !== minPoints) {
            if (day1Scores.find(s => s.name === playerName)?.points === minPoints) {
              return Math.round(baseHandicap * 1.10);
            }
            if (day1Scores.find(s => s.name === playerName)?.points === maxPoints) {
              return Math.round(baseHandicap * 0.90);
            }
          }
        }
      }
      
      return baseHandicap;
    }
    
    // For tournament-specific players, check DB first, then hardcoded
    if (tournamentPlayers[selectedCourse]) {
      const dbPlayer = dbHandicaps?.find(d => d.playerName === playerName);
      if (dbPlayer) return dbPlayer.handicap;
      const player = tournamentPlayers[selectedCourse].find(p => p.name === playerName);
      return player?.handicap || 0;
    }
    
    // For Velvet Jacket Day 2, use different handicaps
    if (day === 'day2' && selectedCourse === 'velvet-jacket-oxfordshire') {
      switch (playerName) {
        case 'Alex': return 22;
        case 'Noah': return 15;
        case 'Blake': return 14;
        case 'Morgan': return 32;
        default: return 0;
      }
    }
    
    // For Day 1 and all other tournaments, use original handicaps
    const player = players.find(p => p.name === playerName);
    return player?.handicap || 0;
  };

  // Get handicaps from DB for the current tournament (if it has DB handicaps)
  const tournamentsWithDbHandicaps = ['velvet-jacket-islantilla'];
  const { data: dbHandicaps } = useQuery<{ playerName: string; handicap: number }[]>({
    queryKey: ['/api/golf/handicaps', selectedCourse],
    queryFn: async () => {
      const response = await fetch(`/api/golf/handicaps/${selectedCourse}`);
      if (!response.ok) throw new Error('Failed to fetch handicaps');
      return response.json();
    },
    enabled: tournamentsWithDbHandicaps.includes(selectedCourse),
    staleTime: 1000 * 60 * 5,
  });

  // Merge DB handicaps into current players list (DB overrides hardcoded values)
  const currentPlayers = React.useMemo(() => {
    const base = tournamentPlayers[selectedCourse] || players;
    if (!dbHandicaps || dbHandicaps.length === 0) return base;
    return base.map(p => {
      const db = dbHandicaps.find(d => d.playerName === p.name);
      return db ? { ...p, handicap: db.handicap } : p;
    });
  }, [selectedCourse, dbHandicaps]);

  // Get all tournaments
  const { data: tournaments } = useQuery({
    queryKey: ['/api/golf/tournaments'],
    enabled: !!selectedCourse,
  });

  // Create tournament mutation
  const createTournamentMutation = useMutation({
    mutationFn: async (tournamentData: any) => {
      const response = await apiRequest('POST', '/api/golf/tournaments', tournamentData);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/golf/tournaments'] });
    },
  });

  // Get or create tournament
  const tournament = Array.isArray(tournaments) ? tournaments.find((t: any) => t.courseId === selectedCourse) || null : null;
  

  
  // Auto-create tournament if it doesn't exist
  React.useEffect(() => {
    if (tournaments && !tournament && selectedCourse && !createTournamentMutation.isPending && !createTournamentMutation.isSuccess) {
      createTournamentMutation.mutate({
        name: currentCourse.name,
        courseId: selectedCourse,
        status: 'active'
      });
    }
  }, [tournaments, tournament, selectedCourse, currentCourse.name, createTournamentMutation.isPending, createTournamentMutation.isSuccess]);

  React.useEffect(() => {
    if (selectedCourse === 'velvet-jacket-islantilla') {
      setCurrentTab(getDefaultTab());
      setCurrentDay(getDefaultTab() === 'day2' ? 'day2' : 'day1');
    }
  }, [selectedCourse]);

  // Fetch scores for the tournament
  const { data: dbScores } = useQuery({
    queryKey: ['/api/golf/tournaments', tournament?.id, 'scores'],
    queryFn: async () => {
      const response = await fetch(`/api/golf/tournaments/${tournament?.id}/scores`);
      return response.json();
    },
    enabled: !!tournament?.id,
  });

  // Save score mutation
  const saveScoreMutation = useMutation({
    mutationFn: async ({ tournamentId, playerName, hole, day, score }: {
      tournamentId: number;
      playerName: string;
      hole: number;
      day: number;
      score: number;
    }) => {
      const response = await apiRequest('POST', '/api/golf/scores', {
        tournamentId,
        playerName,
        hole,
        day,
        score
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/golf/tournaments', tournament?.id, 'scores'] });
    },
  });

  // Fetch prize winners for the tournament
  const { data: dbPrizeWinners } = useQuery({
    queryKey: ['/api/golf/tournaments', tournament?.id, 'prize-winners'],
    queryFn: async () => {
      const response = await fetch(`/api/golf/tournaments/${tournament?.id}/prize-winners`);
      return response.json();
    },
    enabled: !!tournament?.id,
  });

  // Convert database prize winners to the format expected by the UI
  const prizeWinners = React.useMemo(() => {
    const winners: Record<string, string> = {};
    if (Array.isArray(dbPrizeWinners)) {
      dbPrizeWinners.forEach((winner: any) => {
        winners[winner.prizeKey] = winner.winnerName;
      });
    }
    return winners;
  }, [dbPrizeWinners]);

  // Save prize winner mutation
  const savePrizeWinnerMutation = useMutation({
    mutationFn: async ({ tournamentId, prizeKey, winnerName }: {
      tournamentId: number;
      prizeKey: string;
      winnerName: string;
    }) => {
      const response = await apiRequest('POST', '/api/golf/prize-winners', {
        tournamentId,
        prizeKey,
        winnerName
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/golf/tournaments', tournament?.id, 'prize-winners'] });
    },
  });

  const updateScore = (playerName: string, hole: number, day: 'day1' | 'day2', score: string) => {
    const numScore = score === '' ? undefined : parseInt(score);
    
    // Update local state
    setScores(prev => ({
      ...prev,
      [playerName]: {
        ...prev[playerName],
        [hole]: {
          ...prev[playerName]?.[hole],
          [day]: numScore
        }
      }
    }));

    // Save to database if valid score and tournament exists
    if (numScore && tournament?.id) {
      const dayNum = day === 'day1' ? 1 : 2;
      saveScoreMutation.mutate({
        tournamentId: tournament.id,
        playerName,
        hole,
        day: dayNum,
        score: numScore
      });
    }
  };



  const getScore = (playerName: string, hole: number, day: 'day1' | 'day2'): number | undefined => {
    // Check database scores first
    if (dbScores) {
      const dayNum = day === 'day1' ? 1 : 2;
      const dbScore = dbScores.find((s: any) => 
        s.playerName === playerName && s.hole === hole && s.day === dayNum
      );
      if (dbScore && dbScore.score) return dbScore.score;
    }
    
    // Fallback to local state
    return scores[playerName]?.[hole]?.[day];
  };

  const calculateTotal = (playerName: string, day: 'day1' | 'day2', holes: number[]): number => {
    return holes.reduce((total, hole) => {
      const score = getScore(playerName, hole, day);
      return total + (score || 0);
    }, 0);
  };

  // Calculate handicap strokes for a specific hole
  const getHandicapStrokesForHole = (handicap: number, strokeIndex: number): number => {
    if (handicap >= strokeIndex) {
      // Base stroke plus extra strokes for handicaps > 18
      return 1 + Math.floor((handicap - strokeIndex) / 18);
    }
    return 0;
  };

  // Helper function to render handicap dots
  const renderHandicapDots = (handicap: number, strokeIndex: number): JSX.Element => {
    const strokes = getHandicapStrokesForHole(handicap, strokeIndex);
    if (strokes === 0) return <div className="h-2"></div>;
    
    return (
      <div className="flex justify-center gap-0.5 h-2">
        {Array.from({ length: strokes }, (_, i) => (
          <div key={i} className="w-1 h-1 bg-black dark:bg-white rounded-full"></div>
        ))}
      </div>
    );
  };

  // Helper function to get score styling and symbols
  const getScoreDisplay = (score: number | null, par: number, isNetScore: boolean = false, netScore: number | null = null): { display: string; className: string } => {
    if (!score) return { display: '', className: '' };
    
    // For net score columns, use the net score for both display and comparison
    // For gross score columns, use gross score for comparison
    const displayScore = score.toString();
    const scoreDiff = isNetScore ? score - par : score - par;
    
    if (scoreDiff <= -2) {
      return { 
        display: displayScore, 
        className: 'w-7 h-7 border-2 border-red-700 rounded-full flex items-center justify-center eagle-double-circle text-xs' 
      };
    } else if (scoreDiff === -1) {
      return { 
        display: displayScore, 
        className: 'w-8 h-8 border-2 border-green-600 rounded-full bg-green-200 dark:bg-green-800 flex items-center justify-center' 
      };
    } else if (scoreDiff === 0) {
      return { 
        display: displayScore, 
        className: 'w-8 h-8 flex items-center justify-center' 
      };
    } else if (scoreDiff === 1) {
      return { 
        display: displayScore, 
        className: 'w-8 h-8 border-2 border-orange-500 bg-yellow-200 dark:bg-yellow-800 flex items-center justify-center' 
      };
    } else if (scoreDiff >= 2) {
      return { 
        display: displayScore, 
        className: 'w-7 h-7 border-2 border-orange-500 bg-orange-200 dark:bg-orange-800 flex items-center justify-center double-bogey-double-square text-xs' 
      };
    }
    
    return { display: displayScore, className: 'w-8 h-8 flex items-center justify-center' };
  };

  // Calculate matchplay status for Wycombe scramble
  const calculateMatchplayStatus = () => {
    if (!isScramble) return null;
    
    // If tournament is completed, show final result
    if (tournament?.status === 'completed') {
      return 'Alex & Casey win 7&5';
    }

    let alexCaseyUp = 0;
    let holesPlayed = 0;
    const totalHoles = currentCourse.holes.length;

    // Check if both teams have submitted score for hole 1
    const alexCaseyHole1 = getScore('Alex & Casey', 1, 'day1');
    const noahBlakeHole1 = getScore('Noah & Blake', 1, 'day1');
    
    if (!alexCaseyHole1 || !noahBlakeHole1) {
      return null; // Don't show status until both teams have hole 1
    }

    // Calculate hole-by-hole winners
    for (const hole of currentCourse.holes) {
      const alexCaseyScore = getScore('Alex & Casey', hole.number, 'day1');
      const noahBlakeScore = getScore('Noah & Blake', hole.number, 'day1');
      
      if (alexCaseyScore && noahBlakeScore) {
        holesPlayed++;
        
        // For scrambles: Alex & Casey get 4 shots based on team handicap difference (16 - 12 = 4)
        // Team gets shots on SI 1-4
        const alexCaseyStrokes = hole.strokeIndex <= 4 ? 1 : 0;
        const noahBlakeStrokes = 0;
        
        const alexCaseyNet = alexCaseyScore - alexCaseyStrokes;
        const noahBlakeNet = noahBlakeScore - noahBlakeStrokes;
        
        if (alexCaseyNet < noahBlakeNet) {
          alexCaseyUp++;
        } else if (noahBlakeNet < alexCaseyNet) {
          alexCaseyUp--;
        }
        // If tied, no change (halved hole)
      }
    }

    const holesRemaining = totalHoles - holesPlayed;
    const absUp = Math.abs(alexCaseyUp);
    
    // Determine match status
    if (alexCaseyUp === 0) {
      if (holesRemaining === 0) {
        return `Match halved`;
      } else if (holesPlayed <= 9) {
        return `All square after ${holesPlayed} hole${holesPlayed === 1 ? '' : 's'}`;
      } else {
        return `All square with ${holesRemaining} hole${holesRemaining === 1 ? '' : 's'} remaining`;
      }
    } else if (absUp > holesRemaining) {
      // Match is won - team is ahead by more holes than remain
      const winner = alexCaseyUp > 0 ? 'Alex & Casey' : 'Noah & Blake';
      return `${winner} win ${absUp} & ${holesRemaining}`;
    } else {
      const leader = alexCaseyUp > 0 ? 'Alex & Casey' : 'Noah & Blake';
      if (holesRemaining === 0) {
        return `${leader} win ${absUp} & 0`;
      } else if (holesPlayed <= 9) {
        return `${leader} are ${absUp} up after ${holesPlayed} hole${holesPlayed === 1 ? '' : 's'}`;
      } else {
        return `${leader} are ${absUp} up with ${holesRemaining} hole${holesRemaining === 1 ? '' : 's'} remaining`;
      }
    }
  };

  // Calculate net score relative to par for completed holes
  const calculateNet = (playerName: string, day: 'day1' | 'day2', holes: number[]): string => {
    let netRelativeToPar = 0;
    let totalNetScore = 0;
    let hasAnyScore = false;
    let totalPar = 0;

    for (const holeNumber of holes) {
      const grossScore = getScore(playerName, holeNumber, day);
      const dayHoles = getHolesForDay(day);
      const hole = dayHoles.find((h: any) => h.number === holeNumber);
      if (!hole) continue;
      
      totalPar += hole.par;
      
      if (!grossScore) continue;
      
      hasAnyScore = true;

      let handicap = 0;
      if (isScramble) {
        if (playerName === 'Alex & Casey' || ['Alex', 'Casey'].includes(playerName)) {
          handicap = 16;
        } else if (playerName === 'Noah & Blake' || ['Noah', 'Blake'].includes(playerName)) {
          handicap = 12;
        }
      } else {
        handicap = getPlayerHandicap(playerName, day);
      }

      const strokesForHole = getHandicapStrokesForHole(handicap, hole.strokeIndex);
      const netScore = grossScore - strokesForHole;
      totalNetScore += netScore;
      
      const netRelativeToParThisHole = netScore - hole.par;
      netRelativeToPar += netRelativeToParThisHole;
    }

    if (!hasAnyScore) return '-';
    
    let relativeToPar = '';
    if (netRelativeToPar === 0) {
      relativeToPar = 'E';
    } else {
      relativeToPar = netRelativeToPar > 0 ? `+${netRelativeToPar}` : `${netRelativeToPar}`;
    }
    
    return `${totalNetScore} (${relativeToPar})`;
  };

  // Calculate gross score total for completed holes
  const calculateGross = (playerName: string, day: 'day1' | 'day2', holes: number[]): string => {
    let grossRelativeToPar = 0;
    let totalGrossScore = 0;
    let hasAnyScore = false;
    let totalPar = 0;

    for (const holeNumber of holes) {
      const grossScore = getScore(playerName, holeNumber, day);
      const dayHoles = getHolesForDay(day);
      const hole = dayHoles.find((h: any) => h.number === holeNumber);
      if (!hole) continue;
      
      totalPar += hole.par;
      
      if (!grossScore) continue; // Skip holes without scores
      
      hasAnyScore = true;
      totalGrossScore += grossScore;
      
      // Compare to par (gross relative to par)
      const grossRelativeToParThisHole = grossScore - hole.par;
      grossRelativeToPar += grossRelativeToParThisHole;
    }

    if (!hasAnyScore) return '-';
    
    // Format: show actual total with relative to par in parentheses
    // e.g., "72 (+3)" or "69 (E)" or "67 (-2)"
    let relativeToPar = '';
    if (grossRelativeToPar === 0) {
      relativeToPar = 'E';
    } else {
      relativeToPar = grossRelativeToPar > 0 ? `+${grossRelativeToPar}` : `${grossRelativeToPar}`;
    }
    
    return `${totalGrossScore} (${relativeToPar})`;
  };

  // Calculate stableford points for a player on a specific day
  const calculateStablefordDay = (player: string, day: 'day1' | 'day2') => {
    const playerHandicap = getPlayerHandicap(player, day);
    const holes = getHolesForDay(day);
    let totalPoints = 0;
    
    holes.forEach((hole: any) => {
      const grossScore = getScore(player, hole.number, day);
      if (grossScore) {
        const shotsReceived = getHandicapStrokesForHole(playerHandicap, hole.strokeIndex);
        const netScore = grossScore - shotsReceived;
        const netVsPar = netScore - hole.par;
        
        let points = 0;
        if (netVsPar <= -4) points = 6;
        else if (netVsPar === -3) points = 5;
        else if (netVsPar === -2) points = 4;
        else if (netVsPar === -1) points = 3;
        else if (netVsPar === 0) points = 2;
        else if (netVsPar === 1) points = 1;
        else points = 0;
        
        totalPoints += points;
      }
    });
    
    return totalPoints;
  };

  // Calculate total stableford points across both days
  const calculateTotalStableford = (player: string) => {
    const day1Points = calculateStablefordDay(player, 'day1');
    const day2Points = calculateStablefordDay(player, 'day2');
    return day1Points + day2Points;
  };

  // Helper functions for leaderboard
  const calculateDayStablefordPoints = (player: string, day: 'day1' | 'day2') => {
    return calculateStablefordDay(player, day);
  };

  // Calculate stableford points for a single hole
  const calculateHoleStablefordPoints = (player: string, holeNumber: number, day: 'day1' | 'day2'): number => {
    const playerHandicap = getPlayerHandicap(player, day);
    const holes = getHolesForDay(day);
    const hole = holes.find((h: any) => h.number === holeNumber);
    if (!hole) return 0;
    
    const grossScore = getScore(player, holeNumber, day);
    if (!grossScore) return 0;
    
    // Calculate shots received on this hole
    const shotsReceived = getHandicapStrokesForHole(playerHandicap, hole.strokeIndex);
    const netScore = grossScore - shotsReceived;
    const netVsPar = netScore - hole.par;
    
    // Stableford scoring - using same system as leaderboard
    let points = 0;
    if (netVsPar <= -4) points = 6; // Condor (-4)
    else if (netVsPar === -3) points = 5; // Albatross (-3)
    else if (netVsPar === -2) points = 4; // Eagle (-2)
    else if (netVsPar === -1) points = 3; // Birdie (-1)
    else if (netVsPar === 0) points = 2; // Par (0)
    else if (netVsPar === 1) points = 1; // Bogey (+1)
    else points = 0; // Double bogey or worse (+2 or more)
    
    return points;
  };

  // Calculate total score relative to par for both days combined
  const calculateTotalScoreRelativeToPar = (playerName: string, scoreType: 'gross' | 'net'): string => {
    let totalRelativeToPar = 0;
    let hasAnyScore = false;
    
    (['day1', 'day2'] as const).forEach(day => {
      const holes = getHolesForDay(day);
      holes.forEach((hole: any) => {
        const grossScore = getScore(playerName, hole.number, day);
        if (!grossScore) return;
        
        hasAnyScore = true;
        let scoreVsPar;
        
        if (scoreType === 'gross') {
          scoreVsPar = grossScore - hole.par;
        } else {
          const playerHandicap = getPlayerHandicap(playerName, day);
          const shotsReceived = getHandicapStrokesForHole(playerHandicap, hole.strokeIndex);
          const netScore = grossScore - shotsReceived;
          scoreVsPar = netScore - hole.par;
        }
        
        totalRelativeToPar += scoreVsPar;
      });
    });
    
    if (!hasAnyScore) return '-';
    
    if (totalRelativeToPar === 0) {
      return 'E';
    } else {
      return totalRelativeToPar > 0 ? `+${totalRelativeToPar}` : `${totalRelativeToPar}`;
    }
  };

  // Calculate most blobs (holes with 0 stableford points)
  const calculateBlobs = (player: string) => {
    let blobCount = 0;
    
    (['day1', 'day2'] as const).forEach(day => {
      const playerHandicap = getPlayerHandicap(player, day);
      const holes = getHolesForDay(day);
      holes.forEach((hole: any) => {
        const grossScore = getScore(player, hole.number, day);
        if (grossScore) {
          const shotsReceived = getHandicapStrokesForHole(playerHandicap, hole.strokeIndex);
          const netScore = grossScore - shotsReceived;
          const netVsPar = netScore - hole.par;
          
          if (netVsPar >= 2) {
            blobCount++;
          }
        }
      });
    });
    
    return blobCount;
  };

  // Calculate gross total across both days
  const calculateTotalGross = (player: string) => {
    const d1Holes = getHolesForDay('day1');
    const d2Holes = getHolesForDay('day2');
    const day1Gross = parseInt(calculateGross(player, 'day1', d1Holes.map((h: any) => h.number)).split(' ')[0]) || 0;
    const day2Gross = parseInt(calculateGross(player, 'day2', d2Holes.map((h: any) => h.number)).split(' ')[0]) || 0;
    const total = day1Gross + day2Gross;
    return total > 0 ? total : null;
  };

  // Calculate net total across both days
  const calculateTotalNet = (player: string) => {
    const day1Holes = getHolesForDay('day1');
    const day2HolesArr = getHolesForDay('day2');
    const day1Net = parseInt(calculateNet(player, 'day1', day1Holes.map((h: any) => h.number)).split(' ')[0]) || 0;
    const day2Net = parseInt(calculateNet(player, 'day2', day2HolesArr.map((h: any) => h.number)).split(' ')[0]) || 0;
    const total = day1Net + day2Net;
    return total > 0 ? total : null;
  };

  // Separate front and back nine
  const frontNine = currentCourse.holes.slice(0, 9);
  const backNine = currentCourse.holes.slice(9);

  const day1NineHoles = day1Holes === 'front' ? frontNine : backNine;
  const day2NineHoles = day2Holes === 'front' ? frontNine : backNine;
  const day1Par = day1NineHoles.reduce((sum, hole) => sum + hole.par, 0);
  const day2Par = day2NineHoles.reduce((sum, hole) => sum + hole.par, 0);
  
  // Get display players based on course type
  const displayPlayers = isScramble ? [
    { name: 'Alex & Casey', handicap: 16, teamMembers: ['Alex', 'Casey'] },
    { name: 'Noah & Blake', handicap: 12, teamMembers: ['Noah', 'Blake'] }
  ] : players.map(p => ({ ...p, teamMembers: [p.name] }));

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <Header />
      <div className="container mx-auto px-2 sm:px-4 py-6 max-w-7xl">
        <div className="text-center mb-4">
          {/* Tournament Selection Dropdown */}
          <div className="mb-4">
            <select 
              value={selectedCourse}
              onChange={(e) => setSelectedCourse(e.target.value)}
              className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm"
            >
              <option value="wycombe-heights-2v2-scramble">18/08/25 - Wycombe Heights (2v2 Scramble)</option>
              <option value="velvet-jacket-oxfordshire">21/09/25 - Oxfordshire (Velvet Jacket)</option>
              <option value="fairweathermen-cup-islantilla">20/03/26 - Islantilla (Fairweathermen Cup)</option>
              <option value="velvet-jacket-islantilla">21/03/26 - Islantilla (Velvet Jacket)</option>
            </select>
          </div>
        </div>

        <div className="w-full space-y-1">
          {isFairweathermanCup ? (
            <FairweathermanCup tournament={tournament} />
          ) : isScramble ? (
            /* Wycombe Heights - Single Day Scramble */
            <Card className="bg-white dark:bg-gray-800 shadow-lg">
              <CardContent className="pt-2">
                {(() => {
                  const matchStatus = calculateMatchplayStatus();
                  return matchStatus ? (
                    <div className="mb-4 text-center">
                      <div className="inline-block bg-blue-100 dark:bg-blue-900 px-4 py-2 rounded-lg">
                        <p className="text-lg font-semibold text-blue-800 dark:text-blue-200">
                          {matchStatus}
                        </p>
                      </div>
                    </div>
                  ) : null;
                })()}
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs sm:text-sm">
                    <thead>
                      <tr className="bg-gray-100 dark:bg-gray-700">
                        <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-6">Hole</th>
                        <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8 bg-yellow-100 dark:bg-yellow-900">Yds</th>
                        <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-6">SI</th>
                        <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8">Par</th>
                        <th className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-semibold w-24 sm:w-28"><span className="hidden sm:inline">Alex & Casey (4)</span><span className="sm:hidden">Alex&Casey (4)</span></th>
                        <th className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-semibold w-24 sm:w-28"><span className="hidden sm:inline">Noah & Blake</span><span className="sm:hidden">Noah&Blake</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentCourse.holes.map(hole => {
                        const alexCaseyScore = getScore('Alex & Casey', hole.number, 'day1');
                        const noahBlakeScore = getScore('Noah & Blake', hole.number, 'day1');
                        
                        // Calculate net scores for matchplay (internal only - not displayed)
                        let alexCaseyNetNum = null;
                        let noahBlakeNetNum = null;
                        
                        if (alexCaseyScore) {
                          // Alex & Casey get shots on SI 1-4 (4 shots total based on team handicap difference)
                          const strokesForHole = hole.strokeIndex <= 4 ? 1 : 0;
                          alexCaseyNetNum = alexCaseyScore - strokesForHole;
                        }
                        
                        if (noahBlakeScore) {
                          // Noah & Blake get no handicap shots
                          noahBlakeNetNum = noahBlakeScore;
                        }

                        // Get score display styling for each team (gross scores only)
                        const alexCaseyDisplay = getScoreDisplay(alexCaseyScore || null, hole.par, false);
                        const noahBlakeDisplay = getScoreDisplay(noahBlakeScore || null, hole.par, false);
                        
                        return (
                          <tr key={hole.number} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                            <td className="border border-gray-300 dark:border-gray-600 p-1 text-center font-bold">
                              {hole.number}
                            </td>
                            <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-yellow-200 dark:bg-yellow-800">
                              {hole.yardage}
                            </td>
                            <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">
                              {hole.strokeIndex}
                            </td>
                            <td className="border border-gray-300 dark:border-gray-600 p-1 text-center font-medium">
                              {hole.par}
                            </td>
                            <td className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-medium">
                              <div className="flex justify-center">
                                <div className={alexCaseyDisplay.className || 'w-8 h-8 flex items-center justify-center'}>
                                  <input
                                    type="number"
                                    min="0"
                                    max="12"
                                    value={alexCaseyScore || ''}
                                    disabled={tournament?.status === 'completed' || hole.number > 13}
                                    readOnly={tournament?.status === 'completed' || hole.number > 13}
                                    onChange={(e) => {
                                      if (tournament?.status === 'completed' || hole.number > 13) return;
                                      const value = e.target.value;
                                      if (value === '' || value === '0') {
                                        updateScore('Alex & Casey', hole.number, 'day1', '');
                                        if (tournament?.id) {
                                          fetch('/api/golf/scores', {
                                            method: 'DELETE',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({
                                              tournamentId: tournament.id,
                                              playerName: 'Alex & Casey',
                                              hole: hole.number,
                                              day: 1
                                            })
                                          }).then(() => {
                                            queryClient.invalidateQueries({ queryKey: ['/api/golf/tournaments', tournament.id, 'scores'] });
                                          });
                                        }
                                      } else {
                                        updateScore('Alex & Casey', hole.number, 'day1', value);
                                      }
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'ArrowDown' && e.currentTarget.value === '1') {
                                        e.preventDefault();
                                        e.currentTarget.value = '';
                                        updateScore('Alex & Casey', hole.number, 'day1', '');
                                        if (tournament?.id) {
                                          fetch('/api/golf/scores', {
                                            method: 'DELETE',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({
                                              tournamentId: tournament.id,
                                              playerName: 'Alex & Casey',
                                              hole: hole.number,
                                              day: 1
                                            })
                                          }).then(() => {
                                            queryClient.invalidateQueries({ queryKey: ['/api/golf/tournaments', tournament.id, 'scores'] });
                                          });
                                        }
                                      }
                                    }}
                                    className={`w-full h-full text-center text-sm font-medium border-0 bg-transparent text-gray-900 dark:text-white focus:outline-none ${tournament?.status === 'completed' || hole.number > 13 ? 'opacity-50 cursor-not-allowed' : ''}`}
                                  />
                                </div>
                              </div>
                              {/* Only show handicap dots for Oxfordshire, not Wycombe Heights */}
                              {!isScramble && (
                                <div className="flex justify-center mt-1">
                                  {renderHandicapDots(16, hole.strokeIndex)}
                                </div>
                              )}
                            </td>

                            <td className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-medium">
                              <div className="flex justify-center">
                                <div className={noahBlakeDisplay.className || 'w-8 h-8 flex items-center justify-center'}>
                                  <input
                                    type="number"
                                    min="0"
                                    max="12"
                                    value={noahBlakeScore || ''}
                                    disabled={tournament?.status === 'completed' || hole.number > 13}
                                    readOnly={tournament?.status === 'completed' || hole.number > 13}
                                    onChange={(e) => {
                                      if (tournament?.status === 'completed' || hole.number > 13) return;
                                      const value = e.target.value;
                                      if (value === '' || value === '0') {
                                        updateScore('Noah & Blake', hole.number, 'day1', '');
                                        if (tournament?.id) {
                                          fetch('/api/golf/scores', {
                                            method: 'DELETE',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({
                                              tournamentId: tournament.id,
                                              playerName: 'Noah & Blake',
                                              hole: hole.number,
                                              day: 1
                                            })
                                          }).then(() => {
                                            queryClient.invalidateQueries({ queryKey: ['/api/golf/tournaments', tournament.id, 'scores'] });
                                          });
                                        }
                                      } else {
                                        updateScore('Noah & Blake', hole.number, 'day1', value);
                                      }
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'ArrowDown' && e.currentTarget.value === '1') {
                                        e.preventDefault();
                                        e.currentTarget.value = '';
                                        updateScore('Noah & Blake', hole.number, 'day1', '');
                                        if (tournament?.id) {
                                          fetch('/api/golf/scores', {
                                            method: 'DELETE',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({
                                              tournamentId: tournament.id,
                                              playerName: 'Noah & Blake',
                                              hole: hole.number,
                                              day: 1
                                            })
                                          }).then(() => {
                                            queryClient.invalidateQueries({ queryKey: ['/api/golf/tournaments', tournament.id, 'scores'] });
                                          });
                                        }
                                      }
                                    }}
                                    className={`w-full h-full text-center text-sm font-medium border-0 bg-transparent text-gray-900 dark:text-white focus:outline-none ${tournament?.status === 'completed' || hole.number > 13 ? 'opacity-50 cursor-not-allowed' : ''}`}
                                  />
                                </div>
                              </div>
                              {/* Only show handicap dots for Oxfordshire, not Wycombe Heights */}
                              {!isScramble && (
                                <div className="flex justify-center mt-1">
                                  {renderHandicapDots(12, hole.strokeIndex)}
                                </div>
                              )}
                            </td>

                          </tr>
                        );
                      })}
                      
                      {/* 18-hole totals row */}
                      <tr className="bg-green-100 dark:bg-green-900 font-bold">
                        <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">
                          TOTAL
                        </td>
                        <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-yellow-200 dark:bg-yellow-700">
                          {currentCourse.holes.reduce((sum, hole) => sum + hole.yardage, 0)}
                        </td>
                        <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">
                          -
                        </td>
                        <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">
                          {currentCourse.holes.reduce((sum, hole) => sum + hole.par, 0)}
                        </td>
                        <td className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center">
                          {calculateGross('Alex & Casey', 'day1', currentCourse.holes.map(h => h.number)) || '-'}
                        </td>
                        <td className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center">
                          {calculateGross('Noah & Blake', 'day1', currentCourse.holes.map(h => h.number)) || '-'}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                
                {/* Individual Handicaps */}
                <div className="mt-4 bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 text-center">Individual Handicaps</h4>
                  <div className="flex justify-center">
                    <table className="text-sm">
                      <tbody>
                        <tr>
                          <td className="font-semibold text-gray-900 dark:text-white pr-8">Alex:</td>
                          <td className="font-normal text-gray-700 dark:text-gray-300 text-right pr-8">24.2</td>
                          <td className="font-semibold text-gray-900 dark:text-white pr-2">Noah:</td>
                          <td className="font-normal text-gray-700 dark:text-gray-300 text-right">13.1</td>
                        </tr>
                        <tr>
                          <td className="font-semibold text-gray-900 dark:text-white pr-8">Casey:</td>
                          <td className="font-normal text-gray-700 dark:text-gray-300 text-right pr-8">12.3</td>
                          <td className="font-semibold text-gray-900 dark:text-white pr-2">Blake:</td>
                          <td className="font-normal text-gray-700 dark:text-gray-300 text-right">14.8</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Profit/Loss Table */}
                <div className="mt-4 bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 text-center">Profit/Loss Summary</h4>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-xs sm:text-sm">
                      <thead>
                        <tr className="bg-gray-100 dark:bg-gray-600">
                          <th className="border border-gray-300 dark:border-gray-500 p-2 text-center font-semibold">Bet</th>
                          <th className="border border-gray-300 dark:border-gray-500 p-2 text-center font-semibold">Alex</th>
                          <th className="border border-gray-300 dark:border-gray-500 p-2 text-center font-semibold">Casey</th>
                          <th className="border border-gray-300 dark:border-gray-500 p-2 text-center font-semibold">Noah</th>
                          <th className="border border-gray-300 dark:border-gray-500 p-2 text-center font-semibold">Blake</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="hover:bg-gray-100 dark:hover:bg-gray-600">
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center font-medium">Front 9</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-green-600 dark:text-green-400">+£5</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-green-600 dark:text-green-400">+£5</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-red-600 dark:text-red-400">-£5</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-red-600 dark:text-red-400">-£5</td>
                        </tr>
                        <tr className="hover:bg-gray-100 dark:hover:bg-gray-600">
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center font-medium">Back 9</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-green-600 dark:text-green-400">+£5</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-green-600 dark:text-green-400">+£5</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-red-600 dark:text-red-400">-£5</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-red-600 dark:text-red-400">-£5</td>
                        </tr>
                        <tr className="hover:bg-gray-100 dark:hover:bg-gray-600">
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center font-medium">Match</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-green-600 dark:text-green-400">+£10</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-green-600 dark:text-green-400">+£10</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-red-600 dark:text-red-400">-£10</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-red-600 dark:text-red-400">-£10</td>
                        </tr>
                        <tr className="hover:bg-gray-100 dark:hover:bg-gray-600">
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center font-medium">NTP</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-green-600 dark:text-green-400">+£15</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-red-600 dark:text-red-400">-£5</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-red-600 dark:text-red-400">-£5</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-red-600 dark:text-red-400">-£5</td>
                        </tr>
                        <tr className="hover:bg-gray-100 dark:hover:bg-gray-600">
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center font-medium">LD</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-green-600 dark:text-green-400">+£15</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-red-600 dark:text-red-400">-£5</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-red-600 dark:text-red-400">-£5</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center text-red-600 dark:text-red-400">-£5</td>
                        </tr>
                        <tr className="bg-green-100 dark:bg-green-900 font-bold">
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center font-bold">Total</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center font-bold text-green-600 dark:text-green-400">+£50</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center font-bold text-green-600 dark:text-green-400">+£10</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center font-bold text-red-600 dark:text-red-400">-£30</td>
                          <td className="border border-gray-300 dark:border-gray-500 p-2 text-center font-bold text-red-600 dark:text-red-400">-£30</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            /* Velvet Jacket - Two Day Tournament */
            <Card className="bg-white dark:bg-gray-800 shadow-lg">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
                    <button
                      onClick={() => {
                        setCurrentTab('day1');
                        setCurrentDay('day1');
                      }}
                      className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                        currentTab === 'day1'
                          ? 'bg-blue-500 text-white'
                          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                    >
                      Day 1
                    </button>
                    <button
                      onClick={() => {
                        setCurrentTab('day2');
                        setCurrentDay('day2');
                      }}
                      className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                        currentTab === 'day2'
                          ? 'bg-blue-500 text-white'
                          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                    >
                      Day 2
                    </button>
                    <button
                      onClick={() => setCurrentTab('leaderboard')}
                      className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                        currentTab === 'leaderboard'
                          ? 'bg-blue-500 text-white'
                          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                    >
                      Leaderboard
                    </button>
                    <button
                      onClick={() => setCurrentTab('pl')}
                      className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                        currentTab === 'pl'
                          ? 'bg-blue-500 text-white'
                          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                    >
                      P/L
                    </button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-2">
                {currentTab === 'pl' ? (
                  isIslantilla ? (
                    /* Islantilla P/L View */
                    (() => {
                      const islPlayers = currentPlayers;
                      const calculateIslPL = () => {
                        const playerPL: Record<string, number> = {};
                        islPlayers.forEach(p => { playerPL[p.name] = 0; });
                        
                        const allHolesComplete = islPlayers.every(p =>
                          getHolesForDay('day1').every((hole: any) => getScore(p.name, hole.number, 'day1') !== undefined) &&
                          getHolesForDay('day2').every((hole: any) => getScore(p.name, hole.number, 'day2') !== undefined)
                        );
                        if (allHolesComplete) {
                          const sorted = islPlayers
                            .map(p => ({ name: p.name, pts: calculateTotalStableford(p.name) }))
                            .sort((a, b) => b.pts - a.pts);
                          const topPts = sorted[0]?.pts || 0;
                          const champWinners = topPts > 0 ? sorted.filter(p => p.pts === topPts) : [];
                          if (champWinners.length > 0) {
                            islPlayers.forEach(p => {
                              if (champWinners.find(w => w.name === p.name)) {
                                const share = Math.floor((islPlayers.length - champWinners.length) * 20 / champWinners.length);
                                playerPL[p.name] += share;
                              } else {
                                playerPL[p.name] -= 20;
                              }
                            });
                          }
                        }
                        
                        const otherPrizes = [
                          'nearest-pin-1',
                          'longest-drive-1', 'longest-drive-2',
                          'longest-putt-sunk'
                        ];
                        
                        otherPrizes.forEach(key => {
                          const winner = prizeWinners[key];
                          if (winner && winner !== '') {
                            playerPL[winner] += (islPlayers.length - 1) * 2.5;
                            islPlayers.forEach(p => {
                              if (p.name !== winner) {
                                playerPL[p.name] -= 2.5;
                              }
                            });
                          }
                        });

                        return playerPL;
                      };
                      
                      const playerPL = calculateIslPL();
                      
                      return (
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse text-xs">
                            <thead>
                              <tr className="bg-green-100 dark:bg-green-900">
                                <th className="border border-gray-300 dark:border-gray-600 p-2 text-left font-semibold"></th>
                                {islPlayers.map(p => (
                                  <th key={p.name} className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold">{p.name}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                                <td className="border border-gray-300 dark:border-gray-600 p-2 font-medium">Champion</td>
                                {(() => {
                                  const allComplete = islPlayers.every(p =>
                                    getHolesForDay('day1').every((hole: any) => getScore(p.name, hole.number, 'day1') !== undefined) &&
                                    getHolesForDay('day2').every((hole: any) => getScore(p.name, hole.number, 'day2') !== undefined)
                                  );
                                  if (!allComplete) {
                                    return islPlayers.map(p => (
                                      <td key={p.name} className="border border-gray-300 dark:border-gray-600 p-2 text-center">-</td>
                                    ));
                                  }
                                  const plSorted = islPlayers
                                    .map(p => ({ name: p.name, pts: calculateTotalStableford(p.name) }))
                                    .sort((a, b) => b.pts - a.pts);
                                  const plTopPts = plSorted[0]?.pts || 0;
                                  const plWinners = plTopPts > 0 ? plSorted.filter(p => p.pts === plTopPts) : [];
                                  return islPlayers.map(p => {
                                    const isChamp = plWinners.find(w => w.name === p.name);
                                    const hasChamp = plWinners.length > 0;
                                    const amount = isChamp
                                      ? Math.floor((islPlayers.length - plWinners.length) * 20 / plWinners.length)
                                      : hasChamp ? -20 : 0;
                                    return (
                                      <td key={p.name} className={`border border-gray-300 dark:border-gray-600 p-2 text-center font-medium ${amount > 0 ? 'text-green-600' : amount < 0 ? 'text-red-600' : ''}`}>
                                        {amount !== 0 ? (amount > 0 ? `+£${amount}` : `-£${Math.abs(amount)}`) : '-'}
                                      </td>
                                    );
                                  });
                                })()}
                              </tr>
                              {[
                                { key: 'nearest-pin-1', label: 'Nearest Pin #1', na: false },
                                { key: 'nearest-pin-2', label: 'Nearest Pin #2', na: true },
                                { key: 'longest-drive-1', label: 'Longest Drive #1', na: false },
                                { key: 'longest-drive-2', label: 'Longest Drive #2', na: false },
                                { key: 'longest-putt-sunk', label: 'Golden drain', na: false }
                              ].map(prize => (
                                <tr key={prize.key} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                                  <td className="border border-gray-300 dark:border-gray-600 p-2 font-medium">{prize.label}</td>
                                  {islPlayers.map(p => {
                                    if (prize.na) {
                                      return (
                                        <td key={p.name} className="border border-gray-300 dark:border-gray-600 p-2 text-center">-</td>
                                      );
                                    }
                                    const isWinner = prizeWinners[prize.key] === p.name;
                                    const hasWinner = prizeWinners[prize.key] && prizeWinners[prize.key] !== '';
                                    const amount = isWinner ? (islPlayers.length - 1) * 2.5 : hasWinner ? -2.5 : 0;
                                    return (
                                      <td key={p.name} className={`border border-gray-300 dark:border-gray-600 p-2 text-center font-medium ${amount > 0 ? 'text-green-600' : amount < 0 ? 'text-red-600' : ''}`}>
                                        {amount !== 0 ? (amount > 0 ? `+£${amount.toFixed(2)}` : `-£${Math.abs(amount).toFixed(2)}`) : '-'}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                              <tr className="bg-blue-100 dark:bg-blue-900 font-bold text-xs">
                                <td className="border border-gray-300 dark:border-gray-600 p-2 font-bold">TOTAL</td>
                                {islPlayers.map(p => {
                                  const total = playerPL[p.name];
                                  return (
                                    <td key={p.name} className={`border border-gray-300 dark:border-gray-600 p-2 text-center font-bold ${total > 0 ? 'text-green-600' : total < 0 ? 'text-red-600' : ''}`}>
                                      {total > 0 ? '+' : ''}£{total.toFixed(2)}
                                    </td>
                                  );
                                })}
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      );
                    })()
                  ) :
                  /* P/L View */
                  (() => {
                    // P/L Calculation Logic
                    const calculatePL = () => {
                      const playerPL: Record<string, number> = {};
                      
                      // Initialize all players with 0 (no buy-in cost shown)
                      players.forEach(player => {
                        playerPL[player.name] = 0;
                      });
                      
                      // Calculate champion winner automatically based on current standings
                      const sortedPlayers = players
                        .map(p => ({ name: p.name, stablefordTotal: calculateTotalStableford(p.name) }))
                        .sort((a, b) => b.stablefordTotal - a.stablefordTotal);
                      
                      const allHolesComplete = players.every(p => {
                        return currentCourse.holes.every(hole => 
                          getScore(p.name, hole.number, 'day1') !== undefined && 
                          getScore(p.name, hole.number, 'day2') !== undefined
                        );
                      });
                      
                      // Champion prize - Morgan won on playoff hole (hole 2: Morgan 4, Blake 5)
                      if (sortedPlayers[0]?.stablefordTotal > 0) {
                        players.forEach(player => {
                          if (player.name === 'Morgan') {
                            // Morgan gets +£45 for winning playoff
                            playerPL[player.name] += 45;
                          } else {
                            // Losers get -£15 each
                            playerPL[player.name] -= 15;
                          }
                        });
                      }
                      
                      const otherPrizes = [
                        { key: 'nearest-pin-1', amount: 5 },
                        { key: 'nearest-pin-2', amount: 5 },
                        { key: 'longest-drive-1', amount: 5 },
                        { key: 'longest-drive-2', amount: 5 },
                        { key: 'longest-putt-sunk', amount: 5 }
                      ];
                      
                      otherPrizes.forEach(prize => {
                        const winner = prizeWinners[prize.key];
                        if (winner && winner !== '') {
                          playerPL[winner] += (players.length - 1) * prize.amount;
                          players.forEach(player => {
                            if (player.name !== winner) {
                              playerPL[player.name] -= prize.amount;
                            }
                          });
                        }
                      });
                      
                      return playerPL;
                    };
                    
                    const playerPL = calculatePL();
                    
                    return (
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-xs">
                          <thead>
                            <tr className="bg-green-100 dark:bg-green-900">
                              <th className="border border-gray-300 dark:border-gray-600 p-2 text-left font-semibold"></th>
                              {players.map(player => (
                                <th key={player.name} className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold">{player.name}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                              <td className="border border-gray-300 dark:border-gray-600 p-2 font-medium">Champion</td>
                              {players.map(player => {
                                const sortedPlayers = players
                                  .map(p => ({ name: p.name, stablefordTotal: calculateTotalStableford(p.name) }))
                                  .sort((a, b) => b.stablefordTotal - a.stablefordTotal);
                                
                                const allHolesComplete = players.every(p => {
                                  return currentCourse.holes.every(hole => 
                                    getScore(p.name, hole.number, 'day1') !== undefined && 
                                    getScore(p.name, hole.number, 'day2') !== undefined
                                  );
                                });
                                
                                let amount = 0;
                                // Morgan won on playoff hole (hole 2: Morgan 4, Blake 5)
                                if (player.name === 'Morgan') {
                                  amount = 45; // Champion gets +£45
                                } else {
                                  amount = -15; // Losers get -£15 each
                                }
                                
                                return (
                                  <td key={player.name} className={`border border-gray-300 dark:border-gray-600 p-2 text-center font-medium ${amount > 0 ? 'text-green-600' : amount < 0 ? 'text-red-600' : ''}`}>
                                    {amount !== 0 ? (amount > 0 ? `+£${amount}` : `-£${Math.abs(amount)}`) : '-'}
                                  </td>
                                );
                              })}
                            </tr>
                            {[
                              { key: 'nearest-pin-1', label: 'Nearest Pin #1', amount: 5 },
                              { key: 'nearest-pin-2', label: 'Nearest Pin #2', amount: 5 },
                              { key: 'longest-drive-1', label: 'Longest Drive #1', amount: 5 },
                              { key: 'longest-drive-2', label: 'Longest Drive #2', amount: 5 },
                              { key: 'longest-putt-sunk', label: 'Golden drain', amount: 5 }
                            ].map(prize => (
                              <tr key={prize.key} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                                <td className="border border-gray-300 dark:border-gray-600 p-2 font-medium">{prize.label}</td>
                                {players.map(player => {
                                  const isWinner = prizeWinners[prize.key] === player.name;
                                  const hasWinner = prizeWinners[prize.key] && prizeWinners[prize.key] !== '';
                                  const amount = isWinner ? (players.length - 1) * prize.amount : hasWinner ? -prize.amount : 0;
                                  return (
                                    <td key={player.name} className={`border border-gray-300 dark:border-gray-600 p-2 text-center font-medium ${amount > 0 ? 'text-green-600' : amount < 0 ? 'text-red-600' : ''}`}>
                                      {amount !== 0 ? (amount > 0 ? `+£${amount.toFixed(2)}` : `-£${Math.abs(amount).toFixed(2)}`) : '-'}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                            <tr className="bg-blue-100 dark:bg-blue-900 font-bold text-xs">
                              <td className="border border-gray-300 dark:border-gray-600 p-2 font-bold">TOTAL</td>
                              {players.map(player => {
                                const total = playerPL[player.name];
                                const isPositive = total > 0;
                                const isNegative = total < 0;
                                return (
                                  <td key={player.name} className={`border border-gray-300 dark:border-gray-600 p-2 text-center font-bold ${isPositive ? 'text-green-600' : isNegative ? 'text-red-600' : ''}`}>
                                    {total > 0 ? '+' : ''}£{total.toFixed(2)}
                                  </td>
                                );
                              })}
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    );
                  })()
                ) : currentTab === 'leaderboard' ? (
                  isIslantilla ? (
                    /* Islantilla Leaderboard View */
                    <div>
                      <div className="flex justify-between items-center mb-4">
                        <h2 className="text-xl font-semibold text-gray-800 dark:text-white">Scoring (stableford)</h2>
                        <label className="flex items-center space-x-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={showDetailedLeaderboard}
                            onChange={(e) => setShowDetailedLeaderboard(e.target.checked)}
                            className="w-3 h-3 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500"
                          />
                          <span className="text-xs font-medium text-gray-900 dark:text-gray-300">Show details</span>
                        </label>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                          <thead>
                            <tr className="bg-gray-100 dark:bg-gray-700">
                              <th className="border border-gray-300 dark:border-gray-600 p-3 text-left font-semibold">Player</th>
                              <th className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold text-sm w-16">Day 1</th>
                              <th className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold text-sm w-16">Day 2</th>
                              {showDetailedLeaderboard && (
                                <>
                                  <th className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold text-sm w-16">Net</th>
                                  <th className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold text-sm w-16">Gross</th>
                                </>
                              )}
                              <th className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold bg-blue-100 dark:bg-blue-900 text-sm w-16">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {currentPlayers
                              .map(player => ({
                                name: player.name,
                                handicap: player.handicap,
                                day1Points: calculateDayStablefordPoints(player.name, 'day1'),
                                day2Points: calculateDayStablefordPoints(player.name, 'day2'),
                                totalPoints: calculateTotalStableford(player.name),
                                totalNet: showDetailedLeaderboard ? calculateTotalScoreRelativeToPar(player.name, 'net') : '',
                                totalGross: showDetailedLeaderboard ? calculateTotalScoreRelativeToPar(player.name, 'gross') : ''
                              }))
                              .sort((a, b) => b.totalPoints - a.totalPoints)
                              .map((player, index, sortedPlayers) => {
                                const allPlayersCompletedBothDays = currentPlayers.every(p => 
                                  getHolesForDay('day1').every((hole: any) => getScore(p.name, hole.number, 'day1') !== undefined) &&
                                  getHolesForDay('day2').every((hole: any) => getScore(p.name, hole.number, 'day2') !== undefined)
                                );
                                
                                const topScore = sortedPlayers[0]?.totalPoints || 0;
                                const isWinner = player.totalPoints === topScore && topScore > 0 && allPlayersCompletedBothDays;
                                
                                return (
                                  <tr key={player.name} className={`hover:bg-gray-50 dark:hover:bg-gray-700 ${isWinner ? 'bg-yellow-50 dark:bg-yellow-900/20' : ''}`}>
                                    <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">
                                      <div className="flex items-center">
                                        {isWinner && <span className="mr-1 text-yellow-600">🏆</span>}
                                        <span>{player.name}</span>
                                        {showDetailedLeaderboard && (
                                          <span className="ml-1 text-xs text-gray-400">({getPlayerHandicap(player.name, 'day1')}/{getPlayerHandicap(player.name, 'day2')})</span>
                                        )}
                                      </div>
                                    </td>
                                    <td className="border border-gray-300 dark:border-gray-600 p-2 text-center w-16">{player.day1Points}</td>
                                    <td className="border border-gray-300 dark:border-gray-600 p-2 text-center w-16">{player.day2Points}</td>
                                    {showDetailedLeaderboard && (
                                      <>
                                        <td className="border border-gray-300 dark:border-gray-600 p-2 text-center text-sm w-16">{player.totalNet}</td>
                                        <td className="border border-gray-300 dark:border-gray-600 p-2 text-center text-sm w-16">{player.totalGross}</td>
                                      </>
                                    )}
                                    <td className="border border-gray-300 dark:border-gray-600 p-2 text-center font-bold bg-blue-50 dark:bg-blue-900/50 w-16">{player.totalPoints} pts</td>
                                  </tr>
                                );
                              })
                            }
                          </tbody>
                        </table>
                      </div>

                      {/* Prizes Table */}
                      <div className="mt-8">
                        <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-white">Prizes</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse text-sm">
                            <thead>
                              <tr className="bg-green-100 dark:bg-green-900">
                                <th className="border border-gray-300 dark:border-gray-600 p-3 text-left font-semibold">Prize Category</th>
                                <th className="border border-gray-300 dark:border-gray-600 p-3 text-center font-semibold">Winner</th>
                              </tr>
                            </thead>
                            <tbody>
                              {/* Champion - auto-calculated from points */}
                              <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                                <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">Champion</td>
                                <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                  {(() => {
                                    const allComplete = currentPlayers.every(p =>
                                      getHolesForDay('day1').every((hole: any) => getScore(p.name, hole.number, 'day1') !== undefined) &&
                                      getHolesForDay('day2').every((hole: any) => getScore(p.name, hole.number, 'day2') !== undefined)
                                    );
                                    if (!allComplete) return '-';
                                    const sorted = currentPlayers
                                      .map(p => ({ name: p.name, pts: calculateTotalStableford(p.name) }))
                                      .sort((a, b) => b.pts - a.pts);
                                    const top = sorted[0];
                                    if (!top || top.pts === 0) return '-';
                                    const winners = sorted.filter(p => p.pts === top.pts);
                                    if (winners.length === 1) return `${top.name} (${top.pts} pts)`;
                                    return `Tie: ${winners.map(w => w.name).join(', ')} (${top.pts} pts)`;
                                  })()}
                                </td>
                              </tr>
                              {[
                                { key: 'nearest-pin-1', label: 'Nearest Pin #1' },
                                { key: 'nearest-pin-2', label: 'Nearest Pin #2', na: true },
                                { key: 'longest-drive-1', label: 'Longest Drive #1' },
                                { key: 'longest-drive-2', label: 'Longest Drive #2' },
                                { key: 'longest-putt-sunk', label: 'Golden drain' }
                              ].map(prize => (
                                <tr key={prize.key} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                                  <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">
                                    {prize.key === 'longest-putt-sunk' ? (
                                      <div className="flex items-center gap-2">
                                        Golden drain
                                        <div className="relative">
                                          <HelpCircle className="h-5 w-5 text-blue-500 cursor-pointer" onClick={() => setShowGoldenDrainInfo(!showGoldenDrainInfo)} />
                                          {showGoldenDrainInfo && (
                                            <div className="absolute bottom-6 left-0 bg-black text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                                              Longest hole-out
                                              <div className="absolute top-full left-2 border-2 border-transparent border-t-black"></div>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    ) : prize.label}
                                  </td>
                                  <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                    <div className="text-center font-medium">
                                      {'na' in prize && prize.na ? <span className="text-gray-400">N/A</span> : (prizeWinners[prize.key] || '-')}
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* Honours Table */}
                      <div className="mt-8">
                        <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-white">Honours</h3>
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse text-sm">
                            <thead>
                              <tr className="bg-orange-100 dark:bg-orange-900">
                                <th className="border border-gray-300 dark:border-gray-600 p-3 text-left font-semibold">Award Category</th>
                                <th className="border border-gray-300 dark:border-gray-600 p-3 text-center font-semibold">Winner</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                                <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">
                                  <div className="flex items-center gap-2">
                                    Mr Blobby
                                    <div className="relative">
                                      <HelpCircle className="h-5 w-5 text-blue-500 cursor-pointer" onClick={() => setShowMrBlobbyInfo(!showMrBlobbyInfo)} />
                                      {showMrBlobbyInfo && (
                                        <div className="absolute bottom-6 left-0 bg-black text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                                          Most blobs (0-point holes)
                                          <div className="absolute top-full left-2 border-2 border-transparent border-t-black"></div>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </td>
                                <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                  {(() => {
                                    const playerBlobs = currentPlayers.map(player => ({
                                      name: player.name,
                                      blobs: calculateBlobs(player.name)
                                    })).filter(p => p.blobs > 0);
                                    if (playerBlobs.length === 0) return '-';
                                    const maxBlobs = Math.max(...playerBlobs.map(p => p.blobs));
                                    const winners = playerBlobs.filter(p => p.blobs === maxBlobs);
                                    if (winners.length === 1) return `${winners[0].name} (${winners[0].blobs})`;
                                    return `Tie: ${winners.map(w => `${w.name} (${w.blobs})`).join(', ')}`;
                                  })()}
                                </td>
                              </tr>
                              {[
                                { key: 'most-lost-balls', label: 'Most Lost Balls' },
                                { key: 'worst-shot', label: 'Worst Shot' },
                                { key: 'shortest-putt-missed', label: 'Shortest Putt Missed' }
                              ].map(award => (
                                <tr key={award.key} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                                  <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">{award.label}</td>
                                  <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                    <div className="text-center font-medium">
                                      {prizeWinners[award.key] || '-'}
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  ) :
                  /* Leaderboard View */
                  <div>
                    <div className="flex justify-between items-center mb-4">
                      <h2 className="text-xl font-semibold text-gray-800 dark:text-white">Scoring (stableford)</h2>
                      <label className="flex items-center space-x-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={showDetailedLeaderboard}
                          onChange={(e) => setShowDetailedLeaderboard(e.target.checked)}
                          className="w-3 h-3 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                        />
                        <span className="text-xs font-medium text-gray-900 dark:text-gray-300">
                          Show details
                        </span>
                      </label>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr className="bg-gray-100 dark:bg-gray-700">
                            <th className="border border-gray-300 dark:border-gray-600 p-3 text-left font-semibold">Player</th>
                            <th className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold text-sm w-16">Day 1</th>
                            <th className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold text-sm w-16">Day 2</th>
                            {showDetailedLeaderboard && (
                              <>
                                <th className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold text-sm w-16">Net</th>
                                <th className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold text-sm w-16">Gross</th>
                              </>
                            )}
                            <th className="border border-gray-300 dark:border-gray-600 p-2 text-center font-semibold bg-blue-100 dark:bg-blue-900 text-sm w-16">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {players
                            .map(player => ({
                              name: player.name,
                              handicap: player.handicap,
                              day1Points: calculateDayStablefordPoints(player.name, 'day1'),
                              day2Points: calculateDayStablefordPoints(player.name, 'day2'),
                              totalPoints: calculateTotalStableford(player.name),
                              totalNet: showDetailedLeaderboard ? calculateTotalScoreRelativeToPar(player.name, 'net') : '',
                              totalGross: showDetailedLeaderboard ? calculateTotalScoreRelativeToPar(player.name, 'gross') : ''
                            }))
                            .sort((a, b) => {
                              // If points are equal, Morgan comes first (playoff winner)
                              if (a.totalPoints === b.totalPoints) {
                                if (a.name === 'Morgan') return -1;
                                if (b.name === 'Morgan') return 1;
                                return 0;
                              }
                              return b.totalPoints - a.totalPoints;
                            })
                            .map((player, index, sortedPlayers) => {
                              // Check if all players have completed both days
                              const allPlayersCompletedBothDays = players.every(p => 
                                currentCourse.holes.every(hole => 
                                  getScore(p.name, hole.number, 'day1') !== undefined && 
                                  getScore(p.name, hole.number, 'day2') !== undefined
                                )
                              );
                              
                              // Find the highest stableford score
                              const topScore = sortedPlayers[0]?.totalPoints || 0;
                              
                              // Morgan won on playoff hole (hole 2: Morgan 4, Blake 5)
                              const isWinner = player.name === 'Morgan' && topScore > 0 && allPlayersCompletedBothDays;
                              
                              return (
                                <tr key={player.name} className={`hover:bg-gray-50 dark:hover:bg-gray-700 ${isWinner ? 'bg-yellow-50 dark:bg-yellow-900/20' : ''}`}>
                                  <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">
                                    <div className="flex items-center">
                                      {isWinner && <span className="mr-1 text-yellow-600">🏆</span>}
                                      <span>{player.name}</span>
                                    </div>
                                  </td>
                                  <td className="border border-gray-300 dark:border-gray-600 p-2 text-center w-16">
                                    {player.day1Points}
                                  </td>
                                  <td className="border border-gray-300 dark:border-gray-600 p-2 text-center w-16">
                                    {player.day2Points}
                                  </td>
                                  {showDetailedLeaderboard && (
                                    <>
                                      <td className="border border-gray-300 dark:border-gray-600 p-2 text-center text-sm w-16">
                                        {player.totalNet}
                                      </td>
                                      <td className="border border-gray-300 dark:border-gray-600 p-2 text-center text-sm w-16">
                                        {player.totalGross}
                                      </td>
                                    </>
                                  )}
                                  <td className="border border-gray-300 dark:border-gray-600 p-2 text-center font-bold bg-blue-50 dark:bg-blue-900/50 w-16">
                                    {player.totalPoints} pts
                                  </td>
                                </tr>
                              );
                            })
                          }
                        </tbody>
                      </table>
                    </div>

                    {/* Prizes/Minigames Table */}
                    <div className="mt-8">
                      <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-white">Prizes</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                          <thead>
                            <tr className="bg-green-100 dark:bg-green-900">
                              <th className="border border-gray-300 dark:border-gray-600 p-3 text-left font-semibold">Prize Category</th>
                              <th className="border border-gray-300 dark:border-gray-600 p-3 text-center font-semibold">Winner</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                              <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">Champion</td>
                              <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                {(() => {
                                  // Morgan won on playoff hole (hole 2: Morgan 4, Blake 5)
                                  return 'Morgan';
                                })()}
                              </td>
                            </tr>
                            <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                              <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">Nearest Pin #1</td>
                              <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                <div className="text-center font-medium">
                                  {prizeWinners['nearest-pin-1'] || '-'}
                                </div>
                              </td>
                            </tr>
                            <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                              <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">Nearest Pin #2</td>
                              <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                <div className="text-center font-medium text-gray-400">
                                  N/A
                                </div>
                              </td>
                            </tr>
                            <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                              <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">Longest Drive #1</td>
                              <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                <div className="text-center font-medium">
                                  {prizeWinners['longest-drive-1'] || '-'}
                                </div>
                              </td>
                            </tr>
                            <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                              <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">Longest Drive #2</td>
                              <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                <div className="text-center font-medium">
                                  {prizeWinners['longest-drive-2'] || '-'}
                                </div>
                              </td>
                            </tr>
                            <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                              <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">
                                <div className="flex items-center gap-2">
                                  Golden drain
                                  <div className="relative">
                                    <HelpCircle 
                                      className="h-5 w-5 text-blue-500 cursor-pointer" 
                                      onClick={() => setShowGoldenDrainInfo(!showGoldenDrainInfo)}
                                    />
                                    {showGoldenDrainInfo && (
                                      <div className="absolute bottom-6 left-0 bg-black text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                                        Longest hole-out
                                        <div className="absolute top-full left-2 border-2 border-transparent border-t-black"></div>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                <div className="text-center font-medium">
                                  {prizeWinners['longest-putt-sunk'] || '-'}
                                </div>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Honours Table */}
                    <div className="mt-8">
                      <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-white">Honours</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                          <thead>
                            <tr className="bg-orange-100 dark:bg-orange-900">
                              <th className="border border-gray-300 dark:border-gray-600 p-3 text-left font-semibold">Award Category</th>
                              <th className="border border-gray-300 dark:border-gray-600 p-3 text-center font-semibold">Winner</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                              <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">
                                <div className="flex items-center gap-2">
                                  Mr Blobby
                                  <div className="relative">
                                    <HelpCircle 
                                      className="h-5 w-5 text-blue-500 cursor-pointer" 
                                      onClick={() => setShowMrBlobbyInfo(!showMrBlobbyInfo)}
                                    />
                                    {showMrBlobbyInfo && (
                                      <div className="absolute bottom-6 left-0 bg-black text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
                                        Most blobs (0-point holes)
                                        <div className="absolute top-full left-2 border-2 border-transparent border-t-black"></div>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                {(() => {
                                  const playerBlobs = players.map(player => ({
                                    name: player.name,
                                    blobs: calculateBlobs(player.name)
                                  })).filter(p => p.blobs > 0);
                                  
                                  if (playerBlobs.length === 0) return '';
                                  
                                  const maxBlobs = Math.max(...playerBlobs.map(p => p.blobs));
                                  const winners = playerBlobs.filter(p => p.blobs === maxBlobs);
                                  
                                  if (winners.length === 1) {
                                    return `${winners[0].name} (${winners[0].blobs})`;
                                  } else if (winners.length > 1) {
                                    return `Tie: ${winners.map(w => `${w.name} (${w.blobs})`).join(', ')}`;
                                  }
                                  
                                  return '';
                                })()}
                              </td>
                            </tr>
                            <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                              <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">Most Lost Balls</td>
                              <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                <div className="text-center font-medium">
                                  {prizeWinners['most-lost-balls'] || '-'}
                                </div>
                              </td>
                            </tr>
                            <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                              <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">Worst Shot</td>
                              <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                <div className="text-center font-medium">
                                  {prizeWinners['worst-shot'] || '-'}
                                </div>
                              </td>
                            </tr>
                            <tr className="hover:bg-gray-50 dark:hover:bg-gray-700">
                              <td className="border border-gray-300 dark:border-gray-600 p-3 font-medium">Shortest Putt Missed</td>
                              <td className="border border-gray-300 dark:border-gray-600 p-3 text-center">
                                <div className="text-center font-medium">
                                  {prizeWinners['shortest-putt-missed'] || '-'}
                                </div>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                ) : isIslantilla ? (
                  /* Islantilla Scorecard View */
                  <div>
                    <div className="mb-4 flex justify-between items-center">
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {currentDay === 'day1' ? 'Yellow + Green courses' : 'Yellow + Green courses'}
                      </div>
                      <label className="flex items-center space-x-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={showPoints}
                          onChange={(e) => setShowPoints(e.target.checked)}
                          className="w-3 h-3 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500"
                        />
                        <span className="text-xs font-medium text-gray-900 dark:text-gray-300">Show points</span>
                      </label>
                    </div>
                    <div className="overflow-x-auto -mx-4 sm:mx-0">
                      <table className="w-full border-collapse text-xs">
                        <thead>
                          <tr className="bg-gray-100 dark:bg-gray-700">
                            <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-6">Hole</th>
                            <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8 bg-yellow-100 dark:bg-yellow-900">Yds</th>
                            <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-6">SI</th>
                            <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-6">Par</th>
                            {currentPlayers.map(player => (
                              <th key={player.name} className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-14">
                                <div>{player.name}</div>
                                <div className="text-[9px] text-gray-500">({getPlayerHandicap(player.name, currentDay)})</div>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {getHolesForDay(currentDay).map((hole: any) => (
                            <tr key={hole.number} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                              <td className="border border-gray-300 dark:border-gray-600 p-1 text-center font-bold">{hole.number}</td>
                              <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-yellow-200 dark:bg-yellow-800">{hole.yardage}</td>
                              <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">{hole.strokeIndex}</td>
                              <td className="border border-gray-300 dark:border-gray-600 p-1 text-center font-medium">{hole.par}</td>
                              {currentPlayers.map(player => {
                                const score = getScore(player.name, hole.number, currentDay);
                                const scoreDisplay = getScoreDisplay(score || null, hole.par, false);
                                return (
                                  <td key={player.name} className="border border-gray-300 dark:border-gray-600 p-1 text-center font-medium">
                                    <div className="flex justify-center">
                                      <div className={scoreDisplay.className || 'w-7 h-7 flex items-center justify-center'}>
                                        {showPoints && score ? (
                                          <span className="text-[10px] whitespace-nowrap">
                                            {score}({calculateHoleStablefordPoints(player.name, hole.number, currentDay)})
                                          </span>
                                        ) : isEventEnded ? (
                                          <span className="text-xs font-medium text-gray-900 dark:text-white">
                                            {score || ''}
                                          </span>
                                        ) : (
                                          <input
                                            type="number"
                                            min="0"
                                            max="12"
                                            value={score || ''}
                                            onChange={(e) => {
                                              const value = e.target.value;
                                              if (value === '' || value === '0') {
                                                updateScore(player.name, hole.number, currentDay, '');
                                                if (tournament?.id) {
                                                  fetch('/api/golf/scores', {
                                                    method: 'DELETE',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({
                                                      tournamentId: tournament.id,
                                                      playerName: player.name,
                                                      hole: hole.number,
                                                      day: currentDay === 'day1' ? 1 : 2
                                                    })
                                                  }).then(() => {
                                                    queryClient.invalidateQueries({ queryKey: ['/api/golf/tournaments', tournament.id, 'scores'] });
                                                  });
                                                }
                                              } else {
                                                updateScore(player.name, hole.number, currentDay, value);
                                              }
                                            }}
                                            className="w-full h-full text-center text-xs font-medium border-0 bg-transparent text-gray-900 dark:text-white focus:outline-none"
                                          />
                                        )}
                                      </div>
                                    </div>
                                    <div className="flex justify-center mt-0.5">
                                      {renderHandicapDots(getPlayerHandicap(player.name, currentDay), hole.strokeIndex)}
                                    </div>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                          <tr className="bg-green-100 dark:bg-green-900 font-bold">
                            <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">TOT</td>
                            <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-yellow-200 dark:bg-yellow-700">
                              {getHolesForDay(currentDay).reduce((sum: number, hole: any) => sum + hole.yardage, 0)}
                            </td>
                            <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">-</td>
                            <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">
                              {getHolesForDay(currentDay).reduce((sum: number, hole: any) => sum + hole.par, 0)}
                            </td>
                            {currentPlayers.map(player => (
                              <td key={player.name} className="border border-gray-300 dark:border-gray-600 p-1 text-center text-xs">
                                {showPoints 
                                  ? `${calculateDayStablefordPoints(player.name, currentDay)} pts` 
                                  : (calculateGross(player.name, currentDay, getHolesForDay(currentDay).map((h: any) => h.number)) || '-')
                                }
                              </td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  /* Oxfordshire Scorecard View */
                  <div>
                    <div className="mb-4 flex justify-end">
                      <label className="flex items-center space-x-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={showPoints}
                          onChange={(e) => setShowPoints(e.target.checked)}
                          className="w-3 h-3 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                        />
                        <span className="text-xs font-medium text-gray-900 dark:text-gray-300">
                          Show points
                        </span>
                      </label>
                    </div>
                    <div className="overflow-x-auto -mx-4 sm:mx-0">
                    <table className="w-full border-collapse text-xs sm:text-sm">
                      <thead>
                        <tr className="bg-gray-100 dark:bg-gray-700">
                          <th className="border-none p-0 w-3" style={{ borderColor: 'transparent' }}></th>
                          <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8">Hole</th>
                          <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-10 bg-yellow-100 dark:bg-yellow-900">Yds</th>
                          <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8">SI</th>
                          <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-10">Par</th>
                          <th className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-semibold w-20 sm:w-24">
                            <span className="hidden sm:inline">Alex (hcp {getPlayerHandicap('Alex', currentDay)})</span>
                            <span className="sm:hidden">Alex ({getPlayerHandicap('Alex', currentDay)})</span>
                          </th>
                          <th className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-semibold w-20 sm:w-24">
                            <span className="hidden sm:inline">Noah (hcp {getPlayerHandicap('Noah', currentDay)})</span>
                            <span className="sm:hidden">Noah ({getPlayerHandicap('Noah', currentDay)})</span>
                          </th>
                          <th className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-semibold w-20 sm:w-24"><span className="hidden sm:inline">Morgan (hcp 32)</span><span className="sm:hidden">Morgan (32)</span></th>
                          <th className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-semibold w-20 sm:w-24"><span className="hidden sm:inline">Blake (hcp 14)</span><span className="sm:hidden">Blake (14)</span></th>
                        </tr>
                      </thead>
                    <tbody>
                      {(currentDay === 'day2' ? [...currentCourse.holes, {number: 19, par: 3, yardage: 128, strokeIndex: 16}] : currentCourse.holes).map(hole => {
                        let alexScore, noahScore, morganScore, blakeScore;
                        if (hole.number === 19) {
                          alexScore = null;
                          noahScore = null;
                          morganScore = 4;
                          blakeScore = 5;
                        } else {
                          alexScore = getScore('Alex', hole.number, currentDay);
                          noahScore = getScore('Noah', hole.number, currentDay);
                          morganScore = getScore('Morgan', hole.number, currentDay);
                          blakeScore = getScore('Blake', hole.number, currentDay);
                        }

                        const alexDisplay = getScoreDisplay(alexScore || null, hole.par, false);
                        const noahDisplay = getScoreDisplay(noahScore || null, hole.par, false);
                        const morganDisplay = getScoreDisplay(morganScore || null, hole.par, false);
                        const blakeDisplay = getScoreDisplay(blakeScore || null, hole.par, false);
                        
                        return (
                          <tr key={hole.number} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                            <td className="border-none p-0 text-center w-3" style={{ borderColor: 'transparent' }}>
                              {currentDay === 'day1' && hole.number === 5 && (
                                <span title="Nearest to Pin">🎯</span>
                              )}
                              {currentDay === 'day1' && hole.number === 10 && (
                                <span title="Longest Drive">🏌️‍♂️</span>
                              )}
                              {currentDay === 'day2' && hole.number === 2 && (
                                <span title="Nearest to Pin">🎯</span>
                              )}
                              {currentDay === 'day2' && hole.number === 7 && (
                                <span title="Longest Drive">🏌️‍♂️</span>
                              )}
                            </td>
                            <td className="border border-gray-300 dark:border-gray-600 p-1 text-center font-bold">
                              {hole.number === 19 ? 'PLAYOFF' : hole.number}
                            </td>
                            <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-yellow-200 dark:bg-yellow-800">
                              {hole.yardage}
                            </td>
                            <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">
                              {hole.strokeIndex}
                            </td>
                            <td className="border border-gray-300 dark:border-gray-600 p-1 text-center font-medium">
                              {hole.par}
                            </td>
                            
                            {[
                              { name: 'Alex', score: alexScore, display: alexDisplay },
                              { name: 'Noah', score: noahScore, display: noahDisplay },
                              { name: 'Morgan', score: morganScore, display: morganDisplay },
                              { name: 'Blake', score: blakeScore, display: blakeDisplay },
                            ].map(({ name, score, display }) => (
                              <td key={name} className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-medium">
                                <div className="flex justify-center">
                                  <div className={display.className || 'w-8 h-8 flex items-center justify-center'}>
                                    {showPoints && score ? (
                                      <span className="text-xs whitespace-nowrap">
                                        {score}({calculateHoleStablefordPoints(name, hole.number, currentDay)})
                                      </span>
                                    ) : (
                                      <span className="text-sm font-medium text-gray-900 dark:text-white">
                                        {score || ''}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex justify-center mt-1">
                                  {renderHandicapDots(getPlayerHandicap(name, currentDay), hole.strokeIndex)}
                                </div>
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                      
                      <tr className="bg-gray-100 dark:bg-gray-700">
                        <th className="border-none p-0 w-3" style={{ borderColor: 'transparent' }}></th>
                        <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8">Hole</th>
                        <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-10 bg-yellow-100 dark:bg-yellow-900">Yds</th>
                        <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-8">SI</th>
                        <th className="border border-gray-300 dark:border-gray-600 p-1 text-center font-semibold w-10">Par</th>
                        <th className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-semibold w-20 sm:w-24">
                          <span className="hidden sm:inline">Alex (hcp {getPlayerHandicap('Alex', currentDay)})</span>
                          <span className="sm:hidden">Alex ({getPlayerHandicap('Alex', currentDay)})</span>
                        </th>
                        <th className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-semibold w-20 sm:w-24">
                          <span className="hidden sm:inline">Noah (hcp {getPlayerHandicap('Noah', currentDay)})</span>
                          <span className="sm:hidden">Noah ({getPlayerHandicap('Noah', currentDay)})</span>
                        </th>
                        <th className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-semibold w-20 sm:w-24"><span className="hidden sm:inline">Morgan (hcp 32)</span><span className="sm:hidden">Morgan (32)</span></th>
                        <th className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center font-semibold w-20 sm:w-24"><span className="hidden sm:inline">Blake (hcp 14)</span><span className="sm:hidden">Blake (14)</span></th>
                      </tr>
                      
                      <tr className="bg-green-100 dark:bg-green-900 font-bold">
                        <td className="border-none p-0 w-3" style={{ borderColor: 'transparent' }}></td>
                        <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">TOTAL</td>
                        <td className="border border-gray-300 dark:border-gray-600 p-1 text-center bg-yellow-200 dark:bg-yellow-700">
                          {currentCourse.holes.reduce((sum, hole) => sum + hole.yardage, 0)}
                        </td>
                        <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">-</td>
                        <td className="border border-gray-300 dark:border-gray-600 p-1 text-center">
                          {currentCourse.holes.reduce((sum, hole) => sum + hole.par, 0)}
                        </td>
                        <td className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center">
                          {showPoints ? `${calculateDayStablefordPoints('Alex', currentDay)} pts` : (calculateGross('Alex', currentDay, currentCourse.holes.map(h => h.number)) || '-')}
                        </td>
                        <td className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center">
                          {showPoints ? `${calculateDayStablefordPoints('Noah', currentDay)} pts` : (calculateGross('Noah', currentDay, currentCourse.holes.map(h => h.number)) || '-')}
                        </td>
                        <td className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center">
                          {showPoints ? `${calculateDayStablefordPoints('Morgan', currentDay)} pts` : (calculateGross('Morgan', currentDay, currentCourse.holes.map(h => h.number)) || '-')}
                        </td>
                        <td className="border border-gray-300 dark:border-gray-600 p-1 sm:p-2 text-center">
                          {showPoints ? `${calculateDayStablefordPoints('Blake', currentDay)} pts` : (calculateGross('Blake', currentDay, currentCourse.holes.map(h => h.number)) || '-')}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

        </div>
      </div>
    </div>
  );
}
