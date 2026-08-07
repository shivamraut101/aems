import type { Metadata } from "next";
import Link from "next/link";

import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = {
  title: "Reset your password — AEMS",
};

/**
 * Password recovery.
 *
 * Needs SMTP configured in Supabase → Auth → Settings. Without it the page renders,
 * the request is accepted, and no mail is sent — which is why the copy promises a
 * link "if that address is registered" rather than asserting one is on its way.
 */
export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <p className="text-sm font-semibold tracking-tight">AEMS</p>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Workforce Intelligence
        </p>
      </div>

      <div className="rounded-lg border bg-card p-6">
        <h1 className="text-lg font-semibold">Reset your password</h1>
        <p className="mt-1.5 mb-5 text-sm text-muted-foreground">
          Enter your work email address and we will send you a link to set a new password.
        </p>

        <ForgotPasswordForm />
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Remembered it?{" "}
        <Link href="/login" className="underline underline-offset-4 hover:text-foreground">
          Back to sign in
        </Link>
      </p>
    </main>
  );
}
