import type {
  ActivityBatch,
  ActivityBatchResult,
  ActivityEventInput,
  BreakEventInput,
  HeartbeatInput,
  IdleEventInput,
  ScreenshotUploadResult,
} from "@aems/types";

import type { CapturedScreenshot } from "./screenshot.js";
import { screenshotFormData } from "./screenshot.js";

/** The API caps each array in a batch at 1000; a larger flush is rejected as invalid. */
export const MAX_EVENTS_PER_BATCH = 1000;

/**
 * The slice of `AemsClient` the queue actually uses.
 *
 * Narrowed to an interface so tests can substitute a fake that fails on demand;
 * `AemsClient` satisfies it structurally, so `new SyncQueue(client, id)` still compiles
 * at the call site in `index.ts`.
 */
export interface SyncApiClient {
  ingestActivity(batch: ActivityBatch): Promise<ActivityBatchResult>;
  uploadScreenshot(form: FormData): Promise<ScreenshotUploadResult>;
  heartbeat(body: HeartbeatInput): Promise<{ ok: true }>;
}

/**
 * What the caller should do next.
 *
 * The split is the whole point: `retry` keeps the buffer, `dropped` discards a batch
 * the server will never accept, and the two stop signals halt collection. Classify
 * on `AemsApiError.code`, never by substring-matching the response body.
 */
export type SyncOutcome = "sent" | "empty" | "retry" | "dropped" | "consent-required" | "revoked";

/**
 * Maps a thrown error onto an outcome.
 *
 * `consent_required` → consent-required, `device_revoked` / `monitoring_disabled` →
 * revoked, network and 5xx → retry, other 4xx → dropped. Without the last one a
 * single malformed event poisons the buffer permanently, because the same payload
 * is retried forever.
 */
export function classifyError(error: unknown): SyncOutcome {
  const { statusCode, code } = apiErrorFields(error);

  if (code === "consent_required") return "consent-required";
  if (code === "device_revoked" || code === "monitoring_disabled") return "revoked";

  // A rejected token is not a bad batch: the signature is invalid, the devices row is
  // gone, or local state disagrees with the token. Every one of those needs a
  // re-enrolment, and no amount of resending fixes it.
  if (statusCode === 401) return "revoked";

  // No status means the request never reached the API — DNS, a dropped Wi-Fi link, a
  // timeout. Nothing about the payload is wrong, so it is kept.
  if (statusCode === null) return "retry";
  if (statusCode >= 500) return "retry";

  return "dropped";
}

/**
 * Reads `AemsApiError`'s two useful fields structurally.
 *
 * Not `instanceof`: the SDK can be loaded twice (ESM build plus a bundled copy) and a
 * cross-realm error would then classify as a network fault and retry forever.
 */
function apiErrorFields(error: unknown): {
  statusCode: number | null;
  code: string | null;
} {
  if (typeof error !== "object" || error === null) return { statusCode: null, code: null };

  const { statusCode, code } = error as {
    statusCode?: unknown;
    code?: unknown;
  };
  return {
    statusCode: typeof statusCode === "number" ? statusCode : null,
    code: typeof code === "string" ? code : null,
  };
}

/** Which buffer overflowed, so the log line names it. */
export type SyncBufferKind = "activity" | "idle" | "breaks" | "screenshots";

export interface SyncQueueOptions {
  /** Ceiling per event kind. A laptop offline for a week must not exhaust the heap. */
  maxBufferedEvents?: number;
  /** Screenshots are megabytes apiece, so they get a far lower ceiling than events. */
  maxBufferedScreenshots?: number;
  /**
   * Told how many of the oldest items were evicted.
   *
   * Dropping data silently is the one thing a monitoring agent must not do — an
   * unexplained gap in someone's timeline looks like they stopped working.
   */
  onOverflow?: (dropped: number, kind: SyncBufferKind) => void;
}

/** Roughly a day of 5-second sampling per kind, which outlasts any realistic outage. */
const DEFAULT_MAX_BUFFERED_EVENTS = 20_000;
const DEFAULT_MAX_BUFFERED_SCREENSHOTS = 60;

/**
 * Holds observed events until the API confirms it stored them.
 *
 * Every event carries a stable `clientEventId`, which is what makes a retry safe —
 * the API upserts on `(device_id, client_event_id)`. Removal after a successful
 * flush must be by id, not by clearing the buffer: events appended while the request
 * was in flight would otherwise be destroyed unsent.
 */
export class SyncQueue {
  private readonly activity: ActivityEventInput[] = [];
  private readonly idle: IdleEventInput[] = [];
  private readonly breaks: BreakEventInput[] = [];
  private readonly screenshots: CapturedScreenshot[] = [];
  /**
   * Every id currently buffered, across all four kinds.
   *
   * The API upserts one row at a time but does not deduplicate the array it receives,
   * so a batch carrying the same id twice fails as a whole and takes every other event
   * in it down with it.
   */
  private readonly bufferedIds = new Set<string>();
  private lastSync: string | null = null;

  private readonly maxEvents: number;
  private readonly maxScreenshots: number;

  constructor(
    private readonly client: SyncApiClient,
    private readonly deviceId: string,
    private readonly options: SyncQueueOptions = {},
  ) {
    this.maxEvents = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    this.maxScreenshots = options.maxBufferedScreenshots ?? DEFAULT_MAX_BUFFERED_SCREENSHOTS;
  }

  get pending(): number {
    return this.activity.length + this.idle.length + this.breaks.length + this.screenshots.length;
  }

  /** Last time the API confirmed a batch, not the last time a flush was attempted. */
  get lastSyncAt(): string | null {
    return this.lastSync;
  }

  enqueueActivity(event: ActivityEventInput): void {
    this.append(this.activity, event, this.maxEvents, "activity");
  }

