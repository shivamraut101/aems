import { describe, expect, it } from "vitest";

import type { AgentPolicy } from "@aems/types";

import { emptyConfig, mayCollect, type AgentConfig } from "./index.js";

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
