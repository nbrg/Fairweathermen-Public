import { useEffect } from "react";
import { useGroup } from "@/contexts/GroupContext";
import GroupGate from "@/pages/GroupGate";

// Visiting /switch clears the group cookie and shows the gate. Used by people
// who belong to more than one group to swap between them without needing a
// visible "Switch group" button in the header (which would clutter the UI
// for the 99% who only belong to one).
export default function GroupSwitch() {
  const { group, logout } = useGroup();

  useEffect(() => {
    if (group) {
      logout().then(() => {
        // Rewrite the URL so refreshes don't keep re-triggering the logout
        // — the gate is what we actually want to render.
        window.history.replaceState({}, "", "/");
      });
    } else {
      window.history.replaceState({}, "", "/");
    }
  }, [group, logout]);

  return <GroupGate />;
}
