import { beforeEach, describe, expect, it, vi } from "vitest";

import { macosBrowserUrlReader, windowsBrowserUrlReader } from "./browser-url.js";
import { extractDomain, sampleFocus, Tracker, type FocusSample } from "./tracker.js";

// Which platform is being described is part of every website-tracking assertion:
// macOS gets the real address out of the browser, Windows only ever sees the title.
// Naming it here keeps the suite honest on whichever machine it runs.
function macTracker(): Tracker {
  return new Tracker(undefined, macosBrowserUrlReader);
}

function windowsTracker(): Tracker {
  return new Tracker(undefined, windowsBrowserUrlReader);
}

// The only impure edge of this module. Stubbed so the suite never loads the native
// binding — the domain logic below must stay runnable on a machine without it.
const activeWindow = vi.hoisted(() => vi.fn());
vi.mock("get-windows", () => ({ activeWindow }));

/** Offsets from a fixed instant. The base is arbitrary; only the deltas are asserted. */
const BASE = Date.parse("2025-08-05T08:00:00.000Z");
function at(seconds: number): Date {
  return new Date(BASE + seconds * 1000);
}

function focus(
  appName: string,
  windowTitle: string | null = null,
  url: string | null = null,
): FocusSample {
  return { appName, windowTitle, url };
}

describe("Tracker.observeFocus", () => {
  it("emits nothing for the first observed focus", () => {
    const tracker = new Tracker();

    expect(tracker.observeFocus(focus("code"), at(0))).toBeNull();
  });

  it("closes the previous interval when focus changes, describing the app being left", () => {
    const tracker = new Tracker();
    tracker.observeFocus(focus("code"), at(0));

    const event = tracker.observeFocus(focus("chrome"), at(60));

    expect(event?.appName).toBe("code");
    expect(event?.startedAt).toBe(at(0).toISOString());
    expect(event?.endedAt).toBe(at(60).toISOString());
  });

  it("does not split the interval when the same app is observed again", () => {
    const tracker = new Tracker();
    tracker.observeFocus(focus("code"), at(0));

    expect(tracker.observeFocus(focus("code"), at(30))).toBeNull();

    // at(0), not at(30) — proves the repeated sample did not refresh the start.
    expect(tracker.observeFocus(focus("chrome"), at(90))?.startedAt).toBe(at(0).toISOString());
  });

  it("closes the interval when nothing is focused instead of letting it run", () => {
    const tracker = new Tracker();
    tracker.observeFocus(focus("code"), at(0));

    const event = tracker.observeFocus(null, at(60));

    expect(event?.appName).toBe("code");
    expect(event?.endedAt).toBe(at(60).toISOString());
    // An overnight locked laptop must not keep accruing time against the last app.
    expect(tracker.observeFocus(null, at(50000))).toBeNull();
  });

  it("starts a fresh interval after focus returns from nothing", () => {
    const tracker = new Tracker();
    tracker.observeFocus(focus("code"), at(0));
    tracker.observeFocus(null, at(60));
    tracker.observeFocus(focus("code"), at(600));

    expect(tracker.flush(at(660))?.startedAt).toBe(at(600).toISOString());
  });
});

describe("Tracker.flush", () => {
  it("closes the open interval so a single-app workday is not lost entirely", () => {
    const tracker = new Tracker();
    tracker.observeFocus(focus("code"), at(0));

    const event = tracker.flush(at(28800));

    expect(event?.appName).toBe("code");
    expect(event?.startedAt).toBe(at(0).toISOString());
    expect(event?.endedAt).toBe(at(28800).toISOString());
  });

  it("returns null on a second flush", () => {
    const tracker = new Tracker();
    tracker.observeFocus(focus("code"), at(0));
    tracker.flush(at(60));

    expect(tracker.flush(at(120))).toBeNull();
  });
});

describe("clientEventId", () => {
  it("is a distinct uuid on every emitted event", () => {
    const tracker = new Tracker();
    tracker.observeFocus(focus("code"), at(0));
    const first = tracker.observeFocus(focus("chrome"), at(60));
    const second = tracker.observeFocus(focus("slack"), at(120));

    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(first?.clientEventId).toMatch(uuid);
    expect(second?.clientEventId).toMatch(uuid);
    expect(first?.clientEventId).not.toBe(second?.clientEventId);
  });

  it("is fixed at emit time so a retried event keeps its idempotency key", () => {
    const tracker = new Tracker();
    tracker.observeFocus(focus("code"), at(0));
    const event = tracker.observeFocus(focus("chrome"), at(60));

    // The buffer holds this object; a failed flush re-sends it unchanged.
    const resent = JSON.parse(JSON.stringify(event)) as {
      clientEventId: string;
    };
    expect(resent.clientEventId).toBe(event?.clientEventId);
  });
});

