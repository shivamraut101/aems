import { execFile } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";

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

import {
  emptyTotals,
  IPC_CHANNELS,
  mayCollectType,
  offeredTypes,
  pausedBecause,
  statusOf,
} from "../shared/types/index.js";
import type {
  AgentPermissions,
  AgentStatus,
  EnrollRequest,
  PauseReason,
  PermissionTarget,
} from "../shared/types/index.js";
import type { BridgeInvocation } from "./bridge.js";
import { readBridgeInvocation } from "./bridge.js";
import { BROWSER_LINK_FILE, BrowserLinkStore, createBrowserLinkView } from "./bridge-link.js";
import { AEMS_EXTENSION_IDS } from "./bridge-protocol.js";
import { startBridge } from "./bridge-runtime.js";
import type { BrowserUrlReader } from "./browser-url.js";
import { createBrowserUrlReader, createLinkedBrowserUrlReader } from "./browser-url.js";
import { Collector } from "./collector.js";
import { ConfigStore } from "./config.js";
import { DeadLetterFile } from "./dead-letter.js";
import { collectEnrollmentRequest, collectInstalledApplications } from "./device.js";
import { IdleWatcher, setSystemIdleSource } from "./idle.js";
import { ElectronIndicatorSurface, IndicatorController, loadTrayImage } from "./indicator.js";
import { describeRegistration, registerNativeHost } from "./native-host.js";
import { createPermissionMonitor, PermissionGatedCapturer } from "./permissions.js";
import type { PermissionMonitor } from "./permissions.js";
import {
  AGENT_CONFIG_FILE,
  agentStateDirectory,
  createDurableStore,
  emptyDayState,
  JsonFile,
  nodeDurableFs,
} from "./persistence.js";
import type { DurableFs, DurableStore } from "./persistence.js";
import { ElectronCapturer, ScreenshotScheduler } from "./screenshot.js";
import { SessionManager } from "./session.js";
import { SyncQueue } from "./sync.js";
import { createTelemetryReaders, TelemetryReporter } from "./telemetry.js";
import type { TelemetryReaders } from "./telemetry.js";
import { Tracker } from "./tracker.js";

// electron-updater is CommonJS. A named ESM import of it depends on cjs-module-lexer
// picking up its getter-style exports, which is not something to bet a release on.
const requireCjs = createRequire(import.meta.url);

const execFileAsync = promisify(execFile);

/**
 * Every diagnostic in this process goes to stderr, never stdout.
 *
 * In bridge mode stdout *is* the wire Chrome reads length-prefixed frames from, so one
 * `console.log` on any path this process can reach would desynchronise the stream and
 * kill the port with nothing in any log to explain it.
 */
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
  /**
   * The platform URL reader, upgraded by the managed browser extension when one is
   * connected. Held on the runtime because `attachDevice` rebuilds the tracker on a
   * re-enrolment, and a default-constructed one would quietly drop back to reading
   * window titles on Windows.
   */
  urlReader: BrowserUrlReader;
  /** The journal, today's spans and the dead-letter file, as one unit. */
  durable: DurableStore;
  /** Battery, network and free storage. Built once: it caches the readings that cost a spawn. */
  telemetryReaders: TelemetryReaders;
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

// There is deliberately no user access token in this process any more. Enrolment
// redeems a short code and consent is proven by the device token, so the agent never
// holds a credential that could act as the employee anywhere else.

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
    dayEnded: rt.collector?.dayEnded ?? false,
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

/**
 * A `Record`, not a switch with a default, and that is the whole point.
 *
 * The previous version tested four conditions and fell through to "monitoring active"
 * for anything else — so when `dayEnded` was added, the tooltip claimed monitoring was
 * running over an agent that had clocked out, and nothing failed. A total map cannot
 * fall through: add a member to `PauseReason` and this stops compiling until it is
 * given words.
 */
const TRAY_TOOLTIP: Record<PauseReason, string> = {
  revoked: "AEMS — this device has been revoked by an administrator",
  "not-enrolled": "AEMS — not signed in",
  "consent-required": "AEMS — consent required, nothing is being collected",
  "day-ended": "AEMS — finished for today, nothing is being collected",
  "on-break": "AEMS — on a break, nothing is being collected",
};

