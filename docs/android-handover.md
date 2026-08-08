# Android agent — handover

`apps/android-agent` is being handed to a dedicated developer. Nothing in it has been
changed since that decision, deliberately: two changes were written and then reverted
rather than pushed into an app somebody else is about to take ownership of.

This file records what those changes were, why they exist, and what breaks if they are
never applied. It is a to-do list for whoever picks the app up, not a description of
code that is there.

---

## 1. The forgotten-break limit is now an admin setting

**Status: applied to desktop and the dashboard. NOT applied to Android.**

A break left open is how an evening gets recorded as tracked time — somebody declares a
break at 18:00, shuts the lid, and the day accrues until they come back. Both agents
guard against it by treating a break running longer than a limit as one the employee
forgot to end, and closing the day *backdated to when the break began*.

That limit used to be a constant in each agent, kept in sync only by a comment. It is now
`policies.max_open_break_seconds` (migration `…0019`), chosen by a super admin in
**Settings → Monitoring policy**, versioned and audited like every other policy field.

### What Android needs

The policy already reaches the phone — `credentials.policy` is loaded in `sync.ts`
before the break check runs. Three edits:

| File | Change |
| --- | --- |
| `src/day.ts` | `MAX_OPEN_BREAK_MS` → `DEFAULT_MAX_OPEN_BREAK_SECONDS`, value `5 * 60 * 60` |
| `src/session.ts` | `closeForgottenBreak` takes the limit as a parameter rather than reading the constant |
| `src/sync.ts` | pass `credentials.policy.maxOpenBreakSeconds` into it |
| `src/api.ts` | carry `maxOpenBreakSeconds` through the stored policy |

Two things to keep, because both are load-bearing:

- **`maxOpenBreakSeconds` is optional on `AgentPolicy`.** A policy stored before the
  column existed has no value for it. Reading that absence as "no limit" restores exactly
  the overnight-billing bug the guard was added for — fall back to the 5-hour default.
- **Take the value as a parameter, do not re-read it.** `sync.ts` already holds the
  policy; a second read is a second source, and the two eventually disagree.

### If it is never applied

The phone keeps a hard 5-hour limit while desktop honours whatever the admin set. The
same forgotten break then ends the day at different times depending on which device the
person happens to carry — a discrepancy that is much harder to find later than this diff
is to apply now.

---

## 2. Four unused permissions are blocked

**Status: applied.** `app.json` gained a `blockedPermissions` list covering
`SYSTEM_ALERT_WINDOW`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE` and `VIBRATE` —
Expo module defaults that the app never uses. On a monitoring product, "draw over other
apps" and full storage access are precisely what an employee inspecting the permission
list objects to, and defending capabilities the product does not use is a bad position
for no benefit.

The mechanism is `tools:node="remove"`, applied by the manifest merger, so the entries
stay visible in the generated manifest and never reach the installed app. **They are
re-added by Expo on every prebuild** — deleting the lines by hand lasts until the next
`expo prebuild` and no longer.

---

## 3. Things to know before changing anything

- **`expo prebuild --clean` is required** after any `app.json` permission change, and
  `android/` is gitignored and fully generated. The Kotlin modules live in `modules/`,
  outside it, so a clean prebuild is safe.
- **Location is live.** `ACCESS_BACKGROUND_LOCATION` is requested and granted; points are
  reaching `location_points`. Background location triggers a manual Google Play review,
  and Android only grants it from Settings, never from an in-app prompt.
- **Location sampling is throttled** — at most one fix every five minutes, and only when
  the phone has moved >150m or fifteen minutes have passed. The keepalive is what stops
  "did not move" being indistinguishable from "stopped reporting". Before this it sampled
  every 60s, which was 1,440 rows per phone per day.
- **There are no tests in this app at all.** Every other package has them; this one rests
  entirely on typecheck. That is the single biggest risk in handing it over.
- **`EXPO_PUBLIC_*` is inlined at build time.** See `apps/android-agent/.env.example`.
  An APK built with `EXPO_PUBLIC_AEMS_MOCK_API=1` looks like it works and talks to
  nothing.

---

## 4. Per-device collection scope — already handled, no Android work needed

An admin now chooses which data types a device may collect when its enrolment code is
minted, and can change it later. The phone needs no change for this: enforcement is
server-side on every ingest route, so a type an admin switched off is refused whatever
the agent sends. Honouring it agent-side as well would save a wasted request and is
worth doing eventually, but nothing is collected that should not be.
