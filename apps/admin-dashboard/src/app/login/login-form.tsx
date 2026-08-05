"use client";

import { Button } from "@aems/ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { createClient } from "@/lib/supabase";

/**
 * The Zod schema is the single source of validation truth; the form's types are
 * derived from it rather than declared twice.
 *
 * Sign-in deliberately does not enforce password *rules* — length or character
 * requirements here only tell an attacker what shape to guess, and the real rules
 * live wherever the account was created.
 */
const signInSchema = z.object({
  email: z.string().min(1, "Enter your work email").email("That does not look like an email"),
  password: z.string().min(1, "Enter your password"),
});

type SignInValues = z.infer<typeof signInSchema>;

/**
 * Turns a Supabase auth failure into something the person can act on.
 *
 * Credentials and unknown-account both resolve to the same sentence on purpose: a
 * message that distinguishes them is an account-enumeration oracle.
 */
function describeAuthError(message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes("invalid login credentials") || lower.includes("invalid_credentials")) {
    return "That email and password do not match.";
  }
  if (lower.includes("email not confirmed")) {
    return "This account has not been confirmed yet. Ask your administrator.";
  }
  if (lower.includes("too many") || lower.includes("rate limit")) {
    return "Too many attempts. Wait a minute and try again.";
  }
  if (lower.includes("failed to fetch") || lower.includes("network")) {
    return "Could not reach the sign-in service. Check your connection.";
  }
  return message;
}

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);

  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: SignInValues) {
    setFormError(null);

    let supabase;
    try {
      supabase = createClient();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Sign-in is not configured.");
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: values.email,
      password: values.password,
    });

    if (error) {
      setFormError(describeAuthError(error.message));
      return;
    }

    // The previous occupant of this browser tab may have left cached queries behind.
    queryClient.clear();

    // replace(), not push(): the login page must not sit in history behind the app,
    // where Back would land on it while signed in and bounce straight out again.
    router.replace(next);
    // The session now lives in cookies; make the server re-render with it.
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-6 space-y-4">
      {formError ? (
        <div
          id={errorId}
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{formError}</span>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor={emailId} className="block text-sm font-medium">
          Work email
        </label>
        <input
          id={emailId}
          type="email"
          autoComplete="username"
          autoFocus
          spellCheck={false}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? `${emailId}-error` : undefined}
          className={fieldClass(Boolean(errors.email))}
          {...register("email")}
        />
        {errors.email ? (
          <p id={`${emailId}-error`} className="text-xs text-destructive">
            {errors.email.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label htmlFor={passwordId} className="block text-sm font-medium">
          Password
        </label>
        <input
          id={passwordId}
          type="password"
          autoComplete="current-password"
          aria-invalid={errors.password ? true : undefined}
          aria-describedby={errors.password ? `${passwordId}-error` : undefined}
          className={fieldClass(Boolean(errors.password))}
          {...register("password")}
        />
        {errors.password ? (
          <p id={`${passwordId}-error`} className="text-xs text-destructive">
            {errors.password.message}
          </p>
        ) : null}
      </div>

      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Signing in
          </>
        ) : (
          "Sign in"
        )}
      </Button>
    </form>
  );
}

function fieldClass(invalid: boolean): string {
  return [
    "h-9 w-full rounded-md border bg-card px-3 text-sm shadow-sm",
    "placeholder:text-muted-foreground",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    "disabled:cursor-not-allowed disabled:opacity-50",
    invalid ? "border-destructive" : "border-input",
  ].join(" ");
}
