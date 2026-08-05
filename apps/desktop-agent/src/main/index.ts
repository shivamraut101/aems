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
import { DeadLetterFile } from "./dead-letter.js";
import { collectDeviceFacts, collectInstalledApplications } from "./device.js";
import { IdleWatcher, setSystemIdleSource } from "./idle.js";
import { ElectronIndicatorSurface, IndicatorController, loadTrayImage } from "./indicator.js";
import { createPermissionMonitor, PermissionGatedCapturer } from "./permissions.js";
import type { PermissionMonitor } from "./permissions.js";
import { agentStateDirectory, createDurableStore, emptyDayState } from "./persistence.js";
import type { DurableStore } from "./persistence.js";
import { ElectronCapturer, ScreenshotScheduler } from "./screenshot.js";
import { SessionManager } from "./session.js";
import { SyncQueue } from "./sync.js";
import { Tracker } from "./tracker.js";

// electron-updater is CommonJS. A named ESM import of it depends on cjs-module-lexer
// picking up its getter-style exports, which is not something to bet a release on.
const requireCjs = createRequire(import.meta.url);

function log(message: string, error?: unknown): void {
  console.error(`[aems] ${message}`, error ?? "");
}

/**
 * How long any one API call may take.
 *
 * Deliberately set rather than left to the SDK's 30 s default: `Collector.tick()`
 * holds its re-entrancy latch across the flush, so a hung POST blinds focus sampling,
 * idle sampling and capture for the whole deadline. Fifteen seconds is three missed
 * ticks instead of six — and it is comfortably longer than the shutdown drain window
 * below, so the final flush is never cut off by its own transport.
 */
const REQUEST_TIMEOUT_MS = 15_000;

interface Runtime {
  store: ConfigStore;
  client: AemsClient;
  tracker: Tracker;
  idle: IdleWatcher;
  screenshots: ScreenshotScheduler;
  permissions: PermissionMonitor;
  /** The journal, today's spans and the dead-letter file, as one unit. */
  durable: DurableStore;
  deadLetters: DeadLetterFile;
  /** Which device the queue and session manager below belong to. */
  deviceId: string | null;
  /** All three need a device id, so they only exist once the machine is enrolled. */
  queue: SyncQueue | null;
  sessions: SessionManager | null;
  collector: Collector | null;
}

let runtime: Runtime | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let indicator: IndicatorController | null = null;

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

function currentStatus(): AgentStatus {
  const rt = requireRuntime();

  return statusOf(rt.store.current, {
    workSessionId: rt.sessions?.current ?? null,
    pendingEvents: rt.queue?.pending ?? 0,
    lastSyncAt: rt.queue?.lastSyncAt ?? null,
    permissions: rt.permissions.read(),
    totals: rt.collector?.dayTotals ?? emptyTotals(),
    onBreak: rt.collector?.onBreak ?? false,
  });
}

/** Recomputes status, repaints the tray and the indicator, and pushes it to the renderer. */
function publishStatus(): AgentStatus {
  const status = currentStatus();

  // The two visible signals go first, in that order: the indicator is the one that
  // actually satisfies non-negotiable #2, and a renderer that is slow to paint must
  // never be what delays it.
  updateTray(status);
  indicator?.apply(status);
  broadcastStatus(status);

  return status;
}

/**
 * Pushes to every window, not just the main one.
 *
 * The indicator is a second renderer on the same channel, and it reads its own label
 * off this push — sending only to `mainWindow` would leave the pill saying "Monitoring"
 * after capture had been blocked, which is the kind of stale claim this product cannot
 * afford to make.
 */
function broadcastStatus(status: AgentStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.STATUS_CHANGED, status);
  }
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
  // the asar. `loadTrayImage` is what turns an unreadable asset into a throw — Electron
  // answers a missing path with an empty image and `new Tray()` accepts it silently,
  // which would leave the agent collecting behind a zero-size, invisible status item.
  tray = new Tray(loadTrayImage(nativeImage, app.getAppPath(), process.platform));
  tray.on("click", showWindow);
}

// -- the always-visible indicator -----------------------------------------

/** Latched: `apply` runs inside the status publisher, which the collection tick drives. */
let indicatorFailed = false;

