import type {
  ActivityBatch,
  ActivityBatchResult,
  HeartbeatInput,
  WebsiteBlockEventsInput,
  HeartbeatResponse,
  ScreenshotUploadResult,
} from "@aems/types";
import { describe, expect, it } from "vitest";

import { DeadLetterFile } from "./dead-letter.js";
import type { DurableFs } from "./persistence.js";
import { EventJournal } from "./persistence.js";
import type { CapturedScreenshot } from "./screenshot.js";
import { MAX_EVENTS_PER_BATCH, SyncQueue, classifyError } from "./sync.js";

/**
 * Stands in for `AemsApiError`.
 *
 * The SDK cannot be imported as a value here: the repo's vitest alias rewrites every
 * relative `.js` specifier to `.ts`, including the one inside the SDK's own compiled
 * `dist/index.js`. Building the same `{ statusCode, code }` shape by hand also proves
 * the classifier reads fields rather than relying on `instanceof`.
 */
class ApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "AemsApiError";
  }
}

const DEVICE = "33333333-3333-4333-8333-333333333333";
const T0 = new Date("2026-08-05T09:00:00.000Z");

interface UploadCall {
  clientEventId: string;
  capturedAt: string;
  /** Read back off the multipart body, so a field lost on the way is visible here. */
  workSessionId: ReturnType<FormData["get"]>;
  bytes: number;
}

/** No network, no timers — every failure mode is set on the instance before the call. */
class FakeApi {
  readonly batches: ActivityBatch[] = [];
  readonly uploads: UploadCall[] = [];
  readonly heartbeats: HeartbeatInput[] = [];
  readonly blockReports: WebsiteBlockEventsInput[] = [];
  blockError: unknown = null;

  async reportWebsiteBlocks(
    body: WebsiteBlockEventsInput,
  ): Promise<{ accepted: number; rejected: number }> {
    if (this.blockError) throw this.blockError;
    this.blockReports.push(body);
    return { accepted: body.events.length, rejected: 0 };
  }

  ingestError: unknown = null;
  uploadError: unknown = null;
  heartbeatError: unknown = null;
  uploadResult: ScreenshotUploadResult | null = null;
  /** Runs while an ingest is in flight, so a test can observe an event mid-request. */
  duringIngest: (() => void) | null = null;

  async ingestActivity(batch: ActivityBatch): Promise<ActivityBatchResult> {
    this.batches.push(batch);
    this.duringIngest?.();
    if (this.ingestError !== null) throw this.ingestError;
    return {
      acceptedActivity: 0,
      acceptedIdle: 0,
      acceptedBreaks: 0,
      acceptedLocations: 0,
      duplicates: 0,
    };
  }

  async uploadScreenshot(form: FormData): Promise<ScreenshotUploadResult> {
    const file = form.get("file") as Blob;
    this.uploads.push({
      clientEventId: String(form.get("clientEventId")),
      capturedAt: String(form.get("capturedAt")),
      workSessionId: form.get("workSessionId"),
      bytes: file.size,
    });
    if (this.uploadError !== null) throw this.uploadError;
    return this.uploadResult ?? { screenshotId: this.uploads.length };
  }

  /** What the next heartbeat answers with, beyond `ok`. The scope arrives on this route. */
  heartbeatResponse: HeartbeatResponse = { ok: true };

  async heartbeat(body: HeartbeatInput): Promise<HeartbeatResponse> {
    this.heartbeats.push(body);
    if (this.heartbeatError !== null) throw this.heartbeatError;
    return this.heartbeatResponse;
  }
}

function activity(clientEventId: string, appName = "code") {
  return {
    clientEventId,
    appName,
    startedAt: "2026-08-05T09:00:00.000Z",
    endedAt: "2026-08-05T09:01:00.000Z",
  };
}

function idle(clientEventId: string) {
  return {
    clientEventId,
    idleStartAt: "2026-08-05T09:10:00.000Z",
    idleEndAt: "2026-08-05T09:15:00.000Z",
  };
}

