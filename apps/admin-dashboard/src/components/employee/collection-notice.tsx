"use client";

import { usePathname } from "next/navigation";

import { CollectionOff } from "@/components/states";
import { ALL_DATA_TYPES, useCollectionOff } from "@/lib/queries/collection";
import type { DataTypeId } from "@aems/types";

/**
 * "Part of this page is switched off" — once, above whichever tab is open.
 *
 * Sited in the person page's layout rather than repeated inside the seven tabs, which
 * is the only arrangement that makes the guarantee hold: a tab added later inherits the
 * notice instead of being the one screen that quietly draws an ordinary empty state
 * over a policy decision. That failure is what this component exists to prevent, and
 * seven copies of it would reintroduce it on the eighth.
 *
 * It is filtered by tab all the same. "Screenshots are switched off" above the
 * Applications table is true and irrelevant, and a notice a reader learns to skip is
 * worse than no notice — so each route names the types it actually renders, and the
 * component says nothing when none of them is off.
 *
 * Neutral, not amber: a manager reading this is looking at a decision somebody in their
 * own company took on purpose, which is not a fault and must not be dressed as an
 * incident. The employee's own screens use `tone="subject"`.
 */
const TAB_TYPES: Record<string, readonly DataTypeId[]> = {
  // The ribbon and the event feed are built from focus intervals and idle stretches,
  // and both carry the "with no device reporting" phrasing that a switched-off type
  // turns into a false claim.
  timeline: ["applications", "websites", "screenshots", "idle"],
  screenshots: ["screenshots"],
  apps: ["applications", "installed_apps"],
  websites: ["websites"],
  // The Devices tab has its own per-machine panel, which says more than this can —
  // including the types that are still ON, which is the question that tab is asked.
  devices: [],
  // A report is read away from the screen, so an omission there is the one that does
  // the most damage. Everything is named.
  reports: ALL_DATA_TYPES,
};

export function CollectionNotice({ profileId }: { profileId: string }) {
  const pathname = usePathname();
  const { off } = useCollectionOff(profileId);

  // The last segment is the tab, except on the Overview tab, which is the bare
  // `/people/:id` route and shows a bit of all of it.
  const tab = pathname.split("/")[4] ?? "";
  const types = tab in TAB_TYPES ? TAB_TYPES[tab] : ALL_DATA_TYPES;

  return <CollectionOff className="mx-4 mt-4 sm:mx-6" {...off(...(types ?? []))} />;
}
