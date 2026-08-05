#!/usr/bin/env node
/**
 * End-to-end smoke test. Answers one question: does the whole chain work?
 *
 *   1. start the API   ->  pnpm --filter @aems/api dev
 *   2. run this        ->  node scripts/smoke.mjs
 *
 * It signs in for real against Supabase Auth, then calls every endpoint the
 * dashboard uses with a real token, and finally checks that an employee is
 * actually refused other people's data. That last group is the important one:
 * `app.supabase` is the service-role client and bypasses RLS, so on the API path
 * these checks are the only thing standing between an employee and the whole
 * company. Unit tests prove the decision function; this proves the wiring.
 *
 * Exit code 0 means everything a demo touches responded correctly.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function env(key) {
  if (process.env[key]) return process.env[key];
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return undefined;
  const line = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
}

const SUPABASE_URL = env("SUPABASE_URL");
const ANON = env("SUPABASE_ANON_KEY");
const API = env("AEMS_API_URL") ?? "http://localhost:3001";
const PASSWORD = "aems-demo-2026";

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

function bail(message, hint) {
  console.error(`\nCannot run: ${message}`);
  if (hint) console.error(`\n${hint}`);
  process.exit(2);
}

// -- preconditions -----------------------------------------------------------

if (!SUPABASE_URL || !ANON) bail("SUPABASE_URL / SUPABASE_ANON_KEY missing from .env");

if (!env("SUPABASE_SERVICE_ROLE_KEY")) {
  bail(
    "SUPABASE_SERVICE_ROLE_KEY is empty in .env",
    "Copy it from the Supabase dashboard:\n" +
      "  https://supabase.com/dashboard/project/dayyrqcfktwwnkttlres/settings/api-keys\n" +
      "(the service_role row — reveal it). The API will not start without it.",
  );
}

let health;
try {
  health = await fetch(`${API}/health`, { signal: AbortSignal.timeout(5000) });
} catch {
  bail(`the API is not answering on ${API}`, "Start it first:\n  pnpm --filter @aems/api dev");
}
if (!health.ok) bail(`GET /health returned ${health.status}`);

async function signIn(email) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await response.json();
  if (!response.ok) {
    bail(
      `could not sign in as ${email} (${response.status})`,
      "Seed the demo accounts first — supabase/seed/demo.sql",
    );
  }
  return body.access_token;
}

async function call(token, urlPath) {
  const response = await fetch(`${API}${urlPath}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* a download route may not be JSON; status is what we assert on */
  }
  return { status: response.status, body };
}

const describe = (body) =>
  Array.isArray(body) ? `${body.length} rows` : body === null ? "null" : "ok";

// -- run ---------------------------------------------------------------------

console.log(`API      ${API}`);
console.log(`Supabase ${SUPABASE_URL}\n`);

const admin = await signIn("admin@aems.local");
const employee = await signIn("employee@aems.local");
record("sign in (admin + employee)", true);

// The route answers `{ profile: {...} }`, not a bare profile.
const me = await call(employee, "/api/auth/me");
const selfId = me.body?.profile?.id;
record(
  "GET /api/auth/me",
  me.status === 200 && Boolean(selfId),
  me.status === 200 ? `${me.body?.profile?.email ?? "?"}` : `status ${me.status}`,
);

if (!selfId) {
  bail(
    "could not read the signed-in employee's profile id",
    "The account exists in auth.users but has no row in public.profiles.\n" +
      "Re-run supabase/seed/demo.sql.",
  );
}

const today = new Date();
const from = new Date(today).setHours(0, 0, 0, 0);
const to = new Date(today).setHours(23, 59, 59, 0);
const range = `from=${new Date(from).toISOString()}&to=${new Date(to).toISOString()}`;

console.log("\nAdmin — every endpoint the dashboard calls:");
for (const [label, urlPath] of [
  ["employees roster", "/api/employees"],
  ["devices", "/api/devices"],
  ["live workforce", "/api/analytics/live"],
  ["dashboard overview", "/api/analytics/overview"],
  ["policy (settings)", "/api/policies/current"],
  ["AI insights", "/api/analytics/insights?kind=insight"],
  ["reports", "/api/reports"],
  ["report types", "/api/reports/types"],
  ["timeline", `/api/analytics/timeline?profileId=${selfId}&${range}`],
  ["screenshot blocks", `/api/screenshots/blocks?profileId=${selfId}&${range}`],
]) {
  const { status, body } = await call(admin, urlPath);
  record(label, status === 200, status === 200 ? describe(body) : `status ${status}`);
}

console.log("\nEmployee — the boundary (RLS does NOT cover this path):");
const OTHER = "00000000-0000-4000-8000-0000000000ff";
for (const [label, urlPath, want] of [
  ["reads own timeline", `/api/analytics/timeline?profileId=${selfId}&${range}`, 200],
  ["reads own daily summary", `/api/analytics/insights?kind=daily&profileId=${selfId}`, 200],
  ["refused someone else's timeline", `/api/analytics/timeline?profileId=${OTHER}&${range}`, 403],
  ["refused someone else's summary", `/api/analytics/insights?kind=daily&profileId=${OTHER}`, 403],
  ["refused the company insight", "/api/analytics/insights?kind=insight", 403],
  ["refused the employee roster", "/api/employees", 403],
  ["rejects a summary with no profileId", "/api/analytics/insights?kind=daily", 400],
]) {
  const { status } = await call(employee, urlPath);
  record(label, status === want, `expected ${want}, got ${status}`);
}

// -- verdict -----------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);

if (failed.length > 0) {
  console.error(`\n${failed.length} failed:`);
  for (const f of failed) console.error(`  ${f.name} — ${f.detail}`);
  process.exit(1);
}

console.log("Everything the demo touches responded correctly.");
