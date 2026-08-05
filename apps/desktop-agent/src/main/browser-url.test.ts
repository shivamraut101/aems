import { describe, expect, it } from "vitest";

import {
  createBrowserUrlReader,
  createLinkedBrowserUrlReader,
  isBrowser,
  macosBrowserUrlReader,
  windowsBrowserUrlReader,
} from "./browser-url.js";

describe("windowsBrowserUrlReader", () => {
  it("takes the address out of a browser title that carries one", () => {
    expect(
      windowsBrowserUrlReader.read({
        appName: "Google Chrome",
        windowTitle: "stackoverflow.com/questions/1 - Google Chrome",
        url: null,
      }),
    ).toBe("stackoverflow.com/questions/1");
  });

  it("reads nothing from an application that is not a browser", () => {
    // An editor's title is full of paths and dotted filenames. Attributing any of
    // them to a website would put a site nobody visited in somebody's report.
    expect(
      windowsBrowserUrlReader.read({
        appName: "Visual Studio Code",
        windowTitle: "src/main/tracker.ts - aems - Visual Studio Code",
        url: null,
      }),
    ).toBeNull();
  });

  it("does not treat a slash inside a page title as a web address", () => {
    // GitHub puts a repository path in its <title>. The part before the slash has to
    // be host-shaped, or every page whose title mentions a path becomes a "website".
    expect(
      windowsBrowserUrlReader.read({
        appName: "Google Chrome",
        windowTitle: "aems/docs/design.md at main - Google Chrome",
        url: null,
      }),
    ).toBeNull();
  });

  it("keeps a title segment that spells out the scheme", () => {
    // Browsers show the whole URL when a page fails to load, which is exactly when
    // the employee is on a site and there is no <title> to describe it.
    expect(
      windowsBrowserUrlReader.read({
        appName: "Google Chrome",
        windowTitle: "https://github.com/aems/repo - Google Chrome",
        url: null,
      }),
    ).toBe("https://github.com/aems/repo");
  });

  it("keeps a bare host that announces itself with www", () => {
    // No file is called "www.something", so the prefix is evidence in a way that a
    // plain dotted word never is.
    expect(
      windowsBrowserUrlReader.read({
        appName: "Firefox",
        windowTitle: "www.gov.uk - Mozilla Firefox",
        url: null,
      }),
    ).toBe("www.gov.uk");
  });

  it("reads a private-browsing window the same as any other", () => {
    // Firefox separates with an em dash and appends its own mode marker. Neither is
    // a reason to report nothing: a private window is still time on a work device,
    // and consent covers it exactly as it covers the rest.
    expect(
      windowsBrowserUrlReader.read({
        appName: "Firefox",
        windowTitle: "example.org/help — Mozilla Firefox Private Browsing",
        url: null,
      }),
    ).toBe("example.org/help");
  });

  it("keeps an intranet host that carries a port", () => {
    // Self-hosted tools are the ones most likely to have no <title>, so this is where
    // a title-derived address is most often the only reading available.
    expect(
      windowsBrowserUrlReader.read({
        appName: "Microsoft Edge",
        windowTitle: "jira.internal.example.com:8443/browse/AEMS-1 - Microsoft Edge",
        url: null,
      }),
    ).toBe("jira.internal.example.com:8443/browse/AEMS-1");
  });

  it("reads nothing off a search results page, which quotes addresses it is not on", () => {
    // Searching for "example.com/pricing" puts that address in the title while the
    // employee is sitting on the search engine. Reporting the quoted site would be a
    // record of a visit that never happened.
    expect(
      windowsBrowserUrlReader.read({
        appName: "Google Chrome",
        windowTitle: "example.com/pricing - Google Search - Google Chrome",
        url: null,
      }),
    ).toBeNull();
  });
});

describe("macosBrowserUrlReader", () => {
  it("uses the address the OS itself read out of the browser", () => {
    expect(
      macosBrowserUrlReader.read({
        appName: "Google Chrome",
        windowTitle: "AEMS - Google Chrome",
        url: "https://github.com/aems/repo?tab=readme",
      }),
    ).toBe("https://github.com/aems/repo?tab=readme");
  });
});

