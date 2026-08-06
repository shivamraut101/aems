#!/usr/bin/env node
/** Decomposes the per-request fixed cost: what does each Supabase round trip cost? */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = (k) =>
  process.env[k] ??
  fs.readFileSync(path.join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${k}=`))
    ?.slice(k.length + 1)
    .trim()
    .replace(/^["']|["']$/g, "");

const URL_ = env("SUPABASE_URL");
const ANON = env("SUPABASE_ANON_KEY");
const SRK = env("SUPABASE_SERVICE_ROLE_KEY");

const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email: "admin@aems.local", password: "aems-demo-2026" }),
});
const token = (await r.json()).access_token;

const N = 10;
const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function bench(label, fn) {
  await fn();
  const t = [];
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    await fn();
    t.push(performance.now() - s);
  }
  console.log(`${label.padEnd(52)} ${med(t).toFixed(0).padStart(5)} ms`);
}

console.log(`\nDirect Supabase round trips from this machine (${URL_}), median of ${N}:\n`);

await bench("GoTrue  GET /auth/v1/user       (resolveSession leg 1)", () =>
  fetch(`${URL_}/auth/v1/user`, {
    headers: { apikey: SRK, Authorization: `Bearer ${token}` },
  }).then((x) => x.arrayBuffer()),
);

await bench("PostgREST GET /profiles?id=eq.. (resolveSession leg 2)", () =>
  fetch(`${URL_}/rest/v1/profiles?select=id,company_id,email,role,deactivated_at&limit=1`, {
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  }).then((x) => x.arrayBuffer()),
);

await bench("PostgREST GET /activity_events  (one handler query)", () =>
  fetch(`${URL_}/rest/v1/activity_events?select=id&limit=1`, {
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  }).then((x) => x.arrayBuffer()),
);

await bench("Storage POST /object/sign/aems  (screenshot signing)", () =>
  fetch(`${URL_}/storage/v1/object/sign/aems`, {
    method: "POST",
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 600, paths: ["a/b/c.webp"] }),
  }).then((x) => x.arrayBuffer()),
);

await bench("5 PostgREST queries in parallel (Promise.all)", () =>
  Promise.all(
    ["activity_events", "idle_events", "break_events", "work_sessions", "screenshots"].map((t) =>
      fetch(`${URL_}/rest/v1/${t}?select=id&limit=1`, {
        headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
      }).then((x) => x.arrayBuffer()),
    ),
  ),
);

await bench("2 PostgREST queries SEQUENTIALLY (the anti-pattern)", async () => {
  await fetch(`${URL_}/rest/v1/activity_events?select=id&limit=1`, {
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  }).then((x) => x.arrayBuffer());
  await fetch(`${URL_}/rest/v1/idle_events?select=id&limit=1`, {
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  }).then((x) => x.arrayBuffer());
});
