import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentStatus } from "../shared/types/index.js";
import {
  emptyTotals,
  INDICATOR_HASH,
  indicatorStateFor,
  isIndicatorRoute,
} from "../shared/types/index.js";
import type { IndicatorSurface } from "./indicator.js";
import {
  INDICATOR_MARGIN,
  INDICATOR_SIZE,
  IndicatorController,
  indicatorBounds,
  loadTrayImage,
} from "./indicator.js";

/** A status that is collecting with nothing blocked, so each test varies one field. */
function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    enrolled: true,
    collecting: true,
    consentRequired: false,
    revoked: false,
    policyVersion: "2026-01",
    workSessionId: 1,
    pendingEvents: 0,
    collection: null,
  pendingTypes: [],
  dayEnded: false,
    lastSyncAt: null,
    permissions: { screenRecording: "granted", accessibility: "granted", websiteTracking: "browser-url" },
    totals: emptyTotals(),
    onBreak: false,
    ...overrides,
  };
}

describe("indicatorStateFor", () => {
  it("shows the indicator while collection is running", () => {
    expect(indicatorStateFor(status()).visible).toBe(true);
  });

  it("stays off a machine that has never been signed in", () => {
    const state = indicatorStateFor(status({ enrolled: false, collecting: false }));
    expect(state).toEqual({ visible: false, reason: "not-enrolled" });
  });

  it("stays off while the consent gate is still open", () => {
    const state = indicatorStateFor(status({ collecting: false, consentRequired: true }));
    expect(state).toEqual({ visible: false, reason: "consent-required" });
  });

  it("stays off after an administrator revokes the device", () => {
    const state = indicatorStateFor(status({ collecting: false, revoked: true }));
    expect(state).toEqual({ visible: false, reason: "revoked" });
  });

  // `collecting` stays true across a break — it is a property of the consent record,
  // not of the loop. The indicator claims recording, so it has to follow the loop.
  it("stays off during a declared break, even though consent still permits collection", () => {
    const state = indicatorStateFor(status({ collecting: true, onBreak: true }));
    expect(state).toEqual({ visible: false, reason: "on-break" });
  });

  // Reported from a real desktop: End day was pressed, the loop stopped recording, and
  // the pill went on saying "Monitoring". `collecting` is `mayCollect(config)` — the
  // consent record — and ending the day does not touch consent, so every surface that
  // forgot to subtract `dayEnded` claimed collection over a stopped agent.
  it("stays off after the employee has ended their day", () => {
    const state = indicatorStateFor(status({ collecting: true, dayEnded: true }));
    expect(state).toEqual({ visible: false, reason: "day-ended" });
  });

  // Ending the day is offered *from* a break, so the two overlap. "Finished for today"
  // is the truer of the two, and a reader must not be told they are merely paused.
  it("prefers the finished day over the break it was ended from", () => {
    const state = indicatorStateFor(status({ collecting: true, onBreak: true, dayEnded: true }));
    expect(state).toEqual({ visible: false, reason: "day-ended" });
  });

  // The flags above are how collection stops *today*. Keying the last word on
  // `collecting` itself means a future stop signal cannot light the pill by omission.
  it("stays off whenever the agent reports it is not collecting, whatever else it says", () => {
    const state = indicatorStateFor(
      status({ collecting: false, consentRequired: false, revoked: false }),
    );
    expect(state.visible).toBe(false);
  });

  // Showing the same emerald pill while macOS is blocking capture would tell the
  // employee more is being recorded than actually is — the inverse of silent
  // collection, and just as dishonest.
  it("marks itself limited while the OS is blocking part of what was consented to", () => {
    const state = indicatorStateFor(
      status({
        permissions: {
          screenRecording: "denied",
          accessibility: "granted",
          websiteTracking: "browser-url",
        },
      }),
    );

    expect(state).toEqual({ visible: true, tone: "limited", label: "Monitoring — limited" });
  });
});

/** Stands in for the always-on-top BrowserWindow, so nothing here needs a display. */
class FakeSurface implements IndicatorSurface {
  shown = 0;
  destroyed = false;
  private visible = false;

