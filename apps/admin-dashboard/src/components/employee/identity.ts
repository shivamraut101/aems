/**
 * How a person is named on screen.
 *
 * A profile with no `full_name` is normal — Supabase Auth creates the row before
 * anyone fills it in — so every one of these has to produce something legible rather
 * than a blank. A blank avatar or an empty heading reads as a page that failed to
 * load, which sends the reader looking for a fault that is not there.
 */

import { roleLabel, type UserRole } from "@/lib/session";

export interface NamedPerson {
  full_name: string;
  email: string;
}

export function displayName(person: NamedPerson): string {
  const named = person.full_name.trim();
  if (named.length > 0) return named;

  const at = person.email.indexOf("@");
  return at > 0 ? person.email.slice(0, at) : person.email;
}

/**
 * Avatar initials.
 *
 * `Array.from` rather than indexing, so an astral-plane character is taken whole
 * instead of being cut into an unpaired surrogate that renders as a replacement box.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";

  const first = Array.from(words[0]!);
  if (words.length === 1) {
    return first.slice(0, 2).join("").toUpperCase() || "?";
  }

  const last = Array.from(words[words.length - 1]!);
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase() || "?";
}

/** The line under the name: role, and the department when the person has one. */
export function subtitleFor(role: UserRole, department: string | null | undefined): string {
  const label = roleLabel(role);
  const dept = department?.trim();
  return dept ? `${label} · ${dept}` : label;
}
