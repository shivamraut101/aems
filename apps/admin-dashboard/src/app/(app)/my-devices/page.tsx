import { HydrationBoundary, dehydrate } from "@tanstack/react-query";

import { consentKey, readOwnConsent, type ConsentRow } from "@/components/me/consent";
import { currentPolicyQuery, myDevicesQuery } from "@/lib/queries/account";
import { prefetchApiQueries } from "@/lib/server-query";
import { createServerSupabase, getServerSession } from "@/lib/supabase-server";

import { MyDevicesView } from "./my-devices-view";

export const metadata = {
  title: "My devices",
};

/**
 * `/my-devices` — server component, per the rule at the top of `lib/server-query.tsx`.
 *
 * Flat, beside `/me` rather than nested under it, and the directory name is load
 * bearing: `NAV` in `lib/session.ts` publishes `/my-devices`, and `session.test.ts`
 * derives the served routes from this very tree and asserts every sidebar entry lands
 * on one. Renaming this folder without renaming that row turns the single link
 * carrying a compliance obligation into a 404 — which it briefly was.
 *
 * It does not use `PrefetchBoundary` directly because one of its three reads does not
 * come from the Fastify API: consent records are read from Supabase under the person's
 * own JWT, since no endpoint returns them (see `components/me/consent.ts` for why that
 * is legitimate rather than a shortcut). So the boundary is assembled by hand from the
 * same parts — `prefetchApiQueries` for the two specs, one raw read beside it, one
 * `HydrationBoundary` over the lot.
 *
 * `Promise.all` matters here: three round trips that each take 150ms should cost this
 * page 150ms rather than 450ms, and this is the page an employee is most likely to open
 * on a phone.
 */
export default async function MyDevicesPage() {
  const session = await getServerSession();

  const [client, consent] = await Promise.all([
    prefetchApiQueries([myDevicesQuery, currentPolicyQuery]),
    session ? readConsentForPrefetch(session.profileId) : Promise.resolve(null),
  ]);

  // Seeded only when the read actually succeeded. A null here leaves the entry absent,
  // the browser fetches it the ordinary way, and a genuine failure reaches the screen's
  // own "your consent records could not be read" notice — rather than dehydrating an
  // empty array that would render as "you have never agreed to anything".
  if (session && consent) {
    client.setQueryData(consentKey(session.profileId), consent);
  }

  return (
    <HydrationBoundary state={dehydrate(client)}>
      <MyDevicesView />
    </HydrationBoundary>
  );
}

/**
 * The server half of the consent read.
 *
 * Swallows failure into `null` — the opposite of `readOwnConsent`'s own contract, and
 * deliberately: a prefetch that throws inside `Promise.all` would take the whole page
 * render down over a secondary panel. The client retries it in the ordinary way.
 */
async function readConsentForPrefetch(profileId: string): Promise<ConsentRow[] | null> {
  try {
    const supabase = await createServerSupabase();
    return await readOwnConsent(supabase, profileId);
  } catch {
    return null;
  }
}
