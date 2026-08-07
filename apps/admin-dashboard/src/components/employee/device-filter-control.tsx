"use client";

import { cn } from "@aems/ui";
import { Laptop, Smartphone } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { platformLabel } from "@/lib/queries/usage";
import type { DeviceRow } from "@/lib/api";

import { deviceHref, useDeviceFilter } from "./use-device-filter";

const chip = [
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium",
  "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  "focus-visible:ring-offset-1 focus-visible:ring-offset-background",
].join(" ");

/**
 * Which machine the page is showing, beside the day control that says when.
 *
 * Every tab on this page aggregated a person's devices together, which is the right
 * default — "how was their day" is a question about the person, and the reduction
 * unions overlapping devices rather than adding them. But a manager also has to be
 * able to ask about one machine: an employee with a laptop and two phones produced
 * one merged stream, so "what did the field phone do yesterday" had no answer, and
 * neither did "this device went quiet on Tuesday — what was it doing before that".
 *
 * Rendered as chips rather than a `<select>` on purpose. There are two or three of
 * these, the platform icon carries most of the meaning at a glance, and the current
 * choice has to be readable without opening anything — the same reason the screenshot
 * state filter is a chip row.
 *
 * Hidden entirely below two devices. A filter offering one option is a control that
 * cannot change anything, and it would sit on the header of most people in the company
 * implying a choice that is not there.
 */
export function DeviceFilterControl({ devices }: { devices: readonly DeviceRow[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const selected = useDeviceFilter();

  if (devices.length < 2) return null;

  const go = (deviceId: string | null) =>
    // `replace`, matching the day control: stepping between machines is scanning, not
    // navigation, and it must not fill the Back button.
    router.replace(deviceHref(pathname, search.toString(), deviceId), { scroll: false });

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      role="group"
      aria-label="Filter by device"
    >
      <button
        type="button"
        onClick={() => go(null)}
        aria-pressed={selected === null}
        className={cn(
          chip,
          selected === null
            ? "border-transparent bg-primary text-primary-foreground"
            : "border-input bg-card hover:bg-secondary",
        )}
      >
        All devices
      </button>

      {devices.map((device) => {
        const Icon = device.platform === "android" ? Smartphone : Laptop;
        const active = selected === device.id;
        const name = device.device_name || device.label;

        return (
          <button
            key={device.id}
            type="button"
            onClick={() => go(device.id)}
            aria-pressed={active}
            // The platform is in the title rather than the chip: two Windows laptops
            // are told apart by their name, and repeating "Windows" on both spends
            // width on the word they share.
            title={`${name} · ${platformLabel(device.platform)}`}
            className={cn(
              chip,
              "max-w-[12rem]",
              active
                ? "border-transparent bg-primary text-primary-foreground"
                : "border-input bg-card hover:bg-secondary",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{name}</span>
          </button>
        );
      })}
    </div>
  );
}
