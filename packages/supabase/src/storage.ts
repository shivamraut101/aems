/**
 * Storage path construction.
 *
 * The storage RLS policies authorise on path segments — segment 1 is the company,
 * segment 2 is the person. Build paths only through these helpers; a hand-assembled
 * path that puts the segments in a different order silently grants the wrong people
 * access to the object.
 */

export const AEMS_BUCKET = "aems";

export type StorageKind = "screenshots" | "reports";

export function objectPath(
  companyId: string,
  profileId: string,
  kind: StorageKind,
  filename: string,
): string {
  return `${companyId}/${profileId}/${kind}/${filename}`;
}

export function screenshotPath(companyId: string, profileId: string, filename: string): string {
  return objectPath(companyId, profileId, "screenshots", filename);
}

export function reportPath(companyId: string, profileId: string, filename: string): string {
  return objectPath(companyId, profileId, "reports", filename);
}

export interface ParsedObjectPath {
  companyId: string;
  profileId: string;
  kind: StorageKind;
  filename: string;
}

/** Returns null when the path does not match the expected four-segment layout. */
export function parseObjectPath(path: string): ParsedObjectPath | null {
  const segments = path.split("/");
  if (segments.length < 4) return null;

  const [companyId, profileId, kind, ...rest] = segments;
  if (!companyId || !profileId || !kind) return null;
  if (kind !== "screenshots" && kind !== "reports") return null;

  const filename = rest.join("/");
  if (!filename) return null;

  return { companyId, profileId, kind, filename };
}
