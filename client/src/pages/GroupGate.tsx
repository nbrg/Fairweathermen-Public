import { useState, type FormEvent } from "react";
import { useGroup } from "@/contexts/GroupContext";
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
    <div className="flex min-h-screen min-h-[100dvh] flex-col bg-primary px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 py-8">
        <div>
          <img
            src="/icons/logo.webp"
            alt=""
            aria-hidden
            width={112}
            height={112}
            className="h-28 w-28 shadow-lg shadow-black/30 rounded-[22px]"
          />
          <h1 className="font-display mt-6 text-[44px] font-bold leading-none">Fairweathermen</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-white/70">Enter your personal code to continue.</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-3">
          <label htmlFor="gate-code" className="block text-[13px] font-semibold text-white/80">
            Your personal code
          </label>
          <Input
            id="gate-code"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Your code"
            autoComplete="off"
            spellCheck={false}
            disabled={submitting}
            className="h-[52px] rounded-[14px] border-white/20 bg-white/[0.08] px-4 text-[17px] text-white placeholder:text-white/40 focus-visible:ring-secondary focus-visible:ring-offset-0"
          />
          {error && <div className="text-sm text-red-300">{error}</div>}
          <Button
            type="submit"
            disabled={submitting || !code.trim()}
            className="h-[52px] w-full rounded-[14px] bg-secondary text-base font-bold text-primary hover:bg-secondary/90 disabled:bg-white/15 disabled:text-white/60 disabled:opacity-100"
          >
            {submitting ? "Checking…" : "Enter"}
          </Button>
        </form>
        <p className="text-center text-sm text-white/70">
          No code yet?{" "}
          <a href="/create" className="font-semibold text-secondary underline-offset-4 hover:underline">
            Create your own group
          </a>
        </p>
      </div>
    </div>
  );
}
