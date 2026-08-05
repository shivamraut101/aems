"use client";

import { useMutation } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";

/**
 * A freshly minted sign-in code. The plaintext exists here and nowhere else —
 * the API stores only its SHA-256 hash, so this response cannot be re-fetched.
 * If the reader loses it, the only recovery is minting another.
 */
export interface EnrollmentCode {
  code: string;
  expiresAt: string;
  profileId: string;
  fullName: string;
  email: string;
}

/**
 * Mints a code for `profileId`, or for the signed-in person when it is omitted.
 *
 * A mutation rather than a query, and that distinction matters here: every call
 * creates a live credential. A `useQuery` would refetch on window focus and leave a
 * trail of valid codes behind every time someone alt-tabbed away from the dialog.
 */
export function useCreateEnrollmentCode() {
  return useMutation<EnrollmentCode, unknown, { profileId?: string } | void>({
    mutationFn: (input) =>
      apiFetch<EnrollmentCode>("/api/devices/enrollment-codes", {
        method: "POST",
        body: JSON.stringify(input ?? {}),
      }),
    // Nothing to invalidate: codes are write-only from the dashboard's point of view.
    retry: false,
  });
}

/** Whole minutes left, floored, never negative. */
export function minutesLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 60_000));
}

/**
 * How long the code has left, in words.
 *
 * Under a minute reads "less than a minute" rather than "0 minutes", which looks like
 * the code is already dead when it still has fifty seconds of life.
 */
export function expiryLabel(expiresAt: string, now: number = Date.now()): string {
  const remaining = Date.parse(expiresAt) - now;
  if (remaining <= 0) return "Expired";

  const minutes = minutesLeft(expiresAt, now);
  if (minutes < 1) return "Expires in less than a minute";
  return `Expires in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}
