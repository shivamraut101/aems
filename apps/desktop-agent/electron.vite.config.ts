import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
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
