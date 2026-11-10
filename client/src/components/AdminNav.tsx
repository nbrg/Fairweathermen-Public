import { useEffect, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { Link, useLocation } from "wouter";
import Header from "@/components/Header";

// Little nav bar shared by every admin-only view so the owner can move between
// them without editing the URL. The admin password is stored once in
// localStorage ("adminApiKey") and read by all of them, so switching here never
// re-prompts. Add any new admin page here too.
export const ADMIN_LINKS = [
  { href: "/admin/activity", label: "Activity" },
  { href: "/admin/audit", label: "Audit" },
  { href: "/admin/players", label: "Players" },
  { href: "/admin/notifications", label: "Reminders" },
  { href: "/admin/growth", label: "Growth" },
  { href: "/admin/metrics", label: "Metrics" },
  { href: "/admin/visitors", label: "Visitors" },
  { href: "/admin/changes", label: "Changes" },
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

// The one page frame every admin view uses, so they all match the game pages:
// the regular site header (with the game tabs, which Header hides on its own
// when a player has only one game), then the same max-w-5xl column and padding
// as Lawro/LMS, with the admin tabs on top. Pass `nav={false}` to drop the admin
// tabs (the password gate).
export function AdminLayout({
  children,
  nav = true,
  className = "",
}: {
  children: ReactNode;
  nav?: boolean;
  className?: string;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      <main
        data-testid="admin-layout"
        className={`container mx-auto max-w-5xl px-4 py-4 sm:py-6 flex-grow ${className}`}
      >
        {nav && <AdminNav />}
        {children}
      </main>
    </div>
  );
}

// An admin page's title. Any explanation goes in `children` and stays hidden
// behind the (i) button next to the title until tapped, so the page itself
// starts with the data rather than a wall of text.
export function AdminPageTitle({ title, children }: { title: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-bold text-primary">{title}</h1>
        {children && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="How this page works"
            data-testid="admin-help-toggle"
            className={`flex h-8 w-8 items-center justify-center rounded-full ${
              open ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Info className="h-5 w-5" />
          </button>
        )}
      </div>
      {children && open && (
        <div data-testid="admin-help" className="mt-2 space-y-2 rounded-xl bg-muted p-3 text-sm text-gray-600">
          {children}
        </div>
      )}
    </div>
  );
}
