"use client";

import { Badge, Button } from "@aems/ui";
import { AlertTriangle, Loader2, Search } from "lucide-react";
import { useId, useState } from "react";

import { describeError, useEmployees, useSession, type EmployeeRow } from "@/lib/api";
import {
  EMPTY_PEOPLE_FILTERS,
  matchesPeopleFilter,
  monitoringSummary,
} from "@/lib/queries/roster-view";
import { useSetMonitoring } from "@/lib/queries/settings";
import { monitoringConsequence } from "@/lib/queries/settings-view";

import { Notice, Section } from "./section";

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
export function MonitoringSection() {
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  const { data: session } = useSession();
  const { data, isLoading, isError, error } = useEmployees();
  const mutation = useSetMonitoring();

  const canEdit = session?.role === "super_admin";
  const rows = data ?? [];
  const filtered = rows.filter((person) =>
    matchesPeopleFilter(person, { ...EMPTY_PEOPLE_FILTERS, search }),
  );
  const summary = monitoringSummary(rows);

  return (
    <Section
      title="Employee monitoring"
      description="Collection is per person. Pausing stops the agent on that employee's devices; it does not delete anything already recorded."
      actions={
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            id={searchId}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search this list"
            aria-label="Search employees"
            className="h-9 w-56 rounded-md border border-input bg-card pl-8 pr-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          />
        </div>
      }
    >
      {isError ? (
        <Notice tone="error" title="Could not load the roster">
          <p>{describeError(error)}</p>
        </Notice>
      ) : (
        <>
          {!isLoading && rows.length > 0 ? (
            <p className="mb-2 text-sm text-muted-foreground">
              <span className="tabular font-medium text-foreground">{summary.enabled}</span> of{" "}
              <span className="tabular">{summary.total}</span> monitored
              {summary.paused > 0 ? (
                <>
                  {" · "}
                  <span className="tabular font-medium text-foreground">{summary.paused}</span>{" "}
                  paused
                </>
              ) : null}
            </p>
          ) : null}

          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[40rem] text-sm">
              <caption className="sr-only">
                Employees, their monitoring state, and the control to change it
              </caption>
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-4 py-2 font-medium">
                    Employee
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Department
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Devices
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Monitoring
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    {canEdit ? "Change" : ""}
                  </th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array.from({ length: 4 }, (_, index) => (
                    <tr key={index} className="border-b last:border-0">
                      <td colSpan={5} className="px-4 py-2.5">
                        <span className="block h-4 w-full animate-pulse rounded bg-muted" />
                      </td>
                    </tr>
                  ))
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center">
                      <p className="text-sm font-medium">
                        {rows.length === 0 ? "No employees yet" : "No one matches that search"}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {rows.length === 0
                          ? "Invite an employee through Supabase Auth and assign them to this company; they appear here immediately."
                          : "Try a different name, email or department."}
                      </p>
                    </td>
                  </tr>
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
                        setConfirming(person.id);
                      }}
                      onCancel={() => setConfirming(null)}
                      onConfirm={() => {
                        mutation.mutate(
                          { profileId: person.id, enabled: !person.monitoring_enabled },
                          { onSuccess: () => setConfirming(null) },
                        );
                      }}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
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
      <tr className="border-b transition-colors last:border-0 hover:bg-secondary/40">
        <td className="px-4 py-2.5">
          <span className="font-medium">{person.full_name || person.email}</span>
          <p className="text-xs text-muted-foreground">{person.email}</p>
        </td>
        <td className="px-4 py-2.5 text-muted-foreground">{person.department ?? "—"}</td>
        <td className="tabular px-4 py-2.5 text-muted-foreground">{person.devices.length}</td>
        <td className="px-4 py-2.5">
          <Badge variant={person.monitoring_enabled ? "online" : "offline"}>
            {person.monitoring_enabled ? "On" : "Paused"}
          </Badge>
        </td>
        <td className="px-4 py-2.5 text-right">
          {canEdit && !confirming ? (
            <Button variant="outline" size="sm" onClick={onAsk}>
              {copy.action}
            </Button>
          ) : null}
        </td>
      </tr>

      {confirming ? (
        <tr className="border-b bg-secondary/30 last:border-0">
          <td colSpan={5} className="px-4 py-3">
            <div className="flex flex-wrap items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {copy.action} for {person.full_name || person.email}?
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">{copy.detail}</p>
                {failure ? (
                  <p role="alert" className="mt-1.5 text-sm text-destructive">
                    {failure}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
                  Cancel
                </Button>
                <Button size="sm" onClick={onConfirm} disabled={busy}>
                  {busy ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      Saving
                    </>
                  ) : (
                    copy.action
                  )}
                </Button>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
