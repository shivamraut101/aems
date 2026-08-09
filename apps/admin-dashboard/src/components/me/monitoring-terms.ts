/**
 * What a device records, in the words the person being recorded reads.
 *
 * This is compliance copy, not decoration, so it is a pure module with tests rather
 * than sentences inlined in JSX. Two rules hold it together:
 *
 *  1. **It is written against what the agent actually does**, not against what the
 *     policy row says it might. The strings below are the dashboard's half of the
 *     agent's own consent screen (`apps/desktop-agent/src/renderer/screens/
 *     ConsentScreen.tsx` → `collectedItems`). Someone who accepted terms on their
 *     laptop and then reads this page must find the same list, or one of the two is
 *     lying and neither is trustworthy.
 *  2. **A capability the device does not have is stated as absent**, not omitted.
 *     `get-windows` reads a browser tab's address only on macOS, over AppleScript;
 *     Windows exposes no supported way to do it (CLAUDE.md open item 6) unless the
 *     managed browser extension is connected to the agent, which is why the website
 *     line turns on that as well as on the platform. Quietly dropping the line would
 *     leave a reader to assume the worst, and printing it unconditionally would promise
 *     collection the binary cannot perform.
 *
 * `docs/design.md` forbids surveillance framing. That constrains tone, not accuracy:
 * the honest way to avoid sounding like surveillance is to say exactly what is taken
 * and exactly what is not, which is what the negatives at the bottom are for.
 */

import {
  intervalLabel,
  screenshotsPerDay,
  type PolicyRecord,
} from "@/lib/queries/settings-view";

export type DevicePlatform = "windows" | "macos" | "android";

export interface CollectedItem {
  title: string;
  detail: string;
  /** True when this line describes something that is NOT collected. */
  absent?: boolean;
}

/** The terms a policy states, reduced to the two numbers that matter to a person. */
export interface PolicyTerms {
  version: string;
  name: string;
  screenshotIntervalSeconds: number;
  idleThresholdSeconds: number;
  trackedCategories: readonly string[];
}

/**
 * The stored row, reduced to the terms.
 *
 * The API answers `200 null` for a company that has published no policy, and that null
 * has to survive all the way to the copy — every function here takes `PolicyTerms |
 * null` and hedges rather than printing a zero, because "screenshots about every 0 min"
 * is worse than "at regular intervals".
 */
export function toPolicyTerms(record: PolicyRecord | null | undefined): PolicyTerms | null {
  if (!record) return null;

  return {
    version: record.version,
    name: record.name,
    screenshotIntervalSeconds: record.screenshot_interval_seconds,
    idleThresholdSeconds: record.idle_threshold_seconds,
    trackedCategories: record.tracked_categories ?? [],
  };
}

export function platformLabel(platform: DevicePlatform): string {
  switch (platform) {
    case "windows":
      return "Windows";
    case "macos":
      return "macOS";
    case "android":
      return "Android";
  }
}

/**
 * Can this device report the address of the page in the browser?
 *
 * Two ways to get one, and the agent's own consent screen decides it the same way: the
 * macOS agent reads it over AppleScript, and a Windows machine gets there only when the
 * managed browser extension is connected. Kept as a named predicate so the reason
 * appears once instead of a `=== "macos"` scattered through copy that would silently
 * mean something else if a third desktop platform were ever added.
 *
 * The default is the honest one for a caller that does not know — a device that has
 * never said whether an extension is connected has not earned the positive claim.
 */
export function readsBrowserAddress(platform: DevicePlatform, extensionLinked = false): boolean {
  return platform === "macos" || extensionLinked;
}

/**
 * Which of the three things the websites line can say is true of this device.
 *
 * A capability and a permission are different questions and the copy needs both, because
 * the honest sentence differs: a machine that *cannot* read an address and one that has
 * been *told not to* are not the same fact, and only the second has somebody's decision
 * behind it. Reading the extension link alone told an employee whose manager had switched
 * websites off that the addresses they visit are recorded, on the one page that exists so
 * they can check exactly that.
 *
 * Null recording permits, matching the agent: an absent scope is not a denial.
 */
export type WebsiteStance = "recorded" | "incapable" | "switched-off";

export function websiteStance(
  platform: DevicePlatform,
  extensionLinked = false,
  recording: boolean | null = null,
): WebsiteStance {
  if (recording === false) return "switched-off";
  return readsBrowserAddress(platform, extensionLinked) ? "recorded" : "incapable";
}

/** "about every 10 min", or a hedge when no policy has been published yet. */
export function screenshotCadence(policy: PolicyTerms | null): string {
  return policy === null
    ? "at regular intervals"
    : `about every ${intervalLabel(policy.screenshotIntervalSeconds)}`;
}

/** "after 1 min", or a hedge. */
export function idleCadence(policy: PolicyTerms | null): string {
  return policy === null
    ? "for a few minutes"
    : `for ${intervalLabel(policy.idleThresholdSeconds)}`;
}

