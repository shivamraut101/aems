"use client";

import { createContext, useContext, useEffect, useState } from "react";

import { relativeTime } from "@/lib/format";

/**
 * The instant the page was rendered, as the server measured it.
 *
 * This exists to make "3 minutes ago" survivable through hydration. A relative time is
 * a function of two things — the timestamp and *now* — and only the first is in the
 * data. Reading the clock during render meant the server and the browser answered the
 * question at different instants, produced different words, and React responded the
 * only way it can: it threw away the server-rendered tree and re-rendered the whole
 * page on the client. That is a full re-paint on every screen with a last-seen column,
 * and it silently undid the server prefetching those screens were built around.
 *
 * Handing one server-measured instant down fixes it at the root. The number is
 * serialised into the payload, so the server's render and the client's first render
 * are computing from the identical value and produce identical text. Hydration has
 * nothing to disagree about.
 *
 * Zero means "no stamp" — the provider is missing, as in a unit test — and callers
 * fall back to the live clock, which is correct outside a hydration pass.
 */
const RenderedAtContext = createContext(0);

export function RenderedAtProvider({
  value,
  children,
}: {
  value: number;
  children: React.ReactNode;
}) {
  return <RenderedAtContext.Provider value={value}>{children}</RenderedAtContext.Provider>;
}

/**
 * A clock that is deliberately frozen until it is safe to start.
 *
 * Before mount it reports the server's instant, so hydration matches. After mount it
 * reports the browser's own, refreshed on a timer — because the page can sit open for
 * an hour and "just now" must not still say "just now".
 *
 * Thirty seconds is chosen against the finest bucket the formatter renders below a
 * minute. A faster tick would rewrite the same words; a slower one would let a reading
 * of "just now" stand well after it stopped being true.
 */
function useNow(): { now: number; mounted: boolean } {
  const renderedAt = useContext(RenderedAtContext);
  const [live, setLive] = useState<number | null>(null);

  useEffect(() => {
    setLive(Date.now());
    const timer = setInterval(() => setLive(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (live !== null) return { now: live, mounted: true };
  return { now: renderedAt === 0 ? Date.now() : renderedAt, mounted: false };
}

/**
 * "12 seconds ago", rendered so that it is the same string on both sides of hydration.
 *
 * A `<time>` element rather than a bare span: the machine-readable timestamp goes in
 * `dateTime` and the exact moment in `title`, so the precise value is one hover away
 * and assistive technology is not left with only a rounded phrase.
 */
export function RelativeTime({ iso, className }: { iso: string | null; className?: string }) {
  const { now, mounted } = useNow();

  if (iso === null) {
    // Not a time, so not a <time>. "never" is a statement about absence, and marking
    // it up as a timestamp would give a screen reader a date that does not exist.
    return <span className={className}>never</span>;
  }

  return (
    <time
      dateTime={iso}
      // Withheld until mount, for the same reason the text is: `toLocaleString` reads
      // the timezone and locale of whoever runs it, so a title rendered on the server
      // is a different string from the one the browser would write. React does not
      // rebuild the tree over a mismatched attribute the way it does over mismatched
      // text — it leaves the server's value in place and says so — which would leave
      // every one of these captions quietly showing the server's clock, not the
      // reader's. An absent title for one frame is better than a permanently wrong one.
      title={mounted ? new Date(iso).toLocaleString() : undefined}
      className={className}
    >
      {relativeTime(iso, now)}
    </time>
  );
}
