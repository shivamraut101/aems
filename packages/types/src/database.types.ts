/**
 * Supabase schema types.
 *
 * Keep in step with every migration. NOTE: despite the `db:types` script, this file
 * is NOT raw CLI output — the standalone aliases below (`UserRole`, `ReportStatus`,
 * `DevicePlatform`, …) are hand-written, and the generator emits none of them. Running
 * `pnpm db:types` over this file would delete them and break every importer, so treat
 * the generated output as something to merge in, not to overwrite with.
 *
 * Kept in @aems/types rather than @aems/supabase so consumers can type their data
 * without pulling in the supabase-js runtime.
 *
 * The `Relationships` arrays are not decoration: postgrest-js requires them to
 * satisfy its GenericSchema constraint, and it reads them to type embedded selects
 * like `devices(...)`. Drop one and every query against that table degrades to
 * `never`.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type UserRole = "super_admin" | "manager" | "employee";
export type DevicePlatform = "windows" | "macos" | "android";
export type DeviceStatus = "active" | "offline" | "revoked";
export type ConsentMethod = "in_app_dialog" | "onboarding_portal" | "signed_document";
/** @deprecated The legacy `reports.kind` set. Migration ...0010 widened the column to
 *  the four registry types as well; `@aems/analytics`' `ReportKind` is the authority. */
export type ReportKind = "daily" | "weekly" | "team";
export type ReportStatus = "pending" | "ready" | "failed";
export type ReportFormat = "csv" | "pdf";
export type SummaryKind = "daily" | "weekly" | "insight";
export type AiProvider = "openai" | "claude" | "gemini";
export type NetworkType = "wifi" | "cellular" | "ethernet" | "offline";
/** `category_rules.productivity` — tri-state, because "in use but not productive" is real. */
export type Productivity = "productive" | "neutral" | "unproductive";
/** What happens to a URL no restriction rule claims. */
export type RestrictionMode = "blocklist" | "allowlist";
/** Both actions exist in both modes — an `allow` rule is a carve-out from a block-list. */
export type RestrictionAction = "block" | "allow";
/** `domain` is a suffix-matched hostname; `url_pattern` is a `*`-globbed URL. */
export type RestrictionMatchKind = "domain" | "url_pattern";
/**
 * The switchable collection vocabulary — the check constraint on
 * `device_collection_settings.data_type`, and the element type of
 * `device_enrollment_codes.denied_types` and `consent_records.granted_types`.
 *
 * Declared here with the other check-constraint unions so the database and the
 * vocabulary cannot drift; `./collection.js` re-exports it with the platform sets and
 * the copy, and is what application code should import.
 *
 * Work sessions, breaks and heartbeats are deliberately absent: a declared break is the
 * employee's own statement rather than an observation, a work session is the container
 * the rest hangs on (`profiles.monitoring_enabled` already switches that off per
 * person), and heartbeat is consent-exempt so a revoked agent can still learn it was
 * revoked.
 */
export type DataTypeId =
  | "applications"
  | "websites"
  | "screenshots"
  | "idle"
  | "telemetry"
  | "installed_apps"
  | "location";

