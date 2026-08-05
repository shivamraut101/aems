"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Pencil, UserMinus, UserPlus } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import { describeError, useEmployees, useSession } from "@/lib/api";
import {
  editDefaults,
  editEmployeeSchema,
  isDeactivated,
  managerName,
  managerOptions,
  toUpdatePatch,
  type EditEmployeeForm,
  type EditableEmployee,
} from "@/lib/queries/employees-form";
import {
  useDeactivateEmployee,
  useReactivateEmployee,
  useUpdateEmployee,
} from "@/lib/queries/employees";
import { useEmployee, type EmployeeDetail } from "@/lib/queries/employee";
import { roleLabel } from "@/lib/session";

import {
  Dialog,
  Field,
  FormError,
  controlClass,
  destructiveButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "../dialog";

/**
 * Management actions for one person — scope §4.2, on the page a manager already
 * spends their time on.
 *
 * Before this the employee page was read-only: `department` was rendered in four
 * places and settable in none, `manager_id` could only be changed in the database,
 * and the Devices tab explained that "this device was revoked" without offering any
 * way to revoke one. A page that narrates state it cannot produce is a report, not a
 * console.
 *
 * Deliberately sited between the identity header and the tab strip so it is present
 * on every tab: the decision to pause somebody's collection is not a decision about
 * the Overview tab.
 */
export function EmployeeActions({ profileId }: { profileId: string }) {
  const { data: employee } = useEmployee(profileId);
  const { data: session } = useSession();
  const { data: roster } = useEmployees();

  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<"deactivate" | "reactivate" | null>(null);

  // Nothing to act on yet. The header owns the loading and error surfaces for this
  // record; a second skeleton here would just be a second thing flashing.
  if (!employee) return null;

  // The API's `requireSuperAdmin` is the boundary. This only stops the UI offering a
  // manager a form that ends in a 403.
  const canManage = session?.role === "super_admin";
  const isSelf = session?.profileId === profileId;
  const deactivated = isDeactivated(employee);
  const reportsTo = managerName(roster ?? [], employee.manager_id);

  return (
    <div className="px-6 pb-4">
      {deactivated ? (
        <p className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            This account is deactivated. Collection has stopped, its devices are revoked and
            its consent records are withdrawn. Everything already recorded is kept and is
            still readable below.
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <div className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">Reports to</dt>
            <dd className="font-medium">{reportsTo ?? "Not set"}</dd>
          </div>

          {/* Stated, because the consequence is silent everywhere else: the report
              runner resolves a "my team" scope through `manager_id`, so a person
              with none is in nobody's team report and no screen says why. */}
          {reportsTo === null ? (
            <p className="text-xs text-muted-foreground">
              Nobody&rsquo;s team report includes this person until a manager is set.
            </p>
          ) : null}
        </dl>

        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={secondaryButtonClass}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
              Edit details
            </button>

            {deactivated ? (
              <button
                type="button"
                onClick={() => setConfirming("reactivate")}
                className={primaryButtonClass}
              >
                <UserPlus className="h-3.5 w-3.5" aria-hidden />
                Reactivate
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming("deactivate")}
                // Deactivating yourself would revoke the devices of the person
                // holding the only super-admin session, from that session.
                disabled={isSelf}
                title={isSelf ? "Ask another super admin to deactivate your account" : undefined}
                className={secondaryButtonClass}
              >
                <UserMinus className="h-3.5 w-3.5" aria-hidden />
                Deactivate
              </button>
            )}
          </div>
        ) : null}
      </div>

      {editing ? (
        <EditEmployeeDialog employee={employee} onClose={() => setEditing(false)} />
      ) : null}

      {confirming !== null ? (
        <AccountStateDialog
          mode={confirming}
          employee={employee}
          onClose={() => setConfirming(null)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Edit                                                                       */
/* ------------------------------------------------------------------------- */

function EditEmployeeDialog({
  employee,
  onClose,
}: {
  employee: EmployeeDetail;
  onClose: () => void;
}) {
  const nameId = useId();
  const departmentId = useId();
  const managerFieldId = useId();
  const roleId = useId();
  const monitoringId = useId();

  const [serverError, setServerError] = useState<string | null>(null);

  const { data: roster } = useEmployees();
  const managers = useMemo(() => managerOptions(roster ?? [], employee.id), [roster, employee.id]);

  const update = useUpdateEmployee();

  const current: EditableEmployee = employee;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EditEmployeeForm>({
    resolver: zodResolver(editEmployeeSchema),
    defaultValues: editDefaults(current),
  });

  async function onSubmit(values: EditEmployeeForm) {
    setServerError(null);

    const patch = toUpdatePatch(values, current);
    // Saving an untouched form would be answered with a 400 `empty_patch` and read
    // as a failure. Nothing changed, so closing is the honest outcome.
    if (patch === null) {
      onClose();
      return;
    }

    try {
      await update.mutateAsync({ profileId: employee.id, patch });
      onClose();
    } catch (error) {
      setServerError(describeError(error));
    }
  }

  return (
    <Dialog
      title="Edit details"
      description={employee.email}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className="space-y-4 px-5 py-4">
          {serverError ? <FormError message={serverError} /> : null}

          <Field label="Full name" htmlFor={nameId} error={errors.fullName?.message}>
            <input
              {...register("fullName")}
              id={nameId}
              type="text"
              autoComplete="off"
              autoFocus
              aria-invalid={errors.fullName ? true : undefined}
              aria-describedby={errors.fullName ? `${nameId}-error` : undefined}
              className={controlClass}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Department"
              htmlFor={departmentId}
              error={errors.department?.message}
              hint="Clear it to remove them from every department filter."
            >
              <input
                {...register("department")}
                id={departmentId}
                type="text"
                autoComplete="off"
                placeholder="Not set"
                aria-invalid={errors.department ? true : undefined}
                aria-describedby={errors.department ? `${departmentId}-error` : undefined}
                className={controlClass}
              />
            </Field>

            <Field
              label="Role"
              htmlFor={roleId}
              error={errors.role?.message}
              hint="Managers and super admins can read other people's activity."
            >
              <select {...register("role")} id={roleId} className={controlClass}>
                <option value="employee">{roleLabel("employee")}</option>
                <option value="manager">{roleLabel("manager")}</option>
                <option value="super_admin">{roleLabel("super_admin")}</option>
              </select>
            </Field>
          </div>

          <Field
            label="Reports to"
            htmlFor={managerFieldId}
            error={errors.managerId?.message}
            hint="This is what a team report resolves. With nobody set, this person appears in no team report."
          >
            <select {...register("managerId")} id={managerFieldId} className={controlClass}>
              <option value="">No manager</option>
              {managers.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Monitoring"
            htmlFor={monitoringId}
            error={errors.monitoring?.message}
            hint="Pausing stops collection on this person's next agent request. Their history is kept."
          >
            <select {...register("monitoring")} id={monitoringId} className={controlClass}>
              <option value="on">Collecting</option>
              <option value="paused">Paused</option>
            </select>
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={isSubmitting} className={primaryButtonClass}>
            {isSubmitting ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------------- */
/* Deactivate / reactivate                                                    */
/* ------------------------------------------------------------------------- */

/**
 * The confirm step, which names every consequence rather than asking "Are you sure?".
 *
 * Three facts, because all three are surprising to somebody: collection stops, the
 * devices are revoked, and nothing already recorded is deleted. The last one is the
 * reason this is not called "Delete" — non-negotiable #5 keeps the audit trail, and
 * an administrator who believes a removal erases the record will be wrong about what
 * their company still holds.
 */
function AccountStateDialog({
  mode,
  employee,
  onClose,
}: {
  mode: "deactivate" | "reactivate";
  employee: EmployeeDetail;
  onClose: () => void;
}) {
  const [serverError, setServerError] = useState<string | null>(null);

  const deactivate = useDeactivateEmployee();
  const reactivate = useReactivateEmployee();
  const pending = deactivate.isPending || reactivate.isPending;

  const name = employee.full_name?.trim() || employee.email;
  const activeDevices = employee.devices.filter((device) => device.status !== "revoked").length;

  async function run() {
    setServerError(null);
    try {
      if (mode === "deactivate") await deactivate.mutateAsync(employee.id);
      else await reactivate.mutateAsync(employee.id);
      onClose();
    } catch (error) {
      setServerError(describeError(error));
    }
  }

  return (
    <Dialog
      title={mode === "deactivate" ? `Deactivate ${name}?` : `Reactivate ${name}?`}
      onClose={onClose}
    >
      <div className="space-y-3 px-5 py-4 text-sm">
        {serverError ? <FormError message={serverError} /> : null}

        {mode === "deactivate" ? (
          <ul className="space-y-2">
            <li className="flex gap-2">
              <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-foreground" />
              <span>
                Collection stops. Their agent is refused on its next request — not at the end
                of the day.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-foreground" />
              <span>
                {activeDevices === 0
                  ? "They have no enrolled device left to revoke."
                  : `${activeDevices} enrolled ${activeDevices === 1 ? "device is" : "devices are"} revoked and must be enrolled again to work.`}
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-foreground" />
              <span>
                Their consent is withdrawn, so nothing may be collected from them again until
                they accept the policy on a fresh enrolment.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-foreground" />
              <span>
                Their history is kept. Sessions, activity, captures and reports stay exactly
                where they are and remain readable on this page.
              </span>
            </li>
          </ul>
        ) : (
          <>
            <p>
              {name} can sign in again and appears on the roster as usual.
            </p>
            <p>
              Monitoring stays paused and their devices stay revoked. That is deliberate:
              consent was withdrawn when they were off-boarded, and collection may not resume
              on the strength of an administrator&rsquo;s click. Enrolling an agent again, and
              accepting the policy on it, is what starts collection.
            </p>
          </>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
        <button type="button" onClick={onClose} className={secondaryButtonClass}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void run()}
          disabled={pending}
          className={mode === "deactivate" ? destructiveButtonClass : primaryButtonClass}
        >
          {pending
            ? "Working…"
            : mode === "deactivate"
              ? "Deactivate account"
              : "Reactivate account"}
        </button>
      </div>
    </Dialog>
  );
}
