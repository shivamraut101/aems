import type { FastifyPluginAsync } from "fastify";

/**
 * The monitoring policy a company is currently operating under.
 *
 * Read-only. Policies are created by migration or by an admin writing the table
 * directly; editing them from the dashboard is not in `docs/scope.md` §4 and is not
 * built here.
 *
 * **Everyone signed in may read this, employees included, and that is deliberate.**
 * The policy states the screenshot interval and the idle threshold — the terms a
 * person is being monitored under. `docs/design.md` puts "Company Policy — Active" on
 * the Android home screen for the same reason. A monitoring product that hides its own
 * policy from the people it monitors is the surveillance framing the design direction
 * rules out.
 */
export const policyRoutes: FastifyPluginAsync = async (app) => {
  app.get("/current", { preHandler: app.requireUser }, async (request) => {
    const session = request.session!;

    // Newest by `created_at` — the SAME rule `routes/devices.ts` uses when it tells an
    // enrolling agent which policy to enforce. If these two ever disagree, the settings
    // screen shows one policy while the agents run another, which in a compliance
    // product is worse than showing nothing. Changing the rule means changing both.
    const { data } = await app.supabase
      .from("policies")
      .select("*")
      .eq("company_id", session.companyId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // `null`, not 404: "this company has not published a policy" is a real answer about
    // an existing company, and the dashboard renders it as the setup prompt.
    return data ?? null;
  });
};
