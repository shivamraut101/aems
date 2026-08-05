import type { DeviceRow } from "@/lib/api";
import { apiQuery } from "@/lib/query-spec";

/**
 * The reads the device inventory performs.
 *
 * Framework-free, for the reason spelled out in `../people/queries.ts`: `page.tsx` is a
 * server component and warms these before the first paint, and the view reads the same
 * objects.
 *
 * `employeesQuery` is re-exported rather than restated. The inventory resolves
 * `profile_id` to a name through the roster, and a second declaration of `["employees"]`
 * here would be a fourth copy of the same key in the app — each one correct on the day
 * it was written.
 */
export { employeesQuery } from "../people/queries";

/** Enrolled devices — `docs/scope.md` §7. */
export const devicesQuery = apiQuery<DeviceRow[]>({
  queryKey: ["devices"],
  path: "/api/devices",
});
