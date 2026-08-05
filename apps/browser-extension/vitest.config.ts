import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    // Source files use Node-style ".js" specifiers so tsc emits ES modules a browser can
    // actually load. Vitest reads the TypeScript directly, so it needs the mapping back.
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" }],
  },
});
