"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@aems/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH, passwordByteLength } from "@/components/me/password";
import { createClient } from "@/lib/supabase";

/**
 * Setting a first password — no current password demanded.
 *
 * `passwordChangeSchema` in `components/me/password.ts` requires the current one,
 * which is right for a voluntary change from Account: a live session is not proof the
 * owner is at the keyboard, and an unlocked laptop should not be enough to lock them
 * out. It is wrong here. The person just signed in with the credential they are being
 * asked to replace, seconds ago, on this page — re-typing it proves nothing that the
 * sign-in did not already prove, and demanding it while offering no way past is how a
 * forced change becomes a lockout.
 */
const schema = z
  .object({
    newPassword: z
      .string()
      .min(PASSWORD_MIN_LENGTH, `Use at least ${String(PASSWORD_MIN_LENGTH)} characters`),
    confirmPassword: z.string().min(1, "Type the new password again"),
  })
  .superRefine((values, context) => {
    if (passwordByteLength(values.newPassword) > PASSWORD_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["newPassword"],
        message: `That is too long to be stored safely. Keep it under ${String(PASSWORD_MAX_BYTES)} characters.`,
      });
    }
    if (values.confirmPassword && values.confirmPassword !== values.newPassword) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmPassword"],
        message: "The two passwords do not match",
      });
    }
  });

type Values = z.infer<typeof schema>;

export function SetPasswordForm({ redirectTo = "/" }: { redirectTo?: string }) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { newPassword: "", confirmPassword: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFailure(null);
    const supabase = createClient();

    // One call, and it never touches our API. The password and the cleared flag go to
    // the identity provider together under the person's own session, so the only party
    // holding the plaintext is the account owner and Supabase.
    const updated = await supabase.auth.updateUser({
      password: values.newPassword,
      data: { must_change_password: false },
    });

    if (updated.error) {
      setFailure(
        updated.error.message.toLowerCase().includes("different")
          ? "Choose a password different from the one you were given."
          : updated.error.message,
      );
      return;
    }

    /*
     * The JWT in this browser still carries the old metadata until it is refreshed,
     * and the middleware reads the flag from exactly that token — so without this the
     * redirect below lands on `/` and is sent straight back here, forever.
     */
    await supabase.auth.refreshSession();

    router.replace(redirectTo);
    router.refresh();
  });

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-4">
      {failure !== null ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {failure}
        </p>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="new-password" className="text-sm font-medium">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          autoFocus
          aria-invalid={errors.newPassword ? true : undefined}
          aria-describedby="new-password-rules"
          className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          {...register("newPassword")}
        />
        {/* Stated above the field, never only as the reason a submission bounced —
            a rule discovered by rejection is how somebody types four variations of
            the same password. Same principle as PASSWORD_RULES in components/me. */}
        <p id="new-password-rules" className="text-xs text-muted-foreground">
          At least {PASSWORD_MIN_LENGTH} characters, and not one you use anywhere else —
          this one opens your work account.
        </p>
        {errors.newPassword ? (
          <p className="text-xs text-destructive">{errors.newPassword.message}</p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label htmlFor="confirm-password" className="text-sm font-medium">
          Type it again
        </label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.confirmPassword ? true : undefined}
          className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          {...register("confirmPassword")}
        />
        {errors.confirmPassword ? (
          <p className="text-xs text-destructive">{errors.confirmPassword.message}</p>
        ) : null}
      </div>

      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? "Saving…" : "Set password and continue"}
      </Button>
    </form>
  );
}
