import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import { themeColorUtilities, themePaletteVariables } from "./client/src/lib/themePalette";

export default {
  darkMode: ["class"],
  content: ["./client/index.html", "./client/src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        display: ["Barlow Condensed", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(23, 18, 31, 0.05), 0 4px 16px rgba(23, 18, 31, 0.04)",
        // Softer, purple-tinted shadows so legacy shadow-* classes match cards.
        sm: "0 1px 2px rgba(23, 18, 31, 0.05)",
        md: "0 1px 2px rgba(23, 18, 31, 0.05), 0 4px 16px rgba(23, 18, 31, 0.05)",
        lg: "0 2px 4px rgba(23, 18, 31, 0.05), 0 10px 28px rgba(23, 18, 31, 0.08)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      colors: {
        // The Matchday palette, applied app-wide: Tailwind's grays become cool,
        // faintly purple neutrals and its blues become the brand violet, so the
        // many pages styled with gray-*/blue-* utilities match the theme without
        // restyling each one by hand. Every shade (these and the status colours
        // the pages use) reads a CSS variable, and dark mode flips the scale —
        // see themePalette below — so a light tint becomes a dark one and dark
        // text becomes light, without a dark: variant on every class.
        ...themeColorUtilities,
        background: "hsl(var(--background))",
        header: "hsl(var(--header))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        chart: {
          "1": "hsl(var(--chart-1))",
          "2": "hsl(var(--chart-2))",
          "3": "hsl(var(--chart-3))",
          "4": "hsl(var(--chart-4))",
          "5": "hsl(var(--chart-5))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    require("@tailwindcss/typography"),
    // Light values on :root, flipped values under .dark (see themePalette.ts).
    plugin(({ addBase }) => addBase(themePaletteVariables())),
  ],
} satisfies Config;
