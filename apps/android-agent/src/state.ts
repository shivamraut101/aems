import * as SecureStore from "expo-secure-store";
import { useCallback, useState } from "react";

const DEVICE_TOKEN_KEY = "aems.deviceToken";
const CONSENT_KEY = "aems.consentedPolicyVersion";

export interface AgentStatus {
  greeting: string;
  fullName: string | null;
  todayFormatted: string;
  collecting: boolean;
  consentRequired: boolean;
  policyVersion: string | null;
  lastSync: string;
}

function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Agent state.
 *
 * The device token goes in SecureStore (Android Keystore), never AsyncStorage — it
 * authorises every upload this device makes, so it is a credential rather than a
 * preference.
 */
export function useAgentState() {
  const [status, setStatus] = useState<AgentStatus>({
    greeting: greeting(),
    fullName: null,
    todayFormatted: "0h 00m",
    collecting: false,
    consentRequired: true,
    policyVersion: null,
    lastSync: "Not synced",
  });

  const refresh = useCallback(async () => {
    const [token, consented] = await Promise.all([
      SecureStore.getItemAsync(DEVICE_TOKEN_KEY),
      SecureStore.getItemAsync(CONSENT_KEY),
    ]);

    setStatus((current) => ({
      ...current,
      greeting: greeting(),
      collecting: Boolean(token && consented),
      consentRequired: !token || !consented,
      policyVersion: consented,
    }));
  }, []);

  const acceptConsent = useCallback(async () => {
    const version = status.policyVersion ?? "unknown";
    await SecureStore.setItemAsync(CONSENT_KEY, version);
    setStatus((current) => ({ ...current, collecting: true, consentRequired: false }));
  }, [status.policyVersion]);

  return { status, refresh, acceptConsent };
}
