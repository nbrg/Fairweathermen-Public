import { useEffect, useMemo, useSyncExternalStore } from "react";
import { queryClient } from "@/lib/queryClient";

type Snapshot = { value: string; state: "saved" | "saving" | "error" | "incomplete"; message: string };
type Entry = {
  userId: number; matchId: number; value: string; dirty: boolean; version: number;
  inFlight: boolean; blocked: boolean; retryable: boolean; attempts: number;
  timer?: ReturnType<typeof setTimeout>; snapshot: Snapshot; listeners: Set<() => void>;
};

// A queue belongs to the pick, not its mounted input. Switching tabs or
// gameweeks must not discard writes or start a second writer for the same pick.
const entries = new Map<string, Entry>();
const complete = (value: string) => value === "" || /^\d-\d$/.test(value);
const key = (userId: number, matchId: number) => `lawro-draft:${userId}:${matchId}`;

function publish(entry: Entry, state: Snapshot["state"], message = "") {
  entry.snapshot = { value: entry.value, state, message };
  entry.listeners.forEach(listener => listener());
}

function persist(entry: Entry) {
  try {
    if (entry.dirty) sessionStorage.setItem(key(entry.userId, entry.matchId), JSON.stringify({ value: entry.value }));
    else sessionStorage.removeItem(key(entry.userId, entry.matchId));
  } catch { /* Saving to the server still works when browser storage is disabled. */ }
}

function getEntry(userId: number, matchId: number, serverValue: string, enabled: boolean): Entry {
  const identity = key(userId, matchId);
  const cached = enabled && entries.get(identity);
  if (cached) return cached;
  let value = serverValue;
  let dirty = false;
  if (enabled) {
    try {
      const draft = JSON.parse(sessionStorage.getItem(identity) || "null");
      if (draft && typeof draft.value === "string" && /^(\d-\d?)?$/.test(draft.value)) {
        value = draft.value;
        dirty = true;
      }
    } catch { /* An unreadable draft must not prevent score entry. */ }
  }
  const entry: Entry = {
    userId, matchId, value, dirty, version: 0, inFlight: false,
    blocked: false, retryable: true, attempts: 0, listeners: new Set(),
    snapshot: { value, state: dirty ? complete(value) ? "saving" : "incomplete" : "saved", message: "" },
  };
  if (enabled) entries.set(identity, entry);
  return entry;
}

async function pump(entry: Entry) {
  if (!entry.dirty || entry.inFlight || entry.timer || entry.blocked || !complete(entry.value)) return;
  const value = entry.value;
  const version = entry.version;
  entry.inFlight = true;
  publish(entry, "saving");
  let retryable = true;
  try {
    const [homeScore, awayScore] = value === "" ? [null, null] : value.split("-").map(Number);
    const response = await fetch("/api/predictions", {
      method: "PUT", credentials: "include", keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: entry.userId, matchId: entry.matchId, homeScore, awayScore }),
    });
    if (!response.ok) {
      retryable = response.status >= 500 || response.status === 408 || response.status === 429;
      const body = await response.json().catch(() => null);
      throw new Error(typeof body?.error === "string" ? body.error : "Could not save your prediction.");
    }
    // A broken/lost response can follow a committed write. PUT is safe to retry.
    const body = await response.json();
    const confirmed = body?.prediction;
    if (value === "" ? confirmed !== null : !confirmed || confirmed.userId !== entry.userId ||
        confirmed.matchId !== entry.matchId || confirmed.homeScore !== homeScore || confirmed.awayScore !== awayScore) {
      throw new Error("Could not confirm your prediction.");
    }
    entry.attempts = 0;
    if (entry.version === version) {
      entry.dirty = false;
      persist(entry);
    }
    // Keep the input's newer draft, even if this response/refetch has an older score.
    publish(entry, entry.dirty ? complete(entry.value) ? "saving" : "incomplete" : "saved");
    void queryClient.invalidateQueries({ queryKey: ["/api/predictions"] });
    void queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
  } catch (error) {
    entry.retryable = retryable;
    if (entry.version !== version) {
      // The next operation saves the latest desired value, not an obsolete edit.
      entry.attempts = 0;
    } else if (retryable && entry.attempts < 3) {
      const delay = 500 * 2 ** entry.attempts++;
      publish(entry, "saving", "Retrying…");
      entry.timer = setTimeout(() => { entry.timer = undefined; void pump(entry); }, delay);
    } else {
      entry.blocked = true;
      publish(entry, "error", retryable ? "Not saved. Check your connection and retry." :
        error instanceof Error ? error.message : "Could not save your prediction.");
    }
  } finally {
    entry.inFlight = false;
    if (entry.dirty && !complete(entry.value)) publish(entry, "incomplete", "Finish the score, e.g. 2-1.");
    void pump(entry);
  }
}

function retry(entry: Entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.blocked = false;
  entry.attempts = 0;
  void pump(entry);
}

if (typeof window !== "undefined") {
  const resume = () => entries.forEach(entry => {
    if (entry.dirty && entry.retryable) retry(entry);
  });
  window.addEventListener("online", resume);
  window.addEventListener("pagehide", () => entries.forEach(entry => { void pump(entry); }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resume();
    else entries.forEach(entry => { void pump(entry); });
  });
}

export function usePredictionSave(userId: number, matchId: number, serverValue: string, enabled: boolean) {
  const entry = useMemo(() => getEntry(userId, matchId, serverValue, enabled), [userId, matchId, enabled]);
  const snapshot = useSyncExternalStore(
    listener => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; },
    () => entry.snapshot,
  );
  useEffect(() => {
    if (!enabled) return;
    if (!entry.dirty && !entry.inFlight && entry.value !== serverValue) {
      entry.value = serverValue;
      publish(entry, "saved");
    }
    void pump(entry);
  }, [entry, serverValue, enabled]);

  return {
    ...snapshot,
    change(value: string) {
      entry.value = value;
      entry.version++;
      entry.dirty = true;
      entry.blocked = false;
      entry.attempts = 0;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      persist(entry);
      publish(entry, complete(value) ? "saving" : "incomplete", complete(value) ? "" : "Finish the score, e.g. 2-1.");
      void pump(entry);
    },
    retry: () => retry(entry),
  };
}
