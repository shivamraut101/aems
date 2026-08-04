"use client";

import { AemsClient } from "@aems/sdk";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { createClient } from "./supabase";

export interface LiveWorkforceRow {
  deviceId: string;
  platform: "windows" | "macos" | "android";
  label: string;
  profileId: string | null;
  fullName: string | null;
  email: string | null;
  lastSeenAt: string | null;
  status: "active" | "offline";
}

export interface OverviewMetrics {
  totalEmployees: number;
  activeNow: number;
  workingToday: number;
  totalHoursToday: number;
}

function baseUrl(): string {
  return process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";
}

/**
 * API client carrying the current Supabase session.
 *
 * The token is read per request rather than captured once, so a refresh mid-session
 * does not leave the client holding an expired one.
 */
export function useApi(): AemsClient {
  return useMemo(() => {
    const supabase = createClient();

    const authedFetch: typeof fetch = async (input, init) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const headers = new Headers(init?.headers);
      if (session?.access_token) {
        headers.set("Authorization", `Bearer ${session.access_token}`);
      }

      return fetch(input, { ...init, headers });
    };

    return new AemsClient({ baseUrl: baseUrl(), fetch: authedFetch });
  }, []);
}

async function getJson<T>(path: string): Promise<T> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const response = await fetch(`${baseUrl()}${path}`, {
    headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
  });

  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

export function useOverview() {
  return useQuery({
    queryKey: ["analytics", "overview"],
    queryFn: () => getJson<OverviewMetrics>("/api/analytics/overview"),
  });
}

export function useLiveWorkforce() {
  return useQuery({
    queryKey: ["analytics", "live"],
    queryFn: () => getJson<LiveWorkforceRow[]>("/api/analytics/live"),
    // The live strip is the one place staleness is actually visible to the user.
    refetchInterval: 20_000,
  });
}

export function useEmployees() {
  return useQuery({
    queryKey: ["employees"],
    queryFn: () => getJson<EmployeeRow[]>("/api/employees"),
  });
}

export interface EmployeeRow {
  id: string;
  email: string;
  full_name: string;
  role: "super_admin" | "manager" | "employee";
  department: string | null;
  manager_id: string | null;
  monitoring_enabled: boolean;
  created_at: string;
  devices: {
    id: string;
    platform: "windows" | "macos" | "android";
    label: string;
    status: "active" | "offline" | "revoked";
    last_seen_at: string | null;
  }[];
}

export function useDevices() {
  return useQuery({
    queryKey: ["devices"],
    queryFn: () => getJson<DeviceRow[]>("/api/devices"),
  });
}

export interface DeviceRow {
  id: string;
  profile_id: string;
  platform: "windows" | "macos" | "android";
  label: string;
  device_name: string;
  os_version: string;
  agent_version: string;
  model: string | null;
  cpu: string | null;
  ram_mb: number | null;
  storage_mb: number | null;
  status: "active" | "offline" | "revoked";
  last_seen_at: string | null;
  enrolled_at: string;
}
