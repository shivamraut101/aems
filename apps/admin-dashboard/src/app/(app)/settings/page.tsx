"use client";

import { PageHeader } from "@/components/page-header";
import { describeError, useDevices, useEmployees, useSession } from "@/lib/api";
import { roleLabel } from "@/lib/session";

import { MonitoringSection } from "./monitoring-section";
import { PolicySection } from "./policy-section";
import { DefinitionList, DefinitionRow, Notice, Section, ValueSkeleton } from "./section";

/**
 * Company configuration, `docs/scope.md` §4.2.
 *
 * Three sections, in the order an admin needs them: what this tenant is, what the
 * agents are told to collect, and who is being monitored. The last of those is the
 * only control on the page that writes, and it is the one scope §4.2 named and the
 * product did not have.
 *
 * Route access is `NAV` in lib/session.ts — /settings is super-admin only, and
 * AppShell renders the refusal panel for anyone else, so there is no guard here.
 */
export default function SettingsPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-7">
      <PageHeader
        title="Settings"
        subtitle="Company, monitoring policy and who is being monitored."
      />
      <CompanySection />
      <PolicySection />
      <MonitoringSection />
    </div>
  );
}

function CompanySection() {
  const { data: session, isLoading, isError, error } = useSession();
  const employees = useEmployees();
  const devices = useDevices();

  if (isError) {
    return (
      <Section title="Company">
        <Notice tone="error" title="Could not load your account">
          <p>{describeError(error)}</p>
        </Notice>
      </Section>
    );
  }

  return (
    <Section title="Company" description="The tenant every record on this screen belongs to.">
      <DefinitionList>
        <DefinitionRow term="Company">
          {isLoading ? (
            <ValueSkeleton />
          ) : (
            // Never a UUID: an identifier is not an answer to "which company is this".
            <span className="font-medium">
              {session?.companyName ?? session?.department ?? "Your company"}
            </span>
          )}
        </DefinitionRow>

        <DefinitionRow term="Signed in as">
          {isLoading ? (
            <ValueSkeleton className="w-40" />
          ) : session ? (
            <>
              <span className="font-medium">{session.fullName}</span>
              <span className="text-muted-foreground"> · {roleLabel(session.role)}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Not signed in</span>
          )}
        </DefinitionRow>

        <DefinitionRow term="Employees">
          {employees.isLoading ? (
            <ValueSkeleton className="w-10" />
          ) : employees.isError ? (
            <span className="text-muted-foreground">{describeError(employees.error)}</span>
          ) : (
            <span className="tabular font-medium">{employees.data?.length ?? 0}</span>
          )}
        </DefinitionRow>

        <DefinitionRow
          term="Devices enrolled"
          hint="Revoking a device stops it collecting on its very next request."
        >
          {devices.isLoading ? (
            <ValueSkeleton className="w-10" />
          ) : devices.isError ? (
            <span className="text-muted-foreground">{describeError(devices.error)}</span>
          ) : (
            <span className="tabular font-medium">{devices.data?.length ?? 0}</span>
          )}
        </DefinitionRow>
      </DefinitionList>
    </Section>
  );
}
