import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { useCallback, useState } from "react";

import type { AgentPolicy, DeviceEnrollmentRequest } from "@aems/types";

import { client } from "./api";
import {
  EMPTY_TOTALS,
  hasEnded,
  isOnBreak,
  loadDay,
  summariseDay,
  type DayTotals,
} from "./day";
import { loadPending, pendingCount } from "./queue";
import * as session from "./session";
import AemsUsage from "../modules/aems-usage";

const DEVICE_TOKEN_KEY = "aems.deviceToken";
const DEVICE_ID_KEY = "aems.deviceId";
const POLICY_KEY = "aems.policy";
const CONSENT_KEY = "aems.consentedPolicyVersion";
const REVOKED_KEY = "aems.revoked";
export const LAST_SYNC_KEY = "aems.lastSyncAt";

export type Screen = "login" | "consent" | "home" | "revoked";

export interface AgentStatus {
  screen: Screen;
  greeting: string;
  fullName: string | null;
  collecting: boolean;
  policyVersion: string | null;
  lastSync: string;
  deviceId: string | null;
  /** An administrator stopped this device. Terminal until it is enrolled again. */
  revoked: boolean;
  onBreak: boolean;
  dayStarted: boolean;
  dayEnded: boolean;
  totals: DayTotals;
  /** Observed events journalled to disk and not yet accepted by the API. */
  pendingEvents: number;
}

/**
 * Revocation outlives the credentials it invalidates.
 *
 * `clearDeviceCredentials()` deliberately wipes everything the device could still
 * authenticate with, which used to leave the employee on the sign-in screen with no
 * account of what had happened. This flag is what survives that wipe so the app can
 * say so, and enrolling again is what clears it.
 */
export async function markRevoked(): Promise<void> {
  await SecureStore.setItemAsync(REVOKED_KEY, "1");
}

