"use client";

import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@aems/ui";
import { ShieldAlert } from "lucide-react";

import { TableSkeletonRows, type SkeletonColumn } from "@/components/states";
import { describeError, useApiQuery } from "@/lib/api";
import {
  RESTRICTION_EVENT_LIMIT,
  domainTallies,
  personLabel,
  refusalReason,
  restrictionEventsQuery,
  restrictionPeopleQuery,
  rulesById,
  type RestrictionRule,
} from "@/lib/queries/restrictions";

import { Notice, Section } from "../section";

/**
 * What the policy has actually refused.
 *
 * The client asked to "see what has actually been blocked", and the framing of that list
 * decides what the whole feature reads as. `docs/design.md` positions this product as
 * workforce intelligence rather than surveillance, and a refusal feed is the easiest
 * place in the product to break that: presented as a list of people who tried to visit
 * blocked sites, it is a disciplinary log.
 *
 * So it is presented as what it is diagnostically useful for — finding a rule refusing
 * more than whoever wrote it intended. The busiest domains come first, because a domain
 * at the top of that tally is nearly always either a site the company needs and has not
 * allowed, or a rule broader than it looks. The person is shown because "is this stopping
 * someone doing their job" is the question an admin is actually asking, and it cannot be
 * answered without them.
 *
 * The URL is deliberately **not** a column. `GET /api/restrictions/events` returns it and
 * the record needs it, but a full address on a screen scanned by an admin is the detail
 * that turns a diagnostic into browsing history. The host answers "which rule is doing
 * this", which is what this table is for.
 */
const REFUSAL_SKELETON_COLUMNS: readonly SkeletonColumn[] = [
  { key: "when", label: "When", width: "w-28" },
  { key: "website", label: "Website", width: "w-32" },
  { key: "person", label: "Person", width: "w-28" },
  { key: "why", label: "Why", width: "w-40" },
];

export function Refusals({ rules }: { rules: readonly RestrictionRule[] }) {
  const query = useApiQuery(restrictionEventsQuery);
  // Warmed by the same page prefetch, so this names people in the first paint rather than
  // printing "Unknown" and correcting itself a moment later.
  const people = useApiQuery(restrictionPeopleQuery);

  const events = query.data ?? [];
  const byId = rulesById(rules);
  const tallies = domainTallies(events);
  const roster = people.data ?? [];

  return (
    <Section
      title="What this policy has refused"
      description="Pages the browser extension turned away. It is here so a rule that is refusing more than it was meant to can be found and changed — the fix for most of these rows is a rule, not a conversation."
    >
      {query.isError ? (
        <Notice tone="error" title="Could not load recent refusals">
          <p>{describeError(query.error)}</p>
          <p className="mt-1">
            The rules above are unaffected — this is only the record of what they have done.
          </p>
        </Notice>
      ) : (
        <>
          {tallies.length > 0 ? (
            <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 rounded-lg border bg-card px-4 py-3 text-sm">
              <li className="w-full text-xs font-medium text-muted-foreground sm:w-auto">
                Most refused
              </li>
              {tallies.map((tally) => (
                <li key={tally.domain} className="flex items-baseline gap-1.5">
                  <span className="break-all font-mono">{tally.domain}</span>
                  <span className="tabular whitespace-nowrap text-xs text-muted-foreground">
                    {tally.count} {tally.count === 1 ? "time" : "times"}
                    {tally.people > 0
                      ? `, ${String(tally.people)} ${tally.people === 1 ? "person" : "people"}`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <Table
            containerClassName="rounded-lg border bg-card"
            className="min-w-[44rem]"
            aria-busy={query.isLoading || undefined}
          >
            <caption className="sr-only">
              Recent refused page requests, newest first, with the rule that caused each
            </caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">When</TableHead>
                <TableHead scope="col">Website</TableHead>
                <TableHead scope="col">Person</TableHead>
                <TableHead scope="col">Why</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.isLoading ? (
                <TableSkeletonRows columns={REFUSAL_SKELETON_COLUMNS} rows={4} />
              ) : events.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4} className="px-4 py-10 text-center">
                    <ShieldAlert className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden />
                    <p className="mt-3 text-sm font-medium">Nothing has been refused</p>
                    <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                      Either the rules above are not getting in anybody&rsquo;s way, or the
                      browser extension has not reported in yet. Both look the same from here.
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                events.map((event) => {
                  const person = personLabel(event.profileId, roster);

                  return (
                    <TableRow key={event.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        <LocalTime iso={event.blockedAt} />
                      </TableCell>
                      <TableCell className="break-all font-mono">
                        {event.domain ?? <span className="font-sans text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        {person ? (
                          <span className="font-medium">{person}</span>
                        ) : (
                          <span className="text-muted-foreground">Not on the current roster</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {event.ruleId === null ? (
                          <Badge variant="offline">{refusalReason(event, byId)}</Badge>
                        ) : (
                          refusalReason(event, byId)
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>

          {events.length >= RESTRICTION_EVENT_LIMIT ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Showing the most recent {RESTRICTION_EVENT_LIMIT} refusals. The list is capped so
              this page stays a diagnostic rather than a log.
            </p>
          ) : null}
        </>
      )}
    </Section>
  );
}

/**
 * A timestamp in the reader's own timezone.
 *
 * `suppressHydrationWarning` is required and is not a shortcut. This page is
 * server-rendered with its data already resolved, so the same `toLocaleString` runs once
 * on the server — in the *server's* timezone — and again in the browser. Those two strings
 * differ for every reader who is not in the server's zone, and React reports that as a
 * hydration error. Suppressing it keeps the server's text for the first paint and lets the
 * next client render correct it, which is the documented handling for locale-dependent
 * output; the alternative is a timestamp column that pops in after mount, which is the
 * flash this whole change exists to remove.
 *
 * The machine-readable instant is on `dateTime` either way.
 */
function LocalTime({ iso }: { iso: string }) {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return <span>—</span>;

  return (
    <time dateTime={iso} suppressHydrationWarning>
      {new Date(parsed).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })}
    </time>
  );
}
