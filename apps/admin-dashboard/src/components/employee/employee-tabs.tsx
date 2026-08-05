"use client";

import { cn } from "@aems/ui";
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
import { useRef } from "react";

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
 * and the day in the query string travels with it.
 *
 * The active tab is marked three ways — `aria-current`, a heavier weight, and an
 * underline — so it is never colour alone. Arrow keys move between tabs the way a
 * toolbar behaves; Tab still steps through them, so nothing is lost if a reader does
 * not know that.
 */
export function EmployeeTabs({ profileId }: { profileId: string }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const listRef = useRef<HTMLUListElement>(null);

  const tabs = employeeTabs(profileId);
  const active = activeTabHref(pathname, tabs);
  const query = search.toString();

  function onKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;

    const links = Array.from(listRef.current?.querySelectorAll("a") ?? []);
    if (links.length === 0) return;

    const current = links.findIndex((link) => link === document.activeElement);
    if (current === -1) return;

    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? links.length - 1
          : // Wraps, so a reader never has to reverse direction to reach the far end.
            (current + (event.key === "ArrowRight" ? 1 : -1) + links.length) % links.length;

    links[next]?.focus();
  }

  return (
    <nav aria-label="Employee sections" className="border-b">
      {/* The strip scrolls inside itself; the page body never scrolls sideways. */}
      <ul
        ref={listRef}
        onKeyDown={onKeyDown}
        className="-mb-px flex gap-1 overflow-x-auto px-6 [scrollbar-width:thin]"
      >
        {tabs.map((tab) => {
          const isActive = tab.href === active;
          const Icon = ICONS[tab.icon];

          return (
            <li key={tab.href} className="shrink-0">
              <Link
                href={withSearch(tab.href, query)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                  isActive
                    ? "border-primary font-semibold text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
