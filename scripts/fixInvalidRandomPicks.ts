// One-off cleanup: reassign existing *randomly-assigned* LMS picks that landed
// on a team not playing that gameweek in the current season — e.g. a relegated
// club picked before scripts/../autoLmsProcessor was fixed to
// draw only from teams with a real fixture. Such a pick has a null/stale matchId
// and can never be scored, which blocks the whole competition from processing.
//
// It only touches selections that are isRandomlyAssigned='true', have result
// null, and whose team has no fixture in that gameweek. Manual human picks are
// never altered. Each is re-drawn from the correct pool (teams playing that
// gameweek, excluding teams the participant has already used elsewhere).
//
//   npx tsx scripts/fixInvalidRandomPicks.ts            # dry run — report only
//   npx tsx scripts/fixInvalidRandomPicks.ts --confirm  # apply

import { storage } from "../server/storage";
import { eligibleTeamsForGameweek } from "../server/autoLmsProcessor";

const CONFIRM = process.argv.includes("--confirm");

async function main() {
  const matches = await storage.getAllMatches(); // season-scoped
  const teamName = new Map((await storage.getAllTeams()).map((t) => [t.id, t.name]));
  const active = await storage.getActiveLmsCompetitions();

  let invalid = 0;
  let fixed = 0;

  for (const comp of active) {
    const participants = await storage.getLmsParticipantsByCompetition(comp.id);
    for (const p of participants) {
      const selections = await storage.getLmsSelectionsByParticipant(p.id);
      const user = await storage.getUser(p.userId);
      const who = user?.username ?? `user#${p.userId}`;

      for (const sel of selections) {
        if (sel.isRandomlyAssigned !== "true" || sel.result !== null) continue;

        const eligible = eligibleTeamsForGameweek(matches, sel.gameweek);
        if (eligible.has(sel.teamId)) continue; // pick is valid — leave it

        invalid += 1;
        // Teams this participant has used in OTHER gameweeks are off-limits.
        const usedElsewhere = new Set(
          selections.filter((s) => s.id !== sel.id).map((s) => s.teamId),
        );
        const choices = Array.from(eligible.keys()).filter((id) => !usedElsewhere.has(id));

        if (choices.length === 0) {
          console.log(
            `[fix] comp ${comp.id} (group ${comp.groupId}) ${who} GW${sel.gameweek}: ` +
              `invalid pick ${teamName.get(sel.teamId) ?? sel.teamId} — NO eligible replacement (all used). Manual review needed.`,
          );
          continue;
        }

        const newTeamId = choices[Math.floor(Math.random() * choices.length)];
        const newMatch = eligible.get(newTeamId)!;
        console.log(
          `[fix] comp ${comp.id} (group ${comp.groupId}) ${who} GW${sel.gameweek}: ` +
            `${teamName.get(sel.teamId) ?? sel.teamId} → ${teamName.get(newTeamId) ?? newTeamId} (match ${newMatch.id})`,
        );

        if (CONFIRM) {
          await storage.updateLmsSelection(sel.id, {
            teamId: newTeamId,
            matchId: newMatch.id,
          });
          fixed += 1;
        }
      }
    }
  }

  console.log(
    `\n[fix] ${invalid} invalid random pick(s) found; ${CONFIRM ? `${fixed} reassigned.` : "DRY RUN — re-run with --confirm to apply."}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[fix] failed:", err);
    process.exit(1);
  });
