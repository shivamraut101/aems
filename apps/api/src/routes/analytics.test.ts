import type { SessionProfile } from "@aems/auth";
import { describe, expect, it } from "vitest";

import { insightsDenial, insightsSchema } from "./analytics.js";

const SELF = "11111111-1111-4111-8111-111111111111";
const SOMEONE_ELSE = "22222222-2222-4222-8222-222222222222";

type Caller = Pick<SessionProfile, "role" | "profileId">;

const employee: Caller = { role: "employee", profileId: SELF };
const manager: Caller = { role: "manager", profileId: SOMEONE_ELSE };
const admin: Caller = { role: "super_admin", profileId: SOMEONE_ELSE };

describe("insightsSchema", () => {
  it("requires profileId for a per-person summary", () => {
    // "Whose daily summary?" has no sensible default. Answering with everyone's
    // would be a data leak and answering with none would be a silent empty page.
    for (const kind of ["daily", "weekly"] as const) {
      const parsed = insightsSchema.safeParse({ kind });
      expect(parsed.success, `${kind} without profileId must be rejected`).toBe(false);
    }
  });

  it("does not require profileId for the company insight, which has no owner", () => {
    expect(insightsSchema.safeParse({ kind: "insight" }).success).toBe(true);
  });

  it("rejects a kind outside the three docs/scope.md names", () => {
    expect(insightsSchema.safeParse({ kind: "hourly", profileId: SELF }).success).toBe(false);
  });

  it("rejects a profileId that is not a uuid, so it never reaches a query", () => {
    expect(insightsSchema.safeParse({ kind: "daily", profileId: "me" }).success).toBe(false);
  });

  it("defaults the limit and caps it", () => {
    const parsed = insightsSchema.parse({ kind: "daily", profileId: SELF });
    expect(parsed.limit).toBe(14);
    expect(insightsSchema.safeParse({ kind: "insight", limit: 500 }).success).toBe(false);
    expect(insightsSchema.safeParse({ kind: "insight", limit: 0 }).success).toBe(false);
  });
});

describe("insightsDenial", () => {
  it("lets an employee read their own daily and weekly summaries", () => {
    // Non-negotiable #3. An employee who cannot read their own data is a compliance
    // failure, not a tightening.
    for (const kind of ["daily", "weekly"] as const) {
      expect(insightsDenial({ kind, profileId: SELF }, employee)).toBeNull();
    }
  });

  it("refuses an employee reading someone else's summary", () => {
    const denial = insightsDenial({ kind: "daily", profileId: SOMEONE_ELSE }, employee);
    expect(denial?.statusCode).toBe(403);
    expect(denial?.message).toBe("Not your data");
  });

  it("refuses an employee the company-wide insight", () => {
    // It aggregates colleagues, so it is somebody else's data wearing a different name.
    const denial = insightsDenial({ kind: "insight", profileId: undefined }, employee);
    expect(denial?.statusCode).toBe(403);
  });

  it("refuses an employee the company insight whatever profileId they send", () => {
    // The obvious dodge: name yourself, hope the ownership test is the only gate.
    // Asserted for every profileId shape rather than for a check order — swapping the
    // two denials leaves this green, because both refuse and only the wording moves.
    for (const profileId of [SELF, SOMEONE_ELSE, undefined]) {
      expect(
        insightsDenial({ kind: "insight", profileId }, employee)?.statusCode,
        `profileId=${String(profileId)}`,
      ).toBe(403);
    }
  });

  it("lets a manager and an admin read anyone's summaries and the company insight", () => {
    for (const session of [manager, admin]) {
      expect(insightsDenial({ kind: "daily", profileId: SELF }, session)).toBeNull();
      expect(insightsDenial({ kind: "insight", profileId: undefined }, session)).toBeNull();
    }
  });

  it("treats a role it does not recognise as unprivileged", () => {
    // Fail closed. A role added to the schema later and forgotten here must arrive
    // with no rights, not with a manager's. Cast because the point of the test is a
    // value the type system is meant to exclude — the check has to survive it anyway.
    const future = { role: "auditor" as SessionProfile["role"], profileId: SELF };

    expect(insightsDenial({ kind: "insight", profileId: undefined }, future)?.statusCode).toBe(403);
    expect(insightsDenial({ kind: "daily", profileId: SOMEONE_ELSE }, future)?.statusCode).toBe(403);
    // ...and it still reads its own, which is the floor every role has.
    expect(insightsDenial({ kind: "daily", profileId: SELF }, future)).toBeNull();
  });
});
