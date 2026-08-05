/**
 * What the browser extension observed, handed to the collection loop through a file.
 *
 * The native messaging host is a *separate process*: Chrome spawns it, the running
 * agent does not. So the two need somewhere to meet, and this is it — one small JSON
 * document under the agent's state directory, written by the bridge and only ever read
 * by the agent.
 *
 * The bridge deliberately does **not** post the observation to the API itself, even
 * though it could read the device token from the same store the agent uses. Two
 * reasons, and the first is decisive:
 *
 * 1. **A work session id.** Events ingested with a null `work_session_id` are the one
 *    state scope §2.2 cannot aggregate over, and only the running agent knows which
 *    session is open. A browser-spawned process has no way to find out.
 * 2. **No duplicate stream.** The agent's `Tracker` already emits one interval per
 *    focused window. If the bridge emitted its own browser intervals, every second in
 *    a browser would exist twice — once as an app interval and once as a website one —
 *    and the timeline would render both.
 *
 * Handing the URL over instead means the extension *upgrades* the existing watcher
 * rather than competing with it: one ingestion path, one journal, one consent gate,
 * and the Windows website report finally has something in it.
 */

import type { BrowserLinkView } from "./browser-url.js";
import type { JsonFile } from "./persistence.js";

export const BROWSER_LINK_FILE = "browser-link.json";

/**
 * How long a page report is believed.
 *
 * Long enough to cover a service worker that Chrome put to sleep between navigations,
 * short enough that a browser closed twenty seconds ago cannot keep attributing the
 * employee's time to the last site they had open. The agent samples every five
 * seconds, so this is six missed reports.
 */
export const OBSERVATION_TTL_MS = 30_000;

/**
 * How long a connection counts as proof the extension is installed.
 *
 * Used for the *capability* claim, not for attribution — it is what lets the consent
 * screen promise "website domains you visit" on a Windows machine, where the promise
 * is otherwise empty. A week means a laptop that spent the weekend shut down still
 * describes itself correctly on Monday morning.
 */
export const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One browser's report. Keyed by extension origin so Chrome and Edge cannot overwrite each other. */
export interface BrowserObservation {
  /** `chrome-extension://<id>/` — the origin Chrome handed the host on the command line. */
  origin: string;
  /** The address of the page in view, or null when this browser has no focused page. */
  url: string | null;
  observedAt: string;
  /** When this browser last opened the channel. */
  linkedAt: string;
  extensionVersion: string | null;
}

export interface BrowserLinkDocument {
  browsers: Record<string, BrowserObservation>;
}

export function emptyBrowserLink(): BrowserLinkDocument {
  return { browsers: {} };
}

/**
 * Reads the document defensively.
 *
 * Written by a process a browser started, so the same rule applies as to the wire
 * protocol: anything that is not exactly the expected shape is discarded rather than
 * repaired. A missing file is the ordinary case — most machines have no extension.
 */
export function parseBrowserLink(value: unknown): BrowserLinkDocument {
  if (typeof value !== "object" || value === null) return emptyBrowserLink();

  const browsers = (value as { browsers?: unknown }).browsers;
  if (typeof browsers !== "object" || browsers === null) return emptyBrowserLink();

  const parsed: Record<string, BrowserObservation> = {};

  for (const [origin, raw] of Object.entries(browsers as Record<string, unknown>)) {
    const observation = parseObservation(origin, raw);
    if (observation !== null) parsed[origin] = observation;
  }

  return { browsers: parsed };
}

function parseObservation(origin: string, raw: unknown): BrowserObservation | null {
  if (typeof raw !== "object" || raw === null) return null;

  const record = raw as Record<string, unknown>;
  const observedAt = record["observedAt"];
  const linkedAt = record["linkedAt"];
  const url = record["url"];

  if (typeof observedAt !== "string" || typeof linkedAt !== "string") return null;
  if (url !== null && typeof url !== "string") return null;

  return {
    origin,
    url,
    observedAt,
    linkedAt,
    extensionVersion:
      typeof record["extensionVersion"] === "string" ? record["extensionVersion"] : null,
  };
}

function parseStamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The address of the page the employee is actually looking at, or null.
 *
 * The freshest report wins when two browsers are running, because only one of them can
 * be in front and the one in front is the one still sending. A report older than
 * {@link OBSERVATION_TTL_MS} is ignored outright — a stale URL would go on attributing
 * time to a site nobody has open, which is the failure this whole file exists to
 * prevent rather than to introduce.
 */
