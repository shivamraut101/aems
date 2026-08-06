"use client";

import { Button, Input, Label } from "@aems/ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Check, Loader2, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";

import { createClient } from "@/lib/supabase";

import { MePanel } from "./me-shell";
import {
  PASSWORD_CHANGED_MESSAGE,
  PASSWORD_RULES,
  describePasswordFailure,
  passwordChangeSchema,
  type PasswordChangeValues,
} from "./password";

/**
 * Changing your own password.
 *
 * Nothing in this product could change a password before this form existed. A new
 * employee was given a temporary one by an administrator — `newTemporaryPassword()`
 * generates it, the create response shows it exactly once, and it is never stored — and
 * then had no way to replace it. That is not a missing convenience: it means every
 * account in the company is running on a credential a second person has seen.
 *
 * ## The two calls, and why in this order
 *
 * 1. `signInWithPassword` with the **current** password. A live session proves a
 *    browser is signed in, not that the account's owner is at the keyboard, so without
 *    this an unlocked laptop is enough for a passer-by to lock its owner out.
 * 2. `updateUser({ password })` on the session that call just refreshed.
 *
 * Both go straight from the browser to Supabase Auth. The Fastify API is never
 * involved, and that is the point: it holds the service-role key, so routing a
 * plaintext password through it would mean the server handling a credential it has no
 * reason to see, over an endpoint that by construction could set anybody's password.
 *
 * A failed step 1 does not disturb the existing session — Supabase leaves it alone on a
 * rejected sign-in — so a mistyped current password costs nothing but the message.
 */
export function ChangePasswordPanel({ email }: { email: string }) {
  const [status, setStatus] = useState<"idle" | "changed">("idle");
  const [formError, setFormError] = useState<string | null>(null);

  const currentId = useId();
  const newId = useId();
  const confirmId = useId();
  const rulesId = useId();
  const errorId = useId();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PasswordChangeValues>({
    resolver: zodResolver(passwordChangeSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  async function onSubmit(values: PasswordChangeValues) {
    setFormError(null);
    setStatus("idle");

    let supabase;
    try {
      supabase = createClient();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Sign-in is not configured.");
      return;
    }

    const reauth = await supabase.auth.signInWithPassword({
      email,
      password: values.currentPassword,
    });

    if (reauth.error) {
      setFormError(describePasswordFailure("reauthenticate", reauth.error.message));
      return;
    }

    const updated = await supabase.auth.updateUser({ password: values.newPassword });

    if (updated.error) {
      setFormError(describePasswordFailure("update", updated.error.message));
      return;
    }

    // Clear the fields before reporting success: three filled password boxes sitting
    // under "your password is changed" invite a second submission of a value that is no
    // longer current.
    reset();
    setStatus("changed");
  }

  return (
    <MePanel
      title="Password"
      description="Change the password you sign in with. It is not shared with anyone, including your administrator."
    >
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="max-w-md space-y-4">
        {/* The username field exists for password managers, which need to know which
            account the new credential belongs to. Hidden from sight, not from them. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={email}
          readOnly
          aria-hidden
          tabIndex={-1}
          className="sr-only"
        />

        <div className="space-y-1.5">
          <Label htmlFor={currentId}>Current password</Label>
          <Input
            id={currentId}
            type="password"
            autoComplete="current-password"
            aria-invalid={errors.currentPassword ? true : undefined}
            aria-describedby={errors.currentPassword ? `${currentId}-error` : undefined}
            {...register("currentPassword")}
          />
          {errors.currentPassword ? (
            <p id={`${currentId}-error`} className="text-xs text-destructive">
              {errors.currentPassword.message}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={newId}>New password</Label>
          {/* Stated before the field. Rules a person only meets as a rejection are the
              reason people end up typing four variations of the same password. */}
          <ul id={rulesId} className="space-y-0.5 text-xs text-muted-foreground">
            {PASSWORD_RULES.map((rule) => (
              <li key={rule} className="flex items-start gap-1.5">
                <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                {rule}
              </li>
            ))}
          </ul>
          <Input
            id={newId}
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.newPassword ? true : undefined}
            aria-describedby={errors.newPassword ? `${newId}-error` : rulesId}
            {...register("newPassword")}
          />
          {errors.newPassword ? (
            <p id={`${newId}-error`} className="text-xs text-destructive">
              {errors.newPassword.message}
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={confirmId}>New password again</Label>
          <Input
            id={confirmId}
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.confirmPassword ? true : undefined}
            aria-describedby={errors.confirmPassword ? `${confirmId}-error` : undefined}
            {...register("confirmPassword")}
          />
          {errors.confirmPassword ? (
            <p id={`${confirmId}-error`} className="text-xs text-destructive">
              {errors.confirmPassword.message}
            </p>
          ) : null}
        </div>

        {/*
         * The outcome sits above the button rather than at the top of the form.
         *
         * `role="alert"` and `role="status"` announce it either way, but a sighted
         * person on a phone has just scrolled to the bottom to tap Change password —
         * and a message three fields above the fold is one they never see. They then
         * type the whole thing again.
         */}
        {formError ? (
          <p
            id={errorId}
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive-muted px-3 py-2 text-sm"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <span className="min-w-0">{formError}</span>
          </p>
        ) : null}

        {status === "changed" ? (
          <p
            role="status"
            className="flex items-start gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm"
          >
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
            <span className="min-w-0">{PASSWORD_CHANGED_MESSAGE}</span>
          </p>
        ) : null}

        <Button type="submit" disabled={isSubmitting} className="w-full sm:w-auto">
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Changing password
            </>
          ) : (
            "Change password"
          )}
        </Button>
      </form>
    </MePanel>
  );
}
