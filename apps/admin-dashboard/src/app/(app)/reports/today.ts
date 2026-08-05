/**
 * The calendar day, as the machine rendering the page sees it.
 *
 * Split into its own module because it is called from a server component and
 * `lib/queries/activity.ts` — where `dateKeyOf` lives — is `"use client"`. Importing a
 * client module from `page.tsx` for one date function would pull the whole activity
 * query layer across the boundary.
 *
 * The value it returns is the *server's* day, and that is the point: it seeds the date
 * fields identically on both sides of hydration. A reader east of the deploy region can
 * be on tomorrow already, so `reports-view.tsx` corrects to the browser's day on mount —
 * see the effect there. Seeding straight from `new Date()` in the client component
 * instead would make the server and the first client render disagree, which React
 * reports as a hydration mismatch and repairs by re-rendering the field.
 */
export function serverDateKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
