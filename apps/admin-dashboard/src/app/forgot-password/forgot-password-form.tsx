"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@aems/ui";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { createClient } from "@/lib/supabase";

const schema = z.object({
  email: z.string().min(1, "Enter your work email address").email("That is not an email address"),
});

type Values = z.infer<typeof schema>;

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "" } });

  const onSubmit = handleSubmit(async (values) => {
    const supabase = createClient();

    await supabase.auth.resetPasswordForEmail(values.email, {
      redirectTo: `${globalThis.location.origin}/reset-password`,
    });

    /*
     * The same answer whether or not that address exists, and the error is swallowed
     * on purpose.
     *
     * "No account with that email" is an account-enumeration oracle, and on a
     * workforce-monitoring product it tells an attacker who works at the company —
     * which is worth more to them than most passwords. A rate-limit refusal is
     * indistinguishable from success here for the same reason: reporting it would
     * confirm the address had been tried.
     */
    setSent(true);
  });

  if (sent) {
    return (
      <p role="status" className="rounded-md border border-success/40 bg-success/10 px-3 py-2.5 text-sm">
        If that address belongs to an AEMS account, a link to set a new password is on its
        way. It expires in an hour — check your spam folder if it has not arrived in a few
        minutes.
      </p>
    );
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="email" className="text-sm font-medium">
          Work email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          autoFocus
          aria-invalid={errors.email ? true : undefined}
          className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          {...register("email")}
        />
        {errors.email ? <p className="text-xs text-destructive">{errors.email.message}</p> : null}
      </div>

      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? "Sending…" : "Send the link"}
      </Button>
    </form>
  );
}