  show(): void {
    this.shown += 1;
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  isVisible(): boolean {
    return this.visible && !this.destroyed;
  }

  isAlive(): boolean {
    return !this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.visible = false;
  }
}

/** Records every surface the controller asks for, so creation can be counted. */
function surfaceFactory(): { create: () => IndicatorSurface; made: FakeSurface[] } {
  const made: FakeSurface[] = [];
  return {
    made,
    create: () => {
      const surface = new FakeSurface();
      made.push(surface);
      return surface;
    },
  };
}

describe("IndicatorController", () => {
  it("puts an indicator on screen as soon as collection is running", () => {
    const factory = surfaceFactory();
    const controller = new IndicatorController(factory.create);

    controller.apply(status());

    expect(factory.made).toHaveLength(1);
    expect(factory.made[0]?.isVisible()).toBe(true);
  });

  // An indicator over an agent that is collecting nothing is its own compliance
  // failure: it tells the employee they are being recorded when they are not.
  it("creates nothing at all while collection is stopped", () => {
    const factory = surfaceFactory();
    const controller = new IndicatorController(factory.create);

    controller.apply(status({ enrolled: false, collecting: false }));

    expect(factory.made).toHaveLength(0);
  });

  // `apply` runs on every published status — every five seconds while collecting.
  // Building a window each time would flicker over the employee's work all day.
  it("reuses the one window across repeated status updates", () => {
    const factory = surfaceFactory();
    const controller = new IndicatorController(factory.create);

    controller.apply(status());
    controller.apply(status());
    controller.apply(status());

    expect(factory.made).toHaveLength(1);
  });

  it("takes the indicator off screen the moment collection stops", () => {
    const factory = surfaceFactory();
    const controller = new IndicatorController(factory.create);

    controller.apply(status());
    controller.apply(status({ collecting: true, onBreak: true }));

    expect(factory.made[0]?.isVisible()).toBe(false);
  });

  // The whole point of the window: an employee who finds a way to close it — or an
  // OS gesture, or another app — gets it back on the next published status, and the
  // agent is never collecting behind a dismissed indicator for longer than one tick.
  it("puts the indicator back after something hides it", () => {
    const factory = surfaceFactory();
    const controller = new IndicatorController(factory.create);

    controller.apply(status());
    factory.made[0]?.hide();
    controller.apply(status());

    expect(factory.made[0]?.isVisible()).toBe(true);
  });

  // A renderer crash or a stray `destroy()` leaves a dead window behind. Calling
  // `show()` on one throws in Electron, and that throw would surface inside the
  // collection tick — so the indicator is rebuilt rather than resurrected.
  it("rebuilds the indicator after its window is destroyed", () => {
    const factory = surfaceFactory();
    const controller = new IndicatorController(factory.create);

    controller.apply(status());
    factory.made[0]?.destroy();
    controller.apply(status());

    expect(factory.made).toHaveLength(2);
    expect(factory.made[1]?.isVisible()).toBe(true);
  });

  // An always-on-top, click-through window that outlived the agent would keep
  // claiming monitoring over a machine that is no longer being monitored, and the
  // employee has no way to close it.
  it("tears the window down when the agent shuts down", () => {
    const factory = surfaceFactory();
    const controller = new IndicatorController(factory.create);

    controller.apply(status());
    controller.dispose();

    expect(factory.made[0]?.isAlive()).toBe(false);
  });

  // `apply` is called from the status publisher, which the collection tick drives.
  // A throw from here is swallowed by the tick's catch and logged every five seconds
  // while the agent carries on collecting behind nothing — the precise outcome
  // non-negotiable #2 forbids. It is handed to the caller as a decision instead.
  it("reports a window it could not create instead of throwing into the collection loop", () => {
    const failures: unknown[] = [];
    const controller = new IndicatorController(
      () => {
        throw new Error("no display available");
      },
      { onUnavailable: (error) => failures.push(error) },
    );

    const state = controller.apply(status());

    expect(state.visible).toBe(true);
    expect(failures).toHaveLength(1);
  });
});

/** A loaded image, reduced to the two things the tray fix cares about. */
class FakeTrayImage {
  template = false;

  constructor(private readonly empty: boolean) {}

