/**
 * Validation and view models for adding and editing a person — scope §4.2.
 *
 * Pure, and deliberately free of React, TanStack Query and the Supabase client, so
 * every rule on this screen is provable in a node test instead of through a rendered
 * dialog. `employees.ts` next door owns the requests; this file owns what a valid
 * request *is*.
 *
 * The Zod schemas are the single source of validation truth (CLAUDE.md, per-surface
 * rules): the form types are inferred from them rather than declared a second time,
 * so a field cannot drift from its own rule. Nothing here uses `.transform()` or
 * `.default()` on purpose — those make `z.input` and `z.output` diverge, and React
 * Hook Form binds inputs to the *input* type while the resolver hands back the output.
 */

import { z } from "zod";

import type { UserRole } from "@/lib/session";

/** The three roles RLS knows about. Ordered least-privileged first, as the select is. */
export const ROLE_VALUES = ["employee", "manager", "super_admin"] as const;

/* ------------------------------------------------------------------------- */
/* Add a person                                                               */
/* ------------------------------------------------------------------------- */

/**
 * The create form.
 *
 * Every message is written to the person filling the form in, not to a developer.
 * "Invalid email" tells someone their input was rejected; "That does not look like
 * an email address" tells them what to do about it.
 *
 * `department` and `managerId` are required *strings* rather than optional fields
 * because an unfilled `<input>` is `""`, never `undefined` — modelling them as
 * optional would mean the form's own empty state failed its own schema.
 */
export const createEmployeeSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "An email address is required — it is how this person signs in.")
    .max(254, "That email address is too long.")
    .email("That does not look like an email address."),
  fullName: z
    .string()
    .trim()
    .min(1, "A full name is required.")
    .max(160, "Keep the name under 160 characters."),
  role: z.enum(ROLE_VALUES),
  department: z.string().trim().max(120, "Keep the department under 120 characters."),
  /** A profile id, or "" for nobody. Never a name — the select carries ids. */
  managerId: z.union([z.literal(""), z.string().uuid()]),
});

export type CreateEmployeeForm = z.infer<typeof createEmployeeSchema>;

export const EMPTY_CREATE_FORM: CreateEmployeeForm = {
  email: "",
  fullName: "",
  role: "employee",
  department: "",
  managerId: "",
};

/** `POST /api/employees`. Optional keys are omitted rather than sent as "". */
export interface CreateEmployeeBody {
  email: string;
  fullName: string;
  role: UserRole;
  department?: string;
  managerId?: string;
}

/**
 * Form values → request body.
 *
 * The email is lower-cased because Supabase Auth stores it that way; sending
 * `John@Acme.com` and then looking the person up by `john@acme.com` is how a
 * duplicate account gets created for somebody who already has one.
 */
export function toCreateBody(values: CreateEmployeeForm): CreateEmployeeBody {
  const body: CreateEmployeeBody = {
    email: values.email.trim().toLowerCase(),
    fullName: values.fullName.trim(),
    role: values.role,
  };

  const department = values.department.trim();
  if (department !== "") body.department = department;
  if (values.managerId !== "") body.managerId = values.managerId;

  return body;
}

/* ------------------------------------------------------------------------- */
/* Edit a person                                                              */
/* ------------------------------------------------------------------------- */

/**
 * The five fields `PATCH /api/employees/:profileId` accepts, as the form holds them.
 *
 * Monitoring is a string here rather than a boolean because it is bound to a
 * `<select>`, and a select's value is always a string — modelling it as a boolean
 * would make React Hook Form's registered value disagree with the schema's own input
 * type, which is the bug that `z.coerce` usually hides rather than fixes.
 */
export const editEmployeeSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, "A full name is required.")
    .max(160, "Keep the name under 160 characters."),
  department: z.string().trim().max(120, "Keep the department under 120 characters."),
  managerId: z.union([z.literal(""), z.string().uuid()]),
  role: z.enum(ROLE_VALUES),
  monitoring: z.enum(["on", "paused"]),
});

export type EditEmployeeForm = z.infer<typeof editEmployeeSchema>;

/** The shape the edit form reads from — a profile row, however it was fetched. */
export interface EditableEmployee {
  full_name: string | null;
  department: string | null;
  manager_id: string | null;
  role: UserRole;
  monitoring_enabled: boolean;
}

export function editDefaults(person: EditableEmployee): EditEmployeeForm {
  return {
    fullName: person.full_name ?? "",
    department: person.department ?? "",
    managerId: person.manager_id ?? "",
    role: person.role,
    monitoring: person.monitoring_enabled ? "on" : "paused",
  };
}

