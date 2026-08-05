import { describe, expect, it } from "vitest";

import { ApiError, NetworkError, apiErrorFor, describeError, isSessionExpired, joinUrl } from "./api";

describe("joinUrl", () => {
  it("joins a base and a path without doubling or dropping the separator", () => {
    expect(joinUrl("http://localhost:3001", "/api/employees")).toBe(
      "http://localhost:3001/api/employees",
    );
    expect(joinUrl("http://localhost:3001/", "/api/employees")).toBe(
      "http://localhost:3001/api/employees",
    );
    expect(joinUrl("https://api.example.com/v1/", "api/employees")).toBe(
      "https://api.example.com/v1/api/employees",
    );
  });
});

describe("apiErrorFor", () => {
  it("names an expired session instead of blaming the infrastructure", () => {
    const err = apiErrorFor(401, { error: "unauthorized", message: "Missing bearer token" });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("unauthorized");
    expect(err.message).toBe("Your session expired. Sign in again.");
  });

  it("names a permission problem as a permission problem", () => {
    const err = apiErrorFor(403, { error: "forbidden", message: "Manager role required" });
    expect(err.message).toBe("You do not have access to this.");
    expect(err.code).toBe("forbidden");
  });

  it("keeps 401 and 403 copy free of the server's internal wording", () => {
    // The API's own message ("Missing bearer token") is developer copy. It stays on
    // `serverMessage` for the console; the user sees the sentence above.
    const err = apiErrorFor(401, { error: "unauthorized", message: "Missing bearer token" });
    expect(err.serverMessage).toBe("Missing bearer token");
    expect(err.message).not.toContain("bearer");
  });

  it("surfaces the server's own message for a 400, which is about the request", () => {
    const err = apiErrorFor(400, { error: "invalid_body", message: "policyVersion is required" });
    expect(err.message).toBe("policyVersion is required");
  });

  it("reports a missing record without technical vocabulary", () => {
    expect(apiErrorFor(404, null).message).toBe("That record could not be found.");
  });

  it("reports a server fault as temporary, because a retry is the right response", () => {
    expect(apiErrorFor(500, null).message).toBe(
      "The service is temporarily unavailable. Try again in a moment.",
    );
    expect(apiErrorFor(503, null).message).toBe(
      "The service is temporarily unavailable. Try again in a moment.",
    );
  });

  it("falls back to a neutral sentence when the body is unparseable", () => {
    const err = apiErrorFor(418, "<html>teapot</html>");
    expect(err.status).toBe(418);
    expect(err.code).toBe("unknown");
    expect(err.message).toBe("That request could not be completed.");
  });
});

describe("isSessionExpired", () => {
  it("is true only for a 401, which is the one error sign-out fixes", () => {
    expect(isSessionExpired(apiErrorFor(401, null))).toBe(true);
    expect(isSessionExpired(apiErrorFor(403, null))).toBe(false);
    expect(isSessionExpired(new NetworkError("offline"))).toBe(false);
    expect(isSessionExpired(new Error("boom"))).toBe(false);
    expect(isSessionExpired(null)).toBe(false);
  });
});

describe("describeError", () => {
  it("passes an ApiError's user-facing sentence straight through", () => {
    expect(describeError(apiErrorFor(403, null))).toBe("You do not have access to this.");
  });

  it("only blames the connection when the request genuinely never landed", () => {
    expect(describeError(new NetworkError("fetch failed"))).toBe(
      "Could not reach the service. Check your connection.",
    );
  });

  it("does not blame the connection for an unknown error", () => {
    expect(describeError(new Error("kaboom"))).toBe("Something went wrong.");
    expect(describeError(undefined)).toBe("Something went wrong.");
  });
});
