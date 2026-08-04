import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Tauri drives this dev server; the port must match devUrl in tauri.conf.json.
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", target: "esnext" },
});
