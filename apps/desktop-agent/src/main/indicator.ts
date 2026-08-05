/**
 * The always-visible monitoring indicator (non-negotiable #2).
 *
 * The tray alone does not satisfy that promise. Windows 11 22H2+ files third-party
 * notification icons into the overflow flyout by default and Microsoft documents that
 * *only the user* can promote one out of it, so the icon an employee is supposed to be
 * able to see at a glance may never be on screen at all. On macOS the status item is
 * the only surface (`LSUIElement: true` means no Dock icon) and a non-template image
 * renders unreadably against some menu bars. This module adds the piece that closes
 * both gaps — a small always-on-top window the agent controls itself — and fixes the
 * macOS template-image problem for the tray on the way past.
 *
 * The decision of *when* it is on screen is pure and lives in
 * `shared/types/index.ts`; everything Electron-shaped sits behind
 * `IndicatorSurface` so the rules below can be tested without a display.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import type { AgentStatus, IndicatorState } from "../shared/types/index.js";
import { INDICATOR_HASH, indicatorStateFor } from "../shared/types/index.js";

/**
 * The window, reduced to what the controller is allowed to do to it.
 *
 * Injected rather than imported so the show/hide rules need no Electron runtime, no
 * display and no compositor.
 */
export interface IndicatorSurface {
  show(): void;
  hide(): void;
  isVisible(): boolean;
  /** False once the underlying window is gone; every other call then throws. */
  isAlive(): boolean;
  destroy(): void;
}

export interface IndicatorHooks {
  /**
   * The agent wants to claim it is collecting and has no indicator to claim it with.
   *
   * Handed out rather than thrown because `apply` runs inside the status publisher,
   * which the collection tick drives: a throw would be caught and logged there while
   * collection carried on regardless. The caller decides — and for this product the
   * only defensible decision is to stop.
   */
  onUnavailable?: (error: unknown) => void;
}

/** Keeps the indicator on screen for exactly as long as collection is running. */
export class IndicatorController {
  private surface: IndicatorSurface | null = null;

  constructor(
    private readonly createSurface: () => IndicatorSurface,
    private readonly hooks: IndicatorHooks = {},
  ) {}

  /** Reconciles the indicator with the status the agent just published. */
  apply(status: AgentStatus): IndicatorState {
    const state = indicatorStateFor(status);

    if (this.surface !== null && !this.surface.isAlive()) this.surface = null;

    try {
      if (state.visible) {
        // Re-shown on every visible tick, not only on creation: that repetition is
        // what makes the indicator undismissable.
        this.surface ??= this.createSurface();
        this.surface.show();
      } else {
        this.surface?.hide();
      }
    } catch (error) {
      this.surface = null;
      if (state.visible) this.hooks.onUnavailable?.(error);
    }

    return state;
  }

  /** Called on quit. Nothing here survives the process that is claiming to collect. */
  dispose(): void {
    this.surface?.destroy();
    this.surface = null;
  }
}

// -- placement ------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A pill, not a HUD (docs/design.md: the agent is "very minimal").
 *
 * Wide enough that the longest label — "Monitoring — limited" — never has to be
 * ellipsised, and no wider. An indicator reading "Monitoring — limi…" is a worse
 * compliance statement than the short one.
 */
export const INDICATOR_SIZE = { width: 184, height: 32 } as const;

/** Clear of the screen edge, so it reads as deliberate rather than as a rendering fault. */
export const INDICATOR_MARGIN = 16;

/**
 * Where the pill sits, in the coordinates Electron's `screen` module reports.
 *
 * Derived from the display's work area rather than hard-coded: a laptop with a
 * scaled panel, a second monitor with a negative origin, or a taskbar on the left
 * all move the corner, and a fixed x/y puts the compliance indicator off-screen —
 * which is indistinguishable from not having one.
 */
export function indicatorBounds(
  workArea: Rect,
  size: { width: number; height: number },
  margin: number = INDICATOR_MARGIN,
): Rect {
  return {
    x: workArea.x + workArea.width - size.width - margin,
    y: workArea.y + workArea.height - size.height - margin,
    width: size.width,
    height: size.height,
  };
}

// -- tray image -----------------------------------------------------------

/** The `nativeImage` surface the tray fix uses, narrowed so tests need no Electron. */
export interface TrayImage {
  isEmpty(): boolean;
  setTemplateImage(value: boolean): void;
}

/**
 * Generic in the image it hands back, so the real `nativeImage` yields a `NativeImage`
 * the `Tray` constructor accepts while a test's fake yields its own recording double.
 * Narrowing to `TrayImage` here would make the production call site uncallable.
 */
export interface TrayImageLoader<T extends TrayImage = TrayImage> {
  createFromPath(path: string): T;
}