export function currentBrowserUrl(
  document: BrowserLinkDocument,
  now: Date,
  ttlMs: number = OBSERVATION_TTL_MS,
): string | null {
  let best: { url: string; at: number } | null = null;

  for (const observation of Object.values(document.browsers)) {
    if (observation.url === null) continue;

    const at = parseStamp(observation.observedAt);
    if (at === null) continue;
    // A stamp from the future is a clock the agent cannot reason about; ignoring it
    // beats letting it win every comparison for as long as the skew lasts.
    if (at > now.getTime() || now.getTime() - at > ttlMs) continue;

    if (best === null || at > best.at) best = { url: observation.url, at };
  }

  return best?.url ?? null;
}

/** Whether any browser on this machine has an extension that has connected recently. */
export function isBrowserLinked(
  document: BrowserLinkDocument,
  now: Date,
  ttlMs: number = LINK_TTL_MS,
): boolean {
  return Object.values(document.browsers).some((observation) => {
    const at = parseStamp(observation.linkedAt);
    return at !== null && at <= now.getTime() && now.getTime() - at <= ttlMs;
  });
}

/**
 * The link document as one object, shared by the bridge (which writes) and the agent
 * (which reads).
 *
 * `JsonFile` publishes by rename, so a bridge killed mid-write leaves the previous
 * document rather than a truncated one — the same guarantee the event journal has, for
 * the same reason.
 */
export class BrowserLinkStore {
  constructor(private readonly file: JsonFile) {}

  read(): BrowserLinkDocument {
    return parseBrowserLink(this.file.read());
  }

  /**
   * Records what one browser reported, leaving every other browser's entry alone.
   *
   * Read-modify-write from two host processes can lose an entry when Chrome and Edge
   * report in the same instant. It self-heals on the next report from the losing
   * browser, and the alternative — a lock file held by a process a browser can kill at
   * any moment — fails worse.
   */
  update(origin: string, patch: Partial<Omit<BrowserObservation, "origin">>): BrowserLinkDocument {
    const document = this.read();
    const previous = document.browsers[origin];

    const next: BrowserLinkDocument = {
      browsers: {
        ...document.browsers,
        [origin]: {
          origin,
          url: patch.url !== undefined ? patch.url : (previous?.url ?? null),
          observedAt: patch.observedAt ?? previous?.observedAt ?? new Date(0).toISOString(),
          linkedAt: patch.linkedAt ?? previous?.linkedAt ?? new Date(0).toISOString(),
          extensionVersion:
            patch.extensionVersion !== undefined
              ? patch.extensionVersion
              : (previous?.extensionVersion ?? null),
        },
      },
    };

    this.file.write(next);
    return next;
  }
}

/**
 * How long a read of the link document is reused.
 *
 * The document is read from three places on a five-second tick — the focus sample, the
 * permission readout and the status publisher — and it is written by a *different*
 * process, so it cannot be cached for a tick's length without the URL lagging behind
 * the tab. One second is short enough to be invisible on a timeline whose resolution is
 * five, and it collapses the repeated reads into one.
 */
export const LINK_CACHE_MS = 1_000;

/**
 * The link document as the URL reader wants to see it.
 *
 * Kept here rather than in `browser-url.ts` so that file stays free of the store, and
 * so the caching rule sits next to the two TTLs it has to stay smaller than.
 */
export function createBrowserLinkView(
  store: BrowserLinkStore,
  cacheMs: number = LINK_CACHE_MS,
): BrowserLinkView {
  let cached: { document: BrowserLinkDocument; at: number } | null = null;

  const current = (now: Date): BrowserLinkDocument => {
    // `<` rather than `<=`, and a backwards clock jump invalidates rather than extends:
    // a cache that outlives a clock correction would pin a stale URL for however long
    // the skew lasted.
    if (cached !== null && now.getTime() >= cached.at && now.getTime() - cached.at < cacheMs) {
      return cached.document;
    }

    cached = { document: store.read(), at: now.getTime() };
    return cached.document;
  };

  return {
    currentUrl: (now) => currentBrowserUrl(current(now), now),
    linked: (now) => isBrowserLinked(current(now), now),
  };
}
