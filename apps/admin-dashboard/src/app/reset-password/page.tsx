import type { Metadata } from "next";

import { SetPasswordForm } from "../set-password/set-password-form";

export const metadata: Metadata = {
  title: "Set a new password — AEMS",
};

/**
 * Where the recovery email lands.
 *
 * Public, because Supabase puts the recovery session in the URL *fragment* — which the
 * browser never sends to a server, so the middleware cannot see it and would bounce
 * the link straight to /login. The client library reads the fragment on mount and
 * establishes the session before the form submits.
 *
 * Reuses `SetPasswordForm` rather than owning a second one. It makes the same single
 * `updateUser` call, which also clears `must_change_password` — so a new employee who
 * ignored their temporary password and used this link instead is not asked to change
 * it a second time on their way in.
 */
export default function ResetPasswordPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <p className="text-sm font-semibold tracking-tight">AEMS</p>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Workforce Intelligence
        </p>
      </div>

      <div className="rounded-lg border bg-card p-6">
        <h1 className="text-lg font-semibold">Set a new password</h1>
        <p className="mt-1.5 mb-5 text-sm text-muted-foreground">
          Choose a password only you know. You will be signed in once it is saved.
        </p>

        <SetPasswordForm />
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        This link works once and expires an hour after it was sent. If it has expired,
        request another from the sign-in page.
      </p>
    </main>
  );
}
