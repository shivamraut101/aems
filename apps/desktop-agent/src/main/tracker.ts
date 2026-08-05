import { randomUUID } from "node:crypto";

import type { ActivityEventInput } from "@aems/types";

import type { BrowserUrlReader, FocusedWindow } from "./browser-url.js";
import { createBrowserUrlReader } from "./browser-url.js";
// Type-only, and deliberately the store's shape rather than a second declaration of
// it: the two would drift, and the one that drifted would silently stop restoring.
import type { PersistedFocus } from "./persistence.js";

/** One observation of the frontmost window. */
export type FocusSample = FocusedWindow;

/**
 * Reads the frontmost window through `get-windows`.
 *
 * Returns `null` when nothing is focused. That is a real state (locked screen, empty
 * desktop) and must be reported rather than skipped, because `observeFocus` uses it
 * to close the open interval.
 *
 * On Windows `get-windows` degrades to a no-op stub when its node-pre-gyp prebuild
 * failed to download, so this must assert loudly at startup instead of quietly
 * reporting that nobody used any application all day.
 */
export async function sampleFocus(): Promise<FocusSample | null> {
  // Imported lazily so the pure logic in this file stays loadable — and testable —
  // on a machine where the native binding is missing.
  const { activeWindow } = await import("get-windows");
  const window = await activeWindow();
  if (!window) return null;

  return {
    appName: window.owner.name,
    // macOS hands back "" for every title when Screen Recording is not granted.
    // Reporting that as an empty string would make a permission failure look like a
    // window that genuinely has no title.
    windowTitle: window.title === "" ? null : window.title,
    url: ("url" in window ? window.url : null) ?? null,
  };
}

/**
 * Reduces a browser URL to the host that website reporting groups by.
 *
 * Parsing is left to the WHATWG `URL` implementation rather than a pattern of our
 * own: it already resolves ports, userinfo, IDN and percent-encoding, and every one
 * of those is somewhere a hand-written matcher eventually gets a host wrong.
 */
export function extractDomain(value: string | null | undefined): string | null {
  if (!value) return null;

  const hostname = hostnameOf(value.trim());
  return hostname === null ? null : withinApiLimit(normaliseHost(hostname));
}

function hostnameOf(candidate: string): string | null {
  const url = parseUrl(candidate);
  if (url !== null) {
    // Only the web is a "website". file://, chrome:// and about: are not browsing.
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : null;
  }

  // Address bars and window titles routinely carry the host with the scheme elided.
  // `URL` refuses those outright, so it gets a scheme and the result is then checked
  // for plausibility — otherwise "Untitled-1" parses happily as a hostname.
  const assumed = parseUrl(`https://${candidate}`);
  if (assumed === null || !looksLikeHost(assumed.hostname)) return null;

  return assumed.hostname;
}

/**
 * The ingestion schema caps `domain` at 253 characters, which is also the DNS limit.
 *
 * `URL` does not enforce it, and one over-long host would fail validation for the
 * entire batch it travels in — a rejected batch is retried unchanged, so a single
 * malformed address bar would stall every event behind it. Dropping the domain costs
 * one interval of website attribution instead.
 */
function withinApiLimit(hostname: string): string | null {
  return hostname.length <= 253 ? hostname : null;
}

/**
 * Folds away the one subdomain that is never a different site.
 *
 * `www.github.com` and `github.com` are the same destination, and a report that
 * lists both halves someone's time across two rows. Reducing further — to the
 * registered domain proper — needs the public suffix list, which is a dependency and
 * a data file that has to stay current; hostnames are accurate without it.
 */
