import { createRequire } from "node:module";
import { join } from "node:path";

import { AemsClient } from "@aems/sdk";
import type { AgentPolicy } from "@aems/types";
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  powerMonitor,
  shell,
  systemPreferences,
} from "electron";
import type { AppUpdater } from "electron-updater";

import { emptyTotals, IPC_CHANNELS, mayCollect, statusOf } from "../shared/types/index.js";
import type {
  AgentPermissions,
  AgentStatus,
  EnrollRequest,
  PermissionTarget,
} from "../shared/types/index.js";
import { Collector } from "./collector.js";
import { ConfigStore } from "./config.js";
import { collectDeviceFacts, collectInstalledApplications } from "./device.js";
import { IdleWatcher, setSystemIdleSource } from "./idle.js";
import { ElectronCapturer, ScreenshotScheduler } from "./screenshot.js";
import { SessionManager } from "./session.js";
import { SyncQueue } from "./sync.js";
import { Tracker } from "./tracker.js";

// electron-updater is CommonJS. A named ESM import of it depends on cjs-module-lexer
// picking up its getter-style exports, which is not something to bet a release on.
const requireCjs = createRequire(import.meta.url);

interface Runtime {
  store: ConfigStore;
  client: AemsClient;
  tracker: Tracker;
  idle: IdleWatcher;
  screenshots: ScreenshotScheduler;
  /** All three need a device id, so they only exist once the machine is enrolled. */
  queue: SyncQueue | null;
  sessions: SessionManager | null;
  collector: Collector | null;
}

let runtime: Runtime | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

/** Set only by the tray's Quit item, so every other close path hides instead. */
let quitting = false;

/**
 * The employee's Supabase access token, held between enrolment and consent.
 *
 * Both of those routes authenticate as the user rather than the device, and the
 * token is never written to disk — it is dropped the moment consent is recorded.
 */
let accessToken: string | null = null;

function requireRuntime(): Runtime {
  if (runtime === null) throw new Error("Agent runtime is not initialised");
  return runtime;
}

// -- status ---------------------------------------------------------------

function readPermissions(): AgentPermissions {
  if (process.platform !== "darwin") {
    // Windows gates neither screen capture nor window titles, and has no
    // accessibility equivalent to ask for.
    return { screenRecording: "not-required", accessibility: "not-required" };
  }

  return {
    screenRecording: systemPreferences.getMediaAccessStatus("screen"),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied",
  };
}

function currentStatus(): AgentStatus {
  const rt = requireRuntime();

  return statusOf(rt.store.current, {
    workSessionId: rt.sessions?.current ?? null,
    pendingEvents: rt.queue?.pending ?? 0,
    lastSyncAt: rt.queue?.lastSyncAt ?? null,
    permissions: readPermissions(),
    totals: rt.collector?.dayTotals ?? emptyTotals(),
    onBreak: rt.collector?.onBreak ?? false,
  });
}

/** Recomputes status, repaints the tray, and pushes it to the renderer. */
function publishStatus(): AgentStatus {
  const status = currentStatus();
  updateTray(status);
  mainWindow?.webContents.send(IPC_CHANNELS.STATUS_CHANGED, status);
  return status;
}

// -- tray -----------------------------------------------------------------

function trayTooltip(status: AgentStatus): string {
  if (status.revoked) return "AEMS — this device has been revoked by an administrator";
  if (!status.enrolled) return "AEMS — not signed in";
  if (status.consentRequired) return "AEMS — consent required, nothing is being collected";
  if (status.onBreak) return "AEMS — on a break, nothing is being collected";
  return "AEMS — monitoring active";
}

function updateTray(status: AgentStatus): void {
  if (tray === null) return;

  // The tooltip is the compliance signal. Claiming monitoring is active while it is
  // paused is the same failure as collecting silently, just inverted.
  tray.setToolTip(trayTooltip(status));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayTooltip(status), enabled: false },
      { type: "separator" },
      { label: "Open AEMS Agent", click: showWindow },
      // Reachable without opening the window, because a break is declared at the
      // moment somebody stands up rather than after they have found a window.
      {
        label: status.onBreak ? "End break" : "Start a break",
        enabled: status.collecting || status.onBreak,
        click: () => {
          toggleBreak(status.onBreak);
        },
      },
      { type: "separator" },
      {
        label: "Quit AEMS Agent",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray(): void {
  // Packaged or not, resources/ sits at the app root, and nativeImage reads through
  // the asar.
  tray = new Tray(nativeImage.createFromPath(join(app.getAppPath(), "resources", "tray.png")));
  tray.on("click", showWindow);
}

// -- window ---------------------------------------------------------------

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 460,
    height: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0F172A",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // A login-item launch opens the agent without stealing focus from whatever the
  // employee is actually doing.
  window.on("ready-to-show", () => {
    if (!process.argv.includes("--hidden")) window.show();
  });

  // Closing the window must not stop collection or quit the agent — it lives in the
  // tray, and leaving is a deliberate act from there.
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" as const }));

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServer !== undefined && devServer.length > 0) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }

  return window;
}

function showWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }

  mainWindow.show();
  mainWindow.focus();
}

// -- IPC ------------------------------------------------------------------

const SETTINGS_PANES: Record<PermissionTarget, string> = {
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

/** Rebuilds the collaborators that need a device id, and swaps the client onto device auth. */
function attachDevice(deviceId: string, deviceToken: string): void {
  const rt = requireRuntime();

  rt.collector?.stop();
  rt.client.setAuth({ kind: "device", token: deviceToken });

  const queue = new SyncQueue(rt.client, deviceId, {
    onOverflow: (dropped, kind) => {
      console.error(`[aems] dropped ${dropped} buffered ${kind} events to stay within memory`);
    },
  });

  rt.queue = queue;
  rt.sessions = new SessionManager(rt.client, deviceId);
  rt.collector = new Collector(
    {
      config: rt.store,
      queue,
      sessions: rt.sessions,
      tracker: rt.tracker,
      idle: rt.idle,
      screenshots: rt.screenshots,
    },
    // Every state the loop reaches — a clock-in, a stop signal, a break — has to
    // reach the tray and the renderer, or the agent would be collecting invisibly.
    { onChanged: () => void publishStatus() },
  );

  rt.collector.start();
}

function toggleBreak(onBreak: boolean): void {
  const collector = runtime?.collector;
  if (!collector) return;

  if (onBreak) collector.endBreak();
  else collector.startBreak();
}

/**
 * Sends the installed-application inventory (scope §7).
 *
 * Gated on consent like everything else, and deliberately not on the collection
 * timer: it is a cold path that shells out to `reg`/`plutil`.
 */
function reportInventory(): void {
  const rt = requireRuntime();
  if (!mayCollect(rt.store.current)) return;

  void collectInstalledApplications()
    .then((applications) => rt.client.reportApplications({ applications }))
    .catch((error: unknown) => {
      // Inventory is not collection-critical; failing it must not stop the agent.
      console.error("[aems] Could not report the installed-application inventory", error);
    });
}

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.STATUS_GET, (): AgentStatus => currentStatus());

  ipcMain.handle(
    IPC_CHANNELS.POLICY_GET,
    (): AgentPolicy | null => requireRuntime().store.current.policy,
  );

  ipcMain.handle(
    IPC_CHANNELS.ENROLL,
    async (_event, request: EnrollRequest): Promise<AgentStatus> => {
      const { store, client } = requireRuntime();

      client.setAuth({ kind: "user", token: request.accessToken });
      const response = await client.enrollDevice(collectDeviceFacts());
      accessToken = request.accessToken;

      store.update({
        deviceId: response.deviceId,
        companyId: response.companyId,
        profileId: response.profileId,
        deviceToken: response.deviceToken,
        policy: response.policy,
        // Enrolling is not consenting. Collection stays blocked until the employee
        // accepts the policy that is actually in force.
        consentedPolicyVersion: null,
        revoked: false,
      });

      attachDevice(response.deviceId, response.deviceToken);
      return publishStatus();
    },
  );

  ipcMain.handle(IPC_CHANNELS.CONSENT_ACCEPT, async (): Promise<AgentStatus> => {
    const { store, client } = requireRuntime();
    const { deviceId, deviceToken, policy } = store.current;

    if (deviceId === null || deviceToken === null || policy === null) {
      throw new Error("Enrol this device before recording consent");
    }
    if (accessToken === null) {
      throw new Error("Sign in again before recording consent");
    }

    // Consent has to reach the server before it is believed locally. The API is the
    // enforcement point, so a locally-consented agent with no consent_records row
    // just 403s on every ingest and bounces back to this screen forever.
    client.setAuth({ kind: "user", token: accessToken });
    await client.submitConsent({
      deviceId,
      policyVersion: policy.version,
      method: "in_app_dialog",
    });

    accessToken = null;
    client.setAuth({ kind: "device", token: deviceToken });
    store.update({ consentedPolicyVersion: policy.version });

    reportInventory();
    return publishStatus();
  });

  ipcMain.handle(IPC_CHANNELS.BREAK_START, (): AgentStatus => {
    requireRuntime().collector?.startBreak();
    return publishStatus();
  });

  ipcMain.handle(IPC_CHANNELS.BREAK_END, (): AgentStatus => {
    requireRuntime().collector?.endBreak();
    return publishStatus();
  });

  ipcMain.handle(IPC_CHANNELS.PERMISSIONS_GET, (): AgentPermissions => readPermissions());

  ipcMain.handle(
    IPC_CHANNELS.PERMISSIONS_OPEN_SETTINGS,
    async (_event, target: PermissionTarget): Promise<void> => {
      // Screen Recording cannot be requested programmatically — the TCC dialog only
      // appears on a real capture attempt — so deep-linking Settings is the whole
      // remediation path we have.
      if (process.platform !== "darwin") return;
      await shell.openExternal(SETTINGS_PANES[target]);
    },
  );

  ipcMain.handle(IPC_CHANNELS.QUIT, (): void => {
    quitting = true;
    app.quit();
  });
}

