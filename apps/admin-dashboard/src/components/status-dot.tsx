import { cn } from "@aems/ui";

export type PresenceStatus = "active" | "idle" | "offline";

const LABEL: Record<PresenceStatus, string> = {
  active: "Active",
  idle: "Idle",
  offline: "Offline",
};

const TONE: Record<PresenceStatus, string> = {
  active: "bg-[hsl(var(--success))]",
  idle: "bg-[hsl(var(--warning))]",
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