  isEmpty(): boolean {
    return this.empty;
  }

  setTemplateImage(value: boolean): void {
    this.template = value;
  }
}

class FakeImageLoader {
  readonly paths: string[] = [];
  readonly loaded: FakeTrayImage[] = [];

  constructor(private readonly empty = false) {}

  createFromPath(path: string): FakeTrayImage {
    this.paths.push(path);
    const image = new FakeTrayImage(this.empty);
    this.loaded.push(image);
    return image;
  }
}

describe("loadTrayImage", () => {
  // A menu-bar icon that is not a template image keeps its own colours, so it does
  // not invert for a dark menu bar or for the clicked state — the exact way the
  // "permanent tray icon" of non-negotiable #2 becomes unreadable on macOS.
  it("marks the macOS menu-bar image as a template image", () => {
    const loader = new FakeImageLoader();

    const image = loadTrayImage(loader, "/Applications/AEMS.app", "darwin");

    expect((image as FakeTrayImage).template).toBe(true);
  });

  // A template image is black plus alpha; AppKit inverts it, the Windows taskbar
  // does not. Marking it there would put a black blob in the notification area.
  it("leaves the Windows image alone", () => {
    const loader = new FakeImageLoader();

    const image = loadTrayImage(loader, "C:\\Program Files\\AEMS", "win32");

    expect((image as FakeTrayImage).template).toBe(false);
  });

  // `nativeImage.createFromPath` answers a missing or unreadable file with an empty
  // 0x0 image rather than an error, and `new Tray(empty)` accepts it — verified on
  // Electron 43. Left alone, a packaging mistake produces an agent collecting behind
  // a zero-size, invisible tray icon. Raising here is what arms index.ts's existing
  // refuse-to-collect-without-an-indicator guard.
  it("refuses an image the OS could not actually load", () => {
    const loader = new FakeImageLoader(true);

    expect(() => loadTrayImage(loader, "/Applications/AEMS.app", "darwin")).toThrow(
      /tray icon/i,
    );
  });

  // `resources/**/*` is what electron-builder ships; reading from anywhere else
  // produces an icon that loads in the checkout and is missing in the installer.
  it("reads the icon out of the packaged resources directory", () => {
    const loader = new FakeImageLoader();

    loadTrayImage(loader, "/Applications/AEMS.app", "darwin");

    expect(loader.paths[0]).toBe(join("/Applications/AEMS.app", "resources", "tray.png"));
  });
});

describe("isIndicatorRoute", () => {
  // Main builds the indicator window's URL from INDICATOR_HASH and the renderer
  // entry reads it back. One constant, so a rename cannot leave the indicator
  // window rendering the full agent UI at 200x40 pixels.
  it("recognises the hash the indicator window is loaded with, and nothing else", () => {
    expect(isIndicatorRoute(INDICATOR_HASH)).toBe(true);
    expect(isIndicatorRoute("")).toBe(false);
    expect(isIndicatorRoute("#status")).toBe(false);
  });
});

describe("indicatorBounds", () => {
  // Anchored to the work area rather than to the screen: the work area already
  // excludes the taskbar and the Dock, so the pill never sits under either.
  it("parks the pill inside the bottom-right corner of the work area", () => {
    const bounds = indicatorBounds({ x: 0, y: 0, width: 1920, height: 1040 }, INDICATOR_SIZE);

    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1920);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1040);
    expect(bounds.x).toBeGreaterThan(1920 / 2);
    expect(bounds.y).toBeGreaterThan(1040 / 2);
  });

  // A second monitor to the left has a negative origin and the macOS menu bar pushes
  // the primary one down. Ignoring the origin puts the indicator on another screen or
  // off the desktop entirely, which is the same outcome as having no indicator.
  it("follows a display whose work area does not start at the origin", () => {
    const bounds = indicatorBounds({ x: -1920, y: 25, width: 1920, height: 1055 }, INDICATOR_SIZE);

    expect(bounds.x).toBe(-1920 + 1920 - INDICATOR_SIZE.width - INDICATOR_MARGIN);
    expect(bounds.y).toBe(25 + 1055 - INDICATOR_SIZE.height - INDICATOR_MARGIN);
  });
});
