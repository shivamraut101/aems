import { PrefetchBoundary } from "@/lib/server-query";

import { DevicesView } from "./devices-view";
import { devicesQuery, employeesQuery } from "./queries";

/**
 * Device inventory, `docs/scope.md` §7 — server half.
 *
 * Both reads are warmed here, in parallel, so the table is populated in the first
 * paint. They are genuinely two requests: `/api/devices` carries only `profile_id`, and
 * the roster is what turns that into "Ada Lovelace" rather than a uuid. Prefetching one
 * and not the other would leave the owner column filling in a beat after the rest of
 * the row, which is the flash in miniature.
 *
 * The third read on this page — latest battery, network and free storage — is
 * deliberately **not** here. It goes to Supabase from the browser under the reader's own
 * JWT, and its key depends on the device ids the first query returns, so there is
 * nothing to warm until that has answered. Rule 2 in `lib/server-query.tsx`: a query the
 * server cannot key is left to the client, where its loading state is honest.
 */
export default function DevicesPage() {
  return (
    <PrefetchBoundary queries={[devicesQuery, employeesQuery]}>
      <DevicesView />
    </PrefetchBoundary>
  );
}
