"use client";

import {
  Badge,
  Button,
  Label,
  SearchInput,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aems/ui";
import { Loader2, UserPlus } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";

import { ErrorState, TableSkeletonRows, type SkeletonColumn } from "@/components/states";
import { describeError, useApiQuery, useSession, type EmployeeRow } from "@/lib/api";
import {
  EMPTY_PEOPLE_FILTERS,
  matchesPeopleFilter,
  monitoringSummary,
} from "@/lib/queries/roster-view";
import { useSetMonitoring } from "@/lib/queries/settings";
import { employeesQuery } from "@/lib/queries/settings-specs";
import { monitoringChangeConfirmation, monitoringConsequence } from "@/lib/queries/settings-view";

import { ConfirmPanel, Confirmation, Section } from "./section";

/**
 * Per-employee monitoring, `docs/scope.md` §4.2's "enable/disable monitoring".
 *
 * Three properties make this a compliance control rather than a switch:
 *
 *  1. **Only a super admin sees an action.** `PATCH /api/employees/:id` is
 *     `requireSuperAdmin`, so offering the button to a manager would be offering
 *     something the API refuses — and the UI must not offer what the database will
 *     refuse.
 *  2. **The consequence is stated before the change, not after.** Turning collection
 *     off is a promise to a person about their laptop; it is spelled out in words,
 *     including what is *kept*, before anything is sent.
 *  3. **Nothing moves optimistically.** The row shows what the server confirmed.
 */
const ROSTER_SKELETON_COLUMNS: readonly SkeletonColumn[] = [
  { key: "employee", label: "Employee", lines: 2, width: "w-36" },
  { key: "department", label: "Department", width: "w-24" },
  { key: "devices", label: "Devices", width: "w-6" },
  { key: "monitoring", label: "Monitoring", width: "w-14" },
  { key: "change", label: "", align: "right", width: "w-28" },
];

export function MonitoringSection() {
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch } = useApiQuery(employeesQuery);
  const { data: session } = useSession();
  const mutation = useSetMonitoring();

  const canEdit = session?.role === "super_admin";
  const rows = data ?? [];
  const filtered = rows.filter((person) =>
    matchesPeopleFilter(person, { ...EMPTY_PEOPLE_FILTERS, search }),
  );
  const summary = monitoringSummary(rows);

  return (
    <Section
      id="monitoring"
      title="Employee monitoring"
      description="Collection is per person. Pausing stops the agent on that employee's devices; it does not delete anything already recorded."
      affects="one person at a time — every device that person has enrolled stops or resumes collecting at its next check-in."
      actions={
        <>
          <Label htmlFor={searchId} className="sr-only">
            Search employees
          </Label>
          <SearchInput
            id={searchId}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search this list"
            containerClassName="sm:w-56"
          />
        </>
      }
    >
      {isError ? (
        <ErrorState
          title="Could not load the roster"
          message={`${describeError(error)} Nobody's monitoring has changed — this panel could not read the roster, not alter it.`}
          onRetry={() => void refetch()}
        />
      ) : (
        <>
          {confirmed ? <Confirmation>{confirmed}</Confirmation> : null}

          {!isLoading && rows.length > 0 ? (
            <p className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span>
                <span className="tabular font-medium text-foreground">{summary.enabled}</span> of{" "}
                <span className="tabular">{summary.total}</span> monitored
                {summary.paused > 0 ? (
                  <>
                    {" · "}
                    <span className="tabular font-medium text-foreground">{summary.paused}</span>{" "}
                    paused
                  </>
                ) : null}
              </span>

              {/* A filtered table that does not say it is filtered is how someone
                  concludes a colleague has been removed from the company. */}
              {search.trim() ? (
                <span>
                  · showing <span className="tabular">{filtered.length}</span> matching “
                  <span className="break-all">{search.trim()}</span>”{" "}
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="rounded font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Clear
                  </button>
                </span>
              ) : null}
            </p>
          ) : null}

          <Table
            containerClassName="rounded-lg border bg-card"
            className="min-w-[40rem]"
            aria-busy={isLoading || undefined}
          >
            <caption className="sr-only">
              Employees, their monitoring state, and the control to change it
            </caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Employee</TableHead>
                <TableHead scope="col">Department</TableHead>
                <TableHead scope="col">Devices</TableHead>
                <TableHead scope="col">Monitoring</TableHead>
                <TableHead scope="col" className="text-right">
                  {canEdit ? "Change" : ""}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableSkeletonRows columns={ROSTER_SKELETON_COLUMNS} rows={4} />
              ) : filtered.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="px-4 py-10 text-center">
                    <p className="text-sm font-medium">
                      {rows.length === 0 ? "No employees yet" : "No one matches that search"}
                    </p>
                    {rows.length === 0 ? (
                      <>
                        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                          Nobody is being monitored, because nobody has been added. Add a person
                          on the People page and they appear here straight away.
                        </p>
                        {/* A link, not a Button: this navigates. `Button` has no
                            `asChild`, and a button that routes is the wrong element. */}
                        <Link
                          href="/people"
                          className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                        >
                          <UserPlus className="h-3.5 w-3.5" aria-hidden />
                          Add someone on People
                        </Link>
                      </>
                    ) : (
                      <>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {rows.length} {rows.length === 1 ? "person is" : "people are"} on the
                          roster. Try a different name, email or department.
                        </p>
                        <button
                          type="button"
                          onClick={() => setSearch("")}
                          className="mt-3 inline-flex h-9 items-center rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                        >
                          Clear the search
                        </button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((person) => (
                  <MonitoringRow
                    key={person.id}
                    person={person}
                    canEdit={canEdit}
                    confirming={confirming === person.id}
                    busy={mutation.isPending && mutation.variables?.profileId === person.id}
                    failure={
                      mutation.isError && mutation.variables?.profileId === person.id
                        ? describeError(mutation.error)
                        : null
                    }
                    onAsk={() => {
                      mutation.reset();
                      setConfirmed(null);
                      setConfirming(person.id);
                    }}
                    onCancel={() => setConfirming(null)}
                    onConfirm={() => {
                      const enabled = !person.monitoring_enabled;
                      mutation.mutate(
                        { profileId: person.id, enabled },
                        {
                          onSuccess: () => {
                            setConfirming(null);
                            setConfirmed(
                              monitoringChangeConfirmation(
                                person.full_name || person.email,
                                enabled,
                              ),
                            );
                          },
                        },
                      );
                    }}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </>
      )}
    </Section>
  );
}

function MonitoringRow({
  person,
  canEdit,
  confirming,
  busy,
  failure,
  onAsk,
  onCancel,
  onConfirm,
}: {
  person: EmployeeRow;
  canEdit: boolean;
  confirming: boolean;
  busy: boolean;
  failure: string | null;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = monitoringConsequence(person.monitoring_enabled);

  return (
    <>
      <TableRow>
        <TableCell>
          {/* The row is about a person who has a page, and "who is this and are they
              actually reporting" is the next question after pausing someone. The name
              is the link rather than a trailing icon, per the table rule elsewhere. */}
          <Link
            href={`/people/${person.id}`}
            className="rounded font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {person.full_name || person.email}
          </Link>
          {/* An address is the longest string in this table and the one that will not
              wrap sensibly; the full value stays reachable on hover and to a reader. */}
          <p className="truncate text-xs text-muted-foreground" title={person.email}>
            {person.email}
          </p>
        </TableCell>
        <TableCell className="text-muted-foreground">{person.department ?? "—"}</TableCell>
        <TableCell className="tabular text-muted-foreground">{person.devices.length}</TableCell>
        <TableCell>
          <Badge variant={person.monitoring_enabled ? "online" : "offline"} dot>
            {person.monitoring_enabled ? "On" : "Paused"}
          </Badge>
        </TableCell>
        <TableCell className="text-right">
          {canEdit && !confirming ? (
            <Button variant="outline" size="sm" className="h-9" onClick={onAsk}>
              {copy.action}
            </Button>
          ) : null}
        </TableCell>
      </TableRow>

      {confirming ? (
        <TableRow className="bg-secondary/30 hover:bg-secondary/30">
          <TableCell colSpan={5} className="px-4 py-3">
            <ConfirmPanel
              title={`${copy.action} for ${person.full_name || person.email}?`}
              detail={copy.detail}
              error={failure}
            >
              <Button
                variant="ghost"
                size="sm"
                className="h-9"
                onClick={onCancel}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button size="sm" className="h-9" onClick={onConfirm} disabled={busy}>
                {busy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    Saving
                  </>
                ) : (
                  copy.action
                )}
              </Button>
            </ConfirmPanel>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
