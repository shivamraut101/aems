import type { CellValue, ColumnFormat } from "./types.js";

/** `7h 30m` / `45m`. The reading a human wants. */
export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalMinutes = Math.round(safe / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

/** `7.50`. The reading a spreadsheet wants — Kimai's `decimal` flag, adopted. */
export function formatDecimalHours(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return (safe / 3600).toFixed(2);
}

/**
 * One flag, two renderings, same data.
 *
 * Applied at render time rather than at aggregation time so the numbers in the
 * document stay machine-readable and only the presentation changes.
 */
export function effectiveFormat(format: ColumnFormat, decimalDuration: boolean): ColumnFormat {
  return decimalDuration && format === "duration" ? "decimalHours" : format;
}

export function formatCell(value: CellValue, format: ColumnFormat): string {
  if (value === null || value === undefined) return "";

  switch (format) {
    case "duration":
      return formatDuration(Number(value));
    case "decimalHours":
      return formatDecimalHours(Number(value));
    case "seconds":
    case "count":
      return String(Math.round(Number(value)));
    case "percent":
      return `${Math.round(Number(value) * 100)}%`;
    case "date":
      return isoOr(String(value), 0, 10);
    case "time":
      return isoOr(String(value), 11, 16);
    case "text":
    default:
      return String(value);
  }
}

/**
 * Slices an ISO instant without going through `Date`.
 *
 * Dates in a report are already normalised to UTC upstream; re-parsing here would
 * silently reintroduce the host's timezone into a shared document.
 */
function isoOr(value: string, from: number, to: number): string {
  const iso = value.length >= to && value.includes("T") ? value : toIso(value);
  return iso === null ? value : iso.slice(from, to);
}

function toIso(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
