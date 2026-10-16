// Timezone-correct helpers for our stored kickoff strings.
//
// Match kickoffs are stored as naive London-local strings ("YYYY-MM-DD
// HH:MM:SS") — no timezone marker. Parsing them with `new Date(str)` is wrong in
// two ways: it's interpreted in the *runtime's* timezone (the server's UTC, or a
// viewer's local zone), and the space form is `Invalid Date` on some browsers.
// These helpers convert to/from a real UTC instant using the Europe/London zone
// via Intl, so deadlines, countdowns and locking are correct everywhere and all
// year round (BST included). Pure — safe to import from both client and server.

// Format a UTC ISO instant as a London-local "YYYY-MM-DD HH:MM:SS" string.
export function utcToLondonString(utcIso: string): string {
  const d = new Date(utcIso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const obj: Record<string, string> = {};
  for (const p of parts) obj[p.type] = p.value;
  return `${obj.year}-${obj.month}-${obj.day} ${obj.hour}:${obj.minute}:${obj.second}`;
}

// Convert a naive London-local "YYYY-MM-DD HH:MM:SS" string to a UTC epoch (ms).
// Works across BST/GMT by measuring the drift between a UTC guess and how that
// guess reads back in London, then correcting for it. Returns NaN for input that
// doesn't parse.
export function londonStringToUtcMs(londonStr: string): number {
  if (!londonStr) return NaN;
  const iso = londonStr.replace(" ", "T");
  const guessUtc = new Date(`${iso}Z`);
  if (Number.isNaN(guessUtc.getTime())) return NaN;
  const londonReadback = utcToLondonString(guessUtc.toISOString());
  const driftMs =
    new Date(`${londonReadback.replace(" ", "T")}Z`).getTime() - guessUtc.getTime();
  return guessUtc.getTime() - driftMs;
}
