"use client";

import { Badge } from "@aems/ui";

import { PageHeader } from "@/components/page-header";
import { useDevices } from "@/lib/api";
import { relativeTime } from "@/lib/format";

const PLATFORM_LABEL = {
  windows: "Windows",
  macos: "macOS",
  android: "Android",
} as const;

function gigabytes(mb: number | null): string {
  if (!mb) return "—";
  return `${Math.round(mb / 1024)} GB`;
}

/**
 * Device inventory.
 *
 * Reads as an IT asset list rather than a people list — hardware first, person
 * second, per docs/design.md.
 */
export default function DevicesPage() {
  const { data, isLoading, isError } = useDevices();

  return (
    <div className="mx-auto max-w-6xl px-6 py-7">
      <PageHeader
        title="Devices"
        subtitle="Company-owned hardware reporting into AEMS."
      />

      {isError ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          Could not load devices. Check that the API is running.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">
                  Device
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Platform
                </th>
                <th scope="col" className="hidden px-4 py-2 font-medium lg:table-cell">
                  CPU
                </th>
                <th scope="col" className="hidden px-4 py-2 font-medium lg:table-cell">
                  RAM
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Last heartbeat
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 4 }, (_, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td colSpan={6} className="px-4 py-2.5">
                      <span className="block h-4 w-full animate-pulse rounded bg-muted" />
                    </td>
                  </tr>
                ))
              ) : !data || data.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center">
                    <p className="text-sm font-medium">No devices enrolled</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Run the desktop agent and sign in to enrol the first machine.
                    </p>
                  </td>
                </tr>
              ) : (
                data.map((device) => (
                  <tr
                    key={device.id}
                    className="border-b transition-colors last:border-0 hover:bg-secondary/40"
                  >
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{device.device_name || device.label}</span>
                      <p className="text-xs text-muted-foreground">
                        {device.model ?? "Unknown model"} · agent {device.agent_version || "—"}
                      </p>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {PLATFORM_LABEL[device.platform]} {device.os_version}
                    </td>
                    <td className="hidden px-4 py-2.5 text-muted-foreground lg:table-cell">
                      {device.cpu ?? "—"}
                    </td>
                    <td className="tabular hidden px-4 py-2.5 text-muted-foreground lg:table-cell">
                      {gigabytes(device.ram_mb)}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge
                        variant={
                          device.status === "active"
                            ? "online"
                            : device.status === "revoked"
                              ? "revoked"
                              : "offline"
                        }
                      >
                        {device.status}
                      </Badge>
                    </td>
                    <td className="tabular px-4 py-2.5 text-right text-muted-foreground">
                      {relativeTime(device.last_seen_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