// -- lifecycle ------------------------------------------------------------

function configureAutoLaunch(): void {
  // In development process.execPath is the Electron binary inside node_modules, so
  // enabling this would pin a login item to a path that disappears with the checkout.
  if (!app.isPackaged) return;

  app.setLoginItemSettings(
    process.platform === "win32"
      ? {
          openAtLogin: true,
          path: process.execPath,
          args: ["--hidden"],
          enabled: true,
        }
      : { openAtLogin: true, type: "mainAppService" },
  );
}

function startAutoUpdates(): void {
  // The updater is inert unpackaged and only logs failures there.
  if (!app.isPackaged) return;

  const { autoUpdater } = requireCjs("electron-updater") as {
    autoUpdater: AppUpdater;
  };
  autoUpdater.autoDownload = true;
  // Installing mid-session would restart the agent during tracked time and punch a
  // hole in exactly the data the product reports on.
  autoUpdater.autoInstallOnAppQuit = true;
  void autoUpdater.checkForUpdates();
}

/**
 * How long the final drain is allowed to take.
 *
 * The clock-out and the last flush are network calls, and the SDK has no request
 * timeout — an unreachable API would otherwise leave a quitting agent hanging in the
 * tray, which is the one failure an employee cannot work around.
 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

let shuttingDown = false;

/**
 * Closes the open intervals, sends what is buffered and clocks out before exiting.
 *
 * Electron's `before-quit` is synchronous, so quitting is deferred once and resumed
 * when the drain settles. Without this the last focus interval, the open idle stretch
 * and the whole work session are lost on every quit.
 */
function drainThenQuit(event: Electron.Event): void {
  const collector = runtime?.collector;
  if (collector === null || collector === undefined || shuttingDown) return;

  event.preventDefault();
  shuttingDown = true;

  const drained = collector.shutdown().catch((error: unknown) => {
    console.error("[aems] Shutdown drain failed", error);
  });

  const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));

  void Promise.race([drained, deadline]).finally(() => {
    app.quit();
  });
}

function bootstrap(): void {
  app.on("second-instance", showWindow);

  app.on("before-quit", (event) => {
    quitting = true;
    drainThenQuit(event);
  });

  // Deliberately empty: the agent is a tray application, so closing the last window
  // is not a reason to stop collecting.
  app.on("window-all-closed", () => {});

  app.on("activate", showWindow);

  void app.whenReady().then(() => {
    const store = new ConfigStore(app.getPath("userData"));
    const config = store.load();

    // Without this the idle watcher reads a permanent zero and nobody is ever idle.
    // `powerMonitor` only exists after `whenReady`, which is why it is injected here
    // rather than imported by the module that uses it.
    setSystemIdleSource(powerMonitor);

    runtime = {
      store,
      client: new AemsClient({ baseUrl: config.apiUrl }),
      tracker: new Tracker(),
      idle: new IdleWatcher(),
      screenshots: new ScreenshotScheduler(new ElectronCapturer()),
      queue: null,
      sessions: null,
      collector: null,
    };

    registerIpc();

    // The tray comes up BEFORE anything can start collecting. It is the only
    // always-visible signal that monitoring is running, so an ordering where
    // attachDevice() -> collector.start() ran first left a window — however
    // short — in which the agent recorded with no indicator on screen. If the
    // tray cannot be created we do not collect at all: an invisible monitoring
    // agent is the one outcome this product must never produce.
    try {
      createTray();
    } catch (error) {
      console.error("tray creation failed - refusing to collect without an indicator", error);
      dialog.showErrorBox(
        "AEMS Agent cannot start",
        "The monitoring indicator could not be created, so monitoring has not started. " +
          "Please contact your IT administrator.",
      );
      app.quit();
      return;
    }

    if (config.deviceId !== null && config.deviceToken !== null) {
      attachDevice(config.deviceId, config.deviceToken);
      reportInventory();
    }

    mainWindow = createWindow();
    configureAutoLaunch();
    startAutoUpdates();
    publishStatus();
  });
}

// A login-item launch racing a manual one would otherwise produce two agents
// collecting the same machine twice.
if (app.requestSingleInstanceLock()) {
  bootstrap();
} else {
  app.quit();
}
