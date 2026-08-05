/**
 * Who "My activity" is about.
 *
 * The subject is always the signed-in person, read from the session and never from
 * the URL. `/people/:id` takes its subject from the path because a manager chooses
 * it; this screen must not, or a crafted link would turn a self-service page into a
 * viewer for somebody else's day. The API would refuse that read for an employee
 * (`routes/analytics.ts` 403s when `profileId !== session.profileId`), but the UI
 * should not offer what the database will refuse — so the subject is not addressable
 * here at all.
 */

import type { Session, UserRole } from "@/lib/session";

export interface SelfSubjectInput {
  session: Session | null;
  isLoading: boolean;
  isError: boolean;
}

export type SelfSubject =
  | { state: "loading" }
  | { state: "signed-out" }
  | { state: "error" }
  | {
      state: "ready";
      profileId: string;
      fullName: string;
      role: UserRole;
      /** Drives the "Monitoring is paused" note, which is why an empty day is empty. */
      monitoringEnabled: boolean;
    };

export function resolveSelfSubject({ session, isLoading, isError }: SelfSubjectInput): SelfSubject {
  // Loading is checked first so a retry after a transient failure shows a skeleton
  // rather than an error the reader cannot act on.
  if (isLoading) return { state: "loading" };
  if (session) {
    return {
      state: "ready",
      profileId: session.profileId,
      fullName: session.fullName,
      role: session.role,
      monitoringEnabled: session.monitoringEnabled,
    };
  }
  if (isError) return { state: "error" };
  return { state: "signed-out" };
}

/**
 * First name for the greeting, per docs/design.md's "Good Morning, Admin" pattern.
 *
 * Falls back to "there" rather than rendering an empty string — a greeting that reads
 * "Good morning," with nothing after it looks like a bug in the data.
 */
export function selfGreeting(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : "there";
}