describe("createBrowserUrlReader", () => {
  it("gives each supported platform the reader that matches what it can see", () => {
    expect(createBrowserUrlReader("darwin")).toBe(macosBrowserUrlReader);
    expect(createBrowserUrlReader("win32")).toBe(windowsBrowserUrlReader);
  });
});

describe("windowsBrowserUrlReader on real window titles", () => {
  // Captured from get-windows on a Windows 11 machine, verbatim. Every one of them is
  // a page an employee actually had open, and not one contains the host. This is what
  // scope 2.5 looks like on Windows: mostly nothing, honestly reported as nothing.
  const observed = [
    "AEMS Agent - Google Chrome",
    "Employee Monitoring System Open-Source - Google Chrome",
    "Jan Aushadhi Generic Medicine Equivalents - Google Gemini - Google Chrome",
  ];

  it.each(observed)("reads no address from %s", (windowTitle) => {
    expect(
      windowsBrowserUrlReader.read({ appName: "Google Chrome", windowTitle, url: null }),
    ).toBeNull();
  });

  it("survives a page title that contains the separator itself", () => {
    // "Jan Aushadhi ... - Google Gemini - Google Chrome" splits three ways. Judging
    // each piece on its own is what keeps a mis-split from assembling a host.
    expect(
      windowsBrowserUrlReader.read({
        appName: "Google Chrome",
        windowTitle: "Q3 - Revenue - Forecast - example.net/reports - Google Chrome",
        url: null,
      }),
    ).toBe("example.net/reports");
  });
});

describe("windowsBrowserUrlReader refusals", () => {
  const refused: Array<[string, string]> = [
    // .pdf and .md are not TLDs, but .ai and .zip are, and no rule short of the public
    // suffix list separates a file name from a host. So none of them are guessed at.
    ["a downloaded file", "report.pdf - Google Chrome"],
    ["a document name", "notes.md - Google Chrome"],
    ["an asset whose extension is also a TLD", "logo.ai - Google Chrome"],
    // Outlook Web and Teams put addresses in the title. The site is outlook.office.com,
    // never the domain of the person being mailed.
    ["an email address", "Inbox - shivam@primexmeta.com - Google Chrome"],
    ["a local file", "file:///C:/Users/dev/notes.md - Google Chrome"],
    ["a version number", "Release 10.0.26200 - Google Chrome"],
    ["a bare host with nothing to corroborate it", "example.com - Google Chrome"],
  ];

  it.each(refused)("refuses %s", (_case, windowTitle) => {
    expect(
      windowsBrowserUrlReader.read({ appName: "Google Chrome", windowTitle, url: null }),
    ).toBeNull();
  });

  it("refuses an authority carrying an @, so userinfo cannot rename the host", () => {
    // "alice@example.com/inbox" resolves to example.com, but which site the employee
    // was actually on is unknowable from that. Unknowable means nothing is reported.
    expect(
      windowsBrowserUrlReader.read({
        appName: "Google Chrome",
        windowTitle: "Shared - alice@example.com/inbox - Google Chrome",
        url: null,
      }),
    ).toBeNull();
  });

  it("reads nothing when the title is unavailable", () => {
    expect(
      windowsBrowserUrlReader.read({ appName: "Google Chrome", windowTitle: null, url: null }),
    ).toBeNull();
  });

  it("ignores a url field on Windows, where no such field is ever populated", () => {
    // WindowsResult has no `url`. A value in it would mean something upstream invented
    // one, and website reporting must not be the place that trust is extended.
    expect(
      windowsBrowserUrlReader.read({
        appName: "Google Chrome",
        windowTitle: "AEMS Agent - Google Chrome",
        url: "https://github.com/aems",
      }),
    ).toBeNull();
  });
});

describe("isBrowser", () => {
  // Left column is what get-windows reports: the executable's FileDescription on
  // Windows, the bundle display name on macOS, or the file name when a binary carries
  // no description at all.
  it.each(["Google Chrome", "chrome.exe", "Microsoft Edge", "msedge.exe", "Firefox", "Safari"])(
    "recognises %s",
    (appName) => {
      expect(isBrowser(appName)).toBe(true);
    },
  );

  it.each([
    "Visual Studio Code",
    "Microsoft Teams",
    "Windows Explorer",
    "GitHubDesktop.exe",
    "Chrome Remote Desktop",
  ])("does not recognise %s", (appName) => {
    expect(isBrowser(appName)).toBe(false);
  });
});

