import type { ResponsiveColumn, TableMinWidth } from "./table-layout";

/**
 * The device inventory's columns, and the width each one starts being drawn at.
 *
 * Ordered as the table renders them. The four in the `base` tier are the ones an IT
 * reader cannot do without — which machine, is it reporting, when did it last report,
 * and the way to revoke it — so they survive down to a phone. Everything else is
 * hardware detail that is genuinely better hidden than crushed.
 *
 * `docs/scope.md` §7 asks for device name, OS, OS version, CPU, RAM and last heartbeat
 * in the inventory, and §3.3 for battery, network and storage. None of that is dropped:
 * a narrow window hides the columns, the column picker names them, and the employee's
 * own Device tab shows the full set for one machine. What the scope does not ask for is
 * eleven columns rendered inside 992px, which is what the fixed 76rem minimum forced.
 */
export const DEVICE_COLUMNS: readonly ResponsiveColumn[] = [
  { id: "device", label: "Device", from: "base", className: "", budget: 180 },
  {
    id: "owner",
    label: "Assigned to",
    from: "lg",
    className: "hidden lg:table-cell",
    budget: 120,
  },
  {
    id: "platform",
    label: "Platform",
    from: "lg",
    className: "hidden lg:table-cell",
    budget: 120,
  },
  { id: "cpu", label: "CPU", from: "2xl", className: "hidden 2xl:table-cell", budget: 140 },
  { id: "ram", label: "RAM", from: "2xl", className: "hidden 2xl:table-cell", budget: 70 },
  {
    id: "battery",
    label: "Battery",
    from: "xl",
    className: "hidden xl:table-cell",
    budget: 110,
  },
  // `2xl`, not `xl`, and the reason is a measurement rather than a preference. With
  // Network drawn at `xl` the inventory needed 1013px inside the 993px a 1280px laptop
  // gives it, so the table still scrolled — 20px instead of the original 224px, but
  // scrolling all the same. Moving one column up a tier is what makes the flagship
  // table fit outright at the width most people read it on.
  {
    id: "network",
    label: "Network",
    from: "2xl",
    className: "hidden 2xl:table-cell",
    budget: 90,
  },
  {
    id: "storageFree",
    label: "Free storage",
    from: "2xl",
    className: "hidden 2xl:table-cell",
    budget: 110,
  },
  { id: "status", label: "Status", from: "base", className: "", budget: 80 },
  {
    id: "lastSeen",
    label: "Last heartbeat",
    from: "base",
    className: "",
    budget: 100,
    align: "right",
  },
  // Only present for a super admin — `POST /api/devices/:id/revoke` is
  // `requireSuperAdmin`, so a manager is never offered it. Budgeted as though it is
  // always there, because the tightest case is the one that has to fit.
  //
  // 104 rather than 86 because the Revoke button is a default-size `Button`, not a
  // `sm` one: `sm` is 32px tall and this product holds anything a finger has to hit to
  // 36px. The taller button is also a wider one, and the budget has to say so or the
  // arithmetic below is proving something the markup does not do.
  { id: "actions", label: "Actions", from: "base", className: "", budget: 104 },
];

/**
 * The table's minimum width, stepping down with the column set above.
 *
 * The old value was a single `min-w-[76rem]` — 1216px against 992px of room at 1280px,
 * so the inventory scrolled sideways on an ordinary laptop before anyone touched it.
 * 76rem is still right at `2xl`, where there are 1248px and all eleven columns; it was
 * never right anywhere below that.
 */
export const DEVICE_TABLE_MIN_WIDTH: TableMinWidth = {
  className: "min-w-[29rem] lg:min-w-[44rem] xl:min-w-[52rem] 2xl:min-w-[77rem]",
  px: [
    [0, 464],
    [1024, 704],
    [1280, 832],
    [1536, 1232],
  ],
};

/** Column id → the classes that gate it, for the render loop. */
export const DEVICE_COLUMN_CLASS: Record<string, string> = Object.fromEntries(
  DEVICE_COLUMNS.map((column) => [column.id, column.className] as const),
);

export const DEVICE_COLUMN_LABEL: Record<string, string> = Object.fromEntries(
  DEVICE_COLUMNS.map((column) => [column.id, column.label] as const),
);

/**
 * What the column picker says about a width-gated column.
 *
 * Without it the menu lies by omission: a reader on a 1280px screen ticks "CPU", sees
 * nothing change, and concludes the control is broken. Naming the threshold is duller
 * than hiding it and considerably more honest.
 */
export function columnWidthNote(id: string): string | null {
  const column = DEVICE_COLUMNS.find((entry) => entry.id === id);
  if (!column || column.from === "base") return null;
  return column.from === "lg" ? "1024px+" : column.from === "xl" ? "1280px+" : "1536px+";
}
