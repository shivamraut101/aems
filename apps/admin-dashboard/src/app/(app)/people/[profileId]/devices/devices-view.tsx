"use client";

import {
  Badge,
  Button,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aems/ui";
import { Laptop, ShieldOff, Smartphone } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import {
  Dialog,
  FormError,
  destructiveButtonClass,
  secondaryButtonClass,
} from "@/components/dialog";
import { RelativeTime } from "@/components/relative-time";
import { devicesQuery } from "@/components/employee/employee-queries";
import {
  EmptyState,
  ErrorState,
  Panel,
  SectionHeading,
  SkeletonLines,
} from "@/components/employee/states";
import { queryViewState } from "@/components/states";
import { describeError, useApiQuery, useSession, type DeviceRow } from "@/lib/api";
import {
  DATA_TYPE_LABEL,
  oneType,
  typesFor,
  useDeviceCollection,
  useUpdateDeviceCollection,
} from "@/lib/queries/collection";
import { devicesForProfile, gigabytes, osLabel, platformLabel } from "@/lib/queries/usage";

import {
  sortApplications,
  useDeviceApplications,
  useDeviceTelemetry,
  useRevokeDevice,
  useSetPrimaryDevice,
  type DeviceTelemetryRow,
} from "./device-queries";
import { dayHref } from "@/components/employee/tabs";

/**
 * Presence, once.
 *
 * The variant and the label used to be two parallel three-branch ternaries in the
 * panel header, which is two places for the same three states to disagree. Every one
 * of them is a *state* the machine is in rather than a category it belongs to, so all
 * three carry the leading dot.
 */
const DEVICE_STATUS: Record<
  DeviceRow["status"],
  { variant: "online" | "offline" | "revoked"; label: string }
> = {
  active: { variant: "online", label: "Online" },
  offline: { variant: "offline", label: "Offline" },
  revoked: { variant: "revoked", label: "Revoked" },
};

/**
 * Devices tab — scope §7.
 *
 * A specification panel per machine rather than a row in a table: this reads as an IT
 * inventory page (docs/design.md, Device Inventory), and a person has one or two
 * devices, where an eight-column table would be mostly empty. The company-wide table
 * on /devices is the operational view; this is the asset view for one person.
 *
 * The fleet is read through `devicesQuery`, which the route's `page.tsx` prefetches,
 * so the panels are in the first paint. The per-device application inventory is not
 * prefetched — it is one request per machine and the count is a secondary fact on a
 * secondary tab, so it is allowed to arrive a moment later and says "Reading…" while
 * it does.
 */
export function DevicesTabView({ profileId }: { profileId: string }) {
  const query = useApiQuery(devicesQuery);
  const devices = useMemo(
    () => devicesForProfile(query.data ?? [], profileId),
    [query.data, profileId],
  );

  const state = queryViewState(query, () => devices.length === 0);

  return (
    <div>
      <SectionHeading
        title="Devices"
        hint="Company hardware assigned to this person, and when each machine last reported in."
      />

      {state === "error" ? (
        <ErrorState
          title="Devices could not be loaded"
          message={describeError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : state === "loading" ? (
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
            body="Nothing is being collected for this person. Install the desktop agent and sign in on the machine to enrol it, or install the Android app on a company phone — a device appears here as soon as it has been enrolled and the monitoring policy accepted."
          />
        </Panel>
      ) : (
        <div className="space-y-3">
          <Lead devices={devices} />
          {devices.map((device) => (
            <DevicePanel key={device.id} device={device} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Whether this person's hardware is still checking in, before the specifications.
 *
 * The count alone ("2 devices") sat beside the heading and answered a question nobody
 * has. The one worth answering here is whether anything has gone quiet, and a revoked
 * machine is counted separately from an offline one because it is *meant* to be
 * silent — folding the two together would raise an alarm about a decision somebody
 * deliberately took.
 */
function Lead({ devices }: { devices: DeviceRow[] }) {
  const reporting = devices.filter((device) => device.status === "active").length;
  const revoked = devices.filter((device) => device.status === "revoked").length;
  const offline = devices.length - reporting - revoked;

  const allWell = offline === 0 && revoked === 0;

  const parts = [
    // "0 reporting, 1 offline" says the same thing twice for a person with one
    // machine, so the count only appears when there is something to contrast it with.
    ...(allWell
      ? [devices.length === 1 ? "reporting now" : "all reporting now"]
      : reporting > 0
        ? [`${reporting} reporting`]
        : []),
    ...(offline > 0 ? [`${offline} offline`] : []),
    ...(revoked > 0 ? [`${revoked} revoked`] : []),
  ];

  return (
    <p className="text-sm">
      <span className="tabular font-medium">{devices.length}</span>{" "}
      {devices.length === 1 ? "device" : "devices"} assigned — {parts.join(", ")}.
    </p>
  );
}

function DevicePanel({ device }: { device: DeviceRow }) {
  const isPhone = device.platform === "android";
  const Icon = isPhone ? Smartphone : Laptop;
  const status = DEVICE_STATUS[device.status];

  const { data: session } = useSession();
  const [revoking, setRevoking] = useState(false);

  // Only phones send these. Fetching for a laptop would be a request that can only
  // ever answer `null`.
  const telemetry = useDeviceTelemetry(device.id, isPhone);
  const latest = telemetry.data?.latest ?? null;

  const search = useSearchParams();
  const primary = useSetPrimaryDevice();
  // `requireManager` on the API. This only avoids offering an employee reading their
  // own devices a button that ends in a 403.
  const canSetPrimary =
    (session?.role === "super_admin" || session?.role === "manager") &&
    device.status !== "revoked";

  // Revoking is `requireSuperAdmin` on the API. This only stops a manager being
  // offered a button that ends in a 403.
  const canRevoke = session?.role === "super_admin" && device.status !== "revoked";

  // `PATCH .../collection` is `requireManager`. An employee still *reads* the list —
  // non-negotiable #3 — they are just not offered switches that would end in a 403.
  const canEdit =
    (session?.role === "super_admin" || session?.role === "manager") &&
    device.status !== "revoked";

  const applications = useDeviceApplications(device.id);
  const installed = useMemo(
    () => sortApplications(applications.data ?? []),
    [applications.data],
  );

  return (
    <Panel className="p-0">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold" title={device.device_name || device.label}>
              {device.device_name || device.label}
            </h3>
            <p className="truncate text-xs text-muted-foreground">
              {platformLabel(device.platform)} · {device.model?.trim() || "Model not reported"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {/* The day view for this one machine. Everything above this row answers
              "what is this device"; this answers "what did it do", which is the
              question the seven person-level tabs could not be asked. */}
          <Link
            href={dayHref(
              `/people/${device.profile_id}/devices/${device.id}`,
              search.toString(),
              search.get("date"),
            )}
            className="text-xs font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            View activity
          </Link>

          {device.is_primary ? (
            <Badge variant="secondary">Primary</Badge>
          ) : canSetPrimary ? (
            <button
              type="button"
              onClick={() => primary.mutate(device.id)}
              disabled={primary.isPending}
              className="rounded text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              // Said in full here rather than as a bare "Make primary", because the
              // consequence is not obvious from the words: it moves which machine
              // this person's reported hours are computed from.
              title="Compute this person's working hours from this device"
            >
              {primary.isPending ? "Setting…" : "Make primary"}
            </button>
          ) : null}

          <span className="tabular text-xs text-muted-foreground">
            Last heartbeat <RelativeTime iso={device.last_seen_at} />
          </span>
          <Badge variant={status.variant} dot>
            {status.label}
          </Badge>
          {canRevoke ? (
            <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setRevoking(true)}>
              <ShieldOff className="h-3.5 w-3.5" aria-hidden />
              Revoke
            </Button>
          ) : null}
        </div>
      </header>

      {/* A definition list rather than a table: these are facts about one machine, not
          rows to compare against each other. */}
      {/* Phones report live state a laptop has no equivalent for — battery, network,
          screen-on time — and cannot report a CPU model at all. Rendering one grid for
          both made "Android does not expose this" indistinguishable from "collection
          failed": a permanent `CPU —` reads as a gap rather than as a category error.
          So the phone gets the fields it actually has, and is not asked the rest. */}
      {isPhone ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5 px-4 py-4 text-sm sm:grid-cols-4 sm:px-5">
          <Spec label="Battery" value={batteryLabel(latest, telemetry.isPending)} />
          <Spec label="Network" value={networkLabel(latest, telemetry.isPending)} />
          <Spec label="Screen on today" value={screenOnLabel(latest, telemetry.isPending)} />
          <Spec label="Storage free" value={freeStorageLabel(latest, device, telemetry.isPending)} />
        </dl>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5 px-4 py-4 text-sm sm:grid-cols-3 sm:px-5 lg:grid-cols-4">
        <Spec label="Operating system" value={osLabel(device.platform, device.os_version)} />
        {/* Android exposes no CPU model, so the phone is not asked. A dash here is
            permanent and says nothing a reader can act on. */}
        {isPhone ? null : <Spec label="CPU" value={device.cpu?.trim() || null} />}
        <Spec label="Memory" value={gigabytes(device.ram_mb)} />
        <Spec label="Storage" value={gigabytes(device.storage_mb)} />
        <Spec label="Agent" value={device.agent_version?.trim() || null} />
        <Spec label="Enrolled" value={calendarDate(device.enrolled_at)} />
        <Spec label="Device label" value={device.label} />
        <Spec label="Device ID" value={device.id} mono />
        {/* Scope §7 lists installed applications as part of desktop inventory. The
            agent has been reporting them since enrolment; nothing read them back.
            On Android this is not the same list: since API 30 the full inventory needs
            QUERY_ALL_PACKAGES, which this app does not request, so only apps that were
            actually used appear. Labelled differently so the two are not compared. */}
        <Spec
          label={isPhone ? "Apps seen" : "Applications"}
          value={
            applications.isPending
              ? "Reading…"
              : applications.isError
                ? "Unavailable"
                : installed.length === 0
                  ? isPhone
                    ? "Usage access not granted"
                    : "None reported"
                  : `${installed.length} reported`
          }
        />
      </dl>

      {/* Said once, plainly, rather than left to be inferred from four empty tabs.
          docs/design.md positions this as workforce intelligence rather than
          surveillance, and the honest form of that is stating what is NOT collected —
          this is also the disclosure the employee sees on their own phone. */}
      {isPhone ? (
        <p className="border-t px-4 py-3 text-xs text-muted-foreground sm:px-5">
          Phones do not record screenshots, window titles or websites. What is collected
          is app usage, screen-on time and the device readings above.
        </p>
      ) : null}

      {installed.length > 0 ? <InstalledApplications rows={installed} /> : null}

      <CollectionScope device={device} canEdit={canEdit} />

      {device.status === "revoked" ? (
        <p className="border-t px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
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
 * What this one machine may collect, and who last decided each answer.
 *
 * Always rendered, never conditional on something being switched off: the reader's
 * question is "what is this laptop recording", and a panel that only appears once
 * somebody has narrowed the scope answers it for the exceptional case and stays silent
 * for the normal one. That is also what makes it the read surface for an employee
 * looking at their own devices, which non-negotiable #3 requires.
 *
 * Only the types the platform can physically report are listed. Offering an admin a
 * Location switch on a laptop would be a control that changes nothing — desktop
 * "location" is a Wi-Fi lookup accurate to tens of metres and the agents do not collect
 * it — and a switch that does nothing is worse than an absent one.
 *
 * A switch is used rather than a checkbox because this takes effect on save, not on a
 * later submit; it is navy rather than indigo because indigo marks model output, and
 * nothing here is inferred.
 */
function CollectionScope({ device, canEdit }: { device: DeviceRow; canEdit: boolean }) {
  const collection = useDeviceCollection(device.id);
  const update = useUpdateDeviceCollection(device.id);

  const settings = useMemo(() => {
    const byType = new Map(collection.data?.map((row) => [row.dataType, row]) ?? []);
    return typesFor(device.platform).map((id) => ({ id, row: byType.get(id) ?? null }));
  }, [collection.data, device.platform]);

  const offCount = settings.filter((entry) => entry.row?.enabled === false).length;

  return (
    <details className="border-t">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-2.5 text-xs font-medium transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-5 [&::-webkit-details-marker]:hidden">
        What this device collects
        {/* The count is the reason to open it. "6 of 6" is as worth saying as "4 of 6":
            a reader who cannot see the total cannot tell a full scope from an unread one. */}
        <Badge variant={offCount > 0 ? "offline" : "secondary"}>
          {collection.isPending
            ? "Reading…"
            : collection.isError
              ? "Could not be read"
              : `${settings.length - offCount} of ${settings.length} on`}
        </Badge>
      </summary>

      <div className="space-y-3 border-t px-4 py-3 sm:px-5">
        {collection.isError ? (
          /* Never "everything is on" on a failed read. An unanswered question and a
             known answer must not look the same on the one screen that says what is
             being recorded about a person. */
          <p role="alert" className="text-xs text-muted-foreground">
            This device&apos;s collection settings could not be read, so what is listed
            below cannot be confirmed either way.{" "}
            <button
              type="button"
              onClick={() => void collection.refetch()}
              className="rounded font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Try again
            </button>
          </p>
        ) : (
          <>
            <ul className="divide-y">
              {settings.map(({ id, row }) => {
                const enabled = row?.enabled ?? true;
                return (
                  <li key={id} className="flex items-start justify-between gap-4 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm">{DATA_TYPE_LABEL[id]}</p>
                      {/* Who and when, on the row it belongs to. Attribution is stored
                          per (device, type) precisely so two administrators' two
                          decisions on two days do not both read as the later one. */}
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {row
                          ? `${enabled ? "Switched on" : "Switched off"} by ${
                              row.changedByName?.trim() || "an administrator who is no longer listed"
                            } on ${calendarDate(row.changedAt) ?? "an unrecorded date"}`
                          : "Collected since this device was enrolled"}
                      </p>
                    </div>

                    {canEdit ? (
                      <Switch
                        checked={enabled}
                        disabled={update.isPending}
                        aria-label={DATA_TYPE_LABEL[id]}
                        onCheckedChange={(next) => update.mutate(oneType(id, next))}
                      />
                    ) : (
                      <Badge variant={enabled ? "success" : "offline"} dot>
                        {enabled ? "On" : "Off"}
                      </Badge>
                    )}
                  </li>
                );
              })}
            </ul>

            {update.isError ? <FormError message={describeError(update.error)} /> : null}

            <p className="text-xs text-muted-foreground">
              {canEdit
                ? "The agent picks this up on its next heartbeat, within a minute. Switching something off stops it immediately and keeps what was already recorded. Switching one back on collects nothing until the employee has agreed to it on the device — they were never asked about a type that was off."
                : "This is the list you agreed to on this device. Only an administrator can change it, and anything switched back on has to be agreed to again before it is collected."}
            </p>
          </>
        )}
      </div>
    </details>
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
 *
 * `max-h-72` on the table's own scroller is what makes its sticky header earn its
 * keep: three hundred rows scroll past inside the box, and the column names stay.
 */
function InstalledApplications({ rows }: { rows: ReturnType<typeof sortApplications> }) {
  return (
    <details className="border-t">
      <summary className="cursor-pointer list-none px-4 py-2.5 text-xs font-medium transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-5 [&::-webkit-details-marker]:hidden">
        Installed applications ({rows.length})
      </summary>
      {/* Both axes scroll inside this box: the list is long, and on a phone the three
          columns are wider than the panel. Neither may reach the page body. */}
      <Table
        containerClassName="max-h-72 overflow-y-auto border-t"
        className="min-w-[22rem]"
      >
        <caption className="sr-only">Applications reported by this device</caption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className="sm:px-5">
              Application
            </TableHead>
            <TableHead scope="col" className="hidden sm:table-cell sm:px-5">
              Version
            </TableHead>
            <TableHead scope="col" className="text-right sm:px-5">
              Last seen
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="sm:px-5">{row.name}</TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell sm:px-5">
                {row.version?.trim() || "—"}
              </TableCell>
              <TableCell className="tabular whitespace-nowrap text-right text-muted-foreground sm:px-5">
                <RelativeTime iso={row.last_seen_at} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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

      <div className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3">
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
/**
 * The four phone readings, each said only when it is actually known.
 *
 * `null` renders as an em dash, which is right here and wrong on the desktop grid:
 * these are live values that legitimately have not arrived yet, not fields the
 * platform cannot answer. "Reading…" while the request is in flight keeps the two
 * apart, because a phone that has not checked in and a phone with a flat battery must
 * not look the same.
 */
function batteryLabel(row: DeviceTelemetryRow | null, pending: boolean): string | null {
  if (pending) return "Reading…";
  if (!row || row.battery_level === null) return null;
  return `${String(row.battery_level)}%${row.battery_charging === true ? " · charging" : ""}`;
}

const NETWORK_LABEL: Record<string, string> = {
  wifi: "Wi-Fi",
  cellular: "Mobile data",
  ethernet: "Ethernet",
  offline: "No connection",
};

function networkLabel(row: DeviceTelemetryRow | null, pending: boolean): string | null {
  if (pending) return "Reading…";
  if (!row?.network_type) return null;
  return NETWORK_LABEL[row.network_type] ?? row.network_type;
}

/**
 * Today's total, from the newest sample — never a sum.
 *
 * `screen_active_seconds` accumulates from local midnight and is reset by the agent at
 * the day boundary, so the latest row already IS the day's figure. Migration …0015
 * carries the same warning on the column itself.
 */
function screenOnLabel(row: DeviceTelemetryRow | null, pending: boolean): string | null {
  if (pending) return "Reading…";
  const seconds = row?.screen_active_seconds;
  if (seconds === null || seconds === undefined) return null;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${String(hours)}h ${String(minutes)}m` : `${String(minutes)}m`;
}

/** Free space against the total, because 4 GB free means nothing without the capacity. */
function freeStorageLabel(
  row: DeviceTelemetryRow | null,
  device: DeviceRow,
  pending: boolean,
): string | null {
  if (pending) return "Reading…";
  const free = row?.storage_free_mb;
  if (free === null || free === undefined) return null;

  const freeGb = Math.round(free / 1024);
  const total = device.storage_mb;
  return total ? `${String(freeGb)} of ${String(Math.round(total / 1024))} GB` : `${String(freeGb)} GB`;
}

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