/** Edge really does put one of these between "Microsoft" and "Edge". */
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

describe("private and multi-profile browser windows", () => {
  it("reads an incognito window", () => {
    expect(
      windowsBrowserUrlReader.read({
        appName: "Google Chrome",
        windowTitle: "example.com/pricing - Google Chrome (Incognito)",
        url: null,
      }),
    ).toBe("example.com/pricing");
  });

  it("reads past the profile name Edge puts in the title", () => {
    // Edge separates its own name with a zero-width space. Nothing here depends on
    // that, because the browser's segment is never the one being read.
    expect(
      windowsBrowserUrlReader.read({
        appName: "Microsoft Edge",
        windowTitle: `example.com/report - Work - Microsoft${ZERO_WIDTH_SPACE} Edge`,
        url: null,
      }),
    ).toBe("example.com/report");
  });
});

describe("macosBrowserUrlReader", () => {
  it("does not fall back to the window title when the URL is missing", () => {
    // On macOS a missing URL is a missing Accessibility or Automation grant. Guessing
    // from the title would hide a permission failure behind thin website data.
    expect(
      macosBrowserUrlReader.read({
        appName: "Google Chrome",
        windowTitle: "example.com/pricing - Google Chrome",
        url: null,
      }),
    ).toBeNull();
  });
});

describe("reader fidelity", () => {
  it("states how much of website tracking each platform can actually see", () => {
    // The renderer and the dashboard need this to say "not available on this device"
    // rather than draw an empty chart that reads as "nobody browsed".
    expect(createBrowserUrlReader("darwin").fidelity).toBe("browser-url");
    expect(createBrowserUrlReader("win32").fidelity).toBe("window-title");
  });
});

describe("createLinkedBrowserUrlReader", () => {
  const NOW = new Date("2026-08-05T09:00:00.000Z");

  function link(url: string | null, linked: boolean) {
    return { currentUrl: () => url, linked: () => linked };
  }

  it("prefers what the extension reported over what Windows could infer from a title", () => {
    // This is the whole reason the extension exists: on Windows there is no supported
    // way to read a tab's address, so the title reader recovers almost nothing.
    const reader = createLinkedBrowserUrlReader(
      windowsBrowserUrlReader,
      link("https://github.com/aems/pulls", true),
      () => NOW,
    );

    expect(
      reader.read({ appName: "Google Chrome", windowTitle: "Pull requests", url: null }),
    ).toBe("https://github.com/aems/pulls");
  });

  it("never attributes a browser's page to a window that is not a browser", () => {
    // A report that arrived while the employee is in an editor is not evidence about
    // the editor, and attributing it would put a website on an interval nobody spent
    // on the web.
    const reader = createLinkedBrowserUrlReader(
      windowsBrowserUrlReader,
      link("https://github.com/aems", true),
      () => NOW,
    );

    expect(reader.read({ appName: "Code.exe", windowTitle: "index.ts", url: null })).toBeNull();
  });

  it("falls back to the platform reader when nothing fresh has been reported", () => {
    const reader = createLinkedBrowserUrlReader(
      windowsBrowserUrlReader,
      link(null, true),
      () => NOW,
    );

    expect(
      reader.read({
        appName: "Google Chrome",
        windowTitle: "example.com/pricing - Google Chrome",
        url: null,
      }),
    ).toBe("example.com/pricing");
  });

  it("claims browser-url fidelity only while an extension is actually connected", () => {
    // The consent screen promises "website domains you visit" off this value, so it has
    // to drop back the moment the extension is removed.
    expect(
      createLinkedBrowserUrlReader(windowsBrowserUrlReader, link(null, true), () => NOW).fidelity,
    ).toBe("browser-url");

    expect(
      createLinkedBrowserUrlReader(windowsBrowserUrlReader, link(null, false), () => NOW).fidelity,
    ).toBe("window-title");
  });

  it("leaves macOS at browser-url either way, because it could already read the address", () => {
    expect(
      createLinkedBrowserUrlReader(macosBrowserUrlReader, link(null, false), () => NOW).fidelity,
    ).toBe("browser-url");
  });
});
