import { Compass } from "lucide-react";
import Link from "next/link";

/**
 * 404, inside the shell.
 *
 * The realistic way to reach it is not a typo in the address bar — it is
 * `/people/<uuid>` for someone who was removed, or a link from a report that outlived
 * its subject. So the copy names that case rather than saying "page not found", and
 * the exits are the two places the reader was probably heading.
 *
 * A server component: nothing here needs the browser.
 */
export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <div className="rounded-lg border bg-card px-5 py-6">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Compass className="h-4 w-4 text-muted-foreground" aria-hidden />
          Nothing here
        </p>

        <p className="mt-2 text-sm text-muted-foreground">
          This address does not match a screen in AEMS. If you followed a link to a
          person or a device, it may have been removed from the company since the link
          was made.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href="/"
            className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Back to overview
          </Link>
          <Link
            href="/people"
            className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm font-medium transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Browse people
          </Link>
        </div>
      </div>
    </div>
  );
}
