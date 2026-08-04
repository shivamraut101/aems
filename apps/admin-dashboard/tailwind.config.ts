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
      colors: {
        success: "hsl(var(--success))",
        warning: "hsl(var(--warning))",
      },
    },
  },
} satisfies Config;
