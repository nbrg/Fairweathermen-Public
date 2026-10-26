import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { queryClient } from "@/lib/queryClient";
import type { GroupRules, RuleChangeItem } from "@shared/schema";

// A rule change the admin made that this player hasn't acknowledged yet.
export type UnseenRuleChange = {
  id: number;
  changedAt: string;
  // Who made the change (the group's admin), for "Alex has changed the rules".
  changedByName: string | null;
  changes: RuleChangeItem[];
  // Set when Lawro rules changed: the first gameweek the change applies to
  // (99 = from next season).
  lawroEffectiveGameweek: number | null;
};

export type SessionUser = {
  id: number;
  username: string;
};

export type GroupSummary = {
  id: number;
  slug: string;
  name: string;
  // The games the logged-in person can see in this group (their per-group
  // override applied). Lets the header build cross-group game tabs.
  enabledGames?: string[];
};

export type Group = {
  id: number;
  slug: string;
  name: string;
  enabledGames: string[];
  // The logged-in user this session belongs to. Present now that login is
  // per-user rather than per-group.
  user?: SessionUser;
  // Every group this person can switch between (one entry per group they
  // belong to). Length > 1 means the header shows a group switcher.
  availableGroups?: GroupSummary[];
  // This group's resolved rules (defaults merged, legacy columns bridged).
  // Lets the client score / label using the group's own settings.
  rules?: GroupRules;
  // True when the logged-in person created this group (is its admin). Gates the
  // owner-only group settings page + header link.
  isOwner?: boolean;
  // Rule changes made by the admin since this player last acknowledged them;
  // shown in a pop-up (RuleChangesDialog) until they do.
  ruleChanges?: UnseenRuleChange[];
};

type GroupContextValue = {
  group: Group | null;
  // Convenience accessor for the logged-in user (group?.user).
  user: SessionUser | null;
  // Groups this person can switch between (empty if just one / not logged in).
  availableGroups: GroupSummary[];
  loading: boolean;
  login: (code: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => Promise<void>;
  switchGroup: (groupId: number) => Promise<{ ok: true } | { ok: false; error: string }>;
  // Marks the rule-change pop-up as read up to `upToId`: hides it at once and
  // records it on the server so it doesn't come back.
  dismissRuleChanges: (upToId: number) => void;
};

const GroupContext = createContext<GroupContextValue | null>(null);

export function GroupProvider({ children }: { children: ReactNode }) {
  const [group, setGroup] = useState<Group | null>(null);
  const [loading, setLoading] = useState(true);

  // Try to recover the session on mount. If the cookie is valid the server
  // returns the group; if not (401), we render the code-entry gate.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/group/me", { credentials: "include" });
        if (res.ok) {
          const data = (await res.json()) as Group;
          if (!cancelled) setGroup(data);
        }
      } catch {
        // ignore — treat as unauthenticated
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = async (code: string) => {
    const res = await fetch("/api/group/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false as const, error: data?.error || `Login failed (${res.status})` };
    }
    const data = (await res.json()) as Group;
    setGroup(data);
    return { ok: true as const };
  };

  const logout = async () => {
    await fetch("/api/group/logout", { method: "POST", credentials: "include" });
    setGroup(null);
    // Drop all cached game data so a subsequent login starts clean.
    queryClient.clear();
  };

  const switchGroup = async (groupId: number) => {
    const res = await fetch("/api/group/switch", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false as const, error: data?.error || `Switch failed (${res.status})` };
    }
    const data = (await res.json()) as Group;
    setGroup(data);
    // All game data (LMS/predictions) is group-scoped — clear the cache
    // so every query refetches for the newly-active group.
    queryClient.clear();
    return { ok: true as const };
  };

  const dismissRuleChanges = (upToId: number) => {
    // Drop the acknowledged changes from the session itself (not just from the
    // pop-up's own state) so nothing can bring them back until a reload.
    setGroup((g) => (g ? { ...g, ruleChanges: (g.ruleChanges ?? []).filter((c) => c.id > upToId) } : g));
    fetch("/api/group/rule-changes/seen", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upToId }),
    })
      .then((res) => {
        if (!res.ok) console.error("[rule-changes/seen] failed:", res.status);
      })
      .catch((err) => console.error("[rule-changes/seen] failed:", err));
  };

  return (
    <GroupContext.Provider
      value={{
        group,
        user: group?.user ?? null,
        availableGroups: group?.availableGroups ?? [],
        loading,
        login,
        logout,
        switchGroup,
        dismissRuleChanges,
      }}
    >
      {children}
    </GroupContext.Provider>
  );
}

export function useGroup(): GroupContextValue {
  const ctx = useContext(GroupContext);
  if (!ctx) throw new Error("useGroup must be used within GroupProvider");
  return ctx;
}