describe("extractDomain", () => {
  it("takes the hostname out of an http or https URL", () => {
    expect(extractDomain("https://github.com/aems/repo?tab=readme")).toBe("github.com");
    expect(extractDomain("http://stackoverflow.com/questions/1")).toBe("stackoverflow.com");
  });

  it("drops the port and any userinfo", () => {
    expect(extractDomain("https://jira.internal.example.com:8443/browse/AEMS-1")).toBe(
      "jira.internal.example.com",
    );
    expect(extractDomain("https://alice:hunter2@grafana.example.com/d/abc")).toBe(
      "grafana.example.com",
    );
  });
});

describe("extractDomain rejections", () => {
  it("returns null for a window title that is not a URL", () => {
    expect(extractDomain("Inbox (12) - Outlook")).toBeNull();
    expect(extractDomain("tracker.ts - aems - Visual Studio Code")).toBeNull();
    expect(extractDomain("Untitled-1")).toBeNull();
    expect(extractDomain("")).toBeNull();
    expect(extractDomain(null)).toBeNull();
  });

  it("returns null for schemes that are not web browsing", () => {
    expect(extractDomain("file:///C:/Users/dev/notes.md")).toBeNull();
    expect(extractDomain("chrome://settings/privacy")).toBeNull();
    expect(extractDomain("about:blank")).toBeNull();
  });
});

describe("extractDomain without a scheme", () => {
  it("handles bare host strings that URL() rejects on their own", () => {
    expect(extractDomain("github.com/aems/repo")).toBe("github.com");
    expect(extractDomain("youtube.com")).toBe("youtube.com");
    expect(extractDomain("mail.google.com/mail/u/0/#inbox")).toBe("mail.google.com");
  });
});

describe("extractDomain and internationalised hosts", () => {
  it("normalises an IDN to one stable form so a site is not reported twice", () => {
    // Unicode and punycode spellings of the same host must not split the totals.
    expect(extractDomain("https://日本.jp/page")).toBe("xn--wgv71a.jp");
    expect(extractDomain("https://xn--wgv71a.jp/page")).toBe("xn--wgv71a.jp");
    expect(extractDomain("日本.jp/page")).toBe("xn--wgv71a.jp");
  });

  it("keeps an IDN whose punycode TLD is not plain ascii letters", () => {
    expect(extractDomain("https://пример.рф/x")).toBe("xn--e1afmkfd.xn--p1ai");
  });
});

describe("extractDomain plausibility guard", () => {
  it("accepts a schemeless IDN whose TLD punycodes to a non-alphabetic label", () => {
    expect(extractDomain("пример.рф/x")).toBe("xn--e1afmkfd.xn--p1ai");
  });

  it("still rejects a bare number, which URL() reads as an IPv4 shorthand", () => {
    expect(extractDomain("2.5")).toBeNull();
    expect(extractDomain("Build 10.0.26200")).toBeNull();
  });
});

describe("extractDomain normalisation", () => {
  it("folds the www subdomain away so one site is not reported as two", () => {
    expect(extractDomain("https://www.youtube.com/watch?v=x")).toBe("youtube.com");
    expect(extractDomain("www.github.com/aems")).toBe("github.com");
  });

  it("only strips a leading www label, never a host that merely starts with those letters", () => {
    expect(extractDomain("https://wwwtest.example.com/")).toBe("wwwtest.example.com");
    expect(extractDomain("https://docs.www.example.com/")).toBe("docs.www.example.com");
  });
});

describe("Tracker domain attribution", () => {
  it("puts the browsed domain on the emitted event", () => {
    const tracker = macTracker();
    tracker.observeFocus(focus("chrome", "AEMS", "https://github.com/aems/repo"), at(0));

    const event = tracker.observeFocus(focus("code"), at(60));

    expect(event?.domain).toBe("github.com");
    expect(event?.url).toBe("https://github.com/aems/repo");
  });

  it("falls back to the window title when no URL was readable", () => {
    // Windows has no maintained way to read the tab URL, so the title is all there is.
    const tracker = windowsTracker();
    tracker.observeFocus(focus("chrome", "stackoverflow.com/questions/1", null), at(0));

    expect(tracker.flush(at(60))?.domain).toBe("stackoverflow.com");
  });

  it("reports no domain for an ordinary application", () => {
    const tracker = new Tracker();
    tracker.observeFocus(focus("code", "tracker.ts - aems - Visual Studio Code"), at(0));

    expect(tracker.flush(at(60))?.domain).toBeNull();
  });

  it("never turns a non-browser window title into a website", () => {
    // "README.md" parses as a host — .md is Moldova. An editor, a mail client and a
    // file manager all put names like it in the title bar, and every one of them
    // would land in a report as a site the employee visited.
    const tracker = new Tracker();
    tracker.observeFocus(focus("Notepad", "README.md"), at(0));

    expect(tracker.flush(at(60))?.domain).toBeNull();
  });
});

