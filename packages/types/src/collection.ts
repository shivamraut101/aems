/**
 * The collection vocabulary — one list of what a device may record, and the copy that
 * describes each entry to the person being recorded.
 *
 * There were two hardcoded lists before this file: the agent's consent screen and the
 * dashboard's `monitoring-terms.ts`, whose own doc comment says that if the two ever
 * drift "one of the two is lying and neither is trustworthy". Once the set is per-device
 * that drift becomes certain rather than possible — the employee would accept three
 * items on their laptop and read five on the web — so the list lives here, is imported
 * by the API, the agent renderer and the dashboard, and cannot fork.
 *
 * The copy takes pre-formatted cadence strings rather than seconds on purpose: the
 * dashboard formats a span with `intervalLabel` and the agent with `formatSpan`, and
 * dragging either formatter into a package both depend on buys nothing.
 */

import type { DataTypeId, DevicePlatform } from "./database.types.js";

export type { DataTypeId };

/**
 * Every switchable type, in the order a consent screen should read them.
 *
 * Matches the check constraint on `device_collection_settings.data_type`. Adding one
 * here is a migration as well as an edit: the constraint, this array and
 * `PLATFORM_DATA_TYPES` are three statements of the same set.
 */
export const DATA_TYPE_IDS = [
  "applications",
  "websites",
  "screenshots",
  "idle",
  "telemetry",
  "installed_apps",
  "location",
] as const satisfies readonly DataTypeId[];

/**
 * What each platform is physically capable of, before any admin or employee decision.
 *
 * `location` is on Android only, and its absence from the two desktop sets is the fix
 * for a live hole rather than a stylistic choice: `DeviceContext` carried no platform,
 * so a laptop's device token could POST location points and have them stored. No Mac
 * has ever shipped with GPS and desktop "location" resolves to a Wi-Fi BSSID lookup
 * accurate to tens of metres at best — putting that in the same list as a phone's fix
 * is the actual harm. Enabling it later is an edit to this constant and no migration.
 *
 * `screenshots` and `idle` are desktop-only because the Android agent has neither.
 * `websites` is listed for Windows even though the agent can only recover a domain from
 * a window title there — the type is what may be reported, and `describeDataType` is
 * where the platform's fidelity is stated honestly.
 */
export const PLATFORM_DATA_TYPES: Record<
  DevicePlatform,
  readonly DataTypeId[]
> = {
  windows: [
    "applications",
    "websites",
    "screenshots",
    "idle",
    "telemetry",
    "installed_apps",
  ],
  macos: [
    "applications",
    "websites",
    "screenshots",
    "idle",
    "telemetry",
    "installed_apps",
  ],
  android: [
    "applications",
    "websites",
    "telemetry",
    "installed_apps",
    "location",
  ],
};

/**
 * What a device is permitted to collect: three sets intersected, most restrictive wins.
 *
 *   platform capability  −  admin denials  ∩  what the employee agreed to
 *
 * `granted` is null on consent rows written before per-type consent existed, meaning
 * "the platform default of the day" — so a null does not narrow anything. A `'{}'` would
 * have meant "agreed to nothing" and stopped every live device on deploy.
 *
 * `denied` is the set of types with an `enabled = false` row. An absent row permits, in
 * both directions: an unknown platform and a type invented after a device was enrolled
 * both fall through to permitted, which is what makes the deny-list shape safe.
 */
export function effectiveTypes(
  platform: DevicePlatform,
  denied: Iterable<DataTypeId>,
  granted: readonly DataTypeId[] | null,
): DataTypeId[] {
  const off = new Set(denied);
  return (PLATFORM_DATA_TYPES[platform] ?? DATA_TYPE_IDS).filter(
    (id) => !off.has(id) && (granted === null || granted.includes(id)),
  );
}

/**
 * Types an admin has switched on that the employee has not yet agreed to.
 *
 * Narrowing the scope does not force re-consent — collecting less than was agreed is
 * still covered by the agreement, and blocking collection to ask permission to collect
 * less is perverse. Widening it does, and only for the added types. That needs no state
 * machine: the server enforces `granted ∩ allowed`, so an added type is simply not
 * collected until it is agreed to, and this is the set the agent shows to ask.
 */
export function pendingTypes(
  platform: DevicePlatform,
  denied: Iterable<DataTypeId>,
  granted: readonly DataTypeId[] | null,
): DataTypeId[] {
  if (granted === null) return [];
  const off = new Set(denied);
  return (PLATFORM_DATA_TYPES[platform] ?? DATA_TYPE_IDS).filter(
    (id) => !off.has(id) && !granted.includes(id),
  );
}