function breakEvent(clientEventId: string) {
  return {
    clientEventId,
    breakStartAt: "2026-08-05T12:00:00.000Z",
    breakEndAt: "2026-08-05T12:30:00.000Z",
  };
}

function screenshot(clientEventId: string): CapturedScreenshot {
  return {
    clientEventId,
    capturedAt: "2026-08-05T09:05:00.000Z",
    displayId: "1",
    workSessionId: 12,
    image: Buffer.from("jpeg-bytes"),
  };
}

describe("classifyError", () => {
  it("treats consent_required as a stop signal rather than a retry", () => {
    expect(classifyError(new ApiError("Consent required", 403, "consent_required"))).toBe(
      "consent-required",
    );
  });

  it("treats device_revoked as terminal rather than a retry", () => {
    expect(classifyError(new ApiError("Device revoked", 403, "device_revoked"))).toBe("revoked");
  });

  it("stops on monitoring_disabled instead of hammering the API until it is re-enabled", () => {
    expect(classifyError(new ApiError("Monitoring disabled", 403, "monitoring_disabled"))).toBe(
      "revoked",
    );
  });

  it("drops a 400 rather than poisoning the buffer with a body that will never validate", () => {
    expect(classifyError(new ApiError("Invalid body", 400, "invalid_body"))).toBe("dropped");
  });

  it("retries a 5xx, because ingestion has no transaction and the batch may be half-written", () => {
    expect(classifyError(new ApiError("Something went wrong", 500, "ingest_failed"))).toBe("retry");
  });

  it("retries an offline laptop, whose fetch rejects with no status code at all", () => {
    expect(classifyError(new TypeError("fetch failed"))).toBe("retry");
  });

  it("treats a dead device token as terminal, not as one bad batch", () => {
    expect(classifyError(new ApiError("Device is not enrolled", 401, "unauthorized"))).toBe(
      "revoked",
    );
  });
});

