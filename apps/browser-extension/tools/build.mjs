/**
 * Builds the loadable extension into `dist/`.
 *
 * Three steps, no bundler: `tsc` emits ES modules (MV3 service workers accept
 * `"type": "module"`, so nothing needs bundling), the static pages are copied, and the
 * manifest is serialised from `src/manifest.ts` — which is the only place a permission
 * can be added, and the only place one carries its justification.
 *
 * Deliberately dependency-free. A build step for two pages and one worker that pulled
 * in a bundler would be more moving parts than the thing it builds.
 */

import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

/** The TypeScript compiler entry point, resolved through this package's own dependency. */
function tscPath() {
  return createRequire(import.meta.url).resolve("typescript/bin/tsc");
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  // `tsconfig.build.json` is `tsconfig.json` minus the unit tests, so `pnpm typecheck`
  // still covers them and the extension a browser loads does not contain them.
  //
  // The compiler is run as a script under this same Node rather than through the `.bin`
  // shim, so there is no shell on either platform — `node` and a resolved path behave
  // identically on Windows and macOS, and nothing here is ever concatenated into a
  // command line.
  const compiled = spawnSync(process.execPath, [tscPath(), "-p", "tsconfig.build.json"], {
    cwd: root,
    stdio: "inherit",
  });

  if (compiled.status !== 0) {
    process.exitCode = compiled.status ?? 1;
    return;
  }

  await cp(join(root, "public"), dist, { recursive: true });

  // Imported from the build output rather than parsed out of the source, so the JSON
  // Chrome reads is produced by the same module the type checker validated.
  const { manifest } = await import(pathToFileURL(join(dist, "manifest.js")).href);
  await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const entries = await readdir(dist);
  console.log(`browser-extension: dist/ contains ${entries.length} entries`);
  console.log(`browser-extension: load ${dist} at chrome://extensions with Developer mode on`);
}

await main();
