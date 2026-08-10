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

import type { HeartbeatInput } from "@aems/types";

import type { BrowserLinkView } from "./browser-url.js";
import type { JsonFile } from "./persistence.js";

export const BROWSER_LINK_FILE = "browser-link.json";

/**
 * How long a page report is believed.
 *
 * Paired with the extension's repeat: it re-sends the address in view every 20 seconds,
 * so this is three missed repeats. Both halves are needed. A window this short with no
 * repeat recorded only navigations — a page read for ten minutes counted for thirty
 * seconds and the rest of the interval had no domain at all. A repeat with no window
 * would let a browser killed mid-page go on collecting the employee's time forever.
 */
export const OBSERVATION_TTL_MS = 60_000;

/**
 * How long a connection counts as proof the extension is installed.
 *
 * Used for the *capability* claim, not for attribution — it is what lets the consent
 * screen promise "website domains you visit" on a Windows machine, where the promise
 * is otherwise empty. A week means a laptop that spent the weekend shut down still
 * describes itself correctly on Monday morning.
 */
export const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How recently a browser must have connected to be counted.
 *
 * Shorter than {@link LINK_TTL_MS} because the count answers a different question. The
 * capability claim survives a weekend deliberately; the count exists so a *duplicate*
 * install is visible, and on the week-long window an extension moved out of Chrome and
 * into Edge reads as two connected browsers for the next seven days — inventing exactly
 * the problem the number was added to reveal.
 *
 * A day, because a browser in use reconnects far more often than that: Chrome recycles
 * the service worker constantly and every restart opens the channel again. A browser
 * nobody opened yesterday drops out of the count, which understates rather than
 * invents — the same direction `browserLabel` takes for an unrecognised browser.
 */
export const ACTIVE_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** One browser's report. See {@link BrowserLinkStore.update} for what the key is. */
export interface BrowserObservation {
  /**
   * `chrome-extension://<id>/` — the origin Chrome handed the host on the command line.
   *
   * Deliberately *not* the map key. The manifest pins the extension id, so every
   * Chromium browser that loads this extension is spawned with the same origin, and
   * keying by it would have Chrome and Edge take turns overwriting one entry. Kept
   * because it is still the only thing that says which extension spoke.
   */
  origin: string;
  /** The address of the page in view, or null when this browser has no focused page. */
  url: string | null;
  observedAt: string;
  /** When this browser last opened the channel. */
  linkedAt: string;
  extensionVersion: string | null;
}

/**
 * One navigation the extension refused, waiting to be reported.
 *
 * `ruleId` is the numeric `declarativeNetRequest` id the extension enforced, not the
 * rule's uuid — the browser is never told the uuid and must not be. The API maps it
 * back against the company's own rules, which is also what stops a fabricated id from
 * naming a rule belonging to somebody else.
 */
export interface BrowserBlockRecord {
  clientEventId: string;
  url: string;
  ruleId: number | null;
  at: string;
}

/**
 * How many refusals are held before the oldest are dropped.
 *
 * Matches the ingest route's own per-request cap, so a full buffer is exactly one
 * request. The bound exists because this file is written by a process a browser
 * spawns: a machine that browses for a week with the agent stopped must not grow an
 * unbounded document that then fails to parse.
 */
export const MAX_PENDING_BLOCKS = 200;

export interface BrowserLinkDocument {
  browsers: Record<string, BrowserObservation>;
  /**
   * Refusals the agent has not yet reported.
   *
   * Here rather than in the agent's own event journal because the process that learns
   * about a block is the bridge, which Chrome starts and stops at will and which never
   * holds the device token. This document is the one thing both processes already
   * share.
   */
  blocks: BrowserBlockRecord[];
}

export function emptyBrowserLink(): BrowserLinkDocument {
  return { browsers: {}, blocks: [] };
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

  for (const [key, raw] of Object.entries(browsers as Record<string, unknown>)) {
    const observation = parseObservation(key, raw);
    if (observation !== null) parsed[key] = observation;
  }

  return { browsers: parsed, blocks: parseBlocks((value as { blocks?: unknown }).blocks) };
}

/**
 * Absent is the ordinary case — every document written before refusals were reported
 * has no such key, and a machine that has never blocked anything never grows one.
 */
