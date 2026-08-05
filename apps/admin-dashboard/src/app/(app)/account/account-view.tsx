"use client";

import { Badge } from "@aems/ui";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { longDate, monitoringLine, resolveManager, roleSummary } from "@/components/me/account-model";
import { ChangePasswordPanel } from "@/components/me/change-password";
import { Fact, FactList, MePanel, MeShell } from "@/components/me/me-shell";
import { ErrorState, PanelSkeleton, StaleNotice } from "@/components/states";
import { describeError, useApiQuery, useSession } from "@/lib/api";
import { accountQuery } from "@/lib/queries/account";
import { roleLabel } from "@/lib/session";

/**
 * `/account` — who you are in this company, and the one credential you own.
 *
 * Every role lands here, not only employees: a manager and an admin have exactly the
 * same need to change a password and the same right to see what the company has
 * recorded about them. The role matrix calls it "Everyone".
 *
 * Identity comes from `GET /api/employees/:profileId`, which allows any caller to read
 * **themselves** whatever their role, so this needs no new endpoint. The id always
 * comes from the session and never from the URL — a page that took a subject from the
 * address bar would be a viewer for somebody else's profile the moment a manager opened
 * a crafted link, and the API would refuse it besides.
 */
export function AccountView() {
  const { data: session } = useSession();
  const profileId = session?.profileId ?? "";

  const profile = useApiQuery(accountQuery(profileId), { enabled: profileId !== "" });

  const manager = resolveManager(profile.data);
  const monitoring = monitoringLine(profile.data?.monitoring_enabled ?? session?.monitoringEnabled ?? true);

  return (
    <MeShell
      title="Account"
      subtitle="Your details in this company, and your sign-in password."
    >
      {profile.isError && !session ? (
        <ErrorState
          title="Your account could not be loaded"
          message={describeError(profile.error)}
          onRetry={() => void profile.refetch()}
        />
      ) : null}

      {/* The session already carries name, email, role and department, so a failed
          profile read costs the department's *source* and the manager line — not the
          page. Saying so beats blanking a screen that can still answer most of itself. */}
      {profile.isError && session ? (
        <StaleNotice
          className="rounded-md border"
          message="Some of your details could not be refreshed just now. What is shown comes from your current session."
          onRetry={() => void profile.refetch()}
        />
      ) : null}

      {profile.isLoading && !session ? (
        <PanelSkeleton minHeightClass="min-h-[16rem]" lines={5} label="Loading your account" />
      ) : (
        <MePanel title="You">
          <FactList>
            <Fact label="Name">{profile.data?.full_name || session?.fullName || "—"}</Fact>
            <Fact label="Work email">
              <span className="break-all">{profile.data?.email || session?.email || "—"}</span>
            </Fact>
            <Fact label="Role" hint={roleSummary(profile.data?.role ?? session?.role ?? "employee")}>
              <Badge variant="secondary" className="font-normal">
                {roleLabel(profile.data?.role ?? session?.role ?? "employee")}
              </Badge>
            </Fact>
            <Fact label="Company">{session?.companyName ?? "—"}</Fact>
            <Fact label="Department">
              {profile.data?.department ?? session?.department ?? "Not set"}
            </Fact>
            <Fact label="Manager" hint={managerHint(manager.state)}>
              <ManagerValue manager={manager} />
            </Fact>
            <Fact label="In the system since">{longDate(profile.data?.created_at)}</Fact>
            <Fact label="Monitoring" hint={monitoring.detail}>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={
                    monitoring.tone === "success"
                      ? "h-2 w-2 rounded-full bg-success"
                      : "h-2 w-2 rounded-full bg-muted-foreground/50"
                  }
                />
                {monitoring.label}
              </span>
            </Fact>
          </FactList>

          <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
            Your name, department, role and manager are set by your administrator. If any of
            them is wrong, ask them to correct it.
          </p>
        </MePanel>
      )}

      <ChangePasswordPanel email={profile.data?.email || session?.email || ""} />

      <MePanel title="Your monitoring">
        <p className="max-w-prose text-sm text-muted-foreground">
          Which devices report under your name, what each one records, and the terms you
          agreed to — including withdrawing your consent — are on My devices.
        </p>
        <Link
          href="/my-devices"
          className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Open My devices
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </MePanel>
    </MeShell>
  );
}

function ManagerValue({ manager }: { manager: ReturnType<typeof resolveManager> }) {
  if (manager.state === "named") {
    return (
      <span>
        {manager.name} <span className="text-muted-foreground">· {manager.email}</span>
      </span>
    );
  }

  if (manager.state === "assigned") return <span>Assigned</span>;
  return <span className="text-muted-foreground">Nobody assigned</span>;
}

/**
 * The honest footnote for the state the API is in today.
 *
 * `GET /api/employees/:profileId` sends `manager_id` and no join, and RLS lets an
 * employee read exactly one profile row — their own — so the name is genuinely not
 * reachable from this browser. Saying that is better than a dash, and far better than
 * printing the UUID.
 */
function managerHint(state: ReturnType<typeof resolveManager>["state"]): string | undefined {
  if (state === "assigned") {
    return "A manager is assigned to you. Their name is not shared on this page — ask your administrator if you need it.";
  }
  return undefined;
}
