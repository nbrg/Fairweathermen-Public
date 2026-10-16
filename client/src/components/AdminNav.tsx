import { Link, useLocation } from "wouter";

// Little nav bar shared by the admin-only views so the owner can move between
// them without editing the URL. The admin password (stored in localStorage) is
// shared across all three, so switching here never re-prompts.
const LINKS = [
  { href: "/activity", label: "Activity" },
  { href: "/audit", label: "Audit" },
  { href: "/admin/notifications", label: "Reminders" },
];

export function AdminNav() {
  const [loc] = useLocation();
  return (
    <nav className="mb-4 inline-flex gap-1 rounded-lg border bg-white p-1">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            loc === l.href ? "bg-primary text-white" : "text-gray-600 hover:bg-gray-100"
          }`}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
