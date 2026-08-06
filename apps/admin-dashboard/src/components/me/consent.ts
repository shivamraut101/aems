/**
 * The consent record behind one device — read, resolved, and described.
 *
 * ## Why this reads Supabase instead of the API
 *
 * There is no endpoint that returns consent. `POST /api/auth/consent/:deviceId/revoke`
 * withdraws it and `assertConsent` checks it during ingestion, but nothing *selects* it
 * back, so a screen offering "withdraw" would have no way to know whether there is
 * anything to withdraw — and would answer a second click with a 404 that reads as a
 * fault rather than as "already done".
 *
 * `consent_records` has an RLS select policy for exactly this reader:
 *
 *     create policy consent_records_select_self on public.consent_records
 *       for select to authenticated using (profile_id = (select auth.uid()));
 *
 * so the browser, holding only the anon key and the person's own JWT, can see their own
 * rows and nothing else. The database is the boundary here, which is the same reasoning
 * `/devices` already uses to read `device_telemetry` directly. When the API grows a
 * `GET /api/auth/consent` this should move behind it — see the handover note.
 *
 * The select is written once, here, and used by both the server prefetch and the client
 * hook so the two cannot ask for different columns.
 */

// Type-only, and erased: this module is imported by a server component, and the value
// side of `@/lib/supabase` is a browser factory.
import type { createClient } from "@/lib/supabase";

/**
 * Whatever `@supabase/ssr` hands back, browser or server.
 *
 * Taken from our own factory rather than written as `SupabaseClient<Database>`: the
 * `SupabaseClient` re-exported by `@supabase/supabase-js` at the workspace root and the
 * one `@supabase/ssr` builds against differ in generic arity, so naming the type
 * directly makes the server client fail to satisfy the browser one and vice versa. The
 * factory's return type is the same shape both callers actually hold.
 */
export type ConsentSupabaseClient = ReturnType<typeof createClient>;

/** The columns this screen needs. Deliberately not `*`: `ip_address` is not its business. */
export const CONSENT_COLUMNS = "device_id, policy_version, consented_at, revoked_at";

export interface ConsentRow {
  device_id: string;
  policy_version: string;
  consented_at: string;
  revoked_at: string | null;
}

/**
 * Keyed by profile, not by "mine".
 *
 * A shared browser is the case that matters: sign out, sign in as someone else, and a
 * key called `["consent","mine"]` would serve the previous person's answer for as long
 * as it stayed fresh. `queryClient.clear()` on sign-out already covers it, but a key
 * that cannot be wrong regardless is cheaper than a guarantee that has to hold.
 */
export function consentKey(profileId: string): readonly unknown[] {
  return ["consent", profileId];
}

/**
 * Every consent record this person has ever given, newest first.
 *
 * Throws on failure rather than returning an empty array. An empty array means "you
 * have never consented to anything", which on this screen renders as "nothing may be
 * collected from this device" — the exact opposite of the truth if the query merely
 * failed. The prefetch relies on the throw too: a failed read must cache nothing.
 */
