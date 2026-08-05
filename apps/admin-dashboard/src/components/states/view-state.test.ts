import { describe, expect, it } from "vitest";

import { queryViewState, resolveViewState } from "./view-state";

describe("resolveViewState", () => {
  it("is loading only on a first load with nothing in hand", () => {
    expect(resolveViewState({ isLoading: true, isError: false, hasData: false })).toBe("loading");
  });

  it("is not loading when data resolved from cache", () => {
    // The bug this guards: TanStack reports `isFetching` for a background refresh of
    // data that is already on screen. Rendering a skeleton for that throws away a
    // table the reader is looking at.
    expect(resolveViewState({ isLoading: false, isError: false, hasData: true })).toBe("ready");
  });

  it("is error when the request failed and nothing had landed", () => {
    expect(resolveViewState({ isLoading: false, isError: true, hasData: false })).toBe("error");
  });

  it("is stale — not error — when a refetch fails over data already shown", () => {
    expect(resolveViewState({ isLoading: false, isError: true, hasData: true })).toBe("stale");
  });

  it("prefers error over loading while a failed query is retrying", () => {
    expect(resolveViewState({ isLoading: true, isError: true, hasData: false })).toBe("error");
  });

  it("is empty for a settled query with no rows", () => {
    expect(resolveViewState({ isLoading: false, isError: false, hasData: true, isEmpty: true })).toBe(
      "empty",
    );
  });

  it("is empty — never a permanent skeleton — for a disabled query", () => {
    // `enabled: false` leaves a query with no data and no fetch in flight.
    expect(resolveViewState({ isLoading: false, isError: false, hasData: false })).toBe("empty");
  });

  it("does not call a resolved-but-empty result ready", () => {
    expect(resolveViewState({ isLoading: false, isError: false, hasData: true, isEmpty: false })).toBe(
      "ready",
    );
  });
});

describe("queryViewState", () => {
  it("maps a pending query to loading", () => {
    expect(queryViewState({ data: undefined, isLoading: true, isError: false })).toBe("loading");
  });

  it("maps a resolved empty list to empty", () => {
    expect(
      queryViewState({ data: [] as number[], isLoading: false, isError: false }, (rows) => rows.length === 0),
    ).toBe("empty");
  });

  it("maps a resolved non-empty list to ready", () => {
    expect(
      queryViewState({ data: [1], isLoading: false, isError: false }, (rows) => rows.length === 0),
    ).toBe("ready");
  });

  it("never runs the emptiness predicate before data exists", () => {
    let called = false;
    const state = queryViewState<number[]>({ data: undefined, isLoading: true, isError: false }, () => {
      called = true;
      return true;
    });

    expect(state).toBe("loading");
    expect(called).toBe(false);
  });

  it("keeps placeholder data on screen when the next fetch fails", () => {
    expect(queryViewState({ data: [1], isLoading: false, isError: true })).toBe("stale");
  });
});

/**
 * The rule the client complained about, stated as tests.
 *
 *   "before loading anything you should know what should be loaded. I don't want that
 *    something is loaded on a flash scale and after that the real things get loaded."
 *
 * A page whose data was prefetched on the server hydrates with the answer already in
 * the cache. Drawing a skeleton over that is the flash — the reader sees grey bars for
 * one frame and then the content that was in the HTML all along.
 */
describe("hydrated and cached data never draws a skeleton", () => {
  /** What TanStack hands a component after `HydrationBoundary` seeds its key. */
  const hydrated = { data: [{ id: "a" }], isLoading: false, isError: false };

  it("reports ready on the very first render of a server-prefetched page", () => {
    expect(queryViewState(hydrated)).toBe("ready");
  });

  it("stays ready through the background refetch that follows hydration", () => {
    // `staleTime` elapses and TanStack refetches. `isFetching` goes true; `isLoading`
    // does not, because v5 defines it as `isPending && isFetching`. Any state machine
    // keyed off fetching instead would blank the page every refresh interval.
    expect(queryViewState({ ...hydrated, isLoading: false })).toBe("ready");
  });

  it("cannot be talked into a skeleton by a caller that mis-wires the flag", () => {
    // The structural guarantee: `loading` requires *no data*. Even a caller that
    // passes `isPending` into the `isLoading` slot — the commonest mistake, since v5
    // exposes both — gets `ready` while something is on screen.
    expect(queryViewState({ ...hydrated, isLoading: true })).toBe("ready");
    expect(resolveViewState({ isLoading: true, isError: false, hasData: true })).toBe("ready");
  });

  it("reports empty, not loading, for a prefetch that legitimately found nothing", () => {
    expect(queryViewState({ data: [], isLoading: false, isError: false }, (rows) => rows.length === 0)).toBe(
      "empty",
    );
  });

  it("still draws the skeleton when the server prefetch failed and cached nothing", () => {
    // The deliberate other half: a failed prefetch stores no entry, so the browser
    // starts the query from scratch and a skeleton is the honest answer. Dehydrating
    // an empty result instead would render an outage as "no data" forever.
    expect(queryViewState({ data: undefined, isLoading: true, isError: false })).toBe("loading");
  });
});