  enqueueIdle(event: IdleEventInput): void {
    this.append(this.idle, event, this.maxEvents, "idle");
  }

  enqueueBreak(event: BreakEventInput): void {
    this.append(this.breaks, event, this.maxEvents, "breaks");
  }

  enqueueScreenshot(shot: CapturedScreenshot): void {
    this.append(this.screenshots, shot, this.maxScreenshots, "screenshots");
  }

  /**
   * Appends, evicting the oldest once the ceiling is reached.
   *
   * Oldest-first because the recent past is the part a manager is looking at, and
   * because the alternative — refusing new events — would freeze the timeline at the
   * moment the network died instead of at the moment it came back.
   */
  private append<T extends { clientEventId: string }>(
    buffer: T[],
    event: T,
    limit: number,
    kind: SyncBufferKind,
  ): void {
    if (this.bufferedIds.has(event.clientEventId)) return;

    this.bufferedIds.add(event.clientEventId);
    buffer.push(event);
    if (buffer.length <= limit) return;

    const evicted = buffer.splice(0, buffer.length - limit);
    for (const lost of evicted) this.bufferedIds.delete(lost.clientEventId);
    this.options.onOverflow?.(evicted.length, kind);
  }

  /**
   * Sends one bounded slice and removes it only once the API has taken it.
   *
   * `now` is a parameter so the caller's clock is the only clock; nothing here reads
   * the wall time.
   */
  async flush(workSessionId: number | null, now: Date = new Date()): Promise<SyncOutcome> {
    if (this.pending === 0) return "empty";

    const events = await this.flushEvents(workSessionId);
    if (events !== null && events !== "sent") return events;

    const shots = await this.flushScreenshots();
    if (shots !== null && shots !== "sent") return shots;

    this.lastSync = now.toISOString();
    return "sent";
  }

  /**
   * Reports the device as alive, independently of whether anything is being collected.
   *
   * `last_seen_at` is what drives online/idle/offline in the dashboard, and the route
   * has no consent gate — so an enrolled but unconsented device must keep heartbeating
   * rather than appearing to have vanished.
   */
  async heartbeat(workSessionId: number | null): Promise<SyncOutcome> {
    try {
      await this.client.heartbeat({ deviceId: this.deviceId, workSessionId });
    } catch (error) {
      return classifyError(error);
    }

    return "sent";
  }

  /** Returns null when there was nothing of this kind to send. */
  private async flushEvents(workSessionId: number | null): Promise<SyncOutcome | null> {
    const activity = this.activity.slice(0, MAX_EVENTS_PER_BATCH);
    const idle = this.idle.slice(0, MAX_EVENTS_PER_BATCH);
    const breaks = this.breaks.slice(0, MAX_EVENTS_PER_BATCH);

    if (activity.length === 0 && idle.length === 0 && breaks.length === 0) return null;

    try {
      await this.client.ingestActivity({
        deviceId: this.deviceId,
        workSessionId,
        activity,
        idle,
        breaks,
      });
    } catch (error) {
      const outcome = classifyError(error);

      // A body the API rejects as invalid will never become valid, so it leaves the
      // queue on the failure path as well. Keeping it would mean every later flush
      // resends the same rejected slice and nothing after it ever ships.
      if (outcome === "dropped") this.removeBatch(activity, idle, breaks);

      return outcome;
    }

    this.removeBatch(activity, idle, breaks);
    return "sent";
  }

  /**
   * Uploads one screenshot per request, dropping each as it lands.
   *
   * Sequential rather than parallel: these are multipart megabytes off a laptop
   * uplink, and a burst of them competes with the employee's own bandwidth.
   */
  private async flushScreenshots(): Promise<SyncOutcome | null> {
    if (this.screenshots.length === 0) return null;

    for (const shot of [...this.screenshots]) {
      try {
        // The session id was stamped on the frame at capture time, so a shot buffered
        // across a clock-out still lands inside the session it was taken in.
        await this.client.uploadScreenshot(screenshotFormData(shot));
      } catch (error) {
        const outcome = classifyError(error);
        // An unsupported format or an over-size frame is a capture bug, not a network
        // one — re-encoding is the fix, and resending the same bytes never works.
        if (outcome === "dropped") this.removeSent(this.screenshots, [shot]);
        return outcome;
      }

      this.removeSent(this.screenshots, [shot]);
    }

    return "sent";
  }

  private removeBatch(
    activity: readonly ActivityEventInput[],
    idle: readonly IdleEventInput[],
    breaks: readonly BreakEventInput[],
  ): void {
    this.removeSent(this.activity, activity);
    this.removeSent(this.idle, idle);
    this.removeSent(this.breaks, breaks);
  }

  /**
   * Removes exactly what was sent, leaving the rest of the buffer alone.
   *
   * Clearing the buffer instead would destroy anything the tracker observed while the
   * request was in flight — the `await` yields, and the collection loop keeps running.
   */
  private removeSent<T extends { clientEventId: string }>(buffer: T[], sent: readonly T[]): void {
    if (sent.length === 0) return;

    const sentIds = new Set(sent.map((event) => event.clientEventId));
    const kept = buffer.filter((event) => !sentIds.has(event.clientEventId));

    buffer.length = 0;
    for (const event of kept) buffer.push(event);
    for (const id of sentIds) this.bufferedIds.delete(id);
  }

  /**
   * Drops everything buffered.
   *
   * Called on a stop signal: revocation is immediate, so data collected in the window
   * before the server said stop must not be re-sent once consent returns.
   */
  discard(): void {
    this.activity.length = 0;
    this.idle.length = 0;
    this.breaks.length = 0;
    this.screenshots.length = 0;
    this.bufferedIds.clear();
  }
}