/** Loads the tray icon and applies the per-platform rules Electron does not apply itself. */
export function loadTrayImage<T extends TrayImage>(
  loader: TrayImageLoader<T>,
  appPath: string,
  platform: NodeJS.Platform,
): T {
  const path = join(appPath, "resources", "tray.png");
  const image = loader.createFromPath(path);

  // Electron answers an unreadable path with an empty image instead of an error, and
  // `new Tray()` accepts that empty image without complaint. Only an explicit check
  // turns a missing asset into the startup failure it is.
  if (image.isEmpty()) {
    throw new Error(`The tray icon at ${path} could not be loaded`);
  }

  // A macOS status item is expected to be a template image: black plus alpha, which
  // AppKit inverts for a dark menu bar and for the clicked state. Without this the
  // icon keeps its own colours and disappears into some menu bars entirely — the
  // failure CLAUDE.md open item #5 records. Windows takes the bitmap as drawn, so
  // marking it there would render a black blob instead.
  if (platform === "darwin") image.setTemplateImage(true);

  return image;
}

// -- the real window ------------------------------------------------------

// Loaded lazily, exactly as `screenshot.ts` does, so the rules above can be imported
// and exercised in a plain Node process with no Electron runtime.
const requireElectron = createRequire(import.meta.url);

/**
 * The always-on-top pill.
 *
 * Every option below is load-bearing, so they are listed with the reason rather than
 * left to be rediscovered:
 *
 * - `focusable: false` + click-through — the indicator must never take a keystroke or
 *   a click away from the employee's actual work. A compliance signal that gets in
 *   the way is one somebody will find a way to kill.
 * - `setContentProtection(true)` — keeps the window out of screen capture, so the
 *   agent does not photograph its own indicator into every screenshot it takes.
 *   Two documented degradations: on Windows 10 before 2004 the OS can only black the
 *   region out rather than skip it, and on macOS 14.4+ Electron captures through
 *   ScreenCaptureKit, which Apple deliberately made ignore `NSWindowSharingNone`. In
 *   both cases the pill shows up in the corner of the employee's own screenshots —
 *   untidy, not a leak, and not worth hiding the indicator mid-capture to avoid.
 * - `skipTaskbar` + `type: "panel"` — no taskbar button, no Dock tile, no Mission
 *   Control thumbnail. It is a status light, not a window.
 * - `screen-saver` level — every level up to `status` still sits *below* the Windows
 *   taskbar and the macOS Dock, which is exactly where the indicator would be lost.
 * - visible on all workspaces including full screen — an employee who switches Space
 *   or goes full screen must not be able to leave the indicator behind.
 */
export class ElectronIndicatorSurface implements IndicatorSurface {
  private readonly window: Electron.BrowserWindow;
  private readonly screen: Electron.Screen;

  constructor() {
    const { BrowserWindow, app, screen } = requireElectron("electron") as typeof import("electron");
    this.screen = screen;

    this.window = new BrowserWindow({
      ...indicatorBounds(screen.getPrimaryDisplay().workArea, INDICATOR_SIZE),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      // The pill draws its own 8px radius (docs/design.md); letting macOS round the
      // window as well leaves a halo around the corners of a transparent window.
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      acceptFirstMouse: false,
      type: process.platform === "darwin" ? "panel" : undefined,
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.setContentProtection(true);
    this.window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      // An accessory app that transforms its process type here picks up a Dock icon,
      // which is the one thing `LSUIElement: true` exists to prevent.
      skipTransformProcessType: true,
    });
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" as const }));

    const devServer = process.env.ELECTRON_RENDERER_URL;
    if (!app.isPackaged && devServer !== undefined && devServer.length > 0) {
      void this.window.loadURL(`${devServer}/${INDICATOR_HASH}`);
    } else {
      void this.window.loadFile(join(import.meta.dirname, "../renderer/index.html"), {
        hash: INDICATOR_HASH.slice(1),
      });
    }
  }

  /** Idempotent: the controller calls this on every tick the agent is collecting. */
  show(): void {
    // Re-asserted rather than set once: a full-screen application, a display change or
    // a Space switch can all drop a window out of the top level, and the employee has
    // no way to notice that it happened.
    this.window.setAlwaysOnTop(true, "screen-saver");

    // Only when it actually moved — a resolution change, a docking station, a taskbar
    // moved to the side. Re-setting identical bounds every five seconds is a repaint
    // the employee can see.
    const wanted = indicatorBounds(this.screen.getPrimaryDisplay().workArea, INDICATOR_SIZE);
    const current = this.window.getBounds();
    if (current.x !== wanted.x || current.y !== wanted.y) this.window.setBounds(wanted);

    // `showInactive`, never `show`: raising the indicator must not pull focus out of
    // whatever the employee is typing into.
    if (!this.window.isVisible()) this.window.showInactive();
  }

  hide(): void {
    this.window.hide();
  }

  isVisible(): boolean {
    return this.window.isVisible();
  }

  isAlive(): boolean {
    return !this.window.isDestroyed();
  }

  destroy(): void {
    // `destroy`, not `close`: close is cancellable and this window must always go.
    this.window.destroy();
  }
}