describe("SyncQueue", () => {
  it("counts an observed event as pending until the API has acknowledged it", () => {
    const queue = new SyncQueue(new FakeApi(), DEVICE);

    queue.enqueueActivity(activity("a1"));

    expect(queue.pending).toBe(1);
  });
  it("skips the round-trip entirely when nothing has been observed", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);

    await expect(queue.flush(null, T0)).resolves.toBe("empty");
    expect(api.batches).toHaveLength(0);
  });
  it("sends what it buffered and stops counting it once the API has taken it", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueActivity(activity("a1"));

    await expect(queue.flush(7, T0)).resolves.toBe("sent");

    expect(api.batches).toHaveLength(1);
    expect(api.batches[0]?.deviceId).toBe(DEVICE);
    expect(api.batches[0]?.workSessionId).toBe(7);
    expect(api.batches[0]?.activity).toEqual([activity("a1")]);
    expect(queue.pending).toBe(0);
  });
  it("keeps the buffer when a flush fails, and resends the identical ids next time", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueActivity(activity("a1"));
    api.ingestError = new ApiError("Something went wrong", 500, "ingest_failed");

    await expect(queue.flush(null, T0)).resolves.toBe("retry");
    expect(queue.pending).toBe(1);

    api.ingestError = null;
    await expect(queue.flush(null, T0)).resolves.toBe("sent");
    expect(api.batches[1]?.activity).toEqual([activity("a1")]);
    expect(queue.pending).toBe(0);
  });
  it("does not destroy an event observed while the request was still in flight", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueActivity(activity("a1"));
    api.duringIngest = () => queue.enqueueActivity(activity("a2"));

    await expect(queue.flush(null, T0)).resolves.toBe("sent");
    expect(queue.pending).toBe(1);

    api.duringIngest = null;
    await queue.flush(null, T0);
    expect(api.batches[1]?.activity).toEqual([activity("a2")]);
  });
  it("carries idle stretches in the same batch as activity, not a second request", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueActivity(activity("a1"));
    queue.enqueueIdle(idle("i1"));

    expect(queue.pending).toBe(2);
    await expect(queue.flush(null, T0)).resolves.toBe("sent");

    expect(api.batches).toHaveLength(1);
    expect(api.batches[0]?.idle).toEqual([idle("i1")]);
    expect(queue.pending).toBe(0);
  });
  it("carries break stretches too, which scope 2.2 counts separately from idle", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueBreak(breakEvent("b1"));

    await expect(queue.flush(null, T0)).resolves.toBe("sent");

    expect(api.batches[0]?.breaks).toEqual([breakEvent("b1")]);
    expect(queue.pending).toBe(0);
  });
  it("discards the slice the API called invalid, so it cannot be retried forever", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueActivity(activity("a1"));
    api.ingestError = new ApiError("Invalid body", 400, "invalid_body");

    await expect(queue.flush(null, T0)).resolves.toBe("dropped");

    expect(queue.pending).toBe(0);
  });
  it("throws away everything on discard, so revoked data cannot resurface later", () => {
    const queue = new SyncQueue(new FakeApi(), DEVICE);
    queue.enqueueActivity(activity("a1"));
    queue.enqueueIdle(idle("i1"));
    queue.enqueueBreak(breakEvent("b1"));

    queue.discard();

    expect(queue.pending).toBe(0);
  });
  it("uploads a buffered screenshot and stops counting it once stored", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueScreenshot(screenshot("s1"));

    expect(queue.pending).toBe(1);
    await expect(queue.flush(null, T0)).resolves.toBe("sent");

    expect(api.uploads).toEqual([
      {
        clientEventId: "s1",
        capturedAt: "2026-08-05T09:05:00.000Z",
        // Stamped on the frame at capture time, so the timeline can place it inside
        // the session it was taken in.
        workSessionId: "12",
        bytes: Buffer.from("jpeg-bytes").length,
      },
    ]);
    expect(queue.pending).toBe(0);
  });
  it("stamps lastSyncAt from the caller's clock, and only when the API actually took a batch", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    expect(queue.lastSyncAt).toBeNull();

    api.ingestError = new ApiError("Something went wrong", 500, "ingest_failed");
    queue.enqueueActivity(activity("a1"));
    await queue.flush(null, T0);
    expect(queue.lastSyncAt).toBeNull();

    api.ingestError = null;
    await queue.flush(null, new Date("2026-08-05T09:30:00.000Z"));
    expect(queue.lastSyncAt).toBe("2026-08-05T09:30:00.000Z");
  });
  it("caps the buffer by dropping the oldest events, and says how many it lost", () => {
    const lost: number[] = [];
    const queue = new SyncQueue(new FakeApi(), DEVICE, {
      maxBufferedEvents: 2,
      onOverflow: (count) => lost.push(count),
    });

    queue.enqueueActivity(activity("a1"));
    queue.enqueueActivity(activity("a2"));
    queue.enqueueActivity(activity("a3"));

    expect(queue.pending).toBe(2);
    expect(lost).toEqual([1]);
  });

  it("evicts the oldest end of the buffer, keeping the most recent events", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE, { maxBufferedEvents: 2 });
    queue.enqueueActivity(activity("a1"));
    queue.enqueueActivity(activity("a2"));
    queue.enqueueActivity(activity("a3"));

    await queue.flush(null, T0);

    expect(api.batches[0]?.activity).toEqual([activity("a2"), activity("a3")]);
  });
  it("buffers a repeated clientEventId once, because the API does not dedupe within a batch", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueActivity(activity("a1"));
    queue.enqueueActivity(activity("a1"));

    expect(queue.pending).toBe(1);
    await queue.flush(null, T0);

    expect(api.batches[0]?.activity).toEqual([activity("a1")]);
  });
  it("discards buffered screenshots as well, which are the most sensitive thing held", () => {
    const queue = new SyncQueue(new FakeApi(), DEVICE);
    queue.enqueueScreenshot(screenshot("s1"));

    queue.discard();

    expect(queue.pending).toBe(0);
  });
  it("posts a heartbeat carrying the open session, so last_seen_at stays fresh", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);

    await expect(queue.heartbeat(7)).resolves.toBe("sent");

    expect(api.heartbeats).toEqual([{ deviceId: DEVICE, workSessionId: 7 }]);
    // Omitted, not sent as undefined. The API reads an absent key as "this agent did not
    // say" and leaves the browser columns alone; a present one is an answer about a
    // machine that has no bridge at all.
    expect(Object.keys(api.heartbeats[0] ?? {})).not.toContain("browserLink");
  });
  it("carries what the browser bridge left, read at the beat rather than at construction", async () => {
    const api = new FakeApi();
    let browsers = 1;
    const queue = new SyncQueue(api, DEVICE, {
      browserLink: () => ({ linked: true, extensionVersion: "0.1.0", lastSeenAt: null, browsers }),
    });

    await queue.heartbeat(null);
    browsers = 2;
    await queue.heartbeat(null);

    // A separate process writes that file, so a value captured once would report the
    // machine as it was at agent launch for the rest of the day.
    expect(api.heartbeats.map((beat) => beat.browserLink?.browsers)).toEqual([1, 2]);
  });

  /**
   * The link file is published by rename from a *different* process, so EPERM during the
   * replace window is ordinary on Windows and a quarantined file is permanent. Thrown out
   * of `heartbeat`, it would land in the collector's catch with the beat already marked
   * as sent — and revocation, withdrawn consent, a new policy and a changed collection
   * scope all arrive on the heartbeat *response*, so a file permission would switch all
   * four off while collection carried on.
   */
  it("classifies a failure reading the link file instead of throwing out of the beat", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE, {
      browserLink: () => {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      },
    });

    await expect(queue.heartbeat(null)).resolves.toBe("retry");
    expect(api.heartbeats).toEqual([]);
  });

  it("reports a revocation learned from the heartbeat, which also passes the device guard", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    api.heartbeatError = new ApiError("Device revoked", 403, "device_revoked");

    await expect(queue.heartbeat(null)).resolves.toBe("revoked");
  });

  it("keeps heartbeating through a network blip instead of treating it as a stop", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    api.heartbeatError = new TypeError("fetch failed");

    await expect(queue.heartbeat(null)).resolves.toBe("retry");
  });
  it("surfaces consent_required and keeps the buffer, since those events were consented to", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueActivity(activity("a1"));
    api.ingestError = new ApiError("Consent required", 403, "consent_required");

    await expect(queue.flush(null, T0)).resolves.toBe("consent-required");

    expect(queue.pending).toBe(1);
    expect(queue.lastSyncAt).toBeNull();
  });

  it("surfaces device_revoked so the caller can wipe the token and stop for good", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueActivity(activity("a1"));
    api.ingestError = new ApiError("Device revoked", 403, "device_revoked");

    await expect(queue.flush(null, T0)).resolves.toBe("revoked");
  });

  it("surfaces monitoring_disabled the same way, rather than looping on a 403", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueActivity(activity("a1"));
    api.ingestError = new ApiError("Monitoring disabled", 403, "monitoring_disabled");

    await expect(queue.flush(null, T0)).resolves.toBe("revoked");
  });

  it("does not stream screenshots at a server that has just said stop", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueActivity(activity("a1"));
    queue.enqueueScreenshot(screenshot("s1"));
    api.ingestError = new ApiError("Consent required", 403, "consent_required");

    await expect(queue.flush(null, T0)).resolves.toBe("consent-required");

    expect(api.uploads).toHaveLength(0);
    expect(queue.pending).toBe(2);
  });

  it("keeps a screenshot whose upload failed, so a network blip is not a lost frame", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueScreenshot(screenshot("s1"));
    api.uploadError = new TypeError("fetch failed");

    await expect(queue.flush(null, T0)).resolves.toBe("retry");

    expect(queue.pending).toBe(1);
  });

  it("drops a frame the API refuses to store, which re-uploading would never fix", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueScreenshot(screenshot("s1"));
    api.uploadError = new ApiError("Unsupported media type", 415, "unsupported_media_type");

    await expect(queue.flush(null, T0)).resolves.toBe("dropped");

    expect(queue.pending).toBe(0);
  });

  it("splits an oversized backlog into batches the API will accept", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE);
    for (let i = 0; i < MAX_EVENTS_PER_BATCH + 5; i += 1) queue.enqueueActivity(activity(`a${i}`));

    await expect(queue.flush(null, T0)).resolves.toBe("sent");
    expect(api.batches[0]?.activity).toHaveLength(MAX_EVENTS_PER_BATCH);
    expect(queue.pending).toBe(5);

    await expect(queue.flush(null, T0)).resolves.toBe("sent");
    expect(api.batches[1]?.activity).toHaveLength(5);
    expect(queue.pending).toBe(0);
  });
  it("treats a duplicate screenshot response as stored, not as a failed upload", async () => {
    const api = new FakeApi();
    api.uploadResult = { duplicate: true };
    const queue = new SyncQueue(api, DEVICE);
    queue.enqueueScreenshot(screenshot("s1"));

    await expect(queue.flush(null, T0)).resolves.toBe("sent");

    expect(queue.pending).toBe(0);
  });
});

