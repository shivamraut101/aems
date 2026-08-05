import { Suspense } from "react";

import { MyActivity } from "@/components/me/my-activity";

export const metadata = {
  title: "My activity",
};

/**
 * `/me` — the destination every role carries in the sidebar, and where an employee
 * lands after signing in (`landingPathForRole`).
 *
 * Suspense because the day lives in `?date=` and `useSearchParams` suspends during
 * the static render; without a boundary the whole route opts out of prerendering.
 */
export default function MyActivityPage() {
  return (
    <Suspense fallback={null}>
      <MyActivity />
    </Suspense>
  );
}
