import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import type { ScreenshotMetadataInput } from "@aems/types";

import type { AgentConfig } from "../shared/types/index.js";
import { mayCollect } from "../shared/types/index.js";

export interface CapturedScreenshot extends ScreenshotMetadataInput {
  /** Which monitor the frame came from, so the timeline can label multi-monitor captures. */
  displayId: string;
  /** JPEG bytes. Electron's `nativeImage` encodes natively, so no image library is involved. */
  image: Buffer;
}

/** One display's frame, before the scheduler stamps the wire metadata onto it. */
export interface CapturedFrame {
  displayId: string;
  image: Buffer;
}

/**
 * The OS-facing half of capture, injected so the schedule and the consent gate can
 * be tested without a display, an Electron runtime or a Screen Recording grant.
 */
export interface Capturer {
  capture(quality: number): Promise<CapturedFrame[]>;
}

/**
 * JPEG quality for uploads.
 *
 * These leave employee laptops on home broadband, several times an hour, on every
 * monitor. PNG is lossless and a full-resolution desktop runs to several megabytes —
 * a bandwidth cost the employee pays, and a fast route to the API's 10 MB per-file
 * limit. WebP would be smaller still, but `nativeImage` only encodes PNG and JPEG,
 * and pulling in an image library to save a few kilobytes is not worth the native
 * dependency. 60 keeps window text and code legible in review while landing a 1080p
 * desktop in the low hundreds of kilobytes.
 */
export const SCREENSHOT_QUALITY = 60;

/**
 * Widest frame we ask the compositor for.
 *
 * A 4K desktop encodes to roughly four times the bytes of the same frame at 1920,
 * for detail nobody reads back on a timeline.
 */
export const MAX_CAPTURE_WIDTH = 1920;

/** Cadence for a policy that arrived without one. Scope §2.3 lists 1/5/10/15/30 min. */
export const DEFAULT_INTERVAL_SECONDS = 300;

/**
 * Whether the next capture is owed, given when the last one happened.
 *
 * Pure and clock-free so the cadence — including the boundaries, a policy change and
 * a clock that jumps — is testable without waiting for real minutes to pass.
 */
export function isCaptureDue(
  lastCaptureAt: Date | null,
  intervalSeconds: number,
  now: Date,
): boolean {
  // A policy that says "every N minutes" is what the employee consented to, so a
  // malformed interval must fail towards fewer captures, never towards a flood.
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return false;

  if (lastCaptureAt === null) return true;

  const elapsedMs = now.getTime() - lastCaptureAt.getTime();

  // Sleep/resume and NTP corrections move the wall clock backwards. Waiting for it
  // to catch up would silently suspend capture for however far it jumped, so a
  // negative gap re-bases the schedule on the next tick instead.
  if (elapsedMs < 0) return true;

  return elapsedMs >= intervalSeconds * 1000;
}

export interface DisplayGeometry {
  size: { width: number; height: number };
  scaleFactor: number;
}

/**
 * The single `thumbnailSize` every source is captured at.
 *
 * `desktopCapturer.getSources` takes one size for all displays, so it has to bound
 * the largest of them in physical pixels — asking for logical pixels downsamples a
 * HiDPI screen until text stops being readable. The result is a request, not a
 * guarantee: real dimensions still have to be read back off each `NativeImage`.
 */
export function captureSize(
  displays: readonly DisplayGeometry[],
  maxWidth: number,
): { width: number; height: number } {
  const physical = displays.reduce(
    (largest, display) => ({
      width: Math.max(largest.width, Math.round(display.size.width * display.scaleFactor)),
      height: Math.max(largest.height, Math.round(display.size.height * display.scaleFactor)),
    }),
    { width: 0, height: 0 },
  );

  if (physical.width <= maxWidth) return physical;

  // Ask the compositor for the smaller frame rather than encoding a 4K one and
  // resizing after — a quarter of the pixels is roughly a quarter of the upload.
  const scale = maxWidth / physical.width;
  return { width: maxWidth, height: Math.round(physical.height * scale) };
}

/**
 * Pairs a `desktopCapturer` source with a display from the Screen API.
 *
 * `DesktopCapturerSource.display_id` is a string while `Display.id` is a number, and
 * it is empty when the platform cannot report it. An empty id is a match failure —
 * falling back to positional order would silently label one monitor's frames as
 * another's, which is worse than dropping the frame.
 */
export function matchSourceToDisplay<T extends { display_id: string }>(
  sources: readonly T[],
  displayId: number,
): T | null {
  const wanted = String(displayId);
  return sources.find((source) => source.display_id !== "" && source.display_id === wanted) ?? null;
}

