#!/usr/bin/env node
// Works out which Playwright specs a change needs, so CI can skip the areas a
// PR doesn't touch. `npm test` still runs everything; this is only used by CI
// (and `npm run test:affected` locally).
//
//   node tests/affected.mjs [base-ref]        # diff base-ref...HEAD (default origin/main)
//   node tests/affected.mjs --files a.ts b.ts # classify an explicit file list
//   node tests/affected.mjs --check           # fail if the map has gaps (see below)
//
// Prints one line: either "all" or the space-separated spec paths to run.
// With --explain it also prints, on stderr, which file pulled in which area.
//
// Rules, in order, for each changed file:
//   1. A changed spec runs itself.
//   2. CORE files (shared server plumbing, schema, app shell, test harness,
//      build config) run the whole suite.
//   3. A file listed under an AREA runs that area's specs.
//   4. Files that no test exercises (docs, one-off scripts, …) are
//      IGNORED.
//   5. Anything else is unknown, so it runs the whole suite. When you add a
//      file, add it to an area here if you want PRs touching it to stay fast.
// The BASELINE specs (smoke + navigation) run on every PR as a sanity check.
//
// `--check` (part of `npm run check`, so CI runs it) keeps this map honest: it
// fails when a file in the repo falls under rule 5 (classify it: an AREA, CORE
// or IGNORED), when a spec isn't listed in BASELINE or any area's specs (so PRs
// touching that area would never run it), or when a listed spec doesn't exist.
import { execSync } from "node:child_process";

const BASELINE = ["tests/smoke.spec.ts", "tests/navigation.spec.ts"];

// Changing any of these can break any page or endpoint.
const CORE = [
  /^server\/(routes|storage|db|index|vite|groupAuth|scheduleGate)\.ts$/,
  /^shared\/(schema|time|originalGroups)\.ts$/,
  /^client\/src\/(App|main)\.tsx$/,
  /^client\/src\/index\.css$/,
  /^client\/src\/components\/ui\//,
  /^client\/src\/lib\/(queryClient|utils|types|themePalette)\.ts$/,
  /^client\/src\/lib\/theme\.tsx$/,
  /^client\/src\/contexts\//,
  /^client\/index\.html$/,
  /^client\/public\//,
  /^tests\/(helpers|seed|global-setup)\.ts$/,
  /^tests\/affected\.mjs$/,
  /^scripts\/seedTestData\.ts$/,
  /^(package|package-lock|tsconfig|components)\.json$/,
  /^(playwright|vite|tailwind|drizzle)\.config\.ts$/,
  /^postcss\.config\.js$/,
  /^\.github\//,
];

const AREAS = {
  lms: {
    specs: ["tests/lms.spec.ts", "tests/addPlayer.spec.ts", "tests/lmsWheel.spec.ts", "tests/fplFinish.spec.ts"],
    files: [
      /^client\/src\/pages\/LastManStandingPage\.tsx$/,
      /^client\/src\/components\/lms\//,
      /^client\/src\/components\/TeamCrest\.tsx$/,
      /^server\/(lmsProcessor|autoLmsProcessor|lmsAutoStart|lmsEnrolment|lmsWheel|footballDataApi|fplFinish|liveMinute)\.ts$/,
      /^shared\/lmsWheel\.ts$/,
    ],
  },
  lawro: {
    specs: ["tests/lawro.spec.ts", "tests/lawroInputs.spec.ts", "tests/lawroTendencies.spec.ts", "tests/security.spec.ts"],
    files: [
      /^client\/src\/pages\/HomePage\.tsx$/,
      /^client\/src\/hooks\/(useScores|usePredictionSave)\.ts$/,
      /^client\/src\/lib\/lawroTendencies\.ts$/,
      /^client\/src\/components\/TeamCrest\.tsx$/,
      /^server\/(optimizedQueries|lawroMissedPicks|liveMinute)\.ts$/,
    ],
  },
  groups: {
    specs: [
      "tests/auth.spec.ts",
      "tests/switching.spec.ts",
      "tests/selfServiceGroups.spec.ts",
      "tests/groupAdmin.spec.ts",
      "tests/addPlayer.spec.ts",
      "tests/security.spec.ts",
      "tests/groupPlayers.spec.ts",
      "tests/growth.spec.ts",
      "tests/joker.spec.ts",
      "tests/lmsAutoStart.spec.ts",
      "tests/loginCodeNames.spec.ts",
      "tests/ruleChanges.spec.ts",
    ],
    files: [
      /^client\/src\/pages\/(CreateGroup|JoinGroup|GroupGate|GroupSettings|GroupSwitch|SettingsPage)\.tsx$/,
      /^client\/src\/components\/(GroupPlayersCard|RuleChangesDialog|GroupMultiSelect|Header)\.tsx$/,
      /^server\/(loginCodes|groupRules|rateLimits|lmsAutoStart)\.ts$/,
      /^shared\/navGames\.ts$/,
    ],
  },
  admin: {
    specs: ["tests/admin.spec.ts", "tests/addPlayer.spec.ts", "tests/security.spec.ts", "tests/activityTracking.spec.ts"],
    files: [
      /^client\/src\/pages\/(ActivityPage|AdminNotifications|AdminPlayers|AdminStats|AuditPage|GrowthPage|ChangesPage|MetricsPage)\.tsx$/,
      /^client\/src\/components\/(AdminGate|AdminNav|AdminDeleteDialog|ScreenResolutionTracker)\.tsx$/,
      /^server\/(adminDeletion|metrics|auditExtras)\.ts$/,
      /^shared\/changelog\.(ts|json)$/,
      /^client\/src\/hooks\/usePageTracking\.ts$/,
      /^client\/src\/lib\/track\.ts$/,
      /^server\/(visitorTracker|geolocation)\.ts$/,
      /^shared\/(staticAssets|navGames|ipLocation|welcomeMessage|activityEvents)\.ts$/,
    ],
  },
  shell: {
    specs: ["tests/help.spec.ts", "tests/bottomNav.spec.ts"],
    files: [
      /^client\/src\/pages\/(HelpPage|not-found|SettingsPage)\.tsx$/,
      /^client\/src\/components\/(Header|Footer|BottomNav|ReminderSettings)\.tsx$/,
      /^client\/src\/lib\/gameTabs\.ts$/,
      /^server\/navDue\.ts$/,
      /^client\/src\/hooks\/(use-mobile|use-toast)\.tsx?$/,
      /^shared\/navGames\.ts$/,
    ],
  },
};

