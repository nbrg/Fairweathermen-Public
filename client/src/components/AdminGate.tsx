// Simple admin-password gate for the activity/audit views. Mirrors the other
// admin pages: the key is stored in localStorage ("adminApiKey") and sent as the
// x-api-key header. This only hides the UI — the server independently enforces
// the key on every request.
export function AdminGate({
  apiKey,
  setApiKey,
  onSubmit,
  title,
  error,
}: {
  apiKey: string;
  setApiKey: (v: string) => void;
  onSubmit: () => void;
  title: string;
  error?: string | null;
}) {
  const submit = () => {
    localStorage.setItem("adminApiKey", apiKey);
    onSubmit();
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border bg-white p-6 shadow-sm">
        <h1 className="text-lg font-bold text-primary">{title}</h1>
        <p className="mt-1 text-sm text-gray-600">Enter the admin password to view this.</p>
        <input
          type="password"
          placeholder="Admin password"
          value={apiKey}
          autoFocus
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && apiKey && submit()}
          className="mt-3 w-full rounded-md border px-3 py-2 text-sm"
        />
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <button
          onClick={submit}
          disabled={!apiKey}
          className="mt-3 w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          View
        </button>
      </div>
    </div>
  );
}
