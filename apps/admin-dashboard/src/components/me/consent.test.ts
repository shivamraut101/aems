import { describe, expect, it } from "vitest";

import {
  WITHDRAWAL_TAKES_EFFECT,
  collectionStatus,
  consentForDevice,
  consentIsBehindPolicy,
  consentKey,
  withdrawalConsequences,
  type ConsentRow,
} from "./consent";

function row(overrides: Partial<ConsentRow> & Pick<ConsentRow, "device_id">): ConsentRow {
  return {
    policy_version: "2026.08.1",
    consented_at: "2026-08-05T06:08:10.000Z",
    revoked_at: null,
    ...overrides,
  };
}

describe("consentForDevice", () => {
  it("reports no consent when nothing has been recorded", () => {
    expect(consentForDevice([], "d1")).toEqual({ state: "none" });
  });

  it("treats an undefined payload as no consent rather than throwing", () => {
    // The query has not answered yet. A screen must be able to ask before then.
    expect(consentForDevice(undefined, "d1")).toEqual({ state: "none" });
  });

  it("ignores rows belonging to another device", () => {
    expect(consentForDevice([row({ device_id: "other" })], "d1")).toEqual({ state: "none" });
  });

  it("reports the live row when one exists", () => {
    const state = consentForDevice([row({ device_id: "d1", policy_version: "2026.08.2" })], "d1");

    expect(state).toEqual({
      state: "active",
      policyVersion: "2026.08.2",
      consentedAt: "2026-08-05T06:08:10.000Z",
    });
  });

  /**
   * The live-data shape: `d0000000-…-0001` carries a revoked 2026.08.1 row AND a live
   * 2026.08.2 one. Reading the newest-by-time would be right by luck here and wrong the
   * moment a revocation lands after a fresh consent; the unique index says at most one
   * row is live, so liveness is the rule.
   */
  it("prefers the live row over an older withdrawn one whatever the order", () => {
    const rows = [
      row({ device_id: "d1", policy_version: "2026.08.2", consented_at: "2026-08-05T09:12:50.000Z" }),
      row({
        device_id: "d1",
        policy_version: "2026.08.1",
        consented_at: "2026-08-05T06:08:10.000Z",
        revoked_at: "2026-08-05T09:12:12.000Z",
      }),
    ];

    expect(consentForDevice(rows, "d1")).toMatchObject({ state: "active", policyVersion: "2026.08.2" });
    expect(consentForDevice([...rows].reverse(), "d1")).toMatchObject({
      state: "active",
      policyVersion: "2026.08.2",
    });
  });

  it("reports the most recent withdrawal when nothing is live", () => {
    const rows = [
      row({
        device_id: "d1",
        policy_version: "2026.08.1",
        consented_at: "2026-01-01T00:00:00.000Z",
        revoked_at: "2026-02-01T00:00:00.000Z",
      }),
      row({
        device_id: "d1",
        policy_version: "2026.08.2",
        consented_at: "2026-08-05T06:08:10.000Z",
        revoked_at: "2026-08-05T09:12:12.000Z",
      }),
    ];

    expect(consentForDevice(rows, "d1")).toEqual({
      state: "withdrawn",
      policyVersion: "2026.08.2",
      consentedAt: "2026-08-05T06:08:10.000Z",
      revokedAt: "2026-08-05T09:12:12.000Z",
    });
  });
});

describe("consentIsBehindPolicy", () => {
  const active = { state: "active", policyVersion: "2026.08.2", consentedAt: "x" } as const;

  it("is true when the company has published a newer version than the one on file", () => {
    expect(consentIsBehindPolicy(active, "2026.08.4")).toBe(true);
  });

  it("is false when they match", () => {
    expect(consentIsBehindPolicy(active, "2026.08.2")).toBe(false);
  });

  it("says nothing when no policy is published — that is a different problem", () => {
    expect(consentIsBehindPolicy(active, null)).toBe(false);
  });

  /**
   * Withdrawn consent is not "behind" anything. Telling someone who has opted out that
   * the terms have moved on implies they are still being collected under them.
   */
  it("is false once consent has been withdrawn", () => {
    const withdrawn = {
      state: "withdrawn",
      policyVersion: "2026.08.1",
      consentedAt: "x",
      revokedAt: "y",
    } as const;

    expect(consentIsBehindPolicy(withdrawn, "2026.08.4")).toBe(false);
    expect(consentIsBehindPolicy({ state: "none" }, "2026.08.4")).toBe(false);
  });
});

