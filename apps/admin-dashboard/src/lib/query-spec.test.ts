import { describe, expect, it } from "vitest";

import { apiQuery, specRequestInit, specResult } from "./query-spec";

/**
 * These tests exist for one reason: the server prefetch and the client hook build
 * their own requests from the same spec, and if the two ever build *different*
 * requests the symptom is not an error — it is a cache miss that silently restores
 * the flash the prefetch was added to remove. Pinning the derivation is the only way
 * that failure gets caught by anything other than a person watching a screen.
 */

describe("specRequestInit", () => {
  it("asks for nothing on a GET, so a caller can spread it over its own headers", () => {
    expect(specRequestInit(apiQuery<string[]>({ queryKey: ["a"], path: "/api/a" }))).toBeUndefined();
    expect(
      specRequestInit(apiQuery<string[]>({ queryKey: ["a"], path: "/api/a", method: "GET" })),
    ).toBeUndefined();
  });

  it("serialises a POST body exactly once", () => {
    const init = specRequestInit(
      apiQuery<{ ok: boolean }>({
        queryKey: ["report", "week"],
        path: "/api/reports/run",
        method: "POST",
        body: { scope: "company", grouping: "date" },
      }),
    );

    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"scope":"company","grouping":"date"}');
  });

  it("omits the body rather than sending the string \"undefined\"", () => {
    const init = specRequestInit(
      apiQuery<null>({ queryKey: ["x"], path: "/api/x", method: "POST" }),
    );

    expect(init?.method).toBe("POST");
    expect(init && "body" in init).toBe(false);
  });
});

describe("specResult", () => {
  it("passes the payload straight through when the spec declares no parse", () => {
    const spec = apiQuery<{ id: string }[]>({ queryKey: ["devices"], path: "/api/devices" });
    const payload = [{ id: "d1" }];

    expect(specResult(spec, payload)).toBe(payload);
  });

  it("applies the spec's parse, so both runtimes cache the same shape", () => {
    // The case this protects: the server would otherwise dehydrate the API's raw
    // snake_case body while the browser's own fetch stored the parsed object, and
    // whichever landed second would change the type the page had already rendered.
    const spec = apiQuery<{ name: string }>({
      queryKey: ["me"],
      path: "/api/auth/me",
      parse: (payload) => ({ name: String((payload as { full_name: string }).full_name) }),
    });

    expect(specResult(spec, { full_name: "Ada" })).toEqual({ name: "Ada" });
  });
});

describe("apiQuery", () => {
  it("returns the very object it was given, so the key has one identity", () => {
    // Not a triviality. The whole guarantee is that the page and the hook import the
    // same declaration; a helper that copied or rebuilt the spec would let the two
    // sides drift again the moment one of them was passed a derived version.
    const spec = { queryKey: ["devices"] as const, path: "/api/devices" };
    expect(apiQuery<string[]>(spec)).toBe(spec);
  });
});
