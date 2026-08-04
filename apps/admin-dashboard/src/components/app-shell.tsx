"use client";

import { cn } from "@aems/ui";
import {
  Activity,
  LayoutDashboard,
  Laptop,
  Settings,
  Sparkles,
  Users,
  FileText,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Minimal sidebar, per docs/design.md — seven destinations, no nesting, no
 * collapsible tree. Everything deeper is reached by clicking a row.
 */
const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/people", label: "People", icon: Users },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/devices", label: "Devices", icon: Laptop },
  { href: "/reports", label: "Reports", icon: FileText },
  { href: "/insights", label: "AI Insights", icon: Sparkles },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen">
      <nav
        aria-label="Main"
        className="hidden w-56 shrink-0 flex-col border-r bg-card px-3 py-5 md:flex"
      >
        <Link href="/" className="mb-7 flex items-center gap-2 px-2">
          <span className="grid h-7 w-7 place-items-center rounded bg-primary text-xs font-semibold text-primary-foreground">
            A
          </span>
          <span className="text-sm font-semibold tracking-tight">AEMS</span>
        </Link>

        <ul className="flex flex-col gap-0.5">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            const Icon = item.icon;

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-secondary font-medium text-foreground"
                      : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
