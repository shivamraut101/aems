import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../shared/types/index.js";
import { emptyConfig } from "../shared/types/index.js";
import type { CapturedFrame, CapturedScreenshot, Capturer } from "./screenshot.js";
import {
  ScreenshotScheduler,
  captureSize,
  isCaptureDue,
  matchSourceToDisplay,
  screenshotFormData,
} from "./screenshot.js";

const EPOCH = Date.parse("2026-08-05T09:00:00.000Z");

/** Offsets from a fixed instant, so nothing here depends on the wall clock. */
function at(seconds: number): Date {
  return new Date(EPOCH + seconds * 1000);
}

/** A config that passes `mayCollect`, so gate tests only vary the field under test. */
function consented(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...emptyConfig("http://localhost:3001"),
    deviceId: "11111111-1111-4111-8111-111111111111",
    deviceToken: "device-token",
    consentedPolicyVersion: "2026-01",
    policy: {
      version: "2026-01",
      name: "Standard",
      screenshotIntervalSeconds: 300,
      idleThresholdSeconds: 120,
      trackedCategories: [],
    },
    ...overrides,
  };
}

class FakeCapturer implements Capturer {
  calls = 0;

  constructor(private readonly frames: CapturedFrame[]) {}

  capture(): Promise<CapturedFrame[]> {
    this.calls += 1;
    return Promise.resolve(this.frames);
  }
}

function frame(displayId: string): CapturedFrame {
  return { displayId, image: Buffer.from(`frame-${displayId}`) };
}

describe("isCaptureDue", () => {
  it("captures immediately when nothing has been captured yet", () => {
    expect(isCaptureDue(null, 300, at(0))).toBe(true);
  });

  it("does not capture before the interval has elapsed", () => {
    expect(isCaptureDue(at(0), 300, at(299))).toBe(false);
  });

  it("captures on the interval boundary rather than a tick later", () => {
    expect(isCaptureDue(at(0), 300, at(300))).toBe(true);
  });

  it("treats a non-positive interval as capture disabled rather than capture always", () => {
    expect(isCaptureDue(null, 0, at(0))).toBe(false);
    expect(isCaptureDue(at(0), -60, at(1))).toBe(false);
  });

  it("does not stall for hours when the system clock jumps backwards", () => {
    expect(isCaptureDue(at(3600), 300, at(0))).toBe(true);
  });
});

describe("ScreenshotScheduler", () => {
  it("captures nothing while consent is absent", async () => {
    const capturer = new FakeCapturer([frame("1")]);
    const scheduler = new ScreenshotScheduler(capturer);

    const shots = await scheduler.tick(
      { config: consented({ consentedPolicyVersion: null }) },
      at(0),
    );

    expect(shots).toEqual([]);
    expect(capturer.calls).toBe(0);
  });

  it("turns every display into its own uploadable event stamped with the tick time", async () => {
    const capturer = new FakeCapturer([frame("1"), frame("2")]);
    const scheduler = new ScreenshotScheduler(capturer);

    const shots = await scheduler.tick({ config: consented() }, at(0));

    expect(shots.map((shot) => shot.displayId)).toEqual(["1", "2"]);
    expect(shots.map((shot) => shot.capturedAt)).toEqual([
      at(0).toISOString(),
      at(0).toISOString(),
    ]);
    expect(shots[0]?.clientEventId).not.toBe(shots[1]?.clientEventId);
  });

  it("does not capture again until the policy interval has elapsed", async () => {
    const capturer = new FakeCapturer([frame("1")]);
    const scheduler = new ScreenshotScheduler(capturer);
    const config = consented();

    await scheduler.tick({ config }, at(0));
    const shots = await scheduler.tick({ config }, at(299));

    expect(shots).toEqual([]);
    expect(capturer.calls).toBe(1);
  });

  it("honours a shortened interval on the next tick, without a restart", async () => {
    const capturer = new FakeCapturer([frame("1")]);
    const scheduler = new ScreenshotScheduler(capturer);

    await scheduler.tick({ config: consented() }, at(0));

    const tightened = consented({
      consentedPolicyVersion: "2026-02",
      policy: {
        version: "2026-02",
        name: "Standard",
        screenshotIntervalSeconds: 60,
        idleThresholdSeconds: 120,
        trackedCategories: [],
      },
    });
    const shots = await scheduler.tick({ config: tightened }, at(60));

    expect(shots).toHaveLength(1);
  });

  it("surfaces a capture failure but still consumes the interval", async () => {
    const capturer: Capturer = {
      capture: () => Promise.reject(new Error("screen recording not granted")),
    };
    const scheduler = new ScreenshotScheduler(capturer);
    const config = consented();

    await expect(scheduler.tick({ config }, at(0))).rejects.toThrow("screen recording not granted");
    await expect(scheduler.tick({ config }, at(5))).resolves.toEqual([]);
  });

  it("skips a locked session instead of uploading a black frame", async () => {
    const capturer = new FakeCapturer([frame("1")]);
    const scheduler = new ScreenshotScheduler(capturer);
    const config = consented();

    const locked = await scheduler.tick({ config, sessionLocked: true }, at(0));
    const unlocked = await scheduler.tick({ config, sessionLocked: false }, at(5));

    expect(locked).toEqual([]);
    expect(capturer.calls).toBe(1);
    expect(unlocked).toHaveLength(1);
  });
});

describe("screenshotFormData", () => {
  const shot: CapturedScreenshot = {
    displayId: "1",
    image: Buffer.from("jpeg-bytes"),
    clientEventId: "44444444-4444-4444-8444-444444444444",
    capturedAt: at(0).toISOString(),
  };

  it("appends every text field ahead of the file part", () => {
    const form = screenshotFormData(shot);

    expect([...form.keys()]).toEqual(["clientEventId", "capturedAt", "file"]);
    expect(form.get("clientEventId")).toBe(shot.clientEventId);
    expect((form.get("file") as File).type).toBe("image/jpeg");
  });

  it("omits blurred when false, because the API coerces the string 'false' to true", () => {
    expect(screenshotFormData({ ...shot, blurred: false }).has("blurred")).toBe(false);
    expect(screenshotFormData({ ...shot, blurred: true }).get("blurred")).toBe("true");
  });

  it("links the shot to the open work session, still ahead of the file part", () => {
    const form = screenshotFormData({ ...shot, workSessionId: 42 });

    expect([...form.keys()]).toEqual(["clientEventId", "capturedAt", "workSessionId", "file"]);
    expect(form.get("workSessionId")).toBe("42");
    expect(screenshotFormData({ ...shot, workSessionId: null }).has("workSessionId")).toBe(false);
  });
});

describe("matchSourceToDisplay", () => {
  it("refuses a source with no display id rather than capturing the wrong monitor", () => {
    const sources = [{ display_id: "" }, { display_id: "2" }];

    expect(matchSourceToDisplay(sources, 2)).toBe(sources[1]);
    expect(matchSourceToDisplay(sources, 1)).toBeNull();
  });
});

describe("captureSize", () => {
  it("sizes the request to the largest display in physical pixels", () => {
    const displays = [
      { size: { width: 1280, height: 800 }, scaleFactor: 1 },
      { size: { width: 756, height: 491 }, scaleFactor: 2 },
    ];

    expect(captureSize(displays, 4096)).toEqual({ width: 1512, height: 982 });
  });

  it("scales a 4K desktop down to the bandwidth cap, keeping the aspect ratio", () => {
    const displays = [{ size: { width: 3840, height: 2160 }, scaleFactor: 1 }];

    expect(captureSize(displays, 1920)).toEqual({ width: 1920, height: 1080 });
  });
});
