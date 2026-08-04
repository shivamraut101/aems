import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { store } from "./config.js";

/**
 * Blocking, always-on-top notice shown before any tracking starts. The agent
 * must not begin monitoring on a device until the employee explicitly accepts.
 */
export function showConsentWindow(): Promise<void> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 480,
      height: 420,
      resizable: false,
      alwaysOnTop: true,
      title: "AEMS Monitoring Notice",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    win.loadFile(path.join(__dirname, "..", "renderer", "consent.html"));

    ipcMain.once("consent:accept", () => {
      store.set("consentedAt", new Date().toISOString());
      win.close();
      resolve();
    });
  });
}