function trayTooltip(status: AgentStatus): string {
  const paused = pausedBecause(status);
  return paused === null ? "AEMS — monitoring active" : TRAY_TOOLTIP[paused];
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
        label: status.onBreak ? "End break" : "Take a break",
        // Not offered after clock-out: a break is a pause inside a working day, and
        // pausing a day that has already ended is not a state worth being able to reach.
        enabled: !status.dayEnded && (status.collecting || status.onBreak),
        click: () => {
          toggleBreak(status.onBreak);
        },
      },
      {
        // The ellipsis is a promise that this asks before it acts. Ending the day
        // stops collection and closes the work session, and an employee who meant to
        // take a break should not lose their afternoon to a mis-click.
        label: status.dayEnded ? "Start working again" : "End day…",
        enabled: status.enrolled && !status.revoked,
        click: () => {
          void toggleDay(status.dayEnded);
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
    rt.tracker = new Tracker(undefined, rt.urlReader, () =>
      mayCollectType(rt.store.current, "websites"),
    );
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
    // The heartbeat is how a change to this device's collection scope arrives. Written
    // straight through `ConfigStore` — the same path `applyOutcome` uses for a stop
    // signal — so the plaintext config the bridge process reads stays in step with the
    // collection loop by construction rather than by two callers remembering to agree.
    onHeartbeat: (response) => {
      rt.store.update({
        collection: response.collection ?? null,
        pendingTypes: response.pendingTypes ?? [],
      });
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
      telemetry: new TelemetryReporter(rt.client, rt.telemetryReaders),
      dayState: day,
    },
    // Every state the loop reaches — a clock-in, a stop signal, a break — has to
    // reach the tray, the indicator and the renderer, or the agent would be
    // collecting invisibly.
    { onChanged: () => void publishStatus(), log },
  );

  rt.collector.start();
}

/**
 * Clock in or out for the day, from the tray.
 *
 * Ending asks first. It is not destructive in the sense that nothing is lost — the
 * events are flushed, not discarded — but it does stop collection until tomorrow, and a
 * silent stop is exactly as bad as a silent start: the employee would believe they were
 * still clocked in and their manager would see a day that ended at lunch.
 */
