// Every /admin/changes entry must show its PR number. Entries are written in the
// product PR itself, before it merges, so the number used to be left out and
// never added. Open the PR first, then put its
// number on the entry; this check fails until you do.
import { readFileSync } from "node:fs";

const entries = JSON.parse(readFileSync(new URL("../../shared/changelog.json", import.meta.url), "utf8"));
const problems = [];
const seen = new Map();
for (const e of entries) {
  const name = e.id ?? e.title;
  if (!Number.isInteger(e.number) || e.number <= 0) {
    problems.push(`  ${name}: missing "number" (the PR number)`);
  } else if (seen.has(e.number)) {
    problems.push(`  ${name}: PR #${e.number} is already used by ${seen.get(e.number)}`);
  } else {
    seen.set(e.number, name);
  }
}
if (problems.length) {
  console.error(
    "shared/changelog.json: every entry needs its PR number.\n" +
      problems.join("\n") +
      "\nOpen the PR (a draft is fine), then add \"number\": <PR number> to its entry before merging.",
  );
  process.exit(1);
}
