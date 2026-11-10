import type { GroupRules } from "./schema";

// The welcome message the admin copies from /admin/players and sends a new
// player on WhatsApp. WhatsApp formatting: *bold*, _italic_. Only the games the
// player can actually see are explained, using the group's own rules.


// The address in the message, whichever host the admin page is open on.
export const SITE_URL = "https://fairweathermen.com/";

export type WelcomeMessageInput = {
  username: string;
  groupName: string;
  loginCode: string;
  siteUrl: string;
  // The games their header shows.
  games: string[];
  rules: GroupRules;
  // Where they stand in Last Man Standing.
  lms?: { status: "in" | "next" | "none"; competitionName?: string | null; startGameweek?: number | null };
};

function deadlineText(minutesBefore: number): string {
  if (minutesBefore <= 0) return "the first kick-off of the gameweek";
  if (minutesBefore % 60 === 0) {
    const h = minutesBefore / 60;
    return `${h} hour${h === 1 ? "" : "s"} before the first kick-off of the gameweek`;
  }
  return `${minutesBefore} minutes before the first kick-off of the gameweek`;
}

function pts(n: number): string {
  return `${n} pt${n === 1 ? "" : "s"}`;
}

export function welcomeMessage(input: WelcomeMessageInput): string {
  const { username, groupName, loginCode, siteUrl, games, rules } = input;
  const lines: string[] = [];
  const onSite = /fairweathermen/i.test(groupName) ? "" : " on Fairweathermen";
  lines.push(`👋 Hi *${username}*! You've been added to *${groupName}*${onSite}.`);
  lines.push("");
  lines.push(`🔑 *Your login code:* ${loginCode}`);
  lines.push(`1. Open ${siteUrl}`);
  lines.push(`2. Type your code and tap *Enter*`);
  lines.push(`_The code is your personal login, so keep it to yourself. You'll only need to enter it once._`);

  const sections: string[][] = [];

  if (games.includes("lms")) {
    const r = rules.lms;
    const s = ["🏆 *Last Man Standing*"];
    s.push("• Each gameweek, pick one Premier League team to *win*.");
    s.push(
      r.lives > 1
        ? `• If your team loses or draws you lose a life. You have *${r.lives} lives*, and you're out when they're gone.`
        : "• If they win, you're through. If they lose *or draw*, you're out.",
    );
    s.push("• You can't pick the same team twice in a competition.");
    s.push(`• Picks lock at ${deadlineText(r.deadlineMinutesBeforeKickoff)}.`);
    s.push(
      r.missedPickPolicy === "eliminate"
        ? "• No pick by the deadline counts as a loss."
        : "• No pick by the deadline and a random team is picked for you.",
    );
    s.push(`• *£${r.buyIn} buy-in*. The last one standing takes the pot.`);
    const lms = input.lms;
    if (lms?.status === "in" && lms.competitionName) {
      s.push(
        `• You're in *${lms.competitionName}*${lms.startGameweek ? `, which starts in gameweek ${lms.startGameweek}` : ""}.`,
      );
    } else if (lms?.status === "next") {
      s.push(
        `• _${lms.competitionName ? `${lms.competitionName} has already started` : "The current competition has already started"}, so you'll join the next one. You'll see it on the site when it opens._`,
      );
    }
    sections.push(s);
  }

  if (games.includes("predictions")) {
    const r = rules.lawro;
    const s = ["⚽ *Lawro* (score predictions)"];
    s.push("• Predict the score of every Premier League match, one gameweek at a time.");
    s.push(`• *${pts(r.exactScorePoints)}* for the exact score, *${pts(r.correctResultPoints)}* for the right result.`);
    s.push(`• Predictions lock at ${deadlineText(r.deadlineMinutesBeforeKickoff)}. Nobody sees anyone else's until then.`);
    if (r.missedPickPolicy === "random") s.push("• Miss the deadline and random scores are filled in for you.");
    else if (r.missedPickPolicy === "open_until_kickoff")
      s.push("• Missed the deadline? You can still predict any match that hasn't kicked off yet.");
    else s.push("• Miss the deadline and you score nothing for that gameweek.");
    if (r.jokerEnabled) s.push("• Each gameweek, mark one prediction as your 🃏 *Joker* to double its points.");
    sections.push(s);
  }

  if (sections.length) {
    lines.push("");
    lines.push(sections.length > 1 ? "*What you're playing*" : "*What you get*");
    for (const s of sections) {
      lines.push("");
      lines.push(...s);
    }
  }

  const footballGame = games.includes("lms") || games.includes("predictions");
  lines.push("");
  lines.push(
    footballGame
      ? "📱 *Tip:* add the site to your Home Screen (iPhone: Share → *Add to Home Screen*). Then tap the 🔔 at the top to get a reminder before each deadline."
      : "📱 *Tip:* add the site to your Home Screen (iPhone: Share → *Add to Home Screen*) so it opens like an app.",
  );
  return lines.join("\n");
}
