# Password lifecycle — design

**Status:** approved 2026-08-07. Build both parts.

This is a working spec, not one of the four governing documents. `docs/stack.md`,
`docs/scope.md`, `docs/design.md` and `docs/inspiration.md` are unchanged.

---

## The problem

Two gaps found while walking each role through the product on 2026-08-07:

1. **There is no password reset of any kind.** No link on the login page, no endpoint
   in `apps/api/src/routes/auth.ts` (which has four routes, all consent-related), and
   no admin-side reset either. An employee who forgets their password cannot recover
   it, and neither can anyone help them without opening the Supabase dashboard.
2. **A temporary password becomes the permanent one.** `POST /api/employees` generates
   a password, shows it once to the admin (`add-person-dialog.tsx:126`), and the admin
   reads it out. Nothing ever asks the employee to replace it, so a credential that
   passed through a third party over Slack stays valid indefinitely.

## Decisions taken

| Decision | Alternative rejected | Why |
| --- | --- | --- |
| Reset runs on **Supabase's built-in email**, not an admin-mediated queue | An in-dashboard request queue the admin services by hand | Far less code — no request table, no admin inbox, no relay step. Costs an SMTP dependency the client must supply. |
| A temporary password exists **only at account creation** | Also an admin "reset password" button | One code path to force a change, one place a plaintext password is displayed. Someone who cannot reach their mailbox gets their address corrected by an admin and uses the link. |
| Both parts ship together | Part 1 alone until SMTP exists | Part 2 is small once Part 1 exists — they share one route — and it starts working when SMTP appears with no further code. |

**Part 2 is inert until SMTP is configured** in Supabase → Auth → Settings. That is
client infrastructure, not code. Part 1 works immediately and does not depend on it.

---

## Part 1 — forced password change

### Where the flag lives

`app_metadata.must_change_password` on the Supabase user. **Not** a column on
`profiles`, and not `user_metadata`.

- `user_metadata` is writable by the user through `updateUser({ data })`. They could
  clear their own flag. `app_metadata` is writable only by the service role.
- A `profiles` column would need the `SECURITY DEFINER` self-update function amended.
  Migrations `…0005` and `…0011` both exist *because* a new column on `profiles`
  opened a self-update hole, and `CLAUDE.md` requires re-running the 35-test RLS suite
  after any new column there. No migration means no RLS risk and no suite re-run.
- It rides in the JWT, so the middleware reads it with no extra query.

### Changes

| File | Change |
| --- | --- |
| `apps/api/src/routes/employees.ts` | `createAccount` passes `app_metadata: { must_change_password: true }` to `admin.auth.createUser` |
| `apps/admin-dashboard/src/middleware.ts` | One clause in the existing gate: flag set and not already on `/set-password` → redirect there |
| `apps/api/src/routes/auth.ts` | New `POST /api/auth/password`: sets the password **and** clears the flag |
| `apps/admin-dashboard/src/app/set-password/` | New page, outside `(app)` so it renders without the sidebar |
| `apps/admin-dashboard/src/lib/session.ts` | `/set-password` joins the public-path set only insofar as the middleware must not loop on it |

Enforcement is in the middleware because that is the one gate every page passes
through. A client-side redirect would be bypassed by typing `/people` directly.

Clearing the flag must happen in the API because it needs the service-role key. The
same route sets the password, so the page makes one call rather than two.

### The detail that would break it

After the flag is cleared, the browser's JWT still carries the old `app_metadata`. The
page must call `supabase.auth.refreshSession()` before navigating, or the middleware
sends it straight back to `/set-password`.

---

## Part 2 — forgot password

- `/forgot-password` — public. Calls
  `resetPasswordForEmail(email, { redirectTo: <origin>/reset-password })`.
- `/reset-password` — public. Supabase puts a recovery session in the URL fragment;
  the page then calls the same `POST /api/auth/password`.
- `isPublicPath` gains both routes.

**Always answer "If that address is registered, a link is on its way"**, whether or
not the account exists. Confirming an address on a workforce-monitoring product tells
an attacker who works there.

Reusing the same route also settles an edge case: a new employee who ignores their
temporary password and uses the reset link instead has their `must_change_password`
flag cleared by the same call, so they are not asked to change it a second time.

---

## Testing

- **Middleware:** flag set → redirect; flag clear → pass; already on `/set-password` →
  no redirect loop; unauthenticated → still `/login`, unchanged.
- **`POST /api/auth/password`:** rejects a password failing the existing rules in
  `components/me/password.ts`; clears the flag; refuses without a session; refuses to
  act on any user but the caller.
- **Pages:** `/set-password` submits and refreshes the session; `/forgot-password`
  returns the same message for a known and an unknown address.

No RLS suite re-run — nothing touches `profiles`.

---

## Out of scope

- Admin-initiated password reset (decided against; see the table above)
- Password expiry or rotation policy
- Any change to how the desktop or Android agent authenticates — those use device
  tokens and enrolment codes, not passwords

## Related

Leaked-password protection (`CLAUDE.md` open item 9) is a Supabase dashboard toggle
under Auth → Policies that rejects passwords found in the HaveIBeenPwned corpus. It is
not code and not part of this work, but it belongs to the same decision and is the
cheapest real security win available before the demo.
