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
  /*
   * The dashboard's tsconfig sets `jsx: "preserve"` — Next compiles JSX itself, with
   * the automatic runtime. Vitest's esbuild sees `preserve`, falls back to the
   * *classic* transform, and emits bare `React.createElement(...)` into every
   * component it loads, including components that quite correctly do not import
   * React. Every such test then had to publish React as a global before a dynamic
   * import, which is a trap the next person writing one falls into with a
   * `ReferenceError: React is not defined` and no clue why.
   *
   * Saying `automatic` here matches what Next actually does and spares every test the
   * ritual. `app-shell.test.tsx` documented this as the tidier fix and left it as out
   * of scope; it is in scope now.
   */
  esbuild: { jsx: "automatic" },
  resolve: {
    // Mirrors the `@/*` path in tsconfig.json. Vitest does not read tsconfig paths,
    // so without this every test would have to use a relative import.
    alias: { "@": path.resolve(dirname, "src") },
  },
});
