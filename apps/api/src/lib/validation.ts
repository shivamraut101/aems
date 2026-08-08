import type { ZodError, ZodIssue } from "zod";

/**
 * Turns a Zod failure into something a person can act on.
 *
 * `ZodError.message` is a JSON dump of the issue array. Every route was sending it
 * straight to the caller as the user-facing message, so the desktop agent showed a
 * person this when they typed three characters into the sign-in box:
 *
 *   AemsApiError: [ { "code": "too_small", "minimum": 4, "type": "string",
 *   "inclusive": true, "exact": false, "message": "String must contain at least
 *   4 character(s)", "path": [ "code" ] } ]
 *
 * It also leaks the schema's shape to anyone poking at the API, which is a small
 * information disclosure on top of being unreadable.
 */

/**
 * Field names as the person filling the form knows them, not as the schema spells
 * them. Anything absent falls back to de-camel-casing, which handles the long tail
 * ("screenshotIntervalSeconds" -> "screenshot interval seconds") without a
 * dictionary entry for every field in the product.
 */
const FIELD_LABELS: Record<string, string> = {
  code: "Sign-in code",
  email: "Email address",
  fullName: "Full name",
  managerId: "Manager",
  profileId: "Employee",
  deviceId: "Device",
  policyVersion: "Policy version",
  temporaryPassword: "Temporary password",
  bucketSeconds: "Time grouping",
  periodStart: "Start of the period",
  periodEnd: "End of the period",
  from: "Start of the period",
  to: "End of the period",
  kind: "Report type",
  screenshotIntervalSeconds: "Screenshot interval",
  idleThresholdSeconds: "Idle threshold",
  maxOpenBreakSeconds: "Forgotten-break limit",
  trackedCategories: "Tracked categories",
  clientEventId: "Event id",
};

function labelFor(path: readonly (string | number)[]): string {
  const last = [...path].reverse().find((part) => typeof part === "string");
  if (last === undefined) return "This value";

  const known = FIELD_LABELS[last as string];
  if (known) return known;

  // "idleThresholdSeconds" -> "Idle threshold seconds"
  const spaced = (last as string).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Whole sentence for one issue, already carrying its field name. */
function describeIssue(issue: ZodIssue): string {
  const label = labelFor(issue.path);

  switch (issue.code) {
    case "invalid_type":
      // Zod reports a missing field as "expected string, received undefined", which
      // reads as a type error rather than as the blank box it actually is.
      return issue.received === "undefined" || issue.received === "null"
        ? `${label} is required.`
        : `${label} is not in the expected format.`;

    case "too_small": {
      if (issue.type === "string") {
        return issue.minimum === 1
          ? `${label} is required.`
          : `${label} must be at least ${issue.minimum} characters.`;
      }
      if (issue.type === "array") {
        return `${label} needs at least ${issue.minimum} item${issue.minimum === 1 ? "" : "s"}.`;
      }
      return `${label} must be ${issue.minimum} or more.`;
    }

    case "too_big": {
      if (issue.type === "string") return `${label} must be ${issue.maximum} characters or fewer.`;
      if (issue.type === "array") return `${label} can hold at most ${issue.maximum} items.`;
      return `${label} must be ${issue.maximum} or less.`;
    }

    case "invalid_string": {
      if (issue.validation === "email") return `${label} must be a valid email address.`;
      if (issue.validation === "uuid") return `${label} is not a valid identifier.`;
      if (issue.validation === "url") return `${label} must be a valid URL.`;
      if (issue.validation === "datetime") return `${label} must be a date and time.`;
      return `${label} is not in the expected format.`;
    }

    case "invalid_enum_value":
      return `${label} must be one of: ${issue.options.join(", ")}.`;

    case "unrecognized_keys":
      return `Unexpected field${issue.keys.length === 1 ? "" : "s"}: ${issue.keys.join(", ")}.`;

    // `.refine()` messages are written by us for a reader, so they are already the
    // sentence we want and must not be paraphrased.
    case "custom":
      return issue.message;

    default:
      return issue.message.startsWith("String must") || issue.message.startsWith("Expected")
        ? `${label} is not in the expected format.`
        : issue.message;
  }
}

/** The error body every route sends when a request fails validation. */
export interface ValidationFailure {
  error: string;
  message: string;
  statusCode: 400;
  /** Per-field messages, so a form can mark the offending input. */
  fields: Record<string, string>;
}

/**
 * @param error the Zod failure
 * @param code  `invalid_body` or `invalid_query`, kept so existing clients that
 *              branch on it keep working
 *
 * At most three sentences. A caller who got six things wrong is helped by the first
 * few and buried by all of them, and the `fields` map carries the rest for any UI
 * that wants to mark every input at once.
 */
export function validationFailure(error: ZodError, code = "invalid_body"): ValidationFailure {
  const issues = error.issues.length > 0 ? error.issues : [];

  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.join(".");
    // First issue per field wins: Zod can report several for one input and the
    // earliest is the most specific.
    if (key && fields[key] === undefined) fields[key] = describeIssue(issue);
  }

  const sentences = issues.slice(0, 3).map(describeIssue);
  const message =
    sentences.length > 0
      ? [...new Set(sentences)].join(" ")
      : "That request was not in the expected format.";

  return { error: code, message, statusCode: 400, fields };
}
