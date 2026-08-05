import { AemsClient } from "@aems/sdk";

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

export const client = new AemsClient({ baseUrl: resolveApiUrl() });
