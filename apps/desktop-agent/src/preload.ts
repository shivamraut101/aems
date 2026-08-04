import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aems", {
  acceptConsent: () => ipcRenderer.send("consent:accept"),
});
