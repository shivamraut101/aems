"use client";

import { ErrorState } from "@/components/states";
import { describeError, useApiQuery, useSession } from "@/lib/api";
import { devicesQuery, employeesQuery } from "@/lib/queries/settings-specs";
import { roleLabel } from "@/lib/session";

import { CategoriesSection } from "./categories-section";
import { MonitoringSection } from "./monitoring-section";
import { PolicySection } from "./policy-section";
import { DefinitionList, DefinitionRow, Section, ValueSkeleton } from "./section";

/**
 * The company settings page body — everything that was `page.tsx` before the split.
 *
 * Four sections, in the order an admin needs them: what this tenant is, what the agents
 * are told to collect, how that collection is classified, and who is being monitored.
 * Website access is the sibling route, because it is the one part of this screen that
 * changes what an employee's machine can *do* rather than what it records.
 *
 * Three of the four write, and every write goes through the Fastify API so the audit
 * log records it.
 */

/**
 * The four jobs this route holds, as anchors.
 *
 * They are unrelated to each other — a tenant fact, an agent configuration, a scoring
 * rule set and a per-person switch — and stacking four unrelated jobs in one scroll
 * hides three of them below the fold. The tab strip above says there are two *routes*;
 * this says what is on this one, which is the question it does not answer.
 */
const SECTIONS: readonly { id: string; label: string }[] = [
  { id: "company", label: "Company" },
  { id: "policy", label: "Monitoring policy" },
  { id: "categories", label: "Category rules" },
  { id: "monitoring", label: "Employee monitoring" },
];

export function SettingsView() {
  return (
    <>
      <nav aria-label="Sections on this page" className="mb-6 flex flex-wrap gap-2">
        {SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="inline-flex h-8 items-center rounded-md border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {section.label}
          </a>
        ))}
      </nav>

      <CompanySection />
      <PolicySection />
      <CategoriesSection />
      <MonitoringSection />
    </>
  );
}

function CompanySection() {
  const { data: session, isLoading, isError, error, refetch } = useSession();
  // The same specs `page.tsx` prefetched, so these are answered from the hydrated
  // cache rather than fetched again on mount.
  const employees = useApiQuery(employeesQuery);
  const devices = useApiQuery(devicesQuery);

  if (isError) {
    return (
      <Section title="Company" id="company">
        <ErrorState
          title="Could not load your account"
          message={describeError(error)}
          onRetry={() => void refetch()}
        />
      </Section>
    );
  }

  return (
    <Section
      id="company"
      title="Company"
      description="The tenant every record on this screen belongs to."
      affects="nothing — this section is read-only."
    >
      <DefinitionList>
        <DefinitionRow term="Company">
          {isLoading ? (
            <ValueSkeleton />
          ) : session?.companyName ? (
            // Never a UUID: an identifier is not an answer to "which company is this".
            <span className="font-medium">{session.companyName}</span>
          ) : (
            // There is deliberately no fallback to `session.department`. It used to
            // sit here and it was worse than nothing: on the page whose stated job is
            // naming the tenant, it printed the signed-in admin's *department*
            // ("Engineering") where the company name ("Acme Corp") belongs — a
            // confident wrong answer, which is the one failure mode a settings screen
            // cannot afford.
            <span className="text-muted-foreground">Not set</span>
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
