// Tiny fire-and-forget helper for client-side activity tracking. Used to
// record SPA tab/section changes that don't otherwise trigger a server
// round-trip (the LMS sub-tabs etc). Failures are
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

// A fine-grained activity event (see shared/activityEvents.ts): backgrounding
// the app, watching the LMS wheel, highlighting a fixture, using a Tendencies
// chart… Fire-and-forget; uses keepalive so it survives the page being hidden
// or closed straight afterwards.
export function trackUiEvent(
  event: import("@shared/activityEvents").ClientEvent,
  detail: Record<string, string | number | boolean | null | undefined> = {},
): void {
  try {
    if (typeof document !== "undefined" && (document as any).prerendering) return;
    fetch("/api/track/event", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, path: window.location.pathname, detail }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Intentional: tracking failures must never disrupt the UI.
  }
}
