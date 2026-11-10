import { useEffect, type ReactNode } from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { trackUiEvent } from "@/lib/track";

// Light / Dark / Auto. "system" (Auto) follows the phone's own setting and is
// where everyone starts. The choice is per device (localStorage `fwm-theme`);
// next-themes sets class="dark" on <html> before first paint.
export type ThemeChoice = "light" | "dark" | "system";
export const THEME_STORAGE_KEY = "fwm-theme";

// The browser/PWA chrome colour, matching the header in each theme.
const THEME_COLOR = { light: "#0b1e46", dark: "#120b1c" } as const;

function ThemeColorMeta() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    const color = resolvedTheme === "dark" ? THEME_COLOR.dark : THEME_COLOR.light;
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", color));
  }, [resolvedTheme]);
  return null;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey={THEME_STORAGE_KEY}
      disableTransitionOnChange
    >
      <ThemeColorMeta />
      {children}
    </NextThemesProvider>
  );
}

export function useThemeChoice(): [ThemeChoice, (t: ThemeChoice) => void] {
  const { theme, setTheme } = useTheme();
  const choice: ThemeChoice = theme === "light" || theme === "dark" ? theme : "system";
  // Logged for /admin/audit (it's a per-device setting, so the server never sees it otherwise).
  const label = { light: "Light", dark: "Dark", system: "Auto" } as const;
  const set = (t: ThemeChoice) => {
    if (t !== choice) trackUiEvent("setting_changed", { setting: "theme", from: label[choice], to: label[t] });
    setTheme(t);
  };
  return [choice, set];
}
