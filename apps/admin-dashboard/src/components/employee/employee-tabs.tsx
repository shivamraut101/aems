"use client";

import { NavTabs, NavTabsItem } from "@aems/ui";
import {
  Camera,
  FileText,
  Globe,
  LayoutList,
  Laptop,
  LayoutDashboard,
  Waves,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { activeTabHref, employeeTabs, withSearch, type EmployeeTabIcon } from "./tabs";

const ICONS: Record<EmployeeTabIcon, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  timeline: Waves,
  screenshots: Camera,
  apps: LayoutList,
  websites: Globe,
  reports: FileText,
  devices: Laptop,
};

/**
 * The seven sections of scope §4.4 as a tab strip over nested routes.
 *
 * Links, not buttons: each section is a real URL, so back works, a tab is shareable,
 * and the day in the query string travels with it. `NavTabs` is the `@aems/ui`
 * primitive for exactly that case — a `<nav>` of anchors carrying `aria-current`,
 * rather than Radix `Tabs`, whose `role="tab"` triggers would advertise
 * `aria-controls` pointing at panels that do not exist on this page and would pull
 * seven links out of the natural tab order to give them roving focus they are not
 * supposed to have. Using it also deleted the hand-written
 * ArrowLeft/ArrowRight/Home/End handler that used to live here and was reimplementing
 * a keyboard pattern for the wrong widget.
 *
 * **375px.** Seven tabs are about 560px of content and a phone is 375. They do not
 * wrap — a wrapped tab strip stops reading as one — so the strip scrolls inside
 * itself, and only inside itself: the horizontal padding sits on the `<nav>` so the
 * page body never gains a scroll axis and the first and last tabs still line up with
 * the page gutter. Every tab is 36px tall before its underline, which is the minimum
 * touch target.
 *
 * The active tab is marked three ways — `aria-current` for assistive technology, a
 * 2px underline, and full-contrast ink against the muted rest — so it is never colour
 * alone.
 */
export function EmployeeTabs({ profileId }: { profileId: string }) {
  const pathname = usePathname();
  const search = useSearchParams();

  const tabs = employeeTabs(profileId);
  const active = activeTabHref(pathname, tabs);
  const query = search.toString();

  return (
    <NavTabs label="Employee sections" className="px-4 sm:px-6">
      {tabs.map((tab) => {
        const Icon = ICONS[tab.icon];

        return (
          <NavTabsItem key={tab.href} active={tab.href === active}>
            <Link href={withSearch(tab.href, query)}>
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {tab.label}
            </Link>
          </NavTabsItem>
        );
      })}
    </NavTabs>
  );
}
