"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@aems/ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Copy, KeyRound, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { describeError, useApiQuery } from "@/lib/api";
import { useCreateEmployee } from "@/lib/queries/employees";
import {
  EMPTY_CREATE_FORM,
  createEmployeeSchema,
  managerOptions,
  toCreateBody,
  type CreateEmployeeForm,
} from "@/lib/queries/employees-form";
import { roleLabel } from "@/lib/session";

import { employeesQuery } from "./queries";

/**
 * Add a person — scope §4.2's first bullet, and the one the roster used to answer by
 * telling an administrator to go and create the account in the Supabase console.
 *
 * `POST /api/employees` rather than a Supabase insert, because only the API holds the
 * service-role key that can create the auth user and the profile in one step, and
 * because that is where `recordAudit` writes the row saying who added whom.
 *
 * Two steps, not one. The API generates a first password and returns it exactly once —
 * there is no SMTP configured, so no invitation email goes anywhere and that string is
 * the only way the new person will ever sign in. A dialog that closed on success would
 * silently create an account nobody can use, so the second step exists purely to hand
 * the credential over.
 *
 * One `<Dialog>` spanning both steps rather than one per step, so the focus Radix
 * captured on open is still returned to the button that opened it — remounting between
 * the steps would re-capture whatever had focus mid-transition, which by then is
 * nothing, and a keyboard user would be returned to the top of the document.
 */
export function AddPersonDialog({ onClose }: { onClose: () => void }) {
  const [created, setCreated] = useState<{ email: string; password: string | null } | null>(null);

  return (
    // Controlled and always open: this component only exists while the roster renders
    // it, so dismissing means unmounting rather than flipping a second piece of state.
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{created ? "Account created" : "Add a person"}</DialogTitle>
          <DialogDescription>
            {created
              ? created.password
                ? "Give these to the new employee. The password is not stored and cannot be shown again."
                : "Give the password you chose to the new employee."
              : "Creates their sign-in account and puts them on the roster. Nothing is collected until they sign in on a device and accept the monitoring policy."}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <CredentialsStep email={created.email} password={created.password} onClose={onClose} />
        ) : (
          <CreateStep onCreated={setCreated} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Radix refuses `value=""` on a `SelectItem`, so "nobody" needs a name of its own. */
const NO_MANAGER = "__none__";

function CreateStep({
  onCreated,
  onClose,
}: {
  onCreated: (value: { email: string; password: string | null }) => void;
  onClose: () => void;
}) {
  const [serverError, setServerError] = useState<string | null>(null);

  // Already in cache — this dialog opens from the roster, whose server page warmed the
  // very same spec.
  const { data: roster } = useApiQuery(employeesQuery);
  const managers = useMemo(() => managerOptions(roster ?? []), [roster]);

  const create = useCreateEmployee();

  const {
    register,
    control,
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
      // The server's own wording, kept. "That email address is already registered" and
      // "Only a manager or a super admin can be assigned as a manager" both say
      // precisely what to change; replacing them with a generic failure turns a fixable
      // form into a dead end.
      setServerError(describeError(error));
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
      {serverError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
        >
          {serverError}
        </p>
      ) : null}

      <Field label="Work email" required error={errors.email?.message}>
        {(field) => (
          <Input
            {...field}
            {...register("email")}
            type="email"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            placeholder="name@company.com"
          />
        )}
      </Field>

      <Field label="Full name" required error={errors.fullName?.message}>
        {(field) => <Input {...field} {...register("fullName")} type="text" autoComplete="off" />}
      </Field>

      {/* One column on a phone, two from `sm` up. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Role"
          error={errors.role?.message}
          hint="Managers and super admins can read other people's activity."
        >
          {(field) => (
            <Controller
              control={control}
              name="role"
              render={({ field: control }) => (
                <Select value={control.value} onValueChange={control.onChange}>
                  <SelectTrigger {...field}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="employee">{roleLabel("employee")}</SelectItem>
                    <SelectItem value="manager">{roleLabel("manager")}</SelectItem>
                    <SelectItem value="super_admin">{roleLabel("super_admin")}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          )}
        </Field>

        <Field
          label="Department"
          error={errors.department?.message}
          hint="Optional. Groups the roster and filters reports."
        >
          {(field) => (
            <Input
              {...field}
              {...register("department")}
              type="text"
              autoComplete="off"
              placeholder="Engineering"
            />
          )}
        </Field>
      </div>

      <Field
        label="Reports to"
        error={errors.managerId?.message}
        hint={
          managers.length === 0
            ? "No managers on the roster yet — add one and this list fills in."
            : "Only active managers and super admins can appear here, because this is what a team report resolves."
        }
      >
        {(field) => (
          <Controller
            control={control}
            name="managerId"
            render={({ field: control }) => (
              <Select
                // "" is a legitimate form value (nobody) and an illegal Radix one, so
                // the sentinel is translated at the boundary rather than leaking into
                // the schema, which is what `toCreateBody` reads.
                value={control.value === "" ? NO_MANAGER : control.value}
                onValueChange={(value) => control.onChange(value === NO_MANAGER ? "" : value)}
                disabled={managers.length === 0}
              >
                <SelectTrigger {...field}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_MANAGER}>No manager</SelectItem>
                  {managers.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        )}
      </Field>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {isSubmitting ? "Adding…" : "Add person"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The credential, once.
 *
 * Deliberately hard to walk past: the password is not stored anywhere, so closing this
 * panel without copying it means the new account can only be recovered through a
 * password reset the product does not yet offer.
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
    <div className="flex flex-col gap-4">
      <dl className="rounded-md border bg-secondary/40 px-4 py-3 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Email
          </dt>
          <dd className="min-w-0 break-all font-mono text-sm">{email}</dd>
        </div>
        {password ? (
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3">
            <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              Password
            </dt>
            {/* Selectable text, not a masked field: it has to be readable to be handed
                over, and it is already visible to the person who made it. */}
            <dd className="min-w-0 select-all break-all font-mono text-sm">{password}</dd>
          </div>
        ) : null}
      </dl>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <KeyRound className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          They can sign in immediately. Nothing is collected from them until they install
          an agent on a device and accept the monitoring policy on it.
        </span>
      </p>

      <DialogFooter>
        {password ? (
          <Button type="button" variant="outline" onClick={() => void copy()}>
            {copied ? (
              <Check className="h-4 w-4 text-[hsl(var(--success))]" aria-hidden />
            ) : (
              <Copy className="h-4 w-4" aria-hidden />
            )}
            {copied ? "Copied" : "Copy sign-in details"}
          </Button>
        ) : null}
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}
