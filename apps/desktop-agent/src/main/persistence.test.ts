import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { DurableFs } from "./persistence.js";
import { DeadLetterFile } from "./dead-letter.js";
import {
  agentStateDirectory,
  createDurableStore,
  DayStateStore,
  EventJournal,
  JsonFile,
} from "./persistence.js";

/**
 * An in-memory disk that records the order of every operation.
 *
 * The order is the point: "crash-safe" is not a property of the bytes, it is a
 * property of the sequence, so a test that only checked the final contents would
 * pass just as happily against a plain overwrite.
 */
class FakeFs implements DurableFs {
  readonly files = new Map<string, string>();
  readonly ops: string[] = [];
  readonly dirs = new Set<string>();

  /** Set to make the next write throw, standing in for a full or read-only disk. */
  failWrite: string | null = null;

  read(path: string): string | null {
    this.ops.push(`read ${path}`);
    return this.files.get(path) ?? null;
  }

  write(path: string, contents: string): void {
    this.ops.push(`write ${path}`);
    if (this.failWrite === path) throw new Error("ENOSPC");
    this.files.set(path, contents);
  }

  append(path: string, contents: string): void {
    this.ops.push(`append ${path}`);
    if (this.failWrite === path) throw new Error("ENOSPC");
    this.files.set(path, (this.files.get(path) ?? "") + contents);
  }

