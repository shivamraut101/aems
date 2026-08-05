import type { BreakEventInput } from "@aems/types";
import { afterEach, describe, expect, it } from "vitest";

import { IdleWatcher, readIdleSeconds, readIdleState, setSystemIdleSource } from "./idle.js";

// Same base instant the superseded Rust tests used, so the offsets below stay comparable.
const BASE = Date.parse("2025-08-05T08:00:00.000Z");

function at(seconds: number): Date {
  return new Date(BASE + seconds * 1000);
}

function iso(seconds: number): string {
  return at(seconds).toISOString();
}

describe("IdleWatcher.observeIdle", () => {
  it("backdates the idle start to when input stopped, not to when the threshold was crossed", () => {
    const watcher = new IdleWatcher();

    expect(watcher.observeIdle(120, 120, at(300))).toBeNull();

    const event = watcher.observeIdle(0, 120, at(400));
    expect(event?.idleStartAt).toBe(iso(180));
    expect(event?.idleEndAt).toBe(iso(400));
  });

  it("never treats activity below the threshold as idle", () => {
    const watcher = new IdleWatcher();

    expect(watcher.observeIdle(30, 120, at(0))).toBeNull();
    expect(watcher.observeIdle(0, 120, at(60))).toBeNull();
  });

  it("does not restart an open stretch, so a long absence keeps its original start", () => {
    const watcher = new IdleWatcher();

    expect(watcher.observeIdle(120, 120, at(300))).toBeNull();
    expect(watcher.observeIdle(300, 120, at(480))).toBeNull();
    expect(watcher.observeIdle(2400, 120, at(2580))).toBeNull();

    // at(180) rather than at(2460): drifting the start forward each tick would collapse
    // a 40-minute absence into one poll interval.
    expect(watcher.observeIdle(0, 120, at(2600))?.idleStartAt).toBe(iso(180));
  });

  it("floors a zero threshold rather than pinning the agent to idle forever", () => {
    const watcher = new IdleWatcher();

    // At threshold 0 every reading satisfies `idleSeconds >= threshold`, so the stretch
    // opens on the first tick and can never close.
    expect(watcher.observeIdle(0, 0, at(0))).toBeNull();
    expect(watcher.observeIdle(5, 0, at(5))).toBeNull();

    const event = watcher.observeIdle(0, 0, at(10));
    expect(event?.idleStartAt).toBe(iso(0));
    expect(event?.idleEndAt).toBe(iso(10));
  });

  it("splits the stretch when the OS counter resets between polls", () => {
    const watcher = new IdleWatcher();

    expect(watcher.observeIdle(120, 120, at(300))).toBeNull();

    // The employee touched the machine and went idle again entirely between two polls:
    // the counter now backdates to at(560), which is proof it restarted. Without this
    // the whole span reads as one unbroken idle stretch and the active window vanishes.
    const closed = watcher.observeIdle(120, 120, at(680));
    expect(closed?.idleStartAt).toBe(iso(180));
    // Closed at the last tick we actually saw them idle, not at the new start — the
    // unobserved gap must not be claimed as idle.
    expect(closed?.idleEndAt).toBe(iso(300));

    expect(watcher.observeIdle(0, 120, at(700))?.idleStartAt).toBe(iso(560));
  });

  it("tolerates sub-second counter jitter rather than splitting on every poll", () => {
    const watcher = new IdleWatcher();

    // getSystemIdleTime returns whole seconds while `now` carries milliseconds, so the
    // backdated start drifts forward slightly on every tick of one continuous stretch.
    expect(watcher.observeIdle(120, 120, at(300))).toBeNull();
    expect(watcher.observeIdle(125, 120, new Date(at(305).getTime() + 400))).toBeNull();
    expect(watcher.observeIdle(130, 120, new Date(at(310).getTime() + 900))).toBeNull();

    expect(watcher.observeIdle(0, 120, at(400))?.idleStartAt).toBe(iso(180));
  });
});

describe("IdleWatcher.flush", () => {
  it("closes an open idle stretch so quitting while away does not erase it", () => {
    const watcher = new IdleWatcher();
    watcher.observeIdle(120, 120, at(300));

    const event = watcher.flush(at(900));
    expect(event?.idleStartAt).toBe(iso(180));
    expect(event?.idleEndAt).toBe(iso(900));
  });

  it("is idempotent, so a second shutdown pass does not duplicate the stretch", () => {
    const watcher = new IdleWatcher();
    watcher.observeIdle(120, 120, at(300));

    expect(watcher.flush(at(900))).not.toBeNull();
    expect(watcher.flush(at(901))).toBeNull();
  });
});

describe("IdleWatcher breaks", () => {
  it("emits a closed interval when an explicit break ends", () => {
    const watcher = new IdleWatcher();

    expect(watcher.startBreak(at(0))).toBeNull();

    const event: BreakEventInput | null = watcher.endBreak(at(900));
    expect(event?.breakStartAt).toBe(iso(0));
    expect(event?.breakEndAt).toBe(iso(900));
  });

  it("ignores an end with no break open", () => {
    expect(new IdleWatcher().endBreak(at(900))).toBeNull();
  });

  it("does not restart an already-open break", () => {
    const watcher = new IdleWatcher();
    watcher.startBreak(at(0));
    watcher.startBreak(at(60));

    expect(watcher.endBreak(at(900))?.breakStartAt).toBe(iso(0));
  });
});

