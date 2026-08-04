#!/usr/bin/env node
/**
 * Static wiring check: every Supabase table, column and embed referenced by the
 * API and the Edge Functions must exist in the real schema.
 *
 * Why this exists: supabase-js takes table and column names as STRINGS. A typo in
 * `.from("activity_event")` or `.eq("profileId", ...)` typechecks perfectly and
 * fails at runtime, usually as an empty result rather than an error — so it looks
 * like "no data" instead of "broken query". TypeScript cannot catch this class of
 * bug and neither can a unit test with a mocked client.
 *
 * Usage:
 *   node scripts/check-wiring.mjs                 # check against the committed snapshot
 *   node scripts/check-wiring.mjs --print-schema  # emit the SQL to refresh the snapshot
 *
 * The snapshot below must be regenerated whenever a migration changes the schema.
 * Run the query printed by --print-schema and paste the result back in.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SCHEMA_QUERY = `select table_name || ':' || string_agg(column_name, ',' order by ordinal_position)
from information_schema.columns
where table_schema='public'
group by table_name order by table_name;`

if (process.argv.includes('--print-schema')) {
  console.log(SCHEMA_QUERY)
  process.exit(0)
}

// Snapshot of the live schema. Last refreshed 2026-08-05 against project
// dayyrqcfktwwnkttlres after migration 20260805000006.
const SCHEMA = {
  activity_events: 'id,company_id,profile_id,device_id,work_session_id,app_name,window_title,url,category,started_at,ended_at,client_event_id,created_at,domain',
  ai_summaries: 'id,company_id,profile_id,kind,period_start,period_end,provider,model,content,created_at',
  audit_log_entries: 'id,company_id,actor_id,action,target_type,target_id,metadata,created_at',
  break_events: 'id,company_id,profile_id,device_id,work_session_id,break_start_at,break_end_at,duration_seconds,client_event_id,created_at',
  companies: 'id,name,created_at,updated_at',
  consent_records: 'id,company_id,profile_id,device_id,policy_version,method,ip_address,consented_at,revoked_at',
  device_applications: 'id,company_id,device_id,name,version,identifier,first_seen_at,last_seen_at',
  device_telemetry: 'id,company_id,device_id,recorded_at,battery_level,battery_charging,network_type,storage_free_mb,screen_active_seconds',
  devices: 'id,company_id,profile_id,platform,label,os_version,agent_version,enrolled_at,last_seen_at,status,created_at,updated_at,device_name,model,cpu,ram_mb,storage_mb',
  idle_events: 'id,company_id,profile_id,device_id,idle_start_at,idle_end_at,duration_seconds,client_event_id,created_at',
  policies: 'id,company_id,version,name,screenshot_interval_seconds,idle_threshold_seconds,tracked_categories,created_at,updated_at',
  profiles: 'id,company_id,email,full_name,role,department,created_at,updated_at,manager_id,monitoring_enabled',
  reports: 'id,company_id,profile_id,kind,period_start,period_end,status,storage_path,created_at,updated_at',
  screenshots: 'id,company_id,profile_id,device_id,work_session_id,captured_at,storage_path,thumbnail_path,blurred,client_event_id,created_at',
  work_sessions: 'id,company_id,profile_id,device_id,clock_in_at,clock_out_at,created_at',
}

/** Storage bucket ids, which share the .from() call shape but are not tables. */
const BUCKETS = new Set(['aems'])

const cols = Object.fromEntries(Object.entries(SCHEMA).map(([t, c]) => [t, new Set(c.split(','))]))
const tables = new Set(Object.keys(SCHEMA))

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.next'].includes(entry)) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

const files = [...walk('apps/api/src'), ...walk('supabase/functions')]
const problems = []
let nTables = 0
let nCols = 0

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const lineAt = (i) => src.slice(0, i).split('\n').length

  // A query chain runs from one .from() to the next. Scoping by line window
  // instead would bleed across the sibling queries inside a Promise.all.
  const froms = [...src.matchAll(/\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g)]

  for (let k = 0; k < froms.length; k += 1) {
    const table = froms[k][1]
    const start = froms[k].index
    const chain = src.slice(start, k + 1 < froms.length ? froms[k + 1].index : src.length)

    if (BUCKETS.has(table)) continue
    nTables += 1

    if (!tables.has(table)) {
      problems.push(`${file}:${lineAt(start)}  unknown table .from('${table}')`)
      continue
    }

    for (const m of chain.matchAll(/\.(eq|neq|gte|lte|gt|lt|is|like|ilike)\(\s*["'`]([a-z_]+)["'`]/g)) {
      nCols += 1
      if (!cols[table].has(m[2])) {
        problems.push(`${file}:${lineAt(start + m.index)}  ${table}.${m[2]} does not exist`)
      }
    }

    const select = chain.match(/\.select\(\s*"([^"]+)"/)
    if (!select || select[1] === '*') continue
    let body = select[1]

    // embedded relations: profiles!inner(id, email), devices(*)
    for (const rel of body.matchAll(/([a-z_]+)!?\w*\(([^)]*)\)/g)) {
      const name = rel[1]
      if (!tables.has(name)) {
        problems.push(`${file}:${lineAt(start)}  unknown embed ${table} -> ${name}()`)
        continue
      }
      for (const c of rel[2].split(',').map((s) => s.trim()).filter(Boolean)) {
        if (c === '*') continue
        nCols += 1
        if (!cols[name].has(c)) {
          problems.push(`${file}:${lineAt(start)}  ${name}.${c} does not exist (embedded)`)
        }
      }
    }

    body = body.replace(/[a-z_]+!?\w*\([^)]*\)/g, '')
    for (const c of body.split(',').map((s) => s.trim()).filter(Boolean)) {
      const name = c.split(/[:\s]/)[0]
      if (!name || name === '*') continue
      nCols += 1
      if (!cols[table].has(name)) {
        problems.push(`${file}:${lineAt(start)}  ${table}.${name} does not exist (select)`)
      }
    }
  }
}

console.log(`checked ${files.length} files: ${nTables} table refs, ${nCols} columns`)

if (problems.length === 0) {
  console.log('wiring OK - every table, column and embed resolves against the schema')
  process.exit(0)
}

for (const p of problems) console.error(`  ${p}`)
console.error(`\n${problems.length} wiring problem(s)`)
process.exit(1)
