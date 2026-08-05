import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { useCallback, useRef, useState } from "react";

import type { AgentPolicy, DeviceEnrollmentRequest } from "@aems/types";

import { client } from "./api";
import AemsUsage from "../modules/aems-usage";

const DEVICE_TOKEN_KEY = "aems.deviceToken";
const DEVICE_ID_KEY = "aems.deviceId";
const POLICY_KEY = "aems.policy";
const CONSENT_KEY = "aems.consentedPolicyVersion";
export const LAST_SYNC_KEY = "aems.lastSyncAt";

export type Screen = "login" | "consent" | "home";

export interface AgentStatus {
  screen: Screen;
  greeting: string;
  fullName: string | null;
  todayFormatted: string;
  collecting: boolean;
  policyVersion: string | null;
  lastSync: string;
  deviceId: string | null;
}

export interface DeviceCredentials {
  deviceId: string;
  deviceToken: string;
  policy: AgentPolicy;
}

function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Reads the durable device identity — used by `sync.ts` too, including from the
 * background-fetch task, which runs with no mounted component and so cannot read
 * this out of React state.
 */
export async function loadDeviceCredentials(): Promise<DeviceCredentials | null> {
  const [deviceToken, deviceId, policyJson] = await Promise.all([
    SecureStore.getItemAsync(DEVICE_TOKEN_KEY),
    SecureStore.getItemAsync(DEVICE_ID_KEY),
    SecureStore.getItemAsync(POLICY_KEY),
  ]);

  if (deviceToken === null || deviceId === null || policyJson === null) return null;

  return { deviceId, deviceToken, policy: JSON.parse(policyJson) as AgentPolicy };
}

/**
 * Wipes the device identity a revoked or de-consented token can no longer use.
 *
 * Deliberately does not touch `LAST_SYNC_KEY` — the last time this device *did*
 * sync is still true after revocation, and the home screen has already been
 * replaced by the login screen by the time it would matter.
 */
export async function clearDeviceCredentials(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(DEVICE_TOKEN_KEY),
    SecureStore.deleteItemAsync(DEVICE_ID_KEY),
    SecureStore.deleteItemAsync(POLICY_KEY),
    SecureStore.deleteItemAsync(CONSENT_KEY),
  ]);
}

/**
 * Credentials plus whether the currently-in-force policy has actually been
 * consented to. `sync.ts` uses this to decide how much of a cycle it may run: an
 * enrolled-but-unconsented device still heartbeats (so it shows as online), but
 * skips telemetry/applications/activity, which the API rejects pre-consent anyway.
 */
export async function loadSyncContext(): Promise<{
  credentials: DeviceCredentials;
  consented: boolean;
} | null> {
  const [credentials, consentedVersion] = await Promise.all([
    loadDeviceCredentials(),
    SecureStore.getItemAsync(CONSENT_KEY),
  ]);

  if (credentials === null) return null;
  return { credentials, consented: consentedVersion === credentials.policy.version };
}

/**
 * Android's device inventory (scope §3.4), read from the native module rather than
 * `expo-device` — `AemsUsageModule.getDeviceSnapshot()` already surfaces model,
 * Android version, RAM and storage from one native call, so there is no reason to
 * pull a second, possibly-disagreeing source for the same facts.
 */
async function collectDeviceFacts(): Promise<DeviceEnrollmentRequest> {
  const snapshot = await AemsUsage.getDeviceSnapshot();

  return {
    platform: "android",
    label: snapshot.model,
    deviceName: snapshot.model,
    osVersion: snapshot.androidVersion,
    agentVersion: Constants.expoConfig?.version ?? "0.0.0",
    model: snapshot.model,
    ramMb: snapshot.totalRamMb,
    storageMb: snapshot.totalStorageMb,
  };
}

