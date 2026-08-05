import type { ResponsiveColumn, TableMinWidth } from "../devices/table-layout";

/**
 * The roster's columns, on the same rules as the device inventory's.
 *
 * Imported from `../devices/table-layout` rather than from `src/lib/` because this
 * change owns the two table routes and not that directory — see the note at the top of
 * that file. The direction of the import carries no meaning.
 *
 * Who, whether they are being monitored, and when they were last seen are the three
 * facts the roster exists to answer, so those three survive to the narrowest window.
 * Department and role are how the list is *organised* rather than what it says, and the
 * filter bar above the table answers both questions on a screen too narrow to show them.
 */
export const PEOPLE_COLUMNS: readonly ResponsiveColumn[] = [
  { id: "name", label: "Name", from: "base", className: "", budget: 190 },
  {
    id: "department",
    label: "Department",
    from: "lg",
    className: "hidden lg:table-cell",
    budget: 130,
  },
  { id: "role", label: "Role", from: "lg", className: "hidden lg:table-cell", budget: 110 },
  {
    id: "devices",
    label: "Devices",
    from: "xl",
    className: "hidden xl:table-cell",
    budget: 80,
  },
  { id: "monitoring", label: "Monitoring", from: "base", className: "", budget: 110 },
  {
    id: "lastSeen",
    label: "Last seen",
    from: "base",
    className: "",
    budget: 110,
    align: "right",
  },
];

/**
 * 44rem flat became a step.
 *
 * The old single `min-w-[44rem]` (704px) fitted a 1280px laptop comfortably and made a
 * 768px tablet — which has 480px of content once the sidebar appears — scroll by 224px
 * for a table that only has six columns in it.
 */
export const PEOPLE_TABLE_MIN_WIDTH: TableMinWidth = {
  className: "min-w-[26rem] lg:min-w-[42rem] xl:min-w-[48rem]",
  px: [
    [0, 416],
    [1024, 672],
    [1280, 768],
  ],
};

export const PEOPLE_COLUMN_CLASS: Record<string, string> = Object.fromEntries(
  PEOPLE_COLUMNS.map((column) => [column.id, column.className] as const),
);

export const PEOPLE_COLUMN_LABEL: Record<string, string> = Object.fromEntries(
  PEOPLE_COLUMNS.map((column) => [column.id, column.label] as const),
);

/** The threshold a width-gated column appears at, for the column picker. */
export function peopleColumnWidthNote(id: string): string | null {
  const column = PEOPLE_COLUMNS.find((entry) => entry.id === id);
  if (!column || column.from === "base") return null;
  return column.from === "lg" ? "1024px+" : "1280px+";
}
