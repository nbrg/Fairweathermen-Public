import { useState, type FormEvent } from "react";
import { useGroup } from "@/contexts/GroupContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// Shown when nobody has a valid session cookie set. Single text input takes
// the user's personal access code and POSTs it to /api/group/login. The code
// identifies the user, which selects their group + enabled games. On success
// the GroupProvider's state flips and the regular app renders.
export default function GroupGate() {
  const { login } = useGroup();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setSubmitting(true);
    setError(null);
    const result = await login(code.trim().toLowerCase());
    setSubmitting(false);
    if (!result.ok) setError(result.error);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Fairweathermen</CardTitle>
          <p className="text-sm text-gray-500 mt-1">Enter your personal code to continue.</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <Input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Your code"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
            {error && (
              <div className="text-xs text-red-600">{error}</div>
            )}
            <Button type="submit" disabled={submitting || !code.trim()} className="w-full">
              {submitting ? "Checking…" : "Enter"}
            </Button>
            <p className="text-center text-xs text-gray-500">
              No code yet? <a href="/create" className="underline">Create your own group</a>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
