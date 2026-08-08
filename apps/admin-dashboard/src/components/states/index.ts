/**
 * Loading / empty / error, once, for the whole dashboard.
 *
 * Every screen used to invent its own three: a bare `<p>` for a failed request with
 * no way to retry it, a grey box a third the height of the table it replaced, an
 * empty state indistinguishable from a still-loading one. These are the shared
 * versions. `view-state.ts` decides *which* of them a query result calls for.
 *
 *   import { ErrorState, TableSkeleton, queryViewState } from "@/components/states";
 */

export {
  CollectionOff,
  DegradedNotice,
  EmptyState,
  ErrorState,
  StaleNotice,
  type CollectionOffType,
  type DegradedSource,
} from "./feedback";
export {
  FilterBarSkeleton,
  ListSkeleton,
  PanelSkeleton,
  SkeletonBar,
  SkeletonLines,
  StatGridSkeleton,
  TableSkeleton,
  TableSkeletonRows,
  type SkeletonColumn,
} from "./skeletons";
export {
  queryViewState,
  resolveViewState,
  type QueryLike,
  type ViewState,
  type ViewStateInput,
} from "./view-state";
