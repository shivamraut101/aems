/** A clocked-in work period reported by the agent. */
export interface WorkSession {
  id: string;
  userId: string;
  deviceId: string;
  clockInAt: string;
  clockOutAt: string | null;
}

/** A single application/window-focus interval captured by the agent. */
export interface ActivityEvent {
  id: string;
  userId: string;
  deviceId: string;
  workSessionId: string | null;
  appName: string;
  windowTitle: string | null;
  url: string | null;
  category: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** A period during which no keyboard/mouse input was detected. */
export interface IdleEvent {
  id: string;
  userId: string;
  deviceId: string;
  idleStartAt: string;
  idleEndAt: string | null;
  durationSeconds: number | null;
}

/** Metadata for a captured screenshot; binary lives in object storage, not the DB. */
export interface Screenshot {
  id: string;
  userId: string;
  deviceId: string;
  workSessionId: string | null;
  capturedAt: string;
  storageKey: string;
  thumbnailKey: string | null;
  blurred: boolean;
}

/** An aggregated slice of a user's day combining activity, idle and screenshot data. */
export interface TimelineEntry {
  userId: string;
  deviceId: string;
  periodStart: string;
  periodEnd: string;
  activeSeconds: number;
  idleSeconds: number;
  topApp: string | null;
  screenshotId: string | null;
}
