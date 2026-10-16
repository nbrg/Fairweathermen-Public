import { useLocation } from "wouter";
import { useCallback, useEffect, useRef } from "react";

// Records a client-side "visit" to the activity feed. Fires on every route
// change AND whenever the app is re-opened / brought back to the foreground.
//
// The foreground case matters because the app is an installed PWA: when someone
// resumes it from the background (or flips back to an already-open browser tab)
// it stays on whatever route they left, so `location` never changes and the
// route-change effect alone would never re-fire. That visit — often the one
// where they then make a pick — would go completely unrecorded in /activity,
// even though the pick itself lands in /audit. Firing on visibility/focus
// captures those "opened the site" visits too. Consecutive events are collapsed
// into one session (30-min window) on the activity page, so this doesn't spam.
export function usePageTracking() {
  const [location] = useLocation();
  // Keep the current route available to the visibility/focus listener, which is
  // registered once and would otherwise close over a stale value.
  const locationRef = useRef(location);
  locationRef.current = location;
  // Throttle foreground re-fires so a quick tab-flick doesn't record repeatedly.
  const lastForegroundFire = useRef(0);

  // trigger: "navigation" = a real route change / first load; "foreground" = the
  // app being brought back to the foreground on the same route. The server flags
  // foreground re-fires (and loads that happen while hidden) as passive so the
  // activity feed can hide them — on iOS these fire whenever someone returns to
  // Safari with the site as the open tab, which looks like a phantom visit.
  const track = useCallback((path: string, trigger: "navigation" | "foreground") => {
    // Don't record a visit while the page is a speculative prerender — the
    // browser loaded it in the background and the person hasn't actually opened
    // it. If they do activate it, `prerenderingchange` fires and we record then.
    if (typeof document !== "undefined" && (document as any).prerendering) return;
    // credentials: "include" so the session cookie rides along and the visit is
    // attributed to the logged-in user (without it, matching the rest of the
    // app's requests, visits can land unattributed and get hidden from /activity).
    fetch("/api/track/page-visit", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        referrer: document.referrer || "direct",
        trigger,
        visible: document.visibilityState === "visible",
      }),
      keepalive: true,
    }).catch(() => {
      // Silently fail — tracking must never disrupt the user experience.
    });
  }, []);

  // Every route change (and the initial mount). If this load started as a
  // prerender, `track` no-ops above; record the visit once the prerender is
  // activated (the person actually navigates to it) instead.
  useEffect(() => {
    if (typeof document !== "undefined" && (document as any).prerendering) {
      const onActivate = () => track(locationRef.current, "navigation");
      document.addEventListener("prerenderingchange", onActivate, { once: true });
      return () => document.removeEventListener("prerenderingchange", onActivate);
    }
    track(location, "navigation");
  }, [location, track]);

  // App re-opened / re-foregrounded on the same route.
  useEffect(() => {
    const onForeground = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      // Ignore rapid hidden→visible flaps; a genuine re-open is minutes apart.
      if (now - lastForegroundFire.current < 60_000) return;
      lastForegroundFire.current = now;
      track(locationRef.current, "foreground");
    };
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("focus", onForeground);
    return () => {
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("focus", onForeground);
    };
  }, [track]);
}
