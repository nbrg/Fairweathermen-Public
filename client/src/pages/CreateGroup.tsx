import { useState, type FormEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

// The games a self-service group can choose to run (kept in step with
// SELF_SERVE_GAMES on the server).
const GAME_OPTIONS: { key: string; label: string; blurb: string }[] = [
  { key: "lms", label: "Last Man Standing", blurb: "Pick one team to win each week; a wrong pick knocks you out." },
  { key: "predictions", label: "Lawro (score predictions)", blurb: "Predict every Premier League scoreline for points." },
];

type CreateResult = {
  loginCode: string;
  inviteUrl: string;
};

// Public page (/create) — anyone can create their own group. They name it, pick
// a game or two, and become its admin. We show them their personal login code
// and an invite link to share, then let them enter the group.
export default function CreateGroup() {
  const [groupName, setGroupName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [games, setGames] = useState<Set<string>>(new Set(["lms"]));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [copied, setCopied] = useState(false);

  function toggleGame(key: string) {
    setGames((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!groupName.trim() || !adminName.trim() || games.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/group/create", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupName: groupName.trim(),
          adminName: adminName.trim(),
          games: Array.from(games),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || `Couldn't create the group (${res.status})`);
        return;
      }
      setResult({ loginCode: data.code, inviteUrl: data.inviteUrl });
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyInvite() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; the link is shown to copy manually */
    }
  }

  if (result) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 px-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-xl">Your group is ready 🎉</CardTitle>
            <p className="text-sm text-gray-500 mt-1">
              Save your login code and share the invite link with your players.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs text-gray-500">Your personal login code</Label>
              <div className="mt-1 font-mono text-lg font-bold tracking-wide bg-gray-100 rounded-md px-3 py-2 select-all">
                {result.loginCode}
              </div>
              <p className="text-xs text-gray-500 mt-1">
                You'll use this to sign in. Keep it private — it's just for you.
              </p>
            </div>
            <div>
              <Label className="text-xs text-gray-500">Invite link</Label>
              <div className="mt-1 flex gap-2">
                <Input readOnly value={result.inviteUrl} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" onClick={copyInvite}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Anyone who opens this link can join and get their own login code.
              </p>
            </div>
            <Button className="w-full" onClick={() => (window.location.href = "/")}>
              Enter your group
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Create a group</CardTitle>
          <p className="text-sm text-gray-500 mt-1">
            Start your own circle for Last Man Standing and score predictions.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="groupName">Group name</Label>
              <Input
                id="groupName"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="e.g. The Office League"
                maxLength={60}
                disabled={submitting}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="adminName">Your name</Label>
              <Input
                id="adminName"
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                placeholder="e.g. Alex"
                maxLength={40}
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label>Games</Label>
              {GAME_OPTIONS.map((g) => (
                <label key={g.key} className="flex items-start gap-3 rounded-md border p-3 cursor-pointer">
                  <Checkbox
                    checked={games.has(g.key)}
                    onCheckedChange={() => toggleGame(g.key)}
                    disabled={submitting}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-medium">{g.label}</span>
                    <span className="block text-xs text-gray-500">{g.blurb}</span>
                  </span>
                </label>
              ))}
            </div>
            {error && <div className="text-xs text-red-600">{error}</div>}
            <Button
              type="submit"
              className="w-full"
              disabled={submitting || !groupName.trim() || !adminName.trim() || games.size === 0}
            >
              {submitting ? "Creating…" : "Create group"}
            </Button>
            <p className="text-center text-xs text-gray-500">
              Already have a code? <a href="/" className="underline">Sign in</a>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
