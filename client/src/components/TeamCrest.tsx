import { memo, useEffect, useState } from "react";
import type { Team } from "@shared/schema";

// Real club crests are served by football-data.org's public crest CDN
// (https://crests.football-data.org/<id>.png|svg) — the same data source the
// app already uses for live fixtures/scores. We map clubs by *name* (production
// team IDs don't match the seed data), and always fall back to a coloured
// monogram, so a club we don't have an id for — or a crest that fails to load —
// degrades to a clean badge instead of a broken image.
//
// The crest is drawn as a CSS background-image, NOT an <img> element. An <img>
// re-enters the browser's load/decode lifecycle every time React re-mounts it
// (which happens on each LMS data refetch after a pick), which is what caused
// every emblem on the page to blink. A background-image on a persistent span,
// combined with the module-level url cache below, paints instantly from the
// browser cache on re-mount with no flash.

// football-data.org team ids, keyed by a normalised club name.
const NAME_TO_FD_ID: Record<string, number> = {
  // Current Premier League (matches the server's trusted TEAM_ID_MAP).
  arsenal: 57,
  "aston villa": 58,
  bournemouth: 1044,
  brentford: 402,
  brighton: 397,
  burnley: 328,
  chelsea: 61,
  "crystal palace": 354,
  everton: 62,
  fulham: 63,
  leeds: 341,
  liverpool: 64,
  "manchester city": 65,
  "manchester united": 66,
  newcastle: 67,
  "nottingham forest": 351,
  sunderland: 71,
  tottenham: 73,
  "west ham": 563,
  wolverhampton: 76,
  // Other common English clubs (well-known football-data ids).
  ipswich: 349,
  leicester: 338,
  southampton: 340,
  "sheffield united": 356,
  watford: 346,
  norwich: 68,
  middlesbrough: 343,
  coventry: 1076,
  "hull city": 322,
  cardiff: 715,
  swansea: 72,
  blackburn: 59,
  "west bromwich albion": 74,
  "stoke city": 75,
  luton: 389,
  "sheffield wednesday": 345,
  preston: 1081,
  "bristol city": 387,
  millwall: 384,
  "queens park rangers": 69,
  birmingham: 332,
  "derby county": 342,
};

// Brand colours for the monogram fallback. fg is the text colour that reads on
// bg. Clubs not listed get a stable colour hashed from their name.
const BRAND: Record<string, { bg: string; fg: string }> = {
  arsenal: { bg: "#EF0107", fg: "#fff" },
  "aston villa": { bg: "#670E36", fg: "#95BFE5" },
  bournemouth: { bg: "#DA291C", fg: "#fff" },
  brentford: { bg: "#E30613", fg: "#fff" },
  brighton: { bg: "#0057B8", fg: "#fff" },
  burnley: { bg: "#6C1D45", fg: "#99D6EA" },
  chelsea: { bg: "#034694", fg: "#fff" },
  "crystal palace": { bg: "#1B458F", fg: "#C4122E" },
  everton: { bg: "#003399", fg: "#fff" },
  fulham: { bg: "#000000", fg: "#fff" },
  leeds: { bg: "#FFCD00", fg: "#1D428A" },
  liverpool: { bg: "#C8102E", fg: "#fff" },
  "manchester city": { bg: "#6CABDD", fg: "#fff" },
  "manchester united": { bg: "#DA291C", fg: "#FBE122" },
  newcastle: { bg: "#241F20", fg: "#fff" },
  "nottingham forest": { bg: "#DD0000", fg: "#fff" },
  sunderland: { bg: "#EB172B", fg: "#fff" },
  tottenham: { bg: "#132257", fg: "#fff" },
  "west ham": { bg: "#7A263A", fg: "#1BB1E7" },
  wolverhampton: { bg: "#FDB913", fg: "#231F20" },
  ipswich: { bg: "#3A64A3", fg: "#fff" },
  leicester: { bg: "#003090", fg: "#FDBE11" },
  southampton: { bg: "#D71920", fg: "#fff" },
  coventry: { bg: "#4B92DB", fg: "#fff" },
  "hull city": { bg: "#F18A01", fg: "#231F20" },
};

