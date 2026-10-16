export type Team = {
  id: number;
  name: string;
  shortName: string;
};

// The scraper / football-data sync store finished EPL matches as 'finished';
// 'completed' is kept for older code paths that compare against it.
export type MatchStatus = 'not_started' | 'in_progress' | 'completed' | 'finished';

export type Match = {
  id: number;
  homeTeamId: number;
  awayTeamId: number;
  homeScore?: number;
  awayScore?: number;
  status: MatchStatus;
  // Live match minute (e.g. 34 → "34'") while in progress; null/absent otherwise.
  minute?: number | null;
  matchTime: string;
  matchDay: string;
  gameweek: number;
  homeTeam?: Team;
  awayTeam?: Team;
};

export type Prediction = {
  id: number;
  userId: number;
  matchId: number;
  homeScore: number;
  awayScore: number;
  // True when auto-randomised because the player missed the gameweek deadline.
  isAutoPick?: boolean;
  // True when this is another player's pick before the deadline: the API
  // confirms a pick exists but withholds the scoreline (homeScore/awayScore
  // absent) until the gameweek deadline passes.
  hidden?: boolean;
  match?: Match;
  points?: number;
  status?: 'exact_score' | 'correct_result' | 'incorrect' | 'not_started';
};

export type User = {
  id: number;
  username: string;
};

export type LeaderboardEntry = User & {
  predictions: Prediction[];
  exactScores: number;
  correctResults: number;
  totalPoints: number;
};

export type Tab = 'leaderboard' | 'my-predictions' | 'all-predictions';
