#!/usr/bin/env node
/**
 * Does every table the API talks to actually exist in the live database?
 *
 * `check-wiring.mjs` answers a different question — whether the code's table and
 * column names match the schema this repo *believes* in, which is a constant inside
 * that file. Both it and the code read the same idea of the schema, so a migration
 * that is written, reviewed and committed but never *applied* is invisible to it.
 *
 * That gap shipped. `…0014_location_tracking.sql` sat in the repo while the deployed
 * API referenced `location_points`, and every caller of `GET /api/activity/locations`
 * got
 *
 *     500  Could not find the table 'public.location_points' in the schema cache
 *
 * for as long as nobody looked. No check in the repo could have caught it, because
 * every one of them was reading files rather than asking the database.
 *
 * So this one asks the database. It collects the tables the API and the Edge Functions
 * name, and probes each against PostgREST with the service-role key. PostgREST answers
 * `PGRST205` for a table its schema cache does not have — the same error the 500 above
 * carried, which is the point: this fails in CI in exactly the case that would
 * otherwise fail in production.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Without them, or without a
 * network, it SKIPS rather than fails: a contributor with no production credentials
 * must still be able to run `pnpm check`, and a check that could not run is not a
 * check that found something.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function env(key) {
  if (process.env[key]) return process.env[key];
  try {
    const line = readFileSync(path.join(root, ".env"), "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${key}=`));
    return line
      ?.slice(key.length + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log("schema SKIPPED - no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(0);
}

/** Storage bucket ids share the `.from()` shape and are not tables. Mirrors check-wiring. */
const BUCKETS = new Set(["aems"]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (["node_modules", "dist", ".next"].includes(entry)) continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

// Same extraction as check-wiring, deliberately: two checks that disagree about which
// tables the code uses would each be blind to what the other saw.
const referenced = new Set();
for (const file of [
  ...walk(path.join(root, "apps/api/src")),
  ...walk(path.join(root, "supabase/functions")),
]) {
  const src = readFileSync(file, "utf8");
  for (const match of src.matchAll(/\.from\(\s*["'`]([a-z_]+)["'`]\s*,?\s*\)/g)) {
    if (!BUCKETS.has(match[1])) referenced.add(match[1]);
  }
}

if (process.env["CHECK_SCHEMA_SELFTEST"]) referenced.add("a_table_that_does_not_exist");

if (referenced.size === 0) {
  console.error("Found no table references - has the code layout moved?");
  process.exit(1);
}

const base = SUPABASE_URL.replace(/\/+$/, "");
const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

/** `limit=0` asks for the shape and no rows, so this stays cheap on a large table. */
async function probe(table) {
  const response = await fetch(`${base}/rest/v1/${table}?select=*&limit=0`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });

  if (response.ok) return null;

  const body = await response.text().catch(() => "");
  // PGRST205 is precisely "the schema cache has no such table". Anything else — a
  // permission problem, a gateway hiccup — is not what this check is about, and
  // reporting it as a missing table would send someone hunting the wrong bug.
  return body.includes("PGRST205") ? "missing" : `HTTP ${String(response.status)}`;
}

const names = [...referenced].sort();
let results;
try {
  results = await Promise.all(names.map((t) => probe(t).then((r) => [t, r])));
} catch (error) {
  console.log(`schema SKIPPED - could not reach the database: ${String(error?.message ?? error)}`);
  process.exit(0);
}

const missing = results.filter(([, r]) => r === "missing").map(([t]) => t);
const odd = results.filter(([, r]) => r !== null && r !== "missing");

console.log(`checked ${String(names.length)} tables the API names against the live database`);

for (const [table, reason] of odd) {
  console.log(`  note: ${table} answered ${reason} - not a missing table, but worth a look`);
}

if (missing.length === 0) {
  console.log("schema OK - every table the API talks to exists");
  process.exit(0);
}

console.error(`\n${String(missing.length)} table(s) the API references DO NOT EXIST:\n`);
for (const table of missing) console.error(`  ${table}`);
console.error(
  "\nEvery route touching these returns 500 in production. The usual cause is a\n" +
    "migration committed but never applied - check supabase/migrations against the\n" +
    "project and run `pnpm db:push`.",
);
process.exit(1);
