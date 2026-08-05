import { createHash, randomInt } from "node:crypto";

/**
 * Codes an employee can be told over the phone.
 *
 * Enrolment used to mean pasting a Supabase access token — 800 characters of JWT that
 * grants the account's FULL rights for an hour, not the single act of binding a
 * machine. There is no honest answer to "where does a real employee get that", which
 * is the whole reason this exists.
 */

/**
 * Crockford-style alphabet: no O/0, no I/1, no U.
 *
 * Someone is reading this off a screen and typing it into another machine, possibly
 * from a photo or over a call. Every removed character is a class of failed enrolment
 * that looks like "the code doesn't work" rather than "I typed an O".
 */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTVWXYZ";
const GROUP = 4;
const GROUPS = 2;

/** How long a code lives. Long enough to walk to another desk, short enough to matter. */
export const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * A fresh code, formatted `XXXX-XXXX`.
 *
 * `randomInt` rather than `Math.random()`: this is a credential. Rejection-free
 * because node's randomInt already handles modulo bias for us.
 */
export function generateCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g += 1) {
    let group = "";
    for (let i = 0; i < GROUP; i += 1) group += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(group);
  }
  return groups.join("-");
}

/**
 * Everything a human might do to a code on the way back in.
 *
 * Lower case, spaces instead of the dash, the dash left out, a trailing newline from a
 * paste. All of it means the same code, and refusing any of them would be the product
 * blaming the user for its own formatting.
 */
export function normaliseCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, "");
}

/**
 * What is stored. The plaintext never is.
 *
 * Hashing also gives the redemption path an O(1) lookup with no enumeration: there is
 * no query that walks codes, only one that asks "is THIS code live".
 *
 * A plain SHA-256 rather than bcrypt/argon2 on purpose. Those defend a low-entropy
 * secret against offline cracking; this one has ~40 bits, lives ten minutes and dies
 * on first use, so the threat is guessing it live — which the expiry and single use
 * bound — not cracking a stolen hash. A slow hash on the hot enrolment path would buy
 * nothing and cost latency.
 */
export function hashCode(code: string): string {
  return createHash("sha256").update(normaliseCode(code)).digest("hex");
}

/** The row shape redemption needs to judge. */
export interface RedeemableCode {
  expires_at: string;
  consumed_at: string | null;
}

/**
 * Why a code cannot be redeemed, or null if it can.
 *
 * Every rejection says the same thing to the caller. "No such code", "already used"
 * and "expired" are one message on purpose: distinguishing them turns the endpoint
 * into an oracle that confirms which codes exist, and none of the three is separately
 * actionable anyway — the fix is always "ask for a new code".
 */
export function codeRejection(
  row: RedeemableCode | null | undefined,
  now: number,
): { statusCode: number; error: string; message: string } | null {
  const unusable = {
    statusCode: 401,
    error: "invalid_code",
    message: "That sign-in code is not valid any more. Generate a new one from the dashboard.",
  };

  if (!row) return unusable;
  if (row.consumed_at !== null) return unusable;
  if (Date.parse(row.expires_at) <= now) return unusable;

  return null;
}
