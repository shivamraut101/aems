/**
 * Domain aliases over the generated schema types.
 *
 * These exist so application code says `Device` rather than `Tables<"devices">`,
 * while still breaking at compile time when a migration changes a column.
 */

import type { Tables } from "./database.types.js";

export type Company = Tables<"companies">;
export type Profile = Tables<"profiles">;
export type Policy = Tables<"policies">;
export type Device = Tables<"devices">;
export type ConsentRecord = Tables<"consent_records">;
export type WorkSession = Tables<"work_sessions">;
export type ActivityEvent = Tables<"activity_events">;
export type IdleEvent = Tables<"idle_events">;
export type Screenshot = Tables<"screenshots">;
export type Report = Tables<"reports">;
export type AiSummary = Tables<"ai_summaries">;
export type AuditLogEntry = Tables<"audit_log_entries">;
export type BreakEvent = Tables<"break_events">;
export type DeviceTelemetry = Tables<"device_telemetry">;
export type DeviceApplication = Tables<"device_applications">;

export type {
  UserRole,
  DevicePlatform,
  DeviceStatus,
  ConsentMethod,
  ReportKind,
  ReportStatus,
  SummaryKind,
  AiProvider,
  NetworkType,
} from "./database.types.js";
