import type {
  ActivityBatch,
  ActivityBatchResult,
  ApiError,
  ConsentSubmission,
  DayTimeline,
  Device,
  DeviceApplicationsInput,
  DeviceEnrollmentRequest,
  DeviceEnrollmentResponse,
  HeartbeatInput,
  Profile,
  ProductivitySummary,
  Report,
  ScreenshotUploadResult,
  TelemetryInput,
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

/**
 * How long a single request may take before it is abandoned.
 *
 * Long enough for a screenshot upload on a hotel uplink, short enough that a caller
 * driving a fixed-interval loop notices the failure within one cycle rather than
 * blocking on a socket a middlebox has silently black-holed. undici's own header
 * timeout is 300 s, which is far past the point where a monitoring agent should have
 * given up and buffered the batch for the next attempt.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A request that never got an answer — a timeout, a dead link, a refused connection.
 *
 * Deliberately a sibling of {@link AemsApiError} rather than a subclass: the two are
 * the caller's retry/quarantine fork. An `AemsApiError` means the API judged the
 * payload and resending it changes nothing; this means the payload was never judged,
 * so discarding it would lose data the server has not seen. `statusCode` is `null`
 * rather than absent so that fork can be read structurally — the SDK can be loaded
 * twice in one process (built ESM plus a bundled copy) and `instanceof` would then
 * misclassify a cross-realm error.
 */
export class AemsNetworkError extends Error {
  readonly statusCode = null;
  readonly timedOut: boolean;

  constructor(message: string, options: { timedOut: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "AemsNetworkError";
    this.timedOut = options.timedOut;
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
  /** Per-request deadline in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
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
  private readonly timeoutMs: number;
  private auth: AemsClientOptions["auth"];

  constructor(options: AemsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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

  /**
   * Binds this machine using a short code from the dashboard.
   *
   * Sends no Authorization header, and that is the point: the code is the credential.
   * The alternative was asking a person to paste an access token, which is 800
   * characters of JWT granting their account's full rights — something no screen in
   * the product shows them and nobody should be copying around.
   */
  enrollDeviceWithCode(
    code: string,
    body: DeviceEnrollmentRequest,
  ): Promise<DeviceEnrollmentResponse> {
    return this.request("POST", "/api/devices/enroll-with-code", { ...body, code });
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

  reportTelemetry(body: TelemetryInput): Promise<{ ok: true }> {
    return this.request("POST", "/api/devices/telemetry", body);
  }

  // -- consent ------------------------------------------------------------

  submitConsent(body: ConsentSubmission): Promise<{ consentId: string }> {
    return this.request("POST", "/api/auth/consent", body);
  }

  /**
   * Consent proven by the device token rather than a user session.
   *
   * What an agent enrolled with a sign-in code uses, because it never holds a session.
   * No `deviceId` argument: the token already names the device, and letting the caller
   * supply one would mean any valid device token could consent for another machine.
   */
  submitConsentAsDevice(
    body: Omit<ConsentSubmission, "deviceId">,
  ): Promise<{ consentId: string }> {
    return this.request("POST", "/api/auth/consent/device", body);
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

  /**
   * The reduced day view: slots, spans, markers and totals in one response.
   *
   * `bucketSeconds` is a fixed grid, not a free range — 60, 300, 600, 1800 or 3600,
   * defaulting to 600. The set is deliberately not typed as a union here: it is owned
   * by `@aems/analytics`, and the SDK is what the *agents* speak to, so pulling the
   * analytics package in to narrow one argument would put the whole reduction engine
   * in an agent bundle. The API validates and returns 400 on anything else.
   */
  getTimeline(
    profileId: string,
    from: string,
    to: string,
    bucketSeconds?: number,
  ): Promise<DayTimeline> {
    const query = new URLSearchParams({ profileId, from, to });
    if (bucketSeconds !== undefined) query.set("bucketSeconds", String(bucketSeconds));
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

    const init: RequestInit = {
      method,
      headers,
      body: body === undefined ? undefined : isFormData ? (body as FormData) : JSON.stringify(body),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new AemsNetworkError(`${method} ${path} timed out after ${this.timeoutMs}ms`, { timedOut: true }),
      );
    }, this.timeoutMs);

    try {
      // Raced rather than left to the signal alone: honouring `signal` is the fetch
      // implementation's choice, and one that ignores it would hang the caller
      // forever. The race makes the deadline the client's own guarantee.
      return await Promise.race([this.send<T>(path, init, controller.signal), rejectOnAbort(controller.signal)]);
    } catch (error) {
      if (error instanceof AemsApiError || error instanceof AemsNetworkError) throw error;

      // Everything else came from the transport: DNS, a refused socket, a captive
      // portal answering 200 with HTML. None of them is a verdict on the payload,
      // so none of them may look like one to the caller.
      throw new AemsNetworkError(`${method} ${path} failed: ${describeCause(error)}`, {
        timedOut: false,
        cause: error,
      });
    } finally {
      // The controller is per-request and goes out of scope here; the timer is the
      // only handle that would outlive it, so it must not survive a fast response.
      clearTimeout(timer);
    }
  }

  private async send<T>(path: string, init: RequestInit, signal: AbortSignal): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal });

    if (!response.ok) {
      throw await toApiError(response);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Settles only when the deadline fires, so the abort reason becomes the rejection.
 *
 * It must reject synchronously inside the abort dispatch. The transport's own
 * rejection has to travel back through an async function and therefore lands a
 * microtask later, which is what makes the reason we chose — not whatever
 * `AbortError` or torn-down-body `TypeError` the transport happens to raise — the
 * error the caller sees. Deferring this rejection would silently relabel every
 * timeout as an ordinary network fault.
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
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