async function toggleDay(dayEnded: boolean): Promise<void> {
  const collector = runtime?.collector;
  if (!collector) return;

  if (dayEnded) {
    collector.startDay();
    return;
  }

  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["End day", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: "End day",
    message: "End your working day?",
    detail:
      "Your work session will be closed and nothing further will be recorded today. " +
      "Monitoring starts again by itself tomorrow, and you can start working again from " +
      "this menu if you carry on.",
  });

  if (response === 0) await collector.endDay();
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
  if (!mayCollectType(rt.store.current, "installed_apps")) return;

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

      // No Authorization header at all — the code IS the credential, and the device
      // token that comes back is what everything after this uses, consent included.
      // Nothing user-scoped is ever held in this process now.
      const response = await client.enrollDeviceWithCode(
        request.enrollmentCode,
        // Awaited rather than read synchronously: the machine model is the one
        // enrolment fact with no in-process source, and without it every device row
        // in the dashboard read "Unknown model".
        await collectEnrollmentRequest(),
      );

      store.update({
        deviceId: response.deviceId,
        companyId: response.companyId,
        profileId: response.profileId,
        deviceToken: response.deviceToken,
        policy: response.policy,
        // What this machine was enrolled to collect, decided when the code was minted.
        // Absent means the API predates per-device scope, which is the platform default.
        collection: response.collection ?? null,
        pendingTypes: [],
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
    // Exactly the set the screen listed, which is what makes the record a record of
    // what was agreed rather than of when. Undefined where no scope has arrived: the
    // server reads that as the platform default of the day, which is what it means.
    const granted = offeredTypes(store.current.collection, store.current.pendingTypes);

    if (deviceId === null || deviceToken === null || policy === null) {
      throw new Error("Enrol this device before recording consent");
    }

    // Consent has to reach the server before it is believed locally. The API is the
    // enforcement point, so a locally-consented agent with no consent_records row
    // just 403s on every ingest and bounces back to this screen forever.
    //
    // Proven by the device token: an agent enrolled with a code never holds a user
    // session, and the token already names the device, its company and its owner.
    client.setAuth({ kind: "device", token: deviceToken });
    await client.submitConsentAsDevice({
      policyVersion: policy.version,
      method: "in_app_dialog",
      ...(granted === null ? {} : { grantedTypes: granted }),
    });

    // `collection` is left for the next heartbeat to settle rather than widened here:
    // the server decides what it is enforcing, and an agent that assumed its own
    // pending types were now live would collect ahead of the record saying it may.
    store.update({ consentedPolicyVersion: policy.version, pendingTypes: [] });

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

  ipcMain.handle(IPC_CHANNELS.DAY_END, async (): Promise<AgentStatus> => {
    // Awaited, unlike the break handlers: ending the day drains the queue and closes
    // the work session over the network, and returning a status before that lands
    // would show the employee a day that is still open.
    await requireRuntime().collector?.endDay();
    return publishStatus();
  });

  ipcMain.handle(IPC_CHANNELS.DAY_START, (): AgentStatus => {
    requireRuntime().collector?.startDay();
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

/**
 * Where `out/main/bridge.js` actually is — the second main entry the launcher runs.
 *
 * Packaged, it lives inside `app.asar`, and the launcher starts it with
 * `ELECTRON_RUN_AS_NODE=1`. Whether Electron's asar hooks are installed in that mode is
 * a version-dependent detail this agent should not bet a compliance feature on, so an
 * unpacked copy is preferred whenever one exists. Adding
 *
 *     asarUnpack:
 *       - out/main/bridge.js
 *
 * to `electron-builder.yml` is what produces it; without that line this falls back to
 * the in-asar path, which is correct if the hooks are present and is the only other
 * candidate if they are not.
 */
function bridgeScriptPath(): string {
  const inAsar = join(import.meta.dirname, "bridge.js");
  const unpacked = inAsar.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);

  return unpacked !== inAsar && existsSync(unpacked) ? unpacked : inAsar;
}

/**
 * Tells Chrome and Edge how to start this binary as a native messaging host.
 *
 * Fire-and-forget, and deliberately never awaited: a browser that cannot find the host
 * is a degraded install — website tracking falls back to the platform reader and
 * restrictions do not apply — but it is not a reason for a monitoring agent to refuse
 * to launch. The outcome is logged either way, naming the scope, because "registered
 * for this user" and "registered for the machine" are different rollouts and an
 * administrator can only tell which they got if the agent says so.
 */
function registerBrowserBridge(fs: DurableFs): void {
  void registerNativeHost({
    platform: process.platform,
    executablePath: process.execPath,
    userDataPath: app.getPath("userData"),
    homePath: homedir(),
    fs,
    run: async (file, args) => {
      // execFile, never a shell: the manifest path is interpolated into this command
      // line and a path containing `&` must not be able to run anything.
      await execFileAsync(file, [...args], { windowsHide: true });
    },
    join,
    extensionIds: AEMS_EXTENSION_IDS,
    bridgeScriptPath: bridgeScriptPath(),
    makeExecutable: (path) => {
      chmodSync(path, 0o755);
    },
  })
    .then((result) => {
      log(describeRegistration(result));
    })
    .catch((error: unknown) => {
      log("The browser bridge could not be registered", error);
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

    // A sleeping machine is not a working one. Left unhandled, the first sample after
    // waking closes the interval that was open when the lid shut, so a laptop closed
    // overnight reports the whole night as one span of focused work — the largest way
    // this agent could overstate somebody's day. `lock-screen` is included because a
    // locked workstation is equally not being used, and on Windows a lock often
    // precedes sleep by minutes.
    // Registered one by one rather than over a list: `powerMonitor.on` is overloaded
    // per event name and rejects a union of them.
    const onSuspend = (): void => {
      runtime?.collector?.suspend();
      publishStatus();
    };
    const onWake = (): void => {
      runtime?.collector?.wake();
      publishStatus();
    };

    powerMonitor.on("suspend", onSuspend);
    powerMonitor.on("lock-screen", onSuspend);
    powerMonitor.on("resume", onWake);
    powerMonitor.on("unlock-screen", onWake);

    // Built before anything that consumes it: `SyncQueue` replays inside its constructor
    // and `SessionManager` loads inside its, so either one built ahead of the store would
    // silently restore nothing at all.
    const stateDirectory = agentStateDirectory(app.getPath("userData"));
    const durable = createDurableStore({ directory: stateDirectory, log });
    const deadLetters = new DeadLetterFile(durable.fs, durable.deadLetterPath, { log });

    // The other half of the browser bridge. The bridge is a separate process — Chrome
    // spawns it, this agent does not — so the two meet through this file rather than
    // through a shared object. Built before the URL reader that consumes it.
    const link = new BrowserLinkStore(
      new JsonFile(durable.fs, join(stateDirectory, BROWSER_LINK_FILE), { log }),
    );

    const urlReader = createLinkedBrowserUrlReader(
      createBrowserUrlReader(process.platform),
      createBrowserLinkView(link),
    );

    // The monitor is handed the same reader the tracker uses, so the fidelity an
    // employee is shown on the consent screen is produced by the object that actually
    // resolves their website data — not by a second copy of the platform rule.
    const permissions = createPermissionMonitor(urlReader);

    registerBrowserBridge(durable.fs);

    runtime = {
      store,
      client: new AemsClient({ baseUrl: config.apiUrl, timeoutMs: REQUEST_TIMEOUT_MS }),
      // The website gate is a closure over the store rather than a value, so an
      // administrator switching websites off lands on the next focus change.
      tracker: new Tracker(undefined, urlReader, () =>
        mayCollectType(store.current, "websites"),
      ),
      urlReader,
      idle: new IdleWatcher(),
      // The gate sits on the capturer rather than in the scheduler because this is the
      // last point before the display is actually read: nothing can route around it to
      // produce a frame, and a grant withdrawn mid-day stops capture on the next attempt.
      screenshots: new ScreenshotScheduler(
        new PermissionGatedCapturer(new ElectronCapturer(), () => permissions.read()),
      ),
      permissions,
      durable,
      telemetryReaders: createTelemetryReaders({ powerMonitor }),
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

// -- the browser bridge ---------------------------------------------------

/**
 * Serves one native messaging port, then exits with it.
 *
 * No tray, no window, no collection loop and no device token: this process exists to
 * carry an address from the browser to the running agent's state directory and to hand
 * the browser back the policy it must enforce. Everything else the agent does belongs
 * to the instance that holds the single-instance lock.
 *
 * **Chrome does not reach this branch.** The registered host is the launcher in
 * `native-host.ts`, which runs `out/main/bridge.js` under `ELECTRON_RUN_AS_NODE=1` —
 * because a full Electron process writes a stray CRLF to stdout on Windows before any
 * of this code runs, and that alone destroys the wire. This branch remains because it
 * is what makes the *ordering* below verifiable without a browser, and because a
 * launcher edited by hand must still meet a host rather than a second agent.
 */
function runBridgeProcess(invocation: BridgeInvocation): void {
  // Without this macOS bounces a dock icon every time a browser opens the port — a
  // process the employee never started, appearing to start itself.
  app.dock?.hide();

  const userDataPath = app.getPath("userData");
  const fs = nodeDurableFs();

  startBridge(invocation, {
    stdin: process.stdin,
    stdout: process.stdout,
    readConfig: () => fs.read(join(userDataPath, AGENT_CONFIG_FILE)),
    link: new BrowserLinkStore(
      new JsonFile(fs, join(agentStateDirectory(userDataPath), BROWSER_LINK_FILE), { log }),
    ),
    log,
    now: () => new Date(),
    exit: (code) => {
      process.exit(code);
    },
  });

  // stdin starts paused, and a paused stdin is also the only handle keeping this
  // process alive — without this the bridge would exit before Chrome sent a byte.
  process.stdin.resume();
}

// -- entry ----------------------------------------------------------------

/**
 * THE ORDER OF THESE THREE BRANCHES IS LOAD-BEARING. Read before editing.
 *
 * Chrome starts a *new* process for every native messaging port. If the bridge branch
 * ran after `requestSingleInstanceLock()`, every one of those processes would find the
 * lock held by the running agent, fall into the `else` and `app.quit()` before writing
 * a byte — so the extension would see a channel that connects and instantly
 * disconnects, forever, with nothing in any log to say why. And asking for the lock at
 * all fires `second-instance` in the running agent, whose handler opens the agent
 * window: every browser launch would pop a window in the employee's face.
 *
 * So the bridge is decided from `process.argv` alone, before the lock is requested, and
 * the bridge branch never requests it. The agent branch is unchanged: a login-item
 * launch racing a manual one must still produce one agent, not two collecting the same
 * machine twice.
 */
const bridgeInvocation = readBridgeInvocation(process.argv);

if (bridgeInvocation !== null) {
  runBridgeProcess(bridgeInvocation);
} else if (app.requestSingleInstanceLock()) {
  bootstrap();
} else {
  app.quit();
}