export async function isRevoked(): Promise<boolean> {
  return (await SecureStore.getItemAsync(REVOKED_KEY)) === "1";
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
 * Mirrors the desktop agent's enroll-with-code → consent sequence
 * (`apps/desktop-agent/src/main/index.ts`): this agent never holds a user session.
 * `login()` binds the device with the short pairing code the dashboard issues
 * (`POST /api/devices/enroll-with-code`, deliberately unauthenticated — the code
 * IS the credential), and `acceptConsent()` proves itself with the device token
 * that enrolment returns, the same way the desktop agent's `submitConsentAsDevice`
 * does. Both survive an app restart because both live in SecureStore.
 */
export function useAgentState() {
  const [status, setStatus] = useState<AgentStatus>({
    screen: "login",
    greeting: greeting(),
    fullName: null,
    collecting: false,
    policyVersion: null,
    lastSync: "Not synced",
    deviceId: null,
    revoked: false,
    onBreak: false,
    dayStarted: false,
    dayEnded: false,
    totals: EMPTY_TOTALS,
    pendingEvents: 0,
  });

  const refresh = useCallback(async () => {
    const [credentials, consentedVersion, lastSyncAt, revoked, day, pending] = await Promise.all([
      loadDeviceCredentials(),
      SecureStore.getItemAsync(CONSENT_KEY),
      SecureStore.getItemAsync(LAST_SYNC_KEY),
      isRevoked(),
      loadDay(),
      loadPending(),
    ]);

    const screenActive = await screenActiveSeconds();
    const totals = summariseDay(day, screenActive);
    const dayFields = {
      onBreak: isOnBreak(day),
      dayStarted: day.startedAtMs !== null,
      dayEnded: hasEnded(day),
      totals,
      pendingEvents: pendingCount(pending),
    };

    // Revocation is checked before credentials, because revoking is what removed
    // them — reading "no credentials" as "not signed in" is what made an
    // administrator stopping this device look like the app losing its session.
    if (revoked) {
      setStatus((current) => ({
        ...current,
        ...dayFields,
        screen: "revoked",
        greeting: greeting(),
        collecting: false,
        revoked: true,
        deviceId: null,
      }));
      return;
    }

    if (credentials === null) {
      setStatus((current) => ({
        ...current,
        ...dayFields,
        screen: "login",
        greeting: greeting(),
        collecting: false,
        revoked: false,
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
      ...dayFields,
      screen: consented ? "home" : "consent",
      greeting: greeting(),
      collecting: consented,
      revoked: false,
      deviceId: credentials.deviceId,
      policyVersion: credentials.policy.version,
      lastSync: lastSyncAt ?? "Not synced",
    }));
  }, []);

  /**
   * The day controls. Each writes local state, then `refresh()` reads it straight
   * back — so what the screen shows is what was actually persisted, never an
   * optimistic guess that a failed write would leave lying.
   */
  const startDay = useCallback(async () => {
    const credentials = await loadDeviceCredentials();
    if (credentials === null) return;
    await session.startDay(credentials.deviceId);
    await refresh();
  }, [refresh]);

  const endDay = useCallback(async () => {
    const credentials = await loadDeviceCredentials();
    if (credentials === null) return;
    await session.endDay(credentials.deviceId);
    await refresh();
  }, [refresh]);

  const startBreak = useCallback(async () => {
    await session.startBreak();
    await refresh();
  }, [refresh]);

  const endBreak = useCallback(async () => {
    await session.endBreak();
    await refresh();
  }, [refresh]);

  const login = useCallback(async (code: string) => {
    // No Authorization header sent — enroll-with-code is deliberately unauthenticated,
    // the pairing code the dashboard shows is the whole credential.
    const facts = await collectDeviceFacts();
    const response = await client.enrollDeviceWithCode(code, facts);

    await Promise.all([
      SecureStore.setItemAsync(DEVICE_TOKEN_KEY, response.deviceToken),
      SecureStore.setItemAsync(DEVICE_ID_KEY, response.deviceId),
      SecureStore.setItemAsync(POLICY_KEY, JSON.stringify(response.policy)),
      // A fresh enrolment always needs fresh consent, even if a *different* prior
      // enrolment on this device had already recorded one.
      SecureStore.deleteItemAsync(CONSENT_KEY),
      // Enrolling again is the one thing that clears a revocation: an administrator
      // issuing a new code is them deciding this device may be used after all.
      SecureStore.deleteItemAsync(REVOKED_KEY),
    ]);

    client.setAuth({ kind: "device", token: response.deviceToken });

    setStatus((current) => ({
      ...current,
      screen: "consent",
      deviceId: response.deviceId,
      policyVersion: response.policy.version,
      collecting: false,
      revoked: false,
    }));
  }, []);

  const acceptConsent = useCallback(async () => {
    const credentials = await loadDeviceCredentials();
    if (credentials === null) {
      throw new Error("Enrol this device before recording consent");
    }

    // Consent has to reach the server before it is believed locally — the API is
    // the enforcement point, so a locally-consented agent with no consent_records
    // row just gets rejected on every later request. Proven by the device token,
    // which survives an app restart in SecureStore — unlike a user session, this
    // agent never has to ask the employee to sign in again just to finish setup.
    client.setAuth({ kind: "device", token: credentials.deviceToken });
    await client.submitConsentAsDevice({
      policyVersion: credentials.policy.version,
      method: "in_app_dialog",
    });

    await SecureStore.setItemAsync(CONSENT_KEY, credentials.policy.version);

    // Accepting is clocking in. Leaving the day closed here would put the employee on
    // a home screen that says "Collecting" above a set of totals frozen at zero.
    await session.startDay(credentials.deviceId);
    await refresh();
  }, [refresh]);

  return {
    status,
    refresh,
    login,
    acceptConsent,
    startDay,
    endDay,
    startBreak,
    endBreak,
  };
}

/**
 * Today's screen-on seconds, or zero if the native module cannot be reached.
 *
 * Zero is the safe direction to fail in: it understates the day rather than inventing
 * work, and the next successful read corrects it.
 */
async function screenActiveSeconds(): Promise<number> {
  try {
    return (await AemsUsage.getDeviceSnapshot()).screenActiveSeconds;
  } catch {
    return 0;
  }
}