describe("collectionStatus", () => {
  const active = { id: "d1", status: "active" };
  const second = { id: "d2", status: "active" };

  it("counts a device with a live consent record as collecting", () => {
    expect(collectionStatus([active], [row({ device_id: "d1" })], true)).toEqual({
      enrolled: 1,
      collecting: 1,
      accountPaused: false,
    });
  });

  it("does not count a device whose consent has been withdrawn", () => {
    const rows = [row({ device_id: "d1", revoked_at: "2026-08-05T09:12:12.000Z" })];
    expect(collectionStatus([active, second], rows, true)).toMatchObject({
      enrolled: 2,
      collecting: 0,
    });
  });

  /**
   * `requireDevice` 403s a revoked device before it looks at consent, so a stale live
   * consent row on one must not make this page claim it is still collecting.
   */
  it("does not count a revoked device even with consent on file", () => {
    const revoked = { id: "d1", status: "revoked" };
    expect(collectionStatus([revoked], [row({ device_id: "d1" })], true)).toMatchObject({
      collecting: 0,
    });
  });

  it("reports nothing collecting when an administrator has paused the account", () => {
    expect(collectionStatus([active], [row({ device_id: "d1" })], false)).toEqual({
      enrolled: 1,
      collecting: 0,
      accountPaused: true,
    });
  });

  /**
   * The case worth having the function for. A failed consent read defaulting to zero
   * would print "nothing is being collected" over a machine that is reporting — an
   * outage turned into a reassurance, on the one screen where that is a legal problem.
   */
  it("refuses to answer when the consent records could not be read", () => {
    expect(collectionStatus([active], undefined, true)).toEqual({
      enrolled: 1,
      collecting: null,
      accountPaused: false,
    });
  });

  it("still reports the account pause when consent is unreadable, because that alone stops everything", () => {
    expect(collectionStatus([active], undefined, false)).toMatchObject({
      collecting: 0,
      accountPaused: true,
    });
  });
});

describe("consentKey", () => {
  it("is scoped to the person, so a shared browser cannot serve the last one's answer", () => {
    expect(consentKey("a")).not.toEqual(consentKey("b"));
  });
});

describe("withdrawalConsequences", () => {
  it("names screenshots first on a desktop, because that is what people picture", () => {
    expect(withdrawalConsequences("windows").stops[0]).toContain("Screenshot");
  });

  it("does not promise a phone stops taking screenshots — it never took any", () => {
    const android = withdrawalConsequences("android");
    expect(android.stops.join(" ")).not.toContain("Screenshot");
  });

  /**
   * Compliance copy, asserted rather than trusted. A confirmation that omits any of
   * these three leaves the reader unable to predict what they are about to cause:
   * that data is kept, that the agent keeps running, and that resuming is not
   * something anyone else can do for them.
   */
  it("states that recorded data is kept, not deleted", () => {
    const text = withdrawalConsequences("windows").continues.join(" ");
    expect(text).toContain("kept");
    expect(text).toContain("not a deletion");
  });

  it("states that the agent keeps running so it can learn it must stop", () => {
    expect(withdrawalConsequences("macos").continues.join(" ")).toContain("stays enrolled");
  });

  it("points re-consent at the agent, not at a button on this page", () => {
    const resume = withdrawalConsequences("windows").resume;
    expect(resume).toContain("agent");
    expect(resume).toContain("Nobody can do it on your behalf");
  });

  it("says when withdrawal takes effect — non-negotiable #4", () => {
    expect(WITHDRAWAL_TAKES_EFFECT).toContain("next request");
  });
});
