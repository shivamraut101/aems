import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

/**
 * Where the packaged agent will look for the API.
 *
 * Baked in here because there is nowhere else it can come from. A packaged Electron app
 * launched from the Start Menu inherits no environment, the login screen asks only for
 * an enrolment code, and the stored `apiUrl` in `agent-config.json` only exists after a
 * first run that already knew the answer. Without this, every installer ever built
 * points at `http://localhost:3001` — the employee's own laptop — and can never reach
 * anything.
 *
 * Read at BUILD time, from the shell running the build, and frozen into the bundle. One
 * URL per client is the right granularity for a white-label product: the installer given
 * to Acme is an Acme installer.
 *
 * `pnpm build` with nothing set still yields localhost, which is what a developer wants
 * and what every existing test expects.
 */
const BUILD_TIME_API_URL = process.env.AEMS_API_URL?.trim() || "";

export default defineConfig({
  main: {
    define: {
      // A string literal, not a value: `define` performs textual substitution, so the
      // replacement has to be valid source on its own.
      __AEMS_BUILD_API_URL__: JSON.stringify(BUILD_TIME_API_URL),
    },
    // get-windows resolves its macOS Swift binary and its Windows node-pre-gyp
    // binding from its own file location, so bundling it breaks both platforms —
    // it and electron-updater stay external. The workspace packages are the
    // opposite case: bundling them keeps pnpm's symlinked node_modules out of the
    // packaging step entirely.
    plugins: [externalizeDepsPlugin({ exclude: ["@aems/sdk", "@aems/types"] })],
    build: {
      rollupOptions: {
        // TWO main entries, and the second one is not optional.
        //
        // `bridge.js` is the Chrome native messaging host. It is a separate entry
        // because the launcher runs it with ELECTRON_RUN_AS_NODE=1 — the only mode in
        // which the Electron binary produces a byte-clean stdout on Windows, where
        // Chromium's startup otherwise writes a stray CRLF that desynchronises the
        // native messaging wire from its first frame. In that mode `require("electron")`
        // returns a string rather than the module, so the host must not link
        // `index.ts`'s `import { app, ... } from "electron"` at all.
        //
        // See the header of `src/main/bridge-main.ts` for the measurement.
        input: {
          index: "src/main/index.ts",
          bridge: "src/main/bridge-main.ts",
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@aems/sdk", "@aems/types"] })],
    build: {
      rollupOptions: {
        // A sandboxed preload cannot be ESM, and this package is "type": "module" —
        // so the bundle has to be CommonJS and carry a .cjs extension for Node to
        // agree with it.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
