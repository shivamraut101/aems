import { app } from "electron";
import { hasConsented } from "./config.js";
import { showConsentWindow } from "./consent-window.js";
import { createTray } from "./tray.js";
import { startTracking, stopTracking } from "./tracker.js";

app.whenReady().then(async () => {
  if (!hasConsented()) {
    await showConsentWindow();
  }

  createTray();
  startTracking();
});

app.on("window-all-closed", () => {
  // Agent lives in the tray; never quit when the consent window closes.
});

app.on("before-quit", () => {
  stopTracking();
});
