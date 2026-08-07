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

`user_metadata.must_change_password` on the Supabase user.

**Revised after review.** The first draft put it in `app_metadata` and had a new
`POST /api/auth/password` set the password and clear the flag together, because
`app_metadata` is writable only by the service role. `components/me/password.ts`
already argues against that, and the argument holds:

> `apps/api` holds the service-role key. Routing a password through it would mean the
> server … being trusted with a plaintext credential it has no reason to see — and it
> would need a second privileged endpoint that can set anyone's password, which is a
> far worse thing to own than the feature is worth.

So no route, and no plaintext through our service. The browser makes **one** call to
the identity provider under the person's own session:

```ts
await supabase.auth.updateUser({
  password: newPassword,
  data: { must_change_password: false },
});
```

A `profiles` column was also rejected: migrations `…0005` and `…0011` both exist
*because* a new column there opened a self-update hole, and `CLAUDE.md` requires
re-running the 35-test RLS suite after any new column on `profiles`. No migration means
no RLS risk and no suite re-run. Metadata rides in the JWT, so the middleware reads it
with no query either way.

### What the flag is, and what it is not

`user_metadata` is writable by the user, so **someone could clear the flag without
choosing a new password.** That is accepted deliberately.

The flag exists because a temporary password passed through a third party — the admin
read it aloud. The only person harmed by skipping the change is the account owner,
whose password that admin already knows. It is a prompt, not a boundary against the
account holder, and there is no threat model in which a user attacks themselves.

Making it tamper-proof means `app_metadata`, which means a privileged endpoint that can
set any user's password. That endpoint is a materially worse thing to own than an
employee who declines a prompt.

### Changes

| File | Change |
| --- | --- |
| `apps/api/src/routes/employees.ts` | `createAccount` adds `must_change_password: true` to the `user_metadata` it already sets |
| `apps/admin-dashboard/src/middleware.ts` | One clause in the existing gate: flag set and not already on `/set-password` → redirect there |
| `apps/admin-dashboard/src/app/set-password/` | New page, outside `(app)` so it renders without the sidebar |
| `apps/admin-dashboard/src/lib/session.ts` | `/set-password` recognised so the middleware cannot loop on it |

No new API route. Enforcement is in the middleware because that is the one gate every
page passes through; a client-side redirect would be bypassed by typing `/people`.

### The detail that would break it

After `updateUser` returns, the browser's JWT still carries the old metadata. The page
must call `supabase.auth.refreshSession()` before navigating, or the middleware sends
it straight back to `/set-password`.

---

## Part 2 — forgot password

- `/forgot-password` — public. Calls
  `resetPasswordForEmail(email, { redirectTo: <origin>/reset-password })`.
- `/reset-password` — public. Supabase puts a recovery session in the URL fragment;
  the page then makes the same one `updateUser` call `/set-password` makes.
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
- **`createAccount`:** the created user carries `must_change_password: true` without
  losing the `full_name` already in `user_metadata`.
- **Pages:** `/set-password` sends the password and the cleared flag in one
  `updateUser` call and refreshes the session before navigating; `/forgot-password`
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
