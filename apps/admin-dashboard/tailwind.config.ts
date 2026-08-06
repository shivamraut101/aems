import type { Config } from "tailwindcss";

import preset from "@aems/ui/tailwind-preset";

export default {
  presets: [preset as Config],
  darkMode: ["class"],
  content: [
    "./src/**/*.{ts,tsx}",
    // Shared components ship compiled, so their class names live in dist.
    "../../packages/ui/dist/**/*.js",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      /*
       * `colors` is deliberately absent.
       *
       * It used to restate `success: "hsl(var(--success))"` and the same for warning,
       * which looked redundant and was worse than redundant: a flat string does not
       * merge into the preset's `{ DEFAULT, muted }` object, it *replaces* it. So
       * `bg-success-muted` and `bg-warning-muted` compiled to nothing in this app, and
       * every `Badge` with variant success, warning or online rendered as coloured text
       * on a transparent ground — the tinted pill the token layer exists to give them
       * was missing everywhere in the dashboard. The preset already declares both
       * colours with the same DEFAULT; inheriting it is what keeps the muted halves.
       */
    },
  },
} satisfies Config;
