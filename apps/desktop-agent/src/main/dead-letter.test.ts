import { describe, expect, it } from "vitest";

import { DeadLetterFile } from "./dead-letter.js";
import type { DurableFs } from "./persistence.js";

/** Enough of a disk to prove the file survives a restart; nothing touches a real one. */
class FakeFs implements DurableFs {
  readonly files = new Map<string, string>();

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  write(path: string, contents: string): void {
    this.files.set(path, contents);
  }

  append(path: string, contents: string): void {
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

const DEAD_LETTERS = "/state/dead-letters.json";
const T0 = new Date("2026-08-05T09:00:00.000Z");

function activity(clientEventId: string) {
  return {
    clientEventId,
    appName: "code",
    startedAt: "2026-08-05T09:00:00.000Z",
    endedAt: "2026-08-05T09:01:00.000Z",
  };
}

describe("DeadLetterFile", () => {
  it("keeps a batch the API rejected, with the reason, instead of deleting it silently", () => {
    const fs = new FakeFs();

    new DeadLetterFile(fs, DEAD_LETTERS).quarantine(
      { kind: "activity", reason: "invalid_body", events: [activity("a1")] },
      T0,
    );

    // A monitoring product that quietly deletes an employee's data cannot explain the
    // gap in their timeline afterwards. The file is the explanation.
    expect(new DeadLetterFile(fs, DEAD_LETTERS).read()).toEqual([
      {
        quarantinedAt: "2026-08-05T09:00:00.000Z",
        kind: "activity",
        reason: "invalid_body",
        events: [activity("a1")],
      },
    ]);
  });

  it("bounds the file, shedding the oldest entries and recording how many it shed", () => {
    const fs = new FakeFs();
    const letters = new DeadLetterFile(fs, DEAD_LETTERS, { maxEntries: 2 });

    for (const reason of ["first", "second", "third"]) {
      letters.quarantine({ kind: "activity", reason, events: [activity(reason)] }, T0);
    }

    // A device stuck emitting a batch the API hates must not fill the disk with the
    // evidence — but the count of what fell off the end still has to survive, or the
    // file starts lying about how much was lost.
    const reopened = new DeadLetterFile(fs, DEAD_LETTERS, { maxEntries: 2 });
    expect(reopened.read().map((entry) => entry.reason)).toEqual(["second", "third"]);
    expect(reopened.shed).toBe(1);
  });
});
