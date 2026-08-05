import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Node by default so a missing-DOM mistake in a pure module is caught rather
    // than papered over. A component test opts in with a
    // `// @vitest-environment jsdom` docblock at the top of its own file.
    environment: "node",
  },
  resolve: {
    // Mirrors the `@/*` path in tsconfig.json. Vitest does not read tsconfig paths,
    // so without this every test would have to use a relative import.
    alias: { "@": path.resolve(dirname, "src") },
  },
});
