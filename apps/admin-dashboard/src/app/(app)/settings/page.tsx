import { SETTINGS_QUERIES } from "@/lib/queries/settings-specs";
import { PrefetchBoundary } from "@/lib/server-query";

import { SettingsView } from "./settings-view";

/**
 * Company configuration, `docs/scope.md` §4.2.
 *
 * A **server** component with no markup of its own — the two-file page shape described
 * at the top of `lib/server-query.tsx`. The four reads this screen makes are resolved
 * here, in parallel, and dehydrated into the HTML, so `SettingsView` renders the policy,
 * the rules and the roster in its first paint instead of painting four skeletons and
 * swapping them out a moment later.
 *
 * Nothing on this page is keyed on the browser's clock or on a filter the reader has not
 * chosen yet, which is what makes every one of them safe to prefetch.
 */
export default function SettingsPage() {
  return (
    <PrefetchBoundary queries={SETTINGS_QUERIES}>
      <SettingsView />
    </PrefetchBoundary>
  );
}
