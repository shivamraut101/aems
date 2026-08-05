/**
 * Next's Suspense fallback for this segment.
 *
 * The shape comes from `RouteSkeleton`, which the app shell also renders the moment a
 * nav link is clicked. One source for both means the skeleton drawn on the click and
 * the one Next draws on the commit are the same pixels — the handover is invisible.
 */
import { RouteSkeleton } from "@/components/states/page-loading";

export default function Loading() {
  return <RouteSkeleton path="/me" />;
}
