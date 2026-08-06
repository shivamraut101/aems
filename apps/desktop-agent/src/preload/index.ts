import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import { IPC_CHANNELS } from "../shared/types/index.js";
import type {
  AgentApi,
  AgentPermissions,
  AgentPolicy,
  AgentStatus,
  EnrollRequest,
  PermissionTarget,
} from "../shared/types/index.js";

/**
 * The whole bridge.
 *
 * `ipcRenderer` itself is never handed over — exposing it would let renderer code
 * (or anything injected into it) call any channel the main process registers,
 * including ones added later by someone who assumed the renderer was trusted.
 */
const api: AgentApi = {
  getStatus: (): Promise<AgentStatus> => ipcRenderer.invoke(IPC_CHANNELS.STATUS_GET),

  getPolicy: (): Promise<AgentPolicy | null> => ipcRenderer.invoke(IPC_CHANNELS.POLICY_GET),

  enroll: (request: EnrollRequest): Promise<AgentStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.ENROLL, request),

  acceptConsent: (): Promise<AgentStatus> => ipcRenderer.invoke(IPC_CHANNELS.CONSENT_ACCEPT),

  getPermissions: (): Promise<AgentPermissions> => ipcRenderer.invoke(IPC_CHANNELS.PERMISSIONS_GET),

  openPermissionSettings: (target: PermissionTarget): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PERMISSIONS_OPEN_SETTINGS, target),

  startBreak: (): Promise<AgentStatus> => ipcRenderer.invoke(IPC_CHANNELS.BREAK_START),

  endBreak: (): Promise<AgentStatus> => ipcRenderer.invoke(IPC_CHANNELS.BREAK_END),
  endDay: (): Promise<AgentStatus> => ipcRenderer.invoke(IPC_CHANNELS.DAY_END),
  startDay: (): Promise<AgentStatus> => ipcRenderer.invoke(IPC_CHANNELS.DAY_START),

  quit: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.QUIT),

  onStatusChanged: (listener: (status: AgentStatus) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, status: AgentStatus): void => listener(status);
    ipcRenderer.on(IPC_CHANNELS.STATUS_CHANGED, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.STATUS_CHANGED, handler);
    };
  },
};

contextBridge.exposeInMainWorld("aems", api);
