# Running AEMS locally

Against the hosted Supabase project (`dayyrqcfktwwnkttlres`) — no Docker, no local
Postgres. Everything below has been run on this machine except the two steps that
need the service-role key.

---

## 1. One secret to fill in

`.env` at the repo root is already written and gitignored. Every value is filled in
except one:

```
SUPABASE_SERVICE_ROLE_KEY=""
```

Copy it from
[Project Settings → API keys](https://supabase.com/dashboard/project/dayyrqcfktwwnkttlres/settings/api-keys)
(the `service_role` row — reveal it). It bypasses RLS, which is why it is not
retrievable through the MCP connection and why it must never reach the browser
bundle or an agent binary.

The API refuses to start without it, by design:

```
Invalid API environment:
  SUPABASE_SERVICE_ROLE_KEY: String must contain at least 1 character(s)
```

`apps/admin-dashboard/.env.local` is also written. It holds only `NEXT_PUBLIC_*`
values and needs no edit. It duplicates three keys from the root `.env` because
Next.js reads env files only from its own app directory and will not walk up.
The API does walk up (`apps/api/src/env.ts`), so it reads the root file directly.

---

## 2. Demo data

The database was empty, so every screen rendered its empty state. It is now seeded.

| Account | Password | Role |
| --- | --- | --- |
| `admin@aems.local` | `aems-demo-2026` | Super Admin |
| `manager@aems.local` | `aems-demo-2026` | Manager |
| `employee@aems.local` | `aems-demo-2026` | Employee — owns the device and the data |

Company *Acme Corp*, policy `2026.08.1`, one Windows device `EVAN-WIN11`, a consent
record, a 9am work session, five categorised activity events, one idle span, one
break, telemetry and three installed applications.

To re-seed, reset, or seed a different project: `supabase/seed/demo.sql`. It is
re-runnable and carries its own cleanup statements at the bottom.

> Sign in as each of the three in turn — it is the fastest external check that RLS
> holds. The employee must see only their own rows, the manager the whole company,
> and neither may read the audit log.

---

## 3. Install and run

```sh
pnpm install        # already done on this machine
```

Two terminals:

```sh
pnpm --filter @aems/api dev              # http://localhost:3001
pnpm --filter @aems/admin-dashboard dev  # http://localhost:3000
```

Or `pnpm dev` for the Turborepo fan-out — that also starts the Android agent's
Expo server and the Electron agent, which is usually more than you want.

Check the API is up before opening the dashboard:

```sh
curl http://localhost:3001/health         # {"status":"ok","uptime":...}
```

Then open <http://localhost:3000> and sign in as `admin@aems.local`.

### Is it actually working?

With the API running:

```sh
pnpm smoke
```

It signs in for real, calls every endpoint the dashboard uses, and then checks that
an employee is genuinely refused other people's data. That last group matters more
than it looks: the API talks to Supabase with the **service-role key, which bypasses
RLS**, so on this path the route guards are the only thing between an employee and
the whole company. Unit tests prove the decision; this proves the wiring.

It tells you what to fix when it cannot run — a missing service-role key and an API
that is not started are separate, named errors, not one generic failure.

---

## 4. Desktop agent

```sh
pnpm --filter @aems/desktop-agent dev
```

It defaults to `http://localhost:3001`, so start the API first.

The login screen asks for an **access token**, not an email and password — the agent
is never given a credential it could leak. Mint one:

```sh
node scripts/dev-token.mjs                  # employee@aems.local
node scripts/dev-token.mjs admin@aems.local
```

Paste the token to enrol. Tokens last an hour; re-run when enrolment starts
returning 401.

After enrolling you land on the **consent gate**, which is not skippable — that is
non-negotiable #1, and there is deliberately no "later" or "skip" affordance. Accept
it and collection starts: tray icon, always-on-top indicator, screenshots every five
minutes, focus tracking, idle after two minutes without input.

The device is already seeded with a consent record, so enrolling the *same* device
row may take you straight past the gate. To exercise the gate itself, revoke first:

```sql
update public.consent_records set revoked_at = now()
where device_id = 'd0000000-0000-4000-8000-000000000001';
```

---

## 5. What you will and will not see

Working, with the seed loaded: the dashboard overview, live workforce status,
the employee timeline, app and website breakdowns, device inventory.

Not working locally without extra setup:

- **AI insights** — the page and its read endpoint work, but the seed contains no
  `ai_summaries` rows, so it shows its empty state until the worker has run. Writing
  summaries needs `ANTHROPIC_API_KEY` in `.env` and the `ai-summary` Edge Function
  deployed.
- **Screenshots from the agent** — upload works, but the seed contains no screenshot
  rows, so the gallery is empty until an agent runs for a few minutes.
- **Website tracking on Windows** — `get-windows` reads browser URLs via AppleScript,
  macOS only. On Windows the domain column stays empty. This is CLAUDE.md open item 6
  and needs a client decision, not a code fix.

---

## 6. Cleaning up the demo data

```sql
delete from public.companies where id = 'c0000000-0000-4000-8000-000000000001';
delete from auth.users where email like '%@aems.local';
```

The first cascades to every business row; the second cascades to the profiles.