describe("Tracker website intervals", () => {
  it("splits the interval when the browser moves to another site", () => {
    // Without this the whole browser session collapses into one row and scope 2.5
    // ("time spent per domain") has nothing to report.
    const tracker = macTracker();
    tracker.observeFocus(focus("chrome", null, "https://github.com/aems"), at(0));

    const event = tracker.observeFocus(focus("chrome", null, "https://youtube.com/watch"), at(120));

    expect(event?.appName).toBe("chrome");
    expect(event?.domain).toBe("github.com");
    expect(event?.startedAt).toBe(at(0).toISOString());
    expect(event?.endedAt).toBe(at(120).toISOString());
  });

  it("keeps one interval while the same site is browsed", () => {
    const tracker = macTracker();
    tracker.observeFocus(focus("chrome", "Issues", "https://github.com/aems/issues"), at(0));

    // Another page on the same host is the same website visit, not a new one.
    expect(
      tracker.observeFocus(focus("chrome", "Pulls", "https://github.com/aems/pulls"), at(30)),
    ).toBeNull();
    expect(tracker.flush(at(90))?.startedAt).toBe(at(0).toISOString());
  });

  it("keeps a whole Windows browsing session as one interval when no title names a site", () => {
    // The honest consequence of title-only reading: with no host in any title there is
    // no way to tell one site from the next, so the browser reads as a single stretch
    // of "Google Chrome" with no domain rather than as invented visits.
    const tracker = windowsTracker();
    tracker.observeFocus(focus("Google Chrome", "AEMS Agent - Google Chrome"), at(0));

    // The second title is a PDF opened in the browser. If the reader ever started
    // trusting bare dotted words, "Q3-report.pdf" would split this into two visits and
    // put a file name in the website report.
    expect(
      tracker.observeFocus(focus("Google Chrome", "Q3-report.pdf - Google Chrome"), at(600)),
    ).toBeNull();

    const event = tracker.flush(at(1200));
    expect(event?.appName).toBe("Google Chrome");
    expect(event?.domain).toBeNull();
    expect(event?.startedAt).toBe(at(0).toISOString());
  });

  it("reports no domain for an intranet tool reached by IP address", () => {
    // An address, but not a domain — website reporting groups by host name, and
    // "192.168.1.10" is not one. Recorded as application time with no site.
    const tracker = windowsTracker();
    tracker.observeFocus(focus("Google Chrome", "192.168.1.10:3000/dashboard - Google Chrome"), at(0));

    expect(tracker.flush(at(60))?.domain).toBeNull();
  });

  it("does not split a non-browser app when its window title changes", () => {
    const tracker = new Tracker();
    tracker.observeFocus(focus("code", "tracker.ts - aems"), at(0));

    expect(tracker.observeFocus(focus("code", "idle.ts - aems"), at(30))).toBeNull();
    expect(tracker.flush(at(90))?.startedAt).toBe(at(0).toISOString());
  });
});

describe("sampleFocus", () => {
  beforeEach(() => {
    activeWindow.mockReset();
  });

  it("maps the frontmost window onto a focus sample", async () => {
    activeWindow.mockResolvedValue({
      platform: "macos",
      title: "AEMS - Google Chrome",
      owner: {
        name: "Google Chrome",
        processId: 1,
        path: "/x",
        bundleId: "com.google.Chrome",
      },
      url: "https://github.com/aems",
    });

    await expect(sampleFocus()).resolves.toEqual({
      appName: "Google Chrome",
      windowTitle: "AEMS - Google Chrome",
      url: "https://github.com/aems",
    });
  });

  it("reports nothing focused as null rather than throwing", async () => {
    activeWindow.mockResolvedValue(undefined);

    await expect(sampleFocus()).resolves.toBeNull();
  });

  it("reports an unreadable title as null, not as an empty title", async () => {
    // macOS returns "" for every window when Screen Recording is not granted.
    activeWindow.mockResolvedValue({
      platform: "windows",
      title: "",
      owner: { name: "Code", processId: 2, path: "C:/code.exe" },
    });

    const sample = await sampleFocus();
    expect(sample?.appName).toBe("Code");
    expect(sample?.windowTitle).toBeNull();
    expect(sample?.url).toBeNull();
  });
});

