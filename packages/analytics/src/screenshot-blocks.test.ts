import { describe, expect, it } from "vitest";

import type { Screenshot } from "@aems/types";

import {
  buildTimeline,
  groupScreenshotsIntoBlocks,
  monitorCountOf,
  resolveScreenshots,
  screenshotPaths,
  screenshotsInSlot,
  signablePaths,
  signedUrlIndex,
  withSignedUrls,
} from "./productivity.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";
const DEVICE = "33333333-3333-4333-8333-333333333333";

let nextId = 1;

function shot(capturedAt: string, overrides: Partial<Screenshot> = {}): Screenshot {
  const id = overrides.id ?? nextId++;
  return {
    id,
    company_id: COMPANY,
    profile_id: PROFILE,
    device_id: DEVICE,
    work_session_id: null,
    captured_at: capturedAt,
    storage_path: `${COMPANY}/${PROFILE}/screenshots/${id}.webp`,
    thumbnail_path: null,
    blurred: false,
    client_event_id: `c${id}`,
    created_at: capturedAt,
    ...overrides,
  };
}

/** Minutes past 09:00 on the fixed test day, as an ISO instant. */
function at(minute: number, second = 0): string {
  return new Date(Date.parse("2026-08-05T09:00:00.000Z") + minute * 60_000 + second * 1000).toISOString();
}

const SLOT = {
  start: Date.parse("2026-08-05T09:00:00.000Z"),
  end: Date.parse("2026-08-05T10:00:00.000Z"),
};

describe("screenshotsInSlot", () => {
  it("keeps every capture in the block, not just the first match", () => {
    // scope §2.3 offers a 1-minute interval; sixty captures land in an hour-long slot.
    const captures = Array.from({ length: 60 }, (_, i) => shot(at(i)));

    expect(screenshotsInSlot(captures, SLOT)).toHaveLength(60);
  });

  it("sorts ascending even though the query hands them back newest first", () => {
    const rows = [shot(at(30)), shot(at(10)), shot(at(20))];

    expect(screenshotsInSlot(rows, SLOT).map((s) => s.capturedAt)).toEqual([at(10), at(20), at(30)]);
  });

  it("treats the block as half-open so no capture lands in two blocks", () => {
    const rows = [shot("2026-08-05T09:00:00.000Z"), shot("2026-08-05T10:00:00.000Z")];

    const kept = screenshotsInSlot(rows, SLOT);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.capturedAt).toBe("2026-08-05T09:00:00.000Z");
  });

  it("carries the storage paths the signer needs and leaves the URLs unresolved", () => {
    const rows = [shot(at(5), { thumbnail_path: "thumbs/a.webp", blurred: true, work_session_id: 7 })];

    expect(screenshotsInSlot(rows, SLOT)[0]).toMatchObject({
      thumbnailPath: "thumbs/a.webp",
      blurred: true,
      workSessionId: 7,
      url: null,
      thumbnailUrl: null,
    });
  });

  it("drops a row with an unparseable timestamp rather than placing it arbitrarily", () => {
    expect(screenshotsInSlot([shot("not-a-date")], SLOT)).toEqual([]);
  });
});

describe("monitorCountOf", () => {
  it("counts the frames of one capture instant, which is how a multi-monitor tick arrives", () => {
    const refs = screenshotsInSlot([shot(at(5)), shot(at(5)), shot(at(5))], SLOT);

    expect(monitorCountOf(refs)).toBe(3);
  });

  it("reports the busiest instant in the block, not the last one", () => {
    const refs = screenshotsInSlot([shot(at(5)), shot(at(5)), shot(at(9))], SLOT);

    expect(monitorCountOf(refs)).toBe(2);
  });

  it("is zero for a block with no capture", () => {
    expect(monitorCountOf([])).toBe(0);
  });
});

