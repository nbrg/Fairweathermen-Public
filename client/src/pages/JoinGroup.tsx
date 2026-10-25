import { useEffect, useState, type FormEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

// Public page (/join/:token) — a player follows an invite link, enters their
// name, and gets their personal login code (and is signed straight in).
export default function JoinGroup({ token }: { token: string }) {
  const [groupName, setGroupName] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loginCode, setLoginCode] = useState<string | null>(null);
  // True when the joiner was already signed in, so the group was added to their
  // existing login (same code) rather than giving them a new one.
  const [linked, setLinked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/group/invite/${encodeURIComponent(token)}`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setLoadError(data?.error || "This invite link is invalid or has expired.");
        else setGroupName(data?.name ?? "the group");
      } catch {
        if (!cancelled) setLoadError("Network error — please try again.");
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/group/join/${encodeURIComponent(token)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || `Couldn't join (${res.status})`);
        return;
      }
      setLoginCode(data.code);
      setLinked(!!data.linked);
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (checking) {
    return <div className="min-h-screen bg-gray-100" />;
  }

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-xl">Invite not found</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600">{loadError}</p>
            <Button className="w-full mt-4" onClick={() => (window.location.href = "/")}>
              Go to sign in
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loginCode) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-xl">You're in 🎉</CardTitle>
            <p className="text-sm text-gray-500 mt-1">
              {linked
                ? `${groupName} is now on your account — same login code as before.`
                : "Save your personal login code."}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs text-gray-500">Your login code</Label>
              <div className="mt-1 font-mono text-lg font-bold tracking-wide bg-gray-100 rounded-md px-3 py-2 select-all">
                {loginCode}
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Use this to sign in next time. Keep it private — it's yours.
              </p>
            </div>
            <Button className="w-full" onClick={() => (window.location.href = "/")}>
              Enter {groupName}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Join {groupName}</CardTitle>
          <p className="text-sm text-gray-500 mt-1">Enter your name to join and get your login code.</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              maxLength={40}
              autoComplete="off"
              disabled={submitting}
            />
            {error && <div className="text-xs text-red-600">{error}</div>}
            <Button type="submit" className="w-full" disabled={submitting || !name.trim()}>
              {submitting ? "Joining…" : "Join"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
