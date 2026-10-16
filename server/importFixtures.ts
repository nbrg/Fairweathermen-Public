import XLSX from 'xlsx';
import { storage } from './storage';
import type { InsertMatch } from '@shared/schema';

interface ExcelFixture {
  Gameweek: string | number;
  Date: number | string;
  Time: number | string;
  'Home Team': string;
  'Away Team': string;
  [key: string]: any;
}

// Team name mapping to handle variations
const TEAM_NAME_MAPPING: Record<string, string> = {
  // Arsenal variations
  'ARS': 'Arsenal', 'arsenal': 'Arsenal', 'ARSENAL': 'Arsenal',
  
  // Manchester United variations  
  'MAN U': 'Manchester United', 'MANU': 'Manchester United', 'ManU': 'Manchester United',
  'manU': 'Manchester United', 'Man Utd': 'Manchester United', 'MAN UTD': 'Manchester United',
  'man utd': 'Manchester United', 'Manchester Utd': 'Manchester United', 'MANCHESTER UNITED': 'Manchester United',
  'manchester united': 'Manchester United',
  
  // Manchester City variations
  'MAN C': 'Manchester City', 'MANC': 'Manchester City', 'ManC': 'Manchester City',
  'Man City': 'Manchester City', 'MAN CITY': 'Manchester City', 'man city': 'Manchester City',
  'MANCHESTER CITY': 'Manchester City', 'manchester city': 'Manchester City',
  
  // Liverpool variations
  'LIV': 'Liverpool', 'liv': 'Liverpool', 'LIVERPOOL': 'Liverpool', 'liverpool': 'Liverpool',
  
  // Chelsea variations
  'CHE': 'Chelsea', 'che': 'Chelsea', 'CHELSEA': 'Chelsea', 'chelsea': 'Chelsea',
  
  // Tottenham variations
  'TOT': 'Tottenham', 'tot': 'Tottenham', 'TOTTENHAM': 'Tottenham', 'tottenham': 'Tottenham',
  'Spurs': 'Tottenham', 'SPURS': 'Tottenham', 'spurs': 'Tottenham',
  
  // Newcastle variations
  'NEW': 'Newcastle', 'new': 'Newcastle', 'NEWCASTLE': 'Newcastle', 'newcastle': 'Newcastle',
  
  // Brighton variations
  'BRI': 'Brighton', 'bri': 'Brighton', 'BRIGHTON': 'Brighton', 'brighton': 'Brighton',
  
  // West Ham variations
  'WHU': 'West Ham', 'whu': 'West Ham', 'WEST HAM': 'West Ham', 'west ham': 'West Ham',
  
  // Aston Villa variations
  'AVL': 'Aston Villa', 'avl': 'Aston Villa', 'ASTON VILLA': 'Aston Villa', 'aston villa': 'Aston Villa',
  'Villa': 'Aston Villa', 'VILLA': 'Aston Villa', 'villa': 'Aston Villa',
  
  // Crystal Palace variations
  'CRY': 'Crystal Palace', 'cry': 'Crystal Palace', 'CRYSTAL PALACE': 'Crystal Palace', 
  'crystal palace': 'Crystal Palace', 'Palace': 'Crystal Palace', 'PALACE': 'Crystal Palace', 'palace': 'Crystal Palace',
  
  // Everton variations
  'EVE': 'Everton', 'eve': 'Everton', 'EVERTON': 'Everton', 'everton': 'Everton',
  
  // Fulham variations
  'FUL': 'Fulham', 'ful': 'Fulham', 'FULHAM': 'Fulham', 'fulham': 'Fulham',
  
  // Brentford variations
  'BRE': 'Brentford', 'bre': 'Brentford', 'BRENTFORD': 'Brentford', 'brentford': 'Brentford',
  
  // Wolves variations
  'WOL': 'Wolves', 'wol': 'Wolves', 'WOLVES': 'Wolves', 'wolves': 'Wolves',
  'Wolverhampton': 'Wolves', 'WOLVERHAMPTON': 'Wolves', 'wolverhampton': 'Wolves',
  
  // Nottingham Forest variations
  'NFO': 'Nottingham Forest', 'nfo': 'Nottingham Forest', 'NOTTINGHAM FOREST': 'Nottingham Forest',
  'nottingham forest': 'Nottingham Forest', 'Forest': 'Nottingham Forest', 'FOREST': 'Nottingham Forest', 'forest': 'Nottingham Forest',
  "Nott'm Forest": 'Nottingham Forest', "NOTT'M FOREST": 'Nottingham Forest', "nott'm forest": 'Nottingham Forest',
  
  // Bournemouth variations
  'BOU': 'Bournemouth', 'bou': 'Bournemouth', 'BOURNEMOUTH': 'Bournemouth', 'bournemouth': 'Bournemouth',
  
  // Burnley variations
  'BUR': 'Burnley', 'bur': 'Burnley', 'BURNLEY': 'Burnley', 'burnley': 'Burnley',
  
  // Leeds variations
  'LEE': 'Leeds', 'lee': 'Leeds', 'LEEDS': 'Leeds', 'leeds': 'Leeds',
  
  // Sunderland variations
  'SUN': 'Sunderland', 'sun': 'Sunderland', 'SUNDERLAND': 'Sunderland', 'sunderland': 'Sunderland'
};

