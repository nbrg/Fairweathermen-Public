import * as cheerio from 'cheerio';
import { ScrapedMatch } from '@shared/schema';

interface FlashscoreMatch {
  homeTeam: string;
  awayTeam: string;
  homeScore?: number;
  awayScore?: number;
  status: string;
  time: string;
}

/**
 * Scrapes match data from Flashscore mobile site
 * Uses flashscore.mobi for simpler HTML structure
 */
export async function scrapeFlashscore(league: string = 'premier-league'): Promise<ScrapedMatch[]> {
  try {
    // Try multiple URL formats for Flashscore mobile
    const urls = [
      `https://www.flashscore.mobi/football/england/${league}/`,
      `https://www.flashscore.mobi/football/england/premier-league/`,
      `https://m.flashscore.com/football/england/premier-league/`,
      `https://www.flashscore.com/football/england/premier-league/`
    ];
    
    let html = '';
    let successUrl = '';
    
    for (const url of urls) {
      try {
        console.log(`Trying to scrape from: ${url}`);
        
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
          }
        });

        if (response.ok) {
          html = await response.text();
          successUrl = url;
          console.log(`Successfully fetched from: ${url}`);
          break;
        } else {
          console.log(`Failed to fetch from ${url}: ${response.status}`);
        }
      } catch (error) {
        console.log(`Error fetching from ${url}:`, error);
        continue;
      }
    }

    if (!html) {
      throw new Error('Failed to fetch data from any Flashscore URL');
    }
    const $ = cheerio.load(html);
    
    const matches: ScrapedMatch[] = [];
    
    // Look for match containers in various formats used by Flashscore
    const matchSelectors = [
      '.event__match',
      '.match',
      '.match-row',
      '[data-match]',
      '.fixture',
      '.game',
      'tr[data-testid*="match"]',
      '.event-row'
    ];
    
    for (const selector of matchSelectors) {
      $(selector).each((index, element) => {
        try {
          const $match = $(element);
          
          // Try different ways to extract team names
          let homeTeam = '';
          let awayTeam = '';
          
          // Method 1: Look for participant classes
          homeTeam = $match.find('.event__participant--home, .participant-home, .home-team, .team-home').first().text().trim();
          awayTeam = $match.find('.event__participant--away, .participant-away, .away-team, .team-away').first().text().trim();
          
          // Method 2: Look for team name in spans/divs
          if (!homeTeam || !awayTeam) {
            const participants = $match.find('.event__participant, .participant, .team').toArray();
            if (participants.length >= 2) {
              homeTeam = $(participants[0]).text().trim();
              awayTeam = $(participants[1]).text().trim();
            }
          }
          
          // Method 3: Look for team names in any child elements
          if (!homeTeam || !awayTeam) {
            const allText = $match.text();
            // Look for patterns like "Team1 vs Team2" or "Team1 - Team2"
            const vsMatch = allText.match(/([A-Za-z\s]+?)\s+(?:vs|v|\-)\s+([A-Za-z\s]+)/);
            if (vsMatch) {
              homeTeam = vsMatch[1].trim();
              awayTeam = vsMatch[2].trim();
            }
          }
          
          // Extract score - look for patterns like "2:1" but validate they're reasonable scores
          let homeScore: number | undefined;
          let awayScore: number | undefined;
          
          const scoreSelectors = ['.event__score', '.score', '.result', '.match-score'];
          for (const scoreSelector of scoreSelectors) {
            const scoreText = $match.find(scoreSelector).text().trim();
            const scoreMatch = scoreText.match(/^(\d{1,2})\s*[:\-]\s*(\d{1,2})$/);
            if (scoreMatch) {
              const home = parseInt(scoreMatch[1]);
              const away = parseInt(scoreMatch[2]);
              // Only accept reasonable football scores (0-15 goals) and reject corrupted data
              if (home >= 0 && home <= 15 && away >= 0 && away <= 15 && 
                  home !== 101204424 && away !== 15323932) {
                homeScore = home;
                awayScore = away;
                break;
              }
            }
          }
          
          // Also check for scores in the full text, but be more restrictive
          if (homeScore === undefined || awayScore === undefined) {
            const fullText = $match.text();
            // Look for score patterns surrounded by spaces or at word boundaries
            const scoreMatch = fullText.match(/\b(\d{1,2})\s*[:\-]\s*(\d{1,2})\b/);
            if (scoreMatch) {
              const home = parseInt(scoreMatch[1]);
              const away = parseInt(scoreMatch[2]);
              // Only accept reasonable football scores (0-15 goals) and reject corrupted data
              if (home >= 0 && home <= 15 && away >= 0 && away <= 15 && 
                  home !== 101204424 && away !== 15323932) {
                homeScore = home;
                awayScore = away;
              }
            }
          }
          
          // Extract status and time
          let status = 'scheduled';
          let time = 'TBD';
          
          const statusElements = $match.find('.event__time, .time, .status, .match-time, .event__stage');
          statusElements.each((i, el) => {
            const text = $(el).text().toLowerCase().trim();
            if (text.includes('ft') || text.includes('finished') || text.includes('final')) {
              status = 'finished';
            } else if (text.includes("'") || text.includes('live') || text.includes('half')) {
              status = 'live';
            } else if (text.match(/\d{1,2}:\d{2}/)) {
              time = text;
            }
          });
          
          // Clean up team names (remove extra whitespace, common suffixes)
          homeTeam = homeTeam.replace(/\s+/g, ' ').trim();
          awayTeam = awayTeam.replace(/\s+/g, ' ').trim();
          
          if (homeTeam && awayTeam && homeTeam !== awayTeam && homeTeam.length > 2 && awayTeam.length > 2) {
            matches.push({
              homeTeam,
              awayTeam,
              homeScore,
              awayScore,
              status,
              time
            });
            
            console.log(`Found match: ${homeTeam} vs ${awayTeam} (${homeScore !== undefined ? `${homeScore}-${awayScore}` : 'No score'})`);
          }
        } catch (error) {
          console.warn(`Error parsing match ${index}:`, error);
        }
      });
      
      if (matches.length > 0) {
        console.log(`Found ${matches.length} matches using selector: ${selector}`);
        break; // Stop trying other selectors if we found matches
      }
    }
    
    // Alternative parsing if main method doesn't work
    if (matches.length === 0) {
      console.log('Trying alternative parsing method...');
      
      // Debug: Log available class names to understand the structure
      const uniqueClasses = new Set<string>();
      $('[class]').each((i, el) => {
        const classes = $(el).attr('class')?.split(' ') || [];
        classes.forEach(cls => {
          if (cls.includes('match') || cls.includes('event') || cls.includes('fixture') || cls.includes('game')) {
            uniqueClasses.add(cls);
          }
        });
      });
      
      if (uniqueClasses.size > 0) {
        console.log('Found potentially relevant classes:', Array.from(uniqueClasses).slice(0, 10));
      }
      
      // Try to find score patterns in any text content
      const allText = $.text();
      const lines = allText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
      
      for (const line of lines) {
        // Look for patterns like "Liverpool 2:1 Arsenal" or "2:1" with team names nearby
        const scorePattern = /(\d+)\s*[:\-]\s*(\d+)/;
        const scoreMatch = line.match(scorePattern);
        
        if (scoreMatch) {
          console.log(`Found potential score line: "${line}"`);
          
          // Try to extract team names from context
          const beforeScore = line.substring(0, line.indexOf(scoreMatch[0])).trim();
          const afterScore = line.substring(line.indexOf(scoreMatch[0]) + scoreMatch[0].length).trim();
          
          // Simple heuristic: if we have text before and after the score
          if (beforeScore.length > 0 && afterScore.length > 0) {
            matches.push({
              homeTeam: beforeScore,
              awayTeam: afterScore,
              homeScore: parseInt(scoreMatch[1]),
              awayScore: parseInt(scoreMatch[2]),
              status: 'finished',
              time: 'FT'
            });
          }
        }
      }
      
      // Last resort: look for any element that might contain match data
      if (matches.length === 0) {
        $('div, tr, li, span').each((index, element) => {
          const text = $(element).text().trim();
          if (text.length > 10 && text.length < 100) {
            const teamPattern = /([A-Za-z\s]+?)\s+(\d+)\s*[:\-]\s*(\d+)\s+([A-Za-z\s]+)/;
            const match = text.match(teamPattern);
            
            if (match && match[1].trim().length > 0 && match[4].trim().length > 0) {
              matches.push({
                homeTeam: match[1].trim(),
                awayTeam: match[4].trim(),
                homeScore: parseInt(match[2]),
                awayScore: parseInt(match[3]),
                status: 'finished',
                time: 'FT'
              });
            }
          }
        });
      }
    }
    
    console.log(`Scraped ${matches.length} matches from Flashscore mobile`);
    return matches;
    
  } catch (error) {
    console.error('Error scraping Flashscore:', error);
    return [];
  }
}

