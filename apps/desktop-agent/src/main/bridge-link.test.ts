import { describe, expect, it } from "vitest";

import type { BrowserLinkDocument } from "./bridge-link.js";
import {
  ACTIVE_LINK_TTL_MS,
  BrowserLinkStore,
  browserLinkReport,
  createBrowserLinkView,
  currentBrowserUrl,
  isBrowserLinked,
  LINK_CACHE_MS,
  LINK_TTL_MS,
  linkedBrowsers,
  OBSERVATION_TTL_MS,
  parseBrowserLink,
} from "./bridge-link.js";
import { JsonFile } from "./persistence.js";

const CHROME = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const EDGE = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/";
const NOW = new Date("2026-08-05T09:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function document(browsers: BrowserLinkDocument["browsers"]): BrowserLinkDocument {
  return { browsers };
}

/** A JsonFile over an in-memory map, so nothing here touches a real directory. */
function memoryFile(initial: string | null = null): { file: JsonFile; contents: () => string | null } {
  let stored = initial;

  const file = new JsonFile(
    {
      read: () => stored,
      write: (_path, contents) => {
        stored = contents;
      },
      append: () => {},
      rename: () => {},
      remove: () => {
        stored = null;
      },
    },
    "link.json",
  );

  return { file, contents: () => stored };
}

describe("parseBrowserLink", () => {
  it("answers an empty document for anything that is not one", () => {
    expect(parseBrowserLink(null)).toEqual({ browsers: {} });
    expect(parseBrowserLink("nonsense")).toEqual({ browsers: {} });
    expect(parseBrowserLink({ browsers: 4 })).toEqual({ browsers: {} });
  });

  it("keeps the entries it can read and drops the ones it cannot", () => {
    const parsed = parseBrowserLink({
      browsers: {
        [CHROME]: { url: "https://a.test/", observedAt: at(0), linkedAt: at(0), extensionVersion: "1" },
        [EDGE]: { url: 7, observedAt: at(0), linkedAt: at(0) },
        broken: { observedAt: 4 },
      },
    });

    expect(Object.keys(parsed.browsers)).toEqual([CHROME]);
    expect(parsed.browsers[CHROME]?.extensionVersion).toBe("1");
  });
});

describe("currentBrowserUrl", () => {
  it("answers the freshest report, because only one browser can be in front", () => {
    const url = currentBrowserUrl(
      document({
        [CHROME]: { origin: CHROME, url: "https://old.test/", observedAt: at(-10_000), linkedAt: at(-10_000), extensionVersion: null },
        [EDGE]: { origin: EDGE, url: "https://new.test/", observedAt: at(-1_000), linkedAt: at(-1_000), extensionVersion: null },
      }),
      NOW,
    );

    expect(url).toBe("https://new.test/");
  });

  it("ignores a report older than the TTL rather than attributing time to a closed tab", () => {
    const stale = document({
      [CHROME]: {
        origin: CHROME,
        url: "https://a.test/",
        observedAt: at(-OBSERVATION_TTL_MS - 1),
        linkedAt: at(0),
        extensionVersion: null,
      },
    });

    expect(currentBrowserUrl(stale, NOW)).toBeNull();
  });

  it("ignores a stamp from the future, which would otherwise win every comparison", () => {
    const skewed = document({
      [CHROME]: { origin: CHROME, url: "https://a.test/", observedAt: at(60_000), linkedAt: at(0), extensionVersion: null },
    });

    expect(currentBrowserUrl(skewed, NOW)).toBeNull();
  });

  it("skips a browser that reported nothing in view", () => {
    const cleared = document({
      [CHROME]: { origin: CHROME, url: null, observedAt: at(-100), linkedAt: at(0), extensionVersion: null },
      [EDGE]: { origin: EDGE, url: "https://b.test/", observedAt: at(-5_000), linkedAt: at(0), extensionVersion: null },
    });

    expect(currentBrowserUrl(cleared, NOW)).toBe("https://b.test/");
  });

  it("ignores an unparseable stamp", () => {
    const broken = document({
      [CHROME]: { origin: CHROME, url: "https://a.test/", observedAt: "yesterday", linkedAt: at(0), extensionVersion: null },
    });

    expect(currentBrowserUrl(broken, NOW)).toBeNull();
  });
});

