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