/**
 * Agent state.
 *
 * Mirrors the desktop agent's login → enroll → consent sequence
 * (`apps/desktop-agent/src/main/index.ts`): the employee's Supabase access token is
 * held only in a ref for the span of one session, never persisted — if the app is
 * killed between enrolling and consenting, the device token survives in
 * SecureStore but the access token does not, and `refresh()` sends the employee
 * back to `LoginScreen` to finish setup rather than getting stuck on a consent
 * screen it can no longer submit.
 */
export function useAgentState() {
  const accessToken = useRef<string | null>(null);
  const [status, setStatus] = useState<AgentStatus>({
    screen: "login",
    greeting: greeting(),
    fullName: null,
    todayFormatted: "0h 00m",
    collecting: false,
    policyVersion: null,
    lastSync: "Not synced",
    deviceId: null,
  });

  const refresh = useCallback(async () => {
    const [credentials, consentedVersion, lastSyncAt] = await Promise.all([
      loadDeviceCredentials(),
      SecureStore.getItemAsync(CONSENT_KEY),
      SecureStore.getItemAsync(LAST_SYNC_KEY),
    ]);

    if (credentials === null) {
      accessToken.current = null;
      setStatus((current) => ({
        ...current,
        screen: "login",
        greeting: greeting(),
        collecting: false,
        deviceId: null,
        policyVersion: null,
      }));
      return;
    }

    // A policy version bump invalidates a prior consent — the employee agreed to a
    // specific policy, not to whatever the company later changes it to.
    const consented = consentedVersion === credentials.policy.version;

    client.setAuth({ kind: "device", token: credentials.deviceToken });

    setStatus((current) => ({
      ...current,
      screen: consented ? "home" : accessToken.current !== null ? "consent" : "login",
      greeting: greeting(),
      collecting: consented,
      deviceId: credentials.deviceId,
      policyVersion: credentials.policy.version,
      lastSync: lastSyncAt ?? "Not synced",
    }));
  }, []);

  const login = useCallback(async (token: string) => {
    client.setAuth({ kind: "user", token });
    const facts = await collectDeviceFacts();
    const response = await client.enrollDevice(facts);

    accessToken.current = token;

    await Promise.all([
      SecureStore.setItemAsync(DEVICE_TOKEN_KEY, response.deviceToken),
      SecureStore.setItemAsync(DEVICE_ID_KEY, response.deviceId),
      SecureStore.setItemAsync(POLICY_KEY, JSON.stringify(response.policy)),
      // A fresh enrolment always needs fresh consent, even if a *different* prior
      // enrolment on this device had already recorded one.
      SecureStore.deleteItemAsync(CONSENT_KEY),
    ]);

    client.setAuth({ kind: "device", token: response.deviceToken });

    setStatus((current) => ({
      ...current,
      screen: "consent",
      deviceId: response.deviceId,
      policyVersion: response.policy.version,
      collecting: false,
    }));
  }, []);

  const acceptConsent = useCallback(async () => {
    const credentials = await loadDeviceCredentials();
    if (credentials === null) {
      throw new Error("Enrol this device before recording consent");
    }
    if (accessToken.current === null) {
      // The access token only ever lives in memory (never persisted, matching the
      // desktop agent) — if it's gone, the app was restarted mid-setup and the
      // employee has to sign in again to finish.
      setStatus((current) => ({ ...current, screen: "login" }));
      throw new Error("Sign in again to finish setting up this device");
    }

    // Consent has to reach the server before it is believed locally — the API is
    // the enforcement point, so a locally-consented agent with no consent_records
    // row just gets rejected on every later request.
    client.setAuth({ kind: "user", token: accessToken.current });
    await client.submitConsent({
      deviceId: credentials.deviceId,
      policyVersion: credentials.policy.version,
      method: "in_app_dialog",
    });

    accessToken.current = null;
    client.setAuth({ kind: "device", token: credentials.deviceToken });
    await SecureStore.setItemAsync(CONSENT_KEY, credentials.policy.version);

    setStatus((current) => ({
      ...current,
      screen: "home",
      collecting: true,
      policyVersion: credentials.policy.version,
    }));
  }, []);

  return { status, refresh, login, acceptConsent };
}
