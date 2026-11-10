// The colour scales behind Tailwind's gray-*, blue-*, red-*, green-* … classes.
//
// Each shade is a CSS variable (`--tw-c-green-100` = "220 252 231"), so one
// class works in both themes: light mode uses the scale as is, and dark mode
// (the `.dark` class on <html>, set by next-themes) flips it, so a pale tint
// (bg-green-50) becomes a deep one and dark text (text-green-700) becomes a
// light one. The flip is shifted one step towards the middle at the dark end,
// so a strong fill with white text (bg-green-600 text-white) stays readable.
//
// gray and blue are the Matchday neutrals and brand violet; the rest are
// Tailwind's defaults. Imported by tailwind.config.ts only (no runtime cost).

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
type Shade = (typeof SHADES)[number];
type Scale = Record<Shade, string>;

const SCALES: Record<string, Scale> = {
  gray: { 50: "#F8F7FB", 100: "#F1EFF5", 200: "#E7E5EE", 300: "#DCD9E4", 400: "#A8A3B3", 500: "#6E6879", 600: "#57515F", 700: "#423D4A", 800: "#2C2833", 900: "#1B1722", 950: "#100D15" },
  blue: { 50: "#F4F0FD", 100: "#EAE2FB", 200: "#D6C8F6", 300: "#B9A2EE", 400: "#9775E2", 500: "#7A4FD3", 600: "#6538BD", 700: "#522D9B", 800: "#42257C", 900: "#2E1A57", 950: "#1E1139" },
  red: { 50: "#fef2f2", 100: "#fee2e2", 200: "#fecaca", 300: "#fca5a5", 400: "#f87171", 500: "#ef4444", 600: "#dc2626", 700: "#b91c1c", 800: "#991b1b", 900: "#7f1d1d", 950: "#450a0a" },
  orange: { 50: "#fff7ed", 100: "#ffedd5", 200: "#fed7aa", 300: "#fdba74", 400: "#fb923c", 500: "#f97316", 600: "#ea580c", 700: "#c2410c", 800: "#9a3412", 900: "#7c2d12", 950: "#431407" },
  amber: { 50: "#fffbeb", 100: "#fef3c7", 200: "#fde68a", 300: "#fcd34d", 400: "#fbbf24", 500: "#f59e0b", 600: "#d97706", 700: "#b45309", 800: "#92400e", 900: "#78350f", 950: "#451a03" },
  yellow: { 50: "#fefce8", 100: "#fef9c3", 200: "#fef08a", 300: "#fde047", 400: "#facc15", 500: "#eab308", 600: "#ca8a04", 700: "#a16207", 800: "#854d0e", 900: "#713f12", 950: "#422006" },
  lime: { 50: "#f7fee7", 100: "#ecfccb", 200: "#d9f99d", 300: "#bef264", 400: "#a3e635", 500: "#84cc16", 600: "#65a30d", 700: "#4d7c0f", 800: "#3f6212", 900: "#365314", 950: "#1a2e05" },
  green: { 50: "#f0fdf4", 100: "#dcfce7", 200: "#bbf7d0", 300: "#86efac", 400: "#4ade80", 500: "#22c55e", 600: "#16a34a", 700: "#15803d", 800: "#166534", 900: "#14532d", 950: "#052e16" },
  emerald: { 50: "#ecfdf5", 100: "#d1fae5", 200: "#a7f3d0", 300: "#6ee7b7", 400: "#34d399", 500: "#10b981", 600: "#059669", 700: "#047857", 800: "#065f46", 900: "#064e3b", 950: "#022c22" },
  sky: { 50: "#f0f9ff", 100: "#e0f2fe", 200: "#bae6fd", 300: "#7dd3fc", 400: "#38bdf8", 500: "#0ea5e9", 600: "#0284c7", 700: "#0369a1", 800: "#075985", 900: "#0c4a6e", 950: "#082f49" },
  indigo: { 50: "#eef2ff", 100: "#e0e7ff", 200: "#c7d2fe", 300: "#a5b4fc", 400: "#818cf8", 500: "#6366f1", 600: "#4f46e5", 700: "#4338ca", 800: "#3730a3", 900: "#312e81", 950: "#1e1b4b" },
  violet: { 50: "#f5f3ff", 100: "#ede9fe", 200: "#ddd6fe", 300: "#c4b5fd", 400: "#a78bfa", 500: "#8b5cf6", 600: "#7c3aed", 700: "#6d28d9", 800: "#5b21b6", 900: "#4c1d95", 950: "#2e1065" },
  purple: { 50: "#faf5ff", 100: "#f3e8ff", 200: "#e9d5ff", 300: "#d8b4fe", 400: "#c084fc", 500: "#a855f7", 600: "#9333ea", 700: "#7e22ce", 800: "#6b21a8", 900: "#581c87", 950: "#3b0764" },
  rose: { 50: "#fff1f2", 100: "#ffe4e6", 200: "#fecdd3", 300: "#fda4af", 400: "#fb7185", 500: "#f43f5e", 600: "#e11d48", 700: "#be123c", 800: "#9f1239", 900: "#881337", 950: "#4c0519" },
};

// Which light shade each shade shows in dark mode.
const DARK_SHADE: Record<Shade, Shade> = {
  50: 950, 100: 900, 200: 800, 300: 700, 400: 600,
  500: 500,
  600: 500, 700: 400, 800: 300, 900: 200, 950: 100,
};
// Neutrals flip fully, so gray-900 text becomes near-white.
const DARK_NEUTRAL: Record<Shade, Shade> = {
  50: 950, 100: 900, 200: 800, 300: 700, 400: 600,
  500: 400,
  600: 400, 700: 300, 800: 200, 900: 100, 950: 50,
};

const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");

export const themeColorUtilities: Record<string, Record<string, string>> =
  Object.fromEntries(
    Object.keys(SCALES).map((name) => [
      name,
      Object.fromEntries(
        SHADES.map((s) => [s, `rgb(var(--tw-c-${name}-${s}) / <alpha-value>)`]),
      ),
    ]),
  );

export function themePaletteVariables(): Record<string, Record<string, string>> {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const [name, scale] of Object.entries(SCALES)) {
    const flip = name === "gray" ? DARK_NEUTRAL : DARK_SHADE;
    for (const s of SHADES) {
      light[`--tw-c-${name}-${s}`] = rgb(scale[s]);
      dark[`--tw-c-${name}-${s}`] = rgb(scale[flip[s]]);
    }
  }
  return { ":root": light, ".dark": dark };
}
