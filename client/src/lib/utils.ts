import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { Match, Prediction } from "./types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// The site owner's username. The Activity/Audit logs' "Hide my own activity"
// hides entries attributed to this user (by name, regardless of location) — so
// someone else logging in from the owner's home city is still shown.
export const OWN_USERNAME = "Alex";
export function isOwnUsername(username: string | null | undefined): boolean {
  return (username ?? "").trim().toLowerCase() === OWN_USERNAME.toLowerCase();
}

export function formatDateTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatMatchStatus(status: string, time: string): string {
  if (status === 'not_started') {
    return time;
  } else if (status === 'completed') {
    return 'Finished';
  } else if (status === 'in_progress') {
    return time; // Or could format to "Live" or something similar
  }
  
  return status;
}

export function calculatePoints(prediction: Prediction, match: Match): { points: number, status: string } {
  // If match hasn't started or doesn't have scores yet
  if (match.status === 'not_started' || match.homeScore === undefined || match.awayScore === undefined) {
    return { points: 0, status: 'not_started' };
  }
  
  // Exact score (3 points)
  if (prediction.homeScore === match.homeScore && prediction.awayScore === match.awayScore) {
    return { points: 3, status: 'exact_score' };
  }
  
  // Correct result type: win, lose, or draw (1 point)
  const predictionResult = prediction.homeScore > prediction.awayScore 
    ? 'home_win' 
    : prediction.homeScore < prediction.awayScore 
      ? 'away_win' 
      : 'draw';
  
  const matchResult = match.homeScore > match.awayScore 
    ? 'home_win' 
    : match.homeScore < match.awayScore 
      ? 'away_win' 
      : 'draw';
  
  if (predictionResult === matchResult) {
    return { points: 1, status: 'correct_result' };
  }
  
  // Incorrect result (0 points)
  return { points: 0, status: 'incorrect' };
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'exact_score':
      return 'bg-status-correct text-white';
    case 'correct_result':
      return 'bg-status-partial text-white';
    case 'incorrect':
      return 'bg-status-incorrect text-white';
    case 'not_started':
    default:
      return 'bg-gray-200 text-gray-800';
  }
}

export function getStatusText(status: string): string {
  switch (status) {
    case 'exact_score':
      return 'Exact Score';
    case 'correct_result':
      return 'Correct Result';
    case 'incorrect':
      return 'Wrong Result';
    case 'in_progress':
      return 'In Progress';
    case 'not_started':
    default:
      return 'Not Started';
  }
}

export function getScoreDisplay(homeScore?: number, awayScore?: number): string {
  if (homeScore === undefined || awayScore === undefined) {
    return '- - -';
  }
  return `${homeScore} - ${awayScore}`;
}

export function getRankBackground(rank: number): string {
  switch (rank) {
    case 1:
      return 'bg-yellow-400 text-white';
    case 2:
      return 'bg-gray-400 text-white';
    case 3:
      return 'bg-orange-400 text-white';
    default:
      return rank <= 5 ? 'bg-gray-200 text-gray-700' : 'bg-blue-500 text-white';
  }
}

export function getRowBackground(rank: number): string {
  switch (rank) {
    case 1:
      return 'bg-yellow-50';
    case 2:
      return 'bg-gray-50';
    case 3:
      return 'bg-orange-50';
    case 6: // Assuming rank 6 is "You"
      return 'bg-blue-50';
    default:
      return rank % 2 === 0 ? 'bg-gray-50' : '';
  }
}

export function getBorderClass(status: string): string {
  switch (status) {
    case 'exact_score':
      return 'border-l-4 border-status-correct';
    case 'correct_result':
      return 'border-l-4 border-status-partial';
    case 'incorrect':
      return 'border-l-4 border-status-incorrect';
    case 'not_started':
    default:
      return 'border-l-4 border-gray-300';
  }
}