/**
 * The agent wanted to claim it was collecting and had no indicator to claim it with.
 *
 * Monitoring is never silent (non-negotiable #2), so the only defensible response is to
 * stop — the same decision the tray failure already takes, for the same reason.
 */
function onIndicatorUnavailable(error: unknown): void {
  if (indicatorFailed || quitting) return;
  indicatorFailed = true;

  log("The monitoring indicator could not be shown; refusing to collect without it", error);
  runtime?.collector?.stop();

  dialog.showErrorBox(
    "AEMS Agent has stopped",
    "The monitoring indicator could not be shown, so monitoring has stopped. " +
      "Please contact your IT administrator.",
  );

  quitting = true;
  app.quit();
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
  // employee is actually doing. `--hidden` is the Windows signal (it is passed in the
  // Run key); macOS has no such argument under SMAppService and reports it on the
  // login-item settings instead.
  window.on("ready-to-show", () => {
    if (!openedAtLogin()) window.show();
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

function openedAtLogin(): boolean {
  if (process.platform === "win32") return process.argv.includes("--hidden");

  // `openAsHidden` is deprecated and `setLoginItemSettings` takes no args on darwin, so
  // the argv trick never fires there — without this the agent window would appear in the
  // employee's face on every single login.
  return app.getLoginItemSettings().wasOpenedAtLogin;
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

/** Rebuilds the collaborators that need a device id, and swaps the client onto device auth. */
function attachDevice(deviceId: string, deviceToken: string): void {
  const rt = requireRuntime();

  rt.collector?.stop();
  rt.client.setAuth({ kind: "device", token: deviceToken });

  // The durable state outlives the objects that own it, so a re-enrolment onto a
  // *different* device must throw it away: replaying it would send the previous
  // device's observations under the new device's identity. Re-enrolling the same id is
  // the opposite case — replaying is the entire point there.
  if (rt.deviceId !== null && rt.deviceId !== deviceId) {
    rt.durable.journal.clear();
    rt.durable.dayState.update(emptyDayState());

    // The watchers hold the same day in memory that the two files above just lost, so
    // they are replaced rather than carried across: an interval opened under the old
    // enrolment would otherwise close and be reported under the new device's identity.
    // The capture schedule is deliberately kept — it is a consented cadence, not an
    // observation, and resetting it would fire a frame the moment the swap lands.
    rt.tracker = new Tracker();
    rt.idle = new IdleWatcher();
  }
  rt.deviceId = deviceId;

  const day = rt.durable.dayState;

  const queue = new SyncQueue(rt.client, deviceId, {
    journal: rt.durable.journal,
    deadLetters: rt.deadLetters,
    lastSyncAt: day.load().lastSyncAt,
    onSynced: (at) => {
      day.update({ lastSyncAt: at });
    },
    onOverflow: (dropped, kind) => {
      log(`Dropped ${dropped} buffered ${kind} event(s) to stay within memory`);
    },
    onQuarantine: (dropped, kind, reason) => {
      log(`Quarantined ${dropped} ${kind} event(s) the API rejected (${reason})`);
    },
    onDurabilityFault: (error) => {
      log("Could not write the durable store", error);
    },
  });

  rt.queue = queue;
  rt.sessions = new SessionManager(rt.client, deviceId, day);
  rt.collector = new Collector(
    {
      config: rt.store,
      queue,
      sessions: rt.sessions,
      tracker: rt.tracker,
      idle: rt.idle,
      screenshots: rt.screenshots,
      dayState: day,
    },
    // Every state the loop reaches — a clock-in, a stop signal, a break — has to
    // reach the tray, the indicator and the renderer, or the agent would be
    // collecting invisibly.
    { onChanged: () => void publishStatus(), log },
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
      log("Could not report the installed-application inventory", error);
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

  ipcMain.handle(
    IPC_CHANNELS.PERMISSIONS_GET,
    (): AgentPermissions => requireRuntime().permissions.read(),
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSIONS_OPEN_SETTINGS,
    async (_event, target: PermissionTarget): Promise<void> => {
      // `request()` owns the platform branch, and on macOS it also performs the TCC
      // registration without which the deep-linked Settings pane lists no AEMS row at
      // all. It is only ever reached from the employee's own click, because registering
      // for Screen Recording is itself a capture.
      await requireRuntime().permissions.request(target);

      // A just-granted permission has to reach the readout now, rather than at whatever
      // the next collection tick happens to be.
      publishStatus();
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

  // SMAppService lands in `requires-approval` when the employee has switched the agent
  // off under System Settings → Login Items, and re-registering does not override that.
  // Scope §2.1's "auto start with system" is then silently false, so it is logged rather
  // than assumed.
  const { status } = app.getLoginItemSettings();
  if (status === "requires-approval" || status === "not-registered") {
    log(`Auto-launch is not active (${status}); the agent will not start itself at login`);
  }
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
 * The clock-out and the last flush are network calls. The SDK now bounds each one at
 * `REQUEST_TIMEOUT_MS`, but a drain is several of them in sequence — so this is what
 * stops an unreachable API leaving a quitting agent hanging in the tray, which is the
 * one failure an employee cannot work around.
 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

let shuttingDown = false;

/**
 * Closes the open intervals, sends what is buffered and clocks out before exiting.
 *
 * Electron's `before-quit` is synchronous, so quitting is deferred once and resumed
 * when the drain settles. Without this the last focus interval, the open idle stretch
 * and the whole work session are lost on every quit.
 *
 * `Collector.shutdown()` also writes the day's state down as its last act, so a clean
 * exit leaves a document with nothing open — which is what stops the next launch
 * reopening spans that already became events.
 */
function drainThenQuit(event: Electron.Event): void {
  const collector = runtime?.collector;
  if (collector === null || collector === undefined || shuttingDown) return;

  event.preventDefault();
  shuttingDown = true;

  const drained = collector.shutdown().catch((error: unknown) => {
    log("Shutdown drain failed", error);
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

  // Fires once quitting is actually going ahead, so it covers the drain path and the
  // never-enrolled path alike. Nothing that claims the agent is recording survives the
  // process that was doing the recording.
  app.on("will-quit", () => {
    indicator?.dispose();
    indicator = null;
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

    // Built before anything that consumes it: `SyncQueue` replays inside its constructor
    // and `SessionManager` loads inside its, so either one built ahead of the store would
    // silently restore nothing at all.
    const durable = createDurableStore({
      directory: agentStateDirectory(app.getPath("userData")),
      log,
    });
    const deadLetters = new DeadLetterFile(durable.fs, durable.deadLetterPath, { log });

    const permissions = createPermissionMonitor();

    runtime = {
      store,
      client: new AemsClient({ baseUrl: config.apiUrl, timeoutMs: REQUEST_TIMEOUT_MS }),
      tracker: new Tracker(),
      idle: new IdleWatcher(),
      // The gate sits on the capturer rather than in the scheduler because this is the
      // last point before the display is actually read: nothing can route around it to
      // produce a frame, and a grant withdrawn mid-day stops capture on the next attempt.
      screenshots: new ScreenshotScheduler(
        new PermissionGatedCapturer(new ElectronCapturer(), () => permissions.read()),
      ),
      permissions,
      durable,
      deadLetters,
      deviceId: null,
      queue: null,
      sessions: null,
      collector: null,
    };

    registerIpc();

    // Both visible signals come up BEFORE anything can start collecting. An ordering
    // where attachDevice() -> collector.start() ran first left a window — however
    // short — in which the agent recorded with nothing on screen saying so. If the
    // tray cannot be created we do not collect at all: an invisible monitoring agent
    // is the one outcome this product must never produce.
    try {
      createTray();
    } catch (error) {
      log("Tray creation failed - refusing to collect without an indicator", error);
      dialog.showErrorBox(
        "AEMS Agent cannot start",
        "The monitoring indicator could not be created, so monitoring has not started. " +
          "Please contact your IT administrator.",
      );
      app.quit();
      return;
    }

    // The window itself is created lazily, on the first status that says the agent is
    // recording — but the controller that owns that decision exists from here on, so
    // the very first `publishStatus()` after a clock-in already raises the pill.
    indicator = new IndicatorController(() => new ElectronIndicatorSurface(), {
      onUnavailable: onIndicatorUnavailable,
    });

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
