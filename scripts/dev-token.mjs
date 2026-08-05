#!/usr/bin/env node
/**
 * Mint a Supabase access token for a seeded demo account.
 *
 * The desktop agent's login screen asks for an access token rather than an
 * email and password on purpose: the agent never sees a credential, so a
 * compromised binary cannot replay one. That is the right design and an
 * inconvenient one to test by hand — this prints the token to paste in.
 *
 *   node scripts/dev-token.mjs                      # employee@aems.local
 *   node scripts/dev-token.mjs admin@aems.local
 *   node scripts/dev-token.mjs someone@corp.com 'their-password'
 *
 * Tokens expire in an hour. Re-run it when enrolment starts returning 401.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fromEnvFile(key) {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return undefined;
  // Deliberately not pulling in dotenv: this script has to run before anyone has
  // installed anything, which is exactly when it is most useful.
  const line = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
}

const url = process.env.SUPABASE_URL ?? fromEnvFile("SUPABASE_URL");
const anonKey = process.env.SUPABASE_ANON_KEY ?? fromEnvFile("SUPABASE_ANON_KEY");
const email = process.argv[2] ?? "employee@aems.local";
const password = process.argv[3] ?? "aems-demo-2026";

if (!url || !anonKey) {
  console.error("Missing SUPABASE_URL / SUPABASE_ANON_KEY. Copy .env.example to .env first.");
  process.exit(1);
}

const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: anonKey, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});

const body = await response.json();

if (!response.ok) {
  console.error(`Sign-in failed (${response.status}): ${body.error_description ?? body.msg ?? ""}`);
  process.exit(1);
}

console.error(`# ${email} — expires in ${body.expires_in}s`);
// Token on stdout alone, so `node scripts/dev-token.mjs | clip` pipes cleanly.
console.log(body.access_token);
