// Capture a tamper-evident snapshot of one gameweek's Lawro (Prediction League)
// state — every player's predictions, the actual results, points earned, and
// the season leaderboard as of that gameweek. Writes a canonical JSON, a
// SHA-256 of that JSON, and a human-readable HTML.
//
// The point is provable integrity: commit the JSON to the repo and post its
// SHA-256 in the group chat the same day. Anyone can later re-hash the committed
// file (`sha256sum snapshots/<season>/gw-N.json`) and check it matches what you
// posted — so the scores can't have been quietly changed after the fact.
//
//   npx tsx scripts/snapshotLawro.ts --gameweek 2
//   npx tsx scripts/snapshotLawro.ts --gameweek 2 --group city --season 2026/2027
//   npx tsx scripts/snapshotLawro.ts --gameweek 2 --force        # overwrite an existing snapshot
//
// Read-only against the DB; only writes files under snapshots/.

import { createHash } from "crypto";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { db } from "../server/db";
import { groups } from "@shared/schema";
import { storage } from "../server/storage";
import type { Match, Team } from "@shared/schema";

type MatchWithTeams = Match & { homeTeam: Team; awayTeam: Team };

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const GAMEWEEK = Number(argVal("--gameweek"));
const GROUP_ARG = argVal("--group");
const SEASON_ARG = argVal("--season");
const FORCE = process.argv.includes("--force");

