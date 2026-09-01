import type { Config } from "tailwindcss";

const token = (name: string) =>
  "hsl(var(--" + name + ") / <alpha-value>)";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: token("background"),
        surface: token("surface"),
        "surface-muted": token("surface-muted"),
        border: token("border"),
        navy: token("foreground"),
        muted: token("muted-foreground"),
        primary: {
          DEFAULT: token("primary"),
          foreground: token("primary-foreground"),
        },
        focus: token("focus"),
        success: {
          foreground: token("success-foreground"),
          background: token("success-background"),
          border: token("success-border"),
        },
        warning: {
          foreground: token("warning-foreground"),
          background: token("warning-background"),
          border: token("warning-border"),
        },
        error: {
          foreground: token("error-foreground"),
          background: token("error-background"),
          border: token("error-border"),
        },
        rating: {
          again: {
            DEFAULT: token("rating-again-foreground"),
            foreground: token("rating-again-foreground"),
            background: token("rating-again-background"),
            border: token("rating-again-border"),
          },
          hard: {
            DEFAULT: token("rating-hard-foreground"),
            foreground: token("rating-hard-foreground"),
            background: token("rating-hard-background"),
            border: token("rating-hard-border"),
          },
          good: {
            DEFAULT: token("rating-good-foreground"),
            foreground: token("rating-good-foreground"),
            background: token("rating-good-background"),
            border: token("rating-good-border"),
          },
          easy: {
            DEFAULT: token("rating-easy-foreground"),
            foreground: token("rating-easy-foreground"),
            background: token("rating-easy-background"),
            border: token("rating-easy-border"),
          },
        },
      },
      boxShadow: {
        surface: "0 1rem 2.5rem hsl(var(--shadow) / 0.08)",
        card: "0 0.5rem 1.5rem hsl(var(--shadow) / 0.08)",
      },
      borderRadius: {
        surface: "1.25rem",
        card: "1rem",
      },
    },
  },
  plugins: [],
};

export default config;
