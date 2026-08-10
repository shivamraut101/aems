"use client";

import { cn } from "@aems/ui";
import { Globe } from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import type { DeviceRow } from "@/lib/api";
import { calendarDate } from "@/lib/format";
import { extensionLive } from "@/lib/queries/usage";

/**
 * Whether this machine can report a browser address, and how many browsers do.
 *
 * The gap it closes is a rendering collision. On Windows nothing outside the browser
 * may read a tab's address, so a Windows machine with no extension produces an empty
 * Websites tab — identical on screen to an employee who genuinely opened no sites. Two
 * opposite facts drawn the same way is the failure `docs/design.md` names, and the
 * device row has known which of the two it is since migration …0021.
 *
 * The count is here for one question only: whether the extension got installed twice.
 * Nothing behaves differently at two than at one — whichever browsers have it loaded
 * report, and all of them are recorded against this device's employee, exactly as
 * screenshots and application tracking already are.
 *
 * Deliberately *not* routed through `useCollectionOff`. That component only ever makes
 * the positive claim "somebody switched this off" and is documented to fail towards
 * silence; a missing extension is a coverage gap with nobody's name on it, which is the
 * opposite direction. The visual pattern is reused, the hook is not.
 */
export interface BrowserLinkNote {
  /** Amber only where something is actually missing from the record. */
  tone: "neutral" | "warning";
  lines: string[];
}

export function browserLinkNote(device: DeviceRow, now: number = Date.now()): BrowserLinkNote | null {
  // A phone has no browser extension and never will; a revoked machine reports nothing
  // at all, and telling its reader to install something on it is advice that cannot be
  // taken.
  if (device.platform === "android" || device.status === "revoked") return null;

  const lines: string[] = [];
  let tone: BrowserLinkNote["tone"] = "neutral";
  const live = extensionLive(device.browser_extension_linked, device.browser_extension_seen_at, now);

  // Read before the channel, because the two are independent and only this one decides
  // whether anything is written down. Withdrawn consent and a switched-off `websites`
  // scope both stop the recording and neither closes the channel, so the strip used to
  // promise "website addresses from this computer are reported" directly above the
  // employee's own withdrawn-consent notice.
  if (device.website_addresses_recorded === false) {
    lines.push(
      live
        ? "The AEMS browser extension is connected to this computer, but no website addresses are being recorded from it — website activity is switched off for this device."
        : "No website addresses are being recorded from this computer — website activity is switched off for this device.",
    );
  } else if (live) {
    const browsers = device.browser_extension_count ?? 0;
    lines.push(
      browsers > 1
        ? `Website addresses from this computer are reported by the AEMS browser extension, which has connected from ${String(browsers)} browsers in the last day. All of them are recorded the same way.`
        : "Website addresses from this computer are reported by the AEMS browser extension.",
    );
    const version = device.browser_extension_version?.trim();
    if (version) lines.push(`Extension version ${version}.`);
  } else if (device.browser_extension_linked === true) {
    // Linked but stale. Not the same claim as "no extension" and not a reason to accuse
    // anyone of removing one — a laptop that has been shut for a fortnight looks exactly
    // like this, and so does one whose agent was uninstalled without the device being
    // revoked, which is the case that would otherwise assert completeness for ever.
    tone = device.platform === "windows" ? "warning" : "neutral";
    const when = calendarDate(device.browser_extension_seen_at);
    lines.push(
      `An AEMS browser extension last connected to this computer${when ? ` on ${when}` : ""}, and nothing has connected since. Treat its Websites tab as incomplete rather than empty until it does.`,
    );
  } else if (device.platform === "windows") {
    tone = "warning";
    lines.push(
      device.browser_extension_linked === false
        ? "No AEMS browser extension is connected to this computer, so no website addresses are being recorded from it. Windows gives the agent no way to read a browser's address bar — the extension is what makes the Websites tab work."
        : "This computer has not reported whether the AEMS browser extension is connected. Until it does, treat its Websites tab as incomplete rather than empty.",
    );
  } else {
    lines.push(
      "No AEMS browser extension is connected. On macOS the agent reads addresses from the browser itself, so website activity is still recorded from this computer.",
    );
  }

  return { tone, lines };
}

/**
 * The note as a strip, on both the manager's device panel and the employee's own page.
 *
 * Layout comes from the caller because the two hosts are shaped differently — a
 * full-bleed band between sections of the manager's panel, an inset card inside the
 * employee's. Only the tone and the type scale are decided here, so the wording and the
 * amber cannot drift apart between the two readers of the same fact.
 *
 * Amber through the `warning` token, never `accent`: indigo marks model output, and
 * every sentence here is a recorded fact.
 */
export function BrowserLinkStrip({
  device,
  className,
}: {
  device: DeviceRow;
  className?: string;
}) {
  const note = browserLinkNote(device);
  if (!note) return null;

  const warn = note.tone === "warning";

  return (
    <div
      className={cn(
        "flex gap-2.5 text-xs",
        warn ? "border-warning/40 bg-warning/10" : "border-border",
        className,
      )}
    >
      <Globe
        className={cn("mt-px h-3.5 w-3.5 shrink-0", warn ? "text-warning" : "text-muted-foreground")}
        aria-hidden="true"
      />
      <div className="min-w-0 space-y-1 text-muted-foreground">
        {note.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {/* Relative rather than a date: the question this answers is "is it working
            right now", and "4 minutes ago" answers it where "10 Aug 2026" does not.
            The stale branch spells out a calendar date instead, because by then the
            question has become "how long has this been missing". */}
        {extensionLive(device.browser_extension_linked, device.browser_extension_seen_at) &&
        device.browser_extension_seen_at ? (
          <p>
            A browser last connected <RelativeTime iso={device.browser_extension_seen_at} />.
          </p>
        ) : null}
      </div>
    </div>
  );
}
