import { AemsClient } from "@aems/sdk";

import type { AgentPolicy, DeviceEnrollmentResponse } from "@aems/types";

/**
 * `EXPO_PUBLIC_*` vars are inlined into the JS bundle by Metro at build time — no
 * `app.json` "extra" field needed. `10.0.2.2` is the Android emulator's alias for
 * the host machine; `localhost` inside the emulator refers to the emulator itself,
 * not the machine running the API. A physical device needs this set to the host's
 * LAN IP.
 */
const DEFAULT_API_URL = "http://10.0.2.2:3001";

export function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_AEMS_API_URL?.trim();
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_API_URL;
}

export const client = new AemsClient({
  baseUrl: resolveApiUrl(),
  ...(isMockApiEnabled() ? { fetch: mockFetch() } : {}),
});

/**
 * TEMPORARY preview aid — no backend is reachable from this environment, so this
 * lets the login → consent → home flow be clicked through end to end without one.
 *
 * Nothing in `state.ts`/`sync.ts` changes: `login()` and `acceptConsent()` still run
 * their real logic and still call the real `AemsClient` methods — only the transport
 * those calls hit is swapped out, the same way `client.test.ts` fakes `fetch` for unit
 * tests. Turn it off by removing `EXPO_PUBLIC_AEMS_MOCK_API=1` from `.env` (or setting
 * it to anything else) and the app talks to the real API again with zero code changes.
 *
 * DELETE THIS before shipping — it exists only so the UI could be reviewed without a
 * running backend.
 */
function isMockApiEnabled(): boolean {
  return process.env.EXPO_PUBLIC_AEMS_MOCK_API === "1";
}

const MOCK_POLICY: AgentPolicy = {
  version: "preview-1",
  name: "Preview Policy",
  screenshotIntervalSeconds: 300,
  idleThresholdSeconds: 300,
  trackedCategories: [],
};

const MOCK_ENROLLMENT: DeviceEnrollmentResponse = {
  deviceId: "preview-device",
  companyId: "preview-company",
  profileId: "preview-profile",
  deviceToken: "preview-device-token",
  consentRequired: true,
  policy: MOCK_POLICY,
};

function mockFetch(): typeof globalThis.fetch {
  return (async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(resolveApiUrl(), "");
    const method = init?.method ?? "GET";

    console.warn(`[mock-api] ${method} ${path}`);

    const respond = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (method === "POST" && path === "/api/devices/enroll-with-code") return respond(MOCK_ENROLLMENT);
    if (method === "POST" && path === "/api/auth/consent/device") return respond({ consentId: "preview-consent" });
    if (method === "POST" && path === "/api/activity/sessions") {
      return respond({ id: 1, clock_in_at: new Date().toISOString(), clock_out_at: null });
    }
    if (method === "POST" && /^\/api\/activity\/sessions\/\d+\/end$/.test(path)) {
      return respond({ id: 1, clock_out_at: new Date().toISOString() });
    }
    if (method === "POST" && path === "/api/devices/heartbeat") return respond({ ok: true });
    if (method === "POST" && path === "/api/devices/telemetry") return respond({ ok: true });
    if (method === "POST" && path === "/api/devices/applications") return respond({ upserted: 0 });
    if (method === "POST" && path === "/api/activity/events") {
      return respond({ acceptedActivity: 0, acceptedIdle: 0, acceptedBreaks: 0, duplicates: 0 });
    }

    return respond(
      { error: "not_mocked", message: `No preview mock for ${method} ${path}`, statusCode: 501 },
      501,
    );
  }) as typeof globalThis.fetch;
}
