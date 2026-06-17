import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

/**
 * Delta design system → Tailwind. Colors reference CSS variables defined in
 * src/styles/globals.css (OKLCH). Never hardcode hex in components.
 *
 * Each token is wrapped in OKLCH relative-color form so Tailwind can inject the
 * `<alpha-value>` placeholder — this makes opacity modifiers (e.g.
 * `text-primary-foreground/20`, `bg-success/10`, `ring-ring/30`) actually work.
 * Without this, our bare `var(--x)` colors resolve to full oklch() values that
 * have no alpha slot, so /opacity modifiers are silently dropped.
 */
const alpha = (cssVar: string) => `oklch(from ${cssVar} l c h / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: alpha("var(--background)"),
        surface: alpha("var(--surface)"),
        "surface-muted": alpha("var(--surface-muted)"),
        border: alpha("var(--border)"),
        "border-strong": alpha("var(--border-strong)"),
        ring: alpha("var(--ring)"),
        foreground: {
          DEFAULT: alpha("var(--foreground)"),
          muted: alpha("var(--foreground-muted)"),
          subtle: alpha("var(--foreground-subtle)"),
        },
        primary: {
          DEFAULT: alpha("var(--primary)"),
          foreground: alpha("var(--primary-foreground)"),
          50: alpha("var(--primary-50)"),
          100: alpha("var(--primary-100)"),
          500: alpha("var(--primary-500)"),
          600: alpha("var(--primary-600)"),
          700: alpha("var(--primary-700)"),
        },
        success: alpha("var(--success-600)"),
        warning: alpha("var(--warning-600)"),
        danger: alpha("var(--danger-600)"),
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