export async function readOwnConsent(
  client: ConsentSupabaseClient,
  profileId: string,
): Promise<ConsentRow[]> {
  const { data, error } = await client
    .from("consent_records")
    .select(CONSENT_COLUMNS)
    .eq("profile_id", profileId)
    .order("consented_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as ConsentRow[];
}

export type ConsentState =
  | { state: "active"; policyVersion: string; consentedAt: string }
  | { state: "withdrawn"; policyVersion: string; consentedAt: string; revokedAt: string }
  | { state: "none" };

/**
 * What is in force for one device.
 *
 * `consent_records_active_device_key` is a unique index on `device_id` where
 * `revoked_at is null`, so there is at most one live row per device and any number of
 * withdrawn ones. A live row therefore always wins; failing that the most recently
 * given withdrawn row is the one worth describing, because "you withdrew this on
 * Tuesday" is a fact the reader can act on and "you withdrew something in March" is
 * not.
 *
 * Rows are not assumed to arrive sorted — the caller's `order` is a convenience, not a
 * contract this function should inherit.
 */
export function consentForDevice(
  rows: readonly ConsentRow[] | undefined,
  deviceId: string,
): ConsentState {
  if (!rows) return { state: "none" };

  const mine = rows.filter((row) => row.device_id === deviceId);

  const live = mine.find((row) => row.revoked_at === null);
  if (live) {
    return {
      state: "active",
      policyVersion: live.policy_version,
      consentedAt: live.consented_at,
    };
  }

  let newest: ConsentRow | null = null;
  for (const row of mine) {
    if (row.revoked_at === null) continue;
    if (newest === null || Date.parse(row.consented_at) > Date.parse(newest.consented_at)) {
      newest = row;
    }
  }

  if (newest === null) return { state: "none" };

  return {
    state: "withdrawn",
    policyVersion: newest.policy_version,
    consentedAt: newest.consented_at,
    // Narrowed by the loop above; restated for the type rather than asserted.
    revokedAt: newest.revoked_at ?? "",
  };
}

/**
 * The one-sentence answer /my-devices exists to give: is anything being collected about
 * me right now?
 *
 * It is pure and tested because it is a *claim*, not a layout. "Nothing is being
 * collected" printed above a machine that is in fact reporting would be the worst thing
 * this product could say, so the three conditions the server actually enforces are
 * mirrored here and nowhere else:
 *
 *  - `monitoring_enabled = false` on the profile → `requireDevice` 403s every request
 *    (`apps/api/src/plugins/context.ts`), so nothing can be sent from any device.
 *  - `devices.status = 'revoked'` → the same hook 403s that one device.
 *  - no non-revoked `consent_records` row → `assertConsent` refuses ingestion.
 *
 * `collecting` is `number | null` rather than `number` for the case that matters most:
 * when the consent read failed there is no honest count, and defaulting to zero would
 * turn an outage into a reassurance. The caller must say "not knowable" instead.
 */
export interface CollectionStatus {
  enrolled: number;
  /** Null when consent could not be read — never guess "nothing" from a failed query. */
  collecting: number | null;
  /** An administrator has paused collection for the whole account. */
  accountPaused: boolean;
}

export function collectionStatus(
  // Structural rather than `MyDeviceRow`, so this module keeps its single import and
  // does not drag `lib/queries/account` into the server prefetch path.
  devices: readonly { id: string; status: string }[],
  rows: readonly ConsentRow[] | undefined,
  monitoringEnabled: boolean,
): CollectionStatus {
  const enrolled = devices.length;

  if (!monitoringEnabled) return { enrolled, collecting: 0, accountPaused: true };
  if (rows === undefined) return { enrolled, collecting: null, accountPaused: false };

  const collecting = devices.filter(
    (device) =>
      device.status !== "revoked" && consentForDevice(rows, device.id).state === "active",
  ).length;

  return { enrolled, collecting, accountPaused: false };
}

/**
 * Has the company published a newer policy than the one this person agreed to?
 *
 * `assertConsent` only asks whether a non-revoked row exists — it never compares the
 * version — so an employee who accepted `2026.08.2` keeps being collected after
 * `2026.08.4` is published. That is a real property of the system and this screen is
 * the one place its subject can find it out, so it is surfaced rather than smoothed
 * over. The wording that goes with it must not claim which version the agent is
 * *enforcing*: an agent takes its policy at enrolment, so the honest statement is that
 * the published terms have changed since the agreement on file.
 */
export function consentIsBehindPolicy(
  consent: ConsentState,
  currentVersion: string | null,
): boolean {
  if (consent.state !== "active") return false;
  if (!currentVersion) return false;
  return consent.policyVersion !== currentVersion;
}

/**
 * What stops when consent is withdrawn — the sentences the confirmation must show.
 *
 * Non-negotiable #1 makes consent the gate and #4 makes withdrawal immediate, so a
 * confirmation that says "are you sure?" and nothing else is not a confirmation. The
 * reader has to be able to predict the consequence before they cause it, including the
 * parts that do *not* change, which is where people are most often surprised.
 */
export interface WithdrawalConsequences {
  stops: readonly string[];
  continues: readonly string[];
  /** How to allow collection again. It is not a button on this page, and it should not be. */
  resume: string;
}

export function withdrawalConsequences(platform: string): WithdrawalConsequences {
  const desktop = platform !== "android";

  return {
    stops: [
      desktop
        ? "Screenshots of this device's screens."
        : "App-usage and screen-time reporting from this phone.",
      desktop
        ? "Application and website activity, and the time attributed to each."
        : "Battery, network and storage reporting.",
      desktop ? "Idle and break detection, and new work sessions." : "New work sessions.",
      "The installed-application inventory and any device telemetry.",
    ],
    continues: [
      "Everything already recorded is kept. It stays visible to you and to your manager, and withdrawing consent is not a deletion request.",
      "The device stays enrolled and the agent keeps running, so it can find out on its next check-in that it must stop. That check-in carries no observation of you.",
    ],
    resume:
      "To allow collection again, accept the policy in the AEMS agent on the device itself. Nobody can do it on your behalf from here.",
  };
}

/** The one sentence that states when it takes effect. Non-negotiable #4, verbatim in spirit. */
export const WITHDRAWAL_TAKES_EFFECT =
  "Collection stops at the device's next request to the server — usually within a minute.";