describe("buildTimeline screenshots", () => {
  it("returns every capture of the bucket instead of discarding 59 of 60", () => {
    const entries = buildTimeline({
      profileId: PROFILE,
      deviceId: DEVICE,
      periodStart: "2026-08-05T09:00:00.000Z",
      periodEnd: "2026-08-05T10:00:00.000Z",
      activity: [],
      idle: [],
      screenshots: Array.from({ length: 60 }, (_, i) => shot(at(i))),
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.screenshots).toHaveLength(60);
    expect(entries[0]?.screenshotCount).toBe(60);
  });

  it("loses no capture across bucket boundaries", () => {
    // Denser than one per bucket on purpose: the defect this replaces kept exactly
    // one, so a fixture with one capture per bucket would pass either way.
    const captures = Array.from({ length: 18 }, (_, i) => shot(at(i * 3)));

    const entries = buildTimeline({
      profileId: PROFILE,
      deviceId: DEVICE,
      periodStart: "2026-08-05T09:00:00.000Z",
      periodEnd: "2026-08-05T12:00:00.000Z",
      bucketSeconds: 600,
      activity: [],
      idle: [],
      screenshots: captures,
    });

    const seen = entries.flatMap((e) => e.screenshots.map((s) => s.id));
    expect(seen).toHaveLength(captures.length);
    expect(new Set(seen).size).toBe(captures.length);
  });

  it("places captures in the right bucket when the query hands them back newest first", () => {
    // Guard for the cursor walk: the rows arrive descending, the slots are visited
    // ascending, and every capture must still land under its own bucket.
    const descending = [shot(at(70), { id: 3 }), shot(at(35), { id: 2 }), shot(at(5), { id: 1 })];

    const entries = buildTimeline({
      profileId: PROFILE,
      deviceId: DEVICE,
      periodStart: "2026-08-05T09:00:00.000Z",
      periodEnd: "2026-08-05T11:00:00.000Z",
      bucketSeconds: 1800,
      activity: [],
      idle: [],
      screenshots: descending,
    });

    expect(entries.map((e) => e.screenshots.map((s) => s.id))).toEqual([[1], [2], [3], []]);
  });

  it("ignores a capture that falls before the window without shifting the rest", () => {
    const entries = buildTimeline({
      profileId: PROFILE,
      deviceId: DEVICE,
      periodStart: "2026-08-05T09:00:00.000Z",
      periodEnd: "2026-08-05T10:00:00.000Z",
      bucketSeconds: 1800,
      activity: [],
      idle: [],
      screenshots: [shot(at(-40), { id: 1 }), shot(at(40), { id: 2 })],
    });

    expect(entries.map((e) => e.screenshots.map((s) => s.id))).toEqual([[], [2]]);
  });

  it("keeps screenshotId populated for callers still reading the single-id field", () => {
    const entries = buildTimeline({
      profileId: PROFILE,
      deviceId: DEVICE,
      periodStart: "2026-08-05T09:00:00.000Z",
      periodEnd: "2026-08-05T10:00:00.000Z",
      activity: [],
      idle: [],
      screenshots: [shot(at(40), { id: 900 }), shot(at(10), { id: 800 })],
    });

    expect(entries[0]?.screenshotId).toBe(800);
  });

  it("reports the monitor count of the busiest instant in the bucket", () => {
    const entries = buildTimeline({
      profileId: PROFILE,
      deviceId: DEVICE,
      periodStart: "2026-08-05T09:00:00.000Z",
      periodEnd: "2026-08-05T10:00:00.000Z",
      activity: [],
      idle: [],
      screenshots: [shot(at(5)), shot(at(5)), shot(at(20))],
    });

    expect(entries[0]?.monitorCount).toBe(2);
  });
});

describe("groupScreenshotsIntoBlocks", () => {
  const input = {
    periodStart: "2026-08-05T09:00:00.000Z",
    periodEnd: "2026-08-05T10:00:00.000Z",
  };

  it("uses the same block boundaries buildTimeline slices, so the two views agree", () => {
    const blocks = groupScreenshotsIntoBlocks({ ...input, blockSeconds: 600, screenshots: [] });
    const entries = buildTimeline({
      ...input,
      profileId: PROFILE,
      deviceId: DEVICE,
      bucketSeconds: 600,
      activity: [],
      idle: [],
    });

    expect(blocks.map((b) => [b.periodStart, b.periodEnd])).toEqual(
      entries.map((e) => [e.periodStart, e.periodEnd]),
    );
  });

  it("emits an empty block for a gap so the review UI can render 'No capture'", () => {
    const blocks = groupScreenshotsIntoBlocks({
      ...input,
      blockSeconds: 600,
      screenshots: [shot(at(2)), shot(at(35))],
    });

    expect(blocks).toHaveLength(6);
    expect(blocks.map((b) => b.screenshotCount)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("places every capture in exactly one block", () => {
    const captures = Array.from({ length: 24 }, (_, i) => shot(at(i * 2, 30)));

    const blocks = groupScreenshotsIntoBlocks({
      ...input,
      blockSeconds: 600,
      screenshots: captures,
    });

    const ids = blocks.flatMap((b) => b.screenshots.map((s) => s.id));
    expect(new Set(ids).size).toBe(captures.length);
  });

  it("clips the final partial block to the requested end", () => {
    const blocks = groupScreenshotsIntoBlocks({
      periodStart: "2026-08-05T09:00:00.000Z",
      periodEnd: "2026-08-05T09:25:00.000Z",
      blockSeconds: 600,
      screenshots: [],
    });

    expect(blocks).toHaveLength(3);
    expect(blocks[2]?.periodEnd).toBe("2026-08-05T09:25:00.000Z");
  });

  it("returns nothing for an unusable window rather than looping", () => {
    expect(groupScreenshotsIntoBlocks({ ...input, blockSeconds: 0, screenshots: [] })).toEqual([]);
    expect(
      groupScreenshotsIntoBlocks({ periodStart: "nope", periodEnd: "also nope", screenshots: [] }),
    ).toEqual([]);
  });
});

describe("signablePaths", () => {
  it("collects the full-size and thumbnail paths of every block in one list", () => {
    const blocks = groupScreenshotsIntoBlocks({
      periodStart: "2026-08-05T09:00:00.000Z",
      periodEnd: "2026-08-05T10:00:00.000Z",
      blockSeconds: 600,
      screenshots: [
        shot(at(1), { id: 1, storage_path: "a.webp", thumbnail_path: "thumbs/a.webp" }),
        shot(at(21), { id: 2, storage_path: "b.webp", thumbnail_path: null }),
      ],
    });

    expect(signablePaths(blocks).sort()).toEqual(["a.webp", "b.webp", "thumbs/a.webp"]);
  });

  it("asks for each path once — one signature per object, never per tile", () => {
    const blocks = groupScreenshotsIntoBlocks({
      periodStart: "2026-08-05T09:00:00.000Z",
      periodEnd: "2026-08-05T10:00:00.000Z",
      blockSeconds: 600,
      screenshots: [
        shot(at(1), { id: 1, storage_path: "same.webp" }),
        shot(at(2), { id: 2, storage_path: "same.webp" }),
      ],
    });

    expect(signablePaths(blocks)).toEqual(["same.webp"]);
  });
});

describe("screenshotPaths / resolveScreenshots", () => {
  const refs = screenshotsInSlot(
    [
      shot(at(1), { id: 1, storage_path: "a.webp", thumbnail_path: "thumbs/a.webp" }),
      shot(at(2), { id: 2, storage_path: "b.webp" }),
    ],
    SLOT,
  );

  it("lists the keys of a flat run of captures once each", () => {
    expect(screenshotPaths(refs).sort()).toEqual(["a.webp", "b.webp", "thumbs/a.webp"]);
  });

  it("resolves a flat run for a caller that does its own grouping", () => {
    const resolved = resolveScreenshots(refs, new Map([["thumbs/a.webp", "https://s/thumb-a"]]));

    expect(resolved).toEqual([
      {
        id: 1,
        capturedAt: at(1),
        url: null,
        thumbnailUrl: "https://s/thumb-a",
        blurred: false,
        workSessionId: null,
      },
      {
        id: 2,
        capturedAt: at(2),
        url: null,
        thumbnailUrl: null,
        blurred: false,
        workSessionId: null,
      },
    ]);
  });
});

describe("signedUrlIndex", () => {
  it("indexes what came back by path", () => {
    const index = signedUrlIndex([{ path: "a.webp", signedUrl: "https://s/a?token=1" }]);

    expect(index.get("a.webp")).toBe("https://s/a?token=1");
  });

  it("skips entries the signer could not resolve rather than storing a broken URL", () => {
    // A batch comes back part-signed: the call succeeds and reports failure per
    // path, with both `path` and `signedUrl` nullable.
    const index = signedUrlIndex([
      { path: null, signedUrl: "https://s/x", error: "not found" },
      { path: "b.webp", signedUrl: "", error: "not found" },
      { path: "c.webp", signedUrl: null, error: "not found" },
    ]);

    expect(index.size).toBe(0);
  });

  it("keeps the signed paths of a part-signed batch", () => {
    const index = signedUrlIndex([
      { path: "a.webp", signedUrl: "https://s/a", error: null },
      { path: "b.webp", signedUrl: null, error: "not found" },
    ]);

    expect([...index.keys()]).toEqual(["a.webp"]);
  });
});

describe("withSignedUrls", () => {
  const blocks = groupScreenshotsIntoBlocks({
    periodStart: "2026-08-05T09:00:00.000Z",
    periodEnd: "2026-08-05T10:00:00.000Z",
    blockSeconds: 3600,
    screenshots: [
      shot(at(1), { id: 1, storage_path: "a.webp", thumbnail_path: "thumbs/a.webp" }),
      shot(at(2), { id: 2, storage_path: "b.webp" }),
    ],
  });

  it("attaches the signed URL for the image and its thumbnail", () => {
    const signed = withSignedUrls(
      blocks,
      new Map([
        ["a.webp", "https://s/a"],
        ["thumbs/a.webp", "https://s/thumb-a"],
      ]),
    );

    expect(signed[0]?.screenshots[0]).toMatchObject({
      url: "https://s/a",
      thumbnailUrl: "https://s/thumb-a",
    });
  });

  it("leaves an unsigned image null instead of guessing a public URL for a private bucket", () => {
    const signed = withSignedUrls(blocks, new Map());

    expect(signed[0]?.screenshots[1]).toMatchObject({ url: null, thumbnailUrl: null });
  });

  it("keeps the storage layout off the wire — a signed URL is all a browser needs", () => {
    const signed = withSignedUrls(blocks, new Map([["a.webp", "https://s/a"]]));

    expect(signed[0]?.screenshots[0]).not.toHaveProperty("storagePath");
    expect(signed[0]?.screenshots[0]).not.toHaveProperty("thumbnailPath");
  });

  it("emits exactly the fields the shared TimelineScreenshot contract declares", () => {
    const signed = withSignedUrls(blocks, new Map([["a.webp", "https://s/a"]]));

    expect(Object.keys(signed[0]?.screenshots[0] ?? {}).sort()).toEqual([
      "blurred",
      "capturedAt",
      "id",
      "thumbnailUrl",
      "url",
      "workSessionId",
    ]);
  });

  it("does not mutate the blocks it was given", () => {
    withSignedUrls(blocks, new Map([["a.webp", "https://s/a"]]));

    expect(blocks[0]?.screenshots[0]?.url).toBeNull();
  });

  it("falls back to the full image when a row has no thumbnail, so a tile always renders", () => {
    const signed = withSignedUrls(blocks, new Map([["b.webp", "https://s/b"]]));

    expect(signed[0]?.screenshots[1]?.thumbnailUrl).toBe("https://s/b");
  });
});
