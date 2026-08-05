/**
 * Reads the address of the page an employee is looking at.
 *
 * Split out of `tracker.ts` because the two supported platforms answer this question
 * with completely different confidence, and scope §2.5 ("browser domain, time spent")
 * is only honest if the difference is visible rather than averaged away.
 */

import type { UrlFidelity } from "../shared/types/index.js";

/** The frontmost window, as far as a URL reader is concerned. */
export interface FocusedWindow {
  appName: string;
  windowTitle: string | null;
  /** Address the OS itself reported. macOS only — `WindowsResult` has no such field. */
  url: string | null;
}

// How much of §2.5 the platform can see is something the renderer has to state to the
// employee, so it lives in the shared contract; re-exported here because this is the
// module that decides which value a platform gets.
export type { UrlFidelity };

export interface BrowserUrlReader {
  readonly fidelity: UrlFidelity;
  /** An address we are confident is the page in view, or null. Never a guess. */
  read(window: FocusedWindow): string | null;
}

/**
 * Applications whose window title may describe a website.
 *
 * Matched exactly rather than by substring, and by the name the OS reports rather
 * than by the title, because this set is the only thing standing between website
 * reporting and every dotted filename an editor or a chat client puts in its title
 * bar. An unrecognised browser therefore reports nothing — the failure that costs
 * coverage, not the one that invents a site.
 *
 * The names are what `get-windows` actually hands back: on Windows the executable's
 * FileDescription ("Google Chrome", "Microsoft Edge", "Firefox"), falling back to the
 * file name when a binary carries no description; on macOS the bundle's display name.
 */
const BROWSER_APP_NAMES = new Set([
  "google chrome",
  "google chrome beta",
  "google chrome dev",
  "google chrome canary",
  "chrome",
  "chromium",
  "microsoft edge",
  "microsoft edge beta",
  "microsoft edge dev",
  "microsoft edge canary",
  "msedge",
  "firefox",
  "mozilla firefox",
  "firefox developer edition",
  "firefox nightly",
  "brave",
  "brave browser",
  "brave-browser",
  "opera",
  "opera gx",
  "opera browser",
  "vivaldi",
  "safari",
  "arc",
]);

/** True when the window belongs to a browser, so its title may describe a website. */
export function isBrowser(appName: string): boolean {
  const normalised = appName
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "");

  return BROWSER_APP_NAMES.has(normalised);
}

/**
 * The reader for the platform the agent is running on.
 *
 * `platform` is a parameter rather than a read of `process.platform` inside, so both
 * halves of scope §1 are exercisable from one machine — the reason the seam exists at
 * all is that the two supported platforms answer with different confidence, and a test
 * that can only ever see one of them proves nothing about shipping.
 *
 * Windows and macOS are the only supported platforms (scope §1). Anything else gets
 * the title reader: it is the conservative one, and an unsupported platform must not
 * be handed the reader that trusts a field it will never receive.
 */
export function createBrowserUrlReader(platform: NodeJS.Platform): BrowserUrlReader {
  return platform === "darwin" ? macosBrowserUrlReader : windowsBrowserUrlReader;
}

/**
 * macOS: whatever `get-windows` read out of the browser over AppleScript.
 *
 * There is deliberately no fallback to the window title here. On macOS a missing URL
 * means a missing Accessibility or Automation grant, and the honest response to a
 * permission gap is to surface it — the permissions screen exists for exactly this.
 * Papering over it with the handful of titles that happen to contain a host would
 * turn a fixable prompt into a permanently thin website report nobody investigates.
 */
export const macosBrowserUrlReader: BrowserUrlReader = {
  fidelity: "browser-url",
  read: (window) => window.url,
};

/**
 * Windows: the window title, and only when it proves it holds an address.
 *
 * `WindowsResult` has no `url` field — there is no supported way to read a tab's
 * address from outside the browser (see the `fidelity` note in the reader factory).
 * So this reads the one thing Windows does hand over, and refuses to guess from it.
 */
export const windowsBrowserUrlReader: BrowserUrlReader = {
  fidelity: "window-title",
  read(window) {
    if (!isBrowser(window.appName)) return null;
    if (window.windowTitle === null) return null;

    const segments = segmentsOf(window.windowTitle);
    if (segments.some(isSearchResultsMarker)) return null;

    for (const segment of segments) {
      if (isConfidentAddress(segment)) return segment;
    }

    return null;
  },
};

