import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src");

/** Windows hands back backslashes; Vite speaks forward slashes. Compare in one form. */
const normalise = (p: string): string => p.replace(/\\/g, "/");

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  plugins: [
    {
      // Source files use Node-style ".js" specifiers so the tsc build emits valid ESM.
      // Vitest reads the TypeScript directly, so the mapping has to be undone.
      //
      // A blanket `resolve.alias` regex — what the other packages use — cannot work
      // here: this package imports BUILT workspace dependencies, and the alias rewrote
      // `./categorize.js` inside `packages/analytics/dist/index.js` to a `.ts` that has
      // never existed there. Keyed on the importer instead, so only our own sources are
      // rewritten and every dependency keeps resolving its real emitted files.
      name: "aems-api-js-specifier",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer === undefined) return null;
        if (!source.startsWith(".") || !source.endsWith(".js")) return null;
        if (!normalise(importer).startsWith(normalise(SRC))) return null;

        const candidate = path.resolve(path.dirname(importer), `${source.slice(0, -3)}.ts`);
        return fs.existsSync(candidate) ? candidate : null;
      },
    },
  ],
});
