"use client";

import { Badge } from "@aems/ui";
import { Laptop, Smartphone } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo } from "react";

import {
  EmptyState,
  ErrorState,
  Panel,
  SectionHeading,
  SkeletonLines,
} from "@/components/employee/states";
import { describeError, useDevices, type DeviceRow } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { devicesForProfile, gigabytes, osLabel, platformLabel } from "@/lib/queries/usage";

/**
 * Devices tab — scope §7.
 *
 * A specification panel per machine rather than a row in a table: this reads as an IT
 * inventory page (docs/design.md, Device Inventory), and a person has one or two
 * devices, where an eight-column table would be mostly empty. The company-wide table
 * on /devices is the operational view; this is the asset view for one person.
 */
export default function DevicesTabPage() {
  const params = useParams();
  const profileId = typeof params?.["profileId"] === "string" ? params["profileId"] : "";

  const { data, isPending, isError, error, refetch } = useDevices();
  const devices = useMemo(() => devicesForProfile(data ?? [], profileId), [data, profileId]);

  return (
    <div>
      <SectionHeading
        title="Devices"
        hint="Company hardware assigned to this person, and when each machine last reported in."
        action={
          devices.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {devices.length} {devices.length === 1 ? "device" : "devices"}
            </p>
          ) : null
        }
      />

      {isError ? (
        <ErrorState
          title="Devices could not be loaded"
          message={describeError(error)}
          onRetry={() => void refetch()}
        />
      ) : isPending ? (
        <Panel>
          <span className="sr-only" aria-live="polite">
            Loading devices
          </span>
          <SkeletonLines count={5} />
        </Panel>
      ) : devices.length === 0 ? (
        <Panel>
          <EmptyState
            title="No devices assigned"
            body="Nothing is being collected for this person. Install the desktop agent and sign in on the machine to enrol it, or install the Android app on a company phone."
          />
        </Panel>
      ) : (
        <div className="space-y-3">
          {devices.map((device) => (
            <DevicePanel key={device.id} device={device} />
          ))}
        </div>
      )}
    </div>
  );
}

function DevicePanel({ device }: { device: DeviceRow }) {
  const Icon = device.platform === "android" ? Smartphone : Laptop;

  return (
    <Panel className="p-0">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
        <div className="flex items-center gap-2.5">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <h3 className="text-sm font-semibold">{device.device_name || device.label}</h3>
            <p className="text-xs text-muted-foreground">
              {platformLabel(device.platform)} · {device.model?.trim() || "Model not reported"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="tabular text-xs text-muted-foreground">
            Last heartbeat {relativeTime(device.last_seen_at)}
          </span>
          <Badge
            variant={
              device.status === "active"
                ? "online"
                : device.status === "revoked"
                  ? "revoked"
                  : "offline"
            }
          >
            {device.status === "active"
              ? "Online"
              : device.status === "revoked"
                ? "Revoked"
                : "Offline"}
          </Badge>
        </div>
      </header>

      {/* A definition list rather than a table: these are facts about one machine, not
          rows to compare against each other. */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5 px-5 py-4 text-sm sm:grid-cols-3 lg:grid-cols-4">
        <Spec label="Operating system" value={osLabel(device.platform, device.os_version)} />
        <Spec label="CPU" value={device.cpu?.trim() || null} />
        <Spec label="Memory" value={gigabytes(device.ram_mb)} />
        <Spec label="Storage" value={gigabytes(device.storage_mb)} />
        <Spec label="Agent" value={device.agent_version?.trim() || null} />
        <Spec label="Enrolled" value={calendarDate(device.enrolled_at)} />
        <Spec label="Device label" value={device.label} />
        <Spec label="Device ID" value={device.id} mono />
      </dl>

      {device.status === "revoked" ? (
        <p className="border-t px-5 py-2.5 text-xs text-muted-foreground">
          This device was revoked and stops collecting on its next request. Its history is kept as a
          record.
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * One fact.
 *
 * An unreported value renders as a dash, never as an empty cell: an agent that has not
 * sent a CPU string and a machine with no CPU must not look the same.
 */
function Spec({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  const text = value && value !== "—" ? value : null;

  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 truncate ${mono ? "font-mono text-xs" : ""}`} title={text ?? undefined}>
        {text ?? "—"}
      </dd>
    </div>
  );
}

function calendarDate(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}