function normalizeName(name: string): string {
  let n = name.toLowerCase().trim();
  // Strip club suffixes/prefixes and punctuation for stable lookups.
  n = n.replace(/&/g, "and").replace(/[.'']/g, "").replace(/\s+/g, " ").trim();
  n = n.replace(/\b(afc|fc)\b/g, "").replace(/\s+/g, " ").trim();
  // Common aliases → canonical key.
  const aliases: Record<string, string> = {
    "man utd": "manchester united",
    "man united": "manchester united",
    "man city": "manchester city",
    spurs: "tottenham",
    "tottenham hotspur": "tottenham",
    wolves: "wolverhampton",
    "wolverhampton wanderers": "wolverhampton",
    forest: "nottingham forest",
    "brighton and hove albion": "brighton",
    "newcastle united": "newcastle",
    "leeds united": "leeds",
    "ipswich town": "ipswich",
    "leicester city": "leicester",
    "norwich city": "norwich",
    "coventry city": "coventry",
    hull: "hull city",
    "cardiff city": "cardiff",
    "swansea city": "swansea",
    "blackburn rovers": "blackburn",
    "west brom": "west bromwich albion",
    qpr: "queens park rangers",
    "birmingham city": "birmingham",
  };
  return aliases[n] ?? n;
}

function initialsFor(team: Team): string {
  const sn = (team.shortName ?? "").trim();
  if (sn) return sn.slice(0, 3).toUpperCase();
  const words = team.name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words
    .slice(0, 3)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

function hashColor(name: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return { bg: `hsl(${h}, 55%, 38%)`, fg: "#fff" };
}

// Module-level cache of the resolved crest url per football-data id. `undefined`
// = not yet resolved; a string = the working url; `null` = no crest available
// (use the monogram). Because this outlives component mounts, a re-mounted badge
// reads the answer synchronously and never re-runs the png→svg probe or flashes.
const crestUrlCache = new Map<number, string | null>();
const inflight = new Map<number, Promise<string | null>>();

function probe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

function resolveCrestUrl(fdId: number): Promise<string | null> {
  if (crestUrlCache.has(fdId)) return Promise.resolve(crestUrlCache.get(fdId)!);
  const existing = inflight.get(fdId);
  if (existing) return existing;
  const png = `https://crests.football-data.org/${fdId}.png`;
  const svg = `https://crests.football-data.org/${fdId}.svg`;
  const p = (async () => {
    const url = (await probe(png)) ? png : (await probe(svg)) ? svg : null;
    crestUrlCache.set(fdId, url);
    inflight.delete(fdId);
    return url;
  })();
  inflight.set(fdId, p);
  return p;
}

function TeamCrestBase({ team, size = 28, transparent = false }: { team: Team; size?: number; transparent?: boolean }) {
  const key = normalizeName(team.name);
  const fdId = NAME_TO_FD_ID[key];
  const colors = BRAND[key] ?? hashColor(key);
  const initials = initialsFor(team);

  // Seed from the module cache so re-mounts paint the right thing on the first
  // frame. If we've never resolved this crest, optimistically try the png url
  // (the common case) while the probe runs — cached images paint instantly.
  const [url, setUrl] = useState<string | null>(() => {
    if (fdId == null) return null;
    if (crestUrlCache.has(fdId)) return crestUrlCache.get(fdId)!;
    return `https://crests.football-data.org/${fdId}.png`;
  });

  useEffect(() => {
    if (fdId == null) return;
    if (crestUrlCache.has(fdId)) {
      setUrl(crestUrlCache.get(fdId)!);
      return;
    }
    let active = true;
    resolveCrestUrl(fdId).then((u) => active && setUrl(u));
    return () => {
      active = false;
    };
  }, [fdId]);

  const base = {
    width: size,
    height: size,
    // In transparent mode the crest sits directly on whatever's behind it (e.g.
    // a tinted result cell) with no white disc or ring — so it doesn't look like
    // a crest floating on a stray white circle.
    boxShadow: transparent ? undefined : "inset 0 0 0 1px rgba(0,0,0,0.08)",
  } as const;

  if (url) {
    return (
      <span
        aria-hidden
        className={`inline-flex shrink-0 rounded-full bg-center bg-no-repeat ${transparent ? "" : "bg-white"}`}
        style={{
          ...base,
          backgroundImage: `url(${url})`,
          backgroundSize: transparent ? "contain" : "82%",
        }}
      />
    );
  }

  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold leading-none"
      style={{
        ...base,
        background: colors.bg,
        color: colors.fg,
        fontSize: Math.max(9, Math.round(size * 0.34)),
      }}
    >
      {initials}
    </span>
  );
}

// Memoised so the constant LMS refetches (which hand down fresh-but-equivalent
// team objects) don't re-render every badge on the page.
export const TeamCrest = memo(
  TeamCrestBase,
  (a, b) =>
    a.size === b.size &&
    a.transparent === b.transparent &&
    a.team.id === b.team.id &&
    a.team.name === b.team.name &&
    a.team.shortName === b.team.shortName,
);
