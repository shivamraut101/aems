import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Renderer component tests are .tsx and opt into jsdom with a per-file
    // `@vitest-environment` docblock, so the main-process suite keeps running in
    // plain Node — a DOM under the OS readers would hide a Node-only mistake.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
  resolve: {
    // Source files use Node-style ".js" specifiers so the tsc build emits valid ESM.
    // Vitest reads the TypeScript directly, so it needs the mapping back. The
    // extension is dropped rather than rewritten to ".ts" so that Vite's own
    // resolution picks up ".tsx" components too.
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" }],
  },
});
