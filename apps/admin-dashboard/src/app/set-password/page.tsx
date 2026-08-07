import type { Metadata } from "next";

import { SetPasswordForm } from "./set-password-form";

export const metadata: Metadata = {
  title: "Set your password — AEMS",
};

/**
 * The first thing somebody sees after signing in with a password an admin read out.
 *
 * Outside `(app)` on purpose: no sidebar, no navigation, nothing to click past. The
 * page is a gate, and offering the product's chrome around it would suggest the step
 * is optional when the middleware will send them straight back.
 *
 * Says why rather than just what. "Set a password" with no reason reads as a hoop;
 * "the one you were given was read out to you by someone else" is a fact the reader
 * can check against their own memory of how they got here, and it makes the two
 * minutes obviously worth spending.
 */
export default function SetPasswordPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <p className="text-sm font-semibold tracking-tight">AEMS</p>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Workforce Intelligence
        </p>
      </div>

      <div className="rounded-lg border bg-card p-6">
        <h1 className="text-lg font-semibold">Choose your own password</h1>
        <p className="mt-1.5 mb-5 text-sm text-muted-foreground">
          The password you signed in with was created for you and shared with you by
          someone else, so it is not private. Pick one only you know before you carry on.
        </p>

        <SetPasswordForm />
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Nobody at your company can see this password, including whoever set up your
        account.
      </p>
    </main>
  );
}
