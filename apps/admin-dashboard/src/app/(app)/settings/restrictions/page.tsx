import { RESTRICTION_QUERIES } from "@/lib/queries/restrictions";
import { PrefetchBoundary } from "@/lib/server-query";

import { RestrictionsView } from "./restrictions-view";

/**
 * Website access — the restriction surface the client asked for on 2026-08-05.
 *
 * A **server** component, per the rule at the top of `lib/server-query.tsx`. Both reads
 * — the policy and the recent refusals — are warmed here in parallel, so the rule table
 * is in the first paint rather than being a skeleton that swaps.
 *
 * A failed prefetch caches nothing, which matters more here than anywhere else on this
 * screen: until the API's `/api/restrictions` routes land, `serverApiQuery` throws, the
 * entry stays absent, and the client fetches and reports the real refusal. What it must
 * never do is dehydrate an empty policy — "no rules" and "we could not ask" are
 * opposite facts on a page about what employees can reach.
 */
export default function RestrictionsPage() {
  return (
    <PrefetchBoundary queries={RESTRICTION_QUERIES}>
      <RestrictionsView />
    </PrefetchBoundary>
  );
}
