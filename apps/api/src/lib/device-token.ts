import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Long-lived credentials for agents.
 *
 * Agents run on machines we do not control and cannot hold a Supabase session —
 * refreshing one would need a user present. So enrolment mints an HMAC-signed token
 * naming the device, and the agent presents it on every later request.
 *
 * The token is an authorisation claim, not a secret store: it carries only ids, and
 * the API re-reads the device row (including whether it has been revoked) on each
 * request rather than trusting anything embedded here.
 */

export interface DeviceTokenPayload {
  deviceId: string;
  companyId: string;
  profileId: string;
  issuedAt: number;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function issueDeviceToken(payload: DeviceTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/** Returns null for anything malformed or incorrectly signed. */
export function verifyDeviceToken(token: string, secret: string): DeviceTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [body, signature] = parts;
  if (!body || !signature) return null;

  const expected = sign(body, secret);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);

  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as DeviceTokenPayload;
    if (!parsed.deviceId || !parsed.companyId || !parsed.profileId) return null;
    return parsed;
  } catch {
    return null;
  }
}