describe("extractDomain length ceiling", () => {
  it("drops a host too long for the API rather than poisoning the whole batch", () => {
    // The ingestion schema caps domain at 253; an over-long value fails validation
    // for every event sent with it, and a rejected batch is retried forever.
    const overlong = `${"a".repeat(300)}.com`;
    expect(extractDomain(`https://${overlong}/x`)).toBeNull();
    expect(extractDomain(`${"b".repeat(250)}.com`)).toBeNull();
  });

  it("keeps a host at the limit", () => {
    const exact = `${"a".repeat(249)}.com`;
    expect(exact.length).toBe(253);
    expect(extractDomain(`https://${exact}/x`)).toBe(exact);
  });
});

/**
 * The interval in progress when the agent died is the one nothing else can recover:
 * it was never emitted, so it exists only in the store. Reopening it at `now` instead
 * would silently shorten it by however long the machine was down.
 */
describe("Tracker.resume", () => {
  const startedAt = "2026-08-05T09:00:00.000Z";
  const now = new Date("2026-08-05T09:07:00.000Z");

  it("closes a resumed interval at the start it was persisted with", () => {
    const tracker = new Tracker(() => "resumed-id");
    tracker.resume({
      appName: "Code",
      windowTitle: "collector.ts",
      url: null,
      domain: null,
      startedAt,
    });

    expect(tracker.flush(now)).toEqual({
      clientEventId: "resumed-id",
      appName: "Code",
      windowTitle: "collector.ts",
      url: null,
      domain: null,
      startedAt,
      endedAt: now.toISOString(),
    });
  });

  it("hands the open interval back in the shape the store keeps it in", () => {
    const tracker = new Tracker(() => "id", {
      fidelity: "browser-url",
      read: (window) => window.url,
    });
    tracker.observeFocus(
      { appName: "Google Chrome", windowTitle: "AEMS", url: "https://www.github.com/a" },
      new Date(startedAt),
    );

    expect(tracker.openFocus).toEqual({
      appName: "Google Chrome",
      windowTitle: "AEMS",
      url: "https://www.github.com/a",
      domain: "github.com",
      startedAt,
    });
  });

  it("has no open focus once the interval is flushed", () => {
    const tracker = new Tracker(() => "id");
    tracker.resume({ appName: "Code", windowTitle: null, url: null, domain: null, startedAt });
    tracker.flush(now);

    expect(tracker.openFocus).toBeNull();
  });
});

/**
 * The `websites` data type, at the only two lines in the agent that produce either field.
 *
 * Gating the URL *reader* instead would have missed half the feature: the managed
 * browser extension's addresses arrive through `state/browser-link.json`, not through
 * the focus sample, and both paths converge here. So the gate sits on the tracker, is a
 * function rather than a captured flag, and is asked again at close time — an interval
 * opened while websites were permitted must not carry an address off a machine where
 * they have since been switched off.
 */
describe("Tracker with websites switched off", () => {
  const CHROME = focus("Google Chrome", "AEMS", "https://github.com/aems/agent");

  function offTracker(): Tracker {
    return new Tracker(() => "id", macosBrowserUrlReader, () => false);
  }

  it("reports neither the address nor the domain", () => {
    const tracker = offTracker();
    tracker.observeFocus(CHROME, at(0));

    const event = tracker.flush(at(60));

    expect(event?.url).toBeNull();
    expect(event?.domain).toBeNull();
  });

  it("still reports the application, because that is a different type and still true", () => {
    // Dropping the row to enforce a website setting would silently blank the Apps view
    // as well — deleting activity the employee did agree to.
    const tracker = offTracker();
    tracker.observeFocus(CHROME, at(0));
    const closed = tracker.flush(at(60));

    expect(closed?.appName).toBe("Google Chrome");
    expect(closed?.windowTitle).toBe("AEMS");
  });

  it("stops splitting the interval when the browser moves between sites", () => {
    // Identity is the app plus the site. With no site to see, two hosts in one browser
    // are one stretch of "Google Chrome" — which is exactly what a machine that cannot
    // read addresses already produces, and the honest shape here too.
    const tracker = offTracker();

    tracker.observeFocus(CHROME, at(0));
    const split = tracker.observeFocus(
      focus("Google Chrome", "AEMS", "https://stackoverflow.com/q/1"),
      at(30),
    );

    expect(split).toBeNull();
  });

  it("nulls an address on an interval that opened while websites were still permitted", () => {
    let permitted = true;
    const tracker = new Tracker(() => "id", macosBrowserUrlReader, () => permitted);

    tracker.observeFocus(CHROME, at(0));
    permitted = false;
    const event = tracker.flush(at(60));

    expect(event?.domain).toBeNull();
    expect(event?.url).toBeNull();
  });

  it("reports the domain as before when nothing has switched it off", () => {
    const tracker = new Tracker(() => "id", macosBrowserUrlReader);
    tracker.observeFocus(CHROME, at(0));

    expect(tracker.flush(at(60))?.domain).toBe("github.com");
  });
});
