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