// Nothing in the suite exercises these, so they only need the type-check.
const IGNORED = [
  /\.md$/,
  /^migrations\//,
  /^scripts\//, // one-off tsx utilities (seedTestData is CORE, matched first)
  /^client\/src\/lib\/push\.ts$/,
  /^server\/(reminderProcessor|push)\.ts$/,
  /^server\/.*\.d\.ts$/,
  /^(\.gitignore|\.env\.example|LICENSE)$/,
];

export function classify(files) {
  const specs = new Set(BASELINE);
  const reasons = [];
  for (const file of files) {
    if (/^tests\/.*\.spec\.ts$/.test(file)) {
      specs.add(file);
      reasons.push(`${file}: changed spec`);
      continue;
    }
    if (CORE.some((re) => re.test(file))) {
      reasons.push(`${file}: core file, running everything`);
      return { all: true, specs: [], reasons };
    }
    const areas = Object.entries(AREAS).filter(([, a]) => a.files.some((re) => re.test(file)));
    if (areas.length) {
      for (const [, a] of areas) a.specs.forEach((s) => specs.add(s));
      reasons.push(`${file}: ${areas.map(([name]) => name).join(", ")}`);
      continue;
    }
    if (IGNORED.some((re) => re.test(file))) {
      reasons.push(`${file}: not covered by any spec`);
      continue;
    }
    reasons.push(`${file}: not mapped to an area, running everything`);
    return { all: true, specs: [], reasons };
  }
  return { all: false, specs: [...specs].sort(), reasons };
}

// Problems with the map itself, given every file in the repo.
export function mapGaps(files) {
  const gaps = [];
  const listed = new Set([...BASELINE, ...Object.values(AREAS).flatMap((a) => a.specs)]);
  const present = new Set(files);
  for (const file of files) {
    if (/^tests\/.*\.spec\.ts$/.test(file)) {
      if (!listed.has(file)) gaps.push(`${file}: spec isn't in BASELINE or any area's specs`);
      continue;
    }
    if (classify([file]).reasons.at(-1)?.endsWith("not mapped to an area, running everything")) {
      gaps.push(`${file}: not in CORE, any AREA or IGNORED`);
    }
  }
  for (const spec of listed) {
    if (!present.has(spec)) gaps.push(`${spec}: listed in tests/affected.mjs but doesn't exist`);
  }
  return gaps;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    // Tracked files plus new ones not yet committed (but not gitignored).
    const files = execSync("git ls-files --cached --others --exclude-standard", { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const gaps = mapGaps(files);
    if (gaps.length) {
      console.error("tests/affected.mjs doesn't cover these files (CI would silently run the full suite):");
      for (const g of gaps) console.error(`  ${g}`);
      console.error("Add each one to an AREA (files + specs), CORE or IGNORED in tests/affected.mjs.");
      process.exit(1);
    }
    return;
  }
  const explain = args.includes("--explain");
  const rest = args.filter((a) => a !== "--explain");
  let files;
  if (rest[0] === "--files") {
    files = rest.slice(1);
  } else {
    const base = rest[0] ?? "origin/main";
    files = execSync(`git diff --name-only ${base}...HEAD`, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  }
  const result = classify(files);
  if (explain) for (const r of result.reasons) console.error(r);
  console.log(result.all ? "all" : result.specs.join(" "));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
