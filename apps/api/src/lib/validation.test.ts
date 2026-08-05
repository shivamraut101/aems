import { describe, expect, it } from "vitest";
import { z } from "zod";

import { validationFailure } from "./validation.js";

/** Runs a schema against bad input and returns what the caller would receive. */
function failureFor(schema: z.ZodTypeAny, input: unknown) {
  const parsed = schema.safeParse(input);
  if (parsed.success) throw new Error("expected the schema to reject this input");
  return validationFailure(parsed.error);
}

describe("validationFailure", () => {
  it("replaces the Zod dump that reached a user", () => {
    // Verbatim from the agent's sign-in box:
    //   AemsApiError: [ { "code": "too_small", "minimum": 4, ... "path": [ "code" ] } ]
    const failure = failureFor(z.object({ code: z.string().min(4) }), { code: "abc" });

    expect(failure.message).toBe("Sign-in code must be at least 4 characters.");
    expect(failure.message).not.toContain("too_small");
    expect(failure.message).not.toContain("{");
  });

  it("never emits anything that looks like serialised data", () => {
    // The guard that matters: whatever the schema, the message is prose. A `[` or `{`
    // here means a raw issue array leaked back into the response.
    const schemas: [z.ZodTypeAny, unknown][] = [
      [z.object({ email: z.string().email() }), { email: "nope" }],
      [z.object({ tags: z.array(z.string()).min(2) }), { tags: ["one"] }],
      [z.object({ kind: z.enum(["daily", "weekly"]) }), { kind: "hourly" }],
      [z.object({ id: z.string().uuid() }), { id: "not-a-uuid" }],
      [z.object({ n: z.number().int().max(10) }), { n: 99 }],
      [z.object({ nested: z.object({ fullName: z.string().min(1) }) }), { nested: { fullName: "" } }],
    ];

    for (const [schema, input] of schemas) {
      const { message } = failureFor(schema, input);
      expect(message.startsWith("["), message).toBe(false);
      expect(message.startsWith("{"), message).toBe(false);
      expect(message.endsWith("."), message).toBe(true);
    }
  });

  it("calls a missing field required rather than a type error", () => {
    // Zod says "expected string, received undefined", which describes the type system
    // and not the empty box the person is looking at.
    const failure = failureFor(z.object({ platform: z.string() }), {});
    expect(failure.message).toBe("Platform is required.");
  });

  it("uses the name a person knows the field by", () => {
    const failure = failureFor(z.object({ fullName: z.string().min(1) }), { fullName: "" });
    expect(failure.message).toBe("Full name is required.");
  });

  it("de-camel-cases a field it has no label for", () => {
    const failure = failureFor(z.object({ storageFreeMb: z.number() }), {});
    expect(failure.message).toBe("Storage free mb is required.");
  });

  it("lists the allowed values for an enum, which is the actionable part", () => {
    const failure = failureFor(z.object({ kind: z.enum(["daily", "weekly"]) }), { kind: "hourly" });
    expect(failure.message).toBe("Report type must be one of: daily, weekly.");
  });

  it("keeps a hand-written refine message exactly as written", () => {
    const schema = z
      .object({ a: z.number() })
      .refine((v) => v.a > 0, { message: "Publish a policy before enrolling a device." });
    expect(failureFor(schema, { a: 0 }).message).toBe(
      "Publish a policy before enrolling a device.",
    );
  });

  it("maps every field, so a form can mark each input", () => {
    const failure = failureFor(
      z.object({ email: z.string().email(), fullName: z.string().min(1) }),
      { email: "nope", fullName: "" },
    );

    expect(failure.fields).toEqual({
      email: "Email address must be a valid email address.",
      fullName: "Full name is required.",
    });
  });

  it("caps the sentence at three problems but keeps them all in fields", () => {
    // Six sentences buries the reader; the map still carries everything for the UI.
    const schema = z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
    });
    const failure = failureFor(schema, {});

    expect(failure.message.match(/\./g)?.length).toBe(3);
    expect(Object.keys(failure.fields)).toHaveLength(5);
  });

  it("carries the code the caller branches on", () => {
    const parsed = z.object({ a: z.string() }).safeParse({});
    if (parsed.success) throw new Error("unreachable");

    expect(validationFailure(parsed.error, "invalid_query").error).toBe("invalid_query");
    expect(validationFailure(parsed.error).error).toBe("invalid_body");
    expect(validationFailure(parsed.error).statusCode).toBe(400);
  });
});
