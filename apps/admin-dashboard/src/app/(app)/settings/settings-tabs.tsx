"use client";

import { NavTabs, NavTabsItem } from "@aems/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The two settings routes, as links.
 *
 * `NavTabs` rather than Radix `Tabs` because each tab is a real route: Radix would emit
 * `role="tab"` with `aria-controls` pointing at a panel that does not exist, and take
 * the links out of the natural tab order for nothing. See the note in
 * `packages/ui/src/components/tabs.tsx`.
 *
 * Two routes rather than one long page, and the reason is the prefetch. Website access
 * carries a refusal feed that most visits to Settings do not want; putting it behind
 * its own route means its two reads are warmed only when someone asks for them, while
 * the company page's four are warmed only when they ask for that.
 */
const TABS: readonly { href: string; label: string }[] = [
  { href: "/settings", label: "Company" },
  { href: "/settings/restrictions", label: "Website access" },
];

export function SettingsTabs() {
  const pathname = usePathname();

  return (
    <NavTabs label="Settings sections" className="mb-6">
      {TABS.map((tab) => (
        <NavTabsItem
          key={tab.href}
          // Exact for the index, prefix for the rest: `startsWith("/settings")` would
          // light Company on every settings route there will ever be.
          active={tab.href === "/settings" ? pathname === "/settings" : pathname.startsWith(tab.href)}
        >
          <Link href={tab.href}>{tab.label}</Link>
        </NavTabsItem>
      ))}
    </NavTabs>
  );
}