/**
 * Builds the multipart body for `POST /api/screenshots`.
 *
 * Field order is not cosmetic: the route reads `file.fields` before draining the
 * file stream, so anything appended after the file part is invisible to it. That is
 * why the body is assembled here, next to the frame, rather than from loose arguments
 * inside the SDK where the ordering rule would be invisible.
 */
export function screenshotFormData(shot: CapturedScreenshot): FormData {
  const form = new FormData();

  // Stable across every retry of this frame — it is what stops a re-sent upload
  // from becoming a second row.
  form.append("clientEventId", shot.clientEventId);
  form.append("capturedAt", shot.capturedAt);

  // Without it the timeline cannot place a shot inside the session it belongs to.
  if (shot.workSessionId !== undefined && shot.workSessionId !== null) {
    form.append("workSessionId", String(shot.workSessionId));
  }

  // The route parses this with `z.coerce.boolean()`, where the string "false" is
  // truthy. Absence is the only way to say false.
  if (shot.blurred === true) form.append("blurred", "true");

  form.append("file", new Blob([shot.image], { type: "image/jpeg" }), "screenshot.jpg");
  return form;
}

export interface CaptureContext {
  config: AgentConfig;
  /**
   * Windows hands back black frames on a locked or RDP-disconnected session, and a
   * timeline of black rectangles is worse than an honest gap. Skipping leaves the
   * schedule untouched, so the first capture lands as soon as the screen is back.
   */
  sessionLocked?: boolean;
  /**
   * Stamped onto the frame at capture time rather than at upload time: a shot that
   * sits in the buffer across a clock-out still belongs to the session it was taken in.
   */
  workSessionId?: number | null;
}

/**
 * Decides when a capture happens and turns each display's frame into an uploadable
 * event. Holds the schedule only — the frames themselves come from the `Capturer`.
 */
export class ScreenshotScheduler {
  private lastCaptureAt: Date | null = null;

  constructor(private readonly capturer: Capturer) {}

  /**
   * Rejects if the capture itself fails. A lapsed macOS Screen Recording grant is
   * indistinguishable from an idle employee unless somebody is told about it, so
   * the failure is raised rather than swallowed into an empty array.
   */
  async tick(context: CaptureContext, now: Date): Promise<CapturedScreenshot[]> {
    // Re-read on every tick rather than caching: consent withdrawn from the
    // dashboard, a revoked device or a policy bump must stop capture without a restart.
    if (!mayCollect(context.config)) return [];
    if (context.sessionLocked === true) return [];

    const interval = context.config.policy?.screenshotIntervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
    if (!isCaptureDue(this.lastCaptureAt, interval, now)) return [];

    // Consume the interval before the attempt, not after it: a capturer that fails
    // every time would otherwise be retried on every tick of the collection loop.
    this.lastCaptureAt = now;

    const frames = await this.capturer.capture(SCREENSHOT_QUALITY);
    const capturedAt = now.toISOString();

    // The id is minted here, at observation time, and travels with the buffered
    // frame — a retry must present the same one or the API stores the shot twice.
    return frames.map((frame) => ({
      ...frame,
      clientEventId: randomUUID(),
      capturedAt,
      workSessionId: context.workSessionId ?? null,
    }));
  }
}

// Electron is loaded lazily so this module can be imported — and its schedule and
// consent gate exercised — in a plain Node process with no Electron runtime.
const requireElectron = createRequire(import.meta.url);

/** The real capturer. `desktopCapturer` is main-process only, which is where this runs. */
export class ElectronCapturer implements Capturer {
  async capture(quality: number): Promise<CapturedFrame[]> {
    const { desktopCapturer, screen } = requireElectron("electron") as typeof import("electron");

    const displays = screen.getAllDisplays();
    if (displays.length === 0) return [];

    // One call returns every monitor, which is what scope §2.3 asks for — and also
    // means a single display cannot be captured cheaply on its own.
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: captureSize(displays, MAX_CAPTURE_WIDTH),
    });

    const frames: CapturedFrame[] = [];

    for (const display of displays) {
      const source = matchSourceToDisplay(sources, display.id);
      if (!source || source.thumbnail.isEmpty()) continue;

      frames.push({
        displayId: String(display.id),
        image: source.thumbnail.toJPEG(quality),
      });
    }

    return frames;
  }
}

/**
 * Captures every display, one uploadable event each.
 *
 * Prefer `ScreenshotScheduler` in the collection loop — it owns the cadence and the
 * consent gate. This is the one-shot form, and it reads the clock, so it is only
 * correct where the caller has already established that collection is permitted.
 */
export async function captureAllDisplays(
  quality: number = SCREENSHOT_QUALITY,
): Promise<CapturedScreenshot[]> {
  const frames = await new ElectronCapturer().capture(quality);
  const capturedAt = new Date().toISOString();

  return frames.map((frame) => ({
    ...frame,
    clientEventId: randomUUID(),
    capturedAt,
  }));
}
