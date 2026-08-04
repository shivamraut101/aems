import type {
  ActivityBatch,
  ActivityBatchResult,
  ApiError,
  ConsentSubmission,
  Device,
  DeviceApplicationsInput,
  DeviceEnrollmentRequest,
  DeviceEnrollmentResponse,
  HeartbeatInput,
  Profile,
  ProductivitySummary,
  Report,
  ScreenshotUploadResult,
  TimelineEntry,
  WorkSession,
} from "@aems/types";

export class AemsApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "AemsApiError";
  }
}

export interface AemsClientOptions {
  baseUrl: string;
  /**
   * Credential for the caller.
   *
   * `user` is a Supabase access token from a signed-in dashboard session.
   * `device` is the long-lived token an agent received at enrolment.
   */
  auth?: { kind: "user" | "device"; token: string };
  fetch?: typeof globalThis.fetch;
}

/**
 * Typed client for the Fastify API.
 *
 * Agents talk to this and never to Supabase directly — they hold no Supabase
 * credentials, so ingestion authorisation stays in one place.
 */
export class AemsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private auth: AemsClientOptions["auth"];

  constructor(options: AemsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.auth = options.auth;
  }

  /** Swap credentials in place — used by agents after enrolment returns a device token. */
  setAuth(auth: AemsClientOptions["auth"]): void {
    this.auth = auth;
  }

  // -- devices ------------------------------------------------------------

  enrollDevice(body: DeviceEnrollmentRequest): Promise<DeviceEnrollmentResponse> {
    return this.request("POST", "/api/devices/enroll", body);
  }

  listDevices(): Promise<Device[]> {
    return this.request("GET", "/api/devices");
  }

  heartbeat(body: HeartbeatInput): Promise<{ ok: true }> {
    return this.request("POST", "/api/devices/heartbeat", body);
  }

  reportApplications(body: DeviceApplicationsInput): Promise<{ upserted: number }> {
    return this.request("POST", "/api/devices/applications", body);
  }

  // -- consent ------------------------------------------------------------

  submitConsent(body: ConsentSubmission): Promise<{ consentId: string }> {
    return this.request("POST", "/api/auth/consent", body);
  }

  // -- activity -----------------------------------------------------------

  startWorkSession(deviceId: string): Promise<WorkSession> {
    return this.request("POST", "/api/activity/sessions", { deviceId });
  }

  endWorkSession(workSessionId: number): Promise<WorkSession> {
    return this.request("POST", `/api/activity/sessions/${workSessionId}/end`);
  }

  ingestActivity(batch: ActivityBatch): Promise<ActivityBatchResult> {
    return this.request("POST", "/api/activity/events", batch);
  }

  // -- screenshots --------------------------------------------------------

  /**
   * Uploads one screenshot as a ready-made multipart body.
   *
   * The route reads `file.fields` before draining the file stream, so field order is
   * part of the contract rather than a detail — the body is therefore built by the
   * caller that owns the frame (`screenshotFormData` in the agent) instead of being
   * reassembled here from loose arguments that could be appended in the wrong order.
   */
  uploadScreenshot(form: FormData): Promise<ScreenshotUploadResult> {
    return this.request("POST", "/api/screenshots", form);
  }

  // -- employees ----------------------------------------------------------

  listEmployees(): Promise<Profile[]> {
    return this.request("GET", "/api/employees");
  }

  // -- analytics & reports ------------------------------------------------

  getProductivity(profileId: string, from: string, to: string): Promise<ProductivitySummary> {
    const query = new URLSearchParams({ profileId, from, to });
    return this.request("GET", `/api/analytics/productivity?${query.toString()}`);
  }

  getTimeline(profileId: string, from: string, to: string): Promise<TimelineEntry[]> {
    const query = new URLSearchParams({ profileId, from, to });
    return this.request("GET", `/api/analytics/timeline?${query.toString()}`);
  }

  listReports(): Promise<Report[]> {
    return this.request("GET", "/api/reports");
  }

  // -- transport ----------------------------------------------------------

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    const isFormData = typeof FormData !== "undefined" && body instanceof FormData;

    if (body !== undefined && !isFormData) {
      headers["Content-Type"] = "application/json";
    }

    if (this.auth) {
      // Device tokens are not Supabase JWTs, so they travel on their own header —
      // the API must never mistake one for a user session.
      if (this.auth.kind === "user") {
        headers["Authorization"] = `Bearer ${this.auth.token}`;
      } else {
        headers["X-Device-Token"] = this.auth.token;
      }
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : isFormData ? (body as FormData) : JSON.stringify(body),
    });

    if (!response.ok) {
      throw await toApiError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

async function toApiError(response: Response): Promise<AemsApiError> {
  let payload: Partial<ApiError> = {};
  try {
    payload = (await response.json()) as Partial<ApiError>;
  } catch {
    // Non-JSON error body (a proxy timeout page, say) — fall back to the status text.
  }

  return new AemsApiError(
    payload.message ?? response.statusText ?? "Request failed",
    response.status,
    payload.error ?? "unknown_error",
  );
}
