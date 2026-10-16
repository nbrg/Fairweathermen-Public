// Pure helpers for the live match minute (matches.minute) that the Lawro
// match-progress indicator shows. Kept dependency-free (no DB / no network) so
// the live-sync's minute logic can be unit-tested in isolation — see
// scripts/testLiveMinuteSync.ts. Used by server/footballDataApi.ts.

// Parse football-data's `minute` (number | "34" | "45+2" | null) to an integer,
// or null if it isn't a usable live minute.
export function parseFdMinute(raw: number | string | null | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

// Decide the `minute` update for a match from its new status and the feed's
// minute:
//   - in progress → the parsed minute, flagged `changed` only if it moved;
//   - otherwise   → null, flagged `changed` only if a stale minute was set,
//                   so a finished match stops showing its last live minute.
export function nextLiveMinute(
  newStatus: string,
  fdMinute: number | string | null | undefined,
  localMinute: number | null | undefined,
): { changed: boolean; minute: number | null } {
  if (newStatus === "in_progress") {
    const minute = parseFdMinute(fdMinute);
    return { changed: minute !== (localMinute ?? null), minute };
  }
  return { changed: (localMinute ?? null) !== null, minute: null };
}
