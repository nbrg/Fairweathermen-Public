import { ChevronDown } from "lucide-react";

export type GroupOption = { id: number | null; name: string };

// A compact dropdown of group tickboxes (native <details>, so it closes on
// outside interaction without extra JS). Defaults are managed by the parent;
// "All"/"None" quick-toggles are built in. `null` id = ungrouped/pre-login.
export function GroupMultiSelect({
  options,
  selected,
  onChange,
}: {
  options: GroupOption[];
  selected: Set<number | null>;
  onChange: (next: Set<number | null>) => void;
}) {
  const allSelected = options.length > 0 && options.every((o) => selected.has(o.id));
  const label = allSelected
    ? "All groups"
    : selected.size === 0
      ? "No groups"
      : `${selected.size} group${selected.size === 1 ? "" : "s"}`;

  const toggle = (id: number | null) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md border bg-white px-3 py-2 text-sm text-gray-800">
        {label}
        <ChevronDown className="h-4 w-4 text-gray-400" />
      </summary>
      {/* Anchor to the same side the control sits on: left on mobile (where it
          wraps under the heading), right on wider screens. Clamp to the
          viewport so it never opens off-screen. */}
      <div className="absolute left-0 z-30 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-md border bg-white p-2 shadow-lg sm:left-auto sm:right-0">
        <div className="mb-1 flex gap-2 border-b pb-1 text-xs">
          <button
            type="button"
            className="rounded px-2 py-0.5 text-primary hover:bg-gray-100"
            onClick={() => onChange(new Set(options.map((o) => o.id)))}
          >
            All
          </button>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-gray-600 hover:bg-gray-100"
            onClick={() => onChange(new Set())}
          >
            None
          </button>
        </div>
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {options.map((o) => (
            <label
              key={String(o.id)}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-gray-50"
            >
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={selected.has(o.id)}
                onChange={() => toggle(o.id)}
              />
              {o.name}
            </label>
          ))}
        </div>
      </div>
    </details>
  );
}