describe("isBrowserLinked", () => {
  it("counts a connection inside the week-long capability window", () => {
    const weekend = document({
      [CHROME]: { origin: CHROME, url: null, observedAt: at(0), linkedAt: at(-LINK_TTL_MS + 1000), extensionVersion: null },
    });

    expect(isBrowserLinked(weekend, NOW)).toBe(true);
  });

  it("stops claiming the capability once the window has passed", () => {
    const gone = document({
      [CHROME]: { origin: CHROME, url: null, observedAt: at(0), linkedAt: at(-LINK_TTL_MS - 1), extensionVersion: null },
    });

    expect(isBrowserLinked(gone, NOW)).toBe(false);
    expect(isBrowserLinked(document({}), NOW)).toBe(false);
  });
});

describe("linkedBrowsers", () => {
  it("counts each browser that has connected inside the window", () => {
    const both = document({
      Chrome: { origin: CHROME, url: null, observedAt: at(0), linkedAt: at(-1000), extensionVersion: null },
      Edge: { origin: CHROME, url: null, observedAt: at(0), linkedAt: at(-2000), extensionVersion: null },
    });

    expect(linkedBrowsers(both, NOW)).toBe(2);
  });

  it("stops counting a browser whose extension has been removed", () => {
    // Nothing reports an uninstall. The entry simply stops being refreshed, and the
    // window passing is what turns it back into "no extension here".
    const stale = document({
      Chrome: { origin: CHROME, url: null, observedAt: at(0), linkedAt: at(-1000), extensionVersion: null },
      Edge: { origin: CHROME, url: null, observedAt: at(0), linkedAt: at(-LINK_TTL_MS - 1), extensionVersion: null },
    });

    expect(linkedBrowsers(stale, NOW)).toBe(1);
  });

  it("ignores a stamp from the future, as the url reader does", () => {
    const skewed = document({
      Chrome: { origin: CHROME, url: null, observedAt: at(0), linkedAt: at(60_000), extensionVersion: null },
    });

    expect(linkedBrowsers(skewed, NOW)).toBe(0);
  });
});

describe("browserLinkReport", () => {
  it("says nothing is connected when nothing is, rather than omitting the answer", () => {
    expect(browserLinkReport(document({}), NOW)).toEqual({
      linked: false,
      extensionVersion: null,
      lastSeenAt: null,
      browsers: 0,
    });
  });

  it("reports the newest connection and how many browsers there are", () => {
    const both = document({
      Chrome: { origin: CHROME, url: null, observedAt: at(0), linkedAt: at(-9000), extensionVersion: "0.1.0" },
      Edge: { origin: CHROME, url: null, observedAt: at(0), linkedAt: at(-1000), extensionVersion: "0.2.0" },
    });

    expect(browserLinkReport(both, NOW)).toEqual({
      linked: true,
      extensionVersion: "0.2.0",
      lastSeenAt: at(-1000),
      browsers: 2,
    });
  });

  it("reports the removal once the last connection has aged out", () => {
    const gone = document({
      Chrome: {
        origin: CHROME,
        url: null,
        observedAt: at(0),
        linkedAt: at(-LINK_TTL_MS - 1),
        extensionVersion: "0.1.0",
      },
    });

    expect(browserLinkReport(gone, NOW)).toEqual({
      linked: false,
      extensionVersion: null,
      lastSeenAt: null,
      browsers: 0,
    });
  });

  /**
   * The count is the whole reason a duplicate install is visible, so it must not invent
   * one. On the week-long window an extension moved out of Chrome and into Edge an hour
   * ago reads as two connected browsers for the next seven days — a number a manager
   * would act on, describing a browser that has no extension at all.
   */
  it("counts only browsers that have connected lately, while the capability claim survives", () => {
    const moved = document({
      Chrome: {
        origin: CHROME,
        url: null,
        observedAt: at(0),
        linkedAt: at(-ACTIVE_LINK_TTL_MS - 1),
        extensionVersion: "0.1.0",
      },
      Edge: { origin: CHROME, url: null, observedAt: at(0), linkedAt: at(-3600_000), extensionVersion: "0.1.0" },
    });

    expect(browserLinkReport(moved, NOW)).toMatchObject({ linked: true, browsers: 1 });
  });

  /**
   * `linked: true, browsers: 0` is not a contradiction — it is the honest pair for a
   * laptop that spent the week shut. It has the extension, and nothing has connected
   * from it lately, which is exactly what the dashboard needs to hedge instead of
   * promising a complete list.
   */
  it("keeps the capability claim when nothing has connected inside the count's window", () => {
    const weekend = document({
      Chrome: {
        origin: CHROME,
        url: null,
        observedAt: at(0),
        linkedAt: at(-3 * ACTIVE_LINK_TTL_MS),
        extensionVersion: "0.1.0",
      },
    });

    expect(browserLinkReport(weekend, NOW)).toMatchObject({ linked: true, browsers: 0 });
  });
});

