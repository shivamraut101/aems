/**
 * The Account page's view model.
 *
 * Two things here are less obvious than they look: who a person's manager is, and what
 * "monitoring is on" actually promises. Both are pure so they can be asserted.
 */

import type { AccountManager, AccountProfile } from "@/lib/queries/account";
import type { UserRole } from "@/lib/session";

/**
 * Who this person reports to.
 *
 * There are three answers, and the third one is the honest description of a gap rather
 * than a bug:
 *
 *  - **`none`** — `manager_id` is null. Nobody is assigned.
 *  - **`named`** — the payload carried the manager, so the name is shown.
 *  - **`assigned`** — `manager_id` is set and the name is not knowable *by this reader*.
 *    `GET /api/employees/:profileId` selects `*, devices(*)` and no manager join, and an
 *    employee cannot look the id up themselves: RLS `profiles_select_self` returns
 *    exactly one row, their own. So the id is real, the name is not available, and
 *    printing a UUID or silently rendering "—" would both be worse than saying so.
 *
 * The `named` branch already works — it reads an embed the API does not send yet — so
 * adding `manager:profiles!manager_id(id, full_name, email)` to that select is the only
 * change needed to light it up. Both PostgREST join shapes are accepted, exactly as
 * `parseMeResponse` does for `companies(name)`.
 */
export type ManagerLine =
  | { state: "none" }
  | { state: "assigned" }
  | { state: "named"; name: string; email: string };

export function resolveManager(profile: AccountProfile | undefined): ManagerLine {
  if (!profile) return { state: "none" };

  const embedded = firstManager(profile.manager);
  if (embedded) {
    return {
      state: "named",
      name: embedded.full_name?.trim() || emailLocalPart(embedded.email),
      email: embedded.email,
    };
  }

  return profile.manager_id ? { state: "assigned" } : { state: "none" };
}

function firstManager(
  manager: AccountProfile["manager"],
): AccountManager | null {
  if (!manager) return null;
  if (Array.isArray(manager)) return manager[0] ?? null;
  return manager;
}

function emailLocalPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

/**
 * What the monitoring switch on this account means, from the account holder's side.
 *
 * It is a *company* control — `monitoring_enabled` is admin-only, RLS migration ...0005
 * exists specifically to stop a person turning it off for themselves — so the copy must
 * not imply the reader can change it here. What they *can* change is consent, per
 * device, which is why the "off" case still points at that page rather than reading as
 * a dead end.
 */
export interface MonitoringLine {
  label: string;
  tone: "success" | "muted";
  detail: string;
}

export function monitoringLine(enabled: boolean): MonitoringLine {
  return enabled
    ? {
        label: "Active",
        tone: "success",
        detail:
          "Your enrolled devices collect activity under the company policy, for as long as your consent for each one stands.",
      }
    : {
        label: "Paused",
        tone: "muted",
        detail:
          "Your administrator has paused collection for your account. Nothing new is being recorded on any of your devices.",
      };
}

/**
 * What this role can do in the dashboard, in one sentence.
 *
 * The client asked, in as many words, "what are the functionality they could get and
 * what they can do". A role badge on its own does not answer that; this does.
 */
export function roleSummary(role: UserRole): string {
  switch (role) {
    case "employee":
      return "You can read everything recorded about you, see which devices report under your name, and withdraw your consent on any of them.";
    case "manager":
      return "You can read activity, timelines and reports for everyone in your company. Changing policy, people and devices is a Super Admin action.";
    case "super_admin":
      return "You can read everything in the company, publish the monitoring policy, manage people and devices, and change what is collected.";
  }
}

/** "5 August 2026" — a joined date is a date, not a timestamp. */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";

  return new Date(parsed).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** "5 August 2026, 11:42" — for a consent record, where the hour is part of the proof. */
export function longDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";

  return new Date(parsed).toLocaleString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
