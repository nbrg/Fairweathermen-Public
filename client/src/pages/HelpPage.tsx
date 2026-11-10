import { Link } from "wouter";

type RouteRow = {
  path: string;
  name: string;
  description: string;
};

// Visible routes (entered via nav or direct URL).
const PRIMARY_ROUTES: RouteRow[] = [
  {
    path: "/",
    name: "Home",
    description:
      "Default landing page once you've entered a group code — your group's primary game (Last Man Standing, else Lawro).",
  },
  {
    path: "/last-man-standing",
    name: "Last Man Standing",
    description:
      "Live / History / Fixtures / Stats / Rules tabs for the Premier League knockout game. Aliased at /lms.",
  },
  {
    path: "/lawro",
    name: "Lawro",
    description:
      "The Premier League score-prediction game (predict every match, one gameweek at a time). Shown for groups with it enabled.",
  },
];

// Admin / hidden routes — visible by direct URL only.
const HIDDEN_ROUTES: RouteRow[] = [
  { path: "/admin/metrics", name: "Metrics", description: "Engagement, growth, retention and audience dashboards. Admin-key gated across all groups." },
  {
    path: "/switch",
    name: "Switch group",
    description:
      "Clears your group cookie and shows the code prompt. Use this to swap between groups you belong to.",
  },
  {
    path: "/admin/audit",
    name: "Audit log",
    description:
      "Pick and scoring history across all groups, with a group filter. Admin-key gated.",
  },
  {
    path: "/admin/activity",
    name: "Activity log",
    description:
      "Site visits and sub-tab views across all groups, grouped into sessions (consecutive activity within 30 mins). Admin-key gated.",
  },
  {
    path: "/help",
    name: "Help (this page)",
    description: "List of every URL on the site. Not linked from anywhere else.",
  },
  {
    path: "/admin/visitors",
    name: "Admin stats",
    description:
      "General admin / visitor stats. Has its own API-key auth and bypasses the group gate.",
  },
  {
    path: "/admin/players",
    name: "Admin — Manage Players",
    description:
      "Add or remove players from any group's roster. Admin-key gated; removing a player also deletes their picks and predictions.",
  },
];

function RouteTable({ rows }: { rows: RouteRow[] }) {
  return (
    <div className="overflow-x-auto rounded-md border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
            <th className="text-left p-2 font-medium whitespace-nowrap">Path</th>
            <th className="text-left p-2 font-medium whitespace-nowrap">Name</th>
            <th className="text-left p-2 font-medium">What it does</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.path}>
              <td className="p-2 align-top">
                <Link
                  href={r.path}
                  className="font-mono text-xs text-emerald-700 hover:underline whitespace-nowrap"
                >
                  {r.path}
                </Link>
              </td>
              <td className="p-2 align-top font-medium text-gray-800 whitespace-nowrap">
                {r.name}
              </td>
              <td className="p-2 align-top text-gray-700">{r.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function HelpPage() {
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-primary">Help</h1>
          <p className="text-sm text-gray-600">
            Every route on the site. Not linked from anywhere — bookmark this
            page if you want quick access.
          </p>
        </div>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-gray-800">In the nav</h2>
          <RouteTable rows={PRIMARY_ROUTES} />
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-gray-800">
            Hidden / admin routes
          </h2>
          <RouteTable rows={HIDDEN_ROUTES} />
        </section>
      </main>
    </div>
  );
}
