import { cn } from "@aems/ui";

/**
 * `finished` is not a fourth colour of offline — it is the answer to a different
 * question, and it exists because Offline could not tell a manager which.
 *
 * The agent stops heartbeating the moment somebody ends their day, so a person who
 * clocked out properly and a person whose agent crashed both fell to Offline two
 * minutes later. One of those needs following up and the other is a completed day.
 */
export type PresenceStatus = "active" | "idle" | "finished" | "offline";

const LABEL: Record<PresenceStatus, string> = {
  active: "Active",
  idle: "Idle",
  finished: "Finished",
  offline: "Offline",
};

const TONE: Record<PresenceStatus, string> = {
  active: "bg-[hsl(var(--success))]",
  idle: "bg-[hsl(var(--warning))]",
  // Deliberately not grey like offline and not amber like idle: a finished day is
  // neither a problem nor a gap, so it reads as settled rather than as absent.
  finished: "bg-[hsl(var(--success))]/40",
  offline: "bg-muted-foreground/40",
};

/**
 * Presence indicator.
 *
 * The dot is never the only signal — the word travels with it, so the state is
 * still readable without colour vision.
 */
export function StatusDot({ status, className }: { status: PresenceStatus; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE[status])} aria-hidden />
      {LABEL[status]}
    </span>
  );
}
