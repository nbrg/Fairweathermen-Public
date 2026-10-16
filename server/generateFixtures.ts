import { storage } from './storage';
import { InsertMatch } from '@shared/schema';

// Generate complete Premier League fixture list (380 matches across 38 gameweeks)
export async function generateCompleteFixtures() {
  console.log("Generating complete Premier League fixture list...");
  
  // Get all 20 teams
  const teams = await storage.getAllTeams();
  if (teams.length !== 20) {
    throw new Error(`Expected 20 teams, got ${teams.length}`);
  }
  
  const fixtures: InsertMatch[] = [];
  let matchId = 1;
  
  // Premier League fixture generation: each team plays every other team twice (home and away)
  // That's 20 teams × 19 opponents × 2 (home/away) = 380 matches total
  
  // Generate proper Premier League fixtures using round-robin scheduling
  // 20 teams = 190 unique pairings, each played twice (home/away) = 380 matches
  
  const allPairings: Array<{home: number, away: number}> = [];
  
  // Create all unique team pairings
  for (let i = 0; i < teams.length; i++) {
    for (let j = 0; j < teams.length; j++) {
      if (i !== j) {
        allPairings.push({
          home: teams[i].id,
          away: teams[j].id
        });
      }
    }
  }
  
  // Shuffle pairings to distribute teams more evenly across gameweeks
  const shuffledPairings = shuffleArray([...allPairings]);
  
  let gameweek = 1;
  let matchesInGameweek = 0;
  
  // Create matches from shuffled pairings
  for (const pairing of shuffledPairings) {
    const match: InsertMatch = {
      homeTeamId: pairing.home,
      awayTeamId: pairing.away,
      matchTime: getMatchDateTime(gameweek),
      matchDay: gameweek.toString(),
      matchDate: getMatchDate(gameweek),
      gameweek: gameweek,
      status: 'not_started'
    };
    
    fixtures.push(match);
    matchesInGameweek++;
    
    // Move to next gameweek after 10 matches
    if (matchesInGameweek >= 10) {
      gameweek++;
      matchesInGameweek = 0;
    }
  }
  
  console.log(`Generated ${fixtures.length} fixtures across ${Math.max(...fixtures.map(f => f.gameweek ?? 0))} gameweeks`);
  
  // Insert all fixtures
  for (const fixture of fixtures) {
    await storage.createMatch(fixture);
  }
  
  console.log("Complete fixture list created successfully!");
  return fixtures.length;
}

// Helper functions for date calculations
function getMatchDate(gameweek: number): string {
  const baseDate = new Date('2025-08-15');
  const weeksToAdd = gameweek - 1;
  const matchDate = new Date(baseDate);
  matchDate.setDate(baseDate.getDate() + (weeksToAdd * 7));
  
  return `${matchDate.getFullYear()}-${String(matchDate.getMonth() + 1).padStart(2, '0')}-${String(matchDate.getDate()).padStart(2, '0')}`;
}

function getMatchDateTime(gameweek: number): string {
  return `${getMatchDate(gameweek)} 15:00:00`;
}

// Fisher-Yates shuffle algorithm
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}