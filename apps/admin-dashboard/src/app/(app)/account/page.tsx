import { accountQuery } from "@/lib/queries/account";
import { PrefetchBoundary } from "@/lib/server-query";
import { getServerSession } from "@/lib/supabase-server";

import { AccountView } from "./account-view";

export const metadata = {
  title: "Account",
};

/**
 * `/account` — server component, per the rule at the top of `lib/server-query.tsx`.
 *
 * The subject is the session's own profile id, resolved here rather than in the
 * browser, so the profile is in the cache before the view's first render and the page
 * paints a name instead of a skeleton that swaps into one.
 *
 * Reading the session first costs nothing: `getServerSession` is wrapped in React's
 * `cache` and the root layout has already called it for this same request.
 *
 * With no session there is nothing to warm and middleware is already redirecting; the
 * view renders its signed-out path rather than this file guessing at one.
 */
export default async function AccountPage() {
  const session = await getServerSession();

  if (!session) return <AccountView />;

  return (
    <PrefetchBoundary queries={[accountQuery(session.profileId)]}>
      <AccountView />
    </PrefetchBoundary>
  );
}
