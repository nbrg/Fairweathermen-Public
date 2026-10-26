#!/usr/bin/env node
// Works out which Playwright specs a change needs, so CI can skip the areas a
// PR doesn't touch. `npm test` still runs everything; this is only used by CI
// (and `npm run test:affected` locally).
//
//   node tests/affected.mjs [base-ref]        # diff base-ref...HEAD (default origin/main)
//   node tests/affected.mjs --files a.ts b.ts # classify an explicit file list
//
// Prints one line: either "all" or the space-separated spec paths to run.
// With --explain it also prints, on stderr, which file pulled in which area.
//
// Rules, in order, for each changed file:
//   1. A changed spec runs itself.
//   2. CORE files (shared server plumbing, schema, app shell, test harness,
//      build config) run the whole suite.
//   3. A file listed under an AREA runs that area's specs.
//   4. Files that no test exercises (docs, one-off scripts, push/reminders, …)
//      are IGNORED.
//   5. Anything else is unknown, so it runs the whole suite. When you add a
//      file, add it to an area here if you want PRs touching it to stay fast.
// The BASELINE specs (smoke + navigation) run on every PR as a sanity check.
import { execSync } from "node:child_process";

const BASELINE = ["tests/smoke.spec.ts", "tests/navigation.spec.ts"];

// Changing any of these can break any page or endpoint.
const CORE = [
  /^server\/(routes|storage|db|index|vite|groupAuth|scheduleGate)\.ts$/,
  /^shared\/(schema|time)\.ts$/,
  /^client\/src\/(App|main)\.tsx$/,
  /^client\/src\/index\.css$/,
  /^client\/src\/components\/ui\//,
  /^client\/src\/lib\/(queryClient|utils|types)\.ts$/,
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
    specs: ["tests/lms.spec.ts", "tests/lmsAutoStart.spec.ts"],
    files: [
      /^client\/src\/pages\/LastManStandingPage\.tsx$/,
      /^client\/src\/components\/lms\//,
      /^client\/src\/components\/TeamCrest\.tsx$/,
      /^server\/(lmsProcessor|autoLmsProcessor|lmsAutoStart|footballDataApi|importFixtures|liveMinute|scraper)\.ts$/,
    ],
  },
  lawro: {
    specs: ["tests/lawro.spec.ts", "tests/joker.spec.ts", "tests/security.spec.ts"],
    files: [
      /^client\/src\/pages\/HomePage\.tsx$/,
      /^client\/src\/hooks\/useScores\.ts$/,
      /^client\/src\/components\/TeamCrest\.tsx$/,
      /^server\/(optimizedQueries|lawroMissedPicks|liveMinute)\.ts$/,
    ],
  },
  groups: {
    specs: [
      "tests/auth.spec.ts",
      "tests/switching.spec.ts",
      "tests/selfServiceGroups.spec.ts",
      "tests/groupPlayers.spec.ts",
      "tests/groups.spec.ts",
      "tests/loginCodeNames.spec.ts",
      "tests/ruleChanges.spec.ts",
      "tests/security.spec.ts",
    ],
    files: [
      /^client\/src\/pages\/(CreateGroup|JoinGroup|GroupGate|GroupSettings|GroupSwitch)\.tsx$/,
      /^client\/src\/components\/(GroupPlayersCard|RuleChangesDialog|GroupMultiSelect|Header)\.tsx$/,
      /^server\/(loginCodes|groupRules|rateLimits|lmsAutoStart)\.ts$/,
    ],
  },
  admin: {
    specs: ["tests/admin.spec.ts", "tests/growth.spec.ts", "tests/security.spec.ts"],
    files: [
      /^client\/src\/pages\/(ActivityPage|AdminNotifications|AdminPage|AdminPlayers|AdminStats|AuditPage|GrowthPage)\.tsx$/,
      /^client\/src\/components\/(AdminGate|AdminNav|ScreenResolutionTracker)\.tsx$/,
      /^client\/src\/hooks\/usePageTracking\.ts$/,
      /^client\/src\/lib\/track\.ts$/,
      /^server\/(visitorTracker|geolocation)\.ts$/,
      /^shared\/staticAssets\.ts$/,
    ],
  },
  shell: {
    specs: ["tests/help.spec.ts"],
    files: [
      /^client\/src\/pages\/(HelpPage|not-found)\.tsx$/,
      /^client\/src\/components\/(Header|Footer|NotificationBell)\.tsx$/,
      /^client\/src\/hooks\/(use-mobile|use-toast)\.tsx?$/,
    ],
  },
};

// Nothing in the suite exercises these, so they only need the type-check.
const IGNORED = [
  /\.md$/,
  /^(attached_assets|audit|snapshots|migrations)\//,
  /^scripts\//, // one-off tsx utilities (seedTestData is CORE, matched first)
  /^client\/src\/lib\/push\.ts$/,
  /^server\/(reminderProcessor|push|generateFixtures)\.ts$/,
  /^server\/.*\.d\.ts$/,
  /^(\.replit|\.gitignore|generated-icon\.png)$/,
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

function main() {
  const args = process.argv.slice(2);
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