describe("break versus idle precedence", () => {
  it("infers no idle during an explicit break, so the seconds are not counted twice", () => {
    const watcher = new IdleWatcher();
    watcher.startBreak(at(0));

    // The OS counter climbs the whole time the employee is away, but those seconds are
    // already claimed by the break. Emitting both would have the server subtract the
    // same span from active time twice.
    expect(watcher.observeIdle(300, 120, at(300))).toBeNull();
    expect(watcher.observeIdle(600, 120, at(600))).toBeNull();
    expect(watcher.observeIdle(0, 120, at(900))).toBeNull();

    expect(watcher.endBreak(at(900))?.breakStartAt).toBe(iso(0));
  });

  it("truncates an open idle stretch at the break start rather than overlapping it", () => {
    const watcher = new IdleWatcher();
    watcher.observeIdle(120, 120, at(300));

    // The idle before the break is real and must survive; it just cannot run into the
    // break, which now owns every second from at(600) onwards.
    const closed = watcher.startBreak(at(600));
    expect(closed?.idleStartAt).toBe(iso(180));
    expect(closed?.idleEndAt).toBe(iso(600));
  });

  it("clamps a post-break idle start to the break end so idle cannot reach into it", () => {
    const watcher = new IdleWatcher();
    watcher.startBreak(at(0));
    watcher.endBreak(at(900));

    // The break was ended while the employee was still away, so the OS counter has been
    // climbing since at(0) and backdates to before the break end. Trusting it would
    // re-report the entire break as idle on top of the break itself.
    expect(watcher.observeIdle(960, 120, at(960))).toBeNull();

    const event = watcher.observeIdle(0, 120, at(1200));
    expect(event?.idleStartAt).toBe(iso(900));
    expect(event?.idleEndAt).toBe(iso(1200));
  });

  it("drops a clamped idle stretch that has no duration left", () => {
    const watcher = new IdleWatcher();
    watcher.startBreak(at(0));
    watcher.endBreak(at(900));

    // The clamp pins the start to the break end and input resumes at that same instant,
    // leaving nothing to report.
    expect(watcher.observeIdle(900, 120, at(900))).toBeNull();
    expect(watcher.observeIdle(0, 120, at(900))).toBeNull();
  });

  it("drops a break that ended at the instant it started", () => {
    const watcher = new IdleWatcher();
    watcher.startBreak(at(600));

    expect(watcher.endBreak(at(600))).toBeNull();
  });
});

describe("IdleWatcher.flushBreak", () => {
  it("closes an open break so quitting mid-break does not erase it", () => {
    const watcher = new IdleWatcher();
    watcher.startBreak(at(600));

    const event = watcher.flushBreak(at(900));
    expect(event?.breakStartAt).toBe(iso(600));
    expect(event?.breakEndAt).toBe(iso(900));
  });

  it("is idempotent, so a second shutdown pass does not duplicate the break", () => {
    const watcher = new IdleWatcher();
    watcher.startBreak(at(600));

    expect(watcher.flushBreak(at(900))).not.toBeNull();
    expect(watcher.flushBreak(at(901))).toBeNull();
  });
});

describe("clientEventId", () => {
  // The API validates every id as z.string().uuid() and dedupes on
  // (device_id, client_event_id), so a reused or malformed id either 400s the whole
  // batch or silently swallows a second event.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it("issues a distinct uuid to every emitted event", () => {
    const watcher = new IdleWatcher();

    watcher.observeIdle(120, 120, at(300));
    const first = watcher.observeIdle(0, 120, at(400));
    watcher.observeIdle(120, 120, at(600));
    const second = watcher.observeIdle(0, 120, at(700));
    watcher.startBreak(at(800));
    const taken = watcher.endBreak(at(900));

    const ids = [first?.clientEventId, second?.clientEventId, taken?.clientEventId];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(UUID);
  });
});

describe("system idle source", () => {
  afterEach(() => setSystemIdleSource(null));

  it("reads the counter and state from the injected source", () => {
    setSystemIdleSource({
      getSystemIdleTime: () => 42,
      getSystemIdleState: (threshold) => (threshold === 120 ? "idle" : "active"),
    });

    expect(readIdleSeconds()).toBe(42);
    expect(readIdleState(120)).toBe("idle");
    expect(readIdleState(600)).toBe("active");
  });

  it("reports unknown rather than trusting an unrecognised state", () => {
    setSystemIdleSource({
      getSystemIdleTime: () => 0,
      getSystemIdleState: () => "something-new",
    });

    expect(readIdleState(120)).toBe("unknown");
  });

  it("reads zero idle seconds when no source is attached, rather than throwing at a tick", () => {
    expect(readIdleSeconds()).toBe(0);
    expect(readIdleState(120)).toBe("unknown");
  });
});

/**
 * A crash at 11:20 during a stretch that began at 11:00 must not report the twenty
 * minutes as worked. Without this the loss is unbounded — the longer the absence, the
 * more of it is credited as active.
 */
describe("IdleWatcher.resume", () => {
  const start = new Date("2026-08-05T11:00:00.000Z");
  const later = new Date("2026-08-05T11:20:00.000Z");

  it("reopens an idle stretch at the moment it actually began", () => {
    const watcher = new IdleWatcher();
    watcher.resume({ idleSince: start, breakSince: null });

    expect(watcher.openIdleSince).toEqual(start);
    expect(watcher.flush(later)?.idleStartAt).toBe(start.toISOString());
  });

  it("reopens a break, so a relaunch mid-lunch is still on a break", () => {
    const watcher = new IdleWatcher();
    watcher.resume({ idleSince: null, breakSince: start });

    expect(watcher.onBreak).toBe(true);
    expect(watcher.endBreak(later)?.breakStartAt).toBe(start.toISOString());
  });

  it("leaves a watcher that already has a stretch open alone", () => {
    const watcher = new IdleWatcher();
    watcher.observeIdle(600, 120, later);
    watcher.resume({ idleSince: start, breakSince: null });

    expect(watcher.openIdleSince).not.toEqual(start);
  });
});