export interface Database {
  public: {
    Tables: {
      companies: {
        Row: {
          id: string;
          name: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["companies"]["Insert"]>;
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          company_id: string;
          email: string;
          full_name: string;
          role: UserRole;
          department: string | null;
          manager_id: string | null;
          monitoring_enabled: boolean;
          // Off-boarding tombstone (migration 20260805000011). Non-null means: no
          // sign-in, no collection, hidden from the roster. Profiles are never
          // hard-deleted — the cascade from auth.users would take the consent
          // records proving collection was lawful with them.
          deactivated_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          company_id: string;
          email: string;
          full_name?: string;
          role?: UserRole;
          department?: string | null;
          manager_id?: string | null;
          monitoring_enabled?: boolean;
          deactivated_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "profiles_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "profiles_manager_id_fkey";
            columns: ["manager_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      policies: {
        Row: {
          id: string;
          company_id: string;
          version: string;
          name: string;
          screenshot_interval_seconds: number;
          idle_threshold_seconds: number;
          max_open_break_seconds: number;
          tracked_categories: string[];
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          company_id: string;
          version: string;
          name: string;
          screenshot_interval_seconds?: number;
          idle_threshold_seconds?: number;
          max_open_break_seconds?: number;
          tracked_categories?: string[];
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["policies"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "policies_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      devices: {
        Row: {
          id: string;
          company_id: string;
          profile_id: string;
          platform: DevicePlatform;
          label: string;
          os_version: string;
          agent_version: string;
          enrolled_at: string;
          last_seen_at: string | null;
          status: DeviceStatus;
          device_name: string;
          model: string | null;
          cpu: string | null;
          ram_mb: number | null;
          storage_mb: number | null;
          /** Migration ...0016. At most one per profile; see the column comment. */
          is_primary: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          company_id: string;
          profile_id: string;
          platform: DevicePlatform;
          label: string;
          is_primary?: boolean;
          os_version?: string;
          agent_version?: string;
          enrolled_at?: string;
          last_seen_at?: string | null;
          status?: DeviceStatus;
          device_name?: string;
          model?: string | null;
          cpu?: string | null;
          ram_mb?: number | null;
          storage_mb?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["devices"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "devices_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "devices_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      consent_records: {
        Row: {
          id: string;
          company_id: string;
          profile_id: string;
          device_id: string;
          policy_version: string;
          method: ConsentMethod;
          ip_address: string | null;
          consented_at: string;
          revoked_at: string | null;
          /** NULL on rows written before per-type consent existed — "the platform
           *  default of the day", not "agreed to nothing". */
          granted_types: DataTypeId[] | null;
        };
        Insert: {
          id?: string;
          company_id: string;
          profile_id: string;
          device_id: string;
          policy_version: string;
          method: ConsentMethod;
          ip_address?: string | null;
          consented_at?: string;
          revoked_at?: string | null;
          granted_types?: DataTypeId[] | null;
        };
        Update: Partial<Database["public"]["Tables"]["consent_records"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "consent_records_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "consent_records_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "consent_records_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
        ];
      };
      work_sessions: {
        Row: {
          id: number;
          company_id: string;
          profile_id: string;
          device_id: string;
          clock_in_at: string;
          clock_out_at: string | null;
          created_at: string;
        };
        Insert: {
          company_id: string;
          profile_id: string;
          device_id: string;
          clock_in_at?: string;
          clock_out_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["work_sessions"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "work_sessions_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_sessions_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "work_sessions_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
        ];
      };
      activity_events: {
        Row: {
          id: number;
          company_id: string;
          profile_id: string;
          device_id: string;
          work_session_id: number | null;
          app_name: string;
          window_title: string | null;
          url: string | null;
          domain: string | null;
          category: string | null;
          started_at: string;
          ended_at: string | null;
          client_event_id: string;
          created_at: string;
        };
        Insert: {
          company_id: string;
          profile_id: string;
          device_id: string;
          work_session_id?: number | null;
          app_name: string;
          window_title?: string | null;
          url?: string | null;
          domain?: string | null;
          category?: string | null;
          started_at: string;
          ended_at?: string | null;
          client_event_id: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["activity_events"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "activity_events_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "activity_events_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "activity_events_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "activity_events_work_session_id_fkey";
            columns: ["work_session_id"];
            isOneToOne: false;
            referencedRelation: "work_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      idle_events: {
        Row: {
          id: number;
          company_id: string;
          profile_id: string;
          device_id: string;
          idle_start_at: string;
          idle_end_at: string | null;
          /** Generated column — never write to this. */
          duration_seconds: number | null;
          client_event_id: string;
          created_at: string;
        };
        Insert: {
          company_id: string;
          profile_id: string;
          device_id: string;
          idle_start_at: string;
          idle_end_at?: string | null;
          client_event_id: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["idle_events"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "idle_events_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "idle_events_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "idle_events_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
        ];
      };
      screenshots: {
        Row: {
          id: number;
          company_id: string;
          profile_id: string;
          device_id: string;
          work_session_id: number | null;
          captured_at: string;
          storage_path: string;
          thumbnail_path: string | null;
          blurred: boolean;
          client_event_id: string;
          created_at: string;
        };
        Insert: {
          company_id: string;
          profile_id: string;
          device_id: string;
          work_session_id?: number | null;
          captured_at?: string;
          storage_path: string;
          thumbnail_path?: string | null;
          blurred?: boolean;
          client_event_id: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["screenshots"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "screenshots_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "screenshots_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "screenshots_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "screenshots_work_session_id_fkey";
            columns: ["work_session_id"];
            isOneToOne: false;
            referencedRelation: "work_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      category_rules: {
        Row: {
          id: string;
          company_id: string;
          priority: number;
          category_path: string[];
          productivity: Productivity;
          match_app: string | null;
          match_title: string | null;
          match_domain: string | null;
          ignore_case: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          company_id: string;
          priority?: number;
          category_path: string[];
          productivity?: Productivity;
          match_app?: string | null;
          match_title?: string | null;
          match_domain?: string | null;
          ignore_case?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["category_rules"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "category_rules_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
        ];
      };
      break_events: {
        Row: {
          id: number;
          company_id: string;
          profile_id: string;
          device_id: string;
          work_session_id: number | null;
          break_start_at: string;
          break_end_at: string | null;
          /** Generated column — never write to this. */
          duration_seconds: number | null;
          client_event_id: string;
          created_at: string;
        };
        Insert: {
          company_id: string;
          profile_id: string;
          device_id: string;
          work_session_id?: number | null;
          break_start_at: string;
          break_end_at?: string | null;
          client_event_id: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["break_events"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "break_events_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "break_events_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "break_events_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "break_events_work_session_id_fkey";
            columns: ["work_session_id"];
            isOneToOne: false;
            referencedRelation: "work_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      location_points: {
        Row: {
          id: number;
          company_id: string;
          profile_id: string;
          device_id: string;
          work_session_id: number | null;
          recorded_at: string;
          latitude: number;
          longitude: number;
          accuracy_m: number | null;
          client_event_id: string;
          created_at: string;
        };
        Insert: {
          company_id: string;
          profile_id: string;
          device_id: string;
          work_session_id?: number | null;
          recorded_at: string;
          latitude: number;
          longitude: number;
          accuracy_m?: number | null;
          client_event_id: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["location_points"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "location_points_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "location_points_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "location_points_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "location_points_work_session_id_fkey";
            columns: ["work_session_id"];
            isOneToOne: false;
            referencedRelation: "work_sessions";
            referencedColumns: ["id"];
          },
        ];
      };
      device_telemetry: {
        Row: {
          id: number;
          company_id: string;
          device_id: string;
          recorded_at: string;
          battery_level: number | null;
          battery_charging: boolean | null;
          network_type: NetworkType | null;
          storage_free_mb: number | null;
          screen_active_seconds: number | null;
        };
        Insert: {
          company_id: string;
          device_id: string;
          recorded_at?: string;
          battery_level?: number | null;
          battery_charging?: boolean | null;
          network_type?: NetworkType | null;
          storage_free_mb?: number | null;
          screen_active_seconds?: number | null;
        };
        Update: Partial<Database["public"]["Tables"]["device_telemetry"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "device_telemetry_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "device_telemetry_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
        ];
      };
      device_applications: {
        Row: {
          id: number;
          company_id: string;
          device_id: string;
          name: string;
          version: string | null;
          identifier: string | null;
          first_seen_at: string;
          last_seen_at: string;
        };
        Insert: {
          company_id: string;
          device_id: string;
          name: string;
          version?: string | null;
          identifier?: string | null;
          first_seen_at?: string;
          last_seen_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["device_applications"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "device_applications_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "device_applications_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
        ];
      };
      /**
       * Short-lived, single-use codes that bind a machine to a person.
       *
       * `code_hash` only — the plaintext is shown once by the API that mints it and
       * never stored, so a database leak yields nothing an agent could redeem.
       */
      device_enrollment_codes: {
        Row: {
          id: string;
          company_id: string;
          profile_id: string;
          code_hash: string;
          expires_at: string;
          consumed_at: string | null;
          consumed_device_id: string | null;
          created_by: string;
          created_at: string;
          /** Data types this code's device may NOT collect, chosen at mint time. Read
           *  off this row at redemption — the redeeming agent is unauthenticated, so
           *  nothing it claims about its own scope can be trusted. */
          denied_types: DataTypeId[];
          /**
           * The kind of machine this code was minted for (migration …0018), which is
           * what decided the types the dialog offered. Null on codes minted before it —
           * those accept any platform, exactly as they always did.
           */
          platform: DevicePlatform | null;
        };
        Insert: {
          id?: string;
          company_id: string;
          profile_id: string;
          code_hash: string;
          expires_at: string;
          consumed_at?: string | null;
          consumed_device_id?: string | null;
          created_by: string;
          created_at?: string;
          denied_types?: DataTypeId[];
          platform?: DevicePlatform | null;
        };
        Update: Partial<Database["public"]["Tables"]["device_enrollment_codes"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "device_enrollment_codes_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "device_enrollment_codes_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "device_enrollment_codes_consumed_device_id_fkey";
            columns: ["consumed_device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "device_enrollment_codes_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      /**
       * Per-device exceptions to the platform's default collection scope.
       *
       * A DENY list: a missing row means the type is permitted. That is what makes the
       * table safe to deploy empty — every device already in the field keeps collecting
       * exactly what it collects today — and what makes a type added to the vocabulary
       * later permitted on machines nobody has revisited.
       *
       * `changed_by` / `changed_at` are the attribution the compliance surfaces render,
       * per (device, type) pair. They are not read from `audit_log_entries` because
       * only super admins may select that table, so a manager could not read them.
       */
      device_collection_settings: {
        Row: {
          company_id: string;
          device_id: string;
          data_type: DataTypeId;
          enabled: boolean;
          /** Null once the person who made the decision leaves the company. */
          changed_by: string | null;
          changed_at: string;
        };
        Insert: {
          company_id: string;
          device_id: string;
          data_type: DataTypeId;
          enabled: boolean;
          changed_by?: string | null;
          changed_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["device_collection_settings"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "device_collection_settings_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "device_collection_settings_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "device_collection_settings_changed_by_fkey";
            columns: ["changed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      reports: {
        // `kind` is `string`, not `ReportKind`: migration ...0010 widened the check
        // constraint to the four registry types (time_and_activity, app_usage,
        // website_usage, work_breaks) while keeping the legacy daily/weekly/team
        // valid. The authority on the set is `@aems/analytics`' registry, which
        // depends on this package and so cannot be imported here.
        Row: {
          id: number;
          company_id: string;
          profile_id: string | null;
          kind: string;
          period_start: string;
          period_end: string;
          status: ReportStatus;
          storage_path: string | null;
          created_at: string;
          updated_at: string;
          format: ReportFormat;
          grouping: string;
          params: Json | null;
          requested_by: string | null;
          row_count: number | null;
          failure_reason: string | null;
        };
        Insert: {
          company_id: string;
          profile_id?: string | null;
          kind: string;
          period_start: string;
          period_end: string;
          status?: ReportStatus;
          storage_path?: string | null;
          created_at?: string;
          updated_at?: string;
          format?: ReportFormat;
          grouping?: string;
          params?: Json | null;
          requested_by?: string | null;
          row_count?: number | null;
          failure_reason?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["reports"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "reports_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reports_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      ai_summaries: {
        Row: {
          id: number;
          company_id: string;
          profile_id: string | null;
          kind: SummaryKind;
          period_start: string;
          period_end: string;
          provider: AiProvider;
          model: string;
          content: string;
          created_at: string;
        };
        Insert: {
          company_id: string;
          profile_id?: string | null;
          kind: SummaryKind;
          period_start: string;
          period_end: string;
          provider: AiProvider;
          model: string;
          content: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["ai_summaries"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "ai_summaries_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ai_summaries_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_log_entries: {
        Row: {
          id: number;
          company_id: string;
          actor_id: string | null;
          action: string;
          target_type: string;
          target_id: string;
          metadata: Json | null;
          created_at: string;
        };
        Insert: {
          company_id: string;
          actor_id?: string | null;
          action: string;
          target_type: string;
          target_id: string;
          metadata?: Json | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["audit_log_entries"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "audit_log_entries_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "audit_log_entries_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      website_restriction_settings: {
        Row: {
          company_id: string;
          enabled: boolean;
          mode: RestrictionMode;
          notice: string | null;
          /** Bumped by a trigger on any settings OR rule change; the agent polls it. */
          revision: number;
          updated_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          enabled?: boolean;
          mode?: RestrictionMode;
          notice?: string | null;
          updated_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["website_restriction_settings"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "website_restriction_settings_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: true;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "website_restriction_settings_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      website_restriction_rules: {
        Row: {
          id: string;
          company_id: string;
          priority: number;
          action: RestrictionAction;
          match_kind: RestrictionMatchKind;
          pattern: string;
          note: string | null;
          enabled: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          company_id: string;
          priority?: number;
          action: RestrictionAction;
          match_kind: RestrictionMatchKind;
          pattern: string;
          note?: string | null;
          enabled?: boolean;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["website_restriction_rules"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "website_restriction_rules_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "website_restriction_rules_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      website_block_events: {
        Row: {
          id: number;
          company_id: string;
          profile_id: string;
          device_id: string;
          /** `on delete set null` — deleting a rule must not erase what it stopped. */
          rule_id: string | null;
          matched_pattern: string | null;
          mode: RestrictionMode;
          domain: string;
          /** Scheme, host, port and path. The query string is never stored. */
          url: string;
          blocked_at: string;
          client_event_id: string;
          created_at: string;
        };
        Insert: {
          company_id: string;
          profile_id: string;
          device_id: string;
          rule_id?: string | null;
          matched_pattern?: string | null;
          mode: RestrictionMode;
          domain: string;
          url: string;
          blocked_at: string;
          client_event_id: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["website_block_events"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "website_block_events_company_id_fkey";
            columns: ["company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "website_block_events_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "website_block_events_device_id_fkey";
            columns: ["device_id"];
            isOneToOne: false;
            referencedRelation: "devices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "website_block_events_rule_id_fkey";
            columns: ["rule_id"];
            isOneToOne: false;
            referencedRelation: "website_restriction_rules";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
}

/** Convenience accessors: `Tables<"devices">` instead of the full index chain. */
export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];

export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];