function normaliseHost(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

function parseUrl(candidate: string): URL | null {
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

/**
 * A weak plausibility test, deliberately not a public-suffix lookup.
 *
 * It only has to separate a host from an ordinary window title, and it errs towards
 * rejecting: a missed domain costs one interval of website attribution, whereas a
 * false one puts a fabricated site in somebody's report.
 */
function looksLikeHost(hostname: string): boolean {
  const labels = hostname.split(".");
  const tld = labels.length > 1 ? labels[labels.length - 1] : undefined;

  if (tld === undefined || tld.length < 2) return false;

  // Letters, or the punycode form a non-Latin TLD like .рф normalises to. What is
  // being excluded is a trailing all-digit label: "2.5" and "Build 10.0.26200" are
  // version numbers, but `URL` reads them as IPv4 shorthand and yields a "hostname".
  return /^[a-z]+$/.test(tld) || /^xn--[a-z0-9-]+$/.test(tld);
}

/** The focus currently being timed. Becomes an event only once it ends. */
interface OpenInterval {
  sample: FocusSample;
  /** Resolved once, at open time — it is both the event's field and half its identity. */
  domain: string | null;
  startedAt: Date;
}

/**
 * Folds focus samples into closed activity intervals.
 *
 * Pure by design — `now` is always a parameter and nothing here reads a clock or
 * touches I/O, which is what makes the behaviour testable without fake timers.
 */
export class Tracker {
  private current: OpenInterval | null = null;

  /**
   * Both dependencies are injectable: ids so tests can assert on them without
   * matching a random string, and the URL reader so the Windows and macOS halves of
   * website tracking are both exercisable from either machine.
   */
  constructor(
    private readonly newEventId: () => string = randomUUID,
    private readonly urlReader: BrowserUrlReader = createBrowserUrlReader(process.platform),
  ) {}

  /**
   * A new focus does not become an event until focus moves away from it, so every
   * emitted event has a real duration rather than a guess.
   *
   * Identity is the app plus the site it is showing. The window title is left out on
   * purpose — an editor moving between files is one stretch of work, not twenty — but
   * a browser moving between hosts is genuinely two visits, and collapsing those
   * would leave website tracking with a single row per browser per day.
   *
   * `clientEventId` must be generated here, at emit time, not when the event is
   * finally sent — a retry has to reuse the same id for the API's idempotent upsert
   * to recognise it.
   */
  observeFocus(sample: FocusSample | null, now: Date): ActivityEventInput | null {
    const previous = this.current;

    // A locked screen or an empty desktop ends the interval. Treating it as "no
    // reading" instead would attribute the whole overnight span to the last app.
    if (sample === null) {
      this.current = null;
      return previous === null ? null : this.close(previous, now);
    }

    // The reader, not the raw sample, decides what may be called an address: only it
    // knows whether this platform can see a URL at all, and whether a window title is
    // a browser's or an editor's.
    const domain = extractDomain(this.urlReader.read(sample));
    if (
      previous !== null &&
      previous.sample.appName === sample.appName &&
      previous.domain === domain
    ) {
      return null;
    }

    this.current = { sample, domain, startedAt: now };
    return previous === null ? null : this.close(previous, now);
  }

  private close(interval: OpenInterval, now: Date): ActivityEventInput {
    return {
      clientEventId: this.newEventId(),
      appName: interval.sample.appName,
      windowTitle: interval.sample.windowTitle,
      url: interval.sample.url,
      domain: interval.domain,
      startedAt: interval.startedAt.toISOString(),
      endedAt: now.toISOString(),
    };
  }

  /**
   * Closes the open interval at clock-out and on shutdown.
   *
   * Without this an employee who stays in one application all day emits nothing at
   * all, because events are only produced when focus changes.
   */
  flush(now: Date): ActivityEventInput | null {
    const open = this.current;
    this.current = null;
    return open === null ? null : this.close(open, now);
  }

  /**
   * The open interval in the shape the durable store keeps it in, or null.
   *
   * Exposed rather than persisted from inside because the store belongs to the loop:
   * a tracker that wrote its own file would be a second component inventing a path,
   * which is how two halves of the same state end up disagreeing after a crash.
   */
  get openFocus(): PersistedFocus | null {
    const open = this.current;
    if (open === null) return null;

    return {
      appName: open.sample.appName,
      windowTitle: open.sample.windowTitle,
      url: open.sample.url,
      domain: open.domain,
      startedAt: open.startedAt.toISOString(),
    };
  }

  /**
   * Reopens the interval a crash interrupted, at the moment it actually began.
   *
   * Reopening at `now` instead would silently shorten it by however long the machine
   * was down, and dropping it would lose it entirely — an interval only becomes an
   * event when focus moves away, so the open one exists nowhere but the store.
   *
   * The persisted `domain` is trusted rather than re-derived: it was resolved by the
   * reader for the platform that observed it, and re-reading it here would attribute
   * the interval to whatever this launch's reader makes of a stale title.
   */
  resume(focus: PersistedFocus): void {
    const startedAt = new Date(focus.startedAt);
    if (Number.isNaN(startedAt.getTime())) return;

    this.current = {
      sample: { appName: focus.appName, windowTitle: focus.windowTitle, url: focus.url },
      domain: focus.domain,
      startedAt,
    };
  }

  /**
   * When the interval currently being timed began, or null when nothing is focused.
   *
   * The collection loop reads this to cap how long one interval may run. Without a cap
   * an employee who stays in one application all day produces a single eight-hour
   * event that exists nowhere until shutdown — so the timeline stays empty all day and
   * a crash loses the lot.
   */
  get openedAt(): Date | null {
    return this.current?.startedAt ?? null;
  }
}
