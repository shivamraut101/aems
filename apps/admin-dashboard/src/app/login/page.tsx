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
 *
 * The lockup, the card and the copy are all doing one job: telling a reader what this
 * is before asking them for a password. Three things sit outside the card on purpose —
 * the brand above it, the trust note below it — so the card holds only what is being
 * asked for and the page reads top to bottom as "who we are / what to enter / what we
 * do with it".
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
    /*
     * `min-h-svh`, not `min-h-screen`. On a phone `100vh` is the viewport *with* the
     * browser chrome collapsed, so a centred block is laid out against a height the
     * page does not have on first paint and then visibly drops when the URL bar
     * retracts. The small-viewport unit is the height that is true immediately.
     */
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-10 sm:px-6 sm:py-12">
      <div className="w-full max-w-sm">
        {/* The same lockup as the sidebar, down to the tracking. A product whose front
            door and whose interior introduce themselves differently reads as two
            products, and this is the one screen every employee sees first. */}
        <div className="mb-6 flex items-center gap-2.5">
          <span
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary text-[13px] font-semibold tracking-tight text-primary-foreground"
            aria-hidden
          >
            A
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold leading-tight tracking-tight">AEMS</span>
            <span className="block whitespace-nowrap text-[10px] uppercase tracking-[0.07em] text-muted-foreground">
              Workforce intelligence
            </span>
          </span>
        </div>

        <div className="rounded-lg border bg-card p-5 shadow-[var(--shadow-sm)] sm:p-6">
          <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
          {/* What to type, rather than a restatement of the product. Nobody arrives
              here unsure what the page is for; they arrive unsure which of their two
              email addresses was enrolled. */}
          <p className="mt-1 text-sm text-muted-foreground">
            Use the work email your administrator enrolled.
          </p>

          <LoginForm next={next} />
        </div>

        {/* The compliance promise, stated before credentials are handed over rather
            than buried in a settings page. The third sentence is non-negotiable #3 —
            an employee can read their own record — and saying so here is the
            difference between the framing docs/design.md asks for and the one it
            rules out. */}
        <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
          Accounts are created by your administrator. Monitoring runs only on enrolled
          company devices, with a consent record on file. You can always read your own
          activity.
        </p>
      </div>
    </main>
  );
}
