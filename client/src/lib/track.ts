// Tiny fire-and-forget helper for client-side activity tracking. Used to
// record SPA tab/section changes that don't otherwise trigger a server
// round-trip (the LMS sub-tabs, the Lawro sub-tabs etc). Failures are
// swallowed — tracking must never disrupt the UI.
export async function trackEvent(opts: {
  path: string;
  subPath?: string;
  label?: string;
}): Promise<void> {
  try {
    await fetch("/api/track", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
      keepalive: true,
    });
  } catch {
    // Intentional: tracking failures must never disrupt the UI.
  }
}
