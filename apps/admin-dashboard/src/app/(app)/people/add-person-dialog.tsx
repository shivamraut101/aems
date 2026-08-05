"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Copy, KeyRound } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";

import { describeError, useEmployees } from "@/lib/api";
import {
  EMPTY_CREATE_FORM,
  createEmployeeSchema,
  managerOptions,
  toCreateBody,
  type CreateEmployeeForm,
} from "@/lib/queries/employees-form";
import { useCreateEmployee } from "@/lib/queries/employees";
import { roleLabel } from "@/lib/session";

import {
  Dialog,
  Field,
  FormError,
  controlClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "./dialog";

/**
 * Add a person — scope §4.2's first bullet, and the one the roster used to answer by
 * telling an administrator to go and create the account in the Supabase console.
 *
 * `POST /api/employees` rather than a Supabase insert, because only the API holds the
 * service-role key that can create the auth user and the profile in one step, and
 * because that is where `recordAudit` writes the row saying who added whom.
 *
 * Two steps, not one. The API generates a first password and returns it exactly once
 * — there is no SMTP configured, so no invitation email goes anywhere and that string
 * is the only way the new person will ever sign in. A dialog that closed on success
 * would silently create an account nobody can use, so the second step exists purely
 * to hand the credential over.
 *
 * One `<Dialog>` spanning both steps rather than one per step. The shell captures the
 * element that opened it on mount and restores focus to it on unmount; remounting it
 * between the steps would re-capture whatever had focus mid-transition — nothing, once
 * the submit button it was on had been removed — and a keyboard user would be returned
 * to the top of the document instead of to the button they pressed.
 */
export function AddPersonDialog({ onClose }: { onClose: () => void }) {
  const [created, setCreated] = useState<{ email: string; password: string | null } | null>(null);

  return (
    <Dialog
      title={created ? "Account created" : "Add a person"}
      description={
        created
          ? created.password
            ? "Give these to the new employee. The password is not stored and cannot be shown again."
            : "Give the password you chose to the new employee."
          : "Creates their sign-in account and puts them on the roster. Nothing is collected until they sign in on a device and accept the monitoring policy."
      }
      onClose={onClose}
    >
      {created ? (
        <CredentialsStep email={created.email} password={created.password} onClose={onClose} />
      ) : (
        <CreateStep onCreated={setCreated} onClose={onClose} />
      )}
    </Dialog>
  );
}

function CreateStep({
  onCreated,
  onClose,
}: {
  onCreated: (value: { email: string; password: string | null }) => void;
  onClose: () => void;
}) {
  const emailId = useId();
  const nameId = useId();
  const roleId = useId();
  const departmentId = useId();
  const managerId = useId();

  const [serverError, setServerError] = useState<string | null>(null);

  // Already in cache — this dialog opens from the roster, which fetched it.
  const { data: roster } = useEmployees();
  const managers = useMemo(() => managerOptions(roster ?? []), [roster]);

  const create = useCreateEmployee();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateEmployeeForm>({
    resolver: zodResolver(createEmployeeSchema),
    defaultValues: EMPTY_CREATE_FORM,
  });

  async function onSubmit(values: CreateEmployeeForm) {
    setServerError(null);
    const body = toCreateBody(values);

    try {
      const result = await create.mutateAsync(body);
      onCreated({ email: body.email, password: result.temporaryPassword });
    } catch (error) {
      // The server's own wording, kept. "That email address is already registered"
      // and "Only a manager or a super admin can be assigned as a manager" both say
      // precisely what to change; replacing them with a generic failure turns a
      // fixable form into a dead end.
      setServerError(describeError(error));
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className="space-y-4 px-5 py-4">
          {serverError ? <FormError message={serverError} /> : null}

          <Field label="Work email" htmlFor={emailId} error={errors.email?.message}>
            <input
              {...register("email")}
              id={emailId}
              type="email"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              placeholder="name@company.com"
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? `${emailId}-error` : undefined}
              className={controlClass}
            />
          </Field>

          <Field label="Full name" htmlFor={nameId} error={errors.fullName?.message}>
            <input
              {...register("fullName")}
              id={nameId}
              type="text"
              autoComplete="off"
              aria-invalid={errors.fullName ? true : undefined}
              aria-describedby={errors.fullName ? `${nameId}-error` : undefined}
              className={controlClass}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
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

            <Field
              label="Department"
              htmlFor={departmentId}
              error={errors.department?.message}
              hint="Optional. Groups the roster and filters reports."
            >
              <input
                {...register("department")}
                id={departmentId}
                type="text"
                autoComplete="off"
                placeholder="Engineering"
                aria-invalid={errors.department ? true : undefined}
                aria-describedby={errors.department ? `${departmentId}-error` : undefined}
                className={controlClass}
              />
            </Field>
          </div>

          <Field
            label="Reports to"
            htmlFor={managerId}
            error={errors.managerId?.message}
            hint={
              managers.length === 0
                ? "No managers on the roster yet — add one and this list fills in."
                : "Only active managers and super admins can appear here, because this is what a team report resolves."
            }
          >
            <select
              {...register("managerId")}
              id={managerId}
              disabled={managers.length === 0}
              className={controlClass}
            >
              <option value="">No manager</option>
              {managers.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={isSubmitting} className={primaryButtonClass}>
            {isSubmitting ? "Adding…" : "Add person"}
          </button>
        </div>
    </form>
  );
}

/**
 * The credential, once.
 *
 * Deliberately hard to walk past: the password is not stored anywhere, so closing
 * this panel without copying it means the new account can only be recovered through
 * a password reset the product does not yet offer.
 */
function CredentialsStep({
  email,
  password,
  onClose,
}: {
  email: string;
  password: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(`${email}\n${password}`);
      setCopied(true);
    } catch {
      // Clipboard access can be refused outright — an insecure origin, a permission
      // policy. The password is on screen and selectable either way, so this is a
      // convenience that failed, not the feature failing.
      setCopied(false);
    }
  }

  return (
    <>
      <div className="space-y-4 px-5 py-4">
        <dl className="rounded-md border bg-secondary/40 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Email</dt>
            <dd className="font-mono text-sm">{email}</dd>
          </div>
          {password ? (
            <div className="mt-2 flex flex-wrap items-baseline gap-x-3">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Password</dt>
              {/* Selectable text, not a masked field: it has to be readable to be
                  handed over, and it is already visible to the person who made it. */}
              <dd className="select-all break-all font-mono text-sm">{password}</dd>
            </div>
          ) : null}
        </dl>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <KeyRound className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            They can sign in immediately. Nothing is collected from them until they install an
            agent on a device and accept the monitoring policy on it.
          </span>
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
        {password ? (
          <button type="button" onClick={() => void copy()} className={secondaryButtonClass}>
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
            {copied ? "Copied" : "Copy sign-in details"}
          </button>
        ) : null}
        <button type="button" onClick={onClose} className={primaryButtonClass}>
          Done
        </button>
      </div>
    </>
  );
}