function normalizeTeamName(teamName: string): string {
  // First try exact mapping
  if (TEAM_NAME_MAPPING[teamName]) {
    return TEAM_NAME_MAPPING[teamName];
  }
  
  // Try trimmed version
  const trimmed = teamName.trim();
  if (TEAM_NAME_MAPPING[trimmed]) {
    return TEAM_NAME_MAPPING[trimmed];
  }
  
  // Return as-is if no mapping found
  return trimmed;
}

function parseExcelDate(excelDate: number | string): string {
  // Handle Excel serial date format
  if (typeof excelDate === 'number') {
    // Excel serial date (days since 1900-01-01, with some quirks)
    const excelEpoch = new Date(1900, 0, 1);
    const jsDate = new Date(excelEpoch.getTime() + (excelDate - 2) * 24 * 60 * 60 * 1000);
    return jsDate.toISOString().split('T')[0];
  } else {
    // Try to parse as regular date string
    const date = new Date(excelDate);
    if (isNaN(date.getTime())) {
      throw new Error(`Invalid date format: ${excelDate}`);
    }
    return date.toISOString().split('T')[0];
  }
}

function parseExcelTime(excelTime: number | string): string {
  // Handle Excel decimal time format (fraction of a day)
  if (typeof excelTime === 'number') {
    // Convert decimal time to hours:minutes:seconds
    const totalSeconds = Math.round(excelTime * 24 * 60 * 60);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  } else {
    // Handle string time formats
    const cleanTime = excelTime.toString().trim();
    
    // If already in HH:MM:SS format
    if (/^\d{2}:\d{2}:\d{2}$/.test(cleanTime)) {
      return cleanTime;
    }
    
    // If in HH:MM format, add seconds
    if (/^\d{1,2}:\d{2}$/.test(cleanTime)) {
      return cleanTime.padStart(5, '0') + ':00';
    }
    
    // Default fallback
    return '15:00:00';
  }
}

export async function importFixturesFromExcel(filePath: string): Promise<void> {
  console.log('Reading Excel file:', filePath);
  
  // Read the Excel file
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  
  // Convert to JSON
  const fixtures: ExcelFixture[] = XLSX.utils.sheet_to_json(worksheet);
  
  console.log(`Found ${fixtures.length} fixtures in Excel file`);
  
  // Clear existing matches
  console.log('Clearing existing matches...');
  await storage.clearAllMatches();
  
  // Get all teams for ID mapping
  const teams = await storage.getTeams();
  const teamMap = new Map<string, number>();
  teams.forEach(team => {
    teamMap.set(team.name, team.id);
  });
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const fixture of fixtures) {
    try {
      // Skip if missing essential data
      if (!fixture['Home Team'] || !fixture['Away Team'] || !fixture.Gameweek) {
        console.warn('Skipping fixture with missing data:', fixture);
        errorCount++;
        continue;
      }
      
      // Normalize team names
      const homeTeamName = normalizeTeamName(fixture['Home Team']);
      const awayTeamName = normalizeTeamName(fixture['Away Team']);
      
      // Find team IDs
      const homeTeamId = teamMap.get(homeTeamName);
      const awayTeamId = teamMap.get(awayTeamName);
      
      if (!homeTeamId || !awayTeamId) {
        console.warn(`Team not found: ${homeTeamName} (${fixture['Home Team']}) vs ${awayTeamName} (${fixture['Away Team']})`);
        errorCount++;
        continue;
      }
      
      // Parse date and time
      const matchDate = parseExcelDate(fixture.Date);
      const matchTime = parseExcelTime(fixture.Time);
      const matchDateTime = `${matchDate} ${matchTime}`;
      
      // Parse gameweek
      const gameweek = parseInt(fixture.Gameweek.toString());
      
      // Create match object
      const match: InsertMatch = {
        homeTeamId: homeTeamId,
        awayTeamId: awayTeamId,
        matchTime: matchDateTime,
        matchDay: gameweek.toString(),
        matchDate: matchDate,
        gameweek: gameweek,
        status: 'not_started'
      };
      
      await storage.createMatch(match);
      successCount++;
      
    } catch (error) {
      console.error(`Error processing fixture ${fixture.Gameweek}:`, error);
      errorCount++;
    }
  }
  
  console.log(`Import complete: ${successCount} fixtures imported, ${errorCount} errors`);
}