export type DevicePlatform = "windows" | "macos" | "android";

export type DeviceStatus = "active" | "offline" | "revoked";

export interface Device {
  id: string;
  orgId: string;
  userId: string;
  platform: DevicePlatform;
  label: string;
  osVersion: string;
  agentVersion: string;
  enrolledAt: string;
  lastSeenAt: string | null;
  status: DeviceStatus;
}
