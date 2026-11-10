import { ThemeProvider } from "@/lib/theme";
import MetricsPage from "@/pages/MetricsPage";
import { useEffect } from "react";
import { Switch, Route, useLocation } from "wouter";
import { LmsWheel } from "@/components/lms/LmsWheel";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import HomePage from "@/pages/HomePage";
import AdminStats from "@/pages/AdminStats";
import LastManStandingPage from "./pages/LastManStandingPage";
import AdminPlayers from "@/pages/AdminPlayers";
import AdminNotifications from "@/pages/AdminNotifications";
import GroupGate from "@/pages/GroupGate";
import GroupSwitch from "@/pages/GroupSwitch";
import CreateGroup from "@/pages/CreateGroup";
import JoinGroup from "@/pages/JoinGroup";
import SettingsPage from "@/pages/SettingsPage";
import BottomNav from "@/components/BottomNav";
import RuleChangesDialog from "@/components/RuleChangesDialog";
import AuditPage from "@/pages/AuditPage";
import ActivityPage from "@/pages/ActivityPage";
import GrowthPage from "@/pages/GrowthPage";
import ChangesPage from "@/pages/ChangesPage";
import HelpPage from "@/pages/HelpPage";
import { GroupProvider, useGroup } from "@/contexts/GroupContext";
import ScreenResolutionTracker from "@/components/ScreenResolutionTracker";
import { usePageTracking } from "@/hooks/usePageTracking";
import { landingGame } from "@shared/navGames";

// The landing page (/) defaults to the group's primary game, in priority
// order: Last Man Standing (the year-round game), then the Prediction League
// ("Lawro"). Keep this precedence in step with the highlight logic in
// Header.tsx.
function DefaultGame() {
  const { group } = useGroup();
  // Precedence lives in shared/navGames.ts so /activity labels "/" the same way.
  const game = landingGame(group?.enabledGames);
  if (game === "lms") return <LastManStandingPage />;
  return <HomePage />;
}

// Renders the Prediction League ("Lawro") page, but first makes sure the active
// group actually hosts it. The Lawro *tab* already switches groups before
// navigating (Header.openGame), but a direct arrival at /lawro — a bookmark, a
// push-notification link, or the PWA reopening on the route it was left on —
// bypasses that. A multi-group person (e.g. Blake, in a Lawro group plus
// Fairweathermen which has no Prediction League) would then land on Lawro under
// the wrong active group, and every pick would save against that group. The
// server now rejects those writes, but that leaves a confusing dead-end page.
//
// So mirror the header's host-group logic here: if the active group doesn't
// offer "predictions" but another of the person's groups does, switch into that
// group automatically, then render. If none of their groups offers it, fall
// through and render anyway (the server guard still protects the data).
function LawroRoute() {
  const { group, availableGroups, switchGroup } = useGroup();

  const activeHasLawro = !!group?.enabledGames?.includes("predictions");
  // Prefer the active group; otherwise the first of the person's groups that
  // offers Lawro (matches Header's gameToGroupId preference order).
  const hostGroupId = activeHasLawro
    ? group?.id
    : availableGroups.find((g) => (g.enabledGames ?? []).includes("predictions"))?.id;
  const needsSwitch = group != null && hostGroupId != null && hostGroupId !== group.id;

  useEffect(() => {
    if (needsSwitch && hostGroupId != null) {
      void switchGroup(hostGroupId);
    }
  }, [needsSwitch, hostGroupId, switchGroup]);

  // While the switch is in flight, don't render HomePage under the wrong group
  // (that would fire wrong-group queries and flash the wrong data). A brief
  // blank is enough — switchGroup updates the context and re-renders us.
  if (needsSwitch) {
    return <div className="min-h-screen bg-background" />;
  }
  return <HomePage />;
}

function Router() {
  // Track page navigation
  usePageTracking();

  // Always land at the top of the page on every navigation (tab switches,
  // group switches, direct links). Combined with scrollRestoration = "manual"
  // (set in main.tsx), this stops the browser restoring a previous scroll
  // position and keeps the navbar in view.
  const [location] = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);

  // Remount the page whenever the active group changes. Switching group keeps
  // you on the same game route when the new group offers it (see Header's
  // GroupSwitcher), so without this a page would carry the old group's local
  // state (selected round, competition, tab) into the new group.
  const { group } = useGroup();

  return (
    <>
    <Switch key={group?.id ?? "none"}>
      <Route path="/" component={DefaultGame} />
      <Route path="/last-man-standing" component={LastManStandingPage} />
      <Route path="/lms" component={LastManStandingPage} />
      <Route path="/lawro" component={LawroRoute} />
      {/* Legacy alias so old links / push notifications still work. */}
      <Route path="/predictions" component={LawroRoute} />
      {/* Self-service group creation + invites (public; see GatedShell). */}
      <Route path="/create" component={CreateGroup} />
      <Route path="/join/:token">{(params) => <JoinGroup token={params.token} />}</Route>
      {/* Settings for everyone (theme, reminders, install, log out); the
          group owner's rules, players and invite link are part of it too.
          /group-settings is the old owner-only URL: it opens Settings at the
          admin section. */}
      <Route path="/settings">{() => <SettingsPage />}</Route>
      <Route path="/group-settings">{() => <SettingsPage focusAdmin />}</Route>
      <Route path="/admin/visitors" component={AdminStats} />
      <Route path="/admin/metrics" component={MetricsPage} />
      <Route path="/admin/players" component={AdminPlayers} />
      <Route path="/admin/notifications" component={AdminNotifications} />
      <Route path="/admin/growth" component={GrowthPage} />
      <Route path="/admin/changes" component={ChangesPage} />
      <Route path="/admin/audit" component={AuditPage} />
      <Route path="/admin/activity" component={ActivityPage} />
      <Route path="/help" component={HelpPage} />
      {/* Fallback to 404 */}
      <Route component={NotFound} />
    </Switch>
    <BottomNav />
    </>
  );
}