describe("BrowserLinkStore", () => {
  it("leaves every other browser's entry alone when one reports", () => {
    const { file } = memoryFile();
    const store = new BrowserLinkStore(file);

    store.update(CHROME, { url: "https://a.test/", observedAt: at(0) });
    const next = store.update(EDGE, { url: "https://b.test/", observedAt: at(1000) });

    expect(next.browsers[CHROME]?.url).toBe("https://a.test/");
    expect(next.browsers[EDGE]?.url).toBe("https://b.test/");
  });

  it("keeps a field the patch does not mention", () => {
    const { file } = memoryFile();
    const store = new BrowserLinkStore(file);

    store.update(CHROME, { linkedAt: at(0), extensionVersion: "0.1.0", url: null });
    const next = store.update(CHROME, { url: "https://a.test/", observedAt: at(1000) });

    expect(next.browsers[CHROME]?.extensionVersion).toBe("0.1.0");
    expect(next.browsers[CHROME]?.linkedAt).toBe(at(0));
  });

  it("distinguishes a cleared page from an unmentioned one", () => {
    const { file } = memoryFile();
    const store = new BrowserLinkStore(file);

    store.update(CHROME, { url: "https://a.test/", observedAt: at(0) });
    const cleared = store.update(CHROME, { url: null, observedAt: at(1000) });

    expect(cleared.browsers[CHROME]?.url).toBeNull();
  });

  it("keeps two browsers apart under their own keys, sharing one pinned origin", () => {
    // The whole reason the key is not the origin: the manifest pins the extension id, so
    // Chrome and Edge are spawned with byte-identical origins and one would overwrite
    // the other.
    const { file } = memoryFile();
    const store = new BrowserLinkStore(file);

    store.update("Chrome", { origin: CHROME, linkedAt: at(0), url: null });
    const next = store.update("Edge", { origin: CHROME, linkedAt: at(1000), url: null });

    expect(Object.keys(next.browsers)).toEqual(["Chrome", "Edge"]);
    expect(next.browsers["Chrome"]?.origin).toBe(CHROME);
    expect(next.browsers["Edge"]?.origin).toBe(CHROME);
  });

  /**
   * Every machine that takes this update already has a file keyed by the origin, written
   * before browsers named themselves. Left alone it is never refreshed and never
   * removed, so the first hello lands under "Chrome" and the device reports two
   * connected browsers — for one browser — until the week is out.
   */
  it("drops the pre-naming origin entry when a browser writes under its own name", () => {
    const { file } = memoryFile();
    const store = new BrowserLinkStore(file);

    store.update(CHROME, { origin: CHROME, linkedAt: at(0), url: null });
    const next = store.update("Chrome", { origin: CHROME, linkedAt: at(1000), url: null });

    expect(Object.keys(next.browsers)).toEqual(["Chrome"]);
    expect(browserLinkReport(next, new Date(NOW.getTime() + 1000)).browsers).toBe(1);
  });

  it("forgets an entry nothing has refreshed inside the capability window", () => {
    const { file } = memoryFile();
    const store = new BrowserLinkStore(file);

    store.update("Chrome", { origin: CHROME, linkedAt: at(0), observedAt: at(0), url: null });
    const next = store.update("Edge", {
      origin: CHROME,
      linkedAt: at(LINK_TTL_MS + 1),
      observedAt: at(LINK_TTL_MS + 1),
      url: null,
    });

    expect(Object.keys(next.browsers)).toEqual(["Edge"]);
  });

  /** A browser left on one page all week has an old link and a fresh page report. */
  it("keeps an entry still reporting a page, however long ago it connected", () => {
    const { file } = memoryFile();
    const store = new BrowserLinkStore(file);

    store.update("Chrome", { origin: CHROME, linkedAt: at(0), url: null });
    store.update("Chrome", { url: "https://a.test/", observedAt: at(LINK_TTL_MS) });

    const next = store.update("Edge", {
      origin: CHROME,
      linkedAt: at(LINK_TTL_MS + 1000),
      observedAt: at(LINK_TTL_MS + 1000),
      url: null,
    });

    expect(next.browsers["Chrome"]?.url).toBe("https://a.test/");
  });

  it("reads back what it wrote through the file", () => {
    const { file, contents } = memoryFile();
    const store = new BrowserLinkStore(file);

    store.update(CHROME, { url: "https://a.test/", observedAt: at(0) });

    expect(contents()).not.toBeNull();
    expect(store.read().browsers[CHROME]?.url).toBe("https://a.test/");
  });
});

