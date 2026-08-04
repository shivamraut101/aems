import Store from "electron-store";

interface AgentConfig {
  apiUrl: string;
  deviceId: string | null;
  userId: string | null;
  consentedAt: string | null;
  screenshotIntervalSeconds: number;
  idleThresholdSeconds: number;
}

export const store = new Store<AgentConfig>({
  defaults: {
    apiUrl: process.env.AEMS_API_URL ?? "http://localhost:3001",
    deviceId: null,
    userId: null,
    consentedAt: null,
    screenshotIntervalSeconds: 300,
    idleThresholdSeconds: 120,
  },
});

export function hasConsented(): boolean {
  return Boolean(store.get("consentedAt"));
}
