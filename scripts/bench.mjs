#!/usr/bin/env node
/**
 * Latency harness. Calls every endpoint the dashboard uses with a real admin
 * token, N times each, and reports cold (first call) separately from warm.
 *
 *   node scripts/bench.mjs [runs]
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
const RUNS = Number(process.argv[2] ?? 10);

async function signIn(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "aems-demo-2026" }),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(`sign-in ${email}: ${r.status} ${JSON.stringify(b)}`);
  return b.access_token;
}

const admin = await signIn("admin@aems.local");

// Per-person endpoints are benchmarked against the seeded profile that actually
// HAS screenshots — otherwise the signing round trip is skipped and the timeline
// looks 300 ms faster than it is in real use.
const emps = await (
  await fetch(`${API}/api/employees`, { headers: { Authorization: `Bearer ${admin}` } })
).json();
const selfId = (emps.find((e) => e.email === "shivam@primexmeta.com") ?? emps[0]).id;

const from = "2026-08-05T00:00:00Z";
const to = "2026-08-07T00:00:00Z";
const range = `from=${from}&to=${to}`;
const weekFrom = new Date(Date.parse(to) - 7 * 864e5).toISOString();

/** [label, method, path, body?] — every endpoint the dashboard calls. */
const ENDPOINTS = [
  ["GET  /health", "GET", "/health"],
  ["GET  /api/auth/me", "GET", "/api/auth/me"],
  ["GET  /api/employees", "GET", "/api/employees"],
  ["GET  /api/employees/:id", "GET", `/api/employees/${selfId}`],
  ["GET  /api/devices", "GET", "/api/devices"],
  ["GET  /api/analytics/live", "GET", "/api/analytics/live"],
  ["GET  /api/analytics/overview", "GET", "/api/analytics/overview"],
  ["GET  /api/analytics/timeline", "GET", `/api/analytics/timeline?profileId=${selfId}&${range}`],
  ["GET  /api/analytics/insights", "GET", "/api/analytics/insights?kind=insight"],
  ["GET  /api/analytics/productivity", "GET", `/api/analytics/productivity?profileId=${selfId}&${range}`],
  ["GET  /api/analytics/websites", "GET", `/api/analytics/websites?profileId=${selfId}&${range}`],
  ["GET  /api/screenshots/blocks", "GET", `/api/screenshots/blocks?profileId=${selfId}&${range}`],
  ["GET  /api/screenshots", "GET", `/api/screenshots?profileId=${selfId}&${range}`],
  ["GET  /api/policies/current", "GET", "/api/policies/current"],
  ["GET  /api/reports", "GET", "/api/reports"],
  ["GET  /api/reports/types", "GET", "/api/reports/types"],
  ["GET  /api/activity/categories", "GET", "/api/activity/categories"],
  ["GET  /api/restrictions", "GET", "/api/restrictions"],
  ["GET  /api/restrictions/events", "GET", "/api/restrictions/events?limit=100"],
  [
    "POST /api/reports/run",
    "POST",
    "/api/reports/run",
    { kind: "time_and_activity", scope: "company", periodStart: weekFrom, periodEnd: to },
  ],
];

async function time(method, urlPath, body) {
  const t = performance.now();
  const r = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${admin}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  await r.arrayBuffer();
  return { ms: performance.now() - t, status: r.status };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const f = (n) => n.toFixed(0).padStart(6);

// Cold pass first — one call each, in order, before anything is warm.
const cold = new Map();
for (const [label, method, urlPath, body] of ENDPOINTS) {
  const r = await time(method, urlPath, body);
  cold.set(label, r);
}

// Warm pass INTERLEAVED: one sample of every endpoint per round, so network drift
// over the run hits all endpoints equally instead of being charged to whichever
// happened to be measured while it was slow. Block-ordered timing invented a
// 90 ms difference here that interleaving showed did not exist.
const warm = new Map(ENDPOINTS.map(([l]) => [l, []]));
for (let round = 0; round < RUNS; round++) {
  for (const [label, method, urlPath, body] of ENDPOINTS) {
    warm.get(label).push((await time(method, urlPath, body)).ms);
  }
  process.stderr.write(`round ${round + 1}/${RUNS}\n`);
}

const rows = ENDPOINTS.map(([label]) => {
  const w = warm.get(label).sort((a, b) => a - b);
  return {
    label,
    status: cold.get(label).status,
    cold: cold.get(label).ms,
    min: w[0],
    median: pct(w, 50),
    p95: pct(w, 95),
  };
});

rows.sort((a, b) => b.median - a.median);

console.log(`\nAPI ${API} — ${RUNS} warm runs each, cold call excluded from the stats\n`);
console.log(`${"endpoint".padEnd(34)} ${"st".padStart(4)} ${"cold".padStart(6)} ${"min".padStart(6)} ${"med".padStart(6)} ${"p95".padStart(6)}`);
console.log("-".repeat(70));
for (const r of rows) {
  console.log(`${r.label.padEnd(34)} ${String(r.status).padStart(4)} ${f(r.cold)} ${f(r.min)} ${f(r.median)} ${f(r.p95)}`);
}
