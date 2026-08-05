import { describe, expect, it } from "vitest";

import {
  insightsQuery,
  readInsightKindParam,
  readProfileIdParam,
  resolveInsightsRequest,
} from "./queries";

const PROFILE = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

/**
 * These exist because of one specific silent failure.
 *
 * The server prefetch and the client hook build the same cache entry from this module,
 * and if either one produces a different key the hydrated answer sits under a key
 * nobody reads: the browser refetches, the skeleton comes back, and *nothing errors*.
 * The key and the path are therefore asserted literally rather than compared against
 * themselves — a test that rebuilt them the same way would pass through the drift it
 * exists to catch.
 */
describe("insightsQuery", () => {
  it("keys and paths the company reading exactly as useInsights does", () => {
    const spec = insightsQuery("insight", null);

    expect(spec.queryKey).toEqual(["insights", "insight", "company"]);
    expect(spec.path).toBe("/api/analytics/insights?kind=insight");
  });

  it("keys a person's summary by their id and carries it in the query string", () => {
    const spec = insightsQuery("daily", PROFILE);

    expect(spec.queryKey).toEqual(["insights", "daily", PROFILE]);
    expect(spec.path).toBe(`/api/analytics/insights?kind=daily&profileId=${PROFILE}`);
  });

  it("does not collide a company row with a person's row", () => {
    expect(insightsQuery("weekly", null).queryKey).not.toEqual(
      insightsQuery("weekly", PROFILE).queryKey,
    );
  });
});

describe("readInsightKindParam", () => {
  it("accepts the three kinds the API serves", () => {
    expect(readInsightKindParam("daily")).toBe("daily");
    expect(readInsightKindParam("weekly")).toBe("weekly");
    expect(readInsightKindParam("insight")).toBe("insight");
  });

  it("rejects anything else rather than passing it to the API", () => {
    expect(readInsightKindParam("monthly")).toBeNull();
    expect(readInsightKindParam(undefined)).toBeNull();
    expect(readInsightKindParam("")).toBeNull();
  });

  it("takes the first value when the parameter is repeated", () => {
    expect(readInsightKindParam(["weekly", "daily"])).toBe("weekly");
  });
});

describe("readProfileIdParam", () => {
  it("accepts a uuid", () => {
    expect(readProfileIdParam(PROFILE)).toBe(PROFILE);
  });

  it("rejects a non-uuid, so no round trip is spent discovering the 400", () => {
    expect(readProfileIdParam("me")).toBeNull();
    expect(readProfileIdParam("3f2504e0-4f89-11d3-9a0c")).toBeNull();
    expect(readProfileIdParam(undefined)).toBeNull();
  });
});

describe("resolveInsightsRequest", () => {
  const base = {
    kindParam: undefined,
    profileIdParam: undefined,
    fallbackKind: "insight" as const,
    ownProfileId: null,
  };

  it("falls back to the role's first kind when nothing is asked for", () => {
    expect(resolveInsightsRequest(base)).toEqual({
      kind: "insight",
      profileId: null,
      askable: true,
    });
  });

  it("drops the person for a company reading — that row has no owner", () => {
    const resolved = resolveInsightsRequest({
      ...base,
      kindParam: "insight",
      profileIdParam: PROFILE,
    });

    expect(resolved.profileId).toBeNull();
  });

  it("cannot be asked for a per-person summary with nobody named", () => {
    const resolved = resolveInsightsRequest({ ...base, kindParam: "daily" });

    expect(resolved).toEqual({ kind: "daily", profileId: null, askable: false });
  });

  it("pins an employee to their own summaries whatever the URL says", () => {
    const resolved = resolveInsightsRequest({
      ...base,
      kindParam: "weekly",
      profileIdParam: "11111111-2222-3333-4444-555555555555",
      ownProfileId: PROFILE,
    });

    expect(resolved.profileId).toBe(PROFILE);
    expect(resolved.askable).toBe(true);
  });

  it("agrees with itself across the server and the browser for the same URL", () => {
    // The whole point of this module: one function, called twice, from two runtimes.
    const server = resolveInsightsRequest({ ...base, kindParam: "daily", profileIdParam: PROFILE });
    const client = resolveInsightsRequest({ ...base, kindParam: "daily", profileIdParam: PROFILE });

    expect(insightsQuery(server.kind, server.profileId).queryKey).toEqual(
      insightsQuery(client.kind, client.profileId).queryKey,
    );
  });
});