/**
 * Updates match scores based on scraped data
 * Matches by team names and updates scores if found
 */
export async function updateMatchScores(storage: any, scrapedMatches: ScrapedMatch[]): Promise<number> {
  let updatedCount = 0;
  
  try {
    const allMatches = await storage.getAllMatchesWithTeams();
    
    for (const match of allMatches) {
      const homeTeamName = match.homeTeam?.name?.toLowerCase();
      const awayTeamName = match.awayTeam?.name?.toLowerCase();
      
      if (!homeTeamName || !awayTeamName) continue;
      
      // Find matching scraped data
      const scrapedMatch = scrapedMatches.find(scraped => {
        const scrapedHome = scraped.homeTeam.toLowerCase();
        const scrapedAway = scraped.awayTeam.toLowerCase();
        
        // Check for exact match or partial match
        return (scrapedHome.includes(homeTeamName) || homeTeamName.includes(scrapedHome)) &&
               (scrapedAway.includes(awayTeamName) || awayTeamName.includes(scrapedAway));
      });
      
      if (scrapedMatch && scrapedMatch.homeScore !== undefined && scrapedMatch.awayScore !== undefined) {
        // Only update if:
        // 1. We found valid score data from scraping, AND
        // 2. The scores are different from what we have stored, AND
        // 3. We're not overwriting existing scores with empty/null data
        const hasExistingScore = match.homeScore !== null && match.awayScore !== null;
        const scoresAreDifferent = match.homeScore !== scrapedMatch.homeScore || match.awayScore !== scrapedMatch.awayScore;
        
        if (scoresAreDifferent && (!hasExistingScore || scrapedMatch.homeScore !== 0 || scrapedMatch.awayScore !== 0)) {
          await storage.updateMatch(match.id, {
            homeScore: scrapedMatch.homeScore,
            awayScore: scrapedMatch.awayScore,
            status: scrapedMatch.status
          });
          
          console.log(`Updated ${homeTeamName} vs ${awayTeamName}: ${scrapedMatch.homeScore}-${scrapedMatch.awayScore} (was ${match.homeScore}-${match.awayScore})`);
          updatedCount++;
        } else if (hasExistingScore) {
          console.log(`Kept existing score for ${homeTeamName} vs ${awayTeamName}: ${match.homeScore}-${match.awayScore}`);
        }
      }
    }
    
    console.log(`Updated ${updatedCount} match scores`);
    return updatedCount;
    
  } catch (error) {
    console.error('Error updating match scores:', error);
    return 0;
  }
}

/**
 * Main scraper function that fetches and updates scores
 */
export async function runScraper(storage: any): Promise<void> {
  console.log('Starting Flashscore scraper...');
  
  try {
    const scrapedMatches = await scrapeFlashscore();
    
    if (scrapedMatches.length > 0) {
      await updateMatchScores(storage, scrapedMatches);
    } else {
      console.log('No matches found during scraping');
    }
  } catch (error) {
    console.error('Scraper error:', error);
  }
}