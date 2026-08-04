import { Tray, Menu, app } from "electron";
import path from "node:path";

let tray: Tray | null = null;

/** Persistent, visible indicator that monitoring is active on this device. */
export function createTray() {
  tray = new Tray(path.join(__dirname, "..", "..", "assets", "tray-icon.png"));
  tray.setToolTip("AEMS Agent - monitoring active");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "AEMS Agent - monitoring active", enabled: false },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  return tray;
}