// Decides whether to render the group-entry gate or the regular app based on
// the current group session. Admin URLs bypass the gate so they remain
// reachable by direct URL (they have their own server-side API-key auth).
// Visiting /switch clears the cookie and shows the gate so a member of
// multiple groups can re-enter a different code.
function GatedShell() {
  const { group, loading } = useGroup();

  // Always start at the very top when the authenticated app first renders (on
  // login, on a group switch, or on a reload with a valid cookie). Without this
  // the landing content can auto-focus an element and scroll the header out of
  // view, leaving the user part-way down the page. Keyed on the active group id
  // so it also re-tops on a switch.
  //
  // On mobile there are two culprits that fire *after* the first render — the
  // landing content auto-focusing, and the on-screen keyboard dismissing after
  // the code was typed — either of which re-scrolls the page. iOS also animates
  // the keyboard closed over a few hundred ms and can re-scroll when it settles.
  // So we blur any focused element (dismisses the keyboard) and re-assert the
  // top position across the next ~1s, and once more whenever a resize fires
  // (the keyboard closing changes the viewport height) during that window.
  useEffect(() => {
    if (!group) return;
    let active = true;
    const toTop = () => {
      if (!active) return;
      (document.activeElement as HTMLElement | null)?.blur?.();
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
    toTop();
    const raf = requestAnimationFrame(toTop);
    const timers = [60, 150, 300, 600, 1000].map((ms) => setTimeout(toTop, ms));
    // The keyboard finishing its close fires a resize; re-top then, but only for
    // a short window so normal scrolling isn't hijacked later.
    window.addEventListener("resize", toTop, { passive: true });
    const stopResize = setTimeout(() => window.removeEventListener("resize", toTop), 1500);
    // Once someone starts typing/tapping/scrolling, their focus and position
    // take precedence. Delayed layout corrections used to blur the first
    // Lawro input between its two digits and dismiss the mobile keyboard.
    const interactions = ["pointerdown", "keydown", "input", "wheel"];
    const stop = () => {
      active = false;
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      clearTimeout(stopResize);
      window.removeEventListener("resize", toTop);
      window.removeEventListener("focusin", onScoreFocus, true);
      interactions.forEach(type => window.removeEventListener(type, stop, true));
    };
    // Keyboard/accessibility tools can focus a score without pointerdown. Stop
    // before the next layout timer can blur it, even before its first keypress.
    const onScoreFocus = (event: Event) => {
      if ((event.target as HTMLElement).matches?.("input[data-score-input]")) stop();
    };
    window.addEventListener("focusin", onScoreFocus, true);
    interactions.forEach(type => window.addEventListener(type, stop, { capture: true, passive: true }));
    return stop;
  }, [group?.id]);

  const path =
    typeof window !== "undefined" ? window.location.pathname : "/";
  const isAdminPath = path.startsWith("/admin");
  const isSwitchPath = path === "/switch";
  // Public, pre-login pages: self-service group creation + invite links must be
  // reachable without a group cookie.
  const lowerPath = path.toLowerCase();
  const isPublicPath = lowerPath === "/create" || lowerPath.startsWith("/join/");

  if (loading) {
    // Brief blank while we check the cookie; avoids a flash of the gate.
    return <div className="min-h-screen bg-background" />;
  }

  if (isSwitchPath) {
    return <GroupSwitch />;
  }

  if (!group && !isAdminPath && !isPublicPath) {
    return <GroupGate />;
  }

  return (
    <>
      <Router />
      {group && <RuleChangesDialog />}
      {/* LMS randomiser wheel: a site-wide pop-up from a missed deadline until
          the last wheel has spun (renders nothing otherwise). */}
      {group && <LmsWheel />}
    </>
  );
}

function App() {
  return (
    <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <GroupProvider>
        <TooltipProvider>
          <Toaster />
          <ScreenResolutionTracker />
          {/* Breathing room under every page: the last card shouldn't sit flush
              against the bottom edge (or the purple safe-area strip below), so
              pad by the home-indicator inset plus a little extra. */}
          <div style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 2rem)" }}>
            <GatedShell />
          </div>
          {/* Paint the bottom safe-area (home-indicator strip) in the same
              purple as the header so the installed PWA looks intentional top
              and bottom. Zero-height (invisible) on devices without an inset. */}
          <div
            aria-hidden
            className="fixed inset-x-0 bottom-0 z-30 bg-header"
            style={{ height: "env(safe-area-inset-bottom)" }}
          />
        </TooltipProvider>
      </GroupProvider>
    </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
