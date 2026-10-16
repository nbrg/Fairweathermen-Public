// Unit test for the live-minute logic this PR adds (server/liveMinute.ts:
// parseFdMinute + nextLiveMinute, used by the football-data live sync). Pure
// functions — no DB, no network, no API key — so it's safe to run anywhere and
// in CI-style checks.
//
//   npx tsx scripts/testLiveMinuteSync.ts
//
// Exits 0 if every assertion passes, 1 (with a diff) otherwise. This is the part
// of the feature that can't be eyeballed without a real live PL match, so it's
// asserted directly against the shipped functions.

import { parseFdMinute, nextLiveMinute } from "../server/liveMinute";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

console.log("\nparseFdMinute — the feed sends a number, a string, or nothing:");
check("number 34 → 34", parseFdMinute(34), 34);
check("minute 0 is valid → 0", parseFdMinute(0), 0);
check('string "34" → 34', parseFdMinute("34"), 34);
check('stoppage "45+2" → 45', parseFdMinute("45+2"), 45);
check('stoppage "90+5" → 90', parseFdMinute("90+5"), 90);
check("null → null", parseFdMinute(null), null);
check("undefined → null", parseFdMinute(undefined), null);
check('empty "" → null', parseFdMinute(""), null);
check('non-numeric "HT" → null', parseFdMinute("HT"), null);

console.log("\nnextLiveMinute — what the sync writes to matches.minute:");
// While in progress: store the parsed minute, but only flag a write when it moved.
check(
  "in_progress, first tick (null → 34) writes 34",
  nextLiveMinute("in_progress", 34, null),
  { changed: true, minute: 34 },
);
check(
  "in_progress, unchanged minute (34 → 34) writes nothing",
  nextLiveMinute("in_progress", 34, 34),
  { changed: false, minute: 34 },
);
check(
  'in_progress, stoppage "45+2" over 44 writes 45',
  nextLiveMinute("in_progress", "45+2", 44),
  { changed: true, minute: 45 },
);
check(
  "in_progress, feed drops the minute mid-match (30 → null) clears it",
  nextLiveMinute("in_progress", null, 30),
  { changed: true, minute: null },
);
check(
  "in_progress, still no minute (null → null) writes nothing",
  nextLiveMinute("in_progress", null, null),
  { changed: false, minute: null },
);
// Any non-live status clears a stale minute (and only then).
check(
  "finished clears the last live minute (89 → null)",
  nextLiveMinute("finished", 90, 89),
  { changed: true, minute: null },
);
check(
  "finished with no stored minute writes nothing",
  nextLiveMinute("finished", null, null),
  { changed: false, minute: null },
);
check(
  "not_started clears a stray minute (12 → null)",
  nextLiveMinute("not_started", null, 12),
  { changed: true, minute: null },
);
check(
  "not_started with no minute writes nothing",
  nextLiveMinute("not_started", null, null),
  { changed: false, minute: null },
);

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
