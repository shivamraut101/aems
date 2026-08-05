"use client";

import { Badge } from "@aems/ui";
import { Laptop, ShieldOff, Smartphone } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";

import {
  EmptyState,
  ErrorState,
  Panel,
  SectionHeading,
  SkeletonLines,
} from "@/components/employee/states";
import { describeError, useDevices, useSession, type DeviceRow } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { devicesForProfile, gigabytes, osLabel, platformLabel } from "@/lib/queries/usage";

import {
  Dialog,
  FormError,
  destructiveButtonClass,
  secondaryButtonClass,
} from "@/components/dialog";
import { sortApplications, useDeviceApplications, useRevokeDevice } from "./device-queries";

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

  const { data: session } = useSession();
  const [revoking, setRevoking] = useState(false);

  // Revoking is `requireSuperAdmin` on the API. This only stops a manager being
  // offered a button that ends in a 403.
  const canRevoke = session?.role === "super_admin" && device.status !== "revoked";

  const applications = useDeviceApplications(device.id);
  const installed = useMemo(
    () => sortApplications(applications.data ?? []),
    [applications.data],
  );

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
          {canRevoke ? (
            <button
              type="button"
              onClick={() => setRevoking(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-card px-2.5 text-xs font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ShieldOff className="h-3.5 w-3.5" aria-hidden />
              Revoke
            </button>
          ) : null}
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
        {/* Scope §7 lists installed applications as part of desktop inventory. The
            agent has been reporting them since enrolment; nothing read them back. */}
        <Spec
          label="Applications"
          value={
            applications.isPending
              ? "Reading…"
              : applications.isError
                ? "Unavailable"
                : installed.length === 0
                  ? "None reported"
                  : `${installed.length} reported`
          }
        />
      </dl>

      {installed.length > 0 ? <InstalledApplications rows={installed} /> : null}

      {device.status === "revoked" ? (
        <p className="border-t px-5 py-2.5 text-xs text-muted-foreground">
          This device was revoked and stops collecting on its next request. Its history is kept as a
          record.
        </p>
      ) : null}

      {revoking ? (
        <RevokeDeviceDialog device={device} onClose={() => setRevoking(false)} />
      ) : null}
    </Panel>
  );
}

/**
 * The inventory itself, behind a disclosure.
 *
 * A count answers "is anything reported?"; only the list answers "what is on this
 * machine?", which is the question scope §7 actually asks. It is collapsed because a
 * developer laptop reports a few hundred rows and this is not the primary content of
 * the tab — `<details>` is the browser's own expand/collapse, with correct keyboard
 * behaviour and no state to get wrong.
 */
function InstalledApplications({ rows }: { rows: ReturnType<typeof sortApplications> }) {
  return (
    <details className="border-t">
      <summary className="cursor-pointer list-none px-5 py-2.5 text-xs font-medium transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        Installed applications ({rows.length})
      </summary>
      <div className="max-h-72 overflow-y-auto border-t">
        <table className="w-full text-sm">
          <caption className="sr-only">Applications reported by this device</caption>
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-5 py-2 font-medium">
                Application
              </th>
              <th scope="col" className="hidden px-5 py-2 font-medium sm:table-cell">
                Version
              </th>
              <th scope="col" className="px-5 py-2 text-right font-medium">
                Last seen
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b last:border-0">
                <td className="px-5 py-2">{row.name}</td>
                <td className="hidden px-5 py-2 text-muted-foreground sm:table-cell">
                  {row.version?.trim() || "—"}
                </td>
                <td className="tabular px-5 py-2 text-right text-muted-foreground">
                  {relativeTime(row.last_seen_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * The confirm step for a revoke.
 *
 * Says what happens on the machine, not what happens in the database. "Sets status to
 * revoked" is true and useless to the person deciding; "collection stops on its next
 * request and the agent has to be enrolled again" is the same fact in terms they can
 * weigh.
 */
function RevokeDeviceDialog({ device, onClose }: { device: DeviceRow; onClose: () => void }) {
  const revoke = useRevokeDevice();
  const [serverError, setServerError] = useState<string | null>(null);

  async function run() {
    setServerError(null);
    try {
      await revoke.mutateAsync(device.id);
      onClose();
    } catch (error) {
      setServerError(describeError(error));
    }
  }

  return (
    <Dialog title={`Revoke ${device.device_name || device.label}?`} onClose={onClose}>
      <div className="space-y-3 px-5 py-4 text-sm">
        {serverError ? <FormError message={serverError} /> : null}
        <p>
          The agent on this machine is refused on its very next request, so collection stops
          within seconds rather than at the end of the day.
        </p>
        <p>
          Everything already recorded from it is kept — sessions, activity, captures and the
          inventory above all stay where they are.
        </p>
        <p className="text-muted-foreground">
          To use this machine again, sign in on it and enrol it a second time. Nothing is
          collected until the monitoring policy is accepted on the new enrolment.
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
        <button type="button" onClick={onClose} className={secondaryButtonClass}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void run()}
          disabled={revoke.isPending}
          className={destructiveButtonClass}
        >
          {revoke.isPending ? "Revoking…" : "Revoke device"}
        </button>
      </div>
    </Dialog>
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