/** One line of consent copy. Assignable to the dashboard's `CollectedItem`. */
export interface DataTypeCopy {
  id: DataTypeId;
  title: string;
  detail: string;
  /** True when this line describes something that is NOT collected. */
  absent?: boolean;
}

/**
 * The two policy numbers and the one platform fact the copy is parameterised by.
 *
 * Both cadences are already-formatted spans ("10 min"), and both are optional because
 * the API answers `200 null` for a company that has published no policy — the copy
 * hedges rather than printing "about every 0 min".
 */
export interface DataTypeCopyOptions {
  /** e.g. "10 min". Omitted when no policy is published. */
  screenshotInterval?: string | null;
  /** e.g. "5 min". Omitted when no policy is published. */
  idleThreshold?: string | null;
  /** macOS reads a browser's address bar over AppleScript; Windows has no supported way. */
  readsBrowserAddress?: boolean;
}

/**
 * What one data type means, in the words the person being recorded reads.
 *
 * Written against what the agents actually do rather than against the policy row, so a
 * wording that drifts from the behaviour is a bug someone can see. The negatives are
 * stated rather than omitted — a capability the platform lacks is a line saying so,
 * because quietly dropping it leaves a reader to assume the worst.
 */
export function describeDataType(
  id: DataTypeId,
  opts: DataTypeCopyOptions = {},
): DataTypeCopy {
  switch (id) {
    case "applications":
      return {
        id,
        title: "Applications you use",
        detail:
          "The name of the application in focus and how long it stays in focus.",
      };
    case "websites":
      // Windows exposes no supported way to read a browser tab's address, so promising
      // one there would describe a capability the binary does not have — on the single
      // screen whose validity rests on the description being accurate.
      return opts.readsBrowserAddress
        ? {
            id,
            title: "Website domains you visit",
            detail:
              "The domain of the page open in your browser — github.com, for example — and the time spent there. Page contents are not read.",
          }
        : {
            id,
            title: "Not the websites you visit",
            // "Cannot currently", and the sentence about the extension, because the
            // absence is a property of this machine's software and not of the agreement.
            // A Windows laptop that is later force-installed with the managed extension
            // starts recording addresses without the policy version changing, so nothing
            // re-opens this screen — and the words somebody accepted would have become
            // false with no notice. Stated in advance instead; the API also emails when
            // it happens.
            detail:
              "This computer cannot currently report the addresses of pages you open, so no website activity is recorded from it — your browser is recorded only as an application, by name and by how long it is in focus. If your organisation installs the managed AEMS browser extension here, addresses start being recorded and you will be told.",
            absent: true,
          };
    case "screenshots":
      return {
        id,
        title: "Screenshots",
        detail: `A picture of your screen ${
          opts.screenshotInterval
            ? `about every ${opts.screenshotInterval}`
            : "at regular intervals"
        }, covering every display connected to this computer. Not during a break, and not while the screen is locked.`,
      };
    case "idle":
      return {
        id,
        title: "Idle periods",
        detail: `When there has been no keyboard or mouse activity ${
          opts.idleThreshold ? `for ${opts.idleThreshold}` : "for a few minutes"
        }. What you type is never recorded — only whether input happened.`,
      };
    case "telemetry":
      return {
        id,
        title: "This device's state",
        detail:
          "Battery level, whether you are on Wi-Fi or mobile data, free storage, and how long the screen has been on.",
      };
    case "installed_apps":
      return {
        id,
        title: "Applications installed on this device",
        detail:
          "Their names and versions, alongside the device's own facts — name, operating system and version, CPU and memory. Not the contents of any of them.",
      };
    case "location":
      return {
        id,
        title: "Where this device is",
        detail:
          "This device's location while you are working, and how accurate each reading is. Only while you are clocked in.",
      };
  }
}

/** The permitted set, described. What a consent screen renders, in order. */
export function describeDataTypes(
  types: readonly DataTypeId[],
  opts: DataTypeCopyOptions = {},
): DataTypeCopy[] {
  const permitted = new Set(types);
  return DATA_TYPE_IDS.filter((id) => permitted.has(id)).map((id) =>
    describeDataType(id, opts),
  );
}

/**
 * The short name for a data type — a column heading, a chip, a line in an email.
 *
 * Distinct from `describeDataType`, which writes the sentence a consent screen needs.
 * This is the two or three words you put in a list, and it lives here rather than in
 * the dashboard because the API sends email about these too: an employee told
 * "Screen recording is no longer collected" who then reads "Screenshots" on their own
 * devices page has been handed two names for one thing and no way to know it.
 */
export const DATA_TYPE_LABEL: Record<DataTypeId, string> = {
  applications: "Applications",
  websites: "Websites",
  screenshots: "Screenshots",
  idle: "Idle time",
  telemetry: "Battery, network and storage",
  installed_apps: "Installed applications",
  location: "Location",
};