describe("createBrowserLinkView", () => {
  it("collapses the repeated reads a single tick makes into one", () => {
    const { file } = memoryFile();
    const store = new BrowserLinkStore(file);
    store.update(CHROME, { url: "https://a.test/", observedAt: at(0), linkedAt: at(0) });

    let reads = 0;
    const counted = {
      read: () => {
        reads += 1;
        return store.read();
      },
    } as BrowserLinkStore;

    const view = createBrowserLinkView(counted);

    view.currentUrl(NOW);
    view.linked(NOW);
    view.currentUrl(new Date(NOW.getTime() + LINK_CACHE_MS - 1));

    expect(reads).toBe(1);
  });

  it("re-reads once the cache window has passed, because another process writes the file", () => {
    const { file } = memoryFile();
    const store = new BrowserLinkStore(file);
    store.update(CHROME, { url: "https://a.test/", observedAt: at(0), linkedAt: at(0) });

    const view = createBrowserLinkView(store);
    expect(view.currentUrl(NOW)).toBe("https://a.test/");

    store.update(CHROME, { url: "https://b.test/", observedAt: at(LINK_CACHE_MS) });

    expect(view.currentUrl(new Date(NOW.getTime() + LINK_CACHE_MS))).toBe("https://b.test/");
  });

  it("re-reads when the clock jumps backwards rather than pinning a stale url", () => {
    const { file } = memoryFile();
    const store = new BrowserLinkStore(file);
    store.update(CHROME, { url: "https://a.test/", observedAt: at(0), linkedAt: at(0) });

    let reads = 0;
    const counted = {
      read: () => {
        reads += 1;
        return store.read();
      },
    } as BrowserLinkStore;

    const view = createBrowserLinkView(counted);
    view.currentUrl(NOW);
    view.currentUrl(new Date(NOW.getTime() - 60_000));

    expect(reads).toBe(2);
  });
});