  rename(from: string, to: string): void {
    this.ops.push(`rename ${from} -> ${to}`);
    const contents = this.files.get(from);
    if (contents === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.delete(from);
    this.files.set(to, contents);
  }

  remove(path: string): void {
    this.ops.push(`remove ${path}`);
    this.files.delete(path);
  }

  ensureDir(path: string): void {
    this.ops.push(`ensureDir ${path}`);
    this.dirs.add(path);
  }
}

const DAY_FILE = "/state/day.json";

describe("JsonFile", () => {
  it("writes to a temporary file and renames it, so a crash cannot leave a half-written document", () => {
    const fs = new FakeFs();
    const file = new JsonFile(fs, DAY_FILE);

    file.write({ sessions: [] });

    // Nothing is ever written at the real path: rename is the only operation that
    // publishes it, and rename within a directory is atomic on both NTFS and APFS.
    expect(fs.ops).toEqual([
      `write ${DAY_FILE}.tmp`,
      `rename ${DAY_FILE}.tmp -> ${DAY_FILE}`,
    ]);
  });

  it("reads back what it published, and reports an absent file as nothing rather than an error", () => {
    const fs = new FakeFs();
    const file = new JsonFile(fs, DAY_FILE);

    expect(file.read()).toBeNull();

    file.write({ idleSpans: [{ startedAt: "2026-08-05T09:00:00.000Z", endedAt: null }] });

    expect(file.read()).toEqual({
      idleSpans: [{ startedAt: "2026-08-05T09:00:00.000Z", endedAt: null }],
    });
  });

  it("quarantines a half-written document instead of throwing, so a bad file cannot brick the boot", () => {
    const fs = new FakeFs();
    const logged: string[] = [];
    const file = new JsonFile(fs, DAY_FILE, { log: (message) => logged.push(message) });

    // What a power cut during a non-atomic write would have left behind.
    fs.files.set(DAY_FILE, '{"sessions":[{"startedAt":"2026-08-05T09');

    expect(file.read()).toBeNull();

    // Moved aside rather than deleted: it is the only evidence of what was lost, and
    // leaving it in place would fail the same way on every subsequent launch.
    expect(fs.files.has(DAY_FILE)).toBe(false);
    expect(fs.files.get(`${DAY_FILE}.corrupt`)).toBe('{"sessions":[{"startedAt":"2026-08-05T09');
    expect(logged).toHaveLength(1);
  });
});

const LOG_FILE = "/state/pending.ndjson";

function activity(clientEventId: string) {
  return {
    clientEventId,
    appName: "code",
    startedAt: "2026-08-05T09:00:00.000Z",
    endedAt: "2026-08-05T09:01:00.000Z",
  };
}

describe("EventJournal", () => {
  it("replays an event across a hard kill, because it was written before the flush was attempted", () => {
    const fs = new FakeFs();
    const journal = new EventJournal(fs, LOG_FILE);
    journal.restore();

    journal.append("activity", activity("a1"));

    // SIGKILL here. A fresh journal is all the next launch has.
    expect(new EventJournal(fs, LOG_FILE).restore()).toEqual({
      activity: [activity("a1")],
      idle: [],
      breaks: [],
      dropped: 0,
    });
  });

  it("stops replaying an event once the API has confirmed it, but keeps the rest", () => {
    const fs = new FakeFs();
    const journal = new EventJournal(fs, LOG_FILE);
    journal.restore();
    journal.append("activity", activity("a1"));
    journal.append("activity", activity("a2"));

    journal.remove(["a1"]);

    expect(new EventJournal(fs, LOG_FILE).restore().activity).toEqual([activity("a2")]);
  });

  it("bounds the backlog on disk, shedding the oldest first and saying how many it lost", () => {
    const fs = new FakeFs();
    const lost: number[] = [];
    const journal = new EventJournal(fs, LOG_FILE, {
      maxRecords: 2,
      onDrop: (count) => lost.push(count),
    });
    journal.restore();

    journal.append("activity", activity("a1"));
    journal.append("activity", activity("a2"));
    journal.append("activity", activity("a3"));

    // A week offline must not fill the employee's disk, and the recent past is the
    // part a manager is looking at — so the oldest goes, and it is reported.
    expect(lost).toEqual([1]);
    expect(new EventJournal(fs, LOG_FILE).restore().activity).toEqual([
      activity("a2"),
      activity("a3"),
    ]);
  });

  it("folds away the tombstones of a healthy online day instead of growing the log forever", () => {
    const fs = new FakeFs();
    const journal = new EventJournal(fs, LOG_FILE, { compactAfterLines: 8 });
    journal.restore();

    // An agent that syncs every minute for eight hours: nothing is ever pending for
    // long, but every confirmed event still leaves a line and a tombstone behind.
    for (let index = 0; index < 50; index += 1) {
      journal.append("activity", activity(`a${index}`));
      journal.remove([`a${index}`]);
    }

    expect(lineCount(fs.files.get(LOG_FILE))).toBeLessThanOrEqual(8);
    expect(new EventJournal(fs, LOG_FILE).restore().activity).toEqual([]);
  });

  it("wipes the log on revocation, so what was observed before the stop signal cannot resurface", () => {
    const fs = new FakeFs();
    const journal = new EventJournal(fs, LOG_FILE);
    journal.restore();
    journal.append("activity", activity("a1"));

    journal.clear();

    // Non-negotiable 4: revocation is immediate. A backlog that outlived it would be
    // replayed by the next launch and re-sent the moment the device is re-enrolled.
    expect(fs.files.has(LOG_FILE)).toBe(false);
    expect(new EventJournal(fs, LOG_FILE).restore().activity).toEqual([]);
  });

  it("skips a line torn by a power cut and keeps the rest of the offline day", () => {
    const fs = new FakeFs();
    const logged: string[] = [];
    // The tail is what a kill mid-append leaves: the last line stops mid-token.
    fs.files.set(
      LOG_FILE,
      `${JSON.stringify({ k: "activity", e: activity("a1") })}\n{"k":"activity","e":{"clientEve`,
    );

    const restored = new EventJournal(fs, LOG_FILE, { log: (m) => logged.push(m) }).restore();

    expect(restored.activity).toEqual([activity("a1")]);
    expect(logged).toHaveLength(1);
  });
});

function lineCount(body: string | undefined): number {
  return (body ?? "").split("\n").filter((line) => line.length > 0).length;
}

const MIDDAY = new Date("2026-08-05T12:00:00.000Z");

function dayStore(fs: DurableFs, now = MIDDAY): DayStateStore {
  return new DayStateStore(new JsonFile(fs, DAY_FILE), () => now);
}

describe("DayStateStore", () => {
  it("hands back the day's carved-out spans after a restart, so the readout is not Idle 0m", () => {
    const fs = new FakeFs();
    const idleSpans = [{ startedAt: "2026-08-05T10:00:00.000Z", endedAt: "2026-08-05T10:30:00.000Z" }];
    const breakSpans = [{ startedAt: "2026-08-05T11:00:00.000Z", endedAt: "2026-08-05T11:45:00.000Z" }];

    dayStore(fs).update({ idleSpans, breakSpans });

    // Without this the restarted agent re-adopts the open session but none of the
    // carve-outs, so the day reads Active = Total for hours that were not worked.
    const reopened = dayStore(fs).load();
    expect(reopened.idleSpans).toEqual(idleSpans);
    expect(reopened.breakSpans).toEqual(breakSpans);
  });

  it("remembers that the employee ended their day, across a restart", () => {
    const fs = new FakeFs();
    const endedAt = "2026-08-05T17:30:00.000Z";

    dayStore(fs).update({ dayEndedAt: endedAt });

    // `readDayState` wrote this field and never read it back, so a clock-out survived
    // exactly as long as the process did. Rebooting a laptop after finishing for the
    // day silently resumed collection on someone who had said they were done — the
    // one direction of error non-negotiable #1 exists to prevent. The compiler found
    // it; nothing else would have.
    expect(dayStore(fs).load().dayEndedAt).toBe(endedAt);
  });

  it("recovers an open break at its original start, not at the moment of the relaunch", () => {
    const fs = new FakeFs();

    dayStore(fs).update({
      openBreakSince: "2026-08-05T11:30:00.000Z",
      openIdleSince: "2026-08-05T11:05:00.000Z",
      openFocus: {
        appName: "code",
        windowTitle: "sync.ts",
        url: null,
        domain: null,
        startedAt: "2026-08-05T11:00:00.000Z",
      },
    });

    // A crash during lunch that resumed the break at relaunch would credit the whole
    // hour as worked — the exact direction of error a monitoring product must not have.
    const reopened = dayStore(fs).load();
    expect(reopened.openBreakSince).toBe("2026-08-05T11:30:00.000Z");
    expect(reopened.openIdleSince).toBe("2026-08-05T11:05:00.000Z");
    expect(reopened.openFocus?.startedAt).toBe("2026-08-05T11:00:00.000Z");
  });

  it("throws yesterday's snapshot away rather than folding it into today's totals", () => {
    const fs = new FakeFs();
    dayStore(fs, new Date("2026-08-04T12:00:00.000Z")).update({
      idleSpans: [{ startedAt: "2026-08-04T10:00:00.000Z", endedAt: "2026-08-04T10:30:00.000Z" }],
      openBreakSince: "2026-08-04T17:00:00.000Z",
    });

    const today = dayStore(fs, new Date("2026-08-05T09:00:00.000Z")).load();

    expect(today.idleSpans).toEqual([]);
    expect(today.openBreakSince).toBeNull();
  });

  it("survives a hand-mangled state file field by field, rather than refusing to boot", () => {
    const fs = new FakeFs();
    const store = dayStore(fs);
    // Written by a future build, or edited by someone during a support call.
    fs.files.set(
      DAY_FILE,
      JSON.stringify({
        day: "2026-08-05",
        sessions: "not an array",
        idleSpans: [{ startedAt: 42 }, { startedAt: "2026-08-05T10:00:00.000Z" }],
        openFocus: { appName: "code" },
      }),
    );

    const loaded = store.load();

    expect(loaded.sessions).toEqual([]);
    expect(loaded.idleSpans).toEqual([{ startedAt: "2026-08-05T10:00:00.000Z", endedAt: null }]);
    expect(loaded.openFocus).toBeNull();
  });
});

describe("createDurableStore", () => {
  it("assembles the whole store under one directory, so no caller invents a path", () => {
    const fs = new FakeFs();
    const directory = agentStateDirectory("/userData");

    const store = createDurableStore({ fs, directory, now: () => MIDDAY });
    store.journal.append("activity", { clientEventId: "a1" });
    store.dayState.update({ openBreakSince: "2026-08-05T11:30:00.000Z" });
    new DeadLetterFile(store.fs, store.deadLetterPath).quarantine(
      { kind: "activity", reason: "invalid_body", events: [] },
      MIDDAY,
    );

    // Built with `join` so the assertion is about the layout, not the separator: the
    // agent ships on Windows and macOS and the two disagree about that character.
    expect([...fs.files.keys()].sort()).toEqual([
      join(directory, "day-state.json"),
      join(directory, "dead-letters.json"),
      join(directory, "pending-events.ndjson"),
    ]);
    expect(directory.endsWith(join("userData", "state"))).toBe(true);
  });
});