function parseBlocks(value: unknown): BrowserBlockRecord[] {
  if (!Array.isArray(value)) return [];

  const parsed: BrowserBlockRecord[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const clientEventId = record["clientEventId"];
    const url = record["url"];
    const at = record["at"];
    if (typeof clientEventId !== "string" || typeof url !== "string" || typeof at !== "string") {
      continue;
    }
    const ruleId = record["ruleId"];
    parsed.push({
      clientEventId,
      url,
      // A non-integer id is dropped to null rather than the whole record: the refusal
      // happened either way, and losing the record loses the evidence the block list
      // exists to produce.
      ruleId: typeof ruleId === "number" && Number.isInteger(ruleId) ? ruleId : null,
      at,
    });
  }

  return parsed.slice(-MAX_PENDING_BLOCKS);
}

/**
 * @param key The map key, which is only the origin for an entry a browser that does not
 * name itself wrote — so it is the fallback, not the answer.
 */
function parseObservation(key: string, raw: unknown): BrowserObservation | null {
  if (typeof raw !== "object" || raw === null) return null;

  const record = raw as Record<string, unknown>;
  const observedAt = record["observedAt"];
  const linkedAt = record["linkedAt"];
  const url = record["url"];

  if (typeof observedAt !== "string" || typeof linkedAt !== "string") return null;
  if (url !== null && typeof url !== "string") return null;

  return {
    origin: typeof record["origin"] === "string" ? record["origin"] : key,
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

/**
 * When this browser last opened the channel, or null if that is too long ago to mean
 * anything.
 *
 * One definition of "recently", shared by the count, the boolean and the heartbeat
 * report. Three answers to the same question that could disagree is how a dashboard ends
 * up reporting no extension beside a count of two.
 */
function freshLinkAt(observation: BrowserObservation, now: Date, ttlMs: number): number | null {
  const at = parseStamp(observation.linkedAt);
  if (at === null || at > now.getTime() || now.getTime() - at > ttlMs) return null;
  return at;
}

/** How many browsers on this machine have connected inside the capability window. */
export function linkedBrowsers(
  document: BrowserLinkDocument,
  now: Date,
  ttlMs: number = LINK_TTL_MS,
): number {
  return Object.values(document.browsers).filter(
    (observation) => freshLinkAt(observation, now, ttlMs) !== null,
  ).length;
}

/** Whether any browser on this machine has an extension that has connected recently. */
export function isBrowserLinked(
  document: BrowserLinkDocument,
  now: Date,
  ttlMs: number = LINK_TTL_MS,
): boolean {
  return linkedBrowsers(document, now, ttlMs) > 0;
}

/**
 * What the heartbeat tells the API about the browser extension.
 *
 * Built here rather than in `sync.ts` so the window it applies lives beside the two
 * other TTLs it has to stay consistent with. Ageing an entry out is also the whole
 * uninstall story: an extension removed from a profile simply stops connecting, its
 * entry goes stale, and the device reports `linked: false` on the next beat past the
 * window — nothing has to observe the removal for the dashboard to stop claiming a
 * browser that is gone.
 */
export function browserLinkReport(
  document: BrowserLinkDocument,
  now: Date,
  ttlMs: number = LINK_TTL_MS,
  activeTtlMs: number = ACTIVE_LINK_TTL_MS,
): NonNullable<HeartbeatInput["browserLink"]> {
  let linked = false;
  let browsers = 0;
  let newest: { at: number; observation: BrowserObservation } | null = null;

  for (const observation of Object.values(document.browsers)) {
    const at = freshLinkAt(observation, now, ttlMs);
    if (at === null) continue;

    linked = true;
    // Two windows, because `linked` and `browsers` answer different questions — see
    // ACTIVE_LINK_TTL_MS. A machine that connected last week therefore reports
    // `linked: true, browsers: 0`, which is the honest pair: it has the extension, and
    // nothing has connected from it lately.
    if (now.getTime() - at <= activeTtlMs) browsers += 1;
    if (newest === null || at > newest.at) newest = { at, observation };
  }

  return {
    linked,
    extensionVersion: newest?.observation.extensionVersion ?? null,
    lastSeenAt: newest?.observation.linkedAt ?? null,
    browsers,
  };
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
   * `key` is whatever actually tells two browsers apart — the name the extension gave on
   * hello where it gave one, the origin otherwise. It is not the origin, because the
   * pinned extension id makes that identical across every Chromium browser; the true
   * origin therefore has to arrive in the patch instead of being read off the key.
   *
   * Read-modify-write from two host processes can lose an entry when Chrome and Edge
   * report in the same instant. It self-heals on the next report from the losing
   * browser, and the alternative — a lock file held by a process a browser can kill at
   * any moment — fails worse.
   */
  update(key: string, patch: Partial<BrowserObservation>): BrowserLinkDocument {
    const document = this.read();
    const previous = document.browsers[key];

    // The stamp being written, not the wall clock: it is the host's own clock, which is
    // the only one anything in this file is measured against, and it keeps pruning
    // deterministic for a caller that supplies its own.
    const now = new Date(
      Date.parse(patch.observedAt ?? patch.linkedAt ?? "") || Date.now(),
    );

    const next: BrowserLinkDocument = {
      // Carried through untouched. A navigation report and a refusal arrive on the same
      // channel microseconds apart, and rebuilding the document without this drops the
      // refusal that the very next page load would have reported.
      blocks: document.blocks,
      browsers: {
        ...kept(document.browsers, key, now),
        [key]: {
          origin: patch.origin ?? previous?.origin ?? key,
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

  /**
   * Records a refusal for the agent to report.
   *
   * Oldest-first eviction at {@link MAX_PENDING_BLOCKS}: with the agent stopped, the
   * recent refusals are the ones worth keeping, and an unbounded array in a file two
   * processes rewrite on every navigation is a slow way to corrupt it.
   */
  appendBlock(record: BrowserBlockRecord): void {
    const document = this.read();
    this.file.write({
      ...document,
      blocks: [...document.blocks, record].slice(-MAX_PENDING_BLOCKS),
    });
  }

  /**
   * Hands the pending refusals to the caller and clears them in one write.
   *
   * At-most-once, deliberately. The alternative is holding them until the API confirms,
   * which needs a second state machine in a document a browser-spawned process rewrites
   * constantly — and a refusal reported twice would show an employee two blocks where
   * one happened. `client_event_id` still de-duplicates a retry within one request.
   */
  takeBlocks(): BrowserBlockRecord[] {
    const document = this.read();
    if (document.blocks.length === 0) return [];

    this.file.write({ ...document, blocks: [] });
    return document.blocks;
  }
}

/** `chrome-extension://<id>/` — how this file was keyed before browsers named themselves. */
const ORIGIN_KEY = /^chrome-extension:\/\//;

/**
 * The other browsers' entries, minus the ones that are no longer anybody.
 *
 * Two removals, both of which the count would otherwise report as a connected browser:
 *
 * - **Past the capability window.** Nothing reads an entry that old, so keeping it only
 *   grows a file two processes rewrite on every navigation.
 * - **Keyed by the origin.** The extension id is pinned by the manifest, so the origin is
 *   identical in every Chromium browser and this file used to collapse them all into one
 *   entry. Every build since names the browser on hello, which means an origin key can
 *   only be a leftover from before — and left in place it doubles the count on the first
 *   machine to take an update, for a browser that no longer has a separate existence.
 */
function kept(
  browsers: Record<string, BrowserObservation>,
  writing: string,
  now: Date,
): Record<string, BrowserObservation> {
  const legacy = !ORIGIN_KEY.test(writing);
  const out: Record<string, BrowserObservation> = {};

  for (const [key, observation] of Object.entries(browsers)) {
    if (key === writing) continue;
    if (legacy && ORIGIN_KEY.test(key)) continue;
    if (stale(observation, now)) continue;
    out[key] = observation;
  }

  return out;
}

/**
 * Whether an entry is past every window that reads it.
 *
 * Both stamps, because they age independently: a browser open on one page since Monday
 * has a week-old `linkedAt` and a fresh `observedAt`, and dropping it would take the
 * address in view away from the tracker.
 */
function stale(observation: BrowserObservation, now: Date): boolean {
  const linked = parseStamp(observation.linkedAt) ?? 0;
  const observed = parseStamp(observation.observedAt) ?? 0;

  return now.getTime() - Math.max(linked, observed) > LINK_TTL_MS;
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