// Mirror of storage.calculatePoints so points match exactly what the app shows.
function scorePrediction(
  pred: { homeScore: number; awayScore: number },
  m: Match,
): { points: number; status: "exact_score" | "correct_result" | "incorrect" | "not_started" } {
  if (m.status === "not_started" || m.homeScore == null || m.awayScore == null) {
    return { points: 0, status: "not_started" };
  }
  if (pred.homeScore === m.homeScore && pred.awayScore === m.awayScore) return { points: 3, status: "exact_score" };
  const pr = Math.sign(pred.homeScore - pred.awayScore);
  const mr = Math.sign(m.homeScore - m.awayScore);
  return pr === mr ? { points: 1, status: "correct_result" } : { points: 0, status: "incorrect" };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function resolveGroup(): Promise<{ id: number; name: string; slug: string }> {
  const all = await db.select().from(groups);
  const arg = (GROUP_ARG ?? "").toLowerCase();
  const g =
    (GROUP_ARG && all.find((x) => String(x.id) === GROUP_ARG)) ||
    (arg && all.find((x) => x.slug.toLowerCase() === arg)) ||
    (arg && all.find((x) => x.name.toLowerCase() === arg)) ||
    all.find((x) => x.slug.toLowerCase() === "city") ||
    all.find((x) => x.name.toLowerCase() === "fairweathermen") ||
    all.find((x) => (x.enabledGames as string[]).includes("predictions"));
  if (!g) {
    console.error(`[snapshot] Could not resolve a group. Available: ${all.map((x) => `${x.name} (${x.slug})`).join(", ")}`);
    process.exit(1);
  }
  return { id: g.id, name: g.name, slug: g.slug };
}

async function main() {
  if (!Number.isFinite(GAMEWEEK) || GAMEWEEK < 1) {
    console.error("[snapshot] Pass a gameweek, e.g. --gameweek 2");
    process.exit(1);
  }
  const group = await resolveGroup();

  const allMatches = await storage.getAllMatchesWithTeams(true);
  const season = SEASON_ARG ?? allMatches.map((m) => (m as any).season as string).filter(Boolean).sort().slice(-1)[0];
  const seasonMatches = allMatches.filter((m) => (m as any).season === season);
  const matchById = new Map(seasonMatches.map((m) => [m.id, m]));

  const groupUsers = (await storage.getAllUsers())
    .filter((u) => u.groupId === group.id)
    .sort((a, b) => (a.username || "").localeCompare(b.username || ""));
  const userIds = new Set(groupUsers.map((u) => u.id));

  // Predictions for this group's players, keyed by user:match.
  const predByKey = new Map<string, { homeScore: number; awayScore: number }>();
  for (const p of await storage.getAllPredictions()) {
    if (userIds.has(p.userId)) predByKey.set(`${p.userId}:${p.matchId}`, { homeScore: p.homeScore, awayScore: p.awayScore });
  }

  const kickoffMs = (m: MatchWithTeams) => new Date(m.matchTime).getTime() || 0;
  const gwMatches = seasonMatches
    .filter((m) => m.gameweek === GAMEWEEK)
    .sort((a, b) => kickoffMs(a) - kickoffMs(b) || a.id - b.id);
  if (gwMatches.length === 0) {
    console.error(`[snapshot] No ${season} fixtures found for GW${GAMEWEEK}.`);
    process.exit(1);
  }

  // Results grid for GW N.
  const fixtures = gwMatches.map((m) => ({
    matchId: m.id,
    kickoff: m.matchTime,
    home: m.homeTeam.name,
    away: m.awayTeam.name,
    homeShort: m.homeTeam.shortName,
    awayShort: m.awayTeam.shortName,
    finished: m.homeScore != null && m.awayScore != null && m.status !== "not_started",
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    status: m.status,
  }));

  // Per-player predictions + points for GW N.
  const gridRows = groupUsers.map((u) => ({
    username: u.username,
    cells: gwMatches.map((m) => {
      const pred = predByKey.get(`${u.id}:${m.id}`);
      if (!pred) return null;
      const { points, status } = scorePrediction(pred, m);
      return { predicted: `${pred.homeScore}-${pred.awayScore}`, points, status };
    }),
  }));

  // Leaderboard as of GW N: all finished fixtures with gameweek <= N.
  const upToN = seasonMatches.filter((m) => m.gameweek != null && m.gameweek <= GAMEWEEK);
  const leaderboard = groupUsers
    .map((u) => {
      let exact = 0, correct = 0, points = 0;
      for (const m of upToN) {
        const pred = predByKey.get(`${u.id}:${m.id}`);
        if (!pred) continue;
        const { status } = scorePrediction(pred, m);
        if (status === "exact_score") { exact++; points += 3; }
        else if (status === "correct_result") { correct++; points += 1; }
      }
      return { username: u.username, exactScores: exact, correctResults: correct, totalPoints: points };
    })
    .sort(
      (a, b) =>
        b.totalPoints - a.totalPoints ||
        b.exactScores - a.exactScores ||
        b.correctResults - a.correctResults ||
        a.username.localeCompare(b.username),
    )
    .map((r, i) => ({ rank: i + 1, ...r }));

  const snapshot = {
    meta: {
      game: "lawro",
      group: { id: group.id, name: group.name, slug: group.slug },
      season,
      gameweek: GAMEWEEK,
      generatedAt: new Date().toISOString(),
      scoring: "3 points for an exact scoreline, 1 for the correct result",
      note: "Predictions and points are computed from the stored scorelines against the actual results (football-data.org).",
    },
    fixtures,
    predictions: gridRows,
    leaderboard,
  };

  // Canonical JSON (stable ordering) → the file whose SHA-256 is the proof.
  const json = JSON.stringify(snapshot, null, 2) + "\n";
  const sha256 = createHash("sha256").update(json).digest("hex");

  const seasonDir = season.replace(/\//g, "-");
  const outDir = path.resolve("snapshots", seasonDir);
  const jsonPath = path.join(outDir, `gw-${GAMEWEEK}.json`);
  const htmlPath = path.join(outDir, `gw-${GAMEWEEK}.html`);
  if (existsSync(jsonPath) && !FORCE) {
    console.error(`[snapshot] ${jsonPath} already exists. Re-run with --force to overwrite (this changes the hash).`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(jsonPath, json);
  writeFileSync(jsonPath + ".sha256", `${sha256}  gw-${GAMEWEEK}.json\n`);
  writeFileSync(htmlPath, renderHtml(snapshot, sha256));

  console.log(`\n[snapshot] ${group.name} · ${season} · Gameweek ${GAMEWEEK}`);
  console.log(`   JSON:   ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`   HTML:   ${path.relative(process.cwd(), htmlPath)}`);
  console.log(`   SHA-256: ${sha256}`);
  console.log(`\n   → Commit the JSON and post this hash in the group chat. To verify later:`);
  console.log(`     sha256sum ${path.relative(process.cwd(), jsonPath)}`);
}

function ptsBadge(points: number, status: string): string {
  if (status === "not_started") return "";
  const bg = points === 3 ? "#16a34a" : points === 1 ? "#2563eb" : "#9ca3af";
  return `<sup style="background:${bg};color:#fff;border-radius:4px;padding:0 4px;font-size:9px;margin-left:4px">${points}</sup>`;
}

function renderHtml(s: any, sha256: string): string {
  const f = s.fixtures as any[];
  const rows = s.predictions as any[];
  const lb = s.leaderboard as any[];
  const resultCell = (x: any) =>
    x.finished ? `${x.homeScore}–${x.awayScore}` : `<span style="color:#9ca3af">v</span>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lawro GW${s.meta.gameweek} — ${esc(s.meta.group.name)} ${esc(s.meta.season)}</title>
<style>
  :root{--ink:#1b1926;--muted:#6b7280;--line:#e5e7eb;--head:#2b1b53}
  *{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:#f7f6f9;padding:20px}
  .wrap{max-width:900px;margin:0 auto}
  h1{font-size:1.5rem;margin:0 0 2px}.sub{color:var(--muted);font-size:.9rem;margin:0 0 4px}
  .hash{font-family:ui-monospace,monospace;font-size:.72rem;color:var(--muted);word-break:break-all;background:#fff;border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin:8px 0 20px}
  h2{font-size:1.05rem;margin:22px 0 8px}
  table{border-collapse:collapse;width:100%;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:.85rem}
  th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:center;white-space:nowrap}
  th{background:#f2f0f6;color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.03em}
  td.name,th.name{text-align:left;font-weight:600;position:sticky;left:0;background:#fff}
  .scroll{overflow-x:auto}
  tr:nth-child(even) td{background:#faf9fb}
  .lb td.pts{font-weight:700;color:var(--head)}
</style></head><body><div class="wrap">
<h1>Lawro — Gameweek ${s.meta.gameweek}</h1>
<p class="sub">${esc(s.meta.group.name)} · Season ${esc(s.meta.season)} · captured ${new Date(s.meta.generatedAt).toUTCString()}</p>
<div class="hash">SHA-256 of gw-${s.meta.gameweek}.json: ${sha256}</div>

<h2>Results</h2>
<div class="scroll"><table><thead><tr><th class="name">Fixture</th><th>Score</th></tr></thead><tbody>
${f.map((x) => `<tr><td class="name">${esc(x.home)} v ${esc(x.away)}</td><td>${resultCell(x)}</td></tr>`).join("")}
</tbody></table></div>

<h2>Predictions</h2>
<div class="scroll"><table><thead><tr><th class="name">Player</th>${f
    .map((x) => `<th>${esc(x.homeShort)}-${esc(x.awayShort)}</th>`)
    .join("")}</tr></thead><tbody>
${rows
    .map(
      (r) =>
        `<tr><td class="name">${esc(r.username)}</td>${r.cells
          .map((c: any) => `<td>${c ? esc(c.predicted) + ptsBadge(c.points, c.status) : "–"}</td>`)
          .join("")}</tr>`,
    )
    .join("")}
</tbody></table></div>

<h2>Leaderboard (after GW${s.meta.gameweek})</h2>
<div class="scroll"><table class="lb"><thead><tr><th>#</th><th class="name">Player</th><th>Exact</th><th>Result</th><th>Points</th></tr></thead><tbody>
${lb
    .map(
      (r) =>
        `<tr><td>${r.rank}</td><td class="name">${esc(r.username)}</td><td>${r.exactScores}</td><td>${r.correctResults}</td><td class="pts">${r.totalPoints}</td></tr>`,
    )
    .join("")}
</tbody></table></div>

<p class="sub" style="margin-top:20px">${esc(s.meta.scoring)}. ${esc(s.meta.note)}</p>
</div></body></html>`;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[snapshot] failed:", err);
    process.exit(1);
  });
