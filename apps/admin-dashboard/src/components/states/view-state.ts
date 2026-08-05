/**
 * Which of loading / error / stale / empty / ready a screen should render.
 *
 * Pure, and deliberately free of React so it can be tested in the default node
 * environment. The rules it encodes are the ones a hand-written ternary chain kept
 * getting wrong:
 *
 *  - **A failure with data already on screen is not the same as a failure with
 *    nothing.** Replacing a rendered table with a red box because a background
 *    refetch lost the network is worse than leaving the table up and saying it is
 *    stale. That is `"stale"`.
 *  - **A query that resolved from cache is not loading.** TanStack v5 sets
 *    `isLoading = isPending && isFetching`, so a cache hit — or a query holding
 *    `placeholderData` — never reports it. Keying off `isFetching` instead is how
 *    the Activity timeline flashed a skeleton every sixty seconds.
 *  - **Empty is not loading.** A disabled query has no data and is not fetching;
 *    that is `"empty"`, not a spinner that never resolves.
 */

export type ViewState = "loading" | "error" | "stale" | "empty" | "ready";

export interface ViewStateInput {
  /** First load only — no data has ever landed for this key. */
  isLoading: boolean;
  isError: boolean;
  /** Something renderable is in hand, even if it is stale or a placeholder. */
  hasData: boolean;
  /** The data resolved but holds nothing worth drawing. */
  isEmpty?: boolean;
}

export function resolveViewState(input: ViewStateInput): ViewState {
  // Error first: a failed query with previous data still has something to show, and
  // a failed query without it has nothing else to say.
  if (input.isError) return input.hasData ? "stale" : "error";
  if (!input.hasData) return input.isLoading ? "loading" : "empty";
  return input.isEmpty === true ? "empty" : "ready";
}

/** The slice of a TanStack query result this module needs. */
export interface QueryLike<T> {
  data?: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * {@link resolveViewState} against a query result.
 *
 * `isEmpty` is a predicate over the *data* rather than a boolean, so a caller cannot
 * accidentally evaluate `rows.length === 0` while `rows` is still undefined and get
 * "empty" for a query that has not answered yet.
 */
export function queryViewState<T>(query: QueryLike<T>, isEmpty?: (data: T) => boolean): ViewState {
  const hasData = query.data !== undefined && query.data !== null;

  return resolveViewState({
    isLoading: query.isLoading,
    isError: query.isError,
    hasData,
    ...(hasData && isEmpty ? { isEmpty: isEmpty(query.data as T) } : {}),
  });
}
