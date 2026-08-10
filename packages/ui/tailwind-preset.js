/**
 * Shared Tailwind preset — the shadcn/ui token layer.
 *
 * Every surface that renders @aems/ui components must extend this, or the
 * components will reference CSS variables (bg-primary, text-muted-foreground, …)
 * that resolve to nothing and render unstyled.
 */

/** @type {import("tailwindcss").Config} */
// `export default`, not `module.exports`. This package is `"type": "module"`, so the
// CommonJS form was always a mismatch — webpack tolerated it, and Next 16's Turbopack
// (now the default builder) does not: "Export default doesn't exist in target module".
export default {
  darkMode: ["class"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
          muted: "hsl(var(--destructive-muted))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
          /* The tinted ground an AI surface sits on. Indigo is reserved for model
             output, so its tint is too — never spend it on a normal panel. */
          muted: "hsl(var(--accent-muted))",
        },
        /*
         * Status, as first-class colours rather than the Tailwind palette.
         *
         * Screens were reaching for `emerald-600` and `amber-50` directly, which put
         * two greens on one page and left dark mode with tints designed for white.
         * Routing them through the tokens means both themes are tuned in one file.
         */
        success: {
          DEFAULT: "hsl(var(--success))",
          muted: "hsl(var(--success-muted))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          muted: "hsl(var(--warning-muted))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      /*
       * Motion.
       *
       * `tailwindcss-animate` is deliberately not a dependency: it would be a second
       * animation vocabulary next to the one below, and docs/design.md asks for
       * restraint rather than a library of effects. These are the only movements the
       * product makes — a fade for anything that appears in place, a slide for the
       * mobile drawer, which has to read as "coming from the edge" or it looks like a
       * panel that teleported.
       *
       * Durations are short on purpose. Every consumer pairs these with
       * `motion-reduce:animate-none`, and the dashboard's globals.css additionally
       * collapses all animation under `prefers-reduced-motion: reduce`.
       */
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "fade-out": { from: { opacity: "1" }, to: { opacity: "0" } },
        "slide-in-left": {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(0)" },
        },
        "slide-out-left": {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(-100%)" },
        },
        "slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        "slide-out-right": {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(100%)" },
        },
        "slide-in-top": {
          from: { transform: "translateY(-100%)" },
          to: { transform: "translateY(0)" },
        },
        "slide-out-top": {
          from: { transform: "translateY(0)" },
          to: { transform: "translateY(-100%)" },
        },
        "slide-in-bottom": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
        "slide-out-bottom": {
          from: { transform: "translateY(0)" },
          to: { transform: "translateY(100%)" },
        },
        "skeleton-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
      },
      animation: {
        "fade-in": "fade-in 150ms ease-out",
        "fade-out": "fade-out 120ms ease-in",
        "slide-in-left": "slide-in-left 220ms cubic-bezier(0.32, 0.72, 0, 1)",
        "slide-out-left": "slide-out-left 180ms cubic-bezier(0.32, 0.72, 0, 1)",
        "slide-in-right": "slide-in-right 220ms cubic-bezier(0.32, 0.72, 0, 1)",
        "slide-out-right": "slide-out-right 180ms cubic-bezier(0.32, 0.72, 0, 1)",
        "slide-in-top": "slide-in-top 220ms cubic-bezier(0.32, 0.72, 0, 1)",
        "slide-out-top": "slide-out-top 180ms cubic-bezier(0.32, 0.72, 0, 1)",
        "slide-in-bottom": "slide-in-bottom 220ms cubic-bezier(0.32, 0.72, 0, 1)",
        "slide-out-bottom": "slide-out-bottom 180ms cubic-bezier(0.32, 0.72, 0, 1)",
        "skeleton-pulse": "skeleton-pulse 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
