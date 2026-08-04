"use client";

import { Badge } from "@aems/ui";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { useEmployees } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useFilters } from "@/store/filters";

const ROLE_LABEL = {
  super_admin: "Super admin",
  manager: "Manager",
  employee: "Employee",
} as const;

export default function PeoplePage() {
  const { data, isLoading, isError } = useEmployees();
  const search = useFilters((state) => state.search);
  const setSearch = useFilters((state) => state.setSearch);

  const rows = (data ?? []).filter((person) => {
    if (!search) return true;
    const needle = search.toLowerCase();
    return (
      person.full_name.toLowerCase().includes(needle) ||
      person.email.toLowerCase().includes(needle) ||
      (person.department ?? "").toLowerCase().includes(needle)
    );
  });

  return (
    <div className="mx-auto max-w-6xl px-6 py-7">
      <PageHeader
        title="People"
        subtitle="Everyone in your company, with the devices assigned to them."
        actions={
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, email or department"
            aria-label="Search people"
            className="h-9 w-64 rounded-md border bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      />

      {isError ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          Could not load people. Check that the API is running and you are signed in as a manager.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">
                  Department
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Role
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Devices
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Monitoring
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Last seen
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }, (_, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td colSpan={6} className="px-4 py-2.5">
                      <span className="block h-4 w-full animate-pulse rounded bg-muted" />
                    </td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center">
                    <p className="text-sm font-medium">
                      {search ? "No one matches that search" : "No employees yet"}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {search
                        ? "Try a different name or department."
                        : "Invite an employee through Supabase Auth, then assign them to this company."}
                    </p>
                  </td>
                </tr>
              ) : (
                rows.map((person) => {
                  const lastSeen = person.devices
                    .map((device) => device.last_seen_at)
                    .filter((value): value is string => Boolean(value))
                    .sort()
                    .at(-1);

                  return (
                    <tr
                      key={person.id}
                      className="border-b transition-colors last:border-0 hover:bg-secondary/40"
                    >
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/people/${person.id}`}
                          className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {person.full_name || person.email}
                        </Link>
                        <p className="text-xs text-muted-foreground">{person.email}</p>
                      </td>
                      <td className="hidden px-4 py-2.5 text-muted-foreground sm:table-cell">
                        {person.department ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {ROLE_LABEL[person.role]}
                      </td>
                      <td className="tabular px-4 py-2.5 text-muted-foreground">
                        {person.devices.length}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant={person.monitoring_enabled ? "online" : "offline"}>
                          {person.monitoring_enabled ? "On" : "Paused"}
                        </Badge>
                      </td>
                      <td className="tabular px-4 py-2.5 text-right text-muted-foreground">
                        {relativeTime(lastSeen ?? null)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
