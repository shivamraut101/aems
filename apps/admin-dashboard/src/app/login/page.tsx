import type { Metadata } from "next";

import { safeNextPath } from "@/lib/session";

import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in — AEMS",
};

/**
 * Sign-in.
 *
 * Restrained on purpose. This is the first screen anyone sees, and docs/design.md
 * asks for enterprise trust rather than a marketing moment: navy, Inter, thin
 * borders, one card, no gradient. Indigo is absent — it is reserved for AI surfaces,
 * and a login form is not one.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params["next"];
  const next = safeNextPath(Array.isArray(raw) ? raw[0] : raw);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <span
            className="grid h-8 w-8 place-items-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
            aria-hidden
          >
            A
          </span>
          <span className="text-sm font-semibold tracking-tight">AEMS</span>
        </div>

        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Workforce intelligence for company-owned devices.
        </p>

        <LoginForm next={next} />

        <p className="mt-8 border-t pt-4 text-xs leading-relaxed text-muted-foreground">
          Accounts are created by your administrator. Monitoring only ever runs on
          enrolled company devices, with a consent record on file.
        </p>
      </div>
    </main>
  );
}