/**
 * Roughly how many pictures an eight-hour day produces.
 *
 * An interval is abstract; a count is not. "Every 10 minutes" and "about 48 screenshots
 * in an eight-hour day" are the same fact, and only the second one lands.
 */
export function capturesPerWorkingDay(policy: PolicyTerms | null): number {
  return policy === null ? 0 : screenshotsPerDay(policy.screenshotIntervalSeconds);
}

/**
 * What one device records, given the platform it is and the policy in force.
 *
 * Android is a different agent with different sensors — it has no screenshot capture
 * and no window titles — so it gets its own list rather than a desktop list with two
 * lines quietly wrong. Location is absent from both, and stated as absent, because
 * non-negotiable #6 says it is not implemented and an employee has no way to verify
 * that other than being told.
 */
export function collectedItems(
  platform: DevicePlatform,
  policy: PolicyTerms | null,
  extensionLinked = false,
  recording: boolean | null = null,
): CollectedItem[] {
  if (platform === "android") {
    return [
      {
        title: "Apps you use on this phone",
        detail: "Which applications are opened and for how long. Not what you do inside them.",
      },
      {
        title: "Screen time and device state",
        detail:
          "How long the screen is on, the battery level, whether you are on Wi-Fi or mobile data, and free storage.",
      },
      {
        title: "This device",
        detail: "Model, Android version, memory and storage, and when it last synchronised.",
      },
      {
        title: "Not your location",
        detail:
          "Location tracking is not built into this product. Nothing on this phone reports where it is.",
        absent: true,
      },
      {
        title: "Not your messages, photos or personal accounts",
        detail: "Only the app names above and the device facts above are sent.",
        absent: true,
      },
    ];
  }

  return [
    {
      title: "Applications you use",
      detail: "The name of the application in focus and how long it stays in focus.",
    },
    websiteItem(websiteStance(platform, extensionLinked, recording)),
    {
      title: "Idle periods",
      detail: `When there has been no keyboard or mouse activity ${idleCadence(policy)}. What you type is never recorded — only whether input happened.`,
    },
    {
      title: "Screenshots",
      detail: `A picture of your screen ${screenshotCadence(policy)}, covering every display connected to this computer.`,
    },
    {
      title: "This device",
      detail:
        "Device name, operating system and version, CPU and memory, and the list of applications installed on it.",
    },
    {
      title: "Not your keystrokes, files or camera",
      detail:
        "The agent does not record what you type, does not read the contents of your files, and never switches on a camera or microphone.",
      absent: true,
    },
  ];
}

/** The websites line, in the terms that are actually true of this machine right now. */
function websiteItem(stance: WebsiteStance): CollectedItem {
  if (stance === "recorded") {
    return {
      title: "Website domains you visit",
      detail:
        "The domain of the page open in your browser — github.com, for example — and the time spent there. Page contents are not read.",
    };
  }

  if (stance === "switched-off") {
    return {
      title: "Not the websites you visit",
      detail:
        "Website activity is switched off for this device, so nothing about your browsing is recorded from it. Your browser is recorded only as an application, by name and by how long it is in focus.",
      absent: true,
    };
  }

  return {
    title: "Not the websites you visit",
    detail:
      "This computer cannot report the addresses of pages you open, so no website activity is recorded from it. Your browser is recorded only as an application, by name and by how long it is in focus.",
    absent: true,
  };
}

/**
 * The three promises the product makes to the person being monitored.
 *
 * Non-negotiables 1, 2 and 3, said out loud on the screen where they are actionable.
 * They are listed as a first-person "what you can do" rather than as policy, because a
 * right nobody can find is not a right.
 */
export const MONITORING_PROMISES: readonly { title: string; detail: string }[] = [
  {
    title: "Nothing is collected without your agreement",
    detail:
      "Each device only starts recording once you accept the policy on it, and the server refuses anything sent without that agreement on file.",
  },
  {
    title: "Monitoring is never silent",
    detail:
      "While the agent is recording it keeps a tray icon and an on-screen indicator visible. There is no hidden mode.",
  },
  {
    title: "You can read everything recorded about you",
    detail:
      "My activity shows the same day your manager sees — the same totals, the same timeline, the same screenshots.",
  },
];

/**
 * Why this exists at all, in one paragraph, without the word "monitoring" doing all the
 * work.
 *
 * `docs/design.md`: position it as workforce intelligence, not surveillance — and that
 * is a claim about purpose, so the purpose is what is stated.
 */
export const WHY_THIS_EXISTS =
  "Your employer uses AEMS to measure how work time is actually spent — hours worked, focused time, which tools a day goes into. It runs only on company-enrolled devices, only after you accept the terms on each one, and everything it records about you is on this dashboard for you to read.";