/** An in-memory disk, so the durability rules are provable without touching a real one. */
class FakeFs implements DurableFs {
  readonly files = new Map<string, string>();
  /** Set to make every write throw, standing in for a full or read-only disk. */
  broken = false;

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  write(path: string, contents: string): void {
    if (this.broken) throw new Error("ENOSPC");
    this.files.set(path, contents);
  }

  append(path: string, contents: string): void {
    if (this.broken) throw new Error("ENOSPC");
    this.files.set(path, (this.files.get(path) ?? "") + contents);
  }

  rename(from: string, to: string): void {
    const contents = this.files.get(from);
    if (contents === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.delete(from);
    this.files.set(to, contents);
  }

  remove(path: string): void {
    this.files.delete(path);
  }
}

const JOURNAL_FILE = "/state/pending.ndjson";
const DEAD_LETTER_FILE = "/state/dead-letters.json";

describe("SyncQueue durability", () => {
  it("replays an event whose flush never happened, because it reached disk before the request", async () => {
    const fs = new FakeFs();
    const doomed = new SyncQueue(new FakeApi(), DEVICE, {
      journal: new EventJournal(fs, JOURNAL_FILE),
    });
    doomed.enqueueActivity(activity("a1"));
    doomed.enqueueIdle(idle("i1"));

    // SIGKILL. The next launch builds a fresh queue over the same journal.
    const api = new FakeApi();
    const restored = new SyncQueue(api, DEVICE, { journal: new EventJournal(fs, JOURNAL_FILE) });

    expect(restored.pending).toBe(2);
    await expect(restored.flush(7, T0)).resolves.toBe("sent");
    expect(api.batches[0]?.activity).toEqual([activity("a1")]);
    expect(api.batches[0]?.idle).toEqual([idle("i1")]);
  });

  it("does not replay an event the API already confirmed, which would double the day", async () => {
    const fs = new FakeFs();
    const queue = new SyncQueue(new FakeApi(), DEVICE, {
      journal: new EventJournal(fs, JOURNAL_FILE),
    });
    queue.enqueueActivity(activity("a1"));
    queue.enqueueActivity(activity("a2"));

    await queue.flush(null, T0);

    const restored = new SyncQueue(new FakeApi(), DEVICE, {
      journal: new EventJournal(fs, JOURNAL_FILE),
    });
    expect(restored.pending).toBe(0);
  });

  it("quarantines the batch the API called invalid, with its reason, rather than vanishing it", async () => {
    const fs = new FakeFs();
    const api = new FakeApi();
    api.ingestError = new ApiError("Invalid body", 400, "invalid_body");
    const deadLetters = new DeadLetterFile(fs, DEAD_LETTER_FILE);
    const reported: unknown[] = [];

    const queue = new SyncQueue(api, DEVICE, {
      journal: new EventJournal(fs, JOURNAL_FILE),
      deadLetters,
      onQuarantine: (dropped, kind, reason) => reported.push({ dropped, kind, reason }),
    });
    queue.enqueueActivity(activity("a1"));

    await expect(queue.flush(null, T0)).resolves.toBe("dropped");

    expect(queue.pending).toBe(0);
    expect(deadLetters.read()).toEqual([
      {
        quarantinedAt: T0.toISOString(),
        kind: "activity",
        reason: "invalid_body",
        events: [activity("a1")],
      },
    ]);
    expect(reported).toEqual([{ dropped: 1, kind: "activity", reason: "invalid_body" }]);

    // And it must not come back on the next launch, or the same 400 repeats forever.
    const restored = new SyncQueue(new FakeApi(), DEVICE, {
      journal: new EventJournal(fs, JOURNAL_FILE),
    });
    expect(restored.pending).toBe(0);
  });

  it("records a refused frame in the dead letter, but never its megabytes of pixels", async () => {
    const fs = new FakeFs();
    const api = new FakeApi();
    api.uploadError = new ApiError("Unsupported media type", 415, "unsupported_media_type");
    const deadLetters = new DeadLetterFile(fs, DEAD_LETTER_FILE);

    const queue = new SyncQueue(api, DEVICE, { deadLetters });
    queue.enqueueScreenshot(screenshot("s1"));

    await expect(queue.flush(null, T0)).resolves.toBe("dropped");

    // The metadata is what explains the gap; the frame itself is the one thing that
    // must not be copied into a plaintext file on the employee's own disk.
    expect(deadLetters.read()).toEqual([
      {
        quarantinedAt: T0.toISOString(),
        kind: "screenshots",
        reason: "unsupported_media_type",
        events: [
          {
            clientEventId: "s1",
            capturedAt: "2026-08-05T09:05:00.000Z",
            displayId: "1",
            workSessionId: 12,
          },
        ],
      },
    ]);
  });

  it("wipes the journal on discard, so revoked observations do not survive to the next launch", () => {
    const fs = new FakeFs();
    const queue = new SyncQueue(new FakeApi(), DEVICE, {
      journal: new EventJournal(fs, JOURNAL_FILE),
    });
    queue.enqueueActivity(activity("a1"));

    queue.discard();

    const restored = new SyncQueue(new FakeApi(), DEVICE, {
      journal: new EventJournal(fs, JOURNAL_FILE),
    });
    expect(restored.pending).toBe(0);
  });

  it("keeps collecting when the disk refuses the write, and reports the lost durability", async () => {
    const fs = new FakeFs();
    fs.broken = true;
    const faults: unknown[] = [];
    const api = new FakeApi();

    const queue = new SyncQueue(api, DEVICE, {
      journal: new EventJournal(fs, JOURNAL_FILE),
      onDurabilityFault: (error) => faults.push(error),
    });

    // A full disk degrades the agent to the volatile queue it was before; it must not
    // stop it observing, or one ENOSPC becomes a day with no data at all.
    queue.enqueueActivity(activity("a1"));

    expect(queue.pending).toBe(1);
    expect(faults).toHaveLength(1);
    await expect(queue.flush(null, T0)).resolves.toBe("sent");
  });

  it("remembers the last confirmed sync across a restart instead of reading 'No sync yet'", async () => {
    const stamps: string[] = [];
    const queue = new SyncQueue(new FakeApi(), DEVICE, { onSynced: (at) => stamps.push(at) });
    queue.enqueueActivity(activity("a1"));

    await queue.flush(null, T0);

    expect(stamps).toEqual([T0.toISOString()]);

    const restored = new SyncQueue(new FakeApi(), DEVICE, { lastSyncAt: stamps[0] ?? null });
    expect(restored.lastSyncAt).toBe(T0.toISOString());
  });
});

/**
 * The heartbeat as the delivery channel for this device's collection scope.
 *
 * Chosen over a route of its own because it already runs every 60 s, already re-reads
 * the device row and is already the consent-exempt channel revocation travels on — a
 * second poll for two string arrays buys nothing. Every field is optional, so an API
 * that does not send them leaves the agent collecting exactly what it collected before.
 */
describe("SyncQueue heartbeat scope delivery", () => {
  it("hands the scope and the pending set to the caller", async () => {
    const api = new FakeApi();
    const seen: HeartbeatResponse[] = [];
    const queue = new SyncQueue(api, DEVICE, { onHeartbeat: (response) => seen.push(response) });

    api.heartbeatResponse = {
      ok: true,
      collection: ["applications", "idle"],
      pendingTypes: ["screenshots"],
    };
    await queue.heartbeat(null);

    expect(seen).toEqual([
      { ok: true, collection: ["applications", "idle"], pendingTypes: ["screenshots"] },
    ]);
  });

  it("says nothing to the caller when the heartbeat never landed", async () => {
    // A network blip must not be read as "the administrator switched everything off".
    const api = new FakeApi();
    const seen: HeartbeatResponse[] = [];
    const queue = new SyncQueue(api, DEVICE, { onHeartbeat: (response) => seen.push(response) });

    api.heartbeatError = new TypeError("fetch failed");

    await expect(queue.heartbeat(null)).resolves.toBe("retry");
    expect(seen).toEqual([]);
  });

  it("lets the caller's own write fail as itself rather than as a refused heartbeat", async () => {
    const api = new FakeApi();
    const queue = new SyncQueue(api, DEVICE, {
      onHeartbeat: () => {
        throw new Error("ENOSPC");
      },
    });

    // The callback writes the config to disk. A full disk there is not the API refusing
    // the heartbeat, and classifying it as one would stop the loop for the wrong reason.
    await expect(queue.heartbeat(null)).rejects.toThrow("ENOSPC");
    expect(api.heartbeats).toHaveLength(1);
  });
});

describe("SyncQueue.reportBlocks", () => {
  const refusal = {
    clientEventId: "44444444-4444-4444-8444-444444444444",
    url: "https://blocked.test/x",
    ruleId: 99,
    at: "2026-08-05T09:00:00.000Z",
  };

  it("skips the round trip when the browser refused nothing", async () => {
    const api = new FakeApi();

    await expect(new SyncQueue(api, DEVICE).reportBlocks([])).resolves.toBe("empty");
    expect(api.blockReports).toHaveLength(0);
  });

  it("sends the numeric rule id the browser enforced, not a uuid it never had", async () => {
    const api = new FakeApi();

    await expect(new SyncQueue(api, DEVICE).reportBlocks([refusal])).resolves.toBe("sent");

    expect(api.blockReports[0]).toEqual({
      deviceId: DEVICE,
      events: [
        {
          clientEventId: refusal.clientEventId,
          url: refusal.url,
          blockedAt: refusal.at,
          ruleId: 99,
        },
      ],
    });
  });

  /**
   * The refusal already happened in the browser and the employee already saw the page.
   * Classifying the failure keeps this on the same footing as every other route — a
   * revoked device must read as revoked here too, not as a network blip.
   */
  it("classifies a failure rather than throwing into the tick", async () => {
    const api = new FakeApi();
    api.blockError = new ApiError("Device revoked", 403, "device_revoked");

    await expect(new SyncQueue(api, DEVICE).reportBlocks([refusal])).resolves.toBe("revoked");
  });
});