/**
 * Search engines put the query in the window title, and a query is very often an
 * address — which would be recorded as a visit to a site the employee only searched
 * for. The whole title is abandoned rather than the offending segment, because on a
 * results page every address in the title is somebody else's.
 *
 * The list is the engines in common use, not all of them; an unlisted one is a hole
 * in this defence and not in the rest of the reader.
 */
const SEARCH_RESULT_MARKERS = new Set([
  "google search",
  "bing",
  "duckduckgo",
  "yahoo search",
  "search results",
  "brave search",
  "ecosia",
  "startpage",
  "yandex",
  "baidu",
]);

function isSearchResultsMarker(segment: string): boolean {
  return SEARCH_RESULT_MARKERS.has(segment.trim().toLowerCase());
}

/**
 * The punctuation browsers use to hang their own name off the end of a page title.
 *
 * Chrome and Edge use a hyphen, Firefox an em dash, and page titles themselves lean on
 * pipes and middots. All of them are matched because the separator is not what the
 * decision rests on — every segment is judged on its own, so a wrong split costs at
 * most a missed domain and can never assemble one.
 */
const TITLE_SEPARATOR = /\s+[-–—|·•]\s+/;

function segmentsOf(title: string): string[] {
  return title.split(TITLE_SEPARATOR);
}

/**
 * Whether a fragment of a window title is an address, on the evidence of the text
 * alone.
 *
 * Every rule here demands something a page title cannot produce by accident. There is
 * deliberately no rule for a bare dotted word: `report.pdf`, `notes.md` and `logo.ai`
 * are indistinguishable from hosts without the public suffix list, and a fabricated
 * domain in a monitoring report is evidence against someone.
 */
function isConfidentAddress(segment: string): boolean {
  const candidate = segment.trim();

  return spelledOutScheme(candidate) || addressWithPath(candidate) || wwwHost(candidate);
}

/** Nothing is named `www.anything` except a host, so the prefix is proof on its own. */
function wwwHost(segment: string): boolean {
  return /^www\./i.test(segment) && looksLikeAuthority(segment);
}

/** A scheme is never in a page title by chance — the browser fell back to the URL. */
function spelledOutScheme(segment: string): boolean {
  return /^https?:\/\/\S+$/i.test(segment) && looksLikeAuthority(authorityOf(segment));
}

function authorityOf(segment: string): string {
  const withoutScheme = segment.replace(/^https?:\/\//i, "");
  const separator = withoutScheme.search(/[/?#]/);

  return separator < 0 ? withoutScheme : withoutScheme.slice(0, separator);
}

/**
 * Accepts `host/path`, the one title shape that carries its own proof of being an
 * address: a browser only ever puts a path in a title when the page had no `<title>`
 * of its own and it fell back to showing the URL.
 *
 * The authority in front of the slash still has to be host-shaped, because plenty of
 * page titles mention a path — "aems/docs/design.md at main" is a repository, not a
 * site anybody visited.
 */
function addressWithPath(segment: string): boolean {
  const separator = segment.search(/[/?#]/);
  if (separator < 1) return false;

  return looksLikeAuthority(segment.slice(0, separator));
}

/**
 * A structural check only — whether the text could be a host, not whether it is one.
 *
 * Deliberately blind to which suffixes exist: distinguishing `example.com` from
 * `report.pdf` needs the public suffix list, and without it the caller must find its
 * confidence elsewhere. Anything with whitespace or an `@` is refused outright, so an
 * email address in a page title cannot become the domain someone is reported to have
 * visited.
 */
function looksLikeAuthority(value: string): boolean {
  const host = withoutPort(value);
  if (host === null || host.length === 0 || host.length > 253) return false;
  if (/[\s@]/.test(host)) return false;

  const labels = host.split(".");
  if (labels.length < 2) return false;

  return labels.every((label) => /^[^\s.:/?#-](?:[^\s.:/?#]*[^\s.:/?#-])?$/.test(label));
}

/**
 * Strips a port, or refuses the value if what follows the colon is not one.
 *
 * Self-hosted intranet tools live on ports and are the pages least likely to carry a
 * `<title>`. A colon followed by anything else is not an authority at all — "Note: 5"
 * must not become a host.
 */
function withoutPort(value: string): string | null {
  const colon = value.indexOf(":");
  if (colon < 0) return value;

  return /^\d{1,5}$/.test(value.slice(colon + 1)) ? value.slice(0, colon) : null;
}
