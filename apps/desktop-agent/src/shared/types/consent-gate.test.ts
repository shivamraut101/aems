import { describe, expect, it } from "vitest";

import type { AgentPolicy } from "@aems/types";

import {
  emptyConfig,
  mayCollect,
  mayCollectType,
  offeredTypes,
  type AgentConfig,
} from "./index.js";

/**
 * The consent gate — non-negotiable #1 in CLAUDE.md.
 *
 * `mayCollect` is the single predicate the collection loop consults every tick.
 * Every path through it is a compliance rule, and until now the file had no test
 * at all: the adversarial review flagged that the automatic-lapse-on-policy-bump
 * branch — the documented reason `consentedPolicyVersion` exists — was entirely
 * undefended.
 *
 * These are regression guards, not RED-first TDD cycles; the production code
 * already existed. Each one was verified by mutation instead: the corresponding
 * line was broken, the suite was confirmed to fail, and the line restored. A test
 * that cannot fail is worse than no test, because it reads like coverage.
 */

const POLICY: AgentPolicy = {
  version: "2026.08.1",
  name: "Standard Monitoring Policy",
  screenshotIntervalSeconds: 300,
  idleThresholdSeconds: 120,
  trackedCategories: [],
};

/** A fully enrolled, fully consented agent — the only state that may collect. */
function consented(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...emptyConfig("http://localhost:3001"),
    deviceId: "device-1",
    deviceToken: "token-1",
    profileId: "profile-1",
    companyId: "company-1",
    policy: POLICY,
    consentedPolicyVersion: POLICY.version,
    ...overrides,
  };
}

describe("mayCollect", () => {
  it("allows collection once enrolled and consented to the current policy", () => {
    expect(mayCollect(consented())).toBe(true);
  });

  it("stops collecting when the employer publishes a new policy version", () => {
    // The compliance-critical branch. Consent was given for 2026.08.1; the
    // employer has since widened what is monitored. The agent must fall silent
    // until the employee agrees to the new terms — nobody re-consents by
    // accident, and nobody is monitored under terms they never saw.
    const bumped = consented({
      policy: { ...POLICY, version: "2026.09.1" },
      consentedPolicyVersion: "2026.08.1",
    });

    expect(mayCollect(bumped)).toBe(false);
  });

  it("refuses when consent was never recorded", () => {
    expect(mayCollect(consented({ consentedPolicyVersion: null }))).toBe(false);
  });

  it("refuses when no policy has been fetched yet", () => {
    expect(mayCollect(consented({ policy: null }))).toBe(false);
  });

  it("refuses when the device is not enrolled", () => {
    expect(mayCollect(consented({ deviceToken: null }))).toBe(false);
  });

  it("refuses once revoked, even with consent on file for the current policy", () => {
    // Revocation is terminal and is checked FIRST. A revoked device that still
    // holds a valid-looking local consent must not resume collecting just
    // because the version numbers happen to line up.
    expect(mayCollect(consented({ revoked: true }))).toBe(false);
  });

  it("stays revoked when a newly consented policy version arrives", () => {
    const reconsented = consented({
      revoked: true,
      policy: { ...POLICY, version: "2026.09.1" },
      consentedPolicyVersion: "2026.09.1",
    });

    expect(mayCollect(reconsented)).toBe(false);
  });

  it("refuses a freshly initialised config", () => {
    expect(mayCollect(emptyConfig("http://localhost:3001"))).toBe(false);
  });
});

/**
 * The per-device half of the same gate.
 *
 * Every per-type check in `main/` routes through `mayCollectType`, so the rules that
 * matter are: an absent scope changes nothing, a denied type is refused, and consent
 * still outranks both. Verified by mutation — dropping the `mayCollect` call, and
 * flipping the `Array.isArray` default to `false`, each broke a case below.
 */
describe("mayCollectType", () => {
  it("permits everything when no per-device scope has arrived", () => {
    // The deploy case, and the whole reason this defaults open: the eight devices in
    // the field have no settings rows and must keep collecting exactly what they did.
    const config = consented({ collection: null });

    expect(mayCollectType(config, "screenshots")).toBe(true);
    expect(mayCollectType(config, "websites")).toBe(true);
    expect(mayCollectType(config, "telemetry")).toBe(true);
  });

  it("refuses a type the scope leaves out, and permits the ones it names", () => {
    const config = consented({ collection: ["applications", "idle"] });

    expect(mayCollectType(config, "applications")).toBe(true);
    expect(mayCollectType(config, "idle")).toBe(true);
    expect(mayCollectType(config, "screenshots")).toBe(false);
    expect(mayCollectType(config, "websites")).toBe(false);
  });

  it("still refuses a permitted type when there is no consent behind it", () => {
    // The order matters: a scope is an administrator narrowing what may be collected,
    // never a second route to collecting it. Consent is checked first and separately.
    const config = consented({
      collection: ["screenshots"],
      consentedPolicyVersion: null,
    });

    expect(mayCollectType(config, "screenshots")).toBe(false);
  });

  it("refuses everything on a revoked device whatever the scope says", () => {
    expect(mayCollectType(consented({ collection: ["idle"], revoked: true }), "idle")).toBe(false);
  });

  it("permits when the stored scope is not a list at all", () => {
    // A hand-edited config must cost the narrowing, not the day: the API enforces the
    // same set independently, so a degraded agent over-reports to a server that
    // refuses it rather than silently recording nothing and telling nobody.
    const damaged = consented({ collection: "screenshots" as unknown as null });

    expect(mayCollectType(damaged, "screenshots")).toBe(true);
  });
});

describe("offeredTypes", () => {
  it("lists what is permitted plus what an administrator has added, without duplicates", () => {
    expect(offeredTypes(["applications", "idle"], ["screenshots", "idle"])).toEqual([
      "applications",
      "idle",
      "screenshots",
    ]);
  });

  it("stays null when no scope has arrived, so the caller falls back to the default", () => {
    expect(offeredTypes(null, ["screenshots"])).toBeNull();
  });
});
