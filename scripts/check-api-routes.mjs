#!/usr/bin/env node
/**
 * Every `/api/...` path a client calls must be a route the Fastify server registers.
 *
 * `check-wiring.mjs` validates the API against the *database*. Nothing validated the
 * dashboard and the SDK against the *API*, and that gap shipped: the dashboard called
 * `GET /api/analytics/insights` and `GET /api/policies/current`, neither of which
 * existed. Both degrade to a 404 that the UI renders as an empty state, so the AI
 * Insights page and the Settings policy block were permanently blank while nothing
 * anywhere reported an error. Typecheck cannot catch it — a URL is a string.
 *
 *   node scripts/check-api-routes.mjs
 *
 * Exits non-zero on the first unmatched path.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = path.join(root, "apps/api/src");

/** `:profileId` and a `${expr}` interpolation are the same thing to a router. */
function normalise(route) {
  return route
    .replace(/\$\{[^}]*\}/g, ":p")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ":p")
    .replace(/\/+$/, "");
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", ".next", "dist", ".turbo"].includes(entry.name)) walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// -- what the server actually serves ----------------------------------------

const server = fs.readFileSync(path.join(API, "server.ts"), "utf8");

// `import { employeeRoutes } from "./routes/employees.js"` -> employeeRoutes: employees
const moduleOf = new Map();
for (const m of server.matchAll(/import\s*\{\s*(\w+)\s*\}\s*from\s*"\.\/routes\/([\w-]+)\.js"/g)) {
  moduleOf.set(m[1], m[2]);
}

// `app.register(employeeRoutes, { prefix: "/api/employees" })`
const prefixOf = new Map();
for (const m of server.matchAll(/register\(\s*(\w+)\s*,\s*\{\s*prefix:\s*"([^"]+)"/g)) {
  const file = moduleOf.get(m[1]);
  if (file) prefixOf.set(file, m[2]);
}

const served = new Set();

// Routes declared directly on the root instance, e.g. `/health`.
for (const m of server.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
  served.add(`${m[1].toUpperCase()} ${normalise(m[2])}`);
}

for (const [file, prefix] of prefixOf) {
  const source = fs.readFileSync(path.join(API, "routes", `${file}.ts`), "utf8");
  for (const m of source.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
    served.add(`${m[1].toUpperCase()} ${normalise(prefix + m[2])}`);
  }
}

// -- what the clients call ---------------------------------------------------

const callers = [
  ["admin-dashboard", path.join(root, "apps/admin-dashboard/src")],
  ["sdk", path.join(root, "packages/sdk/src")],
];

const problems = [];
let checked = 0;

for (const [label, dir] of callers) {
  if (!fs.existsSync(dir)) continue;

  for (const file of walk(dir)) {
    const source = fs.readFileSync(file, "utf8");

    // A path literal in a string or template, up to the query string.
    for (const m of source.matchAll(/["'`](\/api\/[^"'`?\s]*)/g)) {
      const url = normalise(m[1]);
      checked += 1;

      // The verb is rarely adjacent to the URL, so a path served by ANY method is
      // accepted. This finds routes that do not exist at all — the failure that
      // actually happened — without inventing a method-matching heuristic that
      // would produce false positives on every helper that takes a method.
      if ([...served].some((r) => r.endsWith(` ${url}`))) continue;

      const line = source.slice(0, m.index).split("\n").length;
      problems.push({
        where: `${path.relative(root, file)}:${line}`,
        url: m[1],
        label,
      });
    }
  }
}

if (problems.length > 0) {
  console.error(`FAIL - ${problems.length} client call(s) hit no registered route:\n`);
  for (const p of problems) console.error(`  ${p.where}\n    calls ${p.url}  (${p.label})`);
  console.error(`\nServed routes (${served.size}):`);
  for (const r of [...served].sort()) console.error(`  ${r}`);
  process.exit(1);
}

console.log(`checked ${checked} client call sites against ${served.size} registered routes`);
console.log("api routes OK - every /api path a client calls is served");
