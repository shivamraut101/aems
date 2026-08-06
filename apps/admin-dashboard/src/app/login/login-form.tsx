"use client";

import { Button, Field, Input } from "@aems/ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { ErrorState } from "@/components/states";
import { sessionQuery } from "@/lib/api";
import { landingPathForRole } from "@/lib/session";
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
 * Every branch names the *next move*, not just the fault. Someone locked out of the
 * first screen of the product has no navigation and no support link to fall back on,
 * so the sentence in front of them is the entire recovery path — "Invalid login
 * credentials" tells them nothing they did not already know from the form refusing.
 *
 * Credentials and unknown-account both resolve to the same sentence on purpose: a
 * message that distinguishes them is an account-enumeration oracle. That is also why
 * the advice is about typing rather than about which half was wrong.
 */
function describeAuthError(message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes("invalid login credentials") || lower.includes("invalid_credentials")) {
    return "That email and password do not match. Check for caps lock or a trailing space, then try again — your administrator can reset the password.";
  }
  if (lower.includes("email not confirmed")) {
    return "This account has not been confirmed yet. Ask your administrator to finish setting it up.";
  }
  if (lower.includes("too many") || lower.includes("rate limit")) {
    return "Too many attempts from this device. Wait a minute, then try again.";
  }
  if (lower.includes("failed to fetch") || lower.includes("network")) {
    return "Could not reach the sign-in service. Check your connection and try again.";
  }
  // Anything unrecognised is shown as it arrived. It is framed by the heading above
  // it rather than rewritten, because guessing at an unknown failure's remedy is how
  // a reader gets sent somewhere that cannot help them.
  return message;
}

/**
 * What the button is actually doing, so it can say so.
 *
 * Signing in is three waits end to end — authenticate, read the profile, load the
 * destination — and the form used to report only the first. React Hook Form's
 * `isSubmitting` goes false the instant `onSubmit` returns, which is *before* the
 * navigation it started has arrived: the button re-enabled itself, said "Sign in"
 * again, and then the page changed several seconds later. That is the exact
 * complaint, and it is a reporting bug rather than a slow one.
 */
type SignInPhase = "idle" | "opening";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const [phase, setPhase] = useState<SignInPhase>("idle");
  const [navigating, startTransition] = useTransition();

  // A password typed on a phone keyboard is the commonest cause of the credentials
  // error this form then has to explain, and this is a company-device product where
  // nobody is signing in on a train. Default hidden; the reveal is opt-in per attempt
  // and is never persisted.
  const [revealed, setRevealed] = useState(false);

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

    // The sign-in itself is done; everything below is getting the person to their
    // page. The button must keep saying so — `isSubmitting` is about to go false.
    setPhase("opening");

    // The previous occupant of this browser tab may have left cached queries behind.
    queryClient.clear();

    // Where "/" actually leads depends on the role. "/" is the manager Overview, and
    // an employee sent there met "You do not have access to this" as the very first
    // screen after signing in — the product's own front door refusing them.
    //
    // The root layout would now redirect them anyway, but that costs a wasted render
    // of a page they cannot read plus a second round trip. Asking here means an
    // employee is sent straight to /me, and it seeds the query cache besides, so the
    // destination's shell reads the session rather than requesting it again.
    let destination = next;
    try {
      const session = await queryClient.fetchQuery(sessionQuery);
      if (next === "/" && session) destination = landingPathForRole(session.role);
    } catch {
      // Sign-in succeeded and only the profile lookup failed. Continuing to the
      // default is better than stranding someone on a login form that just worked;
      // the shell reports the missing profile properly.
    }

    // One navigation, inside a transition, and deliberately no `router.refresh()`.
    //
    // Refreshing looks right — the root layout was rendered for a signed-out request
    // — and it is the trap. It re-renders the route being left, which is /login, and
    // middleware bounces an authenticated request off /login with a redirect; the
    // transition then waits on a round trip that exists only to be thrown away.
    // Measured on warm routes it roughly doubled the wait, and on sign-out the
    // equivalent call stalled the navigation outright.
    //
    // Nothing is left stale by skipping it. The destination is a different segment
    // and is fetched fresh, and the shell reads the session from the query cache the
    // `fetchQuery` above just filled — which is why that call is worth its round trip
    // and this one is not.
    //
    // The transition is what keeps `navigating` true until the destination is on
    // screen, so the button cannot go idle in front of a page that has not arrived.
    startTransition(() => {
      // replace(), not push(): the login page must not sit in history behind the
      // app, where Back would land on it while signed in and bounce straight out.
      router.replace(destination);
    });
  }

  const opening = phase === "opening" || navigating;
  const busy = isSubmitting || opening;

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-5 space-y-4">
      {/* The shared error surface rather than a bespoke one. The heading states what
          failed and the body states the move — a form has no "try again" button to
          offer because the submit below already is one. */}
      {formError ? <ErrorState title="Could not sign in" message={formError} /> : null}

      {/* `Field` owns the label/description/invalid wiring, so it cannot be forgotten
          on the one form in the product that is used by every single employee. */}
      <Field label="Work email" error={errors.email?.message}>
        {(field) => (
          <Input
            {...field}
            {...register("email")}
            type="email"
            autoComplete="username"
            autoFocus
            spellCheck={false}
            placeholder="name@company.com"
          />
        )}
      </Field>

      <Field label="Password" error={errors.password?.message}>
        {(field) => (
          <div className="relative">
            <Input
              {...field}
              {...register("password")}
              type={revealed ? "text" : "password"}
              autoComplete="current-password"
              // Room for the reveal control, so a long password never runs under it.
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setRevealed((current) => !current)}
              // The label carries the state, so the control does not need a second
              // announcement channel to say the same thing twice.
              aria-label={revealed ? "Hide password" : "Show password"}
              className="absolute right-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {revealed ? (
                <EyeOff className="h-4 w-4" aria-hidden />
              ) : (
                <Eye className="h-4 w-4" aria-hidden />
              )}
            </button>
          </div>
        )}
      </Field>

      {/* One busy state spanning all three waits. It clears when the destination
          renders and this form unmounts — never before.

          `lg` for 40px rather than the default 36: this is the single control on the
          first screen of the product, and it is hit with a thumb as often as a mouse. */}
      <Button type="submit" size="lg" disabled={busy} className="w-full">
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {opening ? "Opening your workspace" : "Signing in"}
          </>
        ) : (
          "Sign in"
        )}
      </Button>
    </form>
  );
}
