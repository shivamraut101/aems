/**
 * The rules a new password has to satisfy, and the words a refusal is reported in.
 *
 * The Zod schema is the single source of validation truth (CLAUDE.md), so the form
 * derives its types from it and the rules are asserted here rather than being trusted
 * to match the sentences printed above the field.
 *
 * ## Why the change never touches our API
 *
 * `apps/api` holds the service-role key. Routing a password through it would mean the
 * server reading, logging-adjacent to, and being trusted with a plaintext credential it
 * has no reason to see — and it would need a second privileged endpoint that can set
 * anyone's password, which is a far worse thing to own than the feature is worth. The
 * browser calls Supabase Auth's `updateUser` under the person's own session instead:
 * the only party that ever holds the plaintext is the account owner and their identity
 * provider.
 *
 * ## Why the current password is demanded first
 *
 * A live session is not proof that the account's owner is at the keyboard — an unlocked
 * laptop is enough. Re-authenticating with `signInWithPassword` before `updateUser`
 * makes an unattended screen insufficient to change the credential and lock the owner
 * out. It also matches what every other product does, so nobody has to be taught it.
 */

import { z } from "zod";

/** Matches `createSchema.temporaryPassword` in `apps/api/src/routes/employees.ts`. */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * bcrypt's hard limit, counted in **bytes** rather than characters.
 *
 * Everything past the 72nd byte is silently discarded by the hash, which makes a longer
 * password quietly no stronger than its first 72 bytes. The API's own schema says
 * `.max(72)`, which Zod counts in code points — so an accented or non-Latin password of
 * 72 characters passes there and is truncated by the hash anyway. Counting bytes is the
 * stricter and the correct reading, and it is why this is not just `.max(72)`.
 */
export const PASSWORD_MAX_BYTES = 72;

/**
 * Stated **above** the field, never as the reason a submission bounced.
 *
 * Rules discovered by rejection are the reason people end up typing four variations of
 * the same password; a person cannot satisfy a constraint they were not shown.
 */
export const PASSWORD_RULES: readonly string[] = [
  `At least ${String(PASSWORD_MIN_LENGTH)} characters.`,
  "Different from your current password.",
  "Not a password you use anywhere else — this one opens your work account.",
];

/** UTF-8 length, which is what the hash measures. */
export function passwordByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The change, as a form.
 *
 * `superRefine` rather than `refine` so each failure is attached to the field that
 * caused it — a "does not match" error floating above the form instead of under the
 * confirmation box is how people end up re-reading the field they typed correctly.
 */
export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
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
        message: `That is too long to be stored safely. Keep it under ${String(PASSWORD_MAX_BYTES)} bytes — about ${String(PASSWORD_MAX_BYTES)} plain characters.`,
      });
    }

    if (values.newPassword && values.newPassword === values.currentPassword) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["newPassword"],
        message: "Choose a password you are not already using",
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

export type PasswordChangeValues = z.infer<typeof passwordChangeSchema>;

/**
 * Which of the two calls failed, because they fail for different reasons and the person
 * can only fix one of them.
 */
export type PasswordStep = "reauthenticate" | "update";

/**
 * Supabase Auth's wording, turned into a sentence that names what to do next.
 *
 * A wrong *current* password is reported as a wrong current password and nothing else:
 * this is the account's own owner, already signed in, so there is no enumeration
 * concern to hedge against here the way the sign-in form has to.
 */
export function describePasswordFailure(step: PasswordStep, message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes("too many") || lower.includes("rate limit")) {
    return "Too many attempts. Wait a minute and try again.";
  }
  if (lower.includes("failed to fetch") || lower.includes("network")) {
    return "Could not reach the sign-in service. Check your connection and try again.";
  }

  if (step === "reauthenticate") {
    if (lower.includes("invalid login credentials") || lower.includes("invalid_credentials")) {
      return "That is not your current password.";
    }
    return "We could not confirm your current password. Try again.";
  }

  if (lower.includes("should be different") || lower.includes("same as the old")) {
    return "Choose a password you are not already using.";
  }
  if (lower.includes("password should be at least") || lower.includes("weak")) {
    return message;
  }
  if (lower.includes("session") || lower.includes("jwt")) {
    return "Your session expired while you were typing. Sign in again, then change it.";
  }

  return "Your password could not be changed. Try again in a moment.";
}

/** What actually changed, said plainly, so nobody wonders whether it took. */
export const PASSWORD_CHANGED_MESSAGE =
  "Your password is changed. Use the new one the next time you sign in.";