/** `PATCH /api/employees/:profileId`. Null clears a column; absent leaves it alone. */
export interface UpdateEmployeeBody {
  fullName?: string;
  department?: string | null;
  managerId?: string | null;
  role?: UserRole;
  monitoringEnabled?: boolean;
}

/**
 * The difference between what is on screen and what is stored — or null.
 *
 * Only changed fields are sent, for two reasons. The API rejects an empty patch with
 * a 400, so a "Save" on an untouched form would render as a failure; and the patch is
 * copied verbatim into the audit log, where `{department: "Support"}` records what a
 * super admin actually did and a full echo of the row records nothing.
 *
 * An emptied department or manager becomes `null`, not `""`: a person with no
 * department and a person whose department is the empty string must not be two states.
 */
export function toUpdatePatch(
  values: EditEmployeeForm,
  current: EditableEmployee,
): UpdateEmployeeBody | null {
  const patch: UpdateEmployeeBody = {};

  const fullName = values.fullName.trim();
  if (fullName !== (current.full_name ?? "")) patch.fullName = fullName;

  const department = values.department.trim();
  if (department !== (current.department ?? "")) {
    patch.department = department === "" ? null : department;
  }

  if (values.managerId !== (current.manager_id ?? "")) {
    patch.managerId = values.managerId === "" ? null : values.managerId;
  }

  if (values.role !== current.role) patch.role = values.role;

  const monitoring = values.monitoring === "on";
  if (monitoring !== current.monitoring_enabled) patch.monitoringEnabled = monitoring;

  return Object.keys(patch).length === 0 ? null : patch;
}

/* ------------------------------------------------------------------------- */
/* Who can be somebody's manager                                              */
/* ------------------------------------------------------------------------- */

export interface ManagerCandidate {
  id: string;
  full_name: string | null;
  email: string;
  role: UserRole;
  /** Optional so a roster row typed without the column is still a candidate. */
  deactivated_at?: string | null;
}

export interface ManagerOption {
  id: string;
  label: string;
}

/**
 * The people who may appear in a "Reports to" select.
 *
 * These are the same three exclusions `managerAssignmentDenial` enforces on the API,
 * mirrored here so the control never offers a value the server will refuse. Each has
 * its own reason:
 *
 *  - **Employees.** `manager_id` is what `POST /api/reports/run` resolves for the
 *    `my_team` scope; pointing it at somebody who cannot open Reports produces a team
 *    report nobody can read.
 *  - **The person being edited.** A self-referencing manager makes them their own
 *    team, which the report resolver would happily return.
 *  - **Deactivated people.** An off-boarded manager is a team with nobody reading it.
 */
export function managerOptions(
  rows: readonly ManagerCandidate[],
  excludeId?: string,
): ManagerOption[] {
  return rows
    .filter(
      (row) =>
        row.role !== "employee" && row.id !== excludeId && !isDeactivated(row),
    )
    .map((row) => ({ id: row.id, label: row.full_name?.trim() || row.email }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

/**
 * The manager's name for display, or null.
 *
 * Returns null for an id nobody in the roster matches rather than printing the raw
 * uuid: a manager who left the company is "not set any more" to a reader, and a bare
 * uuid on a person's page reads as a bug.
 */
export function managerName(
  rows: readonly ManagerCandidate[],
  managerId: string | null,
): string | null {
  if (!managerId) return null;
  const found = rows.find((row) => row.id === managerId);
  if (!found) return null;
  return found.full_name?.trim() || found.email;
}

/* ------------------------------------------------------------------------- */
/* Account state                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Has this account been off-boarded?
 *
 * `profiles.deactivated_at` is a tombstone, not a flag: the API sets it and clears
 * it, and a timestamp records *when* somebody left where a boolean records only
 * that they did.
 *
 * Read through `in` rather than declared as an optional property, and both halves of
 * that matter. A profile row typed *without* the column is still a valid argument —
 * TypeScript rejects an object with no overlapping keys against an all-optional type,
 * and `EmployeeRow` and `EmployeeDetail` in `lib/api.ts` predate it. And a row that
 * does not carry it reads as "not deactivated", never the reverse: guessing the other
 * way produces a roster offering to reactivate everybody in the company.
 */
export function isDeactivated(person: object): boolean {
  return "deactivated_at" in person && typeof person.deactivated_at === "string";
}
