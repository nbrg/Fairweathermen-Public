import { useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";

// Little nav bar shared by every admin-only view so the owner can move between
// them without editing the URL. The admin password is stored once in
// localStorage ("adminApiKey") and read by all of them, so switching here never
// re-prompts. Add any new admin page here too.
export const ADMIN_LINKS = [
  { href: "/activity", label: "Activity" },
  { href: "/admin/growth", label: "Growth" },
  { href: "/audit", label: "Audit" },
  { href: "/admin/notifications", label: "Reminders" },
  { href: "/admin/players", label: "Players" },
  { href: "/admin", label: "Visitors" },
];

export function AdminNav() {
  const [loc] = useLocation();
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  // On a phone the bar scrolls sideways; keep the current page's tab in view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [loc]);

  return (
    <nav
      aria-label="Admin pages"
      data-testid="admin-nav"
      className="-mx-4 mb-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="inline-flex gap-1 rounded-xl bg-muted p-1">
        {ADMIN_LINKS.map((l) => {
          const active = loc === l.href;
          return (
            <Link
              key={l.href}
              href={l.href}
              ref={active ? activeRef : undefined}
              aria-current={active ? "page" : undefined}
              className={`flex h-9 shrink-0 items-center justify-center whitespace-nowrap rounded-lg px-3 text-sm ${
                active
                  ? "bg-card font-semibold text-foreground shadow-[0_1px_3px_rgba(23,18,31,0.12)]"
                  : "font-medium text-muted-foreground hover:text-foreground"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
