/**
 * The title block every section opens with.
 *
 * `items-end justify-between` with a wrap, because the actions beside a title are
 * range pickers and day steppers — controls whose width is set by their content, not
 * by the header. Below `sm` they drop onto their own line rather than squeezing the
 * title into two words per row.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      {/* `min-w-0` is what lets the row wrap at all: without it a flex item's automatic
          minimum size is its content, so a long subtitle refuses to shrink, pushes the
          actions past the edge, and the whole page scrolls sideways on a phone. */}
      <div className="min-w-0 flex-1 basis-64">
        <h1 className="text-lg font-semibold tracking-tight sm:text-xl">{title}</h1>
        {subtitle ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="min-w-0 max-w-full shrink-0">{actions}</div> : null}
    </header>
  );
}
