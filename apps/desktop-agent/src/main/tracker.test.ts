import { beforeEach, describe, expect, it, vi } from "vitest";

import { extractDomain, sampleFocus, Tracker, type FocusSample } from "./tracker.js";

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
    const tracker = new Tracker();
    tracker.observeFocus(focus("chrome", "AEMS", "https://github.com/aems/repo"), at(0));

    const event = tracker.observeFocus(focus("code"), at(60));

    expect(event?.domain).toBe("github.com");
    expect(event?.url).toBe("https://github.com/aems/repo");
  });

  it("falls back to the window title when no URL was readable", () => {
    // Windows has no maintained way to read the tab URL, so the title is all there is.
    const tracker = new Tracker();
    tracker.observeFocus(focus("chrome", "stackoverflow.com/questions/1", null), at(0));

    expect(tracker.flush(at(60))?.domain).toBe("stackoverflow.com");
  });

  it("reports no domain for an ordinary application", () => {
    const tracker = new Tracker();
    tracker.observeFocus(focus("code", "tracker.ts - aems - Visual Studio Code"), at(0));

    expect(tracker.flush(at(60))?.domain).toBeNull();
  });
});

describe("Tracker website intervals", () => {
  it("splits the interval when the browser moves to another site", () => {
    // Without this the whole browser session collapses into one row and scope 2.5
    // ("time spent per domain") has nothing to report.
    const tracker = new Tracker();
    tracker.observeFocus(focus("chrome", null, "https://github.com/aems"), at(0));

    const event = tracker.observeFocus(focus("chrome", null, "https://youtube.com/watch"), at(120));

    expect(event?.appName).toBe("chrome");
    expect(event?.domain).toBe("github.com");
    expect(event?.startedAt).toBe(at(0).toISOString());
    expect(event?.endedAt).toBe(at(120).toISOString());
  });

  it("keeps one interval while the same site is browsed", () => {
    const tracker = new Tracker();
    tracker.observeFocus(focus("chrome", "Issues", "https://github.com/aems/issues"), at(0));

    // Another page on the same host is the same website visit, not a new one.
    expect(
      tracker.observeFocus(focus("chrome", "Pulls", "https://github.com/aems/pulls"), at(30)),
    ).toBeNull();
    expect(tracker.flush(at(90))?.startedAt).toBe(at(0).toISOString());
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
